"""Chains: a skeleton for a model no template fits, its clips taken chain by chain from the
templates' clips or made procedurally.

A chain spec (parents before children; the first chain is the body):

    {"name": "leg1_l", "kind": "leg", "parent": "body", "part": "Leg1_l",
     "points": [[hip], [knee], [ankle], [toe]], "bones": 3, "rigid": false}

kind is one of KINDS and picks the motion. points are joints in Blender space (Z up, the model
faces -Y), giving len(points) - 1 bones; without them the joints are slab centres along the part,
`bones` of them, the root end nearest the parent chain. part names the mesh objects the chain
moves; a part is weighted only to its own chain and the bone that chain hangs from. A rigid chain
gives each part one bone (the i-th part the i-th bone when the counts match).

Motion is layers. A retarget layer {"from": "spider:Walk"} reads a template's clip as chains
(TEMPLATES) and gives each chain of this model the template chain of the same kind, side and
front-to-back order: legs and arms take its shape ("pose"), tails, tentacles, wings and spines add
its motion to their own rest shape ("delta"); several chains on one template chain move out of
phase. Procedural layers: breathe, wave, flap, strike, with bob, hover and lunge on the root. A clip
may instead be an IK gait ({"ik": {}}): the kit's bake_ik_walk with feet kept flat. Every clip plays
in place.
"""
import fnmatch
import json
import math
import os

import bpy
from mathutils import Matrix, Quaternion, Vector

FPS = 24
KINDS = ("spine", "neck", "tail", "tentacle", "leg", "arm", "wing", "fin", "jaw", "antenna", "rigid")
DEFAULT_BONES = {"spine": 3, "neck": 2, "tail": 6, "tentacle": 8, "leg": 3, "arm": 3, "wing": 4, "fin": 3, "jaw": 1, "antenna": 3, "rigid": 1}


def _sides(fmt, kind, parent, names):
    return {fmt.format(s=s): (kind, parent, [n.format(s=s, S=s.upper()) for n in names]) for s in ("l", "r")}


