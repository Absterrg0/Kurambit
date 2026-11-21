# Budgets: triangles, draw calls, far copies

**When.** A model over its role's triangles; the Performance row past about 300 draw calls or
1.5M triangles; a model seen both near and far, or repeated hundreds of times.

## Numbers

- Role budgets the review reports (`style.roleBudget`): prop 600, rock 400, plant and tree
  1,000, vehicle 1,500, building 2,000, creature 3,000, hero 7,000.
- A scene: under about **300** draw calls and **1.5M** triangles (three.md).
- Every mesh object is a draw call for every copy, and every material on it one more: a static
  model ships as one object with one material (two with Glow).
- glTF splits a vertex at every hard edge and UV seam, so a faceted model draws about 3 vertices a
  triangle: that is expected. Add no UV maps or vertex colours: the export ships neither.
- Under a faceted lock the export already thins each mesh to clean planes: read triangles off
  the review, not the scene.
- Far copies: halve the triangles per level and switch at about 1/2, 1/4 and 1/8 of the screen's
  height.

## Steps

1. Measure: the review's triangles against the role; `kurambit.qa(parts)` gives each object's
   triangles and the faces that sit face to face, never seen.
2. Cut in this order, the cheapest loss first:
   - faces never seen: face to face, or buried inside other parts;
   - extra loops on flat areas: `bmesh.ops.dissolve_limit` at 2-5° (Code); flat n-gons are fine,
     the export triangulates;
   - cylinder sides past the numbers in `art-prop`;
   - the rest at export: `game_blender` op `export` with `simplify: <triangles>`, which keeps the
     outline and seams and says how many it kept.
3. Draw calls: join the parts that never move apart (`art-prop` step 4). In the game, repeats are
   one `M.scatter` each (instances, one draw a material), and `M.merge` merges a model's parts
   that share a material.
4. A big model seen near and far (a castle, a ship, a boss arena): export it again under another
   name with `simplify` at a quarter of its triangles and swap them with `THREE.LOD`
   (`lod.addLevel(near, 0); lod.addLevel(far, d)`, `d` where it is a quarter of the screen tall).
   Small repeated things stay instances without levels: cheaper than LOD objects.
5. Review the far copy at its game distance (the review's game-distance tile): the silhouette
   must hold.

## Pitfalls

- One mesh for the whole level: nothing is culled, every triangle draws every frame.
- Hundreds of copies exported as one file, or as Blender linked duplicates: the game instances,
  the export does not.
- A Decimate ratio on a textured model tears its UVs; `simplify` keeps seams.
- Triangles spent on what reads under 3 px at game distance; colour it instead.

## Checks

```yaml
- review: "triangles <= style.roleBudget (style pass)"
- agent: "a static model is one object with one material (two with Glow)"
- fact: perf.drawCalls
  label: draw calls
  want: "<= 300"
- fact: perf.triangles
  label: triangles
  want: "<= 1500000"
```

## Code

```python
import bmesh, bpy, math
o = bpy.data.objects["Tower"]
bm = bmesh.new(); bm.from_mesh(o.data)
bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(3), verts=bm.verts[:], edges=bm.edges[:],
                         delimit={"MATERIAL", "SHARP"})
bm.to_mesh(o.data); bm.free()
print(len(o.data.polygons), kurambit.qa([o])["notes"])
```

`game_blender` op `export` `simplify`; `M.scatter`, `M.merge` (shell/model.js); three.js `LOD`.

## Sources

EL4CTEO's blender-skills (MIT): `blender-game-optimization` (reduction order, levels at half
the triangles and 1/2, 1/4, 1/8 of the screen, vertex splits at seams, merging against culling),
`blender-export-pipelines` (web budgets); read, rewritten for three.js r180 and Kurambit's export.
Role budgets from the packs, measured 2026-11-20.
