import {
  DEFAULT_GAME_ENGINE,
  GAME_STYLE_DEFAULT_CHARACTERS,
  GAME_STYLE_DEFAULT_LIBRARY,
  GAME_TEMPLATES,
  gameModelChoice,
  gameTemplateForEngine,
  type GameCreateInput,
  type GameEngineId,
  type GameManifest,
  type GameStageKind,
} from "@kurambit/contracts";
import { FIRST_TURN_LEADS } from "@kurambit/shared/gameFirstTurn";

import { engineProfile } from "./engineProfile.ts";

// Harness output, never game content: the bot runs' log and report, kept play
// saves and the person's saved media stay out of every build and checkpoint.
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
    // The same folder under its legacy key, for one release, so an older installed Kurambit still opens the game.
    godotProject: engineProfile(engine).projectDirectory,
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
 * Keep going, for the agent of a game whose turns Kurambit plays (engineProfile
 * turnLoop): what a step message is and what the run does with its build.
 */
const KEEP_GOING_SECTION = `## Keep going

- The person can turn on **Keep going**. Kurambit then sends this chat its next step as a message that starts "Keep going · step N". Each step runs in a session of its own, so the message carries what you need: the brief, the chat's last reply, the facts and the steps before it. Do that one step, like any turn: the last \`game_check\` with \`final: true\` clean, then end with your \`Next:\` line, or \`Next: none\` when nothing worth doing for the brief is left.
- Kurambit measures the step's build, and undoes the step itself only when it breaks the game (it stops booting, errors or freezes in play, or can no longer be won or lost); the person can redo it. Do not put an undone change back unless they ask.
- A step that asks you to fix a measured fact may be wrong for this game: then change nothing and say why in one line. Kurambit sets that step aside.
- The person's own messages always come first. Turn keep going on or off (\`game_keep_going\`) only when they ask.
`;
const PLAYTEST_LINE =
  "- Explore (`game_explore_*`) when the check's play cannot reach your change (late content, an ending, a feel only steady input shows) or the person asks; the harness measures every build. Read `game_facts` when the person reports a problem.";
/** What a turn is: the person's whole request, done and looked at. */
const SCOPE_LINES = `- **Do everything the person asked in this message,** and only that: your own ideas go in \`Next:\`. The turn ends when that work is done and you have looked at it, not when the check is clean. When the game has a reference picture, keep going until your critique of the game's frame beside it finds nothing major.
- **A value they ask to change** that a \`ctx.tune\` already holds: set it with \`game_tune\`, say so, and that is the turn.
- **A question:** answer it and change nothing; your previous \`Next:\` line stands, so repeat it.
- **Look as often as you need; check in full once the work is done.** \`game_check\` is a quick look: a frame of play, its errors and frame rate. Before you end the turn, run \`game_check\` with \`final: true\`, which also plays the scene report and the QA play, and fix what they list. A clean check says the game runs, not that the work is done.
- Install nothing the person did not ask for; the game_* tools are your toolchain.`;
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
 * On the generated route the first turn also starts the key art, builds on stand-ins while it
 * renders, and ends on the person's pick: the look is theirs, and art never blocks the playable.
 */
const GENERATED_GOAL =
  "Goal: the person plays the brief's core loop on the Stage while its art is generated from the look they pick: the loop plays first on stand-ins, so the Stage shows the game within minutes, never primitives.";
