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
        tp, tr = _trunk(rng, height, height * (bare + 0.12), radius, lean * 0.5, flare=1.9)
        wood.append((tp, tr))
        count = limbs or 7
        crest = height * 0.93
        solid.append(_blob(np.array([lean * 0.5, 0, crest - spread * 0.34]), np.array([spread * 0.6, spread * 0.6, spread * 0.46]), seed))
        tassel = []
        for k in range(count):
            az = k * math.tau / count + rng.uniform(-0.25, 0.25)
            out = np.array([math.cos(az), math.sin(az), 0.0])
            reach = spread * rng.uniform(0.8, 1.0)
            start = _along(tp, rng.uniform(0.8, 1.0))
            apex = start + out * reach * 0.5 + np.array([0, 0, crest - start[2] - spread * 0.12])
            tip = start + out * reach + np.array([0, 0, (crest - start[2]) * (1 - droop * 0.75)])
            pts = [start, start * 0.4 + apex * 0.6 + np.array([0, 0, spread * 0.1]), apex, apex * 0.45 + tip * 0.55 + np.array([0, 0, spread * 0.08]), tip]
            wood.append((pts, [radius * 0.4 * (1 - 0.8 * j / 4) for j in range(5)]))
            solid.append(_blob(apex + out * reach * 0.1 - np.array([0, 0, spread * 0.16]), np.array([reach * 0.42, reach * 0.42, spread * 0.34]), seed * 7 + k))
            # Tassels hang from the limb's outer half and its tip, to different lengths.
            for j in range(max(3, int(round(9 * density)))):
                t = rng.uniform(0.4, 1.0)
                hang = _along(pts, t) + rng.normal(0, reach * 0.11, 3) * np.array([1, 1, 0.15])
                floor = height * rng.uniform(0.06, 0.34)
                tassel.append((hang, max(0.5, hang[2] - floor), rng.uniform(0.7, 1.3)))
        verts, faces = [], []
        sides = 5 if facets else 7
        for hang, length, fat in tassel:
            w = min(length * 0.085, spread * 0.1) * fat
            start = len(verts)
            prof = [(0.25, 0.0), (0.8, 0.14), (1.0, 0.45), (0.55, 0.82)]
            twist = rng.uniform(0, math.tau)
            for share, t in prof:
                for q in range(sides):
                    a = twist + math.tau * q / sides
                    verts.append((hang[0] + math.cos(a) * w * share, hang[1] + math.sin(a) * w * share * 0.8, hang[2] + w * 0.4 - length * t))
            verts.append((hang[0], hang[1], hang[2] + w * 0.6))
            verts.append((hang[0] + rng.normal(0, w * 0.2), hang[1] + rng.normal(0, w * 0.2), hang[2] - length))
            for ring in range(len(prof) - 1):
                for q in range(sides):
                    a, b = start + ring * sides + q, start + ring * sides + (q + 1) % sides
                    faces.append((a, b, b + sides, a + sides))
            capa, capb = start + len(prof) * sides, start + len(prof) * sides + 1
            faces += [(start + (q + 1) % sides, start + q, capa) for q in range(sides)]
            faces += [(start + (len(prof) - 1) * sides + q, start + (len(prof) - 1) * sides + (q + 1) % sides, capb) for q in range(sides)]
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


