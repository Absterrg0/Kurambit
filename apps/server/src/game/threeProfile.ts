import { THREE_PROJECT_DIRECTORY } from "@kurambit/contracts";
import type { GameEngineProfile } from "./engineProfile.ts";

export const THREE_PROFILE: GameEngineProfile = {
  id: "three",
  displayName: "three.js",
  projectDirectory: THREE_PROJECT_DIRECTORY,
  exportTargets: ["Web"],
  layout: { assets: "assets", ui: "ui", library: "library", blender: "assets/blender" },
  play: "browser",
  botRefusal: null,
  // The release is a static copy of the folder: its entry proves the staging,
  // and Play needs the entry and the gameplay module.
  web: { exported: ["index.html"], served: ["index.html", "main.js"] },
  check: {
    timedOut: "The three.js check timed out: the page never reported ready within 60 s.",
    withoutGameplayScene: null,
  },
  run: {
    skill: "three",
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
