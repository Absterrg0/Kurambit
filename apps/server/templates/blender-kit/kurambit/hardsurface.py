"""hard_surface: the hard-surface stack (boolean cutters, bevel by angle, weighted normals) with its
traps handled. The stack follows apply_stack.py's midpoly preset from EL4CTEO/blender-skills
(MIT, Copyright (c) 2026 EL4CTEO)."""
import math

import bpy
from mathutils import Matrix

PREFIX = "HS_"  # the stack's modifiers: running hard_surface again replaces them


def _obj(o):
    return bpy.data.objects[o] if isinstance(o, str) else o


def _apply_scale(ob):
    """A bevel's width is in the object's own units: scale it into the mesh so 0.01 means 1 cm on
    every axis (a box scaled 3 x 1 x 1 would bevel 3 cm one way and 1 cm the others)."""
    if all(abs(s - 1) < 1e-6 for s in ob.scale):
        return
    if ob.data.users > 1:
        ob.data = ob.data.copy()
    ob.data.transform(Matrix.Diagonal(ob.scale).to_4x4())
    if ob.scale.x * ob.scale.y * ob.scale.z < 0:  # a mirrored scale turns every face inside out
        ob.data.flip_normals()
    ob.scale = (1, 1, 1)


def hard_surface(obj, cutters=(), bevel=0.01, segments=2, angle=30, weighted=True, apply=False, *, solver="EXACT"):
    """Turns a blockout into a hard-surface part: cuts, rounded edges that catch the light, and the
    flat faces shading flat beside them (no smeared gradients across a panel).

    obj       the mesh (object or name); closed and outward-facing. Its scale is applied first.
    cutters   meshes cut out of it (Boolean difference), in order: window bands, slots, holes, vents.
              Each is hidden from renders and the export and shown as wire. Overlap each cutter
              through the surface; a cutter flush with a face leaves a skin. A round cutter coaxial
              with a round part should be turned half a segment, or it leaves slivers. A cutter
              with a material paints the faces it cuts (glass in a window band, red in a groove).
    bevel     edge width in metres (0.002-0.01 on a prop, 0.02-0.1 on a building or hull). A feature
              under about twice the width collapses: keep slots and lips wider than that.
    segments  bevel segments: 1 a chamfer, 2-3 a round that reads at game distance.
    angle     degrees: only edges sharper than this are bevelled; a 12-sided cylinder's own
              edges are 30 degrees, so use 31+ to leave them smooth or give it more sides.
    weighted  weighted normals: large faces keep flat normals, the bevels take the turn.
    apply     bake the stack into the mesh now (needed before bake_down's decimate or one_skin);
              otherwise it stays live as HS_ modifiers and the export applies them. The cuts leave
              concave n-gons: triangulate before adding a Subdivision modifier, or it folds them.
    solver    "EXACT" (robust), "MANIFOLD" (fast, needs clean closed meshes) or "FLOAT".
    Returns the object. Its triangles: sum(len(p.vertices) - 2 for p in obj.evaluated_get(
    bpy.context.evaluated_depsgraph_get()).data.polygons).
    Example, a crate with a recessed band on each side:
        crate = kurambit.hard_surface(box, cutters=[band_x, band_y], bevel=0.008, segments=2)
    """
    ob = _obj(obj)
    cuts = [_obj(c) for c in cutters]
    _apply_scale(ob)
    for c in cuts:
        c.display_type = "WIRE"
        c.hide_render = True
        c.visible_shadow = False
        c["kurambit_cutter"] = True
    for m in [m for m in ob.modifiers if m.name.startswith(PREFIX)]:
        ob.modifiers.remove(m)
    me = ob.data
    if me.attributes.get("sharp_face"):  # harden normals and weighted normals need smooth faces
        me.attributes.remove(me.attributes["sharp_face"])
    me.set_sharp_from_angle(angle=math.radians(angle))
    for c in cuts:
        b = ob.modifiers.new(f"{PREFIX}Cut_{c.name}", "BOOLEAN")
        b.object, b.operation, b.solver = c, "DIFFERENCE", solver
        b.material_mode = "TRANSFER"  # a cutter's own material paints the faces it cuts
    bev = ob.modifiers.new(f"{PREFIX}Bevel", "BEVEL")
    bev.width = bevel
    bev.segments = segments
    bev.limit_method = "ANGLE"
    bev.angle_limit = math.radians(angle)
    bev.use_clamp_overlap = True
    bev.miter_outer = "MITER_ARC"
    bev.profile = 0.5
    bev.harden_normals = weighted
    if weighted:
        wn = ob.modifiers.new(f"{PREFIX}WeightedNormal", "WEIGHTED_NORMAL")
        wn.mode, wn.weight, wn.keep_sharp = "FACE_AREA", 50, True
    else:
        with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob], selected_editable_objects=[ob]):
            bpy.ops.object.shade_auto_smooth(angle=math.radians(angle))
        ob.modifiers[-1].name = f"{PREFIX}SmoothByAngle"
    if apply:
        dg = bpy.context.evaluated_depsgraph_get()
        # without the depsgraph, preserve_all_data_layers returns an empty mesh
        baked = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
        for m in [m for m in ob.modifiers if m.name.startswith(PREFIX)]:
            ob.modifiers.remove(m)
        old, ob.data = ob.data, baked
        if old.users == 0:
            bpy.data.meshes.remove(old)
    return ob
