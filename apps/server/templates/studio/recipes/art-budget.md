# Budget and bake

**When.** The running game's Performance row says a scene is too heavy, or a model is seen both
near and far, or repeated hundreds of times. Not before: make the model good first.

## Technique

- The only budget is the running scene's: draw calls and triangles in the Performance row
  (`three.md`). A scene under about 300 draw calls and 1.5M triangles runs on most laptops.
- Every mesh object is a draw call for every copy, and every material on it one more: join what
  never moves apart, and draw repeats as instances (`M.scatter`; `M.merge` merges a model's parts
  that share a material).
- A dense model too heavy for its scene keeps its look on a light mesh:
  `kurambit.bake_down(high, low=None, maps=("normal", "ao"), size=1024)`. The best low for a hard
  surface prop is its blockout before the bevels; for a body, a remeshed or decimated copy. Add
  `"color"` to bake the high's colour onto one material.
- At export, `game_blender` op `export` with `simplify: <triangles>` thins the shipped copy and
  keeps the outline and UV seams. A big model seen near and far: export a second copy with
  `simplify` at a quarter and swap them with `THREE.LOD` where it is a quarter of the screen tall.
- Cut in this order, cheapest loss first: faces never seen (face to face, buried), loops on flat
  areas (`bmesh.ops.dissolve_limit` at 2-5°), then the rest with `simplify` or a bake.
- glTF splits a vertex at every hard edge and UV seam: a vertex count three times the triangle
  count on a faceted model is expected.

## Pitfalls

- Thinning a model before the game is too heavy: the detail goes and nothing runs faster.
- One mesh for a whole level: nothing is culled.
- A Decimate ratio on a textured model tears its UVs; `simplify` and `bake_down` keep them.
- A low whose UVs overlap bakes two places onto one: let `bake_down` unwrap it.
- Triangles spent on detail under 3 px at game distance: colour it instead.

## Sources

EL4CTEO's blender-skills (MIT): `blender-game-optimization` (reduction order, levels, vertex
splits at seams) and its texture-baking workflow (the blockout as the low); Kurambit's crate
proof (75,936 triangles baked to 7,592).
