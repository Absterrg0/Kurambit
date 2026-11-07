"""animate(): a move written as poses on beats, compiled onto a character on the standard skeleton,
measured, and pictured, so an agent edits the spec and never keyframes.

A spec (JSON):
  {"name": "SpinCombo", "start": "guard", "poses": {"guard": {...}}, "craft": {...},
   "beats": [{"at": 0, "pose": "guard"}, {"at": 7, "note": "wind-up", "ease": "inout", ...pose keys...}, ...]}

Body space: x is the character's right, y forward, z up, metres; yaw > 0 turns left, degrees.
Pose keys (all optional; a missing key carries over from the beat before):
  root    (x, y, yaw)            where the move is on the ground and which way it faces
  hips    {"at": (x, y, z), "turn": (yaw, pitch, roll)}   the pelvis, relative to root
  chest   (yaw, pitch, roll)     spread over the spine, relative to the hips
  head    (yaw, pitch, roll)     relative to the chest; look (x, y, z) aims it at a root-space point
  prop    {"grip": (x, y, z), "tip": (x, y, z), "edge"?: (x, y, z), "space"?: "root" | "chest", "way"?: "cw" | "ccw"}
          a held prop's grip point and the direction its tip points; the kit rolls it so the wrists
          stay comfortable and an edged prop's edge leads the swing
  hand_l, hand_r  "grip" (on the held prop's handle) or {"at": (x, y, z), "space"?: "root" | "chest", "turn"?: (yaw, pitch, roll)}
  foot_l, foot_r  {"at": (x, y, z), "yaw", "heel" (rolled onto the ball), "space"?: "ground" | "root" | "hips", "orbit"?: true}
                  ground (default) is where root is written, so a planted foot stays put while the body
                  moves; z = 0 is on the floor; hips tucks a foot in the pelvis's frame (a roll)
  elbow_l, elbow_r, knee_l, knee_r   the direction the joint points (root space)
A beat adds "at" (frame), "pose" (a named pose), "ease" (linear, in, out, inout, in2, out2),
"antic" and "over" (anticipation and overshoot, as shares of the beat's change), "pivot"
("foot_l" | "foot_r": turn on that planted foot), "lift" (a step's clearance, m) and "note".
Named poses: "stand" (this body's own rest, standing) and the spec's own "poses".
craft: {"ease", "antic", "over", "arcs", "pivot", "lock_feet", "lock_speed", "hip_drop", "clearance" (m),
        "overlap": {"chest": (hz, damping, clamp deg), "head": (...), "hand": (hz, damping)}}

The craft the kit adds: eased beats with anticipation and overshoot, arcs for a held prop, the
roll search, pivots, foot locking, hip drop where a leg cannot reach, root motion, overlap and
follow-through on springs, and the body's clearance. Root motion rides the pelvis (the root bone
stays at rest), as the library clips' travel does; the clip's rootDrift says how far it goes. Spring
chains are left unkeyed: the game springs them."""
import json
import math
import os
import time

import bpy
import numpy as np
from mathutils import Matrix

from . import helpers, measure, skeleton
from .animrig import (B2W, FINGERS, M4, Body, axis_angle, body_rot, map_pair, rest_hinge, rot_between, rz, slerp_rot,
                      swing_twist, two_bone, unit)
from .protocol import Refused, entry

_BASE = {
    "linear": lambda t: t,
    "in": lambda t: t ** 3,
    "in2": lambda t: t * t,
    "out": lambda t: 1 - (1 - t) ** 3,
    "out2": lambda t: 1 - (1 - t) ** 2,
    "inout": lambda t: t * t * (3 - 2 * t),
}
SPACES = (("prop", "grip", "root"), ("foot_l", "at", "ground"), ("foot_r", "at", "ground"), ("hand_l", "at", "root"),
          ("hand_r", "at", "root"))
CHANNELS = ("root", "hips", "chest", "head", "look", "prop", "hand_l", "hand_r", "foot_l", "foot_r", "elbow_l", "elbow_r",
            "knee_l", "knee_r")
META = ("ease", "antic", "over", "pivot", "lift", "note")
MAX_FRAMES = 600


def ease(kind, t, antic=0.0, over=0.0):
    """Eased progress through a beat. antic dips back by that share of the change in the first half,
    over runs past the goal in the second and settles on it; both are sin² bumps, zero at the ends,
    so a key pose is still hit exactly."""
    t = min(max(t, 0.0), 1.0)
    f = _BASE[kind](t)
    if antic and t < 0.5:
        f -= antic * math.sin(math.pi * t / 0.5) ** 2
    if over and t > 0.5:
        f += over * math.sin(math.pi * (t - 0.5) / 0.5) ** 2
    return f


def _merge(a, b):
    if isinstance(a, dict) and isinstance(b, dict):
        out = dict(a)
        for k, v in b.items():
            out[k] = _merge(a.get(k), v) if k in a else v
        return out
    return b


def _check(spec, library, body):
    """Refuses a spec the compiler cannot read, naming what is wrong."""
    if not isinstance(spec, dict) or not isinstance(spec.get("beats"), list) or len(spec["beats"]) < 2:
        raise Refused("invalid-input", "spec needs beats: a list of at least two {at, ...} beats")
    last = -1
    for i, b in enumerate(spec["beats"]):
        if not isinstance(b, dict) or not isinstance(b.get("at"), int):
            raise Refused("invalid-input", f"beat {i} needs at: a whole frame number")
        if b["at"] <= last:
            raise Refused("invalid-input", f"beat {i} is at frame {b['at']}, not after the beat before it (frame {last})")
        last = b["at"]
        pose = b.get("pose")
        if pose is not None and isinstance(pose, str) and pose not in library:
            raise Refused("invalid-input", f"beat {i} names pose {pose!r}; the named poses are {', '.join(sorted(library))}")
        unknown = [k for k in b if k not in CHANNELS and k not in META and k not in ("at", "pose")]
        if unknown:
            raise Refused("invalid-input", f"beat {i} has unknown keys {', '.join(unknown)}; pose keys are {', '.join(CHANNELS)} and beat keys {', '.join(META)}")
        if b.get("ease", "inout") not in _BASE:
            raise Refused("invalid-input", f"beat {i}: ease is one of {', '.join(_BASE)}")
        if body.prop is None and ("prop" in b or "grip" in (b.get("hand_l"), b.get("hand_r"))):
            raise Refused("invalid-input", f"beat {i} poses a held prop, but no hand of this character holds one: model it parented to hand_r (or skinned rigidly to it), or pose the hands with hand_l and hand_r")
    if spec["beats"][-1]["at"] - spec["beats"][0]["at"] > MAX_FRAMES:
        raise Refused("invalid-input", f"a move is at most {MAX_FRAMES} frames")


