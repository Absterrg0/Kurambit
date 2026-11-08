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
import copy
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
    "smooth": lambda t: t * t * (3 - 2 * t),  # what a channel off the curve through the beats uses
}
SPACES = (("prop", "grip", "root"), ("foot_l", "at", "ground"), ("foot_r", "at", "ground"), ("hand_l", "at", "root"),
          ("hand_r", "at", "root"))
CHANNELS = ("root", "hips", "chest", "head", "look", "prop", "hand_l", "hand_r", "foot_l", "foot_r", "elbow_l", "elbow_r",
            "knee_l", "knee_r")
META = ("ease", "antic", "over", "pivot", "lift", "note")
MAX_FRAMES = 600
EASE_LOCK = 4  # frames a foot eases into and out of its lock


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
            raise Refused("invalid-input", f"beat {i} names pose {pose!r}; the named poses are {', '.join(sorted(library))}, and any clip this character has (its first frame)")
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


def _wrapd(d):
    return (d + 180.0) % 360.0 - 180.0


def _slopes(T, vals, keys=None, shift=None):
    """Monotone cubic (Fritsch-Carlson) slopes per beat, per component, in change per frame: zero
    where the value holds or turns back (so a held foot never creeps and a pose that reverses
    settles), carried through where it keeps going. A beat with no value (None), or a neighbour
    of another kind (keys differ), gets zero. shift: a loop's change over one cycle (the slopes
    wrap round the seam), or None (a one-shot starts and ends at rest)."""
    n = len(T)
    out = [None] * n
    span = T[-1] - T[0]
    for k in range(n):
        if vals[k] is None:
            continue
        y = np.asarray(vals[k], float)
        out[k] = np.zeros_like(y)
        if shift is None:
            if k == 0 or k == n - 1:
                continue
            (p, tp, sp), (q, tq, sq) = (k - 1, T[k - 1], 0), (k + 1, T[k + 1], 0)
        else:
            (p, tp, sp) = (k - 1, T[k - 1], 0) if k > 0 else (n - 2, T[n - 2] - span, -1)
            (q, tq, sq) = (k + 1, T[k + 1], 0) if k < n - 1 else (1, T[1] + span, 1)
        if vals[p] is None or vals[q] is None or (keys is not None and not (keys[p] == keys[k] == keys[q])):
            continue
        yp = np.asarray(vals[p], float) + (0 if shift is None else sp * shift)
        yq = np.asarray(vals[q], float) + (0 if shift is None else sq * shift)
        h0, h1 = T[k] - tp, tq - T[k]
        d0, d1 = (y - yp) / h0, (yq - y) / h1
        w1, w2 = 2 * h1 + h0, h1 + 2 * h0
        ok = d0 * d1 > 1e-12
        out[k] = np.where(ok, (w1 + w2) / (w1 / np.where(ok, d0, 1.0) + w2 / np.where(ok, d1, 1.0)), 0.0)
    return out


def _herm(a, b, ma, mb, h, t):
    t2, t3 = t * t, t * t * t
    return (2 * t3 - 3 * t2 + 1) * np.asarray(a, float) + (t3 - 2 * t2 + t) * h * ma + (3 * t2 - 2 * t3) * np.asarray(b, float) + (t3 - t2) * h * mb


def _tracks(beats, body, loop):
    """Each splined channel's value at every beat and its slope there. Angles are unwrapped beat to
    beat, so a curve through them turns the short way (or the way a prop beat names)."""
    T = [b["at"] for b in beats]
    P = [b["pose"] for b in beats]
    zero3 = np.zeros(3)
    tr = {}
    move = None if loop is None else np.array([loop[0], loop[1], 0.0])

    def add(name, vals, keys=None, shift=None):
        if loop is not None and shift is None:
            shift = np.zeros_like(next((np.asarray(v, float) for v in vals if v is not None), zero3))
        tr[name] = (vals, _slopes(T, vals, keys, None if loop is None else shift))

    add("root", [np.asarray(p["root"], float) for p in P], shift=move)
    for name, get in (("hips_at", lambda p: p["hips"]["at"]), ("hips_turn", lambda p: p["hips"]["turn"]),
                      ("chest", lambda p: p["chest"]), ("head", lambda p: p["head"])):
        add(name, [np.asarray(get(p), float) for p in P])
    add("look", [None if p.get("look") is None else np.asarray(p["look"], float) for p in P])
    for s in "lr":
        vals, keys = [], []
        for p in P:
            f = _ground_foot(p["foot_" + s], np.asarray(p["root"], float))
            keys.append(f["space"])
            vals.append(None if f["space"] == "hips" else np.array([*np.asarray(f["at"], float), f["yaw"], f["heel"]]))
        add("foot_" + s, vals, keys, None if move is None else np.array([loop[0], loop[1], 0, 0, 0.0]))
        hv, hk = [], []
        for p in P:
            h = p["hand_" + s]
            hk.append("grip" if h == "grip" else h.get("space", "root"))
            hv.append(None if h == "grip" else np.asarray(h["at"], float))
        add("hand_" + s, hv, hk)
    if body.prop is not None:
        gv, tv, keys = [], [], []
        a_prev = az_prev = None
        for p in P:
            pr = p["prop"]
            keys.append(pr.get("space", "root"))
            if pr.get("space", "root") == "chest":
                gv.append(None)
                tv.append(None)
                a_prev = az_prev = None
                continue
            c = np.asarray(p["hips"]["at"], float)
            a, r_, z = _cyl(np.asarray(pr["grip"], float) - np.array([c[0], c[1], 0.0]))
            a = math.degrees(a)
            if a_prev is not None:
                a = a_prev + _wrapd(a - a_prev)
            az, el = (math.degrees(x) for x in _sph(pr["tip"]))
            if az_prev is not None:
                d = _wrapd(az - az_prev)
                if pr.get("way") == "cw" and d > 0:
                    d -= 360
                if pr.get("way") == "ccw" and d < 0:
                    d += 360
                az = az_prev + d
            gv.append(np.array([a, r_, z]))
            tv.append(np.array([az, el]))
            a_prev, az_prev = a, az
        add("grip", gv, keys)
        add("tip", tv, keys)
    return tr


