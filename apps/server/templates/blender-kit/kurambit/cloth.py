"""Clothing that moves: dress() fits a garment to the body under it and hangs its loose part on hem
chains, dangle() hangs a loose end (a scarf's tail, a strap) on one chain, follow_hem() keys the
chains to follow the legs in every clip.

A coat weighted to the legs by automatic weights splits between them and flares as two stiff
cones. Here the garment takes the body's own weights by nearest surface (Blender's Data Transfer)
where it hugs the body, and below its hang line it is weighted to chains of spring_ bones around
the hem instead: each vertex to the two chains either side of it, along their bones by height. The
game swings the chains (spring_ bones), and follow_hem keys the chains' roots to follow the thigh
on their side part way, so the hem moves with the stride, not through it.
"""
import json
import math

import bpy
import numpy as np
from mathutils import Vector

from . import helpers

GARMENT_OFFSET = 0.006
# How far under a garment's vertex, along its normal, the skin it lies on may be (metres).
UNDER = 0.04
SOFTEN = 2
# The most of a thigh's swing a hem chain takes where the leg pushes into it: all of it folds the
# hem's front panel like a second leg (run 1's fisherman); this keeps it a panel the leg carries.
PUSHED = 0.8
# The share of a hem chain's lift over a leg that the chain either side of it takes too.
SHARED = 0.3


def _obj(x):
    return bpy.data.objects[x] if isinstance(x, str) else x


def _apply(o, m):
    bpy.context.view_layer.objects.active = o
    with bpy.context.temp_override(object=o, active_object=o):
        bpy.ops.object.modifier_apply(modifier=m.name)


def _world(o):
    me = o.data
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    mw = np.array(o.matrix_world)
    return co.reshape(-1, 3) @ mw[:3, :3].T + mw[:3, 3]


def _bodies(arm):
    """The body a garment fits: the meshes stamped as the character's body, else <armature>_body,
    else its largest skinned mesh that is not clothing."""
    skinned = [o for o in bpy.data.objects
               if o.type == "MESH" and arm in helpers._deforming(o) and not o.get("kurambit_cloth")]
    out = []
    for o in skinned:
        try:
            if json.loads(o.get("kurambit_source", "{}")).get("what") == "body":
                out.append(o)
        except ValueError:
            pass
    if out:
        return out
    named = [o for o in skinned if o.name.lower().startswith(f"{arm.name.lower()}_body")]
    return named or sorted(skinned, key=lambda o: -len(o.data.vertices))[:1]


def _nearest_bone(arm, point, skip=()):
    best, d = None, 1e9
    p = Vector(point)
    for b in arm.data.bones:
        if not b.use_deform or b.name in skip or b.name.startswith("spring_"):
            continue
        h, t = arm.matrix_world @ b.head_local, arm.matrix_world @ b.tail_local
        seg = t - h
        u = max(0.0, min(1.0, (p - h).dot(seg) / max(1e-12, seg.length_squared)))
        dd = (h + seg * u - p).length
        if dd < d:
            best, d = b.name, dd
    return best


def _unweight(o):
    """No vertex group and no weight left in the mesh. A garment cut from a copy of the body keeps
    the body's weights in its mesh by group index even with no group on the object, and new groups
    in another order then read them as their own: a cuff weighted to the upper arm."""
    import bmesh

    o.vertex_groups.clear()
    bm = bmesh.new()
    bm.from_mesh(o.data)
    layer = bm.verts.layers.deform.active
    if layer is not None:
        bm.verts.layers.deform.remove(layer)
        bm.to_mesh(o.data)
    bm.free()


def _soften(o, rounds=SOFTEN):
    """Each vertex's weights averaged with its neighbours', rounds times. The skin's weights step
    from one bone to the next across a joint's crease, where its mesh is dense; a garment's wider
    faces put that whole step on one edge, which then takes the bend alone."""
    me = o.data
    n, groups = len(me.vertices), list(o.vertex_groups)
    if n == 0 or not groups:
        return
    w = np.zeros((n, len(groups)))
    for v in me.vertices:
        for e in v.groups:
            w[v.index, e.group] = e.weight
    edges = np.empty(len(me.edges) * 2, np.int64)
    me.edges.foreach_get("vertices", edges)
    a, b = edges[0::2], edges[1::2]
    count = np.bincount(np.concatenate([a, b]), minlength=n)[:, None]
    for _ in range(rounds):
        near = np.zeros_like(w)
        np.add.at(near, a, w[b])
        np.add.at(near, b, w[a])
        w = (w + near) / (1 + count)
    for vg in groups:
        vg.remove(list(range(n)))
    for j, vg in enumerate(groups):
        for i in np.nonzero(w[:, j] > 1e-3)[0]:
            vg.add([int(i)], float(w[i, j]), "REPLACE")