def resolve_beats(spec, library):
    beats = []
    cur = _merge(library["stand"], library.get(spec.get("start", "stand"), {}))
    for raw in spec["beats"]:
        b = dict(raw)
        pose = b.pop("pose", None)
        frame = b.pop("at")
        meta = {k: b.pop(k) for k in META if k in b}
        if pose is not None:
            cur = _merge(cur, library[pose] if isinstance(pose, str) else pose)
        # A channel given a new position without naming its space is back in its default space: a
        # merge must not keep a stale "space": "chest" from an earlier beat.
        for src in ([library[pose]] if isinstance(pose, str) else [pose] if pose else []) + [b]:
            for key, field, default in SPACES:
                v = src.get(key) if isinstance(src, dict) else None
                if isinstance(v, dict) and field in v and "space" not in v:
                    v = {**v, "space": default}
                    if src is b:
                        b[key] = v
                    else:
                        cur = _merge(cur, {key: v})
        prev_root = cur["root"]
        cur = _merge(cur, b)
        # A body-relative foot this beat does not move stays where it is on the ground, so a root
        # that moves never drags it.
        named = library[pose] if isinstance(pose, str) else (pose or {})
        for side in "lr":
            key = "foot_" + side
            if key not in raw and key not in named and cur[key].get("space") == "root":
                cur[key] = _ground_foot(cur[key], prev_root)
        beats.append({"at": frame, "pose": cur, **meta})
    return beats


# ------------------------------------------------------------------------------------- interpolation
def _cyl(p):
    return math.atan2(p[0], p[1]), math.hypot(p[0], p[1]), p[2]


def _from_cyl(a, r, z):
    return np.array([r * math.sin(a), r * math.cos(a), z])


def _angwrap(d):
    return (d + math.pi) % (2 * math.pi) - math.pi


def _sph(d):
    d = unit(d)
    return math.atan2(d[0], d[1]), math.asin(max(-1, min(1, d[2])))


def _from_sph(az, el):
    return np.array([math.cos(el) * math.sin(az), math.cos(el) * math.cos(az), math.sin(el)])


def _lerp(a, b, t):
    return np.asarray(a, float) + (np.asarray(b, float) - np.asarray(a, float)) * t


def _arc_point(a, b, t, centre):
    """A grip's arc: interpolated about the body's axis through centre, in cylindrical terms."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    c = np.array([centre[0], centre[1], 0.0])
    aa, ra, za = _cyl(a - c)
    ab, rb, zb = _cyl(b - c)
    d = _angwrap(ab - aa)
    return c + _from_cyl(aa + d * t, ra + (rb - ra) * t, za + (zb - za) * t)


def _arc_dir(a, b, t, way=None):
    aza, ela = _sph(a)
    azb, elb = _sph(b)
    d = _angwrap(azb - aza)
    if way == "cw" and d > 0:
        d -= 2 * math.pi
    if way == "ccw" and d < 0:
        d += 2 * math.pi
    if abs(ela) > 1.45 or abs(elb) > 1.45:  # near vertical: a plain blend is steadier
        m = _lerp(a, b, t)
        return unit(m) if np.linalg.norm(m) > 1e-3 else unit(b)
    return _from_sph(aza + d * t, ela + (elb - ela) * t)


def _ground_foot(f, root):
    """A root-space foot in the ground frame at that root."""
    f = dict(f)
    if f.get("space", "ground") == "root":
        R = rz(root[2])
        a = np.asarray(f["at"], float)
        f["at"] = np.array([*(R[:2, :2] @ a[:2] + np.asarray(root[:2], float)), a[2]])
        f["yaw"] = f.get("yaw", 0.0) + root[2]
        f["space"] = "ground"
    f.setdefault("space", "ground")
    f.setdefault("yaw", 0.0)
    f.setdefault("heel", 0.0)
    return f


def _brot(R_world):
    """A turn as body_rot gives it, in body axes."""
    return B2W.T @ R_world @ B2W


def _root_prop(pr, ch, body):
    """A prop written in the chest's frame, in root space at this frame."""
    if pr.get("space", "root") != "chest":
        return pr
    Rh = _brot(body_rot(*ch["hips_turn"]))
    Rc = Rh @ _brot(body_rot(*ch["chest"]))
    origin = np.asarray(ch["hips_at"]) + Rh @ body.chest_off
    return {**pr, "grip": origin + Rc @ np.asarray(pr["grip"], float), "tip": Rc @ np.asarray(pr["tip"], float), "space": "root"}


def _heel_rot(yaw, heel):
    Ry = rz(yaw)
    return axis_angle(Ry @ np.array([1.0, 0, 0]), heel) @ Ry if heel else Ry


def _rootpos(root):
    return B2W @ np.array([root[0], root[1], 0.0])


def _foot_world_of(f, Rp_w, hips_w, ball_h):
    """(ball position, foot rotation) of a foot pose at this frame."""
    if f["space"] == "hips":
        p = hips_w + Rp_w @ B2W @ np.asarray(f["at"], float)
        return p, Rp_w @ axis_angle(np.array([1.0, 0, 0]), f.get("heel", 0.0)) @ rz(f.get("yaw", 0.0))
    return B2W @ np.asarray(f["at"], float) + np.array([0, 0, ball_h]), _heel_rot(f["yaw"], f["heel"])


