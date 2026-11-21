"""rig(): a static model made into a skinned character with clips, on a Mesh2Motion template or on
chains, and the facts of how its clips deform it.

    rig(objects, template=None, chains=None, joints=None, rigid=(), clips=(), name=None, pack=None)

objects   the model's meshes (names or objects), standing on Z = 0 and facing -Y, a person in A- or
          T-pose with arms clear of the torso; props (a sword, a shield) are separate objects in rigid
template  a TEMPLATES id (human, fox, horse, bird, dragon, kaiju, spider, snake, fish): the template's
          skeleton is fitted into the model (landmarks for human and four-legged ones, the reference
          body's box otherwise), joints moves the ones named, and the template's clips play on it.
          None: chains.
chains    the chain spec (rigchains.py), or None for a guess from the parts (it finds chains, not knees)
joints    {bone: [x, y, z]}: where a template's joints are, which the agent knows because it built the
          model (human also takes shoulder_l, elbow_l, wrist_l, hip_l, knee_l, ankle_l, chest, neck)
rigid     {object: bone or None}: parts moved by one bone, never bent (None: the nearest bone)
clips     names from the template's clips (Mesh2Motion's, e.g. Idle_A, Walk, Sword_Attack) or, on
          chains, from default_clips' roles; empty: Idle, a move and an attack
pack      the Mesh2Motion pack's folder (the server resolves it)

Body parts are weighted by Blender's bone heat; a part heat cannot weight (overlapping or open
parts) is weighted on a voxel copy and the weights carried back. The facts are notes, never refusals:
each clip's worst edge stretch, how fast planted feet slide, parts other than feet going under the
floor, and chains passing through each other.
"""
import json
import math
import os

import bpy
import numpy as np
from mathutils import Matrix, Vector

from . import rigchains, rigfit
from .helpers import action_name
from .protocol import Refused, entry

LICENCE = "CC0 1.0 (Mesh2Motion rigs and clips)"
PACK = "mesh2motion-rigs"
POSE_MISMATCH_DEG = 20
UNWEIGHTED_SHARE = 0.002
FACT_FRAMES = 10
# What a clip-less call gets, first name found in the template's clips.
DEFAULT_CLIPS = {
    "human": [("Idle_A",), ("Walk",), ("Jog",), ("Sword_Attack", "Punch_Cross")],
    "fox": [("Idle",), ("Walk",), ("Run",), ("Bite",)],
    "horse": [("Idle",), ("Walk",), ("Run",), ("Kick",)],
    "kaiju": [("Idle",), ("Walk",), ("Attack",)],
    "spider": [("Idle",), ("Walk",), ("Attack",)],
    "snake": [("Idle",), ("Side winding",), ("Bite",)],
    "dragon": [("Idle",), ("Walk",), ("Fly Flap",), ("Attack",)],
    "bird": [("Idle",), ("Walk",), ("Flap",), ("Glide",)],
    "fish": [("Idle",), ("Swim Horizontal",), ("Bite",)],
}


def _mesh(o):
    if isinstance(o, str):
        if o not in bpy.data.objects:
            raise Refused("invalid-input", f"no object {o} in the scene")
        o = bpy.data.objects[o]
    if o.type != "MESH":
        raise Refused("invalid-input", f"{o.name} is a {o.type.lower()}, not a mesh: rig names the model's meshes")
    return o


def _gather(names):
    """Meshes from names of meshes, collections, or objects holding meshes (an earlier rig)."""
    out = []
    for n in names:
        if not isinstance(n, str):
            out.append(_mesh(n))
            continue
        o = bpy.data.objects.get(n)
        if o is not None and o.type != "MESH":
            out += [c for c in o.children_recursive if c.type == "MESH"]
        elif o is None and n in bpy.data.collections:
            out += [c for c in bpy.data.collections[n].all_objects if c.type == "MESH"]
        else:
            out.append(_mesh(n))
    return out


def _unparent(o):
    mw = o.matrix_world.copy()
    o.parent = None
    o.matrix_world = mw


def _strip(o):
    """A part as a static mesh: no armature, weights or parent; its transform applied."""
    for m in list(o.modifiers):
        if m.type == "ARMATURE":
            o.modifiers.remove(m)
    o.vertex_groups.clear()
    _unparent(o)
    if o.data.users > 1:
        o.data = o.data.copy()
    o.data.transform(o.matrix_world)
    o.matrix_world = Matrix()


