# Voxels

**When.** A blocky world, chunky characters or a diorama: made of voxels, not bevelled
low-poly that looks nearly right.

## Numbers

- `size` is metres per voxel: 1/16 for a character, 0.125 for a crate (the kit's examples).
- One material and one draw call per voxel model.
- A world: one `THREE.InstancedMesh` of a cube holding only voxels with an open face.

## Steps

1. Lock the look: `game_assets` op `lock` with `shape: {edges: "voxel"}`. Models and
   `shell/model.js` boxes come out square and flat-shaded, and sheets draw texels square.
2. A model, in `game_blender` op `code`: slices seen from the front, front slice first, each
   slice's rows top to bottom, `.` empty:
   ```python
   import kurambit
   crate = ["wwww", "wddw", "wddw", "wwww"]
   side = ["w..w", "....", "....", "w..w"]
   kurambit.voxels("crate", [crate, side, side, crate],
                   {"w": ("Wood", "#9a6b3f"), "d": "trim"}, size=0.125)
   ```
   A palette value is a hex, a lock role, or `(name, colour)`. Or pass a numpy array
   `[x, y, z]` of palette indices (0 empty). It stands at its bottom centre facing -Y. It
   needs the MagicaVoxel add-on: the first call says how (`game_blender` op `addon`).
3. A `.vox` file: `kurambit.voxels("tree", vox="art/tree.vox", licence="CC0, by ...")`; its
   licence goes into ASSETS.md with the export.
4. A character: `game_blender` op `character` with the closest `style` (`chibi` for a big
   head) and `height`; delete its body mesh; write the voxel body with arms hanging down:
   `kurambit.voxels("knight_body", slices, palette, size=1/16, armature="knight",
follow={"a": "upperarm", "G": "hand"})`. Each voxel follows the nearest bone; `follow`
   pins a key to a bone. Parts are rigid blocks; whole limbs point along the clip's limb.
5. Review and export it as any model (`art-silhouette`); a character's strips show where a
   joint splits a part wrongly.

## Pitfalls

- Bevels, smoothing or a second material on a voxel model.
- Drawing every voxel of a world as its own mesh.
- A world whose heights the game does not keep for what stands on it.

## Checks

```yaml
- review: "materials == 1 (style pass)"
- review: "floating == [] (contact)"
- fact: perf.drawCalls
  label: draw calls
  want: "<= 300"
```

## Code

`kurambit.voxels` (the kit), the MagicaVoxel add-on via op `addon`.

## Sources

Kurambit's voxel kit contract.
