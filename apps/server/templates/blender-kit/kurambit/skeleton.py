"""Skeleton plumbing: glTF joints and rest frames (rest_deviation against the standard skeleton,
for models made before rigging moved to rig.py), imports, binding and clip actions.

Imports use the glTF importer's default bone heuristic ("BLENDER"): it is the one that round-trips
joint frames exactly (import then export gives the same node rotations); TEMPERANCE re-aims the
root bone and turns the root and pelvis 90 degrees off the standard."""
import json
import math
import struct
from contextlib import contextmanager

import bpy
from mathutils import Matrix


# A bone points at this child joint: hands at the middle finger, the spine up the chain.
_POINTS_AT = ("middle_01", "spine_01", "neck_01", "Head", "calf", "foot", "ball", "lowerarm", "hand")


# ---- glTF JSON: what an engine reads -------------------------------------------------------------

def gltf_json(path):
    """The JSON of a .glb (its first chunk) or a .gltf."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:4] == b"glTF":
        length = struct.unpack_from("<I", data, 12)[0]
        return json.loads(data[20:20 + length])
    return json.loads(data)


def skin_joints(doc):
    """Joint names of every skin in a glTF document, in skin order, without repeats."""
    nodes, out = doc.get("nodes", []), []
    for skin in doc.get("skins", []):
        for j in skin.get("joints", []):
            name = nodes[j].get("name", "")
            if name not in out:
                out.append(name)
    return out


def detached_chains(doc):
    """Joints of a glTF's skins that hang from no other joint, beside the one carrying the most:
    each heads a chain that does not reach the spine (an exporter that flattened the tree, or a
    bone left unparented). [] when every joint is under one root."""
    nodes = doc.get("nodes", [])
    joints = {j for skin in doc.get("skins", []) for j in skin.get("joints", [])}
    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}
    roots = [j for j in joints if parent.get(j) not in joints]
    if len(roots) < 2:
        return []

    def size(j):
        return 1 + sum(size(c) for c in nodes[j].get("children", []) if c in joints)

    main = max(roots, key=size)
    return sorted(nodes[j].get("name", str(j)) for j in roots if j != main)


def clip_rate(doc):
    """The frame rate a glTF's clips were sampled at (the commonest over its animations), or None.
    An animation input's accessor carries its count and max (the glTF spec requires both)."""
    votes = {}
    accessors = doc.get("accessors", [])
    for anim in doc.get("animations", []):
        a = max((accessors[s["input"]] for s in anim.get("samplers", [])), key=lambda x: x.get("count", 0), default=None)
        if a is None or a.get("count", 0) < 3 or not a.get("max") or a["max"][0] <= 0:
            continue
        rate = round((a["count"] - 1) / a["max"][0])
        votes[rate] = votes.get(rate, 0) + 1
    return max(votes, key=votes.get) if votes else None


def local_rest(doc):
    """Each skin joint's rest rotation relative to its parent node, as glTF stores it (x, y, z, w)."""
    nodes, out = doc.get("nodes", []), {}
    for skin in doc.get("skins", []):
        for j in skin.get("joints", []):
            out[nodes[j].get("name", "")] = list(nodes[j].get("rotation", [0.0, 0.0, 0.0, 1.0]))
    return out


def quat_angle(a, b):
    """Degrees between two rotations given as (x, y, z, w)."""
    dot = abs(sum(x * y for x, y in zip(a, b)))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(x * x for x in b)) or 1.0
    return math.degrees(2 * math.acos(min(1.0, dot / (na * nb))))


def rest_deviation(candidate_rest, standard_rest):
    """(degrees, joint): the largest local rest-frame difference over the standard joints, or
    None when the candidate does not hold every standard joint."""
    if any(name not in candidate_rest for name in standard_rest):
        return None
    worst = (0.0, None)
    for name, rot in standard_rest.items():
        d = quat_angle(candidate_rest[name], rot)
        if d > worst[0]:
            worst = (d, name)
    return worst


# ---- Blender ---------------------------------------------------------------------------------

def object_mode():
    if bpy.context.mode != "OBJECT" and bpy.context.view_layer.objects.active is not None:
        bpy.ops.object.mode_set(mode="OBJECT")


@contextmanager
def edit_bones(arm):
    """Edit mode on arm. Every Bone, EditBone and PoseBone reference taken before or inside is
    invalid afterwards (edit mode rebuilds them): fetch bones by name again after the block."""
    object_mode()
    layer = bpy.context.view_layer
    previous = layer.objects.active
    arm.hide_set(False)
    layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    try:
        yield arm.data.edit_bones
    finally:
        bpy.ops.object.mode_set(mode="OBJECT")
        if previous is not None and previous.name in layer.objects:
            layer.objects.active = previous


