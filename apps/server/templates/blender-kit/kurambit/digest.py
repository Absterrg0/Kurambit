"""resolve() and digest(): which objects a review or export covers, and their content hashes.

A digest covers everything an export would carry: transforms, geometry, weights, materials,
modifiers, the stamps, bone rest frames and every key of the clips an armature exports. The live
session and the one-shot pass compute it from the same saved data, so an equal digest means the
pass sees exactly what the agent built, and any edit after a review makes the review stale."""
import hashlib
import json
import os

import bpy
import numpy as np

from .protocol import Refused, entry

GEOMETRY = {"MESH", "CURVE", "SURFACE", "FONT", "META"}
PLACES = 5


def _deformers(o):
    out = [m.object for m in getattr(o, "modifiers", []) if m.type == "ARMATURE" and m.object is not None]
    p = o.parent
    while p is not None:
        if p.type == "ARMATURE":
            out.append(p)
        p = p.parent
    return out


def resolve(names=None):
    """Named objects (or collections) with their children and the armatures deforming them; None:
    every rendered geometry object in the scene and those armatures. Sorted names."""
    scene = bpy.context.scene
    picked, missing = [], []
    if names:
        for n in names:
            o = scene.objects.get(n)
            if o is not None:
                picked += [o, *o.children_recursive]
                continue
            c = bpy.data.collections.get(n)
            if c is not None and any(x.name in scene.objects for x in c.all_objects):
                picked += list(c.all_objects)
                continue
            missing.append(n)
        if missing:
            raise Refused("invalid-input", f"no object or collection {', '.join(missing)} in the live scene; it has {', '.join(sorted(o.name for o in scene.objects))[:300]}")
    else:
        picked = [o for o in scene.objects if o.type in GEOMETRY and not o.hide_render]
    out = set()
    for o in picked:
        if o.type in GEOMETRY or o.type == "ARMATURE":
            out.add(o.name)
        out.update(a.name for a in _deformers(o))
    return sorted(out)


def _r(values):
    return np.round(np.asarray(values, dtype=np.float64), PLACES).tobytes()


def _array(coll, attr, n, dtype=np.float64):
    a = np.empty(n, dtype=dtype)
    coll.foreach_get(attr, a)
    return a


def _rna(struct):
    """The editable plain properties of a struct (a modifier, a node input), as a stable list."""
    out = []
    for p in struct.bl_rna.properties:
        if p.is_readonly or p.identifier in ("rna_type", "name", "show_expanded", "is_active", "is_override_data_editable"):
            continue
        v = getattr(struct, p.identifier, None)
        if p.type == "POINTER":
            v = getattr(v, "name", None)
        elif p.type in ("FLOAT", "INT", "BOOLEAN") and getattr(p, "array_length", 0):
            v = [round(x, PLACES) if isinstance(x, float) else x for x in v]
        elif p.type == "FLOAT":
            v = round(v, PLACES)
        elif p.type == "COLLECTION":
            continue
        if isinstance(v, set):  # enum flags: a set's order changes with each process's hash seed
            v = sorted(v)
        out.append((p.identifier, v))
    return out


def _material(m, cache):
    if m is None:
        return "none"
    if m.name not in cache:
        h = hashlib.sha1(m.name.encode())
        h.update(repr((m.use_backface_culling, m.blend_method if hasattr(m, "blend_method") else None)).encode())
        if m.use_nodes and m.node_tree is not None:
            for n in sorted(m.node_tree.nodes, key=lambda n: n.name):
                h.update(repr((n.name, n.bl_idname)).encode())
                image = getattr(n, "image", None)
                if image is not None:
                    # Never image.size (a reopened file loads image buffers lazily, so it reads 0 x 0) and
                    # never the raw filepath ("//" paths are rewritten when the pass's copy is saved elsewhere).
                    path = os.path.normpath(bpy.path.abspath(image.filepath, library=image.library)) if image.filepath else ""
                    h.update(repr((image.name, path, image.source)).encode())
                for i in n.inputs:
                    if hasattr(i, "default_value"):
                        v = i.default_value
                        v = [round(x, PLACES) for x in v] if hasattr(v, "__len__") and not isinstance(v, str) else (round(v, PLACES) if isinstance(v, float) else v)
                        h.update(repr((i.identifier, v)).encode())
            for link in m.node_tree.links:
                h.update(repr((link.from_node.name, link.from_socket.identifier, link.to_node.name, link.to_socket.identifier)).encode())
        else:
            h.update(_r(m.diffuse_color))
        cache[m.name] = h.hexdigest()
    return cache[m.name]


