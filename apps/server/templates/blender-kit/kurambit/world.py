"""The world kit, for game_blender op code: `from kurambit import world`. What a place is made of
that Blender makes better than code, each from a few numbers, built with Blender's own curves,
modifiers and geometry nodes.

  world.tree(name, height=6, crown="cone"|"round"|"weeping", ...)   a trunk, limbs and foliage
  world.rock(name, size=(2, 1.6, 1.2), sharp=0.5, strata=0, ...)    a boulder; wide, tall and strata: a cliff
  world.building(name, plan=(6, 5), floors=1, roof="gable", ...)    walls with openings, floors inside, a roof

Each returns its object, standing on z = 0 at the origin, facing -Y, named name, with colours by
role (bark, leaf, stone, wall, roof, ...): pass `colours={"leaf": "#5a8f3c"}` to set one, or a
material (a made surface: `colours={"bark": kurambit.surface("bark", "bark", "#6b4a32")}`), which
is box-mapped in metres. The look comes from STYLE.json: with a hex palette every role takes its
nearest palette colour and shapes are faceted; without one they are smooth and denser. `seed` makes
another of the same kind: export three seeds of a tree and scatter each in the game (shell/model.js
M.scatter) for a forest in three draws. Ground, furniture and clutter are built in the game's code."""
import json
import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Vector, noise

from . import helpers

# Each role's own colour when the game has no palette and the caller names none.
ROLES = {"bark": "#6b4a32", "leaf": "#4f8a3c", "leaf2": "#6fa84a", "stone": "#8a8780", "stone2": "#6f6c66", "moss": "#5f7a3a",
         "wall": "#d9cdb4", "roof": "#a2523a", "trim": "#5a4030", "floor": "#9a7650", "glass": "#9fc4d6", "door": "#6a4a2e"}


def look():
    """The game's look for made things: {"palette": [hex] | None, "facets": bool}, from STYLE.json
    in the game root (the live scene's working directory)."""
    try:
        with open("STYLE.json", encoding="utf8") as f:
            style = json.load(f)
    except (OSError, ValueError):
        style = {}
    palette = style.get("palette") if isinstance(style.get("palette"), list) and style.get("palette") else None
    return {"palette": palette, "facets": palette is not None}


def _rgb(h):
    return np.array([int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)])


def _material(role, colours, palette, rough=None):
    """The material of a role: the caller's colour, else the role's own, on the palette when there is one."""
    given = (colours or {}).get(role)
    if isinstance(given, bpy.types.Material):  # a made surface (kurambit.surface), or any material of the game's
        return given
    h = given or ROLES[role]
    if palette and not given:
        want = _rgb(h)
        h = min(palette, key=lambda p: float(np.sum((_rgb(p) - want) ** 2)))
    return helpers.material(h, name=role.capitalize(), roughness=rough if rough is not None else (0.35 if role == "glass" else 0.8))


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


# ---- trees -------------------------------------------------------------------------------------

