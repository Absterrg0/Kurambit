"""The measurement shared by the review and the sidecar: size, triangles, textures, clips,
ground speeds, springs and restDeviation; on a character also skin through skin, and per clip
arms through the body, the loop seam and knee pops (contact.py).

It measures the candidate GLB itself, imported into an empty scene: exactly what ships.

Ground speed: an in-place locomotion clip plays right at timeScale = move speed / ground speed;
any other rate slides the feet by the difference. The feet are the standard ball (or foot) bones,
or on another rig the lowest bone of each chain (lowest_chains). The support foot is the lowest; while it
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

LOCOMOTION = ("walk", "run", "jog", "sprint", "trot", "gallop", "canter")
SUB = 4  # samples per frame: a sprint's foot contact lasts only a few frames
KNEE_POP = 8.0
STILL_METRES = 1e-4
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


def _ground_speed(tracks, fps, height):
    """(m/s, "stance" | "stride") from two or more foot tracks (world positions per sample), or
    (None, None)."""
    floor = min(p.z for t in tracks for p in t)
    for widen, source in ((1, "stance"), (2, "stride"), (3, "stride")):
        thr = 0.008 * height * widen
        speeds = []
        for i in range(1, len(tracks[0])):
            t = min(tracks, key=lambda t: t[i].z)
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


def lowest_chains(arm):
    """The bones a body stands on, on any rig: the lowest bone of each chain whose rest head lies
    in the bottom tenth of the skeleton (a quadruped's four paws, a bird's two). [] under two."""
    heads = {b.name: (arm.matrix_world @ b.head_local).z for b in arm.data.bones if b.use_deform}
    if len(heads) < 2:
        return []
    lo, hi = min(heads.values()), max(heads.values())
    low = {n for n, z in heads.items() if z <= lo + 0.1 * max(hi - lo, 1e-6)}

    def below(b):
        return any(c.name in low or below(c) for c in b.children)

    # A chain's lowest: in the band, with nothing of the band under it (a toe, not its ankle).
    feet = [n for n in low if not below(arm.data.bones[n])]
    return sorted(feet) if len(feet) >= 2 else []


def _clips(arm, meshes, height, skin=None):
    sc = bpy.context.scene
    fps = sc.render.fps / sc.render.fps_base
    feet = ([n for n in ("ball_l", "ball_r") if n in arm.pose.bones] or [n for n in ("foot_l", "foot_r") if n in arm.pose.bones]
            or lowest_chains(arm))
    hips = next((n for n in ("pelvis", "root") if n in arm.pose.bones), arm.pose.bones[0].name)
    knees = [k for k in KNEES if all(n in arm.pose.bones for n in k)]
    out = []
    frozen = []
    body = _body_of(arm, meshes)
    for o in meshes:  # only bones are sampled: skinning every mesh at every subframe is wasted
        o.hide_viewport = True
    for act in sorted(bpy.data.actions, key=lambda a: a.name):
        skeleton.assign_action(arm, act)
        f0, f1 = act.frame_range
        f0, f1 = int(round(f0)), int(round(f1))
        track = {n: [] for n in feet + [hips]}
        poses, bends, frames = [], [[] for _ in knees], []
        for k in range((f1 - f0) * SUB + 1):
            sc.frame_set(f0 + k // SUB, subframe=(k % SUB) / SUB)
            for n in track:
                track[n].append((arm.matrix_world @ arm.pose.bones[n].head).copy())
            if k % SUB == 0:
                poses.append([arm.matrix_world @ v for b in arm.pose.bones for v in (b.head, b.tail)])
                if body is not None:
                    frames.append({pb.name: np.array(pb.matrix) for pb in arm.pose.bones})
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
        if any(w in act.name.lower() for w in LOCOMOTION) and len(feet) >= 2:
            speed, source = _ground_speed([track[n] for n in feet], fps, height)
            if speed is not None and speed > 0.01:
                clip["groundSpeed"], clip["groundSpeedFrom"] = round(speed, 3), source
        # A clip whose bones never leave its first pose ships still: its contact numbers would read
        # as perfect, so they are left unmeasured and the clip is named instead.
        still = len(poses) < 2 or max(
            (a - b).length for frame in poses[1:] for a, b in zip(frame, poses[0])
        ) < STILL_METRES
        if still:
            frozen.append(act.name)
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
        if still:
            clip["seam"] = clip["kneePops"] = clip["armThroughBody"] = None
        elif body is not None and len(frames) >= 3:
            clip.update(_contacts(body, frames, fps, act.name))
        out.append(clip)
    skeleton.assign_action(arm, None)
    for pb in arm.pose.bones:
        pb.matrix_basis = Matrix()
    for o in meshes:
        o.hide_viewport = False
    return out, frozen


def _body_of(arm, meshes):
    """The standard skeleton's landmarks and held prop for the contacts, or None off it."""
    from .animrig import Body

    try:
        return Body(arm, meshes)
    except ValueError:
        return None