def _mesh(h, o, cache):
    me = o.data if o.type == "MESH" else None
    if me is None:
        ev = o.evaluated_get(bpy.context.evaluated_depsgraph_get())
        me = ev.to_mesh()
    try:
        nv, np_, nl = len(me.vertices), len(me.polygons), len(me.loops)
        h.update(repr((nv, len(me.edges), np_, nl)).encode())
        h.update(_r(_array(me.vertices, "co", nv * 3)))
        h.update(_array(me.loops, "vertex_index", nl, np.int32).tobytes())
        h.update(_array(me.polygons, "loop_total", np_, np.int32).tobytes())
        h.update(_array(me.polygons, "material_index", np_, np.int32).tobytes())
        h.update(_array(me.polygons, "use_smooth", np_, bool).tobytes())
        for uv in me.uv_layers:
            h.update(uv.name.encode())
            h.update(_r(_array(uv.data, "uv", nl * 2)))
        h.update(repr([_material(s.material, cache) for s in o.material_slots]).encode())
        if o.type == "MESH":
            h.update(repr([g.name for g in o.vertex_groups]).encode())
            for v in me.vertices:
                if len(v.groups):
                    h.update(repr([(g.group, round(g.weight, PLACES)) for g in v.groups]).encode())
            if me.shape_keys is not None:
                for k in me.shape_keys.key_blocks:
                    h.update(k.name.encode())
                    h.update(_r(_array(k.data, "co", nv * 3)))
    finally:
        if o.type != "MESH":
            o.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh_clear()


def _action(h, a):
    h.update(repr((a.name, tuple(a.frame_range), dict(a.items()) if len(a.keys()) else None)).encode())
    from .skeleton import action_fcurves

    for fc in sorted(action_fcurves(a), key=lambda f: (f.data_path, f.array_index)):
        n = len(fc.keyframe_points)
        h.update(repr((fc.data_path, fc.array_index, n)).encode())
        h.update(_r(_array(fc.keyframe_points, "co", n * 2)))
        h.update(_r(_array(fc.keyframe_points, "handle_left", n * 2)))
        h.update(_r(_array(fc.keyframe_points, "handle_right", n * 2)))
        h.update(repr([k.interpolation for k in fc.keyframe_points]).encode())


def exported_actions(arm):
    """The actions an export carries for an armature: its own (kurambit_owner) and any unowned
    action keying its bones. Another character's clips never ride along."""
    from .skeleton import action_fcurves

    bones = set(arm.data.bones.keys())
    out = []
    for a in bpy.data.actions:
        owner = a.get("kurambit_owner")
        if owner is not None:
            if owner == arm.name:
                out.append(a)
            continue
        paths = [fc.data_path for fc in action_fcurves(a)]
        if paths and all('"' in p and p.split('"')[1] in bones for p in paths if p.startswith("pose.bones")) and any(p.startswith("pose.bones") for p in paths):
            out.append(a)
    return sorted(out, key=lambda a: a.name)


def _object(o, cache):
    h = hashlib.sha1()
    h.update(repr((o.type, o.parent.name if o.parent else None, o.parent_type, o.parent_bone, o.hide_render)).encode())
    h.update(_r([x for row in o.matrix_world for x in row]))
    h.update(repr(sorted((k, str(o[k])) for k in o.keys() if k.startswith("kurambit_"))).encode())
    for m in getattr(o, "modifiers", []):
        h.update(repr((m.type, _rna(m))).encode())
    if o.type in GEOMETRY:
        _mesh(h, o, cache)
    elif o.type == "ARMATURE":
        for b in o.data.bones:
            h.update(repr((b.name, b.parent.name if b.parent else None, b.use_deform)).encode())
            h.update(_r([x for row in b.matrix_local for x in row]))
            h.update(_r(list(b.tail_local)))
        for a in exported_actions(o):
            _action(h, a)
    return h.hexdigest()


def digests(names):
    from .skeleton import object_mode

    object_mode()  # edit-mode changes reach the data (and the saved file) only in object mode
    bpy.context.view_layer.update()
    cache = {}
    return {n: _object(bpy.data.objects[n], cache) for n in names}


@entry
def digest(names=None):
    objects = resolve(names)
    return {"objects": objects, "perObject": digests(objects)}
