# Rigging and clips

**When.** A model that moves: a character playing the library's clips, a creature walking, a
held prop.

## Technique

- A human on the standard skeleton: `game_blender` op `character` conforms a body to it and
  brings the library's clips by name (`clips`; the standard set has no attack: add
  `Sword_Attack`, `Punch_Jab` or `Spell_Simple_Shoot`), springs for tails and ears (`chains`),
  and its height. A body you built yourself: op `character` with `body: "none"` gives the
  skeleton at your proportions and prints its joints; build on them, then bind.
- Bind a continuous body with Blender's automatic weights: the Armature modifier plus
  `bpy.ops.object.parent_set(type="ARMATURE_AUTO")` inside a `temp_override` with the body and
  then the armature selected, the armature active. Where bone heat fails (a mesh of separate
  overlapping parts), weight a voxel-remeshed proxy of it and copy the weights back with a Data
  Transfer modifier (vertex groups, nearest face interpolated).
- Clothes shells take the body's weights by Data Transfer the same way. Rigid things ride one
  bone: `kurambit.skin_rigid(plate, "upperarm_l")`; a held prop with
  `kurambit.hold(prop, "r", grip=, tip=)`.
- A creature: `kurambit.blender.metarig("basic_quadruped" | "horse", height=)` is its skeleton;
  fit its bones in edit mode to your model's joints, set `use_deform` on every bone, bind with
  automatic weights, and key a walk with `kurambit.blender.bake_ik_walk(meta, feet, step,
frames)` (diagonal pairs, each paw planted about 60% of the cycle).
- A move the library lacks: op `animate` (poses on beats; the spec is in the kit's animate
  module), or key it with `pose_bone.keyframe_insert` on a named action.
- Name clips as the game plays them; give every character an idle. The export keeps each action
  as a clip and measures ground speed, so the game's feet stay planted.

## Pitfalls

- Generating Rigify's full rig twists the rest pose (133° at a front thigh, measured): keep the
  meta-rig itself as the skeleton.
- Wolf and cat meta-rigs carry about 190 deform bones: use `basic_quadruped` or `horse`.
- Torso weights reaching the thighs tear a hem in a lunge; arms modelled against the body drag
  the ribs.
- A part weighted to no bone stays behind when the character moves: the export refuses it.
- Actions are layered in Blender 5: `action.fcurves` is gone (`recipes/art-bpy.md`).

## Sources

Kurambit's asset study 2026-11-20 (the rest-pose twist and stretch, measured); the Mesh2Motion
proof 2026-11-21 (bone heat plus a voxel proxy and Data Transfer bound every model in about 2 s).
