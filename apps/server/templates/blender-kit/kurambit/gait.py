"""Procedural motion for a creature on its own rig, as numbers per frame: walk, trot, run and hop
from leg phase offsets, stride and body bob, with tail and ear follow-through; plus an idle
(breathing), a look-around and a sit. creature.py turns the numbers into keys.

Pure numpy and math (no bpy), so the gait math is testable on its own.

Space is the armature's: the creature faces -Y, +X is its left, Z up, metres, its feet on z = 0.
A loop is in place: the game moves the body, so a planted foot slides back at exactly the ground
speed (stride over stance time) and plays without skating at moveSpeed / groundSpeed.

A leg is {"name", "foot": (x, y, z) its rest contact point, "front": bool, "side": +1 left / -1
right, "length": hip to ground, metres}. Phase offsets name when each foot lands, as a share of
the cycle; duty is the share of the cycle a foot is planted.
"""
import math

import numpy as np

# Offsets per leg role. Quadrupeds: the walk is a lateral sequence (hind, then the front on that
# side), the trot moves diagonal pairs together, the run is a rotary gallop (hinds close together,
# then the fronts), the hop a pronk. Two legs: alternate, or together for a hop.
GAITS = {
    "walk": {"duty": 0.68, "froude": 0.15, "stride": 1.2, "lift": 0.22, "bob": 0.035, "crouch": 0.04,
             "quad": {("hind", 1): 0.0, ("front", 1): 0.25, ("hind", -1): 0.5, ("front", -1): 0.75},
             "biped": {1: 0.0, -1: 0.5}},
    "trot": {"duty": 0.5, "froude": 0.6, "stride": 1.5, "lift": 0.3, "bob": 0.05, "crouch": 0.07,
             "quad": {("hind", 1): 0.0, ("front", -1): 0.0, ("hind", -1): 0.5, ("front", 1): 0.5},
             "biped": {1: 0.0, -1: 0.5}},
    "run": {"duty": 0.36, "froude": 2.0, "stride": 1.9, "lift": 0.38, "bob": 0.07, "crouch": 0.12,
            "quad": {("hind", 1): 0.0, ("hind", -1): 0.1, ("front", 1): 0.5, ("front", -1): 0.6},
            "biped": {1: 0.0, -1: 0.5}},
    "hop": {"duty": 0.42, "froude": 0.5, "stride": 1.0, "lift": 0.25, "bob": 0.0, "crouch": 0.0,
            "quad": {("hind", 1): 0.0, ("hind", -1): 0.0, ("front", 1): 0.0, ("front", -1): 0.0},
            "biped": {1: 0.0, -1: 0.0}},
}
G = 9.81
FORWARD = np.array([0.0, -1.0, 0.0])


def smooth(u):
    u = min(1.0, max(0.0, u))
    return u * u * (3 - 2 * u)


def hermite(p0, p1, m0, m1, u):
    u2, u3 = u * u, u * u * u
    return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * m1


def offsets(legs, gait):
    """Each leg's landing phase for the gait, by its role (front or hind, its side)."""
    table = GAITS[gait]
    if len(legs) <= 2:
        return [table["biped"].get(1 if leg["side"] >= 0 else -1, 0.0) for leg in legs]
    if len(legs) > 4:
        # Six legs and more (an insect, a spider, a crab): each leg lands half a cycle after the
        # one ahead of it and the one across from it, so the body always stands on alternate legs.
        out = [0.0] * len(legs)
        for side in (1, -1):
            mine = sorted((i for i, leg in enumerate(legs) if (leg["side"] >= 0) == (side > 0)), key=lambda i: legs[i]["foot"][1])
            for rank, i in enumerate(mine):
                out[i] = 0.0 if gait == "hop" else ((rank + (0 if side > 0 else 1)) % 2) * 0.5
        return out
    out = []
    for leg in legs:
        key = ("front" if leg["front"] else "hind", 1 if leg["side"] >= 0 else -1)
        base = table["quad"][key]
        out.append(base)
    return out


