"""A made character's face: face() builds one in its body's style, and face_of() reads how it
blinks off the armature for the sidecar.

face(): eyes, brows and a mouth that belong to the style the body was made in (realistic, heroic,
cartoon, chibi), placed from the body's own landmarks (an MPFB2 body brings its eye sockets and
lips; any other body names where its eyes are). Left to model by hand each time, a face came out
as dots on whatever head the body had.

face_of(): how a made character blinks.

Bones only, never morph targets: they survive compression and every engine plays them the same.
The eye helpers (helpers.eye_lid, helpers.eye_squash) name the bones, and the name is the record
(the export writes no custom properties): blink_lid_<side> turns a lid shut, blink_eye_<side>
squashes a painted eye, blink_shine_<side> hides its highlights. How a lid closes is measured,
never assumed, here on whatever scene holds the armature (the live one, or the candidate GLB
imported for the measure), so the sidecar describes the bytes that ship.

A bone's axes are its own (Blender's bone frame, which the glTF node keeps both ways), so an engine
turns the bone's local rotation by the same axis and angle."""
import math

import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

KINDS = {"lid": "turn", "eye": "squash", "shine": "hide"}
SQUASHED = 0.1  # the scale a painted eye keeps along the face's up axis, shut
FULL = 0.98     # the share of the eye's rays a shut lid must stop
STEP = 5        # degrees between the turns tried


def _weighted(arm, bone):
    """World rest positions of the vertices bound wholly to bone, and the polygons among them."""
    from . import helpers

    points, polys = [], []
    for o in bpy.context.scene.objects:
        if o.type != "MESH" or arm not in helpers._deforming(o):
            continue
        group = o.vertex_groups.get(bone)
        if group is None:
            continue
        co, faces = helpers.rest_coords(o)
        if len(co) != len(o.data.vertices):
            continue
        mine = {}
        for v in o.data.vertices:
            for g in v.groups:
                if g.group == group.index and g.weight >= 0.99:
                    mine[v.index] = len(points) + len(mine)
        if not mine:
            continue
        base = len(points)
        order = sorted(mine)
        index = {v: base + i for i, v in enumerate(order)}
        points += [Vector(co[v]) for v in order]
        polys += [tuple(index[v] for v in f) for f in faces if all(v in index for v in f)]
    return points, polys


def _frame(arm, bone):
    m = arm.matrix_world @ arm.data.bones[bone].matrix_local
    r = m.to_3x3().normalized()
    return m.translation.copy(), [r.col[i].copy() for i in range(3)]


def lid_turn(arm, bone):
    """(axis, radians) that shut the lid on bone over its eye, or None when no turn about the
    bone's x or z does. The eye looks along the bone (its y): rays from in front of it, over a
    disk as wide as the lid's inside, must hit the turned lid. Of the turns that stop the most,
    the middle of the run is the one kept (the lid centred on the eye), the shorter way round."""
    points, polys = _weighted(arm, bone)
    if len(points) < 4 or not polys:
        return None
    centre, axes = _frame(arm, bone)
    look = axes[1]
    inner = min((p - centre).length for p in points)
    if inner <= 1e-6:
        return None
    tree = BVHTree.FromPolygons(points, polys)
    rays = []
    for i in range(-4, 5):
        for j in range(-4, 5):
            u, v = i / 4 * 0.8 * inner, j / 4 * 0.8 * inner
            if u * u + v * v <= (0.8 * inner) ** 2:
                rays.append(centre + look * 3 * inner + axes[0] * u + axes[2] * v)
    best = None
    for name, axis in (("x", axes[0]), ("z", axes[2])):
        for sign in (1, -1):
            cover = []
            for deg in range(STEP, 181, STEP):
                # The lid turned by +a is the rays turned by -a about the eye's centre.
                q = Matrix.Rotation(-math.radians(sign * deg), 3, axis)
                d = q @ -look
                hits = sum(1 for o in rays if tree.ray_cast(centre + q @ (o - centre), d, 3 * inner)[0] is not None)
                cover.append(hits / len(rays))
            top = max(cover)
            if top < FULL:
                continue
            first = cover.index(top)
            last = first
            while last + 1 < len(cover) and cover[last + 1] >= top:
                last += 1
            deg = STEP * (first + last + 2) / 2
            if best is None or (top, -deg) > (best[0], -best[2]):
                best = (top, name, deg, sign)
    if best is None:
        return None
    return best[1], round(best[3] * math.radians(best[2]), 4)