def dress(garment, armature, *, body=None, offset=GARMENT_OFFSET, hang=None, chains=6, bones=3, name=None, rim=None, weights="skin"):
    """Fits garment (a mesh you modelled over the character at rest) and binds it.

    1. Shrinkwrap, outside only: every vertex inside the body moves out to offset metres above it;
       the rest keep the shape you modelled.
    2. Weights: the body's, by nearest surface (Data Transfer), so it bends as the skin under it.
    3. hang (a height in metres; a coat's or skirt's at the hips, a cape's at the shoulders): below
       it, the garment hangs on chains of spring_<name>_<i>_NN bones (bones each) around the hem,
       placed where the garment is, parented to the bone nearest the hang line's centre. 0 chains
       keeps the body's weights everywhere.
    4. Edges: every open edge (a collar, a cuff, a hem) is turned in by rim metres (default by the
       body's size; 0 leaves them), so cloth has a thickness where it ends.
    5. The skin well under it is marked (kurambit_under) and left out of the export: skin that is
       not there cannot show through. Skin near an opening and under a hanging part stays.
    weights="keep" leaves the weights the garment came with (one cut from the body's own mesh).
    Marks the garment as clothing (kurambit_cloth) for the gates. Returns {chain: [bones]}."""
    g = _obj(garment)
    arm = _obj(armature)
    bodies = [_obj(b) for b in body] if isinstance(body, (list, tuple)) else ([_obj(body)] if body else _bodies(arm))
    if not bodies:
        raise ValueError(f"{arm.name} has no body mesh to dress: pass body=")
    name = name or g.name.lower().replace(" ", "_")[:12]
    # Its own modifiers first, so the weights land on the final vertices.
    for m in list(g.modifiers):
        if m.type != "ARMATURE":
            _apply(g, m)
    for m in list(g.modifiers):
        g.modifiers.remove(m)
    # The garment was modelled over the body at rest, and the character stands in its idle: fitted
    # to that pose, a sleeve modelled along a T-posed arm takes the weights of whatever the hanging
    # arm left nearest (a cuff on the upper arm), and tears on the first clip.
    posed = arm.data.pose_position
    arm.data.pose_position = "REST"
    bpy.context.view_layer.update()
    target = bodies[0]
    if len(bodies) > 1:
        # One surface to wrap onto: the body's parts joined in a throwaway copy.
        copies = []
        for b in bodies:
            c = b.copy()
            c.data = b.data.copy()
            bpy.context.scene.collection.objects.link(c)
            copies.append(c)
        with bpy.context.temp_override(active_object=copies[0], selected_editable_objects=copies, object=copies[0]):
            bpy.ops.object.join()
        target = copies[0]
    try:
        sw = g.modifiers.new("fit", "SHRINKWRAP")
        sw.target = target
        sw.wrap_method = "NEAREST_SURFACEPOINT"
        sw.wrap_mode = "OUTSIDE"
        sw.offset = float(offset)
        _apply(g, sw)
        if weights == "keep":
            # Cut from the body's own surface with its weights (hero.garment): they are the skin's
            # already, vertex for vertex, and a transfer by nearest skin can only pick a wrong one
            # (the other thigh's, between two legs that touch).
            return_early = True
        else:
            return_early = False
            _unweight(g)
        # The nearest skin first, then the skin straight under each vertex where there is some
        # within reach: in an armpit the nearest skin to a sleeve is the ribs, and a sleeve
        # weighted to the ribs tears when the arm comes down.
        for mapping in (() if return_early else ("POLYINTERP_NEAREST", "POLYINTERP_VNORPROJ")):
            dt = g.modifiers.new("weights", "DATA_TRANSFER")
            dt.object = target
            dt.use_vert_data = True
            dt.data_types_verts = {"VGROUP_WEIGHTS"}
            dt.vert_mapping = mapping
            if mapping == "POLYINTERP_VNORPROJ":
                dt.use_max_distance = True
                dt.max_distance = UNDER
            dt.layers_vgroup_select_src = "ALL"
            dt.layers_vgroup_select_dst = "NAME"
            with bpy.context.temp_override(object=g, active_object=g):
                bpy.ops.object.datalayout_transfer(modifier=dt.name)
            _apply(g, dt)
    finally:
        if target not in bodies:
            bpy.data.objects.remove(target)
        arm.data.pose_position = posed
    for vg in list(g.vertex_groups):
        if vg.name not in arm.data.bones:
            g.vertex_groups.remove(vg)
    if weights != "keep":
        _soften(g)
    _unsleeved(g, arm)
    size = _size(bodies)
    _turn_in(g, (0.007 * size if rim is None else float(rim)))
    made = {}
    if hang is not None and chains > 0:
        made = _hem(g, arm, float(hang), int(chains), int(bones), name)
    _normalize(g, arm)
    mod = g.modifiers.new("armature", "ARMATURE")
    mod.object = arm
    if g.parent != arm:
        mw = g.matrix_world.copy()
        g.parent = arm
        g.matrix_world = mw
    g["kurambit_cloth"] = True
    _mark_under(g, arm, bodies, reach=max(3 * float(offset), 0.012 * size), margin=0.018 * size)
    if made:
        stored = json.loads(arm.get("kurambit_chains", "{}") or "{}")
        stored.update(made)
        arm["kurambit_chains"] = json.dumps(stored)
        hems = json.loads(arm.get("kurambit_hems", "{}") or "{}")
        hems.update({k: v[0] for k, v in made.items()})
        arm["kurambit_hems"] = json.dumps(hems)
    return made