def timing(leg_length, gait, fps, stride=None, seconds=None):
    """(frames, stride, ground speed) for one cycle: from the Froude number of the gait when not
    given (V = sqrt(Fr g L)), the cycle a whole number of frames, the speed made exact from it."""
    table = GAITS[gait]
    L = max(0.02, float(leg_length))
    S = float(stride) if stride is not None else table["stride"] * L
    if seconds is None:
        # The cadence of the gait's natural stride: a shorter stride (legs that reach less) keeps
        # the cadence and moves slower, as a small-stepping animal does.
        V = math.sqrt(table["froude"] * G * L)
        seconds = table["stride"] * L / (table["duty"] * V) if gait != "hop" else 2 * math.sqrt(2 * table["lift"] * L / G) / (1 - table["duty"]) + 0.25
    frames = max(8, int(round(seconds * fps)))
    T = frames / fps
    V = S / (table["duty"] * T)
    return frames, S, V


def foot_track(phase, duty, stride, lift, push=0.5):
    """(forward offset from the foot's rest, height, swing share or -1 in stance) at phase 0..1
    after landing. Stance sweeps +stride/2 to -stride/2 at constant speed; the swing returns along
    a Hermite curve that leaves and lands at the stance's speed (scaled by push), lifted by a sine."""
    phase %= 1.0
    if phase < duty:
        return stride / 2 - stride * phase / duty, 0.0, -1.0
    u = (phase - duty) / (1 - duty)
    m = -min(push * (1 - duty) / duty, 0.5) * stride
    f = hermite(-stride / 2, stride / 2, m, m, u)
    return f, lift * math.sin(math.pi * u) ** 1.2, u


def walk_cycle(legs, gait="walk", fps=30, stride=None, seconds=None, lift=None, bob=None, tail=0, ears=0, size=0.3, crouch=None):
    """One loop of the gait as frames (frame 0 and the frame after the last are the same pose):
    {"frames": n, "groundSpeed": m/s, "stride": m, "poses": [pose]}. A pose:
        body   {"at": (x, y, z) offset from rest, "pitch", "roll", "yaw"} degrees; pitch > 0 nose up
        feet   {name: {"at": (x, y, z) the contact point, "roll": toe roll degrees, "planted": bool}}
        tail   [(yaw, pitch)] per tail bone, degrees
        ears   [(yaw, pitch)] per ear bone, degrees
    A body with no legs (a hopping spirit) takes size, metres, for the leg length its hop scales by;
    crouch (a share of leg length) lowers the body so straight legs can reach a stride.
    """
    if gait not in GAITS:
        raise ValueError(f"gait {gait!r}: one of {', '.join(GAITS)}")
    table = GAITS[gait]
    L = float(np.mean([leg["length"] for leg in legs])) if legs else float(size)
    frames, S, V = timing(L, gait, fps, stride, seconds)
    H = (table["lift"] if lift is None else lift) * L
    A = (table["bob"] if bob is None else bob) * L
    duty = table["duty"]
    phases = offsets(legs, gait)
    hind = [i for i, leg in enumerate(legs) if not leg["front"]] or list(range(len(legs)))
    front = [i for i, leg in enumerate(legs) if leg["front"]] or hind
    length = 0.0
    if legs and front != hind:
        length = abs(np.mean([legs[i]["foot"][1] for i in front]) - np.mean([legs[i]["foot"][1] for i in hind]))
    poses = []
    for k in range(frames):
        t = k / frames
        feet, lifts = {}, []
        for leg, off in zip(legs, phases):
            f, z, u = foot_track(t - off, duty, S, H)
            at = np.asarray(leg["foot"], float) + FORWARD * f + np.array([0, 0, z])
            feet[leg["name"]] = {"at": tuple(at), "roll": 0.0 if u < 0 else 35.0 * math.sin(math.pi * min(1.0, u * 1.6)),
                                 "planted": u < 0}
            lifts.append(z / H if H > 0 else 0.0)
        # Each group of legs vaults its end of the body: high mid-stance in a walk, low in a trot or
        # run (the legs give), lifted in a run's flight.
        def group(ids):
            vals = []
            for i in ids:
                ph = (t - phases[i]) % 1.0
                if ph < duty:
                    s = math.sin(math.pi * ph / duty)
                    vals.append(s if gait == "walk" else -s)
                else:
                    vals.append(0.0 if gait == "walk" else 0.5 * math.sin(math.pi * (ph - duty) / (1 - duty)))
            return float(np.mean(vals)) if vals else 0.0
        hz, fz = group(hind), group(front)
        if gait == "hop":
            ph = t % 1.0
            air = 0.0 if ph < duty else math.sin(math.pi * (ph - duty) / (1 - duty))
            # A crouch while planted (landing, then the push), height in the air.
            crouch = math.sin(math.pi * ph / duty) if ph < duty else 0.0
            z = air * H * 1.6 - crouch * 0.12 * L
            pitch = -8.0 * air + 6.0 * crouch
        else:
            z = A * (hz + fz) / 2 - (table["crouch"] if crouch is None else crouch) * L
            pitch = math.degrees(math.atan2(A * (fz - hz), length)) if length > 1e-6 else 0.0
        stance_side = sum(leg["side"] * (1.0 if feet[leg["name"]]["planted"] else 0.0) for leg in legs)
        roll = 3.0 * stance_side / max(1, len(legs)) * (1.0 if gait == "walk" else 0.5)
        sway = 0.0
        if len(legs) <= 2 and gait != "hop":
            sway = 0.04 * L * math.sin(2 * math.pi * (t - phases[0] - duty / 2)) * (1 if legs and legs[0]["side"] > 0 else -1)
        poses.append({"body": {"at": (sway, 0.0, z), "pitch": pitch, "roll": roll, "yaw": 0.0}, "feet": feet,
                      "_z": z})
    zs = np.array([p.pop("_z") for p in poses])
    zn = zs / (np.max(np.abs(zs)) or 1.0)
    for k, p in enumerate(poses):
        t = k / frames
        p["tail"] = follow(zn, k, tail, frames, sway=12.0 if gait != "hop" else 4.0, lift=18.0, t=t, cycles=1)
        p["ears"] = follow(zn, k, ears, frames, sway=0.0, lift=14.0, t=t, cycles=1, lag=0.12)
    return {"frames": frames, "groundSpeed": V, "stride": S, "poses": poses}


