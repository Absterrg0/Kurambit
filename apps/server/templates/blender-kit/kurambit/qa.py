"""Mesh faults the review's pictures hide, counted in one code call: print(kurambit.qa(["Crate", "Lid"])).

The export draws every face one-sided (the atlas material culls back faces), so in the game a part
whose faces point inward, or faces wound against their neighbours, are holes; two surfaces facing
the same way within a millimetre flicker as the camera moves. Each object is read as the export
reads it: modifiers applied, in world space, at the rest pose.

Adapted from blender-skills' asset check (MIT, see THIRD-PARTY-NOTICES.md),
`skills/blender-asset-qa/scripts/qa_check.py`: the signed volume of each closed part, the directed
edge used twice, and coplanar overlap found by sampling each triangle against a BVH. Changed here:
one function over named objects, read at the rest pose, a mirrored object judged in its own space,
and only what the game shows (no UV, weight, n-gon or print checks).

Returns {"triangles", "low", "problems": [...], "notes": [...], "objects": {name: {...}}}: low is the
lowest point's height (a prop stands on 0); problems look broken in the game, each with its fix;
notes cost triangles or need a look."""
from collections import Counter

import bmesh
import bpy
from mathutils import geometry
from mathutils.bvhtree import BVHTree

from . import helpers

FLICKER = 0.001  # metres: same-facing surfaces closer than this fight in the depth buffer
MOST = 60000  # triangles past which the flicker check is skipped (it samples every triangle)


def _islands(bm):
    parent = list(range(len(bm.verts)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for e in bm.edges:
        a, b = find(e.verts[0].index), find(e.verts[1].index)
        if a != b:
            parent[a] = b
    return [find(i) for i in range(len(bm.verts))]


def _world_bmesh(o):
    """o's evaluated mesh at the rest pose, in world space, as a triangulated bmesh."""
    rigs = helpers._deforming(o)
    saved = [(a, a.data.pose_position) for a in rigs]
    for a, _ in saved:
        a.data.pose_position = "REST"
    try:
        dg = bpy.context.evaluated_depsgraph_get()
        dg.update()
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        bm = bmesh.new()
        try:
            bm.from_mesh(me)
        finally:
            ev.to_mesh_clear()
    finally:
        for a, p in saved:
            a.data.pose_position = p
    bm.transform(o.matrix_world)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.verts.ensure_lookup_table()
    bm.normal_update()
    return bm


def qa(objects):
    objs = [bpy.data.objects[o] if isinstance(o, str) else o for o in objects]
    objs = [o for o in objs if o.type in helpers.GEOMETRY]
    problems, notes, per = [], [], {}
    verts, tris, meta = [], [], []  # meta: (object index, the normal the game draws)
    low = None
    for oi, o in enumerate(objs):
        # A mirrored object (negative scale) has its winding reversed in world space; Blender and
        # three.js both draw it flipped back, so its parts are judged in their own space.
        sign = -1 if o.matrix_world.determinant() < 0 else 1
        bm = _world_bmesh(o)
        isl = _islands(bm)
        base = len(verts)
        verts.extend(v.co.copy() for v in bm.verts)
        if bm.verts:
            z = min(v.co.z for v in bm.verts)
            low = z if low is None else min(low, z)
        closed, volume, ref = {}, Counter(), {}
        for e in bm.edges:
            if len(e.link_faces) != 2:
                closed[isl[e.verts[0].index]] = False
        directed = Counter()
        empty = degenerate = 0
        slots = o.material_slots
        for f in bm.faces:
            g = isl[f.verts[0].index]
            p0 = ref.setdefault(g, f.verts[0].co.copy())
            a, b, c = (v.co - p0 for v in f.verts)
            volume[g] += a.dot(b.cross(c)) / 6.0
            for lp in f.loops:
                directed[(lp.vert.index, lp.link_loop_next.vert.index)] += 1
            degenerate += f.calc_area() < 1e-10
            empty += f.material_index >= len(slots) or slots[f.material_index].material is None
            tris.append(tuple(base + v.index for v in f.verts))
            meta.append((oi, f.normal * sign))
        inward = sum(1 for g, vol in volume.items() if closed.get(g, True) and vol * sign < -1e-9)
        crossed = sum(1 for n in directed.values() if n > 1)
        open_edges = sum(1 for e in bm.edges if len(e.link_faces) == 1)
        per[o.name] = {"triangles": len(bm.faces), "parts": len(set(isl)), "openEdges": open_edges}
        bm.free()
        if inward:
            problems.append(f"{o.name}: {inward} closed part(s) face inward, invisible in the game: flip them (bmesh.ops.reverse_faces, or recalc_face_normals on that part)")
        if crossed:
            problems.append(f"{o.name}: {crossed} edges join faces wound opposite ways, so one side is a hole: bmesh.ops.recalc_face_normals")
        if degenerate:
            problems.append(f"{o.name}: {degenerate} zero-area triangles: bmesh.ops.dissolve_degenerate(dist=1e-4)")
        if empty:
            problems.append(f"{o.name}: {empty} triangles have no material and ship white: give each slot one")
        if open_edges:
            notes.append(f"{o.name}: {open_edges} open edges; a one-sided face is invisible from behind: close it or give it thickness (Solidify) where the camera can see its back")

    if len(tris) > MOST:
        notes.append(f"{len(tris)} triangles: the flicker check was skipped (it runs under {MOST})")
    elif tris:
        tree = BVHTree.FromPolygons(verts, tris, epsilon=0.0)
        fight, hidden = set(), set()
        for ti, t in enumerate(tris):
            n = meta[ti][1]
            if n.length < 0.5:
                continue
            a, b, c = (verts[i] for i in t)
            centre = (a + b + c) / 3
            for p in (centre, centre.lerp(a, 0.6), centre.lerp(b, 0.6), centre.lerp(c, 0.6)):
                for _, _, tj, _ in tree.find_nearest_range(p, FLICKER):
                    if tj is None or tj == ti or set(t) & set(tris[tj]):
                        continue
                    d = n.dot(meta[tj][1])
                    if abs(d) < 0.999:
                        continue
                    a2, b2, c2 = (verts[i] for i in tris[tj])
                    if geometry.intersect_point_tri(p, a2, b2, c2) is not None:
                        (fight if d > 0 else hidden).add((min(ti, tj), max(ti, tj)))

        def where(pairs):
            out = Counter()
            for i, j in pairs:
                x, y = objs[meta[i][0]].name, objs[meta[j][0]].name
                out[x if x == y else f"{x} / {y}"] += 1
            return out.most_common(8)

        for w, n in where(fight):
            problems.append(f"{w}: {n} triangle pairs lie on one plane facing the same way and flicker: delete the hidden copy, or move one at least 5 mm along its normal")
        for w, n in where(hidden):
            notes.append(f"{w}: {n} triangle pairs sit face to face, never seen: delete them to save triangles")
    return {"triangles": len(tris), "low": round(low, 4) if low is not None else None,
            "problems": problems[:24], "notes": notes[:24], "objects": per}
