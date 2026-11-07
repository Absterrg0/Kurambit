"""The standard skeleton as numpy matrices for the move compiler (animate.py) and the motion metrics
(measure.py): rest frames, forward kinematics, bases from armature-space poses, and two-bone IK
with an explicit hinge.

Everything is in armature space, where the character faces -Y with its right at -X and Z up.
Body space (what a move spec is written in) is x = the character's right, y = forward, z = up, in
metres, with its origin on the ground under the root: body_to_armature(v) = B2W v."""
import math

import bpy
import numpy as np

B2W = np.array([[-1.0, 0, 0], [0, -1.0, 0], [0, 0, 1.0]])
FINGERS = ("thumb", "index", "middle", "ring", "pinky")


def rx(d):
    a = math.radians(d)
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def ry(d):
    a = math.radians(d)
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rz(d):
    a = math.radians(d)
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def body_rot(yaw=0.0, pitch=0.0, roll=0.0):
    """A turn written in body terms as an armature rotation at yaw 0: yaw > 0 turns left, pitch > 0
    bends forward, roll > 0 leans to the character's right."""
    return rz(yaw) @ rx(pitch) @ ry(-roll)


def unit(v):
    v = np.asarray(v, float)
    n = np.linalg.norm(v)
    return v / n if n > 1e-9 else v


def frame_of(u, v):
    """Orthonormal columns [u, v', u x v'], v' being v made perpendicular to u."""
    u = unit(u)
    v = np.asarray(v, float) - np.dot(v, u) * u
    if np.linalg.norm(v) < 1e-6:
        v = np.cross(u, [0, 0, 1.0]) if abs(u[2]) < 0.9 else np.cross(u, [1.0, 0, 0])
    v = unit(v)
    return np.column_stack([u, v, np.cross(u, v)])


def map_pair(a0, b0, a1, b1):
    """The rotation taking direction a0 to a1, and b0's part perpendicular to it to b1's."""
    return frame_of(a1, b1) @ frame_of(a0, b0).T


def axis_angle(axis, deg):
    axis = unit(axis)
    a = math.radians(deg)
    K = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + math.sin(a) * K + (1 - math.cos(a)) * K @ K


def rot_between(a, b):
    a, b = unit(a), unit(b)
    v = np.cross(a, b)
    c = float(np.dot(a, b))
    if c < -0.999999:
        return axis_angle(unit(np.cross(a, [1, 0, 0]) if abs(a[0]) < 0.9 else np.cross(a, [0, 1, 0])), 180.0)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx / (1 + c)


def angle_of(R):
    return math.degrees(math.acos(max(-1.0, min(1.0, (np.trace(R) - 1) / 2))))


def slerp_rot(R0, R1, t):
    """Rotation interpolation; t may leave [0, 1] (overshoot)."""
    D = R0.T @ R1
    ang = angle_of(D)
    if ang < 1e-6:
        return R0
    w = np.array([D[2, 1] - D[1, 2], D[0, 2] - D[2, 0], D[1, 0] - D[0, 1]])
    if np.linalg.norm(w) < 1e-9:  # 180 degrees
        vals, vecs = np.linalg.eigh((D + D.T) / 2)
        w = vecs[:, np.argmax(vals)]
    return R0 @ axis_angle(w, ang * t)


def M4(R=None, t=None):
    m = np.eye(4)
    if R is not None:
        m[:3, :3] = R
    if t is not None:
        m[:3, 3] = t
    return m


def swing_twist(R, axis):
    """The twist of R about a unit axis, degrees."""
    w = math.sqrt(max(0.0, 1 + np.trace(R))) / 2
    if w < 1e-6:
        return 180.0
    x = (R[2, 1] - R[1, 2]) / (4 * w)
    y = (R[0, 2] - R[2, 0]) / (4 * w)
    z = (R[1, 0] - R[0, 1]) / (4 * w)
    return math.degrees(2 * math.atan2(float(np.dot([x, y, z], axis)), w))


