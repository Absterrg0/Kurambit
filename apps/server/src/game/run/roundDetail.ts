// @effect-diagnostics nodeBuiltinImport:off -- One round's evidence is read from the run's own files in the game folder.
// One round's evidence for the creator: the record, its blind comparison, the
// tester and reviewer notes and the bot runs. Reads only files the run wrote,
// and the bot service's records of the round's threads.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import type {
  GameRunPickDetail,
  GameRunRoundDetail,
  GameRunRoundOutcome,
} from "@kurambit/contracts";
import type * as BotEvidence from "../botEvidence.ts";
import type { Picked, RoundRecord, RunState } from "./state.ts";

// Every text is bounded so one expanded round stays a few KB on the wire.
const TEXT_MAX = 3000;
const BOT_RUNS_MAX = 6;

const readText = (path: string): Promise<string | null> =>
  NodeFSP.readFile(path, "utf8").catch(() => null);

// `file`'s real path when it lies strictly inside `dir` of the game's real
// root; a link leading out of there is refused.
const realInside = async (root: string, dir: string, file: string): Promise<string | null> => {
  const base = await NodeFSP.realpath(root).catch(() => null);
  const real = await NodeFSP.realpath(file).catch(() => null);
  if (base === null || real === null) return null;
  const relative = NodePath.relative(NodePath.join(base, dir), real);
  return relative.length === 0 || relative.startsWith("..") || NodePath.isAbsolute(relative)
    ? null
    : real;
};

// Evidence the run wrote under .studio; a symlink there never reads outside it.
const readStudio = async (root: string, ...parts: ReadonlyArray<string>) => {
  const real = await realInside(root, ".studio", NodePath.join(root, ".studio", ...parts));
  return real === null ? null : readText(real);
};

