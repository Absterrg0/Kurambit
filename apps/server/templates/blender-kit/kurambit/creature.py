"""A creature made from scratch, from one sketch: the body, its rig and its clips.

    body = hero.creature_body("cat", {
        "spine": [(0, 0.10, 0.17, 0.075), (0, 0, 0.18, 0.085), (0, -0.09, 0.19, 0.08)],  # rear to front
        "neck":  [(0, -0.12, 0.23, 0.05)],
        "head":  [(0, -0.16, 0.29, 0.085)],
        "leg_hind_l":  [(0.045, 0.09, 0.15, 0.04), (0.05, 0.1, 0.08, 0.03), (0.05, 0.08, 0.02, 0.022), (0.05, 0.06, 0.01, 0.02)],
        "leg_front_l": [(0.045, -0.08, 0.15, 0.035), (0.045, -0.085, 0.06, 0.025), (0.045, -0.095, 0.01, 0.02)],
        "tail":  [(0, 0.15, 0.2, 0.025), (0, 0.22, 0.27, 0.02), (0, 0.24, 0.35, 0.016)],
        "ear_l": [(0.045, -0.15, 0.36, 0.02), (0.05, -0.15, 0.41, 0.004)],
    })
    hero.sculpt(body, "inflate", at=(0, 0.02, 0.15), radius=0.08, amount=0.012)   # a round belly
    hero.sculpt(body, "crease", at=(0, -0.24, 0.27), to=(0, -0.25, 0.25), radius=0.01, amount=0.004)
    arm = hero.creature_rig(body, height=(0.3, 0.45))
    hero.creature_clips(arm, ["walk", "trot", "run", "idle", "look", "sit"])

The sketch is chains of points (x, y, z, radius) in metres, the creature facing -Y with +X its
left and its feet on z = 0. A chain ending _l is mirrored to _r. spine runs rear to front and is
the root; every other chain joins the nearest point of the chains before it. Names say roles:
leg_* (front or fore in the name for a front leg; a quadruped's other legs are hind), tail*,
ear*; any other name (a horn, a lantern) is a chain of its own.

The body is a Skin modifier over the sketch under a subdivision, voxel-remeshed into one closed
mesh and smoothed. The rig is the same sketch: each chain's points are its joints, so the joints
sit inside the body by construction. Tails and ears are spring_ bones (the game swings them).
The clips are the gait generator's (gait.py), keyed on the bones by two-bone IK on each leg.
"""
import json
import math

import bpy
import numpy as np
from mathutils import Matrix, Vector

from . import animrig, gait, helpers
from .character import MADE_BODY

SPRINGS = ("tail", "ear", "antenna", "whisker", "tendril")
SKIN_ROUND = 0.7
# A round, short-legged body crouched a quarter of its leg drags its belly (the cat re-run's
# reviewer): past this the stride shortens instead.
MAX_CROUCH = 0.12


def _chains(chains, mirror=True):
    out = {}
    for name, pts in chains.items():
        pts = [tuple(float(v) for v in p) for p in pts]
        if not pts or any(len(p) != 4 for p in pts):
            raise ValueError(f"chain {name}: points are (x, y, z, radius)")
        out[name] = pts
    if "spine" not in out or len(out["spine"]) < 2:
        raise ValueError("a creature needs a spine of two points or more, rear to front")
    if mirror:
        for name in list(out):
            if name.endswith("_l") and name[:-2] + "_r" not in out:
                out[name[:-2] + "_r"] = [(-x, y, z, r) for x, y, z, r in out[name]]
    # The spine first, then the order given: each chain joins what is already there.
    return dict(sorted(out.items(), key=lambda kv: kv[0] != "spine"))


def _apply(o):
    bpy.context.view_layer.objects.active = o
    for m in list(o.modifiers):
        with bpy.context.temp_override(object=o, active_object=o):
            bpy.ops.object.modifier_apply(modifier=m.name)


