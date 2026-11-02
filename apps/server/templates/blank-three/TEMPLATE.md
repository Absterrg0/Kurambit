# {{GAME_NAME}} — Blank (browser) starter template

This game started from the **Blank (browser)** template: one static three.js
project under `web/` with no gameplay yet. Everything below is the starting
point to extend, not a fixed structure.

## What the template ships

- `web/index.html` — the only page. Served over HTTP by preview, playtest and
  the export; `file://` is not a supported way to play it.
- `web/main.js` — the game: a lit 3D scene (ground, key light, beacon, rover),
  WASD/arrows movement, and the `GameState` object. Keep `GameState` as the
  single source of truth with public primitives only.
- `web/style.css` — fullscreen canvas plus the `#hud` overlay. The probe
  reports the overlay text, so keep the values that matter on screen too.
- `web/vendor/three.module.js` + `web/vendor/three.core.js` — three.js
  r0.180.0, pinned and vendored (MIT, see `web/vendor/LICENSE`), imported
  with a relative path. The module entry re-exports the core file, so both
  stay together. No install step, no bundler, no CDN. Keep the pin; say why
  in `web/vendor/PROVENANCE.md` before changing it.
- `web/assets/` — every visual and sound the game adds. Reference local
  files; nothing loads from the network at runtime.

## The studio bridge (keep it)

`window.__studio` is how the harness plays this game: `ready` after the first
frame, `getState()` returning `{gameState, player, hudText}`, `errors[]`
carrying page errors, and `setState(target, values)` reaching named late
content when the game implements a target (the starter refuses). Keep the
shape; extend `GameState`, not the bridge. The bridge also answers the
stage's `studio-visibility` messages: while the stage tab is hidden the loop
pauses (and a game with sound mutes), then restores what it found.

## Where to add content

- Build gameplay inside `web/main.js` (split per system into modules under
  `web/` when it grows past a screenful), so the page stays the entry point.
- A game with no player marks play with a typed `GameState.state` (0/false
  before play, another value once play starts), so exploration and bot runs
  can find the gameplay baseline.
- Prefer code-built meshes and a few local assets over heavy downloads; the
  export is a static copy of `web/`, so everything the game needs must be a
  file in it.

## Conventions

- ES modules only, no build step: the file the browser loads is the file you
  edit. Keep the import of `./vendor/three.module.js` relative.
- Keyboard: read physical keys on `window` (`KeyW`/`ArrowLeft`/…). The harness
  sends real keys, not Godot action names.
- The game must be playable from `web/index.html` on a fresh checkout.
- Never open anything outside `web/` at runtime, never phone home.

## Playtest

Play first with the `game_explore_*` tools (target web) and study every frame.

## Checks

`game_check` loads the page headless and reports console and page errors with
file and line. Keep the boot clean: no script errors while the game runs.
Engine shutdown noise after quit is not failure; anything while the game runs
is.
