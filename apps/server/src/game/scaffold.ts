import {
  DEFAULT_GAME_ENGINE,
  GAME_STYLE_DEFAULT_CHARACTERS,
  GAME_STYLE_DEFAULT_LIBRARY,
  GAME_TEMPLATES,
  gameModelChoice,
  type GameCharacterRoute,
  gameTemplateForEngine,
  type GameCreateInput,
  type GameEngineId,
  type GameManifest,
  type GameStageKind,
} from "@kurambit/contracts";
import { FIRST_TURN_LEADS } from "@kurambit/shared/gameFirstTurn";

import { engineProfile } from "./engineProfile.ts";

// Harness output, never game content: the bot runs' log (and the player report earlier
// versions wrote), kept play saves and the person's saved media stay out of every build and
// checkpoint.
export const RUN_STATE_IGNORES = [
  ".studio/bot-results.jsonl",
  ".studio/player-report.md",
  ".studio/saves/",
  // The creator's saved videos and images (gameSavedMedia.ts).
  "saved/",
] as const;

/** What the game's engine and Kurambit generate in its folder. */
const generatedIgnores = (engine: GameEngineId) => [
  "builds/",
  ...engineProfile(engine).scaffold.ignores,
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
    assets: [],
    // The code route is written as no route at all, which reads as code here and which an older
    // installed Kurambit (it knows library, blender and generated) still opens. The library key is
    // always written: without it a game reads as one made before the library was opt-in.
    ...((input.characters ?? GAME_STYLE_DEFAULT_CHARACTERS) === "code"
      ? {}
      : { characters: input.characters }),
    library: input.library ?? GAME_STYLE_DEFAULT_LIBRARY,
  };
}

/**
 * Keep going, for the agent of a game whose turns Kurambit plays (engineProfile turnLoop). The
 * step message (decide.ts STEP_TAIL) says how a step ends, `game_keep_going`'s description that
 * only the person turns it on or off, and the undo line that an undone change stays undone.
 */
const KEEP_GOING_SECTION = `## Keep going

- A message that starts "Keep going · step N" comes from **Keep going**, which the person turned on. It runs in a fresh session and carries what you need: do that one step like any turn. A step that asks you to fix a measured fact may be wrong for this game: then change nothing and say why in one line.
`;
const PLAYTEST_LINE =
  "- Play it yourself (`game_play` ops `start`, `act`, `close`) when the check's play cannot reach your change (late content, an ending, a feel only steady input shows) or the person asks; the harness measures every build. Read `game_check` op `facts` when the person reports a problem.";
/** What a turn is: the person's whole request, done and looked at. */
const SCOPE_LINES = `- **Do everything the person asked in this message,** and only that: your own ideas go in \`Next:\`. The turn ends when that work is done and you have looked at it, not when the check is clean. When the game has a reference picture, keep going until your critique of the game's frame beside it finds nothing major.
- **A value they ask to change** that a \`ctx.tune\` already holds: set it in \`web/tune.json\` under the id its \`ctx.tune\` uses, say so, and that is the turn.
- **How models are made** (game.json's \`characters\`: code, blender or generated, and \`library\`) is the person's choice: change it only when they ask in chat.
- **A question:** answer it and change nothing; your previous \`Next:\` line stands, so repeat it.
- **Look as often as you need; check in full once the work is done.** \`game_check\` is a quick look: your game as a player opens it, a frame of play, its errors and frame rate. Before you end the turn, run its op \`final\`, which also plays the scene report and the QA play, and fix what they list. A clean check says the game runs, not that the work is done.
- Install nothing the person did not ask for; the game_* tools are your toolchain.`;
/** Said until a saved play wins the game: "can it be won" is then replayed on every build. */
const FIRST_WIN_LINE =
  "- **No saved play wins this game yet.** Once it can be won, win it with a `game_play` bot or session and save that run (op `replay` `save`), so every later build replays it.";
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

${SCOPE_LINES}
- **Keep the game booting between saves.** The person watches your work live: Kurambit serves the game folder on their Stage and reloads it on every save. Write a new module before the line that imports it, and keep \`main.js\` loadable at each save.
${PLAYTEST_LINE}
${UNDO_LINE}
- **Write your last message for the person making the game:** what changed in the game and what they can do now. Name no tools or files.
- **End every reply with one line,** \`Next: <the one change that would most improve this game>\`, or \`Next: none\` when the brief is done. The person can take your \`Next:\` into their message with one key, so make it a request they could have typed: one change, in their words, not a plan.
`,
  // The Stage plays a Web export the turn loop rebuilds when the turn ends.
  export: `## Every turn

${SCOPE_LINES}
- When your turn ends, Kurambit plays the build on the person's Stage and measures its facts. Do not export to show it; the build is made for you.
${PLAYTEST_LINE}
${UNDO_LINE}
- Write your last message for the person making the game: what changed in the game and what they can do now. Name no tools or files.
- End every reply with one line: \`Next: <the one change that would most improve this game>\`, or \`Next: none\` when the brief is done.
`,
};
const everyTurnSection = (engine: GameEngineId): string | undefined => {
  const profile = engineProfile(engine);
  return profile.turnLoop ? EVERY_TURN_SECTIONS[profile.stage] : undefined;
};

/**
 * The first turn hands the agent the brief, the bridge contract and the person's own choices
 * (how models are made), and nothing about how to make the game: no starter, no recipe, no kit.
 * How a turn ends and what the loop's tools say travel with the turn rules and the tools.
 */
