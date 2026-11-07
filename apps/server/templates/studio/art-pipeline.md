# Art pipeline

Adapted from OhMyGame's sprite-pipeline and game-ui-frontend skills (Apache-2.0).
The live Blender behind the `game_blender_*` tools is your renderer and your
modeller for props; you have no local Blender, Godot or image tools.
`<assets>` is your lane's asset folder: `godot/assets/`, `web/assets/`, or
`unity/Assets/` for Unity (capital A: Unity imports nothing else, and
`unity/assets/` is a different folder it never reads; Unity art goes under
`unity/Assets/Art/`).

A game whose AGENTS.md has "The first turn" follows it there: that turn
locks the look in `STYLE.json` and adds the characters and props with
`game_assets_add`, and takes nothing else from this skill (on the
`generated` route it also starts the key art: Generated art, below). Key
art, sprite renders and Blender props come in later turns, for what no pack
has.

1. Key art first: one image the finished game must live up to.
2. Every in-game visual is a file: characters, objects, tiles, backgrounds, UI
   pieces, effects, animation frames. No code-drawn shapes, flat color
   rectangles or default UI skin on the played path. Dynamic text stays code.
3. One look, locked in `STYLE.json` before the first asset (below). The art
   tools hold the game to it.
4. Characters and creatures come the way the person chose (`characters`
   in game_status; Characters, below): from the lock's packs, made through
   the character pipeline, or generated; every made or generated one is
   exported after a review. On the `generated` route the rest of the art is
   generated too (Generated art, below); elsewhere Blender builds props, set
   pieces, backgrounds and key art.
5. One palette, one silhouette language, one ground line. Movement, hurt, win
   and lose read at a glance. Put the set in one contact-sheet PNG, look at
   it, and redo the weak ones.
6. Record every file's source and licence in ASSETS.md; unknown-source files
   do not ship. Never scrape websites.

## Lock the look: STYLE.json

`game_assets_search` with no words lists the library by style family: one
look each (KayKit, Kenney low-poly, Kenney pixel, ...), its packs, each
character pack's rig, and a pixel palette where the family has one. Look at
a pack's contact sheet (pass `pack`) before choosing. Pick one family whose
look fits the brief (and the key art, once there is one) and write `STYLE.json` at the game root:

```json
{
  "version": 1,
  "family": "kaykit",
  "mode": "smooth",
  "view": "perspective",
  "rig": "kaykit-1",
  "packs": [
    "kaykit-adventurers",
    "kaykit-skeletons",
    "kaykit-dungeon-remastered",
    "kenney-ui-pack"
  ],
  "audio": {
    "packs": ["kenney-rpg-audio", "juhani-chiptune-adventures"],
    "musicLufs": -23,
    "sfxPeakDbtp": -1
  }
}
```

- `mode`: `smooth`, or `pixel` with `tile` (source pixels per tile, 16 for a
  16 px pack) and `palette` (a pack id, or a PNG or folder in the game). A
  pack-id palette may be added without listing it in `packs`; add it with
  `game_assets_add` (any one image of it) before the first render, which
  reads its colours from the game. `outline` (true or `#rrggbb`) outlines
  pixel sprites.
- `view`: `side`, `top-down`, `isometric` or `perspective` (3D).
- `rig`: the skeleton every character shares, so every clip fits every
  character. Leave it out when nothing is rigged (a 2D game drawn from sprite
  packs); then no armature enters the game.
- `packs`: where the game's visuals come from. UI, icons and fonts packs go
  in it too.
- `audio.packs`: where its sounds come from: one effects family and one music
  source. Sound is not locked until the list exists; name it with the look.
- `imports`: outside sources the live Blender may import from (`polyhaven`,
  `sketchfab`, `polypizza`); none when left out. Realistic Poly Haven models
  sit only in a realistic look.
- `anchor`: the image the look answers to (`art/key-art.png`, the person's
  pick on the `generated` route): its palette is the lock's, and every
  generation passes it as a reference.
