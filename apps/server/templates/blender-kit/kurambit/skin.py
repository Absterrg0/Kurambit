"""one_skin: overlapping body regions fused into one continuous surface, the way a sculpt is."""
import bmesh
import bpy
import numpy as np
from mathutils.bvhtree import BVHTree


def _world_bmesh(objects):
    """Every object as evaluated (modifiers on), in world space, in one bmesh; material slots merged."""
    bm, mats = bmesh.new(), []
    dg = bpy.context.evaluated_depsgraph_get()
    for ob in objects:
        ev = ob.evaluated_get(dg)
        me = bpy.data.meshes.new_from_object(ev)
        me.transform(ob.matrix_world)
        remap = []
        for m in me.materials or [None]:
            if m not in mats:
                mats.append(m)
            remap.append(mats.index(m))
        for p in me.polygons:
            p.material_index = remap[min(p.material_index, len(remap) - 1)]
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
    return bm, mats


def _apply(ob, kind, **props):
    mod = ob.modifiers.new(kind.lower(), kind)
    for k, v in props.items():
        setattr(mod, k, v)
    ev = ob.evaluated_get(bpy.context.evaluated_depsgraph_get())
    me = bpy.data.meshes.new_from_object(ev)
    old = ob.data
    ob.modifiers.clear()
    ob.data = me
    bpy.data.meshes.remove(old)


def one_skin(objects, voxel=0.01, smooth=10, hold=0.0, target_faces=None, *, name="skin", keep=False):
    """Fuses overlapping regions (sweeps, spheres, any closed meshes) into one continuous surface:
    the union, voxel remeshed, its seams and voxel steps smoothed away, the way a sculpt blends.

    objects       the meshes to fuse, overlapping where they meet (a limb sunk a few cm into the torso).
                  Their modifiers are applied; open ends are closed by the remesh.
    voxel         voxel size in metres: detail smaller than about 2 voxels melts. 0.005-0.01 for a
                  human-sized hero, about 1/200 of the subject's height in general.
    smooth        Laplacian smoothing iterations (volume kept): 5-20 rounds the joins into soft
                  fillets; 0 keeps the raw remesh.
    hold          0..1: how far each vertex is pulled back onto the original surfaces after smoothing
                  (1 restores crisp forms but also the creases where regions meet).
    target_faces  a quad count: QuadriFlow retopology to about that many quads (decimate if
                  QuadriFlow fails), so the skin ships at a game size. None keeps the remesh density.
    keep          keep the source objects (hidden) instead of deleting them.
    Each face takes the material of the nearest source face, so a red sleeve stays red.
    Returns the new object, smooth shaded, without UVs (bake_down or Smart UV Project adds them).
    Example: body = kurambit.one_skin([torso, neck, head, arm_l, arm_r], voxel=0.008, smooth=12,
                                      target_faces=12000)
    """
    objects = [bpy.data.objects[o] if isinstance(o, str) else o for o in objects]
    src, mats = _world_bmesh(objects)
    bmesh.ops.triangulate(src, faces=src.faces)
    src.faces.ensure_lookup_table()
    tree = BVHTree.FromBMesh(src)
    face_mat = [f.material_index for f in src.faces]

    me = bpy.data.meshes.new(name)
    src.to_mesh(me)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    _apply(ob, "REMESH", mode="VOXEL", voxel_size=voxel, adaptivity=0.0, use_smooth_shade=True)
    if smooth:
        _apply(ob, "LAPLACIANSMOOTH", iterations=int(smooth), lambda_factor=0.5, use_volume_preserve=True,
               use_normalized=True)
    if hold > 0:
        co = np.empty(len(ob.data.vertices) * 3)
        ob.data.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3)
        for i, p in enumerate(co):
            hit = tree.find_nearest(p)
            if hit[0] is not None:
                co[i] = p + (np.array(hit[0]) - p) * hold
        ob.data.vertices.foreach_set("co", co.ravel())
        ob.data.update()
    if target_faces:
        # The remesh leaves edges of a few micrometres, and QuadriFlow refuses any mesh with one
        # ("needs to be manifold") although it is: weld them first.
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=voxel * 0.02)
        bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=voxel * 0.02)
        bm.to_mesh(ob.data)
        bm.free()
        before = len(ob.data.polygons)
        try:
            with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob], selected_editable_objects=[ob]):
                bpy.ops.object.quadriflow_remesh(target_faces=int(target_faces), use_mesh_symmetry=False,
                                                 use_preserve_sharp=False, use_preserve_boundary=False, smooth_normals=True)
        except RuntimeError:
            pass
        if len(ob.data.polygons) == before and before > target_faces:  # QuadriFlow gave up quietly
            _apply(ob, "DECIMATE", ratio=target_faces / before)
    for m in mats:
        ob.data.materials.append(m)
    if len(mats) > 1:
        idx = []
        for p in ob.data.polygons:
            hit = tree.find_nearest(p.center)
            idx.append(face_mat[hit[2]] if hit[2] is not None else 0)
        ob.data.polygons.foreach_set("material_index", idx)
    ob.data.shade_smooth()
    src.free()
    for o in objects:
        if keep:
            o.hide_set(True)
            o.hide_render = True
        else:
            bpy.data.objects.remove(o)
    return ob
