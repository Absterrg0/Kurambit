"""The style pass every exported model goes through: palette, shading, scale and budgets.

It runs only in the one-shot pass, on its own copy of the scene, so the live scene keeps the
agent's materials and modifiers. From STYLE.json:
  palette  a hex list: every material snaps to its nearest colour (in Lab; a textured one face by
           face, by the texture under each face), and the palette becomes
           one small atlas of vertical-gradient swatches (shading.gradient); each face samples its
           swatch by height in the model, so every part gets the same soft top light. Two
           materials result, Palette and Glow (shading.glow), on the one atlas. Without a hex list
           the materials are kept, their textures scaled down to budget.texture, and the flat
           colours that share a finish become one material painted per vertex (fold_flat), so a
           colour costs no draw call.
  scale    scale.character: a character is scaled to that standing height on its armature's
           object, so clip units are unchanged. Props, models on their own rig (kurambit_rig: a
           creature, a vehicle) and characters with a declared height keep their modelled metres.
A character's meshes are joined into one skinned mesh: one mesh, two draw calls."""
import math
import os

import bpy
import numpy as np

from . import helpers, skeleton

# depth: how strongly a made model is shaded into its vertex colours (shade); 0 leaves it flat.
DEFAULT_SHADING = {"gradient": 0.16, "roughness": 0.62, "glow": 2.5, "depth": 0.6}
COLS, SWATCH_W, SWATCH_H = 8, 8, 32


def _lin(c):
    return ((c + 0.055) / 1.055) ** 2.4 if c > 0.04045 else c / 12.92


def _srgb(c):
    c = max(0.0, min(1.0, c))
    return 1.055 * c ** (1 / 2.4) - 0.055 if c > 0.0031308 else 12.92 * c


def _hex(h):
    return [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]


def _lab(rgb):
    """sRGB 0..1 to CIE Lab (D65)."""
    r, g, b = (_lin(x) for x in rgb)
    x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
    f = lambda t: t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116
    return (116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z)))


def realize(o):
    """A plain mesh object with its modifiers applied, except the Armature modifier (geometry the
    export would otherwise drop or re-evaluate). Curves and text become meshes."""
    if o.type != "MESH":
        dg = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(o.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
        m = bpy.data.objects.new(o.name, me)
        for c in o.users_collection:
            c.objects.link(m)
        m.parent, m.parent_type, m.parent_bone = o.parent, o.parent_type, o.parent_bone
        m.matrix_world = o.matrix_world.copy()
        for k in o.keys():
            m[k] = o[k]
        name = o.name
        bpy.data.objects.remove(o)
        m.name = name
        return m
    if o.data.users > 1:
        o.data = o.data.copy()
    if o.data.shape_keys is not None or any(m.type != "ARMATURE" for m in o.modifiers):
        skeleton.baked_mesh(o, keep=lambda m: m.type == "ARMATURE")
    return o


def _bind_bone_children(arm, meshes):
    """A part parented to a bone becomes a mesh skinned rigidly to that bone, so it can be joined."""
    for o in meshes:
        if o.parent == arm and o.parent_type == "BONE":
            bone = o.parent_bone
            skeleton.to_world(o)
            for vg in list(o.vertex_groups):
                o.vertex_groups.remove(vg)
            o.vertex_groups.new(name=bone).add(list(range(len(o.data.vertices))), 1.0, "REPLACE")
            skeleton.bind(o, arm)


def join_character(arm, meshes):
    """Joins the meshes an armature deforms into one, named <armature>_mesh."""
    _bind_bone_children(arm, meshes)
    mine = [o for o in meshes if arm in helpers._deforming(o)]
    if len(mine) < 2:
        return meshes
    target = mine[0]
    others = [o for o in meshes if o not in mine]
    with bpy.context.temp_override(active_object=target, object=target, selected_objects=mine,
                                   selected_editable_objects=mine):
        bpy.ops.object.join()
    target.name = f"{arm.name}_mesh"
    return [target] + others


def _image_mean(image):
    n = len(image.pixels) // 4  # reading pixels loads the buffer; size reads 0 x 0 until then
    if n == 0:
        return None
    px = np.empty(n * 4, np.float32)
    image.pixels.foreach_get(px)
    px = px.reshape(-1, 4)
    w = px[:, 3] if px[:, 3].sum() > 0 else np.ones(len(px))
    rgb = (px[:, :3] * w[:, None]).sum(0) / w.sum()
    # float images hold linear values; byte images hold their sRGB bytes
    return [_srgb(c) for c in rgb] if image.is_float else list(rgb)


def _feeding_image(socket, depth=4):
    """The first image upstream of a socket (glTF imports put a Mix node for vertex colour between)."""
    nodes = [link.from_node for link in socket.links]
    for _ in range(depth):
        for n in nodes:
            if getattr(n, "image", None) is not None:
                return n.image
        nodes = [link.from_node for n in nodes for i in n.inputs for link in i.links]
    return None


def material_colour(m):
    """(sRGB colour, emissive) of a material: its Principled base colour, or the mean of the image
    feeding it."""
    if m is None or m.node_tree is None:
        c = m.diffuse_color if m is not None else (0.8, 0.8, 0.8, 1)
        return [_srgb(x) for x in c[:3]], False
    bsdf = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        return [0.8, 0.8, 0.8], False
    strength = bsdf.inputs["Emission Strength"].default_value
    glow = strength > 0.01 and max(bsdf.inputs["Emission Color"].default_value[:3]) > 0.01
    base = bsdf.inputs["Base Color"]
    image = _feeding_image(base)
    mean = _image_mean(image) if image is not None else None
    if mean is not None:
        return mean, glow
    return [_srgb(x) for x in base.default_value[:3]], glow


def _lab_np(rgb):
    """_lab over an (n, 3) array of sRGB 0..1."""
    c = np.where(rgb > 0.04045, ((rgb + 0.055) / 1.055) ** 2.4, rgb / 12.92)
    xyz = c @ np.array([[0.4124, 0.2126, 0.0193], [0.3576, 0.7152, 0.1192], [0.1805, 0.0722, 0.9505]])
    xyz /= np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[:, 1] - 16, 500 * (f[:, 0] - f[:, 1]), 200 * (f[:, 1] - f[:, 2])], 1)


