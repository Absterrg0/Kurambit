"""fit(): library clips fitted to the body they play on (game_blender_character's fit).

Adapted from blender-kiln's plugin/tools/retarget.py (MIT, Copyright (c) 2026 Nicolas Dolphens),
whose arm clearance adapts scripts/arm_clearance.py of image-to-3dlab (AssetFurnace) v0.4.4,
Copyright 2026 Bingeljell and image-to-3dlab contributors, https://github.com/Bingeljell/image-to-3dlab,
licensed under the Apache License, Version 2.0 (see ../THIRD-PARTY-NOTICES.md).

Changed here: the bones are the standard skeleton's (UE names) instead of SOMA roles; a capsule
runs from a joint to the joint its bone points at; the frames are read from and written back to
a Blender action (each bone's rotation, the pelvis' location) on the conformed armature; calm
takes one strength c (0..1) that scales kiln's factors, c = 1 being kiln's; the soft reach is a
two-bone solve that puts each ankle back where the clip had it after calm moved the hips, and
lowers the hips by what it cannot reach, instead of kiln's foot lock. Kept: the 95th-percentile
capsules, the 25 degree cap on the swing, its smoothing, calm's factors and the soft reach curve.

The rest frames never change: only keys do, so restDeviation is untouched and every clip stays
on the standard skeleton."""
import math

import bpy
import numpy as np
from mathutils import Matrix

from . import helpers, skeleton

# ---- arm clearance ---------------------------------------------------------------------------
# Kiln: capsules round the hips, torso, neck, head and shoulders, each as thick as the skin it
# carries (95th percentile), the arm's points at 80% of the upper arm, the elbow, mid forearm and
# the hand. The swing is capped at 25 degrees: uncapped, a round belly swung kiln's child's arms
# 61-78 degrees out, back to its A-pose. The thighs stay out: their outline held arms out like wings.
MAX_SWING_DEG = 25.0
ARM_PERCENTILE = 60
BODY_PERCENTILE = 95
HEAD_TO_TORSO = 1.1
UPPER_ARM_POINTS = (0.8,)
TORSO = ("spine_01", "spine_02", "spine_03", "spine_04", "spine_05")
BODY = ("pelvis",) + TORSO + ("neck_01", "neck_02", "Head", "clavicle_l", "clavicle_r")

# ---- calm ------------------------------------------------------------------------------------
# Kiln's factors at full strength: hips roll x0.25, yaw x0.4, side sway x0.5; spine and neck
# turns x0.4; head roll and yaw x0.25, pitch x0.7. The head is calmed with the hips: calming the
# hips alone made kiln's chibi's head roll 12.2 degrees instead of 4.3, the spine had compensated.
CALM = dict(roll=0.75, yaw=0.6, sway=0.5, spine=0.6, head=0.75, head_pitch=0.3)
CALM_CHAIN = TORSO + ("neck_01", "neck_02")

# Past SOFT_REACH of its length a leg's reach eases toward REACH instead of stopping dead: clamped
# hard, a foot a little too far pulls the knee straight on one frame and bends it on the next.
REACH = 0.9995
SOFT_REACH = 0.93
# Calm splits a turn into yaw, pitch and roll about the upright body; once the hips or head pitch
# further than this (a fall, a roll) the split is meaningless: on the cat's Death01 calming it
# rolled the head 30.8 degrees instead of 11.9. Such a clip is left as it is.
UPRIGHT_DEG = 45.0


# ---- rotations (pure numpy, as kiln) ----------------------------------------------------------

def _rotation_between(a, b):
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    v, c = np.cross(a, b), float(a @ b)
    if c > 1 - 1e-12:
        return np.eye(3)
    if c < -1 + 1e-9:
        perp = np.cross(a, [1.0, 0, 0]) if abs(a[0]) < 0.9 else np.cross(a, [0, 1.0, 0])
        perp /= np.linalg.norm(perp)
        return 2 * np.outer(perp, perp) - np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx / (1 + c)