def _unweighted(o):
    return sum(1 for v in o.data.vertices if sum(g.weight for g in v.groups) < 1e-3)


def _heat(target, arm):
    rigchains.active(target)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    return _unweighted(target)


def auto_weights(meshes, arm, deform):
    """Bone heat for meshes from the deform bones only, done on one joined copy so layered parts
    (a cape over a body) take matching weights; when heat leaves part of the copy unweighted, on a
    voxel remesh of it. The weights reach each mesh by nearest-face interpolation. Says which ran."""
    for b in arm.data.bones:
        b.use_deform = b.name in deform
    copies = []
    for o in meshes:
        c = o.copy()
        c.data = o.data.copy()
        c.modifiers.clear()
        c.vertex_groups.clear()
        bpy.context.scene.collection.objects.link(c)
        copies.append(c)
    rigchains.active(copies[0])
    for c in copies:
        c.select_set(True)
    if len(copies) > 1:
        bpy.ops.object.join()
    src = bpy.context.view_layer.objects.active
    n = len(src.data.vertices)
    miss = _heat(src, arm)
    how = "heat"
    if miss > UNWEIGHTED_SHARE * n:
        proxy = src.copy()
        proxy.data = src.data.copy()
        bpy.context.scene.collection.objects.link(proxy)
        proxy.parent = None
        proxy.modifiers.clear()
        proxy.vertex_groups.clear()
        r = proxy.modifiers.new("remesh", "REMESH")
        r.mode, r.voxel_size = "VOXEL", max(proxy.dimensions) / 120
        rigchains.active(proxy)
        bpy.ops.object.modifier_apply(modifier="remesh")
        _heat(proxy, arm)
        bpy.data.objects.remove(src)
        src = proxy
        how = f"heat on a voxel copy ({miss} of {n} vertices unweighted by heat)"
    for o in meshes:
        o.vertex_groups.clear()
        dt = o.modifiers.new("kurambit_weights", "DATA_TRANSFER")
        dt.object, dt.use_vert_data = src, True
        dt.data_types_verts, dt.vert_mapping = {"VGROUP_WEIGHTS"}, "POLYINTERP_NEAREST"
        dt.layers_vgroup_select_src, dt.layers_vgroup_select_dst = "ALL", "NAME"
        rigchains.active(o)
        bpy.ops.object.datalayout_transfer(modifier=dt.name)
        bpy.ops.object.modifier_apply(modifier=dt.name)
        _skin(o, arm)
    bpy.data.objects.remove(src)
    return how


def _skin(o, arm):
    """o follows arm by its vertex groups, at most four bones a vertex, normalised (glTF keeps four)."""
    for m in list(o.modifiers):
        if m.type == "ARMATURE":
            o.modifiers.remove(m)
    o.modifiers.new("Armature", "ARMATURE").object = arm
    o.parent = arm
    o.matrix_parent_inverse = arm.matrix_world.inverted()
    if o.vertex_groups:
        rigchains.active(o)
        bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
        bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)


def _one_bone(o, arm, bone):
    o.vertex_groups.clear()
    o.vertex_groups.new(name=bone).add(range(len(o.data.vertices)), 1.0, "REPLACE")
    _skin(o, arm)


def _nearest(arm, p, among):
    W = arm.matrix_world
    return min(among, key=lambda n: rigchains.seg_dist(p, W @ arm.data.bones[n].head_local, W @ arm.data.bones[n].tail_local))


def _centre(o):
    return sum((o.matrix_world @ v.co for v in o.data.vertices), Vector()) / max(len(o.data.vertices), 1)


# ------------------------------------------------------------------ template path
def _import_template(pack, template):
    man = rigchains.manifest(pack, template)
    objs, acts = rigchains.import_glb(os.path.join(pack, man["skeleton"]["file"]))
    bpy.data.batch_remove(acts)
    T = next(o for o in objs if o.type == "ARMATURE")
    bpy.data.batch_remove([o for o in objs if o is not T])
    T.animation_data_clear()
    objs, acts = rigchains.import_glb(os.path.join(pack, man["model"]["file"]))
    bpy.data.batch_remove(acts)
    # Mesh2Motion files carry a 2 m Icosphere helper beside the body.
    ref = [o for o in objs if o.type == "MESH" and not o.name.startswith("Icosphere")]
    bpy.data.batch_remove([o for o in objs if o not in ref])
    for o in ref:
        _strip(o)
    return T, ref, man