def _srgb_pixels(image):
    """(h, w, 3) sRGB 0..1 of an image, or None when it cannot be read."""
    if len(image.pixels) == 0:
        return None
    w, h = image.size
    px = np.empty(w * h * 4, np.float32)
    image.pixels.foreach_get(px)
    rgb = px.reshape(h, w, 4)[:, :, :3]
    if image.is_float:
        rgb = np.where(rgb > 0.0031308, 1.055 * np.power(np.clip(rgb, 0, 1), 1 / 2.4) - 0.055, 12.92 * rgb)
    return rgb


def _face_swatches(me, images, mat_index, loop_poly, plab):
    """Per face, the palette entry its material's base-colour image shows under it, for faces whose
    material is textured (a generator's one baked texture, a pack's colormap): (swatch (n,), mask (n,)).
    Each corner and the centre (counted twice) snap on their own and the face takes the most votes,
    so a face across a colour edge takes one side, never a third colour its mean would land on."""
    n = len(me.polygons)
    swatch, mask = np.zeros(n, np.int64), np.zeros(n, bool)
    uv_layer = me.uv_layers.active
    if uv_layer is None or not any(img is not None for img in images):
        return swatch, mask
    uv = np.empty(len(me.loops) * 2, np.float32)
    uv_layer.data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    count = np.bincount(loop_poly, minlength=n)
    centre = np.stack([np.bincount(loop_poly, weights=uv[:, i], minlength=n) for i in (0, 1)], 1) / np.maximum(count, 1)[:, None]
    plab = np.array(plab)
    votes = np.zeros((n, len(plab)))
    for k, img in enumerate(images):
        if img is None:
            continue
        loops = (mat_index == k)[loop_poly]
        faces = np.where((mat_index == k) & (count > 0))[0]
        if len(faces) == 0:
            continue
        at = np.concatenate([uv[loops], centre[faces], centre[faces]])
        owner = np.concatenate([loop_poly[loops], faces, faces])
        h, w = img.shape[:2]
        x = np.clip((np.mod(at[:, 0], 1.0) * w).astype(np.int64), 0, w - 1)
        y = np.clip((np.mod(at[:, 1], 1.0) * h).astype(np.int64), 0, h - 1)
        lab = _lab_np(img[y, x].astype(np.float64))
        label = np.argmin(((lab[:, None, :] - plab[None]) ** 2).sum(2), 1)
        np.add.at(votes, (owner, label), 1)
        mask[faces] = True
    swatch[mask] = np.argmax(votes[mask], 1)
    return swatch, mask


