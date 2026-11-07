"""The projector paint and carve share: a turnaround sheet painted onto meshes through UV textures.

Per texel, in numpy (Blender's own; no other dependency):
  - Cycles EMIT bakes give every texel its world position, normal and original material, in the
    pose the sheet shows (the bake reads the evaluated, posed mesh);
  - one orthographic depth render per side (front, back, left, right) of the meshes and what stands
    in front of them;
  - each sheet view is aligned to the model's own silhouette in that view (scale from the heights,
    position by the best overlap), and a side view's facing is the one whose silhouette fits;
  - each texel takes the sheet's colour from every view that sees it: in front in that view's depth
    map, inside the sheet's mask, weighted by |n·v|² (open cloth faces either way; the depth test
    already rejects hidden texels). A missing side is the seen side mirrored, except where a block
    list keeps one-sided details (a scabbard) off the other side;
  - a texel no view sees takes its material's median projected colour, blended in smoothly;
  - colours come from 3D positions, so both sides of a UV seam match, and the bake's margin is a
    bleed of real colour.
The high-passed luminance is projected the same way and baked through a bump into a tangent-space
normal map; roughness and metalness come from each original material (an ORM map)."""
import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

from . import sheet as sheets
from . import stylepass
from .protocol import Refused

MID = "kurambit_paint_mid"
MAX_DEPTH_PX = 4096


def log(*a):
    print("[kurambit.project]", *a, flush=True)


# ----------------------------------------------------------------------------- images

def image_array(img):
    w, h = img.size
    a = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(h, w, 4)


def new_image(name, size, float_buffer=False, non_color=True, colour=(0, 0, 0, 0)):
    w, h = size if isinstance(size, tuple) else (size, size)
    img = bpy.data.images.new(name, w, h, alpha=True, float_buffer=float_buffer)
    img.generated_color = colour
    if non_color:
        img.colorspace_settings.name = "Non-Color"
    return img


def save_png(arr, path, non_color=False):
    """arr (H, W, 4) in Blender row order (row 0 at the bottom); the image stays loaded from path."""
    h, w = arr.shape[:2]
    img = new_image(os.path.basename(path), (w, h), non_color=non_color)
    img.pixels.foreach_set(np.ascontiguousarray(arr, np.float32).ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    img.filepath = path
    img.source = "FILE"
    img.reload()
    return img


def sample(img, u, v):
    """Bilinear sample of img (H, W[, C]; row 0 at the top) at continuous pixel coords (pixel i
    spans [i, i + 1))."""
    if img.ndim == 2:
        img = img[:, :, None]
    h, w = img.shape[:2]
    u = np.clip(u - 0.5, 0, w - 1.001)
    v = np.clip(v - 0.5, 0, h - 1.001)
    x0, y0 = np.floor(u).astype(np.int64), np.floor(v).astype(np.int64)
    fx, fy = (u - x0)[:, None], (v - y0)[:, None]
    a = img[y0, x0] * (1 - fx) + img[y0, x0 + 1] * fx
    b = img[y0 + 1, x0] * (1 - fx) + img[y0 + 1, x0 + 1] * fx
    return a * (1 - fy) + b * fy


# ----------------------------------------------------------------------------- scene

def cycles(scene):
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 1
    scene.cycles.use_denoising = False
    scene.render.bake.margin = 8
    scene.render.bake.margin_type = "EXTEND"
    scene.render.bake.use_clear = True
    scene.render.bake.use_selected_to_active = False


def select(objs, active=None):
    layer = bpy.context.view_layer
    layer.update()  # an object removed since the last update still has a (None) entry
    for o in layer.objects:
        if o is not None:
            o.select_set(False)
    for o in objs:
        o.hide_set(False)
        o.hide_viewport = False
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or objs[0]


def evaluated_points(objs):
    """World positions of the evaluated (posed) meshes' vertices."""
    dg = bpy.context.evaluated_depsgraph_get()
    out = []
    for o in objs:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        try:
            co = np.empty(len(me.vertices) * 3)
            me.vertices.foreach_get("co", co)
            m = np.array(ev.matrix_world)
            out.append(co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3])
        finally:
            ev.to_mesh_clear()
    return np.concatenate(out) if out else np.zeros((0, 3))