def sample(beats, craft, body):
    """Per-frame channels from the beats."""
    ball_h = body.ball_h
    frames = []
    for f in range(beats[0]["at"], beats[-1]["at"] + 1):
        i = max(k for k in range(len(beats)) if beats[k]["at"] <= f)
        if i == len(beats) - 1:
            A = B = beats[i]
            t = te = 0.0
        else:
            A, B = beats[i], beats[i + 1]
            t = (f - A["at"]) / (B["at"] - A["at"])
            te = ease(B.get("ease", craft.get("ease", "inout")), t, B.get("antic", craft.get("antic", 0.0)), B.get("over", craft.get("over", 0.0)))
        pa, pb = A["pose"], B["pose"]
        ch = {"frame": f, "t": t, "seg": i, "pivot": B.get("pivot") if A is not B else None}
        ra, rb = np.array(pa["root"], float), np.array(pb["root"], float)
        ch["root"] = _lerp(ra, rb, te)
        ch["hips_at"] = _lerp(pa["hips"]["at"], pb["hips"]["at"], te)
        ch["hips_turn"] = _lerp(pa["hips"]["turn"], pb["hips"]["turn"], te)
        ch["chest"] = _lerp(pa["chest"], pb["chest"], te)
        ch["head"] = _lerp(pa["head"], pb["head"], te)
        la, lb = pa.get("look"), pb.get("look")
        ch["look"] = None if la is None or lb is None else _lerp(la, lb, te)
        if body.prop is not None:
            sa, sb = _root_prop(pa["prop"], ch, body), _root_prop(pb["prop"], ch, body)
            if craft.get("arcs", True):
                ch["grip"] = _arc_point(sa["grip"], sb["grip"], te, ch["hips_at"])
                ch["tip"] = _arc_dir(sa["tip"], sb["tip"], te, pb["prop"].get("way"))
            else:
                ch["grip"] = _lerp(sa["grip"], sb["grip"], te)
                ch["tip"] = unit(_lerp(sa["tip"], sb["tip"], te))
            ea, eb = sa.get("edge"), sb.get("edge")
            ch["edge"] = None if (ea is None or eb is None) else unit(_lerp(ea, eb, te))
        for s in "lr":
            ha, hb = pa["hand_" + s], pb["hand_" + s]
            # A free hand blended with a grip: its goal runs from the grip's place.
            ch["hand_" + s] = "grip" if ha == "grip" and hb == "grip" else {"a": ha, "b": hb, "t": te}
        Rp_w = rz(ch["root"][2]) @ body_rot(*ch["hips_turn"])
        hips_w = rz(ch["root"][2]) @ B2W @ np.asarray(ch["hips_at"]) + _rootpos(ch["root"])
        for side in ("l", "r"):
            fa, fb = _ground_foot(pa["foot_" + side], ra), _ground_foot(pb["foot_" + side], rb)
            air = fa["space"] == "hips" or fb["space"] == "hips"
            if not air:
                if fb.get("orbit") and A is not B:
                    c0 = _lerp(ra[:2], rb[:2], te)
                    at = _arc_point(fa["at"], fb["at"], te, (c0[0], c0[1]))
                else:
                    at = _lerp(fa["at"], fb["at"], te)
                dist = np.linalg.norm(np.asarray(fb["at"][:2], float) - np.asarray(fa["at"][:2], float))
                lift = B.get("lift", craft.get("lift", 0.045 * body.height)) if (A is not B and dist > 0.03) else 0.0
                tl = min(max(t, 0), 1)
                # any real step clears the floor: a short shuffle still lifts half the lift
                at = at + np.array([0, 0, lift * min(1.0, max(0.5, dist / 0.3)) * math.sin(math.pi * tl)])
                yaw = fa["yaw"] + (fb["yaw"] - fa["yaw"]) * te
                heel = fa["heel"] + (fb["heel"] - fa["heel"]) * te
                world = B2W @ at + np.array([0, 0, ball_h])
                R = _heel_rot(yaw, heel)
            else:
                (wa, Ra_), (wb, Rb_) = (_foot_world_of(x, Rp_w, hips_w, ball_h) for x in (fa, fb))
                world = _lerp(wa, wb, te)
                R = slerp_rot(Ra_, Rb_, min(max(te, 0), 1))
                at = B2W.T @ (world - np.array([0, 0, ball_h]))
                yaw = fa["yaw"] + (fb["yaw"] - fa["yaw"]) * te
                heel = 0.0
            both = fa["space"] == "hips" and fb["space"] == "hips"
            ch["foot_" + side] = {"at": at, "yaw": yaw, "heel": heel, "space": "ground", "air": air, "world": world, "R": R,
                                  "air_heel": (fa.get("heel", 0) + (fb.get("heel", 0) - fa.get("heel", 0)) * te) if both else None}

            def kp(f, pole):
                return (Rp_w @ B2W @ np.asarray(pole, float)) if f["space"] == "hips" else (rz(ch["root"][2]) @ B2W @ np.asarray(pole, float))

            ch["knee_world_" + side] = unit(_lerp(kp(fa, pa["knee_" + side]), kp(fb, pb["knee_" + side]), te))
            ch["elbow_" + side] = unit(_lerp(pa["elbow_" + side], pb["elbow_" + side], te))
        frames.append(ch)
    return frames


def spring(xs, f_hz, zeta, fps, sub=8):
    """A second-order follower of a track: lag, then overshoot."""
    xs = np.asarray(xs, float)
    w = 2 * math.pi * f_hz
    x, v = xs[0].copy(), np.zeros_like(xs[0])
    out = []
    dt = 1.0 / fps / sub
    for k in range(len(xs)):
        for _ in range(sub):
            a = w * w * (xs[k] - x) - 2 * zeta * w * v
            v = v + a * dt
            x = x + v * dt
        out.append(x.copy())
    return np.array(out)