def _log_rot(r):
    angle = math.acos(max(-1.0, min(1.0, (np.trace(r) - 1) / 2)))
    if angle < 1e-9:
        return np.zeros(3)
    if angle > math.pi - 1e-6:
        q = Matrix(r.tolist()).to_quaternion()
        v = np.array(q.axis)
        return v / np.linalg.norm(v) * angle
    w = np.array([r[2, 1] - r[1, 2], r[0, 2] - r[2, 0], r[1, 0] - r[0, 1]])
    return w / (2 * math.sin(angle)) * angle


def _exp_rot(v):
    angle = float(np.linalg.norm(v))
    if angle < 1e-12:
        return np.eye(3)
    k = v / angle
    kx = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + math.sin(angle) * kx + (1 - math.cos(angle)) * kx @ kx


def _ypr(r):
    """(yaw, pitch, roll) of r = Ry(yaw) Rx(pitch) Rz(roll), in the character frame (left, up, forward)."""
    return (math.atan2(r[0, 2], r[2, 2]), math.asin(max(-1.0, min(1.0, -r[1, 2]))), math.atan2(r[1, 0], r[1, 1]))


def _from_ypr(yaw, pitch, roll):
    cy, sy, cp, sp, cr, sr = math.cos(yaw), math.sin(yaw), math.cos(pitch), math.sin(pitch), math.cos(roll), math.sin(roll)
    ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    rz = np.array([[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]])
    return ry @ rx @ rz


def _point_segment(p, a, b):
    axis = b - a
    l2 = float(axis @ axis)
    t = 0.0 if l2 == 0 else min(1.0, max(0.0, float((p - a) @ axis) / l2))
    c = a + t * axis
    return float(np.linalg.norm(p - c)), c


def _sideways(direction, along):
    u = along / np.linalg.norm(along)
    side = direction - (direction @ u) * u
    n = float(np.linalg.norm(side))
    return side / n if n > 1e-6 else np.zeros(3)


# ---- the rig, in armature space ----------------------------------------------------------------

class Rig:
    """What the maths needs: rest matrices, parents, where each bone points, up, and the skin."""

    def __init__(self, arm, meshes):
        bones = arm.data.bones
        self.arm = arm
        self.names = [b.name for b in bones]
        self.parents = {b.name: (b.parent.name if b.parent is not None else None) for b in bones}
        self.order = []
        todo = [b.name for b in bones if b.parent is None]
        while todo:
            n = todo.pop(0)
            self.order.append(n)
            todo += [c.name for c in bones[n].children]
        self.rest = {b.name: np.array(b.matrix_local) for b in bones}
        self.rel = {n: m if self.parents[n] is None else np.linalg.inv(self.rest[self.parents[n]]) @ m for n, m in self.rest.items()}
        self.heads = {n: m[:3, 3].copy() for n, m in self.rest.items()}
        # A capsule runs to the joint a bone points at (a hand at its middle finger), else its tail.
        self.tips = {}
        for b in bones:
            child = skeleton._child_joint(bones, b.name, lambda k: True)
            self.tips[b.name] = np.array(bones[child].head_local) if child is not None else np.array(b.tail_local)
        inv = arm.matrix_world.inverted()
        up = np.array(inv.to_3x3() @ Matrix.Identity(3).col[2])
        self.up = up / np.linalg.norm(up)
        points, owners = [], []
        for o in meshes:
            co, _ = helpers.rest_coords(o)
            if len(co) != len(o.data.vertices):
                continue
            names = {g.index: g.name for g in o.vertex_groups}
            m = np.array(inv)
            points.append(co @ m[:3, :3].T + m[:3, 3])
            for v in o.data.vertices:
                best = max(v.groups, key=lambda g: g.weight, default=None)
                owners.append(names.get(best.group, "") if best is not None else "")
        self.points = np.concatenate(points) if points else np.zeros((0, 3))
        self.owners = np.array(owners)
        heights = [h @ self.up for h in self.heads.values()]
        self.height = max(heights) - min(heights)
        votes = [self.heads[f"ball_{s}"] - self.heads[f"foot_{s}"] for s in "lr" if f"ball_{s}" in self.heads]
        f = np.mean(votes, axis=0) if votes else -np.array(inv.to_3x3() @ Matrix.Identity(3).col[1])
        f = f - (f @ self.up) * self.up
        f /= np.linalg.norm(f)
        self.axes = np.stack([np.cross(self.up, f), self.up, f], axis=1)  # (left, up, forward)

    def has(self, *names):
        return all(n in self.rest for n in names)


