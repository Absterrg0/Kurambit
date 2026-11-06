import { UNITY_MIN_VERSION, UNITY_VIEWPORT, UNITY_PROJECT_DIRECTORY } from "@kurambit/contracts";
import type { GameEngineProfile } from "./engineProfile.ts";

export const UNITY_PROFILE: GameEngineProfile = {
  id: "unity",
  turnLoop: false,
  displayName: "Unity",
  projectDirectory: UNITY_PROJECT_DIRECTORY,
  exportTargets: ["Linux", "Windows"],
  // A Unity player is a folder (executable, game_Data/, the engine runtime): it ships whole.
  releases: [
    { target: "Linux", artifact: "builds/linux/game.x86_64", ships: "folder", packageable: false },
    { target: "Windows", artifact: "builds/windows/game.exe", ships: "folder", packageable: false },
  ],
  // A Unity project's own caches sit at its root beside Assets/ and are rewritten by every
  // editor start; Mono's crash dumps land there whenever an editor is stopped.
  buildInputs: {
    skipDirs: [],
    rootOutputDirs: ["Library", "Temp", "Logs", "UserSettings", "obj", "Build", "Builds"],
    sidecarSuffixes: [],
    rootOutputFiles: /(?:\.csproj|\.sln)$|^mono_crash\./,
    derivedAssets: true,
  },
  scaffold: { version: UNITY_MIN_VERSION, directories: [] },
  resourcePath: (projectRelative) => projectRelative,
  importRoot: "Assets",
  importStep: true,
  groundHint: (_width, height, ground) => {
    const up = Number(((height - ground) / height).toFixed(4));
    return `Unity: set the sprite's Pivot to Custom (0.5, ${up}) in its import settings (Pixels Per Unit is yours to match the tiles) to put the transform on the ground line.`;
  },
  stripLoad: null,
  tools: {
    import: "Unity games refresh assets and recompile scripts in the game's live Unity editor.",
    check:
      "Unity games recompile, then play the first enabled build scene and the gameplay scene game.json declares in the live editor for 120 frames each and read its console errors; a scene that never lets play mode advance is an error (the game froze), one that runs below speed is a warning with its frame rate.",
    export:
      "Unity games export Linux or Windows players built in the live editor: builds/linux/ or builds/windows/ is the whole player folder (game.x86_64 or game.exe with game_Data/ and the runtime library beside it); ship the folder. Web is refused.",
    explore:
      "Unity games play a player of the current sources, built once per source identity, in a window the user never sees.",
  },
  // Unity imports only what sits under Assets/, and its template's folders are capitalised.
  layout: {
    assets: "Assets",
    ui: "UI",
    library: "Library",
    blender: "Assets/Blender",
    sprites: "Art/Sprites",
  },
  viewport: UNITY_VIEWPORT,
  play: "player",
  web: null,
  check: {
    timedOut: "The Unity check timed out before finishing its physics frames.",
    withoutGameplayScene: null,
  },
  run: {
    skill: "unity",
    harnessFiles: { template: "blank-unity", files: ["Assets/Kurambit/StudioProbe.cs"] },
    // One editor per server builds every sample's player, so a second sample would wait on it.
    parallelSamples: false,
    // The project's first editor open imports everything (minutes; later opens take seconds).
    warmEditor: true,
    // A Unity project's own files live under Assets/; everything beside it is generated.
    sources: { extensions: [".cs"], under: "Assets" },
    prompts: {
      shell: "",
      // The Unity lane imports models from Assets/; its line otherwise matches the Godot one.
      art: "A 3D game needs real 3D models as GLB, from the library or made with the game_blender_* tools and exported under unity/Assets/Blender with their armature and clips (glTFast imports both, clips included), textures and sprites as PNG under unity/Assets/Art, then game_import and game_check; code-built primitives are placeholders, same as 2D. Unity imports only what sits under unity/Assets/ (capital A). ",
      titleArt: "",
    },
  },
};