def sample(beats, craft, body, loop=None):
    """Per-frame channels from the beats. A beat with no ease (the default, "smooth") runs on a
    monotone cubic through the beats, which keeps moving through a beat the motion carries on
    through and settles only where a value holds or turns back; a named ease (inout, in, out,
    linear...) shapes that one beat's change on its own, as a deliberate break."""
    ball_h = body.ball_h
    tracks = _tracks(beats, body, loop)
    frames = []
    for f in range(beats[0]["at"], beats[-1]["at"] + 1):
        i = max(k for k in range(len(beats)) if beats[k]["at"] <= f)
        smooth = False
        if i == len(beats) - 1:
            A = B = beats[i]
            t = te = 0.0
            extra = 0.0
            h = 1.0
        else:
            A, B = beats[i], beats[i + 1]
            h = float(B["at"] - A["at"])
            t = (f - A["at"]) / h
            kind = B.get("ease", craft.get("ease", "smooth"))
            antic, over = B.get("antic", craft.get("antic", 0.0)), B.get("over", craft.get("over", 0.0))
            smooth = kind == "smooth"
            te = ease(kind, t, antic, over)
            extra = ease("linear", t, antic, over) - t  # the anticipation and overshoot bumps alone

        def spl(name, fallback):
            """The channel on the curve through the beats, or fallback where it cannot run."""
            vals, slopes = tracks[name]
            if not smooth or vals[i] is None or vals[i + 1] is None or slopes[i] is None or slopes[i + 1] is None:
                return fallback()
            a, b = vals[i], vals[i + 1]
            return _herm(a, b, slopes[i], slopes[i + 1], h, t) + (b - a) * extra

        pa, pb = A["pose"], B["pose"]
        ch = {"frame": f, "t": t, "seg": i, "pivot": B.get("pivot") if A is not B else None}
        ra, rb = np.array(pa["root"], float), np.array(pb["root"], float)
        ch["root"] = spl("root", lambda: _lerp(ra, rb, te))
        ch["hips_at"] = spl("hips_at", lambda: _lerp(pa["hips"]["at"], pb["hips"]["at"], te))
        ch["hips_turn"] = spl("hips_turn", lambda: _lerp(pa["hips"]["turn"], pb["hips"]["turn"], te))
        ch["chest"] = spl("chest", lambda: _lerp(pa["chest"], pb["chest"], te))
        ch["head"] = spl("head", lambda: _lerp(pa["head"], pb["head"], te))
        la, lb = pa.get("look"), pb.get("look")
        ch["look"] = None if la is None or lb is None else spl("look", lambda: _lerp(la, lb, te))
        if body.prop is not None:
            sa, sb = _root_prop(pa["prop"], ch, body), _root_prop(pb["prop"], ch, body)
            if craft.get("arcs", True):
                ch["grip"] = _arc_point(sa["grip"], sb["grip"], te, ch["hips_at"])
                ch["tip"] = _arc_dir(sa["tip"], sb["tip"], te, pb["prop"].get("way"))
                g = spl("grip", lambda: None)
                if g is not None:
                    c = ch["hips_at"]
                    ch["grip"] = np.array([c[0], c[1], 0.0]) + _from_cyl(math.radians(g[0]), g[1], g[2])
                _, ela = _sph(sa["tip"])
                _, elb = _sph(sb["tip"])
                d = spl("tip", lambda: None)
                if d is not None and abs(ela) <= 1.45 and abs(elb) <= 1.45:
                    ch["tip"] = _from_sph(math.radians(d[0]), math.radians(d[1]))
            else:
                ch["grip"] = _lerp(sa["grip"], sb["grip"], te)
                ch["tip"] = unit(_lerp(sa["tip"], sb["tip"], te))
            ea, eb = sa.get("edge"), sb.get("edge")
            ch["edge"] = None if (ea is None or eb is None) else unit(_lerp(ea, eb, te))
        for s in "lr":
            ha, hb = pa["hand_" + s], pb["hand_" + s]
            # A free hand blended with a grip: its goal runs from the grip's place.
            if ha == "grip" and hb == "grip":
                ch["hand_" + s] = "grip"
            else:
                ch["hand_" + s] = {"a": ha, "b": hb, "t": te}
                at = spl("hand_" + s, lambda: None) if ha != "grip" and hb != "grip" and ha.get("space", "root") == hb.get("space", "root") else None
                if at is not None:  # one place on the curve; the turn still blends
                    ch["hand_" + s] = {"a": {**ha, "at": at}, "b": {**hb, "at": at}, "t": te}
        Rp_w = rz(ch["root"][2]) @ body_rot(*ch["hips_turn"])
        hips_w = rz(ch["root"][2]) @ B2W @ np.asarray(ch["hips_at"]) + _rootpos(ch["root"])
        for side in ("l", "r"):
            fa, fb = _ground_foot(pa["foot_" + side], ra), _ground_foot(pb["foot_" + side], rb)
            air = fa["space"] == "hips" or fb["space"] == "hips"
            if not air:
                if fb.get("orbit") and A is not B:
                    c0 = _lerp(ra[:2], rb[:2], te)
                    at = _arc_point(fa["at"], fb["at"], te, (c0[0], c0[1]))
                    yaw = fa["yaw"] + (fb["yaw"] - fa["yaw"]) * te
                    heel = fa["heel"] + (fb["heel"] - fa["heel"]) * te
                else:
                    v = spl("foot_" + side, lambda: np.array([*_lerp(fa["at"], fb["at"], te), fa["yaw"] + (fb["yaw"] - fa["yaw"]) * te,
                                                              fa["heel"] + (fb["heel"] - fa["heel"]) * te]))
                    at, yaw, heel = v[:3], float(v[3]), float(v[4])
                dist = np.linalg.norm(np.asarray(fb["at"][:2], float) - np.asarray(fa["at"][:2], float))
                # A step from the floor to the floor clears it; a foot the beats already lift (z above
                # the floor at either end) keeps the heights it was given.
                grounded = abs(float(fa["at"][2])) < 1e-3 and abs(float(fb["at"][2])) < 1e-3
                lift = B.get("lift", craft.get("lift", 0.045 * body.height)) if (A is not B and dist > 0.03 and grounded) else 0.0
                tl = min(max(t, 0), 1)
                # any real step clears the floor: a short shuffle still lifts half the lift; sin² so
                # the foot leaves and meets the floor without a jolt
                at = at + np.array([0, 0, lift * min(1.0, max(0.5, dist / 0.3)) * math.sin(math.pi * tl) ** 2])
                world = B2W @ at + np.array([0, 0, ball_h])
                R = _heel_rot(yaw, heel)
            else:
                (wa, Ra_), (wb, Rb_) = (_foot_world_of(x, Rp_w, hips_w, ball_h) for x in (fa, fb))
                world = _lerp(wa, wb, te)
                R = slerp_rot(Ra_, Rb_, min(max(te, 0), 1))
                at = B2W.T @ (world - np.array([0, 0, ball_h]))
                yaw = fa["yaw"] + (fb["yaw"] - fa["yaw"]) * te
                heel = 0.0
            # A tucked foot (hips space) carries on from its shin; going to or from one, the foot
            # turns from the given orientation over to that one through the beat, never at once.
            ha_, hb_ = fa["space"] == "hips", fb["space"] == "hips"
            tc = min(max(te, 0), 1)
            shin = None
            if ha_ and hb_:
                shin = (fa.get("heel", 0) + (fb.get("heel", 0) - fa.get("heel", 0)) * te, 1.0)
            elif ha_:
                shin = (fa.get("heel", 0), 1.0 - tc)
            elif hb_:
                shin = (fb.get("heel", 0), tc)
            ch["foot_" + side] = {"at": at, "yaw": yaw, "heel": heel, "space": "ground", "air": air, "world": world, "R": R,
                                  "air_heel": shin}

            def kp(f, pole):
                return (Rp_w @ B2W @ np.asarray(pole, float)) if f["space"] == "hips" else (rz(ch["root"][2]) @ B2W @ np.asarray(pole, float))

            ch["knee_world_" + side] = unit(_lerp(kp(fa, pa["knee_" + side]), kp(fb, pb["knee_" + side]), te))
            ch["elbow_" + side] = unit(_lerp(pa["elbow_" + side], pb["elbow_" + side], te))
        frames.append(ch)
    return frames


