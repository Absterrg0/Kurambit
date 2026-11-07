"""The standard skeleton: its joints (read from STANDARD_ARMATURE at run time), the name maps
identity and mpfb_game_engine, conform() and rest_deviation().

glTF clips store absolute local joint rotations, so a library clip plays right only on a skeleton
whose rest joint frames match the one it was made on. Conforming never retargets a clip: it takes
the standard armature itself and moves its joints onto the body, keeping every bone's orientation
and roll, so only lengths change and every library clip plays as it is.

Imports use the glTF importer's default bone heuristic ("BLENDER"): it is the one that round-trips
joint frames exactly (import then export gives the same node rotations); TEMPERANCE re-aims the
root bone and turns the root and pelvis 90 degrees off the standard."""
import json
import math
import struct
from contextlib import contextmanager

import bpy
from mathutils import Matrix

NAME_MAPS = {
    "identity": {},
    # MPFB2's game_engine rig already uses UE names, except these two.
    "mpfb_game_engine": {"Root": "root", "head": "Head"},
}

# Limb bones posed onto the standard rest directions before a body is baked (MPFB stands in an
# A-pose; library bodies are close to the standard T-pose but not exactly on it). Parents first.
ALIGN = []
for _side in ("l", "r"):
    ALIGN += [f"clavicle_{_side}", f"upperarm_{_side}", f"lowerarm_{_side}", f"hand_{_side}",
              f"thigh_{_side}", f"calf_{_side}", f"foot_{_side}"]
    for _finger in ("thumb", "index", "middle", "ring", "pinky"):
        ALIGN += [f"{_finger}_01_{_side}", f"{_finger}_02_{_side}", f"{_finger}_03_{_side}"]

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


def standard_joints(standard_glb):
    """The standard skeleton's joints, read from the standard armature's own file."""
    return skin_joints(gltf_json(standard_glb))


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


def remove_objects(objects):
    """Removes objects and the data only they used."""
    for o in list(objects):
        data = o.data
        bpy.data.objects.remove(o)
        if data is not None and data.users == 0:
            bpy.data.batch_remove([data])


def local_frames(arm):
    """Each bone's rest rotation relative to its parent bone, in Blender's armature space."""
    out = {}
    for b in arm.data.bones:
        m = b.matrix_local.to_3x3().normalized()
        if b.parent is not None:
            m = b.parent.matrix_local.to_3x3().normalized().inverted() @ m
        out[b.name] = m.to_quaternion()
    return out


def frame_deviation(arm, reference):
    """Largest difference (degrees) between arm's bone frames and reference (local_frames of the
    standard), over the reference's bones; None when arm misses one."""
    mine = local_frames(arm)
    if any(n not in mine for n in reference):
        return None
    return max((math.degrees(mine[n].rotation_difference(q).angle) for n, q in reference.items()), default=0.0)


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


def align_pose(body_arm, std_world, std_bones, std_name):
    """Poses the body's own rig so each limb points the way the standard rest pose points it."""
    mw3 = body_arm.matrix_world.to_3x3()
    to_arm = mw3.inverted()
    by_std = {std_name(pb.name): pb.name for pb in body_arm.pose.bones}
    for name in ALIGN:
        if name not in by_std or name not in std_bones:
            continue
        target = _child_joint(std_bones, name, lambda k: k in by_std)
        if target is None:
            continue
        bpy.context.view_layer.update()
        pb = body_arm.pose.bones[by_std[name]]
        pc = body_arm.pose.bones[by_std[target]]
        cur = pc.head - pb.head
        want = to_arm @ (std_world[target] - std_world[name])
        if cur.length < 1e-6 or want.length < 1e-6:
            continue
        q = cur.normalized().rotation_difference(want.normalized())
        pb.matrix = Matrix.Translation(pb.head) @ q.to_matrix().to_4x4() @ Matrix.Translation(-pb.head) @ pb.matrix
    bpy.context.view_layer.update()


def conform(std_arm, body_arm, body_meshes, name_map):
    """Fits std_arm (the standard armature, freshly imported) to a body, keeping every bone's
    orientation and roll (D5), and skins the body to it. body_arm is removed afterwards.

    1. Pose the body's rig onto the standard rest directions and bake that pose into the meshes.
    2. Move each standard joint onto the body's joint; joints the body lacks (leaf bones) keep
       their offset from the parent, scaled by the height ratio.
    3. Skin the meshes to the standard armature by name (the body's weights, renamed by the map).
    Returns the height ratio (body / standard), which scales the pelvis translation of the clips."""
    std_name = lambda n: name_map.get(n, n)
    std_world = {b.name: std_arm.matrix_world @ b.head_local for b in std_arm.data.bones}
    std_bones = {b.name: b for b in std_arm.data.bones}
    if body_arm is not None:
        align_pose(body_arm, std_world, std_bones, std_name)
        mw = body_arm.matrix_world
        joints = {std_name(pb.name): mw @ pb.head for pb in body_arm.pose.bones}
        for o in body_meshes:
            baked_mesh(o, keep=lambda m: m.type != "ARMATURE")
            if o.parent is not None and o.parent_type == "BONE":
                bone = o.parent_bone
                to_world(o)
                for vg in list(o.vertex_groups):
                    o.vertex_groups.remove(vg)
                o.vertex_groups.new(name=std_name(bone)).add(list(range(len(o.data.vertices))), 1.0, "REPLACE")
            else:
                to_world(o)
    else:
        joints = {}
    missing = [n for n in ("Head", "foot_l", "pelvis") if n not in joints]
    if missing:
        raise ValueError(f"the body's rig has no {', '.join(missing)} joint: it is not a humanoid on a known name map")
    ratio = (joints["Head"].z - joints["foot_l"].z) / (std_world["Head"].z - std_world["foot_l"].z)

    inv = std_arm.matrix_world.inverted()
    with edit_bones(std_arm) as eb:
        old = {b.name: (b.head.copy(), b.tail.copy(), b.roll) for b in eb}
        for b in eb:
            b.use_connect = False
        heads = {}

        def place(b):
            h0 = old[b.name][0]
            if b.name in joints:
                heads[b.name] = inv @ joints[b.name]
            elif b.parent is not None:
                heads[b.name] = heads[b.parent.name] + (h0 - old[b.parent.name][0]) * ratio
            else:
                heads[b.name] = h0 * ratio
            for c in b.children:
                place(c)

        for b in eb:
            if b.parent is None:
                place(b)
        for b in eb:
            h0, t0, r0 = old[b.name]
            b.head = heads[b.name]
            b.tail = heads[b.name] + (t0 - h0) * ratio
            b.roll = r0

    for o in body_meshes:
        for vg in o.vertex_groups:
            if vg.name in name_map:
                vg.name = name_map[vg.name]
        bind(o, std_arm)
    if body_arm is not None:
        remove_objects([body_arm])
    return ratio


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


def assign_action(arm, action):
    if arm.animation_data is None:
        arm.animation_data_create()
    arm.animation_data.action = action
    if action is not None and getattr(action, "slots", None) and len(action.slots):
        arm.animation_data.action_slot = action.slots[0]