def _read(rig, action, frames):
    """[(world rotation {bone: 3x3}, positions {bone: xyz})] of each frame, in armature space."""
    arm, scene = rig.arm, bpy.context.scene
    skeleton.assign_action(arm, action)
    out = []
    for f in frames:
        scene.frame_set(f)
        pose = {pb.name: np.array(pb.matrix) for pb in arm.pose.bones}
        out.append(({n: m[:3, :3].copy() for n, m in pose.items()}, {n: m[:3, 3].copy() for n, m in pose.items()}))
    return out


def _posed(rig, wr, pelvis_at, root_at):
    """(pose 4x4, basis 4x4) per bone for one frame: Blender's pose_b = pose_parent @
    inv(rest_parent) @ rest_b @ basis_b, with every bone at its world rotation, the pelvis where
    pelvis_at says (its keyed location), and every other bone where its parent puts it."""
    pose, basis = {}, {}
    for b in rig.order:
        p = rig.parents[b]
        unposed = rig.rel[b] if p is None else pose[p] @ rig.rel[b]
        target = np.eye(4)
        target[:3, :3] = wr[b]
        target[:3, 3] = root_at if p is None else (pelvis_at if b == "pelvis" else unposed[:3, 3])
        pose[b] = target
        basis[b] = np.linalg.inv(unposed) @ target
    return pose, basis


# ---- arms ----------------------------------------------------------------------------------------

def _radii(rig, bones, percentile):
    out = {}
    for b in bones:
        mine = rig.points[rig.owners == b]
        if len(mine):
            a, t = rig.heads[b], rig.tips[b]
            out[b] = float(np.percentile([_point_segment(p, a, t)[0] for p in mine], percentile))
    return out


def _proxy(rig):
    arms = {}
    for s in "lr":
        bones = [f"upperarm_{s}", f"lowerarm_{s}", f"hand_{s}"]
        if rig.has(*bones):
            r = _radii(rig, bones, ARM_PERCENTILE)
            arms[s] = {"bones": bones, "radius": [r.get(b, 0.0) for b in bones]}
    body = _radii(rig, [b for b in BODY if b in rig.rest], BODY_PERCENTILE)
    torso = max((r for b, r in body.items() if b in TORSO), default=None)
    if torso is not None and "Head" in body:
        body["Head"] = min(body["Head"], torso * HEAD_TO_TORSO)
    return {"arms": arms, "body": body, "margin": 0.01 * rig.height} if arms and body else None


def _segment(pose, rig, b):
    moved = pose[b] @ np.linalg.inv(rig.rest[b])
    return pose[b][:3, 3], (moved @ np.append(rig.tips[b], 1.0))[:3]


def _arm_swing(rig, pose, proxy, s, iterations=10):
    """The rotation about the shoulder taking one arm's points out of every capsule, capped."""
    upper, fore, hand = proxy["arms"][s]["bones"]
    ru, rf, rh = proxy["arms"][s]["radius"]
    pivot = pose[upper][:3, 3]
    caps = [(*_segment(pose, rig, b), r) for b, r in proxy["body"].items() if b != f"clavicle_{s}"]
    fa, fb = _segment(pose, rig, fore)
    ha, hb = _segment(pose, rig, hand)
    points = [(pivot + u * (fa - pivot), ru) for u in UPPER_ARM_POINTS]
    points += [(fa, rf), ((fa + fb) / 2, rf), (ha, rh), (hb, rh)]
    total = np.eye(3)
    for _ in range(iterations):
        worst, push = 0.0, None
        for p, ra in points:
            for a, b, rb in caps:
                d, closest = _point_segment(p, a, b)
                depth = rb + ra + proxy["margin"] - d
                if depth > worst and d > 1e-9:
                    away = _sideways(p - closest, p - pivot)
                    if not away.any():
                        away = _sideways(pivot - _point_segment(pivot, a, b)[1], p - pivot)
                    if not away.any():
                        away = _sideways(np.cross(b - a, p - pivot), p - pivot)
                    if away.any():
                        worst, push = depth, (p, away)
        if push is None:
            break
        p, normal = push
        step = _rotation_between(p - pivot, p + normal * worst - pivot)
        total = step @ total
        points = [(pivot + step @ (q - pivot), rr) for q, rr in points]
    v = _log_rot(total)
    ang = float(np.linalg.norm(v))
    if ang > math.radians(MAX_SWING_DEG):
        total = _exp_rot(v * math.radians(MAX_SWING_DEG) / ang)
    return total


