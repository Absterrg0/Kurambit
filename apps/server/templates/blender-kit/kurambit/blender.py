"""Blender's own tools, in reach of plain bpy: Rigify's meta-rigs and the bundled node groups.

A game creature uses the meta-rig itself as its skeleton and keys its walk with bake_ik_walk: the
meta-rig's hierarchy exports intact, legs under the spine. Rigify's generated rig, below, stays for
the models made with it before.

Rigify generates a control rig of several hundred bones (ORG, MCH, DEF and the controls). A game
plays the deform bones alone, and Rigify parents those under ORG and MCH bones that do not
ship, so game_rig bakes each clip keyed on the controls onto a plain armature of the DEF bones,
each parented to its nearest DEF ancestor, and moves the body's weights to it. That armature is
marked as the creature's own rig (kurambit_rig) and is what the review and the export take.

Blender 4.5 bundles Smooth by Angle and the hair curve groups as node assets; Scatter on Surface
and Curve to Tube arrived with 5.x's Essentials, so scatter and tube build the same few nodes
here."""
import importlib
import json
import os

import bpy
from mathutils import Matrix, Vector

from . import helpers, skeleton

METARIGS = {
    "human": "rigify.metarigs.human",
    "basic_human": "rigify.metarigs.Basic.basic_human",
    "basic_quadruped": "rigify.metarigs.Basic.basic_quadruped",
    "horse": "rigify.metarigs.Animals.horse",
    "wolf": "rigify.metarigs.Animals.wolf",
    "cat": "rigify.metarigs.Animals.cat",
    "bird": "rigify.metarigs.Animals.bird",
    "shark": "rigify.metarigs.Animals.shark",
}


def _rigify():
    import addon_utils

    addon_utils.enable("rigify", default_set=True)


def _active(ob):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)


def metarig(kind, name=None, height=None):
    """One of Rigify's meta-rigs (METARIGS), standing on the ground facing -Y, scaled to height
    metres when given, its joint print on stdout. For a game creature the meta-rig itself is the
    skeleton: fit its bones in edit mode, model the parts on its joints, turn use_deform on and key
    its clips with bake_ik_walk (rigify() and game_rig() twist a game rig's rest pose)."""
    if kind not in METARIGS:
        raise ValueError(f"no meta-rig {kind!r}: one of {', '.join(METARIGS)}")
    _rigify()
    name = name or f"{kind}_metarig"
    ob = bpy.data.objects.new(name, bpy.data.armatures.new(name))
    bpy.context.scene.collection.objects.link(ob)
    skeleton.object_mode()
    _active(ob)
    importlib.import_module(METARIGS[kind]).create(ob)
    skeleton.object_mode()
    if height:
        zs = [z for b in ob.data.bones for z in (b.head_local.z, b.tail_local.z)]
        k = height / max(max(zs) - min(0.0, min(zs)), 1e-6)
        ob.data.transform(Matrix.Scale(k, 4))
    print(helpers.joints(ob))
    return ob


def rigify(meta, body=None, name=None):
    """Generates Rigify's control rig from a meta-rig and, given the body (a mesh or a list),
    binds it with automatic weights to the deform bones. Returns the control rig. Kept for rigs
    made with it; a game creature keeps its meta-rig (game_rig twists its rest pose)."""
    _rigify()
    skeleton.object_mode()
    name = name or meta.name.replace("_metarig", "") + "_controls"
    meta.data.rigify_target_rig = None
    meta.data.rigify_rig_basename = name
    _active(meta)
    bpy.ops.pose.rigify_generate()
    rig = bpy.data.objects.get(name) or next(o for o in bpy.data.objects if o.type == "ARMATURE" and o.data.get("rig_id") and o is not meta)
    meta.hide_set(True)
    meta.hide_render = True
    for o in [body] if body is not None and not isinstance(body, (list, tuple)) else (body or []):
        for o2 in bpy.context.view_layer.objects:
            o2.select_set(False)
        o.select_set(True)
        rig.select_set(True)
        bpy.context.view_layer.objects.active = rig
        bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    return rig


