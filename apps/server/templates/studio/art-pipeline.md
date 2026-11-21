# Art pipeline

Adapted from OhMyGame's sprite-pipeline and game-ui-frontend skills (Apache-2.0).
The live Blender behind `game_blender` is your renderer and modeller; you
have no other. Its `code` op runs plain `bpy`, relative paths from the game
root (`~` is its own home); print every path you write. `<assets>` is
`web/assets/` for three.js. Every file's source and licence is in ASSETS.md
(the tools write their own lines); unknown-source files do not ship.

## The look: STYLE.json

Before the first model, `game_assets` op `lock` writes the look from the
brief: `view`, `palette` (hex colours, or a PNG such as the key art),
`shape.edges` (`faceted` or `smooth`), `scale.character` (metres), `budget`.
Change direction by locking again, never by drift. How models are made is
the person's choice in game.json: `characters` (`blender`, `code` or
`generated`) and `library` (off by default). Read both before any model; an
unrigged model is a prop on every route. With the library off its models
are refused, but its clips and sounds come in, and any library model can be
your yardstick in the review.

## Art recipes

Each kind of model is a `recipes/art-*.md`, indexed in `studio-skills/AGENTS.md`:
read the one or two your model needs.

## The loop

Model, `game_blender` op `look` with `mode: "review"`, read the numbers,
change one thing, review again. Pass `reference`: the brief's picture, the
key art, `art/concepts/<name>.png`, or a library model as yardstick
(`<pack id>:<file>`, a file `game_assets` op `search` lists). The review
sets it beside the model at the same framing and reports the overlap, the
look (materials, hue families, flat share, triangles of the role's budget:
name it with `obj["kurambit_role"]`), floating and unsupported parts, and a
character's gates; `kurambit.qa([...])` counts what it cannot see (inward
faces, flicker). Fix what the export would refuse
first, then silhouette, game distance, colour and craft. Write each defect
numbered, with its fix, before changing anything; "looks good" is not a review. A defect back after
two fixes needs another method. Stop when nothing blocking is left, or two
rounds fixed nothing, and name what is left. `game_blender` op `export`
writes exactly the reviewed model and its sidecar; name it in the game by
its sidecar (TEMPLATE.md).

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

## The hero sheet

A character or creature is done when the review keeps its sheet in
`art/sheets/` and your critique is beside it (`game_check` op `final` lists
the rest): `art/sheets/<sheet name>.md`, the brief's words for the subject,
the review's numbers, then each defect numbered, biggest first, with what
you fixed or why not.

## Generated art

On the `generated` route providers make the art (`game_assets` op
`generate`) and the person picks every candidate. Stand-ins play until each
piece arrives: start a generation, keep building, pick it up with op
`wait`, and say what it cost.

1. **Key art, in the first turn.** Lane `image`, name `key_art`,
   `options.aspect` `"16:9"`, the game's world and moment in one image (no
   text or UI), and three `directions` that differ in rendering, palette and
   shape language, each an in-game screenshot this engine can reach,
   labelled in two or three words, grounded with a `style`: a library pack
   id of a different family each (Kenney and Quaternius Monsters ship a
   picture; KayKit none), or the person's reference.
2. **After the pick**, copy it to `art/key-art.png`, read its colours with
   `kurambit.palette_of("art/key-art.png", 8)` and lock them as `palette`
   (leave `palette` out for a painted or realistic key art) with `anchor`.
   Pass it in `references` of every later image.
3. **Characters and props.** If the status line of `game_check` op `final` shows the lane
   null in `artLanes`, tell the person what Settings → Art providers needs.
   Otherwise a sheet (lane `image`, full body, front, arms down), the
   person picks, then lane `character`, `creature` or `model` with it as
   the only reference. A humanoid goes through op `character` with `body:
{game: "<the .glb>"}`, anything else through op `asset_import` with
   `source: "generated"`; stand it facing -Y, review with the sheet as
   `reference`, export. A move the library lacks: lane `motion`.
4. **Images**: lanes `image` and `texture` with the key art as reference;
   `game_assets` op `generate` with `edit` changes a picked one. Never switch route or lane to get
   past a refusal.

## 2D sprites from 3D

Render sprites and strips with `game_blender` op `sprites`, never your own
render code, and look at its contact sheet; the game plays its
`.sheet.json` (`recipes/pictures-2d.md`). A library character: import its GLB, then
render with `"objects": ["<rig>"], "action": "Walking_A"` once per clip. Pixel art: leave out `pixelArt`, `size` and `views`. Pass the first strip's
`pixelsPerUnit` to every other strip of that character. Views: side-scroller `right`; top-down `front`, `back`,
`left`, `right` with `elevation` 35, or `top`; `isometric`.

## Key art

Off the generated route, render it from the game's real assets at
1280x720 in a throwaway scene removed in `finally`, view transform
`Standard`. Open every PNG you render.

Other kinds of art: `recipes/voxels.md` (blocky worlds, .vox),
`recipes/pictures-2d.md` (cards, tiles, icons, UI art, 2D characters).