# Each Mesh2Motion rig read as chains: name -> (kind, the bone it hangs from, bones root to tip).
# "track" is the bone Mesh2Motion tracks the body's position by.
TEMPLATES = {
    "human": {"track": "pelvis", "manifest": "human", "chains": {
        "body": ("spine", "root", ["pelvis", "spine_01", "spine_02", "spine_03"]),
        "neck": ("neck", "spine_03", ["neck_01", "head"]),
        **_sides("leg_{s}", "leg", "pelvis", ["thigh_{s}", "calf_{s}", "foot_{s}", "ball_{s}"]),
        **_sides("arm_{s}", "arm", "spine_03", ["upperarm_{s}", "lowerarm_{s}", "hand_{s}"])}},
    "fox": {"track": "hips", "manifest": "fox", "chains": {
        "body": ("spine", "root", ["hips", "spine_1", "spine_2", "spine_3"]),
        "neck": ("neck", "spine_3", ["spine_4", "spine_5", "head"]),
        "tail": ("tail", "hips", ["tail_1", "tail_2", "tail_3", "tail_4"]),
        **_sides("front_leg_{s}", "leg", "spine_3", ["front_leg_upper_{s}", "front_leg_lower_{s}", "front_leg_ankle_{s}", "front_leg_foot_{s}"]),
        **_sides("back_leg_{s}", "leg", "hips", ["back_leg_upper_{s}", "back_leg_lower_{s}", "back_leg_ankle_{s}", "back_leg_foot_{s}", "back_leg_toe_{s}"])}},
    "horse": {"track": "hips", "manifest": "horse", "chains": {
        "body": ("spine", "root", ["hips", "spine_1", "spine_2", "spine_3", "spine_4"]),
        "neck": ("neck", "spine_4", ["spine_5", "spine_6", "head"]),
        "tail": ("tail", "hips", ["tail_1", "tail_2", "tail_3", "tail_4"]),
        **_sides("front_leg_{s}", "leg", "spine_4", ["front_leg_upper_{s}", "front_leg_lower_{s}", "front_leg_ankle_{s}", "front_leg_foot_{s}"]),
        **_sides("back_leg_{s}", "leg", "hips", ["back_leg_upper_{s}", "back_leg_lower_{s}", "back_leg_ankle_{s}", "back_leg_foot_{s}", "back_leg_toe_{s}"])}},
    "kaiju": {"track": "hips", "manifest": "kaiju", "chains": {
        "body": ("spine", "root", ["hips", "spine_1", "spine_2", "spine_3"]),
        "neck": ("neck", "spine_3", ["spine_4", "spine_5", "head"]),
        "tail": ("tail", "hips", ["tail_1", "tail_2", "tail_3", "tail_4", "tail_5"]),
        **_sides("arm_{s}", "arm", "spine_3", ["front_leg_upper_{s}", "front_leg_lower_{s}", "hand_{s}"]),
        **_sides("leg_{s}", "leg", "hips", ["back_leg_upper_{s}", "back_leg_lower_{s}", "back_leg_ankle_{s}", "back_leg_foot_{s}", "back_leg_toe_1_{s}"])}},
    "spider": {"track": "hips", "manifest": "spider", "chains": {
        "body": ("spine", "root", ["hips", "spine_1", "spine_2", "head"]),
        "tail": ("tail", "hips", ["tail_1", "tail_2", "tail_3"]),
        **_sides("jaw_{s}", "jaw", "head", ["teeth_{s}"]),
        **{k: v for x in "abcd" for k, v in _sides(f"leg_{x}_{{s}}", "leg", "spine_1", [f"leg_{x}_1_{{s}}", f"leg_{x}_2_{{s}}", f"leg_{x}_3_{{s}}"]).items()}}},
    "snake": {"track": "head", "manifest": "snake", "chains": {
        "body": ("spine", "root", ["head", "neck"] + [f"tail{i:02d}" for i in range(1, 21)]),
        "tail": ("tail", "head", ["neck"] + [f"tail{i:02d}" for i in range(1, 21)]),
        "jaw": ("jaw", "head", ["mouth_extension", "mouth"])}},
    "dragon": {"track": "hips", "manifest": "dragon", "chains": {
        "body": ("spine", "root", ["hips", "spine_0", "spine_1"]),
        "neck": ("neck", "spine_1", ["spine_2", "spine_3", "spine_4", "head"]),
        "tail": ("tail", "hips", [f"tail_{i}" for i in range(1, 7)]),
        "jaw": ("jaw", "head", ["mouth_lower"]),
        **_sides("wing_{s}", "wing", "spine_0", ["shoulder_{s}"] + [f"wing_{i}_{{s}}" for i in range(1, 6)]),
        **_sides("front_leg_{s}", "leg", "spine_1", ["front_leg_{s}", "front_ankle_{s}", "front_foot_{s}", "front_toes_{s}"]),
        **_sides("back_leg_{s}", "leg", "hips", ["back_leg_{s}", "back_ankle_{s}", "back_foot_{s}", "back_toes_{s}"])}},
    "bird": {"track": "hips", "manifest": "bird", "chains": {
        "body": ("spine", "root", ["hips", "spine_0", "spine_1"]),
        "neck": ("neck", "spine_1", ["spine_2", "spine_3", "head"]),
        "tail": ("tail", "hips", ["tail_1", "tail_2", "tail_3"]),
        **_sides("wing_{s}", "wing", "spine_1", ["wing_1_{S}", "wing_2_{S}", "wing_3_{S}", "wing_4_{S}", "wing_5_{S}"]),
        **_sides("leg_{s}", "leg", "hips", ["UpperLeg_{S}", "LowerLeg_{S}", "AnkleLeg_{S}", "Foot_{S}"])}},
    "fish": {"track": "pelvis", "manifest": "shark", "chains": {
        "body": ("spine", "root", ["pelvis", "tail_1", "tail_2"]),
        "neck": ("neck", "pelvis", ["neck", "head"]),
        "tail": ("tail", "tail_2", [f"tail_{i}" for i in range(3, 9)]),
        "jaw": ("jaw", "neck", ["mouth_1"]),
        **_sides("fin_{s}", "fin", "tail_1", ["front_fin_0_{s}", "front_fin_1_{s}", "front_fin_2_{s}"])}},
}


def manifest(pack, template):
    with open(os.path.join(pack, "manifest.json")) as f:
        return json.load(f)["rigs"][TEMPLATES[template]["manifest"]]


def import_glb(path):
    """The objects and actions a glTF import adds."""
    objs, acts = set(bpy.data.objects), set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in objs], [a for a in bpy.data.actions if a not in acts]


def active(o):
    for s in bpy.context.selected_objects:
        s.select_set(False)
    o.select_set(True)
    bpy.context.view_layer.objects.active = o


def _side(points):
    x = points[0][0]
    return "l" if x > 1e-3 else "r" if x < -1e-3 else ""


def _frame(d):
    """The rotation whose Y is d and whose Z is as near world up as it can be."""
    d = d.normalized()
    up = Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((0, -1, 0))
    x = d.cross(up).normalized()
    return Matrix((x, d, x.cross(d).normalized())).transposed().to_quaternion()


def seg_dist(p, a, b):
    ab = b - a
    t = max(0, min(1, (p - a).dot(ab) / max(ab.length_squared, 1e-9)))
    return (a + ab * t - p).length


def _pca(pts):
    c = sum(pts, Vector()) / len(pts)
    M = Matrix([[sum((p[i] - c[i]) * (p[j] - c[j]) for p in pts) / len(pts) for j in range(3)] for i in range(3)])
    vecs = []
    for _ in range(3):  # power iteration with deflation
        v = Vector((1, 0.3, 0.1)).normalized() if not vecs else vecs[-1].orthogonal().normalized()
        for _ in range(60):
            w = M @ v
            for u in vecs:
                w -= u * w.dot(u)
            if w.length < 1e-12:
                break
            v = w.normalized()
        vecs.append(v)
    return c, vecs


