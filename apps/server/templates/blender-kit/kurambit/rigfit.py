"""Where a template's joints sit inside a model: fit(model, template armature, reference body, kind, hints).

Mesh2Motion authored each rig on a reference body (its model.glb). A joint keeps its place relative
to landmarks measured the same way on that body and on the model: for a person the crotch, chest
width, fingertips and soles; for a four-legged animal its four feet, belly, nose and tail tip. Other
templates map the reference body's box onto the model's. Joints the agent names (hints) are where it
says, and the joints between them move with them. Blender axes: Z up, the model faces -Y.
"""
import bmesh
import bpy
from mathutils import Quaternion, Vector
from mathutils.bvhtree import BVHTree

# Friendlier names for the human template's main joints.
HUMAN_ALIASES = {
    "hips": "pelvis", "chest": "spine_03", "neck": "neck_01",
    **{f"{k}_{s}": f"{v}_{s}" for s in "lr" for k, v in (
        ("shoulder", "upperarm"), ("elbow", "lowerarm"), ("wrist", "hand"),
        ("hip", "thigh"), ("knee", "calf"), ("ankle", "foot"), ("toe", "ball"))},
}


class Probe:
    """Landmark queries on world-space geometry."""

    def __init__(self, meshes):
        bm = bmesh.new()
        for o in meshes:
            me = o.data.copy()
            me.transform(o.matrix_world)
            bm.from_mesh(me)
            bpy.data.meshes.remove(me)
        self.co = [v.co.copy() for v in bm.verts]
        self.bvh = BVHTree.FromBMesh(bm)
        bm.free()
        self.min = Vector([min(c[i] for c in self.co) for i in range(3)])
        self.max = Vector([max(c[i] for c in self.co) for i in range(3)])

    def hits(self, origin, d, far=50.0):
        """Every surface crossing along a ray, as distances."""
        out, o, d, travelled = [], Vector(origin), Vector(d).normalized(), 0.0
        while travelled < far:
            loc, _, _, dist = self.bvh.ray_cast(o, d, far - travelled)
            if loc is None:
                break
            travelled += dist + 1e-4
            out.append(travelled)
            o = loc + d * 1e-4
        return out

    def first(self, origin, d):
        h = self.hits(origin, d)
        return h[0] if h else None

    def span(self, p, axis):
        """The inside extent along an axis through p, as (lo, hi), or None."""
        a, big = Vector(axis).normalized(), 10.0
        h = self.hits(p - a * big, a)
        if len(h) < 2:
            return None
        pairs = [(h[i], h[i + 1]) for i in range(0, len(h) - 1, 2)]
        best = min(pairs, key=lambda q: 0 if q[0] <= big <= q[1] else min(abs(q[0] - big), abs(q[1] - big)))
        base = p - a * big
        return base + a * best[0], base + a * best[1]

    def centroid(self, pred):
        pts = [c for c in self.co if pred(c)]
        return sum(pts, Vector()) / len(pts) if pts else None


def _piecewise(x, xs, ys):
    """Piecewise-linear through knots, extrapolating the end segments."""
    i = 0 if x <= xs[0] else len(xs) - 2 if x >= xs[-1] else max(k for k in range(len(xs) - 1) if xs[k] <= x)
    t = (x - xs[i]) / (xs[i + 1] - xs[i]) if xs[i + 1] != xs[i] else 0
    return ys[i] + t * (ys[i + 1] - ys[i])


