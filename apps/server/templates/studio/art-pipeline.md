# Art pipeline

Adapted from OhMyGame's sprite-pipeline and game-ui-frontend skills (Apache-2.0).
The live Blender behind the `game_blender_*` tools is your renderer and your
modeller for props; you have no local Blender, Godot or image tools.
`<assets>` is your lane's asset folder: `web/assets/`, `godot/assets/`, or
`unity/Assets/Art/` for Unity (capital A: Unity imports nothing else).

The first turn takes only the STYLE.json lock from this skill (and, on the
`generated` route, the key art). Key art, sprite renders and Blender props
come in later turns, for what no pack has.

1. Key art first: one image the finished game must live up to.
2. Every in-game visual is a file: characters, objects, tiles, backgrounds, UI
   pieces, effects, animation frames. No code-drawn shapes, flat color
   rectangles or default UI skin on the played path. Dynamic text stays code.
3. One palette, one silhouette language, one ground line. Movement, hurt, win
   and lose read at a glance. Put the set in one contact-sheet PNG, look at
   it, and redo the weak ones.
4. Every file's source and licence is in ASSETS.md (the art tools write
   their own lines); unknown-source files do not ship. Never scrape websites.

## Lock the look: STYLE.json

`game_assets_search` with no words lists the library by style family: one
look each (KayKit, Kenney low-poly, Kenney pixel, ...), its packs, each
character pack's rig, and a pixel palette where the family has one. Look at
a pack's contact sheet (pass `pack`) before choosing. Pick one family whose
look fits the brief (and the key art, once there is one) and write
`STYLE.json` at the game root:

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

- `mode`: `smooth`, or `pixel` with `tile` (source pixels per tile),
  `palette` (a pack id, added with `game_assets_add` before the first render,
  or a PNG or folder in the game) and `outline` (true or `#rrggbb`).
- `view`: `side`, `top-down`, `isometric` or `perspective` (3D).
- `rig`: the skeleton every character shares, so every clip fits every
  character. Leave it out when nothing is rigged (a 2D game drawn from
  sprite packs).
- `packs`: where the game's visuals come from, UI, icons and fonts included.
- `audio.packs`: one effects family and one music source. Sound is not
  locked until the list exists; name it with the look.
- `imports`: outside sources the live Blender may import from (`polyhaven`,
  `sketchfab`, `polypizza`); none when left out.
- `anchor`: the image the look answers to (`art/key-art.png`): its palette is
  the lock's, and every generation passes it as a reference.
- 3D made models: `palette` may be a hex list (2 to 64 colours, from the
  family's own textures so made models sit with the packs), with `shading`,
  `scale.character` (metres; KayKit heroes are about 2.1) and `budget`
  (triangles and texture size). A made character's `rig` is
  `standard-humanoid`.

The art tools refuse what breaks the lock and say what to change. Changing
direction is an edit to STYLE.json made on purpose, never a drift: change the
lock first, then the art. STYLE.json is the person's to read and edit too.

## Characters

How this game's characters are made is the person's choice, shown by
game_status as `characters`: `library` (the default), `blender` or
`generated`. Read it before any character; you cannot change it. When the
route cannot do what is asked (the library has no cat), say so in your reply
and name the other routes: the person changes it under the game's More menu,
"Make characters with". A message asking for one made character does not
change the route. An unrigged model is a prop on every route.

- `library`: characters from the lock's packs, played by state with the
  engine's character animator. On `standard-humanoid`,
  `game_blender_character` with a library body
  (`quaternius-universal-base-characters`) puts it on the skeleton with the
  library's clips. No character fits: recolour one (a family's characters
  share one small colormap texture; edit a copy of that PNG and point the
  copy's material at it).
- `blender`: made characters, below.
- `generated`: from generators (Generated art, below): a humanoid is
  conformed to `standard-humanoid` and plays the clip library, a creature
  keeps its own rig and clips.
- 2D sprite packs (a lock with no rig): the characters the packs draw, with
  their own frames, or a 3D family's character rendered into strips (2D
  sprites from 3D).

### Made characters

The tools own the skeleton, its rest frames, scale, palette, budgets and
measurement. You own the shape, the pose and the judgment, and you judge
from the review image, never from your code. A character that did not go
through the review and the export is not finished.