const GENERATED_FIRST_STEP = `1. Start the key art first: \`game_generate\` with lane \`image\`, name \`key_art\`, \`options.aspect\` \`"16:9"\`, a prompt holding the game's world and moment in one image, and three \`directions\`: looks that truly differ (rendering, palette, shape language), each one this game can reach in its engine, drawn as an in-game screenshot, each grounded with a \`style\`: a library pack id that ships a picture of its look (a Kenney low-poly kit, Quaternius Monsters; KayKit ships none), or the person's own reference image, so the key art never promises a look the game cannot reach (\`studio-skills/art-pipeline.md\`, Generated art). It renders while you build; never wait on it. If it is refused (no key, or over the person's daily limit), say so in your reply and go on with the stand-ins. Then read \`BRIEF.md\` and the recipe for your view in \`studio-skills/three.md\`. Write no plan or design document, and do not open Blender. The comment block at the top of each kit is enough; do not read the shell's code.`;
const GENERATED_LAST_STEP = `4. Look with \`game_check\` and fix what a player would call wrong at a glance in its frame (the player small, seen only from behind or hard to make out, a view washed out or too dark), then \`game_check\` with \`final: true\` clean, including each problem its scene report lists (open the frame it names), then \`game_generate_wait\` for the key art and end the turn: say what the person can do now, ask them to pick one of the key art's candidates in the chat, or say it is still rendering (the models are stand-ins until art made from it arrives), say what it cost, and add your \`Next:\` line.`;

const READ_STEP = (also: string) =>
  `1. Read \`BRIEF.md\` and the recipe for your view in \`studio-skills/three.md\`${also}. Write no plan or design document and make no key art. The comment block at the top of each kit is enough; do not read the shell's code.`;
const LOOP_STEP = `3. Replace the starter's gameplay in \`web/main.js\` (its sphere and beacon are placeholders) with the game the brief asks for: the player moves (the recipe), does what the brief has them do, and wins and loses through \`GameState.win\` and \`lose\` when the brief has an end, with the HUD through \`ctx.ui\`. Build only what the brief asks; your ideas go in \`Next:\`.`;
const CHECK_STEP = `5. Look at the game with \`game_check\` as often as you need, and fix what a player would call wrong at a glance: the player small, seen only from behind or hard to make out, a view washed out by haze or too dark to read. When the game has a reference picture, match it like for like: frame the play camera as the picture is framed (\`followCamera3D\` \`frame\` and \`lens\`), then write a numbered critique of the game's frame beside the picture, biggest difference first (composition, silhouette, proportions, colour and light, surface), fix the first, and look again, until the critique finds nothing major: each check's \`review\` says how. Once it does, run \`game_check\` with \`final: true\` and fix until it is clean, including each problem its scene report lists (open the frame it names). End the turn with what the person can do now, plus your \`Next:\` line.`;
/** Models in code: what the kit offers and how the agent sees one, said once for every route that builds them. */
const CODE_MODELS = `with \`shell/model.js\`: one \`palette\` for the game; silhouette first, from curves (the side profile, then the plan, then the sections: \`curve\`, \`loft\`, \`mirrored\`, \`wall\`), then the details a person names each by, each model in its own module under \`web/models/\`, \`merge\`d. A humanoid is built on the clips' skeleton (\`rig\`): \`game_assets_add\` pack \`quaternius-universal-animation-library\`, path \`Unreal-Godot/UAL1_Standard.glb\`, named in \`ASSETS\`. Look at each with \`game_model_sheet\` and fix what reads wrong`;

/** The library first, then what it lacks made the route's way: the old default, and any game with the library on. */
const libraryTurn = (lacking: string) => `## The first turn

Goal: the person plays the brief's core loop on the Stage, and its player and main threat are what the brief names: library models where the library has them, ${lacking} where it does not, never primitives. The loop plays on library models first, so the Stage shows the game within minutes while anything missing is made.

${READ_STEP("")}
2. Choose the look: \`game_assets_search\` with no words lists the library by style family. Pick one that fits the brief. Add the player character and one or two threats or props with \`game_assets_add\`, the first call with \`lock\` (that family and the view), which writes \`STYLE.json\`, and name them in \`ASSETS\`: the shell loads them, and compiles what draws them, behind its loading screen. Keep the default look (\`LOOK\` as it is, or the one preset the brief calls for, adjusted when the view does not read; no lights besides \`ctx.look.sun\`): the first build then starts at once and reads clearly; extra lights and glows cost every frame. Glows are a later turn. When no pack has the brief's player or main threat (a cat, a pigeon, a hover tank), add the closest model to stand in while the loop is built.
${LOOP_STEP}
4. Make what the library lacks: the brief's player or main threat that no pack has, ${lacking === "made in Blender" ? "in Blender (each Blender tool names its recipe)" : "in three.js code with `shell/model.js` (its comment block shows every call; look at it alone with `game_model_sheet`)"}, then swap it in for the model standing in. Only those two; every other missing prop waits for a later turn.
${CHECK_STEP}
`;