def _human_landmarks(P):
    H = P.max.z - P.min.z
    # The body's centre comes from the lower shins, so a held sword or a cape cannot move it.
    shins = [c for c in P.co if P.min.z + 0.08 * H < c.z < P.min.z + 0.15 * H]
    ankles = {}
    for s, sg in (("l", 1), ("r", -1)):
        side = sorted((c for c in shins if sg * c.x > 0), key=lambda c: c.y)
        ankles[s] = side[len(side) // 2] if side else Vector((sg * 0.1 * H, 0, 0))
    cy = (ankles["l"].y + ankles["r"].y) / 2
    crotch = P.min.z + (P.first(Vector((0, cy, P.min.z - 0.01)), (0, 0, 1)) or 0.47 * H)
    # Chest half-width measured from inside the torso, so A-pose arms are not hit.
    chest_z = crotch + 0.45 * (P.max.z - crotch)
    sp = P.span(Vector((0, cy, chest_z)), (0, 1, 0))
    ymid = (sp[0].y + sp[1].y) / 2 if sp else cy
    half = P.first(Vector((0, ymid, chest_z)), (1, 0, 0)) or 0.1 * H
    L = {"H": H, "crotch": crotch, "half": half, "ymid": ymid, "ankle_y": {k: v.y for k, v in ankles.items()},
         "legx": 0.7 * max(abs(c.x) for c in P.co)}
    for s, sg in (("l", 1), ("r", -1)):
        L["tip_" + s] = _arm_tip(P, Vector((sg * half * 1.1, ymid, crotch + 0.62 * (P.max.z - crotch))), sg, H)
    return L


def _arm_tip(P, start, sg, H):
    """The fingertip, found by walking down the arm from the shoulder in slabs, each centred on the
    last, so a hand hanging beside the thigh is followed and the thigh is not."""
    step, r = 0.025 * H, 0.07 * H
    c, d = start, Vector((sg, 0, -0.4)).normalized()
    walked = 0
    for _ in range(80):
        ahead = c + d * step
        slab = [p for p in P.co if abs((p - ahead).dot(d)) < step * 0.6 and ((p - ahead) - d * (p - ahead).dot(d)).length < r]
        if len(slab) < 3:
            break
        cen = sum(slab, Vector()) / len(slab)
        if (cen - c).length < 1e-6:
            break
        d = (d + (cen - c).normalized()).normalized()
        c = cen
        walked += 1
    if walked < 6:
        raise ValueError("no arm clear of the torso (arms down against it)")
    end = [p for p in P.co if (p - c).length < r and (p - c).dot(d) > -step]
    return max(end, key=lambda p: (p - start).length)


def _quad_landmarks(P):
    H = P.max.z - P.min.z
    low = [c for c in P.co if c.z < P.min.z + 0.2 * H]
    ysplit = sum(c.y for c in low) / len(low)
    feet = {}
    for side, sg in (("l", 1), ("r", -1)):
        for end, f in (("front", lambda c: c.y < ysplit), ("back", lambda c: c.y >= ysplit)):
            pts = [c for c in low if sg * c.x > 0 and f(c)]
            if not pts:
                raise ValueError(f"no {end} {side} foot on the ground")
            feet[end + "_" + side] = sum(pts, Vector()) / len(pts)
    yf = (feet["front_l"].y + feet["front_r"].y) / 2
    yb = (feet["back_l"].y + feet["back_r"].y) / 2

    def belly(y):
        return P.min.z + (P.first(Vector((0, y, P.min.z - 0.01)), (0, 0, 1)) or 0.5 * H)

    return {"H": H, "nose": P.min.y, "tail": P.max.y, "yf": yf, "yb": yb, "feet": feet,
            "belly_f": belly(yf), "belly_b": belly(yb), "ysplit": ysplit}


def _leg_center(P, z, sg, xlim, yrange):
    dz = 0.02 * (P.max.z - P.min.z)
    pts = [c for c in P.co if abs(c.z - z) < dz and sg * c.x > 0 and abs(c.x) < xlim and yrange[0] <= c.y <= yrange[1]]
    if not pts:
        return None
    # A median, so a cape or skirt hem caught in the slice pulls less than a mean would.
    xs, ys = sorted(c.x for c in pts), sorted(c.y for c in pts)
    return Vector((xs[len(xs) // 2], ys[len(ys) // 2], z))


def _vertical_center(P, x, y, z):
    sp = P.span(Vector((x, y, z)), (0, 0, 1))
    return (sp[0].z + sp[1].z) / 2 if sp else z


def _fit_human(P, R, th, bones):
    LP, LR = _human_landmarks(P), _human_landmarks(R)
    zmap = lambda z: _piecewise(z, [R.min.z, LR["crotch"], R.max.z], [P.min.z, LP["crotch"], P.max.z])  # noqa: E731
    k = LP["H"] / LR["H"]
    out = {}
    for b in bones:
        n, h = b.name, th[b.name]
        part, side = n[:-2], n[-1]
        sg = 1 if side == "l" else -1
        if n == "root":
            out[n] = Vector((0, LP["ymid"], P.min.z))
        elif n in ("pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "head"):
            z = zmap(h.z)
            sr, sp = R.span(Vector((0, LR["ymid"], h.z)), (0, 1, 0)), P.span(Vector((0, LP["ymid"], z)), (0, 1, 0))
            f = (h.y - sr[0].y) / (sr[1].y - sr[0].y) if sr else 0.5
            out[n] = Vector((0, sp[0].y + f * (sp[1].y - sp[0].y) if sp else LP["ymid"], z))
        elif part in ("thigh", "calf", "foot"):
            z = zmap(h.z) if part != "thigh" else LP["crotch"] + (h.z - LR["crotch"]) * k
            cz = min(z, LP["crotch"] - 0.03 * LP["H"])
            ay = LP["ankle_y"][side]
            c = _leg_center(P, cz, sg, LP["legx"], (ay - 0.07 * LP["H"], ay + 0.07 * LP["H"]))
            out[n] = Vector((c.x, c.y, z)) if c else Vector((h.x * k, h.y * k, z))
            if part == "foot":  # the ankle sits over the heel, not the middle of the foot
                heel = P.centroid(lambda q: abs(q.z - z) < 0.025 * LP["H"] and sg * q.x > 0 and abs(q.x) < LP["legx"])
                if heel:
                    out[n] = Vector((heel.x, heel.y, z))
        elif part in ("upperarm", "lowerarm", "hand"):
            # The shoulder keeps the template's offset from spine_03, widened by the chest; elbow and
            # wrist sit at the template's fractions along shoulder to fingertip, centred in the arm.
            sh_r = th["upperarm_" + side]
            off = sh_r - th["spine_03"]
            sh_p = out["spine_03"] + Vector((off.x * LP["half"] / LR["half"], off.y * k, off.z * k))
            if part == "upperarm":
                out[n] = sh_p
                continue
            ar, ap = LR["tip_" + side] - sh_r, LP["tip_" + side] - sh_p
            q = sh_p + ap * ((h - sh_r).dot(ar) / ar.length_squared)
            v, w = ap.normalized(), 0.02 * LP["H"]
            c = P.centroid(lambda p: abs((p - q).dot(v)) < w and sg * p.x > LP["half"] * 0.9 and (p - q).length < 0.12 * LP["H"])
            out[n] = c or q
        elif part == "ball":
            def sole(M, L, g):
                pts = [q for q in M.co if q.z < M.min.z + 0.06 * L["H"] and g * q.x > 0 and abs(q.x) < L["legx"]]
                return min(pts, key=lambda q: q.y), max(pts, key=lambda q: q.y)

            (tr, hr), (tp, hp) = sole(R, LR, sg), sole(P, LP, sg)
            y = hp.y + (h.y - hr.y) / (tr.y - hr.y) * (tp.y - hp.y)
            cx = P.centroid(lambda c: abs(c.y - y) < 0.01 * LP["H"] and c.z < P.min.z + 0.06 * LP["H"] and sg * c.x > 0 and abs(c.x) < LP["legx"])
            out[n] = Vector((cx.x if cx else h.x * k, y, P.min.z + (h.z - R.min.z) * k))
    try:
        turns = _hands(P, R, LP, LR, th, out)
    except ValueError:
        turns = {}
    return out, (P.max.z - P.min.z) / (R.max.z - R.min.z), turns


def _hand_frame(M, wrist, tip):
    """A hand's axes: along it (wrist to fingertip) and across it toward the thumb, which points
    forward (-Y) in an A- or T-pose; and its length."""
    d = tip - wrist
    L = d.length
    d = d.normalized()
    if sum(1 for c in M.co if 0 < (c - wrist).dot(d) < L * 1.05 and _seg(c, wrist, tip) < 0.5 * L) < 12:
        raise ValueError("no hand at the end of the arm")
    w = Vector((0, -1, 0))
    return d, (w - d * w.dot(d)).normalized(), L


def _seg(p, a, b):
    ab = b - a
    t = max(0, min(1, (p - a).dot(ab) / max(ab.length_squared, 1e-9)))
    return (a + ab * t - p).length


def _frame_turn(dr, wr, dp, wp):
    """The rotation taking the frame (dr, wr) onto (dp, wp)."""
    from mathutils import Matrix

    def m(d, w):
        w = (w - d * w.dot(d)).normalized()
        return Matrix((d, w, d.cross(w))).transposed()

    return (m(dp, wp) @ m(dr, wr).inverted()).to_quaternion()


def _hands(P, R, LP, LR, th, out):
    """{hand bone: (turn, scale)}: how each hand turned and grew from the template's, so its fingers
    land in the model's fingers, palm and thumb where the model has them."""
    turns = {}
    for s in "lr":
        hb = "hand_" + s
        if hb not in out:
            continue
        dr, wr, lr_ = _hand_frame(R, th[hb], LR["tip_" + s])
        dp, wp, lp = _hand_frame(P, out[hb], LP["tip_" + s])
        turns[hb] = (_frame_turn(dr, wr, dp, wp), lp / lr_)
    return turns


def _fit_quad(P, R, th, bones):
    LP, LR = _quad_landmarks(P), _quad_landmarks(R)
    ymap = lambda y: _piecewise(y, [LR["nose"], LR["yf"], LR["yb"], LR["tail"]], [LP["nose"], LP["yf"], LP["yb"], LP["tail"]])  # noqa: E731
    wr, wp = max(abs(c.x) for c in R.co), max(abs(c.x) for c in P.co)
    out = {}
    for b in bones:
        n, h = b.name, th[b.name]
        front = n.startswith("front_")
        is_leg = front or n.startswith("back_")
        belly_r = LR["belly_f"] if front else LR["belly_b"]
        belly_p = LP["belly_f"] if front else LP["belly_b"]
        if n == "root":
            out[n] = Vector((0, (LP["yf"] + LP["yb"]) / 2, P.min.z))
        elif is_leg and h.z < belly_r:
            sg = 1 if n.endswith("_l") else -1
            z = P.min.z + (h.z - R.min.z) * (belly_p - P.min.z) / (belly_r - R.min.z)
            foot = LP["feet"][("front_" if front else "back_") + n[-1]]
            yr = (LP["nose"], LP["ysplit"]) if front else (LP["ysplit"], LP["tail"])
            # Near this leg's own foot, so a low tail or the belly is never averaged in.
            zz, d = max(z, P.min.z + 0.015 * LP["H"]), abs(LP["yf"] - LP["yb"])
            rad = 0.22 * d * (1 + (zz - P.min.z) / (belly_p - P.min.z))
            c = P.centroid(lambda q: abs(q.z - zz) < 0.02 * LP["H"] and sg * q.x > 0 and yr[0] <= q.y <= yr[1]
                           and Vector((q.x - foot.x, q.y - foot.y)).length < rad)
            out[n] = Vector((c.x, c.y, z)) if c else Vector((foot.x, foot.y, z))
        elif is_leg or n.startswith(("hips", "spine", "head", "nose", "tail", "chest")):
            y = min(max(ymap(h.y), P.min.y + 0.01), P.max.y - 0.01)
            yr = min(max(h.y, R.min.y + 0.01), R.max.y - 0.01)
            srr = R.span(Vector((0, yr, _vertical_center(R, 0, yr, h.z))), (0, 0, 1))
            f = (h.z - srr[0].z) / (srr[1].z - srr[0].z) if srr else 0.5
            zguess = _piecewise(h.z, [R.min.z, R.max.z], [P.min.z, P.max.z])
            spp = P.span(Vector((0, y, _vertical_center(P, 0, y, zguess))), (0, 0, 1))
            out[n] = Vector((h.x * wp / wr, y, spp[0].z + f * (spp[1].z - spp[0].z) if spp else zguess))
    return out, (P.max.y - P.min.y) / (R.max.y - R.min.y), {}


def _fit_box(P, R, th):
    """The reference body's box mapped onto the model's, axis by axis (x about the middle)."""
    k = [(P.max[i] - P.min[i]) / max(R.max[i] - R.min[i], 1e-6) for i in range(3)]
    out = {}
    for n, h in th.items():
        out[n] = Vector((h.x * k[0], P.min.y + (h.y - R.min.y) * k[1], P.min.z + (h.z - R.min.z) * k[2]))
    return out, sorted(k)[1], {}


def _follow(bones, th, out, s, turns):
    """Every joint not placed follows its parent rigidly, turned as the parent turned (a hand's
    fingers as the whole hand turned, scaled as it grew)."""
    rot = {n: q for n, (q, _) in turns.items()}
    grow = {}

    def scale(b):
        if b.name not in grow:
            grow[b.name] = turns[b.name][1] if b.name in turns else scale(b.parent) if b.parent else s
        return grow[b.name]

    def bone_rot(b):
        if b.name in rot:
            return rot[b.name]
        q = Quaternion()
        kids = [c for c in b.children if c.name in out]
        if b.name in out and kids:
            a, c = th[kids[0].name] - th[b.name], out[kids[0].name] - out[b.name]
            if a.length > 1e-5 and c.length > 1e-5:
                q = a.rotation_difference(c)
        elif b.parent:
            q = bone_rot(b.parent)
        rot[b.name] = q
        return q

    def place(b):
        if b.name not in out:
            p = b.parent
            out[b.name] = place(p) + bone_rot(p) @ ((th[b.name] - th[p.name]) * scale(p))
        return out[b.name]

    for b in bones:
        place(b)


def _warp(bones, out, hints):
    """Hinted joints go where the agent says; a joint between a hinted ancestor and a hinted
    descendant moves by the blend of their moves, one below a hint follows it, one above only a hint
    moves part way, from nothing at the root."""
    move = {n: Vector(p) - out[n] for n, p in hints.items()}
    by = {b.name: b for b in bones}

    def ancestor(b, dist=0.0):
        p = b.parent
        while p is not None:
            dist += (out[b.name] - out[p.name]).length
            if p.name in move:
                return p.name, dist
            b, p = p, p.parent
        return None, dist

    def descendant(b):
        level, d = [(c, (out[c.name] - out[b.name]).length) for c in b.children], 0
        while level:
            hit = [(c, dd) for c, dd in level if c.name in move]
            if hit:
                return hit
            level = [(g, dd + (out[g.name] - out[c.name]).length) for c, dd in level for g in c.children]
            d += 1
        return []

    new = {}
    for n, b in by.items():
        if n in move:
            new[n] = out[n] + move[n]
            continue
        a, da = ancestor(b)
        below = descendant(b)
        ma = move[a] if a else Vector()
        if below:
            md = sum((move[c.name] for c, _ in below), Vector()) / len(below)
            dd = sum(dd for _, dd in below) / len(below)
            t = da / max(da + dd, 1e-6)
            new[n] = out[n] + ma.lerp(md, t)
        else:
            new[n] = out[n] + ma
    out.update(new)


def fit(meshes, template, reference, kind, hints=None):
    """{bone: world head} for the template's joints inside meshes, the template-to-model scale,
    {bone: turn} for bones whose whole frame turned (hands: their roll too), and notes. kind: "human", "quad" or anything else for the box map."""
    P, R = Probe(meshes), Probe(reference)
    bones = list(template.data.bones)
    th = {b.name: template.matrix_world @ b.head_local for b in bones}
    notes = []
    out, s, turns = None, None, {}
    if kind in ("human", "quad"):
        try:
            out, s, turns = (_fit_human if kind == "human" else _fit_quad)(P, R, th, bones)
        except (ValueError, ZeroDivisionError, TypeError, IndexError) as e:
            notes.append(f"the {kind} landmarks were not found ({e}), so the joints come from the model's box: pass joints for the ones that matter")
            out = None
    if out is None:
        out, s, turns = _fit_box(P, R, th)
    _follow(bones, th, out, s, turns)
    if hints:
        _warp(bones, out, hints)
    return out, s, {n: q for n, (q, _) in turns.items()}, notes