UNDER_GROUP = "kurambit_under"


def _size(bodies):
    """The body's height at rest, metres: what a seam's width and a margin scale by."""
    zs = np.concatenate([helpers.rest_coords(b)[0][:, 2] for b in bodies])
    return float(zs.max() - zs.min()) if len(zs) else 1.75


def _turn_in(g, rim):
    """Every open edge of the garment turned in toward the body by rim: an edge with a thickness."""
    import bmesh

    if rim <= 0:
        return
    bm = bmesh.new()
    bm.from_mesh(g.data)
    bm.normal_update()
    edges = [e for e in bm.edges if len(e.link_faces) == 1]
    if edges:
        normal = {v: v.normal.copy() for e in edges for v in e.verts}
        out = bmesh.ops.extrude_edge_only(bm, edges=edges)
        new = [x for x in out["geom"] if isinstance(x, bmesh.types.BMVert)]
        # Each new vertex sits on the one it was extruded from: in along that one's normal.
        old = {}
        for v in new:
            for e in v.link_edges:
                o = e.other_vert(v)
                if o in normal:
                    old[v] = o
        for v in new:
            if v in old:
                v.co = old[v].co - normal[old[v]] * rim
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(g.data)
        g.data.update()
    bm.free()


def _boundary_distance(co, edges, boundary):
    """How far each vertex is from the mesh's open edges, along its edges (metres)."""
    import heapq

    n = len(co)
    dist = np.full(n, np.inf)
    near = [[] for _ in range(n)]
    for a, b in edges:
        w = float(np.linalg.norm(co[a] - co[b]))
        near[a].append((b, w))
        near[b].append((a, w))
    heap = [(0.0, int(i)) for i in boundary]
    for _, i in heap:
        dist[i] = 0.0
    heapq.heapify(heap)
    while heap:
        d, i = heapq.heappop(heap)
        if d > dist[i]:
            continue
        for j, w in near[i]:
            if d + w < dist[j]:
                dist[j] = d + w
                heapq.heappush(heap, (d + w, j))
    return dist


def _mark_under(g, arm, bodies, reach, margin):
    """Marks the body's vertices that lie well under garment g at rest in the body's UNDER_GROUP:
    within reach of it, more than margin from any opening of it, and under a part that moves with
    the skin (not a hanging one, which swings clear of what is under it)."""
    from mathutils.bvhtree import BVHTree

    co, faces = helpers.rest_coords(g)
    me = g.data
    if len(co) != len(me.vertices) or not len(faces):
        return 0
    edges = np.empty(len(me.edges) * 2, np.int64)
    me.edges.foreach_get("vertices", edges)
    edges = edges.reshape(-1, 2)
    count = np.zeros(len(me.edges), np.int64)
    keys = {(int(min(a, b)), int(max(a, b))): i for i, (a, b) in enumerate(edges)}
    for f in faces:
        for a, b in zip(f, f[1:] + f[:1]):
            count[keys[(min(a, b), max(a, b))]] += 1
    boundary = np.unique(edges[count == 1])
    depth = _boundary_distance(co, edges, boundary) if len(boundary) else np.full(len(co), np.inf)
    swings = np.zeros(len(co), bool)
    spring = {vg.index for vg in g.vertex_groups if vg.name.startswith("spring_")}
    for v in me.vertices:
        swings[v.index] = any(e.group in spring and e.weight > 0.05 for e in v.groups)
    ok = np.array([all(depth[i] > margin and not swings[i] for i in f) for f in faces])
    tree = BVHTree.FromPolygons([Vector(c) for c in co], faces)
    marked = 0
    for b in bodies:
        bco, _ = helpers.rest_coords(b)
        if len(bco) != len(b.data.vertices):
            continue
        group = b.vertex_groups.get(UNDER_GROUP) or b.vertex_groups.new(name=UNDER_GROUP)
        idx = []
        for i, p in enumerate(bco):
            hit = tree.find_nearest(Vector(p), reach)
            if hit[0] is not None and ok[hit[2]]:
                idx.append(i)
        group.add(idx, 1.0, "REPLACE")
        marked += len(idx)
    return marked


