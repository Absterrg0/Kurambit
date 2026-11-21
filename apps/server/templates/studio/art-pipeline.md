# Art pipeline

Adapted from OhMyGame's sprite-pipeline and game-ui-frontend skills (Apache-2.0).
The live Blender behind `game_blender` is your modeller and renderer. Its
`code` op runs plain `bpy` (Blender 5.x: `recipes/art-bpy.md` before your
first call), relative paths from the game root; print every path you write.
`<assets>` is `web/assets/` for three.js. Every file's source and licence is
in ASSETS.md (the tools write their own lines); unknown-source files do not
ship.

## The look: STYLE.json

`game_assets` op `lock` records `view`, `scale.character` (metres),
`budget` and `shape.edges`. Models ship with your own materials and
textures. A `palette` with `finish: "flat"` puts every model on one atlas:
only when the person chose it. How models are made is in game.json:
`characters` `any` (you choose per model; Blender is recommended for
anything sculpted or hard-surface), or `blender` or `code` when the person
locked one, and `library` (off by default: its models stay out, its clips
and sounds come in).

## The method

Good models are one continuous, dense surface per body region, matched to
a reference, with rigid pieces only where the thing is rigid. Parts of
low-sided tubes on a skeleton read as a toy robot.

1. Reference first. The person's picture, the brief's key art, or a front
   and side sheet you draw for this subject (`art/concepts/<name>.png`).
   `kurambit.ref_planes(front=, side=, height=)` stands them behind the
   model with an orthographic camera each; match proportions before any
   detail.
2. Block the masses at real size (a 1.8 m person, a 0.9 m door), facing
   -Y, +X their left, feet on z 0.
3. Dense form, one surface per region:
   - a body from a base: `game_blender` op `character` with `body`
     `{studio: {gender}}` (a drawn stylised body, no install), `mpfb`
     (a realistic human), `library` or `game`; reshape its mesh yourself;
   - or from scratch: `kurambit.sweep(path, stations, sides=48-96)` per
     region (torso, limb, neck, tail, hull, trunk), fused with
     `kurambit.one_skin([...], voxel=, smooth=)`, then a Subdivision
     modifier.
4. Rigid only what is rigid: armour plates, weapons, buckles, wheels,
   doors, each a `kurambit.hard_surface(obj, cutters=, bevel=)` piece
   (boolean, bevel by angle, weighted normals).
5. Cloth as shells of the body: a copy of the body's faces, shrinkwrapped
   and solidified 1-3 cm, so it bends with it. Hair as a sweep or cards.
6. Materials: Principled with real roughness and metal. Cloth, leather,
   metal, wood and stone take a photo scan's grain under their own colour:
   `game_blender` op `asset_import` `{source: "polyhaven", id, applyTo}`
   (op `asset_search` with assetType `textures` finds one). Procedural
   nodes do not ship: bake them.
7. Look at the pictures and refine; then export. Your own looks show what
   you meant: a look with `fresh: true` and `about` shows the picture to a
   separate model that names the biggest visible defects.
8. Bake down only if the running game's Performance row says the scene is
   too heavy: `kurambit.bake_down(high, low=)` puts the dense detail into
   normal and AO maps on a light mesh (`recipes/art-budget.md`).

Notes on demand: `recipes/art-characters.md` (people, animals),
`recipes/art-hard-surface.md` (props, vehicles, buildings),
`recipes/art-rigging.md` (skeletons, weights, clips),
`recipes/art-budget.md`, `recipes/light.md`.

## Characters and creatures

Model them in an A-pose (arms 30-45° down, clear of the body; legs apart),
facing -Y, with every prop (sword, shield, bag) a separate object, and four
legs separated down to the feet: a rig is fitted to the joints, and weights
come from Blender's automatic weights on the body, with props rigid on one
bone (`recipes/art-rigging.md`). Keep the joint positions you built on
where your code can print them: the rig takes them as `joints`.

## The loop

Model, then look: `game_blender` op `look` with `mode: "review"` renders a
turnaround, clay, silhouettes, game distance, a character's clips and the
`reference` picture beside it, and prints what it measured;
`kurambit.qa([...])` counts what pictures hide (inward faces, flicker).
Change what the picture shows is wrong and look again; you decide when it
is good. `game_blender` op `export` runs the same pass, writes the GLB and
its sidecar and prints the same facts; it refuses only a file that would
be broken in the game. Load it in the game by its sidecar (TEMPLATE.md).
The export applies every modifier but Armature: leave them live.

What repeats is drawn as instances in the game (`M.scatter`,
shell/model.js); the ground is code (`M.ground`). A model painted from a
turnaround sheet: `game_blender` op `paint`.

## Key art

Render it from the game's real assets at 1280x720 in a throwaway scene
removed in `finally`, view transform `Standard`. Open every PNG you render.