def _contacts(body, frames, fps, name):
    """The clip's stances (each foot's planted spans) and strikes (a held prop's tip, a free hand
    or a foot at speed, held out from the body; none in a locomotion clip), in the clip's seconds,
    so a game reads its hit windows and foot plants instead of guessing."""
    m = Motion(body, fps)
    pts = [m.points(P) for P in frames]
    floor = m.floor_of(pts)
    planted = m.contacts(pts, floor)
    t = lambda f: round(f / fps, 3)  # noqa: E731
    stances = sorted(({"foot": "foot_" + s, "from": t(a), "to": t(b)} for s in "lr" for a, b in planted[s]), key=lambda x: x["from"])
    strikes = [] if any(w in name.lower() for w in LOCOMOTION) else [
        {"at": t(st["frame"]), "from": t(st["window"][0]), "to": t(st["window"][1]), "by": st["by"], "speed": st["speed"]}
        for st in m.strikes(frames, pts, floor)]
    return {"stances": stances[:32], "strikes": strikes[:16]}


def _unweighted(meshes):
    """Vertices the glTF exporter bound to its neutral_bone: weighted to no bone of the skin."""
    n = 0
    for o in meshes:
        g = o.vertex_groups.get("neutral_bone")
        if g is not None:
            n += sum(1 for v in o.data.vertices if any(e.group == g.index and e.weight > 0 for e in v.groups))
    return n


def measure(glb, kind, standard_rest=None, standard_joints=None, chains=None, rig=None, own_rig=None):
    """GameModelMeasure of a candidate GLB, plus {armatures: {name: [bones]}, worstJoint}. own_rig
    names a creature's own skeleton ("tripo-quadruped"): its sidecar's skeleton, off the standard."""
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
    clips, frozen = _clips(arm, meshes, height, skin if skin is not None and skin.has_arms else None) if arm is not None else ([], [])
    springs = []
    for name, bones in (chains or {}).items():
        if bones and all(b in joints for b in bones):
            springs.append({"name": name, "bones": list(bones)})
    measured = {
        "kind": kind,
        "skeleton": (own_rig or (rig if holds else None)) if arm is not None else None,
        "restDeviation": deviation,
        "height": round(height, 3),
        "footprint": {"width": round(max(0.0, hi.x - lo.x), 3), "depth": round(max(0.0, hi.y - lo.y), 3)},
        "triangles": sum(len(p.vertices) - 2 for o in meshes for p in o.data.polygons),
        "materials": len({s.material.name for o in meshes for s in o.material_slots if s.material}),
        "textures": textures[:32],
        "clips": clips[:128],
        "springs": springs[:8],
    }
    if through is not None:
        measured["skinThrough"] = through
    blink = face.face_of(arm) if arm is not None else None
    if blink is not None:
        measured["face"] = blink
    return measured, {"armatures": {a.name: [b.name for b in a.data.bones] for a in arms}, "joints": joints, "worstJoint": worst,
                      "unweighted": _unweighted(meshes), "frozen": frozen}


