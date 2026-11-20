# Stylised humanoid: parts on the standard skeleton

**When.** A hero or NPC the library does not have, made in Blender. The library's clips must
play on it.

## Numbers

- Head **0.35-0.40** of the height for chibi (KayKit's Rogue is about 0.40), about 0.25 for
  cartoon. Legs about 0.28 of the height: op `character`'s chibi puts the hip at 0.345 of 1.2 m.
- Hero budget **7,000** triangles; the Rogue is 6,457 with its weapons, built as separate parts
  (head 1,115 rigid to one bone, body 1,172, each arm 580, each leg 408).
- Parts of 8-16 sides; subdivision 1 only on the head, the hair cap and the torso.
- Weights: each part on its own bones, top 3, inverse distance to the power 6.
- Mitts about 1.2x the forearm; thin wrists vanish.

## Steps

1. `game_blender` op `character` with `body: "none"`, `height` from the brief, `style.preset`
   `chibi` or `cartoon`, and `clips` by name (add `Sword_Attack` when it fights). It returns the
   joint print: the rest pose (a **T-pose**, arms along ±X, facing -Y) and every joint's world
   position. Model on those numbers.
2. Block each part as a ring loft whose stations sit on its joints:
   ```python
   arm = bpy.data.objects["hero"]
   J = lambda n: arm.matrix_world @ arm.data.bones[n].head_local
   leg = kurambit.loft([(J("thigh_l") + Vector((0, 0, 0.06)), .075, .07), (J("calf_l"), .06, .055),
                        (J("foot_l") + Vector((0, 0, .03)), .05, .05)], sides=10, material=M["pants"], name="leg_l")
   kurambit.skin_rigid(leg, kurambit.weights_along(arm, ["thigh_l", "calf_l"]), armature=arm)
   ```
   Head (squircle 2.4-2.6, a rounded box), torso from hip to shoulder flaring to a hem above the
   hip joint, arms on shoulder, elbow and wrist rings, legs with a ring hidden 6 cm up inside the
   torso, boots lofted along -Y with their base on z 0.
3. Review against a library hero (silhouette recipe). Fix the masses first.
4. Dress in separate shells: a hair cap with the face cut out, solidified 2 cm, plus a few
   flat-shaded locks; scarf, belt, bracers, cuffs as lofts. The face is paint
   (`kurambit.decal`, palette recipe) or a few parts placed with `kurambit.place_on_surface`.
5. Weights: the head and everything on it, hands and props rigid to one bone
   (`skin_rigid(part, "Head")`); torso, limbs and boots with `weights_along`, each limited to its
   own chain (the torso: pelvis, spine and the clavicles, never the thighs).
6. A prop in the hand: `kurambit.hold(prop, "r", grip=, tip=)`.
7. Review; read the deformation gate on the attack clip first.

## Pitfalls

- Torso weights reaching the thighs tear the hem in a lunge (deformation 4.33x measured).
- Subdivision everywhere: 11,600 triangles for the same read.
- A hair cap without a face cut is a helmet.
- Starting from a dense base body and dressing it: 30-39k triangles, toes through boots.

## Checks

```yaml
- gates: [height, deformation, feet, budget] all pass   # H gates
- triangles <= 7000                                      # H style.roleBudget
- materials == 1; style.hues <= 5                        # H style pass
- floating == []; influences <= 4                        # H contact, pass
- review.thinShare_gamePx < 0.05                         # H review
- clips loop back to rest                                # H clip seams
```

## Code

Kit only: op `character` (`body: "none"`), `kurambit.loft`, `weights_along`, `skin_rigid`,
`hold`, `place_on_surface`, `decal`.

## Sources

KayKit Rogue part split, measured; Kurambit's asset study 2026-11-20 (hero: 7,450 triangles, all
gates, UAL1 Idle, Walk and Sword_Attack play in three.js); Polycount on loops at joints (read).