def spring(xs, f_hz, zeta, fps, sub=8, loop=False, shift=None):
    """A second-order follower of a track: lag, then overshoot. A loop's (loop, or shift: the
    track's change over one cycle) runs three cycles and keeps the last, so it starts as it ends."""
    xs = np.asarray(xs, float)
    if (loop or shift is not None) and len(xs) > 2:
        cyc = xs[:-1]
        d = np.zeros_like(xs[0]) if shift is None else np.asarray(shift, float)
        out = spring(np.concatenate([cyc - d, cyc, cyc + d, xs[:1] + 2 * d]), f_hz, zeta, fps, sub)
        return out[len(cyc):] - d
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
        ch["blade"] = blade
        # The off hand letting go of the handle (or taking it) still counts as much as it holds,
        # so the roll does not jump the moment it starts to leave.
        ho = ch["hand_" + o]
        hold_o = 0.0
        if isinstance(ho, dict):
            hold_o = (1 - min(max(ho["t"], 0), 1)) if ho["a"] == "grip" else (min(max(ho["t"], 0), 1) if ho["b"] == "grip" else 0.0)
        best = None
        forced = ch.get("edge_force")
        if forced is not None:  # the roll chosen frame by frame, then smoothed over the clip
            e = unit(forced - np.dot(forced, blade) * blade)
            best = (0.0, e, hands_for(e))
        for k in range(0 if forced is not None else 36):
            e = axis_angle(blade, 10.0 * k) @ e0
            cand = hands_for(e)
            cost = 0.0
            for s in (m, o):
                share = 1.0 if (s == m or two) else hold_o
                if share <= 0:
                    continue
                w, H = cand[s]
                b = bend(s, w, H, wrist_pole(s, w, H))
                cost += share * (0.02 * b + max(0.0, b - 40.0) ** 2 / 50.0)
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


