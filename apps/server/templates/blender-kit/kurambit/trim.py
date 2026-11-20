"""trim(): the gear and trim a designed character carries, one call each, fitted to what it wears.

A body in a plain coat is not a character. What makes a ranger read as a ranger is on top of the
clothes: a belt with a buckle, a strap across the chest, a pouch, a collar, buttons, shoulder
pieces, a cape, a scabbard. Each of these is measured off the character as it is dressed now (the
body and every garment on it, at rest), so it sits on the coat and not inside it, and is bound to
the joints under it.

Space: the character at rest, facing -Y, +X its left, metres.
"""
import json
import math

import bpy
import numpy as np
from mathutils import Vector

from . import cloth, helpers

KINDS = ("belt", "strap", "pouch", "collar", "cuffs", "buttons", "pauldrons", "cape", "scabbard", "bag")
TRUNK = ("pelvis", "spine", "neck", "clavicle")
ROUND = 20


def _worn(arm, prefixes=None):
    """World points at rest of the body and everything dressed on it, with each point's lead bone."""
    from . import deform

    pts, leads = [], []
    for o in [*cloth._bodies(arm), *[o for o in bpy.data.objects if o.get("kurambit_cloth") and arm in helpers._deforming(o)]]:
        co, _ = helpers.rest_coords(o)
        if len(co) != len(o.data.vertices):
            continue
        lead = np.array([l or "" for l in deform._dominant(o, arm)])
        pts.append(co)
        leads.append(lead)
    pts, leads = (np.concatenate(pts), np.concatenate(leads)) if pts else (np.zeros((0, 3)), np.array([]))
    if prefixes is not None and len(pts):
        keep = np.array([name.startswith(tuple(prefixes)) for name in leads], bool)
        pts, leads = pts[keep], leads[keep]
    return pts, leads


def _joint(arm, name, end="head"):
    b = arm.data.bones.get(name)
    if b is None:
        raise ValueError(f"{arm.name} has no {name} joint: hero.trim goes on a body on the standard skeleton")
    return np.array(arm.matrix_world @ (b.head_local if end == "head" else b.tail_local))


def _basis(axis):
    axis = np.asarray(axis, float)
    axis = axis / np.linalg.norm(axis)
    a = np.array([1.0, 0.0, 0.0]) if abs(axis[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
    a = a - axis * (a @ axis)
    a = a / np.linalg.norm(a)
    return axis, a, np.cross(axis, a)


def _section(pts, centre, axis, slab, bins=ROUND):
    """How far the points within slab of the plane through centre reach from it, in bins directions."""
    axis, a, b = _basis(axis)
    d = pts - centre
    near = np.abs(d @ axis) <= slab
    x, y = d[near] @ a, d[near] @ b
    if len(x) < 6:
        raise ValueError("nothing is worn there to put it on")
    k = ((np.arctan2(y, x) % (2 * math.pi)) / (2 * math.pi) * bins).astype(int) % bins
    rad = np.zeros(bins)
    np.maximum.at(rad, k, np.hypot(x, y))
    for _ in range(2):
        rad = np.maximum(rad, (np.roll(rad, 1) + np.roll(rad, -1)) / 2)
    return rad, a, b


def _mesh(name, verts, faces, mat, smooth=True):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(float(x) for x in v) for v in verts], [], faces)
    me.materials.append(mat)
    if smooth:
        me.shade_smooth()
    me.update()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def _band(name, pts, centre, axis, width, thick, mat, gap=0.003, slab=None):
    """A flat band round the worn points in the plane through centre: a belt, a strap, a collar."""
    rad, a, b = _section(pts, centre, axis, slab or max(width, 0.02))
    axis = _basis(axis)[0]
    verts, faces = [], []
    for i in range(ROUND):
        ang = 2 * math.pi * (i + 0.5) / ROUND
        out = a * math.cos(ang) + b * math.sin(ang)
        for r, h in ((gap, -0.5), (gap + thick, -0.5), (gap + thick, 0.5), (gap, 0.5)):
            verts.append(centre + out * (rad[i] + r) + axis * (h * width))
    for i in range(ROUND):
        j = (i + 1) % ROUND
        for k in range(4):
            faces.append((i * 4 + k, j * 4 + k, j * 4 + (k + 1) % 4, i * 4 + (k + 1) % 4))
    o = _mesh(name, verts, faces, mat, smooth=False)
    return o, rad, a, b


