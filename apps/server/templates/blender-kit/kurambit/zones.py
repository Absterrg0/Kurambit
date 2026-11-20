"""zone(): a second colour on part of a made model, by what that part is.

One flat colour per part reads as an unpainted toy. A designed animal has a pale belly, socks, a
muzzle, ear insides, stripes or spots; a designed garment has a hem, a stripe or a panel in a second
colour. A zone is the model's own faces given another flat material, chosen by where they are on the
body (which bone leads them, which way they face, how far along the body they sit). The export folds
flat materials into vertex colours, so a zone costs no draw call and Art still lists each colour by
its name.

Space: the model at rest, facing -Y, +X its left, +Z up, metres.
"""
import math

import bpy
import numpy as np

from . import helpers

ANIMAL = ("belly", "socks", "muzzle", "ears", "blaze", "stripes", "spots", "saddle", "tip", "mask")
CLOTH = ("hems", "stripe", "panel", "patch")
KINDS = ANIMAL + CLOTH
TRUNK = ("spine", "pelvis", "neck", "tail", "root")


def _faces(o):
    """(face centres, face normals, face areas, [vertex indices]) of o at rest, in world space."""
    co, polys = helpers.rest_coords(o)
    me = o.data
    if len(co) != len(me.vertices):
        co = np.array([o.matrix_world @ v.co for v in me.vertices])
    faces = [tuple(p.vertices) for p in me.polygons]
    centres = np.array([co[list(f)].mean(axis=0) for f in faces])
    normals, areas = np.zeros((len(faces), 3)), np.zeros(len(faces))
    for i, f in enumerate(faces):
        n = np.zeros(3)
        for k in range(1, len(f) - 1):
            n += np.cross(co[f[k]] - co[f[0]], co[f[k + 1]] - co[f[0]])
        areas[i] = np.linalg.norm(n) / 2
        normals[i] = n / max(1e-12, np.linalg.norm(n))
    return co, centres, normals, areas, faces


def _leads(o, arm, faces):
    """The bone that leads each face ("" where none does)."""
    if arm is None:
        return np.array([""] * len(faces))
    from . import deform

    lead = deform._dominant(o, arm)
    out = []
    for f in faces:
        names = [lead[i] or "" for i in f]
        out.append(max(set(names), key=names.count))
    return np.array(out)


def _starts(leads, prefixes):
    # A creature's tail and ears are spring chains: spring_tail_01 is the tail's.
    return np.array([name.removeprefix("spring_").startswith(tuple(prefixes)) for name in leads], bool)


def _rim_distance(o, co, faces):
    """Each face's distance from the nearest open edge of the mesh, and that edge's height."""
    from .cloth import _boundary_distance

    count = {}
    for f in faces:
        for a, b in zip(f, f[1:] + f[:1]):
            k = (min(a, b), max(a, b))
            count[k] = count.get(k, 0) + 1
    pairs = np.array(sorted(count), np.int64).reshape(-1, 2)
    rim = np.unique(np.array([k for k, c in count.items() if c == 1], np.int64).reshape(-1, 2))
    if not len(rim):
        return None, rim
    depth = _boundary_distance(co, pairs, rim)
    return np.array([min(depth[i] for i in f) for f in faces]), rim


def _cut(o, planes):
    """Cuts o's faces along each (point, normal, face mask or None) plane, so a zone's edge is a
    line of the mesh and not the teeth of whatever faces were there. Rest space is the mesh's own
    for a model bound where it was made, which every made model is."""
    import bmesh
    from mathutils import Vector

    bm = bmesh.new()
    bm.from_mesh(o.data)
    inv = o.matrix_world.inverted()
    for point, normal, mask in planes:
        bm.faces.ensure_lookup_table()
        faces = [f for f in bm.faces if mask is None or (f.index < len(mask) and mask[f.index])] if mask is None or len(mask) == len(bm.faces) else list(bm.faces)
        geom = list({v for f in faces for v in f.verts} | {e for f in faces for e in f.edges} | set(faces))
        if geom:
            bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-6, plane_co=inv @ Vector(point), plane_no=(inv.to_3x3().inverted().transposed() @ Vector(normal)).normalized())
            bm.faces.index_update()
    bm.to_mesh(o.data)
    bm.free()
    o.data.update()


