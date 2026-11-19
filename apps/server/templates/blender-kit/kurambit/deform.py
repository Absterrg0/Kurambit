"""hero_gates(): a character's measured gates, on the one-shot pass's copy of the scene before the
style pass joins its meshes: height in its range, edge stretch and squash on every clip, clothing
inside the body, feet on walk and run, and the budget (gates.py holds the numbers' rules).

Clothing is a mesh marked kurambit_cloth (hero.dress marks it); the body is the character's body
mesh (stamped what: body). A hero's height leaves out what it holds and its tail: vertices led by
a hand's bones or a tail's, so a rod held overhead or a raised tail is not its height. Its range is the armature's kurambit_height [lo, hi] (game_blender op character's
height, hero.creature_rig's height); a body on the standard skeleton with none is a human,
1.5-2.0 m; a body on its own rig must declare one."""
import json

import bpy
import numpy as np
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


def _inside(points, body_co, body_polys):
    tree = _surface(body_co, body_polys)
    near, nrm = np.empty_like(points), np.empty_like(points)
    for i, p in enumerate(points):
        hit = tree.find_nearest(p)
        if hit[0] is None:
            near[i], nrm[i] = p, (0.0, 0.0, 1.0)
        else:
            near[i], nrm[i] = hit[0], hit[1]
    return gates.depths(points, near, nrm)


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
                              f"{height:.2f} m tall, and no height range declared: a creature declares the brief's (hero.creature_rig height=(lo, hi), or armature['kurambit_height'] = [lo, hi])"))
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
        for o in cloth:
            rest_depth[o.name] = _inside(rest[o.name][0], *body_rest)
            outer[o.name] = _outer(o, dg, rest[o.name][0], body_rest)
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
                        d = _inside(posed[o.name][0][keep], *merged)
                        depth, i, share = gates.sunk(d, rest_depth[o.name][keep])
                        i = None if i is None else int(np.nonzero(keep)[0][i])
                        if share > gates.CLOTH_SHARE_MAX and depth > worst_cloth[0]:
                            worst_cloth = (depth, (name, f, o.name, leads[o.name][i] if i is not None else None), share)
                        elif worst_cloth[1] is None and depth > worst_cloth[0]:
                            worst_cloth = (depth, (name, f, o.name, leads[o.name][i] if i is not None else None), share)
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
        ok = not (worst_cloth[0] > gates.CLOTH_DEPTH_MAX and worst_cloth[2] > gates.CLOTH_SHARE_MAX)
        out.append(gates.gate("cloth", ok, round(depth * 1000, 1), gates.CLOTH_DEPTH_MAX * 1000,
                              f"clothing sinks at most {depth * 1000:.0f} mm into the body{where(worst_cloth[1])}, {worst_cloth[2] * 100:.1f}% of its vertices past {gates.CLOTH_DEPTH_MAX * 1000:.0f} mm"
                              + ("" if ok else ": lift it (hero.dress offset), weight it like the body under it, or hang the hem on chains")))
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
