"""The world kit, for game_blender op code: `from kurambit import world`. What a place is made of
that Blender makes better than code, each from one call and a few numbers, built with Blender's
own curves, modifiers and geometry nodes.

  world.tree(name, height=6, crown="cone"|"round"|"weeping"|"bush"|"palm"|"bare", ...)   a tree
  world.plants(name, "grass"|"reeds"|"fern"|"flowers", ...)          a patch of low plants to scatter
  world.rock(name, size=(2, 1.6, 1.2), sharp=0.5, moss=0, ...)       a rock of broad planes
  world.cliff(name, size=(9, 3, 6), ...)                             jointed beds of rock, a wall to build against
  world.building(name, plan=(6, 5), floors=1, roof="gable", ...)     a framed, roofed, walk-in building

Each returns its object, standing on z = 0 at the origin, facing -Y, named name. The look comes
from the game's lock (kurambit.look): a colour and a surface for every role (bark, leaf, stone,
wall, roof, ...), faceted or soft shapes, how chunky and how detailed. `colours={"leaf":
"#5a8f3c"}` sets one role's colour, `{"wall": "stone"}` gives it another role's look, and a
material (a made surface) is box-mapped in metres. `seed` makes another of the same kind: export
three seeds of a tree and scatter each in the game (shell/model.js M.scatter) for a forest in
three draws. The ground is built in the game's code (M.ground), as are furniture and clutter."""
import json
import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Vector, noise

from . import helpers, look

def _material(role, colours, lk, rough=None):
    """The material of a role: the caller's (a colour, or a material such as a made surface), else
    the look's: its surface where the finish is not flat and the role has one, else its colour."""
    given = (colours or {}).get(role)
    if isinstance(given, bpy.types.Material):
        return given
    if isinstance(given, str) and not given.startswith("#"):  # another role's colour and surface
        return _material(given, None, lk, rough)
    if given is None and lk["finish"] != "flat" and role in lk["surfaces"]:
        made = bpy.data.materials.get(role)
        if made is not None and "kurambit_surface" in made:
            return made
        from .surfaces import surface
        return surface(role)
    return helpers.material(given or look.colour(role, lk), name=role.capitalize(), roughness=rough if rough is not None else (0.35 if role == "glass" else 0.8))


def _new(name, me):
    old = bpy.data.objects.get(name)
    if old is not None:
        bpy.data.objects.remove(old, do_unlink=True)
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def _apply(o):
    """o with its modifiers (and a curve's bevel) made real: a plain mesh object of the same name."""
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    if o.type == "MESH":
        old = o.data
        o.modifiers.clear()
        o.data = me
        if old.users == 0:
            bpy.data.meshes.remove(old)
        return o
    name, world_matrix = o.name, o.matrix_world.copy()
    bpy.data.objects.remove(o, do_unlink=True)
    made = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(made)
    made.matrix_world = world_matrix
    return made


def _shade(o, facets, angle=40):
    me = o.data
    me.polygons.foreach_set("use_smooth", [not facets] * len(me.polygons))
    if not facets:
        # Blender 4.1+: smooth by angle is a mesh attribute set through the operator-free API.
        me.set_sharp_from_angle(angle=math.radians(angle))
    me.update()


def _join(name, parts):
    parts = [p for p in parts if p is not None]
    keep = parts[0]
    if len(parts) > 1:
        with bpy.context.temp_override(active_object=keep, object=keep, selected_objects=parts, selected_editable_objects=parts):
            bpy.ops.object.join()
    old = bpy.data.objects.get(name)
    if old is not None and old != keep:
        bpy.data.objects.remove(old, do_unlink=True)
    keep.name = name
    keep.data.name = name
    return keep


def _wrap(o):
    """Surfaces among o's materials get their box mapping, in metres."""
    if any(m is not None and "kurambit_surface" in m for m in o.data.materials):
        from .surfaces import wrap
        wrap(o)
    return o


def tris(o):
    o.data.calc_loop_triangles()
    return len(o.data.loop_triangles)


# ---- trees and plants ---------------------------------------------------------------------------