def drop_under(meshes):
    """Removes the faces of each body whose every vertex is marked as under a garment (the export's
    pass runs this on its own copy of the scene, so the live body stays whole for the next fitting).
    Returns how many faces went."""
    import bmesh

    gone = 0
    for o in meshes:
        group = o.vertex_groups.get(UNDER_GROUP) if o.type == "MESH" else None
        if group is None:
            continue
        bm = bmesh.new()
        bm.from_mesh(o.data)
        layer = bm.verts.layers.deform.active
        if layer is not None:
            faces = [f for f in bm.faces if all(v[layer].get(group.index, 0.0) > 0.5 for v in f.verts)]
            gone += len(faces)
            bmesh.ops.delete(bm, geom=faces, context="FACES")
            bm.to_mesh(o.data)
            o.data.update()
        bm.free()
        o.vertex_groups.remove(group)
    return gone


def _arm_bones(arm, side):
    top = arm.data.bones.get(f"upperarm_{side}")
    return {top.name, *(c.name for c in top.children_recursive)} if top is not None else set()


def _unsleeved(g, arm):
    """A garment with no sleeve on an arm takes none of that arm's weights: a coat's side panel
    beside a hanging hand would follow the hand. A sleeve is garment around the forearm: within a
    quarter of its length of the bone, or of its own skin's reach from it (a chibi's forearm is
    short and thick, and its sleeve sits further out than a quarter of its length)."""
    from . import deform

    co = _world(g)
    skins = [(helpers.rest_coords(b)[0], deform._dominant(b, arm)) for b in _bodies(arm)]
    for side in ("l", "r"):
        bones = _arm_bones(arm, side)
        fore = arm.data.bones.get(f"lowerarm_{side}")
        if not bones or fore is None:
            continue
        h, t = np.array(arm.matrix_world @ fore.head_local), np.array(arm.matrix_world @ fore.tail_local)
        seg = t - h
        u = np.clip((co - h) @ seg / max(1e-12, seg @ seg), 0, 1)
        def off(points):
            k = np.clip((points - h) @ seg / max(1e-12, seg @ seg), 0, 1)
            return np.linalg.norm(points - (h + np.outer(k, seg)), axis=1)

        reach = 0.25 * float(np.linalg.norm(seg))
        for skin, lead in skins:
            on = np.array([l == f"lowerarm_{side}" for l in lead], bool)
            if len(skin) == len(lead) and on.sum() >= 12:
                reach = max(reach, 1.5 * float(np.percentile(off(skin[on]), 90)))
        if (off(co) < reach).sum() >= 12:
            continue
        for vg in list(g.vertex_groups):
            if vg.name in bones:
                g.vertex_groups.remove(vg)
    groups = {vg.index for vg in g.vertex_groups}
    for v in g.data.vertices:
        if not any(e.group in groups and e.weight > 1e-4 for e in v.groups):
            p = g.matrix_world @ v.co
            skip = _arm_bones(arm, "l") | _arm_bones(arm, "r")
            name = _nearest_bone(arm, p, skip)
            (g.vertex_groups.get(name) or g.vertex_groups.new(name=name)).add([v.index], 1.0, "REPLACE")


def _normalize(o, arm):
    groups = {vg.index: vg for vg in o.vertex_groups if vg.name in arm.data.bones}
    for v in o.data.vertices:
        ws = [(g.group, g.weight) for g in v.groups if g.group in groups]
        total = sum(w for _, w in ws)
        if total > 1e-6 and abs(total - 1) > 1e-4:
            for gi, w in ws:
                groups[gi].add([v.index], w / total, "REPLACE")


