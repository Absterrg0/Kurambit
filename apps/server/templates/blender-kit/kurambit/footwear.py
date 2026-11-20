"""footwear(): shoes and boots made for the feet they go on.

A boot cut from the skin of a foot is a second skin: five toes show through it and it has no sole.
Footwear here is its own shape, measured off the foot at rest: an upper lofted along the foot from
heel to toe, as wide and as high at each station as the foot is there plus its ease, with one
rounded (or pointed) toe; a sole under it, a welt wider, flat on the ground, in its own colour; and
for a boot a shaft up the shin, round the calf at each height. It bends at the ankle and the ball
with the foot's own joints, and the skin inside it is left out of the export.

Space: the character at rest, facing -Y, +X its left, metres.
"""
import math

import bpy
import numpy as np

from . import cloth, helpers

KINDS = ("boots", "shoes")
TOES = ("round", "pointed", "square")
SIDES = ("l", "r")
STATIONS = 11
ROUND = 12


def _darker(hex_colour, k):
    return "#" + "".join(f"{round(int(hex_colour[i:i + 2], 16) * k):02x}" for i in (1, 3, 5))


def _ring(centre, f, r, width, low, high, box):
    """One closed section of the upper across the foot: flat under, rounded over."""
    mid = low + 0.42 * (high - low)
    out = []
    for i in range(ROUND):
        t = 2 * math.pi * i / ROUND
        c, s = math.cos(t), math.sin(t)
        x = width * math.copysign(abs(c) ** box, c)
        z = mid + ((high - mid) * abs(s) ** 0.8 if s >= 0 else -(mid - low) * abs(s) ** 0.25)
        out.append(centre + r * x + np.array([0.0, 0.0, z]))
    return out


def _tube(rings, cap_first, cap_last):
    verts = [p for ring in rings for p in ring]
    n = len(rings[0])
    faces = []
    for k in range(len(rings) - 1):
        for j in range(n):
            a, b = k * n + j, k * n + (j + 1) % n
            faces.append((a, b, b + n, a + n))
    if cap_first:
        faces.append(tuple(range(n - 1, -1, -1)))
    if cap_last:
        faces.append(tuple(range((len(rings) - 1) * n, len(rings) * n)))
    return verts, faces


def _weights(o, indices):
    """Each listed vertex's deforming weights, normalised: {bone: weight}."""
    names = {g.index: g.name for g in o.vertex_groups}
    out = []
    for i in indices:
        w = {names[g.group]: g.weight for g in o.data.vertices[int(i)].groups if g.weight > 1e-4 and g.group in names}
        total = sum(w.values()) or 1.0
        out.append({b: x / total for b, x in w.items()})
    return out