def _atlas(palette, gradient, out_dir):
    rows = math.ceil(len(palette) / COLS)
    img = bpy.data.images.new("palette", COLS * SWATCH_W, rows * SWATCH_H, alpha=False)
    px = np.ones((rows * SWATCH_H, COLS * SWATCH_W, 4), np.float32)
    for i, c in enumerate(palette):
        col, row = i % COLS, rows - 1 - i // COLS
        for y in range(SWATCH_H):
            k = 1 - gradient + 2 * gradient * y / (SWATCH_H - 1)  # bottom darker, top lighter
            px[row * SWATCH_H + y, col * SWATCH_W:(col + 1) * SWATCH_W, :3] = [_srgb(_lin(x) * k) for x in c]
    img.pixels.foreach_set(px.ravel())
    img.filepath_raw = os.path.join(out_dir, "palette.png")
    img.file_format = "PNG"
    img.save()
    img.pack()
    return img, rows


def _palette_material(name, img, shading, glow):
    m = bpy.data.materials.new(name)
    helpers.use_nodes(m)
    m.use_backface_culling = True  # closed shapes: single-sided in glTF, half the fill cost
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.interpolation = "Linear"
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = shading["roughness"]
    bsdf.inputs["Metallic"].default_value = 0.0
    if glow:
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = shading["glow"]
    return m