# ------------------------------------------------------------------------------------ motion metrics
# The numbers game_animate returns after every pass, measured on a clip as Blender plays it on the
# character, so a compiled move and a library clip are measured by the same code on the same body.
# The same stances and strikes go into the sidecar per clip (_contacts), so a game reads its hit
# windows and planted feet instead of guessing.
G = 9.81
# Winter's segment masses (share of the body) and where each segment's centre lies from its near end.
SEGMENTS = (
    ("Head", "Head:tail", 0.081, 0.5), ("pelvis", "neck_01", 0.497, 0.5),
    ("upperarm_l", "lowerarm_l", 0.028, 0.436), ("upperarm_r", "lowerarm_r", 0.028, 0.436),
    ("lowerarm_l", "hand_l", 0.016, 0.43), ("lowerarm_r", "hand_r", 0.016, 0.43),
    ("hand_l", "middle_01_l", 0.006, 0.5), ("hand_r", "middle_01_r", 0.006, 0.5),
    ("thigh_l", "calf_l", 0.100, 0.433), ("thigh_r", "calf_r", 0.100, 0.433),
    ("calf_l", "foot_l", 0.0465, 0.433), ("calf_r", "foot_r", 0.0465, 0.433),
    ("foot_l", "ball_l", 0.0145, 0.5), ("foot_r", "ball_r", 0.0145, 0.5),
)
# Human range of motion, degrees (AAOS normal values, rounded).
ROM = {
    "knee_flex": (-5, 145), "elbow_flex": (-5, 150), "hip_flex": (-30, 125), "hip_abd": (-30, 50),
    "spine_twist": (-50, 50), "spine_flex": (-35, 95), "spine_side": (-40, 40), "neck_turn": (-80, 80),
    "neck_flex": (-60, 55), "wrist_bend": (0, 85), "ankle_dorsi": (-55, 30),
}
CONTACT_Z = 0.02
CONTACT_V = 1.0  # m/s: a foot skimming the floor faster than this is stepping, not standing
PROP_STRIKE = 5.0  # m/s at a held prop's tip
LIMB_STRIKE = 3.5  # m/s at a free hand or a foot, held out from the body
TRACKED = ("hand_r", "hand_l", "foot_l", "foot_r", "Head", "pelvis")


def _hull(pts):
    pts = sorted(set(map(tuple, np.round(pts, 4))))
    if len(pts) <= 2:
        return np.array(pts)

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lo, hi = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(hi) >= 2 and cross(hi[-2], hi[-1], p) <= 0:
            hi.pop()
        hi.append(p)
    return np.array(lo[:-1] + hi[:-1])


def _seg_dist(p, a, b):
    ab = b - a
    t = 0 if np.dot(ab, ab) < 1e-12 else min(1, max(0, np.dot(p - a, ab) / np.dot(ab, ab)))
    return float(np.linalg.norm(p - (a + ab * t)))


def _outside(p, hull):
    """How far a 2-D point is outside a convex hull, 0 inside."""
    if len(hull) == 1:
        return float(np.linalg.norm(p - hull[0]))
    if len(hull) == 2:
        return _seg_dist(p, hull[0], hull[1])
    n = len(hull)
    if all(((hull[(i + 1) % n][0] - hull[i][0]) * (p[1] - hull[i][1]) - (hull[(i + 1) % n][1] - hull[i][1]) * (p[0] - hull[i][0])) >= 0 for i in range(n)):
        return 0.0
    return min(_seg_dist(p, hull[i], hull[(i + 1) % n]) for i in range(n))


def _ypr(R):
    """(yaw, pitch, roll) of R = Rz(yaw) Rx(pitch) Ry(-roll)."""
    b = math.asin(max(-1, min(1, R[2, 1])))
    return math.degrees(math.atan2(-R[0, 1], R[1, 1])), math.degrees(b), -math.degrees(math.atan2(-R[2, 0], R[2, 2]))


def _unit(v):
    n = np.linalg.norm(v)
    return v / n if n > 1e-9 else v


def _runs(flags):
    """[(first, last)] of each run of True."""
    out, k, n = [], 0, len(flags)
    while k < n:
        if not flags[k]:
            k += 1
            continue
        j = k
        while j + 1 < n and flags[j + 1]:
            j += 1
        out.append((k, j))
        k = j + 1
    return out


