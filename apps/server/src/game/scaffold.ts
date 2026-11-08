import {
  DEFAULT_GAME_ENGINE,
  GAME_TEMPLATES,
  gameTemplateForEngine,
  type GameCreateInput,
  type GameEngineId,
  type GameManifest,
  type GameStageKind,
} from "@kurambit/contracts";
import { engineProfile, PROFILES } from "./engineProfile.ts";

// Where stage-era runs kept their ladder's state-check bots; old games still ignore it.
const CHECK_BOT_DIR = ".studio/bot/checks";

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
  ...PROFILES.flatMap((profile) => profile.scaffold.ignores),
  "*.blend1",
  // Kurambit writes and refreshes these from its own templates (server start, every turn):
  // tracked, a refresh would read as the agent's change and Undo would roll the skills back.
  "studio-skills/",
];

/** The engine a create request builds for. Omitted means the first active engine. */
export const createEngine = (input: GameCreateInput): GameEngineId =>
  input.engine ?? DEFAULT_GAME_ENGINE;

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
    ...(templateEntry?.runtime === undefined
      ? {}
      : { runtime: { [engine]: templateEntry.runtime } }),
    engine: { name: engine, version: engineProfile(engine).scaffold.version },
    project: engineProfile(engine).projectDirectory,
    // The same folder under its legacy key, for one release, so an older installed Kurambit still opens the game.
    godotProject: engineProfile(engine).projectDirectory,
    assets: [],
    ...(input.characters === undefined ? {} : { characters: input.characters }),
  };
}

/**
 * Keep going, for the agent of a game whose turns Kurambit plays (engineProfile
 * turnLoop): what a step message is and what the run does with its build.
 */
export const KEEP_GOING_HEADING = "## Keep going";
export const KEEP_GOING_SECTION = `${KEEP_GOING_HEADING}

- The person can turn on **Keep going**. Kurambit then sends this chat its next step as a message that starts "Keep going · step N". Do that one step, like any turn: one change, \`game_check\` clean, end with your \`Next:\` line.
- Kurambit measures the step's build, and undoes the step itself when it makes a fact worse; the person can redo it. Do not put an undone change back unless they ask.
- A step that asks you to fix a measured fact may be wrong for this game: then change nothing and say why in one line. Kurambit sets that step aside.
- The person's own messages always come first. Turn keep going on or off (\`game_keep_going\`) only when they ask.
`;
/** The section an earlier Kurambit wrote for its production run, whose tools are gone. */
export const STAGE_ERA_HEADING = "## The creator's session and the production run";

const EVERY_TURN_HEADING = "## Every turn";

const PLAYTEST_LINE =
  "- Do not play-test with `game_explore_*` or bots to see whether the game works: the harness measures every build. Explore only when the person asks or a fact says something you cannot see in the code. Read `game_facts` when the person reports a problem.";
const UNDO_LINE =
  "- The person can undo any turn. When files you wrote are back to an earlier state, they undid it on purpose (`game_builds` shows the restore). Do not put the change back unless they ask.";

/**
 * How a chat turn ends where Kurambit plays and measures every turn's build
 * (engineProfile turnLoop), by how the Stage shows the game; the other
 * engines' agents keep checking their own work.
 */
const EVERY_TURN_SECTIONS: Partial<Record<GameStageKind, string>> = {
  // The Stage serves the folder and reloads it on every save (GamePreview.live).
  live: `## Every turn

- **One visible change per turn.** The person watches your work live: Kurambit serves the game folder on their Stage and reloads it each time you save. A turn is one change they can see when they play, about five minutes of work, \`game_check\` clean with nothing left in its scene report, then end the turn. If the request needs more, do the first visible part and put the rest in \`Next:\`.
- **Keep the game booting between saves.** Every save reloads the person's game. Write a new module before the line that imports it, and keep \`main.js\` loadable at each save. A save that breaks the page shows the person the error.
${PLAYTEST_LINE}
${UNDO_LINE}
- **End every reply with one line,** \`Next: <the one change that would most improve this game>\`, or \`Next: none\` when the brief is done. The person can send your \`Next:\` with one click, so make it a request they could have typed: one change, in their words, not a plan.
`,
  // The Stage plays a Web export the turn loop rebuilds when the turn ends.
  export: `## Every turn

- A turn that changes the game becomes a build. When your turn ends, Kurambit plays it on the person's Stage and measures its facts: whether it boots, an idle, a random and a skilled bot, frozen frames, input response. Ending the turn is how the person sees your work, so keep turns short: one visible improvement, \`game_check\` clean with nothing left in its scene report, then end. Do not export to show it; the build is made for you.
${PLAYTEST_LINE}
${UNDO_LINE}
- End every reply with one line: \`Next: <the one change that would most improve this game>\`, or \`Next: none\` when the brief is done.
`,
};
const everyTurnSection = (engine: GameEngineId): string | undefined => {
  const profile = engineProfile(engine);
  return profile.turnLoop ? EVERY_TURN_SECTIONS[profile.stage] : undefined;
};

