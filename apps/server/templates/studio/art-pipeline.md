# Art pipeline

Adapted from OhMyGame's sprite-pipeline and game-ui-frontend skills (Apache-2.0).
The live Blender behind the `game_blender_*` tools is your modeller and
renderer; you have no local Blender, Godot or image tools. `<engine>` is
`godot/` or `web/`.

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
5. Library assets: `game_blender_assets_search` and `_import` (Poly Haven is
   CC0, no key; Sketchfab and Poly Pizza need the user's keys). Never scrape
   websites. Record every file's source and licence in ASSETS.md;
   unknown-source files do not ship.

## Sprites and animation frames

`game_blender_code` runs Python in Blender (bpy, bmesh, numpy) from the game
root. Render in a throwaway scene and remove it in `finally`, so even a failed
run leaves nothing for the next call to save into the live .blend; print every
path you write. Set the pose itself before each render. This walk cycle writes
six frames; a still is the same with `n = 1`.

```python
import bpy, bmesh, os, math, numpy as np
name, n, size = "web/assets/sprites/hero_walk", 6, 128  # <engine>/assets/...
os.makedirs(os.path.dirname(os.path.abspath(name)), exist_ok=True)
sc = bpy.data.scenes.new("render_tmp"); made = []
try:
    sc.render.engine = "BLENDER_EEVEE_NEXT"  # WORKBENCH: flat, fast
    sc.render.resolution_x = sc.render.resolution_y = size; sc.render.film_transparent = True
    sc.view_settings.view_transform = "Standard"  # colors below are linear
    def part(label, dims, loc, rgb, parent=None):  # pivot at the top face: limbs swing at the joint
        me = bpy.data.meshes.new(label); bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.scale(bm, vec=dims, verts=bm.verts)
        bmesh.ops.translate(bm, vec=(0, 0, -dims[2] / 2), verts=bm.verts); bm.to_mesh(me); bm.free()
        mat = bpy.data.materials.new(label); mat.diffuse_color = (*rgb, 1); me.materials.append(mat)
        ob = bpy.data.objects.new(label, me); ob.location = loc; ob.parent = parent
        sc.collection.objects.link(ob); made.append(ob); return ob
    body = part("body", (0.5, 0.3, 0.7), (0, 0, 1.6), (0.03, 0.1, 0.45))
    part("head", (0.4, 0.4, 0.4), (0, 0, 0.45), (0.75, 0.42, 0.25), body)
    limbs = [(part(f"leg{s}", (0.18, 0.18, 0.8), (0, s * 0.12, -0.7), (0.08, 0.05, 0.03), body),
              part(f"arm{s}", (0.14, 0.14, 0.6), (0, s * 0.32, 0), (0.75, 0.42, 0.25), body), s) for s in (-1, 1)]
    def pose(t):  # a sine swing repeats a pose either side of its peak; the foot lift tells them apart
        for leg, arm, s in limbs:
            leg.rotation_euler.y, arm.rotation_euler.y = 0.6 * s * math.sin(t), -0.7 * s * math.sin(t)
            leg.location.z = -0.7 + 0.3 * max(0.0, s * math.cos(t))
        body.location.z = 1.6 + 0.06 * abs(math.cos(t))
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); cam.data.type, cam.data.ortho_scale = "ORTHO", 2.4
    cam.location, cam.rotation_euler = (0, -6, 0.95), (1.5708, 0, 0)  # side-on; top-down: (0, 0, 6), (0, 0, 0)
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN")); sun.rotation_euler = (0.8, 0.2, 0.5)
    for o in (cam, sun): sc.collection.objects.link(o); made.append(o)
    sc.camera = cam; frames = []
    for f in range(n):
        pose(2 * math.pi * f / n); sc.render.filepath = os.path.abspath(f"{name}_{f}.png")
        bpy.ops.render.render(write_still=True, scene=sc.name); print("WROTE", sc.render.filepath)
        img = bpy.data.images.load(sc.render.filepath); px = np.empty(size * size * 4, np.float32)
        img.pixels.foreach_get(px); frames.append(px.reshape(size, size, 4)); bpy.data.images.remove(img)
    for f in range(n):  # SAME: two frames show one pose; change the pose, not the render
        d = float(np.abs(frames[f] - frames[(f + 1) % n]).mean()); print("DIFF", f, round(d, 4), "SAME" if d < 0.01 else "")
finally:
    for o in made: bpy.data.objects.remove(o)
    bpy.data.scenes.remove(sc)
```

Live-scene models: link them into `sc.collection`, never remove them. An
imported rigged GLB plays its own clip only if you call
`bpy.context.scene.frame_set(f)` before each render (`sc.frame_set` evaluates no
keyframes in background mode); or pose its bones directly. Key art: a
perspective camera at 1280x720 over the game's real assets. Open every PNG you render.

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