def squash_axis(arm, bone):
    """The bone's own axis that runs nearest the face's up (world up at rest)."""
    _, axes = _frame(arm, bone)
    return "xyz"[max(range(3), key=lambda i: abs(axes[i].z))]


def blink_of(arm, bone):
    """The GameModelBlink of one blink_ bone, or None (a lid that never shuts)."""
    kind = KINDS.get(bone.split("_")[1] if bone.count("_") >= 2 else "")
    if kind == "turn":
        turn = lid_turn(arm, bone)
        return None if turn is None else {"bone": bone, "kind": "turn", "axis": turn[0], "amount": turn[1]}
    if kind == "squash":
        return {"bone": bone, "kind": "squash", "axis": squash_axis(arm, bone), "amount": SQUASHED}
    if kind == "hide":
        return {"bone": bone, "kind": "hide", "axis": "x", "amount": 0.0}
    return None


def face_of(arm):
    blinks = [b for b in (blink_of(arm, bone.name) for bone in arm.data.bones if bone.name.startswith("blink_")) if b is not None]
    return {"blink": blinks[:8]} if blinks else None


# ---- face(): a face in the body's style ----------------------------------------------------------
# eye: the eyeball's radius over the socket's, how far its front stands proud of the socket (in
# socket radii; 0 sits in it), its depth and height over that radius, the iris' share of its width
# and the pupil's of the iris; lid: how far open a turning lid rests, degrees (a round eye), or
# None for a squash (a painted one). brow: thickness, length and lift in socket radii, the inner end's drop in degrees,
# and the arch. mouth: the body's own lips tinted, or a drawn smile that wide (of the lips' width).
# soften: how far the head's sculpted features are smoothed away, so drawn eyes sit on a drawn head.
STYLES = {
    "realistic": dict(eye=1.0, proud=0.0, flat=1.0, tall=1.0, iris=0.5, pupil=0.42, lid=150.0, brow=(0.34, 2.6, 1.3, 5.0, 0.14), mouth=None, soften=0.0),
    "heroic": dict(eye=1.0, proud=0.0, flat=1.0, tall=1.0, iris=0.48, pupil=0.4, lid=146.0, brow=(0.5, 2.8, 1.15, 14.0, 0.05), mouth=None, soften=0.0),
    "cartoon": dict(eye=1.45, proud=1.4, flat=0.7, tall=1.1, iris=0.62, pupil=0.5, lid=None, brow=(0.6, 2.5, 2.1, -5.0, 0.3), mouth=0.95, soften=0.7),
    "chibi": dict(eye=1.6, proud=1.45, flat=0.45, tall=1.3, iris=0.76, pupil=0.55, lid=None, brow=(0.3, 1.8, 2.5, -8.0, 0.25), mouth=0.5, soften=1.0),
}
# On a drawn body (studio.py) the head already has the style's skull and sockets: the eyes sit in
# them and turn their lids shut, nothing is smoothed away, and its own lips stay.
DRAWN = {
    "cartoon": dict(eye=1.0, proud=0.0, flat=1.0, tall=1.0, iris=0.6, pupil=0.5, lid=180.0, brow=(0.3, 1.5, 1.05, -4.0, 0.2), mouth="own", soften=0.0),
    "chibi": dict(eye=1.0, proud=0.0, flat=1.0, tall=1.0, iris=0.68, pupil=0.55, lid=180.0, brow=(0.22, 1.2, 1.1, -6.0, 0.18), mouth="own", soften=0.0),
}
LANDMARKS = "kurambit_face"
BASE = "kurambit_base"
STYLE = "kurambit_style"
EYES = {"l": "face_eye_l", "r": "face_eye_r"}
LIPS = "face_lips"


def style_of(arm, style=None):
    """The face table for arm's style on the body it was made from."""
    style = style or arm.get(STYLE) or "realistic"
    if style not in STYLES:
        raise ValueError(f"face style {style!r}: one of {', '.join(STYLES)}")
    return DRAWN[style] if arm.get(BASE) == "studio" and style in DRAWN else STYLES[style]