def _hem(g, arm, hang, n, nb, name):
    co = _world(g)
    below = co[:, 2] < hang
    if below.sum() < 8:
        raise ValueError(f"{g.name}: fewer than 8 vertices below hang {hang:.2f} m: nothing hangs")
    # Round the body's axis: the middle of a skirt's ring is, but the middle of a cape's own
    # vertices lies on the cape, and angles round it scramble which chain each part follows.
    mid = np.median(co[co[:, 2] < hang + 0.05][:, :2], axis=0)
    axis = np.array(arm.matrix_world @ arm.data.bones["pelvis"].head_local)[:2] if "pelvis" in arm.data.bones else mid
    centre = np.array([*axis, hang])
    ang = np.arctan2(co[:, 0] - centre[0], -(co[:, 1] - centre[1]))  # 0 in front (-Y), + toward its left (+X)
    a_below = ang[below]
    # Chains where the garment is: across its whole round, or the arc a cape covers.
    srt = np.sort(a_below)
    gaps = np.diff(np.concatenate([srt, [srt[0] + 2 * math.pi]]))
    k = int(np.argmax(gaps))
    if gaps[k] <= math.pi / 2:
        # A ring: round its own middle, as it always was.
        centre = np.array([*mid, hang])
        ang = np.arctan2(co[:, 0] - centre[0], -(co[:, 1] - centre[1]))
    if gaps[k] > math.pi / 2:
        lo = srt[(k + 1) % len(srt)]
        span = 2 * math.pi - gaps[k]
        angles = [lo + span * (i + 0.5) / n for i in range(n)]
        closed = False
    else:
        angles = [-math.pi + 2 * math.pi * (i + 0.5) / n for i in range(n)]
        closed = True
    parent = _nearest_bone(arm, centre)
    bottom = co[below][:, 2].min()
    width = 2 * math.pi / n if closed else (angles[1] - angles[0] if n > 1 else math.pi)
    made = {}
    for i, a in enumerate(angles):
        near = below & (np.abs(_wrap(ang - a)) < width / 2)
        sel = co[near] if near.sum() >= 3 else co[below]
        pts = []
        for j in range(nb + 1):
            z = hang + (bottom - hang) * j / nb
            band = sel[np.abs(sel[:, 2] - z) < max(0.02, (hang - bottom) / nb / 2)]
            r = np.median(np.hypot(band[:, 0] - centre[0], band[:, 1] - centre[1])) if len(band) else 0.1
            r *= 0.9  # inside the cloth, so the bone sits in it
            pts.append(Vector((centre[0] + r * math.sin(a), centre[1] - r * math.cos(a), z)))
        label = f"spring_{name}_{i + 1}"
        made[label] = helpers.add_chain(arm, label, parent, pts)
    # Weights below the hang line: the two nearest chains by angle, along them by height; above
    # it, blended back to the body's over a band.
    blend_band = max(0.04, 0.15 * (hang - bottom))
    labels = list(made)
    groups = {lab: [g.vertex_groups.get(b) or g.vertex_groups.new(name=b) for b in made[lab]] for lab in labels}
    body_groups = {vg.index for vg in g.vertex_groups if not vg.name.startswith("spring_")}
    for vi in np.nonzero(co[:, 2] < hang + blend_band)[0]:
        z = co[vi, 2]
        share = min(1.0, max(0.0, (hang + blend_band - z) / (2 * blend_band)))
        share = share * share * (3 - 2 * share)
        if share <= 0:
            continue
        d = np.array([abs(_wrap(ang[vi] - a)) for a in angles])
        order = np.argsort(d)
        i1, i2 = int(order[0]), int(order[1]) if n > 1 else int(order[0])
        if not closed and (d[i1] > width):
            i2 = i1
        w1 = 1.0 if i1 == i2 else d[i2] / max(1e-9, d[i1] + d[i2])
        t = min(1.0, max(0.0, (hang - z) / max(1e-6, hang - bottom))) * nb
        bi = min(nb - 1, int(t))
        f = t - bi
        for lab, w in ((labels[i1], w1), (labels[i2], 1 - w1)):
            if w <= 1e-4:
                continue
            gs = groups[lab]
            gs[bi].add([int(vi)], share * w * (1 - f if bi + 1 < nb else 1.0), "ADD")
            if bi + 1 < nb and f > 0:
                gs[bi + 1].add([int(vi)], share * w * f, "ADD")
        for el in g.data.vertices[int(vi)].groups:
            if el.group in body_groups:
                el.weight *= 1 - share
    return made


def _wrap(a):
    return (a + math.pi) % (2 * math.pi) - math.pi