- 3D made models: `palette` may also be a hex list (`["#E4E4E3", ...]`, 2 to
  64 colours; take them from the family's own textures so made models sit
  with the packs), `shading` (`gradient` 0.16, `roughness` 0.62, `glow` 2.5),
  `scale.character` (metres a made character stands; KayKit heroes are about
  2.1) and `budget` (`character` 20000 and `prop` 8000 triangles, `texture`
  1024 px a side). A made character's `rig` is `standard-humanoid`.

What the tools do with it: `game_assets_add` refuses a pack outside the lists
and characters on another rig (an FBX or other model whose clips cannot be
read counts as a character), and measures each added clip's loudness against
`musicLufs` (music) and `sfxPeakDbtp` (effects);
`game_blender_render_sprites` fills the palette, outline, size and views from
the lock and refuses a palette or mode it does not hold;
`game_blender_assets_import` refuses a source `imports` does not list;
`game_blender_export` exports only what you last reviewed, as it was, and
refuses an armature not on the lock's rig (or any armature when it names
none; a generated creature keeps its own rig), rest frames off the standard skeleton, triangles or a texture over the
budget, and a character with no idle clip; `game_assets_search` shows the
lock's packs first. A refusal says what to change. Changing
direction is an edit to STYLE.json made on purpose, never a drift: when the
look changes, change the lock first, then the art. STYLE.json is the person's
to read and edit too.

## Characters

How this game's characters are made is the person's choice, kept in
game.json and shown by game_status as `characters`: `library` (the
default), `blender` or `generated`. Read it before any character; it is not in
STYLE.json, and you cannot change it. When the route cannot do what is
asked (the library has no cat), say so in your reply and name the other
routes: the person changes it under the game's More menu, "Make characters
with". A message asking for one made character does not change the route;
the tools refuse it until the person does. An unrigged model is a prop on
every route.

