import {
  GAME_ENGINES,
  THREE_PINNED_VERSION,
  THREE_VIEWPORT,
  THREE_PROJECT_DIRECTORY,
} from "@kurambit/contracts";
import type { GameEngineProfile } from "./engineProfile.ts";

export const THREE_PROFILE: GameEngineProfile = {
  id: "three",
  turnLoop: GAME_ENGINES.three.turnLoop,
  stage: GAME_ENGINES.three.stage,
  displayName: "three.js",
  projectDirectory: THREE_PROJECT_DIRECTORY,
  exportTargets: ["Web"],
  releases: [{ target: "Web", artifact: null, ships: "folder", packageable: true }],
  buildInputs: {
    skipDirs: [],
    rootOutputDirs: [],
    sidecarSuffixes: [],
    rootOutputFiles: null,
    derivedAssets: false,
  },
  scaffold: { version: THREE_PINNED_VERSION, directories: ["web/assets", "builds/web"] },
  resourcePath: (projectRelative) => `./${projectRelative}`,
  importRoot: null,
  importStep: false,
  groundHint: (_width, height, ground) => {
    const up = Number(((height - ground) / height).toFixed(4));
    return `three.js: sprite.center.set(0.5, ${up}) on a THREE.Sprite, or geometry.translate(0, ${Number((0.5 - up).toFixed(4))} * planeHeight, 0) on a plane, puts the object's position on the ground line.`;
  },
  stripLoad: null,
  tools: {
    import: "three.js games have no import step: the static folder is the game.",
    check:
      "three.js games load the static page and then the gameplay entry in headless Chromium and report console and page errors; a page that crashes is the game's error, a browser that is lost is a tool failure.",
    export:
      "three.js games export Web only (a static copy of web/); Windows and Linux are refused.",
    explore: "three.js games load the static folder in headless Chromium and play in real time.",
  },
  layout: {
    assets: "assets",
    ui: "ui",
    library: "library",
    blender: "assets/blender",
    sprites: "sprites",
  },
  viewport: THREE_VIEWPORT,
  play: "browser",
  // The release is a static copy of the folder: its entry proves the staging,
  // and Play needs the entry and the gameplay module.
  web: { exported: ["index.html"], served: ["index.html", "main.js"] },
  check: {
    timedOut: "The three.js check timed out: the page never reported ready within 60 s.",
    withoutGameplayScene: null,
  },
  run: {
    skill: "three",
    // The play runner lives in the server (Godot's runner script, the browser host).
    harnessFiles: { template: "blank-three", files: ["shell/studio.js"] },
    parallelSamples: true,
    warmEditor: false,
    sources: { extensions: [".js", ".mjs"], under: "" },
    prompts: {
      shell:
        "When TEMPLATE.md describes the demo shell, use it: gameplay goes in web/main.js (start, update, stop on the ctx the shell passes), a run ends with GameState.win or GameState.lose, every player action gets an answer through Juice, values that must survive a retry go in KEEP_ACROSS_RUNS, and you build no menus or render loop of your own. ",
      art: "Models are GLB, library or Blender models (game_blender_* tools, exported under web/assets), sprites and textures as rendered PNGs; code-built primitives are placeholders. The export is a static copy, so everything the game loads must be a file under web/. ",
      titleArt:
        '; also add, inside :root in web/style.css, --title-art: linear-gradient(rgb(0 0 0 / 0.55), rgb(0 0 0 / 0.55)), url("assets/ui/title_bg.png"); (this one CSS line is allowed)',
    },
  },
};
