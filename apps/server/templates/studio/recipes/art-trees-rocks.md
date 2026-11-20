# Trees and rocks: lofts, displaced blobs, scatter

**When.** Trees, bushes, rocks, cliffs and their placement, made in Blender (with the library on,
Quaternius Stylized Nature and Kenney Nature come first).

## Numbers

- Tree **1,000** triangles (role `tree`; Quaternius Stylized Nature median 698); rock **400**
  (role `rock`; Kenney Nature median 76).
- A trunk thick enough to read: at least 4 px at game distance, about 0.12 of the tree's height
  at the base for a stylised tree, tapering to half.
- Crowns: 3-7 big blobs, each 0.3-0.5 of the tree's height across. A pine: 3-5 cone tiers,
  bottom tier the widest.
- Rocks: an icosphere (subdivisions 2-3) displaced by Voronoi at 0.2-0.3 of its radius, decimated
  to 0.3, flat shaded; squash it (z 0.6-0.8) so it sits.
- Scatter: 3 sizes, scale 0.8-1.2 within a size, rotation about z at random.

## Steps

1. Trunk as a loft that bends a little: `kurambit.loft([(base, r, r), (mid + bend, .7 r, .7 r),
(top, .5 r, .5 r)], sides=7, up=(0, -1, 0), cap=(False, True), smooth=False)`
   (`up` across the path, or the rings twist); 1-3 branches as smaller lofts from the trunk's
   upper half, their base inside it.
2. Crown blobs: `bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2)`, a Displace modifier
   with a Voronoi or Clouds texture (strength 0.15-0.25 of the radius), Decimate (ratio 0.4-0.6),
   applied with `bpy.ops.object.convert(target="MESH")`; place them on the branch tips, sunk into
   each other so nothing floats. Flat shading for faceted.
3. Two greens a tree (a light top, a darker inner blob) and a bark brown, as separate parts.
4. Rocks the same way from one blob; make 3 variants with different seeds (`texture.noise_scale`,
   a different `object.location` of the texture coordinates) rather than one rock scaled.
5. Placement: `bpy.ops.object.randomize_transform(random_seed=, loc=, rot=(0, 0, 3.14),
scale_even=True, scale=)` on duplicates, or `kurambit.blender.scatter(obj, on=ground,
density=, seed=)` (Geometry Nodes). Repeats in the game are instances (`M.scatter`), so export
   one tree or rock per variant.
6. `tree["kurambit_role"] = "tree"` (or `"rock"`); review against a pack tree or rock.

Blender 4.5 runs neither Sapling Tree Gen 1.0 (needs 5.2) nor Generate Tree 1.1.5 (needs 5.0.1);
their trees are realistic or heavy anyway (21k and 5k triangles).

## Pitfalls

- Thin branches vanish at game distance.
- One big sphere for a crown reads as a lollipop; three overlapping blobs read as a tree.
- A crown floating off the trunk: sink it in.
- Alpha leaf cards sort and overdraw; keep solid crowns.

## Checks

```yaml
- review: "triangles <= 1000 (tree), <= 400 (rock) (style.roleBudget)"
- review: "floating == [] (contact)"
- review: "review.thinShare_gamePx < 0.05 (review)"
- review: "style.hues <= 3 (style pass)"
```

## Code

Blender's own: Displace with a procedural texture, Decimate, `object.randomize_transform`;
`kurambit.loft`, `kurambit.blender.scatter`.

## Sources

Quaternius Stylized Nature and Kenney Nature triangle counts, measured (ART-RESEARCH §3);
Quaternius' "Rocks without modeling" and "Easiest Tree Ever" titles (read); Sapling and Generate
Tree install refusals on 4.5.16, verified 2026-11-20.