def points_along(objs, n, start_near):
    """n + 1 joints along parts: slab centres along their main axis, the root end nearest start_near."""
    pts = [o.matrix_world @ v.co for o in objs for v in o.data.vertices]
    c, vecs = _pca(pts)
    a = vecs[0]
    ts = [(p - c).dot(a) for p in pts]
    lo, hi = min(ts), max(ts)
    if (c + a * lo - start_near).length > (c + a * hi - start_near).length:
        a, lo, hi, ts = -a, -hi, -lo, [-t for t in ts]
    w = (hi - lo) / (2 * n)
    out = []
    for i in range(n + 1):
        t = lo + (hi - lo) * i / n
        tt = min(max(t, lo + w * 0.5), hi - w * 0.5)
        sel = [p for p, s in zip(pts, ts) if abs(s - tt) < w]
        q = sum(sel, Vector()) / len(sel) if sel else c + a * tt
        out.append(q + a * (t - tt))  # the ends sit at the part's extremes
    return out


def guess(parts):
    """A chain spec from the parts alone, the fallback when the agent gives none: the bulkiest part is
    the body, long parts become chains (a sheet a wing; a tube a tentacle when it lies along the
    ground, a leg when only its tip reaches it, else a tail), a part continuing another's tip extends
    that chain, compact parts ride rigidly on the nearest bone. It finds the chains, not the knees."""
    info = {}
    for o in parts:
        pts = [o.matrix_world @ v.co for v in o.data.vertices]
        c, vecs = _pca(pts)
        ext = [max((p - c).dot(v) for p in pts) - min((p - c).dot(v) for p in pts) for v in vecs]
        info[o.name] = dict(o=o, c=c, ext=ext, pts=pts, zmin=min(p.z for p in pts), vol=ext[0] * ext[1] * ext[2],
                            lo=Vector([min(p[i] for p in pts) for i in range(3)]), hi=Vector([max(p[i] for p in pts) for i in range(3)]))
    floor = min(i["zmin"] for i in info.values())
    body = max(info, key=lambda n: info[n]["vol"])
    B = info[body]
    bc, H = B["c"], B["hi"].z - floor
    chains, rigid = [], {}
    if B["ext"][0] / max(B["ext"][1], 1e-6) > 3:  # a long body is itself the spine (a serpent)
        chains.append({"name": "body", "kind": "spine", "part": [body], "points": points_along([B["o"]], 12, bc + Vector((0, -10, 0)))})
    else:
        p0, p1 = Vector((bc.x, B["hi"].y, bc.z)), Vector((bc.x, B["lo"].y, bc.z))
        chains.append({"name": "body", "kind": "spine", "part": [body], "points": [p0, (p0 + p1) / 2, p1]})
    cand = []
    for n, I in info.items():
        if n == body:
            continue
        line = points_along([I["o"]], 6, bc)
        ds = sorted(min(seg_dist(p, a, b) for a, b in zip(line, line[1:])) for p in I["pts"])
        width = ds[int(0.9 * (len(ds) - 1))]
        if I["ext"][0] < 4 * width:
            rigid[n] = None
            continue
        cand.append(dict(name=n, I=I, L=I["ext"][0], width=width, sheet=width > 0.12 * I["ext"][0] and I["ext"][2] < 0.3 * I["ext"][1]))
    merged = {}  # a tube lying inside a sheet's box belongs to it (a wing's leading edge)
    for a in cand:
        for b in cand:
            if a is b or not b["sheet"] or a["sheet"]:
                continue
            m = 0.05 * b["L"]
            lo, hi = b["I"]["lo"] - Vector((m, m, m)), b["I"]["hi"] + Vector((m, m, m))
            if sum(all(lo[i] <= p[i] <= hi[i] for i in range(3)) for p in a["I"]["pts"]) > 0.8 * len(a["I"]["pts"]):
                merged[a["name"]] = b["name"]
    cand = [c for c in cand if c["name"] not in merged]
    for c in cand:
        c["parts"] = [c["name"]] + [k for k, v in merged.items() if v == c["name"]]
        c["points"] = points_along([info[p]["o"] for p in c["parts"]], 4 if c["sheet"] else max(2, min(8, round(c["L"] / max(c["width"], 1e-6) / 2.5))), bc)
    cand.sort(key=lambda c: (c["points"][0] - bc).length)
    out = []
    for c in cand:
        host = next((h for h in out if not h["sheet"] and not c["sheet"] and (h["points"][-1] - c["points"][0]).length < 0.25 * c["L"]), None)
        if host:
            host["points"] += c["points"][1:]
            host["parts"] += c["parts"]
        else:
            out.append(c)
    count = {}
    for c in out:
        near = sum(1 for p in c["points"] if p.z < floor + 0.12 * H)
        kind = "wing" if c["sheet"] else "tentacle" if near >= 3 else "leg" if c["points"][-1].z < floor + 0.15 * H else "tail"
        count[kind] = count.get(kind, 0) + 1
        chains.append({"name": f"{kind}{count[kind]}", "kind": kind, "parent": "body", "points": c["points"], "part": c["parts"]})
    return {"chains": chains, "rigid": rigid}