def _scatter_nodes(leaf, scale, jitter, seed):
    """A geometry-nodes group: one leaf mesh on every point, turned along the point's `dir`, sized at
    random, realised. Blender's own instancing, so foliage is one modifier."""
    g = bpy.data.node_groups.new("kurambit_foliage", "GeometryNodeTree")
    g.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    g.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    n, link = g.nodes, g.links
    gin, gout = n.new("NodeGroupInput"), n.new("NodeGroupOutput")
    obj = n.new("GeometryNodeObjectInfo")
    obj.inputs["Object"].default_value = leaf
    inst = n.new("GeometryNodeInstanceOnPoints")
    direction = n.new("GeometryNodeInputNamedAttribute")
    direction.data_type = "FLOAT_VECTOR"
    direction.inputs["Name"].default_value = "dir"
    align = n.new("FunctionNodeAlignRotationToVector")
    align.axis = "Z"
    spin = n.new("FunctionNodeRandomValue")
    spin.data_type = "FLOAT"
    spin.inputs[3].default_value = 2 * math.pi
    spin.inputs["Seed"].default_value = seed
    turn = n.new("FunctionNodeRotateRotation")
    turn.rotation_space = "LOCAL"
    euler = n.new("ShaderNodeCombineXYZ")
    to_rot = n.new("FunctionNodeEulerToRotation")
    size = n.new("FunctionNodeRandomValue")
    size.data_type = "FLOAT"
    size.inputs[2].default_value = scale * (1 - jitter)
    size.inputs[3].default_value = scale * (1 + jitter)
    size.inputs["Seed"].default_value = seed + 1
    grow = n.new("GeometryNodeInputNamedAttribute")
    grow.data_type = "FLOAT_VECTOR"
    grow.inputs["Name"].default_value = "size"
    mul = n.new("ShaderNodeVectorMath")
    mul.operation = "SCALE"
    real = n.new("GeometryNodeRealizeInstances")
    link.new(gin.outputs[0], inst.inputs["Points"])
    link.new(obj.outputs["Geometry"], inst.inputs["Instance"])
    link.new(direction.outputs["Attribute"], align.inputs["Vector"])
    link.new(spin.outputs[1], euler.inputs["Z"])
    link.new(euler.outputs[0], to_rot.inputs[0])
    link.new(align.outputs[0], turn.inputs[0])
    link.new(to_rot.outputs[0], turn.inputs[1])
    link.new(turn.outputs[0], inst.inputs["Rotation"])
    link.new(grow.outputs["Attribute"], mul.inputs[0])
    link.new(size.outputs[1], mul.inputs["Scale"])
    link.new(mul.outputs[0], inst.inputs["Scale"])
    link.new(inst.outputs[0], real.inputs[0])
    link.new(real.outputs[0], gout.inputs[0])
    return g


def _leaf_mesh(kind, facets):
    """One piece of foliage, its base at the origin, growing along +Z, about 1 m."""
    bm = bmesh.new()
    if kind == "pad":  # a flat drooping pad: a conifer's bough
        bmesh.ops.create_cone(bm, cap_ends=False, segments=5 if facets else 7, radius1=0.5, radius2=0.0, depth=1.0)
        for v in bm.verts:
            v.co.z += 0.5
            v.co.y *= 0.42
    elif kind == "strand":  # a narrow hanging blade, two faces crossed
        for a in (0.0, math.pi / 2):
            c, s = math.cos(a), math.sin(a)
            vs = [bm.verts.new((x * c, x * s, z)) for x, z in ((-0.5, 0), (0.5, 0), (0.4, 0.6), (0.0, 1.0), (-0.4, 0.6))]
            bm.faces.new(vs)
    else:  # a clump: a broadleaf's mass of leaves
        bmesh.ops.create_icosphere(bm, subdivisions=1 if facets else 2, radius=0.5)
        for v in bm.verts:
            v.co.z = v.co.z * 0.72 + 0.3
    me = bpy.data.meshes.new("kurambit_leaf")
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new("kurambit_leaf", me)
    return o


