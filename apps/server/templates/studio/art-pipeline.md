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

## How the packs are made

The best CC0 packs (KayKit, Kenney, Quaternius) win on surface and purpose,
not geometry. Each rule names the number the review reports for it; quote it
when you judge a model.

1. **One gradient atlas.** Give each part a flat colour
   (`kurambit.material("#RRGGBB", name="Roof")`); the export packs them into
   one material on one small atlas of vertical-gradient swatches, lighter on
   top, and Art lists and edits each swatch by its name. Reported:
   _materials_ (1, plus Glow if something glows), _textures_, _swatches_.
2. **Three to five hues per object**, each in a light and a dark value; the
   atlas warms each swatch's light end and cools its dark end.
   Reported: _hue families_.
3. **Silhouette first, at game distance.** Block the big masses and look
   before any detail: in black at the size it plays, it must read as its
   subject and show which way it faces. Reported: _overlap_ with your
   reference per view and its _width by tenths of height_; the
   game-distance tile.
4. **Purposeful detail.** Spend triangles where the player looks: a face,
   hands, the weapon, a door, windows, an awning. A KayKit building is 828
   triangles with all of that. Name the model's role
   (`obj["kurambit_role"] = "building"`); budgets are the packs': prop 600,
   rock 400, plant or tree 1,000, building 2,000, creature 3,000, hero 7,000.
   Reported: _triangles of the role's budget_.
5. **Faceted or smooth, on purpose and alike.** Faceted is flat shading.
   Smooth is smooth by angle with a small bevel. Reported: _flat-shaded share_ against the lock's `shape.edges`.
6. **Chunky.** Big heads, hands and feet; thick trunks, big crowns and
   roofs. A part thinner than 3 px at game distance vanishes. Reported:
   _thin share_ of the game-distance silhouette.
7. **One family, one scale, one ground line.** Everything stands on z = 0 at
   the lock's scale. Reported: _height_ and _footprint_.
8. **Characters from a base** (op `character`), never from scratch.
   Reported: _rest frames off the standard skeleton_.
9. **One texel density.** A texture is the exception (a sign, a painted
   face) and stays within `budget.texture`. Reported: _textures_ by size.
10. **Nothing floats, nothing pokes through.** Parts that meet enter each
    other. Reported: _parts over 0.5 mm from every other_, _skin through
    skin_.

## The loop

Model, `game_blender` op `look` with `mode: "review"`, read the numbers,
change one thing, review again. Pass `reference`: the brief's picture, the
key art, `art/concepts/<name>.png`, or a library model as yardstick
(`<pack id>:<file>`, a file `game_assets` op `search` lists). The review
sets it beside the model at the same framing and reports the overlap. Fix
what the export would refuse first, then silhouette, game distance, colour
and craft. Write each defect numbered, with its fix, before changing
anything; "looks good" is not a review. A defect back after two fixes needs
another method. Stop when nothing blocking is left, or two rounds fixed
nothing, and name what is left. `game_blender` op `export` writes exactly the reviewed model and its
sidecar; name it in the game by its sidecar (TEMPLATE.md).

## Making in Blender

Model with Blender's own tools in op `code`: primitives, bevel, mirror,
array, boolean, skin and subdivision modifiers for organic masses, a voxel
remesh to fuse them, decimate to the role's budget. Apply modifiers
before export (`bpy.ops.object.convert(target="MESH")`). Place features by
raycast, never guessed coordinates: `kurambit.place_on_surface(obj, target,
(0, 1, 0))`. Models face -Y, +X is their left.

Blender's bundled node groups load by name with
`kurambit.blender.node_group("Smooth by Angle")` (and the hair curve
groups); `kurambit.blender.scatter(obj, on=ground, density=2, seed=1)`
scatters instances, `kurambit.blender.tube(curve, radius)` sweeps a curve:
both are plain Geometry Nodes on the live object.

## Characters

### Humanoids

