// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Reads the bot file and writes the run's trace and kept play on the native filesystem.
// A stepped bot: a `.studio/bot/` file that exports `decide(obs) → actions` plays inside the game's
// page (shell studio.bot). The shell calls it each fixed step on the run's own clock, as fast as
// the page allows, and records the run as it records a person's, so the run is a play: kept under
// the bot run's own id, replayable to any moment and savable as a test play. Its ending is the
// game's own (GameState.win/lose), never the bot's word.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  GamePlay,
  keptRunTag,
  playOutcomeWords,
  type GameBotFinding,
  type GameBotRunResult,
} from "@kurambit/contracts";
import { boundEvidence, END_FRAME } from "./gameBotRuntime.ts";
import type { PlayLaunch } from "./playLaunch.ts";
import { botPlayTag, keepPlay } from "./playFiles.ts";

/** What the launch hands the run: the session it plays in. */
export type BotLaunch = Pick<PlayLaunch, "play">;

/** Whether a bot file is a stepped one: it exports `decide`. */
export const isSteppedBot = (source: string) =>
  /\bexport\s+(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+|var\s+)decide\b|\bexport\s*\{[^}]*\bdecide\b/.test(
    source,
  );

/** What a stepped run's page answers (shell studio.bot). */
const BotAnswer = Schema.Struct({
  outcome: Schema.NullOr(
    Schema.Struct({ won: Schema.Boolean, text: Schema.String, seconds: Schema.Number }),
  ),
  seconds: Schema.Number,
  steps: Schema.Number,
  decisions: Schema.Number,
  wallMs: Schema.Number,
  error: Schema.NullOr(Schema.String),
  unknown: Schema.Array(Schema.String),
  /** decide returned false: the script's own stop; absent from runtimes before 1.38. */
  stopped: Schema.optionalKey(Schema.Boolean),
  where: Schema.Struct({
    at: Schema.NullOr(Schema.Tuple([Schema.Number, Schema.Number, Schema.Number])),
  }),
  values: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
  ),
  /** The bot file's own report() of its run; absent from runtimes before 1.35. */
  report: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
  play: Schema.NullOr(Schema.Unknown),
});
const decodeAnswer = Schema.decodeUnknownOption(BotAnswer);
const decodePlay = Schema.decodeUnknownOption(GamePlay);

export interface SteppedBotArgs {
  readonly root: string;
  readonly runId: string;
  readonly runDir: string;
  readonly tracePath: string;
  readonly botFile: string;
  readonly source: string;
  /** Seconds of game time the run may play before it ends unended. */
  readonly seconds: number;
  /** Step at a person's pace, so the page's frame times are a person's (shell studio.bot). */
  readonly realTime?: boolean;
  /** Keep the run's last screen beside its trace (the default); a caller that takes its own says false. */
  readonly endFrame?: boolean;
}

/** A run with what its caller may show beyond the result: its play, kept id and how it stopped. */
export interface SteppedRun {
  readonly result: GameBotRunResult;
  readonly play: GamePlay | null;
  /** The kept play's id, which `game_play` op replay takes; null when none was kept. */
  readonly kept: string | null;
  /** decide returned false. */
  readonly stopped: boolean;
  /** The game's own ending, when the run reached one. */
  readonly outcome: { readonly won: boolean } | null;
  readonly wallMs: number;
}