class Rig:
    """An armature's rest as numpy, parents first, in armature space."""

    def __init__(self, arm):
        self.arm = arm
        self.names = sorted((b.name for b in arm.data.bones), key=lambda n: len(arm.data.bones[n].parent_recursive))
        self.parent = {b.name: (b.parent.name if b.parent else None) for b in arm.data.bones}
        self.L = {b.name: np.array(b.matrix_local) for b in arm.data.bones}
        self.Linv = {n: np.linalg.inv(m) for n, m in self.L.items()}
        self.length = {b.name: b.length for b in arm.data.bones}

    def head(self, n):
        return self.L[n][:3, 3]

    def local(self, n, P, B):
        """n's armature-space matrix from its parent's pose and its own basis."""
        p = self.parent[n]
        return (self.L[n] if p is None else P[p] @ self.Linv[p] @ self.L[n]) @ B

    def fk(self, B, P=None):
        P = {} if P is None else P
        for n in self.names:
            P[n] = self.local(n, P, B.get(n, np.eye(4)))
        return P

    def basis(self, P):
        B = {}
        for n in self.names:
            p = self.parent[n]
            ref = self.L[n] if p is None else P[p] @ self.Linv[p] @ self.L[n]
            B[n] = np.linalg.inv(ref) @ P[n]
        return B

    def head_under(self, n, P):
        """Where n's head sits given its parent's pose."""
        p = self.parent[n]
        return (P[p] @ self.Linv[p] @ self.L[n])[:3, 3]

    def posed(self, n, Rdelta, P, head=None):
        """P[n] for a rotation from rest, its head carried by its parent (or given)."""
        h = self.head_under(n, P) if head is None else np.asarray(head, float)
        P[n] = M4(Rdelta @ self.L[n][:3, :3], h)
        return P[n]

    def read_pose(self):
        return {pb.name: np.array(pb.matrix) for pb in self.arm.pose.bones}


def two_bone(S, G, a, b, pole):
    """The middle joint of a chain of lengths a, b from S reaching for G, bent toward pole (a
    direction). Returns (middle, the end reached, the reach asked as a share of the chain's length)."""
    S, G = np.asarray(S, float), np.asarray(G, float)
    dv = G - S
    d = np.linalg.norm(dv)
    need = d / (a + b)
    d = min(max(d, abs(a - b) + 1e-4), (a + b) * 0.9995)
    u = unit(dv)
    p = np.asarray(pole, float) - np.dot(pole, u) * u
    if np.linalg.norm(p) < 1e-6:
        p = np.cross(u, [1, 0, 0])
    p = unit(p)
    ca = (a * a + d * d - b * b) / (2 * a * d)
    sa = math.sqrt(max(0.0, 1 - ca * ca))
    return S + a * (ca * u + sa * p), S + u * d, need


def rest_hinge(L, n):
    """The axis an elbow or knee folds about at rest: the forearm folds forward, the calf back."""
    y = L[n][:3, 1]
    if n.startswith(("upperarm", "lowerarm")):
        return unit(np.cross(y, [0, -1.0, 0]))
    return unit(np.cross(y, [0, 1.0, 0]))


STANDARD_JOINTS = ("root", "pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "Head", "clavicle_l", "clavicle_r", "upperarm_l",
                   "upperarm_r", "lowerarm_l", "lowerarm_r", "hand_l", "hand_r", "thigh_l", "thigh_r", "calf_l", "calf_r", "foot_l",
                   "foot_r", "ball_l", "ball_r", "middle_01_l", "middle_01_r")
# A fist's curl per finger joint (degrees), and a relaxed hand's; the thumb folds less.
FIST = {"01": 55.0, "02": 80.0, "03": 55.0}
RELAXED = {"01": 12.0, "02": 18.0, "03": 12.0}
THUMB = 0.45


def _descendants(arm, name):
    out = []
    stack = [arm.data.bones[name]]
    while stack:
        b = stack.pop()
        out.append(b.name)
        stack.extend(b.children)
    return set(out)


def _islands(me, mask):
    """A label per vertex: the connected piece it belongs to, over edges between masked vertices."""
    parent = np.arange(len(me.vertices))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    ev = np.empty(len(me.edges) * 2, np.int64)
    me.edges.foreach_get("vertices", ev)
    for a, b in ev.reshape(-1, 2):
        if mask[a] and mask[b]:
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[ra] = rb
    return np.array([find(i) for i in range(len(parent))])


def character_meshes(arm):
    """The meshes that move with an armature: skinned by it, or parented to it or to its bones."""
    out = []
    for o in bpy.context.scene.objects:
        if o.type != "MESH":
            continue
        if any(m.type == "ARMATURE" and m.object == arm for m in o.modifiers):
            out.append(o)
            continue
        p = o.parent
        while p is not None and p != arm:
            p = p.parent
        if p == arm:
            out.append(o)
    return out