def dangle(part, armature, start, end, *, bones=3, parent=None, name=None):
    """Hangs part (a scarf's end, a strap, a tassel) on one spring_ chain from start to end (world
    points along it); its vertices weight along the chain by where they project, blended into
    parent (the bone nearest start, if not given) at the root. Returns {chain: [bones]}."""
    o = _obj(part)
    arm = _obj(armature)
    name = name or o.name.lower().replace(" ", "_")[:12]
    a, b = np.asarray(start, float), np.asarray(end, float)
    parent = parent or _nearest_bone(arm, a)
    label = f"spring_{name}"
    pts = [Vector(a + (b - a) * j / bones) for j in range(bones + 1)]
    chain = helpers.add_chain(arm, label, parent, pts)
    co = _world(o)
    t = np.clip((co - a) @ (b - a) / max(1e-12, (b - a) @ (b - a)), 0, 1) * bones
    o.vertex_groups.clear()
    root = o.vertex_groups.new(name=parent)
    gs = [o.vertex_groups.new(name=n) for n in chain]
    for vi, tv in enumerate(t):
        if tv < 0.3:
            k = tv / 0.3
            root.add([vi], 1 - k, "REPLACE")
            gs[0].add([vi], k, "REPLACE")
            continue
        bi = min(bones - 1, int(tv))
        f = tv - bi
        gs[bi].add([vi], 1 - f if bi + 1 < bones else 1.0, "REPLACE")
        if bi + 1 < bones and f > 0:
            gs[bi + 1].add([vi], f, "REPLACE")
    if not any(m.type == "ARMATURE" for m in o.modifiers):
        o.modifiers.new("armature", "ARMATURE").object = arm
    if o.parent != arm:
        mw = o.matrix_world.copy()
        o.parent = arm
        o.matrix_world = mw
    stored = json.loads(arm.get("kurambit_chains", "{}") or "{}")
    stored[label] = chain
    arm["kurambit_chains"] = json.dumps(stored)
    return {label: chain}


def follow_hem(armature, follow=0.5):
    """Keys every hem chain's root, in every clip of the armature, to follow the thigh on its side
    (both thighs for a chain in front or behind, by how far round it is) by follow (0..1) of the
    thigh's swing, and up to PUSHED of it where the leg pushes into that part of the hem; and never
    less than keeps that chain outside both legs, so a knee coming up lifts the cloth over it
    instead of coming through. The game's springs swing it from there.
    Run it again after adding clips. Returns how many clips it keyed."""
    from .digest import exported_actions
    from .skeleton import assign_action

    arm = _obj(armature)
    hems = json.loads(arm.get("kurambit_hems", "{}") or "{}")
    if not hems or "thigh_l" not in arm.data.bones or "pelvis" not in arm.data.bones:
        return 0
    sc = bpy.context.scene
    keep = (arm.animation_data.action if arm.animation_data else None, sc.frame_current)
    chains_of = json.loads(arm.get("kurambit_chains", "{}") or "{}")
    lower = {root: [b for b in chains_of.get(lab, [root])[1:] if b in arm.data.bones] for lab, root in hems.items()}
    rest = {n: arm.data.bones[n].matrix_local.to_3x3() for n in ["pelvis", "thigh_l", "thigh_r", *hems.values(), *[b for bs in lower.values() for b in bs]]}
    side = {}
    for lab, root in hems.items():
        x = (arm.data.bones[root].head_local - arm.data.bones["pelvis"].head_local).x
        reach = max(1e-6, max(abs((arm.data.bones[r].head_local - arm.data.bones["pelvis"].head_local).x) for r in hems.values()))
        side[root] = 0.5 + 0.5 * max(-1.0, min(1.0, x / reach))  # 1: its left thigh only
    # A sheet's chains (a cape's) swing as one: each following its own thigh, a narrow sheet behind
    # the legs splits between them in a lunge.
    sheet = [r for r in json.loads(arm.get("kurambit_sheets", "[]") or "[]") if r in side]
    for root in sheet:
        side[root] = 0.5
    dirs = {}
    for root in hems.values():
        v = arm.data.bones[root].head_local - arm.data.bones["pelvis"].head_local
        v.z = 0
        dirs[root] = v.normalized() if v.length > 1e-6 else Vector((0, -1, 0))
    # What the hem must stay outside of: each leg as a run of balls down its bones, as thick as the
    # body is there, seen from each chain.
    limbs = _limbs(arm)
    clear = GARMENT_OFFSET + 0.006 * _size(_bodies(arm))
    reach = {}
    for lab, root in hems.items():
        bones = chains_of.get(lab, [root])
        d0 = arm.data.bones[bones[-1]].tail_local - arm.data.bones[root].head_local
        out0 = dirs[root]
        spacing = 2 * math.pi * max(0.05, (arm.data.bones[root].head_local - arm.data.bones["pelvis"].head_local).to_2d().length) / max(1, len(hems))
        reach[root] = (d0, d0.length, out0, Vector((0, 0, -1)).cross(out0), spacing)
    from mathutils import Quaternion

    closed_ring = len(hems) >= 5
    count = 0
    for act in exported_actions(arm):
        assign_action(arm, act)
        a, b = int(act.frame_range[0]), int(act.frame_range[1])
        for root in hems.values():
            for link in [root, *lower[root]]:
                arm.pose.bones[link].rotation_mode = "QUATERNION"
                arm.pose.bones[link].rotation_quaternion = (1, 0, 0, 0)
        for f in range(a, b + 1):
            sc.frame_set(f)
            pel = arm.pose.bones["pelvis"].matrix.to_3x3()
            swing, push = {}, {}
            for s in ("l", "r"):
                th = arm.pose.bones[f"thigh_{s}"].matrix.to_3x3()
                # The thigh's turn from rest, in the pelvis' frame, and which way it carries the knee.
                d = (rest["pelvis"] @ pel.inverted()) @ th @ rest[f"thigh_{s}"].inverted()
                swing[s] = d.to_quaternion()
                down = Vector((0, 0, -1))
                k = d @ down - down
                k.z = 0
                push[s] = k.normalized() if k.length > 1e-4 else None
            turns, lifts = {}, {}
            for root, wl in side.items():
                out_dir = Vector((dirs[root][0], dirs[root][1], 0))
                qs = {}
                for s in ("l", "r"):
                    # A leg pushing into this part of the hem carries it all the way; elsewhere part way.
                    into = max(0.0, push[s].dot(out_dir)) if push[s] is not None else 0.0
                    qs[s] = _toward(swing[s], follow + (PUSHED - follow) * into)
                turns[root] = qs["l"].slerp(qs["r"], 1 - wl)
                lifts[root] = _clear_of_legs(arm, root, turns[root], reach[root], limbs, clear)
            # A chain lifted over a knee takes its neighbours part of the way: cloth between a
            # chain at a knee's height and one hanging straight would stretch like a web.
            order = list(side)
            for _ in range(2):
                was = dict(lifts)
                for i, root in enumerate(order):
                    near = [was[order[j]] for j in ((i - 1) % len(order) if closed_ring else i - 1, (i + 1) % len(order) if closed_ring else i + 1) if 0 <= j < len(order)]
                    lifts[root] = max(was[root], SHARED * max(near, default=0.0))
            qs, drops = {}, {}
            if sheet:
                most = max(lifts[root] for root in sheet)
                lifts.update({root: most for root in sheet})
            for root in order:
                q = Quaternion(reach[root][3], lifts[root]) @ turns[root] if lifts[root] > 1e-4 else turns[root]
                # Its turn in armature axes, as the bone's own basis (it hangs from the hips).
                R = rest[root].inverted() @ q.to_matrix() @ rest[root]
                pb = arm.pose.bones[root]
                pb.rotation_quaternion = R.to_quaternion()
                pb.keyframe_insert("rotation_quaternion", frame=f)
                # Below the bone a leg lifts, cloth hangs: each lower bone falls back toward how it
                # hangs at rest, as far as still clears the leg beside it. Keyed stiff, the whole
                # chain turns as one stick and a skirt over a wide stance opens into a cone.
                qs[root], drops[root] = q, list(_drape(arm, root, lower[root], q, reach[root], limbs, clear))
            for root in order:
                for link, back in zip(lower[root], drops[root]):
                    cb = arm.pose.bones[link]
                    cb.rotation_quaternion = (rest[link].inverted() @ Quaternion(reach[root][3], -back).to_matrix() @ rest[link]).to_quaternion()
                    cb.keyframe_insert("rotation_quaternion", frame=f)
        count += 1
    assign_action(arm, keep[0])
    sc.frame_set(keep[1])
    return count