def game_rig(rig, name, clips=None):
    """A plain armature of the control rig's DEF bones (named without DEF-, each under its
    nearest DEF ancestor), with every clip keyed on the controls baked onto it, and the meshes
    the rig deformed moved to it. clips: actions to bake, default every action keyed on the rig.
    Marks it the creature's own rig (kurambit_rig = name). Returns the new armature."""
    skeleton.object_mode()
    deform = [b for b in rig.data.bones if b.use_deform]

    def keep_parent(b):
        p = b.parent
        while p is not None and not p.use_deform:
            p = p.parent
        return p

    short = lambda n: n[4:] if n.startswith("DEF-") else n
    arm = bpy.data.objects.new(name, bpy.data.armatures.new(name))
    bpy.context.scene.collection.objects.link(arm)
    arm.matrix_world = rig.matrix_world.copy()
    _active(arm)
    bpy.ops.object.mode_set(mode="EDIT")
    for b in deform:
        e = arm.data.edit_bones.new(short(b.name))
        e.head, e.tail = b.head_local, b.tail_local
        e.align_roll(b.z_axis)
    for b in deform:
        p = keep_parent(b)
        if p is not None:
            arm.data.edit_bones[short(b.name)].parent = arm.data.edit_bones[short(p.name)]
    bpy.ops.object.mode_set(mode="OBJECT")
    # The game rig follows the controls while the clips are baked.
    for pb in arm.pose.bones:
        c = pb.constraints.new("COPY_TRANSFORMS")
        c.target, c.subtarget = rig, "DEF-" + pb.name if "DEF-" + pb.name in rig.pose.bones else pb.name
    if clips is None:
        clips = [a for a in bpy.data.actions if any(fc.data_path.startswith("pose.bones") for fc in skeleton.action_fcurves(a)) and a.get("kurambit_owner") in (None, rig.name)]
    sc = bpy.context.scene
    baked = []
    for act in clips:
        rig.animation_data_create()
        rig.animation_data.action = act
        lo, hi = (int(round(x)) for x in act.frame_range)
        clip = act.get("kurambit_clip", act.name)
        # The controls' clip stays to edit and bake again, owned by the control rig, so it never
        # rides along with the game rig's export; the baked one takes the clip's name.
        act["kurambit_owner"], act["kurambit_clip"] = rig.name, clip
        act.use_fake_user = True
        if act.name == clip:
            act.name = f"{rig.name}|{clip}"
        stale = bpy.data.actions.get(clip)
        if stale is not None and stale.get("kurambit_owner") == name:
            bpy.data.actions.remove(stale)
        out = bpy.data.actions.new(clip)
        out.use_fake_user = True
        out["kurambit_owner"], out["kurambit_clip"] = name, clip
        skeleton.assign_action(arm, out)
        for pb in arm.pose.bones:
            pb.rotation_mode = "QUATERNION"
        for f in range(lo, hi + 1):
            sc.frame_set(f)
            visual = {pb.name: pb.matrix.copy() for pb in arm.pose.bones}
            for pb in arm.pose.bones:
                for c in pb.constraints:
                    c.mute = True
            for pb in arm.pose.bones:  # parents first: each bone's basis from its visual matrix
                pb.matrix = visual[pb.name]
                bpy.context.view_layer.update()
            for pb in arm.pose.bones:
                pb.keyframe_insert("rotation_quaternion", frame=f - lo)
                pb.keyframe_insert("location", frame=f - lo)
                pb.keyframe_insert("scale", frame=f - lo)
            for pb in arm.pose.bones:
                for c in pb.constraints:
                    c.mute = False
        baked.append(out)
    if rig.animation_data is not None:
        rig.animation_data.action = None
    for pb in arm.pose.bones:
        for c in list(pb.constraints):
            pb.constraints.remove(c)
        pb.matrix_basis = Matrix()
    skeleton.assign_action(arm, baked[0] if baked else None)
    for o in bpy.data.objects:
        mod = next((m for m in o.modifiers if m.type == "ARMATURE" and m.object == rig), None) if o.type == "MESH" else None
        if mod is None:
            continue
        mod.object = arm
        for vg in o.vertex_groups:
            if vg.name.startswith("DEF-"):
                vg.name = vg.name[4:]
        if o.parent == rig:
            mw = o.matrix_world.copy()
            o.parent = arm
            o.matrix_world = mw
    arm["kurambit_rig"] = name
    rig.hide_set(True)
    rig.hide_render = True
    return arm


def node_group(name):
    """A node group Blender bundles as an asset ("Smooth by Angle", "Generate Hair Curves"...),
    appended once."""
    if name in bpy.data.node_groups:
        return bpy.data.node_groups[name]
    root = os.path.join(bpy.utils.resource_path("LOCAL"), "datafiles", "assets")
    for folder, _, files in os.walk(root):
        for f in files:
            if not f.endswith(".blend"):
                continue
            with bpy.data.libraries.load(os.path.join(folder, f), assets_only=True) as (src, dst):
                if name in src.node_groups:
                    dst.node_groups = [name]
            if name in bpy.data.node_groups:
                return bpy.data.node_groups[name]
    raise ValueError(f"Blender {bpy.app.version_string} bundles no node group {name!r}")


def _modifier(obj, label, build):
    tree = bpy.data.node_groups.new(label, "GeometryNodeTree")
    tree.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    tree.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    n = tree.nodes
    gin, gout = n.new("NodeGroupInput"), n.new("NodeGroupOutput")
    tree.links.new(build(tree, gin.outputs[0]), gout.inputs[0])
    mod = obj.modifiers.new(label, "NODES")
    mod.node_group = tree
    return mod


