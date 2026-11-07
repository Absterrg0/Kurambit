"""paint(): a model painted from its turnaround sheet, and adopt(): its result into the live scene.

paint runs in the one-shot pass on a copy of the saved live scene (the projection and its bakes
outlast a live call), on the meshes the server resolved:
    objects        resolved names (meshes are painted; armatures deform them)
    expectedDigest {name: sha1} of the live scene when it was copied
    sheet          abs path of the sheet image
    views          optional: the sheet's views left to right (front, back, left, right)
    noMirror       optional: [x0, y0, x1, y1] sheet pixel boxes the mirrored side must not copy
    pose           optional {arms, legs}: degrees for a standard-skeleton character, set for the
                   projection only (arms below horizontal, legs apart); otherwise as posed
    size           the atlas side in px (the head's own atlas is half)
    name           the stem of the textures
    out            abs scratch dir: textures, the alignment image and the library .blend
It writes nothing in the game. adopt (live) checks the objects are unchanged since the copy, puts
the painted meshes in place of theirs, copies the textures into the game and stamps the objects."""
import hashlib
import json
import math
import os
import shutil

import bpy
import numpy as np
from mathutils import Matrix

from . import helpers, project, skeleton
from . import sheet as sheets
from .digest import digests
from .protocol import Refused, entry

MATERIALS = "kurambit_paint_materials"
GID = "kurambit_bake_gid"


def _verify(names, expected):
    missing = [n for n in names if n not in bpy.data.objects]
    found = digests([n for n in names if n not in missing])
    differ = missing + [n for n, sha in found.items() if expected.get(n) != sha]
    return differ


def _deformers(o):
    arms = [m.object for m in o.modifiers if m.type == "ARMATURE" and m.object is not None]
    if o.parent is not None and o.parent.type == "ARMATURE":
        arms.append(o.parent)
    return arms


def _pose(targets, pose):
    """The sheet's A-pose on every standard-skeleton armature deforming the targets."""
    arms = {a for o in targets for a in _deformers(o) if "upperarm_l" in a.data.bones}
    if not arms:
        raise Refused("invalid-input", "pose sets a standard-skeleton character's arms and legs, and nothing painted is deformed by one: pose the model as the sheet shows it in the live scene instead, and leave pose out")
    a, leg = math.radians(pose.get("arms", 45)), math.radians(pose.get("legs", 8))
    for arm in arms:
        arm.data.pose_position = "POSE"
        skeleton.assign_action(arm, None)
        for pb in arm.pose.bones:
            pb.matrix_basis = Matrix()
        bpy.context.view_layer.update()
        for s, sx in (("l", 1), ("r", -1)):
            for b in (f"upperarm_{s}", f"lowerarm_{s}", f"hand_{s}"):
                if b in arm.pose.bones:
                    helpers.aim(b, (sx * math.cos(a), 0.0, -math.sin(a)), arm)
            for b in (f"thigh_{s}", f"calf_{s}"):
                if b in arm.pose.bones:
                    helpers.aim(b, (sx * math.sin(leg), 0.0, -math.cos(leg)), arm)
    bpy.context.view_layer.update()


def _head_faces(o):
    """Faces weighted mostly to the Head bone: the face gets its own atlas."""
    n = len(o.data.polygons)
    vg = next((g for g in o.vertex_groups if g.name.lower() == "head"), None)
    if vg is None or not _deformers(o):
        return np.zeros(n, np.int32)
    me = o.data
    w = np.zeros(len(me.vertices), np.float32)
    for v in me.vertices:
        for g in v.groups:
            if g.group == vg.index:
                w[v.index] = g.weight
    loop_v = np.empty(len(me.loops), np.int32)
    me.loops.foreach_get("vertex_index", loop_v)
    totals = np.empty(n, np.int32)
    me.polygons.foreach_get("loop_total", totals)
    poly = np.repeat(np.arange(n), totals)
    mean = np.bincount(poly, weights=w[loop_v], minlength=n) / np.maximum(totals, 1)
    return (mean >= 0.5).astype(np.int32)