- `library` (the default): characters come from the lock's packs. 3D:
  `game_assets_add` the family's character models (for `kaykit-1`:
  `kaykit-adventurers` heroes and `kaykit-skeletons` enemies, 76-95 clips
  each) and play their clips by state with the engine's character animator
  (`CharacterAnimator` in Godot and Unity, `animate` in three.js;
  TEMPLATE.md), which finds "Idle", "Walking_A" or "1H_Melee_Attack_Chop"
  by their words. On `standard-humanoid`, `game_blender_character` with a
  library body (`quaternius-universal-base-characters`) puts it on the
  skeleton with the library's clips; recolour it with the palette, review
  and export it like a made one. No character fits: recolour one (a
  family's characters share one small colormap texture; edit a copy of
  that PNG and point the copy's material at it). Creatures off the humanoid
  rig come from a pack that carries their own clips.
- `blender`: made characters, below.
- `generated`: characters and creatures from generators (Generated art,
  below): a humanoid is conformed to `standard-humanoid` and plays the clip
  library, a creature keeps its own rig and clips.
- 2D sprite packs (a lock with no rig): take the characters the packs draw,
  with their own frames. To render a 3D family's character into strips,
  import its GLB into the live Blender, list its clips
  (`[a.name for a in bpy.data.actions]`), hide what it should not carry
  (`ob.hide_render = True`), then `game_blender_render_sprites` with
  `"objects": ["<rig name>"], "action": "Walking_A"`, once per clip. With a
  pixel lock, leave out `pixelArt`, `size` and `views`: the lock fills them.

### Made characters

The tools own the skeleton, its rest frames, scale, palette, budgets and
measurement. You own the shape, the pose and the judgment, and you judge
from the review image, never from your code. A character that did not go
through the review and the export is not finished.

1. **Design sheet first.** Add the subject's section to `art/CONCEPT.md`
   before the first shape. A character built without one comes out plain
   (a child in a T-shirt and shorts):
   - its role and one signature shape that makes the silhouette (a hood's
     point, a flame lock, a backpack);
   - one primary shape (round, square or triangle) and the head's share of
     the height (about 40% for a chibi);
   - the two features that must read at game distance;
   - the palette roles (main, secondary, accent, one glow);
   - the costume in layers (a base garment, an over-garment, a belt or a
     strap) and a prop or accessory that says the role;
   - three finishes at least (cuffs, a buckle, stitching, an emblem): they
     are what reads as made rather than generated.

   `art/concepts/<name>.png`, when it exists, is shown beside every review.

2. **Body.** `game_blender_character` with an `mpfb` body (age 0 is a
   toddler, 0.5 an adult; needs MPFB2, which the person installs in
   Settings → Game tools) or a library body, the clips (the standard set
   when you leave them out) and the chains no clip keys: `tail` from
   `pelvis`, `ear` from `Head` with `mirror`. Keep chains short (springs do
   not collide). It leaves a collection `<name>` with the armature `<name>`
   and the skinned `<name>_body`. `replace: true` rebuilds only the body and
   the armature and re-binds your parts. Pick the body by the concept's
   proportions, not by the subject's age: the scale pass sets how tall it
   stands, but the body sets its head share and limb length. A small,
   round or chibi character (a cat, a gnome, a mascot) takes a child body
   (`age` 0.1 to 0.25); a lean adult body under a big head reads as a
   person in a costume.
3. **Parts** with `game_blender_code`, in world space at the rest pose.
   `kurambit` is already imported:
   - `kurambit.material("#RRGGBB", glow=0)`: a colour by palette role;
   - `kurambit.skin_rigid(obj, "Head")`, or a `{bone: weight}` dict, or a
     function of a vertex's world position (with `armature=`): binds a part;
   - `kurambit.place_on_surface(obj, target, (0, 1, 0), offset=0.002)`: moves
     a feature onto a surface along the direction you would look; returns
     the point and normal. Eyes, noses, badges and buckles go on by raycast,
     never by guessed coordinates;
   - `kurambit.ring_around(body, "lowerarm_l", 0.86, axis=(1, 0, 0),
material=m)`: a band hugging the measured cross-section (cuffs, belts,
     collars). End every colour zone under a modelled band, never on a
     jagged line of faces;
   - `kurambit.tube_along_bones(["tail_01", ..., "tail_05"], 0.028)`: a
     tapered tube weighted along a chain;
   - `kurambit.place_chain(arm, "ear_l", start=..., direction=..., length=...)`
     or `points=[...]`: moves a chain onto the parts you modelled (ears onto
     the hood, a curled tail). Do it before skinning parts to the chain.

   Model shapes, not boxes: bevels, subdivided spheres, boolean openings.
   One glow accent per character. The craft that separates a made
   character from a cheap one:
   - **Hair**: a thin cap ending low at the nape, then about 20 to 25
     chunky locks lying on the head and lifting toward flicked tips, with
     one signature lock; the under-locks a shade darker. Never one smooth
     shell: it reads as a helmet, and cones on it read as horns.
   - **Eyes** stand out of the face (about 60% of their depth), with an
     iris and a highlight lit from one side. Lids sit high: low lids read
     grumpy. Cheeks sink into the skull rather than sit on it.
   - **Face**: a small nose (it sticks out in profile sooner than you
     think); an open smile sunk into the skin.
   - **Hands**: a flatter palm with a thumb. Round mittens read as stumps.
     Paws get pads.
   - **Clothes**: a garment lying on the body (an apron, a tabard) is
     projected onto the skin and lifted a few millimetres; a cuff or band
     is one object per limb (`ring_around`). A part lying across a joint
     takes weights over its region's bones (a `{bone: weight}` dict or a
     function), never 100% on one bone.
   - **Joins**: a part that meets another enters it. Nothing rests on a
     surface, floats, or pokes through, on the back and from the side too.
   - **Accessories** are big enough to read at game distance; a strap
     that reads as a line is too thin.