def building(name, plan=(6.0, 5.0), *, floors=1, storey=2.7, wall=0.25, roof="gable", pitch=40.0, overhang=0.4, sides=None, openings=(),
             parapet=0, interior=True, colours=None, facets=None):
    """A building you can walk into. plan: (wide, deep) metres, a radius with `sides` (a round
    tower of that many sides), or a convex ring of (x, y) points; floors of storey metres; wall
    thickness; roof: "gable", "hip", "cone", "shed" or "flat" at pitch degrees with an overhang;
    parapet: that many battlements round a flat roof. openings: [{"side": 0.., "at": 0..1 along
    that wall, "kind": "door"|"window", "width", "height", "sill", "floor": 0..}], side 0 the
    front (-Y) on a rectangle and counted counter-clockwise from above; each is cut through the
    wall and framed, a window glazed, a door hung as its own named part (<name>_door_N, hinged
    at its edge, for the game to swing). interior: a floor in every storey. Colours by role:
    wall, roof, trim, floor, glass, door. Returns the building's object."""
    lk = look.read()
    facets = lk["facets"] if facets is None else facets
    mat = {r: _material(r, colours, lk) for r in ("wall", "roof", "trim", "floor", "glass", "door")}
    if sides:
        r = plan if isinstance(plan, (int, float)) else plan[0] / 2
        ring = [(r * math.sin(2 * math.pi * (k + 0.5) / sides), -r * math.cos(2 * math.pi * (k + 0.5) / sides)) for k in range(sides)]
    elif len(plan) == 2 and isinstance(plan[0], (int, float)):
        w, d = plan
        ring = [(-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2)]
    else:
        ring = [tuple(p) for p in plan]
    top = floors * storey
    outer = _prism(name + "_walls", ring, 0.0, top, mat["wall"])
    inner = _prism(name + "_inner", _inset(ring, wall), -0.5, top + 0.5, mat["wall"])
    cut = outer.modifiers.new("room", "BOOLEAN")
    cut.operation = "DIFFERENCE"
    cut.solver = "EXACT"
    cut.object = inner
    parts, doors, cutters = [], [], [inner]
    pts = np.array(ring, dtype=float)
    for k, op in enumerate(openings):
        a, b = pts[op.get("side", 0) % len(pts)], pts[(op.get("side", 0) + 1) % len(pts)]
        along = (b - a) / np.linalg.norm(b - a)
        outward = np.array([along[1], -along[0]])
        if outward @ (a - pts.mean(axis=0)) < 0:
            outward = -outward
        kind = op.get("kind", "window")
        ow = op.get("width", 1.0 if kind == "door" else 1.1)
        oh = op.get("height", 2.1 if kind == "door" else 1.2)
        sill = op.get("floor", 0) * storey + (0.0 if kind == "door" else op.get("sill", 0.95))
        mid = a + (b - a) * op.get("at", 0.5) - outward * wall / 2
        rot = math.atan2(along[1], along[0])

        def piece(nm, lo, hi, m, _mid=mid, _rot=rot):
            o = _box(nm, lo, hi, m)
            o.rotation_euler = (0, 0, _rot)
            o.location = (_mid[0], _mid[1], 0)
            return o

        hole = piece(f"{name}_hole_{k}", (-ow / 2, -wall, sill + (0.0 if kind == "window" else -0.01)), (ow / 2, wall, sill + oh), None)
        m = outer.modifiers.new(f"hole{k}", "BOOLEAN")
        m.operation = "DIFFERENCE"
        m.solver = "EXACT"
        m.object = hole
        cutters.append(hole)
        f, depth = 0.09, wall / 2 + 0.04
        frame = [((-ow / 2 - f, -depth, sill + oh), (ow / 2 + f, depth, sill + oh + f)), ((-ow / 2 - f, -depth, sill), (-ow / 2, depth, sill + oh)),
                 ((ow / 2, -depth, sill), (ow / 2 + f, depth, sill + oh))]
        if kind == "window":
            frame.append(((-ow / 2 - f - 0.04, -depth - 0.05, sill - f), (ow / 2 + f + 0.04, depth, sill)))
            frame += [((-0.025, -0.03, sill), (0.025, 0.03, sill + oh)), ((-ow / 2, -0.03, sill + oh / 2 - 0.025), (ow / 2, 0.03, sill + oh / 2 + 0.025))]
            parts.append(piece(f"{name}_glass_{k}", (-ow / 2, -0.012, sill), (ow / 2, 0.012, sill + oh), mat["glass"]))
        for i, (lo, hi) in enumerate(frame):
            parts.append(piece(f"{name}_frame_{k}_{i}", lo, hi, mat["trim"]))
        if kind == "door":
            leaf = piece(f"{name}_door_{len(doors) + 1}", (0.0, -0.03, sill + 0.02), (ow - 0.04, 0.03, sill + oh - 0.02), mat["door"])
            hinge = mid - along * (ow / 2 - 0.02)
            leaf.location = (hinge[0], hinge[1], 0)
            knob = piece(f"{name}_knob_{k}", (ow - 0.2, -0.07, sill + 1.0), (ow - 0.12, 0.07, sill + 1.08), mat["trim"])
            knob.location = leaf.location
            doors.append(_join(leaf.name, [leaf, knob]))
    walls = _apply(outer)
    for c in cutters:
        bpy.data.objects.remove(c, do_unlink=True)
    solid = [walls]
    if interior:
        for fl in range(floors):
            solid.append(_prism(f"{name}_floor_{fl}", _inset(ring, wall * 0.5), fl * storey - (0.12 if fl else 0.0), fl * storey + (0.0 if fl else 0.06) + (0.0 if fl else 0), mat["floor"]))
    base = _prism(name + "_base", _inset(ring, -0.08), -0.25, 0.18, mat["trim"])
    solid.append(base)
    # The roof.
    c = pts.mean(axis=0)
    eave = _inset(ring, -overhang)
    ep = np.array(eave)
    if roof == "flat":
        solid.append(_prism(name + "_roof", _inset(ring, wall * 0.5), top - 0.15, top, mat["floor"]))
        if parapet:
            ext = _inset(ring, -0.12)
            n = len(ring)
            per = [np.linalg.norm(np.array(ext[(i + 1) % n]) - np.array(ext[i])) for i in range(n)]
            total, step = sum(per), sum(per) / parapet
            walk = 0.0
            for i in range(n):
                p0, p1 = np.array(ext[i]), np.array(ext[(i + 1) % n])
                e = (p1 - p0) / per[i]
                inward = np.array([-e[1], e[0]])
                if inward @ (c - p0) < 0:
                    inward = -inward
                solid.append(_prism(f"{name}_curb_{i}", [tuple(p0), tuple(p1), tuple(p1 + inward * (wall + 0.12)), tuple(p0 + inward * (wall + 0.12))], top, top + 0.45, mat["wall"]))
                s = (-walk) % step
                while s + step * 0.5 <= per[i] + 1e-6:
                    q0, q1 = p0 + e * s, p0 + e * min(per[i], s + step * 0.5)
                    solid.append(_prism(f"{name}_merlon_{i}_{int(s * 100)}", [tuple(q0), tuple(q1), tuple(q1 + inward * (wall + 0.12)), tuple(q0 + inward * (wall + 0.12))], top + 0.45, top + 1.0, mat["wall"]))
                    s += step
                walk += per[i]
    else:
        if roof == "cone" or (roof == "hip" and len(ring) != 4):
            apex_h = float(np.max(np.linalg.norm(ep - c, axis=1))) * math.tan(math.radians(pitch))
            verts = [(x, y, top) for x, y in eave] + [(c[0], c[1], top + apex_h)] + [(x, y, top - 0.12) for x, y in eave]
            n = len(eave)
            faces = [(i, (i + 1) % n, n) for i in range(n)] + [(n + 1 + (i + 1) % n, n + 1 + i, i, (i + 1) % n) for i in range(n)] + [tuple(n + 1 + i for i in range(n))]
        else:
            # A rectangle's roof: the ridge along its longer side.
            lo, hi = ep.min(axis=0), ep.max(axis=0)
            long_x = (hi[0] - lo[0]) >= (hi[1] - lo[1])
            half = ((hi[1] - lo[1]) if long_x else (hi[0] - lo[0])) / 2
            rise = half * math.tan(math.radians(pitch)) if roof != "shed" else half * 2 * math.tan(math.radians(pitch))
            run_in = half if roof == "hip" else 0.0
            cx, cy = (lo + hi) / 2
            if roof == "shed":
                verts = [(lo[0], lo[1], top), (hi[0], lo[1], top), (hi[0], hi[1], top + rise), (lo[0], hi[1], top + rise),
                         (lo[0], lo[1], top - 0.12), (hi[0], lo[1], top - 0.12), (hi[0], hi[1], top - 0.12), (lo[0], hi[1], top - 0.12)]
                faces = [(0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
            else:
                r0, r1 = ((lo[0] + run_in, cy), (hi[0] - run_in, cy)) if long_x else ((cx, lo[1] + run_in), (cx, hi[1] - run_in))
                base4 = [(lo[0], lo[1]), (hi[0], lo[1]), (hi[0], hi[1]), (lo[0], hi[1])]
                verts = [(x, y, top) for x, y in base4] + [(r0[0], r0[1], top + rise), (r1[0], r1[1], top + rise)] + [(x, y, top - 0.12) for x, y in base4]
                faces = ([(0, 1, 5, 4), (2, 3, 4, 5), (1, 2, 5), (3, 0, 4)] if long_x else [(1, 2, 5, 4), (3, 0, 4, 5), (0, 1, 4), (2, 3, 5)])
                faces += [(6, 9, 8, 7), (0, 6, 7, 1), (1, 7, 8, 2), (2, 8, 9, 3), (3, 9, 6, 0)]
        me = bpy.data.meshes.new(name + "_roof")
        me.from_pydata(verts, [], faces)
        me.update()
        rf = bpy.data.objects.new(name + "_roof", me)
        bpy.context.scene.collection.objects.link(rf)
        me.materials.append(mat["roof"])
        solid.append(rf)
        if roof == "gable":
            # The gable ends: the wall carried up under the ridge.
            lo, hi = pts.min(axis=0), pts.max(axis=0)
            long_x = (hi[0] - lo[0]) >= (hi[1] - lo[1])
            half_w = ((hi[1] - lo[1]) if long_x else (hi[0] - lo[0])) / 2
            gh = half_w * math.tan(math.radians(pitch))
            for end in (0, 1):
                if long_x:
                    x = lo[0] if end == 0 else hi[0] - wall
                    tri = [(x, lo[1], top), (x, hi[1], top), (x, (lo[1] + hi[1]) / 2, top + gh)]
                    tri2 = [(x + wall, p[1], p[2]) for p in tri]
                else:
                    y = lo[1] if end == 0 else hi[1] - wall
                    tri = [(lo[0], y, top), (hi[0], y, top), ((lo[0] + hi[0]) / 2, y, top + gh)]
                    tri2 = [(p[0], y + wall, p[2]) for p in tri]
                gm = bpy.data.meshes.new(name + "_gable")
                gm.from_pydata(tri + tri2, [], [(0, 1, 2), (5, 4, 3), (0, 3, 4, 1), (1, 4, 5, 2), (2, 5, 3, 0)])
                bm = bmesh.new()
                bm.from_mesh(gm)
                bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
                bm.to_mesh(gm)
                bm.free()
                g = bpy.data.objects.new(name + "_gable", gm)
                bpy.context.scene.collection.objects.link(g)
                gm.materials.append(mat["wall"])
                solid.append(g)
    out = _join(name, solid + parts)
    bm = bmesh.new()
    bm.from_mesh(out.data)
    bmesh.ops.recalc_face_normals(bm, faces=[f for f in bm.faces])
    bm.to_mesh(out.data)
    bm.free()
    bev = out.modifiers.new("bevel", "BEVEL")
    bev.width = 0.025
    bev.segments = 1 if facets else 2
    bev.limit_method = "ANGLE"
    bev.angle_limit = math.radians(50)
    out = _apply(out)
    _shade(out, True if facets else False, 30)
    _wrap(out)
    for d in doors:
        _wrap(d)
    for d in doors:
        helpers.pivot(d, d.matrix_world.translation, parent=out)
    out["kurambit_world"] = json.dumps({"kind": "building", "floors": floors, "doors": [d.name for d in doors]})
    return out
