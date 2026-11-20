# Voxels

A blocky world, chunky characters or a diorama is made of voxels, not of
bevelled low-poly that looks nearly right.

## The lock

`game_assets` op `lock` with `shape: {edges: "voxel"}`: models and
`shell/model.js` boxes come out square and flat-shaded, and textures and
sheets draw their texels as squares. A voxel model keeps its cubes under any
lock: the style pass never thins or shades across it.

## A model

In `game_blender` op `code`, write the model as slices seen from the front,
front slice first, each slice's rows top to bottom, `.` empty:

```python
import kurambit
crate = ["wwww", "wddw", "wddw", "wwww"]
side = ["w..w", "....", "....", "w..w"]
kurambit.voxels("crate", [crate, side, side, crate],
                {"w": ("Wood", "#9a6b3f"), "d": "trim"}, size=0.125)
```

A palette value is a hex, a lock role, or `(name, colour)`; Art lists each
colour by its name. Or pass a numpy array `[x, y, z]` of indices into a list
palette (0 empty): a terrain or a tree is easier to fill in code. `size` is
metres per voxel; the model stands on the ground at its bottom centre,
facing -Y, in one material and one draw call. Then review and export it as
any prop (`art-pipeline.md`, Making in Blender). It needs the MagicaVoxel add-on: the
first call says how to install it (`game_blender` op `addon`).

A `.vox` file someone gave the game: `kurambit.voxels("tree", vox="art/tree.vox",
licence="CC0, by ...")`, its first model (`model=` another). The licence goes
into ASSETS.md with the export.

## A character

Rigid parts on the standard skeleton, playing the library's clips:

1. `game_blender` op `character` with the body and `style` closest to the
   voxel design (`chibi` for a big head) and its `height`.
2. In op `code`, delete the body mesh it made and write the voxel body
   standing with its arms hanging down beside it:
   `kurambit.voxels("knight_body", slices, palette, size=1/16,
armature="knight", follow={"a": "upperarm", "G": "hand"})`. Each voxel
   follows the nearest bone; a key in `follow` follows the bone named (its
   side from where the voxel is), which keeps sleeves off the chest. Head,
   chest, hips, arms and legs are rigid blocks; a whole arm or leg points
   along the clip's limb, so no clip folds it.
3. Review and export it as any character; its strips show where a joint
   splits a part wrongly.

## A world

Many blocks are drawn as one `THREE.InstancedMesh` of a cube, with only the
voxels that have an open face (`setColorAt` for each colour), or as voxel
models exported in chunks. The game keeps the heights it built the field
from, for what stands on it.