def follow(signal, k, bones, frames, sway, lift, t, cycles=1, lag=0.08):
    """Follow-through down a chain: each bone answers the body's height a little later than the one
    before (pitch, opposite to the motion: it trails) and sways side to side, later toward the tip."""
    out = []
    for b in range(bones):
        d = (b + 1) * lag
        j = int(round((k - d * frames))) % frames
        share = (b + 1) / bones
        pitch = -lift * signal[j] * share
        yaw = sway * math.sin(2 * math.pi * cycles * (t - d)) * share
        out.append((yaw, pitch))
    return out


def idle(legs, fps=30, seconds=3.0, tail=0, ears=0, breath=0.012):
    """A breathing loop: the body rises and falls (breath, a share of leg length), the head nods a
    little after it, the tail sways slowly, and one ear flicks once."""
    L = float(np.mean([leg["length"] for leg in legs])) if legs else 0.3
    frames = max(24, int(round(seconds * fps)))
    poses = []
    for k in range(frames):
        t = k / frames
        b = 0.5 - 0.5 * math.cos(2 * math.pi * t)
        flick = math.exp(-((t - 0.62) * 22) ** 2)
        ear = [(18.0 * flick * (i + 1) / ears, -2.0 * b) for i in range(ears)]
        poses.append({
            "body": {"at": (0.0, 0.0, breath * L * b), "pitch": 1.2 * b, "roll": 0.0, "yaw": 0.0},
            "feet": {leg["name"]: {"at": tuple(leg["foot"]), "roll": 0.0, "planted": True} for leg in legs},
            "head": (0.0, -2.0 * math.sin(2 * math.pi * (t - 0.1))),
            "tail": [(14.0 * math.sin(2 * math.pi * (t - 0.08 * i)) * (i + 1) / max(1, tail), 3.0 * b) for i in range(tail)],
            "ears": ear,
        })
    return {"frames": frames, "groundSpeed": 0.0, "stride": 0.0, "poses": poses}