1. **Design sheet first.** Add the subject's section to `art/CONCEPT.md`
   before the first shape; a character built without one comes out plain (a
   child in a T-shirt and shorts). It names the role and one signature shape
   that makes the silhouette (a hood's point, a flame lock, a backpack); one
   primary shape (round, square or triangle) and the head's share of the
   height (about 40% for a chibi); the two features that must read at game
   distance; the palette roles (main, secondary, accent, one glow); the
   costume in layers (a base garment, an over-garment, a belt or strap) and a
   prop that says the role; and three finishes at least (cuffs, a buckle,
   stitching, an emblem): they read as made rather than generated.
   `art/concepts/<name>.png`, when it exists, is shown beside every review.
2. **Body.** `game_blender_character`. Pick the body by the concept's
   proportions, not the subject's age: the scale pass sets the height, the
   body sets head share and limb length. A small, round or chibi character
   (a cat, a gnome, a mascot) takes a child body (`age` 0.1 to 0.25); a lean
   adult body under a big head reads as a person in a costume. Keep spring
   chains short (springs do not collide). The standard clips have no attack:
   name one in `clips` (`Punch_Jab`, `Sword_Attack`, `Spell_Simple_Shoot`)
   when the character fights. Choose `fit` from the review's strips: `arms:
true` swings arms out of the torso, `calm` (0..1) calms a waddle or a
   rolling head on a wide or big-headed body.
3. **Parts** with `game_blender_code`, in world space at the rest pose.
   `kurambit` is already imported:
   - `kurambit.material("#RRGGBB", glow=0)`: a colour by palette role;
   - `kurambit.skin_rigid(obj, "Head")`, or a `{bone: weight}` dict, or a
     function of a vertex's world position (with `armature=`): binds a part;
   - `kurambit.place_on_surface(obj, target, (0, 1, 0), offset=0.002)`:
     moves a feature onto a surface along the direction you would look.
     Eyes, noses, badges and buckles go on by raycast, never by guessed
     coordinates;
   - `kurambit.ring_around(body, "lowerarm_l", 0.86, axis=(1, 0, 0),
material=m)`: a band hugging the measured cross-section (cuffs, belts,
     collars). End every colour zone under a band, never on a jagged line;
   - `kurambit.tube_along_bones(["tail_01", ..., "tail_05"], 0.028)`: a
     tapered tube weighted along a chain;
   - `kurambit.place_chain(arm, "ear_l", start=..., direction=...,
length=...)` or `points=[...]`: moves a chain onto the parts you
     modelled, before skinning parts to it;
   - `kurambit.eye_lid` (a round eye's lid) and `kurambit.eye_squash`
     (painted eyes): eyes that blink in the game on their own.

   Model shapes, not boxes: bevels, subdivided spheres, boolean openings.
   One glow accent per character. The craft that separates a made character
   from a cheap one:
   - **Hair**: a thin cap ending low at the nape, then about 20 to 25 chunky
     locks lifting toward flicked tips, one signature lock, the under-locks a
     shade darker. Never one smooth shell: it reads as a helmet, and cones on
     it read as horns.
   - **Eyes** stand out of the face (about 60% of their depth), with an iris
     and a highlight lit from one side. Lids sit high: low lids read grumpy.
   - **Face**: a small nose (it sticks out in profile sooner than you think);
     an open smile sunk into the skin.
   - **Hands**: a flatter palm with a thumb; round mittens read as stumps.
     Paws get pads.
   - **Clothes** are projected onto the skin and lifted a few millimetres; a
     part across a joint takes weights over its region's bones, never one.
   - **Joins**: a part that meets another enters it. Nothing floats or pokes
     through, on the back and from the side too.
   - **Accessories** read at game distance; a strap that reads as a line is
     too thin.

4. **Moves the clip library lacks.** Use a library clip whenever one fits:
   mocap commits harder than any authored move. For a combo, a dodge into
   guard or a stagger, author it with `game_animate` (its description gives
   the spec), read its pictures and numbers against the library clip's,
   change one thing, and call again until neither improves. A warning (hip
   drop, reach, clearance) means the spec asked for what this body cannot
   do: move the feet in, the grip closer or the hips down.

   For a small change to a library pose, `kurambit.key_pose("Pounce", frame,
{"base": "Idle_Loop", "turn": {"pelvis": ((1, 0, 0), 14)}}, arm)` keys one
   pose by world directions (the character faces -Y, +X is its left), and
   `kurambit.mirror_pose(pose)` the other side; a clip you key with your own
   code needs `action.use_fake_user = True`, or it is not saved.

5. **Review:** `game_blender_look` with `mode: "review"`. Fix what the text
   says the export would refuse first. Then walk the image in this order:
   1. Silhouette: the primary shape and the two features read in black.
   2. Game distance: at 1x, can you tell what it is and which way it faces?
   3. Palette roles: main, accent and the one glow where the concept put them.
   4. Side by side with the concept: proportions, head share, features.
   5. Craft: hair, eyes, hands, joins and accessories as above, and every
      line of the design sheet shows.
   6. Clips: feet under the body, the head not hidden in the jump and run,
      arms clear of the body, the custom clip's anticipation.

   Write the critique before changing anything: each defect numbered, with
   its tile, where, blocking or detail, and the fix; or "nothing blocking"
   with what you checked. "Looks good" is not a review.

   You see what you meant to make in your own render. For a character or a
   hero piece, when you can start a subagent, have a fresh one read each
   review from only the brief, the subject's `art/CONCEPT.md` section and the
   image's path, and list every defect; fix what it marks blocking, or say
   why not (it can be wrong).

   Two changes to the same region go one per round. A defect back after two
   fixes is the method's, not the amount's: rebuild that part another way.
   Stop when nothing blocking is left, or after 8 reviews with what is left
   named in your reply. A background prop needs one reading.

6. **Export:** `game_blender_export` writes exactly the reviewed model and
   its sidecar; any change after the review needs a new review. Name it in
   the game by its sidecar (TEMPLATE.md).

### Painted from a sheet

On the Blender route a model looks like its picture when the picture is its
texture. Model the silhouette and the big forms as smooth shells and paint
the detail from the subject's turnaround sheet with `game_blender_paint`:
plates, cords, weave, eyes, brows and the nose as geometry fight the paint.

1. **The sheet.** Lane `image` (the person picks it), the key art as
   reference, and a prompt for the layout the paint reads: "a turnaround
   sheet: front, side (facing left, true profile) and back views side by
   side at exactly the same scale and height, feet on one baseline; strict
   symmetric A-pose, arms straight about 45 degrees down and away from the
   body, legs slightly apart; orthographic, flat even lighting, plain light
   grey background, no shadows, no text, nothing overlapping, space between
   the views". The person's own sheet works the same.
2. **Paint.** Below about 75% overlap the model's proportions or pose
   differ from the sheet's (arm angle, head size, shoulder width): fix the
   model, not the paint. Give each material its fitting colour first: texels
   no view sees take it. Then review the ¾ view and the game camera's: front,
   side and back match by construction.
3. **A new character on the same body:** edit the hero's sheet (lane
   `image`, `options.edit`, "same layout, same body, same pose and scale; new
   outfit: ..."): it comes back aligned, so the body, clips and paint carry
   over. A new enemy for one image.
4. **Carve organic props** (a statue, a carved lion, a rock, a trunk): a
   three-view sheet of the prop, then `game_blender_carve` with its
   `height`. Model buildings, vehicles and anything with straight edges,
   holes or thin parts instead.

A STYLE.json hex palette snaps painted faces to its colours: a painted look
needs a lock with no hex palette.

## Generated art

On the `generated` route the person has the art made by providers through
`game_generate`, and this pipeline makes it one look. The person picks every
candidate; you never pick taste for them. Never block the playable on art:
library stand-ins play until each piece arrives. Start a generation, keep
building, and pick it up with `game_generate_wait`.

1. **Key art, in the first turn.** Lane `image`, name `key_art`,
   `options.aspect` `"16:9"`, a prompt holding the game's world and moment in
   one image (from BRIEF.md; no text or UI in it), and three `directions`:
   the person is choosing a look, so make three looks, not three samples of
   one, differing in rendering (flat-shaded low-poly, chunky toon with
   outlines, soft clay, painterly), palette (warm, cool, pastel, neon) and
   shape language (round, blocky, angular). Each is a look this game can
   reach in its engine, drawn as an in-game screenshot at the game's camera,
   never a poster or a cinematic render, labelled in two or three words. If
   the brief's art direction fixes the look, vary only what it leaves open.

   Ground each direction with `style`: words alone drift to the image
   model's own glossy polish, and key art that promises a look the game
   cannot reach is broken on the first screenshot. For stylised 3D pass a
   library pack id per direction, from different families: Kenney low-poly
   kits and characters and Quaternius Monsters ship an overview picture;
   KayKit packs ship none, so ground a KayKit look in a game image of it.
   For 2D, a Kenney pixel or vector pack; the person's references instead
   when they gave some.

2. **After the pick, lock the look to it.** Copy the picked file to
   `art/key-art.png`, read its colours with
   `print(kurambit.palette_of("art/key-art.png", 8))` in `game_blender_code`,
   and write STYLE.json's `palette` (that hex list; for a painted or
   realistic key art leave `palette` out, so models keep their textures) and
   `anchor`. Pass the key art in `references` of every later image and
   texture. It is also the title backdrop (TEMPLATE.md).
3. **Characters.** First read `artLanes` in `game_status`: when `character`
   (or `creature`) is null, nothing can model it, so make no sheet for it
   and tell the person what Settings → Art providers needs. Then a character
   sheet: lane `image`, two or three `directions` when the design is open
   (silhouette, outfit, proportions), the key art as reference, the
   character alone on a plain background, full body, one front view, arms
   down and apart. The person picks. Then lane `character` or `creature`
   with the picked sheet as its only reference; after the person's "Rig
   this":
   - a humanoid: `game_blender_character` with `body: {game: "<the .glb it
delivered>"}` and the clips;
   - a creature: `game_blender_assets_import` with `source: "generated"`.
     One that came with clips but no idle gets `Idle_Loop` holding its rest
     pose, which you may key into a breath;
   - then stand it on the ground facing -Y, review and export it (Made
     characters 5 and 6).
   - **Moves the library lacks** (a boss's slam, a pounce): lane `motion`
     with `options.character` the game's exported character, so the feet and
     reach fit it; then `game_blender_character` with `replace: true` and the
     motion's GLB among the clips, on every humanoid that should play it.
4. **Props.** A concept first when the look matters (lane `image`, the key
   art as reference, the prop alone on a plain background), then lane
   `model` with the picked concept as its only reference, then
   `game_blender_assets_import` with `source: "generated"`, review and
   export. Moving parts (`options.parts`) get their origin at the hinge.
5. **Images and sound.** Sprites, UI art, backgrounds and textures: lane
   `image` or `texture` with the key art as reference; effects and music
   from the brief's mood. A picked image the person wants changed goes
   through `game_image_edit`, which keeps what they liked.
6. **In the game.** Add generated images and sounds unchanged where you
   can: their cards know them in the game by their bytes. Never switch route
   or lane to get past a refusal.

## 2D sprites from 3D

Render every sprite, strip and icon with `game_blender_render_sprites`, never
your own render code, and look at its contact sheet. To render a library character, import its GLB into the live
Blender, list its clips (`[a.name for a in bpy.data.actions]`), hide what it
should not carry (`ob.hide_render = True`), then render with `"objects":
["<rig name>"], "action": "Walking_A"`, once per clip.

- Pixel art: leave out `pixelArt`, `size` and `views` (the lock fills them);
  the game scales sprites and tiles up together with nearest filtering and
  never recolours them. A smooth game renders at the size the game draws.
- One character, one scale: pass the `pixelsPerUnit` its first strip
  reports to every other strip of it, or an attack renders smaller than the
  idle.
- Views: side-scroller `right` (flip it for left); top-down `front`, `back`,
  `left`, `right` with `elevation` 35, or `top`; `isometric`. The model faces
  -Y, like imported glTF models.

## Props, set pieces and 3D models

Library pieces from the lock's packs come first; an organic hard prop with a
three-view sheet is carved. What no pack has, build in the live Blender:
`game_blender_code` to model, `game_blender_scene` to measure,
`game_blender_look` with `mode: "review"` to see exactly what will ship,
`game_blender_export`, then `game_check`. Match the family's look: its
proportions, its bevel (never flat boxes) and colours by palette role
(`kurambit.material("#RRGGBB")`). Design set pieces for the camera: a
third-person or top-down camera needs low partitions (about 1.8 m in a 4 m
cell), not full-height walls. Realistic models and textures
(`game_blender_assets_search`: Poly Haven is CC0, no key; Sketchfab and Poly
Pizza need the person's keys) belong only in a realistic lock.

## Key art

On the `generated` route the key art is generated (above). Otherwise, a
perspective camera at 1280x720 over the game's real assets, rendered in a
throwaway scene removed in `finally`, so a failed run leaves nothing in the
live .blend:

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
