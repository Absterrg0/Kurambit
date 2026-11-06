import {
  GAME_TEMPLATES,
  THREE_PINNED_VERSION,
  UNITY_MIN_VERSION,
  gameTemplateForEngine,
  type GameCreateInput,
  type GameEngineId,
  type GameManifest,
} from "@kurambit/contracts";
import { engineProfile } from "./engineProfile.ts";
import { CHECK_BOT_DIR } from "./run/checkRunner.ts";

// Run notes and reports are harness output, never game content: ignoring them
// keeps the tree clean so build swaps never need a stash (T28 wedged on a
// half-applied stash pop). The list keeps the files earlier runs wrote
// (run.json, rounds.jsonl, stop, steer, profile, run.log), so an older game's leftovers
// never ride in a commit.
export const RUN_STATE_IGNORES = [
  ".studio/run.json",
  ".studio/rounds.jsonl",
  ".studio/stop",
  ".studio/steer.jsonl",
  ".studio/profile",
  ".studio/run.log",
  ".studio/bot-results.jsonl",
  ".studio/player-report.md",
  ".studio/pick.txt",
  ".studio/next.md",
  ".studio/ship.md",
  ".studio/art-review.md",
  ".studio/ladder.json",
  `${CHECK_BOT_DIR}/`,
  ".studio/rung-change.json",
  ".studio/exports.json",
  ".studio/final-video.json",
  ".studio/tester-*.md",
  ".studio/reviewer-*.md",
  ".studio/worktrees/",
  ".studio/comparisons/",
  ".studio/saves/",
  // The creator's saved videos and images (gameSavedMedia.ts).
  "saved/",
  ".studio/play-*.md",
  ".studio/proto-*.md",
  ".studio/proto-*-frames.jpg",
  ".studio/round-state.json",
  "PICK-NOTES.md",
  "JUDGE-NOTES.md",
] as const;

/** What every engine generates in the game folder, beside the run's own files. */
const GENERATED_IGNORES = [
  "builds/",
  "godot/.godot/",
  "unity/[Ll]ibrary/",
  "unity/[Tt]emp/",
  "unity/[Ll]ogs/",
  "unity/[Uu]ser[Ss]ettings/",
  "unity/[Oo]bj/",
  "unity/*.csproj",
  "unity/*.sln",
  "*.blend1",
];

/** The engine a create request builds for. Omitted means the Godot native lane. */
export const createEngine = (input: GameCreateInput): GameEngineId => input.engine ?? "godot";

/** The manifest a new game starts from; the template names the gameplay scene. */
export function scaffoldManifest(input: GameCreateInput): GameManifest {
  const engine = createEngine(input);
  const template = gameTemplateForEngine(engine);
  const templateEntry = GAME_TEMPLATES.find((entry) => entry.id === template);
  return {
    schemaVersion: 1,
    name: input.name.trim(),
    brief: input.brief,
    artDirection: input.artDirection ?? "",
    template,
    ...(templateEntry?.gameplayScene === undefined
      ? {}
      : { gameplayScene: templateEntry.gameplayScene }),
    ...(templateEntry?.probe === true ? { probe: true } : {}),
    engine:
      engine === "three"
        ? { name: "three", version: THREE_PINNED_VERSION }
        : engine === "unity"
          ? { name: "unity", version: UNITY_MIN_VERSION }
          : { name: "godot", version: "4.7.2" },
    project: engineProfile(engine).projectDirectory,
    // The same folder under its legacy key, for one release, so an older installed Kurambit still opens the game.
    godotProject: engineProfile(engine).projectDirectory,
    assets: [],
  };
}

/**
 * The creator's own session and a live production run share this folder; the
 * run's builder edits it and the run restores builds into it, which would
 * overwrite the session's edits.
 */
export const CREATOR_SESSION_SECTION = `## The creator's session and the production run

This section is for the creator's own session on this game. A session the production run launched for one of its roles follows its prompt instead.

A production run may be working on this game; game_run_status says whether one is live and what it is doing. While one is live, do not edit the game's files: the run is changing them and restores its builds into the folder, which would overwrite your edits. Pass the creator's requests to the run with game_run_steer and tell them the run's next round takes it up. When no run is live, work on the game directly as usual. A run ends once its ladder is done and the ship check has played the game; it does not polish on its own. When the creator wants the run to polish something, pass their request with game_run_steer: the run comes back for one round on it, then stops.

A run is Guided or on Autopilot. A Guided run asks the creator at its decision points (the vision's look, which prototype to keep, the ladder of what to build) by sending a message to this chat. When one arrives, read the decision with game_run_status and present it:

- Show the evidence as a visual reply: an HTML render with the images by their local paths (key art, each prototype's frame sheet), and the pitches or the ladder as short text.
- Say in a few plain lines what differs or what to look at; no jargon about the run.
- Ask, and invite an answer in the creator's own words. They may combine ("the first one's movement with the second one's camera"), change things, or let the run decide.
- Say what the run does by itself if nobody answers, and when (game_run_status gives the time).

Record the answer with game_run_decide: choose the answer that fits what they said and put their words in notes. A refused answer comes back with the reason; fix it and call again. Do not answer for the creator; if nobody answers, the run takes its default by itself.

The creator can ask at any time to start or resume the run (game_run_start), stop it (game_run_stop), switch it between Guided and Autopilot (game_run_profile), steer it (game_run_steer) or put the game back to a kept round (game_run_restore).
`;

/**
 * Files the studio owns for every game. The starter template's project tree
 * supplies the engine sources; see templates.ts.
 */
export function scaffoldFiles(input: GameCreateInput): Record<string, string> {
  const manifest = scaffoldManifest(input);
  const engine = createEngine(input);
  const projectLine =
    engine === "unity"
      ? `# Kurambit project

Build BRIEF.md's game in Unity 6 (C#, Input System). unity/ is the project inside a demo shell (TEMPLATE.md): gameplay goes in unity/Assets/Scenes/Game.unity, built by unity/Assets/Editor/BuildGame.cs, game code in unity/Assets/Scripts; unity/Assets/Kurambit stays as shipped.

Use the game_* tools to check, play, export and package the game, and the game_unity_* tools to edit scenes in the live editor; never run Unity yourself. Keep builds/ and unity/Library, Temp, Logs, UserSettings generated.
`
      : engine === "three"
        ? `# Kurambit project

Build BRIEF.md's game with three.js (vendored in web/vendor, no install step). web/ is the static project: web/index.html, web/main.js, web/style.css, web/assets for every visual and sound.

Use the game_* tools to check, play, export and package the game; never launch your own browser. Keep builds/ generated.
`
        : `# Kurambit project

Build BRIEF.md's game in Godot 4.7 (GDScript, Compatibility). godot/ is the project.

Use the game_* tools to check, play, export and package the game; never run Godot yourself. Keep builds/ and godot/.godot/ generated.
`;
  return {
    "game.json": JSON.stringify(manifest, null, 2) + "\n",
    "BRIEF.md": `# ${manifest.name}\n\n${manifest.brief}\n\n## Art direction\n\n${manifest.artDirection}\n`,
    "AGENTS.md": `${projectLine}\n${CREATOR_SESSION_SECTION}`,
    "CLAUDE.md": "@AGENTS.md\n",
    ".gitignore": `${[...GENERATED_IGNORES, ...RUN_STATE_IGNORES].join("\n")}\n`,
  };
}