def build(spec, parts, name, collection):
    """The armature of a spec: a root, then each chain's bones head to tail, rolled to world up; a
    chain hangs from its parent chain's bone nearest its first point."""
    chains = spec["chains"]
    by = {c["name"]: c for c in chains}
    for c in chains:
        c["kind"] = c.get("kind", "tail")
        c["part"] = [c["part"]] if isinstance(c.get("part"), str) else list(c.get("part") or [])
        c["rigid"] = c.get("rigid", c["kind"] == "rigid")
        if not c.get("points"):
            par = by.get(c.get("parent"))
            near = Vector(par["points"][-1]) if par and par.get("points") else Vector()
            c["points"] = points_along([parts[p] for p in c["part"]], c.get("bones") or DEFAULT_BONES.get(c["kind"], 3), near)
        c["points"] = [Vector(p) for p in c["points"]]
        c["side"] = _side(c["points"])
    data = bpy.data.armatures.new(name)
    A = bpy.data.objects.new(name, data)
    collection.objects.link(A)
    active(A)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = data.edit_bones
    p0 = chains[0]["points"][0]
    r = eb.new("root")
    r.head, r.tail = Vector((p0.x, p0.y, 0)), Vector((p0.x, p0.y + 0.2, 0))
    names = {}
    for c in chains:
        bn = []
        for i in range(len(c["points"]) - 1):
            b = eb.new(f"{c['name']}_{i}")
            b.head, b.tail = c["points"][i], c["points"][i + 1]
            d = (b.tail - b.head).normalized()
            b.align_roll(Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((0, -1, 0)))
            if i:
                b.parent, b.use_connect = eb[bn[-1]], True
            bn.append(b.name)
        names[c["name"]] = bn
        pb = min(names[c["parent"]], key=lambda n: seg_dist(c["points"][0], eb[n].head, eb[n].tail)) if c.get("parent") else "root"
        eb[bn[0]].parent = eb[pb]
        c["attach"] = pb
    bpy.ops.object.mode_set(mode="OBJECT")
    for c in chains:
        c["bones"] = names[c["name"]]
    A.data.bones["root"].use_deform = False
    return A


# ------------------------------------------------------------------ template clips, read as chains
_SRC = {}


def source(pack, template, clip):
    """World rotation, head and tail of every template bone on every frame of one clip, and at rest."""
    key = (template, clip)
    if key in _SRC:
        return _SRC[key]
    man = manifest(pack, template)
    entry = next((a for a in man["animations"] if a["name"] == clip), None)
    if entry is None:
        raise KeyError(f"{template} has no clip {clip}")
    objs, _ = import_glb(os.path.join(pack, man["skeleton"]["file"]))
    T = next(o for o in objs if o.type == "ARMATURE")
    bpy.data.batch_remove([o for o in objs if o is not T])
    cobjs, acts = import_glb(os.path.join(pack, entry["file"]))
    bpy.data.batch_remove(cobjs)
    W = T.matrix_world
    rest = {b.name: ((W @ b.matrix_local).to_quaternion(), W @ b.head_local, W @ b.tail_local) for b in T.data.bones}
    T.animation_data_create()
    T.animation_data.action = acts[0]
    if acts[0].slots:
        T.animation_data.action_slot = acts[0].slots[0]
    f0, f1 = int(acts[0].frame_range[0]), int(acts[0].frame_range[1])
    sc = bpy.context.scene
    keep = sc.frame_current
    frames = []
    for f in range(f0, f1 + 1):
        sc.frame_set(f)
        frames.append({pb.name: ((W @ pb.matrix).to_quaternion(), W @ pb.head, W @ pb.tail) for pb in T.pose.bones})
    sc.frame_set(keep)
    bpy.data.objects.remove(T)
    bpy.data.batch_remove(acts)
    ys = {n: v[1].y for n, v in rest.items()}
    _SRC[key] = dict(rest=rest, frames=frames, n=len(frames) - 1, track=TEMPLATES[template]["track"], y=ys)
    return _SRC[key]


def _at(S, t):
    x = (t % 1.0) * S["n"]
    i = int(x)
    j, a = min(i + 1, S["n"]), x - i
    A, B = S["frames"][i], S["frames"][j]
    return {k: (A[k][0].slerp(B[k][0], a), A[k][1].lerp(B[k][1], a), A[k][2].lerp(B[k][2], a)) for k in A}


def _fracs(points):
    L = [0.0]
    for a, b in zip(points, points[1:]):
        L.append(L[-1] + (b - a).length)
    return [x / max(L[-1], 1e-9) for x in L]