def scatter(obj, on, density=1.0, seed=0, scale=(0.8, 1.2)):
    """Instances of obj scattered over the faces of on (per square metre), turned at random about
    up and scaled within scale, as a Geometry Nodes modifier on a new object (the ground itself is
    not part of it)."""
    out = bpy.data.objects.new(f"{obj.name}_scatter", bpy.data.meshes.new(f"{obj.name}_scatter"))
    bpy.context.scene.collection.objects.link(out)

    def build(tree, geo):
        n, L = tree.nodes, tree.links
        info = n.new("GeometryNodeObjectInfo")
        info.inputs["Object"].default_value = on
        info.transform_space = "RELATIVE"
        dist = n.new("GeometryNodeDistributePointsOnFaces")
        dist.inputs["Density"].default_value = density
        dist.inputs["Seed"].default_value = seed
        L.new(info.outputs["Geometry"], dist.inputs["Mesh"])
        inst = n.new("GeometryNodeObjectInfo")
        inst.inputs["Object"].default_value = obj
        place = n.new("GeometryNodeInstanceOnPoints")
        L.new(dist.outputs["Points"], place.inputs["Points"])
        L.new(inst.outputs["Geometry"], place.inputs["Instance"])
        turn = n.new("FunctionNodeRandomValue")
        turn.data_type = "FLOAT_VECTOR"
        turn.inputs["Min"].default_value = (0, 0, 0)
        turn.inputs["Max"].default_value = (0, 0, 6.2832)
        turn.inputs["Seed"].default_value = seed + 1
        L.new(turn.outputs["Value"], place.inputs["Rotation"])
        size = n.new("FunctionNodeRandomValue")
        size.inputs[2].default_value, size.inputs[3].default_value = scale
        size.inputs["Seed"].default_value = seed + 2
        L.new(size.outputs[1], place.inputs["Scale"])
        real = n.new("GeometryNodeRealizeInstances")
        L.new(place.outputs["Instances"], real.inputs["Geometry"])
        return real.outputs["Geometry"]

    _modifier(out, "scatter", build)
    return out


def tube(curve, radius=0.05, sides=6):
    """A curve swept into a closed tube of radius metres, as a Geometry Nodes modifier on it."""

    def build(tree, geo):
        n, L = tree.nodes, tree.links
        circle = n.new("GeometryNodeCurvePrimitiveCircle")
        circle.inputs["Resolution"].default_value = sides
        circle.inputs["Radius"].default_value = radius
        sweep = n.new("GeometryNodeCurveToMesh")
        sweep.inputs["Fill Caps"].default_value = True
        L.new(geo, sweep.inputs["Curve"])
        L.new(circle.outputs["Curve"], sweep.inputs["Profile Curve"])
        return sweep.outputs["Mesh"]

    return _modifier(curve, "tube", build)


def bake_ik_walk(arm, feet, step, frames, clip="Walk"):
    """Keys a clip on a plain armature through IK legs and bakes it to its bones. feet: the foot
    bones; each one's parent gets a two-bone IK aimed at an empty at the foot. step(foot, frame)
    gives that empty's offset from rest in metres (Vector((0, 0, 0)) plants it; stance slides back
    at the walk's speed, swing lifts). Keys already on the action clip (a bob, a breath) bake with
    it. Constraints and empties go after; the clip is the armature's own, looping over
    0..frames, and the feet are recorded for the feet gate. Returns the action."""
    skeleton.object_mode()
    sc = bpy.context.scene
    act = bpy.data.actions.get(clip) or bpy.data.actions.new(clip)
    arm.animation_data_create()
    arm.animation_data.action = act
    made = []
    try:
        for foot in feet:
            if foot not in arm.pose.bones or arm.pose.bones[foot].parent is None:
                raise ValueError(f"{arm.name} has no foot bone {foot} with a parent to bend")
            e = bpy.data.objects.new(f"ik_{foot}", None)
            sc.collection.objects.link(e)
            rest = arm.matrix_world @ arm.data.bones[foot].head_local
            for f in range(frames + 1):
                e.location = rest + Vector(step(foot, f))
                e.keyframe_insert("location", frame=f)
            c = arm.pose.bones[foot].parent.constraints.new("IK")
            c.name, c.target, c.chain_count = "kurambit_ik", e, 2
            made.append((e, arm.pose.bones[foot].parent, c))
        for pb in arm.pose.bones:
            pb.rotation_mode = "QUATERNION"
        _active(arm)
        bpy.ops.object.mode_set(mode="POSE")
        bpy.ops.pose.select_all(action="SELECT")
        bpy.ops.nla.bake(frame_start=0, frame_end=frames, only_selected=False, visual_keying=True,
                         clear_constraints=False, use_current_action=True, bake_types={"POSE"})
    finally:
        skeleton.object_mode()
        for e, pb, c in made:
            pb.constraints.remove(c)
            act_e = e.animation_data.action if e.animation_data else None
            bpy.data.objects.remove(e)
            if act_e is not None and act_e.users == 0:
                bpy.data.actions.remove(act_e)
    name = arm.get("kurambit_rig") or arm.name
    arm["kurambit_rig"] = name
    act.use_fake_user = True
    act["kurambit_owner"], act["kurambit_clip"] = arm.name, clip
    arm["kurambit_legs"] = json.dumps([{"foot": f} for f in feet])
    sc.frame_set(0)
    return act