def creature_body(name, chains, *, mirror=True, voxel=None, smooth=10, subdivide=2, material=None):
    """The body mesh <name>_body from the sketch: skin, subdivision, a voxel remesh (voxel metres;
    default a 90th of its height) and smooth passes. Returns the object."""
    chains = _chains(chains, mirror)
    verts, radii, edges, joins = [], [], [], {}
    for cname, pts in chains.items():
        start = len(verts)
        if verts:
            p0 = np.array(pts[0][:3])
            near = int(np.argmin([np.linalg.norm(np.array(v) - p0) for v in verts]))
            joins[cname] = near
            edges.append((near, start))
        for i, (x, y, z, r) in enumerate(pts):
            verts.append((x, y, z))
            radii.append(max(0.002, r))
            if i:
                edges.append((start + i - 1, start + i))
    me = bpy.data.meshes.new(f"{name}_body")
    me.from_pydata(verts, edges, [])
    o = bpy.data.objects.new(f"{name}_body", me)
    bpy.context.scene.collection.objects.link(o)
    skin = o.modifiers.new("skin", "SKIN")
    skin.use_smooth_shade = True
    for i, r in enumerate(radii):
        sv = me.skin_vertices[0].data[i]
        # Inside the balls below, so its square corners do not stick out of them.
        sv.radius = (r * SKIN_ROUND, r * SKIN_ROUND)
        sv.use_root = i == 0
    if subdivide:
        sub = o.modifiers.new("sub", "SUBSURF")
        sub.levels = sub.render_levels = int(subdivide)
    _apply(o)
    # A ball at every point: a branch point's hull (a head with ears on it) comes out smaller than
    # its radius, and a lone point (a round head) is only as round as a sphere makes it.
    # The skin's sections are square: balls along every segment, close enough to overlap, round
    # them out to the radius before the remesh fuses the lot.
    import bmesh

    bm = bmesh.new()
    bm.from_mesh(me)
    for a, b in edges:
        pa, pb = np.array(verts[a]), np.array(verts[b])
        ra, rb = radii[a], radii[b]
        steps = max(1, int(math.ceil(np.linalg.norm(pb - pa) / (0.5 * max(1e-4, min(ra, rb))))))
        for k in range(steps + 1):
            t = k / steps
            p = pa + (pb - pa) * t
            bmesh.ops.create_icosphere(bm, subdivisions=2, radius=ra + (rb - ra) * t, matrix=Matrix.Translation(p.tolist()))
    for (x, y, z), r in zip(verts, radii):
        bmesh.ops.create_icosphere(bm, subdivisions=3, radius=r, matrix=Matrix.Translation((x, y, z)))
    bm.to_mesh(me)
    bm.free()
    zs = np.array([v.co.z for v in me.vertices])
    height = float(zs.max() - zs.min()) or 0.3
    rm = o.modifiers.new("remesh", "REMESH")
    rm.mode = "VOXEL"
    rm.voxel_size = float(voxel) if voxel else max(0.002, height / 90)
    rm.use_smooth_shade = True
    _apply(o)
    if smooth:
        sculpt(o, "smooth", iterations=int(smooth))
    for p in me.polygons:
        p.use_smooth = True
    if material is not None:
        o.data.materials.append(material)
    o["kurambit_graph"] = json.dumps(chains)
    o["kurambit_source"] = json.dumps(MADE_BODY)
    return o


