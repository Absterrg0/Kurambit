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
joints and never bend. By default a part is a whole block: head, chest, hips, each arm, each leg.
follow={"s": "upperarm"} makes a key's voxels follow a bone wherever they are (a bone with no side
takes the voxel's: +X is the character's left); a bone inside a part (a hand) means that part.

A whole arm or leg cannot bend at the elbow or knee, so in every clip of the character it points
where the clip's limb points, shoulder to wrist, hip to ankle, and the hips rise by what a
straightened standing leg would push into the ground (aim_limbs). A limb cut at its joints on a
body two voxels thick folds into a heap the moment a clip bends it."""
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
BONES = ("pelvis", "spine_03", "Head", "upperarm_l", "upperarm_r", "thigh_l", "thigh_r")
# A part on one of these with no part below it is a whole limb, aimed at the joint named.
LIMB_ENDS = {"upperarm": "hand", "thigh": "foot"}


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
        if parts.limbs:
            arm["kurambit_voxel_limbs"] = json.dumps(parts.limbs)
            aim_limbs(arm)
        elif "kurambit_voxel_limbs" in arm:
            del arm["kurambit_voxel_limbs"]
    w, d, h = ((hi - lo) * size).round(3)
    print(f"{name}: {len(cells)} voxels, {w} x {d} x {h} m (wide, deep, tall), {len(faces)} faces, {len(colours)} colours"
          + (f", parts on {', '.join(parts)}" if arm is not None else "") + (f"; the file holds {models} models" if models > 1 else ""))
    return obj


class _Parts(dict):
    to_rest = {}
    limbs = {}


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
    def part_of(b):
        """The part a bone belongs to: itself, else its nearest ancestor that is a part."""
        p = arm.data.bones[b]
        while p is not None and p.name not in allowed:
            p = p.parent
        return p.name if p is not None else b

    resolved = {b: part_of(b) for b in wanted}
    allowed += sorted(set(resolved.values()) - set(allowed))
    if not allowed:
        raise ValueError(f"{arm.name} has none of the bones {', '.join(bones or BONES)}")
    limbs = {}
    for b in allowed:
        end = next((f"{e}{b[len(r):]}" for r, e in LIMB_ENDS.items() if b.startswith(r + "_")), None)
        if end is not None and end in arm.pose.bones and not any(b in {p.name for p in arm.data.bones[o].parent_recursive} for o in allowed):
            limbs[b] = end
    try:
        _stand(arm)
        mw = arm.matrix_world
        ends = {b: (np.array(mw @ arm.pose.bones[b].head), np.array(mw @ arm.pose.bones[b].tail)) for b in allowed}
        moved = {b: (mw @ arm.data.bones[b].matrix_local) @ (mw @ arm.pose.bones[b].matrix).inverted() for b in allowed}
        reach = {b: np.array(mw @ arm.pose.bones[e].head) - ends[b][0] for b, e in limbs.items()}
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
        bone = resolved[sided(follow[cells[k]], c[0])] if cells[k] in follow else allowed[i]
        parts.setdefault(bone, {})[k] = cells[k]
    parts.to_rest = {b: moved[b] for b in parts}
    # A whole limb's own axis: its voxels' long axis, from the joint toward the limb's end, in rest.
    parts.limbs = {}
    for b, end in limbs.items():
        if b not in parts:
            continue
        pts = (np.array(list(parts[b]), float) + 0.5 - shift) * size
        axis = np.linalg.svd(pts - pts.mean(0), full_matrices=False)[2][0]
        axis = axis if axis @ reach[b] > 0 else -axis
        if reach[b][2] < -0.5 * np.linalg.norm(reach[b]):
            # A leg stands on its ankle: it aims the joint's own line so a planted foot lands true.
            axis = reach[b]
        rest = (mw.inverted().to_3x3() @ moved[b].to_3x3() @ Vector(axis)).normalized()
        parts.limbs[b] = {"end": end, "axis": [round(v, 5) for v in rest]}
    return parts


def aim_limbs(arm):
    """Every clip of a voxel character, rewritten so each whole limb points where the clip's limb
    does (module docstring). Idempotent: a clip already aimed comes out the same, so the review
    pass runs it again for clips added after the voxels were made."""
    from .digest import exported_actions
    from .fit import _keys

    limbs = json.loads(arm.get("kurambit_voxel_limbs", "{}") or "{}")
    limbs = {b: v for b, v in limbs.items() if b in arm.pose.bones and v["end"] in arm.pose.bones}
    if not limbs:
        return 0
    bones = arm.pose.bones
    below = {b: [d.name for d in arm.data.bones[b].children_recursive] for b in limbs}
    legs = [b for b, v in limbs.items() if arm.data.bones[v["end"]].head_local.z < 0.25 * arm.data.bones[b].head_local.z]
    lift_bone = "pelvis" if "pelvis" in bones else None
    action = arm.animation_data.action if arm.animation_data else None
    sc = bpy.context.scene
    keep = sc.frame_current
    done = 0
    for act in exported_actions(arm):
        skeleton.assign_action(arm, act)
        f0, f1 = (int(round(f)) for f in act.frame_range)
        at = list(range(f0, f1 + 1))
        rots, lifts = {b: [] for b in limbs}, []
        for f in at:
            sc.frame_set(f)
            heads = {b: bones[b].head.copy() for b in limbs}
            ends = {b: bones[v["end"]].head.copy() for b, v in limbs.items()}
            # The leg standing lowest keeps its ankle where the clip put it; every other limb keeps
            # its direction from the joint.
            planted = min(legs, key=lambda b: ends[b].z) if legs and lift_bone else None
            for _ in range(6):
                for b, v in limbs.items():
                    pb, h = bones[b], bones[b].head.copy()
                    want = ends[b] - h if b == planted else ends[b] - heads[b]
                    if want.length < 1e-6:
                        continue
                    a = (pb.matrix @ arm.data.bones[b].matrix_local.inverted()).to_3x3() @ Vector(v["axis"])
                    q = a.rotation_difference(want).to_matrix().to_4x4()
                    pb.matrix = Matrix.Translation(h) @ q @ Matrix.Translation(-h) @ pb.matrix
                for b in limbs:
                    for d in below[b]:
                        bones[d].matrix_basis = Matrix()
                bpy.context.view_layer.update()
                if planted is None:
                    break
                # A straight leg is longer than the clip's bent one: the hips rise till it reaches.
                lift = ends[planted].z - bones[limbs[planted]["end"]].head.z
                if abs(lift) < 1e-4:
                    break
                bones[lift_bone].matrix = Matrix.Translation((0, 0, lift)) @ bones[lift_bone].matrix
                bpy.context.view_layer.update()
            lifts.append(bones[lift_bone].matrix_basis.translation.copy() if lift_bone else None)
            for b in limbs:
                q = bones[b].matrix_basis.to_quaternion()
                if rots[b] and q.dot(rots[b][-1]) < 0:
                    q.negate()
                rots[b].append(q)
        fcs = skeleton.action_fcurves(act)
        quiet = {d for b in limbs for d in below[b]}
        for fc in list(fcs):
            bone = fc.data_path.split('"')[1] if '"' in fc.data_path else ""
            rot = fc.data_path.endswith((".rotation_quaternion", ".rotation_euler", ".rotation_axis_angle"))
            if (rot and (bone in limbs or bone in quiet)) or (bone == lift_bone and fc.data_path.endswith(".location") and lift_bone):
                fcs.remove(fc)
        for b in limbs:
            bones[b].rotation_mode = "QUATERNION"
            for i in range(4):
                _keys(fcs.new(f'pose.bones["{b}"].rotation_quaternion', index=i), at, [q[i] for q in rots[b]])
        for d in sorted(quiet):
            bones[d].rotation_mode = "QUATERNION"
            for i, v in enumerate((1.0, 0.0, 0.0, 0.0)):
                _keys(fcs.new(f'pose.bones["{d}"].rotation_quaternion', index=i), at[:1], [v])
        if lift_bone:
            for i in range(3):
                _keys(fcs.new(f'pose.bones["{lift_bone}"].location', index=i), at, [float(t[i]) for t in lifts])
        done += 1
    for pb in bones:
        pb.matrix_basis = Matrix()
    skeleton.assign_action(arm, action)
    sc.frame_set(keep)
    return done
