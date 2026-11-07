"""generated(): a model game_generate delivered, brought into the live scene and stamped for the
ledger like any import, so the review, the export and the sidecar credit its provider.

params (the server resolves the path and reads the generation's record):
    path   abs path of the .glb, .gltf or .fbx under art/generated/
    name   the collection it lands in; a creature's armature takes this name too
    lane   "model" (a prop: no armature) or "creature" (one armature, kept as it is)
    stamp  {from, licence, ai, credits}: the provider, its licence line, true, the cost in USD
    rig    a creature's own rig id ("tripo-quadruped"): the lock's rig governs humanoids only
    generation  {id, path}: the generation that delivered it; the server checks a creature's
                armature against it before the lock's rig check skips it
    restore     {scale, translation} | None: how the provider normalized the game's own mesh it
                rigged (normalized = original × scale + translation, glTF axes); undone here, so
                the mesh comes back at the size and place it was made at

A creature keeps its skeleton and its clips: it is never conformed, and its armature carries
kurambit_rig so the pass and the lock know it is on its own rig. A model made in parts keeps each
part as its own object, named after the part, so the game can pivot it. A humanoid is not imported
here: game_blender_character conforms it to the standard skeleton."""
import json
import re

import bpy
import numpy as np
from mathutils import Matrix

from . import helpers, skeleton
from .protocol import Refused, entry


def _clip_name(action):
    """The clip's own name: "Armature|Armature|Walk" and "Armature|walk|baselayer" become Walk, walk."""
    parts = [p for p in action.name.split("|") if p and p.lower() not in ("baselayer", "base layer")]
    name = parts[-1] if parts else action.name
    return re.sub(r"\.\d{3}$", "", name)[:64]


def _rest_idle(arm, owner, stamp, frames=30):
    """A looping clip that holds every bone at rest: a creature's way of standing still."""
    act = bpy.data.actions.new("Idle_Loop")
    act.use_fake_user = True
    act["kurambit_owner"] = owner
    # Another character's Idle_Loop may hold the name in the scene; the export names clips by this.
    act["kurambit_clip"] = "Idle_Loop"
    act["kurambit_source"] = json.dumps({"what": "clips", **stamp})
    skeleton.assign_action(arm, act)
    rotation = {"QUATERNION": "rotation_quaternion", "AXIS_ANGLE": "rotation_axis_angle"}
    for pb in arm.pose.bones:
        pb.matrix_basis = Matrix.Identity(4)
        for frame in (1, 1 + frames):
            for path in ("location", rotation.get(pb.rotation_mode, "rotation_euler"), "scale"):
                pb.keyframe_insert(path, frame=frame)
    return act


@entry
def generated(params):
    name, lane, stamp = params["name"], params["lane"], params["stamp"]
    if name in bpy.data.collections or name in bpy.data.objects:
        raise Refused("invalid-input", f"{name} already exists in the live scene: remove it first (game_blender_code), or import under another name")
    skeleton.object_mode()
    new, actions = skeleton.import_model(params["path"])
    arms = [o for o in new if o.type == "ARMATURE"]
    meshes = [o for o in new if o.type in helpers.GEOMETRY]
    problem = None
    if not meshes:
        problem = "it holds no mesh"
    elif lane == "model" and arms:
        problem = "it is rigged, and a model is an unrigged prop: a rigged animal or monster comes through the creature lane, a humanoid through the character lane"
    elif lane == "creature" and len(arms) != 1:
        problem = f"a creature is one rigged body, and it holds {len(arms)} armatures"
    if problem is not None:
        skeleton.remove_objects(new)
        bpy.data.batch_remove(set(actions))
        raise Refused("invalid-input", f"{params['path']}: {problem}")
    # Empties and cameras a generator leaves (a scene root, bone shapes) are not part of the model.
    for o in new:
        if o not in arms and o not in meshes:
            for child in o.children:
                mw = child.matrix_world.copy()
                child.parent = None
                child.matrix_world = mw
    skeleton.remove_objects([o for o in new if o not in arms and o not in meshes])
    restore = params.get("restore")
    if restore:
        # glTF (x, y, z) is Blender (x, -z, y); the inverse of p * s + t is (p - t) / s.
        tx, ty, tz = restore["translation"]
        undo = Matrix.Diagonal((1 / restore["scale"],) * 3).to_4x4() @ Matrix.Translation((-tx, tz, -ty))
        for o in arms + meshes:
            if o.parent is None:
                o.matrix_world = undo @ o.matrix_world
    coll = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(coll)
    for o in arms + meshes:
        for c in list(o.users_collection):
            c.objects.unlink(o)
        coll.objects.link(o)

    what = "body" if lane == "creature" else "mesh"
    part = json.dumps({"what": what, **stamp})
    parts = {o: o.name for o in meshes}
    for i, o in enumerate(meshes):
        o["kurambit_source"] = part
        if lane == "model":
            # A part keeps the name it was made with (a door, a wheel); a numbered one takes a number.
            own = re.sub(r"[^A-Za-z0-9_]+", "_", re.sub(r"\.\d{3}$", "", parts[o])).strip("_")
            o.name = name if len(meshes) == 1 else f"{name}_{own or i + 1}"
    clips = []
    notes = []
    if arms:
        arm = arms[0]
        # The bodies first: a mesh may already hold the creature's name (a person's own model
        # usually does), and the armature must get it, not a numbered copy of it.
        for i, o in enumerate(meshes):
            o.name = f"{name}_body" if len(meshes) == 1 else f"{name}_body_{i + 1}"
        arm.name = name
        arm.data.name = name
        arm["kurambit_source"] = json.dumps({"what": "clips", **stamp})
        arm["kurambit_rig"] = params["rig"]
        arm["kurambit_generation"] = json.dumps(params["generation"])
        for a in actions:
            label = _clip_name(a)
            a.use_fake_user = True  # an action nothing uses is not saved
            a["kurambit_owner"] = name
            a["kurambit_clip"] = label
            a["kurambit_source"] = json.dumps({"what": "clips", **stamp})
            a.name = label
            clips.append(a.name)
        idle = next((a for a in actions if "idle" in a.name.lower()), None)
        if actions and idle is None:
            # Tripo's creature presets are one walk or march and no idle, so a creature standing
            # still would play its walk in place. Its rest pose is how it stands.
            idle = _rest_idle(arm, name, stamp)
            clips.append(idle["kurambit_clip"])
            notes.append(f"it came with no idle ({', '.join(clips[:-1])[:200]}): Idle_Loop was added, holding its rest pose. Key a breath or a look on its own bones if it should move while it stands")
        skeleton.assign_action(arm, idle)
        if not actions:
            notes.append("it came with no clips: it ships in its rest pose, or key clips on its own bones")
    else:
        bpy.data.batch_remove(set(actions))
    co = np.concatenate([helpers.rest_coords(o)[0] for o in meshes if o.type == "MESH"] or [np.zeros((1, 3))])
    size = [round(float(x), 3) for x in co.max(0) - co.min(0)]
    return {
        "objects": [o.name for o in arms + meshes],
        "armature": arms[0].name if arms else None,
        "clips": clips,
        "size": size,
        "notes": notes,
    }
