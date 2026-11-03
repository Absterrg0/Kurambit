// @effect-diagnostics nodeBuiltinImport:off -- One round's evidence is read from the run's own files in the game folder.
// One round's evidence for the creator: the record, its blind comparison, the
// tester and reviewer notes and the bot runs. Reads only files the run wrote.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import type { GameRunRoundDetail, GameRunRoundOutcome } from "@kurambit/contracts";
import type { RoundRecord, RunState } from "./state.ts";

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
        : "rejected";

const Primitive = Schema.Union([Schema.Number, Schema.Boolean, Schema.String, Schema.Null]);
const BotFactFile = Schema.Struct({
  ending: Schema.String,
  seconds: Schema.Number,
  final: Schema.Record(Schema.String, Primitive),
  note: Schema.String,
});
// Older comparison files lack the bot fields; every key is optional.
const ComparisonFile = Schema.Struct({
  playOrder: Schema.optionalKey(Schema.String),
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

const BotRow = Schema.Struct({
  runId: Schema.String,
  at: Schema.String,
  seconds: Schema.optionalKey(Schema.Number),
  won: Schema.optionalKey(Schema.Boolean),
  ending: Schema.optionalKey(Schema.String),
  findings: Schema.optionalKey(Schema.Number),
  mode: Schema.optionalKey(Schema.String),
  file: Schema.optionalKey(Schema.String),
});
const decodeBotRow = Schema.decodeUnknownOption(Schema.fromJsonString(BotRow));

const UUID_JSON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
const SAFE_NAME = /^[A-Za-z0-9_-]{1,80}\.md$/;
const SAFE_SHEET = /^frames-[A-Za-z0-9-]{1,80}\.jpg$/;
const SAFE_RUN_ID = /^[A-Za-z0-9-]{1,64}$/;

// The comparison record is named `${branch}-${uuid}.json`; a branch "round-1"
// must not pick up "round-10-…" or a suffixed "round-1-x-…" branch's file.
const latestComparison = async (root: string, branch: string) => {
  const dir = NodePath.join(root, ".studio", "comparisons");
  const names = (await NodeFSP.readdir(dir).catch(() => [] as string[])).filter(
    (name) => name.startsWith(`${branch}-`) && UUID_JSON.test(name.slice(branch.length + 1)),
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

const comparisonOf = async (
  root: string,
  branch: string,
): Promise<{
  readonly comparison: GameRunRoundDetail["comparison"];
  readonly sheetFiles: ReadonlyArray<{ readonly build: string; readonly path: string }>;
}> => {
  const found = await latestComparison(root, branch);
  if (found === null) return { comparison: null, sheetFiles: [] };
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
      return text === undefined ? [] : [{ build, text: bounded(text) }];
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
  return { comparison, sheetFiles };
};

// Bot runs recorded in the game folder between this round's first builder or
// tester turn and the next round's first turn. Comparison bots play in removed
// checkouts and never land here.
const botRunsOf = async (root: string, state: RunState, n: number) => {
  const startedAt = (round: number) => {
    const roles = new Set([`builder-${round}`, `builder-${round}b`, `tester-${round}`]);
    return state.threads
      .filter((thread) => roles.has(thread.role))
      .map((thread) => Date.parse(thread.startedAt))
      .filter(Number.isFinite);
  };
  const own = startedAt(n);
  if (own.length === 0) return [];
  const from = Math.min(...own);
  const later = startedAt(n + 1);
  const until = later.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...later);
  const text = (await readStudio(root, "bot-results.jsonl")) ?? "";
  return text
    .split("\n")
    .flatMap((line) => {
      if (line.trim().length === 0) return [];
      const decoded = decodeBotRow(line);
      if (decoded._tag === "None") return [];
      const at = Date.parse(decoded.value.at);
      return at >= from && at < until ? [decoded.value] : [];
    })
    .slice(-BOT_RUNS_MAX)
    .map((row) => ({
      runId: row.runId,
      file: row.file ?? "",
      mode: row.mode ?? "play",
      ending: row.ending ?? (row.won === true ? "done" : "ended"),
      seconds: row.seconds ?? 0,
      findings: row.findings ?? 0,
      at: row.at,
    }));
};

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
): Promise<RoundEvidence> => {
  const n = record.round;
  const studio = (name: string) => readStudio(root, name);
  const nextRound = state.rounds.find((r) => r.round === n + 1);
  const latest = state.rounds.at(-1)?.round === n;
  const botRuns = await botRunsOf(root, state, n);
  const compared = await comparisonOf(root, record.branch);
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