def assign(objs, groups, mats):
    """Every object's material slots set to one per group, its faces by group."""
    for o in objs:
        me = o.data
        me.materials.clear()
        for m in mats[: int(groups[o.name].max()) + 1]:
            me.materials.append(m)
        me.polygons.foreach_set("material_index", groups[o.name].astype(np.int32))


def proxy_of(objs):
    """One static mesh of the objects as they are posed, in world space, keeping their UVs,
    attributes and material slots: Cycles bakes many selected objects one at a time, re-syncing
    the scene for each, which costs minutes and memory for a character of thirty parts."""
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    parts = []
    for o in objs:
        ev = o.evaluated_get(dg)
        me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
        me.transform(ev.matrix_world)
        p = bpy.data.objects.new("kurambit_bake_proxy", me)
        bpy.context.scene.collection.objects.link(p)
        parts.append(p)
    select(parts)
    if len(parts) > 1:
        bpy.ops.object.join()
    proxy = bpy.context.view_layer.objects.active
    proxy.data.uv_layers.active = proxy.data.uv_layers["paint"]
    proxy.data.uv_layers["paint"].active_render = True
    return proxy


def drop(obj):
    me = obj.data
    bpy.data.objects.remove(obj)
    if me.users == 0:
        bpy.data.meshes.remove(me)


def occluders(targets):
    """The targets and every other rendered mesh standing in their box (a sword, a hat), not the
    ground or walls around them: a mesh far bigger than the targets is scenery."""
    pts = evaluated_points(targets)
    lo, hi = pts.min(0), pts.max(0)
    span = float((hi - lo).max())
    out = list(targets)
    for o in bpy.context.scene.objects:
        if o in out or o.type != "MESH" or o.hide_render:
            continue
        p = evaluated_points([o])
        if not len(p):
            continue
        a, b = p.min(0), p.max(0)
        if (b - a).max() > 2 * span or (a > hi).any() or (b < lo).any():
            continue
        out.append(o)
    return out


# ----------------------------------------------------------------------------- depth

