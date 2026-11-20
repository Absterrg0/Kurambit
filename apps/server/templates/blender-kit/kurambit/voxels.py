"""Voxel models: a grid of palette keys becomes one mesh of cubes, hidden faces gone and coplanar
faces of a colour merged, one material per colour (the export folds them into vertex colours: one
draw call). The meshing and the .vox reader are the MagicaVoxel add-on's (blender_magicavoxel, on
the add-ons list as "magicavoxel"), called at the version the list pins, so nothing here parses a
file or merges faces by hand.

  voxels("crate", slices, {"w": "floor", "d": ("Band", "#5a4030")}, size=0.1)
  voxels("knight", slices, palette, size=0.0625, armature="knight")   rigid parts on its bones
  voxels("tree", vox="art/tree.vox", licence="CC0, from the person")  a .vox file, its first model

slices: the model seen from the front, front slice first; each slice its rows top to bottom, each
row its voxels left to right as you look at it ("." or " " is empty). Or a numpy array [x, y, z]
of palette indices (0 empty) with a list palette. Origin: the bottom centre, on the ground, facing
-Y as every model does; size is metres per voxel.

armature: a skeleton standing at the origin (op character's). The grid is read as the character
standing with its arms down (the review's stand); each voxel follows the nearest of `bones`, each
part is meshed whole on its own, and is put back to the skeleton's rest, so the parts turn at the
joints and never bend. follow={"s": "upperarm"} makes a key's voxels follow a bone wherever they
are (a bone with no side takes the voxel's: +X is the character's left)."""
import json
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

from . import helpers, look, skeleton
from .protocol import Refused

ADDON = "blender_magicavoxel"
# The bones a voxel character's parts follow by default: one rigid torso (the chest) over the
# hips, no neck, no fingers or toes. A part nearest a bone not listed follows the nearest listed one.
BONES = ("pelvis", "spine_03", "Head", "upperarm_l", "lowerarm_l", "hand_l", "upperarm_r", "lowerarm_r", "hand_r",
         "thigh_l", "calf_l", "foot_l", "thigh_r", "calf_r", "foot_r")


def _addon():
    import addon_utils

    names = [m.__name__ for m in addon_utils.modules() if m.__name__ == ADDON or m.__name__.endswith("." + ADDON)]
    if not names:
        raise Refused("tool-missing", 'Voxels need the MagicaVoxel add-on (27 KB, official, GPL-3.0/MIT): call game_blender op addon {"install": "magicavoxel"}, then this again.')
    addon_utils.enable(names[0], default_set=True)
    return sys.modules[names[0] + "." + ADDON]


def _colour(value, key):
    """(name, "#rrggbb") of a palette entry: a hex, a lock role, or (name, hex or role)."""
    name, c = value if isinstance(value, (tuple, list)) else (None, value)
    if not isinstance(c, str):
        raise ValueError(f"palette {key!r}: give \"#rrggbb\", a role, or (name, colour)")
    return name or (c if not c.startswith("#") else f"Voxel {key}"), look.colour(c)


def _grid(slices, palette):
    """{(x, y, z): colour index}, [(name, hex)] and {key: colour index} from slices or an array."""
    if isinstance(slices, np.ndarray):
        if slices.ndim != 3 or not isinstance(palette, (list, tuple)):
            raise ValueError("an array grid is [x, y, z] of indices into a palette list (0 is empty, 1 the list's first)")
        cells = {tuple(int(i) for i in p): int(slices[tuple(p)]) for p in np.argwhere(slices > 0)}
        bad = sorted({v for v in cells.values() if v > len(palette)})
        if bad:
            raise ValueError(f"indices {bad} are past the palette's {len(palette)} colours")
        return cells, [_colour(v, str(i + 1)) for i, v in enumerate(palette)], {str(i + 1): i + 1 for i in range(len(palette))}
    keys, colours, cells = {}, [], {}
    depth = len(slices)
    for y, rows in enumerate(slices):
        rows = rows.split("\n") if isinstance(rows, str) else list(rows)
        for r, row in enumerate(rows):
            z = len(rows) - 1 - r
            for x, ch in enumerate(row):
                if ch in ". ":
                    continue
                if ch not in keys:
                    if ch not in (palette or {}):
                        raise ValueError(f"slice {y} row {r} has {ch!r}, which the palette does not name")
                    keys[ch] = len(colours) + 1
                    colours.append(_colour(palette[ch], ch))
                cells[(x, y, z)] = keys[ch]
    if not cells or depth == 0:
        raise ValueError("the grid has no voxels")
    return cells, colours, keys


def _vox(path, model):
    mv = _addon()
    full = os.path.abspath(path)
    warned = []
    reader = type("Reader", (), {"report": lambda self, kind, text: warned.append(text)})()
    vox = mv.ImportVOX.load_vox(reader, full)
    if vox is None:
        raise Refused("invalid-input", f"{path} is not a .vox file: {'; '.join(warned) or 'it could not be read'}")
    if not 0 <= model < len(vox.meshes):
        raise Refused("invalid-input", f"{path} holds {len(vox.meshes)} model(s); model is 0 to {len(vox.meshes) - 1}")
    mesh = vox.meshes[model]
    it, cells, used = mv.OctreeIterator(mesh.voxels), {}, {}
    while it.move_next():
        x, y, z, c = it.current
        cells[(x, y, z)] = used.setdefault(c, len(used) + 1)
    colours = [(f"Vox {c}", "#%02x%02x%02x" % tuple(round(v * 255) for v in vox.get_color(c)[:3])) for c in used]
    return cells, colours, len(vox.meshes)