# ------------------------------------------------------------------------------------------ the solver
def solve_frame(body, ch):
    r = body.rig
    P = {}
    root = ch["root"]
    Ry = rz(root[2])

    def W(v):
        return Ry @ B2W @ np.asarray(v, float) + _rootpos(root)

    def D(d):
        return Ry @ B2W @ np.asarray(d, float)

    r.posed("root", np.eye(3), P, head=r.head("root"))
    Rp = Ry @ body_rot(*ch["hips_turn"])
    r.posed("pelvis", Rp, P, head=W(ch["hips_at"]))
    for n, share in (("spine_01", 0.3), ("spine_02", 0.65), ("spine_03", 1.0)):
        r.posed(n, Rp @ body_rot(*(np.asarray(ch["chest"]) * share)), P)
    Rc = Rp @ body_rot(*ch["chest"])
    hy, hp, hr = ch["head"]
    r.posed("neck_01", Rc @ body_rot(hy * 0.4, hp * 0.4, hr * 0.4), P)
    r.posed("Head", Rc @ body_rot(hy, hp, hr), P)
    m, o = body.main, body.off
    prop = body.prop

    def involves_grip(h):
        return h == "grip" or (isinstance(h, dict) and "grip" in (h["a"], h["b"]))

    # The prop is posed whenever the main hand holds it at either end of the beat.
    posed = prop is not None and involves_grip(ch["hand_" + m])
    holding = posed and ch["hand_" + m] == "grip"
    two = holding and ch["hand_" + o] == "grip"
    if prop is not None and involves_grip(ch["hand_" + o]) and not posed:
        raise Refused("invalid-input", f"at frame {ch['frame']} hand_{o} is on the grip while hand_{m}, which holds the prop, is not: put hand_{m} on the grip too, or free hand_{o}")
    grip = blade = None
    if posed:
        grip = W(ch["grip"])
        blade = unit(D(ch["tip"]))
    nowhere = W((0, 0.3, 1.0))

    def free(spec, gripped):
        if spec == "grip":
            return gripped
        at = np.asarray(spec["at"], float)
        turn = ("neutral", body_rot(*spec.get("turn", (0, 0, 0))))
        if spec.get("space", "root") == "chest":
            return P["spine_03"][:3, 3] + Rc @ B2W @ at, turn
        return W(at), turn

    # Where each hand is going decides the shrug: the clavicles turn toward it first.
    goal_pos = {}
    for s in "lr":
        h = ch["hand_" + s]
        at_grip = (grip if s == m else grip - blade * body.second) if posed else nowhere
        if h == "grip":
            goal_pos[s] = at_grip
        else:
            pa, pb = free(h["a"], (at_grip, None))[0], free(h["b"], (at_grip, None))[0]
            goal_pos[s] = pa + (pb - pa) * h["t"]
    for s in "lr":
        cl = "clavicle_" + s
        P0 = r.posed(cl, Rc, P)
        rest_dir = Rc @ r.L[cl][:3, 1]
        want = unit(goal_pos[s] - P0[:3, 3])
        ang = math.degrees(math.acos(max(-1, min(1, np.dot(rest_dir, want)))))
        k = min(0.2, 20.0 / max(ang, 1e-6)) if ang > 1e-3 else 0.0
        r.posed(cl, slerp_rot(np.eye(3), rot_between(rest_dir, want), k) @ Rc, P)
    shoulder = {s: r.head_under("upperarm_" + s, P) for s in "lr"}
    a0, a1 = P["pelvis"][:3, 3], P["spine_03"][:3, 3]
    clear = ch.get("clearance", body.clearance)

    def outward(q):
        """How far q is inside a capsule around the spine, and the way out: perpendicular to the
        spine, so it holds upside down in a roll too."""
        ab = a1 - a0
        t = min(1, max(0, np.dot(q - a0, ab) / np.dot(ab, ab)))
        d = q - (a0 + ab * t)
        return clear - np.linalg.norm(d), (unit(d) if np.linalg.norm(d) > 1e-6 else Rc @ np.array([0, -1.0, 0]))

    goals, poles, hs = {}, {}, {}
    if posed:
        if clear and holding:
            for _ in range(2):
                worst = None
                for q in (grip, grip - blade * body.second) if two else (grip,):
                    deficit, way = outward(q)
                    if deficit > 0 and (worst is None or deficit > worst[0]):
                        worst = (deficit, way)
                if worst is None:
                    break
                grip = grip + worst[1] * worst[0]
                ch["cleared"] = ch.get("cleared", 0) + 1
        authored = ch.get("edge") is not None
        pref = D(ch["edge"]) if authored else D(ch.get("edge_auto", (0, 0, -1)))
        pref = unit(pref - np.dot(pref, blade) * blade)
        pref_w = 3.0 if authored else (ch.get("lead_w", 1.0) if prop["edged"] else 0.0)
        prev = ch.get("edge_prev")

        def hands_for(e):
            Hm = map_pair(prop["axis"], prop["edge"], blade, e)
            Ho = map_pair(prop["axis_off"], prop["edge_off"], blade, e)
            return {m: (grip - Hm @ prop["grip"], Hm), o: ((grip - blade * body.second) - Ho @ prop["grip_off"], Ho)}

        def wrist_pole(s, wrist, H):
            # the elbow hangs where the spec points it, nudged toward where the forearm runs on into the hand
            e_star = wrist - H[:, 1] * body.fore
            return unit(unit(D(ch["elbow_" + s])) + 0.4 * unit(e_star - shoulder[s]))

        def bend(s, wrist, H, pole):
            M, G, _ = two_bone(shoulder[s], wrist, body.upper, body.fore, pole)
            return math.degrees(math.acos(max(-1, min(1, np.dot(unit(G - M), H[:, 1])))))

        # The roll: a search over the prop's turn about its own axis, scoring folded wrists, an
        # edge that does not lead the swing, and a roll that jumps from the last frame.
        e0 = unit(np.cross(blade, [0, 0, 1.0]) if abs(blade[2]) < 0.95 else np.cross(blade, [1.0, 0, 0]))
        best = None
        for k in range(36):
            e = axis_angle(blade, 10.0 * k) @ e0
            cand = hands_for(e)
            cost = 0.0
            for s in ((m, o) if two else (m,)):
                w, H = cand[s]
                b = bend(s, w, H, wrist_pole(s, w, H))
                cost += 0.02 * b + max(0.0, b - 40.0) ** 2 / 50.0
            cost += pref_w * (1 - abs(float(np.dot(e, pref)))) * 20.0  # either edge may lead
            if prev is not None:
                pv = unit(prev - np.dot(prev, blade) * blade)
                cost += 0.08 * math.degrees(math.acos(max(-1, min(1, float(np.dot(e, pv))))))
            if best is None or cost < best[0]:
                best = (cost, e, cand)
        _, edge, hs = best
        ch["edge_final"] = edge
        if holding:
            goals[m] = hs[m]
            poles[m] = wrist_pole(m, *hs[m])
        if two:
            goals[o] = hs[o]
            poles[o] = wrist_pole(o, *hs[o])
    for s in "lr":
        if s in goals:
            continue
        h = ch["hand_" + s]
        if h == "grip":  # the other hand on a prop the main hand is letting go of: it follows the handle
            h = {"a": "grip", "b": "grip", "t": 1.0}
        gripped = hs.get(s, (nowhere, np.eye(3)))
        (pa, Ra), (pb, Rb) = free(h["a"], gripped), free(h["b"], gripped)
        t = h["t"]
        pos = pa + (pb - pa) * t
        if clear:
            deficit, way = outward(pos)
            if deficit > 0:
                pos = pos + way * deficit
                ch["cleared"] = ch.get("cleared", 0) + 1
        if "free_" + s in ch:
            pos = ch["free_" + s]
        goals[s] = (pos, ("blend", Ra, Rb, min(max(t, 0), 1)))
        poles[s] = D(ch["elbow_" + s])
    for s in "lr":
        _arm(body, s, goals[s][0], goals[s][1], poles[s], P, ch)
    for s in "lr":
        fist = ch["hand_" + s] == "grip" or (s == m and holding)
        fb = body.finger_basis(s, fist)
        for n in r.names:
            if n in fb or (n.endswith("_" + s) and n.split("_")[0] in FINGERS):
                P[n] = r.local(n, P, fb.get(n, np.eye(4)))
    for s in "lr":
        f = ch["foot_" + s]
        _leg(body, s, ch["foot_world_" + s], f["R"], None if f["air"] else f["yaw"], ch["knee_world_" + s], P, f.get("air_heel"), ch)
    for n in r.names:
        if n not in P:
            P[n] = r.local(n, P, np.eye(4))
    return P