def _materials(targets):
    """Every target's original materials, as one list, and each face's index in it. A mesh painted
    before keeps the materials it had then (stored on the mesh), so painting again keeps its ORM."""
    infos, keys, gids = [], {}, {}
    for o in targets:
        me = o.data
        n = len(me.polygons)
        stored = me.get(MATERIALS)
        painted = me.attributes.get(project.MID) is not None and stored and all(s.material is not None and s.material.get("kurambit_paint") for s in o.material_slots)
        if painted:
            local = json.loads(stored)
            ids = np.empty(n, np.float32)
            me.attributes[project.MID].data.foreach_get("value", ids)
            ids = np.clip(ids.astype(np.int32) - 1, 0, len(local) - 1)
        else:
            local = [project.material_info(s.material) for s in o.material_slots] or [project.material_info(None)]
            ids = np.empty(n, np.int32)
            me.polygons.foreach_get("material_index", ids)
            ids = np.minimum(ids, len(local) - 1)
            if me.attributes.get(project.MID) is not None:
                me.attributes.remove(me.attributes[project.MID])
            a = me.attributes.new(project.MID, "FLOAT", "FACE")
            a.data.foreach_set("value", (ids + 1).astype(np.float32))
            me[MATERIALS] = json.dumps(local)
        to_global = []
        for info in local:
            key = json.dumps(info, sort_keys=True)
            if key not in keys:
                keys[key] = len(infos)
                infos.append(info)
            to_global.append(keys[key])
        gids[o.name] = np.array(to_global, np.int32)[ids]
    return infos, gids