def _mesh_object(name, verts, faces):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.update()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def _blob(centre, radii, seed, rough=0.16, subdivisions=3):
    """A lump: a sphere pushed in and out by noise, the start of a crown's lobe or a bush."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdivisions, radius=1.0)
    off = Vector((seed * 5.3, seed * 1.7, seed * 9.1))
    for v in bm.verts:
        n = noise.noise(v.co * 1.4 + off)
        v.co = Vector(centre) + Vector((v.co.x * radii[0], v.co.y * radii[1], v.co.z * radii[2])) * (1.0 + rough * n * 2)
    me = bpy.data.meshes.new("kurambit_blob")
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new("kurambit_blob", me)
    bpy.context.scene.collection.objects.link(o)
    return o


def _fuse(name, parts, voxel, triangles=None):
    """Several overlapping solids as one skin with nothing inside it: Blender's voxel remesh, then
    its decimate to a triangle count."""
    o = _join(name, parts)
    r = o.modifiers.new("fuse", "REMESH")
    r.mode = "VOXEL"
    r.voxel_size = voxel
    r.use_smooth_shade = True
    o = _apply(o)
    if triangles is not None and tris(o) > triangles:
        d = o.modifiers.new("thin", "DECIMATE")
        d.ratio = triangles / tris(o)
        o = _apply(o)
    return o


def _tufts(name, hull, count, tuft, seed, *, lift=0.5, facing=-0.35):
    """Leaves over a hull, scattered and instanced by geometry nodes (Distribute Points on Faces,
    Instance on Points), each lying down the hull's slope and lifted off it, then given the hull's
    own normals (Blender's Data Transfer modifier): the crown shades as one soft shape and only its
    outline is leafy. tuft: an object, its base at the origin, growing along +Y, face up +Z."""
    area = sum(p.area for p in hull.data.polygons)
    g = bpy.data.node_groups.new("kurambit_tufts", "GeometryNodeTree")
    g.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    g.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    n, link = g.nodes, g.links
    gin, gout = n.new("NodeGroupInput"), n.new("NodeGroupOutput")
    points = n.new("GeometryNodeDistributePointsOnFaces")
    points.distribute_method = "RANDOM"
    points.inputs["Density"].default_value = count / max(area, 1e-6)
    points.inputs["Seed"].default_value = seed
    # Only faces that look outward enough carry leaves: none under a skirt or against the ground.
    normal = n.new("GeometryNodeInputNormal")
    split = n.new("ShaderNodeSeparateXYZ")
    keep = n.new("FunctionNodeCompare")
    keep.operation = "GREATER_THAN"
    keep.inputs[1].default_value = facing
    link.new(normal.outputs[0], split.inputs[0])
    link.new(split.outputs["Z"], keep.inputs[0])
    link.new(keep.outputs[0], points.inputs["Selection"])
    obj = n.new("GeometryNodeObjectInfo")
    obj.inputs["Object"].default_value = tuft
    inst = n.new("GeometryNodeInstanceOnPoints")
    # Face up along the hull's normal, then turned about it so the leaf points down the slope.
    up = n.new("FunctionNodeAlignRotationToVector")
    up.axis = "Z"
    down = n.new("FunctionNodeAlignRotationToVector")
    down.axis, down.pivot_axis = "Y", "Z"
    down.inputs["Vector"].default_value = (0.0, 0.0, -1.0)
    wobble = n.new("FunctionNodeRandomValue")
    wobble.data_type = "FLOAT_VECTOR"
    wobble.inputs[0].default_value = (lift * 0.5, -0.25, -0.5)
    wobble.inputs[1].default_value = (lift * 1.5, 0.25, 0.5)
    wobble.inputs["Seed"].default_value = seed + 1
    tilt = n.new("FunctionNodeEulerToRotation")
    turn = n.new("FunctionNodeRotateRotation")
    turn.rotation_space = "LOCAL"
    size = n.new("FunctionNodeRandomValue")
    size.data_type = "FLOAT"
    size.inputs[2].default_value, size.inputs[3].default_value = 0.75, 1.25
    size.inputs["Seed"].default_value = seed + 2
    real = n.new("GeometryNodeRealizeInstances")
    link.new(gin.outputs[0], points.inputs["Mesh"])
    link.new(points.outputs["Normal"], up.inputs["Vector"])
    link.new(up.outputs[0], down.inputs["Rotation"])
    link.new(wobble.outputs[0], tilt.inputs[0])
    link.new(down.outputs[0], turn.inputs[0])
    link.new(tilt.outputs[0], turn.inputs[1])
    link.new(points.outputs["Points"], inst.inputs["Points"])
    link.new(obj.outputs["Geometry"], inst.inputs["Instance"])
    link.new(turn.outputs[0], inst.inputs["Rotation"])
    link.new(size.outputs[1], inst.inputs["Scale"])
    link.new(inst.outputs[0], real.inputs[0])
    link.new(real.outputs[0], gout.inputs[0])
    leaves = _new(name, hull.data.copy())
    leaves.matrix_world = hull.matrix_world
    leaves.modifiers.new("scatter", "NODES").node_group = g
    soft = leaves.modifiers.new("soft", "DATA_TRANSFER")
    soft.object = hull
    soft.use_loop_data = True
    soft.data_types_loops = {"CUSTOM_NORMAL"}
    soft.loop_mapping = "POLYINTERP_NEAREST"
    leaves = _apply(leaves)
    bpy.data.node_groups.remove(g)
    return _two_sided(leaves)


def _two_sided(o):
    """Thin foliage given a back: every face again, turned round, keeping the normals it was
    given. A double-sided material would turn those normals on a back face, and a leaf seen from
    under would go black; with its own back faces it shades as the crown does from both sides."""
    me = o.data
    n = len(me.loops)
    normals = np.array([c.vector[:] for c in me.corner_normals], dtype=np.float32).reshape(-1, 3)
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    faces = [list(p.vertices) for p in me.polygons]
    starts = [p.loop_start for p in me.polygons]
    # The backs get vertices of their own: two faces on the same vertices are one face to Blender's
    # mesh checks, which drop the second.
    count = len(me.vertices)
    back, order = [], []
    for f, s0 in zip(faces, starts):
        back.append([v + count for v in f[::-1]])
        order += list(range(s0 + len(f) - 1, s0 - 1, -1))
    both = bpy.data.meshes.new(me.name)
    both.from_pydata(co.reshape(-1, 3).tolist() * 2, [], faces + back)
    both.polygons.foreach_set("use_smooth", [True] * len(both.polygons))
    both.normals_split_custom_set(np.concatenate([normals[:n], normals[order]]).tolist())
    both.update()
    o.data = both
    bpy.data.meshes.remove(me)
    o["kurambit_two_sided"] = True
    return o


def _leaf(length, width, cup=0.12):
    """One leaf for _tufts: a pointed blade lying along +Y, a little cupped."""
    w, l = width / 2, length
    return _mesh_object("kurambit_leaf", [(-w * 0.6, 0, 0), (w * 0.6, 0, 0), (w, l * 0.5, l * cup), (0, l, l * cup * 0.5), (-w, l * 0.5, l * cup)], [(0, 1, 2, 3, 4)])


def _lit(o, lk, colours, dark="leaf", light="leaf2", *, low=None, high=None):
    """A foliage mesh in its two tones by how much sky each face sees (its normal and its height in
    the crown). With a hex palette or facets: two flat materials. Otherwise one material in the
    light tone, shaded down to the dark one per vertex, so the crown has depth under any light and
    Art still edits it as one colour."""
    me = o.data
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    z = co.reshape(-1, 3)[:, 2]
    low, high = (float(z.min()) if low is None else low), (float(z.max()) if high is None else high)
    me.materials.clear()
    if lk["facets"] or lk["palette"]:
        for r in (dark, light):
            me.materials.append(_material(r, colours, lk))
        for p in me.polygons:
            h = (p.center.z - low) / max(1e-6, high - low)
            p.material_index = 1 if p.normal.z * 0.6 + h * 0.75 > 0.72 else 0
        return o
    a, b = _rgb(look.colour((colours or {}).get(dark) or dark, lk)), _rgb(look.colour((colours or {}).get(light) or light, lk))
    lin = lambda c: np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    shade = np.clip(lin(a) / np.maximum(lin(b), 1e-4), 0.0, 1.0)
    mat = bpy.data.materials.get(f"{light.capitalize()} lit") or helpers.material(look.colour((colours or {}).get(light) or light, lk), name=f"{light.capitalize()} lit", roughness=0.85)
    tree_nodes = mat.node_tree
    if not any(nd.type == "VERTEX_COLOR" for nd in tree_nodes.nodes):
        bsdf = next(nd for nd in tree_nodes.nodes if nd.type == "BSDF_PRINCIPLED")
        base = tuple(bsdf.inputs["Base Color"].default_value)
        col = tree_nodes.nodes.new("ShaderNodeVertexColor")
        col.layer_name = "Col"
        mix = tree_nodes.nodes.new("ShaderNodeMix")
        mix.data_type, mix.blend_type = "RGBA", "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        mix.inputs["A"].default_value = base
        tree_nodes.links.new(col.outputs["Color"], mix.inputs["B"])
        tree_nodes.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
    mat.use_backface_culling = True  # soft foliage carries its own back faces (_two_sided) or is closed
    me.materials.append(mat)
    attr = me.color_attributes.get("Col") or me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
    out = np.ones((len(me.loops), 4), dtype=np.float32)
    normals = np.array([cn.vector[:] for cn in me.corner_normals]) if len(me.corner_normals) else None
    for p in me.polygons:
        h = (p.center.z - low) / max(1e-6, high - low)
        # Each leaf a little lighter or darker than its neighbours, so the mass reads as leaves.
        own = noise.noise(Vector(p.center) * 2.7) * 0.5
        for li in p.loop_indices:
            nz = normals[li][2] if normals is not None else p.normal.z
            t = float(np.clip(nz * 0.5 + h * 0.7 - 0.08 + own, 0.0, 1.0))
            out[li, :3] = shade + (1.0 - shade) * t
    attr.data.foreach_set("color", out.ravel())
    me.color_attributes.active_color = attr
    return o


def _rgb(h):
    return np.array([int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)])


def _wood(name, splines, lk, colours, sides=None):
    """Trunk and limbs: poly splines of (point, radius), bevelled round by Blender's curve tools."""
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = 1.0
    cu.bevel_resolution = sides if sides is not None else (1 if lk["facets"] else 2)
    cu.resolution_u = 1 if lk["facets"] else 2
    cu.use_fill_caps = True
    for pts, radii in splines:
        s = cu.splines.new("POLY")
        s.points.add(len(pts) - 1)
        for p, pt, r in zip(s.points, pts, radii):
            p.co = (*pt, 1.0)
            p.radius = r
    wood = _new(name, cu)
    wood.data.materials.append(_material("bark", colours, lk))
    wood = _apply(wood)
    _shade(wood, lk["facets"])
    return wood


def _trunk(rng, height, top, radius, lean, flare=1.7, points=8):
    """A trunk's points and radii: a gentle bend to its lean, flared at the root, tapering."""
    bend = rng.normal(0, 0.014 * height, 2)
    pts, radii = [], []
    for i in range(points):
        t = i / (points - 1)
        off = np.array([lean, 0.0]) * t ** 1.5 + bend * math.sin(t * math.pi)
        pts.append(np.array([off[0], off[1], top * t]))
        radii.append(radius * ((1 - 0.6 * t ** 0.9) + (flare - 1) * max(0.0, 1 - t * 9) ** 2))
    return pts, radii


def _along(pts, t):
    f = min(max(t, 0.0), 0.9999) * (len(pts) - 1)
    i = int(f)
    return pts[i] * (1 - (f - i)) + pts[i + 1] * (f - i)


def _limb(rng, base, tip, radius, sag=0.0, wander=0.06, points=5):
    """A limb from base to tip: bowed upward, sagging by `sag`, wandering a little."""
    span = np.linalg.norm(tip - base)
    pts = []
    for j in range(points):
        t = j / (points - 1)
        p = base + (tip - base) * t + np.array([0, 0, span * (0.18 - sag) * math.sin(t * math.pi)])
        pts.append(p + (rng.normal(0, wander * span, 3) if 0 < j < points - 1 else 0))
    return pts, [radius * (1 - 0.75 * j / (points - 1)) for j in range(points)]


def _skirt(z0, z1, radius, points, rng, soft):
    """One tier of a conifer: a skirt flaring down from the trunk to a ragged hem, closed under."""
    n = points * 2
    turn = rng.uniform(0, math.tau)
    rim = [radius * (1.0 if k % 2 == 0 else 0.72) * rng.uniform(0.9, 1.1) for k in range(n)]
    dip = [(-0.1 if k % 2 == 0 else 0.07) * (z1 - z0) + rng.normal(0, 0.02) * (z1 - z0) for k in range(n)]
    rings = [(0.07, z1, 0.0), (0.42, z0 + (z1 - z0) * 0.55, 0.5), (1.0, z0, 1.0)] if not soft else \
            [(0.07, z1, 0.0), (0.25, z0 + (z1 - z0) * 0.78, 0.2), (0.5, z0 + (z1 - z0) * 0.48, 0.5), (0.78, z0 + (z1 - z0) * 0.2, 0.8), (1.0, z0, 1.0)]
    verts, faces = [], []
    for share, z, ragged in rings:
        for k in range(n):
            a = turn + math.tau * k / n
            r = radius * share * (1 - ragged) + rim[k] * share * ragged
            verts.append((r * math.cos(a), r * math.sin(a), z + dip[k] * ragged))
    for ring in range(len(rings) - 1):
        for k in range(n):
            a, b = ring * n + k, ring * n + (k + 1) % n
            faces.append((a, a + n, b + n, b))
    # The underside: from the hem up and in to the trunk, so a tier is a solid, not a paper cone.
    under = len(verts)
    verts.append((0.0, 0.0, z0 + (z1 - z0) * 0.45))
    last = (len(rings) - 1) * n
    faces += [(last + (k + 1) % n, last + k, under) for k in range(n)]
    faces.append(tuple(range(n)))
    return verts, faces


def _frond(length, width, rise, fall, facets):
    """A frond: a blade arching out along +Y, rising by `rise` then falling by `fall` of its
    length, folded along its midrib, its edge cut into leaflets."""
    n = 7 if facets else 10
    verts, faces = [], []
    for j in range(n + 1):
        t = j / n
        y, z = length * t * (1 - 0.18 * t), length * (rise * t - fall * t ** 2.2)
        w = width * (math.sin(math.pi * min(1.0, 0.06 + t * 0.98)) ** 0.7) * (1 - 0.2 * t) + 0.01
        cut = 0.6 if j % 2 else 1.0
        verts += [(-w * cut, y, z - w * 0.45), (0.0, y, z), (w * cut, y, z - w * 0.45)]
    for j in range(n):
        a = j * 3
        faces += [(a, a + 1, a + 4, a + 3), (a + 1, a + 2, a + 5, a + 4)]
    return verts, faces


def tree(name, height=6.0, crown="cone", *, trunk=None, spread=None, limbs=None, droop=None, density=1.0, bare=None,
         lean=0.0, seed=1, colours=None, facets=None, foliage=None):
    """A tree or a plant, standing at the origin. crown: "cone" (a conifer: tiers of skirts),
    "round" (a broadleaf: a crown of lobes on lifting limbs), "weeping" (limbs arching over, hung
    with tassels), "bush" (a mass of lobes on the ground: height 1 to 2), "palm" (a ringed
    leaning trunk under arching fronds) or "bare" (a dead tree: forking limbs, no leaves).
    trunk: its radius at the ground; spread: the crown's radius; limbs: how many; droop: 0..1 how
    far limbs or fronds fall; density: foliage amount (0.5 for one that repeats); bare: the share
    of the height below the crown; lean: metres the top is off the base; seed: another of its
    kind. The look sets the rest: faceted, the crown is one low-poly skin in two flat tones; soft,
    leaves lie over it and take its shading. Colour roles: bark, leaf, leaf2."""
    lk = look.read()
    if facets is not None:
        lk["facets"] = facets
    facets, chunky, detail = lk["facets"], lk["chunky"], lk["detail"]
    rng = np.random.default_rng(seed)
    if crown not in ("cone", "round", "weeping", "bush", "palm", "bare"):
        raise ValueError(f'crown is "cone", "round", "weeping", "bush", "palm" or "bare", not {crown!r}')
    radius = (trunk or height * {"cone": 0.028, "round": 0.04, "weeping": 0.05, "bush": 0.02, "palm": 0.03, "bare": 0.06}[crown]) * (1 + 0.8 * chunky)
    spread = (spread or height * {"cone": 0.25, "round": 0.4, "weeping": 0.46, "bush": 0.7, "palm": 0.42, "bare": 0.4}[crown]) * (1 + 0.2 * chunky)
    bare = {"cone": 0.2, "round": 0.42, "weeping": 0.4, "bush": 0.0, "palm": 0.86, "bare": 0.35}[crown] * (1 - 0.3 * chunky) if bare is None else bare
    droop = {"cone": 0.25, "round": 0.0, "weeping": 0.9, "bush": 0.0, "palm": 0.5, "bare": 0.0}[crown] if droop is None else droop
    wood, solid, leafy, loose = [], [], [], []  # splines; lobes to fuse; hulls leaves lie over; ready foliage meshes

    if crown == "cone":
        tp, tr = _trunk(rng, height, height * 0.96, radius, lean, flare=1.5)
        wood.append((tp, tr))
        tiers = int(round(4 + 2.5 * detail - 1.0 * chunky))
        z0 = height * bare
        step = (height - z0) / (tiers + 0.35)
        verts, faces = [], []
        for k in range(tiers):
            base = z0 + step * k
            top = min(height, base + step * (1.75 if k < tiers - 1 else 1.4))
            r = spread * (1.0 - 0.8 * k / max(1, tiers - 1)) * rng.uniform(0.92, 1.06)
            v, f = _skirt(base - droop * step * 0.5, top, r, int((5 if facets else 7) + max(0, 2 - k)), rng, not facets)
            at = _along(tp, (base + top) / 2 / (height * 0.96))
            faces += [tuple(i + len(verts) for i in face) for face in f]
            verts += [(x + at[0], y + at[1], z) for x, y, z in v]
        boughs = _mesh_object(name + "_boughs", verts, faces)
        (loose if facets else leafy).append(boughs)
    elif crown in ("round", "bush"):
        ry = min(spread * 0.85, height * 0.36) if crown == "round" else height * 0.55
        centre = np.array([lean * 0.9, 0.0, height - ry if crown == "round" else ry * 0.75])
        if crown == "round":
            tp, tr = _trunk(rng, height, height * (bare + 0.14), radius, lean * 0.7)
            wood.append((tp, tr))
        count = max(3, int(round((limbs or (7 if crown == "round" else 5)) * (1 - 0.3 * chunky))))
        lobes = [(centre + np.array([0, 0, ry * 0.12]), np.array([spread * 0.62, spread * 0.62, ry * 0.8]))]
        for k in range(count):
            az = k * 2.39996 + rng.uniform(-0.4, 0.4)
            up = rng.uniform(-0.45, 0.5) if crown == "round" else rng.uniform(-0.2, 0.45)
            at = centre + np.array([math.cos(az) * spread * 0.56, math.sin(az) * spread * 0.56, up * ry])
            r = spread * rng.uniform(0.36, 0.5)
            lobes.append((at, np.array([r, r, r * rng.uniform(0.72, 0.9)])))
        for k, (at, r) in enumerate(lobes):
            solid.append(_blob(at, r, seed * 31 + k))
        if crown == "round":
            # Limbs lift from the trunk's top into the lower lobes, so wood shows under the crown.
            fork = tp[-1]
            for k in range(1, min(len(lobes), 1 + (limbs or 4))):
                at, r = lobes[k]
                if at[2] > centre[2] + ry * 0.2:
                    continue
                start = _along(tp, rng.uniform(0.72, 0.98))
                wood.append(_limb(rng, start, at - np.array([0, 0, r[2] * 0.3]), radius * 0.42))
            wood.append(_limb(rng, fork, centre, radius * 0.5))
        else:
            for k in range(3):
                az = k * 2.1 + rng.uniform(0, 1)
                wood.append(_limb(rng, np.array([math.cos(az), math.sin(az), 0.0]) * spread * 0.12, centre + np.array([math.cos(az), math.sin(az), 0.2]) * spread * 0.4, radius * 0.8))
    elif crown == "weeping":
        # One shape from crest to hem: a dome, and strands that start all over it, run out and over
        # its curve and fall, the outer ones longest, so the crown pours down like a fountain
        # instead of a lid with a curtain hung under its rim.
        tp, tr = _trunk(rng, height, height * (bare + 0.12), radius, lean * 0.5, flare=1.9)
        wood.append((tp, tr))
        crest = height * 0.97
        rz = spread * 0.62
        centre = np.array([lean * 0.5, 0.0, crest - rz])
        solid.append(_blob(centre, np.array([spread * 0.74, spread * 0.74, rz]), seed, rough=0.1))
        for k in range(limbs or 6):
            az = k * math.tau / (limbs or 6) + rng.uniform(-0.25, 0.25)
            out = np.array([math.cos(az), math.sin(az), 0.0])
            start = _along(tp, rng.uniform(0.8, 1.0))
            wood.append(_limb(rng, start, centre + out * spread * 0.62 + np.array([0, 0, rz * 0.25]), radius * 0.42, sag=0.05))
            solid.append(_blob(centre + out * spread * 0.38 + np.array([0, 0, rz * 0.1]), np.array([spread * 0.42] * 2 + [rz * 0.62]), seed * 7 + k, rough=0.1))
        verts, faces = [], []
        sides = 3 if facets else 6
        count = int(round((28 if facets else 64) * max(0.3, density) * (0.7 + 0.6 * detail)))
        for j in range(count):
            # Golden-angle spiral over the dome from near the crest to its widest; the lower a
            # strand starts, the further out it runs and the longer it falls.
            share = (j + 0.5) / count
            polar = math.radians(18 + 80 * share ** 0.8) + rng.uniform(-0.06, 0.06)
            az = j * 2.39996 + rng.uniform(-0.15, 0.15)
            h = np.array([math.cos(az), math.sin(az), 0.0])
            on = centre + np.array([h[0] * spread * 0.74 * math.sin(polar), h[1] * spread * 0.74 * math.sin(polar), rz * math.cos(polar)])
            on = on + (on - centre) / np.linalg.norm(on - centre) * spread * 0.04
            run = spread * (0.14 + 0.2 * share) * rng.uniform(0.8, 1.2)
            floor = height * (0.08 + 0.32 * (1 - share) ** 1.5 + 0.45 * (1 - droop)) * rng.uniform(0.75, 1.3)
            drop = max(on[2] - floor, spread * 0.3)
            path = [on, on + h * run * 0.55 + np.array([0, 0, run * 0.12]), on + h * run - np.array([0, 0, run * 0.35])]
            for q in (0.35, 0.7, 1.0):
                path.append(path[2] + h * run * 0.18 * q - np.array([0, 0, (drop - run * 0.35) * q]))
            w = spread * 0.075 * rng.uniform(0.75, 1.25) * (1 + 0.5 * chunky)
            widths = [0.55, 0.85, 1.0, 0.95, 0.7, 0.3]
            start = len(verts)
            twist = rng.uniform(0, math.tau)
            for i, (pt, share_w) in enumerate(zip(path, widths)):
                tangent = path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]
                tangent = tangent / np.linalg.norm(tangent)
                side = np.cross(tangent, np.array([0, 0, 1.0]))
                side = side / np.linalg.norm(side) if np.linalg.norm(side) > 1e-6 else np.array([1.0, 0, 0])
                up = np.cross(side, tangent)
                for q in range(sides):
                    ang = twist + math.tau * q / sides
                    # Flattened across the strand, like a hanging fringe of leaves.
                    verts.append(tuple(pt + (side * math.cos(ang) + up * math.sin(ang) * 0.55) * w * share_w))
            ends = len(path)
            verts.append(tuple(path[0] - (path[1] - path[0]) * 0.1))
            verts.append(tuple(path[-1] - np.array([0, 0, w * 0.4])))
            for ring in range(ends - 1):
                for q in range(sides):
                    c0, c1 = start + ring * sides + q, start + ring * sides + (q + 1) % sides
                    faces.append((c0, c1, c1 + sides, c0 + sides))
            capa, capb = start + ends * sides, start + ends * sides + 1
            faces += [(start + (q + 1) % sides, start + q, capa) for q in range(sides)]
            faces += [(start + (ends - 1) * sides + q, start + (ends - 1) * sides + (q + 1) % sides, capb) for q in range(sides)]
        hangs = _mesh_object(name + "_tassels", verts, faces)
        (loose if facets else leafy).append(hangs)
    elif crown == "palm":
        tp, tr = _trunk(rng, height, height * bare, radius, lean or height * rng.uniform(0.08, 0.2), flare=1.9, points=12)
        # Rings up the trunk: its radius steps in and out.
        tr = [r * (1.12 if i % 2 else 0.9) for i, r in enumerate(tr)]
        wood.append((tp, tr))
        head = tp[-1]
        count = limbs or 11
        verts, faces = [], []
        for k in range(count):
            az = k * 2.39996 + rng.uniform(-0.2, 0.2)
            tier = k % 2
            length = spread * rng.uniform(0.9, 1.15) * (1.0 if tier else 0.85)
            v, f = _frond(length, length * 0.2 * (1 + 0.4 * chunky), 0.3 if tier else 0.8, (0.5 if tier else 0.75) + droop * 0.6, facets)
            c, s_ = math.cos(az), math.sin(az)
            faces += [tuple(i + len(verts) for i in face) for face in f]
            verts += [(head[0] + x * s_ + y * c, head[1] - x * c + y * s_, head[2] + z) for x, y, z in v]
        fronds = _mesh_object(name + "_fronds", verts, faces)
        loose.append(fronds)
        solid.append(_blob(head + np.array([0, 0, radius * 0.3]), np.array([radius * 1.9] * 3), seed, rough=0.05, subdivisions=2))
    else:  # bare: a dead tree, forking
        tp, tr = _trunk(rng, height, height * (bare + 0.2), radius, lean, flare=2.0)
        wood.append((tp, tr))

        def fork(base, direction, length, r, depth):
            tip = base + direction * length
            pts, radii = _limb(rng, base, tip, r, sag=0.12, wander=0.1)
            wood.append((pts, radii))
            if depth == 0:
                return
            for _ in range(2 if depth > 1 or rng.uniform() < 0.6 else 1):
                d = direction + rng.normal(0, 0.55, 3) + np.array([0, 0, 0.25])
                fork(_along(pts, rng.uniform(0.55, 1.0)), d / np.linalg.norm(d), length * rng.uniform(0.55, 0.75), r * 0.62, depth - 1)

        for k in range(limbs or 4):
            az = k * 2.39996 + rng.uniform(-0.4, 0.4)
            d = np.array([math.cos(az) * 0.8, math.sin(az) * 0.8, rng.uniform(0.5, 1.0)])
            fork(_along(tp, rng.uniform(0.5, 1.0)), d / np.linalg.norm(d), spread * rng.uniform(0.7, 1.0), radius * 0.6, int(round(1 + 1.4 * detail)))

    parts = [_wood(name + "_wood", wood, lk, colours)]
    low = height * bare if crown not in ("bush",) else 0.0
    if solid and crown == "palm":
        heart = _fuse(name + "_heart", solid, radius * 0.5, 60)
        heart.data.materials.clear()
        heart.data.materials.append(_material("bark", colours, lk))
        _shade(heart, facets)
        parts.append(heart)
        solid = []
    if solid:
        big = spread
        hull = _fuse(name + "_crown", solid, big / (7 if facets else 10), int((260 if facets else 700) * (0.6 + 0.8 * detail) * max(0.5, min(1.0, density))))
        if facets:
            _shade(hull, True)
            loose.append(hull)
        else:
            leafy.append(hull)
    for hull in leafy:
        # Soft: the hull itself is the crown's dark inside, and leaves lie over it.
        _shade(hull, False, 180)
        size = max(spread * {"cone": 0.24, "bush": 0.3}.get(crown, 0.2), 0.16) * (1.25 - 0.5 * detail)
        strand = hull.name.endswith("_tassels")  # long narrow leaves hanging close along a strand
        leaf = _leaf(size * (2.4 if strand else 1.4 if crown != "cone" else 2.2), size * (0.4 if strand else 1.2 if crown != "cone" else 0.7))
        area = sum(p.area for p in hull.data.polygons)
        leaves = _tufts(hull.name + "_leaves", hull, int(area / (size * size * (1.7 if strand else 0.5)) * max(0.3, density)), leaf, seed,
                        lift=0.18 if strand else 0.5 if crown != "cone" else 0.4, facing=-0.85)
        leaf_mesh = leaf.data
        bpy.data.objects.remove(leaf)
        bpy.data.meshes.remove(leaf_mesh)
        zs = [v.co.z for v in hull.data.vertices]
        _lit(leaves, lk, colours, low=min(zs), high=max(zs))
        parts.append(leaves)
        if strand:  # a strand is its leaves alone
            strand_mesh = hull.data
            bpy.data.objects.remove(hull)
            bpy.data.meshes.remove(strand_mesh)
            continue
        hull.data.materials.clear()
        hull.data.materials.append(_material("leaf", colours, lk))
        if not lk["palette"]:
            _lit(hull, lk, colours, low=min(zs), high=max(zs) + (max(zs) - min(zs)) * 0.8)
        parts.append(hull)
    for o in loose:
        if not facets:
            # Soft tassels, fronds and boughs: smooth, their normals bent outward from the crown's
            # middle (Blender's Normal Edit modifier, radial), so each mass shades as one.
            _shade(o, False, 180)
            ne = o.modifiers.new("soft", "NORMAL_EDIT")
            ne.mode = "RADIAL"
            ne.mix_factor = 0.55
            ne.offset = (lean * 0.5, 0.0, low + (height - low) * 0.35)
            o = _apply(o)
            if crown == "palm" and not lk["palette"]:
                o = _two_sided(o)
        else:
            _shade(o, True)
        _lit(o, lk, colours)
        parts.append(o)
    out = _wrap(_join(name, parts))
    out["kurambit_world"] = json.dumps({"kind": "tree", "crown": crown, "height": height, "seed": seed})
    return out


