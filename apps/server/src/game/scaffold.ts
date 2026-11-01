import {
  DEFAULT_GAME_TEMPLATE,
  DEFAULT_GAME_TEST_SUITE,
  GAME_TEMPLATES,
  type GameCreateInput,
  type GameManifest,
} from "@t3tools/contracts";

/** The first message of a game's thread. The brief lives in BRIEF.md. */
export function initialGamePrompt(input: GameCreateInput): string {
  const brief = `${input.brief}${input.artDirection ? `\n\nArt direction:\n${input.artDirection}` : ""}`;
  return `${brief}\n\nThe game is scaffolded in this folder: BRIEF.md holds the brief, godot/ the Godot 4.7 project. Build it with the game_* tools (game_check to check, game_export to export). The creator starts a production run from the Stage when ready.`;
}

/** The manifest a new game starts from; the blank template names the suite and scene. */
export function scaffoldManifest(input: GameCreateInput): GameManifest {
  const template = DEFAULT_GAME_TEMPLATE;
  const templateEntry = GAME_TEMPLATES.find((entry) => entry.id === template);
  return {
    schemaVersion: 1,
    name: input.name.trim(),
    brief: input.brief,
    artDirection: input.artDirection ?? "",
    template,
    testSuite: templateEntry?.testSuite ?? DEFAULT_GAME_TEST_SUITE,
    ...(templateEntry?.gameplayScene === undefined
      ? {}
      : { gameplayScene: templateEntry.gameplayScene }),
    ...(templateEntry?.probe === true ? { probe: true } : {}),
    engine: { name: "godot", version: "4.7.2" },
    godotProject: "godot",
    assets: [],
  };
}

/**
 * Files the studio owns for every game. The blank template supplies the
 * `godot/` tree; see templates.ts.
 */
export function scaffoldFiles(input: GameCreateInput): Record<string, string> {
  const manifest = scaffoldManifest(input);
  return {
    "game.json": JSON.stringify(manifest, null, 2) + "\n",
    "BRIEF.md": `# ${manifest.name}\n\n${manifest.brief}\n\n## Art direction\n\n${manifest.artDirection}\n`,
    "AGENTS.md": `# Game Studio project

Build BRIEF.md's game in Godot 4.7 (GDScript, Compatibility). godot/ is the project.

Use the game_* tools to check, play, export and package the game; never run Godot yourself. Keep builds/ and godot/.godot/ generated.
`,
    "CLAUDE.md": "@AGENTS.md\n",
    ".gitignore":
      "builds/\ngodot/.godot/\n*.blend1\n.studio/run.json\n.studio/rounds.jsonl\n.studio/stop\n.studio/run.log\n.studio/bot-results.jsonl\nPICK-NOTES.md\nJUDGE-NOTES.md\n",
  };
}
