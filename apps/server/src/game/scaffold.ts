import {
  GAME_TEMPLATES,
  THREE_PINNED_VERSION,
  THREE_PROJECT_DIRECTORY,
  gameTemplateForEngine,
  type GameCreateInput,
  type GameEngineId,
  type GameManifest,
} from "@kurambit/contracts";

/** The first message of a game's thread. The brief lives in BRIEF.md. */
export function initialGamePrompt(input: GameCreateInput): string {
  const engine: GameEngineId = input.engine ?? "godot";
  const projectLine =
    engine === "three"
      ? "web/ the three.js static project (open web/index.html over HTTP to play it)"
      : "godot/ the Godot 4.7 project";
  const brief = `${input.brief}${input.artDirection ? `\n\nArt direction:\n${input.artDirection}` : ""}`;
  return `${brief}\n\nThe game is scaffolded in this folder: BRIEF.md holds the brief, ${projectLine}. Build it with the game_* tools (game_check to check, game_export to export). The creator starts a production run from the Stage when ready.`;
}

/** The engine a create request builds for. Omitted means the Godot native lane. */
export const createEngine = (input: GameCreateInput): GameEngineId => input.engine ?? "godot";

/** The manifest a new game starts from; the template names the suite and scene. */
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
    ...(templateEntry?.testSuite === undefined ? {} : { testSuite: templateEntry.testSuite }),
    ...(templateEntry?.gameplayScene === undefined
      ? {}
      : { gameplayScene: templateEntry.gameplayScene }),
    ...(templateEntry?.probe === true ? { probe: true } : {}),
    engine:
      engine === "three"
        ? { name: "three", version: THREE_PINNED_VERSION }
        : { name: "godot", version: "4.7.2" },
    godotProject: engine === "three" ? THREE_PROJECT_DIRECTORY : "godot",
    assets: [],
  };
}

/**
 * Files the studio owns for every game. The starter template's project tree
 * supplies the engine sources; see templates.ts.
 */
export function scaffoldFiles(input: GameCreateInput): Record<string, string> {
  const manifest = scaffoldManifest(input);
  const engine = createEngine(input);
  const projectLine =
    engine === "three"
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
    "AGENTS.md": projectLine,
    "CLAUDE.md": "@AGENTS.md\n",
    ".gitignore":
      "builds/\ngodot/.godot/\n*.blend1\n.studio/run.json\n.studio/rounds.jsonl\n.studio/stop\n.studio/run.log\n.studio/bot-results.jsonl\n.studio/player-report.md\n.studio/pick.txt\n.studio/next.md\n.studio/ship.md\n.studio/exports.json\n.studio/final-video.json\n.studio/tester-*.md\n.studio/reviewer-*.md\n.studio/worktrees/\nPICK-NOTES.md\nJUDGE-NOTES.md\n",
  };
}