def tree(name, height=6.0, crown="cone", *, trunk=None, spread=None, limbs=None, droop=None, foliage=None, density=1.0, bare=0.25,
         lean=0.0, seed=1, colours=None, facets=None):
    """A tree. crown: "cone" (tiers of boughs narrowing to the top: a conifer), "round" (limbs
    lifting into a dome: a broadleaf) or "weeping" (limbs that arch over and hang in strands).
    trunk: its radius at the ground (default by height); spread: the crown's radius; limbs: how
    many; droop: 0..1 how far limbs fall; foliage: "pad", "clump" or "strand" (default by crown);
    density: foliage amount (0.5 for a tree that repeats: a forest draws each seed many times);
    bare: the share of the trunk below the crown; lean: metres the top is off the base. Returns
    the object: wood and leaves, two colours."""
    lk = look()
    facets = lk["facets"] if facets is None else facets
    rng = np.random.default_rng(seed)
    trunk = trunk or height * 0.035
    spread = spread or height * {"cone": 0.26, "round": 0.42, "weeping": 0.5}[crown]
    limbs = limbs or {"cone": 15, "round": 9, "weeping": 9}[crown]
    droop = {"cone": 0.25, "round": 0.0, "weeping": 0.9}[crown] if droop is None else droop
    foliage = foliage or {"cone": "pad", "round": "clump", "weeping": "strand"}[crown]
    cu = bpy.data.curves.new(name + "_wood", "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = 1.0
    cu.bevel_resolution = 0 if facets else 1
    cu.resolution_u = 1 if facets else 2
    cu.use_fill_caps = True
    points, dirs, sizes = [], [], []

    def spline(pts, radii):
        s = cu.splines.new("POLY")
        s.points.add(len(pts) - 1)
        for p, pt, r in zip(s.points, pts, radii):
            p.co = (*pt, 1.0)
            p.radius = r

    # The trunk: a gentle bend to its lean, tapering; a cone's runs to the very top.
    top = height * (0.97 if crown == "cone" else 0.62 if crown == "round" else 0.55)
    bend = np.array([rng.normal(0, 0.012 * height), rng.normal(0, 0.012 * height)])
    tp = []
    for i in range(7):
        t = i / 6
        off = np.array([lean, 0.0]) * t ** 1.5 + bend * math.sin(t * math.pi)
        tp.append((off[0], off[1], top * t))
    spline(tp, [trunk * (1 - 0.82 * (i / 6) ** 0.8) for i in range(7)])
    at = lambda t: np.array(tp[min(5, int(t * 6))]) * (1 - (t * 6) % 1) + np.array(tp[min(6, int(t * 6) + 1)]) * ((t * 6) % 1) if t < 1 else np.array(tp[6])
    for k in range(limbs):
        f = (k + rng.uniform(0.2, 0.8)) / limbs
        t = bare + (1.0 - bare) * (f if crown == "cone" else 0.35 + 0.65 * f)
        base = at(min(t, 0.999))
        az = k * 2.39996 + rng.uniform(-0.3, 0.3)  # the golden angle: no two limbs over each other
        out = np.array([math.cos(az), math.sin(az), 0.0])
        if crown == "cone":
            length = spread * (1.0 - 0.85 * (t - bare) / (1 - bare)) * rng.uniform(0.85, 1.1)
            rise = 0.12 - droop * 0.7
        elif crown == "round":
            length = spread * rng.uniform(0.75, 1.0) * (0.75 + 0.25 * math.sin(f * math.pi))
            rise = 0.9 - 0.7 * f * 0 + rng.uniform(-0.15, 0.15)
        else:
            length = spread * rng.uniform(0.7, 1.0)
            rise = 0.75
        n = 4 if crown == "cone" else 5
        pts, p, d = [base], base.copy(), (out + np.array([0, 0, rise]))
        d /= np.linalg.norm(d)
        for j in range(1, n + 1):
            d = d + np.array([0, 0, -droop * (0.5 if crown != "weeping" else 0.42) * j / n]) + rng.normal(0, 0.05, 3)
            d /= np.linalg.norm(d)
            p = p + d * length / n
            pts.append(p.copy())
        r0 = trunk * (0.42 if crown != "cone" else 0.22) * (1 - 0.5 * t)
        spline(pts, [max(r0 * (1 - 0.8 * j / n), trunk * 0.05) for j in range(n + 1)])
        # Foliage along the limb's outer part.
        if foliage == "pad":
            # A bough's pads: one at each joint, and a pair spread to the sides at every other one.
            for j in range(1, n + 1):
                dd = pts[j] - pts[j - 1]
                dd /= np.linalg.norm(dd)
                for side in ((0,) if j % 2 else (-1, 0, 1)):
                    if side != 0 and rng.uniform() > density:
                        continue
                    points.append(pts[j] if side == 0 else (pts[j] + pts[j - 1]) / 2)
                    dirs.append(dd + np.array([-dd[1], dd[0], 0.0]) * 0.8 * side + np.array([0, 0, -0.25]))
                    sizes.append(length * 0.66 * (1.2 - 0.4 * j / n))
        elif foliage == "clump":
            for j in range(2, n + 1):
                for _ in range(max(1, int(round(2 * density)))):
                    points.append(pts[j] + rng.normal(0, length * 0.09, 3))
                    dirs.append(np.array([0, 0, 1.0]) + rng.normal(0, 0.25, 3))
                    sizes.append(length * rng.uniform(0.5, 0.8))
        else:
            # Strands hang from the arched part to near the ground, a curtain round the crown.
            for j in range(1, n + 1):
                for _ in range(max(1, int(round(11 * density)))):
                    q = pts[j - 1] + (pts[j] - pts[j - 1]) * rng.uniform(0, 1) + rng.normal(0, length * 0.07, 3) * np.array([1, 1, 0.15])
                    points.append(q)
                    dirs.append(np.array([rng.normal(0, 0.05), rng.normal(0, 0.05), -1.0]))
                    sizes.append(max(0.4, q[2] - height * rng.uniform(0.05, 0.3)))
    if crown == "cone":  # the leader's own tip
        points.append(np.array(tp[6]) - np.array([0, 0, spread * 0.5]))
        dirs.append(np.array([0, 0, 1.0]))
        sizes.append(spread * 0.75)
    wood = _new(name + "_wood", cu)
    wood.data.materials.append(_material("bark", colours, lk["palette"]))
    wood = _apply(wood)
    _shade(wood, facets)
    # Foliage: a point per piece, instanced by geometry nodes.
    pm = bpy.data.meshes.new(name + "_leaves")
    pm.from_pydata([tuple(p) for p in points], [], [])
    da = pm.attributes.new("dir", "FLOAT_VECTOR", "POINT")
    da.data.foreach_set("vector", np.array(dirs, dtype=np.float32).ravel())
    # A strand keeps its own width however far it hangs; pads and clumps grow evenly.
    wide = [min(v, height * 0.035) if foliage == "strand" else v for v in sizes]
    sa = pm.attributes.new("size", "FLOAT_VECTOR", "POINT")
    sa.data.foreach_set("vector", np.array([(w, w, v) for w, v in zip(wide, sizes)], dtype=np.float32).ravel())
    leaves = _new(name + "_leaves", pm)
    leaf = _leaf_mesh(foliage, facets)
    mod = leaves.modifiers.new("foliage", "NODES")
    group = mod.node_group = _scatter_nodes(leaf, 1.0, 0.18, seed)
    leaves = _apply(leaves)
    bpy.data.node_groups.remove(group)
    leaf_mesh = leaf.data
    bpy.data.objects.remove(leaf)
    bpy.data.meshes.remove(leaf_mesh)
    if foliage == "clump" and not facets:
        # A broadleaf's clumps fused into one canopy surface.
        r = leaves.modifiers.new("fuse", "REMESH")
        r.mode = "VOXEL"
        r.voxel_size = max(0.08, height * 0.022)
        leaves = _apply(leaves)
        thin = leaves.modifiers.new("thin", "DECIMATE")
        thin.ratio = min(1.0, 2400 * max(0.4, density) / max(1, tris(leaves)))
        leaves = _apply(leaves)
    # Realised instances bring an empty material slot of their own.
    leaves.data.materials.clear()
    leaves.data.materials.append(_material("leaf", colours, lk["palette"]))
    leaves.data.polygons.foreach_set("material_index", [0] * len(leaves.data.polygons))
    _shade(leaves, facets or foliage == "strand", 60)
    out = _wrap(_join(name, [wood, leaves]))
    out["kurambit_world"] = json.dumps({"kind": "tree", "crown": crown, "height": height, "seed": seed})
    return out


# ---- rocks -------------------------------------------------------------------------------------

def rock(name, size=(2.0, 1.6, 1.2), *, sharp=0.5, strata=0.0, cracks=0.3, moss=0.0, seed=1, triangles=None, colours=None, facets=None):
    """A rock size (wide, deep, tall) metres. sharp: 0 a water-worn stone, 1 broken and angular;
    strata: 0..1 layered ledges (with a wide, tall size: a cliff face); cracks: 0..1 deep creases;
    moss: 0..1 of its top in the moss colour. Flat under, sitting a little into the ground."""
    lk = look()
    facets = lk["facets"] if facets is None else facets
    triangles = triangles or (260 if facets else 2400)
    sx, sy, sz = size
    big = max(size)
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=5, radius=0.5)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = _new(name, me)
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    # A squarer start for a broken rock, a rounder one for a worn stone.
    p = 2.0 + sharp * 5.0
    co = co / (np.sum(np.abs(co) ** p, axis=1, keepdims=True) ** (1 / p)) * 0.5
    co *= np.array([sx, sy, sz])
    co[:, 2] += sz * 0.42
    off = Vector((seed * 13.1, seed * 7.7, seed * 3.3))
    out = np.empty(len(co))
    for i, c in enumerate(co):
        v = Vector(c)
        n1 = noise.noise(v / (big * 0.6) + off)
        n2 = noise.noise(v / (big * 0.22) + off * 2)
        cell = noise.voronoi(v / (big * 0.45) + off, distance_metric="DISTANCE", exponent=2.5)[0]
        d = n1 * 0.16 + n2 * 0.05 * (1 - sharp * 0.5) + (cell[1] - cell[0]) * 0.22 * sharp - (max(0.0, 0.12 - (cell[1] - cell[0])) * 1.6 * cracks)
        if strata > 0:
            band = (c[2] / (big * 0.14) + n1 * 0.6) % 1.0
            d += strata * (0.10 * (1.0 if band < 0.7 else -0.6))
        out[i] = d
    centre = np.array([0, 0, sz * 0.42])
    radial = co - centre
    radial /= np.linalg.norm(radial, axis=1, keepdims=True) + 1e-9
    co += radial * (out[:, None] * big * 0.5)
    co[:, 2] = np.maximum(co[:, 2], 0.0)
    me.vertices.foreach_set("co", co.ravel())
    me.update()
    if not facets:
        r = o.modifiers.new("fuse", "REMESH")
        r.mode = "VOXEL"
        r.voxel_size = big / 60
    d = o.modifiers.new("thin", "DECIMATE")
    d.ratio = min(1.0, triangles / max(1, len(me.polygons) * (4 if not facets else 1)))
    o = _apply(o)
    if tris(o) > triangles * 1.3:
        d = o.modifiers.new("thin", "DECIMATE")
        d.ratio = triangles / tris(o)
        o = _apply(o)
    stone, stone2, mossy = (_material(r, colours, lk["palette"]) for r in ("stone", "stone2", "moss"))
    o.data.materials.clear()
    for m in (stone, stone2, mossy):
        o.data.materials.append(m)
    for poly in o.data.polygons:
        n, c = poly.normal, poly.center
        up = n.z
        if moss > 0 and up > 0.75 - moss * 0.35 and c.z > sz * (0.75 - moss * 0.5):
            poly.material_index = 2
        elif up < 0.25 and noise.noise(Vector(c) / (big * 0.3) + off) < -0.05 or (strata > 0 and (c.z / (big * 0.14)) % 1.0 > 0.72):
            poly.material_index = 1
    _shade(o, facets, 35)
    _wrap(o)
    o["kurambit_world"] = json.dumps({"kind": "rock", "size": list(size), "seed": seed})
    return o


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


def _prism(name, ring, z0, z1, mat, cap=True):
    """A closed solid from a plan ring between two heights."""
    n = len(ring)
    verts = [(x, y, z0) for x, y in ring] + [(x, y, z1) for x, y in ring]
    faces = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    if cap:
        faces += [tuple(reversed(range(n))), tuple(range(n, 2 * n))]
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
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
    lk = look()
    facets = lk["facets"] if facets is None else facets
    mat = {r: _material(r, colours, lk["palette"]) for r in ("wall", "roof", "trim", "floor", "glass", "door")}
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