def _smooth(swings, cyclic, radius=4):
    """Each frame's swing spread over its neighbours, never below the raw swing."""
    v = np.array([_log_rot(s) for s in swings])
    n = len(v)
    w = np.exp(-0.5 * (np.arange(-radius, radius + 1) / max(radius / 2, 1)) ** 2)
    out = []
    for t in range(n):
        if cyclic:
            ids, ww = [(t + k) % n for k in range(-radius, radius + 1)], w
        else:
            lo, hi = max(0, t - radius), min(n, t + radius + 1)
            ids, ww = list(range(lo, hi)), w[lo - t + radius:hi - t + radius]
        blended = (v[ids] * ww[:, None]).sum(0) / ww.sum()
        out.append(_exp_rot(blended if np.linalg.norm(blended) >= np.linalg.norm(v[t]) else v[t]))
    return out


def _subtree(rig, root):
    out, stack = [], [root]
    while stack:
        b = stack.pop()
        out.append(b)
        stack.extend(c for c, p in rig.parents.items() if p == b)
    return out


def clear_arms(rig, frames, proxy, cyclic):
    """Swings each arm out of the body wherever it went in. Returns the largest and median swing (deg)."""
    swings = {s: [] for s in proxy["arms"]}
    for wr, pos in frames:
        pose, _ = _posed(rig, wr, pos["pelvis"], pos[rig.order[0]])
        for s in swings:
            swings[s].append(_arm_swing(rig, pose, proxy, s))
    deg = []
    for s, sw in swings.items():
        deg += [math.degrees(np.linalg.norm(_log_rot(r))) for r in sw]
        arm = _subtree(rig, proxy["arms"][s]["bones"][0])
        for (wr, _), swing in zip(frames, _smooth(sw, cyclic)):
            for b in arm:
                wr[b] = swing @ wr[b]
    return (max(deg), float(np.median(deg))) if deg else (0.0, 0.0)


# ---- calm and the legs -------------------------------------------------------------------------

def upright(rig, frames):
    """Whether the hips and head stay within UPRIGHT_DEG of their rest pitch throughout."""
    axes = rig.axes
    for b in ("pelvis", "Head"):
        if b in rig.rest:
            for wr, _ in frames:
                if abs(math.degrees(_ypr(axes.T @ wr[b] @ rig.rest[b][:3, :3].T @ axes)[1])) > UPRIGHT_DEG:
                    return False
    return True


def calm(rig, frames, c):
    """Scales the pelvis' roll, yaw and side sway, the spine's and neck's own turns and the head's
    turns in the world by strength c; every other bone keeps its world rotation. In place."""
    k = {name: 1 - f * c for name, f in CALM.items()}
    axes, left = rig.axes, rig.axes[:, 0]

    def scaled(world, b, ky, kp, kr):
        y, p, r = _ypr(axes.T @ world @ rig.rest[b][:3, :3].T @ axes)
        return axes @ _from_ypr(y * ky, p * kp, r * kr) @ axes.T @ rig.rest[b][:3, :3]

    side0 = float(np.mean([pos["pelvis"] @ left for _, pos in frames]))
    chain = [b for b in rig.order if b in CALM_CHAIN]
    for wr, pos in frames:
        old = dict(wr)
        wr["pelvis"] = scaled(old["pelvis"], "pelvis", k["yaw"], 1.0, k["roll"])
        pos["pelvis"] = pos["pelvis"] - ((pos["pelvis"] @ left) - side0) * (1 - k["sway"]) * left
        for b in chain:
            p = rig.parents[b]
            q0 = rig.rest[p][:3, :3].T @ rig.rest[b][:3, :3]
            delta = (old[p].T @ old[b]) @ q0.T
            wr[b] = wr[p] @ _exp_rot(_log_rot(delta) * k["spine"]) @ q0
        if "Head" in wr:
            wr["Head"] = scaled(old["Head"], "Head", k["head"], k["head_pitch"], k["head"])


