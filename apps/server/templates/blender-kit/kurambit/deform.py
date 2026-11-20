"""hero_gates(): a character's measured gates, on the one-shot pass's copy of the scene before the
style pass joins its meshes: height in its range, edge stretch and squash on every clip, clothing
inside the body, feet on walk and run, and the budget (gates.py holds the numbers' rules).

Clothing is a mesh marked kurambit_cloth (hero.dress marks it); the body is the character's body
mesh (stamped what: body). A hero's height leaves out what it holds and its tail: vertices led by
a hand's bones or a tail's, so a rod held overhead or a raised tail is not its height. Its range is the armature's kurambit_height [lo, hi] (game_blender op character's
height, hero.creature_rig's height); a body on the standard skeleton with none is a human,
1.5-2.0 m; a body on its own rig must declare one."""
import json
import math

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

from . import gates, helpers
from .digest import exported_actions
from .skeleton import assign_action

DEFORM_FRAMES = 8
LOCOMOTION = ("walk", "run", "jog", "sprint", "trot", "gallop", "canter", "hop")
STANDARD_FEET = ("ball_l", "ball_r")


def _clip_name(a):
    return a.get("kurambit_clip", a.name.split("|")[-1])


def held_or_dangling(arm):
    """Bones whose vertices are not the hero's height: a hand's and everything under it (a rod
    raised overhead), and a tail's. Ears, a hat and a hood count; a hem hangs below anyway."""
    out = set()
    for b in arm.data.bones:
        n = b.name
        if "tail" in n or n.startswith(("hand_", "prop")) or any(p.name.startswith("hand_") for p in b.parent_recursive):
            out.add(n)
    return out


def _dominant(o, arm):
    """Each vertex's leading bone (its heaviest group naming a bone), or the bone o hangs from."""
    n = len(o.data.vertices) if o.type == "MESH" else 0
    if o.parent == arm and o.parent_type == "BONE":
        return [o.parent_bone] * n
    names = {g.index: g.name for g in o.vertex_groups if g.name in arm.data.bones}
    out = []
    for v in o.data.vertices:
        best, w = None, 0.0
        for g in v.groups:
            if g.group in names and g.weight > w:
                best, w = names[g.group], g.weight
        out.append(best)
    return out


def hero_height(arm, meshes):
    """(height, the lowest z): the standing height of the body and what it wears, at rest."""
    skip = held_or_dangling(arm)
    lo, hi = None, None
    for o in meshes:
        if o.type != "MESH":
            continue
        co, _ = helpers.rest_coords(o)
        lead = _dominant(o, arm)
        if len(lead) == len(co):
            keep = np.array([b is None or b not in skip for b in lead], bool)
            if o.parent == arm and o.parent_type == "BONE" and not keep.any():
                continue
            co = co[keep] if keep.any() else co[:0]
        if len(co) == 0:
            continue
        lo = co[:, 2].min() if lo is None else min(lo, co[:, 2].min())
        hi = co[:, 2].max() if hi is None else max(hi, co[:, 2].max())
    if lo is None:
        return 0.0, 0.0
    return float(hi - lo), float(lo)


def _coords(o, dg):
    ev = o.evaluated_get(dg)
    me = ev.to_mesh()
    try:
        co = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get("co", co)
        m = np.array(ev.matrix_world)
        co = co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]
        polys = [tuple(p.vertices) for p in me.polygons]
        edges = np.empty(len(me.edges) * 2, dtype=np.int64)
        me.edges.foreach_get("vertices", edges)
    finally:
        ev.to_mesh_clear()
    return co, polys, edges.reshape(-1, 2)


def _frames(act, n):
    a, b = int(act.frame_range[0]), int(act.frame_range[1])
    if b <= a:
        return [a]
    return sorted({int(round(a + (b - a) * i / max(1, n - 1))) for i in range(n)})


def _surface(co, polys):
    """A BVH of the body with its faces turned consistently outward: a decimate or a join can flip
    some, and a flipped face reads a garment outside it as inside."""
    import bmesh

    bm = bmesh.new()
    verts = [bm.verts.new(p) for p in co.tolist()]
    for p in polys:
        try:
            bm.faces.new([verts[i] for i in p])
        except ValueError:  # a duplicate face
            pass
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    tree = BVHTree.FromBMesh(bm)
    bm.free()
    return tree


