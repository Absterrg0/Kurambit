import {
  GAME_TEMPLATES,
  THREE_PINNED_VERSION,
  THREE_PROJECT_DIRECTORY,
  UNITY_PINNED_VERSION,
  UNITY_PROJECT_DIRECTORY,
  gameTemplateForEngine,
  type GameCreateInput,
  type GameEngineId,
  type GameManifest,
} from "@kurambit/contracts";

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
          ? { name: "unity", version: UNITY_PINNED_VERSION }
          : { name: "godot", version: "4.7.2" },
    // The engine project directory for every lane, despite the legacy name.
    godotProject:
      engine === "three"
        ? THREE_PROJECT_DIRECTORY
        : engine === "unity"
          ? UNITY_PROJECT_DIRECTORY
          : "godot",
    assets: [],
  };
}

/**
 * The creator's own session and a live production run share this folder; the
 * run's builder edits it and its git resets would undo the session's edits.
 */
export const CREATOR_SESSION_SECTION = `## The creator's session and the production run

This section is for the creator's own session on this game. A session the production run launched for one of its roles follows its prompt instead.

A production run may be working on this game; game_run_status says whether one is live and what it is doing. While one is live, do not edit the game's files: the run is changing them and its commits and resets would collide with yours. Pass the creator's requests to the run with game_run_steer and tell them the run's next round takes it up. When no run is live, work on the game directly as usual.
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

Build BRIEF.md's game in Unity ${UNITY_PINNED_VERSION} (C#, Input System). unity/ is the project: unity/Assets/Scenes/Main.unity is the main scene, unity/Assets/Scripts for game code, unity/Assets/Kurambit/StudioProbe.cs stays as shipped.

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
    ".gitignore":
      "builds/\ngodot/.godot/\nunity/[Ll]ibrary/\nunity/[Tt]emp/\nunity/[Ll]ogs/\nunity/[Uu]ser[Ss]ettings/\nunity/[Oo]bj/\nunity/*.csproj\nunity/*.sln\n*.blend1\n.studio/run.json\n.studio/rounds.jsonl\n.studio/stop\n.studio/run.log\n.studio/bot-results.jsonl\n.studio/player-report.md\n.studio/pick.txt\n.studio/next.md\n.studio/ship.md\n.studio/exports.json\n.studio/final-video.json\n.studio/tester-*.md\n.studio/reviewer-*.md\n.studio/worktrees/\nPICK-NOTES.md\nJUDGE-NOTES.md\n",
  };
}