LEG = (("thigh", "calf"), ("calf", "foot"))


def _limbs(arm):
    """[(bone, the bone its far end is at, how thick the body is round it)] for both legs."""
    from . import deform

    out = []
    # As thick as the leg is with what it wears: a hem clears the trousers, not the skin under them.
    bodies = [*_bodies(arm), *[o for o in bpy.data.objects if o.get("kurambit_cloth") and arm in helpers._deforming(o)]]
    for s in ("l", "r"):
        for a, b in LEG:
            if f"{a}_{s}" not in arm.data.bones or f"{b}_{s}" not in arm.data.bones:
                continue
            h, t = np.array(arm.matrix_world @ arm.data.bones[f"{a}_{s}"].head_local), np.array(arm.matrix_world @ arm.data.bones[f"{b}_{s}"].head_local)
            seg = t - h
            radii = []
            for body in bodies:
                co, _ = helpers.rest_coords(body)
                if len(co) != len(body.data.vertices):
                    continue
                mine = co[np.array([l == f"{a}_{s}" for l in deform._dominant(body, arm)])]
                if len(mine):
                    u = np.clip((mine - h) @ seg / max(1e-12, seg @ seg), 0, 1)
                    radii.append(np.linalg.norm(mine - (h + np.outer(u, seg)), axis=1))
            thick = float(np.percentile(np.concatenate(radii), 75)) if radii else 0.08 * float(np.linalg.norm(seg))
            out.append((f"{a}_{s}", f"{b}_{s}", thick))
    return out