class Depth:
    """An orthographic depth render of the occluders from one side, framing the box lo..hi."""

    def __init__(self, label, objs, lo, hi, px, out_dir):
        right, look = (np.array(v, np.float64) for v in sheets.AXES[label])
        up = np.array([0.0, 0.0, 1.0])
        corners = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
        h, v, d = corners @ right, corners @ up, corners @ look
        pad = 0.02 * float((hi - lo).max())
        width, height = h.max() - h.min() + 2 * pad, v.max() - v.min() + 2 * pad
        px = max(px, max(width, height) / MAX_DEPTH_PX)
        W, H = int(math.ceil(width / px)), int(math.ceil(height / px))
        self.label, self.right, self.up, self.look, self.px, self.W, self.H = label, right, up, look, px, W, H
        self.hc, self.vc = (h.max() + h.min()) / 2, (v.max() + v.min()) / 2
        self.cam = right * self.hc + up * self.vc + look * (d.min() - 1.0)
        self.depth = self._render(objs, d.max() - d.min() + 2.0, out_dir)

    def _render(self, objs, reach, out_dir):
        sc = bpy.context.scene
        cam = bpy.data.objects.new("kurambit_depth_cam", bpy.data.cameras.new("kurambit_depth_cam"))
        sc.collection.objects.link(cam)
        rot = Matrix([list(self.right), list(self.up), list(-self.look)]).transposed()
        cam.matrix_world = Matrix.Translation(Vector(self.cam)) @ rot.to_4x4()
        cam.data.type = "ORTHO"
        cam.data.ortho_scale = max(self.W, self.H) * self.px
        cam.data.sensor_fit = "AUTO"
        cam.data.clip_start, cam.data.clip_end = 0.01, reach + 1.0
        sc.camera = cam
        cycles(sc)
        sc.cycles.filter_width = 0.01
        sc.render.resolution_x, sc.render.resolution_y = self.W, self.H
        sc.render.resolution_percentage = 100
        sc.render.film_transparent = False
        sc.view_settings.view_transform = "Standard"
        sc.view_settings.look = "None"
        sc.render.image_settings.file_format = "OPEN_EXR"
        sc.render.image_settings.color_depth = "32"
        world = bpy.data.worlds.new("kurambit_depth_world")
        world.use_nodes = True
        world.node_tree.nodes["Background"].inputs[0].default_value = (1e4, 1e4, 1e4, 1)
        world.node_tree.nodes["Background"].inputs[1].default_value = 1.0
        keep_world = sc.world
        sc.world = world
        m = bpy.data.materials.new("kurambit_depth")
        m.use_nodes = True
        nt = m.node_tree
        nt.nodes.clear()
        cd = nt.nodes.new("ShaderNodeCameraData")
        em = nt.nodes.new("ShaderNodeEmission")
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        nt.links.new(cd.outputs["View Z Depth"], em.inputs["Color"])
        nt.links.new(em.outputs[0], out.inputs[0])
        hidden = [o for o in sc.objects if o.type in stylepass.helpers.GEOMETRY and o not in objs and not o.hide_render]
        for o in hidden:
            o.hide_render = True
        shown = [o for o in objs if o.hide_render]
        for o in shown:
            o.hide_render = False
        layer = bpy.context.view_layer
        layer.material_override = m
        path = os.path.join(out_dir, f"depth_{self.label}.exr")
        sc.render.filepath = path
        try:
            bpy.ops.render.render(write_still=True)
        finally:
            layer.material_override = None
            for o in hidden:
                o.hide_render = False
            for o in shown:
                o.hide_render = True
            sc.world = keep_world
            bpy.data.objects.remove(cam)
            bpy.data.materials.remove(m)
            bpy.data.worlds.remove(world)
        img = bpy.data.images.load(path, check_existing=False)
        d = image_array(img)[::-1, :, 0].copy()
        bpy.data.images.remove(img)
        os.remove(path)
        return d

    def pixel(self, h, v):
        """Continuous pixel coords (x, y from the top) of world coords along right (h) and up (v)."""
        return (h - self.hc) / self.px + self.W / 2, self.H / 2 - (v - self.vc) / self.px

    def covered(self, h, v):
        x, y = self.pixel(h, v)
        xi = np.clip(np.floor(x).astype(np.int64), 0, self.W - 1)
        yi = np.clip(np.floor(y).astype(np.int64), 0, self.H - 1)
        inside = (x >= 0) & (x < self.W) & (y >= 0) & (y < self.H)
        return inside & (self.depth[yi, xi] < 1e3)  # the world behind is 1e4

    def visible(self, P, tol):
        """Points in front in this view: within tol of the nearest surface in a 3x3 neighbourhood."""
        x, y = self.pixel(P @ self.right, P @ self.up)
        z = (P - self.cam) @ self.look
        xi = np.clip(np.floor(x).astype(np.int64), 1, self.W - 2)
        yi = np.clip(np.floor(y).astype(np.int64), 1, self.H - 2)
        best = np.full(len(P), np.inf, np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                best = np.minimum(best, np.abs(self.depth[yi + dy, xi + dx] - z))
        return best < tol


# ----------------------------------------------------------------------------- views

class View:
    """One sheet view placed on the model: x_s = c0 + (P.right - hmin) / S, y_s = r0 + (zmax - z) / S.
    mirror: this view paints the other side of the subject from the seen side, mirrored in x."""

    def __init__(self, sv, label, S, c0, r0, hmin, zmax, iou, weight, mirror=False, block=()):
        self.sv, self.label, self.S, self.c0, self.r0, self.hmin, self.zmax = sv, label, S, c0, r0, hmin, zmax
        self.iou, self.weight, self.mirror, self.block = iou, weight, mirror, list(block)
        self.right = np.array(sheets.AXES[sv.label if mirror else label][0])

    def centre(self):
        """The sheet column of the model's h = 0 (its centre line in this view)."""
        return self.c0 - self.hmin / self.S

    def sheet_px(self, P):
        if self.mirror:
            P = P * np.array([-1.0, 1.0, 1.0])
        return self.c0 + (P @ self.right - self.hmin) / self.S, self.r0 + (self.zmax - P[:, 2]) / self.S

    def blocked(self, u, v):
        out = np.zeros(len(u), bool)
        for x0, y0, x1, y1 in self.block:
            out |= (u >= x0) & (u < x1) & (v >= y0) & (v < y1)
        return out


def silhouette(depth, lo, hi, S):
    """The model's silhouette in this side's view, on a grid of sheet pixels: row 0 at the top of
    the model, column 0 at its h minimum. Returns (grid, hmin)."""
    corners = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
    h = corners @ depth.right
    hmin, hmax = float(h.min()), float(h.max())
    nc = int(math.ceil((hmax - hmin) / S)) + 1
    nr = int(math.ceil((hi[2] - lo[2]) / S))
    cc, rr = np.meshgrid(np.arange(nc), np.arange(nr))
    hv = hmin + (cc.ravel() + 0.5) * S
    vv = hi[2] - (rr.ravel() + 0.5) * S
    return depth.covered(hv, vv).reshape(nr, nc), hmin


def align(sv, mask, depth, lo, hi, S, search=16, head=0.18):
    """Places the model's silhouette on the sheet view at S metres per pixel, its top on the
    view's crown (the rows are measured, never fitted: whole-body overlap would trade the face's
    registration for a robe's). The column shift is the one with the best overlap of the head
    band, the top `head` of the figure, where a few pixels show most. Returns
    (iou, c0, r0, hmin, grid): iou over the whole figure."""
    grid, hmin = silhouette(depth, lo, hi, S)
    r0 = sv.crown
    nr, nc = grid.shape
    view = mask[:, sv.x0:sv.x1] > 0.5
    if not grid.any():
        return 0.0, sv.x0, r0, hmin, grid
    band = max(int(nr * head), 8)
    pad = nc + search + 2
    canvas = np.zeros((nr, view.shape[1] + 2 * pad), bool)
    rows = view[r0:r0 + nr]
    canvas[: rows.shape[0], pad:pad + view.shape[1]] = rows
    ys, xs = np.nonzero(rows[:band])
    gy, gx = np.nonzero(grid[:band])
    if len(xs) == 0 or len(gx) == 0:
        ys, xs = np.nonzero(rows)
        gy, gx = np.nonzero(grid)
    c_init = int(round(xs.mean() - gx.mean()))

    def overlap(c, top):
        g = grid[:top]
        inter = int((canvas[:top, pad + c:pad + c + nc] & g).sum())
        return inter / max(int(canvas[:top].sum()) + int(g.sum()) - inter, 1)

    c = max(range(c_init - search, c_init + search + 1), key=lambda c: overlap(c, band))
    return overlap(c, nr), sv.x0 + c, r0, hmin, grid


def place_views(read, depths, lo, hi, no_mirror=()):
    """The sheet's views on the model, plus the mirrored side when only one side is drawn. A
    sheet's views share one scale and baseline, so the scale comes from the front's measured
    height and every view keeps its own measured rows; each takes its own column shift. A side
    view whose facing the sheet did not show takes the facing whose silhouette fits better."""
    mask = read["mask"]
    front = next(v for v in read["views"] if v.label == "front")
    S = float(hi[2] - lo[2]) / (front.base - front.crown + 1)
    views = []
    for sv in read["views"]:
        labels = [sv.label] if sv.label in ("front", "back") else (["left", "right"] if not sv.fixed else [sv.label])
        fits = [(align(sv, mask, depths[label], lo, hi, S), label) for label in labels]
        (iou, c0, r0, hmin, grid), label = max(fits, key=lambda f: f[0][0])
        sv.label = label
        weight = 1.0 if label in ("front", "back") else 0.8
        views.append(View(sv, label, S, c0, r0, hmin, float(hi[2]), iou, weight))
        views[-1].grid = grid
    sides = [v for v in views if v.label in ("left", "right")]
    if len(sides) == 1:
        s = sides[0]
        other = "right" if s.label == "left" else "left"
        views.append(View(s.sv, other, s.S, s.c0, s.r0, s.hmin, s.zmax, s.iou, 0.6, mirror=True, block=no_mirror))
    return views


def alignment_image(read, views, path):
    """Each view's sheet crop with the model's silhouette outline over it (red), side by side."""
    rgb = read["rgb"]
    H = rgb.shape[0]
    tiles = []
    for v in (v for v in views if not v.mirror):
        tile = rgb[:, v.sv.x0:v.sv.x1].copy()
        nr, nc = v.grid.shape
        edge = v.grid & ~sheets.erode(v.grid, 2)
        ys, xs = np.nonzero(edge)
        ys, xs = ys + v.r0, xs + v.c0 - v.sv.x0
        ok = (ys >= 0) & (ys < H) & (xs >= 0) & (xs < tile.shape[1])
        tile[ys[ok], xs[ok]] = (1.0, 0.1, 0.1)
        tiles.append(tile)
        tiles.append(np.ones((H, 6, 3), np.float32))
    img = np.concatenate(tiles[:-1], axis=1)
    out = np.dstack([img, np.ones(img.shape[:2], np.float32)])[::-1]
    save_png(out, path)


# ----------------------------------------------------------------------------- bakes

def uv_unwrap(objs, groups, layer="paint", margin=0.004):
    """A fresh UV layer on every object, each group of faces packed into its own 0..1 atlas, the
    objects of a group sharing it (multi-object edit mode)."""
    for o in objs:
        me = o.data
        uv = me.uv_layers.get(layer) or me.uv_layers.new(name=layer)
        me.uv_layers.active = uv
        uv.active_render = True
    select(objs)
    bpy.ops.object.mode_set(mode="EDIT")
    try:
        for g in sorted({int(x) for gr in groups.values() for x in np.unique(gr)}):
            for o in objs:
                bm = bmesh.from_edit_mesh(o.data)
                bm.faces.ensure_lookup_table()
                gr = groups[o.name]
                for f in bm.faces:
                    f.select = bool(gr[f.index] == g)
                bmesh.update_edit_mesh(o.data)
            bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=margin, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
            bpy.ops.uv.select_all(action="SELECT")
            bpy.ops.uv.pack_islands(margin=margin, rotate=True)
    finally:
        bpy.ops.object.mode_set(mode="OBJECT")


def _bake_material(name, image):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = image
    nt.nodes.active = tex
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    return m, nt, tex, out


def bake_geometry(objs, groups, sizes, centre, radius, mid_attribute):
    """Per group: {pos, nrm, covered, mid} arrays over its atlas (Blender row order). Every object's
    material slots are set to one per group, faces by group."""
    sc = bpy.context.scene
    cycles(sc)
    mats, nts, texs = [], [], []
    for g, size in enumerate(sizes):
        m, nt, tex, out = _bake_material(f"kurambit_bake_{g}", None)
        geo = nt.nodes.new("ShaderNodeNewGeometry")
        attr = nt.nodes.new("ShaderNodeAttribute")
        attr.attribute_name = mid_attribute
        attr.attribute_type = "GEOMETRY"
        vm = nt.nodes.new("ShaderNodeVectorMath")
        vm.operation = "MULTIPLY_ADD"
        em = nt.nodes.new("ShaderNodeEmission")
        nt.links.new(em.outputs[0], out.inputs[0])
        nt.nodes.active = tex
        mats.append(m)
        nts.append((nt, geo, attr, vm, em))
        texs.append(tex)
    assign(objs, groups, mats)
    proxy = proxy_of(objs)
    out = [{} for _ in sizes]
    for kind in ("pos", "nrm", "mid"):
        imgs = []
        for g, size in enumerate(sizes):
            img = new_image(f"kurambit_bake_{kind}_{g}", size, float_buffer=True)
            texs[g].image = img
            imgs.append(img)
            nt, geo, attr, vm, em = nts[g]
            for link in list(nt.links):
                if link.to_node in (em, vm):
                    nt.links.remove(link)
            if kind == "mid":
                nt.links.new(attr.outputs["Fac"], em.inputs["Color"])
                continue
            s = 0.5 / radius if kind == "pos" else 0.25
            vm.inputs[1].default_value = (s, s, s)
            off = 0.5 - np.asarray(centre) * s if kind == "pos" else np.full(3, 0.5)
            vm.inputs[2].default_value = tuple(float(x) for x in off)
            nt.links.new(geo.outputs["Position" if kind == "pos" else "Normal"], vm.inputs[0])
            nt.links.new(vm.outputs[0], em.inputs["Color"])
        bpy.ops.object.bake(type="EMIT")
        for g, img in enumerate(imgs):
            out[g][kind] = image_array(img)
            bpy.data.images.remove(img)
    for g in range(len(sizes)):
        b = out[g]
        b["pos"] = (b["pos"][:, :, :3] - 0.5) * 2 * radius + np.asarray(centre)
        b["nrm"] = (b["nrm"][:, :, :3] - 0.5) * 4
        # the stored material id is 1-based: a texel the bake (or its margin) wrote is never 0
        b["mid"] = np.floor(b["mid"][:, :, 0] + 0.5).astype(np.int32)
        b["covered"] = b["mid"] > 0
    drop(proxy)
    for m in mats:
        bpy.data.materials.remove(m)
    return out


def bake_normal_from_height(objs, groups, heights, strength=1.0, distance=0.004):
    """Tangent-space normal maps from projected detail heights (per group, (H, W, 4) arrays)."""
    sc = bpy.context.scene
    cycles(sc)
    sc.render.bake.normal_space = "TANGENT"
    mats, targets, sources = [], [], []
    for g, h in enumerate(heights):
        src = new_image(f"kurambit_height_{g}", (h.shape[1], h.shape[0]), float_buffer=True)
        src.pixels.foreach_set(np.ascontiguousarray(h, np.float32).ravel())
        tgt = new_image(f"kurambit_normal_{g}", (h.shape[1], h.shape[0]), colour=(0.5, 0.5, 1, 1))
        m, nt, tex, out = _bake_material(f"kurambit_nbake_{g}", tgt)
        hi = nt.nodes.new("ShaderNodeTexImage")
        hi.image = src
        hi.interpolation = "Cubic"
        uvn = nt.nodes.new("ShaderNodeUVMap")
        uvn.uv_map = "paint"
        bump = nt.nodes.new("ShaderNodeBump")
        bump.inputs["Strength"].default_value = strength
        bump.inputs["Distance"].default_value = distance
        bsdf = nt.nodes.new("ShaderNodeBsdfDiffuse")
        nt.links.new(uvn.outputs["UV"], hi.inputs["Vector"])
        nt.links.new(hi.outputs["Color"], bump.inputs["Height"])
        nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
        nt.links.new(bsdf.outputs[0], out.inputs[0])
        nt.nodes.active = tex
        mats.append(m)
        targets.append(tgt)
        sources.append(src)
    assign(objs, groups, mats)
    proxy = proxy_of(objs)
    bpy.ops.object.bake(type="NORMAL")
    drop(proxy)
    out = [image_array(t) for t in targets]
    for m in mats:
        bpy.data.materials.remove(m)
    for img in sources + targets:
        bpy.data.images.remove(img)
    return out


def bake_normal_from_high(low, high, size, extrusion):
    """Tangent-space normal map of a sculpted high mesh onto its game mesh."""
    sc = bpy.context.scene
    cycles(sc)
    sc.render.bake.normal_space = "TANGENT"
    sc.render.bake.use_selected_to_active = True
    sc.render.bake.cage_extrusion = extrusion
    sc.render.bake.max_ray_distance = extrusion * 2
    tgt = new_image("kurambit_normal_high", size, colour=(0.5, 0.5, 1, 1))
    m, nt, tex, out = _bake_material("kurambit_nhigh", tgt)
    low.data.materials.clear()
    low.data.materials.append(m)
    select([high, low], active=low)
    try:
        bpy.ops.object.bake(type="NORMAL")
    finally:
        sc.render.bake.use_selected_to_active = False
    arr = image_array(tgt)
    bpy.data.materials.remove(m)
    bpy.data.images.remove(tgt)
    return arr


# ----------------------------------------------------------------------------- projection

def project(bake, views, depths, read, detail, tol):
    """One atlas: (colour (n, 3), detail (n,), weight (n,), texel index (n,), material id (n,))."""
    cov = bake["covered"].ravel()
    idx = np.flatnonzero(cov)
    P = bake["pos"].reshape(-1, 3)[idx]
    N = bake["nrm"].reshape(-1, 3)[idx]
    N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-6)
    mid = bake["mid"].ravel()[idx] - 1
    acc = np.zeros((len(idx), 3), np.float32)
    dacc = np.zeros(len(idx), np.float32)
    wsum = np.zeros(len(idx), np.float32)
    rgb, mask = read["rgb"], read["mask"]
    for v in views:
        dm = depths[v.label]
        u, y = v.sheet_px(P)
        w = np.abs(N @ dm.look) ** 2 * v.weight
        w *= dm.visible(P, tol)
        w *= (u >= v.sv.x0) & (u < v.sv.x1) & (y >= 0) & (y < rgb.shape[0])
        w *= np.clip((sample(mask, u, y)[:, 0] - 0.5) * 2, 0, 1)
        if v.block:
            w *= ~v.blocked(u, y)
        acc += sample(rgb, u, y) * w[:, None]
        dacc += sample(detail, u, y)[:, 0] * w
        wsum += w
        v.seen = int(getattr(v, "seen", 0) + (w > 0.05).sum())
    col = acc / np.maximum(wsum, 1e-6)[:, None]
    det = dacc / np.maximum(wsum, 1e-6)
    return col, det, wsum, idx, mid