def plants(name, kind="grass", *, size=0.5, count=7, spread=0.5, seed=1, colours=None):
    """A patch of low plants to scatter over the ground (M.scatter in the game's code), standing at
    the origin. kind: "grass" (a tuft of blades), "reeds" (tall thin stems), "fern" (arching
    fronds from one root) or "flowers" (stems with heads: colour role `flower`, else pass it).
    size: their height in metres; count: how many in the patch; spread: its radius. Colour
    roles: grass, grass2."""
    lk = look.read()
    rng = np.random.default_rng(seed)
    facets = lk["facets"]
    verts, faces, heads = [], [], []
    if kind not in ("grass", "reeds", "fern", "flowers"):
        raise ValueError(f'plants kind is "grass", "reeds", "fern" or "flowers", not {kind!r}')
    for k in range(count):
        az, r = rng.uniform(0, math.tau), spread * math.sqrt(rng.uniform(0, 1))
        root = np.array([math.cos(az) * r, math.sin(az) * r, 0.0])
        face = rng.uniform(0, math.tau)
        h = size * rng.uniform(0.6, 1.15)
        if kind == "fern":
            v, f = _frond(h * 1.5, h * 0.3, 0.9, 0.9, facets)
            c, s_ = math.cos(face), math.sin(face)
            faces += [tuple(i + len(verts) for i in fc) for fc in f]
            verts += [(root[0] * 0.15 + x * s_ + y * c, root[1] * 0.15 - x * c + y * s_, z + h * 0.1) for x, y, z in v]
            continue
        # A blade: a tapering strip bending over to one side, two faces wide so it has a fold.
        w = h * {"grass": 0.11, "reeds": 0.035, "flowers": 0.03}[kind] * (1 + 0.6 * lk["chunky"])
        lean = np.array([math.cos(face), math.sin(face), 0.0]) * h * {"grass": 0.45, "reeds": 0.15, "flowers": 0.2}[kind] * rng.uniform(0.4, 1.2)
        side = np.array([-math.sin(face), math.cos(face), 0.0])
        steps = 3
        start = len(verts)
        for j in range(steps + 1):
            t = j / steps
            mid = root + lean * t * t + np.array([0, 0, h * t])
            ww = w * (1 - t * 0.85)
            verts += [tuple(mid - side * ww), tuple(mid + lean / h * ww * 0.6), tuple(mid + side * ww)]
        for j in range(steps):
            a = start + j * 3
            faces += [(a, a + 1, a + 4, a + 3), (a + 1, a + 2, a + 5, a + 4)]
        if kind == "flowers":
            heads.append(root + lean + np.array([0, 0, h]))
    o = _mesh_object(name, verts, faces)
    old = bpy.data.objects.get(name)
    _shade(o, facets, 180)
    if not facets and not lk["palette"]:
        # Blades shade as the ground does: their normals mostly up, so a patch is one soft tuft.
        ne = o.modifiers.new("soft", "NORMAL_EDIT")
        ne.mode = "RADIAL"
        ne.mix_factor = 0.8
        ne.offset = (0.0, 0.0, -size * 2.5)
        o = _two_sided(_apply(o))
    _lit(o, lk, colours, dark="grass", light="grass2", low=0.0, high=size)
    parts = [o]
    if heads:
        bm = bmesh.new()
        for hd in heads:
            made = bmesh.ops.create_icosphere(bm, subdivisions=1, radius=size * 0.13)
            for v in made["verts"]:
                v.co = Vector((v.co.x, v.co.y, v.co.z * 0.6)) + Vector(hd)
        me = bpy.data.meshes.new(name + "_heads")
        bm.to_mesh(me)
        bm.free()
        hd = bpy.data.objects.new(name + "_heads", me)
        bpy.context.scene.collection.objects.link(hd)
        given = (colours or {}).get("flower")
        me.materials.append(given if isinstance(given, bpy.types.Material) else helpers.material(given or (look.colour("flower", lk) if "flower" in lk["roles"] else "#e8c84a"), name="Flower"))
        _shade(hd, facets)
        parts.append(hd)
    out = _join(name, parts)
    out["kurambit_world"] = json.dumps({"kind": "plants", "plants": kind, "seed": seed})
    return out


