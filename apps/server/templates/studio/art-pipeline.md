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

## Modelling

Model the way you would in Blender on your own: plain `bpy`, with whatever
technique this subject wants. Write each model as one script,
`art/blender/src/<name>.py`, that builds it from an empty scene, and rerun
it whole after each edit (`exec(open(path).read())` in op `code`), so the
model is always what the script says.

What the game needs from a model, however it is made:

- Real size in metres (a 1.8 m person, a 0.9 m door), facing -Y, +X its
  left, standing on z 0.
- What moves apart (a wheel, door, lid, turret, a held sword) is its own
  object with its origin at the hinge; what never moves apart is joined,
  one draw call a copy. A building kit's pieces are separate exports with
  their origin where the game snaps them.
- Surfaces closer than 5 mm flicker in the game (2 cm seen from far), and
  faces turned inward vanish: `kurambit.qa([...])` counts both.
- Principled materials with real roughness and metal. UVs, image textures
  and normal maps ship; procedural nodes do not: bake them. A photo scan's
  grain under cloth, leather, metal, wood or stone: `game_blender` op
  `asset_import` `{source: "polyhaven", id, applyTo}` (op `asset_search`
  with assetType `textures` finds one).
- Too heavy for the running scene (its Performance row): `recipes/art-budget.md`.

## Characters and creatures

Anything that will move is built for its rig (`recipes/art-rigging.md`):
an A-pose (arms 30-45° down, clear of the body; legs apart), every prop a
separate object, and four legs separate down to the feet. Keep the joint
positions you built on where your code can print them: the rig takes them
as `joints`. A human can start from a base body: `game_blender` op
`character` with `body` `{studio: {gender}}` (a drawn stylised body),
`{mpfb: {...}}` (a realistic human, once the person agrees to the add-on),
a library body or `{game: path}`; reshape its mesh before it is rigged.

## The loop

Model, then look: `game_blender` op `look` with `mode: "review"` renders a
turnaround, clay, silhouettes, game distance, a character's clips and the
`reference` picture beside it, and prints what it measured. A look with
`fresh: true` and `about` shows the picture to a separate model that names
the biggest visible defects. Change what the picture shows is wrong and look
again; you decide when it is good. `game_blender` op `export` runs the same
pass, writes the GLB and its sidecar and prints the same facts; it refuses
only a file that would be broken in the game. Load it in the game by its
sidecar (TEMPLATE.md). The export applies every modifier but Armature:
leave them live.

What repeats is drawn as instances in the game (`M.scatter`,
shell/model.js); the ground is code (`M.ground`). A model painted from a
turnaround sheet: `game_blender` op `paint`.

## Key art

Render it from the game's real assets at 1280x720 in a throwaway scene
removed in `finally`, view transform `Standard`. Open every PNG you render.
