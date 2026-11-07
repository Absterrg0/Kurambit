"""Contact facts, numbers only: floating parts, skin through skin, arms through the body.

Adapted from blender-kiln (MIT, see THIRD-PARTY-NOTICES.md): `floating()` from the
floating-parts check in plugin/references/reference-fidelity.md §3, `Skin` from
bench/skin_intersect.py and the arm-through-body part of plugin/tools/motion_measure.py.

Skin crossings are triangle pairs the BVH finds overlapping, ignoring pairs that share a corner:
corners are welded by position first, because a glTF round trip splits every seam. Areas are the
rest areas of the crossing triangles, in mm², and what already crosses at rest is subtracted from
a pose, so a modelled overlap (an eye set into its head) is counted once, at rest."""
import math

import bpy
import numpy as np
from mathutils import Quaternion, Vector
from mathutils.bvhtree import BVHTree

from . import helpers

FLOAT_GAP = 0.0005  # metres: a part farther than this from every other one touches nothing

# The standard skeleton's limbs, by root bone: every bone below one belongs to that limb.
ARMS = ("upperarm_l", "upperarm_r")
LEGS = ("thigh_l", "thigh_r")
# kiln's fixed bent pose: bone -> (degrees about the body's side axis, where its tail should go).
BENT = {"thigh": (60, "fwd"), "calf": (75, "back"), "upperarm": (45, "fwd"), "lowerarm": (75, "fwd_up")}
BENT_CENTRE = {"spine_01": (20, "fwd"), "neck_01": (30, "fwd_down")}


def _near(co, tree, tol):
    return any(tree.find_nearest(v, tol)[0] is not None for v in co)


def floating(objects):
    """[(name, gap metres)] of the geometry parts not connected to the main piece, farthest first;
    None with fewer than two parts. Two parts touch when they cross or a vertex of one lies within
    FLOAT_GAP of the other's surface; the main piece is the touching group with the largest
    bounds, and a part outside it is reported with its distance to the parts outside its group.
    Measured at rest, on the parts as the agent modelled them."""
    parts = []
    for o in objects:
        if o.type not in helpers.GEOMETRY:
            continue
        co, polys = helpers.rest_coords(o)
        if len(co) and polys:
            parts.append((o.name, np.asarray(co), polys))
    if len(parts) < 2:
        return None
    n = len(parts)
    trees = [BVHTree.FromPolygons(co.tolist(), polys) for _, co, polys in parts]
    lo = [co.min(0) for _, co, _ in parts]
    hi = [co.max(0) for _, co, _ in parts]
    group = list(range(n))

    def root(i):
        while group[i] != i:
            group[i] = group[group[i]]
            i = group[i]
        return i

    for i in range(n):
        for k in range(i + 1, n):
            if root(i) == root(k) or (lo[i] > hi[k] + FLOAT_GAP).any() or (lo[k] > hi[i] + FLOAT_GAP).any():
                continue
            if trees[i].overlap(trees[k]) or _near(parts[i][1].tolist(), trees[k], FLOAT_GAP) or _near(parts[k][1].tolist(), trees[i], FLOAT_GAP):
                group[root(k)] = root(i)
    groups = {}
    for i in range(n):
        groups.setdefault(root(i), []).append(i)
    if len(groups) == 1:
        return []
    size = lambda g: np.prod(np.max([hi[i] for i in g], 0) - np.min([lo[i] for i in g], 0) + 1e-4)
    main = max(groups.values(), key=size)
    out = []
    for g in groups.values():
        if g is main:
            continue
        rest = [k for k in range(n) if k not in g]
        co_r, polys_r, off = [], [], 0
        for k in rest:
            co_r.append(parts[k][1])
            polys_r += [tuple(v + off for v in p) for p in parts[k][2]]
            off += len(parts[k][1])
        tree = BVHTree.FromPolygons(np.concatenate(co_r).tolist(), polys_r)
        for i in g:
            gap = min(d for d in (tree.find_nearest(v)[3] for v in parts[i][1].tolist()) if d is not None)
            out.append((parts[i][0], gap))
    return sorted(out, key=lambda x: -x[1])