# ---- rocks and cliffs ---------------------------------------------------------------------------

def _stone(o, lk, colours, moss, top):
    """A rock's colours: stone, a darker stone under overhangs and low against the ground, and moss
    (or grass: any role) on what faces the sky near its top."""
    me = o.data
    me.materials.clear()
    for r in ("stone", "stone2", "moss"):
        me.materials.append(_material(r, colours, lk))
    for p in me.polygons:
        if moss > 0 and p.normal.z > 0.8 - moss * 0.35 and p.center.z > top * (0.9 - moss * 0.75):
            p.material_index = 2
        elif p.normal.z < -0.15 or p.center.z < top * 0.07:
            p.material_index = 1
    return o


def _chisel(o, lk, width, angle=38):
    """Hard planes with worn edges: a bevel, then facets (a faceted look) or smoothing by angle."""
    b = o.modifiers.new("worn", "BEVEL")
    b.width = width
    b.segments = 1 if lk["facets"] else 2
    b.limit_method = "ANGLE"
    b.angle_limit = math.radians(25)
    o = _apply(o)
    _shade(o, lk["facets"], angle)
    return o


def rock(name, size=(2.0, 1.6, 1.2), *, sharp=0.5, strata=0.0, cracks=0.3, moss=0.0, seed=1, colours=None, facets=None, triangles=None):
    """A rock size (wide, deep, tall) metres, built of broad planes: the convex hull of a few
    points, with smaller blocks broken off beside it. sharp: 0 a rounded boulder of many small
    planes, 1 a few big angular ones; cracks: 0..1 how many blocks stand beside the main one;
    moss: 0..1 of its top in the moss colour; strata > 0 makes it a cliff (world.cliff). Flat
    under, sitting a little into the ground. `triangles` is accepted from before and ignored: the
    planes set the count. Colour roles: stone, stone2, moss."""
    if strata > 0:
        return cliff(name, size, ledge=strata, moss=moss, seed=seed, colours=colours, facets=facets)
    lk = look.read()
    if facets is not None:
        lk["facets"] = facets
    rng = np.random.default_rng(seed)
    sx, sy, sz = size
    parts = []
    blocks = [(np.zeros(3), np.array([sx, sy, sz]))]
    for k in range(int(round(cracks * 3 * (0.5 + lk["detail"])))):
        az = rng.uniform(0, math.tau)
        scale = rng.uniform(0.3, 0.55)
        blocks.append((np.array([math.cos(az) * sx * 0.42, math.sin(az) * sy * 0.42, 0.0]), np.array([sx, sy, sz]) * scale))
    for k, (at, dims) in enumerate(blocks):
        count = int(round(26 - 16 * sharp))
        p = 2.0 + sharp * 3.0
        pts = rng.normal(0, 1, (count, 3))
        pts = pts / (np.sum(np.abs(pts) ** p, axis=1, keepdims=True) ** (1 / p))
        pts *= rng.uniform(0.82, 1.0, (count, 1))
        pts[:, 2] = np.abs(pts[:, 2]) * 1.0 - 0.12  # a dome, its foot below the ground
        pts = pts * dims * np.array([0.5, 0.5, 1.0]) + at
        # A slant and a twist, so no rock sits square to the world.
        lean = rng.normal(0, 0.12, 2)
        pts[:, 0] += pts[:, 2] * lean[0]
        pts[:, 1] += pts[:, 2] * lean[1]
        bm = bmesh.new()
        for q in pts:
            bm.verts.new(tuple(q))
        hull = bmesh.ops.convex_hull(bm, input=bm.verts)
        for v in [v for v in bm.verts if not v.link_faces]:
            bm.verts.remove(v)
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, 0, -0.04 * sz), plane_no=(0, 0, -1), clear_outer=True)
        bmesh.ops.holes_fill(bm, edges=bm.edges)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        me = bpy.data.meshes.new(f"{name}_{k}")
        bm.to_mesh(me)
        bm.free()
        o = bpy.data.objects.new(f"{name}_{k}", me)
        bpy.context.scene.collection.objects.link(o)
        parts.append(_chisel(o, lk, min(dims) * (0.035 + 0.1 * (1 - sharp))))
    out = _join(name, parts)
    _stone(out, lk, colours, moss, sz)
    _wrap(out)
    out["kurambit_world"] = json.dumps({"kind": "rock", "size": list(size), "seed": seed})
    return out


