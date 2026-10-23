// @effect-diagnostics globalDate:off -- Evidence folder names and result timestamps are wall-clock records of a run.
// @effect-diagnostics nodeBuiltinImport:off -- Playtest evidence is files under the game's builds/ directory.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import {
  GameConsoleMessage,
  GamePlaytestState,
  GamePlaytestProbe,
  GamePlaytestStep,
  type GameAcceptanceCriterion,
  type GameLastPlaytest,
  type GameWebPlaytestResult,
} from "@t3tools/contracts";
import { selectPlaytestCoverFrame } from "./playtestState.ts";

const PLAYTEST_DIRECTORY = "builds/playtests";
const DIRECTORY_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?$/;
const KEEP_RUNS = 5;

const StoredFrame = Schema.Struct({
  label: Schema.String,
  file: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  // The probe state taken nearest this frame, the read a cover can be picked
  // from. Older evidence has none and simply cannot act as observed gameplay.
  probe: Schema.optionalKey(GamePlaytestProbe),
});
const StoredPlaytest = Schema.fromJsonString(
  Schema.Struct({
    at: Schema.String,
    success: Schema.Boolean,
    booted: Schema.Boolean,
    bootMs: Schema.NullOr(Schema.Number),
    responded: Schema.Boolean,
    changedPercent: Schema.Number,
    message: Schema.String,
    steps: Schema.Array(Schema.Unknown),
    consoleMessages: Schema.Array(GameConsoleMessage),
    frames: Schema.Array(StoredFrame),
    // Older evidence has no probe snapshot; it is still valid evidence of what
    // the run did, just without the state the probe would have reported.
    state: Schema.optionalKey(Schema.NullOr(GamePlaytestState)),
    designObservations: Schema.optionalKey(Schema.Array(Schema.String)),
    // Whether the run counted as honest gameplay evidence and why it did not.
    qualifies: Schema.optionalKey(Schema.Boolean),
    blockers: Schema.optionalKey(Schema.Array(Schema.String)),
    interaction: Schema.optionalKey(Schema.String),
    // The project's base viewport and the integer multiple it was captured at.
    baseWidth: Schema.optionalKey(Schema.Number),
    baseHeight: Schema.optionalKey(Schema.Number),
    captureScale: Schema.optionalKey(Schema.Number),
  }),
);
type StoredPlaytest = typeof StoredPlaytest.Type;
const decodeStoredPlaytest = Schema.decodeUnknownSync(StoredPlaytest);
const isPlaytestStep = Schema.is(GamePlaytestStep);
const decodePlaytestSteps = Schema.decodeUnknownOption(Schema.Array(GamePlaytestStep));

const slug = (label: string) => {
  const cleaned = label.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return (cleaned || "frame").slice(0, 40);
};

const timestampName = (at: Date) => at.toISOString().replace(/[:.]/g, "-");

const uniqueDirectory = async (root: string, base: string) => {
  const parent = NodePath.join(root, PLAYTEST_DIRECTORY);
  let name = base;
  for (let suffix = 2; ; suffix++) {
    try {
      await NodeFSP.access(NodePath.join(parent, name));
      name = `${base}-${suffix}`;
    } catch {
      return name;
    }
  }
};