def import_gltf(path):
    """Imports a glTF into the current collection: (new objects, new actions). Bone display shapes
    the importer adds (an Icosphere that would pollute bounds and exports) are removed."""
    objects_before = set(bpy.data.objects)
    actions_before = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in objects_before]
    shapes = set()
    for o in new:
        if o.type == "ARMATURE":
            for pb in o.pose.bones:
                if pb.custom_shape is not None:
                    shapes.add(pb.custom_shape)
                    pb.custom_shape = None
    new = [o for o in new if o not in shapes]
    remove_objects(shapes)
    return new, [a for a in bpy.data.actions if a not in actions_before]


def import_model(path):
    """import_gltf, or the FBX importer for an .fbx (generators deliver either)."""
    if not path.lower().endswith(".fbx"):
        return import_gltf(path)
    objects_before = set(bpy.data.objects)
    actions_before = set(bpy.data.actions)
    bpy.ops.import_scene.fbx(filepath=path, automatic_bone_orientation=False)
    return [o for o in bpy.data.objects if o not in objects_before], [a for a in bpy.data.actions if a not in actions_before]


def remove_objects(objects):
    """Removes objects and the data only they used."""
    for o in list(objects):
        data = o.data
        bpy.data.objects.remove(o)
        if data is not None and data.users == 0:
            bpy.data.batch_remove([data])


def baked_mesh(obj, keep=lambda m: False):
    """Applies obj's modifiers (except those keep() names) into its mesh without operators, so it
    works in the live session from any context. Vertex groups survive; shape keys are baked."""
    hidden = []
    for m in obj.modifiers:
        if keep(m) and m.show_viewport:
            m.show_viewport = False
            hidden.append(m)
    try:
        dg = bpy.context.evaluated_depsgraph_get()
        dg.update()
        ev = obj.evaluated_get(dg)
        me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
    finally:
        for m in hidden:
            m.show_viewport = True
    old = obj.data
    obj.shape_key_clear() if obj.data.shape_keys else None
    obj.data = me
    me.name = old.name
    if old.users == 0:
        bpy.data.meshes.remove(old)
    for m in list(obj.modifiers):
        if not keep(m):
            obj.modifiers.remove(m)
    return obj


def to_world(obj):
    """Puts obj's world transform into its mesh and unparents it, so its vertices are world space."""
    mw = obj.matrix_world.copy()
    if obj.data.users > 1:
        obj.data = obj.data.copy()
    obj.parent = None
    obj.data.transform(mw)
    obj.matrix_world = Matrix()


def _child_joint(bones, name, has):
    """The standard joint a bone points at: its preferred child that the body also has."""
    kids = [c.name for c in bones[name].children if not c.name.endswith(("_leaf_l", "_leaf_r"))]
    kids = kids or [c.name for c in bones[name].children]
    kids = [k for k in kids if has(k)]
    for want in _POINTS_AT:
        for k in kids:
            if k.startswith(want):
                return k
    return kids[0] if kids else None


def bind(obj, arm):
    """Parents obj to arm (keeping where it is) with one Armature modifier."""
    mw = obj.matrix_world.copy()
    obj.parent = arm
    obj.parent_type = "OBJECT"
    obj.matrix_parent_inverse = arm.matrix_world.inverted()
    obj.matrix_world = mw
    for m in list(obj.modifiers):
        if m.type == "ARMATURE":
            obj.modifiers.remove(m)
    m = obj.modifiers.new("Armature", "ARMATURE")
    m.object = arm


def action_fcurves(action):
    """The F-curves of an action, on layered (4.4+) and legacy actions alike."""
    try:
        return action.layers[0].strips[0].channelbag(action.slots[0]).fcurves
    except (AttributeError, IndexError):
        return action.fcurves


def fit_clip(action, ratio):
    """A library clip on a conformed body: rotations as they are, translation only at the pelvis,
    scaled to the body (a shorter body must not be pulled to the mannequin's lengths), no scale."""
    fcs = action_fcurves(action)
    for fc in list(fcs):
        path = fc.data_path
        bone = path.split('"')[1] if '"' in path else ""
        if path.endswith(".scale") or (path.endswith(".location") and bone != "pelvis"):
            fcs.remove(fc)
        elif path.endswith(".location"):
            for k in fc.keyframe_points:
                k.co.y *= ratio
                k.handle_left.y *= ratio
                k.handle_right.y *= ratio


def retime(action, k):
    """Stretches an action's keys (and its manual frame range) by k, so it lasts as many seconds
    at a frame rate k times the old one."""
    for fc in action_fcurves(action):
        for key in fc.keyframe_points:
            key.co.x *= k
            key.handle_left.x *= k
            key.handle_right.x *= k
        fc.update()
    if action.use_frame_range:
        start, end = action.frame_start * k, action.frame_end * k
        for name, value in (("frame_end", end), ("frame_start", start)) if k > 1 else (("frame_start", start), ("frame_end", end)):
            setattr(action, name, value)  # in this order neither clamps the other


def assign_action(arm, action):
    if arm.animation_data is None:
        arm.animation_data_create()
    arm.animation_data.action = action
    if action is not None and getattr(action, "slots", None) and len(action.slots):
        arm.animation_data.action_slot = action.slots[0]