def _swing_needed(points, length, out0, axis0, spacing, clear):
    """The least angle from straight down, toward out0, a chain of that length must hang at to
    pass outside every ball in points ([(offset from the chain's hinge, radius)]); None when no
    ball is in front of it."""
    down = Vector((0, 0, -1))
    need = None
    for u, thick in points:
        along, below, across = u.dot(out0), u.dot(down), u.dot(axis0)
        far = math.hypot(along, below)
        if below < 0.05 * length or far > 1.15 * length or abs(across) > 0.9 * spacing + 0.5 * thick:
            continue
        # The chain's point as far from the hinge as the ball's centre is clears it by its radius.
        angle = math.atan2(along, below) + 2 * math.asin(min(0.95, (thick + clear) / (2 * max(far, 1e-6))))
        need = angle if need is None else max(need, angle)
    return need


def _clear_of_legs(arm, root, q, reach, limbs, clear):
    """How much further out (radians) the hem chain at root must turn, past q, to hang outside both
    legs: seen along the chain's own hinge, the chain swings no less than the widest ball of a leg
    in front of it. Part of a stride is not enough when a knee comes up into the cloth. The garment
    was made round the legs at rest, so whatever the measure says it lacks there is its slack."""
    d0, length, out0, axis0, spacing = reach
    pb = arm.pose.bones[root]
    parent = pb.parent
    if parent is None or length < 1e-6:
        return 0.0
    down = Vector((0, 0, -1))
    hinge0 = arm.data.bones[root].head_local
    at_rest = [(arm.data.bones[a].head_local.lerp(arm.data.bones[b].head_local, k / 6) - hinge0, thick) for a, b, thick in limbs for k in range(1, 7)]
    have0 = math.atan2(d0.dot(out0), d0.dot(down))
    need0 = _swing_needed(at_rest, length, out0, axis0, spacing, clear)
    slack = max(0.0, need0 - have0) if need0 is not None else 0.0
    carried = (parent.matrix.to_3x3() @ arm.data.bones[parent.name].matrix_local.to_3x3().inverted()).inverted()
    posed = [(carried @ (arm.pose.bones[a].head.lerp(arm.pose.bones[b].head, k / 6) - pb.head), thick) for a, b, thick in limbs for k in range(1, 7)]
    need = _swing_needed(posed, length, out0, axis0, spacing, clear)
    if need is None:
        return 0.0
    now = q @ d0
    have = math.atan2(now.dot(out0), now.dot(down))
    return max(0.0, min(need - slack, math.radians(95)) - have)


def _drape(arm, root, lower, q, reach, limbs, clear):
    """How far back toward straight down (radians, about the chain's hinge) each bone below a hem
    chain's root turns when the root is turned by q: all of the way back to its own rest angle,
    less whatever the leg beside that bone still needs."""
    _, _, out0, axis0, spacing = reach
    down = Vector((0, 0, -1))
    pb = arm.pose.bones[root]
    parent = pb.parent
    if parent is None or not lower:
        return [0.0] * len(lower)

    def angle(v):
        return math.atan2(v.dot(out0), v.dot(down))

    bones = [arm.data.bones[b] for b in [root, *lower]]
    vecs = [b.tail_local - b.head_local for b in bones]
    turned = angle(q @ vecs[0]) - angle(vecs[0])
    if turned < math.radians(2):
        return [0.0] * len(lower)
    carried = (parent.matrix.to_3x3() @ arm.data.bones[parent.name].matrix_local.to_3x3().inverted()).inverted()
    posed = [(carried @ (arm.pose.bones[a].head.lerp(arm.pose.bones[b].head, k / 6) - pb.head), thick) for a, b, thick in limbs for k in range(1, 7)]
    head = (q @ vecs[0]).dot(out0) * out0 + (q @ vecs[0]).dot(down) * down
    out, undone = [], 0.0
    for v in vecs[1:]:
        # Any of the leg ahead of this bone, level with it or below: it falls back only past that.
        need = None
        for u, thick in posed:
            u = u - head
            along, below, far = u.dot(out0), u.dot(down), math.hypot(u.dot(out0), u.dot(down))
            if along < -thick or far > 1.15 * v.length + thick or abs(u.dot(axis0)) > 0.9 * spacing + 0.5 * thick:
                continue
            a = math.atan2(along, below) + 2 * math.asin(min(0.95, (thick + clear) / (2 * max(far, 1e-6))))
            need = a if need is None else max(need, a)
        want = max(angle(v), need if need is not None else -math.pi)
        stiff = angle(v) + turned
        back = max(0.0, min(stiff - want, turned) - undone)
        out.append(back)
        undone += back
        hangs = stiff - undone
        head = head + (math.sin(hangs) * out0 + math.cos(hangs) * down) * v.length
    return out


def _toward(q, k):
    from mathutils import Quaternion

    return Quaternion().slerp(q, k)
