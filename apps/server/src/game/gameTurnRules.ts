// @effect-diagnostics nodeBuiltinImport:off -- Run execution reads the game record before any game service exists for it.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { GameManifest, isAvailableEngine, keptRunTag, playOutcomeWords } from "@kurambit/contracts";

import { decisionsForTurn } from "./GameDecisions.ts";
import { keptSince, savedPlays, type KeptPlay } from "./playFiles.ts";
import { gameTurnRules } from "./scaffold.ts";

const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(GameManifest));

/** The person's runs a turn names, and about how many characters they may take. */
const RUNS_MOST = 5;
const RUNS_CHARS = 600;
/** Runs read to count them: every kept one (playFiles.ts keeps ten). */
const RUNS_READ = 10;
/** The game's own values a run's line names, from where it ended. */
const RUN_VALUES = 3;

type KeptRun = KeptPlay & { readonly id: string };

const buildWords = (build: string | null) => (build === null ? "no build" : `build \`${build}\``);
const tenths = (value: number | boolean) =>
  typeof value === "number" ? String(Math.round(value * 10) / 10) : String(value);

/** One run: its id, how it went, and the game's values and the player where it ended. */
const runLine = (run: KeptRun, ownBuild: boolean) => {
  const { outcome, marks } = run.play;
  // Plays from before 1.5.0 carry no end: their last once-a-second mark stands in.
  const last = outcome.where ?? marks.at(-1);
  const details = [
    ...(outcome.text === "" ? [] : [`"${outcome.text.slice(0, 60)}"`]),
    ...Object.entries(last?.values ?? {})
      .slice(0, RUN_VALUES)
      .map(([key, value]) => `\`${key}\` ${tenths(value)}`),
    ...(last?.at == null ? [] : [`at ${last.at.map(tenths).join(", ")}`]),
    ...(ownBuild ? [buildWords(run.build)] : []),
  ];
  return `- \`${keptRunTag(run.id)}\` ${playOutcomeWords(outcome)}${details.length === 0 ? "" : ` (${details.join("; ")})`}`;
};

/**
 * What the person played since the agent's last turn, newest first, in about RUNS_CHARS
 * characters: each run by the id `game_play` op `replay` takes. Null when they played none.
 */
const runsSection = (runs: ReadonlyArray<KeptRun>, sinceTurn: boolean): string | null => {
  const first = runs[0];
  if (first === undefined) return null;
  const oneBuild = runs.every((run) => run.build === first.build);
  const when = sinceTurn ? "Since your last turn the person" : "The person recently";
  const on = oneBuild && first.build !== null ? ` on ${buildWords(first.build)}` : "";
  const header = `${when} played ${runs.length === 1 ? "once" : `${runs.length} times`}${on}, newest first. \`game_play\` op \`replay\` \`{"run": "<id>", "at": <seconds>}\` shows any moment of a run.`;
  const lines: Array<string> = [];
  let used = header.length;
  for (const run of runs) {
    const line = runLine(run, !oneBuild);
    if (lines.length >= RUNS_MOST || (lines.length > 0 && used + line.length > RUNS_CHARS)) break;
    lines.push(line);
    used += line.length + 1;
  }
  const more = runs.length - lines.length;
  return [header, ...lines, ...(more > 0 ? [`- and ${more} more`] : [])].join("\n");
};

const read = <A>(work: () => Promise<A>, fallback: A) =>
  Effect.promise(() => work().catch(() => fallback));

const gameEngine = (cwd: string) =>
  read(() => NodeFSP.readFile(NodePath.join(cwd, "game.json"), "utf8"), null).pipe(
    Effect.map((text) => {
      const manifest = text === null ? Option.none() : decodeManifest(text);
      return Option.isSome(manifest) && isAvailableEngine(manifest.value.engine.name)
        ? manifest.value.engine.name
        : null;
    }),
  );

/**
 * The harness rules for a turn that runs in `cwd`: its game's turn rules when the folder holds a
 * game, by the engine in its game.json; none for any other thread. They ask for a winning test
 * play while none is saved. It reads the folder rather than asking GameProjectService, which
 * launches threads through orchestration and so cannot be a dependency of run execution.
 */
export const turnRulesForWorkspace = (cwd: string | null) =>
  Effect.gen(function* () {
    const engine = cwd === null ? null : yield* gameEngine(cwd);
    if (cwd === null || engine === null || gameTurnRules(engine) === undefined) return undefined;
    const saved = yield* read(() => savedPlays(cwd), { plays: [], set: "" });
    return gameTurnRules(engine, { winSaved: saved.plays.some((each) => each.play.outcome.won) });
  });

/**
 * The person's runs on the game in `cwd` kept after `lastTurnEndedAt` (an ISO time; the thread's
 * previous turn), as a block for the turn's message; null when they played none or it is no game.
 * It goes with the message rather than the turn rules: a provider reads its rules when its
 * session opens (Claude's system prompt, Cursor's first prompt), so a block that changes every
 * turn reaches the agent only beside the message.
 */
export const personRunsForWorkspace = (cwd: string | null, lastTurnEndedAt?: string) =>
  Effect.gen(function* () {
    if (cwd === null || (yield* gameEngine(cwd)) === null) return null;
    const runs = yield* read(() => keptSince(cwd, lastTurnEndedAt, RUNS_READ), []);
    return runsSection(runs, lastTurnEndedAt !== undefined);
  });

/**
 * The person's decisions on the game in `cwd` (`.studio/decisions.md`) as a block for the turn's
 * message: all of them for a session that starts fresh, those since `since` (when the session
 * last started a turn) for one that goes on; null when there are none or it is no game. The
 * person's own message (`words`) first gives a waiting undo its reason.
 */
export const personDecisionsForWorkspace = (
  cwd: string | null,
  input: { readonly since?: string; readonly words?: string },
) =>
  Effect.gen(function* () {
    if (cwd === null || (yield* gameEngine(cwd)) === null) return null;
    return yield* decisionsForTurn(cwd, input).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("The game's decisions could not be read.", { cwd, cause }).pipe(
          Effect.as(null),
        ),
      ),
    );
  });
