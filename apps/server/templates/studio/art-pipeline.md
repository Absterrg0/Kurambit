# Art pipeline

Adapted from OhMyGame's sprite-pipeline and game-ui-frontend skills
(Apache-2.0), plus the standing finding that code-drawn placeholders
must go.

You have no local Blender, Godot or image tools. The live Blender behind the
`game_blender_*` tools is your modeller and your renderer for 3D models, 2D
sprites and key art. `<engine>` below is the game's engine folder: `godot/`
or `web/`.

1. Key art first: one image the finished game must live up to. Everything
   else is held to it.
2. Every in-game visual is a file: characters, objects, tiles, backgrounds,
   UI pieces, effects, animation frames. No code-drawn shapes, no flat
   color rectangles, no default UI skin on the played path.
3. 3D models are built in the live scene with `game_blender_code`, seen with
   `game_blender_look`, measured with `game_blender_scene`, and exported as
   GLB with `game_blender_export` (rigged characters where they move). Then
   `game_import` and `game_check`. Code-built primitives are placeholders.
4. Identity and anchors: one palette, one silhouette language, one ground
   line. A new asset that breaks them is reworked, not accepted.
5. Sheets and states: movement, hurt, win and lose all read at a glance.
   Animation frames where things move.
6. Render the set side by side into one contact-sheet PNG, look at it, and
   redo the weak ones until the set hangs together.
7. Dynamic text stays code; its skin (panels, buttons, fonts) is images.
8. Library assets: `game_blender_assets_search`, then
   `game_blender_assets_import` (Poly Haven is CC0 and needs no key;
   Sketchfab and Poly Pizza need the user's keys). Never scrape websites.
   Record every file's source and licence in ASSETS.md next to its use;
   unknown-source files do not ship.

## 2D sprites and key art

`game_blender_code` runs Python inside Blender with bpy, bmesh and numpy.
Its working directory is the game root. Render in a throwaway scene so the
saved .blend stays clean, and print every path you write:

```python
import bpy, bmesh, os
out = os.path.abspath("web/assets/sprites/crate.png")  # <engine>/assets/...
os.makedirs(os.path.dirname(out), exist_ok=True)
sc = bpy.data.scenes.new("render_tmp")
sc.render.engine = "BLENDER_EEVEE_NEXT"  # BLENDER_WORKBENCH: flat and fast
sc.render.resolution_x = sc.render.resolution_y = 128
sc.render.film_transparent = True
sc.render.image_settings.file_format = "PNG"
sc.render.image_settings.color_mode = "RGBA"
sc.render.filepath = out
me = bpy.data.meshes.new("crate"); bm = bmesh.new()
bmesh.ops.create_cube(bm, size=1.0); bm.to_mesh(me); bm.free()
mat = bpy.data.materials.new("crate"); mat.diffuse_color = (0.8, 0.45, 0.2, 1)
me.materials.append(mat)
ob = bpy.data.objects.new("crate", me); ob.rotation_euler = (0.6, 0, 0.8)
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
cam.data.type = "ORTHO"; cam.data.ortho_scale = 2.2
cam.location = (0, -5, 0); cam.rotation_euler = (1.5708, 0, 0)
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
sun.rotation_euler = (0.8, 0.2, 0.5)
for o in (ob, cam, sun): sc.collection.objects.link(o)
sc.camera = cam
bpy.ops.render.render(write_still=True, scene=sc.name)
for o in (ob, cam, sun): bpy.data.objects.remove(o)
bpy.data.scenes.remove(sc)
print("WROTE", out)
```

- Models already in the live scene: link them into `sc.collection` too and
  do not remove them afterwards.
- Animation frames: render one PNG per pose or `sc.frame_set(n)`. A sheet is
  one wide render with the copies offset along x.
- Key art: the same setup with a perspective camera at 1280x720, composed
  from the game's real assets.
- Open every PNG you render and look at it before moving on.