def _build_fitted(T, heads, s, name, collection, limbs, turns):
    """The template's armature with its joints moved: each bone keeps the template's roll, turned by
    the least rotation from its template direction to its fitted one. Returns it and the bones whose
    clips copy world orientation (limbs, and bones turned past POSE_MISMATCH_DEG: a drooping tail on a
    level-tailed template), so the clip's pose lands where it puts it whatever the model's rest."""
    F = T.copy()
    F.data = T.data.copy()
    F.name = F.data.name = name
    collection.objects.link(F)
    F.animation_data_clear()
    rigchains.active(F)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = F.data.edit_bones
    tmpl = {b.name: (b.matrix.copy(), b.length, [c.name for c in b.children]) for b in eb}
    turned, base = {}, {}
    for b in eb:
        b.use_connect = False
    for b in eb:  # parents come first
        # A bone whose whole frame the fit turned (a hand), and what hangs from it, starts from that
        # turn, so a palm and its fingers keep the model's roll.
        base[b.name] = turns.get(b.name) or (base.get(b.parent.name) if b.parent is not None else None)
    for b in eb:
        m, length, kids = tmpl[b.name]
        h, rot = heads[b.name], m.to_3x3()
        if base[b.name] is not None:
            q0 = base[b.name]
            rot = q0.to_matrix() @ rot
            m = Matrix.Translation(m.translation) @ rot.to_4x4()
            if kids:
                c, tdir = heads[kids[0]] - h, q0 @ (tmpl[kids[0]][0].translation - tmpl[b.name][0].translation)
                if c.length > 1e-4 and tdir.length > 1e-4:
                    rot = tdir.rotation_difference(c).to_matrix() @ rot
                length = max(c.length, 1e-3) if c.length > 1e-4 else length * s
            else:
                length *= s
            b.matrix = Matrix.Translation(h) @ rot.to_4x4()
            b.length = max(length, 1e-3)
            continue
        if kids:
            c, tdir = heads[kids[0]] - h, tmpl[kids[0]][0].translation - m.translation
            if c.length > 1e-4 and tdir.length > 1e-4:
                q = tdir.rotation_difference(c)
                rot = q.to_matrix() @ rot
                turned[b.name] = math.degrees(q.angle)
                length = max(c.dot(rot.col[1].normalized()), length * s * 0.5)
            else:
                length *= s
        else:
            p = b.parent
            if p is not None:
                pm, _, pk = tmpl[p.name]
                pc, pt = heads[pk[0]] - heads[p.name], tmpl[pk[0]][0].translation - pm.translation
                if pc.length > 1e-4 and pt.length > 1e-4:
                    rot = pt.rotation_difference(pc).to_matrix() @ rot
            length *= s
        b.matrix = Matrix.Translation(h) @ rot.to_4x4()
        b.length = max(length, 1e-3)
    bpy.ops.object.mode_set(mode="OBJECT")
    world = set()
    for b in F.data.bones:  # parents come first
        if b.name in limbs or turned.get(b.name, 0) > POSE_MISMATCH_DEG or (b.parent and b.parent.name in world):
            world.add(b.name)
    return F, world


def _bake_template(T, F, world, clips, track, action_for, renamed):
    """Each fitted bone copies its template bone's rotation (world for `world`, rest-relative for the
    rest), the tracking bone and root its world location, with the template scaled so its tracking
    bone stands as high as the fitted one; each clip is baked into its own action."""
    th = T.matrix_world @ T.data.bones[track].head_local
    fh = F.matrix_world @ F.data.bones[track].head_local
    k = (fh.z - F.matrix_world.translation.z) / max(th.z - T.matrix_world.translation.z, 1e-6)
    T.scale = (k, k, k)
    bpy.context.view_layer.update()
    T.location += fh - T.matrix_world @ T.data.bones[track].head_local
    bpy.context.view_layer.update()
    for pb in F.pose.bones:
        c = pb.constraints.new("COPY_ROTATION")
        c.target, c.subtarget = T, renamed.get(pb.name, pb.name)
        c.target_space = c.owner_space = "WORLD" if renamed.get(pb.name, pb.name) in world else "LOCAL"
        if pb.name in (track, "root"):
            c = pb.constraints.new("COPY_LOCATION")
            c.target, c.subtarget = T, pb.name
            c.target_space = c.owner_space = "WORLD"
    made = []
    try:
        for name, act in clips:
            T.animation_data_create()
            T.animation_data.action = act
            if act.slots:
                T.animation_data.action_slot = act.slots[0]
            f0, f1 = int(act.frame_range[0]), int(act.frame_range[1])
            out = action_for(name)
            F.animation_data_create()
            F.animation_data.action = out
            rigchains.active(F)
            bpy.ops.object.mode_set(mode="POSE")
            bpy.ops.pose.select_all(action="SELECT")
            bpy.ops.nla.bake(frame_start=f0, frame_end=f1, only_selected=True, visual_keying=True,
                             clear_constraints=False, use_current_action=True, bake_types={"POSE"})
            bpy.ops.object.mode_set(mode="OBJECT")
            made.append((name, out, None, True))
    finally:
        if bpy.context.object is not None and bpy.context.object.mode != "OBJECT":
            bpy.ops.object.mode_set(mode="OBJECT")
        for pb in F.pose.bones:
            for c in list(pb.constraints):
                pb.constraints.remove(c)
    return made