def snap_palette(meshes, hexes, shading, out_dir):
    """Every material onto the palette atlas; returns the palette entries used, in palette order."""
    pal = [_hex(h) for h in hexes]
    plab = [_lab(c) for c in pal]
    nearest = lambda rgb: min(range(len(pal)), key=lambda i: sum((a - b) ** 2 for a, b in zip(_lab(rgb), plab[i])))
    img, rows = _atlas(pal, shading["gradient"], out_dir)
    flat, glow_mat = _palette_material("Palette", img, shading, False), _palette_material("Glow", img, shading, True)
    used, seen, pixel_cache = set(), set(), {}
    for o in meshes:
        me = o.data
        if me.as_pointer() in seen:  # a mesh several objects share is styled once
            continue
        seen.add(me.as_pointer())
        infos = [material_colour(s.material) for s in o.material_slots] or [([0.8, 0.8, 0.8], False)]
        idx = [nearest(c) for c, _ in infos]
        np_ = len(me.polygons)
        mat_index = np.empty(np_, np.int32)
        me.polygons.foreach_get("material_index", mat_index)
        mat_index = np.minimum(mat_index, len(idx) - 1)
        swatch = np.array(idx)[mat_index]
        glows = np.array([g for _, g in infos])[mat_index]
        loop_poly = np.repeat(np.arange(np_), [p.loop_total for p in me.polygons])
        # A textured material (a generator's one baked texture, a pack's colormap) is many colours:
        # each face snaps to the palette by what its texture shows under it, not by the mean.
        images = []
        for slot in o.material_slots:
            m = slot.material
            bsdf = next((nd for nd in m.node_tree.nodes if nd.type == "BSDF_PRINCIPLED"), None) if m is not None and m.node_tree is not None else None
            img = _feeding_image(bsdf.inputs["Base Color"]) if bsdf is not None else None
            if img is not None and img.name not in pixel_cache:
                pixel_cache[img.name] = _srgb_pixels(img)
            images.append(pixel_cache.get(img.name) if img is not None else None)
        snapped, textured = _face_swatches(me, images, mat_index, loop_poly, plab)
        swatch[textured] = snapped[textured]
        used.update(int(k) for k in np.unique(swatch))
        co = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get("co", co)
        m = np.array(o.matrix_world)
        z = (co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3])[:, 2]
        loop_v = np.empty(len(me.loops), np.int32)
        me.loops.foreach_get("vertex_index", loop_v)
        loop_swatch = swatch[loop_poly]
        lz = z[loop_v]
        t = np.full(len(lz), 0.5)
        for k in np.unique(loop_swatch):
            sel = loop_swatch == k
            lo, hi = lz[sel].min(), lz[sel].max()
            if hi - lo > 1e-6:
                t[sel] = (lz[sel] - lo) / (hi - lo)
        u = ((loop_swatch % COLS) + 0.5) / COLS
        v = ((rows - 1 - loop_swatch // COLS) + 0.08 + 0.84 * t) / rows
        for name in [layer.name for layer in me.uv_layers]:  # removing a layer invalidates the others' references
            me.uv_layers.remove(me.uv_layers[name])
        uv = me.uv_layers.new(name="palette")
        uv.data.foreach_set("uv", np.stack([u, v], 1).ravel().astype(np.float32))
        me.materials.clear()  # this resets every face's material index: set them again below
        me.materials.append(flat)
        me.materials.append(glow_mat)
        me.polygons.foreach_set("material_index", glows.astype(np.int32))
    return [hexes[k] for k in sorted(used)]


# What makes two flat materials one finish: every Principled input the glTF export writes, but the colour.
_FINISH = ("Roughness", "Metallic", "IOR", "Specular IOR Level", "Transmission Weight", "Coat Weight", "Coat Roughness", "Sheen Weight")
PAINT = "Col"
MAX_PAINTS = 64


def _flat(m):
    """(sRGB colour, finish) of a material that is one flat opaque colour with nothing plugged in,
    or None: a textured, glowing or see-through one keeps its own material."""
    if m is None or m.node_tree is None:
        return None
    bsdfs = [n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"]
    if len(bsdfs) != 1 or any(i.is_linked for i in bsdfs[0].inputs):
        return None
    b = bsdfs[0].inputs
    if b["Alpha"].default_value < 0.999:
        return None
    if b["Emission Strength"].default_value > 0.01 and max(b["Emission Color"].default_value[:3]) > 0.01:
        return None
    finish = tuple(round(float(b[k].default_value), 2) for k in _FINISH if k in b) + (bool(m.use_backface_culling),)
    return [_srgb(x) for x in b["Base Color"].default_value[:3]], finish


def fold_flat(meshes, single=False):
    """Flat-colour materials that share a finish become one material, Paint, each colour painted
    per vertex: a hero in twenty colours draws as one mesh in one call, so a colour is free. A
    finish only one material has (unless single: a model shaded per vertex needs its one colour
    there too), and a mesh that already carries vertex colours, stay as they are. Returns [{"colour": "#rrggbb", "name": the material it was}] for the sidecar, so Art names
    each colour as its maker did."""
    flats = {}
    for o in meshes:
        if len(o.data.color_attributes) > 0:
            continue
        for s in o.material_slots:
            f = _flat(s.material)
            if f is not None:
                flats[s.material] = f
    groups = {}
    for m, (_, finish) in flats.items():
        groups.setdefault(finish, []).append(m)
    into, paints = {}, {}
    for n, mats in enumerate(g for g in groups.values() if len(g) > (0 if single else 1)):
        paint = sorted(mats, key=lambda m: m.name)[0].copy()
        paint.name = "Paint" if n == 0 else f"Paint {n + 1}"
        nt = paint.node_tree
        bsdf = next(nd for nd in nt.nodes if nd.type == "BSDF_PRINCIPLED")
        bsdf.inputs["Base Color"].default_value = (1, 1, 1, 1)
        col = nt.nodes.new("ShaderNodeVertexColor")
        col.layer_name = PAINT
        nt.links.new(col.outputs["Color"], bsdf.inputs["Base Color"])
        for m in mats:
            into[m] = paint
            hexed = "#%02x%02x%02x" % tuple(round(max(0.0, min(1.0, c)) * 255) for c in flats[m][0])
            paints.setdefault(hexed, m.name)
    if not into:
        return []
    for o in meshes:
        me = o.data
        if len(me.color_attributes) > 0 or not any(s.material in into for s in o.material_slots):
            continue
        slots = [s.material for s in o.material_slots]
        mat_index = np.empty(len(me.polygons), np.int32)
        me.polygons.foreach_get("material_index", mat_index)
        mat_index = np.minimum(mat_index, len(slots) - 1)
        # glTF's COLOR_0 is linear; a face of a material that keeps its own stays white under it.
        colour = np.array([[_lin(c) for c in flats[m][0]] + [1.0] if m in into else [1.0] * 4 for m in slots])
        loop_poly = np.repeat(np.arange(len(me.polygons)), [p.loop_total for p in me.polygons])
        attr = me.color_attributes.new(PAINT, "FLOAT_COLOR", "CORNER")
        attr.data.foreach_set("color", colour[mat_index][loop_poly].ravel().astype(np.float32))
        me.color_attributes.active_color = attr
        me.color_attributes.render_color_index = 0
        kept = []
        for m in slots:
            m = into.get(m, m)
            if m not in kept:
                kept.append(m)
        remap = np.array([kept.index(into.get(m, m)) for m in slots], np.int32)
        me.materials.clear()  # this resets every face's material index: set them again below
        for m in kept:
            me.materials.append(m)
        me.polygons.foreach_set("material_index", remap[mat_index])
    return [{"colour": c, "name": n[:64]} for c, n in list(paints.items())[:MAX_PAINTS]]


# The least a vertex is shaded to at full depth, and how far a shading ray looks, as a share of the
# model's height.
SHADE_FLOOR = 0.55
SHADE_REACH = 0.05
# A colour darker than this (linear luminance, mid grey) has little room below it: its shade is
# eased toward SHADE_DARK of its strength, so a dark cloth stays its colour and does not go black.
SHADE_MID = 0.18
SHADE_DARK = 0.4
_RAYS = [(math.sin(a) * math.cos(b), math.sin(a) * math.sin(b), math.cos(a))
         for a, n in ((math.radians(25), 4), (math.radians(60), 7)) for b in [2 * math.pi * (k + 0.5 * (n == 7)) / n for k in range(n)]]


def shade(meshes, depth):
    """Depth baked into a made model, so it does not read as plastic under any light: each painted
    vertex gets a shade (1 untouched .. SHADE_FLOOR) from what is near it (dark in creases and
    where parts meet), its height (a soft gradient to the ground), which way it faces (a darker
    underside) and how it stands out (worn edges stay light). depth 0..1 scales all of it.

    The shade goes in the paint colour's alpha, which an opaque material never uses, and the
    game's shader multiplies it in: the colour itself stays flat, so Art still reads and edits each
    colour of the model as one swatch."""
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree

    for o in meshes:
        me = o.data
        attr = me.color_attributes.get(PAINT)
        if attr is None or len(me.vertices) == 0:
            continue
        n = len(me.vertices)
        co = np.empty(n * 3)
        me.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3)
        nrm = np.empty(n * 3)
        me.vertices.foreach_get("normal", nrm)
        nrm = nrm.reshape(-1, 3)
        up = np.array(o.matrix_world.to_3x3().inverted() @ Vector((0, 0, 1)))
        up /= max(1e-9, np.linalg.norm(up))
        tall = co @ up
        size = float(tall.max() - tall.min()) or 1.0
        tree = BVHTree.FromPolygons([Vector(c) for c in co.tolist()], [tuple(p.vertices) for p in me.polygons])
        reach = SHADE_REACH * size
        near = np.zeros(n)
        for i in range(n):
            z = Vector(nrm[i])
            x = z.orthogonal().normalized()
            y = z.cross(x)
            start = Vector(co[i]) + z * (0.004 * size)
            hit = 0.0
            for a, b, c in _RAYS:
                d = x * a + y * b + z * c
                got = tree.ray_cast(start, d, reach)
                if got[0] is not None:
                    hit += (1 - got[3] / reach) ** 2  # a crease, not a brim a hand away
            near[i] = hit / len(_RAYS)
        edges = np.empty(len(me.edges) * 2, np.int64)
        me.edges.foreach_get("vertices", edges)
        a, b = edges[0::2], edges[1::2]
        count = np.maximum(np.bincount(np.concatenate([a, b]), minlength=n), 1)
        # How far a vertex stands proud of its neighbours, along its normal: an edge that wears.
        along = np.einsum("ij,ij->i", nrm[a], co[a] - co[b]) / np.maximum(np.linalg.norm(co[a] - co[b], axis=1), 1e-9)
        back = np.einsum("ij,ij->i", nrm[b], co[b] - co[a]) / np.maximum(np.linalg.norm(co[a] - co[b], axis=1), 1e-9)
        proud = np.zeros(n)
        np.add.at(proud, a, along)
        np.add.at(proud, b, back)
        proud = np.clip(proud / count * 3.0, -1.0, 1.0)
        height = (tall - tall.min()) / size
        facing = nrm @ up
        s = (1 - 0.6 * np.clip(near * 2.4, 0, 1)) * (0.82 + 0.18 * height) * (1 - 0.26 * np.clip(-facing, 0, 1)) * (0.9 + 0.1 * np.clip(proud, 0, 1)) * (1 - 0.2 * np.clip(-proud, 0, 1))
        for _ in range(2):  # soft, never speckled
            mean = np.zeros(n)
            np.add.at(mean, a, s[b])
            np.add.at(mean, b, s[a])
            s = 0.5 * s + 0.5 * mean / count
        s = np.clip(s / max(1e-9, float(np.percentile(s, 98))), 0.0, 1.0)
        corner = np.empty(len(me.loops), np.int64)
        me.loops.foreach_get("vertex_index", corner)
        colour = np.empty(len(me.loops) * 4, np.float32)
        attr.data.foreach_get("color", colour)
        colour = colour.reshape(-1, 4)
        light = colour[:, :3] @ np.array([0.2126, 0.7152, 0.0722], np.float32)
        ease = SHADE_DARK + (1 - SHADE_DARK) * np.clip(light / SHADE_MID, 0, 1)
        s = np.clip(1 - float(depth) * ease * (1 - s[corner]), SHADE_FLOOR, 1.0)
        painted = np.zeros(len(me.polygons), bool)
        slots = [sl.material for sl in o.material_slots]
        mat_index = np.empty(len(me.polygons), np.int32)
        me.polygons.foreach_get("material_index", mat_index)
        for k, m in enumerate(slots):
            if m is not None and m.name.split(".")[0].startswith("Paint"):
                painted |= mat_index == k
        loop_poly = np.repeat(np.arange(len(me.polygons)), [p.loop_total for p in me.polygons])
        colour[:, 3] = np.where(painted[loop_poly], s, 1.0)
        attr.data.foreach_set("color", colour.ravel())
        for m in slots:
            if m is not None and m.name.split(".")[0].startswith("Paint"):
                _keep_alpha(m)


def _keep_alpha(material):
    """Makes the glTF exporter write the paint's alpha: it writes a colour's alpha only where the
    material's Alpha reads it, so Alpha is that alpha clipped at a level no shade reaches (glTF's
    MASK at 0.01: nothing is ever cut, and the material stays opaque)."""
    nt = material.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    if bsdf.inputs["Alpha"].is_linked:
        return
    col = next((n for n in nt.nodes if n.type == "VERTEX_COLOR"), None)
    if col is None:
        return
    clip = nt.nodes.new("ShaderNodeMath")
    clip.operation = "GREATER_THAN"
    clip.inputs[1].default_value = 0.01
    nt.links.new(col.outputs["Alpha"], clip.inputs[0])
    nt.links.new(clip.outputs[0], bsdf.inputs["Alpha"])


def show_shade(materials):
    """On a candidate imported to be looked at: each paint material's colour times its baked shade,
    as the game's shader draws it, so a review shows the model as it plays."""
    for m in materials:
        if m is None or m.node_tree is None or not m.name.split(".")[0].startswith("Paint"):
            continue
        nt = m.node_tree
        bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
        col = next((n for n in nt.nodes if n.type in ("VERTEX_COLOR", "ATTRIBUTE")), None)
        if bsdf is None or col is None or not bsdf.inputs["Base Color"].is_linked:
            continue
        source = bsdf.inputs["Base Color"].links[0].from_socket
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type, mix.blend_type = "RGBA", "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        nt.links.new(source, mix.inputs["A"])
        nt.links.new(col.outputs["Alpha"], mix.inputs["B"])
        nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
        if bsdf.inputs["Alpha"].is_linked:
            nt.links.remove(bsdf.inputs["Alpha"].links[0])


def fit_textures(meshes, side):
    """Every texture the meshes use, at most side px on its longer side: one over it is scaled down
    (Blender's image scale, aspect kept) into a new packed image, so the source file is never
    written; one that cannot be read is left out of its material. Returns the notes."""
    notes, done = [], {}
    mats = {s.material for o in meshes for s in o.material_slots if s.material is not None and s.material.node_tree is not None}
    for m in sorted(mats, key=lambda m: m.name):
        for node in list(m.node_tree.nodes):
            image = getattr(node, "image", None)
            if image is None:
                continue
            if image.name not in done:
                done[image.name] = _fit(image, side, notes)
            if done[image.name] is None:
                m.node_tree.nodes.remove(node)
            else:
                node.image = done[image.name]
    return notes


def _fit(image, side, notes):
    if len(image.pixels) == 0:  # reading pixels loads the buffer
        notes.append(f"texture {image.name} could not be read ({os.path.basename(image.filepath)}): left out")
        return None
    w, h = image.size
    if max(w, h) <= side:
        return image
    k = side / max(w, h)
    nw, nh = max(1, round(w * k)), max(1, round(h * k))
    scratch = image.copy()
    try:
        scratch.scale(nw, nh)
        px = np.empty(nw * nh * 4, np.float32)
        scratch.pixels.foreach_get(px)
    finally:
        bpy.data.images.remove(scratch)
    out = bpy.data.images.new(f"{image.name}_{nw}", nw, nh, alpha=True, float_buffer=image.is_float)
    out.colorspace_settings.name = image.colorspace_settings.name
    out.pixels.foreach_set(px)
    out.pack()
    notes.append(f"texture {image.name} {w}x{h} → {nw}x{nh} (STYLE.json budget.texture {side})")
    return out


def rest_height(meshes):
    zs = [helpers.rest_coords(o)[0][:, 2] for o in meshes]
    zs = [z for z in zs if len(z)]
    if not zs:
        return 0.0
    return float(max(z.max() for z in zs) - min(z.min() for z in zs))


def character_scale(arms, meshes, style):
    """What the pass scales a character by: STYLE.json's scale.character over its standing height
    (what it holds overhead or trails does not count, deform.hero_height), or None. A model on its
    own rig (kurambit_rig) keeps the size it was made at, a wolf is no hero's height, and so does a
    character that declares its height range (kurambit_height): a chibi is meant small."""
    from .deform import hero_height

    want = ((style or {}).get("scale") or {}).get("character")
    if not arms or not want or any(a.get("kurambit_rig") or a.get("kurambit_height") for a in arms):
        return None
    h = hero_height(arms[0], meshes)[0] if len(arms) == 1 else rest_height(meshes)
    return want / h if h > 1e-6 else None


# A faceted finish keeps this share of a mesh's triangles (a garment more: thinned as far as the body,
# its planes cut through what is worn under it), and leaves a mesh under FACET_MIN whole.
FACET_KEEP = 0.2
FACET_KEEP_CLOTH = 0.35
FACET_MIN = 500


def facet(objects, style):
    """The lock's faceted finish (shading.finish "faceted"): each mesh thinned to clean planes and
    shaded flat, which is how most low-poly art gets its look. It runs before the gates, so they
    measure what ships. Weights, materials and the skin marked as under a garment carry through the
    thinning. Returns how many meshes it thinned."""
    if ((style or {}).get("shading") or {}).get("finish") != "faceted":
        return 0
    thinned = 0
    for o in objects:
        if o.type != "MESH":
            continue
        tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
        if tris > FACET_MIN and o.data.shape_keys is None:
            m = o.modifiers.new("facet", "DECIMATE")
            m.ratio = max(FACET_KEEP_CLOTH if o.get("kurambit_cloth") else FACET_KEEP, FACET_MIN / tris)
            # Where two colours meet stays where it is: thinned across, a stripe's edge turns to teeth.
            index = np.empty(len(o.data.polygons), np.int32)
            o.data.polygons.foreach_get("material_index", index)
            seen, border = {}, set()
            for p in o.data.polygons:
                for key in p.edge_keys:
                    other = seen.setdefault(key, index[p.index])
                    if other != index[p.index]:
                        border.update(key)
            # So does where one bone's skin meets another's: thinned there, one long edge spans a
            # joint (from one thigh to the other at the fork) and tears when it bends.
            arm = next((m.object for m in o.modifiers if m.type == "ARMATURE" and m.object is not None), None)
            lead = []
            if arm is not None:
                from . import deform

                lead = deform._dominant(o, arm)
                for e in o.data.edges:
                    a, b = e.vertices
                    if lead[a] != lead[b]:
                        border.update((a, b))
                bones = {g.index for g in o.vertex_groups if g.name in arm.data.bones}
                for v in o.data.vertices:
                    if max((g.weight for g in v.groups if g.group in bones), default=1.0) < 0.6:
                        border.add(v.index)
            head = []
            if arm is not None:
                # A head is small and round, and what a face reads from: thinned as hard as a body,
                # it comes to a point.
                head = [i for i, name in enumerate(lead) if name == "Head" and i not in border]
            if border or head:
                keep = o.vertex_groups.new(name="kurambit_facet_keep")
                keep.add(list(range(len(o.data.vertices))), 1.0, "REPLACE")
                keep.add(head, 0.0, "REPLACE")
                keep.add(sorted(border), 0.0, "REPLACE")
                m.vertex_group = keep.name
                m.vertex_group_factor = 8.0
            if o.get("kurambit_cloth"):
                m.ratio = _cloth_ratio(o, m)
            with bpy.context.temp_override(object=o, active_object=o):
                bpy.ops.object.modifier_move_to_index(modifier=m.name, index=0)
                bpy.ops.object.modifier_apply(modifier=m.name)
            thinned += 1
            keep = o.vertex_groups.get("kurambit_facet_keep")
            if keep is not None:
                o.vertex_groups.remove(keep)
        o.data.polygons.foreach_set("use_smooth", [False] * len(o.data.polygons))
        o.data.update()
    return thinned


def _cloth_ratio(o, m, sink=0.003):
    """The least a garment can keep and still lie where it was: thinned, its planes cut inside its
    own curve, and on a thin limb that is inside the arm it covers. The first share at which nearly
    every original vertex is within sink metres of the thinned surface."""
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree

    co = np.array([v.co for v in o.data.vertices])
    ratio = m.ratio
    while ratio < 0.95:
        tmp = bpy.data.objects.new("kurambit_facet_try", o.data.copy())
        bpy.context.scene.collection.objects.link(tmp)
        try:
            for vg in o.vertex_groups:
                tmp.vertex_groups.new(name=vg.name)
            d = tmp.modifiers.new("facet", "DECIMATE")
            d.ratio, d.vertex_group, d.vertex_group_factor = ratio, m.vertex_group, m.vertex_group_factor
            with bpy.context.temp_override(object=tmp, active_object=tmp):
                bpy.ops.object.modifier_apply(modifier=d.name)
            me = tmp.data
            tree = BVHTree.FromPolygons([v.co for v in me.vertices], [tuple(p.vertices) for p in me.polygons])
            out = []
            for c in co:
                hit = tree.find_nearest(Vector(c))
                out.append(0.0 if hit[0] is None else max(0.0, (Vector(c) - hit[0]).dot(hit[1])))
        finally:
            me = tmp.data
            bpy.data.objects.remove(tmp)
            bpy.data.meshes.remove(me)
        if np.percentile(out, 99.5) <= sink:
            return ratio
        ratio = min(1.0, ratio * 1.4)
    return 1.0


def style_pass(objects, style, out_dir, texture_side):
    """Runs the pass on objects (the resolved candidate, in this one-shot copy). Returns
    {kind, meshes, armatures, usedPalette, scaled, notes, paints}."""
    style = style or {}
    objects = [realize(o) if o.type in helpers.GEOMETRY else o for o in objects]
    arms = [o for o in objects if o.type == "ARMATURE"]
    meshes = [o for o in objects if o.type == "MESH"]
    for arm in arms:
        meshes = join_character(arm, meshes)
    shading = {**DEFAULT_SHADING, **(style.get("shading") or {})}
    palette = style.get("palette")
    notes, paints = [], []
    if isinstance(palette, list) and palette:
        used = snap_palette(meshes, palette, shading, out_dir)
    else:
        used = []
        notes = fit_textures(meshes, texture_side)
        depth = float(shading.get("depth", 0.0))
        paints = fold_flat(meshes, single=depth > 0)
        if depth > 0:
            shade(meshes, depth)
    scaled = character_scale(arms, meshes, style)
    if scaled is not None:
        for arm in arms:
            arm.scale = [s * scaled for s in arm.scale]
        bpy.context.view_layer.update()
    for o in meshes:
        o.data.validate()
    return {"kind": "character" if arms else "prop", "meshes": meshes, "armatures": arms, "usedPalette": used,
            "scaled": scaled, "notes": notes, "paints": paints}
