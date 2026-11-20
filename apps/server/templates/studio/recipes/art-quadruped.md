# Quadruped: the meta-rig as the skeleton, lofted parts, an IK walk

**When.** An animal the library lacks. Check Quaternius Animated Animals first (wolf, fox, deer,
horse, cow, husky and more), on the library route.

## Numbers

- Creature budget **3,000** triangles; Quaternius animals median 2,079.
- 8 sides per ring, flat shaded: the faceted animal look.
- The spine runs along the **top** of the back: body rings hang below it, deepest at the chest
  (chest depth about 0.45 of shoulder height).
- Legs about 0.13 of the height thick at the hip; cannon bones at least 0.04 m at 1 m tall.
- Hock and wrist: a leg ring is a teardrop, not a circle (rv larger behind than in front), and
  the hind leg bends back at the hock.
- Walk: 30 frames at 30 fps, diagonal pairs, each paw planted 60% of the cycle.

## Steps

1. `KB = kurambit.blender; meta = KB.metarig("basic_quadruped", height=0.9)` (or `horse`). It
   prints the joint print. Fit the tail, neck and legs in edit mode.
2. Loft the body below the spine, rump to neck; the head along the skull with a tapering muzzle;
   each leg from shoulder or hip to toe through its joints, its top inside the body; paws, ears,
   a bushy tail. Colour by separate parts (bib, jaw, tail tip).
3. The meta-rig itself is the armature: `for b in meta.data.bones: b.use_deform = True`. Weight
   each part to its own bones: `kurambit.skin_rigid(leg, kurambit.weights_along(meta,
["thigh.L", "shin.L", "foot.L", "toe.L"]), armature=meta)`; the body to its spine bones only.
4. Clips with IK legs, baked:
   ```python
   n, stride, lift = 30, 0.13, 0.07
   phase = {"foot.L": 0, "front_foot.R": 0, "foot.R": .5, "front_foot.L": .5}
   def step(foot, f):
       u = (f / n + phase[foot]) % 1
       if u < .6: return Vector((0, -stride + 2 * stride * u / .6, 0))
       w = (u - .6) / .4
       return Vector((0, stride - 2 * stride * w, math.sin(math.pi * w) * lift))
   KB.bake_ik_walk(meta, list(phase), step, n, clip="Walk")
   KB.bake_ik_walk(meta, list(phase), lambda foot, f: Vector(), 60, clip="Idle")
   ```
   Key a bob or a breath on the action first (`pose.bones[...].keyframe_insert` on
   `bpy.data.actions["Walk"]`); the bake keeps it. Name the role: `meta["kurambit_role"] = "creature"`.
5. Review against the library animal.

## Pitfalls

- Rigify `rigify()` then `game_rig()` twists the rest pose (133° at a front thigh, measured): keep
  the meta-rig.
- Rings centred on the spine give a thin body hung high.
- Body weights reaching the thighs: 3.42x stretch.
- Round tube legs on straight joints read as stilts; give the hock its angle.
- Wolf and cat meta-rigs carry 181-197 deform bones: use `basic_quadruped` or `horse`.

## Checks

```yaml
- gates: [height, deformation, feet, budget] all pass   # H gates
- triangles <= 3000                                      # H style.roleBudget
- detachedChains == []                                   # H measure (limbs reach the spine)
- walk ground speed > 0; seams loop                      # H clip facts
```

## Code

Rigify's meta-rigs (bundled with Blender, GPL; only the skeleton data ships), `kurambit.loft`,
`weights_along`, `kurambit.blender.bake_ik_walk`.

## Sources

Kurambit's asset study 2026-11-20 (wolf: 1,612 triangles, all gates, Walk 0.46 m/s; the rest-pose
twist measured); Quaternius animal triangle counts, measured; kiln's metaball bodies (read, untested).
