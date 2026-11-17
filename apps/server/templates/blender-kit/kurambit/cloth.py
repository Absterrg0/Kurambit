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
# The most of a thigh's swing a hem chain takes where the leg pushes into it: all of it folds the
# hem's front panel like a second leg (run 1's fisherman); this keeps it a panel the leg carries.
PUSHED = 0.8


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


def dress(garment, armature, *, body=None, offset=GARMENT_OFFSET, hang=None, chains=6, bones=3, name=None):
    """Fits garment (a mesh you modelled over the character at rest) and binds it.

    1. Shrinkwrap, outside only: every vertex inside the body moves out to offset metres above it;
       the rest keep the shape you modelled.
    2. Weights: the body's, by nearest surface (Data Transfer), so it bends as the skin under it.
    3. hang (a height in metres; a coat's or skirt's at the hips, a cape's at the shoulders): below
       it, the garment hangs on chains of spring_<name>_<i>_NN bones (bones each) around the hem,
       placed where the garment is, parented to the bone nearest the hang line's centre. 0 chains
       keeps the body's weights everywhere.
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
        g.vertex_groups.clear()
        dt = g.modifiers.new("weights", "DATA_TRANSFER")
        dt.object = target
        dt.use_vert_data = True
        dt.data_types_verts = {"VGROUP_WEIGHTS"}
        dt.vert_mapping = "POLYINTERP_NEAREST"
        dt.layers_vgroup_select_src = "ALL"
        dt.layers_vgroup_select_dst = "NAME"
        with bpy.context.temp_override(object=g, active_object=g):
            bpy.ops.object.datalayout_transfer(modifier=dt.name)
        _apply(g, dt)
    finally:
        if target not in bodies:
            bpy.data.objects.remove(target)
    for vg in list(g.vertex_groups):
        if vg.name not in arm.data.bones:
            g.vertex_groups.remove(vg)
    _unsleeved(g, arm)
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
    if made:
        stored = json.loads(arm.get("kurambit_chains", "{}") or "{}")
        stored.update(made)
        arm["kurambit_chains"] = json.dumps(stored)
        hems = json.loads(arm.get("kurambit_hems", "{}") or "{}")
        hems.update({k: v[0] for k, v in made.items()})
        arm["kurambit_hems"] = json.dumps(hems)
    return made


def _arm_bones(arm, side):
    top = arm.data.bones.get(f"upperarm_{side}")
    return {top.name, *(c.name for c in top.children_recursive)} if top is not None else set()


def _unsleeved(g, arm):
    """A garment with no sleeve on an arm takes none of that arm's weights: a coat's side panel
    beside a hanging hand would follow the hand. A sleeve is garment around the forearm."""
    co = _world(g)
    for side in ("l", "r"):
        bones = _arm_bones(arm, side)
        fore = arm.data.bones.get(f"lowerarm_{side}")
        if not bones or fore is None:
            continue
        h, t = np.array(arm.matrix_world @ fore.head_local), np.array(arm.matrix_world @ fore.tail_local)
        seg = t - h
        u = np.clip((co - h) @ seg / max(1e-12, seg @ seg), 0, 1)
        d = np.linalg.norm(co - (h + np.outer(u, seg)), axis=1)
        if (d < 0.25 * np.linalg.norm(seg)).sum() >= 12:
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
    centre = np.array([*np.median(co[co[:, 2] < hang + 0.05][:, :2], axis=0), hang])
    ang = np.arctan2(co[:, 0] - centre[0], -(co[:, 1] - centre[1]))  # 0 in front (-Y), + toward its left (+X)
    a_below = ang[below]
    # Chains where the garment is: across its whole round, or the arc a cape covers.
    srt = np.sort(a_below)
    gaps = np.diff(np.concatenate([srt, [srt[0] + 2 * math.pi]]))
    k = int(np.argmax(gaps))
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
    thigh's swing, and up to PUSHED of it where the leg pushes into that part of the hem, so a coat's hem steps with the legs and the game's springs swing it from there.
    Run it again after adding clips. Returns how many clips it keyed."""
    from .digest import exported_actions
    from .skeleton import assign_action

    arm = _obj(armature)
    hems = json.loads(arm.get("kurambit_hems", "{}") or "{}")
    if not hems or "thigh_l" not in arm.data.bones or "pelvis" not in arm.data.bones:
        return 0
    sc = bpy.context.scene
    keep = (arm.animation_data.action if arm.animation_data else None, sc.frame_current)
    rest = {n: arm.data.bones[n].matrix_local.to_3x3() for n in ["pelvis", "thigh_l", "thigh_r", *hems.values()]}
    side = {}
    for lab, root in hems.items():
        x = (arm.data.bones[root].head_local - arm.data.bones["pelvis"].head_local).x
        reach = max(1e-6, max(abs((arm.data.bones[r].head_local - arm.data.bones["pelvis"].head_local).x) for r in hems.values()))
        side[root] = 0.5 + 0.5 * max(-1.0, min(1.0, x / reach))  # 1: its left thigh only
    dirs = {}
    for root in hems.values():
        v = arm.data.bones[root].head_local - arm.data.bones["pelvis"].head_local
        v.z = 0
        dirs[root] = v.normalized() if v.length > 1e-6 else Vector((0, -1, 0))
    count = 0
    for act in exported_actions(arm):
        assign_action(arm, act)
        a, b = int(act.frame_range[0]), int(act.frame_range[1])
        for root in hems.values():
            arm.pose.bones[root].rotation_mode = "QUATERNION"
            arm.pose.bones[root].rotation_quaternion = (1, 0, 0, 0)
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
            for root, wl in side.items():
                out_dir = Vector((dirs[root][0], dirs[root][1], 0))
                qs = {}
                for s in ("l", "r"):
                    # A leg pushing into this part of the hem carries it all the way; elsewhere part way.
                    into = max(0.0, push[s].dot(out_dir)) if push[s] is not None else 0.0
                    qs[s] = _toward(swing[s], follow + (PUSHED - follow) * into)
                q = qs["l"].slerp(qs["r"], 1 - wl)
                # Its turn in armature axes, as the bone's own basis (it hangs from the hips).
                R = rest[root].inverted() @ q.to_matrix() @ rest[root]
                pb = arm.pose.bones[root]
                pb.rotation_quaternion = R.to_quaternion()
                pb.keyframe_insert("rotation_quaternion", frame=f)
        count += 1
    assign_action(arm, keep[0])
    sc.frame_set(keep[1])
    return count


def _toward(q, k):
    from mathutils import Quaternion

    return Quaternion().slerp(q, k)