def _body_dir(ch, v):
    """A direction in the pelvis's frame at this frame (x right, y forward, z up)."""
    return rz(ch["root"][2]) @ body_rot(*ch["hips_turn"]) @ B2W @ np.asarray(v, float)


def _steady_pole(pole, S, G, fallback):
    """A pole that still names a side when it lines up with the limb: the part of the pole across
    the limb decides where the joint goes, and as that part shrinks its direction swings from
    frame to frame, so a body-relative fallback (elbows out and back, knees forward) takes over."""
    pole = unit(pole)
    u = unit(np.asarray(G, float) - np.asarray(S, float))
    across = float(np.linalg.norm(pole - np.dot(pole, u) * u))
    k = min(1.0, across / 0.5)
    return pole if k >= 1.0 else unit(pole * k + unit(fallback) * (1 - k))


def _hinge_normal(d1, d2, pole):
    """The plane a two-bone limb bends in. Bent, it is the bones' own plane; nearly straight that
    plane is noise, so it eases over to the plane two_bone bent it in (the pole's part across the
    limb), and a limb reaching full stretch never twists round in one frame."""
    u1, u2 = unit(d1), unit(d2)
    bent = np.cross(u1, u2)
    u = unit(np.asarray(d1, float) + np.asarray(d2, float))
    p = np.asarray(pole, float) - np.dot(pole, u) * u
    if np.linalg.norm(p) < 1e-6:
        return unit(bent) if np.linalg.norm(bent) > 1e-9 else unit(np.cross(u, [0, 0, 1.0]))
    by_pole = unit(np.cross(p, u))  # two_bone puts the middle joint toward p: the bones' plane, this way round
    w = min(1.0, float(np.linalg.norm(bent)) / math.sin(math.radians(12.0)))
    if w == 0:
        return by_pole
    bent = unit(bent)
    if np.dot(bent, by_pole) < 0:
        bent = -bent
    return unit(w * bent + (1 - w) * by_pole)


def _limb_rot(r, n, d, nrm):
    """The turn taking bone n's rest (direction, hinge) onto (d, nrm)."""
    return map_pair(r.L[n][:3, 1], rest_hinge(r.L, n), d, nrm)


