import {
  GAME_ENGINES,
  UNITY_MIN_VERSION,
  UNITY_VIEWPORT,
  UNITY_PROJECT_DIRECTORY,
} from "@kurambit/contracts";
import type { GameEngineProfile } from "./engineProfile.ts";

const RUNTIME_SETTINGS =
  /^( *)m_RuntimeSettings:\r?\n\1 {2}m_List:(?: \[\])?\r?\n(?:\1 {2}- rid: -?\d+\r?\n)*/m;

export const UNITY_PROFILE: GameEngineProfile = {
  id: "unity",
  status: GAME_ENGINES.unity.status,
  editors: ["blender", "unity"],
  turnLoop: GAME_ENGINES.unity.turnLoop,
  stage: GAME_ENGINES.unity.stage,
  tuneFile: null,
  displayName: "Unity",
  projectDirectory: UNITY_PROJECT_DIRECTORY,
  exportTargets: ["Linux", "Windows"],
  // A Unity player is a folder (executable, game_Data/, the engine runtime): it ships whole.
  releases: [
    { target: "Linux", artifact: "builds/linux/game.x86_64", ships: "folder", packageable: false },
    { target: "Windows", artifact: "builds/windows/game.exe", ships: "folder", packageable: false },
  ],
  // URP keeps a list of the settings a player needs in `m_RuntimeSettings`. A
  // player build fills it from the rest of the file and an editor save empties
  // it again, so it flips on every warm-up and build without any source edit.
  // The build recomputes it either way: it is output kept inside an input file.
  derivedInput: {
    glob: "*.asset",
    marker: "m_RuntimeSettings:",
    normalise: (text) => text.replace(RUNTIME_SETTINGS, "$1m_RuntimeSettings: derived\n"),
  },
  scaffold: {
    version: UNITY_MIN_VERSION,
    directories: [],
    ignores: [
      "unity/[Ll]ibrary/",
      "unity/[Tt]emp/",
      "unity/[Ll]ogs/",
      "unity/[Uu]ser[Ss]ettings/",
      "unity/[Oo]bj/",
      "unity/*.csproj",
      "unity/*.sln",
      // Its own build folders and Mono's crash dumps, which land whenever an editor is stopped.
      "unity/[Bb]uild/",
      "unity/[Bb]uilds/",
      "unity/mono_crash.*",
    ],
    agents: `Build BRIEF.md's game in Unity 6 (C#, Input System). unity/ is the project inside a demo shell (TEMPLATE.md): gameplay goes in unity/Assets/Scenes/Game.unity, built by unity/Assets/Editor/BuildGame.cs, game code in unity/Assets/Scripts; unity/Assets/Kurambit stays as shipped.

Use the game_* tools to check, play, export and package the game, and the game_unity_* tools to edit scenes in the live editor; never run Unity yourself. Keep builds/ and unity/Library, Temp, Logs, UserSettings generated.
`,
  },
  resourcePath: (projectRelative) => projectRelative,
  importRoot: "Assets",
  importStep: true,
  compressedModels: false,
  groundHint: (_width, height, ground) => {
    const up = Number(((height - ground) / height).toFixed(4));
    return `Unity: set the sprite's Pivot to Custom (0.5, ${up}) in its import settings (Pixels Per Unit is yours to match the tiles) to put the transform on the ground line.`;
  },
  stripLoad: null,
  xvfbRenderer: null,
  sidecarLoad: null,
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
    credits: "Assets/credits.txt",
  },
  viewport: UNITY_VIEWPORT,
  play: "player",
  web: null,
  check: {
    timedOut: "The Unity check timed out before finishing its physics frames.",
    withoutGameplayScene: null,
  },
  skill: "unity",
};
