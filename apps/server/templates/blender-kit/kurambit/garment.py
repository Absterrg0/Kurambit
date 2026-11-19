"""garment(): a whole piece of clothing made from the body it is for, then dressed.

A garment modelled by hand over a body ends where its maker cut it: a coat cut out of a copy of the
skin ends along the skin's own triangles, a saw-toothed collar, and a skirt lathed about a guessed
centre leaves the thighs outside it. Here a garment is the body's own surface between clean cuts:
each opening (collar, cuff, hem, waist, boot top) is a plane across the limb it goes round, so its
edge is one straight loop; the surface is lifted off the skin and eased; and a part that hangs (a
coat's or a dress's skirt) is lofted round the outline of everything under it, at every height, so
both legs are inside it by construction. Then cloth.dress fits it, turns its edges in, hangs the
skirt on hem chains and leaves the skin under it out of the export.

Space: the character at rest, facing -Y, +X its left, metres.
"""
import math

import bpy
import numpy as np
from mathutils import Vector

from . import cloth, helpers

KINDS = ("top", "trousers", "boots", "gloves", "skirt")
LIFT = "kurambit_lift"
SIDES = ("l", "r")
FINGERS = ("thumb", "index", "middle", "ring", "pinky")


def _bone(arm, name, end="head"):
    b = arm.data.bones.get(name)
    if b is None:
        raise ValueError(f"{arm.name} has no {name} joint: hero.garment dresses a body on the standard skeleton; model any other garment by hand and use hero.dress")
    return np.array(arm.matrix_world @ (b.head_local if end == "head" else b.tail_local))


def _arm_of(s):
    return [f"clavicle_{s}", f"upperarm_{s}", f"lowerarm_{s}", f"hand_{s}"] + [f"{f}_{i:02d}_{s}" for f in FINGERS for i in (1, 2, 3)] + [f"{f}_04_leaf_{s}" for f in FINGERS]


def _leg_of(s):
    return [f"thigh_{s}", f"calf_{s}", f"foot_{s}", f"ball_{s}", f"ball_leaf_{s}"]