def _arm(body, s, wrist, Hw, pole, P, ch):
    r = body.rig
    ua, la, h = "upperarm_" + s, "lowerarm_" + s, "hand_" + s
    S = r.head_under(ua, P)
    pole = _steady_pole(pole, S, wrist, _body_dir(ch, (1.0 if s == "r" else -1.0, -0.7, -0.3)))
    M, G, need = two_bone(S, wrist, body.upper, body.fore, pole)
    d1, d2 = M - S, G - M
    nrm = _hinge_normal(d1, d2, pole)
    r.posed(ua, _limb_rot(r, ua, d1, nrm), P)
    R2 = _limb_rot(r, la, d2, nrm)
    if isinstance(Hw, tuple):  # a free hand: neutral from its forearm, turned, or blended with a grip

        def res(x):
            return (R2 @ x[1] @ r.L[h][:3, :3]) if isinstance(x, tuple) else x

        Hw = res(Hw) if Hw[0] == "neutral" else slerp_rot(res(Hw[1]), res(Hw[2]), Hw[3])
    # the forearm takes half the hand's twist about it, so the wrist does not candy-wrap
    rel = (R2 @ r.L[la][:3, :3]).T @ Hw @ np.linalg.inv(r.L[h][:3, :3]) @ r.L[la][:3, :3]
    tw = swing_twist(rel, np.array([0, 1.0, 0]))
    # Unwrapped against the frame before: the twist crossing 180 degrees would turn the forearm a
    # half turn between two keys, and a game playing between them shows the hand spun round.
    prev = body.twist.get(s)
    if prev is not None:
        tw = prev + _wrapd(tw - prev)
    body.twist[s] = tw
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
    given = Rf
    for _ in range(2 if air_heel is not None else 1):
        ankle = ball_world - Rf @ body.ball_off[s]
        pole = _steady_pole(pole, S, ankle, _body_dir(ch, (0.15 if s == "r" else -0.15, 1.0, 0.0)))
        M, G, need = two_bone(S, ankle, body.thigh, body.calf, pole)
        d1, d2 = M - S, G - M
        nrm = _hinge_normal(d1, d2, pole)
        Rc_ = _limb_rot(r, ca, d2, nrm)
        if air_heel is not None:
            # a foot off the ground carries on from its shin, pointed by its heel value
            heel, w = air_heel
            shin = axis_angle(Rc_ @ rest_hinge(r.L, th), heel) @ Rc_
            Rf = shin if w >= 1 else slerp_rot(given, shin, w)
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


def _cycle(n, loop):
    """A loop's frames 0..N (frame N is frame 0 one cycle on): (N, the world shift per cycle)."""
    return n - 1, B2W @ np.array([loop[0], loop[1], 0.0])


def _feet_world(frames, body, craft, fps, loop=None):
    """Each foot's ball goal, locked to the ground through each stance and eased out of the lock.
    In a loop the stances run round the seam: a foot planted at the end is the same stance as the
    one planted at the start, one cycle on."""
    info = {"stances": {"l": 0, "r": 0}, "lockedFrames": {"l": 0, "r": 0}}
    n = len(frames)
    if loop is not None:
        N, S = _cycle(n, loop)
        ext = list(range(-N, 2 * N + 1))  # three cycles round the one keyed
    else:
        N, S = n, np.zeros(3)
        ext = list(range(n))

    def at(arr, q):
        k, r = divmod(q, N) if loop is not None else (0, q)
        return arr[r] + k * S if arr.ndim == 2 else arr[r]

    for s in "lr":
        pts = np.array([c["foot_" + s]["world"] for c in frames])
        if craft.get("lock_feet", True):
            # planted: low and slow (a foot gliding through a lunge is not locked)
            spd = np.r_[0.0, np.linalg.norm(np.diff(pts[:, :2], axis=0), axis=1) * fps]
            spd = np.minimum(spd, np.r_[spd[1:], spd[-1]])
            down = np.array([(not c["foot_" + s]["air"]) and (p[2] - body.ball_h) < 0.02 and v < craft.get("lock_speed", 0.5)
                             for c, p, v in zip(frames, pts, spd)])
            if loop is not None:
                spd[0] = spd[N] = min(spd[0], spd[N]) if N > 0 else spd[0]
            P = np.array([at(pts, q) for q in ext])
            D = np.array([bool(at(down, q)) for q in ext])
            m = len(ext)
            locked, weight = P.copy(), np.zeros(m)
            k = 0
            while k < m:
                if not D[k]:
                    k += 1
                    continue
                j = k
                while j + 1 < m and D[j + 1]:
                    j += 1
                anchor = np.median(P[k:j + 1], axis=0)
                anchor[2] = body.ball_h
                locked[k:j + 1] = anchor
                weight[k:j + 1] = 1.0
                q0 = ext[k]
                if loop is None or 0 <= q0 < N:  # a stance round the seam counts once
                    info["stances"][s] += 1
                info["lockedFrames"][s] += sum(1 for q in range(k, j + 1) if 0 <= ext[q] < (N if loop is not None else n))
                k = j + 1
            on = np.where(weight == 1)[0]
            out = pts.copy()
            off = ext.index(0)
            for q in range(n):
                e = q + off
                if weight[e] == 1:
                    out[q] = locked[e]
                elif len(on):
                    z = on[np.argmin(np.abs(on - e))]
                    if abs(z - e) <= EASE_LOCK:  # eased in and out of the lock on a smoothstep, so a lift never pops
                        b = 1 - abs(z - e) / (EASE_LOCK + 1)
                        b = b * b * (3 - 2 * b)
                        out[q] = pts[q] * (1 - b) + locked[z] * b
            pts = out
        for c, p in zip(frames, pts):
            c["foot_world_" + s] = p
    return info