@entry
def paint(params):
    names = list(params["objects"])
    differ = _verify(names, params["expectedDigest"])
    if differ:
        raise Refused("invalid-input", f"the saved scene differs from the live one ({', '.join(differ[:5])})")
    skeleton.object_mode()
    objs = [bpy.data.objects[n] for n in names]
    targets = [o for o in objs if o.type == "MESH" and len(o.data.polygons) > 0]
    notes = []
    other = [o.name for o in objs if o.type in helpers.GEOMETRY and o.type != "MESH"]
    if other:
        notes.append(f"only meshes are painted: {', '.join(other[:6])} {'is' if len(other) == 1 else 'are'} not (convert to a mesh first)")
    if not targets:
        raise Refused("invalid-input", "nothing to paint: name the meshes (or the character's armature, which brings its meshes)")
    shared = {o.data.name for o in targets if o.data.users > 1}
    if shared:
        raise Refused("invalid-input", f"{', '.join(sorted(shared)[:4])} is a mesh several objects share: painting it would paint them all alike. Make it single-user first (game_blender_code: obj.data = obj.data.copy())")
    if any(m.type == "MIRROR" for o in targets for m in o.modifiers):
        notes.append("a Mirror modifier maps both halves to the same texels: one half's paint shows on both. Apply it first for a model whose sides differ")
    if params.get("pose"):
        _pose(targets, params["pose"])
    out = params["out"]
    os.makedirs(out, exist_ok=True)
    read = sheets.read_sheet(params["sheet"], params.get("views"))
    notes += read["notes"]
    project.log("sheet read", [v.describe() for v in read["views"]])
    pts = project.evaluated_points(targets)
    lo, hi = pts.min(0), pts.max(0)
    if hi[2] - lo[2] < 1e-3:
        raise Refused("invalid-input", "the meshes have no height to match the sheet's views against")
    front = next(v for v in read["views"] if v.label == "front")
    S = float(hi[2] - lo[2]) / (front.base - front.crown + 1)
    occ = project.occluders(targets)
    depths = {label: project.Depth(label, occ, lo, hi, S / 2, out) for label in sheets.LABELS}
    project.log("depth maps rendered")
    views = project.place_views(read, depths, lo, hi, params.get("noMirror") or ())
    project.log("views placed", [(v.label, round(v.iou, 3), round(v.centre(), 1), v.r0) for v in views])
    alignment = os.path.join(out, "alignment.png")
    project.alignment_image(read, views, alignment)
    project.refuse_poor_fit(views)
    infos, gids = _materials(targets)
    groups = {o.name: _head_faces(o) for o in targets}
    has_head = any(g.any() for g in groups.values()) and not all(g.all() for g in groups.values())
    if not has_head:
        groups = {k: np.zeros_like(g) for k, g in groups.items()}
    size = int(params["size"])
    sizes = [size, max(size // 2, 256)] if has_head else [size]
    for o in targets:
        me = o.data
        if me.attributes.get(GID) is not None:
            me.attributes.remove(me.attributes[GID])
        me.attributes.new(GID, "FLOAT", "FACE").data.foreach_set("value", (gids[o.name] + 1).astype(np.float32))
    project.uv_unwrap(targets, groups)
    project.log("unwrapped", sizes)
    tol = 0.009 * float(hi[2] - lo[2])
    files, seen = project.paint_atlases(targets, groups, sizes, views, depths, read, project.detail_height(read), infos, out, params["name"], tol, mid_attribute=GID)
    for o in targets:
        o.data.attributes.remove(o.data.attributes[GID])
    library = os.path.join(out, "painted.blend")
    bpy.data.libraries.write(library, {o.data for o in targets}, path_remap="ABSOLUTE", fake_user=True)
    return {
        "library": library,
        "meshes": {o.name: o.data.name for o in targets},
        "files": [os.path.basename(f) for f in files],
        "alignment": alignment,
        "views": [{**v.sv.describe(), "label": v.label, "overlap": round(v.iou, 3)} for v in views if not v.mirror],
        "mirrored": next((v.label for v in views if v.mirror), None),
        "head": has_head,
        "seen": round(seen, 3),
        "notes": [n[:400] for n in notes],
    }


def _adopt_images(images, dest, stem_of):
    """Copies each image's file into dest under a content-named file and points the image at it;
    returns the game files written. A paint never overwrites a file another image still reads."""
    os.makedirs(dest, exist_ok=True)
    written = []
    for img in images:
        src = bpy.path.abspath(img.filepath)
        with open(src, "rb") as f:
            sha = hashlib.sha1(f.read()).hexdigest()[:10]
        name = f"{stem_of(img)}.{sha}.png"
        target = os.path.join(dest, name)
        if not os.path.exists(target):
            shutil.copyfile(src, target)
        img.filepath = bpy.path.relpath(target) if bpy.data.filepath else target
        img.reload()
        written.append(target)
    return written


def _images_of(materials):
    out = []
    for m in materials:
        for n in (m.node_tree.nodes if m is not None and m.node_tree is not None else []):
            img = getattr(n, "image", None)
            if img is not None and img not in out:
                out.append(img)
    return out


def unfake(data, materials):
    """The library was written with fake users so nothing in it was dropped: what the scene now
    uses must not keep one, or a painted-over texture would stay in the .blend for good. Returns
    the materials' images."""
    images = _images_of(materials)
    for idb in list(data) + list(materials) + images:
        idb.use_fake_user = False
    return images


def sweep(dest):
    """Removes an earlier paint's materials and images no object uses any more, then the files in
    dest no image of the live scene reads."""
    for m in [m for m in bpy.data.materials if m.users == 0 and m.get("kurambit_paint")]:
        bpy.data.materials.remove(m)
    root = os.path.normpath(dest) + os.sep
    for i in [i for i in bpy.data.images if i.users == 0 and i.filepath and os.path.normpath(bpy.path.abspath(i.filepath)).startswith(root)]:
        bpy.data.images.remove(i)
    used = {os.path.normpath(bpy.path.abspath(i.filepath)) for i in bpy.data.images if i.users > 0 and i.filepath}
    for f in os.listdir(dest) if os.path.isdir(dest) else []:
        p = os.path.normpath(os.path.join(dest, f))
        if p not in used and f.endswith(".png"):
            os.remove(p)


def stem(img):
    base = os.path.basename(img.filepath).rsplit(".png", 1)[0]
    return base.split(".")[0]


@entry
def adopt(params):
    """The painted meshes in place of the live objects' own, if those are unchanged since the copy."""
    skeleton.object_mode()
    differ = _verify(list(params["expectedDigest"]), params["expectedDigest"])
    if differ:
        raise Refused("invalid-input", f"{', '.join(differ[:5])} changed in the live scene while it was being painted: nothing was replaced. Paint again.")
    wanted = sorted(set(params["meshes"].values()))
    with bpy.data.libraries.load(params["library"], link=False) as (_src, dst):
        dst.meshes = list(wanted)
    new = dict(zip(wanted, dst.meshes))
    for obj, mesh in params["meshes"].items():
        o = bpy.data.objects[obj]
        old = o.data
        o.data = new[mesh]
        new[mesh].use_fake_user = False
        if old.users == 0:
            bpy.data.meshes.remove(old)
        o["kurambit_paint"] = json.dumps({"what": "texture", **params["stamp"]})
    mats = [m for me in new.values() for m in me.materials if m is not None]
    written = _adopt_images(unfake(list(new.values()), mats), params["dest"], stem)
    sweep(params["dest"])
    return {"objects": sorted(params["meshes"]), "files": written}