def _match(spec, template, kinds, only, ys):
    """This model's chain -> the template chain of the same kind, side and front-to-back order."""
    src = TEMPLATES[template]["chains"]
    out, by_kind = {}, {}
    for c in spec["chains"]:
        if only and not any(fnmatch.fnmatch(c["name"], p) for p in only):
            continue
        by_kind.setdefault(c["kind"], []).append(c)
    for kind, tcs in by_kind.items():
        skind = kinds.get(kind, kind)
        scs = [n for n, v in src.items() if v[0] == skind] if skind else []
        if not scs:
            continue
        for side in ("l", "r", ""):
            ts = sorted([c for c in tcs if c["side"] == side], key=lambda c: c["points"][0].y)
            ss = ([n for n in scs if n.endswith("_" + side)] if side else []) or [n for n in scs if not n.endswith(("_l", "_r"))] or scs
            ss = sorted(ss, key=lambda n: ys[src[n][2][0]])
            for i, c in enumerate(ts):
                j = round(i * (len(ss) - 1) / max(len(ts) - 1, 1)) if len(ts) > 1 else 0
                out[c["name"]] = ss[min(j, len(ss) - 1)]
    return out


def _retarget(L, spec, pack, nframes):
    template, clip = L["from"].split(":", 1)
    S = source(pack, template, clip)
    m = _match(spec, template, L.get("kinds", {}), L.get("chains"), S["y"])
    src = TEMPLATES[template]["chains"]
    uses = {}
    for t, s in m.items():
        uses.setdefault(s, []).append(t)
    out, root, ground = [dict() for _ in range(nframes + 1)], [None] * (nframes + 1), []
    SR = S["rest"]
    for tname, sname in m.items():
        c = next(c for c in spec["chains"] if c["name"] == tname)
        _, sP, sbones = src[sname]
        mode = L.get("mode", {}).get(c["kind"]) or ("pose" if c["kind"] in ("leg", "arm") else "delta")
        peers = uses[sname]
        phase = peers.index(tname) / len(peers) * L.get("spread", 1.0) if len(peers) > 1 else 0.0
        spts = [SR[b][1] for b in sbones] + [SR[sbones[-1]][2]]
        sfr, tfr = _fracs(spts), _fracs(c["points"])
        sp0, sp1 = L.get("span", (0.0, 1.0))
        Aq = _frame(c["points"][-1] - c["points"][0]) @ _frame(spts[-1] - spts[0]).inverted()
        amp = L.get("amp", {}).get(c["kind"], 1.0)
        smid = [0.5 * (sfr[k] + sfr[k + 1]) for k in range(len(sbones))]
        for f in range(nframes + 1):
            P = _at(S, f / nframes + phase)
            undo = SR[sP][0] @ P[sP][0].inverted()  # takes the template's attach bone back to rest
            if mode == "pose":
                pts = [undo @ (P[b][1] - P[sP][1]) for b in sbones] + [undo @ (P[sbones[-1]][2] - P[sP][1])]

                def at(u, pts=pts):
                    k = min(max([0] + [k for k in range(len(sfr) - 1) if sfr[k] <= u]), len(sfr) - 2)
                    return pts[k].lerp(pts[k + 1], (u - sfr[k]) / max(sfr[k + 1] - sfr[k], 1e-9))

            for i, bn in enumerate(c["bones"]):
                if mode == "delta":
                    u = sp0 + 0.5 * (tfr[i] + tfr[i + 1]) * (sp1 - sp0)
                    k = max([0] + [k for k in range(len(sbones)) if smid[k] <= u])
                    k2 = min(k + 1, len(sbones) - 1)
                    a = 0 if k2 == k else max(0, min(1, (u - smid[k]) / (smid[k2] - smid[k])))

                    def dk(k):
                        return undo @ P[sbones[k]][0] @ SR[sbones[k]][0].inverted()

                    D = Aq @ dk(k).slerp(dk(k2), a) @ Aq.inverted()
                    if amp != 1.0:
                        D = Quaternion().slerp(D, amp)
                else:
                    d = Aq @ (at(sp0 + tfr[i + 1] * (sp1 - sp0)) - at(sp0 + tfr[i] * (sp1 - sp0)))
                    D = (c["points"][i + 1] - c["points"][i]).rotation_difference(d)
                out[f][bn] = D
        if c["kind"] == "leg":
            ground.append(c["name"])
    if L.get("move", True) and any(src[s][0] == "spine" for s in m.values()):
        def extent(pts):
            return max(max(p[i] for p in pts) - min(p[i] for p in pts) for i in range(3))

        # Body motion scales with overall size; sideways and forward motion count from the first
        # frame, height from rest; the loop's net travel goes (the game moves the root).
        k = extent([p for c in spec["chains"] for p in c["points"]]) / extent([v[j] for v in SR.values() for j in (1, 2)])
        h0, hr = _at(S, 0)[S["track"]][1], SR[S["track"]][1]
        base = Vector((h0.x, h0.y, hr.z))
        disp = [(_at(S, f / nframes)[S["track"]][1] - base) * k for f in range(nframes + 1)]
        for f in range(nframes + 1):
            root[f] = disp[f] - (disp[-1] - disp[0]) * (f / nframes)
    return out, root, ground