def _two_bone(H, K0, A0, A, L1, L2):
    """Knee and the ankle reached for a leg H -> knee -> ankle reaching for A, bending in the plane
    the knee bent in; past SOFT_REACH of the leg's length the reach eases toward REACH."""
    d_vec = A - H
    d = float(np.linalg.norm(d_vec))
    u = d_vec / max(d, 1e-9)
    d = max(d, abs(L1 - L2) + 1e-6)
    soft, hard = SOFT_REACH * (L1 + L2), REACH * (L1 + L2)
    if d > soft:
        d = soft + (hard - soft) * (1 - math.exp(-(d - soft) / (hard - soft)))
    p = (K0 - H) - ((K0 - H) @ u) * u
    if np.linalg.norm(p) < 1e-6:
        p = np.cross(u, [1.0, 0, 0])
    p /= np.linalg.norm(p)
    a = (L1 * L1 - L2 * L2 + d * d) / (2 * d)
    h = math.sqrt(max(L1 * L1 - a * a, 0.0))
    return H + a * u + h * p, H + d * u


def place_feet(rig, frames, ankles, iterations=3):
    """Puts each ankle back where the clip had it (ankles: per frame {side: xyz}) by turning the
    thigh and shin, the foot keeping its world rotation, with the soft reach; what the legs cannot
    reach lowers the hips. In place. Returns the largest drop (m)."""
    sides = [s for s in "lr" if rig.has(f"thigh_{s}", f"calf_{s}", f"foot_{s}")]
    L = {s: (np.linalg.norm(rig.heads[f"calf_{s}"] - rig.heads[f"thigh_{s}"]),
             np.linalg.norm(rig.heads[f"foot_{s}"] - rig.heads[f"calf_{s}"])) for s in sides}
    root = rig.order[0]
    deepest = 0.0
    for (wr, pos), want in zip(frames, ankles):
        drop = 0.0
        for _ in range(iterations):
            gaps = []
            for s in sides:
                pose, _ = _posed(rig, wr, pos["pelvis"], pos[root])
                H, K0, A0 = (pose[f"{b}_{s}"][:3, 3] for b in ("thigh", "calf", "foot"))
                K, reached = _two_bone(H, K0, A0, want[s], *L[s])
                wr[f"thigh_{s}"] = _rotation_between(K0 - H, K - H) @ wr[f"thigh_{s}"]
                wr[f"calf_{s}"] = _rotation_between(A0 - K0, reached - K) @ wr[f"calf_{s}"]
                gaps.append(float(np.linalg.norm(want[s] - reached)))
            gap = max(gaps, default=0.0)
            if gap < 1e-4:
                break
            pos["pelvis"] = pos["pelvis"] - rig.up * gap
            drop += gap
        deepest = max(deepest, drop)
    return deepest


# ---- writing the keys --------------------------------------------------------------------------

def _write(rig, action, frames_at, frames):
    """Replaces the action's rotation keys (and the pelvis' location) with one key per frame."""
    fcs = skeleton.action_fcurves(action)
    keyed = set()
    for fc in list(fcs):
        path = fc.data_path
        bone = path.split('"')[1] if '"' in path else ""
        if path.endswith((".rotation_quaternion", ".rotation_euler", ".rotation_axis_angle")) or path == f'pose.bones["pelvis"].location':
            keyed.add(bone)
            fcs.remove(fc)
    keyed.add("pelvis")
    rots = {b: [] for b in rig.order}
    locs = []
    root = rig.order[0]
    for wr, pos in frames:
        _, basis = _posed(rig, wr, pos["pelvis"], pos[root])
        for b in rig.order:
            q = Matrix(basis[b][:3, :3].tolist()).to_quaternion()
            prev = rots[b][-1] if rots[b] else None
            if prev is not None and q.dot(prev) < 0:
                q.negate()
            rots[b].append(q)
        locs.append(basis["pelvis"][:3, 3].copy())
    for b in rig.order:
        if b not in keyed and all(abs(q.angle) < 1e-5 for q in rots[b]):
            continue
        rig.arm.pose.bones[b].rotation_mode = "QUATERNION"
        for i in range(4):
            _keys(fcs.new(f'pose.bones["{b}"].rotation_quaternion', index=i), frames_at, [q[i] for q in rots[b]])
    for i in range(3):
        _keys(fcs.new('pose.bones["pelvis"].location', index=i), frames_at, [float(v[i]) for v in locs])


