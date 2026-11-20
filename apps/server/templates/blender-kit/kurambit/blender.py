"""Blender's own tools, in reach of plain bpy: Rigify's meta-rigs and the bundled node groups.

A game creature uses the meta-rig itself as its skeleton and keys its walk with bake_ik_walk: the
meta-rig's hierarchy exports intact, legs under the spine. Rigify's generated rig is not for games:
its glTF export flattens the deform bones under the rig root.

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
    its clips with bake_ik_walk."""
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
