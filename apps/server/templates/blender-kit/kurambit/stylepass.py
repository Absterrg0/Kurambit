"""The style pass every exported model goes through: scale, texture budget, a character's one mesh,
and, when the person chose it, the packs' gradient atlas.

It runs only in the one-shot pass, on its own copy of the scene, so the live scene keeps the
agent's materials and modifiers. By default every material ships as Blender's glTF exporter writes
it (base colour, metallic, roughness, emission, normal maps, transmission, alpha, culling), its
textures scaled to budget.texture. From STYLE.json:
  palette  a hex list, which a lock keeps only for the flat finish the person picked: the pack look
           of KayKit and Kenney, measured from their files. Every material snaps to its nearest
           colour (in Lab; a textured one face by face, by the texture under each face) on one
           small atlas of vertical-gradient swatches, the whole palette, one for the game; each
           face samples its swatch by its height in the model, so every part gets the same soft
           top light (shading.gradient) and a ramp that warms toward the top (shading.hue). A
           glowing colour samples the same atlas through a second material, Glow. A voxel model
           (a material per colour) goes on an atlas of its own colours without a palette too.
  scale    scale.character: a character is scaled to that standing height on its armature's
           object, so clip units are unchanged. Props, models on their own rig (kurambit_rig: a
           creature, a vehicle) and characters with a declared height keep their modelled metres.
A character's meshes are joined into one skinned mesh: one mesh, one draw call (a primitive per
material). Exports made before (colours painted per vertex with a baked shade) still load as they were."""
import colorsys
import math
import os

import bpy
import numpy as np

from . import helpers, skeleton

# hue: degrees a swatch's ramp turns toward warm at its top and away at its bottom (ramp).
DEFAULT_SHADING = {"gradient": 0.16, "roughness": 0.62, "glow": 2.5, "hue": 10.0}
COLS, SWATCH_W, SWATCH_H = 8, 8, 32
# A decal (kurambit.decal: eyes, brows, an emblem) is a painted cell the width of the atlas and two
# swatch rows tall, below the swatches: the runtime recolours swatches by rows of equal height.
DECAL_ROWS = 2
DECAL = COLS * SWATCH_W


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


def ramp(c, gradient, hue, t):
    """A swatch's colour at height t (0 bottom, 1 top), sRGB: darker below and lighter above by
    gradient, its hue turned toward warm (45°) at the top and away from it at the bottom by up to
    hue degrees each way, as painters shift a ramp. A near-grey keeps its hue."""
    h, sat, v = colorsys.rgb_to_hsv(*c)
    if sat > 0.08:
        d = ((45 / 360 - h + 0.5) % 1.0) - 0.5
        h = (h + math.copysign(min(abs(d), hue / 360), d) * (2 * t - 1)) % 1.0
    k = 1 - gradient + 2 * gradient * t
    return [_srgb(_lin(x) * k) for x in colorsys.hsv_to_rgb(h, sat, v)]


def _decal_pixels(image):
    """A decal's image resampled to its DECAL x DECAL cell, bottom row first, sRGB."""
    w, h = image.size
    px = np.empty(w * h * 4, np.float32)
    image.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)
    ys = np.minimum((np.arange(DECAL) + 0.5) * h / DECAL, h - 1).astype(int)
    xs = np.minimum((np.arange(DECAL) + 0.5) * w / DECAL, w - 1).astype(int)
    return px[ys][:, xs]


