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
  derivedInput: null,
  scaffold: {
    version: "4.7.2",
    directories: ["godot/assets/models", "godot/scripts", "builds/web"],
    ignores: ["godot/.godot/"],
    agents: `Build BRIEF.md's game in Godot 4.7 (GDScript; Forward+ natively, Compatibility on Web). godot/ is the project.

Use the game_* tools to check, play, export and package the game; never run Godot yourself. Keep builds/ and godot/.godot/ generated.
`,
  },
  resourcePath: (projectRelative) => `res://${projectRelative}`,
  importRoot: null,
  importStep: true,
  compressedModels: false,
  groundHint: (width, height, ground) =>
    `Godot: Sprite2D offset (0, ${height / 2 - ground}) puts the node origin on the ground line (x=${width / 2} is already the origin).`,
  sidecarLoad: null,
  // Xvfb has only software GL, so GameGodotEngine forces Compatibility there.
  xvfbRenderer: {
    settings: "project.godot",
    note: (settings) => {
      const method = /^renderer\/rendering_method="([^"]+)"/m.exec(settings)?.[1] ?? "forward_plus";
      return method === "gl_compatibility"
        ? null
        : `Compatibility; native exports draw ${method === "mobile" ? "Mobile" : "Forward+"}`;
    },
  },
  stripLoad: (key, resource, view) =>
    `SpriteStrips.apply($AnimatedSprite2D, {${JSON.stringify(key)}: "${resource}"}, "${view}") loads it`,
  layout: {
    assets: "assets",
    ui: "ui",
    library: "library",
    blender: "assets/blender",
    sprites: "sprites",
    credits: "credits.txt",
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
  skill: "godot-game",
};