4. **Custom clips** with `kurambit.key_pose("Pounce", frame, {"base":
"Idle_Loop", "move": (0, 0, -0.1), "turn": {"pelvis": ((1, 0, 0), 14)},
"aim": {"upperarm_l": (0.3, -0.75, -0.2)}}, arm)`: on top of a library
   pose, by world directions (the character faces -Y, +X is its left),
   never by a bone's local axes. Give it an anticipation key, an overshoot
   and a settle; keep it in place (the game moves the character).
   A clip you key with your own code needs `action.use_fake_user = True`:
   an action nothing uses is not saved, and the review then refuses.
5. **Review:** `game_blender_look` with `mode: "review"`. It runs the
   export's style pass and measurement and shows one image: a turnaround,
   silhouettes, the model at game distance, each walk, run, jump and custom
   clip, the palette, and the concept. A texture you painted or edited in
   the scene is reviewed only once saved (`image.save()`) or packed
   (`image.pack()`); a file you rewrote needs only `image.reload()`. Walk
   it in this order:
   1. Silhouette: the primary shape and the two features read in black.
   2. Game distance: at 1x, can you tell what it is and which way it faces?
   3. Palette roles: main, accent and the one glow are where the concept
      put them; no part is a surprise colour.
   4. Side by side with the concept: proportions, head share, features.
   5. Craft: hair, eyes, hands, joins and accessories as above, and every
      line of the design sheet shows (each layer, the prop, each finish).
   6. Clips: feet stay under the body, the head is not hidden in the jump
      and run, arms clear the body, the custom clip has its anticipation.

   The text lists what the export would refuse: fix those first. Then
   write the critique before changing anything: each defect numbered, with
   its tile, where, blocking or detail, and the fix; or "nothing blocking"
   with what you checked. "Looks good" is not a review.

   You read your own render as its author and see what you meant to make.
   For a character or a hero piece, when you can start a subagent, have a
   fresh one read each review: give it only the person's brief, the
   subject's section of `art/CONCEPT.md` and the review image's path (never
   your code, your notes or what you fixed), and ask for every defect
   (tile, where, blocking or detail) and one line: would it show this to
   the person as is? Fix what it marks blocking, or say why not; it can be
   wrong (a shadow read as a hole).

   Fix every defect of a round when they touch different parts; two
   changes to the same region go one per round. A defect back after two
   fixes is the method's, not the amount's: rebuild that part another
   way. Stop when the fresh reading and yours find nothing blocking, or
   after 8 reviews with what is left named in your reply. A background
   prop needs one reading.

6. **Export:** `game_blender_export` writes exactly the reviewed model, its
   `<name>.asset.json` sidecar (clips with their ground speed, springs,
   height) and an ASSETS.md line. Any change after the review needs a new
   review. In three.js, point `ASSETS` at the sidecar
   (`cat: "assets/blender/space_cat.asset.json"`) and drive it with
   `locomotion()` and `play(state, { moveSpeed })` so the feet stay planted
   (TEMPLATE.md).

## Generated art

On the `generated` route the person has the art made by providers through
`game_generate` (their own keys, or Codex on their ChatGPT plan), and this
pipeline makes it one look. The person picks every candidate; you never
pick taste for them. Never block the playable on art: library stand-ins
play until each piece arrives. Start a generation, keep building, and pick
it up with `game_generate_wait`.

1. **Key art, in the first turn.** Lane `image`, name `key_art`,
   `options.aspect` `"16:9"`, a prompt holding the game's world and moment
   in one image (from BRIEF.md; no text or UI in it), and three
   `directions`: the person is choosing a look, so make three looks, not
   three samples of one. Make them differ in rendering (flat-shaded
   low-poly, chunky toon with outlines, soft clay or vinyl toy, painterly),
   palette (warm, cool, pastel, neon) and shape language (round and soft,
   blocky, angular). Each must be a look this game can reach in its engine
   with generated and library models, drawn as an in-game screenshot at
   the game's camera, never a movie poster or a cinematic render. Label
   each in two or three words. If the brief's art direction already fixes
   the look, keep it and vary only what it leaves open. End the turn asking
   the person to pick one in the chat.