`game_blender` op `character` puts a body on the standard skeleton, so the
library's clips play on it unchanged: `height` from the brief, `clips` by
name (the standard set has no attack: name `Sword_Attack`, `Punch_Jab` or
`Spell_Simple_Shoot` when it fights). A small or round character takes a child
body or the chibi style. Model clothes, hair and gear over it at rest in op `code` and bind
each part with `kurambit.skin_rigid(part, "head")` (or a `{bone: weight}`
dict); a part across a joint takes Blender's Data Transfer weights from the
body. Hair is chunky locks, never one smooth shell; `kurambit.eye_lid` makes an
eye blink. What a hand holds:
`kurambit.hold(prop, "r", grip=, tip=)`.

A move the library lacks (a combo, a stagger): `game_blender` op `animate`,
poses on beats from a library pose; read its pictures and numbers, change
one thing, and animate again until neither improves.

### Creatures and machines: own rig, own clips

A creature, a machine on hinges or a humanoid that plays only its own clips
enters on its own rig and never plays library clips. Rig it with Rigify:
`meta = kurambit.blender.metarig("wolf", height=0.9)` (`basic_human`,
`human`, `basic_quadruped`, `horse`, `wolf`, `cat`, `bird`, `shark`), move
its bones onto your body in edit mode, then `rig =
kurambit.blender.rigify(meta, body)`: Rigify's controls, automatic weights.
Key each clip on the controls as an action named as the game plays it (an
idle first: `Idle`, `Walk`, `Attack`), then `kurambit.blender.game_rig(rig,
"wolf")` bakes them onto a rig of its deform bones alone, marked as the
creature's own, and that rig and its body are what you review and export. A
loop's last key equals its first and keeps its travel in place. A vehicle
needs no rig: `kurambit.pivot(wheel, hub, parent=body)` per moving part.

### The hero sheet

A character or creature is done when the review keeps its sheet in
`art/sheets/` and your critique is beside it (`game_check` op `final` lists
the rest): `art/sheets/<sheet name>.md`, the brief's words for the subject,
the review's numbers, then each defect numbered, biggest first, with what
you fixed or why not.

## Props

Made the same way; with the library on, the lock's packs first. A
third-person or top-down camera needs low partitions (about 1.8 m in a 4 m
cell). Set pieces that snap are each their own export, origin where the game
places them; `kurambit.grid(pieces, 4)` names any gap. What repeats is drawn as instances in the
game (`M.scatter`, shell/model.js); the ground is code (`M.ground`). A prop
painted from a turnaround sheet: `game_blender` op `paint`, after the model's
overlap with the sheet passes about 0.75. Realistic textures (Poly Haven,
ambientCG) belong only in a realistic lock.

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
3. **Characters and props.** If `game_check` op `status` shows the lane
   null in `artLanes`, tell the person what Settings → Art providers needs.
   Otherwise a sheet (lane `image`, full body, front, arms down), the
   person picks, then lane `character`, `creature` or `model` with it as
   the only reference. A humanoid goes through op `character` with `body:
{game: "<the .glb>"}`, anything else through op `asset_import` with
   `source: "generated"`; stand it facing -Y, review with the sheet as
   `reference`, export. A move the library lacks: lane `motion`.
4. **Images**: lanes `image` and `texture` with the key art as reference;
   op `image_edit` changes a picked one. Never switch route or lane to get
   past a refusal.

## 2D sprites from 3D

Render sprites and strips with `game_blender` op `sprites`, never your own
render code, and look at its contact sheet; the game plays its
`.sheet.json` (`pictures.md`). A library character: import its GLB, then
render with `"objects": ["<rig>"], "action": "Walking_A"` once per clip. Pixel art: leave out `pixelArt`, `size` and `views`. Pass the first strip's
`pixelsPerUnit` to every other strip of that character. Views: side-scroller `right`; top-down `front`, `back`,
`left`, `right` with `elevation` 35, or `top`; `isometric`.

## Key art

Off the generated route, render it from the game's real assets at
1280x720 in a throwaway scene removed in `finally`, view transform
`Standard`. Open every PNG you render.

Other kinds of art: `voxels.md` (blocky worlds, .vox), `pictures.md`
(cards, tiles, icons, UI art, 2D characters).