export const bounded = (text: string, max = TEXT_MAX): string => {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max).trimEnd()}…`;
};

const boundedOrNull = (text: string | null | undefined): string | null =>
  text === null || text === undefined || text.trim().length === 0 ? null : bounded(text);

export const roundOutcome = (r: RoundRecord): GameRunRoundOutcome =>
  r.kept
    ? "kept"
    : r.inconclusive === true
      ? "inconclusive"
      : r.unjudged === true
        ? "unjudged"
        : r.abandoned === true
          ? "abandoned"
          : "rejected";

const Primitive = Schema.Union([Schema.Number, Schema.Boolean, Schema.String, Schema.Null]);
const BotFactFile = Schema.Struct({
  ending: Schema.String,
  seconds: Schema.Number,
  final: Schema.Record(Schema.String, Primitive),
  note: Schema.String,
});
const EvidenceFile = Schema.Struct({
  sessions: Schema.Number,
  actions: Schema.Number,
  nominalMs: Schema.Number,
  images: Schema.Number,
});
// Older comparison files lack the bot fields; every key is optional.
const ComparisonFile = Schema.Struct({
  // The pick names its blind labels' prototype branches.
  A: Schema.optionalKey(Schema.String),
  B: Schema.optionalKey(Schema.String),
  playOrder: Schema.optionalKey(Schema.String),
  evidence: Schema.optionalKey(Schema.Record(Schema.String, Schema.NullOr(EvidenceFile))),
  gate: Schema.optionalKey(Schema.NullOr(Schema.String)),
  reports: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  bot: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ file: Schema.String, decider: Schema.String })),
  ),
  botWithheld: Schema.optionalKey(Schema.NullOr(Schema.String)),
  bots: Schema.optionalKey(Schema.Record(Schema.String, Schema.NullOr(BotFactFile))),
  sheets: Schema.optionalKey(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
  sheetsShown: Schema.optionalKey(Schema.Boolean),
  verdicts: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        order: Schema.String,
        verdict: Schema.String,
        comparison: Schema.NullOr(Schema.String),
      }),
    ),
  ),
});
const decodeComparison = Schema.decodeUnknownOption(Schema.fromJsonString(ComparisonFile));

const UUID_JSON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
const SAFE_NAME = /^[A-Za-z0-9_-]{1,80}\.md$/;
const SAFE_SHEET = /^frames-[A-Za-z0-9-]{1,80}\.jpg$/;
const SAFE_RUN_ID = /^[A-Za-z0-9-]{1,64}$/;

// The comparison record is named `${branch}-${uuid}.json`; a branch "round-1"
// must not pick up "round-10-…" or a suffixed "round-1-x-…" branch's file.
const latestComparison = async (root: string, branch: string, id?: string) => {
  const dir = NodePath.join(root, ".studio", "comparisons");
  const names = (await NodeFSP.readdir(dir).catch(() => [] as string[])).filter(
    (name) =>
      name.startsWith(`${branch}-`) &&
      UUID_JSON.test(name.slice(branch.length + 1)) &&
      (id === undefined || name === `${branch}-${id}.json`),
  );
  let best: { name: string; at: number } | null = null;
  for (const name of names) {
    const at = (await NodeFSP.stat(NodePath.join(dir, name)).catch(() => null))?.mtimeMs ?? 0;
    if (best === null || at > best.at) best = { name, at };
  }
  if (best === null) return null;
  const decoded = decodeComparison((await readStudio(root, "comparisons", best.name)) ?? "");
  return decoded._tag === "Some" ? { file: decoded.value } : null;
};

/**
 * A frame sheet the record names, only as a plain frames-*.jpg in
 * .studio/comparisons that really resolves inside it; the transport mints its
 * URL from this resolved path, never from what the record says.
 */
const sheetFile = async (root: string, recorded: string | null | undefined) => {
  const name = recorded === null || recorded === undefined ? "" : NodePath.basename(recorded);
  if (!SAFE_SHEET.test(name)) return null;
  const real = await realInside(
    root,
    NodePath.join(".studio", "comparisons"),
    NodePath.join(root, ".studio", "comparisons", name),
  );
  const info = real === null ? null : await NodeFSP.stat(real).catch(() => null);
  return real !== null && info?.isFile() === true && info.size > 0 ? real : null;
};

// With an id, only that comparison record: the pick names the one it came from.
const comparisonOf = async (
  root: string,
  branch: string,
  id?: string,
): Promise<{
  readonly comparison: GameRunRoundDetail["comparison"];
  readonly sheetFiles: ReadonlyArray<{ readonly build: string; readonly path: string }>;
  readonly sides: Readonly<Record<string, string>>;
}> => {
  const found = await latestComparison(root, branch, id);
  if (found === null) return { comparison: null, sheetFiles: [], sides: {} };
  const { file } = found;
  const playOrder = file.playOrder ?? "";
  const builds = playOrder.split(",").filter((name) => name.length > 0);
  const order = [
    ...builds,
    ...Object.keys(file.reports ?? {}).filter((name) => !builds.includes(name)),
  ];
  const judges = [];
  for (const verdict of file.verdicts ?? []) {
    // The record names its comparator file; only a plain name inside comparisons/ is read.
    const name = verdict.comparison === null ? "" : NodePath.basename(verdict.comparison);
    const text = SAFE_NAME.test(name) ? await readStudio(root, "comparisons", name) : null;
    judges.push({
      order: verdict.order,
      verdict: verdict.verdict,
      reasoning: bounded(text ?? ""),
    });
  }
  const sheetFiles: Array<{ build: string; path: string }> = [];
  for (const build of order) {
    const path = await sheetFile(root, file.sheets?.[build]);
    if (path !== null) sheetFiles.push({ build, path });
  }
  const comparison = {
    gate: file.gate ?? null,
    playOrder,
    judges,
    reports: order.flatMap((build) => {
      const text = file.reports?.[build];
      const seen = file.evidence?.[build];
      const exposure =
        seen === undefined || seen === null
          ? null
          : {
              sessions: seen.sessions,
              actions: seen.actions,
              nominalMs: seen.nominalMs,
              images: seen.images,
            };
      return text === undefined ? [] : [{ build, text: bounded(text), exposure }];
    }),
    bot: file.bot ?? null,
    botWithheld: file.botWithheld ?? null,
    bots: order.flatMap((build) => {
      const fact = file.bots?.[build];
      return fact === undefined || fact === null
        ? []
        : [{ build, ...fact, note: bounded(fact.note, 300) }];
    }),
    sheets: sheetFiles.map(({ build, path }) => ({
      build,
      file: NodePath.relative(root, path).split(NodePath.sep).join("/"),
      url: null,
    })),
    sheetsShown: file.sheetsShown ?? false,
  };
  const sides: Record<string, string> = {};
  if (file.A !== undefined) sides.A = file.A;
  if (file.B !== undefined) sides.B = file.B;
  return { comparison, sheetFiles, sides };
};

export type PickEvidence = {
  readonly detail: GameRunPickDetail;
  readonly sheetFiles: ReadonlyArray<{ readonly build: string; readonly path: string }>;
};

const PICK_NOTE: Record<Picked["how"], string | null> = {
  won: null,
  selected: "The comparator called it a tie, then selected this one to continue from.",
  "only-booted": "Only one prototype booted, so it was adopted without a comparison.",
  creator: "The creator picked this prototype after seeing both.",
};

/**
 * The prototype pick's evidence: what the run recorded it became and the one
 * comparison record it came from, never a record an earlier run left behind.
 */
export const readPickEvidence = async (root: string, state: RunState): Promise<PickEvidence> => {
  const t = state.task;
  const open = t._tag === "pick";
  const id = open ? t.comparison : (state.picked?.comparison ?? "");
  const compared =
    id === ""
      ? { comparison: null, sheetFiles: [], sides: {} }
      : await comparisonOf(root, "pick", id);
  // While the pick compares, its record is not written yet; the task holds the labels.
  const sides =
    compared.comparison === null && open && t.cmp.x.length > 0
      ? { A: t.cmp.x, B: t.cmp.y }
      : compared.sides;
  const picked = open ? null : state.picked;
  const note =
    picked !== null
      ? PICK_NOTE[picked.how]
      : !open && (state.pickNotes.length > 0 || state.protos.length > 0)
        ? "No adopted prototype is recorded for this run."
        : null;
  return {
    detail: {
      sides: Object.entries(sides).map(([build, branch]) => ({ build, branch })),
      chosen: picked?.branch ?? null,
      how: picked?.how ?? null,
      note,
      comparison: compared.comparison,
    },
    sheetFiles: compared.sheetFiles,
  };
};

/** The threads whose bot runs a round shows: its builders' and its tester's. */
export const roundBotThreads = (state: RunState, n: number) => {
  const roles = new Set([`builder-${n}`, `builder-${n}b`, `tester-${n}`]);
  return state.threads.filter((thread) => roles.has(thread.role)).map((t) => t.threadId);
};

// The round's bot runs, from the bot service's records of its threads (never
// the game folder's copy, which a role agent can write), latest last.
// Comparison and check bots run on no thread and are not shown.
const botRunsOf = (bots: ReadonlyArray<BotEvidence.BotRun>) =>
  bots
    .toSorted((a, b) => a.at.localeCompare(b.at))
    .slice(-BOT_RUNS_MAX)
    .map((run) => ({
      runId: run.runId,
      file: run.file,
      mode: run.mode,
      ending: run.ending ?? (run.won ? "done" : "ended"),
      seconds: run.seconds,
      findings: run.findings,
      at: run.at,
    }));

/**
 * The run's own video for a bot run, resolved strictly inside the game's
 * builds/logs: the path is built from the run id, never read from a file, and
 * a link that leads out of builds/logs is refused.
 */
export const botVideoFile = async (root: string, runId: string): Promise<string | null> => {
  if (!SAFE_RUN_ID.test(runId)) return null;
  const logs = await NodeFSP.realpath(NodePath.join(root, "builds", "logs")).catch(() => null);
  if (logs === null || (await realInside(root, "builds", logs)) === null) return null;
  const file = await NodeFSP.realpath(NodePath.join(logs, `game-bot-${runId}`, "run.mp4")).catch(
    () => null,
  );
  if (file === null) return null;
  const relative = NodePath.relative(logs, file);
  if (relative.startsWith("..") || NodePath.isAbsolute(relative)) return null;
  const info = await NodeFSP.stat(file).catch(() => null);
  return info?.isFile() === true && info.size > 0 ? file : null;
};

export type RoundEvidence = {
  readonly detail: Omit<GameRunRoundDetail, "restorable" | "current">;
  /** The canonical video file the transport may mint a URL for. */
  readonly videoFile: string | null;
  /** The frame sheet files the transport may mint URLs for, by build. */
  readonly sheetFiles: ReadonlyArray<{ readonly build: string; readonly path: string }>;
};

export const readRoundEvidence = async (
  root: string,
  state: RunState,
  record: RoundRecord,
  /** The bot runs of the round's threads in this game folder (see roundBotThreads). */
  bots: ReadonlyArray<BotEvidence.BotRun>,
): Promise<RoundEvidence> => {
  const n = record.round;
  const studio = (name: string) => readStudio(root, name);
  const nextRound = state.rounds.find((r) => r.round === n + 1);
  const latest = state.rounds.at(-1)?.round === n;
  const botRuns = botRunsOf(bots);
  // A round names its own record; one recorded before that finds its label's latest.
  const compared = await comparisonOf(root, record.branch, record.comparison);
  let video: GameRunRoundDetail["video"] = null;
  let videoFile: string | null = null;
  for (const run of botRuns.toReversed()) {
    videoFile = await botVideoFile(root, run.runId);
    if (videoFile !== null) {
      video = {
        runId: run.runId,
        file: NodePath.relative(root, videoFile).split(NodePath.sep).join("/"),
        url: null,
      };
      break;
    }
  }
  return {
    detail: {
      round: n,
      outcome: roundOutcome(record),
      move: record.move,
      branch: record.branch,
      durationMs: record.durationMs,
      linesChanged: record.linesChanged,
      note: record.note ?? null,
      steer: record.steer ?? [],
      verdicts: record.verdicts,
      comparison: compared.comparison,
      testerNote: boundedOrNull((await studio(`tester-${n}.md`)) ?? record.testerNote),
      reviewerNotes: boundedOrNull(await studio(`reviewer-${n}.md`)),
      direction: boundedOrNull(nextRound?.move ?? (latest ? state.next : null)),
      botRuns,
      video,
    },
    videoFile,
    sheetFiles: compared.sheetFiles,
  };
};