/**
 * On the generated route the first turn also starts the key art, builds on library stand-ins while
 * it renders, and ends on the person's pick: the look is theirs, and art never blocks the playable.
 */
const GENERATED_FIRST_STEP = `1. Start the key art first: \`game_generate\` with lane \`image\`, name \`key_art\`, \`options.aspect\` \`"16:9"\`, a prompt holding the game's world and moment in one image, and three \`directions\`: looks that truly differ (rendering, palette, shape language), each one this game can reach in its engine, drawn as an in-game screenshot, each grounded with a \`style\`: a library pack id that ships a picture of its look (a Kenney low-poly kit, Quaternius Monsters; KayKit ships none), or the person's own reference image, so the key art never promises a look the game cannot reach (\`studio-skills/art-pipeline.md\`, Generated art). It renders while you build; never wait on it. If it is refused (no key, or over the person's daily limit), say so in your reply and go on with library art. Then read \`BRIEF.md\`, the "Shortest path" in \`TEMPLATE.md\` and the recipe for your view in \`studio-skills/three.md\`. Write no plan or design document, and do not open Blender. The comment block at the top of each kit is enough; do not read the shell's code.`;
const GENERATED_LAST_STEP = `4. Run \`game_check\` and fix until it is clean, including each problem its scene report lists (open the frame it names), then \`game_generate_wait\` for the key art and end the turn: say what the person can do now, ask them to pick one of the key art's candidates in the chat, or say it is still rendering (the library models are stand-ins until art made from it arrives), say what it cost, and add your \`Next:\` line.`;

/** A new game's first turn, per engine; an engine without one gets the brief alone. */
const FIRST_TURN_SECTIONS: Partial<Record<GameEngineId, string>> = {
  three: `## The first turn

Goal: the person plays the brief's core loop on the Stage within ten minutes, with library art, not primitives.

1. Read \`BRIEF.md\`, the "Shortest path" in \`TEMPLATE.md\` and the recipe for your view in \`studio-skills/three.md\`. Write no plan or design document, make no key art, and do not open Blender. The comment block at the top of each kit is enough; do not read the shell's code.
2. Choose the look: \`game_assets_search\` with no words lists the library by style family. Pick one that fits the brief and write \`STYLE.json\` (family, view, packs, rig; \`studio-skills/art-pipeline.md\`). Add the player character and one or two threats or props with \`game_assets_add\`, and name them in \`ASSETS\`: the shell loads them, and compiles what draws them, behind its loading screen. Keep the default look (\`LOOK\` as it is, or the one preset the brief calls for, no lights besides \`ctx.look.sun\`): the first build then starts at once and reads clearly; extra lights and glows cost every frame. Glows are a later turn. When no pack has the brief's exact subject, take the closest character and say so in your reply; a model of its own is a later turn.
3. Replace the starter's gameplay in \`web/main.js\` (its sphere and beacon are placeholders) with the brief's core loop: the player moves (the recipe), the one main verb, the threat, a win and a lose through \`GameState.win\` and \`lose\`, the HUD through \`ctx.ui\`, and \`Juice\` on every action. As the recipes do, name the player and each threat with \`ctx.thing\` and read their speeds, timers and counts from \`ctx.tune\`: that is how the person selects them and drags their values live.
4. Run \`game_check\` and fix until it is clean, including each problem its scene report lists (open the frame it names). The person has watched the starter turn into your game; end the turn as soon as the core loop plays. End it with what the person can do now, plus your \`Next:\` line.

More waves and levels, menu art, music and polish are later turns.
`,
};