class Motion:
    """Foot slide per stance, balance, joint limits, smoothness, seams, strikes, the floor and root
    travel of a clip, from the armature-space pose of every bone at every frame."""

    def __init__(self, body, fps):
        from .animrig import B2W, rest_hinge

        self.body, self.rig, self.fps, self.B2W = body, body.rig, fps, B2W
        r = self.rig
        self.heel_local = {}
        for s in "lr":
            ank = r.head("foot_" + s)
            heel = np.array([ank[0], ank[1] + 0.02 * body.height, 0.0])
            self.heel_local[s] = (r.Linv["foot_" + s] @ np.array([*heel, 1]))[:3]
        # each contact point's height at rest: a point is down when it is back near there
        rp = self.points(r.fk({}))
        self.rest_z = {"heel": float(rp["heel_l"][2]), "ball": float(rp["ball_l"][2]), "toe": float(rp["toe_l"][2])}
        self.hinge = {n: rest_hinge(r.L, n) for n in ("thigh_l", "thigh_r", "upperarm_l", "upperarm_r")}

    def points(self, P):
        r = self.rig
        out = {n: P[n][:3, 3] for n in ("hand_r", "hand_l", "Head", "pelvis", "foot_l", "foot_r")}
        for s in "lr":
            out["ball_" + s] = P["ball_" + s][:3, 3]
            out["toe_" + s] = (P["ball_" + s] @ np.array([0, r.length["ball_" + s], 0, 1]))[:3]
            out["heel_" + s] = (P["foot_" + s] @ np.array([*self.heel_local[s], 1]))[:3]
        tip = self.body.tip_of(P)
        if tip is not None:
            out["tip"] = tip
        return out

    def com(self, P):
        r = self.rig
        tot, acc = 0.0, np.zeros(3)
        for a, b, m, k in SEGMENTS:
            pa = P[a][:3, 3]
            pb = (P[a] @ np.array([0, r.length[a], 0, 1]))[:3] if b.endswith(":tail") else P[b][:3, 3]
            acc += m * (pa + (pb - pa) * k)
            tot += m
        prop = self.body.prop
        if prop is not None:
            mid = (P["hand_" + prop["side"]] @ np.array([*((prop["grip"] + prop["tip"]) / 2), 1]))[:3]
            acc += prop["mass"] * mid
            tot += prop["mass"]
        return acc / tot

    def angles(self, P):
        r, B2W = self.rig, self.B2W
        out = {}

        def Rd(n):
            return P[n][:3, :3] @ r.L[n][:3, :3].T

        for s in "lr":
            for up, lo, key in (("thigh_" + s, "calf_" + s, "knee_flex"), ("upperarm_" + s, "lowerarm_" + s, "elbow_flex")):
                # the joint's own bend: the lower bone's swing about its hinge, signed
                D = (P[up] @ r.Linv[up] @ r.L[lo])[:3, :3].T @ P[lo][:3, :3]
                yb = D[:, 1]
                ang = math.degrees(math.acos(max(-1, min(1, yb[1]))))
                out[f"{key}_{s}"] = ang * (-1 if (-yb[2]) >= -1e-6 else 1)
            v = B2W.T @ (Rd("pelvis").T @ _unit(P["thigh_" + s][:3, 1]))  # body axes: x right, y forward, z up
            out[f"hip_flex_{s}"] = math.degrees(math.atan2(v[1], -v[2]))
            out[f"hip_abd_{s}"] = math.degrees(math.asin(max(-1, min(1, v[0] if s == "r" else -v[0]))))
            out[f"wrist_bend_{s}"] = math.degrees(math.acos(max(-1, min(1, np.dot(_unit(P["hand_" + s][:3, 1]), _unit(P["lowerarm_" + s][:3, 1]))))))
            rest = math.degrees(math.acos(max(-1, min(1, np.dot(_unit(r.L["calf_" + s][:3, 1]), _unit(r.L["foot_" + s][:3, 1]))))))
            now = math.degrees(math.acos(max(-1, min(1, np.dot(_unit(P["calf_" + s][:3, 1]), _unit(P["foot_" + s][:3, 1]))))))
            out[f"ankle_dorsi_{s}"] = rest - now
        out["spine_twist"], out["spine_flex"], out["spine_side"] = _ypr(Rd("pelvis").T @ Rd("spine_03"))
        y, p, _ = _ypr(Rd("spine_03").T @ Rd("Head"))
        out["neck_turn"], out["neck_flex"] = y, p
        return out

    def contacts(self, pts, floor):
        """Per foot: the frames it is planted (low and slow), as runs of three frames or more."""
        n, fps = len(pts), self.fps
        out = {}
        for s in "lr":
            low = [min(p["heel_" + s][2] - self.rest_z["heel"], p["ball_" + s][2] - self.rest_z["ball"], p["toe_" + s][2] - self.rest_z["toe"]) < floor + CONTACT_Z for p in pts]
            fp = np.array([p["ball_" + s] for p in pts])
            fv = np.linalg.norm(np.gradient(fp[:, :2], axis=0), axis=1) * fps if n > 1 else np.zeros(n)
            out[s] = [(k, j) for k, j in _runs([bool(lw and v < CONTACT_V) for lw, v in zip(low, fv)]) if j - k + 1 >= 3]
        return out

    def floor_of(self, pts):
        cand = np.array([[p["heel_" + s][2] - self.rest_z["heel"] for s in "lr"] + [p["ball_" + s][2] - self.rest_z["ball"] for s in "lr"] for p in pts])
        return float(np.percentile(cand.min(1), 3))

    def strikes(self, Ps, pts, floor, skip=()):
        """Speed peaks of what strikes: a held prop's tip, else the free hands and the feet while
        they are held out from the body. Each with its frame, its window (the frames it is moving
        at half its threshold or more) and its speed."""
        n, fps, h = len(Ps), self.fps, self.body.height
        prop = self.body.prop
        sources = (["tip"] if prop is not None else []) + [k for k in ("hand_l", "hand_r", "ball_l", "ball_r")
                                                             if k not in skip and not (prop is not None and k == "hand_" + prop["side"])]
        found = []
        for key in sources:
            x = np.array([p[key] for p in pts])
            v = np.gradient(x, axis=0) * fps if n > 1 else np.zeros_like(x)
            sp = np.linalg.norm(v, axis=1)
            least = PROP_STRIKE if key == "tip" else LIMB_STRIKE * h / 1.8
            peaks = []
            for i in range(1, n - 1):
                if sp[i] >= least and sp[i] >= sp[i - 1] and sp[i] >= sp[i + 1]:
                    if key != "tip":
                        pel = pts[i]["pelvis"]
                        if math.hypot(*(x[i] - pel)[:2]) < 0.3 * h:  # a swing under the body is a step, not a strike
                            continue
                    if peaks and i - peaks[-1] < 5:
                        if sp[i] > sp[peaks[-1]]:
                            peaks[-1] = i
                        continue
                    peaks.append(i)
            for i in peaks:
                k0, k1 = i, i
                while k0 > 0 and sp[k0 - 1] > least * 0.5:
                    k0 -= 1
                while k1 < n - 1 and sp[k1 + 1] > least * 0.5:
                    k1 += 1
                hit = {"frame": i, "by": "prop" if key == "tip" else key.replace("ball_", "foot_"), "speed": round(float(sp[i]), 1),
                       "height": round(float(x[i][2] - floor), 2), "window": [k0, k1]}
                if key == "tip":
                    Hm = Ps[i]["hand_" + prop["side"]][:3, :3]
                    blade = Hm @ prop["axis"]
                    vp = v[i] - np.dot(v[i], blade) * blade
                    if prop["edged"]:
                        hit["edgeLeads"] = round(abs(float(np.dot(_unit(Hm @ prop["edge"]), _unit(vp)))) if np.linalg.norm(vp) > 1e-6 else 0.0, 2)
                    az = [math.atan2(*(x[q] - Ps[q]["pelvis"][:3, 3])[1::-1]) for q in range(k0, k1 + 1)]
                    hit["sweepDeg"] = round(math.degrees(float(np.abs(np.diff(np.unwrap(az))).sum())) if len(az) > 1 else 0.0)
                found.append(hit)
        return sorted(found, key=lambda s: s["frame"])

    def run(self, Ps, skin_fn=None, stand=None):
        fps, n = self.fps, len(Ps)
        pts = [self.points(P) for P in Ps]
        res = {"frames": n, "seconds": round((n - 1) / fps, 3)}
        floor = self.floor_of(pts)
        res["floor"] = round(floor, 3)
        planted = self.contacts(pts, floor)
        stances = []
        for s in "lr":
            for k, j in planted[s]:
                slide = 0.0
                for key in ("ball_", "heel_"):
                    down = [pts[q][key + s][2] - self.rest_z[key[:-1]] < floor + CONTACT_Z for q in range(k, j + 1)]
                    path = sum(float(np.linalg.norm(pts[q][key + s][:2] - pts[q - 1][key + s][:2]))
                               for q in range(k + 1, j + 1) if down[q - k] and down[q - k - 1])  # only between two grounded frames
                    slide = max(slide, path)
                stances.append({"foot": s, "from": k, "to": j, "slideMm": round(slide * 1000, 1)})
        res["stances"] = sorted(stances, key=lambda st: st["from"])
        sl = [st["slideMm"] for st in stances]
        res["footSlide"] = {"stances": len(sl), "meanMm": round(float(np.mean(sl)), 1) if sl else None,
                            "maxMm": round(float(np.max(sl)), 1) if sl else None, "over20mm": int(sum(1 for v in sl if v > 20))}
        coms = np.array([self.com(P) for P in Ps])
        vel = np.gradient(coms, axis=0) * fps if n > 1 else np.zeros_like(coms)
        out_static, out_dyn, support = [], [], []
        for i, p in enumerate(pts):
            sup = [p[key + s][:2] for s in "lr" for key in ("heel_", "ball_", "toe_") if p[key + s][2] - self.rest_z[key[:-1]] < floor + CONTACT_Z]
            if not sup:
                support.append([])
                out_static.append(None)
                out_dyn.append(None)
                continue
            hull = _hull(np.array(sup))
            support.append(hull.tolist())
            w0 = math.sqrt(G / max(0.3, coms[i][2] - floor))
            out_static.append(_outside(coms[i][:2], hull))
            out_dyn.append(_outside(coms[i][:2] + vel[i][:2] / w0, hull))  # Hof's extrapolated centre of mass
        dyn = [d for d in out_dyn if d is not None]
        sta = [d for d in out_static if d is not None]
        res["balance"] = {"groundedFrames": len(dyn), "airborneFrames": n - len(dyn),
                          "xcomOutsidePct": round(100 * sum(d > 0.05 for d in dyn) / max(1, len(dyn)), 1),
                          "comOutsidePct": round(100 * sum(d > 0.05 for d in sta) / max(1, len(sta)), 1),
                          "xcomWorstCm": round(100 * max(dyn), 1) if dyn else None}
        angs = [self.angles(P) for P in Ps]
        viol = {}
        for key in angs[0]:
            lo, hi = ROM[key[:-2] if key.endswith(("_l", "_r")) else key]
            vals = np.array([a[key] for a in angs])
            over = np.maximum(vals - hi, lo - vals)
            if (over > 0).any():
                viol[key] = {"frames": int((over > 0).sum()), "worstDeg": round(float(over.max()), 1), "worstFrame": int(np.argmax(over)),
                             "range": [round(float(vals.min()), 1), round(float(vals.max()), 1)]}
        res["jointLimits"] = {"framesOver": int(sum(v["frames"] for v in viol.values())),
                              "worstDeg": round(max([v["worstDeg"] for v in viol.values()], default=0.0), 1), "violations": viol}
        curves, smooth = {}, {}
        T = (n - 1) / fps
        for key in TRACKED + (("tip",) if "tip" in pts[0] else ()):
            x = np.array([p[key] for p in pts])
            v = np.gradient(x, axis=0) * fps if n > 2 else np.zeros_like(x)
            a = np.gradient(v, axis=0) * fps if n > 2 else np.zeros_like(x)
            j = np.gradient(a, axis=0) * fps if n > 2 else np.zeros_like(x)
            sp, jm = np.linalg.norm(v, axis=1), np.linalg.norm(j, axis=1)
            vpk = float(sp.max())
            ldlj = round(-math.log(max(1e-12, T ** 3 / vpk ** 2 * float((jm ** 2).sum() / fps))), 2) if vpk > 0.05 and T > 0 else None
            med = float(np.median(jm)) + 1e-6
            smooth[key] = {"peakSpeed": round(vpk, 2), "ldlj": ldlj, "jerkSpikes": int(((jm > 6 * med) & (jm > 400)).sum())}
            curves[key] = {"speed": sp.tolist(), "jerk": jm.tolist()}
        res["smoothness"] = {"jerkSpikes": int(sum(v["jerkSpikes"] for v in smooth.values())), "points": smooth}
        if stand is not None:
            L = self.rig.L["pelvis"][:3, :3]
            keys = ("pelvis", "spine_03", "Head", "hand_l", "hand_r", "lowerarm_l", "lowerarm_r", "calf_l", "calf_r", "foot_l", "foot_r")

            def pose_cm(P):
                # in the pelvis's ground frame: where it stands and which way it faces removed
                f = (P["pelvis"][:3, :3] @ L.T) @ np.array([0, -1.0, 0])
                yaw = math.atan2(f[0], -f[1])
                c, s_ = math.cos(-yaw), math.sin(-yaw)
                Rz = np.array([[c, -s_, 0], [s_, c, 0], [0, 0, 1.0]])
                pel = P["pelvis"][:3, 3]
                return np.array([Rz @ (P[k][:3, 3] - np.array([pel[0], pel[1], 0.0])) for k in keys])

            g = pose_cm(stand)
            res["seam"] = {"startCm": round(100 * float(np.linalg.norm(pose_cm(Ps[0]) - g, axis=1).mean()), 1),
                           "endCm": round(100 * float(np.linalg.norm(pose_cm(Ps[-1]) - g, axis=1).mean()), 1)}
        res["strikes"] = self.strikes(Ps, pts, floor)
        res["belowFloor"] = sum(1 for P in Ps for nme in ("hand_l", "hand_r", "Head", "calf_l", "calf_r", "pelvis") if P[nme][2, 3] - floor < 0.03)
        pel = np.array([P["pelvis"][:3, 3] for P in Ps])
        res["root"] = {"travelM": round(float(np.linalg.norm(pel[-1, :2] - pel[0, :2])), 2)}
        if skin_fn is not None:
            limbs, props = skin_fn()
            res["throughBody"] = {"limbMeanMm2": round(float(np.mean(limbs)), 0), "limbMaxMm2": round(float(np.max(limbs)), 0)}
            if self.body.prop is not None:
                res["throughBody"].update({"propMeanMm2": round(float(np.mean(props)), 0), "propMaxMm2": round(float(np.max(props)), 0)})
            curves["skin"] = {"limb": limbs, "prop": props}
        curves["com"] = coms.tolist()
        curves["xcomOut"] = out_dyn
        curves["support"] = support
        curves["planted"] = {s: planted[s] for s in "lr"}
        curves["track"] = {k: [p[k].tolist() for p in pts] for k in pts[0]}
        curves["angles"] = {k: [a[k] for a in angs] for k in angs[0]}
        return res, curves