def take_landmarks(arm, meshes):
    """Reads a body's face off its marked vertices at rest (an MPFB2 body's eye helpers and lips),
    keeps it on the armature and removes the eye helpers: {eye_l, eye_r: [x, y, z, radius], mouth:
    [x, y, z, width]} in world metres."""
    import bmesh
    import json

    from . import helpers

    found = {}
    for o in meshes:
        co, _ = helpers.rest_coords(o)
        if len(co) != len(o.data.vertices):
            continue
        gone = set()
        for key, name in (*EYES.items(), ("mouth", LIPS)):
            g = o.vertex_groups.get(name)
            if g is None:
                continue
            idx = [v.index for v in o.data.vertices if any(e.group == g.index and e.weight > 0.5 for e in v.groups)]
            if not idx:
                continue
            pts = co[idx]
            lo, hi = pts.min(axis=0), pts.max(axis=0)
            c = (lo + hi) / 2
            if key == "mouth":
                found["mouth"] = [float(c[0]), float(lo[1]), float(c[2]), float(hi[0] - lo[0])]
            else:
                found[f"eye_{key}"] = [*map(float, c), float(max(hi - lo)) / 2]
                gone |= set(idx)
                o.vertex_groups.remove(g)
        if gone:
            bm = bmesh.new()
            bm.from_mesh(o.data)
            bm.verts.ensure_lookup_table()
            bmesh.ops.delete(bm, geom=[bm.verts[i] for i in gone], context="VERTS")
            bm.to_mesh(o.data)
            bm.free()
    if found:
        arm[LANDMARKS] = json.dumps(found)
    return found


