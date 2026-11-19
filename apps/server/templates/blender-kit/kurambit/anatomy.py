"""What makes a made creature read as an animal: masses for its body, a face that blinks, feet,
fur, and wings that are a surface.

A body skinned over a sketch of chains is a set of pipes: a horse comes out as a tube on four
tubes with no eyes. masses() gives every animal of a plan what its plan has (a deep chest, haunches
and shoulders over its legs, cheeks behind a muzzle) for creature_body to fuse in. creature_face()
puts eyes that blink, nostrils and a mouth on the head it finds; feet() gives each leg a hoof, a
paw or claws; fur() lays chunky locks along a chain (a mane up a neck, a tuft down a tail);
feathers() and wing() make a wing's surface, feathers that stack when it folds or a ribbed skin.

Everything is found on the sketch and on the body's own surface: a chain's joints, rays out to the
skin. Space: the creature at rest, facing -Y, +X its left, metres.
"""
import json
import math

import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

from . import helpers, skeleton
from .hair import _Build, _shade


def masses(chains):
    """[(centre, (rx, ry, rz))]: the ellipsoids a sketch's plan adds to its pipes."""
    out = []
    legs = [(n, p) for n, p in chains.items() if n.startswith("leg") and len(p) >= 3]
    spine = chains["spine"]
    walker = len(legs) in (2, 4)
    for name, pts in legs if walker else []:
        (hx, hy, hz, r), (kx, ky, kz, _) = pts[0], pts[1]
        hind = not any(w in name for w in ("front", "fore"))
        seg = math.sqrt((kx - hx) ** 2 + (ky - hy) ** 2 + (kz - hz) ** 2)
        # The muscle over a leg's first bone, flat to the body's side and deep fore and aft.
        out.append(((hx * 0.9 + kx * 0.0 + (kx - hx) * 0.35, hy + (ky - hy) * 0.35, hz + (kz - hz) * 0.35),
                    (0.8 * r, (1.45 if hind else 1.2) * r, max(1.05 * r, 0.6 * seg))))
    if len(legs) == 4:
        (x0, y0, z0, r0), (x1, y1, z1, r1) = spine[0], spine[-1]
        out.append(((x1, y1, z1 - 0.28 * r1), (0.95 * r1, 1.15 * r1, 1.22 * r1)))  # the chest, deep
        out.append(((x0, y0, z0 + 0.04 * r0), (1.04 * r0, 1.12 * r0, 1.05 * r0)))  # the croup
        if len(spine) >= 3:
            xm, ym, zm, rm = spine[len(spine) // 2]
            out.append(((xm, ym, zm - 0.18 * rm), (1.03 * rm, 1.3 * rm, 1.0 * rm)))  # the belly
    head = chains.get("head")
    if head and len(head) >= 2:
        (sx, sy, sz, sr), (mx, my, mz, _) = head[0], head[-1]
        # Cheeks and jaw under the skull, toward the muzzle.
        out.append(((sx, sy + (my - sy) * 0.22, sz + (mz - sz) * 0.22 - 0.22 * sr), (0.92 * sr, 1.0 * sr, 0.85 * sr)))
    return out


def _arm(armature):
    return bpy.data.objects[armature] if isinstance(armature, str) else armature


def _roles(arm):
    if "kurambit_creature" not in arm:
        raise ValueError(f"{arm.name} is not a creature made by hero.creature_rig")
    return json.loads(arm["kurambit_creature"])


def _body(arm):
    o = next((o for o in bpy.data.objects if o.type == "MESH" and arm in helpers._deforming(o) and "kurambit_graph" in o), None)
    if o is None:
        raise ValueError(f"{arm.name} has no body made by hero.creature_body")
    return o


def _tree(body):
    co, faces = helpers.rest_coords(body)
    return BVHTree.FromPolygons([Vector(c) for c in co], faces)


def _skin(body):
    return next((s.material for s in body.material_slots if s.material is not None), None) or helpers.material("#888888", name="Skin")


def _head(arm, body):
    """(skull centre, its radius, the unit way the face points, the muzzle's tip, its radius)."""
    chains = json.loads(body["kurambit_graph"])
    pts = chains.get("head")
    if not pts:
        raise ValueError(f"{arm.name} has no head chain in its sketch: name the chain its eyes go on head")
    skull = Vector(pts[0][:3])
    if len(pts) >= 2 and (Vector(pts[-1][:3]) - skull).length > 1e-5:
        tip = Vector(pts[-1][:3])
        axis = (tip - skull).normalized()
        return skull, pts[0][3], axis, tip, pts[-1][3]
    axis = Vector((0, -1, 0))
    return skull, pts[0][3], axis, skull + axis * pts[0][3], pts[0][3]


def _out(tree, origin, direction, reach):
    """The skin's outermost point from origin along direction (from outside in), or None."""
    d = Vector(direction).normalized()
    hit = tree.ray_cast(Vector(origin) + d * reach, -d, reach)
    return hit[0]


def creature_face(armature, *, eyes="#2b1d14", white="#f3efe6", size=0.3, set="side", nostrils=True, mouth=True, dark="#1c1614"):
    """A face on a creature's head: two round eyes (a white, a big iris of the eyes colour, a pupil)
    with lids that blink in the game, nostrils at the muzzle's tip and a mouth line along it. size is
    an eye's radius over the skull's; set is where the eyes sit: "side" (a horse, a fish, a bird),
    "front" (a cat, an owl) or "top" (a frog, a crab). Everything is placed on the head by rays.
    Returns {"parts", "blinks"}."""
    from . import face

    arm, sets = _arm(armature), {"side": (72.0, 12.0), "front": (32.0, 16.0), "top": (40.0, 55.0)}
    if set not in sets:
        raise ValueError(f"eyes set {set!r}: one of {', '.join(sets)}")
    body = _body(arm)
    tree = _tree(body)
    skull, sr, axis, tip, tr = _head(arm, body)
    up = Vector((0, 0, 1))
    up = (up - axis * up.dot(axis)).normalized() if abs(up.dot(axis)) < 0.95 else Vector((0, -1, 0))
    left = up.cross(axis).normalized()
    if left.x < 0:
        left = -left
    skin = _skin(body)
    mats = [helpers.material(white, name="Eye white", roughness=0.25), helpers.material(eyes, name="Eye", roughness=0.25),
            helpers.material("#0c0c0f", name="Pupil", roughness=0.25)]
    style = dict(flat=1.0, tall=1.0, iris=0.72, pupil=0.55)
    around, lift = sets[set]
    parts, blinks = [], []
    radius = float(size) * sr
    for sgn, key in ((1, "l"), (-1, "r")):
        a, e = math.radians(around), math.radians(lift)
        d = (axis * (math.cos(a) * math.cos(e)) + left * (sgn * math.sin(a) * math.cos(e)) + up * math.sin(e)).normalized()
        origin = skull + axis * (0.18 * sr)
        p = _out(tree, origin, d, 4 * sr)
        if p is None:
            continue
        centre = p - d * (0.45 * radius)
        eye, _, _, _ = face._eyeball(f"{arm.name}_eye_{key}", centre, radius, d, style, mats)
        blinks.append(helpers.eye_lid(eye, key, armature=arm, look=tuple(d), open_deg=150.0, material=skin))
        parts += [eye.name, f"lid_{key}"]
    b = _Build()
    if nostrils and (tip - skull).length > 0.3 * sr:
        for sgn in (1, -1):
            d = (axis * 0.9 + left * (sgn * 0.42) + up * 0.25).normalized()
            p = _out(tree, tip - axis * (0.6 * tr), d, 4 * tr)
            if p is not None:
                b.blob(p - d * (0.05 * tr), 0.13 * tr, squash=(1, 1, 1))
    if mouth and (tip - skull).length > 0.3 * sr:
        # A line along each side of the muzzle, from under its tip back toward the cheek.
        for sgn in (1, -1):
            path = []
            for t in np.linspace(0.0, 1.0, 6):
                at = tip + (skull - tip) * (0.75 * t) - up * (0.3 * tr + 0.15 * tr * t)
                d = (left * sgn * (0.35 + 0.65 * t) + axis * (1 - t) * 0.9 - up * 0.25).normalized()
                p = _out(tree, at - d * 0.01 * tr, d, 4 * max(tr, sr))
                if p is not None:
                    path.append((p + d * 0.004 * tr, d))
            if len(path) >= 3:
                b.lock(path, 0.09 * tr, 0.05 * tr, root=1.0, taper=0.7)
    if b.faces:
        o = b.object(f"{arm.name}_muzzle", [helpers.material(dark, name="Nose")])
        helpers.skin_rigid(o, "Head", armature=arm)
        parts.append(o.name)
    return {"parts": parts, "blinks": blinks}


FEET = ("hoof", "paw", "claw")


def feet(armature, kind="paw", *, colour="#2a221e", size=1.0):
    """Gives every leg its foot: "hoof" (a dark flared block under the last joint), "paw" (a round
    pad with toes) or "claw" (three talons forward and one back). Each is bound to its leg's last
    bone. Returns the objects' names."""
    if kind not in FEET:
        raise ValueError(f"feet kind {kind!r}: one of {', '.join(FEET)}")
    arm = _arm(armature)
    body = _body(arm)
    chains = json.loads(body["kurambit_graph"])
    legs = json.loads(arm.get("kurambit_legs", "[]"))
    mat = helpers.material(colour, name={"hoof": "Hoof", "paw": "Paws", "claw": "Claws"}[kind])
    made = []
    for leg in legs:
        pts = chains.get(leg["name"])
        if not pts:
            continue
        x, y, z, r = pts[-1]
        r *= float(size)
        b = _Build()
        if kind == "hoof":
            segs, rows = 12, ((1.22, 0.0), (1.2, 0.5), (1.02, 1.5), (0.92, 1.9))
            base = len(b.verts)
            for k, h in rows:
                for j in range(segs):
                    a = 2 * math.pi * j / segs
                    b.verts.append(Vector((x + math.cos(a) * r * k, y - 0.18 * r + math.sin(a) * r * k * 1.12, z + r * h - r)))
            for i in range(len(rows) - 1):
                for j in range(segs):
                    p, q = base + i * segs + j, base + i * segs + (j + 1) % segs
                    b.faces.append((p, q, q + segs, p + segs))
                    b.mat.append(0)
            b.faces.append(tuple(base + j for j in range(segs))[::-1])
            b.faces.append(tuple(base + (len(rows) - 1) * segs + j for j in range(segs)))
            b.mat += [0, 0]
        elif kind == "paw":
            b.blob(Vector((x, y - 0.25 * r, z + 0.15 * r)), 1.15 * r, squash=(1.05, 1.25, 0.8))
            for k in (-1, 0, 1):
                b.blob(Vector((x + k * 0.62 * r, y - 1.25 * r + abs(k) * 0.22 * r, z - 0.05 * r)), 0.48 * r, squash=(1, 1.15, 0.85))
        else:
            for k, back in ((-1, False), (0, False), (1, False), (0, True)):
                a = math.radians(k * 28)
                d = Vector((math.sin(a), math.cos(a) if back else -math.cos(a), 0.0))
                start = Vector((x, y, z + 0.1 * r))
                n = 1.5 if back else 2.6
                path = [(start + d * (r * n * t) + Vector((0, 0, 0.5 * r * math.sin(t * math.pi) - 0.35 * r * t)), Vector((0, 0, 1))) for t in np.linspace(0, 1, 5)]
                b.lock(path, 0.75 * r, 0.75 * r, root=1.0, taper=0.35)
        o = b.object(f"{arm.name}_{leg['name']}_{kind}", [mat])
        helpers.skin_rigid(o, leg["foot"], armature=arm)
        made.append(o.name)
    return made


def fur(armature, chain, *, colour="#3a2a20", length=None, count=None, side="top", lean=0.6, name=None):
    """Chunky locks along a chain of the sketch: a mane up a neck (side "top"), a beard or chest
    ruff ("under"), or a tuft past a tail's end ("end"). length is a lock's length in metres
    (default by the chain's thickness), lean how far the locks lie back along the chain (0 upright
    .. 1 flat). Each lock follows the bone it grows from. Returns the object's name."""
    arm = _arm(armature)
    roles = _roles(arm)
    if chain not in roles:
        raise ValueError(f"{arm.name} has no chain {chain}: its chains are {', '.join(roles)}")
    body = _body(arm)
    tree = _tree(body)
    pts = [p for p in json.loads(body["kurambit_graph"])[chain]]
    bones = roles[chain]
    joints = [arm.matrix_world @ arm.data.bones[b].head_local for b in bones] + [arm.matrix_world @ arm.data.bones[bones[-1]].tail_local]
    radius = float(np.mean([p[3] for p in pts]))
    total = sum((joints[i + 1] - joints[i]).length for i in range(len(joints) - 1))
    mats = [helpers.material(colour, name="Fur"), helpers.material(_shade(colour, 0.75), name="Fur under")]
    b = _Build()
    owner = []

    def at(t):
        """The point t (0..1) of the way along the chain, the way it runs there, and its bone."""
        want, run = t * total, 0.0
        for i in range(len(joints) - 1):
            seg = (joints[i + 1] - joints[i]).length
            if run + seg >= want or i == len(joints) - 2:
                u = min(1.0, max(0.0, (want - run) / max(seg, 1e-9)))
                return joints[i].lerp(joints[i + 1], u), (joints[i + 1] - joints[i]).normalized(), bones[min(i, len(bones) - 1)]
            run += seg
        return joints[-1], (joints[-1] - joints[-2]).normalized(), bones[-1]

    if side == "end":
        tip, along, bone = at(1.0)
        n = count or 7
        reach = length if length is not None else 5 * radius
        for k in range(n):
            a = 2 * math.pi * k / n
            off = Vector((math.cos(a), 0, math.sin(a)))
            off = (off - along * off.dot(along)).normalized()
            start = at(0.7)[0] + off * radius * 0.5
            path = [(start + along * (reach * t) + off * (radius * 0.9 * math.sin(t * math.pi)), off) for t in np.linspace(0, 1, 6)]
            before = len(b.verts)
            b.lock(path, 1.5 * radius, 1.2 * radius, mat=k % 2, taper=0.5)
            owner += [bone] * (len(b.verts) - before)
    else:
        n = count or max(6, int(round(total / (0.45 * radius))))
        reach = length if length is not None else 2.6 * radius
        way = Vector((0, 0, 1 if side == "top" else -1))
        for k in range(n):
            t = (k + 0.5) / n
            p, along, bone = at(t)
            out = (way - along * way.dot(along))
            out = out.normalized() if out.length > 1e-6 else Vector((0, 0, 1))
            root = _out(tree, p, out, 6 * radius) or p + out * radius
            # Away from the head: back along a neck, which the sketch runs base to head.
            back = -along
            grow = (out * (1 - lean) + back * lean).normalized()
            path = [(root - out * (0.15 * radius) + grow * (reach * u) - out * (0.25 * reach * u * u), out) for u in np.linspace(0, 1, 5)]
            before = len(b.verts)
            b.lock(path, 1.3 * radius, 0.6 * radius, mat=k % 2, taper=0.45)
            owner += [bone] * (len(b.verts) - before)
    o = b.object(name or f"{arm.name}_{chain}_fur", mats)
    for bone in sorted(set(owner)):
        o.vertex_groups.new(name=bone).add([i for i, x in enumerate(owner) if x == bone], 1.0, "REPLACE")
    skeleton.bind(o, arm)
    return o.name


FOLD_KEY = "kurambit_wing_fold"
# How a skinned wing rests on the ground, per bone from the shoulder (sweep, lift, degrees): half
# folded, up and back. Folded flat as feathers fold, a skin crosses itself.
HALF_FOLD = ((34.0, 38.0), (-46.0, 0.0), (30.0, 0.0), (0.0, 0.0))


def _wing_chains(arm, chain):
    roles = _roles(arm)
    names = [c for c in roles if c == chain or c in (f"{chain}_l", f"{chain}_r")]
    if not names:
        raise ValueError(f"{arm.name} has no chain {chain}: its chains are {', '.join(roles)}")
    return roles, names


def feathers(armature, chain="wing", *, depth, colour="#5a3a2a", cover=None, per_bone=5, direction=(0, 1, 0)):
    """A wing's feathers on its chain (both sides): a row of long flight feathers hanging depth
    metres back from the bones, longest toward the tip and fanning out there, under a row of short
    coverts (cover: their hex colour, default a lighter shade). Each feather follows one bone, so
    a folded wing is feathers stacked, as a bird's is. Returns the objects' names."""
    arm = _arm(armature)
    roles, names = _wing_chains(arm, chain)
    mats = [helpers.material(colour, name="Flight feathers"), helpers.material(cover or _shade(colour, 1.35), name="Coverts")]
    back = Vector(direction).normalized()
    made = []
    for cname in names:
        bones = [arm.data.bones[b] for b in roles[cname]]
        pts = [arm.matrix_world @ b.head_local for b in bones] + [arm.matrix_world @ bones[-1].tail_local]
        out = (pts[-1] - pts[0]).normalized()
        normal = out.cross(back).normalized()
        n = len(bones)
        b = _Build()
        owner = []
        for row, (share, mat, lift) in enumerate(((1.0, 0, 0.0), (0.45, 1, 1.0))):
            for j in range(n):
                for k in range(per_bone):
                    t = (j + (k + 0.5) / per_bone) / n
                    p = pts[j].lerp(pts[j + 1], (k + 0.5) / per_bone)
                    # Longest two thirds of the way out; the last ones swing round toward the tip.
                    reach = depth * share * (0.55 + 0.45 * math.sin(min(1.0, t / 0.7) * math.pi / 2)) * (1.0 if t < 0.8 else 1.0 - 0.25 * (t - 0.8) / 0.2)
                    fan = max(0.0, (t - 0.55) / 0.45) ** 1.5
                    d = (back * (1 - 0.75 * fan) + out * (0.95 * fan)).normalized()
                    width = 1.9 * (pts[j + 1] - pts[j]).length / per_bone
                    start = p + normal * (0.004 + 0.006 * lift + 0.002 * (k % 2))
                    path = [(start + d * (reach * u), normal) for u in np.linspace(0, 1, 4)]
                    before = len(b.verts)
                    b.lock(path, width, 0.01 * depth + 0.002, mat=mat, sides=4, root=0.8, taper=0.78)
                    owner += [bones[j].name] * (len(b.verts) - before)
        o = b.object(f"{arm.name}_{cname}_feathers", mats)
        for bone in sorted(set(owner)):
            o.vertex_groups.new(name=bone).add([i for i, x in enumerate(owner) if x == bone], 1.0, "REPLACE")
        skeleton.bind(o, arm)
        made.append(o.name)
    return made


def wing(armature, chain="wing", *, depth, colour="#8a3a2a", ribs=None, direction=(0, 1, 0), taper=0.25):
    """A wing's skin on its chain (both sides), as a bat's or a dragon's: a membrane from the bones
    back depth metres at the root, scalloped between ribs that run from each joint to its trailing
    edge (ribs: their hex colour, default a darker shade). It bends in a curve across each joint
    and its inner edge stays on the body, and such a wing rests half folded, up and back. Returns
    the objects' names."""
    arm = _arm(armature)
    roles, names = _wing_chains(arm, chain)
    mats = [helpers.material(colour, name="Wing skin"), helpers.material(ribs or _shade(colour, 0.6), name="Wing ribs")]
    back = Vector(direction).normalized()
    made = []
    for cname in names:
        bones = [arm.data.bones[b] for b in roles[cname]]
        pts = [arm.matrix_world @ b.head_local for b in bones] + [arm.matrix_world @ bones[-1].tail_local]
        n, cols, rows = len(bones), 5, 6
        out = (pts[-1] - pts[0]).normalized()
        normal = out.cross(back).normalized()
        parent = bones[0].parent.name if bones[0].parent is not None else bones[0].name
        verts, faces, weights = [], [], []
        total = n * cols
        for i in range(total + 1):
            t = i / total
            j, u = min(n - 1, i // cols), (i % cols) / cols if i < total else 1.0
            if i == total:
                j, u = n - 1, 1.0
            p = pts[j].lerp(pts[j + 1], u)
            # Deep at the body, scalloped up between the ribs, to a point at the tip.
            reach = depth * (1 - (1 - taper) * t ** 1.4) * (1 - 0.22 * math.sin(math.pi * u) ** 2) * (1.0 if i < total else 0.02)
            d = (back * (1 - 0.6 * t) + out * 0.6 * t).normalized()
            # Across a joint the skin bends over a third of a bone either side, and further from
            # the bones it follows the bone before, so its trailing edge folds late.
            for r in range(rows + 1):
                s = r / rows
                verts.append(p + d * (reach * s))
                at = j + u - 0.2 * s
                lo = max(0, min(n - 1, int(math.floor(at + 0.5)) - 1)) if at >= 0.5 else 0
                w = {}
                if at < 0:
                    k = min(1.0, -at / 0.2) * 0.8
                    w[parent] = k
                    w[bones[0].name] = 1 - k
                else:
                    a, f = int(math.floor(at)), at - math.floor(at)
                    a = min(n - 1, a)
                    if f > 2 / 3 and a + 1 < n:
                        k = (f - 2 / 3) * 1.5
                        k = k * k * (3 - 2 * k)
                        w[bones[a].name], w[bones[a + 1].name] = 1 - 0.5 * k, 0.5 * k
                    elif f < 1 / 3 and a > 0:
                        k = (1 / 3 - f) * 1.5
                        k = k * k * (3 - 2 * k)
                        w[bones[a].name], w[bones[a - 1].name] = 1 - 0.5 * k, 0.5 * k
                    else:
                        w[bones[a].name] = 1.0
                weights.append(w)
        for i in range(total):
            for r in range(rows):
                a = i * (rows + 1) + r
                faces.append((a, a + rows + 1, a + rows + 2, a + 1))
        me = bpy.data.meshes.new(f"{arm.name}_{cname}_skin")
        me.from_pydata([tuple(v) for v in verts], [], faces)
        me.shade_smooth()
        o = bpy.data.objects.new(me.name, me)
        for c in arm.users_collection:
            c.objects.link(o)
        me.materials.append(mats[0])
        sol = o.modifiers.new("thick", "SOLIDIFY")
        sol.thickness, sol.offset = max(0.003, 0.012 * depth), 0.0
        groups = {}
        for v, w in enumerate(weights):
            for bone, k in w.items():
                if k > 1e-4:
                    groups.setdefault(bone, o.vertex_groups.new(name=bone) if o.vertex_groups.get(bone) is None else o.vertex_groups[bone]).add([v], k, "REPLACE")
        with bpy.context.temp_override(object=o, active_object=o):
            bpy.ops.object.modifier_apply(modifier=sol.name)
        skeleton.bind(o, arm)
        made.append(o.name)
        # The ribs: a finger from each joint to the trailing edge, and the arm itself.
        b = _Build()
        owner = []
        for j in range(n + 1):
            t = j / n
            reach = depth * (1 - (1 - taper) * t ** 1.4) * (1.0 if j < n else 0.02)
            d = (back * (1 - 0.6 * t) + out * 0.6 * t).normalized()
            if reach > 0.05 * depth and j > 0:
                path = [(pts[j] + d * (reach * u) + normal * 0.004, normal) for u in np.linspace(0, 1, 5)]
                before = len(b.verts)
                b.lock(path, 0.05 * depth, 0.05 * depth, sides=5, root=1.0, taper=0.3)
                owner += [bones[min(j, n - 1) - (1 if j == n else 0)].name] * (len(b.verts) - before)
        for j in range(n):
            path = [(pts[j].lerp(pts[j + 1], u), normal) for u in np.linspace(0, 1, 3)]
            before = len(b.verts)
            b.lock(path, 0.075 * depth * (1 - 0.5 * j / n), 0.075 * depth * (1 - 0.5 * j / n), sides=6, root=1.0, taper=0.98)
            owner += [bones[j].name] * (len(b.verts) - before)
        ro = b.object(f"{arm.name}_{cname}_ribs", [mats[1]])
        for bone in sorted(set(owner)):
            ro.vertex_groups.new(name=bone).add([i for i, x in enumerate(owner) if x == bone], 1.0, "REPLACE")
        skeleton.bind(ro, arm)
        made.append(ro.name)
    arm[FOLD_KEY] = json.dumps(HALF_FOLD)
    return made