const FIRST_TURN_GOAL =
  "Goal: the person plays the game the brief describes on the Stage, made as well as you can make it: every part a player sees is yours to design.";
const READ_LINE =
  "Read `BRIEF.md` and the bridge contract in `TEMPLATE.md` (what the harness needs from the game, nothing about how it looks), then build the game in `web/`. Write no plan or design document.";
/**
 * The Stage follows the first turn's saves from the first frame the game draws (GameStage
 * `makingFirstBuild`). Left alone, an agent writes every module and wires main.js last, and the
 * person looks at a card for the whole turn.
 */
const WATCHED_LINE =
  "The person watches the Stage while you work: it shows the game from the first frame it draws and follows every save. Get a scene they can see running first, then grow the game in place.";
/** The person's model route and library choice, said once: how the game's models are made. */
const routeLine = (route: GameCharacterRoute, library: boolean): string => {
  if (route === "blender" && !library) return BLENDER_ROUTE_LINE;
  const made =
    route === "blender"
      ? "made in Blender (each Blender tool names its recipe), with quick models in code standing in while they are made"
      : route === "generated"
        ? "generated from the key art below by the person's providers, with quick models in code standing in until they arrive"
        : "built in three.js code, never bare primitives standing in for them";
  return library
    ? `The person turned the asset library on: use its models where it has what the brief names (\`game_assets\` op \`search\`; the first \`add\` takes \`lock\`), and the rest are ${made}.`
    : `The person chose how the game's models are made: its player, main threat and world are ${made}.`;
};
/**
 * The default route, by kind of model: the AQ bake-off's sculpted and tailored Blender characters
 * beat code's, and round 6B's side-by-side gave trees, rocks and buildings to Blender's kit and
 * left ground, furniture and clutter to code, which builds them as well and with no round trip.
 */
const BLENDER_ROUTE_LINE =
  "The person chose how the game's models are made, by kind: the player, its characters and its creatures are made in Blender (each Blender tool names its recipe), with quick models in code standing in while they are made; so are trees, rocks and buildings and the prop the game is about; the rest is built in three.js code. If `game_check` op `status` shows no Blender, build the characters in code too and tell the person that Settings → Game tools takes a Blender.";

/** On the generated route the first turn also starts the key art, so art never blocks the playable. */
const GENERATED_LINE = `Start the key art first: \`game_assets\` op \`generate\` with lane \`image\`, name \`key_art\`, \`options.aspect\` \`"16:9"\`, a prompt holding the game's world and moment in one image, and three \`directions\`: looks that truly differ, each one this game can reach, each grounded with a \`style\` (a library pack id that ships a picture of its look, or the person's own reference image; \`studio-skills/art-pipeline.md\`, Generated art). It renders while you build; never wait on it, and if it is refused, say so and go on. Before you end the turn, op \`wait\` for it: ask the person to pick one of its candidates in the chat, or say it is still rendering, and say what it cost.`;

/** The first turn for this game's engine and model choice; an engine without one gets the brief alone. */
const firstTurnSection = (manifest: GameManifest): string | undefined => {
  if (manifest.engine.name !== "three") return undefined;
  const { route, library } = gameModelChoice(manifest);
  return [
    "## The first turn",
    FIRST_TURN_GOAL,
    ...(route === "generated" ? [GENERATED_LINE] : []),
    READ_LINE,
    WATCHED_LINE,
    routeLine(route, library),
  ].join("\n\n");
};

/** Said when the person attached a picture to the new game (GameCreateInput `reference`). */
const REFERENCE_LINE =
  "The person attached a picture to aim for, attached here and saved as `art/reference.png`. When it holds more than the one view you will match (a phone screenshot, a page around it), save that view alone over it. The model sheet and the check show it beside yours, and the turn ends when the game's frame matches it.";

/**
 * A new game's first message: the brief, then the first turn's steps. They travel with the brief,
 * not in the game's AGENTS.md, so they reach the one turn they are for and a change to them needs
 * no migration of games already made.
 */
export const firstTurnMessage = (
  manifest: GameManifest,
  options: { readonly reference?: boolean } = {},
): string => {
  const steps = firstTurnSection(manifest);
  const art = manifest.artDirection.trim();
  return [
    manifest.brief.trim(),
    ...(art === "" ? [] : [`Art direction: ${art}`]),
    steps === undefined ? FIRST_TURN_LEADS.brief : FIRST_TURN_LEADS.steps,
    ...(options.reference === true ? [REFERENCE_LINE] : []),
    ...(steps === undefined ? [] : [steps.trim()]),
  ].join("\n\n");
};

/**
 * The harness's rules for every turn of a game whose turns Kurambit plays: how a turn ends and
 * what keep going does. Run execution sends them with each turn (ProviderAdapterV2TurnInput
 * `harnessInstructions`) rather than writing them into the game, so a change to them reaches
 * every game at once.
 */
export const gameTurnRules = (
  engine: GameEngineId,
  game: { readonly winSaved: boolean } = { winSaved: false },
): string | undefined => {
  const everyTurn = everyTurnSection(engine);
  if (everyTurn === undefined) return undefined;
  return `${everyTurn}${game.winSaved ? "" : `${FIRST_WIN_LINE}\n`}\n${KEEP_GOING_SECTION}`;
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
    "AGENTS.md": `# Kurambit project\n\n${engineProfile(engine).scaffold.agents}`,
    "CLAUDE.md": "@AGENTS.md\n",
    ".gitignore": `${[...generatedIgnores(engine), ...RUN_STATE_IGNORES].join("\n")}\n`,
  };
}
