"""face_of(): how a made character blinks, read off its armature for the sidecar's face.

Bones only, never morph targets: they survive compression and every engine plays them the same.
The eye helpers (helpers.eye_lid, helpers.eye_squash) name the bones, and the name is the record
(the export writes no custom properties): blink_lid_<side> turns a lid shut, blink_eye_<side>
squashes a painted eye, blink_shine_<side> hides its highlights. How a lid closes is measured,
never assumed, here on whatever scene holds the armature (the live one, or the candidate GLB
imported for the measure), so the sidecar describes the bytes that ship.

A bone's axes are its own (Blender's bone frame, which the glTF node keeps both ways), so an engine
turns the bone's local rotation by the same axis and angle."""
import math

import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

KINDS = {"lid": "turn", "eye": "squash", "shine": "hide"}
SQUASHED = 0.1  # the scale a painted eye keeps along the face's up axis, shut
FULL = 0.98     # the share of the eye's rays a shut lid must stop
STEP = 5        # degrees between the turns tried


def _weighted(arm, bone):
    """World rest positions of the vertices bound wholly to bone, and the polygons among them."""
    from . import helpers

    points, polys = [], []
    for o in bpy.context.scene.objects:
        if o.type != "MESH" or arm not in helpers._deforming(o):
            continue
        group = o.vertex_groups.get(bone)
        if group is None:
            continue
        co, faces = helpers.rest_coords(o)
        if len(co) != len(o.data.vertices):
            continue
        mine = {}
        for v in o.data.vertices:
            for g in v.groups:
                if g.group == group.index and g.weight >= 0.99:
                    mine[v.index] = len(points) + len(mine)
        if not mine:
            continue
        base = len(points)
        order = sorted(mine)
        index = {v: base + i for i, v in enumerate(order)}
        points += [Vector(co[v]) for v in order]
        polys += [tuple(index[v] for v in f) for f in faces if all(v in index for v in f)]
    return points, polys


def _frame(arm, bone):
    m = arm.matrix_world @ arm.data.bones[bone].matrix_local
    r = m.to_3x3().normalized()
    return m.translation.copy(), [r.col[i].copy() for i in range(3)]


def lid_turn(arm, bone):
    """(axis, radians) that shut the lid on bone over its eye, or None when no turn about the
    bone's x or z does. The eye looks along the bone (its y): rays from in front of it, over a
    disk as wide as the lid's inside, must hit the turned lid. Of the turns that stop the most,
    the middle of the run is the one kept (the lid centred on the eye), the shorter way round."""
    points, polys = _weighted(arm, bone)
    if len(points) < 4 or not polys:
        return None
    centre, axes = _frame(arm, bone)
    look = axes[1]
    inner = min((p - centre).length for p in points)
    if inner <= 1e-6:
        return None
    tree = BVHTree.FromPolygons(points, polys)
    rays = []
    for i in range(-4, 5):
        for j in range(-4, 5):
            u, v = i / 4 * 0.8 * inner, j / 4 * 0.8 * inner
            if u * u + v * v <= (0.8 * inner) ** 2:
                rays.append(centre + look * 3 * inner + axes[0] * u + axes[2] * v)
    best = None
    for name, axis in (("x", axes[0]), ("z", axes[2])):
        for sign in (1, -1):
            cover = []
            for deg in range(STEP, 181, STEP):
                # The lid turned by +a is the rays turned by -a about the eye's centre.
                q = Matrix.Rotation(-math.radians(sign * deg), 3, axis)
                d = q @ -look
                hits = sum(1 for o in rays if tree.ray_cast(centre + q @ (o - centre), d, 3 * inner)[0] is not None)
                cover.append(hits / len(rays))
            top = max(cover)
            if top < FULL:
                continue
            first = cover.index(top)
            last = first
            while last + 1 < len(cover) and cover[last + 1] >= top:
                last += 1
            deg = STEP * (first + last + 2) / 2
            if best is None or (top, -deg) > (best[0], -best[2]):
                best = (top, name, deg, sign)
    if best is None:
        return None
    return best[1], round(best[3] * math.radians(best[2]), 4)


def squash_axis(arm, bone):
    """The bone's own axis that runs nearest the face's up (world up at rest)."""
    _, axes = _frame(arm, bone)
    return "xyz"[max(range(3), key=lambda i: abs(axes[i].z))]


def blink_of(arm, bone):
    """The GameModelBlink of one blink_ bone, or None (a lid that never shuts)."""
    kind = KINDS.get(bone.split("_")[1] if bone.count("_") >= 2 else "")
    if kind == "turn":
        turn = lid_turn(arm, bone)
        return None if turn is None else {"bone": bone, "kind": "turn", "axis": turn[0], "amount": turn[1]}
    if kind == "squash":
        return {"bone": bone, "kind": "squash", "axis": squash_axis(arm, bone), "amount": SQUASHED}
    if kind == "hide":
        return {"bone": bone, "kind": "hide", "axis": "x", "amount": 0.0}
    return None


def face_of(arm):
    blinks = [b for b in (blink_of(arm, bone.name) for bone in arm.data.bones if bone.name.startswith("blink_")) if b is not None]
    return {"blink": blinks[:8]} if blinks else None