/** Writes frames and a result.json, then keeps only the newest five runs. */
export const writePlaytestEvidence = async (input: {
  readonly root: string;
  readonly steps: readonly GamePlaytestStep[];
  readonly result: GameWebPlaytestResult;
  readonly at?: Date;
}): Promise<{ readonly directory: string }> => {
  const at = input.at ?? new Date();
  const name = await uniqueDirectory(input.root, timestampName(at));
  const relativeDirectory = `${PLAYTEST_DIRECTORY}/${name}`;
  const directory = NodePath.join(input.root, relativeDirectory);
  await NodeFSP.mkdir(directory, { recursive: true });
  const frames: (typeof StoredFrame)["Type"][] = [];
  for (const [index, shot] of input.result.screenshots.entries()) {
    const file = `${String(index + 1).padStart(2, "0")}-${slug(shot.label)}.png`;
    await NodeFSP.writeFile(NodePath.join(directory, file), Buffer.from(shot.data, "base64"));
    frames.push({
      label: shot.label,
      file,
      width: shot.width,
      height: shot.height,
      ...(shot.probe === undefined ? {} : { probe: shot.probe }),
    });
  }
  const stored: StoredPlaytest = {
    at: at.toISOString(),
    success: input.result.success,
    booted: input.result.booted,
    bootMs: input.result.bootMs,
    responded: input.result.responded,
    changedPercent: input.result.changedPercent,
    message: input.result.message,
    steps: [...input.steps],
    consoleMessages: input.result.consoleMessages,
    frames,
    state: input.result.state,
    ...(input.result.designObservations === undefined
      ? {}
      : { designObservations: input.result.designObservations }),
    ...(input.result.qualifies === undefined
      ? {}
      : {
          qualifies: input.result.qualifies,
          ...(input.result.blockers === undefined ? {} : { blockers: [...input.result.blockers] }),
          ...(input.result.interaction === undefined
            ? {}
            : { interaction: input.result.interaction }),
        }),
    ...(input.result.baseViewport === undefined
      ? {}
      : {
          baseWidth: input.result.baseViewport.width,
          baseHeight: input.result.baseViewport.height,
          ...(input.result.captureScale === undefined
            ? {}
            : { captureScale: input.result.captureScale }),
        }),
  };
  await NodeFSP.writeFile(
    NodePath.join(directory, "result.json"),
    `${JSON.stringify(stored, null, 2)}\n`,
  );
  await prunePlaytests(input.root);
  return { directory: relativeDirectory };
};

const prunePlaytests = async (root: string): Promise<void> => {
  const parent = NodePath.join(root, PLAYTEST_DIRECTORY);
  let entries: string[] = [];
  try {
    entries = await NodeFSP.readdir(parent);
  } catch {
    return;
  }
  const runs = entries.filter((name) => DIRECTORY_NAME.test(name)).sort();
  for (const name of runs.slice(0, Math.max(0, runs.length - KEEP_RUNS)))
    await NodeFSP.rm(NodePath.join(parent, name), { recursive: true, force: true });
};

/**
 * Whether a stored run proved real play. Evidence written before the verdict
 * field predates qualification; a successful run that responded is the most
 * that evidence itself can claim (and it has no per-frame probe to pick from
 * anyway).
 */
const runQualified = (stored: StoredPlaytest): boolean =>
  stored.qualifies ?? (stored.success && stored.responded);

const readStoredRun = async (parent: string, name: string): Promise<StoredPlaytest | null> => {
  try {
    return decodeStoredPlaytest(
      await NodeFSP.readFile(NodePath.join(parent, name, "result.json"), "utf8"),
    );
  } catch {
    return null;
  }
};

const publicFrames = (name: string, stored: StoredPlaytest) =>
  stored.frames.map((frame) => ({
    label: frame.label,
    path: `${PLAYTEST_DIRECTORY}/${name}/${frame.file}`,
    ...(frame.probe === undefined ? {} : { probe: frame.probe }),
  }));

/**
 * One persisted run, with the per-frame probe state the visual judge selects
 * from. `null` means missing or malformed evidence, never an empty run.
 */
export interface PlaytestEvidenceRun {
  readonly frames: ReadonlyArray<{
    readonly label: string;
    readonly file: string;
    readonly probe?: GamePlaytestProbe;
  }>;
  readonly state: GamePlaytestState | null;
}

/** Reads one evidence folder by its game-relative `builds/playtests/<run>` path. */
export const readPlaytestEvidence = async (
  root: string,
  directory: string,
): Promise<PlaytestEvidenceRun | null> => {
  if (NodePath.dirname(directory) !== PLAYTEST_DIRECTORY) return null;
  const parent = NodePath.join(root, PLAYTEST_DIRECTORY);
  const stored = await readStoredRun(parent, NodePath.basename(directory));
  return stored === null ? null : { frames: stored.frames, state: stored.state ?? null };
};