def _atlas(colours, shading, out_dir, decals=()):
    swatch_rows = math.ceil(len(colours) / COLS)
    rows = swatch_rows + DECAL_ROWS * len(decals)
    img = bpy.data.images.new("palette", COLS * SWATCH_W, rows * SWATCH_H, alpha=False)
    px = np.ones((rows * SWATCH_H, COLS * SWATCH_W, 4), np.float32)
    for j, image in enumerate(decals):
        y0 = (len(decals) - 1 - j) * DECAL_ROWS * SWATCH_H
        # The swatches' soft top light, over the cell's height, so the painted faces meet the
        # plain ones around them without a lighter patch.
        c = _decal_pixels(image)[:, :, :3]
        k = (1 - shading["gradient"] + 2 * shading["gradient"] * np.linspace(0, 1, DECAL))[:, None, None]
        lin = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92) * k
        px[y0:y0 + DECAL, :DECAL, :3] = np.where(lin > 0.0031308, 1.055 * np.clip(lin, 0, 1) ** (1 / 2.4) - 0.055, 12.92 * lin)
    for i, c in enumerate(colours):
        col, row = i % COLS, rows - 1 - i // COLS
        for y in range(SWATCH_H):
            px[row * SWATCH_H + y, col * SWATCH_W:(col + 1) * SWATCH_W, :3] = ramp(c, shading["gradient"], shading["hue"], y / (SWATCH_H - 1))
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


def _hexed(c):
    return "#%02x%02x%02x" % tuple(round(max(0.0, min(1.0, x)) * 255) for x in c)


def _decal_image(m):
    """The painted image of a decal material (kurambit.decal), else None."""
    if m is None or not m.get("kurambit_decal") or m.node_tree is None:
        return None
    return next((n.image for n in m.node_tree.nodes if n.type == "TEX_IMAGE" and n.image is not None), None)


AXES = {"-y": ((1, 0, 0), (0, 0, 1)), "+y": ((-1, 0, 0), (0, 0, 1)), "+x": ((0, 1, 0), (0, 0, 1)),
        "-x": ((0, -1, 0), (0, 0, 1)), "+z": ((1, 0, 0), (0, 1, 0)), "-z": ((1, 0, 0), (0, -1, 0))}


def _project(points, axis):
    """(u, v) 0..1 of points seen from the axis side (-y: the model's front), over their bounds."""
    right, up = (np.array(a, float) for a in AXES.get(axis, AXES["-y"]))
    uv = []
    for d in (right, up):
        x = points @ d
        lo, hi = x.min(), x.max()
        uv.append((x - lo) / (hi - lo) if hi - lo > 1e-9 else np.full(len(x), 0.5))
    return uv


