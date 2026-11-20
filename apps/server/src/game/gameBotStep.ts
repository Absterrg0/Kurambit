// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Reads the bot file and writes the run's trace and kept play on the native filesystem.
// A stepped bot: a `.studio/bot/` file that exports `decide(obs) → actions` plays inside the game's
// page (shell studio.bot). The shell calls it each fixed step on the run's own clock, as fast as
// the page allows, and records the run as it records a person's, so the run is a play: kept under
// the bot run's own id, replayable to any moment and savable as a test play. Its ending is the
// game's own (GameState.win/lose), never the bot's word. Bot files in the kit's format
// (observe/options/status, run from a Node child in real time) keep the path in gameBotPlay.ts.
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
import { END_FRAME } from "./gameBotRuntime.ts";
import type { BotLaunch } from "./gameBotPlay.ts";
import { botPlayTag, keepPlay } from "./playFiles.ts";

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
  where: Schema.Struct({
    at: Schema.NullOr(Schema.Tuple([Schema.Number, Schema.Number, Schema.Number])),
  }),
  values: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
  ),
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
}

/** The goal a bot file states (`export const goal = "…"`), else a plain one. */
const goalOf = (source: string) =>
  /\bexport\s+const\s+goal\s*=\s*(["'`])([^"'`\n]{1,200})\1/.exec(source)?.[2] ?? "play the game";

/** Real time a stepped run may take: its game seconds, plus room for a page slower than real time. */
const wallMsFor = (seconds: number) => seconds * 1_000 + 30_000;

export const playSteppedBot = async (
  launch: BotLaunch,
  args: SteppedBotArgs,
): Promise<GameBotRunResult> => {
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
  const unplayed = (note: string): GameBotRunResult => ({
    ...base,
    played: false,
    status: { state: "bot-error", note },
    message: `Bot "${file}" did not play: ${note}`,
  });
  if (play.stepBot === undefined)
    return unplayed("this game's runner plays no stepped bots; write it in the kit's format.");
  const raw = await play.stepBot(args.source, {
    seconds: args.seconds,
    wallMs: wallMsFor(args.seconds),
  });
  if (raw === "no-bot")
    return unplayed(
      "this game's runtime predates stepped bots (decide); write it in the kit's format (KIT-GUIDE.md).",
    );
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
    return result;
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
  const framed = await play.still(endFrame).catch(() => false);
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
  const wallSeconds = ran.wallMs / 1000;
  const timeRatio = wallSeconds > 0 ? ran.seconds / wallSeconds : 0;
  // The game's own ending is the run's; past its game seconds it ended unended, and past its
  // wall bound (a page slower than real time) it ran out of time.
  const state =
    ran.outcome !== null || ran.seconds >= args.seconds
      ? "done"
      : ran.error
        ? "bot-error"
        : "budget";
  const note =
    ran.outcome !== null
      ? `the game ended: ${ran.outcome.won ? "won" : "lost"} at ${ran.outcome.seconds} s${ran.outcome.text === "" ? "" : ` (${ran.outcome.text})`}`
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
      evidence: { playingAt: 0, endedAt: ran.outcome?.seconds ?? null, stepped: true },
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
  return result;
};