2. **After the pick, lock the look to it.** Copy the picked file to
   `art/key-art.png`, read its colours with
   `print(kurambit.palette_of("art/key-art.png", 8))` in
   `game_blender_code`, and write STYLE.json's `palette` (that hex list:
   every exported model is snapped to it; for a painted or realistic key
   art leave `palette` out, so models keep their textures) and `anchor`
   (`"art/key-art.png"`). Pass the key art in `references` of every later
   generation. It is also the title backdrop (TEMPLATE.md or the engine
   skill).
3. **Characters.** A character sheet first: lane `image`, two or three
   `directions` when the character's design is open (silhouette, outfit,
   proportions; the key art fixes the rendering), else none, the key art
   as reference, the character alone on a plain background
   in a front and side view, arms down and apart. The person picks. Then
   lane `character` (a humanoid) or `creature` (`options.body`, and the
   clips it needs in `options.clips`), with the picked sheet and the key
   art as references. Then:
   - a humanoid: `game_blender_character` with `body: {game: "<the .glb it
delivered>"}` and the clips. It is conformed to the standard skeleton
     whatever its bones are named, so the clip library, `fit`, ground
     speeds, springs and blinks all work on it;
   - a creature: `game_blender_assets_import` with `source: "generated"`
     and its `path`. It keeps its own rig, clips and size; it needs an idle
     clip once it has clips;
   - then stand it on the ground facing -Y, review and export it as in
     Made characters 5 and 6.
4. **Props.** Lane `model` with the key art (or a picked prop image) as
   reference, then `game_blender_assets_import` with `source: "generated"`,
   review and export. Its baked texture is snapped to the palette face by
   face; a lock with no hex palette keeps it, scaled to the budget.
5. **Images and sound.** Sprites, UI art, backgrounds and textures: lane
   `image` or `texture` with the key art as reference. Effects and music:
   lanes `sfx` and `music` from the brief's mood (`options.seconds`,
   `options.loop` for music). Add each file with `game_import`.
6. **Cost.** Say in the turn's reply what its generations cost. A refusal
   (no key, over the person's daily limit) goes in the reply as it is;
   never switch route or lane to get past it.

## 2D sprites from 3D

Render every sprite, animation strip and icon with `game_blender_render_sprites`,
never with your own camera, light or render code. It fits a fixed orthographic
camera to the objects across every frame, so nothing is cut off, the scale is
the same in every frame and view, the feet stand on the same row in every
frame, and studio lights keep small sprites readable. It writes
`<output>_0.png ... <output>_N.png` and `<output>.sprite.json` (frame size,
fps, anchor per view), records them in ASSETS.md and returns a contact sheet:
look at it. Its `output` is a path prefix under `<assets>`: `godot/assets/sprites/hero_walk`,
`web/assets/sprites/hero_walk` or `unity/Assets/Art/Sprites/hero_walk`. In Godot,
`SpriteStrips.apply` loads strips from the `.sprite.json`; elsewhere use the
anchor offset it gives.

- Pixel-art game: STYLE.json's palette, outline and tile size apply (the
  canvas defaults to two tiles); the engine scales sprites and tiles up
  together with nearest filtering and must not recolour them: a Godot 2D
  scene has no WorldEnvironment, and a three.js game draws sprites through an
  orthographic camera, which skips tone mapping unless `LOOK` names one.
  Smooth game: render at the size the game draws.
- One character, one scale: leave out `pixelsPerUnit` for its first strip,
  then pass the value that strip reports to every other strip of the same
  character (idle, walk, attack), or an attack renders smaller than the idle.
  If a bigger clip no longer fits, the tool says which `size` it needs.
