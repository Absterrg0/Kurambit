"""The style pass every exported model goes through: palette, shading, scale and budgets.

It runs only in the one-shot pass, on its own copy of the scene, so the live scene keeps the
agent's materials and modifiers. From STYLE.json:
  palette  a hex list: every material snaps to its nearest colour (in Lab; a textured one face by
           face, by the texture under each face), and the palette becomes
           one small atlas of vertical-gradient swatches (shading.gradient); each face samples its
           swatch by height in the model, so every part gets the same soft top light. Two
           materials result, Palette and Glow (shading.glow), on the one atlas. Without a hex list
           the materials are kept, their textures scaled down to budget.texture.
  scale    scale.character: a character is scaled to that standing height on its armature's
           object, so clip units are unchanged. Props and generated creatures keep their
           modelled metres.
A character's meshes are joined into one skinned mesh: one mesh, two draw calls."""
import math
import os

import bpy
import numpy as np

from . import helpers, skeleton

DEFAULT_SHADING = {"gradient": 0.16, "roughness": 0.62, "glow": 2.5}
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


def style_pass(objects, style, out_dir, texture_side):
    """Runs the pass on objects (the resolved candidate, in this one-shot copy). Returns
    {kind, meshes, armatures, usedPalette, scaled, notes}."""
    style = style or {}
    objects = [realize(o) if o.type in helpers.GEOMETRY else o for o in objects]
    arms = [o for o in objects if o.type == "ARMATURE"]
    meshes = [o for o in objects if o.type == "MESH"]
    for arm in arms:
        meshes = join_character(arm, meshes)
    shading = {**DEFAULT_SHADING, **(style.get("shading") or {})}
    palette = style.get("palette")
    notes = []
    if isinstance(palette, list) and palette:
        used = snap_palette(meshes, palette, shading, out_dir)
    else:
        used = []
        notes = fit_textures(meshes, texture_side)
    scaled = None
    want = (style.get("scale") or {}).get("character")
    # A generated creature (kurambit_rig) keeps the size it was made at: a wolf is no hero's height.
    if arms and want and not any(a.get("kurambit_rig") for a in arms):
        h = rest_height(meshes)
        if h > 1e-6:
            scaled = want / h
            for arm in arms:
                arm.scale = [s * scaled for s in arm.scale]
            bpy.context.view_layer.update()
    for o in meshes:
        o.data.validate()
    return {"kind": "character" if arms else "prop", "meshes": meshes, "armatures": arms, "usedPalette": used,
            "scaled": scaled, "notes": notes}