def _descendants(bones, roots):
    out = set()
    for b in bones:
        p = b
        while p is not None:
            if p.name in roots:
                out.add(b.name)
                break
            p = p.parent
    return out


def _coords(mesh, dg):
    ev = mesh.evaluated_get(dg)
    me = ev.to_mesh()
    try:
        co = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get("co", co)
        m = np.array(ev.matrix_world)
        return co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]
    finally:
        ev.to_mesh_clear()


class Skin:
    """The skins an armature deforms, as one triangle soup with each triangle's part: arm, leg,
    tail or body (the torso and the head), from the bone weighing most on its corners."""

    def __init__(self, arm, meshes):
        self.arm, self.meshes = arm, meshes
        bones = arm.data.bones
        arms, legs = _descendants(bones, ARMS), _descendants(bones, LEGS)
        tris, fams, off = [], [], 0
        for o in meshes:
            me = o.data
            me.calc_loop_triangles()
            t = np.empty(len(me.loop_triangles) * 3, np.int64)
            me.loop_triangles.foreach_get("vertices", t)
            t = t.reshape(-1, 3)
            names = [g.name for g in o.vertex_groups]
            part = [1 if n in arms else 2 if n in legs else 3 if "tail" in n.lower() else 0 for n in names]
            vf = np.zeros(len(me.vertices), np.int8)  # 0 body, 1 arm, 2 leg, 3 tail
            for v in me.vertices:
                best = max(((g.weight, g.group) for g in v.groups if g.group < len(names)), default=None)
                if best is not None and best[0] > 0:
                    vf[v.index] = part[best[1]]
            tf = vf[t]
            fams.append(np.where(tf[:, 1] == tf[:, 2], tf[:, 1], tf[:, 0]))
            tris.append(t + off)
            off += len(me.vertices)
        self.tris = np.concatenate(tris) if tris else np.zeros((0, 3), np.int64)
        self.fam = np.concatenate(fams) if fams else np.zeros(0, np.int8)
        self.has_arms = bool(arms) and bool((self.fam == 1).any())
        rest = self.coords()
        _, canon = np.unique(np.round(rest, 6), axis=0, return_inverse=True)
        self.corners = canon.reshape(-1)[self.tris]
        p = rest[self.tris]
        self.area = 0.5 * np.linalg.norm(np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0]), axis=1) * 1e6
        self.total = float(self.area.sum())
        self.arm_idx = np.where(self.fam == 1)[0]
        self.body_idx = np.where(self.fam == 0)[0]
        self.rest_hits = self.hits(rest)
        self.rest_arm_body = self.arm_body(rest)

    def coords(self):
        dg = bpy.context.evaluated_depsgraph_get()
        dg.update()
        out = [_coords(o, dg) for o in self.meshes]
        return np.concatenate(out) if out else np.zeros((0, 3))

    def _apart(self, pairs):
        """The pairs that share no corner."""
        if not len(pairs):
            return pairs
        a, b = self.corners[pairs[:, 0]], self.corners[pairs[:, 1]]
        share = np.zeros(len(pairs), bool)
        for i in range(3):
            for j in range(3):
                share |= a[:, i] == b[:, j]
        return pairs[~share]

    def hits(self, co):
        """The triangles crossing another one."""
        tree = BVHTree.FromPolygons(co.tolist(), self.tris.tolist(), all_triangles=True)
        pairs = np.array(tree.overlap(tree), np.int64).reshape(-1, 2)
        pairs = self._apart(pairs[pairs[:, 0] != pairs[:, 1]])
        return set(pairs.ravel().tolist())

    def arm_body(self, co):
        """The arm and body triangles crossing each other, and the arm triangles with two corners
        inside the body: a limb buried deep crosses the surface only where it enters."""
        if not len(self.arm_idx) or not len(self.body_idx):
            return set()
        pts = co.tolist()
        ta = BVHTree.FromPolygons(pts, self.tris[self.arm_idx].tolist(), all_triangles=True)
        tb = BVHTree.FromPolygons(pts, self.tris[self.body_idx].tolist(), all_triangles=True)
        pairs = np.array(ta.overlap(tb), np.int64).reshape(-1, 2)
        out = set()
        if len(pairs):
            pairs = self._apart(np.stack([self.arm_idx[pairs[:, 0]], self.body_idx[pairs[:, 1]]], 1))
            out = set(pairs.ravel().tolist())
        body = self.tris[self.body_idx].ravel()
        lo, hi = co[body].min(0), co[body].max(0)
        corners = np.unique(self.tris[self.arm_idx])
        corners = corners[((co[corners] >= lo) & (co[corners] <= hi)).all(1)]
        inside = np.zeros(len(co), bool)
        for v in corners.tolist():
            loc, normal, _, _ = tb.find_nearest(pts[v])
            if loc is not None and (Vector(pts[v]) - loc).dot(normal) < 0:
                inside[v] = True
        deep = self.arm_idx[inside[self.tris[self.arm_idx]].sum(1) >= 2]
        return out | set(deep.tolist())

    def mm2(self, tris):
        return float(self.area[list(tris)].sum()) if tris else 0.0

    def pct(self, tris):
        return round(100 * self.mm2(tris) / self.total, 3) if self.total else 0.0

    def arm_body_mm2(self):
        """Arm skin through the body on the current pose, mm², less what crosses at rest."""
        return self.mm2(self.arm_body(self.coords()) - self.rest_arm_body)

    def bent(self):
        """The share of the skin crossing other skin on kiln's bent pose, %, less what crosses at
        rest; None when the standard limbs are missing. Leaves the armature at rest."""
        arm, pb = self.arm, self.arm.pose.bones
        names = [f"{b}_{s}" for b in BENT for s in "lr"] + list(BENT_CENTRE)
        if any(n not in pb for n in names) or "pelvis" not in pb:
            return None
        w = arm.matrix_world
        foot = arm.data.bones.get("foot_l")
        fwd = (w.to_3x3() @ (foot.tail_local - foot.head_local)) if foot is not None else Vector((0, -1, 0))
        fwd.z = 0
        fwd = fwd.normalized() if fwd.length > 1e-6 else Vector((0, -1, 0))
        up = Vector((0, 0, 1))
        side = fwd.cross(up).normalized()
        want = {"fwd": fwd, "back": -fwd, "fwd_up": fwd + up, "fwd_down": fwd - up}
        spec = {f"{b}_{s}": v for b, v in BENT.items() for s in "lr"} | BENT_CENTRE
        saved = {p.name: (p.rotation_mode, p.matrix_basis.copy()) for p in pb}
        try:
            for name, (deg, toward) in spec.items():
                p = pb[name]
                p.rotation_mode = "QUATERNION"
                axis = ((w @ p.matrix).to_3x3().normalized().inverted() @ side).normalized()
                best = None
                for sign in (1, -1):
                    t0 = (w @ p.tail).copy()
                    p.rotation_quaternion = Quaternion(axis, sign * math.radians(deg))
                    bpy.context.view_layer.update()
                    gain = ((w @ p.tail) - t0).dot(want[toward].normalized())
                    p.rotation_quaternion = (1, 0, 0, 0)
                    bpy.context.view_layer.update()
                    if best is None or gain > best[0]:
                        best = (gain, sign)
                p.rotation_quaternion = Quaternion(axis, best[1] * math.radians(deg))
                bpy.context.view_layer.update()
            return self.pct(self.hits(self.coords()) - self.rest_hits)
        finally:
            for p in pb:
                p.rotation_mode, p.matrix_basis = saved[p.name][0], saved[p.name][1]
            bpy.context.view_layer.update()