def chains_of(spec, pats):
    return [c for c in spec["chains"] if any(fnmatch.fnmatch(c["name"], p) or c["kind"] == p for p in pats)]


def _bend(c, f, nframes, fn, axis):
    """Bend angles fn(u, t, i), summed along the chain, about its side or up axis."""
    d = (c["points"][-1] - c["points"][0]).normalized()
    up = Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((0, -1, 0))
    ax = d.cross(up).normalized() if axis == "up" else up
    fr, acc, out = _fracs(c["points"]), 0.0, {}
    for i, bn in enumerate(c["bones"]):
        acc += fn(0.5 * (fr[i] + fr[i + 1]), f / nframes, i)
        out[bn] = Quaternion(ax, acc)
    return out


def _procedural(L, spec, nframes):
    out, root = [dict() for _ in range(nframes + 1)], [None] * (nframes + 1)
    kind, tau = L["proc"], 2 * math.pi
    cs = chains_of(spec, L.get("chains", ["*"]))
    cyc = L.get("cycles", 1)
    for ci, c in enumerate(cs):
        ph = L.get("spread", 0.0) * ci / max(len(cs), 1)
        sgn, nb = (1 if c["side"] != "r" else -1), len(c["bones"])
        for f in range(nframes + 1):
            if kind == "breathe":
                a = math.radians(L.get("amp", 3))
                o = _bend(c, f, nframes, lambda u, t, i: a / nb * math.sin(tau * (t * cyc + ph)), "up")
            elif kind == "wave":
                a, w, lift = math.radians(L.get("amp", 15)), L.get("waves", 1.0), L.get("lift", False)

                def wave(u, t, i, a=a, w=w, ph=ph):
                    return a * (0.3 + u) / nb * 2 * math.sin(tau * (t * cyc - u * w + ph))

                o = _bend(c, f, nframes, (lambda u, t, i: 0.5 * wave(u, t, i) + a * (0.3 + u) / nb) if lift else wave, L.get("axis", "side"))
                if L.get("axis2"):
                    o2 = _bend(c, f, nframes, lambda u, t, i: 0.6 * wave(u, t + 0.25 / cyc, i), L["axis2"])
                    o = {k: o2[k] @ o[k] for k in o}
            elif kind == "flap":
                a, lag, t, acc, o = math.radians(L.get("amp", 40)), L.get("lag", 0.12), f / nframes, 0.0, {}
                for i, bn in enumerate(c["bones"]):
                    acc += (a if i == 0 else a * 0.35) * math.sin(tau * (t * cyc - i * lag))
                    o[bn] = Quaternion(Vector((0, 1, 0)), -sgn * acc)
            elif kind == "strike":
                a, cnt, past, recoil = math.radians(L.get("amp", 40)), L.get("count", 1), L.get("past", 0.2), L.get("profile") == "recoil"

                def env(t, cnt=cnt, past=past, recoil=recoil):
                    t = (t * cnt) % 1.0
                    if recoil:
                        return math.exp(-t * 10)
                    if t < 0.35:
                        return math.sin(t / 0.35 * math.pi / 2)
                    if t < 0.5:
                        return 1 - (1 + past) * (t - 0.35) / 0.15
                    return -past * (1 - (t - 0.5) / 0.5) ** 2

                o = _bend(c, f, nframes, lambda u, t, i: ((a if i == 0 else 0) if recoil else a / nb) * env(t), "up")
            else:
                raise ValueError(f"no procedural layer {kind}")
            out[f].update(o)
    for f in range(nframes + 1):
        t, r = f / nframes, Vector()
        if kind == "breathe" or L.get("bob"):
            r += Vector((0, 0, L.get("bob", 0.01) * math.sin(tau * t * cyc)))
        r += Vector((0, 0, L.get("hover", 0.0)))
        if L.get("lunge"):
            e = math.sin(math.pi * (t - 0.3) / 0.4) if 0.3 < t < 0.7 else 0
            back = -0.3 * math.sin(math.pi * t / 0.3) if t < 0.3 else 0
            r += Vector((0, -L["lunge"] * (e + back), -0.3 * L["lunge"] * e))
        root[f] = r
    return out, root, []


def _rest(A):
    W = A.matrix_world
    return {b.name: dict(q=(W @ b.matrix_local).to_quaternion(), h=W @ b.head_local, t=W @ b.tail_local,
                         parent=b.parent.name if b.parent else None) for b in A.data.bones}


