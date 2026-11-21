"""A stylised human body from Blender Studio's Human Base Meshes bundle (CC0), rigged here.

The two stylised bodies ship in the kit (bodies/stylised.blend, 0.6 MB: the bundle's v1.4.1 stripped
to their positions, faces and face sets; see THIRD-PARTY-NOTICES.md), so it needs no install.

The bundle's stylised bodies are drawn characters: a big skull with eye sockets, a short nose, simple
hands with five fingers: a base for a drawn character, which a realistic adult head smoothed
down never reads as. They come unrigged, in an
A-pose, with sculpt face sets that cut the body where it bends (upper arm, forearm, each phalanx,
thigh, shin, foot). The joints are read off those cuts: a joint is the centre of the loop between
two face sets. The body is then bound to an armature of the standard joints' names with automatic
weights, and character() conforms it as it conforms any rigged body.

The face sets are the asset's own data at the pinned version (v1.4.1): SETS names them once.
"""
import os

import bpy
import numpy as np
from mathutils import Matrix, Vector

from .protocol import Refused

LICENCE = "CC0 1.0 (Blender Studio Human Base Meshes)"
OBJECTS = {"male": "GEO-body_male_stylized", "female": "GEO-body_female_stylized"}
BODIES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bodies", "stylised.blend")

# Face sets by what they cover (.sculpt_face_set), the same on both bodies.
SETS = {
    "skull": 44, "lids": 27, "socket": 28, "inner": 37, "ears": 29, "nose": 45, "lip_top": 47, "lip_low": 48,
    "jaw": 46, "mouth": 49, "neck": 6, "chest": 259, "shoulder": 260, "upperarm": 263, "lowerarm": 262,
    "palm": 273, "hips": 258, "thigh": 256, "shin": 257, "ankle": 288, "foot": 316, "ball": 317,
}
FINGERS = {"thumb": (359, 285, 284), "index": (278, 283, 282), "middle": (277, 279, 272), "ring": (280, 274, 275), "pinky": (281, 286, 276)}
# The face moves as one piece with the head: features placed on it must not slide on it.
RIGID_HEAD = ("skull", "lids", "socket", "inner", "ears", "nose", "lip_top", "lip_low", "mouth")
PARENTS = {
    "pelvis": "root", "spine_01": "pelvis", "spine_02": "spine_01", "spine_03": "spine_02", "neck_01": "spine_03", "Head": "neck_01",
    "clavicle": "spine_03", "upperarm": "clavicle", "lowerarm": "upperarm", "hand": "lowerarm",
    "thigh": "pelvis", "calf": "thigh", "foot": "calf", "ball": "foot",
}


def _load(path, which):
    name = OBJECTS[which]
    wanted = [name, f"{name}.eye.L", f"{name}.eye.R"]
    try:
        with bpy.data.libraries.load(path, link=False) as (src, dst):
            missing = [n for n in wanted if n not in src.objects]
            if not missing:
                dst.objects = wanted
    except OSError as error:
        raise Refused("invalid-input", f"could not read the base meshes at {path}: {error}")
    if missing:
        raise Refused("invalid-input", f"{path} has no {', '.join(missing)}: it is not Human Base Meshes v1.4.1")
    objs = list(dst.objects)
    for o in objs:
        bpy.context.scene.collection.objects.link(o)
        o.asset_clear()
        if o.data.users > 1:  # the two eyes are one mesh, placed twice
            o.data = o.data.copy()
    bpy.context.view_layer.update()  # a loaded object's world matrix is not known before this
    for o in objs:
        mw = o.matrix_world.copy()
        o.parent = None
        o.data.transform(mw)
        o.matrix_world = Matrix()
        if mw.determinant() < 0:
            o.data.flip_normals()
    return objs


def _loops(me, co, sets):
    """{(set a, set b): vertex indices on the edges between them}, a < b."""
    corner = np.empty(len(me.loops), np.int64)
    me.loops.foreach_get("vertex_index", corner)
    start = np.empty(len(me.polygons), np.int64)
    total = np.empty(len(me.polygons), np.int64)
    me.polygons.foreach_get("loop_start", start)
    me.polygons.foreach_get("loop_total", total)
    seen, out = {}, {}
    for p in range(len(start)):
        vs = corner[start[p]:start[p] + total[p]]
        for a, b in zip(vs, np.roll(vs, -1)):
            key = (int(min(a, b)), int(max(a, b)))
            other = seen.setdefault(key, sets[p])
            if other != sets[p]:
                out.setdefault((int(min(other, sets[p])), int(max(other, sets[p]))), set()).update(key)
    return out