def atlas_pass(meshes, shading, out_dir, hexes=None):
    """Every material onto one atlas of gradient swatches, in one material (and Glow, when
    something glows): the packs' method. With a locked hex palette every material snaps to its
    nearest entry (in Lab; a textured face by the texture under it) and the atlas is the whole
    palette, one for the game; without one (voxel models, whose materials are plain colours) the
    swatches are the model's own colours. Each face samples its swatch by its height in the model;
    a decal's faces sample its painted cell, projected along its axis over their bounds. Returns
    (palette entries used, swatches [{colour, name}] in atlas order, rows)."""
    colours = [_hex(h) for h in hexes] if hexes else []
    names = [None] * len(colours)
    plab = [_lab(c) for c in colours]
    slots_of = []
    decals = []
    for o in meshes:
        infos = []
        for slot in o.material_slots or [None]:
            m = slot.material if slot is not None else None
            image = _decal_image(m)
            if image is not None:
                if m not in decals:
                    decals.append(m)
                infos.append(("decal", decals.index(m)))
                continue
            c, glow = material_colour(m)
            if hexes:
                k = min(range(len(colours)), key=lambda i: sum((a - b) ** 2 for a, b in zip(_lab(c), plab[i])))
            else:
                k = next((i for i, x in enumerate(colours) if _hexed(x) == _hexed(c)), None)
                if k is None:
                    colours.append(_hex(_hexed(c)))
                    names.append(None)
                    k = len(colours) - 1
            if names[k] is None and m is not None:
                names[k] = m.name.split(".")[0][:64]
            infos.append((k, glow))
        slots_of.append(infos)
    img, rows = _atlas(colours, shading, out_dir, [_decal_image(m) for m in decals])
    flat, glow_mat = _palette_material("Palette", img, shading, False), None
    used, seen, pixel_cache = set(), set(), {}
    for o, infos in zip(meshes, slots_of):
        me = o.data
        if me.as_pointer() in seen:  # a shared mesh is styled once
            continue
        seen.add(me.as_pointer())
        is_decal = lambda i: i[0] == "decal"
        if any(not is_decal(i) and i[1] for i in infos) and glow_mat is None:
            glow_mat = _palette_material("Glow", img, shading, True)
        np_ = len(me.polygons)
        mat_index = np.empty(np_, np.int32)
        me.polygons.foreach_get("material_index", mat_index)
        mat_index = np.minimum(mat_index, len(infos) - 1)
        swatch = np.array([0 if is_decal(i) else i[0] for i in infos])[mat_index]
        glows = np.array([bool(not is_decal(i) and i[1]) for i in infos])[mat_index]
        decal = np.array([i[1] if is_decal(i) else -1 for i in infos])[mat_index]
        loop_poly = np.repeat(np.arange(np_), [p.loop_total for p in me.polygons])
        # A textured material (a generator's baked texture, a pack's colormap) is many colours:
        # each face snaps by what its texture shows under it, not by the mean.
        images = []
        for slot in o.material_slots:
            m = slot.material
            if _decal_image(m) is not None:
                images.append(None)  # painted, never snapped
                continue
            bsdf = next((nd for nd in m.node_tree.nodes if nd.type == "BSDF_PRINCIPLED"), None) if m is not None and m.node_tree is not None else None
            image = _feeding_image(bsdf.inputs["Base Color"]) if bsdf is not None else None
            if image is not None and image.name not in pixel_cache:
                pixel_cache[image.name] = _srgb_pixels(image)
            images.append(pixel_cache.get(image.name) if image is not None else None)
        if hexes:
            snapped, textured = _face_swatches(me, images, mat_index, loop_poly, plab)
            swatch[textured] = snapped[textured]
        used.update(int(k) for k in np.unique(swatch[decal < 0]))
        co = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get("co", co)
        mw = np.array(o.matrix_world)
        z = (co.reshape(-1, 3) @ mw[:3, :3].T + mw[:3, 3])[:, 2]
        loop_v = np.empty(len(me.loops), np.int32)
        me.loops.foreach_get("vertex_index", loop_v)
        loop_swatch = np.where(decal[loop_poly] < 0, swatch[loop_poly], -1)
        lz = z[loop_v]
        t = np.full(len(lz), 0.5)
        # A voxel face is one colour edge to edge: its swatch's middle, no gradient up a merged face.
        for k in [] if o.get("kurambit_voxel") else np.unique(loop_swatch[loop_swatch >= 0]):
            sel = loop_swatch == k
            lo, hi = lz[sel].min(), lz[sel].max()
            if hi - lo > 1e-6:
                t[sel] = (lz[sel] - lo) / (hi - lo)
        u = ((loop_swatch % COLS) + 0.5) / COLS
        v = ((rows - 1 - loop_swatch // COLS) + 0.08 + 0.84 * t) / rows
        loop_decal = decal[loop_poly]
        if (loop_decal >= 0).any():
            world = co.reshape(-1, 3) @ mw[:3, :3].T + mw[:3, 3]
            for j in np.unique(loop_decal[loop_decal >= 0]):
                sel = loop_decal == j
                du, dv = _project(world[loop_v[sel]], decals[j]["kurambit_decal"])
                pad = 0.5 / DECAL
                u[sel] = pad + (1 - 2 * pad) * du
                y0 = (len(decals) - 1 - j) * DECAL_ROWS
                v[sel] = (y0 + DECAL_ROWS * (pad + (1 - 2 * pad) * dv)) / rows
        for name in [layer.name for layer in me.uv_layers]:  # removing a layer invalidates the others' references
            me.uv_layers.remove(me.uv_layers[name])
        me.uv_layers.new(name="palette").data.foreach_set("uv", np.stack([u, v], 1).ravel().astype(np.float32))
        me.materials.clear()  # this resets every face's material index: set them again below
        for m in [flat] + ([glow_mat] if glow_mat is not None else []):
            me.materials.append(m)
        me.polygons.foreach_set("material_index", glows.astype(np.int32))
    swatches = [{"colour": _hexed(colours[k]), "name": (names[k] or _hexed(colours[k]))[:64]} for k in range(len(colours))]
    return [hexes[k] for k in sorted(used)] if hexes else [], swatches, rows


def decal_uvs(meshes):
    """Without the atlas a decal keeps its own material: its faces' corners get UVs over its picture,
    projected along its axis over their bounds, as the atlas would place them in its cell."""
    for o in meshes:
        axes = [_decal_image(s.material) is not None and s.material["kurambit_decal"] for s in o.material_slots]
        if not any(axes):
            continue
        me = o.data
        index = np.empty(len(me.polygons), np.int32)
        me.polygons.foreach_get("material_index", index)
        loop_poly = np.repeat(np.arange(len(me.polygons)), [p.loop_total for p in me.polygons])
        loop_v = np.empty(len(me.loops), np.int32)
        me.loops.foreach_get("vertex_index", loop_v)
        co = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get("co", co)
        mw = np.array(o.matrix_world)
        world = co.reshape(-1, 3) @ mw[:3, :3].T + mw[:3, 3]
        layer = me.uv_layers.active or me.uv_layers.new(name="UVMap")
        uv = np.zeros(len(me.loops) * 2, np.float32)
        layer.data.foreach_get("uv", uv)
        uv = uv.reshape(-1, 2)
        for k, axis in enumerate(axes):
            sel = (np.minimum(index, len(axes) - 1) == k)[loop_poly]
            if axis and sel.any():
                du, dv = _project(world[loop_v[sel]], axis)
                uv[sel] = np.stack([du, dv], 1)
        layer.data.foreach_set("uv", uv.ravel())


def hue_families(swatches):
    """How many 30° hue families the saturated swatches fall in; greys and near-greys count none."""
    bins = set()
    for sw in swatches:
        h, sat, v = colorsys.rgb_to_hsv(*_hex(sw["colour"]))
        if sat > 0.15 and v > 0.1:
            bins.add(int(h * 12) % 12)
    return len(bins)


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
FACET_KEEP = 0.1
FACET_KEEP_HELD = 0.2
FACET_KEEP_CLOTH = 0.35
FACET_MIN = 500


def facet(objects, style):
    """The lock's faceted look (shape.edges "faceted", set in STYLE.json): each mesh thinned to clean planes and
    shaded flat, which is how most low-poly art gets its look. It runs before the gates, so they
    measure what ships. Weights, materials and the skin marked as under a garment carry through the
    thinning. Returns how many meshes it thinned."""
    if ((style or {}).get("shape") or {}).get("edges") != "faceted":
        return 0
    thinned = 0
    for o in objects:
        if o.type != "MESH" or o.get("kurambit_voxel"):  # thinned, a cube is no longer one
            continue
        if o.get("kurambit_world") or (o.parent is not None and o.parent.get("kurambit_world")):
            continue  # the world helpers build it in the lock's planes already; thinned, a willow's strands turn to spikes
        tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
        if tris > FACET_MIN and o.data.shape_keys is None:
            cloth = bool(o.get("kurambit_cloth"))
            arm = next((m.object for m in o.modifiers if m.type == "ARMATURE" and m.object is not None), None)
            # A body with clothes cut from it is thinned as they are, joint by joint, or the two part
            # at every joint and the skin comes through.
            held = cloth or (arm is not None and any(x.get("kurambit_cloth") and arm in helpers._deforming(x) for x in objects))
            m = o.modifiers.new("facet", "DECIMATE")
            m.ratio = max(FACET_KEEP_CLOTH if cloth else FACET_KEEP_HELD if held else FACET_KEEP, FACET_MIN / tris)
            # Anything else mirrored, so both sides get the same planes (a body is made symmetric about X).
            m.use_symmetry, m.symmetry_axis = not held, "X"
            # Where two colours meet stays where it is: thinned across, a stripe's edge turns to teeth.
            index = np.empty(len(o.data.polygons), np.int32)
            o.data.polygons.foreach_get("material_index", index)
            seen, border = {}, set()
            for p in o.data.polygons:
                for key in p.edge_keys:
                    other = seen.setdefault(key, index[p.index])
                    if other != index[p.index]:
                        border.update(key)
            # On clothing and what wears it, so does where one bone's skin meets another's: thinned
            # there, one long edge spans a joint (from one thigh to the other at the fork) and tears
            # when it bends. Not on an animal or a prop: held there, every joint keeps a dense band
            # and the thinning between bands collapses into long fans, crumpled where low-poly art
            # has clean planes.
            lead = []
            if arm is not None:
                from . import deform

                lead = deform._dominant(o, arm)
            if arm is not None and held:
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
                # Held hard, what is kept stays dense and its neighbours collapse into fans; the rest
                # only lean their thinning away from colour borders and the face.
                m.vertex_group_factor = 8.0 if held else 2.0
            if cloth:
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


def atlas_style(style):
    """The hex palette the person locked, which asks for the atlas, or None."""
    palette = (style or {}).get("palette")
    return palette if isinstance(palette, list) and palette else None


def style_pass(objects, style, out_dir, texture_side):
    """Runs the pass on objects (the resolved candidate, in this one-shot copy). Returns
    {kind, meshes, armatures, usedPalette, scaled, notes, paints, atlas, hues}: paints are the
    atlas's swatches in its order, which the sidecar carries so Art lists and edits each one;
    without the atlas there are none, and Art edits each material as the game loads it."""
    style = style or {}
    objects = [realize(o) if o.type in helpers.GEOMETRY else o for o in objects]
    arms = [o for o in objects if o.type == "ARMATURE"]
    meshes = [o for o in objects if o.type == "MESH"]
    # Read before the join, which hides which part had no material.
    unpainted = [o.name for o in meshes if not any(s.material for s in o.material_slots)]
    for arm in arms:
        meshes = join_character(arm, meshes)
    shading = {**DEFAULT_SHADING, **(style.get("shading") or {})}
    hexes = atlas_style(style)
    notes = [] if hexes else fit_textures(meshes, texture_side)
    notes += [f"{n} has no material, so it ships the default white: give it one" for n in unpainted[:8]]
    if hexes:
        used, swatches, rows = atlas_pass(meshes, shading, out_dir, hexes)
        hues = hue_families(swatches)
    else:
        # A voxel model is a material per colour: on its own colours' atlas it is one draw call.
        voxels = [o for o in meshes if o.get("kurambit_voxel")]
        used, swatches, rows = atlas_pass(voxels, shading, out_dir) if voxels else ([], [], 0)
        decal_uvs([o for o in meshes if o not in voxels])
        mats = {s.material for o in meshes for s in o.material_slots if s.material is not None}
        hues = hue_families([{"colour": _hexed(material_colour(m)[0])} for m in mats])
    scaled = character_scale(arms, meshes, style)
    if scaled is not None:
        for arm in arms:
            arm.scale = [s * scaled for s in arm.scale]
        bpy.context.view_layer.update()
    for o in meshes:
        o.data.validate()
    atlas = {"columns": COLS, "rows": rows} if swatches else None
    return {"kind": "character" if arms else "prop", "meshes": meshes, "armatures": arms, "usedPalette": used,
            "scaled": scaled, "notes": notes, "paints": swatches[:64], "atlas": atlas, "hues": hues}