def zone(target, kind, colour, *, armature=None, name=None, amount=None, count=None, size=None, where=None, at=None, seed=1):
    """Gives part of target (a mesh, or its name) the colour (hex) as a zone of its own, kind one of:
      on a creature (armature: its rig, found from the mesh when left out)
        belly    the underside of the trunk, neck and tail (amount 0..1: how far up the flanks)
        socks    each leg below amount of its height (default 0.35); where "front" or "hind" for two
        muzzle   the front amount of the head (default 0.4)
        ears     the ears' insides (where "all" for the whole ear)
        blaze    a stripe down the front of the head, size metres wide
        stripes  count bands across the back and down the flanks (amount: their share of the coat)
        spots    count patches of about size metres, scattered by seed
        saddle   a patch over the middle of the back (amount: how much of its length)
        tip      the end of the tail (where: another chain, as "ear" or "wing"), its last amount
        mask     a band across the eyes
      on clothing
        hems     a band size wide along every open edge; where "low", "neck" or "cuffs" for one kind
        stripe   a band round it at height at (metres), size high; count repeats it downward
        panel    its front, size metres wide about the centre line
        patch    the faces within size of at (a point, or a bone's name: its joint)
    name names the colour in Art (default the kind). Returns how many faces took it."""
    o = bpy.data.objects[target] if isinstance(target, str) else target
    if kind not in KINDS:
        raise ValueError(f"zone kind {kind!r}: one of {', '.join(KINDS)}")
    arm = (bpy.data.objects[armature] if isinstance(armature, str) else armature) or next(iter(helpers._deforming(o)), None) or (o.parent if o.parent is not None and o.parent.type == "ARMATURE" else None)
    posed = arm.data.pose_position if arm is not None else None
    if arm is not None:
        arm.data.pose_position = "REST"
        bpy.context.view_layer.update()
    try:
        co, c, n, areas, faces = _faces(o)
        leads = _leads(o, arm, faces)
        lo, hi = co.min(axis=0), co.max(axis=0)
        tall = float(hi[2] - lo[2]) or 1.0
        # A zone that ends on a plane is cut along it first, and measured again.
        planes = []
        legs = _starts(leads, ("leg",))
        if kind == "stripe":
            h = float(size) if size is not None else 0.05 * tall
            z0 = float(at) if at is not None else lo[2] + 0.5 * tall
            planes = [((0, 0, z0 - 2 * h * k + sgn * h / 2), (0, 0, 1), None) for k in range(int(count or 1)) for sgn in (1, -1)]
        elif kind == "socks" and legs.any():
            k = 0.35 if amount is None else float(amount)
            for chain in sorted({name.rsplit("_", 1)[0] for name in leads[legs]}):
                mine = np.array([name.rsplit("_", 1)[0] == chain for name in leads], bool)
                z = c[mine][:, 2]
                planes.append(((0, 0, float(z.min() + k * (z.max() - z.min()))), (0, 0, 1), mine))
        elif kind == "muzzle":
            heads = _starts(leads, ("head", "Head", "jaw", "beak"))
            if heads.any():
                y = c[heads][:, 1]
                planes = [((0, float(y.min() + (0.4 if amount is None else float(amount)) * (y.max() - y.min())), 0), (0, 1, 0), heads)]
        elif kind == "panel":
            w = float(size) if size is not None else 0.3 * float(hi[0] - lo[0])
            front = (n[:, 1] < -0.2) & ~_starts(leads, ("upperarm", "lowerarm", "hand"))
            planes = [((sgn * w / 2, 0, 0), (1, 0, 0), front) for sgn in (1, -1)]
        if planes:
            _cut(o, planes)
            co, c, n, areas, faces = _faces(o)
            leads = _leads(o, arm, faces)
    finally:
        if arm is not None:
            arm.data.pose_position = posed
    lo, hi = co.min(axis=0), co.max(axis=0)
    span = hi - lo
    tall = float(span[2]) or 1.0
    pick = np.zeros(len(faces), bool)
    trunk = _starts(leads, TRUNK)
    legs = _starts(leads, ("leg",))
    head = _starts(leads, ("head", "Head", "jaw", "beak"))
    if kind == "belly":
        k = 0.3 if amount is None else float(amount)
        body = trunk | head | (legs & (c[:, 2] > lo[2] + 0.55 * tall))
        pick = body & (n[:, 2] < -0.5 + 1.2 * k) & ~_starts(leads, ("ear", "wing"))
    elif kind == "socks":
        k = 0.35 if amount is None else float(amount)
        for chain in sorted({name.rsplit("_", 1)[0] for name in leads[legs]}):
            mine = np.array([name.rsplit("_", 1)[0] == chain for name in leads], bool)
            if where in ("front", "hind") and where not in chain:
                continue
            z = c[mine][:, 2]
            pick |= mine & (c[:, 2] < z.min() + k * (z.max() - z.min()))
    elif kind in ("muzzle", "blaze", "mask"):
        if not head.any():
            raise ValueError(f"{o.name} has no head bone leading any face: a {kind} goes on a creature's head")
        y = c[head][:, 1]
        front, back = float(y.min()), float(y.max())
        if kind == "muzzle":
            k = 0.4 if amount is None else float(amount)
            # The snout below the eyes: on a short head the front share alone is the whole face.
            z = c[head][:, 2]
            pick = head & (c[:, 1] < front + k * (back - front)) & (c[:, 2] < z.min() + 0.55 * (z.max() - z.min()))
        elif kind == "blaze":
            w = float(size) if size is not None else 0.22 * float(np.ptp(c[head][:, 0]))
            pick = head & (np.abs(c[:, 0]) < w / 2) & (n[:, 1] < 0.2) & (n[:, 2] > -0.3)
        else:
            z = c[head][:, 2]
            mid = float(z.min() + 0.62 * (z.max() - z.min()))
            h = float(size) if size is not None else 0.2 * float(z.max() - z.min())
            pick = head & (np.abs(c[:, 2] - mid) < h / 2) & (n[:, 1] < 0.3)
    elif kind == "ears":
        ears = _starts(leads, ("ear",))
        pick = ears if where == "all" else ears & (n[:, 1] < -0.25)
    elif kind == "tip":
        chain = where or "tail"
        mine = _starts(leads, (chain,))
        if not mine.any():
            raise ValueError(f"{o.name} has no {chain} bone leading any face")
        k = 0.3 if amount is None else float(amount)
        # The chain's far end: furthest from the body's middle.
        centre = c[trunk].mean(axis=0) if trunk.any() else c.mean(axis=0)
        far = np.linalg.norm(c - centre, axis=1)
        pick = mine & (far > far[mine].min() + (1 - k) * (far[mine].max() - far[mine].min()))
    elif kind in ("stripes", "saddle", "spots"):
        coat = (trunk | legs | head) if kind != "saddle" else trunk
        along = c[:, 1]
        a0, a1 = float(along[trunk].min() if trunk.any() else lo[1]), float(along[trunk].max() if trunk.any() else hi[1])
        if kind == "saddle":
            k = 0.4 if amount is None else float(amount)
            mid = (a0 + a1) / 2
            pick = coat & (n[:, 2] > 0.25) & (np.abs(along - mid) < k * (a1 - a0) / 2)
        elif kind == "stripes":
            bands = int(count or 7)
            duty = 0.4 if amount is None else float(amount)
            # Bands across the back that thin toward the belly and lean back down the flank.
            top = float(c[trunk][:, 2].max()) if trunk.any() else hi[2]
            low = float(c[trunk][:, 2].min()) if trunk.any() else lo[2]
            down = np.clip((top - c[:, 2]) / max(1e-9, top - low), 0, 1.5)
            phase = ((along - a0) / max(1e-9, a1 - a0) * bands + 0.35 * down) % 1.0
            pick = coat & (np.abs(phase - 0.5) < 0.5 * duty * (1 - 0.75 * np.clip(down, 0, 1))) & (n[:, 2] > -0.35)
        else:
            rng = np.random.default_rng(int(seed))
            r = float(size) if size is not None else 0.07 * float(max(span))
            ids = np.nonzero(coat)[0]
            chosen = rng.choice(ids, size=min(len(ids), int(count or 12)), replace=False, p=areas[ids] / areas[ids].sum()) if len(ids) else []
            for i in chosen:
                pick |= coat & (np.linalg.norm(c - c[i], axis=1) < r * (0.7 + 0.6 * rng.random()))
    elif kind == "hems":
        depth, rim = _rim_distance(o, co, faces)
        if depth is None:
            raise ValueError(f"{o.name} has no open edge: a hem follows a garment's openings")
        w = float(size) if size is not None else 0.022 * tall / max(0.25, tall / max(span))
        pick = depth < w
        if where in ("low", "neck", "cuffs"):
            z = c[:, 2]
            if where == "low":
                pick &= z < lo[2] + 0.2 * tall
            elif where == "neck":
                pick &= (z > lo[2] + 0.8 * tall) & (np.abs(c[:, 0]) < 0.35 * span[0])
            else:
                pick &= _starts(leads, ("lowerarm", "hand", "upperarm"))
    elif kind == "stripe":
        h = float(size) if size is not None else 0.05 * tall
        z0 = float(at) if at is not None else lo[2] + 0.5 * tall
        for k in range(int(count or 1)):
            pick |= np.abs(c[:, 2] - (z0 - 2 * h * k)) < h / 2
    elif kind == "panel":
        w = float(size) if size is not None else 0.3 * float(span[0])
        pick = (np.abs(c[:, 0]) < w / 2) & (n[:, 1] < -0.2) & ~_starts(leads, ("upperarm", "lowerarm", "hand"))
    elif kind == "patch":
        if isinstance(at, str):
            if arm is None or at not in arm.data.bones:
                raise ValueError(f"no joint {at}: at is a point (x, y, z) or one of the rig's bones")
            point = np.array(arm.matrix_world @ arm.data.bones[at].head_local)
        elif at is not None:
            point = np.array(at, float)
        else:
            raise ValueError("a patch needs at=, a point or a bone's name")
        pick = np.linalg.norm(c - point, axis=1) < (float(size) if size is not None else 0.06 * tall)
    ids = np.nonzero(pick)[0]
    if not len(ids):
        return 0
    label = name or kind.capitalize()
    mat = helpers.material(colour, name=label)
    me = o.data
    if not me.materials:
        me.materials.append(helpers.material("#b8b8b8", name="Base"))
    slot = next((i for i, m in enumerate(me.materials) if m == mat), None)
    if slot is None:
        me.materials.append(mat)
        slot = len(me.materials) - 1
    index = np.empty(len(me.polygons), np.int32)
    me.polygons.foreach_get("material_index", index)
    index[ids] = slot
    me.polygons.foreach_set("material_index", index)
    me.update()
    return int(len(ids))
