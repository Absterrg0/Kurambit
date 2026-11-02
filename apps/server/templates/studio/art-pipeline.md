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
7. No-key shelf before paid generators: Poly Haven textures/models (public API,
   no key, CC0, commercial OK; live-API calls must send an app-identifying
   User-Agent/Referer and credit Poly Haven visibly where surfaced — downloaded
   CC0 files themselves need no credit), Quaternius CC0 characters (itch.io,
   verify the download route before depending on it), sfxr/ZzFX-style
   synthesized effects and code-rendered music loops for audio. Do not scrape
   the website (its ToS forbids it); use the public API or the Blender tools.
   Record every file's source and licence in ASSETS.md next to its use;
   unlicensed or unknown-source files do not ship.
8. Retrieve, don't imagine: 3D comes through the game_blender_assets_search /
   game_blender_import tools (Poly Haven, no key; GLB plus textures into the
   live Blender scene, then exported and imported to the engine like any
   model). 2D art and audio are generated with standard-library code (Pillow
   PNG, wave synth) into the asset folders. Quaternius/Kenney packs are fetched
   with plain HTTPS downloads only after confirming the URL serves the file;
   glb/gltf/fbx/obj for meshes, png/jpg/webp/svg for images, wav/ogg/mp3/mid
   for audio — anything else is converted or refused. Every fetched file lands
   with its source URL, licence and intended use appended to the ASSETS.md
   file-to-use map in the same step; a file without that line is unused.
