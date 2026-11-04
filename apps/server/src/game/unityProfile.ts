import { UNITY_VIEWPORT, UNITY_PROJECT_DIRECTORY } from "@kurambit/contracts";
import type { GameEngineProfile } from "./engineProfile.ts";

export const UNITY_PROFILE: GameEngineProfile = {
  id: "unity",
  displayName: "Unity",
  projectDirectory: UNITY_PROJECT_DIRECTORY,
  exportTargets: ["Linux", "Windows"],
  // Unity imports only what sits under Assets/, and its template's folders are capitalised.
  layout: { assets: "Assets", ui: "UI", library: "Library", blender: "Assets/Blender" },
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
      stateHook:
        "A setup target of the game's own is a branch in public static bool StudioSetState(string target, Dictionary<string, object> values) on GameState, returning true when it put the game there. ",
    },
  },
};