def _limb_rot(r, n, d, nrm):
    """The turn taking bone n's rest (direction, hinge) onto (d, nrm)."""
    return map_pair(r.L[n][:3, 1], rest_hinge(r.L, n), d, nrm)


def _arm(body, s, wrist, Hw, pole, P, ch):
    r = body.rig
    ua, la, h = "upperarm_" + s, "lowerarm_" + s, "hand_" + s
    S = r.head_under(ua, P)
    M, G, need = two_bone(S, wrist, body.upper, body.fore, pole)
    d1, d2 = M - S, G - M
    nrm = np.cross(d1, d2)
    if np.linalg.norm(nrm) < 1e-6:
        nrm = np.cross(d1, -np.asarray(pole))
    nrm = unit(nrm)
    r.posed(ua, _limb_rot(r, ua, d1, nrm), P)
    R2 = _limb_rot(r, la, d2, nrm)
    if isinstance(Hw, tuple):  # a free hand: neutral from its forearm, turned, or blended with a grip

        def res(x):
            return (R2 @ x[1] @ r.L[h][:3, :3]) if isinstance(x, tuple) else x

        Hw = res(Hw) if Hw[0] == "neutral" else slerp_rot(res(Hw[1]), res(Hw[2]), Hw[3])
    # the forearm takes half the hand's twist about it, so the wrist does not candy-wrap
    rel = (R2 @ r.L[la][:3, :3]).T @ Hw @ np.linalg.inv(r.L[h][:3, :3]) @ r.L[la][:3, :3]
    tw = swing_twist(rel, np.array([0, 1.0, 0]))
    R2 = axis_angle(unit(d2), tw * 0.5) @ R2
    r.posed(la, R2, P)
    P[h] = M4(Hw, r.head_under(h, P))
    key = s + "arm"
    if need > body.stretch.get(key, (0, 0))[0]:
        body.stretch[key] = (need, ch["frame"])


def _leg(body, s, ball_world, Rf, flat_yaw, pole, P, air_heel, ch):
    r = body.rig
    th, ca, ft, bl = "thigh_" + s, "calf_" + s, "foot_" + s, "ball_" + s
    S = r.head_under(th, P)
    for _ in range(2 if air_heel is not None else 1):
        ankle = ball_world - Rf @ body.ball_off[s]
        M, G, need = two_bone(S, ankle, body.thigh, body.calf, pole)
        d1, d2 = M - S, G - M
        nrm = np.cross(d1, d2)
        if np.linalg.norm(nrm) < 1e-6:
            nrm = np.cross(d1, np.asarray(pole))
        nrm = unit(nrm)
        Rc_ = _limb_rot(r, ca, d2, nrm)
        if air_heel is not None:
            # a foot off the ground carries on from its shin, pointed by its heel value
            Rf = axis_angle(Rc_ @ rest_hinge(r.L, th), air_heel) @ Rc_
    r.posed(th, _limb_rot(r, th, d1, nrm), P)
    r.posed(ca, Rc_, P)
    r.posed(ft, Rf, P)
    r.posed(bl, rz(flat_yaw) if flat_yaw is not None else Rf, P)  # the toes stay flat on the ground
    key = s + "leg"
    if need > body.stretch.get(key, (0, 0))[0]:
        body.stretch[key] = (need, ch["frame"])


# ---------------------------------------------------------------------------------------- craft passes
def _edge_auto(frames, fps):
    """The edge leads: it faces the way the tip travels, smoothed, held while the tip is slow."""
    tips = np.array([np.asarray(c["grip"]) + np.asarray(c["tip"]) * 0.8 for c in frames])
    vel = np.gradient(tips, axis=0) * fps if len(tips) > 1 else np.zeros_like(tips)
    prev = np.array([0, 0.3, -1.0])
    out = []
    for c, v in zip(frames, vel):
        d = unit(c["tip"])
        vp = v - np.dot(v, d) * d
        sp = np.linalg.norm(vp)
        want = unit(vp) if sp > 0.6 else prev
        w = min(1.0, sp / 2.5)
        e = unit(prev * (1 - w) + want * w) if sp > 0.6 else prev
        e = unit(e - np.dot(e, d) * d)
        out.append(e)
        c["lead_w"] = 2.0 * w if sp > 0.6 else 0.3
        prev = e
    out = np.array(out)
    for i, c in enumerate(frames):
        c["edge_auto"] = unit(out[max(0, i - 1):i + 2].mean(0))


def _pivots(frames):
    """A beat with pivot turns the body on that planted foot: the root orbits the foot, keeping the
    offset it had when the beat began, and the shift carries on to later frames."""
    offset = np.zeros(2)
    seg = foot0 = off0 = yaw0 = None
    for c in frames:
        root = np.asarray(c["root"], float).copy()
        root[:2] += offset
        pv = c.get("pivot")
        if pv:
            s = pv[-1]
            if seg != c["seg"]:
                seg = c["seg"]
                foot0 = np.asarray(c["foot_" + s]["at"][:2], float)
                off0 = root[:2] - foot0
                yaw0 = root[2]
            want = foot0 + rz(root[2] - yaw0)[:2, :2] @ off0
            offset = offset + (want - root[:2])
            root[:2] = want
        c["root"] = root


def _feet_world(frames, body, craft, fps):
    """Each foot's ball goal, locked to the ground through each stance and eased out of the lock."""
    info = {"stances": {"l": 0, "r": 0}, "lockedFrames": {"l": 0, "r": 0}}
    for s in "lr":
        pts = np.array([c["foot_" + s]["world"] for c in frames])
        if craft.get("lock_feet", True):
            # planted: low and slow (a foot gliding through a lunge is not locked)
            spd = np.r_[0.0, np.linalg.norm(np.diff(pts[:, :2], axis=0), axis=1) * fps]
            spd = np.minimum(spd, np.r_[spd[1:], spd[-1]])
            down = [(not c["foot_" + s]["air"]) and (p[2] - body.ball_h) < 0.02 and v < craft.get("lock_speed", 0.5)
                    for c, p, v in zip(frames, pts, spd)]
            n = len(pts)
            locked, weight = pts.copy(), np.zeros(n)
            k = 0
            while k < n:
                if not down[k]:
                    k += 1
                    continue
                j = k
                while j + 1 < n and down[j + 1]:
                    j += 1
                anchor = np.median(pts[k:j + 1], axis=0)
                anchor[2] = body.ball_h
                locked[k:j + 1] = anchor
                weight[k:j + 1] = 1.0
                info["stances"][s] += 1
                info["lockedFrames"][s] += j - k + 1
                k = j + 1
            out = pts.copy()
            on = np.where(weight == 1)[0]
            for q in range(n):
                if weight[q] == 1:
                    out[q] = locked[q]
                elif len(on):
                    z = on[np.argmin(np.abs(on - q))]
                    if abs(z - q) <= 3:  # eased in and out over 3 frames, so a lift never pops
                        b = 1 - abs(z - q) / 4
                        out[q] = pts[q] * (1 - b) + locked[z] * b
            pts = out
        for c, p in zip(frames, pts):
            c["foot_world_" + s] = p
    return info