class LimbSkin:
    """contact.Skin with a held prop split out: the arms (without the prop) through the body, and
    the prop through the body, mm² per frame, less what crosses at rest."""

    def __init__(self, arm, body):
        meshes = [o for o in body.meshes if any(m.type == "ARMATURE" and m.object == arm for m in o.modifiers)]
        prop_objects = set(body.prop["objects"]) if body.prop is not None else set()
        parented = [o for o in body.meshes if o.name in prop_objects and o not in meshes]
        sk = self.skin = contact.Skin(arm, meshes + parented)
        # which corners are the prop's: a parented prop's whole mesh, or a skinned body's vertices
        # rigid to the hand beyond its fingers
        flags = []
        for o in meshes + parented:
            f = np.zeros(len(o.data.vertices), bool)
            if o in parented:
                f[:] = True
            elif o.name in prop_objects and body.prop is not None:
                hand = "hand_" + body.prop["side"]
                gi = {g.index for g in o.vertex_groups if g.name == hand}
                hh = np.array(arm.data.bones[hand].head_local)
                reach = 0.15 * body.height / 1.8
                for v in o.data.vertices:
                    if sum(g.weight for g in v.groups if g.group in gi) >= 0.98 and np.linalg.norm(np.array(v.co) - hh) > reach:
                        f[v.index] = True
            flags.append(f)
        flags = np.concatenate(flags) if flags else np.zeros(0, bool)
        tri_prop = flags[sk.tris].any(1) if len(flags) else np.zeros(len(sk.tris), bool)
        self.prop_idx = np.where(tri_prop)[0]
        self.arm_only = np.array([i for i in sk.arm_idx if not tri_prop[i]], np.int64)
        self.body_only = np.array([i for i in sk.body_idx if not tri_prop[i]], np.int64)
        self.arm_all, self.body_all = sk.arm_idx, sk.body_idx
        rest = sk.coords()
        self.rest_arm = self._against(rest, self.arm_only)
        self.rest_prop = self._against(rest, self.prop_idx)

    def _against(self, co, idx):
        sk = self.skin
        sk.arm_idx, sk.body_idx = idx, self.body_only
        try:
            return sk.arm_body(co) if len(idx) else set()
        finally:
            sk.arm_idx, sk.body_idx = self.arm_all, self.body_all

    def now(self):
        co = self.skin.coords()
        return self.skin.mm2(self._against(co, self.arm_only) - self.rest_arm), self.skin.mm2(self._against(co, self.prop_idx) - self.rest_prop)