def _hip_drop(frames, body, loop=None):
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
    # The most any leg needs within four frames, then a smoothing no wider than that: the drop is
    # whole wherever it is needed, starts before and eases off after, never stepping the pelvis.
    kern = np.exp(-0.5 * (np.arange(-4, 5) / 1.6) ** 2)
    kern /= kern.sum()
    if loop is not None and len(drops) > 2:  # the smoothing wraps round the seam
        cyc = drops[:-1]
        pad = np.r_[cyc[-4:], cyc, cyc[:4]]
        sm = np.array([pad[i:i + 9].max() for i in range(len(cyc))])
        pad = np.r_[sm[-4:], sm, sm[:4]]
        sm2 = np.convolve(pad, kern, mode="valid")
        sm2 = np.r_[sm2, sm2[:1]]
    else:
        sm = np.array([drops[max(0, i - 4):i + 5].max() for i in range(len(drops))])
        pad = np.r_[np.full(4, sm[0]), sm, np.full(4, sm[-1])]
        sm2 = np.maximum(np.convolve(pad, kern, mode="valid"), 0)
    for c, d in zip(frames, sm2):
        c["hips_at"] = np.asarray(c["hips_at"]) - np.array([0, 0, d])
    worst = int(np.argmax(drops)) if len(drops) else 0
    return float(drops.max()) if len(drops) else 0.0, int((drops > 1e-4).sum()), frames[worst]["frame"] if len(drops) else 0


def _overlap(frames, craft, fps, loop=False):
    ov = craft.get("overlap", {})
    if "chest" in ov:  # the chest trails the hips: its yaw in the world, pitch and roll relative, clamped
        f, z, clamp = ov["chest"]
        wy = spring(np.array([[c["root"][2] + c["hips_turn"][0] + c["chest"][0]] for c in frames]), f, z, fps, loop=loop)
        pr = spring(np.array([[c["chest"][1], c["chest"][2]] for c in frames]), f, z, fps, loop=loop)
        for c, y, p in zip(frames, wy, pr):
            lag = max(-clamp, min(clamp, y[0] - (c["root"][2] + c["hips_turn"][0] + c["chest"][0])))
            c["chest"] = np.array([c["chest"][0] + lag, p[0], p[1]])
    if "head" in ov:  # the head trails the chest
        f, z, clamp = ov["head"]

        def want(c):
            return np.array([c["root"][2] + c["hips_turn"][0] + c["chest"][0] + c["head"][0], c["chest"][1] + c["head"][1]])

        sm = spring(np.array([want(c) for c in frames]), f, z, fps, loop=loop)
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


def _free_hand_overlap(frames, body, craft, fps, loop=None):
    ov = craft.get("overlap", {}).get("hand")
    if ov is None:
        return
    for s in "lr":
        idx = [i for i, c in enumerate(frames) if c["hand_" + s] != "grip"]
        if len(idx) < 3:
            continue
        pos = np.array([solve_frame(body, frames[i])["hand_" + s][:3, 3] for i in idx])
        body.twist = {}
        periodic = loop is not None and len(idx) == len(frames)
        shift = _cycle(len(frames), loop)[1] if periodic else None
        for i, p in zip(idx, spring(pos, ov[0], ov[1], fps, shift=shift)):
            frames[i]["free_" + s] = p


def _smooth_roll(frames):
    """The held prop's roll as the search chose it each frame, measured against a reference carried
    along the blade from frame to frame, unwrapped, then cleaned of one- and two-frame flips (a
    near tie in the search) and smoothed, so the prop never spins between two keys."""
    runs, cur = [], []
    for i, c in enumerate(frames):
        if c.get("edge_final") is not None and c.get("blade") is not None:
            cur.append(i)
        elif cur:
            runs.append(cur)
            cur = []
    if cur:
        runs.append(cur)
    for run in runs:
        ref = np.asarray(frames[run[0]]["edge_final"], float)
        refs, phis = [], []
        for i in run:
            b = frames[i]["blade"]
            r_ = ref - np.dot(ref, b) * b
            ref = unit(r_) if np.linalg.norm(r_) > 1e-6 else unit(frames[i]["edge_final"])
            e = frames[i]["edge_final"]
            phis.append(math.atan2(float(np.dot(np.cross(ref, e), b)), float(np.dot(ref, e))))
            refs.append(ref)
        phi = np.unwrap(np.array(phis))
        if len(phi) >= 5:
            pad = np.r_[phi[:1], phi[:1], phi, phi[-1:], phi[-1:]]
            phi = np.array([np.median(pad[k:k + 5]) for k in range(len(phi))])
            for _ in range(2):
                pad = np.r_[phi[:1], phi, phi[-1:]]
                phi = 0.25 * pad[:-2] + 0.5 * pad[1:-1] + 0.25 * pad[2:]
        for i, ref, a in zip(run, refs, phi):
            frames[i]["edge_force"] = axis_angle(frames[i]["blade"], math.degrees(a)) @ ref