def _one(arm, bodies, worn, s, kind, size, ease, top, toe, sole_t, welt):
    """([(verts, faces, material slot, weights(vertex) -> {bone: w})], the skin's vertex mask per body)."""
    from . import deform
    from .garment import _bone, _outline

    ankle, ball = _bone(arm, f"foot_{s}"), _bone(arm, f"ball_{s}")
    knee = _bone(arm, f"calf_{s}")
    foot_pts, calf_pts, calf_w, inside = [], [], [], []
    for body in bodies:
        co, _ = helpers.rest_coords(body)
        if len(co) != len(body.data.vertices):
            inside.append(None)
            continue
        lead = np.array([l or "" for l in deform._dominant(body, arm)])
        on_foot = np.isin(lead, [f"foot_{s}", f"ball_{s}", f"ball_leaf_{s}"])
        foot_pts.append(co[on_foot])
        calf_pts.append(co[lead == f"calf_{s}"])
        calf_w.extend(_weights(body, np.flatnonzero(lead == f"calf_{s}")))
        inside.append((on_foot, lead == f"calf_{s}", co))
    # The shaft goes round what is worn on the shin too: boots made over trousers are made round them.
    for o in worn:
        co, _ = helpers.rest_coords(o)
        if len(co) == len(o.data.vertices):
            on = np.flatnonzero(np.array([l == f"calf_{s}" for l in deform._dominant(o, arm)], bool))
            calf_pts.append(co[on])
            calf_w.extend(_weights(o, on))
    foot = np.concatenate(foot_pts) if foot_pts else np.zeros((0, 3))
    calf = np.concatenate(calf_pts) if calf_pts else np.zeros((0, 3))
    if len(foot) < 12:
        raise ValueError(f"{arm.name}'s body has no skin on foot_{s}: footwear goes on a body on the standard skeleton")
    f = ball - ankle
    f[2] = 0.0
    f = f / max(1e-9, np.linalg.norm(f))
    r = np.array([-f[1], f[0], 0.0])
    base = np.array([ankle[0], ankle[1], 0.0])
    u, v = (foot - base) @ f, (foot - base) @ r
    u0, u1 = float(u.min()) - ease, float(u.max()) + ease
    length = u1 - u0
    ground = float(foot[:, 2].min())
    reach = {"round": 0.0, "square": 0.0, "pointed": 0.3}[toe] * length
    slab = length / STATIONS
    rings, edge = [], []
    for k in range(STATIONS):
        t = k / (STATIONS - 1)
        at = u0 + (length + reach) * t
        near = np.abs(u - min(at, u1 - ease)) < slab
        if near.sum() < 3:
            near = np.abs(u - min(at, u1 - ease)) < 2 * slab
        vc = float((v[near].max() + v[near].min()) / 2) if near.any() else 0.0
        width = float((v[near].max() - v[near].min()) / 2) + ease if near.any() else ease
        high = float(foot[near][:, 2].max()) + ease if near.any() else ground + 3 * ease
        # Rounded at both ends: the heel's back and the toe's front close in.
        end = min(t, 1 - t) * (STATIONS - 1)
        close = 1.0 if end >= 1.5 else (0.62 + 0.38 * end / 1.5)
        if toe == "pointed" and at > u1 - ease:
            past = (at - (u1 - ease)) / max(1e-9, reach + ease)
            close *= 1 - 0.75 * past
            high = ground + sole_t + (high - ground - sole_t) * (1 - 0.6 * past)
        box = 0.45 if toe == "square" and t > 0.6 else 0.62
        centre = base + f * at + r * vc
        centre[2] = 0.0
        rings.append(_ring(centre, f, r, width * close, ground + sole_t * 0.6, ground + sole_t + (high - ground - sole_t) * (0.75 + 0.25 * close), box))
        edge.append((at, vc, width * close))
    ub = float((ball - base) @ f)
    blend = 0.12 * length

    def foot_weight(p):
        k = min(1.0, max(0.0, (float((np.asarray(p) - base) @ f) - (ub - blend)) / (2 * blend)))
        k = k * k * (3 - 2 * k)
        return {f"foot_{s}": 1 - k, f"ball_{s}": k} if 0 < k < 1 else ({f"ball_{s}": 1.0} if k >= 1 else {f"foot_{s}": 1.0})

    parts = [(*_tube(rings, True, True), 0, foot_weight)]
    # The sole: the upper's own outline a welt wider, flat on the ground.
    out_r = [base + f * at + r * (vc + w * (1 + welt) + 0.25 * welt * length * 0.1) for at, vc, w in edge]
    out_l = [base + f * at + r * (vc - w * (1 + welt) - 0.25 * welt * length * 0.1) for at, vc, w in edge]
    out_r[0], out_l[0] = out_r[0] - f * welt * length * 0.25, out_l[0] - f * welt * length * 0.25
    out_r[-1], out_l[-1] = out_r[-1] + f * welt * length * 0.25, out_l[-1] + f * welt * length * 0.25
    loop = out_r + out_l[::-1]
    n = len(loop)
    verts = [p + np.array([0, 0, ground + 0.0005]) for p in loop] + [p + np.array([0, 0, ground + sole_t]) for p in loop]
    faces = [(j, (j + 1) % n, n + (j + 1) % n, n + j) for j in range(n)] + [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))]
    parts.append((verts, faces, 1, foot_weight))
    # The shaft: round the shin at each height, from inside the upper to where the boot ends.
    span = float(np.linalg.norm(knee - ankle))
    top_z = ankle[2] + (float(top) if kind == "boots" else 0.07) * span
    low_z = ankle[2] - 0.35 * (ankle[2] - ground)
    levels = max(3, int(round((top_z - low_z) / (0.035 * size))) + 1)
    shaft, lowest = [], None
    for k in reversed(range(levels)):
        z = low_z + (top_z - low_z) * k / (levels - 1)
        here = calf[np.abs(calf[:, 2] - z) < max(0.02 * size, (top_z - low_z) / levels)] if len(calf) else calf
        if len(here) >= 6:
            centre = np.array([float(here[:, 0].mean()), float(here[:, 1].mean())])
            reachs = _outline(here, centre, ROUND)
            for _ in range(2):  # a rim, not the skin's own bumps
                reachs = np.maximum(reachs, (np.roll(reachs, 1) + reachs + np.roll(reachs, -1)) / 3)
            lowest = (centre, reachs)
        elif lowest is None:
            continue
        # Below the shin's own skin the shaft keeps the ankle's outline down into the upper.
        centre, reachs = lowest
        out = reachs + ease * (1.35 if k == levels - 1 else 1.0)
        shaft.append([np.array([centre[0] + out[j] * math.sin(2 * math.pi * j / ROUND), centre[1] - out[j] * math.cos(2 * math.pi * j / ROUND), z]) for j in range(ROUND)])
    shaft.reverse()
    if len(shaft) >= 2:
        soft = 0.035 * size

        def shin_weight(p):
            k = min(1.0, max(0.0, (float(p[2]) - (ankle[2] - soft)) / soft))  # the shin's by the joint, as its skin is
            k = k * k * (3 - 2 * k)
            # Above the ankle it bends as what it goes round does (the trousers, or the skin), so
            # nothing under it comes through when the knee bends.
            near = calf_w[int(np.argmin(np.sum((calf - np.asarray(p)) ** 2, 1)))] if len(calf_w) == len(calf) and len(calf) else {f"calf_{s}": 1.0}
            out = {b: w * k for b, w in near.items() if b in arm.data.bones} or {f"calf_{s}": k}
            if k < 1:
                out[f"foot_{s}"] = out.get(f"foot_{s}", 0.0) + 1 - k
            return out

        parts.append((*_tube(shaft, False, False), 0, shin_weight))
    hidden = []
    for item in inside:
        if item is None:
            hidden.append(None)
            continue
        on_foot, on_calf, co = item
        hidden.append((on_foot | on_calf) & (co[:, 2] < top_z - 0.012 * size))
    return parts, hidden


