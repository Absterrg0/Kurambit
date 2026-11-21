"""sweep: one continuous quad surface along a centreline, its cross-section blended smoothly between
profile stations (the dense-surface method of Fable's pelican: superellipse rings on Hermite tables)."""
import math

import bmesh
import bpy
import numpy as np
from mathutils import Vector


def _centreline(path, n):
    """n points and unit tangents, evenly spaced by arc length on a Catmull-Rom spline through path."""
    if isinstance(path, bpy.types.Object):
        me = path.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
        pts = np.array([path.matrix_world @ v.co for v in me.vertices])
        path.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh_clear()
    else:
        pts = np.array([tuple(p) for p in path], float)
    if len(pts) < 2:
        raise ValueError("sweep needs a path of at least two points")
    ext = np.vstack([2 * pts[0] - pts[1], pts, 2 * pts[-1] - pts[-2]])
    dense = []
    for i in range(len(pts) - 1):
        p0, p1, p2, p3 = ext[i:i + 4]
        for s in np.linspace(0, 1, 32, endpoint=False):
            dense.append(0.5 * (2 * p1 + (p2 - p0) * s + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s * s
                                + (3 * p1 - p0 - 3 * p2 + p3) * s ** 3))
    dense = np.vstack([dense, pts[-1]])
    arc = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(dense, axis=0), axis=1))])
    at = np.linspace(0, arc[-1], n)
    line = np.column_stack([np.interp(at, arc, dense[:, k]) for k in range(3)])
    tan = np.gradient(line, axis=0)
    return line, tan / np.linalg.norm(tan, axis=1, keepdims=True), arc[-1]


def _frames(line, tan, up):
    """Rotation-minimising frames (double reflection), so a curving path never twists its rings."""
    t0 = Vector(tan[0])
    side = t0.cross(Vector(up))
    if side.length < 1e-4:  # the path starts along up: any side will do
        side = t0.cross(Vector((1, 0, 0)) if abs(t0.x) < 0.9 else Vector((0, 1, 0)))
    r = [side.normalized()]
    for i in range(len(tan) - 1):
        v1 = Vector(line[i + 1]) - Vector(line[i])
        c1 = v1.dot(v1) or 1e-12
        rl = r[-1] - (2 / c1) * v1.dot(r[-1]) * v1
        tl = Vector(tan[i]) - (2 / c1) * v1.dot(Vector(tan[i])) * v1
        v2 = Vector(tan[i + 1]) - tl
        c2 = v2.dot(v2) or 1e-12
        r.append((rl - (2 / c2) * v2.dot(rl) * v2).normalized())
    side = np.array(r)
    return side, np.cross(side, tan)


def _pchip(x, y, at):
    """Monotone cubic Hermite (Fritsch-Carlson): smooth through every station, never overshooting
    between them, so a width that narrows never dips below its stations."""
    x, y = np.asarray(x, float), np.asarray(y, float)
    if len(x) == 1:
        return np.full_like(at, y[0])
    h, d = np.diff(x), np.diff(y) / np.diff(x)
    m = np.zeros_like(y)
    m[0], m[-1] = d[0], d[-1]
    for k in range(1, len(x) - 1):
        if d[k - 1] * d[k] > 0:
            w1, w2 = 2 * h[k] + h[k - 1], h[k] + 2 * h[k - 1]
            m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k])
    k = np.clip(np.searchsorted(x, at, side="right") - 1, 0, len(x) - 2)
    s = (at - x[k]) / h[k]
    return ((2 * s ** 3 - 3 * s ** 2 + 1) * y[k] + (s ** 3 - 2 * s ** 2 + s) * h[k] * m[k]
            + (-2 * s ** 3 + 3 * s ** 2) * y[k + 1] + (s ** 3 - s ** 2) * h[k] * m[k + 1])


def _station(s):
    if isinstance(s, dict):
        return (s["t"], s["w"], s["h"], s.get("n", 2.0), s.get("dx", 0.0), s.get("dz", 0.0))
    t, w, h, *rest = s
    n = rest[0] if rest else 2.0
    dx, dz = rest[1] if len(rest) > 1 else (0.0, 0.0)
    return (t, w, h, n, dx, dz)


