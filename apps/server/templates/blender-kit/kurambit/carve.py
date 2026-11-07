"""carve(): an organic hard prop (a statue, a carving, a rock, a trunk) made from its three-view
sheet, and adopt(): it into the live scene.

carve runs in the one-shot pass, in an empty scene:
  1. a visual hull: voxels kept where the front, side and back silhouettes agree. Three views alone
     carve box-like sections, so each horizontal section is rounded to a squircle inside the
     silhouette runs its voxels belong to; below `box` metres (a plinth) sections stay boxes;
  2. a voxel remesh and a smooth: a clean dense statue;
  3. a relief sculpt: each vertex pushed along its normal by the sheet's band-passed luminance,
     projected from the views that see it (carved curls, brows and panels are light and dark in
     the painting, so they become relief);
  4. the game mesh: decimated to the triangle budget, the sheet's colour projected onto it like a
     painted model, and its normal map baked from the sculpt.
params: sheet, views, name, height (m), box (m), triangles, size, relief, roughness, metallic, out.
The prop stands on the ground at the origin, facing -Y."""
import json
import math
import os

import bpy
import numpy as np

from . import paint, project, skeleton
from . import sheet as sheets
from .protocol import Refused, entry

SQUIRCLE = 2.6


def _apply(o):
    project.select([o])
    for m in list(o.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def _voxels_to_mesh(occ, origin, vox, name):
    """The boundary faces of an occupancy grid as one quad mesh."""
    nx, ny, nz = occ.shape
    p = np.zeros((nx + 2, ny + 2, nz + 2), bool)
    p[1:-1, 1:-1, 1:-1] = occ

    def cid(i, j, k):
        return (i * (ny + 1) + j) * (nz + 1) + k

    quads = []
    for ax in range(3):
        i, j, k = np.nonzero(np.diff(p.astype(np.int8), axis=ax))
        if ax == 0:
            j, k = j - 1, k - 1
            q = [cid(i, j, k), cid(i, j + 1, k), cid(i, j + 1, k + 1), cid(i, j, k + 1)]
        elif ax == 1:
            i, k = i - 1, k - 1
            q = [cid(i, j, k), cid(i + 1, j, k), cid(i + 1, j, k + 1), cid(i, j, k + 1)]
        else:
            i, j = i - 1, j - 1
            q = [cid(i, j, k), cid(i + 1, j, k), cid(i + 1, j + 1, k), cid(i, j + 1, k)]
        quads.append(np.stack(q, 1))
    quads = np.concatenate(quads)
    used, inv = np.unique(quads, return_inverse=True)
    quads = inv.reshape(-1, 4)
    k = used % (nz + 1)
    j = (used // (nz + 1)) % (ny + 1)
    i = used // ((nz + 1) * (ny + 1))
    co = np.stack([origin[0] + i * vox, origin[1] + j * vox, origin[2] + k * vox], 1)
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(co))
    me.vertices.foreach_set("co", co.astype(np.float32).ravel())
    me.loops.add(len(quads) * 4)
    me.loops.foreach_set("vertex_index", quads.astype(np.int32).ravel())
    me.polygons.add(len(quads))
    me.polygons.foreach_set("loop_start", np.arange(0, len(quads) * 4, 4, dtype=np.int32))
    me.update(calc_edges=True)
    me.validate()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def _row(mask, v, z):
    """The view's mask row at height z (m)."""
    r = int(math.floor(v.r0 + (v.zmax - z) / v.S))
    return mask[min(max(r, 0), mask.shape[0] - 1)]


def _cols(v, h):
    return v.c0 + h / v.S


def _inside(row, cols, x0, x1):
    ci = np.floor(cols).astype(np.int64)
    ok = (ci >= x0) & (ci < x1)
    return ok & row[np.clip(ci, 0, len(row) - 1)], np.clip(ci, 0, len(row) - 1)


def _match_mirror(mask, a, b, height, vox):
    """Shifts view b's centre column so its silhouette, mirrored, best overlaps view a's (the back
    against the front, one side against the other): their centres are measured independently."""
    hs = np.arange(-height, height, vox)
    zs = np.arange(vox / 2, height, vox)
    A = np.stack([_inside(_row(mask, a, z), _cols(a, hs), a.sv.x0, a.sv.x1)[0] for z in zs])
    best = (-1.0, 0)
    for d in range(-14, 15):
        B = np.stack([_inside(_row(mask, b, z), b.c0 + d + (-hs) / b.S, b.sv.x0, b.sv.x1)[0] for z in zs])
        inter = (A & B).sum()
        iou = inter / max((A | B).sum(), 1)
        if iou > best[0]:
            best = (iou, d)
    b.c0 += best[1]
    return best[0]


def hull(mask, front, back, sides, height, box, vox):
    """The rounded visual hull as an occupancy grid, and the grid's corner origin."""
    half = lambda v: max(abs((v.sv.x0 - v.c0) * v.S), abs((v.sv.x1 - v.c0) * v.S)) + vox  # noqa: E731
    hx = half(front)
    hy = max(half(s) for s in sides)
    xs = np.arange(-hx, hx, vox) + vox / 2
    ys = np.arange(-hy, hy, vox) + vox / 2
    zs = np.arange(0, height, vox) + vox / 2
    occ = np.zeros((len(xs), len(ys), len(zs)), bool)
    for k, z in enumerate(zs):
        rf = _row(mask, front, z)
        inf, fi = _inside(rf, _cols(front, xs), front.sv.x0, front.sv.x1)
        cf, hf = sheets.runs(rf)
        keep_x = inf.copy()
        if back is not None:
            keep_x &= _inside(_row(mask, back, z), _cols(back, -xs), back.sv.x0, back.sv.x1)[0]
        s = sides[0]
        sign = 1.0 if s.label == "left" else -1.0  # left: image-right is +Y
        rs = _row(mask, s, z)
        ins, si = _inside(rs, _cols(s, sign * ys), s.sv.x0, s.sv.x1)
        for other in sides[1:]:
            osign = 1.0 if other.label == "left" else -1.0
            ins &= _inside(_row(mask, other, z), _cols(other, osign * ys), other.sv.x0, other.sv.x1)[0]
        cs, hs = sheets.runs(rs)
        o2 = keep_x[:, None] & ins[None, :]
        if z >= box and o2.any():
            u = (_cols(front, xs) - 0.5 - cf[fi]) / hf[fi]
            v = (_cols(s, sign * ys) - 0.5 - cs[si]) / hs[si]
            o2 &= (np.abs(u)[:, None] ** SQUIRCLE + np.abs(v)[None, :] ** SQUIRCLE) <= 1.0
        occ[:, :, k] = o2
    return occ, (xs[0] - vox / 2, ys[0] - vox / 2, 0.0)


def _place(read, height):
    """Each sheet view on the prop: metres per pixel from its own height, its centre column, the
    ground at its baseline."""
    views = []
    for sv in read["views"]:
        S = height / (sv.base - sv.crown + 1)
        views.append(project.View(sv, sv.label, S, sv.centre + 0.5, sv.crown, 0.0, height, 1.0, 1.0 if sv.label in ("front", "back") else 0.8))
    return views


def sculpt(high, views, read, height, box, relief, out):
    """Pushes each vertex along its normal by the sheet's band-passed luminance, from the views
    that see it, facing them."""
    lum = read["lum"]
    band = sheets.blur(lum, 1.2) - sheets.blur(lum, 9.0)
    me = high.data
    n = len(me.vertices)
    P = np.empty(n * 3, np.float32)
    me.vertices.foreach_get("co", P)
    P = P.reshape(-1, 3)
    N = np.empty(n * 3, np.float32)
    me.vertices.foreach_get("normal", N)
    N = N.reshape(-1, 3)
    lo, hi = P.min(0), P.max(0)
    S = min(v.S for v in views)
    depths = {}
    acc = np.zeros(n, np.float32)
    ws = np.zeros(n, np.float32)
    for v in views:
        if v.label not in depths:
            depths[v.label] = project.Depth(v.label, [high], lo, hi, S / 2, out)
        dm = depths[v.label]
        w = np.clip(-(N @ dm.look), 0, 1) ** 2 * dm.visible(P, 0.011 * height) * v.weight
        u, y = v.sheet_px(P)
        w *= (u >= v.sv.x0) & (u < v.sv.x1)
        acc += project.sample(band, u, y)[:, 0] * w
        ws += w
    disp = np.clip(acc / np.maximum(ws, 1e-4), -0.25, 0.25) * np.clip(ws / 0.3, 0, 1)
    amp = np.where(P[:, 2] > box, 0.056, 0.028) * height * relief
    me.vertices.foreach_set("co", (P + N * (disp * amp)[:, None]).ravel())
    me.update()
    sm = high.modifiers.new("smooth", "SMOOTH")
    sm.factor, sm.iterations = 0.5, 1
    _apply(high)


@entry
def carve(params):
    for o in list(bpy.data.objects):  # the factory scene's cube, camera and light
        bpy.data.objects.remove(o)
    bpy.context.view_layer.update()
    out = params["out"]
    os.makedirs(out, exist_ok=True)
    height = float(params["height"])
    box = float(params.get("box") or 0.0)
    name = params["name"]
    read = sheets.read_sheet(params["sheet"], params.get("views"))
    notes = list(read["notes"])
    mask = read["mask"] > 0.5
    views = _place(read, height)
    front = next(v for v in views if v.label == "front")
    back = next((v for v in views if v.label == "back"), None)
    sides = [v for v in views if v.label in ("left", "right")]
    if not sides:
        raise Refused("invalid-input", "carving needs a side view beside the front: the sheet's views are " + ", ".join(v.label for v in views))
    vox = height / 280.0
    if back is not None:
        fit = _match_mirror(mask, front, back, height, vox)
        if fit < 0.6:
            notes.append(f"the back view's silhouette overlaps the mirrored front's only {fit:.0%}: check the views are labelled right")
    if len(sides) == 2:
        _match_mirror(mask, sides[0], sides[1], height, vox)
    occ, origin = hull(mask, front, back, sides, height, box, vox)
    project.log("hull voxels", int(occ.sum()), occ.shape)
    if occ.sum() < 1000:
        raise Refused("invalid-input", "the views' silhouettes barely agree, so they carve almost nothing: check that they are one subject's front, side and back at the same scale")
    high = _voxels_to_mesh(occ, origin, vox, f"{name}_high")
    del occ
    r = high.modifiers.new("remesh", "REMESH")
    r.mode, r.voxel_size = "VOXEL", vox * 0.85
    sm = high.modifiers.new("smooth", "SMOOTH")
    sm.factor, sm.iterations = 0.9, 12
    _apply(high)
    project.log("remeshed", len(high.data.vertices))
    if len(sides) == 1:
        s = sides[0]
        views.append(project.View(s.sv, "right" if s.label == "left" else "left", s.S, s.c0, s.r0, 0.0, height, 1.0, 0.6, mirror=True))
    sculpt(high, views, read, height, box, float(params.get("relief", 1.0)), out)
    project.log("sculpted")
    low = high.copy()
    low.data = high.data.copy()
    bpy.context.scene.collection.objects.link(low)
    dec = low.modifiers.new("decimate", "DECIMATE")
    dec.ratio = min(1.0, int(params["triangles"]) / max(2 * len(high.data.polygons), 1))
    _apply(low)
    low.name = low.data.name = name
    for p in low.data.polygons:
        p.use_smooth = True
    info = {"name": name, "colour": [0.5, 0.5, 0.5], "roughness": float(params.get("roughness", 0.8)), "metallic": float(params.get("metallic", 0.0))}
    low.data.attributes.new(paint.GID, "FLOAT", "FACE").data.foreach_set("value", np.ones(len(low.data.polygons), np.float32))
    groups = {low.name: np.zeros(len(low.data.polygons), np.int32)}
    project.uv_unwrap([low], groups)
    size = int(params["size"])
    normal = project.bake_normal_from_high(low, high, size, 0.017 * height)
    high.hide_render = True
    pts = project.evaluated_points([low])
    lo, hi = pts.min(0), pts.max(0)
    depths = {label: project.Depth(label, [low], lo, hi, front.S / 2, out) for label in {v.label for v in views}}
    files, seen = project.paint_atlases([low], groups, [size], views, depths, read, project.detail_height(read), [info], out, name, 0.011 * height, paint.GID, normals=[normal])
    low.data.attributes.remove(low.data.attributes[paint.GID])
    skeleton.remove_objects([high])
    triangles = sum(len(p.vertices) - 2 for p in low.data.polygons)
    library = os.path.join(out, "carved.blend")
    bpy.data.libraries.write(library, {low}, path_remap="ABSOLUTE", fake_user=True)
    return {
        "library": library,
        "object": low.name,
        "triangles": triangles,
        "size": [round(float(x), 3) for x in hi - lo],
        "files": [os.path.basename(f) for f in files],
        "views": [{**v.sv.describe(), "label": v.label} for v in views if not v.mirror],
        "mirrored": next((v.label for v in views if v.mirror), None),
        "seen": round(seen, 3),
        "notes": [n[:400] for n in notes],
    }


@entry
def adopt(params):
    """The carved prop into the live scene, in its own collection; replace swaps one carved before,
    keeping where it stands."""
    skeleton.object_mode()
    name = params["name"]
    old = bpy.data.objects.get(name)
    coll = bpy.data.collections.get(name)
    where = None
    if old is not None or coll is not None:
        if not params.get("replace"):
            raise Refused("invalid-input", f"{name} already exists in the live scene: carve again with replace: true to replace it, or under another name")
        if old is not None:
            where = old.matrix_world.copy()
            skeleton.remove_objects([old])
    with bpy.data.libraries.load(params["library"], link=False) as (_src, dst):
        dst.objects = [params["object"]]
    o = dst.objects[0]
    o.use_fake_user = False
    o.name = name
    if coll is None:
        coll = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(coll)
    coll.objects.link(o)
    if where is not None:
        o.matrix_world = where
    o["kurambit_source"] = json.dumps({"what": "mesh", **params["stamp"]})
    o["kurambit_paint"] = json.dumps({"what": "texture", **params["stamp"]})
    images = paint.unfake([o.data], [s.material for s in o.material_slots if s.material is not None])
    written = paint._adopt_images(images, params["dest"], paint.stem)
    paint.sweep(params["dest"])
    return {"objects": [o.name], "files": written}
