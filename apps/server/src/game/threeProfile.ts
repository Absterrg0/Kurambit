import {
  GAME_ENGINES,
  THREE_PINNED_VERSION,
  THREE_VIEWPORT,
  THREE_PROJECT_DIRECTORY,
} from "@kurambit/contracts";
import type { GameEngineProfile } from "./engineProfile.ts";

export const THREE_PROFILE: GameEngineProfile = {
  id: "three",
  editors: ["blender"],
  turnLoop: GAME_ENGINES.three.turnLoop,
  stage: GAME_ENGINES.three.stage,
  tuneFile: "tune.json",
  displayName: "three.js",
  projectDirectory: THREE_PROJECT_DIRECTORY,
  exportTargets: ["Web"],
  releases: [{ target: "Web", artifact: null, ships: "folder", packageable: true }],
  scaffold: {
    version: THREE_PINNED_VERSION,
    directories: ["web/assets", "builds/web"],
    ignores: [],
    agents: `Build BRIEF.md's game with three.js. web/ is the static project: web/index.html, web/main.js, web/assets for every visual and sound. three.js and the bridge that runs the game (TEMPLATE.md) are Kurambit's runtime (game.json \`runtime\`), which Kurambit serves and copies into every export: no install step. Import them as \`./vendor/three.module.js\` and \`./shell/run-state.js\`; the import map in web/index.html points those at the runtime; read its source in studio-skills/runtime/shell/. Never copy or edit the runtime: a variant is a module of the game's own beside main.js.

Use the game_* tools to check, play, export and package the game; never launch your own browser. Keep builds/ generated.
`,
  },
  resourcePath: (projectRelative) => `./${projectRelative}`,
  importStep: false,
  compressedModels: true,
  groundHint: (_width, height, ground) => {
    const up = Number(((height - ground) / height).toFixed(4));
    return `three.js: sprite.center.set(0.5, ${up}) on a THREE.Sprite, or geometry.translate(0, ${Number((0.5 - up).toFixed(4))} * planeHeight, 0) on a plane, puts the object's position on the ground line.`;
  },
  sidecarLoad: (key, sidecar) =>
    `three.js games load the sidecar: ASSETS = { ${key}: "${sidecar}" }.`,
  layout: {
    assets: "assets",
    ui: "ui",
    library: "library",
    blender: "assets/blender",
    sprites: "sprites",
    credits: "credits.txt",
  },
  viewport: THREE_VIEWPORT,
  // The release is a static copy of the folder: its entry proves the staging,
  // and Play needs the entry and the gameplay module.
  web: { exported: ["index.html"], served: ["index.html", "main.js"] },
  check: {
    timedOut: "The three.js check timed out: the page never reported ready within 60 s.",
  },
  skill: "three",
};