def _joints(me, co, sets):
    """The standard joints of the body, in world metres, from where its face sets meet."""
    loops = _loops(me, co, sets)
    S = SETS

    def ring(a, b, side=0):
        idx = np.array(sorted(loops.get((min(a, b), max(a, b)), ())), np.int64)
        pts = co[idx] if len(idx) else np.zeros((0, 3))
        if side:
            pts = pts[pts[:, 0] * side > 0]
        if len(pts) < 3:
            raise Refused("invalid-input", f"the base mesh's face sets {a} and {b} do not meet: it is not Human Base Meshes v1.4.1")
        return pts

    j = {}
    neck = ring(S["neck"], S["chest"]).mean(axis=0)
    head = np.concatenate([ring(S["neck"], S["skull"]), ring(S["neck"], S["jaw"])]).mean(axis=0)
    hips = {}
    for side, s in ((1, "l"), (-1, "r")):
        groin = ring(S["thigh"], S["hips"], side)
        c = groin.mean(axis=0)
        # The loop runs from the crotch up over the hip: the joint is in its upper half.
        hips[s] = np.array([c[0], c[1], c[2] + 0.35 * (groin[:, 2].max() - c[2])])
        j[f"thigh_{s}"] = hips[s]
        j[f"calf_{s}"] = ring(S["thigh"], S["shin"], side).mean(axis=0)
        ankle = np.concatenate([ring(S["shin"], S["ankle"], side), ring(S["ankle"], S["foot"], side)])
        j[f"foot_{s}"] = ankle.mean(axis=0)
        ball = ring(S["foot"], S["ball"], side).mean(axis=0)
        j[f"ball_{s}"] = np.array([ball[0], ball[1], ball[2] * 0.6])
        cap_in, cap_out = ring(S["chest"], S["shoulder"], side).mean(axis=0), ring(S["shoulder"], S["upperarm"], side).mean(axis=0)
        j[f"upperarm_{s}"] = cap_in * 0.45 + cap_out * 0.55
        j[f"lowerarm_{s}"] = ring(S["upperarm"], S["lowerarm"], side).mean(axis=0)
        j[f"hand_{s}"] = ring(S["lowerarm"], S["palm"], side).mean(axis=0)
        for finger, (a, b, c3) in FINGERS.items():
            j[f"{finger}_01_{s}"] = ring(S["palm"], a, side).mean(axis=0)
            j[f"{finger}_02_{s}"] = ring(a, b, side).mean(axis=0)
            j[f"{finger}_03_{s}"] = ring(b, c3, side).mean(axis=0)
    pelvis = (hips["l"] + hips["r"]) / 2
    pelvis[0] = 0.0
    neck[0] = head[0] = 0.0
    j["pelvis"], j["neck_01"], j["Head"] = pelvis, neck, head
    # The spine runs up the back third of the trunk, in the standard skeleton's own shares.
    for name, t in (("spine_01", 0.235), ("spine_02", 0.45), ("spine_03", 0.697)):
        j[name] = pelvis + (neck - pelvis) * t
    for side, s in ((1, "l"), (-1, "r")):
        j[f"clavicle_{s}"] = np.array([side * 0.1 * abs(j[f"upperarm_{s}"][0]), neck[1] - 0.04, j["spine_03"][2] + 0.82 * (neck[2] - j["spine_03"][2])])
    return j


def _parent(name):
    stem, side = (name[:-2], name[-2:]) if name.endswith(("_l", "_r")) else (name, "")
    if stem in PARENTS:
        p = PARENTS[stem]
        return p + side if p in ("clavicle", "upperarm", "lowerarm", "hand", "thigh", "calf", "foot") else p
    finger, n = stem.rsplit("_", 1)
    return f"hand{side}" if n == "01" else f"{finger}_{int(n) - 1:02d}{side}"


def _armature(name, joints, tips):
    ad = bpy.data.armatures.new(name)
    arm = bpy.data.objects.new(name, ad)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    eb = ad.edit_bones
    root = eb.new("root")
    root.head, root.tail = (0, 0, 0), (0, 0, 0.1)
    todo = [n for n in joints]
    made = {"root": root}
    while todo:
        n = next(x for x in todo if _parent(x) in made)
        todo.remove(n)
        b = eb.new(n)
        b.head = Vector(joints[n])
        b.tail = b.head + Vector((0, 0, 0.05))
        b.parent = made[_parent(n)]
        made[n] = b
    for n, b in made.items():
        if n == "root":
            continue
        kids = [c for c in b.children]
        want = next((c for c in kids if c.name.startswith(("spine", "neck", "Head", "middle_01", "calf", "foot", "ball", "lowerarm", "hand"))), kids[0] if kids else None)
        end = Vector(tips[n]) if n in tips else (want.head.copy() if want is not None else b.head + (b.head - b.parent.head) * 0.5)
        if (end - b.head).length > 1e-4:
            b.tail = end
    bpy.ops.object.mode_set(mode="OBJECT")
    ad.bones["root"].use_deform = False
    return arm