def _close_loop(spec, beats):
    """A loop's last beat is its first one cycle on: the same pose, the root (and the feet planted
    on the ground) moved by the cycle's travel. Returns the travel (x, y), or None for a one-shot."""
    if not spec.get("loop"):
        return None
    first, last = beats[0]["pose"], beats[-1]["pose"]
    r0, r1 = np.asarray(first["root"], float), np.asarray(last["root"], float)
    if abs(_wrapd(r1[2] - r0[2])) > 1e-6:
        raise Refused("invalid-input", "a loop ends facing the way it starts: give the last beat's root the first beat's yaw")
    travel = r1[:2] - r0[:2]
    closing = copy.deepcopy(first)
    closing["root"] = (float(r1[0]), float(r1[1]), float(r0[2]))
    for s in "lr":
        f = _ground_foot(first["foot_" + s], r0)
        if f["space"] == "ground":
            f["at"] = np.asarray(f["at"], float) + np.array([travel[0], travel[1], 0.0])
        closing["foot_" + s] = f
    beats[-1] = {**beats[-1], "pose": closing}
    return float(travel[0]), float(travel[1])


def _ypr(R):
    """(yaw, pitch, roll) degrees with body_rot(yaw, pitch, roll) == R."""
    pitch = math.degrees(math.asin(max(-1.0, min(1.0, float(R[2, 1])))))
    c = math.degrees(math.atan2(-float(R[2, 0]), float(R[2, 2])))
    yaw = math.degrees(math.atan2(-float(R[0, 1]), float(R[1, 1])))
    return (round(yaw, 2), round(pitch, 2), round(-c, 2))


def _pole(S, M, G):
    """The direction a middle joint points, off the line from S to G, in body space."""
    u = unit(G - S)
    d = (M - S) - np.dot(M - S, u) * u
    return tuple(round(float(x), 3) for x in unit(B2W.T @ d)) if np.linalg.norm(d) > 1e-5 else None


def _clip_pose(body, name):
    """A clip's first frame on this character as a named pose, so a move starts (or ends) where the
    game's idle or guard is and the crossfade between them has nothing to slide: the hips, chest
    and head, each foot where it stands, the knees and elbows, and the hands (on the held prop's
    handle when they hold it). None when the character has no such clip."""
    arm, r = body.arm, body.rig
    act = helpers.clip_of(arm, name)
    if act is None or "kurambit_spec" in act:
        return None
    P = _track(arm, act)[0]
    skeleton.assign_action(arm, None)
    for pb in arm.pose.bones:
        pb.matrix_basis = Matrix()
    bpy.context.view_layer.update()

    def delta(n):
        return P[n][:3, :3] @ r.L[n][:3, :3].T

    Rp = delta("pelvis")
    hips = {"at": tuple(round(float(x), 4) for x in B2W.T @ P["pelvis"][:3, 3]), "turn": _ypr(Rp)}
    Rc_ = Rp.T @ delta("spine_03")
    chest = _ypr(Rc_)
    Rc = Rp @ body_rot(*chest)
    # No root, and the feet relative to it: a closing beat naming the pose ends where the move went.
    pose = {"hips": hips, "chest": chest, "head": _ypr(Rc.T @ delta("Head")), "look": None}
    for s in "lr":
        ball = B2W.T @ P["ball_" + s][:3, 3]
        Rf = delta("foot_" + s)
        fb = B2W.T @ (Rf @ B2W @ np.array([0, 1.0, 0]))
        yaw = math.degrees(math.atan2(-fb[0], fb[1]))
        tilt = math.degrees(math.asin(max(-1.0, min(1.0, float(fb[2])))))
        heel = min((tilt, -tilt), key=lambda h: np.linalg.norm(_heel_rot(yaw, h) - Rf))
        z = float(ball[2] - body.ball_h)
        pose["foot_" + s] = {"at": (round(float(ball[0]), 4), round(float(ball[1]), 4), 0.0 if z < 0.02 else round(z, 4)),
                             "yaw": round(yaw, 2), "heel": round(heel, 2), "space": "root"}
        knee = _pole(P["thigh_" + s][:3, 3], P["calf_" + s][:3, 3], P["foot_" + s][:3, 3])
        elbow = _pole(P["upperarm_" + s][:3, 3], P["lowerarm_" + s][:3, 3], P["hand_" + s][:3, 3])
        stand = body.stand()
        pose["knee_" + s] = knee or stand["knee_" + s]
        pose["elbow_" + s] = elbow or stand["elbow_" + s]
        R2 = delta("lowerarm_" + s) @ r.L["lowerarm_" + s][:3, :3]
        turn = _ypr(R2.T @ P["hand_" + s][:3, :3] @ r.L["hand_" + s][:3, :3].T)
        pose["hand_" + s] = {"at": tuple(round(float(x), 4) for x in B2W.T @ P["hand_" + s][:3, 3]), "space": "root", "turn": turn}
    if body.prop is not None:
        m, o, pr = body.main, body.off, body.prop
        Hm = P["hand_" + m][:3, :3]
        grip = P["hand_" + m][:3, 3] + Hm @ pr["grip"]
        blade = unit(Hm @ pr["axis"])
        pose["prop"] = {"grip": tuple(round(float(x), 4) for x in B2W.T @ grip), "tip": tuple(round(float(x), 4) for x in B2W.T @ blade),
                        "edge": None, "space": "root"}
        pose["hand_" + m] = "grip"
        Ho = P["hand_" + o][:3, :3]
        held = (grip - blade * body.second) - Ho @ pr["grip_off"]
        if np.linalg.norm(held - P["hand_" + o][:3, 3]) < 0.04:
            pose["hand_" + o] = "grip"
    return pose


