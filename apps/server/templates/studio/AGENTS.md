# Studio skills

Craft advice, a skill per file, for the game's engine. A game's first
turn needs only what "The first turn" in its first message names.

- `three`: three.js lane: the rules beside the bridge contract, the Stage's Ask.
- `art-pipeline`: STYLE.json's look, reviews, Blender, generated art, sprites.

## Recipes

How shipped games make one part well, a page each: `recipes/<id>.md`. Pick at most 3 for
this turn, read only those, and name them in game.json `"recipes": [...]`; `game_check` then
prints each one's numbers.

- `block-out-first`: the first turn: a moving scene within minutes, improved in place.
- `opens-on-the-game`: every game's first frame; a title only when asked for.
- `light-rig`: any lit 3D scene: sun, sky, bounce, tone mapping, shadows.
- `sky-fog`: outdoors: sky, sun-tinted fog, distance.
- `stylised-sea`: open water: swell, depth colour, foam.
- `boat-buoyancy`: a hull on water: floating, steering, wake.
- `third-person-camera`: a character steered from behind.
- `hit-feel`: any hit: hit stop, flash, knockback, shake.
- `attack-telegraph`: enemy attacks: windup, active, recovery.
- `controller-feel`: running, jumping, dashing.
- `readable-boss`: a duel or one foe the game is about.
- `hud-that-reads`: HUD, prompts, menus: text size, placement.
- `sound-set-mix`: every game: the sounds it needs, and the mix.
- `tension-release`: threats over time: waves, a boss, a chase.
- `retry-one-press`: any game that can be lost; pause.
- `art-silhouette`: every made model: masses first, against a reference.
- `art-palette`: a model's colours: one atlas, painted cells.
- `art-prop`: crates, barrels, weapons, tables: edges that catch light.
- `art-humanoid`: a hero or NPC on the standard skeleton.
- `art-quadruped`: an animal the library lacks.
- `art-vehicle`: cars, carts, boats.
- `art-ruin`: walls, arches, houses: pieces on the grid.
- `art-trees-rocks`: trees, rocks and their scatter.
- `art-budget`: too many triangles or draws, far copies.
- `pictures-2d`: cards, tiles, icons, UI art, 2D effects and characters.
- `voxels`: blocky models, characters and worlds, .vox files.
