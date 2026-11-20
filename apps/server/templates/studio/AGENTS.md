# Studio skills

Craft advice, one skill per file, for the game's engine. A game's first
turn needs only what "The first turn" in its first message names.

- `three`: three.js lane: the rules beside the bridge contract, the Stage's Ask.
- `art-pipeline`: the look kept in STYLE.json, the review loop, making in Blender, generated art, sprites.
- `pictures`: cards, tiles, tokens, icons, UI art, effects and 2D characters drawn as HTML or SVG, and how a game shows them and every sprite sheet.
- `voxels`: voxel models, characters and worlds, and .vox files.
- `audio`: sound effects and music, from the library or synthesized.
- `playtest`: when to play, how with `game_play`, report what was and was not verified.

## Recipes

How people who ship games make one part well: numbers, steps, pitfalls and checks, a page each,
in `recipes/<id>.md`. Pick at most 3 for this turn, read only those, and name them in game.json
`"recipes": [...]`; `game_check` then prints each one's numbers.

| id                | when                                                             |
| ----------------- | ---------------------------------------------------------------- |
| `art-silhouette`  | every made model: masses first, against a reference              |
| `art-palette`     | a model's colours: one atlas, faces and emblems as painted cells |
| `art-humanoid`    | a hero or NPC on the standard skeleton                           |
| `art-quadruped`   | an animal the library lacks                                      |
| `art-vehicle`     | cars, carts, boats                                               |
| `art-ruin`        | walls, arches, houses: pieces on the grid                        |
| `art-trees-rocks` | trees, rocks and their scatter                                   |