def _inside(points, body_co, body_polys, gone=None):
    """How deep each point is in the body; 0 where the skin nearest it does not ship (gone, per
    face): cloth cannot show skin that is not there."""
    tree = _surface(body_co, body_polys)
    near, nrm = np.empty_like(points), np.empty_like(points)
    kept = np.ones(len(points), bool)
    for i, p in enumerate(points):
        hit = tree.find_nearest(p)
        if hit[0] is None:
            near[i], nrm[i] = p, (0.0, 0.0, 1.0)
        else:
            near[i], nrm[i] = hit[0], hit[1]
            if gone is not None and hit[2] < len(gone) and gone[hit[2]]:
                kept[i] = False
    return np.where(kept, gates.depths(points, near, nrm), 0.0)


def _gone(bodies):
    """Per face of the merged bodies, whether it is left out of the export (cloth.dress marked every
    vertex of it as under a garment), and per vertex whether every face it is on is."""
    from .cloth import UNDER_GROUP

    faces, verts = [], []
    for o in bodies:
        g = o.vertex_groups.get(UNDER_GROUP)
        flag = np.zeros(len(o.data.vertices), bool)
        if g is not None:
            for v in o.data.vertices:
                flag[v.index] = any(e.group == g.index and e.weight > 0.5 for e in v.groups)
        polys = [tuple(p.vertices) for p in o.data.polygons]
        gone = np.array([all(flag[i] for i in p) for p in polys], bool) if polys else np.zeros(0, bool)
        shown = np.zeros(len(flag), bool)
        for p, x in zip(polys, gone):
            if not x:
                shown[list(p)] = True
        faces.append(gone)
        verts.append(~shown)
    return (np.concatenate(faces), np.concatenate(verts)) if faces else (np.zeros(0, bool), np.zeros(0, bool))


def _vertex_normals(co, polys):
    n = np.zeros_like(co)
    for p in polys:
        a, b, c = co[p[0]], co[p[1]], co[p[2]]
        fn = np.cross(b - a, c - a)
        for i in p:
            n[i] += fn
    return n / np.maximum(np.linalg.norm(n, axis=1), 1e-12)[:, None]


def _outer(o, dg, co, body):
    """The garment's outside: vertices whose normal faces away from the body at rest. A garment
    with thickness has an inside layer against the skin that a bending leg may cross unseen."""
    ev = o.evaluated_get(dg)
    me = ev.to_mesh()
    try:
        n = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get("normal", n)
    finally:
        ev.to_mesh_clear()
    n = n.reshape(-1, 3) @ np.array(o.matrix_world)[:3, :3].T
    tree = _surface(body[0], body[1])
    keep = np.ones(len(co), bool)
    for i, p in enumerate(co):
        hit = tree.find_nearest(p)
        if hit[0] is not None:
            keep[i] = float(np.dot(n[i], p - np.array(hit[0]))) >= 0
    return keep if keep.any() else np.ones(len(co), bool)


COVER_SAMPLES = 2500
# The fewest sampled vertices of one body part under a garment for its share to be read alone.
COVER_PART_MIN = 20
# How near an opening of a garment (a share of the body's height) skin stops counting as under it.
EDGE_MARGIN = 0.018