/**
 * One persisted run's own factual verdict, for callers that vouch for a build
 * without replaying it: boot, console errors, and a real response to input.
 */
export interface PlaytestRunFacts {
  readonly booted: boolean;
  readonly responded: boolean;
  readonly consoleErrors: number;
  /** Input steps the run actually executed. Waits and screenshots do not count. */
  readonly steps: number;
}

/**
 * The stored verdict of one run, by its game-relative evidence directory. Null
 * means missing or malformed evidence, never a pass. This is the same record
 * the playtest stage was derived from, so a submission checks facts the server
 * already measured instead of running the browser again.
 */
export const readPlaytestRunFacts = async (
  root: string,
  directory: string,
): Promise<PlaytestRunFacts | null> => {
  if (NodePath.dirname(directory) !== PLAYTEST_DIRECTORY) return null;
  const stored = await readStoredRun(
    NodePath.join(root, PLAYTEST_DIRECTORY),
    NodePath.basename(directory),
  );
  if (stored === null) return null;
  return {
    booted: stored.booted,
    responded: stored.responded,
    consoleErrors: stored.consoleMessages.filter((message) => message.level === "error").length,
    steps: stored.steps.filter(
      (step) => isPlaytestStep(step) && !("waitMs" in step) && !("screenshot" in step),
    ).length,
  };
};

/** Reads the newest run; malformed evidence counts as no evidence. */
export const readLastPlaytest = async (
  root: string,
  builds: readonly { readonly target: string; readonly updatedAt: string }[],
  acceptance: readonly GameAcceptanceCriterion[] | null = null,
): Promise<GameLastPlaytest | null> => {
  const parent = NodePath.join(root, PLAYTEST_DIRECTORY);
  let entries: string[] = [];
  try {
    entries = await NodeFSP.readdir(parent);
  } catch {
    return null;
  }
  const runs = entries.filter((name) => DIRECTORY_NAME.test(name)).sort();
  const newest = runs.at(-1);
  if (newest === undefined) return null;
  const stored = await readStoredRun(parent, newest);
  if (stored === null) return null;
  const webBuild = builds.find((build) => build.target === "Web");
  const stale = webBuild === undefined || Date.parse(stored.at) < Date.parse(webBuild.updatedAt);
  const steps = decodePlaytestSteps(stored.steps);
  const frames = publicFrames(newest, stored);
  // The cover comes from the latest run that proved real play, which can be
  // older than the newest run when that run failed: a menu or a hover frame
  // from a failed attempt must not replace the last observed play. The frame
  // itself is picked from persisted per-frame probe state, never captions.
  let cover: ReturnType<typeof selectPlaytestCoverFrame> = null;
  for (const name of runs.toReversed()) {
    const run = name === newest ? stored : await readStoredRun(parent, name);
    if (run === null || !runQualified(run)) continue;
    cover = selectPlaytestCoverFrame(publicFrames(name, run), run.state ?? null, acceptance);
    break;
  }
  return {
    at: stored.at,
    directory: `${PLAYTEST_DIRECTORY}/${newest}`,
    success: stored.success,
    responded: stored.responded,
    changedPercent: stored.changedPercent,
    consoleErrorCount: stored.consoleMessages.filter((message) => message.level === "error").length,
    frames,
    // A run that failed to qualify leaves no playable frame behind; callers
    // fall back to the newest run's after-steps frame instead of a menu.
    coverFrame: cover,
    // Keep the verdict separate from `success`: the browser run can succeed
    // while the exam does not, and the Builds tab must be able to say so.
    ...(stored.qualifies === undefined ? {} : { qualifies: stored.qualifies }),
    ...(stored.blockers === undefined ? {} : { blockers: [...stored.blockers] }),
    ...(stored.interaction === undefined ? {} : { interaction: stored.interaction }),
    ...(steps._tag === "Some" ? { steps: [...steps.value] } : {}),
    ...(stored.baseWidth === undefined || stored.baseHeight === undefined
      ? {}
      : { viewport: { width: stored.baseWidth, height: stored.baseHeight } }),
    stale,
  };
};
