"""The measurement shared by the review and the sidecar: size, triangles, textures, clips,
ground speeds, springs and restDeviation.

It measures the candidate GLB itself, imported into an empty scene: exactly what ships.

Ground speed: an in-place locomotion clip plays right at timeScale = move speed / ground speed;
any other rate slides the feet by the difference. The support foot is the lower one; while it
is near the floor it is planted, so its backward speed is the clip's ground speed ("stance"). A
clip with a flight phase (a sprint) touches down for too few samples in that band, so the
fallback ("stride") widens the band to two, then three times, catching each stride's touchdown.
(The distance a foot sweeps while low, over the time it is low, underestimates: touchdown and
lift-off are slow.)"""
import math

import bpy
from mathutils import Matrix, Vector

from . import face, skeleton

LOCOMOTION = ("walk", "run", "jog", "sprint")
SUB = 4  # samples per frame: a sprint's foot contact lasts only a few frames


def _bounds(meshes):
    dg = bpy.context.evaluated_depsgraph_get()
    lo, hi = Vector((1e9,) * 3), Vector((-1e9,) * 3)
    for o in meshes:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        for v in me.vertices:
            w = ev.matrix_world @ v.co
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
        ev.to_mesh_clear()
    return lo, hi


def _ground_speed(ta, tb, fps, height):
    """(m/s, "stance" | "stride") from two foot tracks (world positions per sample), or (None, None)."""
    floor = min(min(p.z for p in ta), min(p.z for p in tb))
    for widen, source in ((1, "stance"), (2, "stride"), (3, "stride")):
        thr = 0.008 * height * widen
        speeds = []
        for i in range(1, len(ta)):
            t = ta if ta[i].z <= tb[i].z else tb
            if t[i].z < floor + thr and t[i - 1].z < floor + thr:
                speeds.append((t[i].y - t[i - 1].y) * fps * SUB)  # it faces -Y: backward is +Y
        if len(speeds) >= 3:
            speeds.sort()
            return speeds[len(speeds) // 2], source
    return None, None


def _clips(arm, meshes, height):
    sc = bpy.context.scene
    fps = sc.render.fps / sc.render.fps_base
    feet = [n for n in ("ball_l", "ball_r") if n in arm.pose.bones] or [n for n in ("foot_l", "foot_r") if n in arm.pose.bones]
    hips = next((n for n in ("pelvis", "root") if n in arm.pose.bones), arm.pose.bones[0].name)
    out = []
    for o in meshes:  # only bones are sampled: skinning every mesh at every subframe is wasted
        o.hide_viewport = True
    for act in sorted(bpy.data.actions, key=lambda a: a.name):
        skeleton.assign_action(arm, act)
        f0, f1 = act.frame_range
        f0, f1 = int(round(f0)), int(round(f1))
        track = {n: [] for n in feet + [hips]}
        for k in range((f1 - f0) * SUB + 1):
            sc.frame_set(f0 + k // SUB, subframe=(k % SUB) / SUB)
            for n in track:
                track[n].append((arm.matrix_world @ arm.pose.bones[n].head).copy())
        tol = 0.02 * max(1.0, height / 1.8)
        h = track[hips]
        clip = {
            "name": act.name,
            "seconds": round((f1 - f0) / fps, 3),
            "loops": all((t[0] - t[-1]).length < tol for t in track.values()),
            "rootDrift": round(math.hypot(h[-1].x - h[0].x, h[-1].y - h[0].y), 3),
            "groundSpeed": None,
            "groundSpeedFrom": None,
        }
        if any(w in act.name.lower() for w in LOCOMOTION) and len(feet) == 2:
            speed, source = _ground_speed(track[feet[0]], track[feet[1]], fps, height)
            if speed is not None and speed > 0.01:
                clip["groundSpeed"], clip["groundSpeedFrom"] = round(speed, 3), source
        out.append(clip)
    skeleton.assign_action(arm, None)
    for pb in arm.pose.bones:
        pb.matrix_basis = Matrix()
    for o in meshes:
        o.hide_viewport = False
    return out


def measure(glb, kind, standard_rest=None, standard_joints=None, chains=None, rig=None):
    """GameModelMeasure of a candidate GLB, plus {armatures: {name: [bones]}, worstJoint}."""
    doc = skeleton.gltf_json(glb)
    bpy.ops.wm.read_factory_settings(use_empty=True)  # one-shot only: nothing of the source scene remains
    skeleton.import_gltf(glb)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    arm = arms[0] if arms else None
    if arm is not None:
        skeleton.assign_action(arm, None)
        for pb in arm.pose.bones:
            pb.matrix_basis = Matrix()
    bpy.context.view_layer.update()
    lo, hi = _bounds(meshes) if meshes else (Vector(), Vector())
    height = max(0.0, hi.z - lo.z)
    textures = [{"width": i.size[0], "height": i.size[1]} for i in bpy.data.images if i.size[0] > 0]
    joints = skeleton.skin_joints(doc)
    deviation, worst = None, None
    if standard_rest and arm is not None:
        found = skeleton.rest_deviation(skeleton.local_rest(doc), standard_rest)
        if found is not None:
            deviation, worst = round(found[0], 2), found[1]
    holds = bool(standard_joints) and all(j in joints for j in standard_joints)
    springs = []
    for name, bones in (chains or {}).items():
        if bones and all(b in joints for b in bones):
            springs.append({"name": name, "bones": list(bones)})
    measured = {
        "kind": kind,
        "skeleton": (rig if holds else None) if arm is not None else None,
        "restDeviation": deviation,
        "height": round(height, 3),
        "footprint": {"width": round(max(0.0, hi.x - lo.x), 3), "depth": round(max(0.0, hi.y - lo.y), 3)},
        "triangles": sum(len(p.vertices) - 2 for o in meshes for p in o.data.polygons),
        "materials": len({s.material.name for o in meshes for s in o.material_slots if s.material}),
        "textures": textures[:32],
        "clips": _clips(arm, meshes, height)[:128] if arm is not None else [],
        "springs": springs[:8],
    }
    blink = face.face_of(arm) if arm is not None else None
    if blink is not None:
        measured["face"] = blink
    return measured, {"armatures": {a.name: [b.name for b in a.data.bones] for a in arms}, "joints": joints, "worstJoint": worst}