def fill(col, det, wsum, mid, flat):
    """A texel no view sees (or barely) takes its material's median projected colour, or the
    material's own colour when its faces are barely seen at all; blended in by weight."""
    out = np.zeros_like(col)
    for m in np.unique(mid):
        sel = mid == m
        good = sel & (wsum > 0.25)
        out[sel] = np.median(col[good], axis=0) if good.sum() > 40 else flat.get(int(m), (0.5, 0.5, 0.5))
    k = np.clip(wsum / 0.25, 0, 1)
    return col * k[:, None] + out * (1 - k[:, None]), det * k + 0.5 * (1 - k)


def to_atlas(shape, idx, values, background):
    H, W = shape
    a = np.empty((H * W, 4), np.float32)
    a[:] = background
    a[idx, : values.shape[1]] = values
    a[idx, 3] = 1.0
    return a.reshape(H, W, 4)


def textured_material(name, albedo, normal, orm, normal_strength=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs[0], out.inputs[0])
    uvn = nt.nodes.new("ShaderNodeUVMap")
    uvn.uv_map = "paint"
    a = nt.nodes.new("ShaderNodeTexImage")
    a.image = albedo
    nt.links.new(uvn.outputs["UV"], a.inputs["Vector"])
    nt.links.new(a.outputs["Color"], bsdf.inputs["Base Color"])
    n = nt.nodes.new("ShaderNodeTexImage")
    n.image = normal
    normal.colorspace_settings.name = "Non-Color"
    nt.links.new(uvn.outputs["UV"], n.inputs["Vector"])
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nm.uv_map = "paint"
    nm.inputs["Strength"].default_value = normal_strength
    nt.links.new(n.outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    o = nt.nodes.new("ShaderNodeTexImage")
    o.image = orm
    orm.colorspace_settings.name = "Non-Color"
    nt.links.new(uvn.outputs["UV"], o.inputs["Vector"])
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(o.outputs["Color"], sep.inputs[0])
    nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    m.diffuse_color = (0.5, 0.5, 0.5, 1)
    m["kurambit_paint"] = 1  # painting it again keeps the materials it was painted over
    return m


def material_info(m):
    """What a texel of this original material keeps: its flat colour (sRGB) for the fill, and its
    roughness and metalness for the ORM map."""
    colour, _ = stylepass.material_colour(m)
    rough, metal = 0.8, 0.0
    bsdf = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None) if m is not None and m.node_tree is not None else None
    if bsdf is not None:
        rough = float(bsdf.inputs["Roughness"].default_value)
        metal = float(bsdf.inputs["Metallic"].default_value)
    return {"name": m.name if m is not None else "", "colour": [round(float(c), 4) for c in colour], "roughness": round(rough, 3), "metallic": round(metal, 3)}