def look_around(legs, fps=30, seconds=4.0, tail=0, ears=0, yaw=40.0):
    """A one-shot: the head turns to one side, holds, to the other, holds, and back."""
    frames = max(24, int(round(seconds * fps)))
    beats = [(0.0, 0.0), (0.18, yaw), (0.42, yaw), (0.6, -yaw), (0.82, -yaw), (1.0, 0.0)]
    poses = []
    for k in range(frames + 1):
        t = k / frames
        for (t0, a0), (t1, a1) in zip(beats, beats[1:]):
            if t0 <= t <= t1:
                y = a0 + (a1 - a0) * smooth((t - t0) / (t1 - t0) if t1 > t0 else 1.0)
                break
        poses.append({
            "body": {"at": (0.0, 0.0, 0.0), "pitch": 0.0, "roll": 0.0, "yaw": 0.12 * y},
            "feet": {leg["name"]: {"at": tuple(leg["foot"]), "roll": 0.0, "planted": True} for leg in legs},
            "head": (y, 4.0 * abs(y) / max(1.0, yaw)),
            "tail": [(-0.3 * y * (i + 1) / max(1, tail), 0.0) for i in range(tail)],
            "ears": [(0.0, 6.0 * abs(y) / max(1.0, yaw))] * ears,
        })
    return {"frames": frames + 1, "groundSpeed": 0.0, "stride": 0.0, "poses": poses, "once": True}


def sit(legs, fps=30, seconds=1.0, tail=0, ears=0):
    """A one-shot into a sit, held at its end: the hips go down and back over the planted hind feet
    and the body pitches up on straight front legs; a two-legged body crouches instead."""
    frames = max(12, int(round(seconds * fps)))
    hind = [leg for leg in legs if not leg["front"]] or legs
    front = [leg for leg in legs if leg["front"]]
    Lh = float(np.mean([leg["length"] for leg in hind])) if hind else 0.3
    length = 0.0
    if front and hind:
        length = abs(np.mean([leg["foot"][1] for leg in front]) - np.mean([leg["foot"][1] for leg in hind]))
    poses = []
    for k in range(frames + 1):
        u = smooth(k / frames)
        # A little overshoot at the bottom, then it settles.
        settle = u + 0.06 * math.sin(math.pi * min(1.0, k / frames * 1.25)) * (1 - u)
        if front:
            # The haunches come down most of the hind leg's height; the chest pitches up just
            # enough that the front legs stay straight under it.
            drop = 0.7 * Lh * settle
            pitch = math.degrees(math.asin(min(1.0, drop / (length or Lh))))
            at = (0.0, 0.1 * Lh * settle, -drop)
        else:
            drop = 0.35 * Lh * settle
            pitch, at = 8.0 * settle, (0.0, 0.05 * Lh * settle, -drop)
        poses.append({
            "body": {"at": at, "pitch": pitch, "roll": 0.0, "yaw": 0.0, "pivot": "rear" if front else "centre"},
            "feet": {leg["name"]: {"at": tuple(leg["foot"]), "roll": 0.0, "planted": True} for leg in legs},
            "head": (0.0, -0.7 * pitch),
            "tail": [(35.0 * settle * (i + 1) / max(1, tail), -10.0 * settle) for i in range(tail)],
            "ears": [(0.0, 4.0 * settle)] * ears,
        })
    return {"frames": frames + 1, "groundSpeed": 0.0, "stride": 0.0, "poses": poses, "once": True}


def float_bob(fps=30, seconds=2.4, height=0.05, tail=0, ears=0):
    """A hover loop for a floating body: up and down, a slow tilt, the tail trailing behind."""
    frames = max(24, int(round(seconds * fps)))
    zs = np.array([math.sin(2 * math.pi * k / frames) for k in range(frames)])
    poses = []
    for k in range(frames):
        t = k / frames
        poses.append({
            "body": {"at": (0.0, 0.0, height * zs[k]), "pitch": 3.0 * math.cos(2 * math.pi * t), "roll": 2.0 * math.sin(2 * math.pi * t),
                     "yaw": 0.0},
            "feet": {},
            "tail": follow(zs, k, tail, frames, sway=10.0, lift=14.0, t=t, lag=0.1),
            "ears": follow(zs, k, ears, frames, sway=0.0, lift=10.0, t=t, lag=0.12),
        })
    return {"frames": frames, "groundSpeed": 0.0, "stride": 0.0, "poses": poses}