TRUNK = ["pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "Head"]


def _along(arm, a, b, t):
    """The point t of the way from joint a to joint b, and the unit direction a to b."""
    pa, pb = _bone(arm, a), _bone(arm, b)
    d = pb - pa
    return pa + d * t, d / max(1e-9, np.linalg.norm(d))


def _plan(arm, kind, size, sleeves, length, collar, top, waist, fork):
    """(the bones whose skin the garment is, [(point, the side kept, the bones the cut runs through)])."""
    cuts, keep = [], []
    up = np.array([0.0, 0.0, 1.0])
    if kind == "top":
        keep = ["pelvis", "spine_01", "spine_02", "spine_03", "neck_01"] + [f"clavicle_{s}" for s in SIDES]
        p, d = _along(arm, "neck_01", "Head", float(collar))
        cuts.append((p, -d, ["neck_01", "Head", "spine_03"]))
        for s in SIDES:
            limb = _arm_of(s)
            if sleeves == "long":
                p, d = _along(arm, f"lowerarm_{s}", f"hand_{s}", 0.9)
                keep += [f"upperarm_{s}", f"lowerarm_{s}"]
            elif sleeves == "short":
                p, d = _along(arm, f"upperarm_{s}", f"lowerarm_{s}", 0.55)
                keep += [f"upperarm_{s}"]
            else:
                p, d = _along(arm, f"upperarm_{s}", f"lowerarm_{s}", 0.1)
                keep += [f"upperarm_{s}"]
            cuts.append((p, -d, limb[1:]))
        # Never below the fork of the legs: cut lower, a top closes under the body like a leotard,
        # and what hangs lower than that is a skirt's to do (hem=).
        z = max(float(length), fork) if length is not None else fork
        cuts.append((np.array([0.0, 0.0, z]), up, ["pelvis", "spine_01", "spine_02"] + _leg_of("l") + _leg_of("r")))
        keep += ["thigh_l", "thigh_r"]
    elif kind == "trousers":
        keep = ["pelvis"]
        z = float(waist) if waist is not None else _bone(arm, "spine_01")[2] + 0.01 * size
        cuts.append((np.array([0.0, 0.0, z]), -up, ["pelvis", "spine_01", "spine_02", "spine_03"]))
        keep += ["spine_01"]
        t = 0.93 if length is None else float(length)
        for s in SIDES:
            if t > 0.5:
                p, d = _along(arm, f"calf_{s}", f"foot_{s}", (t - 0.5) * 2)
                keep += [f"thigh_{s}", f"calf_{s}"]
            else:
                p, d = _along(arm, f"thigh_{s}", f"calf_{s}", t * 2)
                keep += [f"thigh_{s}"]
            cuts.append((p, -d, _leg_of(s)))
    elif kind == "boots":
        t = 0.45 if top is None else float(top)
        for s in SIDES:
            p, d = _along(arm, f"calf_{s}", f"foot_{s}", 1 - t)
            cuts.append((p, d, [f"thigh_{s}", f"calf_{s}"]))
            keep += [f"calf_{s}", f"foot_{s}", f"ball_{s}", f"ball_leaf_{s}"]
    elif kind == "gloves":
        t = 0.2 if top is None else float(top)
        for s in SIDES:
            p, d = _along(arm, f"lowerarm_{s}", f"hand_{s}", 1 - t)
            cuts.append((p, d, [f"upperarm_{s}", f"lowerarm_{s}"]))
            keep += _arm_of(s)[2:]
    return keep, cuts


def _fork(arm, bodies, size):
    """The height the legs part at, a little above it: the lowest the trunk's skin comes on the
    body's centre line."""
    from . import deform

    from . import deform as measure

    low = []
    for body in bodies:
        co, faces = helpers.rest_coords(body)
        if len(co) != len(body.data.vertices):
            continue
        lead = deform._dominant(body, arm)
        normals = measure._vertex_normals(co, faces)
        # Skin on the centre line that faces the ground: the saddle between the legs, not the
        # insides of two thighs that touch.
        mid = (np.abs(co[:, 0]) < 0.012 * size) & (normals[:, 2] < -0.6) & np.array([l is not None and l.startswith(("pelvis", "thigh")) for l in lead])
        if mid.any():
            low.append(float(np.median(co[mid][:, 2])))
    hip = float(_bone(arm, "thigh_l")[2])
    return (max(low) if low else hip - 0.05 * size) + 0.012 * size


def _shell(arm, bodies, keep, cuts, lift, ease, name, box=()):
    """The bodies' rest surface over the keep bones, cut by each plane across the bones it runs
    through, lifted lift metres off the skin and eased ease rounds. Returns the object, or None."""
    import bmesh

    from . import deform

    # The body's own mesh at rest, weights and all: what is cut from it bends exactly as the skin does.
    body = bodies[0]
    co, _ = helpers.rest_coords(body)
    bm = bmesh.new()
    bm.from_mesh(body.data)
    if len(co) != len(bm.verts):
        bm.free()
        return None
    bm.verts.ensure_lookup_table()
    for v, c in zip(bm.verts, co.tolist()):
        v.co = c
    tag = bm.faces.layers.int.new("bone")
    names = {}
    lead = deform._dominant(body, arm)
    for f in bm.faces:
        ls = [lead[v.index] for v in f.verts]
        bone = max(set(ls), key=ls.count)
        f[tag] = names.setdefault(bone, len(names) + 1) if bone is not None else 0
    wanted = set(keep) | {b for _, _, through in cuts for b in through}
    ids = {names[b] for b in wanted if b in names}
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f[tag] not in ids], context="FACES")
    for point, normal, through in cuts:
        cut_ids = {names[b] for b in through if b in names}
        faces = [f for f in bm.faces if f[tag] in cut_ids]
        geom = list({v for f in faces for v in f.verts} | {e for f in faces for e in f.edges} | set(faces))
        if geom:
            bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-6, plane_co=Vector(point), plane_no=Vector(-np.asarray(normal)), clear_outer=True, clear_inner=False)
    keep_ids = {names[b] for b in keep if b in names}
    # What a cut ran through and left on the kept side stays (a wrist's last ring); the rest of a
    # bone the garment does not cover goes.
    through_ids = {names[b] for _, _, through in cuts for b in through if b in names}
    drop = []
    for f in bm.faces:
        if f[tag] in keep_ids:
            continue
        c = np.array(f.calc_center_median())
        inside = f[tag] in through_ids and all(float((c - np.asarray(p)) @ np.asarray(n)) >= -1e-6 for p, n, through in cuts if f[tag] in {names.get(b) for b in through})
        if not inside:
            drop.append(f)
    bmesh.ops.delete(bm, geom=drop, context="FACES")
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    if not bm.faces:
        bm.free()
        return None
    bm.normal_update()
    on_cut = {v for e in bm.edges if len(e.link_faces) == 1 for v in e.verts}
    for v in bm.verts:
        v.co += v.normal * lift
    inner = [v for v in bm.verts if v not in on_cut]
    for _ in range(int(ease)):
        # Cloth does not follow every muscle: eased, then lifted back off the skin by dress.
        bmesh.ops.smooth_vert(bm, verts=inner, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    if box:
        _toe_box(bm, tag, {names[b] for b in box if b in names})
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.shade_smooth()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    for g in body.vertex_groups:  # the same groups in the same order: the mesh's weights go by index
        o.vertex_groups.new(name=g.name)
    return o


def _toe_box(bm, tag, ids):
    """Each connected part of the faces tagged ids (a foot's toes) drawn out onto its own convex
    hull: a boot has one toe, not five."""
    import bmesh
    from mathutils.bvhtree import BVHTree

    faces = [f for f in bm.faces if f[tag] in ids]
    seen = set()
    for start in faces:
        if start in seen:
            continue
        island, todo = [], [start]
        seen.add(start)
        while todo:
            f = todo.pop()
            island.append(f)
            for e in f.edges:
                for g in e.link_faces:
                    if g not in seen and g[tag] in ids:
                        seen.add(g)
                        todo.append(g)
        verts = list({v for f in island for v in f.verts})
        island_set = set(island)
        if len(verts) < 8:
            continue
        hull_bm = bmesh.new()
        for v in verts:
            hull_bm.verts.new(v.co)
        bmesh.ops.convex_hull(hull_bm, input=hull_bm.verts[:])
        tree = BVHTree.FromBMesh(hull_bm)
        centre = sum((v.co for v in verts), Vector()) / len(verts)
        edge = {v for v in verts if any(f not in island_set for f in v.link_faces)}
        inner = [v for v in verts if v not in edge]
        for spread in (0, 10, 6):
            # Out onto the hull, then eased along it: the skin between two toes lands in a crease
            # that the easing opens out.
            if spread:
                bmesh.ops.smooth_vert(bm, verts=inner, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
                for _ in range(spread - 1):
                    bmesh.ops.smooth_vert(bm, verts=inner, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
            for v in inner:
                d = v.co - centre
                if d.length < 1e-7:
                    continue
                hit = tree.ray_cast(centre + d.normalized() * 10, -d.normalized(), 20)
                if hit[0] is not None:
                    v.co = hit[0]
        hull_bm.free()


def _reweigh(o, bones, to):
    """Every weight o has on bones goes to the bone to."""
    target = o.vertex_groups.get(to) or o.vertex_groups.new(name=to)
    moved = {g.index for g in o.vertex_groups if g.name in bones}
    for v in o.data.vertices:
        extra = sum(e.weight for e in v.groups if e.group in moved)
        if extra > 0:
            for gi in [e.group for e in v.groups if e.group in moved]:
                o.vertex_groups[gi].remove([v.index])
            target.add([v.index], extra, "ADD")


def _outline(pts, centre, segs):
    """How far a set of points reaches from centre in each of segs directions (its convex outline)."""
    out = np.zeros(segs)
    rel = pts[:, :2] - centre
    for j in range(segs):
        a = 2 * math.pi * j / segs
        out[j] = max(0.0, float((rel @ np.array([math.sin(a), -math.cos(a)])).max())) if len(rel) else 0.0
    return out


def _skirt(arm, bodies, top_z, hem_z, flare, gap, name, segs=40, rings=11):
    """A tube hanging from top_z to hem_z round everything under it: at each height its outline is
    the outline of the trunk and legs there (never narrower than the ring above), gap metres clear,
    widening to flare times that at the hem."""
    from . import deform

    pts = []
    for body in bodies:
        co, _ = helpers.rest_coords(body)
        if len(co) != len(body.data.vertices):
            continue
        lead = deform._dominant(body, arm)
        under = np.array([l is not None and l.startswith(("pelvis", "spine", "thigh", "calf", "foot", "ball")) for l in lead])
        pts.append(co[under])
    pts = np.concatenate(pts) if pts else np.zeros((0, 3))
    span = top_z - hem_z
    if span <= 1e-4 or not len(pts):
        raise ValueError(f"nothing hangs between {top_z:.2f} m and {hem_z:.2f} m: hem must be below the hips")
    slab = max(0.012, span / rings * 0.75)
    band = pts[np.abs(pts[:, 2] - top_z) < slab]
    centre = band[:, :2].mean(axis=0) if len(band) else pts[:, :2].mean(axis=0)
    verts, faces = [], []
    reach = np.zeros(segs)
    for k in range(rings):
        t = k / (rings - 1)
        z = top_z + 0.015 - (span + 0.015) * t
        here = pts[np.abs(pts[:, 2] - z) < slab]
        reach = np.maximum(reach, _outline(here, centre, segs))
        # An outline with a waist in it (between two legs) is rounded off by its neighbours.
        r = np.maximum(reach, (np.roll(reach, 1) + np.roll(reach, -1)) / 2)
        r = (r + gap) * (1 + (flare - 1) * t ** 1.3)
        for j in range(segs):
            a = 2 * math.pi * j / segs
            verts.append((centre[0] + r[j] * math.sin(a), centre[1] - r[j] * math.cos(a), z))
    for k in range(rings - 1):
        for j in range(segs):
            a, b = k * segs + j, k * segs + (j + 1) % segs
            faces.append((a, a + segs, b + segs, b))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.shade_smooth()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def garment(armature, kind, *, colour=None, material=None, name=None, sleeves="long", length=None, hem=None, flare=1.2,
            collar=0.3, top=None, waist=None, fit=1.0, chains=6):
    """Makes and dresses a garment on armature's body (a human on the standard skeleton), in one of
    KINDS:
      top       shirt, tunic, coat, dress: the trunk from the collar (collar: 0 at the neck's base
                .. 1 under the jaw) down to length (a height, m; default and lowest where the legs part), with
                sleeves "long", "short" or "none"; hem (a height, m) hangs a skirt on from there
                down, flare times as wide at its hem (a coat to the knees, a dress, a robe)
      trousers  from waist (a height; default the waist) down length of the leg (0..1, default the
                ankle; 0.45 is shorts)
      boots     the feet and up top of the shin (0..1, default 0.45)
      gloves    the hands and up top of the forearm (0..1, default 0.2)
      skirt     from waist down to hem, flare times as wide there
    colour (hex) or material; fit scales how loose it sits (1 a shirt, 1.6 a padded coat). Every
    opening is a clean loop with a turned-in edge. Make what is worn underneath first: each garment
    lies outside the ones already on. Returns {"object", "chains", "triangles"}."""
    if kind not in KINDS:
        raise ValueError(f"garment kind {kind!r}: one of {', '.join(KINDS)}")
    arm = bpy.data.objects[armature] if isinstance(armature, str) else armature
    bodies = cloth._bodies(arm)
    if not bodies:
        raise ValueError(f"{arm.name} has no body mesh to dress")
    size = cloth._size(bodies)
    name = name or f"{arm.name}_{kind}"
    mat = material or helpers.material(colour or "#6c8fd6", name=name.split("_", 1)[-1].capitalize())
    posed = arm.data.pose_position
    arm.data.pose_position = "REST"
    bpy.context.view_layer.update()
    try:
        # Over whatever is worn already: a coat made after the trousers lies outside them.
        lift = 0.0045 * size * float(fit)
        parts = []
        hang = None
        if kind != "skirt":
            fork = _fork(arm, bodies, size)
            keep, cuts = _plan(arm, kind, size, sleeves, length, collar, top, waist, fork)
            box = [f"{b}_{s}" for b in ("ball", "ball_leaf") for s in SIDES] if kind == "boots" else ()
            shell = _shell(arm, bodies, keep, cuts, lift, ease=3 * float(fit), name=name, box=box)
            if shell is None:
                raise ValueError(f"{arm.name}'s body has no skin where a {kind} goes: its joints may be named another way")
            if kind == "top":
                # A top hangs from the trunk: what it has of the legs' weights (its last ring, at the
                # hip) would tear it at the first stride.
                _reweigh(shell, _leg_of("l") + _leg_of("r"), "pelvis")
            parts.append(shell)
        if kind == "skirt" or (kind == "top" and hem is not None):
            if hem is None:
                raise ValueError("a skirt needs hem=, the height its hem hangs at")
            hip = float(_bone(arm, "thigh_l")[2])
            top_z = max(float(length) if length is not None else 0.0, _fork(arm, bodies, size)) if kind == "top" else (float(waist) if waist is not None else float(_bone(arm, "spine_01")[2]))
            skirt = _skirt(arm, bodies, top_z, float(hem), float(flare), lift + 0.006 * size * float(fit), name + "_skirt")
            # It hangs from the hips; below the hang line its hem chains take it over (cloth.dress).
            skirt.vertex_groups.new(name="pelvis").add(list(range(len(skirt.data.vertices))), 1.0, "REPLACE")
            parts.append(skirt)
            hang = min(top_z, hip)
        # Over whatever is worn there already: a coat made after the trousers lies outside them.
        lo, hi = min(float(np.min([v.co.z for v in p.data.vertices])) for p in parts), max(float(np.max([v.co.z for v in p.data.vertices])) for p in parts)
        under = 0.0
        for o in bpy.data.objects:
            if o.get("kurambit_cloth") and arm in helpers._deforming(o) and o.name != name and LIFT in o:
                zs = helpers.rest_coords(o)[0][:, 2]
                if len(zs) and min(hi, float(zs.max())) - max(lo, float(zs.min())) > 0.03 * size:
                    under = max(under, float(o[LIFT]))
        lift += under
        for p in parts:
            if under > 0:
                p.data.update()
                for v in p.data.vertices:
                    v.co += v.normal * under
        g = parts[0]
        if len(parts) > 1:
            with bpy.context.temp_override(active_object=g, object=g, selected_objects=parts, selected_editable_objects=parts):
                bpy.ops.object.join()
        g.name = name
        g.data.materials.clear()
        g.data.materials.append(mat)
    finally:
        arm.data.pose_position = posed
    made = cloth.dress(g, arm, body=bodies, offset=lift, hang=hang, chains=chains if hang is not None else 0, name=name.split("_", 1)[-1][:12],
                       weights="keep")
    g[LIFT] = lift
    if made:
        cloth.follow_hem(arm)
    return {"object": g.name, "chains": made, "triangles": sum(len(p.vertices) - 2 for p in g.data.polygons)}