def paint_atlases(objs, groups, sizes, views, depths, read, detail, infos, out_dir, stem, tol, mid_attribute, normals=None, normal_distance=0.004):
    """Projects and bakes every group's atlas; writes <stem>[_head]_{albedo,normal,orm}.png into
    out_dir and gives every object its painted materials. normals: precomputed normal maps per
    group (a sculpt's bake) instead of the detail's bump. Returns (files, seen share)."""
    pts = evaluated_points(objs)
    lo, hi = pts.min(0), pts.max(0)
    centre, radius = (lo + hi) / 2, float((hi - lo).max()) * 0.5 + 0.05
    log("baking positions, normals and materials", sizes)
    bakes = bake_geometry(objs, groups, sizes, centre, radius, mid_attribute)
    log("projecting")
    flat = {i: info["colour"] for i, info in enumerate(infos)}
    albedos, heights, orms = [], [], []
    seen = covered = 0
    for g, bake in enumerate(bakes):
        col, det, wsum, idx, mid = project(bake, views, depths, read, detail, tol)
        col, det = fill(col, det, wsum, mid, flat)
        seen += int((wsum > 0.25).sum())
        covered += len(idx)
        shape = bake["covered"].shape
        albedos.append(to_atlas(shape, idx, col, (0.5, 0.5, 0.5, 1.0)))
        heights.append(to_atlas(shape, idx, np.repeat(det[:, None], 3, 1), (0.5, 0.5, 0.5, 1.0)))
        orm = np.zeros((len(idx), 3), np.float32)
        orm[:, 0] = 1.0
        for m in np.unique(mid):
            info = infos[int(m)] if 0 <= m < len(infos) else {"roughness": 0.8, "metallic": 0.0}
            orm[mid == m, 1], orm[mid == m, 2] = info["roughness"], info["metallic"]
        orms.append(to_atlas(shape, idx, orm, (1.0, 0.8, 0.0, 1.0)))
    log("baking the detail normal map" if normals is None else "writing textures")
    if normals is None:
        normals = bake_normal_from_height(objs, groups, heights, distance=normal_distance)
    files, mats = [], []
    for g in range(len(sizes)):
        part = f"{stem}{'_head' if g == 1 else ''}"
        a = save_png(albedos[g], os.path.join(out_dir, f"{part}_albedo.png"))
        n = save_png(normals[g], os.path.join(out_dir, f"{part}_normal.png"), non_color=True)
        r = save_png(orms[g], os.path.join(out_dir, f"{part}_orm.png"), non_color=True)
        files += [a.filepath, n.filepath, r.filepath]
        mats.append(textured_material(part, a, n, r))
    assign(objs, groups, mats)
    return files, seen / max(covered, 1)


def detail_height(read, sigma=3.0, gain=2.0):
    """The sheet's luminance high-pass, centred at 0.5: carved and painted detail for the normal map."""
    lum = read["lum"]
    return np.clip(0.5 + (lum - sheets.blur(lum, sigma)) * gain, 0, 1)


def refuse_poor_fit(views, minimum=0.5):
    poor = [v for v in views if not v.mirror and v.iou < minimum]
    if poor:
        text = ", ".join(f"{v.label} {v.iou:.0%}" for v in poor)
        raise Refused("invalid-input", f"the model's silhouette does not match the sheet ({text} overlap, at least {minimum:.0%} needed): pose and proportion it as the sheet shows it (pose sets the arms and legs of a standard-skeleton character), or check that the sheet is this subject's. Nothing was baked.")
