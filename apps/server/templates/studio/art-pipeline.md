# Art pipeline

Adapted from OhMyGame's sprite-pipeline and game-ui-frontend skills
(Apache-2.0), plus the standing finding that code-drawn placeholders
must go.

1. Key art first: one image the finished game must live up to. Everything
   else is held to it.
2. Every in-game visual is a file: characters, objects, tiles, backgrounds,
   UI pieces, effects, animation frames. No code-drawn shapes, no flat
   color rectangles, no default UI skin on the played path.
   A 3D game needs real 3D models scripted in headless Blender at the path
   in PROJECT.md, exported as GLB (rigged characters where they move),
   then imported and checked in the engine. Code-built primitives are
   placeholders, same as 2D.
3. Identity and anchors: one palette, one silhouette language, one ground
   line. A new asset that breaks them is reworked, not accepted.
4. Sheets and states: movement, hurt, win and lose all read at a glance.
   Animation frames where things move.
5. Lay the set out on one contact-sheet image, look at it, and redo the
   weak ones until the set hangs together.
6. Dynamic text stays code; its skin (panels, buttons, fonts) is images.