def footwear(armature, kind="boots", *, colour="#4a3324", sole=None, material=None, name=None, top=0.45, toe="round", fit=1.0):
    """Makes and binds a pair of boots or shoes on armature's feet (a human on the standard
    skeleton): an upper with one toe ("round", "pointed" or "square"), a sole in its own colour
    (sole=, default a darker shade of colour) and, for boots, a shaft up top of the shin (0..1).
    fit scales its ease about the foot. Returns {"object", "chains", "triangles"}."""
    if kind not in KINDS:
        raise ValueError(f"footwear kind {kind!r}: one of {', '.join(KINDS)}")
    if toe not in TOES:
        raise ValueError(f"toe {toe!r}: one of {', '.join(TOES)}")
    arm = bpy.data.objects[armature] if isinstance(armature, str) else armature
    bodies = cloth._bodies(arm)
    if not bodies:
        raise ValueError(f"{arm.name} has no body mesh to put footwear on")
    size = cloth._size(bodies)
    name = name or f"{arm.name}_{kind}"
    label = name.split("_", 1)[-1].capitalize()
    upper = material or helpers.material(colour, name=label)
    under = helpers.material(sole or _darker(colour, 0.55), name=f"{label} sole")
    worn = [o for o in bpy.data.objects if o.get("kurambit_cloth") and o.name != name and arm in helpers._deforming(o)]
    posed = arm.data.pose_position
    arm.data.pose_position = "REST"
    bpy.context.view_layer.update()
    try:
        verts, faces, slots, weights, hidden = [], [], [], [], [None] * len(bodies)
        for s in SIDES:
            parts, skin = _one(arm, bodies, worn, s, kind, size, 0.011 * size * float(fit), top, toe, 0.02 * size, 0.09)
            for pv, pf, slot, weigh in parts:
                start = len(verts)
                verts += [tuple(float(x) for x in p) for p in pv]
                faces += [tuple(start + i for i in f) for f in pf]
                slots += [slot] * len(pf)
                weights += [weigh(p) for p in pv]
            hidden = [b if a is None else (a if b is None else a | b) for a, b in zip(hidden, skin)]
    finally:
        arm.data.pose_position = posed
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.materials.append(upper)
    me.materials.append(under)
    me.polygons.foreach_set("material_index", slots)
    me.shade_smooth()
    me.update()
    g = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(g)
    groups = {}
    for i, w in enumerate(weights):
        for bone, k in w.items():
            if k > 1e-4:
                (groups.get(bone) or groups.setdefault(bone, g.vertex_groups.new(name=bone))).add([i], float(k), "REPLACE")
    mod = g.modifiers.new("armature", "ARMATURE")
    mod.object = arm
    world = g.matrix_world.copy()
    g.parent = arm
    g.matrix_world = world
    g["kurambit_cloth"] = True
    # The foot inside it does not ship: skin that is not there cannot come through a toe cap.
    for body, mask in zip(bodies, hidden):
        if mask is not None and mask.any():
            group = body.vertex_groups.get(cloth.UNDER_GROUP) or body.vertex_groups.new(name=cloth.UNDER_GROUP)
            group.add(np.nonzero(mask)[0].tolist(), 1.0, "REPLACE")
    return {"object": g.name, "chains": {}, "triangles": sum(len(p.vertices) - 2 for p in me.polygons)}
