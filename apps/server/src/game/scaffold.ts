import {
  DEFAULT_GAME_ENGINE,
  GAME_TEMPLATES,
  gameTemplateForEngine,
  type GameCreateInput,
  type GameEngineId,
  type GameManifest,
  type GameStageKind,
} from "@kurambit/contracts";
import { FIRST_TURN_LEADS } from "@kurambit/shared/gameFirstTurn";

import { engineProfile, PROFILES } from "./engineProfile.ts";

// Harness output, never game content: the bot runs' log and report, kept play
// saves and the person's saved media stay out of every build and checkpoint.
export const RUN_STATE_IGNORES = [
  ".studio/bot-results.jsonl",
  ".studio/player-report.md",
  ".studio/saves/",
  // The creator's saved videos and images (gameSavedMedia.ts).
  "saved/",
] as const;

/** What every engine generates in the game folder. */
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
function scaffoldManifest(input: GameCreateInput): GameManifest {
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
const KEEP_GOING_SECTION = `## Keep going

- The person can turn on **Keep going**. Kurambit then sends this chat its next step as a message that starts "Keep going · step N". Do that one step, like any turn: one change, \`game_check\` clean, end with your \`Next:\` line.
- Kurambit measures the step's build, and undoes the step itself when it makes a fact worse; the person can redo it. Do not put an undone change back unless they ask.
- A step that asks you to fix a measured fact may be wrong for this game: then change nothing and say why in one line. Kurambit sets that step aside.
- The person's own messages always come first. Turn keep going on or off (\`game_keep_going\`) only when they ask.
`;
const PLAYTEST_LINE =
  "- Do not play-test with `game_explore_*` or bots to see whether the game works: the harness measures every build. Explore only when the person asks or a fact says something you cannot see in the code. Read `game_facts` when the person reports a problem.";
// The person numbers builds by what they can see; a small fix stays inside the build it fixes.
const CHANGE_LINE =
  "- **Say whether the turn is a new build or a fix.** Pass `change` to your last `game_check`: `new` when the person would call it a new version of the game, `fix` for a small correction to the build they already have (a bug, a typo, a value nudged), which Kurambit keeps as that same build. When you cannot tell which they want, ask them in one short question before you end the turn.";
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

- **One visible change per turn.** The person watches your work live: Kurambit serves the game folder on their Stage and reloads it each time you save. A turn is the change the person asked for, one they can see when they play, \`game_check\` clean with nothing left in its scene report, then end the turn. When a request holds several changes, do the first and put the rest in \`Next:\`, but never put off what they asked for because it takes work: a model the library lacks is made in Blender in the turn that asks for it.
- **Keep the game booting between saves.** Every save reloads the person's game. Write a new module before the line that imports it, and keep \`main.js\` loadable at each save. A save that breaks the page shows the person the error.
${PLAYTEST_LINE}
${UNDO_LINE}
${CHANGE_LINE}
- **Write your last message for the person making the game:** what changed in the game and what they can do now. Name no tools or files.
- **End every reply with one line,** \`Next: <the one change that would most improve this game>\`, or \`Next: none\` when the brief is done. The person can take your \`Next:\` into their message with one key, so make it a request they could have typed: one change, in their words, not a plan.
`,
  // The Stage plays a Web export the turn loop rebuilds when the turn ends.
  export: `## Every turn

- A turn that changes the game becomes a build. When your turn ends, Kurambit plays it on the person's Stage and measures its facts: whether it boots, an idle, a random and a skilled bot, frozen frames, input response. Ending the turn is how the person sees your work, so keep turns short: one visible improvement, \`game_check\` clean with nothing left in its scene report, then end. Do not export to show it; the build is made for you.
${PLAYTEST_LINE}
${UNDO_LINE}
${CHANGE_LINE}
- Write your last message for the person making the game: what changed in the game and what they can do now. Name no tools or files.
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

Goal: the person plays the brief's core loop on the Stage, and its player and main threat are what the brief names: library models where the library has them, made in Blender where it does not, never primitives. The loop plays on library models first, so the Stage shows the game within minutes while anything missing is made.

1. Read \`BRIEF.md\`, the "Shortest path" in \`TEMPLATE.md\` and the recipe for your view in \`studio-skills/three.md\`. Write no plan or design document and make no key art. The comment block at the top of each kit is enough; do not read the shell's code.
2. Choose the look: \`game_assets_search\` with no words lists the library by style family. Pick one that fits the brief. Add the player character and one or two threats or props with \`game_assets_add\`, the first call with \`lock\` (that family and the view), which writes \`STYLE.json\`, and name them in \`ASSETS\`: the shell loads them, and compiles what draws them, behind its loading screen. Keep the default look (\`LOOK\` as it is, or the one preset the brief calls for, no lights besides \`ctx.look.sun\`): the first build then starts at once and reads clearly; extra lights and glows cost every frame. Glows are a later turn. When no pack has the brief's player or main threat (a cat, a pigeon, a hover tank), add the closest model to stand in while the loop is built.
3. Replace the starter's gameplay in \`web/main.js\` (its sphere and beacon are placeholders) with the brief's core loop: the player moves (the recipe), the one main verb, the threat, a win and a lose through \`GameState.win\` and \`lose\`, the HUD through \`ctx.ui\`, and \`Juice\` on every action. As the recipes do, name the player and each threat with \`ctx.thing\` and read their speeds, timers and counts from \`ctx.tune\`: that is how the person selects them and drags their values live.
4. Make what the library lacks: the brief's player or main threat that no pack has, in Blender (\`studio-skills/art-pipeline.md\`: Made characters for a person, Made from scratch for an animal, creature or machine), then swap it in for the model standing in. Only those two; every other missing prop waits for a later turn.
5. Run \`game_check\` and fix until it is clean, including each problem its scene report lists (open the frame it names), and look at its pictures as a player would. End the turn with what the person can do now, plus your \`Next:\` line.

More waves and levels, menu art, music and polish are later turns.
`,
};