def _cover_rest(garment, body, height, hidden=None):
    """What of the body a garment covers at rest, and which side of each of its faces the body is
    on: (body vertex indices, the sign per garment face, each face's open edges). A body vertex is
    covered when the garment's nearest point to it is within reach, lies out along the skin's own
    normal, and is not on an open edge (beyond a hem the leg is past the cloth, not under it)."""
    gco, gpolys = garment[0], garment[1]
    bco, bpolys = body
    if not len(gpolys) or not len(bco):
        return None
    tree = BVHTree.FromPolygons([Vector(c) for c in gco.tolist()], gpolys)
    count = {}
    for f in gpolys:
        for a, b in zip(f, f[1:] + f[:1]):
            k = (min(a, b), max(a, b))
            count[k] = count.get(k, 0) + 1
    open_edges = [[(a, b) for a, b in zip(f, f[1:] + f[:1]) if count[(min(a, b), max(a, b))] == 1] for f in gpolys]
    # Skin within a seam's width of an opening comes and goes as the cloth shifts along the limb:
    # it is at the edge of the garment, not under it.
    from .cloth import _boundary_distance

    pairs = np.array(sorted(count), np.int64).reshape(-1, 2)
    rim = np.unique(np.array([k for k, c in count.items() if c == 1], np.int64).reshape(-1, 2)) if any(c == 1 for c in count.values()) else np.zeros(0, np.int64)
    depth = _boundary_distance(gco, pairs, rim) if len(rim) else np.full(len(gco), np.inf)
    deep = np.array([min(depth[i] for i in f) > EDGE_MARGIN * height for f in gpolys], bool)
    body_tree = _surface(bco, bpolys)
    sign = np.ones(len(gpolys))
    for i, f in enumerate(gpolys):
        c = gco[list(f)].mean(axis=0)
        pts = gco[list(f[:3])]
        n = np.cross(pts[1] - pts[0], pts[2] - pts[0])
        hit = body_tree.find_nearest(Vector(c))
        if hit[0] is not None:
            sign[i] = 1.0 if float(n @ (np.array(hit[0]) - c)) >= 0 else -1.0
    reach = 0.12 * height
    lo, hi = gco.min(axis=0) - reach, gco.max(axis=0) + reach
    near = np.nonzero(np.all((bco >= lo) & (bco <= hi), axis=1))[0]
    covered = []
    normals = _vertex_normals(bco, bpolys)
    for i in near:
        if hidden is not None and hidden[i]:
            continue  # skin that does not ship
        hit = tree.find_nearest(Vector(bco[i]), reach)
        if hit[0] is None or not deep[hit[2]] or _on_open_edge(np.array(hit[0]), gco, open_edges[hit[2]]):
            continue
        # Under the cloth: the cloth is out along the skin's own normal, not off to one side of it
        # (a chin over a collar is beside the cloth, not under it).
        to = np.array(hit[0]) - bco[i]
        far = np.linalg.norm(to)
        if far > 1e-6 and float(to @ normals[i]) / far < 0.35:
            continue
        # And this skin is what that cloth lies over: the skin nearest the cloth there is about as
        # far from it (a jaw 10 cm above a collar that lies on the shoulder is not under it).
        back = body_tree.find_nearest(hit[0])
        if back[0] is not None and np.linalg.norm(np.array(back[0]) - np.array(hit[0])) < 0.6 * far - 0.002:
            continue
        covered.append(int(i))
    if len(covered) > COVER_SAMPLES:
        covered = covered[::int(math.ceil(len(covered) / COVER_SAMPLES))]
    return np.array(covered, np.int64), sign, open_edges


def _on_open_edge(p, co, edges, tol=0.0015):
    for a, b in edges:
        seg = co[b] - co[a]
        u = min(1.0, max(0.0, float((p - co[a]) @ seg) / max(1e-12, float(seg @ seg))))
        if np.linalg.norm(p - (co[a] + seg * u)) < tol:
            return True
    return False


def _lies_over(cover, garment, under_co, height, rings=3):
    """The garment's faces that lie over what cover says is under it at rest, and rings of faces
    round them. A thigh under a skirt is under the skirt; when a sleeve swings past it the sleeve
    is nearer, and which side of a sleeve a thigh is on says nothing."""
    gco, gpolys = garment[0], garment[1]
    tree = BVHTree.FromPolygons([Vector(c) for c in gco.tolist()], gpolys)
    over = np.zeros(len(gpolys), bool)
    for i in cover[0]:
        hit = tree.find_nearest(Vector(under_co[i]))
        if hit[0] is not None:
            over[hit[2]] = True
    corner = np.array([v for f in gpolys for v in f], np.int64)
    face = np.repeat(np.arange(len(gpolys)), [len(f) for f in gpolys])
    for _ in range(rings):
        touched = np.zeros(len(gco), bool)
        touched[corner[over[face]]] = True
        grown = np.zeros(len(gpolys), bool)
        np.logical_or.at(grown, face, touched[corner])
        over |= grown
    # Not its rims: once a hem lifts past a leg the leg's nearest cloth is the hem's turned-in
    # edge, and the leg is past the cloth, not through it.
    from .cloth import _boundary_distance

    count = {}
    for f in gpolys:
        for a, b in zip(f, f[1:] + f[:1]):
            k = (min(a, b), max(a, b))
            count[k] = count.get(k, 0) + 1
    rim = np.unique(np.array([k for k, c in count.items() if c == 1], np.int64).reshape(-1, 2))
    if len(rim):
        depth = _boundary_distance(gco, np.array(sorted(count), np.int64).reshape(-1, 2), rim)
        over &= np.array([min(depth[i] for i in f) > EDGE_MARGIN * height for f in gpolys], bool)
    return over