def compile_move(body, spec, fps):
    """(frames, armature-space poses, compile report) for a spec on a body. A loop is keyed in place:
    its travel comes off the pelvis, so frame N is frame 0 and the game moves the character at the
    clip's measured ground speed."""
    craft = dict(spec.get("craft", {}))
    library = {"stand": body.stand(), **(spec.get("poses") or {})}
    # A pose named for one of the character's clips (its idle, its guard) is that clip's first frame.
    for name in [spec.get("start")] + [b.get("pose") for b in spec.get("beats") or [] if isinstance(b, dict)]:
        if isinstance(name, str) and name not in library:
            got = _clip_pose(body, name)
            if got is not None:
                library[name] = got
    _check(spec, library, body)
    beats = resolve_beats(spec, library)
    loop = _close_loop(spec, beats)
    t0 = beats[0]["at"]
    report_eased = {b["at"] - t0: b["ease"] for b in beats[1:] if b.get("ease", craft.get("ease", "smooth")) != "smooth" and "ease" in b}
    frames = sample(beats, craft, body, loop)
    body.stretch = {}
    body.twist = {}
    report = {"frames": len(frames), "eased": report_eased}
    for c in frames:
        c["clearance"] = craft.get("clearance", body.clearance)
    if craft.get("pivot", True):
        _pivots(frames)
    if body.prop is not None:
        _edge_auto(frames, fps)
    _look(frames, body)
    _overlap(frames, craft, fps, loop is not None)
    report["footLock"] = _feet_world(frames, body, craft, fps, loop)
    if craft.get("hip_drop", True):
        mx, n, at = _hip_drop(frames, body, loop)
        report["hipDrop"] = {"maxCm": round(mx * 100, 1), "frames": n, "worstFrame": at - frames[0]["frame"]}
    _free_hand_overlap(frames, body, craft, fps, loop)

    def solve_all():
        body.twist = {}
        out, prev = [], None
        for c in frames:
            c["edge_prev"] = prev
            out.append(solve_frame(body, c))
            prev = c.get("edge_final")
        return out

    poses = solve_all()
    if body.prop is not None:  # the roll, chosen per frame above, smoothed over the clip and solved again
        _smooth_roll(frames)
        body.stretch = {}
        poses = solve_all()
    if loop is not None:
        N, S = _cycle(len(poses), loop)
        for i, P in enumerate(poses):
            d = S * (i / N)
            for n in P:
                if n != "root":
                    P[n] = P[n].copy()
                    P[n][:3, 3] -= d
        poses[-1] = poses[0]
        report["loop"] = {"travel": [round(loop[0], 4), round(loop[1], 4)], "travelM": round(float(np.linalg.norm(loop)), 3),
                          "groundSpeed": round(float(np.linalg.norm(loop)) * fps / N, 3)}
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


def _moved(m, d):
    m = np.array(m)
    m[:3, 3] += d
    return m


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


def _beat_at(report, frame):
    eased = report.get("eased", {})
    near = [b for b in eased if abs(b - frame) <= 1]
    return f" (beat {near[0]}, ease {eased[near[0]]})" if near else ""


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
    sm = (res.get("smoothness") or {}).get("pops") or {}
    for p in sm.get("fastTurns", [])[:2]:
        out.append(f"spin: {p['bone']} turns {p['deg']}° against its parent from frame {p['frame'] - 1} to {p['frame']}; a game draws frames between keys and shows that as a spin. Give that change more frames")
    if sm.get("count"):
        out.append("pop: " + "; ".join(f"{p['bone']} jumps {p['deg']}° for one frame at frame {p['frame']}{_beat_at(report, p['frame'])}" for p in sm["worst"][:3])
                   + f" ({sm['count']} in all). Two beats too close for the change between them, or a named ease (in, out, linear) meeting another, break the motion there")
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
        if report.get("loop"):  # measured travelling, as the game shows it moving at the ground speed
            N, S = _cycle(len(played), report["loop"]["travel"])
            played = [{n: (m if n == "root" else _moved(m, S * (i / N))) for n, m in P.items()} for i, P in enumerate(played)]
            stand = None
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
        "- pops (a bone one frame out of line) and spins (a bone turning 90° or more against its parent in one frame): "
        + _pair(m, b, lambda x: f"{x['smoothness'].get('pops', {}).get('count', 0)} pops, {x['smoothness'].get('pops', {}).get('fastCount', 0)} spins"),
        ("- loop: keyed in place, {travelM} m a cycle at {groundSpeed} m/s; the export measures that ground speed, so play it with moveSpeed".format(**r["compile"]["loop"])
         if r["compile"].get("loop") else "- start/end against the start pose: " + seam(m)),
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
