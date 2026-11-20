# Ruin and building piece: coursed blocks on the grid

**When.** Walls, arches, towers, houses, temples: set pieces that snap on a grid.

## Numbers

- **4 m grid**, depth at most 1 m for a wall (the grid's thin limit); a house fits whole cells.
- Courses **0.5 m**; blocks 0.55-1.0 m long, joints staggered 0.25 m, 3 cm gaps; bevel 3.5 cm,
  1 segment.
- An arch of 9 voussoirs, the keystone proud.
- At most **2,000** triangles a piece (role `building`); a plain wall can be a slab with inset
  bricks (KayKit's broken wall is 784).
- A KayKit building spends 828 triangles on windows, a door, an awning: detail where the player looks.
- A third-person camera wants low partitions, about 1.8 m in a 4 m cell.

## Steps

1. Plinth along the piece.
2. Course loop: for each 0.5 m row, lay blocks of random length; split the row at an opening's
   edges. Below the spring line skip the opening; above it keep a block only if its bottom clears
   the arch's outer curve.
3. Voussoirs: for i in 0..8 a polar quad between radii r and r + 0.35 at angles i·π/9 to
   (i+1)·π/9, extruded through the depth; the middle one 5 cm proud.
4. Pillars from drums (bevelled cylinders), with a base and a capital.
5. Break the top with a falling line (drop whole blocks, never cut them); moss caps on the
   highest tops.
6. A house: walls on the cell edges, a door and windows as insets and frames, a roof of two
   slabs overhanging 15-25 cm, a chimney; every part resting on what is under it.
7. Rubble as its own set piece, never inside the wall.
8. Origin at the grid corner, base on z 0; `kurambit.grid([pieces], 4)` names any gap.
   `piece["kurambit_role"] = "building"`.

## Pitfalls

- A block wedged over an opening touches its neighbours, so it is not floating; the review's
  unsupported line names it.
- Jitter on end pillars breaks the grid by 2 cm.
- Rubble inside the piece moves its base and breaks the grid.
- One unique mesh per wall kills instancing: variety from broken variants and rotation.

## Checks

```yaml
- grid(4).fits == true # H kurambit.grid
- triangles <= 2000 # H style.roleBudget
- floating == []; unsupported == [] # H contact
- style.flat >= 0.9 when faceted # H style pass
```

## Code

Plain `bpy` and `bmesh`; `kurambit.grid`, `kurambit.material`.

## Sources

KayKit Dungeon Remastered `wall_broken`, `wall_arched` (4 x 1 x 4 m, measured); KayKit City
Builder building (828 triangles); Kurambit's asset study 2026-11-20 (ruin: 1,892 triangles,
fits the grid); TF2 on repetition (RECIPES A6, read).