def _hip_drop(frames, body):
    """Lowers the pelvis, smoothed, wherever a leg cannot reach its goal. Returns (max m, frames)."""
    r = body.rig
    drops = []
    for c in frames:
        P = {}
        root = c["root"]
        Ry = rz(root[2])
        r.posed("root", np.eye(3), P, head=r.head("root"))
        r.posed("pelvis", Ry @ body_rot(*c["hips_turn"]), P, head=Ry @ B2W @ np.asarray(c["hips_at"]) + _rootpos(root))
        need = 0.0
        for s in "lr":
            hip = r.head_under("thigh_" + s, P)
            ankle = c["foot_world_" + s] - c["foot_" + s]["R"] @ body.ball_off[s]
            reach = (body.thigh + body.calf) * 0.985
            dxy = math.hypot(*(hip - ankle)[:2])
            if dxy < reach:
                need = max(need, hip[2] - (ankle[2] + math.sqrt(reach * reach - dxy * dxy)))
        drops.append(max(0.0, need))
    drops = np.array(drops)
    sm = np.array([drops[max(0, i - 2):i + 3].max() for i in range(len(drops))])
    sm2 = np.array([sm[max(0, i - 1):i + 2].mean() for i in range(len(sm))])
    for c, d in zip(frames, sm2):
        c["hips_at"] = np.asarray(c["hips_at"]) - np.array([0, 0, d])
    worst = int(np.argmax(drops)) if len(drops) else 0
    return float(drops.max()) if len(drops) else 0.0, int((drops > 1e-4).sum()), frames[worst]["frame"] if len(drops) else 0


def _overlap(frames, craft, fps):
    ov = craft.get("overlap", {})
    if "chest" in ov:  # the chest trails the hips: its yaw in the world, pitch and roll relative, clamped
        f, z, clamp = ov["chest"]
        wy = spring(np.array([[c["root"][2] + c["hips_turn"][0] + c["chest"][0]] for c in frames]), f, z, fps)
        pr = spring(np.array([[c["chest"][1], c["chest"][2]] for c in frames]), f, z, fps)
        for c, y, p in zip(frames, wy, pr):
            lag = max(-clamp, min(clamp, y[0] - (c["root"][2] + c["hips_turn"][0] + c["chest"][0])))
            c["chest"] = np.array([c["chest"][0] + lag, p[0], p[1]])
    if "head" in ov:  # the head trails the chest
        f, z, clamp = ov["head"]

        def want(c):
            return np.array([c["root"][2] + c["hips_turn"][0] + c["chest"][0] + c["head"][0], c["chest"][1] + c["head"][1]])

        sm = spring(np.array([want(c) for c in frames]), f, z, fps)
        for c, s in zip(frames, sm):
            lag = np.clip(s - want(c), -clamp, clamp)
            c["head"] = np.array([c["head"][0] + lag[0], c["head"][1] + lag[1], c["head"][2]])


def _look(frames, body):
    """Head angles toward a look point (root space), limited, relative to the chest."""
    for c in frames:
        if c.get("look") is None:
            continue
        Rc = rz(c["root"][2]) @ body_rot(*c["hips_turn"]) @ body_rot(*c["chest"])
        head = rz(c["root"][2]) @ B2W @ np.asarray(c["hips_at"]) + _rootpos(c["root"]) + Rc @ B2W @ body.head_off
        tgt = rz(c["root"][2]) @ B2W @ np.asarray(c["look"]) + _rootpos(c["root"])
        db = B2W.T @ (Rc.T @ (tgt - head))
        yaw = math.degrees(math.atan2(-db[0], db[1]))
        pitch = -math.degrees(math.atan2(db[2], math.hypot(db[0], db[1])))
        c["head"] = np.array([max(-60, min(60, yaw + c["head"][0])), max(-45, min(45, pitch + c["head"][1])), c["head"][2]])


def _free_hand_overlap(frames, body, craft, fps):
    ov = craft.get("overlap", {}).get("hand")
    if ov is None:
        return
    for s in "lr":
        idx = [i for i, c in enumerate(frames) if c["hand_" + s] != "grip"]
        if len(idx) < 3:
            continue
        pos = np.array([solve_frame(body, frames[i])["hand_" + s][:3, 3] for i in idx])
        for i, p in zip(idx, spring(pos, ov[0], ov[1], fps)):
            frames[i]["free_" + s] = p


def compile_move(body, spec, fps):
    """(frames, armature-space poses, compile report) for a spec on a body."""
    craft = dict(spec.get("craft", {}))
    library = {"stand": body.stand(), **(spec.get("poses") or {})}
    _check(spec, library, body)
    beats = resolve_beats(spec, library)
    frames = sample(beats, craft, body)
    body.stretch = {}
    report = {"frames": len(frames)}
    for c in frames:
        c["clearance"] = craft.get("clearance", body.clearance)
    if craft.get("pivot", True):
        _pivots(frames)
    if body.prop is not None:
        _edge_auto(frames, fps)
    _look(frames, body)
    _overlap(frames, craft, fps)
    report["footLock"] = _feet_world(frames, body, craft, fps)
    if craft.get("hip_drop", True):
        mx, n, at = _hip_drop(frames, body)
        report["hipDrop"] = {"maxCm": round(mx * 100, 1), "frames": n, "worstFrame": at - frames[0]["frame"]}
    _free_hand_overlap(frames, body, craft, fps)
    poses = []
    prev = None
    for c in frames:
        c["edge_prev"] = prev
        poses.append(solve_frame(body, c))
        prev = c.get("edge_final")
    report["reach"] = {k: {"share": round(v[0], 3), "frame": v[1] - frames[0]["frame"]} for k, v in body.stretch.items()}
    report["clearedFrames"] = sum(1 for c in frames if c.get("cleared"))
    return frames, poses, report