/** The goal a bot file states (`export const goal = "…"`), else a plain one. */
const goalOf = (source: string) =>
  /\bexport\s+const\s+goal\s*=\s*(["'`])([^"'`\n]{1,200})\1/.exec(source)?.[2] ?? "play the game";

/** Real time a stepped run may take: its game seconds, plus room for a page slower than real time. */
const wallMsFor = (seconds: number) => seconds * 1_000 + 30_000;

export const playSteppedBot = async (
  launch: BotLaunch,
  args: SteppedBotArgs,
): Promise<GameBotRunResult> => (await runSteppedBot(launch, args)).result;

export const runSteppedBot = async (
  launch: BotLaunch,
  args: SteppedBotArgs,
): Promise<SteppedRun> => {
  const { play } = launch;
  const file = NodePath.relative(args.root, args.botFile);
  const goal = goalOf(args.source);
  const base = {
    runId: args.runId,
    goal,
    ticks: 0,
    tickHz: 0,
    timeRatio: 0,
    gameSeconds: 0,
    decisions: 0,
    usedSetState: false,
    findings: [] as ReadonlyArray<GameBotFinding>,
    finalState: {},
    finalPos: null,
    runIds: [args.runId],
    tracePath: args.tracePath,
    videoPath: "",
    frames: [] as ReadonlyArray<string>,
  };
  const unplayed = (note: string): SteppedRun => ({
    result: {
      ...base,
      played: false,
      status: { state: "bot-error", note },
      message: `Bot "${file}" did not play: ${note}`,
    },
    play: null,
    kept: null,
    stopped: false,
    outcome: null,
    wallMs: 0,
  });
  if (play.stepBot === undefined) return unplayed("this game's runner plays no stepped bots.");
  const raw = await play.stepBot(args.source, {
    seconds: args.seconds,
    wallMs: wallMsFor(args.seconds),
    ...(args.realTime === true ? { realTime: true } : {}),
  });
  if (raw === "no-bot") return unplayed("this game's runtime predates stepped bots (decide).");
  const loadError =
    typeof raw === "object" && raw !== null && !("outcome" in raw) && "error" in raw
      ? String((raw as { error: unknown }).error)
      : null;
  if (loadError !== null) return unplayed(loadError.slice(0, 300));
  const answer = decodeAnswer(raw);
  if (Option.isNone(answer)) {
    // The page never answered within the run's wall bound: measured about the game.
    const note = `the game's page did not answer within ${wallMsFor(args.seconds) / 1000} s`;
    const result: GameBotRunResult = {
      ...base,
      status: { state: "unresponsive", note },
      message: `Bot "${file}": unresponsive — ${note}.`,
    };
    await NodeFSP.writeFile(args.tracePath, JSON.stringify({ ...result, file }, null, 2));
    return {
      result,
      play: null,
      kept: null,
      stopped: false,
      outcome: null,
      wallMs: wallMsFor(args.seconds),
    };
  }
  const ran = answer.value;
  // The run is a play: kept under the bot run's own id, whatever it ended with.
  const decoded = ran.play === null ? Option.none() : decodePlay(ran.play);
  const kept = Option.isNone(decoded)
    ? null
    : await keepPlay(
        args.root,
        { at: new Date().toISOString(), build: null, play: decoded.value },
        botPlayTag(args.runId),
      ).catch(() => null);
  await NodeFSP.mkdir(NodePath.join(args.runDir, "frames"), { recursive: true }).catch(
    () => undefined,
  );
  const endFrame = NodePath.join(args.runDir, "frames", END_FRAME);
  const framed = args.endFrame !== false && (await play.still(endFrame).catch(() => false));
  const findings: Array<GameBotFinding> = [];
  const finding = (detector: string, severity: string, summary: string, detail = "") =>
    findings.push({ detector, severity, summary, t: ran.seconds, pos: ran.where.at, detail });
  if (ran.error !== null) finding("bot_error", "error", ran.error.slice(0, 300));
  if (ran.unknown.length > 0)
    finding(
      "unknown_action",
      "warning",
      `decide named actions the game does not have: ${ran.unknown.join(", ")}`,
    );
  const report = boundEvidence(ran.report).value;
  const wallSeconds = ran.wallMs / 1000;
  const timeRatio = wallSeconds > 0 ? ran.seconds / wallSeconds : 0;
  // The game's own ending is the run's; past its game seconds it ended unended, and past its
  // wall bound (a page slower than real time) it ran out of time.
  const state =
    ran.outcome !== null || ran.seconds >= args.seconds || ran.stopped === true
      ? "done"
      : ran.error
        ? "bot-error"
        : "budget";
  const note =
    ran.outcome !== null
      ? `the game ended: ${ran.outcome.won ? "won" : "lost"} at ${ran.outcome.seconds} s${ran.outcome.text === "" ? "" : ` (${ran.outcome.text})`}`
      : ran.stopped === true
        ? `decide stopped the run at ${ran.seconds} s`
        : state === "done"
          ? `the game did not end in ${args.seconds} s of play`
          : `${ran.seconds} s of play in ${wallSeconds.toFixed(0)} s of wall time; the run's wall bound ended it`;
  const tag = kept === null ? null : keptRunTag(kept);
  const result: GameBotRunResult = {
    ...base,
    status: {
      state,
      note,
      // Build facts read the ending's time from here, as from the kit's tier bots.
      evidence: {
        playingAt: 0,
        endedAt: ran.outcome?.seconds ?? null,
        stepped: true,
        ...(report === undefined ? {} : { report }),
      },
    },
    ticks: ran.steps,
    tickHz: wallSeconds > 0 ? Number((ran.steps / wallSeconds).toFixed(2)) : 0,
    timeRatio: Number(timeRatio.toFixed(3)),
    gameSeconds: ran.seconds,
    decisions: ran.decisions,
    findings,
    finalState: ran.values,
    finalPos: ran.where.at,
    frames: framed ? [endFrame] : [],
    message:
      `Bot "${file}": ${note}; ${ran.seconds} s of game in ${wallSeconds.toFixed(1)} s ` +
      `(${timeRatio.toFixed(1)}× real time), ${ran.decisions} decisions.` +
      (tag === null
        ? ""
        : ` Its play is ${tag} (${playOutcomeWords(decoded.pipe(Option.getOrThrow).outcome)}): game_play op replay {"run": "${tag}", "at": <s>} shows a moment; {"save": "<name>", "run": "${tag}"} makes it a test play.`),
  };
  await NodeFSP.writeFile(
    args.tracePath,
    JSON.stringify({ ...result, file, play: kept, wallSeconds }, null, 2),
  );
  return {
    result,
    play: Option.getOrNull(decoded),
    kept,
    stopped: ran.stopped === true,
    outcome: ran.outcome,
    wallMs: ran.wallMs,
  };
};

/** A run whose game never booted: measured about the game, with a trace of its own. */
export const runWithoutBoot = async (
  args: Pick<SteppedBotArgs, "root" | "runId" | "botFile" | "tracePath">,
  note: string,
): Promise<GameBotRunResult> => {
  const file = NodePath.relative(args.root, args.botFile);
  const result: GameBotRunResult = {
    runId: args.runId,
    goal: "play the game",
    status: { state: "not-booted", note },
    ticks: 0,
    tickHz: 0,
    timeRatio: 0,
    gameSeconds: 0,
    decisions: 0,
    usedSetState: false,
    findings: [],
    finalState: {},
    finalPos: null,
    runIds: [args.runId],
    tracePath: args.tracePath,
    videoPath: "",
    frames: [],
    message: `Bot "${file}": the game did not boot. ${note}`,
  };
  await NodeFSP.writeFile(args.tracePath, JSON.stringify({ ...result, file }, null, 2)).catch(
    () => undefined,
  );
  return result;
};
