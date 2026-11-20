# Silhouette first, against the reference

**When.** Every model, before any detail: the first review of a character, creature, vehicle or
set piece.

## Numbers

- A part under **3 px** across at game distance vanishes; the review reports the share of the
  silhouette in such parts (keep it under 5%).
- Overlap with the reference at the same height: about **0.7** or more on the views the subject
  shares with it. A T-posed reference against an A-posed model, or a solid wall against an arch,
  reads low by construction: compare the views that mean something.
- Masses first: 3 to 7 big parts carry the read (head, torso, limbs; body, cabin, wheels; trunk,
  crown).
- Stop when two rounds gain nothing.

## Steps

1. Pick the yardstick: the brief's picture, the key art, or a library model as
   `<pack id>:<file>` from `game_assets` op `search` (a Rogue for a hero, a Quaternius animal
   for a creature, a KayKit car or wall).
2. Block the big masses only, as lofts and primitives (`kurambit.loft`, `bpy.ops.mesh.primitive_*`),
   on the structure the subject has: a skeleton's joints, a side profile, a 4 m grid.
3. `game_blender` op `look` with `mode: "review"` and `reference`. Read: overlap per view, widths
   by tenths of height, the game-distance tile, the silhouettes row.
4. Fix the largest band difference first (a head too small, a chest too shallow, a wheel off its
   arch). Write each defect numbered with its fix before changing anything.
5. Only when the masses read: detail where the player looks.

## Pitfalls

- Detailing before the masses read: the detail is thrown away.
- An overlap taken at a different height or camera than the reference's.
- Thin wrists, legs, railings and branches vanish at game distance: make them chunky.
- One sculpted blob decimated to budget gives random facets and no edge loops: build parts.

## Checks

```yaml
- review: "review.overlap.sameHeight >= 0.7 on the views shared with the reference (review)"
- review: "review.thinShare_gamePx < 0.05 (review)"
- review: "floating == [] (contact)"
- review: "problems: [] (review)"
```

## Code

Kit only: `kurambit.loft`, the review's `reference`.

## Sources

TF2's class silhouettes and Overwatch's read-at-distance (RECIPES A2); majidmanzarpour's
blockout gate (IoU ≥ 0.85, read only); Kurambit's asset study 2026-11-20 (overlaps measured).