/** The code route with the library off: every model in code, looked at alone before the game is built round it. */
const CODE_TURN = `## The first turn

Goal: the person plays the brief's core loop on the Stage, and its player, main threat and world are models you build in three.js code, never bare primitives standing in for them.

${READ_STEP(", and the comment block of `studio-skills/runtime/shell/model.js`")}
2. Build the player and the main threat ${CODE_MODELS} before step 3.
${LOOP_STEP}
4. Build the world the brief names the same way: the ground and the one or two set pieces it names, repeats with \`scatter\`, open water with \`shell/water.js\`. Choose the look the brief calls for in \`LOOK\` (its comment block in \`shell/look.js\`: a preset, a physical sky with clouds outdoors, or a flat stylised one), no lights besides \`ctx.look.sun\`.
${CHECK_STEP}
`;

/** Blender with the library off: quick code stand-ins carry the loop while the real models are made. */
const STAND_IN_TURN = `## The first turn

Goal: the person plays the brief's core loop on the Stage, and its player and main threat are made in Blender, never primitives. The loop plays first on quick stand-ins built in code, so the Stage shows the game within minutes while they are made.

${READ_STEP("")}
2. Stand-ins: the player and the main threat as quick models in code with \`shell/model.js\` (a \`palette\`, rounded \`box\`es, the right size and colours), named in the game as the real ones will be. Keep the default look (\`LOOK\` as it is, no lights besides \`ctx.look.sun\`).
${LOOP_STEP}
4. Make the player and the main threat in Blender (its tools each name their recipe), then swap them in for the stand-ins. Only those two; every other prop waits for a later turn.
${CHECK_STEP}
`;

/** The first turn for this game's engine and model choice; an engine without one gets the brief alone. */
const firstTurnSection = (manifest: GameManifest): string | undefined => {
  if (manifest.engine.name !== "three") return undefined;
  const { route, library } = gameModelChoice(manifest);
  if (route === "code") return library ? libraryTurn("built in code") : CODE_TURN;
  if (route === "blender") return library ? libraryTurn("made in Blender") : STAND_IN_TURN;
  // Generated characters come from the person's providers, never Blender: no making step.
  const lines = (library ? libraryTurn("made in Blender") : STAND_IN_TURN)
    .split("\n")
    .filter((line) => !line.startsWith("4. "))
    .map((line) => (line.startsWith("Goal: ") ? GENERATED_GOAL : line));
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
export const gameTurnRules = (engine: GameEngineId): string | undefined => {
  const everyTurn = everyTurnSection(engine);
  return everyTurn === undefined ? undefined : `${everyTurn}\n${KEEP_GOING_SECTION}`;
};

/** Games made before the turn rules moved out of AGENTS.md carry them as these sections. */
const MOVED_SECTIONS = ["## Every turn\n", "## Keep going\n"];

/**
 * A game's AGENTS.md without the turn rules it was made with, every other byte as it was; null
 * when it has none. A section runs to the next `## ` heading, which keeps the blank line before
 * it; the last section takes the blank line before itself instead.
 */
export const withoutMovedSections = (agents: string): string | null => {
  let updated = agents;
  for (const heading of MOVED_SECTIONS) {
    const at = updated.indexOf(`\n${heading}`);
    if (at === -1) continue;
    const next = updated.indexOf("\n## ", at + 1);
    updated =
      next === -1
        ? updated.slice(0, at + 1).replace(/\n\n$/, "\n")
        : `${updated.slice(0, at + 1)}${updated.slice(next + 1)}`;
  }
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
    "AGENTS.md": `# Kurambit project\n\n${engineProfile(engine).scaffold.agents}`,
    "CLAUDE.md": "@AGENTS.md\n",
    ".gitignore": `${[...generatedIgnores(engine), ...RUN_STATE_IGNORES].join("\n")}\n`,
  };
}