def sweep(path, stations, sides=64, rings=None, *, up=(0, 0, 1), caps=(True, True), name="sweep", material=None):
    """One continuous quad surface along a centreline: a torso, limb, neck, tail, hull or trunk.

    path      the centreline in metres, world space: a list of 2+ points (a smooth Catmull-Rom spline
              runs through them) or a curve object.
    stations  the cross-section along it, each {"t", "w", "h", "n", "dx", "dz"} or a tuple
              (t, w, h[, n[, (dx, dz)]]): t is 0..1 along the path (by length), w the full width and
              h the full height in metres, n the superellipse exponent (2 round, 3-4 a rounded box,
              6+ nearly square, 1.5 a diamond), dx/dz an offset of the section's centre sideways and
              up (a belly that hangs, a keel). Width runs along the frame's side (path x up), height
              along up as seen across the path. Every value blends smoothly (monotone Hermite)
              between stations, so 4-8 stations make a whole body region.
    sides     vertices round each ring (48-96 for a hero, 24-32 for a background part).
    rings     rings along the path; default makes roughly square quads.
    up        the direction height runs along; it must not run along the path's start (a leg going
              down still takes up=(0, 0, 1) if it bends, else pass up=(0, -1, 0)).
    caps      (start, end): close each end with a rounded dome ending in one pole. A station of
              width 0 already closes its end to a point.
    Returns the object: smooth shaded, UVs (u round, v along), ready for a Subdivision modifier.
    Example, a 1.2 m tapering, flat-bellied tail:
        tail = kurambit.sweep([(0, 0, 1), (0, .6, .9), (0, 1.2, 1.1)],
                              [(0, .3, .25, 2.5), (.5, .18, .15, 2), (1, .02, .02)], sides=48)
    """
    st = sorted(_station(s) for s in stations)
    tt, ww, hh, nn, dx, dz = (np.array(c, float) for c in zip(*st))
    _, _, length = _centreline(path, 64)
    if rings is None:
        girth = math.pi * (ww.max() + hh.max()) / 2
        rings = int(np.clip(round(length / max(girth / sides, 1e-4)), 8, 400)) + 1
    line, tan, _ = _centreline(path, rings)
    side, upv = _frames(line, tan, up)
    at = np.linspace(0, 1, rings)
    w, h = np.maximum(_pchip(tt, ww, at), 0) / 2, np.maximum(_pchip(tt, hh, at), 0) / 2
    n = np.maximum(_pchip(tt, nn, at), 0.5)
    ox, oz = _pchip(tt, dx, at), _pchip(tt, dz, at)
    a = 2 * np.pi * np.arange(sides) / sides
    c, s = np.cos(a)[None], np.sin(a)[None]
    e = (2 / n)[:, None]
    lx = (np.sign(c) * np.abs(c) ** e) * w[:, None] + ox[:, None]
    lz = (np.sign(s) * np.abs(s) ** e) * h[:, None] + oz[:, None]
    verts = line[:, None] + side[:, None] * lx[..., None] + upv[:, None] * lz[..., None]
    verts = verts.reshape(-1, 3).tolist()
    faces, uvs = [], []
    for i in range(rings - 1):
        for k in range(sides):
            k1 = (k + 1) % sides
            faces.append((i * sides + k, i * sides + k1, (i + 1) * sides + k1, (i + 1) * sides + k))
            uvs += [(k / sides, at[i]), ((k + 1) / sides, at[i]), ((k + 1) / sides, at[i + 1]), (k / sides, at[i + 1])]
    for end, ring, sign in ((0, 0, -1), (1, rings - 1, 1)):
        base = [ring * sides + k for k in range(sides)]
        r = min(w[ring], h[ring])
        if not caps[end] or r < 1e-5:  # a zero-width end is already a point: welded below
            continue
        centre = Vector(line[ring]) + Vector(side[ring]) * ox[ring] + Vector(upv[ring]) * oz[ring]
        steps = max(2, sides // 16)
        prev = base
        for j in range(1, steps + 1):
            q = math.sin(math.pi / 2 * j / (steps + 1))
            ring_pts = [centre + (Vector(verts[b]) - centre) * math.cos(math.pi / 2 * j / (steps + 1)) + Vector(tan[ring]) * sign * r * q for b in base]
            idx = list(range(len(verts), len(verts) + sides))
            verts += [tuple(p) for p in ring_pts]
            for k in range(sides):
                k1 = (k + 1) % sides
                f = (prev[k], prev[k1], idx[k1], idx[k])
                faces.append(f if sign > 0 else f[::-1])
                uvs += [(k / sides, end)] * 4
            prev = idx
        pole = len(verts)
        verts.append(tuple(centre + Vector(tan[ring]) * sign * r))
        for k in range(sides):
            f = (prev[k], prev[(k + 1) % sides], pole)
            faces.append(f if sign > 0 else f[::-1])
            uvs += [(k / sides, end)] * 3
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.uv_layers.new(name="UVMap").data.foreach_set("uv", np.array(uvs, np.float32).ravel())
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=1e-7)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.shade_smooth()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    if material is not None:
        me.materials.append(material)
    return ob