/** The first turn for this game: its engine's, with the generated route's key-art steps. */
const firstTurnSection = (manifest: GameManifest): string | undefined => {
  const section = FIRST_TURN_SECTIONS[manifest.engine.name];
  if (section === undefined || manifest.characters !== "generated") return section;
  const lines = section.split("\n");
  const first = lines.findIndex((line) => line.startsWith("1. "));
  const last = lines.findIndex((line) => line.startsWith("4. "));
  return [
    ...lines.slice(0, first),
    GENERATED_FIRST_STEP,
    ...lines.slice(first + 1, last),
    GENERATED_LAST_STEP,
    ...lines.slice(last + 1),
  ].join("\n");
};

/**
 * An existing game's AGENTS.md with its engine's "Every turn" section, added
 * once before the keep-going section, so a game made before the turn loop
 * learns that its turns are played and can be undone. Pure; unchanged when present.
 */
export const withEveryTurn = (agents: string, engine: GameEngineId): string => {
  const section = everyTurnSection(engine);
  if (section === undefined || agents.includes(EVERY_TURN_HEADING)) return agents;
  const keepGoing = agents.indexOf(KEEP_GOING_HEADING);
  const at = keepGoing >= 0 ? keepGoing : agents.indexOf(STAGE_ERA_HEADING);
  if (at < 0) return `${agents.trimEnd()}\n\n${section}`;
  return `${agents.slice(0, at)}${section}\n${agents.slice(at)}`;
};

/**
 * The game's keep-going section, in place of the production run's section an
 * earlier Kurambit wrote (its tools no longer exist), or added once. An engine
 * keep going cannot run on only loses the stale section. Pure.
 */
export const withKeepGoing = (agents: string, engine: GameEngineId): string => {
  const section = engineProfile(engine).turnLoop ? KEEP_GOING_SECTION : "";
  const at = agents.indexOf(STAGE_ERA_HEADING);
  if (at >= 0) {
    const after = agents.indexOf("\n## ", at + STAGE_ERA_HEADING.length);
    const rest = after < 0 ? "" : agents.slice(after + 1);
    const kept = agents.includes(KEEP_GOING_HEADING) ? "" : section;
    return `${agents.slice(0, at)}${kept}${kept !== "" && rest !== "" ? "\n" : ""}${rest}`;
  }
  if (section === "" || agents.includes(KEEP_GOING_HEADING)) return agents;
  return `${agents.trimEnd()}\n\n${section}`;
};

/**
 * The game chat's first message: the brief, sent as the person's own, so they
 * see exactly what the agent was told, then one instruction line. That line
 * names AGENTS.md because some providers (Grok, Antigravity) do not load it by
 * themselves.
 */
const FIRST_TURN_LEADS = [
  "Make this game. Read AGENTS.md first.",
  'Make this game. Follow "The first turn" in AGENTS.md.',
] as const;

/** The first turn's instruction line, which names no game, so a build's summary skips it. */
export const isFirstTurnLead = (line: string): boolean =>
  (FIRST_TURN_LEADS as ReadonlyArray<string>).includes(line);

export const firstTurnMessage = (manifest: GameManifest): string => {
  const lead = FIRST_TURN_LEADS[FIRST_TURN_SECTIONS[manifest.engine.name] === undefined ? 0 : 1];
  const art = manifest.artDirection.trim();
  return `${manifest.brief.trim()}${art === "" ? "" : `\n\nArt direction: ${art}`}\n\n${lead}`;
};

/**
 * Files the studio owns for every game. The starter template's project tree
 * supplies the engine sources; see templates.ts.
 */
export function scaffoldFiles(input: GameCreateInput): Record<string, string> {
  const manifest = scaffoldManifest(input);
  const engine = createEngine(input);
  return {
    "game.json": JSON.stringify(manifest, null, 2) + "\n",
    "BRIEF.md": `# ${manifest.name}\n\n${manifest.brief}\n\n## Art direction\n\n${manifest.artDirection}\n`,
    "AGENTS.md": [
      `# Kurambit project\n\n${engineProfile(engine).scaffold.agents}`,
      everyTurnSection(engine),
      firstTurnSection(manifest),
      engineProfile(engine).turnLoop ? KEEP_GOING_SECTION : undefined,
    ]
      .filter((section) => section !== undefined)
      .join("\n"),
    "CLAUDE.md": "@AGENTS.md\n",
    ".gitignore": `${[...GENERATED_IGNORES, ...RUN_STATE_IGNORES].join("\n")}\n`,
  };
}