def _quads(mv, cells):
    tree = mv.Octree()
    for (x, y, z), c in cells.items():
        tree.add(x, y, z, c)
    outside = mv.VoxelGrid.create_outside_grid(tree)
    # Watertight: a big face is cut where a smaller neighbour's corner meets its edge, so no crack
    # shows between them at any distance.
    return mv.GreedyMeshing.generate_mesh(tree, outside, False, True)


def _segment_distance(p, a, b):
    ab = b - a
    t = np.clip(((p - a) @ ab) / max(ab @ ab, 1e-12), 0, 1)
    return np.linalg.norm(p - (a + t[:, None] * ab), axis=1)


def voxels(name, slices=None, palette=None, *, size=0.1, vox=None, model=0, licence=None, armature=None, bones=None, follow=None):
    """A voxel model (module docstring). Returns the mesh object; prints its size and faces."""
    mv = _addon()
    if (slices is None) == (vox is None):
        raise ValueError("give slices (with a palette) or vox=")
    models = 1
    if vox is not None:
        if not licence:
            raise ValueError("a .vox comes from someone: pass licence= (its licence and who made it), for ASSETS.md")
        cells, colours, models = _vox(vox, model)
        keys = {}
    else:
        cells, colours, keys = _grid(slices, palette)
    pts = np.array(list(cells), float)
    lo, hi = pts.min(0), pts.max(0) + 1
    # Bottom centre at the origin; the front slice (y 0) toward -Y.
    shift = np.array([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]])
    arm = helpers._armature(armature) if armature is not None else None
    parts = {None: cells}
    if arm is not None:
        unknown = sorted(set(follow or {}) - set(keys))
        if unknown:
            raise ValueError(f"follow names {unknown}, which the palette does not")
        parts = _parts(arm, cells, shift, size, bones, {keys[k]: b for k, b in (follow or {}).items()})
    verts, faces, mats, groups, part_of = [], [], [], {}, []
    for bone, group in parts.items():
        to_rest = parts.to_rest[bone] if arm is not None else None
        for q in _quads(mv, group):
            loop = q.get_loop()
            start = len(verts)
            for p in loop:
                v = Vector((np.array(p, float) - shift) * size)
                verts.append(tuple(to_rest @ v) if to_rest is not None else tuple(v))
            faces.append(list(range(start, start + len(loop))))
            mats.append(q.color - 1)
            part_of.append(bone)
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    for n, c in colours:
        me.materials.append(helpers.material(c, name=n))
    me.polygons.foreach_set("material_index", mats)
    me.polygons.foreach_set("use_smooth", [False] * len(faces))
    me.validate()
    me.update()
    old = bpy.data.objects.get(name)
    if old is not None:
        bpy.data.objects.remove(old)
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    # The style pass keeps it cubes: no thinning to planes, no shading baked across a merged face.
    obj["kurambit_voxel"] = size
    if vox is not None:
        obj["kurambit_source"] = json.dumps({"what": "mesh", "from": vox, "licence": str(licence)[:200], "ai": False, "credits": None})
    if arm is not None:
        for bone in parts:
            vg = obj.vertex_groups.new(name=bone)
            vg.add(sorted({i for f, b in zip(faces, part_of) if b == bone for i in f}), 1.0, "REPLACE")
        skeleton.bind(obj, arm)
    w, d, h = ((hi - lo) * size).round(3)
    print(f"{name}: {len(cells)} voxels, {w} x {d} x {h} m (wide, deep, tall), {len(faces)} faces, {len(colours)} colours"
          + (f", parts on {', '.join(parts)}" if arm is not None else "") + (f"; the file holds {models} models" if models > 1 else ""))
    return obj


class _Parts(dict):
    to_rest = {}


def _parts(arm, cells, shift, size, bones, follow):
    """Each voxel to the nearest bone of the stand pose; per part, the matrix from the stand to rest."""
    from .review import _stand

    action = arm.animation_data.action if arm.animation_data else None
    allowed = [b for b in (bones or BONES) if b in arm.pose.bones]
    sided = lambda b, x: b if b in arm.pose.bones else f"{b}_{'l' if x >= 0 else 'r'}"
    wanted = {sided(b, x) for b in follow.values() for x in (-1, 1)}
    missing = sorted(b for b in wanted if b not in arm.pose.bones)
    if missing:
        raise ValueError(f"{arm.name} has no bone {', '.join(missing)}")
    allowed += sorted(wanted - set(allowed))
    if not allowed:
        raise ValueError(f"{arm.name} has none of the bones {', '.join(bones or BONES)}")
    try:
        _stand(arm)
        mw = arm.matrix_world
        ends = {b: (np.array(mw @ arm.pose.bones[b].head), np.array(mw @ arm.pose.bones[b].tail)) for b in allowed}
        moved = {b: (mw @ arm.data.bones[b].matrix_local) @ (mw @ arm.pose.bones[b].matrix).inverted() for b in allowed}
    finally:
        for pb in arm.pose.bones:
            pb.matrix_basis = Matrix()
        skeleton.assign_action(arm, action)
        bpy.context.view_layer.update()
    keys = list(cells)
    centre = (np.array(keys, float) + 0.5 - shift) * size
    dist = np.stack([_segment_distance(centre, *ends[b]) for b in allowed], 1)
    nearest = dist.argmin(1)
    parts = _Parts()
    for k, i, c in zip(keys, nearest, centre):
        bone = sided(follow[cells[k]], c[0]) if cells[k] in follow else allowed[i]
        parts.setdefault(bone, {})[k] = cells[k]
    parts.to_rest = {b: moved[b] for b in parts}
    return parts