def _template_clips(man, template, wanted):
    names = [a["name"] for a in man["animations"] if a["name"] != "Rest Pose" and a["name"] != "Rest_Pose"]
    if not wanted:
        return [next(n for n in group if n in names) for group in DEFAULT_CLIPS[template] if any(n in names for n in group)]
    missing = [w for w in wanted if w not in names]
    if missing:
        raise Refused("invalid-input", f"the {template} template has no clip {', '.join(missing)}; its clips: {', '.join(names)}")
    return list(dict.fromkeys(wanted))


def _template(model, rigid, template, hints, wanted, name, pack, collection, notes):
    T, ref, man = _import_template(pack, template)
    chains = rigchains.TEMPLATES[template]["chains"]
    try:
        bones = {b.name for b in T.data.bones}
        aliases = rigfit.HUMAN_ALIASES if template == "human" else {}
        hints = {aliases.get(k, k): v for k, v in (hints or {}).items()}
        unknown = [k for k in hints if k not in bones]
        if unknown:
            main = [b for c in chains.values() for b in c[2]]
            raise Refused("invalid-input", f"the {template} template has no joint {', '.join(unknown)}; its main joints: {', '.join(dict.fromkeys(main))}")
        kind = "human" if template == "human" else "quad" if template in ("fox", "horse") else "box"
        heads, s, turns, fit_notes = rigfit.fit(model, T, ref, kind, hints)
        notes += fit_notes
        bpy.data.batch_remove(ref)
        ref = []
        limbs = {c[2][0] for c in chains.values() if c[0] in ("leg", "arm", "wing", "fin")}
        F, world = _build_fitted(T, heads, s, name, collection, limbs, turns)
        # The human template is the standard skeleton but for its head's name: renamed, every tool
        # that reads the standard joints (animate, the clip measures, sheet poses) reads this rig.
        renamed = {"Head": "head"} if template == "human" else {}
        for new_name, old_name in renamed.items():
            F.data.bones[old_name].name = new_name
        # Leaves orient their parent and the root carries the body: neither takes weight.
        deform = {b.name for b in F.data.bones if b.name != "root" and b.children}
        deform |= {b.name for b in F.data.bones if b.parent is not None and b.parent.name == "root"}
        how = auto_weights(model, F, deform)
        for b in F.data.bones:
            b.use_deform = b.name in deform
        for o, bone in rigid.items():
            if bone is not None and bone not in F.data.bones:
                asked = bone
                bone = {v: k for k, v in renamed.items()}.get(asked) or rigfit.HUMAN_ALIASES.get(asked) if template == "human" else None
                if bone is None or bone not in F.data.bones:
                    raise Refused("invalid-input", f"{o.name} rides {asked}, which the {template} template has no bone called; its bones: {', '.join(sorted(deform))}")
            _one_bone(o, F, bone or _nearest(F, _centre(o), sorted(deform)))
        picked = _template_clips(man, template, wanted)
        acts = []
        for clip in picked:
            entry_ = next(a for a in man["animations"] if a["name"] == clip)
            objs, got = rigchains.import_glb(os.path.join(pack, entry_["file"]))
            bpy.data.batch_remove(objs)
            acts.append((clip, got[0]))
            bpy.data.batch_remove(got[1:])
        made = _bake_template(T, F, world, acts, rigchains.TEMPLATES[template]["track"], lambda c: _action(F, c), renamed)
        bpy.data.batch_remove([a for _, a in acts])
    finally:
        bpy.data.batch_remove([T] + list(ref))
    back = {v: k for k, v in renamed.items()}
    legs = [c[2][-1] for c in chains.values() if c[0] == "leg"]
    table = {n: [back.get(b, b) for b in c[2]] for n, c in chains.items()}
    return F, made, how, legs, table, {n: c[0] for n, c in chains.items()}