def _box(name, centre, x, y, z, size, mat, bevel=0.2):
    """A rounded box at centre with its own axes x, y, z (unit vectors) and size along each."""
    verts = [np.asarray(centre) + np.asarray(x) * (sx * size[0] / 2) + np.asarray(y) * (sy * size[1] / 2) + np.asarray(z) * (sz * size[2] / 2)
             for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    o = _mesh(name, verts, faces, mat, smooth=False)
    if bevel > 0:
        m = o.modifiers.new("bevel", "BEVEL")
        m.width = min(size) * bevel
        m.segments = 2
        with bpy.context.temp_override(object=o, active_object=o):
            bpy.ops.object.modifier_apply(modifier=m.name)
    return o


def _join(parts, name):
    first = parts[0]
    if len(parts) > 1:
        with bpy.context.temp_override(active_object=first, object=first, selected_objects=parts, selected_editable_objects=parts):
            bpy.ops.object.join()
    first.name = name
    return first


def _nearest_trunk(arm, point):
    best = min((b for b in arm.data.bones if b.name.startswith(("pelvis", "spine", "neck"))), key=lambda b: abs((arm.matrix_world @ b.head_local.lerp(b.tail_local, 0.5)).z - point[2]))
    return best.name


def trim(armature, kind, *, colour="#6a4a2c", metal="#c9a44a", name=None, at=None, side="l", size=1.0, count=None, length=None, chains=4):
    """Adds a piece of gear or trim to armature's dressed body (a human on the standard skeleton),
    made round what it wears now, so dress first. kind is one of:
      belt       round the waist (at: its height, m), with a buckle in metal at the front
      strap      across the chest from the side's shoulder to the other hip
      pouch      on the belt line at the side's hip (at: degrees round from the front); bag: larger, behind
      collar     a stand-up band round the neck
      cuffs      a band at each wrist
      buttons    count (default 4) down the front, in metal
      pauldrons  a shoulder piece over each shoulder, rimmed in metal
      cape       from the shoulders down the back to length (a height, m; default the knees), on
                 chains spring chains; clasped in metal at the neck
      scabbard   at the side's hip, slanting back
    colour (hex) is its own, metal its fittings'; size scales it. Returns {"object", "chains", "triangles"}."""
    if kind not in KINDS:
        raise ValueError(f"trim kind {kind!r}: one of {', '.join(KINDS)}")
    arm = bpy.data.objects[armature] if isinstance(armature, str) else armature
    bodies = cloth._bodies(arm)
    if not bodies:
        raise ValueError(f"{arm.name} has no body mesh to put gear on")
    tall = cloth._size(bodies)
    name = name or f"{arm.name}_{kind}"
    label = name.split("_", 1)[-1].capitalize()
    mat = helpers.material(colour, name=label)
    fit = helpers.material(metal, name=f"{label} metal", roughness=0.35)
    sx = 1.0 if side == "l" else -1.0
    posed = arm.data.pose_position
    arm.data.pose_position = "REST"
    bpy.context.view_layer.update()
    made, bind = {}, None
    try:
        trunk, _ = _worn(arm, TRUNK + ("thigh",))
        up = np.array([0.0, 0.0, 1.0])
        if kind == "belt":
            z = float(at) if at is not None else float(_joint(arm, "spine_01")[2] - 0.02 * tall)
            centre = np.array([0.0, float(_joint(arm, "pelvis")[1]), z])
            w = 0.035 * tall * size
            band, rad, a, b = _band(name, trunk, centre, up, w, 0.008 * tall, mat)
            # The buckle: a frame at the front, where the band's own section says the front is.
            front = np.array([0.0, -1.0, 0.0])
            reach = max(rad[i] for i in range(ROUND) if (a * math.cos(2 * math.pi * (i + 0.5) / ROUND) + b * math.sin(2 * math.pi * (i + 0.5) / ROUND)) @ front > 0.9)
            buckle = _box(name + "_buckle", centre + front * (reach + 0.012 * tall), np.array([1.0, 0, 0]), front, up, (w * 1.5, 0.012 * tall, w * 1.45), fit)
            g = _join([band, buckle], name)
            bind = {"pelvis": 0.5, "spine_01": 0.5}
        elif kind == "strap":
            top, low = _joint(arm, f"upperarm_{side}"), _joint(arm, f"thigh_{'r' if side == 'l' else 'l'}")
            top = np.array([top[0] * 0.55, top[1], top[2] + 0.02 * tall])
            low = np.array([low[0] * 1.2, low[1], _joint(arm, "spine_01")[2] - 0.02 * tall])
            line = low - top
            axis = np.cross(line, np.array([0.0, 1.0, 0.0]))
            chest, _ = _worn(arm, ("pelvis", "spine", "clavicle"))
            g, *_ = _band(name, chest, (top + low) / 2, axis, 0.03 * tall * size, 0.007 * tall, mat, slab=0.03 * tall)
            bind = "spine_02"
        elif kind in ("pouch", "bag"):
            big = kind == "bag"
            angle = math.radians(float(at) if at is not None else (150.0 if big else 62.0)) * sx
            z = float(_joint(arm, "spine_01")[2] - (0.07 if big else 0.06) * tall)
            centre = np.array([0.0, float(_joint(arm, "pelvis")[1]), z])
            rad, a, b = _section(trunk, centre, up, 0.03 * tall)
            out = np.array([math.sin(angle), -math.cos(angle), 0.0])
            i = int(np.argmax([(a * math.cos(2 * math.pi * (k + 0.5) / ROUND) + b * math.sin(2 * math.pi * (k + 0.5) / ROUND)) @ out for k in range(ROUND)]))
            s = (0.075 if big else 0.05) * tall * size
            across = np.cross(up, out)
            body = _box(name + "_body", centre + out * (rad[i] + s * 0.32), across, out, up, (s * (1.5 if big else 1.0), s * 0.6, s * 1.15), mat, 0.25)
            flap = _box(name + "_flap", centre + out * (rad[i] + s * 0.36) + up * (s * 0.36), across, out, up, (s * (1.56 if big else 1.06), s * 0.66, s * 0.5), helpers.material(_darker(colour, 0.78), name=f"{label} flap"), 0.25)
            stud = _box(name + "_stud", centre + out * (rad[i] + s * 0.7) + up * (s * 0.16), across, out, up, (s * 0.2, s * 0.08, s * 0.2), fit, 0.3)
            g = _join([body, flap, stud], name)
            bind = "pelvis"
        elif kind == "collar":
            p0, p1 = _joint(arm, "neck_01"), _joint(arm, "Head")
            neck, _ = _worn(arm, ("neck", "spine_03", "clavicle", "Head"))
            centre = p0 + (p1 - p0) * 0.35
            g, *_ = _band(name, neck, centre, p1 - p0, 0.035 * tall * size, 0.007 * tall, mat, gap=0.002 * tall, slab=0.02 * tall)
            bind = "neck_01"
        elif kind == "cuffs":
            parts = []
            for s in ("l", "r"):
                p0, p1 = _joint(arm, f"lowerarm_{s}"), _joint(arm, f"hand_{s}")
                fore, _ = _worn(arm, (f"lowerarm_{s}",))
                c, *_ = _band(f"{name}_{s}", fore, p0 + (p1 - p0) * 0.84, p1 - p0, 0.04 * tall * size, 0.006 * tall, mat, slab=0.02 * tall)
                helpers.skin_rigid(c, f"lowerarm_{s}", armature=arm)
                parts.append(c)
            g = _join(parts, name)
        elif kind == "buttons":
            n = int(count or 4)
            z1, z0 = float(_joint(arm, "neck_01")[2] - 0.06 * tall), float(_joint(arm, "spine_01")[2] + 0.02 * tall)
            front, _ = _worn(arm, ("pelvis", "spine"))
            parts = []
            for k in range(n):
                z = z1 + (z0 - z1) * (k / max(1, n - 1))
                near = front[(np.abs(front[:, 2] - z) < 0.02 * tall) & (np.abs(front[:, 0]) < 0.03 * tall)]
                if not len(near):
                    continue
                y = float(near[:, 1].min())
                r = 0.011 * tall * size
                b = _box(f"{name}_{k}", (0.0, y - r * 0.3, z), (1, 0, 0), (0, -1, 0), (0, 0, 1), (2 * r, r * 0.8, 2 * r), fit, 0.4)
                helpers.skin_rigid(b, _nearest_trunk(arm, (0, y, z)), armature=arm)
                parts.append(b)
            if not parts:
                raise ValueError("no front to put buttons on")
            g = _join(parts, name)
        elif kind == "pauldrons":
            parts = []
            for s, sgn in (("l", 1.0), ("r", -1.0)):
                p = _joint(arm, f"upperarm_{s}")
                arm_pts, _ = _worn(arm, (f"upperarm_{s}", f"clavicle_{s}"))
                near = arm_pts[np.linalg.norm(arm_pts - p, axis=1) < 0.09 * tall]
                r = (float(np.percentile(np.linalg.norm(near - p, axis=1), 90)) if len(near) else 0.05 * tall) * 1.12 * size
                verts, faces = [], []
                rings, seg = 5, 12
                for j in range(rings + 1):
                    phi = (math.pi / 2) * j / rings * 1.15
                    for k in range(seg):
                        th = 2 * math.pi * k / seg
                        verts.append(p + np.array([sgn * 0.012 * tall, 0, 0.01 * tall]) + np.array([sgn * r * 1.05 * math.sin(phi) * max(0.0, math.cos(th)) + r * 0.25 * math.sin(phi) * min(0.0, math.cos(th)) * sgn,
                                                                                                    r * 1.02 * math.sin(phi) * math.sin(th), r * (math.cos(phi) * 0.95)]))
                for j in range(rings):
                    for k in range(seg):
                        faces.append((j * seg + k, (j + 1) * seg + k, (j + 1) * seg + (k + 1) % seg, j * seg + (k + 1) % seg))
                dome = _mesh(f"{name}_{s}", verts, faces, mat)
                index = np.zeros(len(dome.data.polygons), np.int32)
                index[(rings - 1) * seg:] = 1
                dome.data.materials.append(fit)
                dome.data.polygons.foreach_set("material_index", index)
                sol = dome.modifiers.new("thick", "SOLIDIFY")
                sol.thickness = 0.008 * tall
                with bpy.context.temp_override(object=dome, active_object=dome):
                    bpy.ops.object.modifier_apply(modifier=sol.name)
                helpers.skin_rigid(dome, {f"clavicle_{s}": 0.6, f"upperarm_{s}": 0.4}, armature=arm)
                parts.append(dome)
            g = _join(parts, name)
        elif kind == "cape":
            sh_l, sh_r = _joint(arm, "upperarm_l"), _joint(arm, "upperarm_r")
            top_z = float(max(sh_l[2], sh_r[2]) + 0.035 * tall)
            hem_z = float(length) if length is not None else float(_joint(arm, "calf_l")[2])
            # Round the back and the shoulders only, never the arms: wrapped round them it is a box
            # the arms swing in. Behind the shoulder joints, a swinging arm passes beside it.
            back, _ = _worn(arm, ("pelvis", "spine", "clavicle", "thigh", "calf", "neck"))
            centre = np.array([0.0, float(_joint(arm, "spine_02")[1])])
            rows, seg = 12, 15
            half = math.radians(70)
            verts, faces, reach = [], [], np.zeros(seg)
            for j in range(rows):
                t = j / (rows - 1)
                z = top_z - (top_z - hem_z) * t
                here = back[np.abs(back[:, 2] - z) < max(0.02 * tall, (top_z - hem_z) / rows)]
                for k in range(seg):
                    ang = math.pi - half + 2 * half * k / (seg - 1)
                    d = np.array([math.sin(ang), -math.cos(ang)])
                    r = float(((here[:, :2] - centre) @ d).max()) if len(here) else 0.0
                    reach[k] = max(reach[k], r)
                r_row = np.maximum(reach, (np.roll(reach, 1) + np.roll(reach, -1)) / 2)
                r_row[0], r_row[-1] = max(reach[0], reach[1]), max(reach[-1], reach[-2])
                for k in range(seg):
                    ang = math.pi - half + 2 * half * k / (seg - 1)
                    rr = (r_row[k] + 0.012 * tall) * (1 + 0.25 * t)
                    verts.append((centre[0] + rr * math.sin(ang), centre[1] - rr * math.cos(ang), z))
            for j in range(rows - 1):
                for k in range(seg - 1):
                    faces.append((j * seg + k, j * seg + k + 1, (j + 1) * seg + k + 1, (j + 1) * seg + k))
            sheet = _mesh(name, verts, faces, mat)
            made = cloth.dress(sheet, arm, hang=float(min(sh_l[2], sh_r[2]) - 0.05 * tall), chains=int(chains), name=label.lower()[:12])
            sheets = json.loads(arm.get("kurambit_sheets", "[]") or "[]")
            arm["kurambit_sheets"] = json.dumps(sorted(set(sheets) | {bones[0] for bones in made.values()}))
            front = _worn(arm, ("spine_03", "neck", "clavicle"))[0]
            near = front[(np.abs(front[:, 2] - (top_z - 0.03 * tall)) < 0.03 * tall) & (np.abs(front[:, 0]) < 0.04 * tall)]
            y = float(near[:, 1].min()) if len(near) else float(centre[1] - 0.1 * tall)
            clasp = _box(name + "_clasp", (0.0, y - 0.006 * tall, top_z - 0.03 * tall), (1, 0, 0), (0, -1, 0), (0, 0, 1), (0.034 * tall * size, 0.012 * tall, 0.034 * tall * size), fit, 0.35)
            helpers.skin_rigid(clasp, "spine_03", armature=arm)
            g = sheet
            made = {**made}
            g["kurambit_trim_extra"] = clasp.name
        elif kind == "scabbard":
            hip = _joint(arm, f"thigh_{side}")
            z = float(_joint(arm, "spine_01")[2] - 0.05 * tall)
            centre = np.array([0.0, float(_joint(arm, "pelvis")[1]), z])
            rad, a, b = _section(trunk, centre, up, 0.03 * tall)
            out = np.array([sx, 0.0, 0.0])
            i = int(np.argmax([(a * math.cos(2 * math.pi * (k + 0.5) / ROUND) + b * math.sin(2 * math.pi * (k + 0.5) / ROUND)) @ out for k in range(ROUND)]))
            L = (float(length) if length is not None else 0.36 * tall) * size
            along = np.array([0.0, 0.42, -0.9])
            along = along / np.linalg.norm(along)
            start = centre + out * (rad[i] + 0.012 * tall)  # its inner face on the belt line
            wide = np.cross(out, along)
            sheath = _box(name + "_sheath", start + along * (L / 2), wide, out, along, (0.045 * tall, 0.018 * tall, L), mat, 0.3)
            cap = _box(name + "_cap", start + along * (L * 0.96), wide, out, along, (0.05 * tall, 0.022 * tall, L * 0.1), fit, 0.3)
            mouth = _box(name + "_mouth", start + along * (L * 0.04), wide, out, along, (0.052 * tall, 0.024 * tall, L * 0.08), fit, 0.3)
            g = _join([sheath, cap, mouth], name)
            bind = "pelvis"
    finally:
        arm.data.pose_position = posed
    if bind is not None:
        helpers.skin_rigid(g, bind, armature=arm)
    return {"object": g.name, "chains": made, "triangles": sum(len(p.vertices) - 2 for p in g.data.polygons)}


def _darker(hex_colour, k):
    return "#" + "".join(f"{round(int(hex_colour[i:i + 2], 16) * k):02x}" for i in (1, 3, 5))
