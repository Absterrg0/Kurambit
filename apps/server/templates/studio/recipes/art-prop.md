# Prop: bevelled parts whose edges catch the light

**When.** Crates, barrels, chests, weapons, tools, furniture, lamps, signs: rigid things the
player sees up close.

## Numbers

- Role `prop`, **600** triangles; a weapon bound to a hero counts in the hero's 7,000.
- Real sizes: door 2.1 x 0.9 m, table 0.75 m high, chair seat 0.45 m, counter 0.9 m, barrel
  0.9 m, crate 0.6-1 m, against a 1.8 m hero (`scale.character`).
- Bevel width: the lock's `kurambit.look.read()["bevel"]` (2.5 cm unless set), about 1-3% of a
  part's smallest side, one width on the whole model. Angle limit **30°**. Segments 1 on a
  faceted lock, 2 on a soft one.
- Cylinder sides by size: under 5 cm (handles, bolts) **6**, poles and hoops **8**, barrels and
  wheels **12-16**. Multiples of 4 keep mirrors and cuts on the loops.
- Edge swatch one step lighter than its face (about +15% value), a recess one step darker
  (about -25%): same hue, so the review's hue count stays.
- Recess or panel depth 1-2 cm; a detail under 3 px at game distance is paint, not geometry.
- Surfaces closer than 2 mm flicker: keep them at least 5 mm apart, 2 cm if seen from far.

## Steps

1. Block the masses at real size, each part a primitive or `kurambit.loft`; compare the
   silhouette first (`art-silhouette`).
2. Put rotation and scale into the mesh before anything measured in metres (bevel, solidify).
3. Cuts: a Boolean modifier, solver `"EXACT"` (on 4.5 and 5.x; `"MANIFOLD"` is faster on closed
   cutters), the cutter 1 cm past the surface on every side, hidden and left out of the export.
   Panels and plank gaps: inset the faces and sink them, in the darker swatch (Code).
4. Join every part that never moves on its own into one object (one draw call a copy); a lid,
   door or wheel stays its own with `kurambit.pivot`. Join before adding modifiers: a join keeps
   only the active object's.
5. Bevel, then (soft lock only) Weighted Normal, both left live: the export applies them. Give
   the bevel's new faces the lighter swatch through its `material` slot.
6. `print(kurambit.qa([...]))`, fix its problems, then one review.
   `obj["kurambit_role"] = "prop"`.

## Pitfalls

- A bevel on unapplied or uneven scale stretches and blobs.
- Smooth shading with no sharp edges turns a box into a pillow: on a soft lock use the
  Weighted Normal with `keep_sharp`, or `mesh.set_sharp_from_angle(angle=math.radians(30))`.
- Weighted Normal does nothing on flat faces, and a faceted lock ships every face flat: skip it.
- A cutter flush with a face makes garbage faces and flicker.
- `Metallic` 1 does not ship (the atlas is matte): metal reads as a light cool swatch beside a
  dark one.
- Ten loose parts are ten draw calls for every copy in the game.

## Checks

```yaml
- review: "triangles <= 600 (style.roleBudget (prop))"
- review: "floating == [] (contact)"
- agent: "kurambit.qa(parts) problems == []"
- agent: "one object per part that moves; the rest joined"
```

## Code

```python
import bmesh, bpy, math
lk = kurambit.look.read()
o = bpy.data.objects["Crate"]                      # joined, scale applied
edge = kurambit.material("#c9a26b", name="Crate edge")
dark = kurambit.material("#6e5235", name="Crate gap")
for m in (edge, dark):
    o.data.materials.append(m)
bm = bmesh.new(); bm.from_mesh(o.data)
sides = [f for f in bm.faces if abs(f.normal.z) < 0.1]
bmesh.ops.inset_individual(bm, faces=sides, thickness=0.06, depth=-0.015)
for f in sides:                                    # the sunk panel keeps the face's identity
    f.material_index = len(o.data.materials) - 1
bm.to_mesh(o.data); bm.free()
b = o.modifiers.new("Bevel", "BEVEL")
b.width, b.segments = lk["bevel"], 1 if lk["facets"] else 2
b.limit_method, b.angle_limit = "ANGLE", math.radians(30)
b.material = len(o.data.materials) - 2             # bevel faces in the edge swatch
if not lk["facets"]:
    b.harden_normals = True
    o.data.shade_smooth()                          # 4.1+: no auto smooth exists
    w = o.modifiers.new("Normals", "WEIGHTED_NORMAL")
    w.mode, w.weight, w.keep_sharp = "FACE_AREA", 50, True
print(kurambit.qa([o]))
```

Blender's Bevel, Weighted Normal and Boolean modifiers; `bmesh.ops.inset_individual`;
`kurambit.look`, `kurambit.material`, `kurambit.pivot`, `kurambit.qa`.

## Sources

EL4CTEO's blender-skills (MIT): `blender-hardsurface-modeling` (bevel at a 30° limit, Weighted
Normal by face area at 50 keeping sharp, cylinder sides by size, boolean solvers and cutters past
the surface), `blender-texturing` (edge wear and grime from curvature, here as swatches),
`blender-scene-setup` (real sizes), `blender-asset-qa` (offsets against flicker); read, rewritten
for the atlas export.