/** The first turn for this game: its engine's, with the generated route's key-art steps. */
const firstTurnSection = (manifest: GameManifest): string | undefined => {
  const section = FIRST_TURN_SECTIONS[manifest.engine.name];
  if (section === undefined || manifest.characters !== "generated") return section;
  // Generated characters come from the person's providers, never Blender: no making step.
  const lines = section.split("\n").filter((line) => !line.startsWith("4. "));
  const first = lines.findIndex((line) => line.startsWith("1. "));
  const last = lines.findIndex((line) => line.startsWith("5. "));
  return [
    ...lines.slice(0, first),
    GENERATED_FIRST_STEP,
    ...lines.slice(first + 1, last),
    GENERATED_LAST_STEP,
    ...lines.slice(last + 1),
  ].join("\n");
};

export const firstTurnMessage = (manifest: GameManifest): string => {
  const lead = FIRST_TURN_LEADS[FIRST_TURN_SECTIONS[manifest.engine.name] === undefined ? 0 : 1];
  const art = manifest.artDirection.trim();
  return `${manifest.brief.trim()}${art === "" ? "" : `\n\nArt direction: ${art}`}\n\n${lead}`;
};

/**
 * A game's AGENTS.md with its "Every turn" section as Kurambit writes it now: the turn rules are
 * the harness's contract, so a game made before a change to them plays by the new ones. The rest
 * of the file is the game's own; null when there is nothing to change.
 */
export const refreshedTurnRules = (agents: string, engine: GameEngineId): string | null => {
  const rules = everyTurnSection(engine);
  const start = agents.indexOf("## Every turn\n");
  if (rules === undefined || start === -1) return null;
  const next = agents.indexOf("\n## ", start + 1);
  const end = next === -1 ? agents.length : next + 1;
  const updated = `${agents.slice(0, start)}${rules}${agents.slice(end)}`;
  return updated === agents ? null : updated;
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