# ------------------------------------------------------------------ chains path
def _chains(parts, rigid, spec, wanted, name, pack, collection, notes):
    by = {o.name: o for o in parts}
    if spec is None:
        spec = rigchains.guess(parts)
        notes.append("chains guessed from the parts (" + ", ".join(f"{c['name']} {c['kind']}" for c in spec["chains"]) + "): pass chains with their joint points for knees that bend where you built them")
    else:
        spec = json.loads(json.dumps({"chains": spec} if isinstance(spec, list) else spec))
    named = set()
    for c in spec["chains"]:
        if c.get("kind", "tail") not in rigchains.KINDS:
            raise Refused("invalid-input", f"chain {c.get('name')} has kind {c.get('kind')}; kinds: {', '.join(rigchains.KINDS)}")
        ps = [c["part"]] if isinstance(c.get("part"), str) else list(c.get("part") or [])
        gone = [p for p in ps if p not in by]
        if gone:
            raise Refused("invalid-input", f"chain {c.get('name')} names {', '.join(gone)}, which is not among the objects rigged")
        if not ps and not c.get("points"):
            raise Refused("invalid-input", f"chain {c.get('name')} has neither points nor a part to find them on")
        named |= set(ps)
    names = [c["name"] for c in spec["chains"]]
    late = [c["name"] for i, c in enumerate(spec["chains"]) if c.get("parent") and c["parent"] not in names[:i]]
    if late:
        raise Refused("invalid-input", f"chains {', '.join(late)} hang from a chain not listed before them; list parents first")
    A = rigchains.build(spec, by, name, collection)
    hows = {}
    claimed = {}
    for c in spec["chains"]:
        for i, p in enumerate(c["part"]):
            claimed.setdefault(p, []).append((c, i))
    for o in parts:
        cs = claimed.get(o.name)
        if not cs:
            continue
        if any(c["rigid"] for c, _ in cs):
            c, i = cs[0]
            _one_bone(o, A, c["bones"][i] if len(c["part"]) == len(c["bones"]) else _nearest(A, _centre(o), c["bones"]))
            hows[o.name] = "rigid"
            continue
        deform = {b for c, _ in cs for b in c["bones"]} | {c["attach"] for c, _ in cs if c["attach"] != "root"}
        hows[o.name] = auto_weights([o], A, deform)
    allbones = sorted(b.name for b in A.data.bones if b.name != "root")
    for b in A.data.bones:
        b.use_deform = b.name != "root"
    for o in parts:
        if o.name not in claimed and o not in rigid:
            rigid[o] = None
    for o, bone in rigid.items():
        if bone is not None and "." in bone and bone not in A.data.bones:  # chain.index
            ch, _, idx = bone.partition(".")
            c = next((c for c in spec["chains"] if c["name"] == ch), None)
            bone = c["bones"][int(idx)] if c and idx.isdigit() and int(idx) < len(c["bones"]) else None
        if bone is not None and bone not in A.data.bones:
            bone = next((c["bones"][0] for c in spec["chains"] if c["name"] == bone), None)
        _one_bone(o, A, bone or _nearest(A, _centre(o), allbones))
    roles = {**rigchains.default_clips(spec), **(spec.get("clips") or {})}
    picked = wanted or list(spec.get("clips") or [n for n in roles if not n.endswith(("_spider", "_ripple"))])
    missing = [w for w in picked if w not in roles]
    if missing:
        raise Refused("invalid-input", f"no clip {', '.join(missing)} for these chains; they have {', '.join(roles)} (or give clips in the spec)")
    A["kurambit_rig"] = A.name
    made = rigchains.bake(A, spec, pack, {n: roles[n] for n in picked}, lambda c: _action(A, c))
    rest = [h for h in hows.values() if h != "heat" and h != "rigid"]
    how = "heat" if not rest else "; ".join(f"{n}: {h}" for n, h in hows.items() if h not in ("heat", "rigid"))
    legs = [c["bones"][-1] for c in spec["chains"] if c["kind"] == "leg"]
    return A, made, how, legs, {c["name"]: c["bones"] for c in spec["chains"]}, {c["name"]: c["kind"] for c in spec["chains"]}