def _smooth_weights(o, rounds, keep):
    """Weights averaged over neighbours, rounds times; vertices in keep hold theirs."""
    me = o.data
    n, groups = len(me.vertices), list(o.vertex_groups)
    w = np.zeros((n, len(groups)))
    for v in me.vertices:
        for e in v.groups:
            w[v.index, e.group] = e.weight
    edges = np.empty(len(me.edges) * 2, np.int64)
    me.edges.foreach_get("vertices", edges)
    a, b = edges[0::2], edges[1::2]
    count = np.bincount(np.concatenate([a, b]), minlength=n)[:, None]
    held = w[keep].copy()
    for _ in range(rounds):
        near = np.zeros_like(w)
        np.add.at(near, a, w[b])
        np.add.at(near, b, w[a])
        w = (w + near) / (1 + count)
        w[keep] = held
    w /= np.maximum(w.sum(axis=1, keepdims=True), 1e-9)
    for vg in groups:
        vg.remove(list(range(n)))
    for k, vg in enumerate(groups):
        for i in np.nonzero(w[:, k] > 2e-3)[0]:
            vg.add([int(i)], float(w[i, k]), "REPLACE")


def body(gender=0.5, path=BODIES):
    """(rig, [mesh], name map): the stylised body for gender (0 female .. 1 male), standing at the
    origin facing -Y, bound to a rig of the standard joints' names in its own A-pose, its eye sockets
    and lips marked for the face kit as an MPFB2 body's are."""
    from . import helpers, skeleton
    from .character import EYES, LIPS

    skeleton.object_mode()
    mesh, eye_l, eye_r = _load(path, "male" if float(gender) >= 0.5 else "female")
    me = mesh.data
    centres = [np.array([v.co for v in e.data.vertices]) for e in (eye_l, eye_r)]
    mid = float((centres[0].mean(axis=0)[0] + centres[1].mean(axis=0)[0]) / 2)
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    shift = Vector((-mid, 0.0, -float(co[:, 2].min())))
    for o in (mesh, eye_l, eye_r):
        o.data.transform(Matrix.Translation(shift))
    co = co + np.array(shift)
    sets = np.empty(len(me.polygons), np.int32)
    me.attributes[".sculpt_face_set"].data.foreach_get("value", sets)
    joints = _joints(me, co, sets)
    # Finger tips and toes: the far end of each last phalanx, so its bone has a length to weight by.
    corner = np.empty(len(me.loops), np.int64)
    me.loops.foreach_get("vertex_index", corner)
    poly_of = np.repeat(np.arange(len(me.polygons)), [p.loop_total for p in me.polygons])
    vert_sets = {}
    for s in set(sets.tolist()):
        vert_sets[s] = np.unique(corner[np.isin(poly_of, np.nonzero(sets == s)[0])])
    tips = {}
    for side, s in ((1, "l"), (-1, "r")):
        for finger, (_, b, c3) in FINGERS.items():
            pts = co[vert_sets[c3]]
            pts = pts[pts[:, 0] * side > 0]
            base, mid_j = joints[f"{finger}_03_{s}"], joints[f"{finger}_02_{s}"]
            d = (base - mid_j) / max(1e-9, np.linalg.norm(base - mid_j))
            tips[f"{finger}_03_{s}"] = base + d * float(((pts - base) @ d).max())
        toes = co[vert_sets[SETS["ball"]]]
        toes = toes[toes[:, 0] * side > 0]
        tips[f"ball_{s}"] = np.array([joints[f"ball_{s}"][0], float(toes[:, 1].min()), joints[f"ball_{s}"][2]])
        tips[f"Head"] = joints["Head"] + np.array([0, 0, 0.6 * (co[:, 2].max() - joints["Head"][2])])
    arm = _armature("studio_rig", joints, tips)
    for p in me.polygons:
        p.use_smooth = True
    helpers.bind(mesh, arm)
    rigid = np.unique(np.concatenate([vert_sets[SETS[k]] for k in RIGID_HEAD]))
    for vg in mesh.vertex_groups:
        vg.remove(rigid.tolist())
    mesh.vertex_groups["Head"].add(rigid.tolist(), 1.0, "REPLACE")
    keep = np.zeros(len(me.vertices), bool)
    keep[rigid] = True
    _smooth_weights(mesh, 2, keep)
    lips = mesh.vertex_groups.new(name=LIPS)
    lips.add(np.unique(np.concatenate([vert_sets[SETS["lip_top"]], vert_sets[SETS["lip_low"]]])).tolist(), 1.0, "REPLACE")
    # The eyes come as their own spheres in the sockets: joined in as marked helper geometry, which
    # character.take_landmarks reads and removes, as it does an MPFB2 body's.
    n0 = len(me.vertices)
    counts = [len(eye_l.data.vertices), len(eye_r.data.vertices)]
    with bpy.context.temp_override(active_object=mesh, object=mesh, selected_objects=[mesh, eye_l, eye_r], selected_editable_objects=[mesh, eye_l, eye_r]):
        bpy.ops.object.join()
    start = n0
    for key, count in zip(("l", "r"), counts):
        idx = list(range(start, start + count))
        mesh.vertex_groups.new(name=EYES[key]).add(idx, 1.0, "REPLACE")
        mesh.vertex_groups["Head"].add(idx, 1.0, "REPLACE")
        start += count
    for a in [a for a in mesh.data.attributes if a.name in (".sculpt_face_set", ".sculpt_mask", "crease_edge")]:
        mesh.data.attributes.remove(a)
    mesh.data.materials.clear()
    return arm, [mesh], {}