def write_action(body, poses, act):
    """Keys every bone but the spring chains on every frame, linear; translation on the pelvis only."""
    arm, r = body.arm, body.rig
    skeleton.assign_action(arm, act)
    prevq = {}
    for i, P in enumerate(poses):
        B = r.basis(P)
        for pb in arm.pose.bones:
            if pb.name in body.chain_bones:
                continue
            loc, q, _ = Matrix(B[pb.name].tolist()).decompose()
            if pb.name in prevq and prevq[pb.name].dot(q) < 0:
                q.negate()
            prevq[pb.name] = q
            pb.rotation_mode = "QUATERNION"
            pb.rotation_quaternion = q
            pb.keyframe_insert("rotation_quaternion", frame=i)
            if pb.name == "pelvis":
                pb.location = loc
                pb.keyframe_insert("location", frame=i)
    for fc in skeleton.action_fcurves(act):
        for k in fc.keyframe_points:
            k.interpolation = "LINEAR"
    act.frame_range = (0, len(poses) - 1)
    act.use_frame_range = True
    return act


# ---------------------------------------------------------------------------------------- the entry
def _restore(arm, kept):
    ad = arm.animation_data or arm.animation_data_create()
    ad.action = kept["action"]
    if kept["action"] is not None and kept["slot"] is not None:
        ad.action_slot = kept["slot"]
    for pb in arm.pose.bones:
        pb.matrix_basis = kept["basis"][pb.name]
    sc = bpy.context.scene
    sc.frame_set(kept["frame"])


_BARS = {}


def _bar(arm, body, bar, fps, out):
    """The library clip the move is measured against, played on this character as the export
    would (rotations as they are, the pelvis's travel scaled to this body), measured, then removed."""
    # The live session keeps the kit loaded: a bar measured once on this body is reused.
    key = (arm.name, bar["path"], bar["clip"], round(body.height, 4), None if body.prop is None else round(body.prop["length"], 4), fps)
    if key in _BARS:
        return _BARS[key]
    before_objects = set(bpy.data.objects)
    before_actions = set(bpy.data.actions)
    skeleton.import_gltf(bar["path"])
    new = [o for o in bpy.data.objects if o not in before_objects]
    src = next((o for o in new if o.type == "ARMATURE"), None)
    imported = set(bpy.data.actions) - before_actions
    found = next((a for a in imported if a.name == bar["clip"] or a.name.split("|")[-1] == bar["clip"]), None)
    keep = found.copy() if found is not None else None
    for a in imported:
        bpy.data.actions.remove(a)
    ratio = (arm.data.bones["pelvis"].head_local.length / max(1e-6, src.data.bones["pelvis"].head_local.length)) if src is not None and "pelvis" in src.data.bones else 1.0
    skeleton.remove_objects(new)
    if keep is None:
        return None
    try:
        skeleton.fit_clip(keep, ratio)
        rate = skeleton.clip_rate(skeleton.gltf_json(bar["path"])) or fps
        if abs(rate - fps) > 0.5:
            skeleton.retime(keep, fps / rate)
        keep.name = "kurambit_bar"
        poses = _track(arm, keep)
        res, _ = measure.Motion(body, fps).run(poses, _skin_fn(arm, body, keep), stand=None)
        res["clip"] = bar["clip"]
        res["pack"] = bar.get("pack")
        _BARS[key] = res
        return res
    finally:
        bpy.data.actions.remove(keep)


def _track(arm, act):
    sc = bpy.context.scene
    skeleton.assign_action(arm, act)
    f0, f1 = (int(round(x)) for x in act.frame_range)
    out = []
    for f in range(f0, f1 + 1):
        sc.frame_set(f)
        out.append({pb.name: np.array(pb.matrix) for pb in arm.pose.bones})
    return out


def _skin_fn(arm, body, act):
    meshes = [o for o in body.meshes if any(m.type == "ARMATURE" and m.object == arm for m in o.modifiers)]
    if not meshes:
        return None

    def run():
        skin = measure.LimbSkin(arm, body)
        sc = bpy.context.scene
        skeleton.assign_action(arm, act)
        f0, f1 = (int(round(x)) for x in act.frame_range)
        limbs, props = [], []
        for f in range(f0, f1 + 1, 2):
            sc.frame_set(f)
            a, b = skin.now()
            limbs.append(a)
            props.append(b)
        return limbs, props

    return run


def _warnings(report, res, body, fps):
    out = []
    hd = report.get("hipDrop") or {}
    if hd.get("maxCm", 0) >= 3:
        out.append(f"hip drop: the pelvis was lowered {hd['maxCm']} cm at frame {hd['worstFrame']} ({hd['frames']} frames) because a leg could not reach its foot: the stance is wider or the hips higher than this body's legs reach; bring the feet in or the hips down")
    for k, v in sorted(report.get("reach", {}).items()):
        if v["share"] > 1.0:
            limb = {"larm": "left arm", "rarm": "right arm", "lleg": "left leg", "rleg": "right leg"}[k]
            out.append(f"reach: the {limb} was asked for {round(v['share'] * 100)}% of its length at frame {v['frame']}; it stops at 100%, so the goal is not reached")
    if report.get("clearedFrames", 0) > 0:
        out.append(f"clearance: hands were pushed out of the body on {report['clearedFrames']} frames; their goals are inside the torso")
    slides = [s for s in res["stances"] if s["slideMm"] > 20]
    if slides:
        out.append("foot slide: " + "; ".join(f"{'left' if s['foot'] == 'l' else 'right'} foot {s['slideMm']} mm over frames {s['from']}-{s['to']}" for s in slides[:4]))
    worst = sorted(res["jointLimits"]["violations"].items(), key=lambda kv: -kv[1]["worstDeg"])[:3]
    for k, v in worst:
        out.append(f"joint limit: {k} {v['worstDeg']}° past its range on {v['frames']} frames (range {v['range'][0]}..{v['range'][1]}°)")
    tb = res.get("throughBody") or {}
    if (tb.get("propMeanMm2") or 0) > 0:
        out.append(f"the prop passes through the body: {tb['propMeanMm2']} mm² a frame on average")
    if res.get("belowFloor", 0) > 0:
        out.append(f"below the floor: {res['belowFloor']} frame-bone pairs (hands, head, knees or pelvis under 3 cm)")
    return out