def _action(arm, clip):
    old = next((a for a in bpy.data.actions if a.get("kurambit_owner") == arm.name and a.get("kurambit_clip") == clip), None)
    if old is not None:
        bpy.data.actions.remove(old)
    a = bpy.data.actions.new(action_name(arm.name, clip))
    a.use_fake_user = True
    a["kurambit_owner"], a["kurambit_clip"] = arm.name, clip
    return a


# ------------------------------------------------------------------ facts
def _coords(objs, dg):
    out = []
    for o in objs:
        e = o.evaluated_get(dg)
        me = e.to_mesh()
        co = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3) @ np.array(e.matrix_world.to_3x3()).T + np.array(e.matrix_world.translation)
        ed = np.empty(len(me.edges) * 2, dtype=np.int64)
        me.edges.foreach_get("vertices", ed)
        out.append((co, ed.reshape(-1, 2)))
        e.to_mesh_clear()
    return out


def _dominant(o, arm):
    groups = {g.index: g.name for g in o.vertex_groups if g.name in arm.data.bones}
    dom = []
    for v in o.data.vertices:
        best = max(((g.weight, groups[g.group]) for g in v.groups if g.group in groups), default=(0, ""))
        dom.append(best[1])
    return dom


def _pose(arm):
    W = arm.matrix_world
    return {pb.name: (W @ pb.head, W @ pb.tail) for pb in arm.pose.bones}


def _seg_seg(a0, a1, b0, b1):
    pts = [a0.lerp(a1, t / 4) for t in range(5)]
    return min(rigchains.seg_dist(p, b0, b1) for p in pts)