def _shown(cover, garment, body_co, over=None):
    """How far outside the garment each covered body vertex is now (0 for one still under it);
    over: the only faces of the garment a vertex is read against."""
    idx, sign, open_edges = cover
    gco, gpolys = garment[0], garment[1]
    tree = BVHTree.FromPolygons([Vector(c) for c in gco.tolist()], gpolys)
    out = np.zeros(len(idx))
    for k, i in enumerate(idx):
        p = body_co[i]
        hit = tree.find_nearest(Vector(p))
        if hit[0] is None:
            continue
        near = np.array(hit[0])
        if (over is not None and not over[hit[2]]) or _on_open_edge(near, gco, open_edges[hit[2]]):
            continue
        f = gpolys[hit[2]]
        n = np.cross(gco[f[1]] - gco[f[0]], gco[f[2]] - gco[f[0]])
        length = np.linalg.norm(n)
        if length < 1e-12:
            continue
        side = sign[hit[2]] * float((p - near) @ n) / length
        out[k] = max(0.0, -side)
    return out


def _feet(arm):
    """(bone, which end) the feet are tracked by: the standard balls, the legs a creature rig names,
    or the lowest bone of each chain."""
    if all(f in arm.data.bones for f in STANDARD_FEET):
        return [(f, "head") for f in STANDARD_FEET]
    if "kurambit_legs" in arm:  # a made creature names its feet, none when it floats
        legs = json.loads(arm["kurambit_legs"] or "[]")
        return [(leg["foot"], "tail") for leg in legs if leg.get("foot") in arm.data.bones]
    from .measure import lowest_chains

    return [(n, "tail") for n in lowest_chains(arm)]


def _bone_point(arm, name, end):
    pb = arm.pose.bones[name]
    return np.array(arm.matrix_world @ (pb.head if end == "head" else pb.tail))


