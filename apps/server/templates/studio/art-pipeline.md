# Art pipeline

Adapted from OhMyGame's sprite-pipeline and game-ui-frontend skills (Apache-2.0).
The live Blender behind `game_blender` is your renderer and modeller; you
have no other. Its `code` op runs plain `bpy`, relative paths from the game
root (`~` is its own home); print every path you write. `<assets>` is
`web/assets/` for three.js. Every file's source and licence is in ASSETS.md
(the tools write their own lines); unknown-source files do not ship.

## The look: STYLE.json

`game_assets` op `lock` records `view`, `scale.character` (metres),
`budget`, `shape.edges`. Models ship with your own materials (metal, glass,
glow). A `palette` with `finish: "flat"` is the pack look, every model on
one atlas (`recipes/art-palette.md`): only when the person chose it.
Change direction by locking again, never by drift. How models are made is
the person's choice in game.json: `characters` (`blender` or `code`) and
`library` (off by default). Read both before any model; an
unrigged model is a prop on every route. With the library off its models
are refused, but its clips and sounds come in.

## Art recipes

Each kind of model is a `recipes/art-*.md`, indexed in `studio-skills/AGENTS.md`:
read the one or two your model needs.

## The loop

Model, then look: `game_blender` op `look` with `mode: "review"` renders a
turnaround, clay, game distance and a character's clips, with `reference`
(the brief's picture, the person's, or `art/concepts/<name>.png`) beside it,
and prints what it measured; `kurambit.qa([...])` counts what it cannot see
(inward faces, flicker). Change what the picture shows is wrong, and look
again. `game_blender` op `export` runs the same pass, writes the model and
its sidecar and prints the same facts; it refuses only a file that would be
broken in the game. Name it in the game by its sidecar (TEMPLATE.md).

## Making in Blender

Code for 4.5 and 5.x, or a failed call: `recipes/art-bpy.md`.
Build parts on a structure, never one sculpted blob: a skeleton's joints, a
side profile, the 4 m grid. Primitives, `kurambit.loft` (rings on joints),
bevel, mirror, array, boolean; the export applies modifiers (not Armature),
so leave them live. Place features by raycast:
`kurambit.place_on_surface(obj, target, (0, 1, 0))`. Models face -Y, +X is
their left, feet on z 0.

A humanoid: `game_blender` op `character` puts the standard skeleton, sized,
with the library's clips (`clips` by name; the standard set has no attack:
`Sword_Attack`, `Punch_Jab` or `Spell_Simple_Shoot`). `body: "none"` gives the
skeleton and its joint print to model parts on; a body (`library`, `mpfb`,
`game`) comes painted in the material `<name> skin`. Parts bind with
`kurambit.skin_rigid(part, "Head")` or `kurambit.weights_along`; a hand holds
with `kurambit.hold(prop, "r", grip=, tip=)`. A move the library lacks: op
`animate`, poses on beats from a library pose.

An animal: `kurambit.blender.metarig(kind, height=)` is its skeleton
(`basic_quadruped`, `horse`, ...); `kurambit.blender.bake_ik_walk` keys its
clips.

Set pieces that snap are each their own export, origin where the game
places them (`art-ruin`). What repeats is drawn as instances in the game
(`M.scatter`, shell/model.js); the ground is code (`M.ground`). With the
library on, the lock's packs come first. A prop
painted from a turnaround sheet: `game_blender` op `paint`, after the
model's overlap with the sheet passes about 0.75. Realistic textures (Poly
Haven, ambientCG) belong only in a realistic lock.

## Key art

Render it from the game's real assets at
1280x720 in a throwaway scene removed in `finally`, view transform
`Standard`. Open every PNG you render.

Other kinds of art: `recipes/pictures-2d.md` (cards, tiles, icons, UI art, 2D characters).