def facts(arm, meshes, made, legs, chains, kinds, rigid=()):
    """Per clip: the worst edge stretch (posed length over rest, either way) with its frame and bone,
    how fast planted feet slide, the deepest a non-leg part goes under the floor, and chain pairs
    that come much closer than at rest. Measured on the scene as it stands."""
    sc, dg = bpy.context.scene, bpy.context.evaluated_depsgraph_get()
    keep_frame, keep_act = sc.frame_current, arm.animation_data.action if arm.animation_data else None
    fps = sc.render.fps / sc.render.fps_base
    arm.data.pose_position = "REST"
    dg.update()
    rest = _coords(meshes, dg)
    arm.data.pose_position = "POSE"
    floor = min(float(c[:, 2].min()) for c, _ in rest if len(c))
    height = max(float(c[:, 2].max()) for c, _ in rest if len(c)) - floor
    dom = [_dominant(o, arm) for o in meshes]
    leg_bones = {b for n, bs in chains.items() if kinds.get(n) == "leg" for b in bs}
    for b in list(leg_bones):  # what hangs below a leg (toes, hooves) is leg too
        stack = list(arm.data.bones[b].children) if b in arm.data.bones else []
        while stack:
            c = stack.pop()
            leg_bones.add(c.name)
            stack += list(c.children)
    rest_len = [np.linalg.norm(c[e[:, 0]] - c[e[:, 1]], axis=1) for c, e in rest]
    # Slivers (a fifth of the mesh's median edge) stretch many times over without showing.
    sliver = [0.2 * float(np.median(r)) if len(r) else 0.0 for r in rest_len]
    rest_pose = {n: (arm.matrix_world @ b.head_local, arm.matrix_world @ b.tail_local) for n, b in arm.data.bones.items()}
    pairs = []
    names = list(chains)
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            ba, bb = [x for x in chains[a] if x in rest_pose], [x for x in chains[b] if x in rest_pose]
            if not ba or not bb or set(ba) & set(bb):
                continue
            pa, pb_ = arm.data.bones[ba[0]].parent, arm.data.bones[bb[0]].parent
            if (pa and pa.name in bb) or (pb_ and pb_.name in ba):
                continue
            d0 = min(_seg_seg(*rest_pose[x], *rest_pose[y]) for x in ba for y in bb)
            if d0 > 0.02 * height:
                pairs.append((a, b, ba, bb, d0))
    out = []
    for name, act, speed, _ in made:
        arm.animation_data.action = act
        if act.slots:
            arm.animation_data.action_slot = act.slots[0]
        f0, f1 = int(act.frame_range[0]), int(act.frame_range[1])
        sample = sorted({round(f0 + (f1 - f0) * i / (FACT_FRAMES - 1)) for i in range(FACT_FRAMES)})
        worst, under, cross = (1.0, f0, ""), (0.0, f0, ""), {}
        for f in sample:
            sc.frame_set(f)
            dg = bpy.context.evaluated_depsgraph_get()
            posed = _coords(meshes, dg)
            for k, ((co, ed), (rco, red)) in enumerate(zip(posed, rest)):
                if co.shape != rco.shape or ed.shape != red.shape or not len(ed):
                    continue
                ln = np.linalg.norm(co[ed[:, 0]] - co[ed[:, 1]], axis=1)
                ok = rest_len[k] > max(sliver[k], 1e-5)
                r = np.where(ok, ln / np.where(ok, rest_len[k], 1), 1.0)
                r = np.maximum(r, 1 / np.maximum(r, 1e-6))
                # The 99.9th percentile edge: one bad edge is noise, a thousandth of them shows.
                j = int(np.argsort(r)[max(0, int(0.999 * (len(r) - 1)))])
                if r[j] > worst[0]:
                    worst = (float(r[j]), f, dom[k][int(ed[j, 0])] or meshes[k].name)
                low = [i for i in np.argsort(co[:, 2])[:64] if dom[k][i] and dom[k][i] not in leg_bones]
                if low and floor - co[low[0], 2] > under[0]:
                    under = (float(floor - co[low[0], 2]), f, meshes[k].name if meshes[k] in rigid else dom[k][low[0]])
            P = _pose(arm)
            for a, b, ba, bb, d0 in pairs:
                d = min(_seg_seg(*P[x], *P[y]) for x in ba for y in bb)
                if d < 0.15 * d0 and d < 0.03 * height and d < cross.get((a, b), (d0, 0))[0]:
                    cross[(a, b)] = (d, f, d0)
        fact = {"clip": name, "frames": f1 - f0 + 1, "stretch": round(worst[0], 2), "stretchFrame": worst[1], "stretchBone": worst[2]}
        if speed is not None:
            fact["groundSpeed"] = round(speed, 3)
        if under[0] > 0.01 * height:
            fact["underFloor"] = {"depth": round(under[0], 3), "frame": under[1], "bone": under[2]}
        if cross:
            fact["crossing"] = [{"chains": [a, b], "gap": round(d, 3), "rest": round(d0, 3), "frame": f} for (a, b), (d, f, d0) in sorted(cross.items(), key=lambda x: x[1][0])[:4]]
        tips = [b for b in legs if b in arm.pose.bones]
        if tips and f1 > f0:
            track = {b: [] for b in tips}
            for f in range(f0, f1 + 1):
                sc.frame_set(f)
                for b in tips:
                    track[b].append(arm.matrix_world @ arm.pose.bones[b].tail)
            ground = min(p.z for t in track.values() for p in t)
            slides = []
            for t in track.values():
                for p, q in zip(t, t[1:]):
                    if p.z < ground + 0.03 * height and q.z < ground + 0.03 * height:
                        slides.append((q.xy - p.xy).length * fps)
            if slides:
                slides.sort()
                fact["plantedFeet"] = {"share": round(len(slides) / max(len(tips) * (f1 - f0), 1), 2),
                                       "slide": round(slides[len(slides) // 2], 3), "slideMax": round(slides[int(0.9 * (len(slides) - 1))], 3)}
        out.append(fact)
    arm.animation_data.action = keep_act
    sc.frame_set(keep_frame)
    return out


def fact_lines(fs):
    """The facts as sentences for the agent."""
    out = []
    for f in fs:
        bits = [f"stretch at most ×{f['stretch']} (frame {f['stretchFrame']}, {f['stretchBone'] or 'unweighted'})"]
        if "groundSpeed" in f:
            bits.append(f"walks at {f['groundSpeed']} m/s")
        if "plantedFeet" in f:
            p = f["plantedFeet"]
            bits.append(f"planted feet move {p['slide']} m/s (up to {p['slideMax']}), on the ground {round(100 * p['share'])}% of the time")
        if "underFloor" in f:
            u = f["underFloor"]
            bits.append(f"{u['bone']} goes {u['depth']} m under the floor (frame {u['frame']})")
        for c in f.get("crossing", []):
            bits.append(f"{c['chains'][0]} and {c['chains'][1]} come {c['gap']} m apart ({c['rest']} at rest, frame {c['frame']})")
        out.append(f"{f['clip']} ({f['frames']} frames): " + "; ".join(bits) + ".")
    return out


# ------------------------------------------------------------------ entry
def rig(objects, template=None, chains=None, joints=None, rigid=(), clips=(), name=None, pack=None):
    if pack is None or not os.path.isfile(os.path.join(pack, "manifest.json")):
        raise Refused("invalid-input", "rig needs the Mesh2Motion pack's folder (pack)")
    if template is not None and template not in rigchains.TEMPLATES:
        raise Refused("invalid-input", f"no template {template}; templates: {', '.join(rigchains.TEMPLATES)}")
    rigid = {_mesh(k): v for k, v in (rigid.items() if isinstance(rigid, dict) else ((r, None) for r in rigid))}
    meshes = list(dict.fromkeys(_gather(objects) + list(rigid)))
    if not meshes:
        raise Refused("invalid-input", "nothing to rig: name the model's meshes")
    name = name or meshes[0].name.split(".")[0] + "_rig"
    if bpy.context.object is not None and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.context.view_layer.update()  # an object moved in the same script has a stale matrix_world
    for o in meshes:
        _strip(o)
    old = bpy.data.objects.get(name)
    if old is not None and old.type == "ARMATURE":
        for a in [a for a in bpy.data.actions if a.get("kurambit_owner") == name]:
            bpy.data.actions.remove(a)
        bpy.data.objects.remove(old)
    elif old is not None and old in meshes:
        old.name = f"{name}_body"  # the armature takes the character's name, as the export does
    elif old is not None:
        raise Refused("invalid-input", f"{name} is already a {old.type.lower()} in the scene; name the rig something else")
    collection = meshes[0].users_collection[0] if meshes[0].users_collection else bpy.context.scene.collection
    body = [o for o in meshes if o not in rigid]
    if not body:
        raise Refused("invalid-input", "every object is rigid: name the body too")
    notes = []
    fps = bpy.context.scene.render.fps
    bpy.context.scene.render.fps, bpy.context.scene.render.fps_base = rigchains.FPS, 1.0
    if template is not None:
        arm, made, how, legs, table, kinds = _template(body, rigid, template, joints, list(clips), name, pack, collection, notes)
        arm["kurambit_rig"] = f"mesh2motion-{template}"
    else:
        arm, made, how, legs, table, kinds = _chains(body, rigid, chains, list(clips), name, pack, collection, notes)
        arm["kurambit_rig"] = "chains"
    if fps != rigchains.FPS:
        notes.append(f"the scene now plays at {rigchains.FPS} fps, the clips' rate (it was {fps})")
    for clip, act, speed, sourced in made:
        act["kurambit_owner"], act["kurambit_clip"] = arm.name, clip
        if sourced:  # a clip made only of procedural layers was made here
            act["kurambit_source"] = json.dumps({"what": "clips", "from": PACK, "licence": LICENCE, "ai": False, "credits": None})
        if speed:
            act["kurambit_speed"] = speed
    arm["kurambit_legs"] = json.dumps([{"foot": f} for f in legs])
    # The export's height check reads a range off the rig; the model's own height is the one it was built at.
    tall = max((o.matrix_world @ v.co).z for o in meshes for v in o.data.vertices) - min((o.matrix_world @ v.co).z for o in meshes for v in o.data.vertices)
    arm["kurambit_height"] = [round(0.9 * tall, 3), round(1.1 * tall, 3)]
    arm["kurambit_chains_rig"] = json.dumps(table)
    idle = next((a for c, a, _, _ in made if "idle" in c.lower()), made[0][1] if made else None)
    arm.animation_data_create()
    arm.animation_data.action = idle
    measured = facts(arm, meshes, made, legs, table, kinds, rigid)
    rigchains.active(arm)
    return {
        "armature": arm.name,
        "meshes": [o.name for o in meshes],
        "template": template or "chains",
        "bones": len(arm.data.bones),
        "weights": how,
        "rigid": {o.name: o.vertex_groups[0].name for o in rigid if o.vertex_groups},
        "chains": table,
        "clips": [c[0] for c in made],
        "facts": measured,
        "notes": notes + fact_lines(measured),
    }


@entry
def run(params):
    """The server's call: params as rig()'s arguments, the template "chains" meaning none."""
    template = params.get("template")
    return rig(params["objects"], None if template in (None, "chains") else template, params.get("chains"),
               params.get("joints"), params.get("rigid") or {}, params.get("clips") or (), params.get("name"), params.get("pack"))