@entry
def animate(params):
    """animate(): compile a move spec onto a character as a clip, measure it and its bar, and draw
    the pictures. params: {armature, clip, spec, out: abs dir, bar: {path, clip, pack} | None,
    replace: bool}. The clip is the action <armature>|<clip>, exported as clip like the library's;
    the spec rides on it (kurambit_spec), so the next pass can start from it."""
    t0 = time.time()
    arm = bpy.data.objects.get(params["armature"])
    if arm is None or arm.type != "ARMATURE":
        raise Refused("invalid-input", f"no armature {params['armature']!r} in the live scene; game_blender_character makes one")
    clip = params["clip"]
    spec = params["spec"]
    existing = helpers.clip_of(arm, clip)
    if existing is not None and "kurambit_spec" not in existing:
        raise Refused("invalid-input", f"{clip} is a clip {arm.name} already has (a library or keyed clip); name the move something else, or remove that clip first")
    sc = bpy.context.scene
    fps = sc.render.fps / sc.render.fps_base
    ad = arm.animation_data or arm.animation_data_create()
    kept = {"action": ad.action, "slot": getattr(ad, "action_slot", None), "frame": sc.frame_current,
            "basis": {pb.name: pb.matrix_basis.copy() for pb in arm.pose.bones}}
    try:
        ad.action = None
        for pb in arm.pose.bones:
            pb.matrix_basis = Matrix()
        bpy.context.view_layer.update()
        try:
            body = Body(arm)
        except ValueError as cause:
            raise Refused("invalid-input", f"{arm.name} is {cause}: game_animate compiles moves for characters game_blender_character made") from None
        frames, poses, report = compile_move(body, spec, fps)
        name = helpers.action_name(arm.name, clip)
        if existing is not None:
            bpy.data.actions.remove(existing)
        act = bpy.data.actions.new(name)
        act["kurambit_owner"] = arm.name
        act["kurambit_clip"] = clip
        act["kurambit_spec"] = json.dumps(spec, separators=(",", ":"))
        act.use_fake_user = True
        write_action(body, poses, act)
        played = _track(arm, act)
        stand = compile_move(body, {"beats": [{"at": 0, "pose": spec.get("start", "stand")}, {"at": 1}], "poses": spec.get("poses") or {}}, fps)[1][0]
        motion = measure.Motion(body, fps)
        res, curves = motion.run(played, _skin_fn(arm, body, act), stand=stand)
        bar = _bar(arm, body, params["bar"], fps, params["out"]) if params.get("bar") else None
        os.makedirs(params["out"], exist_ok=True)
        beats = [b["at"] - spec["beats"][0]["at"] for b in spec["beats"]]
        notes = {b["at"] - spec["beats"][0]["at"]: b.get("note", "") for b in spec["beats"]}
        from .review import motion_pictures

        images = motion_pictures(arm, body, act, res, curves, beats, notes, params["out"], f"{clip} on {arm.name}", motion)
        warnings = _warnings(report, res, body, fps)
        result = {
            "clip": clip, "action": act.name, "frames": len(played), "fps": fps, "seconds": round((len(played) - 1) / fps, 3),
            "metrics": _public(res), "bar": None if bar is None else _public(bar), "compile": report, "warnings": warnings,
            "images": [{"path": p, "width": w, "height": h} for p, (w, h) in images],
            "body": {"height": round(body.height, 3), "hipsAt": round(float((B2W.T @ body.rig.head("pelvis"))[2]), 3),
                     "legLength": round(body.thigh + body.calf, 3), "armLength": round(body.upper + body.fore, 3),
                     "prop": None if body.prop is None else {"hand": "hand_" + body.prop["side"], "objects": body.prop["objects"],
                                                              "length": round(body.prop["length"], 3), "edged": body.prop["edged"]}},
            "tookSeconds": round(time.time() - t0, 1),
        }
        result["summary"] = _summary(result, arm.name)
        with open(os.path.join(params["out"], "bundle.json"), "w") as f:
            json.dump({**result, "spec": spec}, f, indent=1)
        return result
    finally:
        _restore(arm, kept)


def _pair(m, b, f):
    a = f(m)
    return a if b is None else f"{a} | {f(b)}"


def _summary(r, owner):
    """The pass in a few lines: the body, the warnings, then each measure as move | bar."""
    m, b = r["metrics"], r["bar"]
    body = r["body"]
    prop = body["prop"]
    lines = [f"{r['clip']} on {owner}: {r['frames']} frames at {r['fps']:g} fps ({r['seconds']} s), compiled, measured and drawn in {r['tookSeconds']} s.",
             f"Body: {body['height']} m to the top of the head bone, pelvis {body['hipsAt']} m up at rest, legs {body['legLength']} m, arms {body['armLength']} m"
             + ("; no hand holds a prop." if prop is None else f"; {prop['hand']} holds {', '.join(prop['objects'])} ({prop['length']} m{', edged' if prop['edged'] else ''})."),
             "Warnings: none." if not r["warnings"] else "Warnings:\n" + "\n".join("- " + w for w in r["warnings"]),
             "Measured" + ("" if b is None else f" (this move | the bar, {b['clip']} on the same body)") + ":"]

    def fs(x):
        f = x["footSlide"]
        return "no stance" if not f["stances"] else f"{f['meanMm']}/{f['maxMm']} mm over {f['stances']} stances"

    def bal(x):
        return f"{x['balance']['xcomOutsidePct']}% XCoM, {x['balance']['comOutsidePct']}% COM ({x['balance']['airborneFrames']} airborne frames)"

    def rom(x):
        return f"{x['jointLimits']['framesOver']} frame-joints over, worst {x['jointLimits']['worstDeg']}°"

    def thr(x):
        t = x.get("throughBody") or {}
        return "not measured" if not t else f"limbs {t['limbMeanMm2']:g} mm²" + ("" if "propMeanMm2" not in t else f", prop {t['propMeanMm2']:g} mm²")

    def strikes(x):
        return ", ".join(f"f{s['frame']} {s['by']} {s['speed']} m/s" + (f" edge {s['edgeLeads']}" if "edgeLeads" in s else "") for s in x["strikes"][:5]) or "none"

    def seam(x):
        return "-" if "seam" not in x else f"{x['seam']['startCm']}/{x['seam']['endCm']} cm"

    lines += [
        "- foot slide per stance, mean/max: " + _pair(m, b, fs),
        "- balance, grounded frames with the centre of mass 5 cm outside the support: " + _pair(m, b, bal),
        "- joint limits: " + _pair(m, b, rom),
        "- through the body, mean per frame: " + _pair(m, b, thr),
        "- jerk spikes: " + _pair(m, b, lambda x: str(x["smoothness"]["jerkSpikes"])),
        "- start/end against the start pose: " + seam(m),
        "- strikes: " + _pair(m, b, strikes),
        "- travel: " + _pair(m, b, lambda x: f"{x['root']['travelM']} m"),
    ]
    return lines


def _public(res):
    """The metrics without their per-frame detail (that is in the pictures)."""
    keep = ("frames", "seconds", "footSlide", "balance", "jointLimits", "smoothness", "seam", "strikes", "belowFloor", "root", "throughBody", "stances", "clip", "pack")
    out = {k: res[k] for k in keep if k in res}
    if "jointLimits" in out:
        out["jointLimits"] = {**out["jointLimits"], "violations": dict(sorted(out["jointLimits"]["violations"].items(), key=lambda kv: -kv[1]["frames"])[:6])}
    return out