def cliff(name, size=(9.0, 3.0, 6.0), *, layers=None, ledge=0.6, moss=0.4, ends="flat", seed=1, colours=None, facets=None):
    """A cliff a level is built against: size (wide, deep, tall) metres of rock in level beds, each
    a slab whose face steps in and out in flat planes. Its top is flat to stand on, its back is
    flat, and with ends "flat" its ends are too, so pieces butt into a long wall ("rough" breaks
    them off). layers: how many beds; ledge: 0..1 how far beds step; moss: 0..1 of the top and the
    ledges in the moss colour (pass colours={"moss": "grass"} for a grassed top). It faces -Y,
    standing on the ground with its top at `tall`. Colour roles: stone, stone2, moss."""
    lk = look.read()
    if facets is not None:
        lk["facets"] = facets
    rng = np.random.default_rng(seed)
    w, d, tall = size
    layers = layers or max(3, int(round(tall / (1.5 - 0.6 * lk["detail"] + 0.5 * lk["chunky"]))))
    cuts = max(4, int(round(w / (1.7 - 0.6 * lk["detail"]))))
    xs = np.linspace(-w / 2, w / 2, cuts + 1)
    xs[1:-1] += rng.normal(0, w / cuts * 0.22, cuts - 1)
    front = -d / 2 + np.cumsum(rng.normal(0, d * 0.14, cuts + 1))
    front -= front.min() + d / 2 - 0.0
    front = np.clip(front + (-d / 2 - front.min()), -d / 2, d * 0.15)
    heights = rng.uniform(0.7, 1.3, layers)
    heights = np.concatenate([[0.0], np.cumsum(heights / heights.sum() * tall)])
    parts = []
    for k in range(layers):
        z0, z1 = heights[k], heights[k + 1]
        thick = z1 - z0
        # A bed leans back with height and steps as a whole; joints break it into blocks, each
        # standing a little proud of or behind its neighbours and a little taller or shorter.
        step = rng.uniform(-1, 1) * ledge * d * 0.1 + d * 0.42 * (k / layers) ** 1.5
        i = 0
        while i < cuts:
            j = min(cuts, i + int(rng.integers(1, 4)))
            push = step + rng.uniform(-1, 1) * ledge * d * 0.13
            face = np.clip(front[i:j + 1] + push, -d / 2, d / 2 - 0.4)
            ring = [(xs[m], face[m - i]) for m in range(i, j + 1)]
            if ends != "flat":
                if i == 0:
                    ring[0] = (xs[0] + rng.uniform(0, w / cuts * 0.7), ring[0][1])
                if j == cuts:
                    ring[-1] = (xs[-1] - rng.uniform(0, w / cuts * 0.7), ring[-1][1])
            # The block's face slopes back to its top edge, each joint by its own amount.
            upper = [(x, min(d / 2 - 0.3, y + thick * rng.uniform(0.0, 0.3))) for x, y in ring]
            back = [(ring[-1][0], d / 2), (ring[0][0], d / 2)]
            top = z1 if k == layers - 1 else z1 + rng.uniform(-0.18, 0.12) * thick
            parts.append(_prism(f"{name}_bed_{k}_{i}", ring + back, z0 - (0.3 if k == 0 else thick * 0.25), top, None, top=upper + back))
            i = j
    out = _join(name, parts)
    bm = bmesh.new()
    bm.from_mesh(out.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(out.data)
    bm.free()
    out = _chisel(out, lk, min(0.12, tall / layers * 0.12))
    _stone(out, lk, colours, moss, tall)
    # Beds alternate a little in tone, as strata do.
    for p in out.data.polygons:
        if p.material_index == 0 and abs(p.normal.z) < 0.5:
            bed = int(np.searchsorted(heights, p.center.z) - 1)
            if bed % 3 == 1:
                p.material_index = 1
    _wrap(out)
    out["kurambit_world"] = json.dumps({"kind": "cliff", "size": list(size), "seed": seed})
    return out


# ---- buildings ---------------------------------------------------------------------------------

def _box(name, lo, hi, mat):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    lo, hi = np.array(lo, dtype=float), np.array(hi, dtype=float)
    for v in bm.verts:
        v.co = Vector(((v.co.x + 0.5) * (hi[0] - lo[0]) + lo[0], (v.co.y + 0.5) * (hi[1] - lo[1]) + lo[1], (v.co.z + 0.5) * (hi[2] - lo[2]) + lo[2]))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    if mat is not None:
        me.materials.append(mat)
    return o


def _prism(name, ring, z0, z1, mat, cap=True, top=None):
    """A closed solid from a plan ring between two heights; `top` is another ring for its upper end."""
    n = len(ring)
    verts = [(x, y, z0) for x, y in ring] + [(x, y, z1) for x, y in (top or ring)]
    faces = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    if cap:
        faces += [tuple(reversed(range(n))), tuple(range(n, 2 * n))]
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    if mat is not None:
        me.materials.append(mat)
    return o


def _inset(ring, d):
    """A convex plan ring moved in by d metres (out when negative)."""
    pts = np.array(ring, dtype=float)
    c = pts.mean(axis=0)
    out = []
    n = len(pts)
    for i in range(n):
        a, b, p = pts[i - 1], pts[(i + 1) % n], pts[i]
        e1, e2 = p - a, b - p
        n1, n2 = np.array([-e1[1], e1[0]]) / np.linalg.norm(e1), np.array([-e2[1], e2[0]]) / np.linalg.norm(e2)
        if n1 @ (c - p) < 0:
            n1, n2 = -n1, -n2
        m = n1 + n2
        m = m / np.linalg.norm(m)
        out.append(tuple(p + m * d / max(0.2, float(m @ n1))))
    return out


def _slab(name, origin, turn, lo, hi, mat, lean=0.0, tip=0.0):
    """A box in a wall's own frame: x along the wall from `origin`, y into the building (outside is
    negative), z up. lean: radians it turns in the wall's plane about its low corner; tip: radians
    it tips outward about its top inner edge (an awning)."""
    from mathutils import Matrix

    o = _box(name, (0.0, lo[1], 0.0), (hi[0] - lo[0], hi[1], hi[2] - lo[2]), mat)
    local = Matrix.Translation((lo[0], 0.0, lo[2])) @ Matrix.Rotation(-lean, 4, "Y") @ Matrix.Rotation(tip, 4, "X")
    o.matrix_world = Matrix.Translation((origin[0], origin[1], 0.0)) @ Matrix.Rotation(turn, 4, "Z") @ local
    return o


def _cut(target, cutters):
    for c in cutters:
        m = target.modifiers.new("cut", "BOOLEAN")
        m.operation, m.solver, m.object = "DIFFERENCE", "EXACT", c
    return _apply(target)


def building(name, plan=(6.0, 5.0), *, floors=1, storey=2.7, wall=None, roof="gable", pitch=None, overhang=None, sides=None, openings=(),
             parapet=0, interior=True, frame=None, footing=None, chimney=None, batter=0.0, ruin=0.0, roof_part=False, seed=1, colours=None, facets=None):
    """A building you can walk into, standing at the origin, its front (side 0) facing -Y. plan:
    (wide, deep) metres, a radius with `sides` (a round tower of that many sides), or a convex
    ring of (x, y) points; floors of storey metres; wall thickness (0.25, a ruin 0.5). roof: "gable", "hip", "cone",
    "shed" or "flat" at pitch degrees with an overhang; parapet: that many battlements round a
    flat roof, on a corbelled course. What shows it was built, each on by default where it suits
    and off with False: frame (a timber frame on the walls: posts, plates, studs and braces),
    footing (metres of stone under the walls), chimney (a stone stack through the roof), eaves
    with bargeboards and a ridge, a sill and lintel at every window, a stone step at every door.
    batter: metres a tower's foot is wider than its top. ruin: 0..1 how much of the walls has
    fallen (no roof, broken tops, rubble). openings: [{"side": 0.., "at": 0..1 along that wall,
    "kind": "door"|"window"|"shop", "width", "height", "sill", "floor": 0.., "shutters": True,
    "porch": True}], sides counted counter-clockwise from above; each is cut through the wall and
    framed, a window glazed, a shop a wide counter under an awning with a hanging sign, a door
    hung as its own named part (<name>_door_N, hinged at its edge, for the game to swing).
    interior: a floor in every storey; roof_part: the roof as its own part (<name>_roof) for a
    game that lifts it when the player goes in. A doorway fits the look's character height. Colour
    roles: wall, roof, trim, floor, door, glass, stone, cloth; a role may take another's
    (colours={"wall": "stone"})."""
    lk = look.read()
    if facets is not None:
        lk["facets"] = facets
    facets, chunky, detail = lk["facets"], lk["chunky"], lk["detail"]
    rng = np.random.default_rng(seed)
    # Made again, a building takes its parts' names: the doors and roof it had before go first.
    for old in [o for o in bpy.data.objects if o.name == name + "_roof" or o.name.startswith(name + "_door_")]:
        bpy.data.objects.remove(old, do_unlink=True)
    mat = {r: _material(r, colours, lk) for r in ("wall", "roof", "trim", "floor", "glass", "door", "stone", "cloth")}
    round_plan = bool(sides)
    if sides:
        r = plan if isinstance(plan, (int, float)) else plan[0] / 2
        ring = [(r * math.sin(2 * math.pi * (k + 0.5) / sides), -r * math.cos(2 * math.pi * (k + 0.5) / sides)) for k in range(sides)]
    elif len(plan) == 2 and isinstance(plan[0], (int, float)):
        w, d = plan
        ring = [(-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2)]
    else:
        ring = [tuple(p) for p in plan]
    square = len(ring) == 4 and not round_plan
    pitch = (38.0 + 14.0 * chunky) if pitch is None else pitch
    overhang = (0.35 + 0.3 * chunky) if overhang is None else overhang
    frame = (square and roof != "flat" and detail >= 0.3) if frame is None else frame
    footing = (0.7 if round_plan else 0.55) if footing is None else (footing or 0.0)
    chimney = (roof in ("gable", "hip") and square and detail >= 0.4) if chimney is None else chimney
    ruined = ruin > 0.05
    # A ruin is what stood longest: thick masonry.
    wall = (0.5 if ruined else 0.25) if wall is None else wall
    top = floors * storey
    pts = np.array(ring, dtype=float)
    centre = pts.mean(axis=0)
    n = len(ring)
    tall_door = max(2.05, 1.16 * lk["character"])

    def side_of(k):
        a, b = pts[k % n], pts[(k + 1) % n]
        along = (b - a) / np.linalg.norm(b - a)
        outward = np.array([along[1], -along[0]])
        if outward @ (a - centre) < 0:
            outward = -outward
        return a, b, along, outward, float(np.linalg.norm(b - a)), math.atan2(along[1], along[0])

    # Walls: the plan's ring, wider at the foot by the batter, hollowed, then cut by every opening.
    foot = _inset(ring, -batter) if batter else ring
    outer = _prism(name + "_walls", foot, 0.0, top, mat["wall"], top=ring)
    inner = _prism(name + "_inner", _inset(ring, wall), -0.5, top + 0.5, None)
    cutters, door_cutters, parts, doors, spans = [inner], [], [], [], {}
    for k, op in enumerate(openings):
        a, b, along, outward, length, rot = side_of(op.get("side", 0))
        kind = op.get("kind", "window")
        ow = op.get("width", {"door": max(0.95, 0.56 * lk["character"]), "shop": min(2.4, length * 0.5)}.get(kind, 1.05))
        oh = op.get("height", {"door": tall_door, "shop": 1.45}.get(kind, 1.2))
        sill = op.get("floor", 0) * storey + (0.0 if kind == "door" else op.get("sill", 0.95))
        x0 = length * op.get("at", 0.5) - ow / 2
        spans.setdefault(op.get("side", 0) % n, []).append((x0, x0 + ow, sill, sill + oh))
        lean_out = batter * (1 - sill / max(top, 1e-6))  # how far the battered face stands out here

        def piece(nm, lo, hi, m, _a=a, _rot=rot, **kw):
            return _slab(nm, _a, _rot, lo, hi, m, **kw)

        hole = piece(f"{name}_hole_{k}", (x0, -wall - batter - 0.3, sill - (0.01 if kind == "door" else 0.0)), (x0 + ow, wall * 2, sill + oh), None)
        cutters.append(hole)
        if kind == "door":
            door_cutters.append(hole)
        if ruined and (kind != "door" or ruin > 0.45):
            continue  # a ruin keeps its holes and loses what hung in them
        f, out, back = 0.1, -0.045 - lean_out, wall * 0.55
        # The frame: lintel, jambs, and under a window a sill that stands proud.
        parts.append(piece(f"{name}_lintel_{k}", (x0 - f - 0.06, out - 0.02, sill + oh), (x0 + ow + f + 0.06, back, sill + oh + f * 1.4), mat["trim"]))
        parts.append(piece(f"{name}_jamb_{k}_l", (x0 - f, out, sill), (x0, back, sill + oh), mat["trim"]))
        parts.append(piece(f"{name}_jamb_{k}_r", (x0 + ow, out, sill), (x0 + ow + f, back, sill + oh), mat["trim"]))
        if kind == "window":
            parts.append(piece(f"{name}_sill_{k}", (x0 - f - 0.08, out - 0.09, sill - f), (x0 + ow + f + 0.08, back, sill), mat["trim" if not round_plan else "stone"]))
            parts.append(piece(f"{name}_glass_{k}", (x0, wall * 0.5 - 0.012, sill), (x0 + ow, wall * 0.5 + 0.012, sill + oh), mat["glass"]))
            bars = max(1, int(round(ow / 0.55)) - 1)
            for q in range(bars):
                xq = x0 + ow * (q + 1) / (bars + 1)
                parts.append(piece(f"{name}_bar_{k}_{q}", (xq - 0.022, wall * 0.5 - 0.03, sill), (xq + 0.022, wall * 0.5 + 0.03, sill + oh), mat["trim"]))
            parts.append(piece(f"{name}_bar_{k}_h", (x0, wall * 0.5 - 0.03, sill + oh * 0.55 - 0.022), (x0 + ow, wall * 0.5 + 0.03, sill + oh * 0.55 + 0.022), mat["trim"]))
            if op.get("shutters", detail >= 0.75 and not round_plan):
                for sgn, xs in ((-1, x0 - f - ow * 0.5), (1, x0 + ow + f)):
                    parts.append(piece(f"{name}_shutter_{k}_{sgn}", (xs, out - 0.05, sill), (xs + ow * 0.5, out, sill + oh), mat["door"]))
                    for zz in (0.18, 0.78):
                        parts.append(piece(f"{name}_shutter_{k}_{sgn}_{zz}", (xs + 0.02, out - 0.075, sill + oh * zz), (xs + ow * 0.5 - 0.02, out - 0.05, sill + oh * zz + 0.07), mat["trim"]))
        elif kind == "shop":
            # A counter on the sill, an awning over it on two brackets, and a sign hung beside it.
            parts.append(piece(f"{name}_counter_{k}", (x0 - 0.12, out - 0.32, sill - 0.07), (x0 + ow + 0.12, back, sill), mat["floor"]))
            for xs in (x0 + 0.05, x0 + ow - 0.13):
                parts.append(piece(f"{name}_bracket_{k}_{xs:.1f}", (xs, out - 0.3, sill - 0.5), (xs + 0.08, out, sill - 0.07), mat["trim"]))
            reach = 1.15
            parts.append(piece(f"{name}_awning_{k}", (x0 - 0.25, -reach, sill + oh + 0.32), (x0 + ow + 0.25, 0.0, sill + oh + 0.37), mat["cloth"], tip=math.radians(24)))
            parts.append(piece(f"{name}_valance_{k}", (x0 - 0.25, -reach * 0.93 - 0.02, sill + oh + 0.32 - reach * 0.42 - 0.2), (x0 + ow + 0.25, -reach * 0.93, sill + oh + 0.32 - reach * 0.4), mat["cloth"]))
            for xs in (x0 - 0.2, x0 + ow + 0.12):
                parts.append(piece(f"{name}_strut_{k}_{xs:.1f}", (xs, -reach * 0.9, sill + oh - 0.15), (xs + 0.06, out, sill + oh - 0.09), mat["trim"]))
            sx = min(length - 0.9, x0 + ow + 0.45)
            parts.append(piece(f"{name}_signarm_{k}", (sx, out - 0.75, sill + oh + 0.2), (sx + 0.07, out, sill + oh + 0.27), mat["trim"]))
            parts.append(piece(f"{name}_sign_{k}", (sx - 0.02, out - 0.7, sill + oh - 0.42), (sx + 0.09, out - 0.14, sill + oh + 0.1), mat["floor"]))
        if kind == "door":
            if ruin <= 0.45:
                leaf = piece(f"{name}_door_{len(doors) + 1}", (x0 + 0.02, wall * 0.3, sill + 0.02), (x0 + ow - 0.02, wall * 0.3 + 0.06, sill + oh - 0.02), mat["door"])
                extra = [piece(f"{name}_ledge_{k}_{zz}", (x0 + 0.05, wall * 0.3 - 0.03, sill + oh * zz), (x0 + ow - 0.05, wall * 0.3, sill + oh * zz + 0.12), mat["trim"]) for zz in (0.14, 0.76)]
                extra.append(piece(f"{name}_knob_{k}", (x0 + ow - 0.2, wall * 0.3 - 0.1, sill + 1.0), (x0 + ow - 0.13, wall * 0.3, sill + 1.08), mat["trim"]))
                leaf = _join(leaf.name, [leaf] + extra)
                hinge = a + along * (x0 + 0.02) - outward * (-wall * 0.3)
                doors.append((leaf, (hinge[0], hinge[1], 0.0)))
            if sill < 0.1:
                parts.append(piece(f"{name}_step_{k}", (x0 - 0.3, -0.75 - batter, -0.2), (x0 + ow + 0.3, 0.02, 0.14), mat["stone"]))
            if op.get("porch"):
                # A small roof over the door on two posts.
                for xs in (x0 - 0.42, x0 + ow + 0.3):
                    parts.append(piece(f"{name}_post_{k}_{xs:.1f}", (xs, -1.25, 0.0), (xs + 0.12, -1.13, sill + oh + 0.25), mat["trim"]))
                parts.append(piece(f"{name}_porchbeam_{k}", (x0 - 0.5, -1.28, sill + oh + 0.25), (x0 + ow + 0.5, -1.1, sill + oh + 0.37), mat["trim"]))
                parts.append(piece(f"{name}_porch_{k}", (x0 - 0.65, -1.55, sill + oh + 0.92), (x0 + ow + 0.65, 0.0, sill + oh + 1.0), mat["roof"], tip=math.radians(22)))
    walls = _cut(outer, cutters)
    solid = [walls]
    if footing > 0:
        base = _prism(name + "_footing", _inset(ring, -0.07 - batter), -0.3, footing, mat["stone"], top=_inset(ring, -0.055 - batter * (1 - footing / top)))
        base_in = _prism(name + "_footing_in", _inset(ring, wall * 0.5), -0.5, footing + 0.5, None)
        solid.append(_cut(base, [base_in] + door_cutters))
        bpy.data.objects.remove(base_in, do_unlink=True)
    else:
        solid.append(_prism(name + "_base", _inset(ring, -0.08 - batter), -0.3, 0.16, mat["stone" if round_plan else "trim"]))
    if interior:
        for fl in range(floors):
            if fl and ruin > 0.5:
                continue
            solid.append(_prism(f"{name}_floor_{fl}", _inset(ring, wall * 0.5), fl * storey - (0.12 if fl else 0.3), fl * storey + (0.0 if fl else 0.06), mat["floor"]))

    def clear(side, x0, x1, z0=0.0, z1=None):
        return not any(x0 < b + 0.12 and x1 > a - 0.12 and z0 < d + 0.1 and (z1 is None or z1 > c - 0.1) for a, b, c, d in spans.get(side, []))

    if frame:
        # A timber frame standing proud of the plaster: posts at the corners, a sill beam, a plate
        # at every storey, studs between the openings and a brace in each clear end bay.
        post, proud = 0.17 * (1 + 0.5 * chunky), 0.05
        for k in range(n):
            a, b, along, outward, length, rot = side_of(k)
            beam = lambda nm, lo, hi, **kw: parts.append(_slab(f"{name}_{nm}_{k}", a, rot, lo, hi, mat["trim"], **kw))
            for x in (0.0, length - post):
                beam(f"post{x:.0f}", (x - proud if x == 0 else x, -proud, footing), (x + post + (proud if x else 0), post, top))
            for fl in range(floors + 1):
                z = footing if fl == 0 else fl * storey - post * 0.9
                beam(f"plate{fl}", (-proud, -proud - 0.01, z), (length + proud, post * 0.6, z + post * 0.9))
            for fl in range(floors):
                z0, z1 = (footing + post * 0.9 if fl == 0 else fl * storey), (fl + 1) * storey - post * 0.9
                bays = max(2, int(round(length / (1.25 + 0.5 * chunky))))
                for j in range(1, bays):
                    x = length * j / bays - post * 0.35 + rng.normal(0, 0.03 * chunky)
                    if clear(k, x, x + post * 0.7, z0, z1):
                        beam(f"stud{fl}_{j}", (x, -proud + 0.01, z0), (x + post * 0.7, post * 0.5, z1))
                bay = length / bays
                for end, sgn in ((0.0, 1), (length, -1)):
                    x0, x1 = sorted((end + sgn * post, end + sgn * (bay - post * 0.4)))
                    if detail >= 0.5 and clear(k, x0, x1, z0, z1) and bay > 0.8:
                        run, rise = x1 - x0, (z1 - z0) * 0.86
                        ang = math.atan2(rise, run)
                        beam(f"brace{fl}_{sgn}", (x0 if sgn > 0 else x1, -proud + 0.02, z0 + 0.02), ((x0 if sgn > 0 else x1) + math.hypot(run, rise), post * 0.4, z0 + 0.02 + post * 0.55),
                             lean=ang if sgn > 0 else math.pi - ang)
    if round_plan and floors > 1 and detail >= 0.3:
        # A tower's string courses: a band of stone at every floor.
        for fl in range(1, floors):
            share = 1 - fl * storey / top
            solid.append(_prism(f"{name}_course_{fl}", _inset(ring, -0.07 - batter * share), fl * storey - 0.1, fl * storey + 0.08, mat["stone"]))

    def battlements(z, count):
        """A parapet carried out past the wall on a corbelled course, `count` merlons round it."""
        ext = _inset(ring, -0.22)
        solid.append(_prism(name + "_corbel", ext, z - 0.42, z + 0.02, mat["wall"], top=None))
        solid.append(_prism(name + "_corbel_low", _inset(ring, -0.1), z - 0.7, z - 0.42, mat["stone"]))
        per = [np.linalg.norm(np.array(ext[(i + 1) % n]) - np.array(ext[i])) for i in range(n)]
        step = sum(per) / count
        walk = 0.0
        for i in range(n):
            p0, p1 = np.array(ext[i]), np.array(ext[(i + 1) % n])
            e = (p1 - p0) / per[i]
            inward = np.array([-e[1], e[0]])
            if inward @ (centre - p0) < 0:
                inward = -inward
            deep = wall + 0.2
            solid.append(_prism(f"{name}_curb_{i}", [tuple(p0), tuple(p1), tuple(p1 + inward * deep), tuple(p0 + inward * deep)], z, z + 0.5, mat["wall"]))
            s_ = (-walk) % step
            while s_ + step * 0.5 <= per[i] + 1e-6:
                q0, q1 = p0 + e * s_, p0 + e * min(per[i], s_ + step * 0.5)
                solid.append(_prism(f"{name}_merlon_{i}_{int(s_ * 100)}", [tuple(q0), tuple(q1), tuple(q1 + inward * deep), tuple(q0 + inward * deep)], z + 0.5, z + 1.1, mat["wall"]))
                s_ += step
            walk += per[i]

    # The roof.
    roof_parts = []
    eave = _inset(ring, -overhang)
    ep = np.array(eave)
    lo, hi = pts.min(axis=0), pts.max(axis=0)
    long_x = (hi[0] - lo[0]) >= (hi[1] - lo[1])
    half_w = ((hi[1] - lo[1]) if long_x else (hi[0] - lo[0])) / 2
    ridge_h = half_w * math.tan(math.radians(pitch))
    thick = 0.14 + 0.08 * chunky
    if ruined:
        pass
    elif roof == "flat":
        solid.append(_prism(name + "_roof", _inset(ring, wall * 0.5), top - 0.15, top, mat["floor"]))
        if parapet:
            battlements(top, parapet)
    elif roof == "cone" or (roof == "hip" and not square):
        base_ring, base_z = ring, top
        if round_plan and detail >= 0.3:
            # A tower's top: battlements on corbels round a lookout set in behind them, and the cap
            # on the lookout, its eaves reaching out past the battlements.
            battlements(top, max(6, n if n % 2 == 0 else n + 1))
            base_ring = _inset(ring, wall + 0.12)
            look_h = min(storey * 0.75, 2.3)
            solid.append(_prism(name + "_lookout", base_ring, top - 0.1, top + look_h, mat["wall"]))
            post = 0.16 * (1 + 0.5 * chunky)
            for i, (x, y) in enumerate(_inset(base_ring, -0.04)):
                d = np.array([x, y]) - centre
                d = d / np.linalg.norm(d)
                q = np.array([-d[1], d[0]]) * post / 2
                c0, c1 = np.array([x, y]), np.array([x, y]) - d * post
                parts.append(_prism(f"{name}_lookpost_{i}", [tuple(c0 - q), tuple(c0 + q), tuple(c1 + q), tuple(c1 - q)], top + 1.1, top + look_h, mat["trim"]))
            parts.append(_prism(name + "_lookplate", _inset(base_ring, -0.07), top + look_h - 0.24, top + look_h, mat["trim"]))
            base_z = top + look_h
            eave = _inset(base_ring, -(wall + 0.12 + 0.22 + overhang))
            ep = np.array(eave)
        reach = float(np.max(np.linalg.norm(ep - centre, axis=1)))
        apex_h = reach * math.tan(math.radians(pitch))
        # A kick at the eaves: the lowest part of the roof flares out flatter, as a tower's cap does.
        kick = [(x, y, base_z - 0.02) for x, y in eave]
        mid = [(centre[0] + (x - centre[0]) * 0.72, centre[1] + (y - centre[1]) * 0.72, base_z + apex_h * (0.16 + 0.1 * (1 - chunky))) for x, y in eave]
        m = len(eave)
        verts = kick + mid + [(centre[0], centre[1], base_z + apex_h)] + [(x, y, base_z - thick) for x, y in eave]
        faces = [(i, (i + 1) % m, m + (i + 1) % m, m + i) for i in range(m)] + [(m + i, m + (i + 1) % m, 2 * m) for i in range(m)]
        faces += [(2 * m + 1 + (i + 1) % m, 2 * m + 1 + i, i, (i + 1) % m) for i in range(m)] + [tuple(2 * m + 1 + i for i in range(m))]
        roof_parts.append(_mesh_object(name + "_roof", verts, faces))
        roof_parts[-1].data.materials.append(mat["roof"])
        if detail >= 0.3:
            # A fascia under the eave: the cap has an edge you can see.
            roof_parts.append(_prism(name + "_fascia", _inset(eave, 0.02), base_z - thick - 0.12, base_z - thick + 0.01, mat["trim"], top=_inset(eave, 0.02)))
            if base_ring is ring:
                # Two corbelled courses step the wall out to meet the eaves.
                for step_out, z0, z1 in ((0.1, top - 0.62, top - 0.36), (0.22, top - 0.36, top - 0.1)):
                    solid.append(_prism(f"{name}_corbel_{step_out}", _inset(ring, -step_out), z0, z1, mat["stone"]))
    else:
        e_lo, e_hi = ep.min(axis=0), ep.max(axis=0)
        # Along the ridge (u) and across it (v): a gable or hip roof lofted over three sections, so
        # the ridge can sag and the eaves kick out, as an old roof's do.
        u0, u1 = (e_lo[0], e_hi[0]) if long_x else (e_lo[1], e_hi[1])
        v0, v1 = (e_lo[1], e_hi[1]) if long_x else (e_lo[0], e_hi[0])
        vc, half = (v0 + v1) / 2, (v1 - v0) / 2
        rise = half * math.tan(math.radians(pitch)) * (2 if roof == "shed" else 1)
        sag = 0.035 * chunky * (u1 - u0)
        kick = 0.22 if roof != "shed" else 0.0
        run_in = half if roof == "hip" else 0.0
        to_xyz = (lambda u, v, z: (u, v, z)) if long_x else (lambda u, v, z: (v, u, z))
        sections = [u0, (u0 + u1) / 2, u1]
        prof = [(-1.0, 0.0), (-1.0 + kick, kick * 0.55), (0.0, 1.0), (1.0 - kick, kick * 0.55), (1.0, 0.0)] if roof != "shed" else [(-1.0, 0.0), (1.0, 1.0)]
        verts, faces = [], []
        for si, u in enumerate(sections):
            dip = sag if si == 1 else 0.0
            for pv, pz in prof:
                uu = u
                if roof == "hip" and si != 1:
                    uu = u + (run_in * pz if si == 0 else -run_in * pz)
                verts.append(to_xyz(uu, vc + pv * half, top - 0.02 + pz * rise - dip * pz))
        m = len(prof)
        for si in range(2):
            for j in range(m - 1):
                a0, b0 = si * m + j, si * m + j + 1
                faces.append((a0, b0, b0 + m, a0 + m) if long_x else (a0, a0 + m, b0 + m, b0))
        under = len(verts)
        verts += [to_xyz(u0, v0, top - thick), to_xyz(u1, v0, top - thick), to_xyz(u1, v1, top - thick), to_xyz(u0, v1, top - thick)]
        faces.append((under, under + 3, under + 2, under + 1) if long_x else (under, under + 1, under + 2, under + 3))
        # Close the ends and the eaves between the lofted top and the flat underside.
        faces.append(tuple([under] + list(range(0, m)) + [under + 3]) if long_x else tuple([under + 3] + list(range(m - 1, -1, -1)) + [under]))
        faces.append(tuple([under + 2] + list(range(3 * m - 1, 2 * m - 1, -1)) + [under + 1]) if long_x else tuple([under + 1] + list(range(2 * m, 3 * m)) + [under + 2]))
        faces.append((under, under + 1, 2 * m, m, 0) if long_x else (0, m, 2 * m, under + 1, under))
        faces.append((under + 2, under + 3, m - 1, 2 * m - 1, 3 * m - 1) if long_x else (3 * m - 1, 2 * m - 1, m - 1, under + 3, under + 2))
        rf = _mesh_object(name + "_roof", verts, faces)
        bm = bmesh.new()
        bm.from_mesh(rf.data)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(rf.data)
        bm.free()
        rf.data.materials.append(mat["roof"])
        roof_parts.append(rf)
        if roof == "gable":
            gh = ridge_h
            for end in (0, 1):
                if long_x:
                    x = lo[0] if end == 0 else hi[0] - wall
                    tri = [(x, lo[1], top), (x, hi[1], top), (x, (lo[1] + hi[1]) / 2, top + gh)]
                    tri2 = [(x + wall, q[1], q[2]) for q in tri]
                else:
                    y = lo[1] if end == 0 else hi[1] - wall
                    tri = [(lo[0], y, top), (hi[0], y, top), ((lo[0] + hi[0]) / 2, y, top + gh)]
                    tri2 = [(q[0], y + wall, q[2]) for q in tri]
                g = _mesh_object(name + "_gable", tri + tri2, [(0, 1, 2), (5, 4, 3), (0, 3, 4, 1), (1, 4, 5, 2), (2, 5, 3, 0)])
                g.data.materials.append(mat["wall"])
                solid.append(g)
                if frame:
                    # The gable's own timbers: a tie beam, a king post, and two struts.
                    k_side = (3 if end == 0 else 1) if long_x else (0 if end == 0 else 2)
                    a, b, along, outward, length, rot = side_of(k_side)
                    post = 0.17 * (1 + 0.5 * chunky)
                    parts.append(_slab(f"{name}_tie_{end}", a, rot, (-0.05, -0.06, top - post * 0.5), (length + 0.05, post * 0.5, top + post * 0.4), mat["trim"]))
                    parts.append(_slab(f"{name}_king_{end}", a, rot, (length / 2 - post * 0.35, -0.05, top + post * 0.4), (length / 2 + post * 0.35, post * 0.5, top + gh - 0.15), mat["trim"]))
                    if detail >= 0.5:
                        for sgn in (1, -1):
                            run = length * 0.24
                            ang = math.atan2(gh * 0.45, run)
                            x = length / 2 - sgn * (run + post * 0.3)
                            parts.append(_slab(f"{name}_strut_{end}_{sgn}", a, rot, (x, -0.04, top + post * 0.4), (x + math.hypot(run, gh * 0.45), post * 0.4, top + post * 0.4 + post * 0.5), mat["trim"],
                                               lean=ang if sgn > 0 else math.pi - ang))
            # Bargeboards along the gable's edges and a ridge beam: the roof has an edge you can see.
            if detail >= 0.3:
                slope = math.hypot(half, rise)
                ang = math.atan2(rise, half)
                thick_b, deep_b = 0.08 + 0.07 * chunky, 0.2 + 0.16 * chunky
                for u in (u0, u1 - thick_b):
                    for sgn in (1, -1):
                        origin = to_xyz(u, vc - sgn * half, 0)[:2]
                        turn = (math.pi / 2 if long_x else 0.0) + (0.0 if sgn > 0 else math.pi)
                        board = _slab(f"{name}_barge_{u:.1f}_{sgn}", origin, turn, (0.0, -thick_b / 2, top - deep_b), (slope * 1.0, thick_b / 2, top - 0.02), mat["trim"], lean=ang)
                        roof_parts.append(board)
                # A fascia board under each eave closes the roof's low edge.
                for sgn in (1, -1):
                    origin = to_xyz(u0, vc - sgn * (half - 0.03), 0)[:2]
                    roof_parts.append(_slab(f"{name}_fascia_{sgn}", origin, 0.0 if long_x else math.pi / 2, (0.0, -0.04, top - thick - 0.06), (u1 - u0, 0.04, top - 0.01), mat["trim"]))
                ridge = _mesh_object(name + "_ridge", [to_xyz(u, vc + dv, top + rise + dz - (sag if q == 1 else 0)) for q, u in enumerate(sections) for dv, dz in ((-0.09, -0.07), (0.09, -0.07), (0.09, 0.05), (-0.09, 0.05))],
                                     [(4 * q + j, 4 * q + (j + 1) % 4, 4 * q + 4 + (j + 1) % 4, 4 * q + 4 + j) for q in range(2) for j in range(4)] + [(3, 2, 1, 0), (8, 9, 10, 11)])
                bm = bmesh.new()
                bm.from_mesh(ridge.data)
                bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
                bm.to_mesh(ridge.data)
                bm.free()
                ridge.data.materials.append(mat["trim"])
                roof_parts.append(ridge)
        if chimney:
            # A stone stack through the roof, a third of the way along the ridge, capped, with a pot.
            cu, cv = u0 + (u1 - u0) * 0.3, vc + half * 0.28
            w_, base_z = 0.62 * (1 + 0.3 * chunky), top - 0.1
            tip_z = top + rise + 0.55 + 0.3 * chunky
            cx, cy = to_xyz(cu, cv, 0)[:2]
            lean = rng.normal(0, 0.02 * chunky, 2)
            stack = _prism(name + "_chimney", [(cx - w_ / 2, cy - w_ / 2), (cx + w_ / 2, cy - w_ / 2), (cx + w_ / 2, cy + w_ / 2), (cx - w_ / 2, cy + w_ / 2)], base_z, tip_z, mat["stone"],
                           top=[(cx - w_ * 0.42 + lean[0], cy - w_ * 0.42 + lean[1]), (cx + w_ * 0.42 + lean[0], cy - w_ * 0.42 + lean[1]), (cx + w_ * 0.42 + lean[0], cy + w_ * 0.42 + lean[1]), (cx - w_ * 0.42 + lean[0], cy + w_ * 0.42 + lean[1])])
            cap = _box(name + "_chimney_cap", (cx - w_ * 0.5 + lean[0], cy - w_ * 0.5 + lean[1], tip_z), (cx + w_ * 0.5 + lean[0], cy + w_ * 0.5 + lean[1], tip_z + 0.1), mat["stone"])
            pot = _prism(name + "_chimney_pot", [(cx + lean[0] + 0.13 * math.cos(q * math.tau / 6), cy + lean[1] + 0.13 * math.sin(q * math.tau / 6)) for q in range(6)], tip_z + 0.1, tip_z + 0.42, mat["roof"])
            roof_parts += [stack, cap, pot]
    if ruined:
        # Fallen walls: every stretch of wall is broken off at its own height, lower with more
        # ruin, and stepped down course by course as laid stone falls, not sawn; the stone lies
        # in heaps at the foot of what fell, and moss grows on all of it that faces the sky.
        course = 0.3 + 0.12 * chunky
        breakers, heaps = [], []
        for k in range(n):
            a, b, along, outward, length, rot = side_of(k)
            chunks = max(2, int(round(length / 1.1)))
            level = top * (1 - ruin * rng.uniform(0.25, 0.95))
            for j in range(chunks):
                level = float(np.clip(level + rng.normal(0, top * 0.16), top * (1 - ruin) * 0.35 + 0.4, top + 0.3))
                if level >= top:
                    continue
                x0, x1 = length * j / chunks, length * (j + 1) / chunks
                steps = max(2, int(round((x1 - x0) / (course * 1.5))))
                fall = 1 if rng.uniform() < 0.5 else -1
                for q in range(steps):
                    # Each stone's width a course and a half; the stair leans toward one side.
                    lvl = level + fall * course * (q - steps / 2) * rng.uniform(0.6, 1.2)
                    lvl = max(course, round(lvl / course) * course)
                    xa, xb = x0 + (x1 - x0) * q / steps - 0.004, x0 + (x1 - x0) * (q + 1) / steps + 0.004
                    breakers.append(_slab(f"{name}_break_{k}_{j}_{q}", a, rot, (xa, -wall - 0.6, lvl), (xb, wall * 2 + 0.4, top + 3.0), None))
                volume = (top - level) * (x1 - x0)
                if volume > 1.2 and rng.uniform() < 0.7:
                    mid = a + along * (x0 + x1) / 2
                    heaps.append((mid - outward * rng.uniform(0.3, 0.8) if rng.uniform() < 0.7 else mid + outward * (wall + rng.uniform(0.4, 0.9)), volume))
        walls = _cut(walls, breakers)
        if frame or footing:
            pieces = _cut(_join(name + "_timbers", [p for p in parts]), breakers) if parts else None
            parts = [pieces] if pieces is not None else []
        for bk in breakers:
            bpy.data.objects.remove(bk, do_unlink=True)
        solid[0] = walls
        moss = _material("moss", colours, lk)
        stones = []
        for h, (at, volume) in enumerate(heaps):
            # A low mound of earth and small stone, and the dressed blocks on it.
            reach = min(1.6, 0.5 + 0.35 * volume)
            mound = _blob((at[0], at[1], -reach * 0.25), (reach, reach * 0.8, reach * 0.45), seed * 13 + h, rough=0.25, subdivisions=1 if facets else 2)
            mound.data.materials.append(mat["stone"])
            stones.append(mound)
            for j in range(int(np.clip(round(volume * 1.5 * ruin), 2, 7))):
                size = course * rng.uniform(0.9, 1.6)
                off = rng.normal(0, reach * 0.4, 2)
                lift = max(0.0, reach * 0.3 * (1 - np.linalg.norm(off) / reach))
                block = _box(f"{name}_rubble_{h}_{j}", (-size / 2, -size * 0.35, -size * 0.2), (size / 2, size * 0.35, size * 0.45), mat["wall" if rng.uniform() < 0.6 else "stone"])
                block.location = (at[0] + off[0], at[1] + off[1], lift)
                block.rotation_euler = (rng.normal(0, 0.3), rng.normal(0, 0.3), rng.uniform(0, math.tau))
                stones.append(block)
        for o in [walls] + stones:
            o.data.materials.append(moss)
            mi = len(o.data.materials) - 1
            mw = o.matrix_world
            for poly in o.data.polygons:
                if (mw.to_3x3() @ poly.normal).z > 0.75 and (mw @ poly.center).z > 0.2:
                    poly.material_index = mi
        solid += stones
    for c in cutters:
        bpy.data.objects.remove(c, do_unlink=True)
    body = solid + parts + ([] if roof_part else roof_parts)
    out = _join(name, body)
    done = [out] + ([_join(name + "_roof", roof_parts)] if roof_part and roof_parts else []) + [d for d, _ in doors]
    for i, o in enumerate(done):
        bm = bmesh.new()
        bm.from_mesh(o.data)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(o.data)
        bm.free()
        if lk["bevel"] > 0:
            bev = o.modifiers.new("bevel", "BEVEL")
            bev.width = lk["bevel"]
            bev.segments = 1  # one cut: a building is hundreds of timbers, and a rounder edge triples its triangles
            bev.limit_method = "ANGLE"
            bev.angle_limit = math.radians(50)
            o = done[i] = _apply(o)
        _shade(o, facets, 30)
        _wrap(o)
    out = done[0]
    for o in done[1:]:
        at = next((h for d, h in doors if d.name == o.name), None)
        helpers.pivot(o, at if at is not None else out.matrix_world.translation, parent=out)
    out["kurambit_world"] = json.dumps({"kind": "building", "floors": floors, "doors": [d.name for d, _ in doors], "roof": name + "_roof" if roof_part and roof_parts else None})
    return out