def hero_gates(arm, meshes, budgets, scale=1.0):
    """The gates of one character: a list of gates.gate dicts, every number in shipped metres
    (scale: what the style pass will scale it by)."""
    sc = bpy.context.scene
    fps = sc.render.fps / sc.render.fps_base
    out = []
    # A body that lost its Armature modifier would pass every gate hollow: nothing of it bends.
    loose = [o.name for o in meshes if o.type == "MESH" and arm not in helpers._deforming(o)
             and (helpers_stamp(o) or {}).get("what") == "body"]
    meshes = [o for o in meshes if o.type == "MESH" and (arm in helpers._deforming(o) or o.parent == arm)]
    rigid = any(o.parent == arm and o.parent_type == "BONE" for o in meshes)
    skinned = not loose and (rigid or any(arm in helpers._deforming(o) for o in meshes))
    height, ground = hero_height(arm, meshes)
    height *= scale
    declared = arm.get("kurambit_height")
    rng = None
    if declared:
        rng = [float(x) for x in json.loads(declared)] if isinstance(declared, str) else [float(x) for x in declared]
    elif not arm.get("kurambit_rig"):
        rng = list(gates.HUMAN_HEIGHT)
    if rng is None:
        out.append(gates.gate("height", False, round(height, 3), None,
                              f"{height:.2f} m tall, and no height range declared: a creature declares the brief's (armature['kurambit_height'] = [lo, hi])"))
    else:
        out.append(gates.height(height, rng[0], rng[1]))

    cloth = [o for o in meshes if o.get("kurambit_cloth")]
    body = [o for o in meshes if (helpers_stamp(o) or {}).get("what") == "body" and not o.get("kurambit_cloth")]
    skin = meshes
    dg = bpy.context.evaluated_depsgraph_get()
    ad = arm.animation_data or arm.animation_data_create()
    keep_action, keep_frame, keep_pos = ad.action, sc.frame_current, arm.data.pose_position

    arm.data.pose_position = "REST"
    dg.update()
    rest = {o.name: _coords(o, dg) for o in skin}
    rest_len = {n: gates.edge_lengths(c, e) for n, (c, _, e) in rest.items()}
    body_rest = _merged([rest[o.name] for o in body]) if body else None
    rest_depth = {}
    outer = {}
    if body_rest is not None:
        gone_faces, gone_verts = _gone(body)
        if len(gone_faces) != len(body_rest[1]) or len(gone_verts) != len(body_rest[0]):
            gone_faces = gone_verts = None
        for o in cloth:
            rest_depth[o.name] = _inside(rest[o.name][0], *body_rest, gone_faces)
            outer[o.name] = _outer(o, dg, rest[o.name][0], body_rest)
    cover = {}
    if body_rest is not None:
        for o in cloth:
            c = _cover_rest(rest[o.name], body_rest, height / max(scale, 1e-9), gone_verts)
            # Read against the cloth that lies over that skin: a forearm swinging past a skirt is
            # nearer the skirt than its own sleeve, and is not under the skirt.
            cover[o.name] = None if c is None else (c, _lies_over(c, rest[o.name], body_rest[0], height / max(scale, 1e-9)))
    # Cloth under cloth, read the same way: what of one garment another lies over at rest.
    layered = {}
    for under in cloth:
        for over in cloth:
            if under is over or not len(rest[under.name][1]) or not len(rest[over.name][1]):
                continue
            c = _cover_rest(rest[over.name], (rest[under.name][0], rest[under.name][1]), height / max(scale, 1e-9))
            if c is not None and len(c[0]) >= COVER_PART_MIN:
                layered[(under.name, over.name)] = (c, _lies_over(c, rest[over.name], rest[under.name][0], height / max(scale, 1e-9)))
    worst_layer = (0.0, None, 0.0)
    body_lead = [l for o in body for l in _dominant(o, arm)] if body else []
    worst_shown = (0.0, None, 0.0)
    leads = {o.name: _dominant(o, arm) for o in skin}
    arm.data.pose_position = "POSE"
    for pb in arm.pose.bones:
        pb.matrix_basis.identity()
    dg.update()
    feet = _feet(arm)
    contact_max, slide_max = gates.feet_limits(height / max(scale, 1e-9))
    feet_rest = {f: _bone_point(arm, f, end)[2] for f, end in feet}

    worst_stretch = (1.0, None)
    worst_spread = (1.0, None)
    worst_squash = (1.0, None)
    min_edge = gates.EDGE_SHARE * height / max(scale, 1e-9)
    worst_cloth = (0.0, None, 0.0)
    worst_contact, worst_slide = (0.0, None), (0.0, None)
    clips = exported_actions(arm)
    try:
        for act in clips:
            name = _clip_name(act)
            assign_action(arm, act)
            for f in _frames(act, DEFORM_FRAMES):
                sc.frame_set(f)
                dg.update()
                posed = {o.name: _coords(o, dg) for o in skin}
                for o in skin:
                    co, _, e = posed[o.name]
                    if len(co) != len(rest[o.name][0]):
                        continue
                    s = gates.strain(rest_len[o.name], gates.edge_lengths(co, e), min_edge)
                    if s is None:
                        continue
                    if s["spread"] > worst_spread[0]:
                        worst_spread = (s["spread"], (name, f, o.name, _edge_bone(leads[o.name], e, s["spread_edge"])))
                    if s["worst"] > worst_stretch[0]:
                        worst_stretch = (s["worst"], (name, f, o.name, _edge_bone(leads[o.name], e, s["edge"])))
                    if s["squash"] < worst_squash[0]:
                        worst_squash = (s["squash"], (name, f, o.name, None))
                if body_rest is not None and cloth:
                    merged = _merged([posed[o.name] for o in body])
                    for o in cloth:
                        if len(posed[o.name][0]) != len(rest_depth[o.name]):
                            continue
                        keep = outer[o.name]
                        d = _inside(posed[o.name][0][keep], *merged, gone_faces)
                        depth, i, share = gates.sunk(d, rest_depth[o.name][keep])
                        i = None if i is None else int(np.nonzero(keep)[0][i])
                        if share > gates.CLOTH_SHARE_MAX and depth > worst_cloth[0]:
                            worst_cloth = (depth, (name, f, o.name, leads[o.name][i] if i is not None else None), share)
                        elif worst_cloth[1] is None and depth > worst_cloth[0]:
                            worst_cloth = (depth, (name, f, o.name, leads[o.name][i] if i is not None else None), share)
                        c, faces = cover.get(o.name) or (None, None)
                        if c is None or not len(c[0]):
                            continue
                        shown = _shown(c, posed[o.name], merged[0], faces)
                        # By body part: a hole is as big as it is, however much else the garment covers.
                        through, part, at = float(shown.max()), float(np.mean(shown > gates.CLOTH_DEPTH_MAX)), None
                        if body_lead:
                            bones = np.array([body_lead[int(i)] or "" for i in c[0]])
                            for bone in set(bones.tolist()):
                                mine = bones == bone
                                if mine.sum() >= COVER_PART_MIN:
                                    share = float(np.mean(shown[mine] > gates.CLOTH_DEPTH_MAX))
                                    if share > part or at is None:
                                        part, at, through = max(part, share), bone, max(through, float(shown[mine].max())) if share >= part else through
                            at = at or body_lead[int(c[0][int(np.argmax(shown))])]
                        if (part > gates.CLOTH_SHARE_MAX) > (worst_shown[2] > gates.CLOTH_SHARE_MAX) or (
                                (part > gates.CLOTH_SHARE_MAX) == (worst_shown[2] > gates.CLOTH_SHARE_MAX) and through > worst_shown[0]):
                            worst_shown = (through, (name, f, o.name, at), part)
                for (under, over), (c, faces) in layered.items():
                    if len(posed[under][0]) != len(rest[under][0]) or len(posed[over][0]) != len(rest[over][0]):
                        continue
                    shown = _shown(c, posed[over], posed[under][0], faces)
                    bones = np.array([leads[under][int(i)] or "" for i in c[0]])
                    for bone in set(bones.tolist()):
                        mine = bones == bone
                        if mine.sum() < COVER_PART_MIN:
                            continue
                        share, through = float(np.mean(shown[mine] > gates.CLOTH_DEPTH_MAX)), float(shown[mine].max())
                        if (share > gates.CLOTH_SHARE_MAX) > (worst_layer[2] > gates.CLOTH_SHARE_MAX) or (
                                (share > gates.CLOTH_SHARE_MAX) == (worst_layer[2] > gates.CLOTH_SHARE_MAX) and through > worst_layer[0]):
                            worst_layer = (through, (name, f, f"{under} through {over}", bone), share)
            if feet and any(w in name.lower() for w in LOCOMOTION) and "idle" not in name.lower():
                a, b = int(act.frame_range[0]), int(act.frame_range[1])
                tracks = {fb: [] for fb, _ in feet}
                for f in range(a, b + 1):
                    sc.frame_set(f)
                    for fb, end in feet:
                        tracks[fb].append(_bone_point(arm, fb, end))
                band = {fb: 0.25 * contact_max + 0.003 for fb, _ in feet}
                speed = gates.ground_speed(tracks, band, fps)
                for fb, _ in feet:
                    tr = np.array(tracks[fb])
                    planted = gates.plants(tr, band[fb])
                    contact, cat, slide, sat = gates.feet(tr, feet_rest[fb], planted, speed, fps)
                    if contact > worst_contact[0]:
                        worst_contact = (contact, (name, a + (cat or 0), fb))
                    if slide > worst_slide[0]:
                        worst_slide = (slide, (name, a + (sat or 0), fb))
    finally:
        assign_action(arm, keep_action)
        arm.data.pose_position = keep_pos
        sc.frame_set(keep_frame)

    def where(w):
        if w is None:
            return ""
        clip, frame, part, bone = w
        return f" ({clip} frame {frame}, {part}{' at ' + bone if bone else ''})"

    ok = gates.deformation(worst_spread[0], worst_stretch[0], worst_squash[0]) and bool(skinned)
    if not skinned:
        # Nothing bends with the armature (a body that lost its Armature modifier): a pass here
        # would be hollow.
        out.append(gates.gate("deformation", False, 0.0, None,
                              f"the body does not deform with {arm.name} ({', '.join(loose[:4]) or 'no mesh is bound'}): bind it (an Armature modifier on {arm.name}) and review again"))
        ok = None
    if ok is not None:
        out.append(gates.gate("deformation", ok, round(worst_spread[0], 2), [gates.SQUASH_SPREAD_MIN, gates.STRETCH_SPREAD_MAX, gates.STRETCH_WORST_MAX],
                              f"edges stretch {worst_spread[0]:.2f}x at the 99.9th percentile{where(worst_spread[1])}, {worst_stretch[0]:.2f}x at worst{where(worst_stretch[1])}, and squash to {worst_squash[0]:.2f}x at the 0.1st{where(worst_squash[1])}"
                              + ("" if ok else f" (limits {gates.STRETCH_SPREAD_MAX}x, {gates.STRETCH_WORST_MAX}x and {gates.SQUASH_SPREAD_MIN}x): a spread past its limit is a joint whose weights tear or a garment split by the legs (hang it on chains); a single worst edge is a vertex weighted to the wrong bone")))
    if cloth:
        depth = worst_cloth[0] * scale
        sunk_ok = not (worst_cloth[0] > gates.CLOTH_DEPTH_MAX and worst_cloth[2] > gates.CLOTH_SHARE_MAX)
        # The same limits read from the skin's side: a thigh through a skirt between the skirt's
        # own vertices sinks none of them, and is the hole a person sees.
        shown_ok = not (worst_shown[0] > gates.CLOTH_DEPTH_MAX and worst_shown[2] > gates.CLOTH_SHARE_MAX)
        # And between garments: trousers through the coat over them is a hole in the coat.
        layer_ok = not (worst_layer[0] > gates.CLOTH_DEPTH_MAX and worst_layer[2] > gates.CLOTH_SHARE_MAX)
        ok = sunk_ok and shown_ok and layer_ok
        through, between = worst_shown[0] * scale, worst_layer[0] * scale
        limit = f"{gates.CLOTH_DEPTH_MAX * 1000:.0f} mm"
        sunk = (f"clothing sinks at most {depth * 1000:.0f} mm into the body{where(worst_cloth[1])}, "
                f"{worst_cloth[2] * 100:.1f}% of its vertices past {limit}")
        shown = (f"the body comes at most {through * 1000:.0f} mm through it{where(worst_shown[1])}, "
                 f"{worst_shown[2] * 100:.1f}% of that part's skin under it past {limit}")
        layer = (f"one garment comes at most {between * 1000:.0f} mm through another{where(worst_layer[1])}, "
                 f"{worst_layer[2] * 100:.1f}% of what is under it there past {limit}")
        # A refusal names only what failed, each with its fix, so the text stays inside the protocol.
        failed = ([sunk + ": lift it (hero.dress offset), weight it like the body under it, or hang the hem on chains"] if not sunk_ok else []) + \
                 ([shown + ": the body shows through: widen it there, or take its weights from the body (Data Transfer)"] if not shown_ok else []) + \
                 ([layer + ": the under garment shows through. Make it first, run hero.follow_hem after adding clips, or end the outer one higher (a closed skirt past mid-thigh does not clear a lunge)"] if not layer_ok else [])
        out.append(gates.gate("cloth", ok, round(max(depth, through, between) * 1000, 1), gates.CLOTH_DEPTH_MAX * 1000,
                              "; ".join(failed) if failed else "; ".join([sunk, shown] + ([layer] if layered else []))))
    if feet and any(any(w in _clip_name(a).lower() for w in LOCOMOTION) for a in clips):
        c, s = worst_contact[0] * scale, worst_slide[0] * scale
        ok = worst_contact[0] <= contact_max and worst_slide[0] <= slide_max
        out.append(gates.gate("feet", ok, round(s * 100, 1), round(slide_max * scale * 100, 1),
                              f"planted feet {c * 100:.1f} cm off the ground at worst{where(_w3(worst_contact[1]))}, sliding {s * 100:.1f} cm{where(_w3(worst_slide[1]))}"
                              + ("" if ok else f" (limits {contact_max * scale * 100:.1f} cm and {slide_max * scale * 100:.1f} cm at this height): key the feet planted, or regenerate the gait")))
    tris = sum(len(p.vertices) - 2 for o in meshes for p in o.data.polygons)
    mats = len({s.material.name for o in meshes for s in o.material_slots if s.material})
    textures = [{"width": i.size[0], "height": i.size[1]} for i in bpy.data.images if i.size[0] > 0 and i.users > 0]
    out.append(gates.budget(tris, mats, textures, {"triangles": budgets["character"], "texture": budgets["texture"]}))
    return out


def _w3(w):
    return None if w is None else (w[0], w[1], w[2], None)


def _edge_bone(lead, edges, i):
    if i is None or i >= len(edges):
        return None
    return lead[edges[i][0]] if edges[i][0] < len(lead) else None


def _merged(parts):
    cos, polys, off = [], [], 0
    for co, ps, _ in parts:
        cos.append(co)
        polys += [tuple(v + off for v in p) for p in ps]
        off += len(co)
    return np.concatenate(cos) if cos else np.zeros((0, 3)), polys


def helpers_stamp(o):
    try:
        return json.loads(o.get("kurambit_source", ""))
    except (TypeError, ValueError):
        return None
