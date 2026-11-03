# Art pipeline

Adapted from OhMyGame's sprite-pipeline and game-ui-frontend skills (Apache-2.0).
The live Blender behind the `game_blender_*` tools is your modeller and
renderer; you have no local Blender, Godot or image tools. `<assets>` is
your lane's asset folder: `godot/assets/`, `web/assets/`, or
`unity/Assets/` for Unity (capital A: Unity imports nothing else, and
`unity/assets/` is a different folder it never reads; Unity art goes under
`unity/Assets/Art/`).

1. Key art first: one image the finished game must live up to.
2. Every in-game visual is a file: characters, objects, tiles, backgrounds, UI
   pieces, effects, animation frames. No code-drawn shapes, flat color
   rectangles or default UI skin on the played path. Dynamic text stays code.
3. 3D: build with `game_blender_code`, see with `game_blender_look`, measure
   with `game_blender_scene`, export GLB with `game_blender_export` (rigged
   where they move), then `game_import` and `game_check`.
4. One palette, one silhouette language, one ground line. Movement, hurt, win
   and lose read at a glance. Put the set in one contact-sheet PNG, look at
   it, and redo the weak ones.
5. Library first for characters, tiles, UI, icons and fonts:
   `game_assets_search` finds CC0 packs (no key); pass `pack` to look inside
   one and look at its contact sheet before you pick. `game_assets_add` copies
   files or whole folders into `<assets>library/<pack>/` (`unity/Assets/Library/<pack>/`) and credits
   them in ASSETS.md. One style per game: take a game's sprites, tiles and UI
   from packs that look alike (same pixel size or same vector look), never a
   mix. Make your own art (below) when nothing fits or the look must be
   unique. Realistic models and textures: `game_blender_assets_search` and
   `_import` (Poly Haven is CC0, no key; Sketchfab and Poly Pizza need the
   user's keys). Never scrape websites. Record every file's source and
   licence in ASSETS.md; unknown-source files do not ship.

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

- Pixel-art game: pass the style pack VISION.md names as the palette, and the
  size the sprite has in that pack's own pixels (a 16 px tile pack wants a
  16-32 px character); the engine scales sprites and tiles up together with
  nearest filtering. Smooth game: leave out `pixelArt` and render at the size
  the game draws.

  ```json
  {
    "output": "<assets>sprites/hero_walk",
    "objects": ["hero"],
    "action": "hero_walk",
    "size": 32,
    "pixelArt": { "palette": "<pack id>", "outline": true }
  }
  ```

- One character, one scale: leave out `pixelsPerUnit` for its first strip,
  then pass the value that strip reports to every other strip of the same
  character (idle, walk, attack), or an attack renders smaller than the idle.
  If a bigger clip no longer fits, the tool says which `size` it needs.
- Render in-place clips. A clip that moves the character across the ground
  (root motion) is refused; the game moves the sprite.
- Views: side-scroller `right` (flip it for left); top-down `front`, `back`,
  `left`, `right` with `elevation` 35, or `top`; `isometric`.
- The model lives in the live scene: a library character (its clips are
  actions: list `bpy.data.actions`), an imported model, or one you build. A
  built model moves through one action keyed on every part, like this walk:

```python
import bpy, bmesh, math
col = bpy.data.collections.new("hero"); bpy.context.scene.collection.children.link(col)
act = bpy.data.actions.new("hero_walk"); parts = []
def part(label, dims, loc, rgb, parent=None):  # pivot at the top face: limbs swing at the joint
    me = bpy.data.meshes.new(label); bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=dims, verts=bm.verts)
    bmesh.ops.translate(bm, vec=(0, 0, -dims[2] / 2), verts=bm.verts); bm.to_mesh(me); bm.free()
    mat = bpy.data.materials.new(label); mat.diffuse_color = (*rgb, 1); me.materials.append(mat)
    ob = bpy.data.objects.new(label, me); ob.location = loc; ob.parent = parent
    col.objects.link(ob); ob.animation_data_create().action = act; parts.append(ob); return ob
body = part("body", (0.5, 0.3, 0.7), (0, 0, 1.6), (0.03, 0.1, 0.45))
part("head", (0.4, 0.4, 0.4), (0, 0, 0.45), (0.75, 0.42, 0.25), body)
limbs = [(part(f"leg{s}", (0.18, 0.18, 0.8), (s * 0.12, 0, -0.7), (0.08, 0.05, 0.03), body),
          part(f"arm{s}", (0.14, 0.14, 0.6), (s * 0.32, 0, 0), (0.75, 0.42, 0.25), body), s) for s in (-1, 1)]
def pose(t):  # a sine swing repeats a pose either side of its peak; the foot lift tells them apart
    for leg, arm, s in limbs:
        leg.rotation_euler.x, arm.rotation_euler.x = 0.6 * s * math.sin(t), -0.7 * s * math.sin(t)
        leg.location.z = -0.7 + 0.3 * max(0.0, s * math.cos(t))
    body.location.z = 1.6 + 0.06 * abs(math.cos(t))
for f in range(0, 25, 3):  # frame 24 repeats frame 0, so the cycle loops
    pose(2 * math.pi * f / 24)
    for ob in parts: ob.keyframe_insert("location", frame=f); ob.keyframe_insert("rotation_euler", frame=f)
```

The model faces -Y, like imported glTF models; `right` shows it facing screen
right. Then `game_blender_render_sprites` with `"objects": ["hero"],
"action": "hero_walk"` renders 8 frames of the cycle.

## Key art

A perspective camera at 1280x720 over the game's real assets, rendered in a
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
mat = bpy.data.materials.new("ground"); mat.use_nodes = True; N, L = mat.node_tree.nodes, mat.node_tree.links
noise, ramp, bump, bsdf = N.new("ShaderNodeTexNoise"), N.new("ShaderNodeValToRGB"), N.new("ShaderNodeBump"), N["Principled BSDF"]
noise.inputs["Scale"].default_value, noise.inputs["Detail"].default_value = 5, 12
e0, e1 = ramp.color_ramp.elements; e0.position, e1.position = 0.4, 0.65
e0.color, e1.color = (0.01, 0.03, 0.02, 1), (0.08, 0.2, 0.06, 1)  # two palette colors, linear
L.new(noise.outputs["Fac"], ramp.inputs["Fac"]); L.new(noise.outputs["Fac"], bump.inputs["Height"])
L.new(ramp.outputs["Color"], bsdf.inputs["Base Color"]); L.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
```
