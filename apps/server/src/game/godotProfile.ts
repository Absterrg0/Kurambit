import { GAME_ENGINES } from "@kurambit/contracts";
import type { GameEngineProfile } from "./engineProfile.ts";

export const GODOT_PROFILE: GameEngineProfile = {
  id: "godot",
  status: GAME_ENGINES.godot.status,
  editors: ["blender"],
  turnLoop: GAME_ENGINES.godot.turnLoop,
  stage: GAME_ENGINES.godot.stage,
  tuneFile: null,
  displayName: "Godot",
  projectDirectory: "godot",
  exportTargets: ["Web", "Linux", "Windows"],
  releases: [
    { target: "Web", artifact: null, ships: "folder", packageable: true },
    // The standard presets embed the pack; a custom preset adds game.pck beside the executable.
    { target: "Linux", artifact: "builds/linux/game.x86_64", ships: "file", packageable: false },
    { target: "Windows", artifact: "builds/windows/game.exe", ships: "file", packageable: true },
  ],
  buildInputs: {
    skipDirs: [".godot"],
    rootOutputDirs: [],
    sidecarSuffixes: [".import", ".uid"],
    rootOutputFiles: null,
    derivedAssets: false,
  },
  scaffold: {
    version: "4.7.2",
    directories: ["godot/assets/models", "godot/scripts", "builds/web"],
    agents: `Build BRIEF.md's game in Godot 4.7 (GDScript; Forward+ natively, Compatibility on Web). godot/ is the project.

Use the game_* tools to check, play, export and package the game; never run Godot yourself. Keep builds/ and godot/.godot/ generated.
`,
  },
  resourcePath: (projectRelative) => `res://${projectRelative}`,
  importRoot: null,
  sharedEditor: false,
  importStep: true,
  compressedModels: false,
  groundHint: (width, height, ground) =>
    `Godot: Sprite2D offset (0, ${height / 2 - ground}) puts the node origin on the ground line (x=${width / 2} is already the origin).`,
  sidecarLoad: null,
  stripLoad: (key, resource, view) =>
    `SpriteStrips.apply($AnimatedSprite2D, {${JSON.stringify(key)}: "${resource}"}, "${view}") loads it`,
  tools: {
    import: "Godot games run a headless editor import (sidecars and the .godot cache).",
    check:
      "Godot games load every .gd, .tscn and .tres outside .gdignore folders and outside what every export preset excludes, run the main scene and the gameplay scene game.json declares for 120 physics frames each, and report parse, load and runtime errors with file:line, plus lint warnings for InputMap actions used but not defined and a player without a working CollisionShape.",
    export:
      "Godot games take the Web, Windows or Linux release preset. Windows writes builds/windows/game.exe, a 64-bit x86_64 executable (the standard preset embeds the game data; a custom preset that does not also writes builds/windows/game.pck, so keep both files together; it has not been run on Windows). Linux writes builds/linux/game.x86_64. Missing export templates are an actionable error naming how the user adds them in Godot. Web uses Compatibility rendering and a single-threaded export.",
    explore: "Godot games run natively with the game paused between acts.",
  },
  layout: {
    assets: "assets",
    ui: "ui",
    library: "library",
    blender: "assets/blender",
    sprites: "sprites",
  },
  viewport: null,
  play: "native",
  web: {
    exported: ["index.html", "index.wasm", "index.js", "index.pck"],
    served: ["index.html", "index.js", "index.wasm", "index.pck"],
  },
  check: {
    timedOut: "The Godot check timed out before finishing its physics frames.",
    // Without a gameplay scene the check falls back to the main scene, which is the menu.
    withoutGameplayScene:
      "The manifest declares no gameplay scene, so the check ran only the main scene (the menu); gameplay initialization was not exercised.",
  },
  run: {
    skill: "godot-game",
    // The play runner lives in the server (Godot's runner script, the browser host).
    harnessFiles: null,
    parallelSamples: true,
    warmEditor: false,
    sources: { extensions: [".gd"], under: "" },
    prompts: {
      // Games made from the Godot starter carry a demo shell; older ones do not, so the line defers to TEMPLATE.md.
      shell:
        "When TEMPLATE.md describes the demo shell, use it: gameplay goes in godot/scenes/game.tscn, a run ends with GameState.win or GameState.lose, every player action gets an answer through Juice, values that must survive a retry go in KEEP_ACROSS_RUNS, and you build no menus of your own. ",
      art: "A 3D game needs real 3D models as GLB, library or Blender models (game_blender_* tools; rigged characters where they move), then imported and checked in the engine; code-built primitives are placeholders, same as 2D. ",
      titleArt: "",
    },
  },
};
