"""The measurement shared by the review and the sidecar: size, triangles, textures, clips,
ground speeds, springs and restDeviation; on a character also skin through skin, and per clip
arms through the body, the loop seam and knee pops (contact.py).

It measures the candidate GLB itself, imported into an empty scene: exactly what ships.

Ground speed: an in-place locomotion clip plays right at timeScale = move speed / ground speed;
any other rate slides the feet by the difference. The support foot is the lower one; while it
is near the floor it is planted, so its backward speed is the clip's ground speed ("stance"). A
clip with a flight phase (a sprint) touches down for too few samples in that band, so the
fallback ("stride") widens the band to two, then three times, catching each stride's touchdown.
(The distance a foot sweeps while low, over the time it is low, underestimates: touchdown and
lift-off are slow.)

Per clip, from the bones at every frame: the seam (a *_Loop clip's last-to-first pose step over
its mean frame step, the pelvis's horizontal travel removed: about 1 is seamless) and knee pops
(one-frame knee bends of KNEE_POP degrees or more against both neighbours, either way). From the
skin at every ARM_EVERY-th frame: arm skin through the body, mm² per sampled frame. Bones are
sampled with the meshes hidden; only that skin pass evaluates them."""
import math

import bpy
import numpy as np
from mathutils import Matrix, Vector

from . import contact, face, skeleton

LOCOMOTION = ("walk", "run", "jog", "sprint")
SUB = 4  # samples per frame: a sprint's foot contact lasts only a few frames
KNEE_POP = 8.0
ARM_EVERY = 2
KNEES = (("thigh_l", "calf_l"), ("thigh_r", "calf_r"))


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


def _seam(poses, hips):
    """The loop point's pose step over the mean frame step, or None under three frames."""
    if len(poses) < 3:
        return None
    off = np.zeros((len(hips), 1, 3))
    off[:, 0, :2] = hips[:, :2] - hips[0, :2]
    p = poses - off
    steps = np.linalg.norm(p[1:] - p[:-1], axis=2).mean(1)
    if steps.mean() < 1e-9:
        return None
    last = len(p) - 1
    if np.linalg.norm(p[last] - p[0], axis=1).mean() < 0.05 * steps.mean():  # a closing key repeating the first
        last -= 1
    return round(float(np.linalg.norm(p[0] - p[last], axis=1).mean() / steps[:last].mean()), 2)


def _knee_pops(bends):
    pops = 0
    for a in bends:
        a = np.array(a)
        if len(a) < 3:
            continue
        d0, d1 = a[1:-1] - a[:-2], a[2:] - a[1:-1]
        pops += int(np.sum((np.abs(d0) >= KNEE_POP) & (np.abs(d1) >= KNEE_POP) & (d0 * d1 < 0)))
    return pops


def _bend(arm, upper, lower):
    u = arm.pose.bones[upper]
    lo = arm.pose.bones[lower]
    return math.degrees((u.tail - u.head).angle(lo.tail - lo.head, 0.0))


def _clips(arm, meshes, height, skin=None):
    sc = bpy.context.scene
    fps = sc.render.fps / sc.render.fps_base
    feet = [n for n in ("ball_l", "ball_r") if n in arm.pose.bones] or [n for n in ("foot_l", "foot_r") if n in arm.pose.bones]
    hips = next((n for n in ("pelvis", "root") if n in arm.pose.bones), arm.pose.bones[0].name)
    knees = [k for k in KNEES if all(n in arm.pose.bones for n in k)]
    out = []
    for o in meshes:  # only bones are sampled: skinning every mesh at every subframe is wasted
        o.hide_viewport = True
    for act in sorted(bpy.data.actions, key=lambda a: a.name):
        skeleton.assign_action(arm, act)
        f0, f1 = act.frame_range
        f0, f1 = int(round(f0)), int(round(f1))
        track = {n: [] for n in feet + [hips]}
        poses, bends = [], [[] for _ in knees]
        for k in range((f1 - f0) * SUB + 1):
            sc.frame_set(f0 + k // SUB, subframe=(k % SUB) / SUB)
            for n in track:
                track[n].append((arm.matrix_world @ arm.pose.bones[n].head).copy())
            if k % SUB == 0:
                poses.append([arm.matrix_world @ v for b in arm.pose.bones for v in (b.head, b.tail)])
                for i, (up, lo) in enumerate(knees):
                    bends[i].append(_bend(arm, up, lo))
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
        loop = act.name.lower().endswith("_loop")
        clip["seam"] = _seam(np.array(poses), np.array([h[i].to_tuple() for i in range(0, len(h), SUB)])) if loop else None
        clip["kneePops"] = _knee_pops(bends) if knees else None
        clip["armThroughBody"] = None
        if skin is not None:
            for o in meshes:
                o.hide_viewport = False
            through = []
            for f in range(f0, f1 + 1, ARM_EVERY):
                sc.frame_set(f)
                through.append(skin.arm_body_mm2())
            for o in meshes:
                o.hide_viewport = True
            clip["armThroughBody"] = round(sum(through) / len(through), 1) if through else None
        out.append(clip)
    skeleton.assign_action(arm, None)
    for pb in arm.pose.bones:
        pb.matrix_basis = Matrix()
    for o in meshes:
        o.hide_viewport = False
    return out


def _unweighted(meshes):
    """Vertices the glTF exporter bound to its neutral_bone: weighted to no bone of the skin."""
    n = 0
    for o in meshes:
        g = o.vertex_groups.get("neutral_bone")
        if g is not None:
            n += sum(1 for v in o.data.vertices if any(e.group == g.index and e.weight > 0 for e in v.groups))
    return n


def measure(glb, kind, standard_rest=None, standard_joints=None, chains=None, rig=None):
    """GameModelMeasure of a candidate GLB, plus {armatures: {name: [bones]}, worstJoint}."""
    doc = skeleton.gltf_json(glb)
    bpy.ops.wm.read_factory_settings(use_empty=True)  # one-shot only: nothing of the source scene remains
    # At the clips' own rate, or a 30 fps clip lands between 24 fps frames and its length and seam read wrong.
    bpy.context.scene.render.fps, bpy.context.scene.render.fps_base = skeleton.clip_rate(doc) or 24, 1.0
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
    skin, through = None, None
    skinned = [o for o in meshes if arm is not None and any(m.type == "ARMATURE" and m.object == arm for m in o.modifiers)]
    if kind == "character" and skinned:
        skin = contact.Skin(arm, skinned)
        through = {"rest": skin.pct(skin.rest_hits), "bent": skin.bent() if holds else None}
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
        "clips": _clips(arm, meshes, height, skin if skin is not None and skin.has_arms else None)[:128] if arm is not None else [],
        "springs": springs[:8],
    }
    if through is not None:
        measured["skinThrough"] = through
    blink = face.face_of(arm) if arm is not None else None
    if blink is not None:
        measured["face"] = blink
    return measured, {"armatures": {a.name: [b.name for b in a.data.bones] for a in arms}, "joints": joints, "worstJoint": worst,
                      "unweighted": _unweighted(meshes)}