class Body:
    """What the compiler and the metrics know of a character: its rest landmarks and the prop a
    hand holds, if any. A held prop is a mesh parented to a hand (or a finger), or skin weighted
    rigidly to one beyond the fingers; its long axis, its tip and its grip are measured from its
    vertices in the hand's frame, so the pose it is held in is the pose it was modelled in."""

    def __init__(self, arm, meshes=None):
        missing = [n for n in STANDARD_JOINTS if n not in arm.data.bones]
        if missing:
            raise ValueError("not on the standard skeleton: no bone " + ", ".join(missing[:8]))
        self.arm = arm
        r = self.rig = Rig(arm)
        self.meshes = character_meshes(arm) if meshes is None else meshes
        from . import helpers

        self.chain_bones = {b for bones in helpers.chains_of(arm).values() for b in bones}
        self.thigh = float(np.linalg.norm(r.head("calf_l") - r.head("thigh_l")))
        self.calf = float(np.linalg.norm(r.head("foot_l") - r.head("calf_l")))
        self.upper = float(np.linalg.norm(r.head("lowerarm_l") - r.head("upperarm_l")))
        self.fore = float(np.linalg.norm(r.head("hand_l") - r.head("lowerarm_l")))
        self.ball_off = {s: r.head("ball_" + s) - r.head("foot_" + s) for s in "lr"}
        self.ball_h = float(r.head("ball_l")[2])
        top = r.head("Head")[2] + r.length["Head"]
        self.height = float(max(top, 0.5))
        self.chest_off = B2W.T @ (r.head("spine_03") - r.head("pelvis"))
        self.head_off = B2W.T @ (r.head("Head") - r.head("pelvis"))
        self.stretch = {}
        self.prop = self._held()
        self.main = self.prop["side"] if self.prop else "r"
        self.off = "l" if self.main == "r" else "r"
        self.second = 0.058 * self.height  # the off hand's place on a two-handed grip, below the main
        self.clearance = self._torso_radius() + 0.05
        self.curl = {n: self._curl_sign(n) for n in r.names if n.split("_")[0] in FINGERS and not n.split("_")[1].startswith("04")}

    # ------------------------------------------------------------------------------- the held prop
    def _held(self):
        arm = self.arm
        dg = bpy.context.evaluated_depsgraph_get()
        found = []
        for s in "rl":
            hand = "hand_" + s
            under = _descendants(arm, hand)
            Pw = arm.matrix_world @ arm.pose.bones[hand].matrix
            inv = np.array(Pw.inverted())
            tip = "middle_04_leaf_" + s
            # past the fingertips: the fist's own skin is rigid to the hand too
            reach = float(np.linalg.norm(self.rig.head(tip) - self.rig.head(hand))) + 0.03 if tip in self.rig.L else 0.12 * self.height / 1.8
            pts, objects = [], []
            for o in self.meshes:
                ev = o.evaluated_get(dg)
                me = ev.to_mesh()
                try:
                    co = np.empty(len(me.vertices) * 3)
                    me.vertices.foreach_get("co", co)
                    co = co.reshape(-1, 3) @ np.array(ev.matrix_world)[:3, :3].T + np.array(ev.matrix_world)[:3, 3]
                finally:
                    ev.to_mesh_clear()
                if o.parent == arm and o.parent_type == "BONE" and o.parent_bone in under:
                    pts.append(co)
                    objects.append(o.name)
                    continue
                if not any(m.type == "ARMATURE" and m.object == arm for m in o.modifiers):
                    continue
                gi = {g.index for g in o.vertex_groups if g.name in under}
                if not gi:
                    continue
                rigid = np.zeros(len(o.data.vertices), bool)
                for v in o.data.vertices:
                    w = sum(g.weight for g in v.groups if g.group in gi)
                    rigid[v.index] = w >= 0.98
                if rigid.any():
                    local = co @ inv[:3, :3].T + inv[:3, 3]
                    far = rigid & (np.linalg.norm(local, axis=1) > reach)
                    if far.any():
                        # every rigid island reaching past the fingertips: a box blade has vertices
                        # only at its ends, so the far ones alone would be its tip
                        island = _islands(o.data, rigid)
                        keep = rigid & np.isin(island, np.unique(island[far]))
                        if keep.sum() >= 8:
                            pts.append(co[keep])
                            objects.append(o.name)
            if not pts:
                continue
            world = np.concatenate(pts)
            local = world @ inv[:3, :3].T + inv[:3, 3]
            c = local.mean(0)
            _, sv, vt = np.linalg.svd(local - c, full_matrices=False)
            axis = vt[0]
            proj = (local - c) @ axis
            if np.linalg.norm(c + axis * proj.max()) < np.linalg.norm(c + axis * proj.min()):
                axis, proj = -axis, -proj
            length = float(proj.max() - proj.min())
            if length < 0.2 * self.height / 1.8:
                continue
            palm = np.array([0, self.rig.length[hand] * 0.5, 0.0])
            grip = c + axis * float(np.dot(palm - c, axis))
            edge = unit(vt[1] - axis * np.dot(vt[1], axis))
            found.append({"side": s, "objects": objects, "axis": axis, "grip": grip, "tip": c + axis * proj.max(),
                          "base": c + axis * proj.min(), "edge": edge, "length": length,
                          # a blade is much wider than thick; a staff is round and has no edge to lead with
                          "edged": bool(len(sv) > 2 and sv[1] > 1.8 * sv[2]), "mass": 0.016})
        if not found:
            return None
        prop = max(found, key=lambda p: p["length"])
        # the other hand's mirrored hold of the same handle (the skeleton is symmetric across x)
        s, o = prop["side"], "l" if prop["side"] == "r" else "r"
        Mw = np.diag([-1.0, 1, 1])
        Rm, Ro = self.rig.L["hand_" + s][:3, :3], self.rig.L["hand_" + o][:3, :3]
        prop["axis_off"] = Ro.T @ Mw @ Rm @ prop["axis"]
        prop["edge_off"] = Ro.T @ Mw @ Rm @ prop["edge"]
        prop["grip_off"] = Ro.T @ Mw @ Rm @ prop["grip"]
        return prop

    def tip_of(self, P):
        """The held prop's tip in armature space, or None."""
        if self.prop is None:
            return None
        return (P["hand_" + self.prop["side"]] @ np.array([*self.prop["tip"], 1]))[:3]

    def _torso_radius(self):
        """How far the torso's skin reaches from the spine at the 85th percentile, from the
        vertices the pelvis and spine weigh most on (a slim body and a bulky cuirass differ)."""
        a, b = self.rig.head("pelvis"), self.rig.head("spine_03")
        d = []
        for o in self.meshes:
            if not any(m.type == "ARMATURE" for m in o.modifiers):
                continue
            names = [g.name for g in o.vertex_groups]
            mw = np.array(o.matrix_world)
            for v in o.data.vertices:
                best = max(((g.weight, g.group) for g in v.groups if g.group < len(names)), default=None)
                if best is None or names[best[1]] not in ("pelvis", "spine_01", "spine_02", "spine_03"):
                    continue
                p = (mw @ np.array([*v.co, 1.0]))[:3]
                ab = b - a
                t = min(1, max(0, np.dot(p - a, ab) / np.dot(ab, ab)))
                d.append(np.linalg.norm(p - (a + ab * t)))
        return float(np.percentile(d, 85)) if len(d) > 20 else 0.09 * self.height

    def _curl_sign(self, n):
        """+1 or -1: which way about the joint's own x axis folds the finger toward the palm (the
        tip comes closer to the wrist)."""
        r = self.rig
        side = n[-1]
        P0 = r.fk({})
        tip_name = n.rsplit("_", 2)[0] + "_04_leaf_" + side
        if tip_name not in r.L:
            return 1.0
        wrist = P0["hand_" + side][:3, 3]
        best = None
        for sign in (1.0, -1.0):
            B = {n: M4(rx(sign * 40.0))}
            P = r.fk(B)
            d = np.linalg.norm(P[tip_name][:3, 3] - wrist)
            if best is None or d < best[0]:
                best = (d, sign)
        return best[1]

    def finger_basis(self, side, fist):
        out = {}
        for n, sign in self.curl.items():
            if n[-1] != side:
                continue
            joint = n.split("_")[1]
            deg = (FIST if fist else RELAXED).get(joint, 0.0) * (THUMB if n.startswith("thumb") else 1.0)
            out[n] = M4(rx(sign * deg))
        return out

    # ---------------------------------------------------------------------------------- the stand
    def stand(self):
        """The default pose, from this body's rest: standing, knees soft, arms hanging; a held prop
        low and forward in its hand."""
        r = self.rig
        pel = B2W.T @ r.head("pelvis")
        reach = self.upper + self.fore
        pose = {
            "root": (0.0, 0.0, 0.0),
            "hips": {"at": (0.0, float(pel[1]), float(pel[2]) * 0.97), "turn": (0.0, 0.0, 0.0)},
            "chest": (0.0, 0.0, 0.0),
            "head": (0.0, 0.0, 0.0),
            "look": None,
        }
        for s in "lr":
            sh = B2W.T @ r.head("upperarm_" + s)
            ball = B2W.T @ r.head("ball_" + s)
            pose["hand_" + s] = {"at": (float(sh[0]) * 1.12, float(sh[1]) + 0.02, float(sh[2]) - reach * 0.96), "space": "root", "turn": (0.0, 0.0, 0.0)}
            pose["foot_" + s] = {"at": (float(ball[0]), float(ball[1]), 0.0), "yaw": 0.0, "heel": 0.0, "space": "ground"}
            pose["elbow_" + s] = (0.4 * float(np.sign(sh[0])), -0.3, -1.0)
            pose["knee_" + s] = (0.1 * float(np.sign(ball[0])), 1.0, 0.0)
        if self.prop is not None:
            m = self.main
            sh = B2W.T @ r.head("upperarm_" + m)
            pose["hand_" + m] = "grip"
            pose["prop"] = {"grip": (float(sh[0]) * 1.1, 0.22, float(sh[2]) - reach * 0.8), "tip": (0.0, 0.55, -0.83), "edge": None, "space": "root"}
        return pose