def soften(arm, meshes, amount):
    """Smooths the face's sculpted features (lids, the brow ridge, the nose's wings) by amount
    (0..1): a drawn eye on a sculpted adult face reads as a sticker. Only the front of the head
    moves, fading out toward the ears, and the lips keep their shape so the mouth stays shut."""
    import bmesh

    rounds = int(round(36 * amount))
    if rounds <= 0:
        return
    for o in meshes:
        g = o.vertex_groups.get("Head")
        if g is None:
            continue
        lips = o.vertex_groups.get(LIPS)
        bm = bmesh.new()
        bm.from_mesh(o.data)
        layer = bm.verts.layers.deform.active
        if layer is None:
            bm.free()
            continue
        head = [v for v in bm.verts if v[layer].get(g.index, 0.0) > 0.98]
        if len(head) > 8:
            ys = [v.co.y for v in head]
            front, back = min(ys), max(ys)
            mid = front + (back - front) * 0.45
            was = {v: v.co.copy() for v in head}
            for _ in range(rounds):
                bmesh.ops.smooth_vert(bm, verts=head, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
            mouth = [v for v in head if lips is not None and v[layer].get(lips.index, 0.0) > 0.5]
            # The lips go back with the face around them as one piece, never each vertex its own way.
            sink = sum((v.co - was[v] for v in mouth), Vector()) / len(mouth) if mouth else Vector()
            for v in mouth:
                v.co = was[v] + sink
            for v in set(head) - set(mouth):
                t = max(0.0, min(1.0, (mid - was[v].y) / max(1e-9, (mid - front) * 0.5)))
                v.co = was[v].lerp(v.co, t * t * (3 - 2 * t))
            bm.to_mesh(o.data)
            o.data.update()
        bm.free()


def _made(name, verts, faces, materials, face_material=None):
    import bmesh

    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    for m in materials:
        me.materials.append(m)
    if face_material is not None:
        me.polygons.foreach_set("material_index", face_material)
    me.shade_smooth()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def _eyeball(name, centre, radius, look, st, mats):
    """An eye turned about its look: pupil, iris and white as rings of one ellipsoid."""
    import math

    d = Vector(look).normalized()
    up = Vector((0, 0, 1))
    up = (up - d * up.dot(d)).normalized()
    side = d.cross(up)
    iris = math.asin(min(0.98, st["iris"]))
    pupil = math.asin(min(0.98, st["iris"] * st["pupil"]))
    polar = [0.0, pupil * 0.5, pupil, pupil + (iris - pupil) * 0.5, iris] + [iris + (math.pi * 0.62 - iris) * i / 5 for i in range(1, 6)]
    band = [2, 2, 1, 1] + [0] * 5  # pupil, iris, white
    segs = 20
    verts, faces, index = [centre + d * radius * st["flat"]], [], []
    for a in polar[1:]:
        for j in range(segs):
            az = 2 * math.pi * j / segs
            verts.append(centre + d * (math.cos(a) * radius * st["flat"]) + side * (math.sin(a) * math.cos(az) * radius) + up * (math.sin(a) * math.sin(az) * radius * st["tall"]))
    for j in range(segs):
        faces.append((0, 1 + j, 1 + (j + 1) % segs))
        index.append(band[0])
    for i in range(len(polar) - 2):
        for j in range(segs):
            a, b = 1 + i * segs + j, 1 + i * segs + (j + 1) % segs
            faces.append((a, a + segs, b + segs, b))
            index.append(band[i + 1])
    return _made(name, verts, faces, mats, index), d, up, side


def _on_skin(skin, point, look, lift, deep=0.05):
    """point moved along the look onto the skin, lift metres proud of it; itself when nothing is
    hit, or when the skin there is more than deep behind it (between parted lips, a nostril)."""
    from . import helpers

    hit = helpers.surface_hit(skin, Vector(point) + Vector(look) * 0.3, -Vector(look), 0.6)
    if hit is None or (Vector(point) - hit[0]).dot(Vector(look)) > deep:
        return Vector(point) + Vector(look) * lift
    return hit[0] + Vector(look) * lift


def _strip(name, skin, points, look, half, thick, mat):
    """A band along points (each (centre, half height)), laid on the skin and thick proud of it."""
    up = Vector((0, 0, 1))
    verts, faces = [], []
    n = len(points)
    for c, h in points:
        for dz, lift in ((-h, 0.0), (-h * 0.6, thick), (h * 0.6, thick), (h, 0.0)):
            verts.append(_on_skin(skin, Vector(c) + up * dz, look, 0.0006 + lift))
    for i in range(n - 1):
        for k in range(3):
            a = i * 4 + k
            faces.append((a, a + 1, a + 5, a + 4))
    return _made(name, verts, faces, [mat])


def face(armature, *, style=None, iris="#4f7396", brows="#3a2a20", lips="#b4645c", white="#f3efe6", skin=None,
         eyes=None, eye_radius=None, mouth=None, look=(0, -1, 0)):
    """A face on armature's head in its body's style (the preset op character made it in, or
    style): two eyes with an iris, a pupil and a highlight that blink in the game, brows, and a
    mouth (the body's own lips tinted, or a drawn smile on a softened head). Colours are hex.
    An MPFB2 body knows where its face is; for any other, eyes=[(x, y, z) of the left eye's centre
    at rest] with eye_radius, and mouth=(x, y, z). skin: the lids' material (default the body's).
    Returns {"parts": [...], "blinks": [...]}."""
    import json
    import math

    from . import helpers

    arm = bpy.data.objects[armature] if isinstance(armature, str) else armature
    style = style or arm.get(STYLE) or "realistic"
    st = style_of(arm, style)
    marks = json.loads(arm.get(LANDMARKS, "{}") or "{}")
    if eyes is not None:
        x, y, z = eyes[0] if isinstance(eyes[0], (list, tuple)) else eyes
        r = float(eye_radius or 0.012)
        marks["eye_l"], marks["eye_r"] = [x, y, z, r], [-x, y, z, r]
    if mouth is not None:
        marks["mouth"] = [*mouth, marks.get("mouth", [0, 0, 0, 0.05])[3]]
    if "eye_l" not in marks or "eye_r" not in marks:
        raise ValueError(f"{arm.name}'s body does not say where its eyes are (only an MPFB2 body does): pass eyes=[(x, y, z)] of the left eye's centre at rest, eye_radius= and mouth=(x, y, z)")
    body = [o for o in bpy.data.objects if o.type == "MESH" and arm in helpers._deforming(o) and '"body"' in str(o.get("kurambit_source", ""))]
    skin = skin or next((s.material for o in body for s in o.material_slots if s.material is not None), None) or helpers.material("#d9a17c", name="Skin")
    mats = [helpers.material(white, name="Eye white", roughness=0.25), helpers.material(iris, name="Iris", roughness=0.25),
            helpers.material("#111114", name="Pupil", roughness=0.25)]
    shine = helpers.material("#ffffff", name="Eye shine", roughness=0.25)
    brow_mat = helpers.material(brows, name="Brows")
    d = Vector(look).normalized()
    parts, blinks = [], []
    for sgn, key in ((1, "l"), (-1, "r")):
        x, y, z, r = marks[f"eye_{key}"]
        socket = Vector((x, y, z))
        radius = r * st["eye"]
        # A socket-sized eye sits in its socket; a bigger one stands out of the softened face.
        centre = socket if st["proud"] <= 0 else socket + d * (r * st["proud"] - radius * st["flat"])
        eye, _, up, side = _eyeball(f"{arm.name}_eye_{key}", centre, radius, d, st, mats)
        front = centre + d * radius * st["flat"]
        glint = radius * 0.2
        dot = _made(f"{arm.name}_shine_{key}", *_blob(front + side * (radius * st["iris"] * 0.4) + up * (radius * st["tall"] * st["iris"] * 0.4) - d * glint * 0.75, glint), [shine])
        if st["lid"] is not None:
            helpers.skin_rigid(dot, "Head", armature=arm)
            blinks.append(helpers.eye_lid(eye, key, armature=arm, look=tuple(d), open_deg=st["lid"], material=skin))
            parts += [eye.name, dot.name, f"lid_{key}"]
        else:
            blinks += helpers.eye_squash(eye, key, shine=[dot], armature=arm, look=tuple(d))
            parts += [eye.name, dot.name]
        thick, length, lift, drop, arch = st["brow"]
        tilt = math.radians(drop)
        pts = []
        for i in range(9):
            t = i / 8 * 2 - 1  # inner end to outer end
            across = t * length * r / 2
            rise = lift * r + arch * r * (1 - t * t) - math.sin(tilt) * (1 - t) / 2 * length * r / 2
            pts.append((socket + Vector((sgn * (across + 0.15 * r), 0, rise)), thick * r * (0.55 + 0.45 * (1 - t * t)) / 2 * (1.15 if t < 0 else 0.85)))
        brow = _strip(f"{arm.name}_brow_{key}", body, pts, d, None, thick * r * 0.35, brow_mat)
        helpers.skin_rigid(brow, "Head", armature=arm)
        parts.append(brow.name)
    if "mouth" in marks and lips:
        mx, my, mz, width = marks["mouth"]
        if st["mouth"] == "own":
            pass  # a drawn head's lips are its skin's colour
        elif st["mouth"] is None:
            # Lips are the skin's own colour a little redder: the full tint reads as lipstick.
            tint = helpers.material(_mix(_hex_of(skin), lips, LIP_TINT), name="Lips")
            for o in body:
                g = o.vertex_groups.get(LIPS)
                if g is None:
                    continue
                inside = {v.index for v in o.data.vertices if any(e.group == g.index and e.weight > 0.5 for e in v.groups)}
                o.data.materials.append(tint)
                slot = len(o.data.materials) - 1
                for p in o.data.polygons:
                    if all(v in inside for v in p.vertices):
                        p.material_index = slot
                parts.append(f"{o.name} (lips tinted)")
        else:
            half = width * st["mouth"] / 2
            pts = []
            for i in range(9):
                t = i / 8 * 2 - 1
                pts.append((Vector((mx + t * half, my, mz + half * 0.34 * (t * t - 0.45))), max(0.0015, half * 0.13 * (1 - 0.7 * t * t))))
            smile = _strip(f"{arm.name}_mouth", body, pts, d, None, 0.0008, helpers.material("#5c2b2b", name="Mouth"))
            helpers.skin_rigid(smile, "Head", armature=arm)
            parts.append(smile.name)
    return {"style": style, "parts": parts, "blinks": blinks}


LIP_TINT = 0.45


def _hex_of(material):
    """A material's base colour as hex (sRGB), as helpers.material set it."""
    bsdf = next((n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None) if material.node_tree else None
    c = bsdf.inputs["Base Color"].default_value[:3] if bsdf is not None else material.diffuse_color[:3]
    to_srgb = lambda v: 12.92 * v if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055
    return "#" + "".join(f"{max(0, min(255, round(to_srgb(v) * 255))):02x}" for v in c)


def _mix(a, b, t):
    a, b = a.lstrip("#"), b.lstrip("#")
    return "#" + "".join(f"{round(int(a[i:i + 2], 16) * (1 - t) + int(b[i:i + 2], 16) * t):02x}" for i in (0, 2, 4))


def _blob(centre, radius, rings=5, segs=10):
    import math

    verts, faces = [], []
    for i in range(1, rings):
        a = math.pi * i / rings
        for j in range(segs):
            b = 2 * math.pi * j / segs
            verts.append(Vector(centre) + Vector((math.sin(a) * math.cos(b), math.cos(a), math.sin(a) * math.sin(b))) * radius)
    top, bottom = len(verts), len(verts) + 1
    verts += [Vector(centre) + Vector((0, radius, 0)), Vector(centre) - Vector((0, radius, 0))]
    for i in range(rings - 2):
        for j in range(segs):
            a, b = i * segs + j, i * segs + (j + 1) % segs
            faces.append((a, b, b + segs, a + segs))
    for j in range(segs):
        faces.append((top, (j + 1) % segs, j))
        faces.append((bottom, (rings - 2) * segs + j, (rings - 2) * segs + (j + 1) % segs))
    return verts, faces