- Render in-place clips. A clip that moves the character across the ground
  (root motion) is refused; the game moves the sprite.
- Views: side-scroller `right` (flip it for left); top-down `front`, `back`,
  `left`, `right` with `elevation` 35, or `top`; `isometric`. STYLE.json's
  view sets them when you leave `views` out.
- Props and pickups render the same way, from a library model or one you
  build in Blender. The model faces -Y, like imported glTF models; `right`
  shows it facing screen right.

## Props, set pieces and 3D models

Library pieces from the lock's packs come first. What no pack has, build in
the live Blender: `game_blender_code` to model, `game_blender_scene` to
measure, `game_blender_look` with `mode: "review"` to see exactly what will
ship, `game_blender_export` for the GLB and its sidecar, then `game_import`
and `game_check`. Match the family's look: its proportions, its bevel
(bevelled edges, never flat boxes), and colours by palette role
(`kurambit.material("#RRGGBB")`; the style pass snaps them to the palette).
Design set pieces for the camera: a third-person or top-down camera needs
low partitions (about 1.8 m in a 4 m cell), not full-height walls. Realistic models and textures
(`game_blender_assets_search` and `_import`: Poly Haven is CC0, no key;
Sketchfab and Poly Pizza need the user's keys) belong only in a realistic
lock.

## Key art

On the `generated` route the key art is generated (Generated art, above).
Otherwise, a perspective camera at 1280x720 over the game's real assets, rendered in a
throwaway scene that is removed in `finally`, so a failed run leaves nothing in
the live .blend:

```python
import bpy, os, math
sc = bpy.data.scenes.new("keyart_tmp"); made = []
try:
    sc.render.engine = "BLENDER_EEVEE_NEXT"; sc.render.resolution_x, sc.render.resolution_y = 1280, 720
    sc.view_settings.view_transform = "Standard"  # material colors render as set
    for o in bpy.context.scene.objects:
        if o.type in {"MESH", "LIGHT"} and o.visible_get(): sc.collection.objects.link(o)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); cam.location = (0, -9, 5)
    cam.rotation_euler = (math.radians(62), 0, 0)
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN")); sun.rotation_euler = (0.8, 0.2, 0.5)
    for o in (cam, sun): sc.collection.objects.link(o); made.append(o)
    sc.camera = cam; sc.render.filepath = os.path.abspath("art/key-art.png")
    bpy.ops.render.render(write_still=True, scene=sc.name); print("WROTE", sc.render.filepath)
finally:
    for o in made: bpy.data.objects.remove(o)
    bpy.data.scenes.remove(sc)
```

Open every PNG you render.

## Backgrounds

Never a flat fill. Render a ground plane (`bmesh.ops.create_grid`) at the
game's resolution from the game's own view, with this material, a low sun
(`rotation_euler = (1.1, 0.3, 0)`, `energy = 3`) and a dark `sc.world`, then
place the game's props on it:

```python
mat = bpy.data.materials.new("ground")
if mat.node_tree is None: mat.use_nodes = True  # Blender 4.x only; 5.0+ always has nodes
N, L = mat.node_tree.nodes, mat.node_tree.links
noise, ramp, bump, bsdf = N.new("ShaderNodeTexNoise"), N.new("ShaderNodeValToRGB"), N.new("ShaderNodeBump"), N["Principled BSDF"]
noise.inputs["Scale"].default_value, noise.inputs["Detail"].default_value = 5, 12
e0, e1 = ramp.color_ramp.elements; e0.position, e1.position = 0.4, 0.65
e0.color, e1.color = (0.01, 0.03, 0.02, 1), (0.08, 0.2, 0.06, 1)  # two palette colors, linear
L.new(noise.outputs["Fac"], ramp.inputs["Fac"]); L.new(noise.outputs["Fac"], bump.inputs["Height"])
L.new(ramp.outputs["Color"], bsdf.inputs["Base Color"]); L.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
```