def wave(lengths, fps=30, seconds=1.0, sweep=16.0, waves=0.8, grow=0.75, tail=0, steady=0.7):
    """A loop of a wave running down a legless body, front to rear, for a swim or a slither.
    lengths: its spine's segments rear to front, metres. Each joint turns up to sweep degrees, the
    rear grow times more than the front; waves is how many wavelengths the body holds. The body is
    turned and shifted so its front keeps its heading and steady of its line (a fish's head hardly
    sways; its tail does the work). A pose's "spine" is each joint's yaw, rear to front, and its
    tail carries the wave on. groundSpeed: 0.6 body lengths a cycle."""
    n = len(lengths)
    frames = max(8, int(round(seconds * fps)))
    poses = []
    for k in range(frames):
        t = k / frames
        rel = [sweep * (1 + grow * (1 - i / max(1, n - 1))) / (1 + grow) * math.sin(2 * math.pi * (t + waves * i / max(1, n))) for i in range(1, n)]
        yaw0 = -sum(rel)
        heading, x = yaw0, 0.0
        for i, length in enumerate(lengths):
            if i > 0:
                heading += rel[i - 1]
            x += length * math.sin(math.radians(heading))
        poses.append({
            "body": {"at": (-steady * x, 0.0, 0.0), "pitch": 0.0, "roll": 0.0, "yaw": yaw0, "pivot": "rear"},
            "feet": {},
            "spine": rel,
            "tail": [(1.3 * sweep * math.sin(2 * math.pi * (t - waves * (j + 1) / max(1, n))), 0.0) for j in range(tail)],
            "ears": [],
        })
    return {"frames": frames, "groundSpeed": 0.6 * float(sum(lengths)) / (frames / fps), "stride": 0.0, "poses": poses}


def flap(feet, fps=30, seconds=0.6, lift=45.0, height=0.0, wing=3, tail=0):
    """A wing-beat loop: each wing bone lifts and falls (lift degrees at the shoulder, the outer
    bones a beat behind, so the tip whips), the body rising on the downstroke; height lifts it off
    the ground with its legs hanging. A pose's "wings" is (sweep, lift) per wing bone, degrees."""
    frames = max(8, int(round(seconds * fps)))
    poses = []
    for k in range(frames):
        t = k / frames
        z = height + 0.06 * max(height, 0.1) * math.sin(2 * math.pi * (t + 0.25))
        poses.append({
            "body": {"at": (0.0, 0.0, z), "pitch": 4.0 * math.sin(2 * math.pi * t), "roll": 0.0, "yaw": 0.0},
            "feet": {name: {"at": (at[0], at[1], at[2] + z), "roll": 20.0 if height > 0 else 0.0, "planted": False} for name, at in feet.items()} if height > 0 else {},
            "wings": [(0.0, lift * (1.0 if j == 0 else 0.55) * math.sin(2 * math.pi * (t - 0.12 * j))) for j in range(wing)],
            "tail": [(0.0, 6.0 * math.sin(2 * math.pi * (t - 0.1 * (j + 1)))) for j in range(tail)],
            "ears": [],
        })
    return {"frames": frames, "groundSpeed": 0.0, "stride": 0.0, "poses": poses}


def slide(track, planted, ground_speed, fps, forward=FORWARD):
    """The worst slide of a foot while planted, metres: over each planted span, how far the foot
    strays from the path a planted foot takes when the clip plays at ground speed (sliding back at
    exactly that speed). track is (frames, 3) in the clip's in-place space."""
    track = np.asarray(track, float)
    planted = np.asarray(planted, bool)
    n = len(track)
    worst, at = 0.0, None
    k = 0
    while k < n:
        if not planted[k]:
            k += 1
            continue
        j = k
        while j + 1 < n and planted[j + 1]:
            j += 1
        if j > k:
            steps = np.arange(j - k + 1) / fps
            ideal = track[k] - np.outer(steps, np.asarray(forward, float) * ground_speed)
            off = np.linalg.norm((track[k:j + 1] - ideal)[:, :2], axis=1)
            if off.max() > worst:
                worst, at = float(off.max()), k + int(np.argmax(off))
        k = j + 1
    return worst, at
