import type { GameEngineProfile } from "./engineProfile.ts";

export const GODOT_PROFILE: GameEngineProfile = {
  id: "godot",
  displayName: "Godot",
  projectDirectory: "godot",
  exportTargets: ["Web", "Linux", "Windows"],
  layout: { assets: "assets", ui: "ui", library: "library", blender: "assets/blender" },
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
      stateHook:
        "A setup target of the game's own is a branch in func studio_set_state(target: String, values: Dictionary) -> bool on the GameState autoload, returning true when it put the game there. ",
    },
  },
};