def _keys(fc, at, values):
    fc.keyframe_points.add(len(at))
    co = np.empty(2 * len(at))
    co[0::2], co[1::2] = at, values
    fc.keyframe_points.foreach_set("co", co)
    for k in fc.keyframe_points:
        k.interpolation = "LINEAR"
    fc.update()


def fit(arm, meshes, actions, params):
    """Applies params {arms?, calm?} to each action (library clips on this body). Returns notes."""
    arms, c = bool(params.get("arms")), float(params.get("calm") or 0.0)
    if not arms and c <= 0:
        return []
    rig = Rig(arm, meshes)
    proxy = _proxy(rig) if arms else None
    keep = bpy.context.scene.frame_current
    notes, swings, calmed, tumbling = [], [], None, []
    for act in actions:
        f0, f1 = (int(round(x)) for x in act.frame_range)
        at = list(range(f0, f1 + 1))
        frames = _read(rig, act, at)
        # A loop's last frame repeats its first: fit the cycle without it and repeat it again.
        cyclic = "loop" in act.name.lower() and len(at) > 2
        work = frames[:-1] if cyclic else frames
        if c > 0 and not upright(rig, work):
            tumbling.append(act.get("kurambit_clip", act.name))
        elif c > 0:
            ankles = [{s: pose_at[f"foot_{s}"].copy() for s in "lr" if f"foot_{s}" in pose_at} for _, pose_at in work]
            before = _sway_roll(rig, work)
            calm(rig, work, c)
            drop = place_feet(rig, work, ankles)
            if calmed is None or "walk" in act.name.lower():
                calmed = (act.get("kurambit_clip", act.name), before, _sway_roll(rig, work), drop)
        if proxy is not None:
            swings.append(clear_arms(rig, work, proxy, cyclic))
        if cyclic:
            work.append(work[0])
        _write(rig, act, at, work)
    skeleton.assign_action(arm, None)
    for pb in arm.pose.bones:
        pb.matrix_basis = Matrix()
    bpy.context.scene.frame_set(keep)
    if swings:
        notes.append(f"fit arms: swung out of the body up to {max(s[0] for s in swings):.1f}° (median {float(np.median([s[1] for s in swings])):.1f}°, cap {MAX_SWING_DEG:.0f}°)")
    if calmed is not None:
        name, b, a, drop = calmed
        notes.append(f"fit calm {c:g} on {name}: hips roll {b[0]:.1f}→{a[0]:.1f}°, yaw {b[1]:.1f}→{a[1]:.1f}°, sway {b[2]:.0f}→{a[2]:.0f} mm, head roll {b[3]:.1f}→{a[3]:.1f}°; feet kept, hips lowered up to {drop * 1000:.0f} mm")
    if tumbling:
        notes.append(f"fit calm left {', '.join(tumbling)} as they are: the body pitches over more than {UPRIGHT_DEG:.0f}°")
    return notes


def _sway_roll(rig, frames):
    """Peak-to-peak hips roll and yaw (deg), side sway (m) and head roll (deg), in the character frame."""
    axes, left = rig.axes, rig.axes[:, 0]

    def ptp(b, i):
        v = [math.degrees(_ypr(axes.T @ wr[b] @ rig.rest[b][:3, :3].T @ axes)[i]) for wr, _ in frames]
        return max(v) - min(v) if v else 0.0

    sway = [pos["pelvis"] @ left for _, pos in frames]
    return (ptp("pelvis", 2), ptp("pelvis", 0), (max(sway) - min(sway)) * 1000 if sway else 0.0,
            ptp("Head", 2) if "Head" in rig.rest else 0.0)