def _compose(spec, A, R, layers, nframes, legs):
    """World rotations per bone per frame (chains ride on the bone they hang from), with the body
    raised or lowered so the lowest foot stays on the ground."""
    attach = {bn: c["attach"] for c in spec["chains"] for bn in c["bones"]}
    order = [b.name for b in A.data.bones]
    frames = []
    for f in range(nframes + 1):
        D, rootoff = {}, Vector()
        for lo, ro in layers:
            D.update(lo[f])
            if ro[f] is not None:
                rootoff = rootoff + ro[f]
        Q, H = {}, {}
        for n in order:
            r = R[n]
            if r["parent"] is None:
                Q[n], H[n] = r["q"], r["h"] + rootoff
                continue
            P = attach.get(n, "root")
            Q[n] = Q[P] @ R[P]["q"].inverted() @ D.get(n, Quaternion()) @ r["q"]
            bp = r["parent"]
            H[n] = H[bp] + Q[bp] @ R[bp]["q"].inverted() @ (r["h"] - R[bp]["h"])
        if legs:
            tips = [(H[b] + Q[b] @ R[b]["q"].inverted() @ (R[b]["t"] - R[b]["h"])).z for c in spec["chains"] if c["name"] in legs for b in [c["bones"][-1]]]
            g0 = min(R[c["bones"][-1]]["t"].z for c in spec["chains"] if c["name"] in legs)
            rootoff = rootoff + Vector((0, 0, g0 - min(tips)))
        frames.append((Q, rootoff))
    return frames


def _key(A, R, act, frames):
    A.animation_data_create()
    A.animation_data.action = act
    for pb in A.pose.bones:
        pb.rotation_mode = "QUATERNION"
    for f, (Q, rootoff) in enumerate(frames):
        for pb in A.pose.bones:
            r = R[pb.name]
            if r["parent"] is None:
                pb.rotation_quaternion = Quaternion()
                pb.location = r["q"].inverted() @ rootoff
                pb.keyframe_insert("location", frame=f)
            else:
                p = r["parent"]
                pb.rotation_quaternion = r["q"].inverted() @ R[p]["q"] @ Q[p].inverted() @ Q[pb.name]
            pb.keyframe_insert("rotation_quaternion", frame=f)


def _ik(A, spec, L, nframes, act):
    """An N-legged gait with planted, flat feet through the kit's bake_ik_walk: tripod for six,
    diagonal pairs for four, alternate for two. Returns its ground speed (m/s)."""
    from .blender import bake_ik_walk

    legs = chains_of(spec, L.get("chains", ["leg"]))
    if not legs:
        raise ValueError("an IK gait needs leg chains")
    feet, phase, by_side = [], {}, {}
    for c in legs:
        by_side.setdefault(c["side"], []).append(c)
    for s, cs in by_side.items():
        for i, c in enumerate(sorted(cs, key=lambda c: c["points"][0].y)):
            feet.append(c["bones"][-1])
            phase[c["bones"][-1]] = ((i + (s == "r")) % 2) * 0.5
    hip = sum(c["points"][0].z for c in legs) / len(legs)
    reach = sum(Vector((c["points"][-1] - c["points"][0]).xy).length for c in legs) / len(legs)
    stride, lift, duty, cyc = L.get("stride", max(0.6 * hip, 0.4 * reach)), L.get("lift", 0.25 * hip), L.get("duty", 0.55), L.get("cycles", 1)

    def step(foot, f):
        t = (f / nframes * cyc + phase[foot]) % 1.0
        if t < duty:
            return Vector((0, -stride / 2 + stride * t / duty, 0))
        s = (t - duty) / (1 - duty)
        return Vector((0, stride / 2 - stride * s, lift * math.sin(math.pi * s)))

    flat = []
    for foot in feet:  # soles keep their rest orientation while the IK bends the leg above
        e = bpy.data.objects.new("flat_" + foot, None)
        bpy.context.scene.collection.objects.link(e)
        e.matrix_world = A.matrix_world @ A.data.bones[foot].matrix_local
        c = A.pose.bones[foot].constraints.new("COPY_ROTATION")
        c.target = e
        flat.append((e, c, foot))
    try:
        bake_ik_walk(A, feet, step, nframes, clip=act.name)
    finally:
        for e, c, foot in flat:
            A.pose.bones[foot].constraints.remove(c)
            bpy.data.objects.remove(e)
    return stride / (duty * nframes / cyc / FPS)