def _neighbours(me):
    e = np.empty(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get("vertices", e)
    return e.reshape(-1, 2)


def _falloff(co, at, radius, to=None):
    if at is None:
        return np.ones(len(co))
    a = np.asarray(at, float)
    if to is None:
        d = np.linalg.norm(co - a, axis=1)
    else:
        b = np.asarray(to, float)
        ab = b - a
        t = np.clip((co - a) @ ab / max(1e-12, ab @ ab), 0, 1)
        d = np.linalg.norm(co - (a + np.outer(t, ab)), axis=1)
    u = np.clip(d / max(1e-6, radius), 0, 1)
    return (1 - u * u) ** 2


def sculpt(obj, kind, *, at=None, to=None, radius=None, amount=0.0, iterations=1, factor=0.5):
    """A named sculpt pass on a mesh, in world metres, at rest:
        smooth   relax the surface (iterations, factor), everywhere or within radius of at
        inflate  push along the normals by amount (negative deflates) within radius of at
        crease   a groove along at -> to: pulled in by amount, sharply, within radius of the line
        grab     move a region by amount, an (x, y, z) offset, with a soft falloff around at
        flatten  press the region within radius of at onto its average plane by amount (0..1)
    Returns how many vertices moved."""
    o = bpy.data.objects[obj] if isinstance(obj, str) else obj
    me = o.data
    mw = np.array(o.matrix_world)
    inv = np.linalg.inv(mw)
    n = len(me.vertices)
    co = np.empty(n * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3) @ mw[:3, :3].T + mw[:3, 3]
    if kind != "smooth" and (at is None or radius is None) and kind != "grab":
        raise ValueError(f"sculpt {kind}: needs at and radius")
    w = _falloff(co, at, radius if radius is not None else 1e9, to)
    if kind == "smooth":
        e = _neighbours(me)
        for _ in range(max(1, int(iterations))):
            acc = np.zeros_like(co)
            cnt = np.zeros(n)
            np.add.at(acc, e[:, 0], co[e[:, 1]])
            np.add.at(acc, e[:, 1], co[e[:, 0]])
            np.add.at(cnt, e[:, 0], 1)
            np.add.at(cnt, e[:, 1], 1)
            avg = acc / np.maximum(cnt, 1)[:, None]
            co = co + (avg - co) * (factor * w)[:, None]
    elif kind in ("inflate", "crease"):
        me.update()
        nrm = np.empty(n * 3)
        me.vertices.foreach_get("normal", nrm)
        nrm = nrm.reshape(-1, 3) @ mw[:3, :3].T
        nrm /= np.maximum(np.linalg.norm(nrm, axis=1), 1e-9)[:, None]
        if kind == "crease":
            w = w ** 3
            co = co - nrm * (float(amount) * w)[:, None]
        else:
            co = co + nrm * (float(amount) * w)[:, None]
    elif kind == "grab":
        if at is None or radius is None:
            raise ValueError("sculpt grab: needs at and radius")
        co = co + np.outer(w, np.asarray(amount, float))
    elif kind == "flatten":
        sel = w > 1e-3
        if sel.sum() >= 3:
            c = np.average(co[sel], axis=0, weights=w[sel])
            _, _, vt = np.linalg.svd(co[sel] - c)
            normal = vt[2]
            d = (co - c) @ normal
            co = co - np.outer(d * w * float(amount), normal)
    else:
        raise ValueError(f"sculpt kind {kind!r}: smooth, inflate, crease, grab or flatten")
    local = co @ inv[:3, :3].T + inv[:3, 3]
    me.vertices.foreach_set("co", local.ravel())
    me.update()
    return int((w > 1e-3).sum())


def decimate(obj, triangles):
    """Down to about this many triangles (a collapse decimate, applied)."""
    o = bpy.data.objects[obj] if isinstance(obj, str) else obj
    have = sum(len(p.vertices) - 2 for p in o.data.polygons)
    if have <= triangles:
        return have
    m = o.modifiers.new("decimate", "DECIMATE")
    m.ratio = max(0.01, triangles / have)
    _apply(o)
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def _role(cname):
    base = cname.split("_")[0]
    if cname == "spine":
        return "spine"
    if base in ("neck", "head"):
        return base
    if base in ("leg", "arm"):
        return "leg"
    for s in SPRINGS:
        if cname.startswith(s):
            return "spring"
    return "other"


def _bone_names(cname, n, role):
    stem = f"spring_{cname}" if role == "spring" else cname
    names = [f"{stem}_{i + 1:02d}" for i in range(n)]
    if role == "head" and cname == "head":
        names[-1] = "Head"  # as on the standard skeleton, so the kit's face helpers find it
    return names


def creature_rig(body, name=None, *, height=None, springs=SPRINGS, weights=True):
    """The armature from body's sketch, standing at the origin facing -Y, bound with automatic
    weights; marked on its own rig with its height range (lo, hi) for the gate. Returns it."""
    o = bpy.data.objects[body] if isinstance(body, str) else body
    chains = json.loads(o["kurambit_graph"])
    name = name or o.name.removesuffix("_body")
    if bpy.data.objects.get(name) is not None:
        raise ValueError(f"{name} already exists: remove it or pick another name")
    ad = bpy.data.armatures.new(name)
    arm = bpy.data.objects.new(name, ad)
    for c in o.users_collection:
        c.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    eb = ad.edit_bones
    root = eb.new("root")
    root.head, root.tail = (0, 0, 0), (0, 0, 0.1 * max(p[2] for p in chains["spine"]) + 0.01)
    root.use_deform = False
    joints = []  # (point, bone name ending there or starting there) for joins
    roles, legs = {}, []
    spring_chains = {}
    for cname, pts in chains.items():
        role = _role(cname)
        if role == "other" and any(cname.startswith(s) for s in springs):
            role = "spring"
        ps = [Vector(p[:3]) for p in pts]
        parent = root
        if cname != "spine":
            # The bone whose segment is nearest the chain's first point.
            best, d = None, 1e9
            for b in eb:
                if b.name == "root":
                    continue
                seg = b.tail - b.head
                t = max(0.0, min(1.0, (ps[0] - b.head).dot(seg) / max(1e-12, seg.length_squared)))
                dd = (b.head + seg * t - ps[0]).length
                if dd < d:
                    best, d = b, dd
            parent = best or root
        if len(ps) == 1:
            # A lone point (a round head): one bone from where it joins to the point and beyond.
            base = parent.tail.copy() if parent is not root else ps[0] - Vector((0, 0, pts[0][3]))
            tip = ps[0] + (ps[0] - base).normalized() * pts[0][3] * 0.8 if (ps[0] - base).length > 1e-6 else ps[0] + Vector((0, 0, pts[0][3]))
            ps = [base, tip] if (ps[0] - base).length > 1e-4 else [ps[0], tip]
        elif cname != "spine" and role in ("neck", "head") and parent is not root:
            ps = [parent.tail.copy()] + ps
        names = _bone_names(cname, len(ps) - 1, role)
        prev = parent
        for i, bn in enumerate(names):
            b = eb.new(bn)
            b.head, b.tail = ps[i], ps[i + 1]
            if (b.tail - b.head).length < 1e-4:
                b.tail = b.head + Vector((0, 0, 0.01))
            b.parent = prev
            b.use_connect = i > 0
            prev = b
        roles[cname] = names
        if role == "spring":
            spring_chains[cname] = names
        if role == "leg":
            legs.append({"name": cname, "bones": names, "foot": names[-1], "point": list(pts[-1][:3]),
                         "hip": list(pts[0][:3])})
    bpy.ops.object.mode_set(mode="OBJECT")
    # Front or hind: named so, or for four legs or more the forward half.
    if len(legs) > 2:
        mid = float(np.median([leg["point"][1] for leg in legs]))
        for leg in legs:
            n = leg["name"]
            leg["front"] = ("front" in n or "fore" in n or n.startswith("arm")) if any(w in n for w in ("front", "fore", "hind", "back", "rear")) else leg["point"][1] < mid
    else:
        for leg in legs:
            leg["front"] = False
    for leg in legs:
        leg["side"] = 1 if leg["point"][0] > 1e-4 else (-1 if leg["point"][0] < -1e-4 else 0)
        leg["length"] = leg["hip"][2] - leg["point"][2] + 1e-6
    arm["kurambit_rig"] = name
    arm["kurambit_legs"] = json.dumps(legs)
    arm["kurambit_creature"] = json.dumps(roles)
    if spring_chains:
        arm["kurambit_chains"] = json.dumps(spring_chains)
    if height is not None:
        arm["kurambit_height"] = json.dumps([float(height[0]), float(height[1])])
    if weights:
        bind(o, arm)
    return arm


def bind(mesh, arm):
    """Automatic (heat) weights; a vertex heat leaves unweighted takes its nearest bone."""
    o = bpy.data.objects[mesh] if isinstance(mesh, str) else mesh
    for x in bpy.context.view_layer.objects:
        x.select_set(False)
    o.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    with bpy.context.temp_override(selected_objects=[o, arm], selected_editable_objects=[o, arm], active_object=arm, object=arm):
        bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    deform = [b for b in arm.data.bones if b.use_deform]
    groups = {g.index for g in o.vertex_groups if g.name in arm.data.bones}
    loose = [v.index for v in o.data.vertices if not any(g.group in groups and g.weight > 1e-4 for g in v.groups)]
    if loose:
        mw = o.matrix_world
        for i in loose:
            p = mw @ o.data.vertices[i].co
            best, d = None, 1e9
            for b in deform:
                h, t = arm.matrix_world @ b.head_local, arm.matrix_world @ b.tail_local
                seg = t - h
                u = max(0.0, min(1.0, (p - h).dot(seg) / max(1e-12, seg.length_squared)))
                dd = (h + seg * u - p).length
                if dd < d:
                    best, d = b, dd
            g = o.vertex_groups.get(best.name) or o.vertex_groups.new(name=best.name)
            g.add([i], 1.0, "REPLACE")
    return len(loose)


CLIPS = {
    "walk": ("Walk_Loop", lambda legs, fps, kw: gait.walk_cycle(legs, "walk", fps, **kw)),
    "trot": ("Trot_Loop", lambda legs, fps, kw: gait.walk_cycle(legs, "trot", fps, **kw)),
    "run": ("Run_Loop", lambda legs, fps, kw: gait.walk_cycle(legs, "run", fps, **kw)),
    "hop": ("Hop_Loop", lambda legs, fps, kw: gait.walk_cycle(legs, "hop", fps, **kw)),
    "idle": ("Idle_Loop", lambda legs, fps, kw: gait.idle(legs, fps, **kw)),
    "hover": ("Hover_Loop", lambda legs, fps, kw: gait.float_bob(fps, **kw)),
    "look": ("Look_Around", lambda legs, fps, kw: gait.look_around(legs, fps, **kw)),
    "sit": ("Sit", lambda legs, fps, kw: gait.sit(legs, fps, **kw)),
}


def _rx(d):
    return animrig.rx(d)


def _axis_rot(axis, deg):
    return animrig.axis_angle(np.asarray(axis, float), deg)


def creature_clips(armature, clips=("walk", "idle"), *, fps=None, **options):
    """Keys the clips on a creature_rig armature: walk, trot, run, hop (loops in place), idle and
    hover (loops), look and sit (one-shots). options per clip: {"walk": {"stride": m, "seconds": s,
    "lift": share of leg length, "bob": share}}. Returns {clip: {"frames", "groundSpeed"}}."""
    arm = bpy.data.objects[armature] if isinstance(armature, str) else armature
    roles = json.loads(arm["kurambit_creature"])
    legs_rec = json.loads(arm.get("kurambit_legs", "[]"))
    sc = bpy.context.scene
    fps = fps or round(sc.render.fps / sc.render.fps_base)
    rig = animrig.Rig(arm)
    legs = [{"name": leg["name"], "foot": leg["point"], "front": leg["front"], "side": leg["side"], "length": leg["length"]}
            for leg in legs_rec]
    tails = [n for c, n in roles.items() if c.startswith("tail")]
    ears = [n for c, n in roles.items() if c.startswith("ear")]
    tail_n = max((len(t) for t in tails), default=0)
    ear_n = max((len(e) for e in ears), default=0)
    spine = roles["spine"]
    body_bone = spine[0]
    centre = np.mean([rig.head(b) for b in spine] + [rig.L[spine[-1]][:3, 3] + rig.L[spine[-1]][:3, 1] * rig.length[spine[-1]]], axis=0)
    rear = rig.head(spine[0])
    heads = roles.get("head", [])
    necks = roles.get("neck", [])
    # How big the body is, for what has no legs to measure: the height of its spine.
    size = max(0.05, float(np.mean([rig.head(b)[2] for b in spine])))
    out = {}
    for clip in clips:
        if clip not in CLIPS:
            raise ValueError(f"clip {clip!r}: one of {', '.join(CLIPS)}")
        label, make = CLIPS[clip]
        kw = dict(options.get(clip, {}))
        if clip in ("walk", "trot", "run", "hop", "idle", "look", "sit", "hover"):
            kw.setdefault("tail", tail_n)
            kw.setdefault("ears", ear_n)
        if clip in ("walk", "trot", "run", "hop") and not legs and clip != "hop":
            raise ValueError(f"{clip}: {arm.name} has no legs; hop or hover move a legless body")
        if clip in ("walk", "trot", "run", "hop") and legs:
            stride, crouch = _stride_cap(rig, legs_rec, clip)
            kw.setdefault("stride", stride)
            kw.setdefault("crouch", crouch)
        if not legs and clip == "hop":
            kw.setdefault("size", size)
        if clip == "hover":
            kw.setdefault("height", 0.12 * size)
        made = make(legs, fps, kw)
        act = _key(arm, rig, label, made, legs_rec, body_bone, centre, rear, necks, heads, tails, ears)
        out[label] = {"frames": made["frames"], "groundSpeed": round(made["groundSpeed"], 3)}
    return out


def _stride_cap(rig, legs_rec, clip):
    """(stride, crouch) every leg reaches: a foot swept S/2 ahead of and behind its hip with the
    leg at most 95% straight. Legs sketched straight cannot reach a stride standing tall, so the
    body crouches for it, as an animal walks on bent legs, up to MAX_CROUCH of its leg length;
    past that the stride shortens."""
    table = gait.GAITS[clip]
    legs = []
    for leg in legs_rec:
        bones = leg["bones"]
        reach = 0.95 * sum(rig.length[b] for b in bones[:2])
        J0 = rig.head(bones[0])
        end = rig.head(bones[2]) if len(bones) >= 3 else rig.L[bones[-1]][:3, 3] + rig.L[bones[-1]][:3, 1] * rig.length[bones[-1]]
        legs.append((reach, max(1e-4, J0[2] - end[2]), table["stride"] * leg["length"]))
    if not legs:
        return None, table.get("crouch", 0.0)
    crouch = max([table.get("crouch", 0.0)] + [
        min(MAX_CROUCH, max(0.0, 1 - math.sqrt(max(0.0, r * r - (w / 2) ** 2)) / h0)) for r, h0, w in legs])
    caps = [min(w, 2 * math.sqrt(max(0.0, r * r - (h0 * (1 - crouch)) ** 2))) for r, h0, w in legs]
    return max(0.02, min(caps)), crouch


def _pose(rig, pose, legs_rec, body_bone, centre, rear, necks, heads, tails, ears):
    P = {}
    b = pose["body"]
    R = animrig.rz(b.get("yaw", 0.0)) @ _rx(-b.get("pitch", 0.0)) @ animrig.ry(b.get("roll", 0.0))
    pivot = rear if b.get("pivot") == "rear" else centre
    M = animrig.M4(R, pivot + np.asarray(b["at"], float) - R @ pivot)
    head_yaw, head_pitch = pose.get("head", (0.0, 0.0))
    head_set = set(n for chain in heads for n in chain) if isinstance(heads, list) and heads and isinstance(heads[0], list) else set(heads)
    neck_set = set(necks)
    tail_of = {n: (i, chain) for chain in tails for i, n in enumerate(chain)}
    ear_of = {n: (i, chain) for chain in ears for i, n in enumerate(chain)}
    leg_of = {}
    for leg in legs_rec:
        for i, n in enumerate(leg["bones"]):
            leg_of[n] = (i, leg)
    solved = {}
    for n in rig.names:
        if n == body_bone:
            P[n] = M @ rig.L[n]
            continue
        if n in leg_of:
            i, leg = leg_of[n]
            if leg["name"] not in solved:
                solved[leg["name"]] = _leg(rig, P, leg, pose["feet"].get(leg["name"]))
            P[n] = solved[leg["name"]](n, P)
            continue
        Pn = rig.local(n, P, np.eye(4))
        Rn = Pn[:3, :3]
        if n in neck_set or n in head_set:
            share = 0.4 if n in neck_set else 0.6
            k = max(1, len(neck_set) if n in neck_set else len(head_set))
            steady = _rx(0.5 * b.get("pitch", 0.0) / max(1, len(neck_set) + len(head_set)))
            Rd = animrig.rz(head_yaw * share / k) @ _rx(-head_pitch * share / k) @ steady
            P[n] = animrig.M4(Rd @ Rn, Pn[:3, 3])
        elif n in tail_of or n in ear_of:
            i, chain = tail_of.get(n) or ear_of.get(n)
            vals = pose.get("tail" if n in tail_of else "ears", [])
            if i < len(vals):
                yaw, pitch = vals[i]
                if n in ear_of and "_r_" in n:
                    yaw = -yaw
                d = Rn[:, 1]
                side = np.cross(d, [0, 0, 1.0])
                Rd = animrig.rz(yaw) @ (_axis_rot(side / np.linalg.norm(side), pitch) if np.linalg.norm(side) > 1e-6 else np.eye(3))
                P[n] = animrig.M4(Rd @ Rn, Pn[:3, 3])
            else:
                P[n] = Pn
        else:
            P[n] = Pn
    return rig.basis(P)


def _leg(rig, P, leg, foot):
    """A solver for one leg's bones under the posed body: the first two bones by two-bone IK reach
    the joint above the paw, the paw keeps its rest angle to the ground (rolled at the toe while it
    swings)."""
    bones = leg["bones"]
    cache = {}

    def solve(n, P):
        if not cache:
            J = [rig.head(b) for b in bones] + [rig.L[bones[-1]][:3, 3] + rig.L[bones[-1]][:3, 1] * rig.length[bones[-1]]]
            target = np.asarray(foot["at"], float) if foot else J[-1]
            roll = foot["roll"] if foot else 0.0
            hip = rig.head_under(bones[0], P)
            if len(bones) == 1:
                cache["dirs"] = [animrig.unit(target - hip)]
                cache["pts"] = [hip]
                cache["rigid"] = 0
            else:
                Rr = _rx(roll)
                if len(bones) >= 3:
                    off = J[-1] - J[2]
                    ankle = target - Rr @ off
                else:
                    ankle = target
                a, b = rig.length[bones[0]], rig.length[bones[1]]
                rest_mid = J[1] - J[0]
                along = animrig.unit(J[2] - J[0])
                pole = rest_mid - along * float(rest_mid @ along)
                if np.linalg.norm(pole) < 1e-5:
                    pole = np.array([0, 1.0 if leg["front"] else -1.0, 0])
                Rp = P[rig.parent[bones[0]]][:3, :3] @ rig.Linv[rig.parent[bones[0]]][:3, :3] if rig.parent[bones[0]] else np.eye(3)
                mid, end, _ = animrig.two_bone(hip, ankle, a, b, Rp @ pole)
                cache["dirs"] = [animrig.unit(mid - hip), animrig.unit(end - mid)]
                cache["pts"] = [hip, mid]
                cache["roll"] = Rr
        i = bones.index(n)
        Pn = rig.local(n, P, np.eye(4))
        if i < len(cache["dirs"]):
            R0 = Pn[:3, :3]
            R = animrig.rot_between(R0[:, 1], cache["dirs"][i]) @ R0
            return animrig.M4(R, Pn[:3, 3] if i else cache["pts"][0])
        return animrig.M4(cache["roll"] @ rig.L[n][:3, :3], Pn[:3, 3])

    return solve


def _key(arm, rig, label, made, legs_rec, body_bone, centre, rear, necks, heads, tails, ears):
    act = helpers.clip_of(arm, label)
    if act is not None:
        bpy.data.actions.remove(act)
    act = bpy.data.actions.new(helpers.action_name(arm.name, label))
    act.use_fake_user = True
    act["kurambit_owner"] = arm.name
    act["kurambit_clip"] = label
    ad = arm.animation_data or arm.animation_data_create()
    previous = ad.action
    from .skeleton import assign_action

    assign_action(arm, act)
    poses = made["poses"]
    loop = not made.get("once")
    frames = list(range(len(poses))) + ([0] if loop else [])
    for pb in arm.pose.bones:
        pb.rotation_mode = "QUATERNION"
    for f, k in enumerate(frames):
        B = _pose(rig, poses[k], legs_rec, body_bone, centre, rear, necks, heads, tails, ears)
        for pb in arm.pose.bones:
            if pb.name == "root":
                continue
            pb.matrix_basis = Matrix(B[pb.name].tolist())
            pb.keyframe_insert("rotation_quaternion", frame=f)
            if pb.name == body_bone:
                pb.keyframe_insert("location", frame=f)
    assign_action(arm, previous)
    for pb in arm.pose.bones:
        pb.matrix_basis = Matrix()
    return act


CONTROLS = "kurambit_controls"


def _rig_type(role, n):
    """A Rigify rig type for one chain of the sketch: an IK paw for a leg of three bones or more, a
    spine with a torso control, a tail; anything else (a two-bone leg, a neck, ears) FK."""
    if role == "leg" and n >= 4:
        return "limbs.paw"
    if role == "leg" and n == 3:
        return "limbs.arm"  # upper, lower and the paw at the IK end, as an arm's hand
    if role == "spine" and n >= 3:
        return "spines.basic_spine"
    if role == "spring" and n >= 2:
        return "spines.basic_tail"
    return "basic.copy_chain" if n >= 2 else "basic.super_copy"


def controls(armature, on=True):
    """A Rigify control rig for a creature_rig armature, to pose by hand: IK paws, a torso, FK
    chains. The sketch's rig becomes a Rigify metarig (<name>_metarig, its chains typed), Rigify
    generates <name>_controls, and the armature copies its ORG bones until bake_controls keys a
    clip from it. on=False takes the control rig and the copying away. Returns the control rig's
    name, or None."""
    import addon_utils

    arm = bpy.data.objects[armature] if isinstance(armature, str) else armature
    for pb in arm.pose.bones:
        for c in [c for c in pb.constraints if c.name == CONTROLS]:
            pb.constraints.remove(c)
    for stale in (f"{arm.name}_metarig", f"{arm.name}_controls"):
        o = bpy.data.objects.get(stale)
        if o is not None:
            bpy.data.objects.remove(o)
    if not on:
        return None
    roles = json.loads(arm["kurambit_creature"])
    addon_utils.enable("rigify", default_set=True)
    meta = bpy.data.objects.new(f"{arm.name}_metarig", bpy.data.armatures.new(f"{arm.name}_metarig"))
    bpy.context.scene.collection.objects.link(meta)
    meta.matrix_world = arm.matrix_world.copy()
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = meta
    bpy.ops.object.mode_set(mode="EDIT")
    for b in arm.data.bones:
        if b.name == "root":
            continue
        e = meta.data.edit_bones.new(b.name)
        e.head, e.tail = b.head_local, b.tail_local
        e.align_roll(b.z_axis)
    for b in arm.data.bones:
        if b.name == "root":
            continue
        e = meta.data.edit_bones[b.name]
        if b.parent is not None and b.parent.name != "root":
            e.parent = meta.data.edit_bones[b.parent.name]
            e.use_connect = b.use_connect
    bpy.ops.object.mode_set(mode="OBJECT")
    # Rigify lays its control buttons out by the metarig's bone collections: one row for all.
    coll = meta.data.collections.new("Controls")
    coll.rigify_ui_row = 1
    for b in meta.data.bones:
        coll.assign(b)
    bpy.ops.object.mode_set(mode="POSE")
    for cname, bones in roles.items():
        role = _role(cname)
        if role == "other" and bones and bones[0].startswith("spring_"):
            role = "spring"
        meta.pose.bones[bones[0]].rigify_type = _rig_type(role, len(bones))
    bpy.ops.object.mode_set(mode="OBJECT")
    meta.data.rigify_target_rig = None
    meta.data.rigify_rig_basename = f"{arm.name}_controls"
    meta.select_set(True)
    bpy.ops.pose.rigify_generate()
    rig = bpy.data.objects.get(f"{arm.name}_controls")
    if rig is None:
        raise ValueError("Rigify did not generate the control rig")
    for c in rig.users_collection:
        c.objects.unlink(rig)
    bpy.context.scene.collection.objects.link(rig)
    meta.hide_set(True)
    for pb in arm.pose.bones:
        if pb.name == "root" or f"ORG-{pb.name}" not in rig.pose.bones:
            continue
        c = pb.constraints.new("COPY_TRANSFORMS")
        c.name = CONTROLS
        c.target, c.subtarget = rig, f"ORG-{pb.name}"
    return rig.name


def bake_controls(armature, clip, start, end):
    """Keys clip on the armature from the control rig's pose over start..end (visual keys), then
    leaves the control rig driving it. Returns the action."""
    from .skeleton import assign_action

    arm = bpy.data.objects[armature] if isinstance(armature, str) else armature
    act = helpers.clip_of(arm, clip)
    if act is not None:
        bpy.data.actions.remove(act)
    act = bpy.data.actions.new(helpers.action_name(arm.name, clip))
    act.use_fake_user = True
    act["kurambit_owner"] = arm.name
    act["kurambit_clip"] = clip
    assign_action(arm, act)
    sc = bpy.context.scene
    for pb in arm.pose.bones:
        pb.rotation_mode = "QUATERNION"
    for f in range(int(start), int(end) + 1):
        sc.frame_set(f)
        bpy.context.view_layer.update()
        visual = {pb.name: pb.matrix.copy() for pb in arm.pose.bones}
        muted = [(c, c.mute) for pb in arm.pose.bones for c in pb.constraints if c.name == CONTROLS]
        for c, _ in muted:
            c.mute = True
        for pb in arm.pose.bones:  # parents first: each bone's basis from its visual matrix
            if pb.name != "root":
                pb.matrix = visual[pb.name]
                bpy.context.view_layer.update()
        for pb in arm.pose.bones:
            if pb.name == "root":
                continue
            pb.keyframe_insert("rotation_quaternion", frame=f - int(start))
            pb.keyframe_insert("location", frame=f - int(start))
        for c, m in muted:
            c.mute = m
    assign_action(arm, None)
    return act
