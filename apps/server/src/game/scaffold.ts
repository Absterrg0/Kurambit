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
import { fill, STUDIO_TEXT } from "./studioText.ts";

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

const TURN = STUDIO_TEXT.turnRules;
const FIRST = STUDIO_TEXT.firstTurn;

/**
 * How a chat turn ends where Kurambit plays and measures every turn's build
 * (engineProfile turnLoop), by how the Stage shows the game: `live` serves the folder and reloads
 * it on every save (GamePreview.live), `export` plays a Web export the turn loop rebuilds when
 * the turn ends. The other engines' agents keep checking their own work.
 */
const everyTurnSection = (engine: GameEngineId): string | undefined => {
  const profile = engineProfile(engine);
  if (!profile.turnLoop) return undefined;
  const section = (TURN.everyTurn as Partial<Record<GameStageKind, string>>)[profile.stage];
  return section === undefined
    ? undefined
    : fill(section, { scope: TURN.scope, playtest: TURN.playtest, undo: TURN.undo });
};

/**
 * The person's model route and library choice, said once: how the game's models are made. With no
 * route locked the agent picks per model, Blender recommended; a locked route is said as theirs.
 */
const routeLine = (route: GameCharacterRoute, library: boolean): string => {
  if (route === "any" && !library) return FIRST.anyRoute;
  return fill(library ? FIRST.library : FIRST.chosen, { made: FIRST.made[route] });
};

/** The first turn for this game's engine and model choice; an engine without one gets the brief alone. */
const firstTurnSection = (manifest: GameManifest): string | undefined => {
  if (manifest.engine.name !== "three") return undefined;
  const { route, library } = gameModelChoice(manifest);
  // The Stage follows the first turn's saves from the first frame the game draws (GameStage
  // `makingFirstBuild`), so `watched` asks for a running scene first.
  return [FIRST.heading, FIRST.goal, FIRST.read, FIRST.watched, routeLine(route, library)].join(
    "\n\n",
  );
};

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
    ...(options.reference === true ? [FIRST.reference] : []),
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
  if (everyTurn === undefined) return undefined;
  return `${everyTurn}\n${TURN.keepGoing}`;
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