def default_clips(spec):
    """Idle, a move and an attack chosen from the chain kinds, then the alternatives the proof kept."""
    k = {}
    for c in spec["chains"]:
        k[c["kind"]] = k.get(c["kind"], 0) + 1
    legs, wings, tent = k.get("leg", 0), k.get("wing", 0) + k.get("fin", 0), k.get("tentacle", 0)
    extra = []
    if k.get("antenna"):
        extra.append({"proc": "wave", "chains": ["antenna"], "amp": 12, "cycles": 2, "axis": "up", "axis2": "side", "spread": 0.5})
    if k.get("tail") and legs:
        extra.append({"proc": "wave", "chains": ["tail"], "amp": 15, "cycles": 1})
    breathe = {"proc": "breathe", "chains": ["spine"], "amp": 2, "cycles": 2, "bob": 0.01}
    if legs >= 5:
        return {"Idle": {"layers": [{"from": "spider:Idle"}] + extra},
                "Walk": {"frames": 32, "ik": {}, "layers": [breathe] + extra},
                "Attack": {"layers": [{"from": "spider:Attack"}] + extra},
                "Walk_spider": {"layers": [{"from": "spider:Walk", "mode": {"leg": "delta"}}] + extra}}
    if legs in (2, 4) and not wings:
        return {"Idle": {"frames": 48, "layers": [{"proc": "breathe", "chains": ["spine"], "amp": 2, "bob": 0.008}] + extra},
                "Walk": {"frames": 32, "ik": {}, "layers": [dict(breathe, bob=0.02)] + extra},
                "Attack": {"frames": 36, "layers": [{"proc": "strike", "chains": ["arm", "neck", "jaw"], "amp": 30},
                                                    {"proc": "strike", "chains": ["spine"], "amp": -6, "lunge": 0.05}] + extra}}
    if wings and not legs:
        return {"Idle": {"frames": 72, "layers": [{"proc": "wave", "chains": ["spine"], "amp": 8, "waves": 0.8},
                                                  {"proc": "flap", "chains": ["wing", "fin"], "amp": 5}]},
                "Fly": {"layers": [{"from": "dragon:Fly Flap", "chains": ["wing*"], "move": False},
                                   {"proc": "wave", "chains": ["spine"], "amp": 25, "waves": 1.2, "bob": 0.06, "hover": 0.9}]},
                "Slither": {"frames": 36, "layers": [{"proc": "wave", "chains": ["spine"], "amp": 30, "waves": 1.3}, {"proc": "flap", "chains": ["wing", "fin"], "amp": 6}]},
                "Attack": {"layers": [{"from": "snake:Bite", "mode": {"spine": "pose"}}, {"from": "dragon:Roar", "chains": ["wing*"], "move": False}]}}
    if tent >= 3:
        front = [c["name"] for c in sorted((c for c in spec["chains"] if c["kind"] == "tentacle"), key=lambda c: c["points"][-1].y)[:2]]
        return {"Idle": {"frames": 72, "layers": [{"proc": "breathe", "chains": ["neck", "spine"], "amp": 6, "bob": 0.015},
                                                  {"proc": "wave", "chains": ["tentacle"], "amp": 10, "waves": 0.7, "spread": 1.0}]},
                "Crawl": {"layers": [{"from": "snake:Side winding", "kinds": {"tentacle": "tail", "spine": None, "neck": None}, "amp": {"tentacle": 0.5}, "span": (0.0, 0.45)},
                                     {"proc": "breathe", "chains": ["neck", "spine"], "amp": 4, "cycles": 2, "bob": 0.02}]},
                "Attack": {"frames": 36, "layers": [{"proc": "wave", "chains": ["tentacle"], "amp": 8, "waves": 0.7, "spread": 1.0},
                                                    {"proc": "strike", "chains": front, "amp": 120, "past": 0.0},
                                                    {"proc": "strike", "chains": ["neck", "spine"], "amp": 25, "lunge": 0.12}]},
                "Crawl_ripple": {"frames": 48, "layers": [{"proc": "wave", "chains": ["tentacle"], "amp": 22, "waves": 0.8, "cycles": 2, "axis": "up", "axis2": "side", "spread": 2.0, "lift": True}]}}
    # Anything else: a breath, a sway of every chain, and a strike of the front ones.
    return {"Idle": {"frames": 48, "layers": [{"proc": "breathe", "chains": ["spine", "neck"], "amp": 3, "bob": 0.01},
                                              {"proc": "wave", "chains": ["tail", "tentacle", "antenna", "wing", "fin"], "amp": 8, "spread": 0.5}]},
            "Attack": {"frames": 36, "layers": [{"proc": "strike", "chains": ["neck", "arm", "jaw"], "amp": 30, "lunge": 0.05}]}}


def bake(A, spec, pack, clips, action_for):
    """Keys each clip ({name: {frames?, layers, ik?}}) on A. action_for(name) gives the action to key
    into. Returns [(name, action, ground speed or None, whether a template's clip went into it)]."""
    R = _rest(A)
    made = []
    for name, C in clips.items():
        n = C.get("frames") or 0
        if not n:
            first = next(L for L in C["layers"] if "from" in L)
            n = source(pack, *first["from"].split(":", 1))["n"]
        outs, legs = [], []
        for L in C["layers"]:
            o, r, g = _retarget(L, spec, pack, n) if "from" in L else _procedural(L, spec, n)
            outs.append((o, r))
            legs += g
        act = action_for(name)
        _key(A, R, act, _compose(spec, A, R, outs, n, legs))
        speed = _ik(A, spec, C["ik"], n, act) if "ik" in C else None
        made.append((name, act, speed, any("from" in L for L in C["layers"])))
    return made
