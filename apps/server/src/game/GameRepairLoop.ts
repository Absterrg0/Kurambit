// @effect-diagnostics nodeBuiltinImport:off -- The loop record is a server-state file keyed by the game root.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  CommandId,
  DEFAULT_GAME_REVIEW_BUDGET,
  EMPTY_GAME_REVIEW_USAGE,
  GameOperationError,
  gameProductionBudgetMs,
  type GameProductionStatus,
  type GameRepairFrame,
  GameRepairLoop as GameRepairLoopSchema,
  type GameRepairLoop as GameRepairLoopRecord,
  GAME_REVIEW_FACETS,
  type GameReviewBallotAnswer,
  type GameReviewBallotPlan,
  type GameReviewBallotRecord,
  type GameReviewCheck,
  GAME_REVIEW_QUALITY_RUBRIC_VERSION,
  gameReviewQualityCoverage,
  type GameReviewUsage,
  type GameReviewChildUsage,
  type GameReviewDefect,
  type GameReviewDoNotRegress,
  type GameReviewExperimentRoute,
  type GameReviewRound as GameReviewRoundRecord,
  type GameSubmission,
  type GameSubmitInput,
  type GameSubmitResult,
  type ModelSelection,
  type NodeId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameAdmission from "./GameAdmission.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameRepairStudio from "./GameRepairStudio.ts";
import * as GameReviewAttemptPolicy from "./gameReviewAttemptPolicy.ts";
import * as GameReviewSessions from "./GameReviewSessions.ts";
import * as GameRoundStore from "./GameRoundStore.ts";
import { qualityRepairDefects } from "./gameQualityEval.ts";
import { playtestIntervalObservation } from "./playtestEvidence.ts";
import {
  chooseDiverseWitnessPairs,
  playtestInputSignature,
  playtestPairWitnessScore,
  playtestStepAction,
} from "./playtestInputPairs.ts";
import { productionBudgetText, productionStatus } from "./gameProduction.ts";
import { gameRecordLocation, readRecordText } from "./gameRecord.ts";

/**
 * One record per game. The newest loop is the only live one; a finished loop
 * stays as the reason the next builder turn replaced it. The array is capped so
 * a long-lived game does not grow an unbounded file.
 */
const StoredLoops = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  loops: Schema.Array(GameRepairLoopSchema),
});
const decodeStoredLoops = Schema.decodeUnknownSync(Schema.fromJsonString(StoredLoops));
const MAX_STORED_LOOPS = 10;

const MAX_REPAIR_PROMPT_DEFECTS = 5;
/** Enough of the last rejection to steer the next repair without crowding its brief. */
const MAX_PREVIOUS_REJECTION_CHARS = 1_200;
const BALLOT_FRAMES_PER_SIDE = 6;
const CRITIC_FRAMES = 8;
const REQUIRED_POSITIVE_CHECKS = ["boot", "console", "input"] as const;
const FACT_CHECK_IDS = new Set([
  "boot",
  "console",
  "input",
  "build",
  "bytes",
  "sources",
  "playtest",
]);
/** A child that ignores its interrupt may not hold a creator action forever. */
const DEFAULT_CHILD_JOIN_TIMEOUT_MS = 15_000;

export interface GameRepairLoopEnsureInput {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  /** An explicit review-model override, frozen for the whole loop. */
  readonly reviewSelection?: ModelSelection | undefined;
}

const nowIso = () => DateTime.formatIso(DateTime.nowUnsafe());
const nowMs = () => DateTime.toEpochMillis(DateTime.nowUnsafe());
const epochMs = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

const remainingBudget = (record: GameRepairLoopRecord, at: number) => ({
  repairs: Math.max(0, record.budget.repairs - record.repairsUsed),
  elapsedMs: Math.max(0, epochMs(record.startedAt) + record.budget.elapsedMs - at),
});

const budgetText = (record: GameRepairLoopRecord, at: number) => {
  const remaining = remainingBudget(record, at);
  const minutes = Math.max(1, Math.ceil(remaining.elapsedMs / 60_000));
  return `${remaining.repairs} repair${remaining.repairs === 1 ? "" : "s"} and ${minutes} minute${minutes === 1 ? "" : "s"} left`;
};

const framesFor = (frames: ReadonlyArray<GameRepairFrame>) =>
  frames.map((frame) => ({
    id: frame.id,
    label: frame.label,
    sourcePath: frame.path,
    ...(frame.inputPair === undefined ? {} : { inputPair: frame.inputPair }),
    ...(frame.width === undefined ? {} : { width: frame.width }),
    ...(frame.height === undefined ? {} : { height: frame.height }),
    ...(frame.observations === undefined ? {} : { observations: frame.observations }),
  }));

/**
 * Frames a budget keeps: the window-shaped evidence is never dropped, because
 * it is the only view of how the game holds up outside the played shape. The
 * rest keep their order, so a later pair is the one that loses its slot.
 */
const boundedFrames = <T extends { readonly window?: boolean }>(
  frames: ReadonlyArray<T>,
  limit: number,
): ReadonlyArray<T> => {
  const shaped = frames.filter((frame) => frame.window === true);
  const rest = frames.filter((frame) => frame.window !== true);
  return [...rest.slice(0, Math.max(0, limit - shaped.length)), ...shaped];
};

const toCriticFrame = (
  frame: GameRepairStudio.GameRepairStudioFrame,
  index: number,
): GameRepairFrame => ({
  id: `f${index + 1}`,
  label: frame.label,
  path: frame.path,
  ...(frame.inputPair === undefined ? {} : { inputPair: frame.inputPair }),
  ...(frame.width === undefined ? {} : { width: frame.width }),
  ...(frame.height === undefined ? {} : { height: frame.height }),
  ...(frame.window === true ? { window: true } : {}),
  ...(frame.observations === undefined ? {} : { observations: frame.observations }),
});

const criticFrames = (
  frames: ReadonlyArray<GameRepairStudio.GameRepairStudioFrame>,
): GameRepairFrame[] => {
  const shaped = frames.filter((frame) => frame.window === true);
  const rest = frames.filter((frame) => frame.window !== true);
  const byStep = new Map<number, GameRepairStudio.GameRepairStudioFrame[]>();
  for (const frame of rest) {
    if (frame.inputPair === undefined) continue;
    const group = byStep.get(frame.inputPair.stepIndex) ?? [];
    group.push(frame);
    byStep.set(frame.inputPair.stepIndex, group);
  }
  const complete = [...byStep.entries()]
    .filter(
      ([, pair]) =>
        pair.length === 2 &&
        pair[0]!.inputPair?.phase === "before" &&
        pair[1]!.inputPair?.phase === "after",
    )
    .sort(([left], [right]) => left - right);
  // No whole pairs (loose fallback): keep the old prefix behavior so a
  // no-pairs run still shows its loose frames within budget.
  if (complete.length === 0) return boundedFrames(frames, CRITIC_FRAMES).map(toCriticFrame);
  const budgetPairs = Math.max(0, Math.floor((CRITIC_FRAMES - shaped.length) / 2));
  // Second cut uses the same diverse witness-aware ranking as the first
  // stage, so it keeps the best whole pairs instead of undoing the choice
  // by dropping to a prefix. Selection measurements are not quality verdicts.
  const ranks = complete.map(([stepIndex, pair]) => {
    const inputPair = pair[1]!.inputPair!;
    return {
      stepIndex,
      signature:
        inputPair.input === undefined ? "unknown" : playtestInputSignature(inputPair.input),
      score: playtestPairWitnessScore(inputPair),
    };
  });
  const chosen = new Set(chooseDiverseWitnessPairs(ranks, budgetPairs));
  const kept = complete.filter(([stepIndex]) => chosen.has(stepIndex)).flatMap(([, pair]) => pair);
  return [...kept, ...shaped].map(toCriticFrame);
};

const assignmentFrames = (
  frames: ReadonlyArray<BallotFrame>,
  side: "a" | "b" | "c" | "d",
): ReadonlyArray<GameReviewSessions.GameReviewFrameInput> =>
  frames.map((frame, index) => ({
    id: `${side}${index + 1}`,
    label: `${side.toUpperCase()}: ${frame.label}`,
    sourcePath: frame.path,
    ...(frame.inputPair === undefined ? {} : { inputPair: frame.inputPair }),
    ...(frame.pair === undefined ? {} : { pair: frame.pair }),
    ...(frame.width === undefined ? {} : { width: frame.width }),
    ...(frame.height === undefined ? {} : { height: frame.height }),
  }));

/**
 * One card per input: the before and after captures of the same input become
 * one labelled image, so a ballot judges the change rather than a lone still.
 * Observations and boot frames stay as they are.
 */
const ballotFrames = (frames: ReadonlyArray<GameRepairFrame>): ReadonlyArray<BallotFrame> => {
  const cards: BallotFrame[] = [];
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]!;
    const next = frames[index + 1];
    const pair = frame.inputPair;
    if (
      pair !== undefined &&
      pair.phase === "before" &&
      next?.inputPair !== undefined &&
      next.inputPair.phase === "after" &&
      next.inputPair.stepIndex === pair.stepIndex &&
      JSON.stringify(next.inputPair.input) === JSON.stringify(pair.input)
    ) {
      const caption = playtestStepAction(pair.input);
      cards.push({
        ...frame,
        label: `${frame.label.replace(/ before: .*$/u, "")} (before | after): ${caption}`,
        inputPair: next.inputPair,
        pair: { beforePath: frame.path, afterPath: next.path, caption },
      });
      index += 1;
      continue;
    }
    cards.push(frame);
  }
  return cards;
};

/** Matched evidence from one cited point of a critic route. */
interface BallotExperimentPair {
  readonly key: string;
  readonly incumbent: ReadonlyArray<GameRepairFrame>;
  readonly candidate: ReadonlyArray<GameRepairFrame>;
}

/** One frame a ballot sees, or one composed before/after card. */
interface BallotFrame {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly inputPair?: GameRepairFrame["inputPair"];
  readonly pair?: GameReviewSessions.GameReviewFrameInput["pair"];
  readonly width?: number;
  readonly height?: number;
}

const inputRouteKey = (
  route: Pick<GameReviewExperimentRoute, "steps" | "setupSteps">,
  stepIndex: number,
  viewport: GameRepairLoopRecord["inputs"]["viewport"],
) => {
  const full = [...(route.setupSteps ?? []), ...route.steps];
  return JSON.stringify([viewport, full.slice(0, stepIndex + 1)]);
};

const experimentFrames = (
  frames: ReadonlyArray<GameRepairStudio.GameRepairStudioFrame>,
  route: GameReviewExperimentRoute,
  citation: GameReviewExperimentRoute["frames"][number],
  kind: "pair" | "observation",
): GameRepairFrame[] => {
  const atStep = frames.filter((frame) => frame.inputPair?.stepIndex === citation.stepIndex);
  const observationMs =
    citation.observationMs ?? playtestIntervalObservation(citation.label)?.elapsedMs;
  // Capture work shifts timestamps between runs; match the nearest moment in the same step.
  const observations =
    kind !== "observation" || observationMs === undefined
      ? []
      : frames
          .flatMap((frame) => {
            const at = playtestIntervalObservation(frame.label);
            return at !== null && at.stepIndex === citation.stepIndex ? [{ frame, at }] : [];
          })
          .sort(
            (left, right) =>
              Math.abs(left.at.elapsedMs - observationMs) -
              Math.abs(right.at.elapsedMs - observationMs),
          );
  const selected =
    kind === "observation"
      ? observationMs === undefined
        ? frames.filter((frame) => frame.label === citation.label).slice(0, 1)
        : observations.slice(0, 1).map((entry) => entry.frame)
      : atStep.some((frame) => frame.inputPair?.phase === "before") &&
          atStep.some((frame) => frame.inputPair?.phase === "after")
        ? atStep
        : [];
  return selected.map((frame) => {
    const pair = frame.inputPair;
    const observation =
      pair !== undefined && ("waitMs" in pair.input || "screenshot" in pair.input);
    return {
      id: "e1",
      label: `experiment ${route.id}: ${observation ? "observation: " : ""}${frame.label}`,
      path: frame.path,
      ...(pair === undefined || observation ? {} : { inputPair: pair }),
      ...(frame.width === undefined ? {} : { width: frame.width }),
      ...(frame.height === undefined ? {} : { height: frame.height }),
    };
  });
};

const sideChecks = (checks: ReadonlyArray<GameReviewCheck>, side: string) =>
  checks.map((check) => ({
    id: `${side}:${check.id}`,
    status: check.status,
    ...(check.detail === undefined ? {} : { detail: check.detail }),
    ...(check.measurements === undefined ? {} : { measurements: check.measurements }),
  }));

/** A deterministic anonymous A/B order; the second ballot is always its reverse. */
const seededFlip = (key: string): boolean =>
  (NodeCrypto.createHash("sha256").update(key).digest()[0]! & 1) === 0;

const ballotPlans = (loopId: string, roundId: string): GameReviewBallotPlan[] => {
  const first = seededFlip(`${loopId}:${roundId}:main`);
  return [
    {
      order: 0,
      main: first ? { A: "challenger", B: "incumbent" } : { A: "incumbent", B: "challenger" },
      control: { C: "incumbent", D: "incumbent" },
      evidenceHash: null,
    },
    {
      order: 1,
      main: first ? { A: "incumbent", B: "challenger" } : { A: "challenger", B: "incumbent" },
      control: { C: "incumbent", D: "incumbent" },
      evidenceHash: null,
    },
  ];
};

type VetoKind =
  | { readonly kind: "unqualified" }
  | { readonly kind: "failed"; readonly check: string }
  | { readonly kind: "unmeasured"; readonly check: string }
  | { readonly kind: "required"; readonly check: string }
  | { readonly kind: "preservation"; readonly item: string; readonly check: string };

/**
 * Only execution facts can veto a candidate. Older rounds may contain inferred
 * quality checks; those remain evidence for model judgment.
 */
const mechanicalVeto = (
  incumbent: ReadonlyArray<GameReviewCheck>,
  candidate: ReadonlyArray<GameReviewCheck>,
  items: ReadonlyArray<GameReviewDoNotRegress>,
): VetoKind | null => {
  const after = new Map(candidate.map((check) => [check.id, check]));
  if (after.get("playtest")?.status === "failed") return { kind: "unqualified" };
  for (const before of incumbent) {
    if (!FACT_CHECK_IDS.has(before.id) || before.status !== "passed") continue;
    const now = after.get(before.id);
    if (now === undefined || now.status === "unmeasured")
      return { kind: "unmeasured", check: before.id };
    if (now.status === "failed") return { kind: "failed", check: before.id };
  }
  for (const id of REQUIRED_POSITIVE_CHECKS) {
    if (after.get(id)?.status !== "passed") return { kind: "required", check: id };
  }
  for (const item of items) {
    if (item.checkId === undefined || !FACT_CHECK_IDS.has(item.checkId)) continue;
    if (incumbent.find((check) => check.id === item.checkId)?.status !== "passed") continue;
    if (after.get(item.checkId)?.status !== "passed")
      return { kind: "preservation", item: item.id, check: item.checkId };
  }
  return null;
};

const vetoReason = (veto: VetoKind): string => {
  switch (veto.kind) {
    case "unqualified":
      return "playtest-failed: the challenger's exact-build playtest did not qualify.";
    case "failed":
      return `check-failed: ${veto.check} passed on the incumbent and fails on the challenger.`;
    case "unmeasured":
      return `check-unmeasured: ${veto.check} passed on the incumbent and is now unmeasured.`;
    case "required":
      return `check-missing: ${veto.check} is not positively shown on the challenger.`;
    case "preservation":
      return `preservation-lost: ${veto.item} is measured by ${veto.check}, which no longer passes.`;
  }
};

/** Overall quality belongs to the critic; identical controls must remain ties. */
const ballotReason = (
  answer: NonNullable<GameReviewBallotRecord["answer"]>,
  plan: GameReviewBallotPlan,
): string | null => {
  if (answer.overall === undefined || answer.overallReason === undefined)
    return `invalid-ballot: ballot ${plan.order} has no overall judgment.`;
  if (GAME_REVIEW_FACETS.some((facet) => answer.control[facet] !== "tie"))
    return `failed-control: ballot ${plan.order} preferred one of two identical control builds.`;
  return null;
};

const challengerLosses = (
  answer: Pick<GameReviewBallotAnswer, "preservation">,
  plan: GameReviewBallotPlan,
) => {
  const side = plan.main.A === "challenger" ? "A" : "B";
  return answer.preservation.filter((entry) => entry[side] === "lost").map((entry) => entry.id);
};

/** A child the live fiber currently owns, and how to stop it. */
interface OwnedChild {
  readonly childThreadId: ThreadId;
  readonly runId: RunId | null;
  readonly label: string;
}

type ChildOutcome =
  | { readonly kind: "failed"; readonly reason: string }
  | {
      readonly kind: "expired";
      readonly child: OwnedChild | null;
      /** The phase cap interrupted and fully joined the child before this was read. */
      readonly settled: boolean;
    }
  | {
      readonly kind: "terminal";
      readonly status: "completed" | "failed" | "cancelled" | "interrupted" | "rolled_back";
      readonly child: OwnedChild;
    };

/** Everything one live fiber needs and nothing a restart could reuse. */
interface Task {
  readonly root: string;
  /** Every live child keyed by role:order, so siblings never clear each other. */
  readonly owned: Ref.Ref<ReadonlyMap<string, OwnedChild>>;
  readonly usageWrite: Semaphore.Semaphore;
}

const ownedKey = (role: string, order: number) => `${role}:${order}`;

const ownedRemove = (task: Task, key: string) =>
  Ref.update(task.owned, (current) => {
    if (!current.has(key)) return current;
    const next = new Map(current);
    next.delete(key);
    return next;
  });

interface RoundOutcome {
  readonly record: GameRepairLoopRecord;
  /** The loop is terminal; the fiber returns. */
  readonly done: boolean;
}

/**
 * The repair loop is one structured task per game, not a persisted state
 * machine. Its fiber is straight-line code forked in the service scope:
 * checks, critic, snapshot, repair, judge, ballots, promote or reject, repeated
 * within budget, every child awaited inline. Cancelling a creator action
 * interrupts that fiber and joins it, so no late child can promote after the
 * action. The durable records keep the origin, the frozen selections and
 * inputs, the spend and the decided rounds; nothing waits for a restart.
 */
export class GameRepairLoop extends Context.Service<
  GameRepairLoop,
  {
    /**
     * The reactor's entry point: create the loop for the completed builder run
     * whose submission (or, without one, verified export) names the build to
     * review, or return the loop already there. Starting a loop is serialized
     * with every user action.
     */
    readonly ensure: (
      input: GameRepairLoopEnsureInput,
    ) => Effect.Effect<GameRepairLoopRecord | null, GameOperationError>;
    /**
     * The builder's (or repair child's) declaration of the build it stands
     * behind. The server verifies only facts and records the declaration; the
     * review starts from the recorded submission after the turn ends.
     */
    readonly submit: (
      threadId: ThreadId,
      input: GameSubmitInput,
    ) => Effect.Effect<GameSubmitResult, GameOperationError>;
    readonly activity: (
      threadId: ThreadId,
    ) => Effect.Effect<
      { readonly held: boolean; readonly phase: string | null },
      GameOperationError
    >;
    /** The newest loop for the thread's game, if one exists. */
    readonly read: (
      threadId: ThreadId,
    ) => Effect.Effect<GameRepairLoopRecord | null, GameOperationError>;
    /**
     * A user action supersedes the loop: interrupt and join its fiber (whose
     * finalizers stop the owned child), stop the open round and record the
     * stop. Fails closed when the child could not be stopped.
     */
    readonly interrupt: (
      threadId: ThreadId,
      reason: string,
    ) => Effect.Effect<void, GameOperationError>;
    /**
     * Startup reconciliation: every loop the restart cut is marked
     * interrupted, the incumbent stays selected and no Resume exists.
     */
    readonly recover: () => Effect.Effect<ReadonlyArray<string>, never>;
    /** Joins the live fiber for a game, when one is running. */
    readonly awaitIdle: (threadId: ThreadId) => Effect.Effect<void, never>;
    /**
     * The creator's explicit return to the version before a review. The round
     * is the newest loop's own restorable round (see GameRoundStore
     * `isRestorableRound`), found by its loop id, never whichever round is
     * newest. There is no Resume.
     */
    readonly restore: (
      threadId: ThreadId,
    ) => Effect.Effect<GameRoundStore.GameRestore, GameOperationError>;
  }
>()("t3/game/GameRepairLoop") {}

export interface GameRepairLoopOptions {
  readonly stateDir: string;
  /** Test seam: the whole-loop deadline. Defaults to the persisted budget. */
  readonly budget?: typeof DEFAULT_GAME_REVIEW_BUDGET | undefined;
  /** Test seam: how long a supersession waits for its child to stop. */
  readonly childJoinTimeoutMs?: number | undefined;
  /** Test seam: the wall clock the budget is judged against, in epoch ms. */
  readonly now?: (() => number) | undefined;
}

export const layer = (options: GameRepairLoopOptions) => {
  const budget = options.budget ?? DEFAULT_GAME_REVIEW_BUDGET;
  const childJoinTimeoutMs = options.childJoinTimeoutMs ?? DEFAULT_CHILD_JOIN_TIMEOUT_MS;
  const now = options.now ?? nowMs;

  const make = Effect.gen(function* () {
    const projects = yield* GameProjectService.GameProjectService;
    const rounds = yield* GameRoundStore.GameRoundStore;
    const sessions = yield* GameReviewSessions.GameReviewSessions;
    const studio = yield* GameRepairStudio.GameRepairStudio;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const admission = yield* GameAdmission.GameAdmission;
    const scope = yield* Effect.scope;
    const operations = yield* GameOperations.GameOperations;
    const preview = yield* GamePreview.GamePreview;
    const phases = new Map<string, string>();
    const progress = (root: string, phase: string) =>
      Effect.gen(function* () {
        phases.set(root, phase);
        yield* operations.changed(root, phase);
      });

    /**
     * A game this service holds. It stays held after its fiber ends until every
     * child the loop recorded is verified terminal; a restart re-arms it with
     * no fiber from the recorded children alone.
     */
    interface Live {
      readonly fiber: Fiber.Fiber<void, never> | null;
      readonly loopId: string;
      readonly entry: GameAdmission.GameAdmissionEntry;
    }
    const live = new Map<string, Live>();

    const location = (root: string) =>
      gameRecordLocation(options.stateDir, "game-repair-loops", root);
    const attempt = <A>(operation: string, path: string, work: () => Promise<A>) =>
      Effect.tryPromise({
        try: work,
        catch: (cause) =>
          new GameOperationError({
            operation,
            path,
            reason: "io",
            ...(cause instanceof Error ? { detail: cause.message } : {}),
            cause,
          }),
      });
    const readFile = (file: string) =>
      attempt("read game repair loop", file, async () => {
        const text = await readRecordText(file);
        if (text === null) return null;
        return decodeStoredLoops(text).loops;
      });

    const readRecord = (root: string) =>
      Effect.gen(function* () {
        const found = yield* attempt("read game repair loop", root, () => location(root));
        const loops = (yield* readFile(found.file).pipe(Effect.orElseSucceed(() => []))) ?? [];
        return loops[0] ?? null;
      });

    const save = (root: string, record: GameRepairLoopRecord) =>
      Effect.gen(function* () {
        const found = yield* attempt("write game repair loop", root, () => location(root));
        const existing = (yield* readFile(found.file).pipe(Effect.orElseSucceed(() => []))) ?? [];
        const loops = [record, ...existing.filter((entry) => entry.id !== record.id)].slice(
          0,
          MAX_STORED_LOOPS,
        );
        yield* attempt("write game repair loop", found.file, async () => {
          await NodeFSP.mkdir(NodePath.dirname(found.file), { recursive: true });
          const temporary = `${found.file}.${NodeCrypto.randomUUID()}.tmp`;
          try {
            await NodeFSP.writeFile(
              temporary,
              `${JSON.stringify({ schemaVersion: 2, loops }, null, 2)}\n`,
            );
            await NodeFSP.rename(temporary, found.file);
          } finally {
            await NodeFSP.rm(temporary, { force: true });
          }
        });
        yield* operations.changed(root, record.reason ?? "Review updated.");
        return record;
      });

    /** Reads the newest record again, then persists the update derived from it. */
    const patch = (
      root: string,
      update: (record: GameRepairLoopRecord) => GameRepairLoopRecord,
    ): Effect.Effect<GameRepairLoopRecord, GameOperationError> =>
      Effect.gen(function* () {
        const current = yield* readRecord(root);
        if (current === null)
          return yield* new GameOperationError({
            operation: "update game repair loop",
            path: root,
            reason: "invalid-input",
            detail: "The game has no review loop record.",
          });
        return yield* save(root, update(current));
      });

    const logFailure = (message: string, cause: unknown) => Effect.logWarning(message, { cause });

    const findRound = (root: string, roundId: string) =>
      Effect.gen(function* () {
        const state = yield* rounds.read(root).pipe(Effect.orElseSucceed(() => null));
        return state?.rounds.find((round) => round.id === roundId) ?? null;
      });

    /**
     * The newest declaration a turn made. A submission is scoped to its run, so
     * a later text-only turn can never inherit the previous turn's build.
     */
    const submissionForRun = (root: string, runId: RunId | null) =>
      runId === null
        ? Effect.succeed(null)
        : rounds.read(root).pipe(
            Effect.map(
              (state) =>
                (state.submissions ?? []).findLast(
                  (entry) => String(entry.runId) === String(runId),
                ) ?? null,
            ),
            Effect.orElseSucceed(() => null),
          );

    const stopOpenRound = (root: string, reason: string) =>
      rounds.stopRunning(root, reason).pipe(
        Effect.catchCause((cause) => logFailure("stopping the open review round failed", cause)),
        Effect.asVoid,
      );

    /** Stops an owned child and reports whether it actually settled. */
    const interruptChild = (child: OwnedChild, reason: string): Effect.Effect<boolean, never> =>
      Effect.gen(function* () {
        const shell = yield* threads
          .getThreadShell(child.childThreadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (shell === null) return true;
        yield* threads
          .interruptThread({
            projectId: shell.projectId,
            commandId: CommandId.make(
              `game-repair-cancel:${String(child.childThreadId)}:${child.label}`,
            ),
            threadId: child.childThreadId,
            ...(child.runId === null ? {} : { runId: child.runId }),
            reason,
          })
          .pipe(
            Effect.catchCause((cause) => logFailure("cancelling a review child failed", cause)),
          );
        // A supersession is only safe once the writer stopped. A child that
        // ignores its interrupt fails the creator action instead of racing it.
        const joined = yield* threads
          .waitForThread({
            projectId: shell.projectId,
            threadId: child.childThreadId,
            ...(child.runId === null ? {} : { runId: child.runId }),
            timeoutMs: childJoinTimeoutMs,
          })
          .pipe(
            Effect.timeoutOption(Duration.millis(childJoinTimeoutMs + 1_000)),
            Effect.orElseSucceed(() => Option.none()),
          );
        return Option.isSome(joined) && !joined.value.timedOut;
      }).pipe(Effect.catchCause(() => Effect.succeed(false)));

    /**
     * Whether the child thread's bound run has actually reached a terminal
     * status. A thread that was never created wrote nothing.
     */
    const childIsTerminal = (
      child: GameReviewSessions.GameReviewRecordedChild,
    ): Effect.Effect<boolean, never> =>
      threads.getThreadShell(child.childThreadId).pipe(
        Effect.flatMap((shell) =>
          shell === null
            ? Effect.succeed(null)
            : threads.getThreadRecords(child.childThreadId, ["runs"]),
        ),
        Effect.map((records) => {
          if (records === null) return true;
          const run =
            child.runId === null
              ? records.runs.at(-1)
              : records.runs.find((candidate) => candidate.id === child.runId);
          if (run === undefined) return true;
          return (
            run.status === "completed" ||
            run.status === "failed" ||
            run.status === "cancelled" ||
            run.status === "interrupted" ||
            run.status === "rolled_back"
          );
        }),
        Effect.orElseSucceed(() => false),
      );

    /**
     * Stops every child the loop recorded and reports whether all of them are
     * terminal. Only this verdict releases a game: a fiber ending, a timeout or
     * a failed confirmation write proves nothing about a child's writes.
     */
    const settleChildren = (
      root: string,
      loopId: string,
      reason: string,
    ): Effect.Effect<boolean, never> =>
      Effect.gen(function* () {
        const recorded = yield* sessions.recordedChildren({ root, loopId });
        let settled = true;
        for (const child of recorded) {
          if (yield* childIsTerminal(child)) continue;
          yield* interruptChild({ ...child, label: "settle" }, reason);
          if (!(yield* childIsTerminal(child))) settled = false;
        }
        return settled;
      }).pipe(Effect.catchCause(() => Effect.succeed(false)));

    /** Provider-turn usage of one child, or null when it did not report any. */
    const usageOf = (
      child: OwnedChild,
    ): Effect.Effect<
      {
        readonly providerTurns: number;
        readonly usedTokens: number;
        readonly inputTokens: number;
        readonly outputTokens: number;
      } | null,
      never
    > =>
      threads.getThreadRecords(child.childThreadId, ["providerTurns"]).pipe(
        Effect.map((records) => {
          const turns = records.providerTurns;
          if (turns.length === 0) return null;
          let used = 0;
          let input = 0;
          let output = 0;
          for (const turn of turns) {
            const usage = turn.tokenUsage;
            if (usage === undefined) return null;
            used += usage.usedTokens;
            input += usage.inputTokens ?? 0;
            output += usage.outputTokens ?? 0;
          }
          return {
            providerTurns: turns.length,
            usedTokens: used,
            inputTokens: input,
            outputTokens: output,
          };
        }),
        Effect.orElseSucceed(() => null),
      );

    const sumUsage = (entries: ReadonlyArray<GameReviewUsage>): GameReviewUsage => {
      const counted = entries.every((entry) => entry.recipeCalls !== undefined)
        ? entries.reduce((sum, entry) => sum + (entry.recipeCalls ?? 0), 0)
        : undefined;
      return {
        status:
          entries.length > 0 && entries.every((entry) => entry.status === "measured")
            ? "measured"
            : "unknown",
        providerTurns: entries.reduce((sum, entry) => sum + entry.providerTurns, 0),
        usedTokens: entries.reduce((sum, entry) => sum + entry.usedTokens, 0),
        inputTokens: entries.reduce((sum, entry) => sum + entry.inputTokens, 0),
        outputTokens: entries.reduce((sum, entry) => sum + entry.outputTokens, 0),
        ...(counted === undefined ? {} : { recipeCalls: counted }),
      };
    };

    const recordUsage = (
      task: Task,
      child: OwnedChild,
      input: {
        readonly roundId: string;
        readonly role: GameReviewSessions.GameReviewTaskRole;
        readonly order: number;
      },
      measured: boolean,
    ): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const usage = measured ? yield* usageOf(child) : null;
        const calls =
          child.runId === null
            ? null
            : yield* sessions
                .inputCalls(child.childThreadId, child.runId)
                .pipe(Effect.orElseSucceed(() => null));
        const recipeCalls = yield* sessions.recipeCalls(child.childThreadId);
        const round = yield* findRound(task.root, input.roundId);
        if (round === null || round.status !== "running") return;
        const entry: GameReviewChildUsage = {
          role: input.role,
          order: input.order,
          childThreadId: child.childThreadId,
          runId: child.runId,
          tryInputCalls: calls,
          usage: {
            ...(usage === null ? EMPTY_GAME_REVIEW_USAGE : { status: "measured", ...usage }),
            ...(recipeCalls === null ? {} : { recipeCalls }),
          },
        };
        const children = [
          ...(round.childUsage ?? []).filter(
            (entry) => entry.childThreadId !== child.childThreadId || entry.runId !== child.runId,
          ),
          entry,
        ];
        const heavy = sumUsage(
          children.filter((entry) => (entry.tryInputCalls ?? 0) > 0).map((entry) => entry.usage),
        );
        yield* rounds.recordReview(task.root, input.roundId, {
          childUsage: children,
          usageByRole: {
            critic: sumUsage(
              children.filter((entry) => entry.role === "critic").map((entry) => entry.usage),
            ),
            repair: sumUsage(
              children.filter((entry) => entry.role === "repair").map((entry) => entry.usage),
            ),
            ballot: sumUsage(
              children.filter((entry) => entry.role === "ballot").map((entry) => entry.usage),
            ),
            "try_input-heavy": children.some((entry) => entry.tryInputCalls === null)
              ? { ...heavy, status: "unknown" }
              : heavy,
          },
        });
        const all = yield* rounds.read(task.root);
        yield* patch(task.root, (record) => ({
          ...record,
          usage: sumUsage(
            all.rounds
              .filter((round) => round.loopId === record.id)
              .flatMap((round) => round.childUsage ?? [])
              .map((entry) => entry.usage),
          ),
          updatedAt: nowIso(),
        }));
      }).pipe(
        task.usageWrite.withPermits(1),
        Effect.catchCause((cause) => logFailure("recording review usage failed", cause)),
        Effect.asVoid,
      );

    /** Freeze phase caps from this round's opening budget, not the original loop allowance. */
    const phasePlan = (
      record: GameRepairLoopRecord,
      phase: GameReviewAttemptPolicy.ReviewPhase,
      roundBudgetMs: number,
    ) =>
      GameReviewAttemptPolicy.planReviewPhase({
        phase,
        remainingMs: remainingBudget(record, now()).elapsedMs,
        totalBudgetMs: Math.min(record.budget.elapsedMs, roundBudgetMs),
      });

    const withinPhase = <A, E>(effect: Effect.Effect<A, E>, allowanceMs: number) =>
      effect.pipe(Effect.timeoutOption(Duration.millis(Math.max(1, allowanceMs))));

    const answerDetail = (
      answer: GameReviewSessions.GameReviewSessionAnswerResult | null,
    ): string | undefined => {
      if (answer === null || answer.kind === "critic" || answer.kind === "ballot") return undefined;
      return answer.kind === "invalid" ? answer.reason : "the child left no terminal answer.";
    };

    const answerReadiness = (
      answer: GameReviewSessions.GameReviewSessionAnswerResult | null,
    ): GameReviewAttemptPolicy.ReviewAnswerReadiness =>
      answer === null
        ? "missing"
        : answer.kind === "critic" || answer.kind === "ballot"
          ? "usable"
          : "unusable";

    const answerExhausted = (
      answer: GameReviewSessions.GameReviewSessionAnswerResult | null,
    ): boolean => answer !== null && answer.kind === "invalid" && answer.exhausted === true;

    /**
     * One reading of a child's end for every role. A usable recorded answer or
     * an actual candidate is judgment even when the provider ended failed; no
     * evidence from such an end is infrastructure, not a game result. A phase
     * cap the loop itself joined may also have left that evidence on disk.
     * An exhausted tool record is the review's own invalid output, never a
     * user cancellation, so its last validation error rides as the detail.
     */
    const attemptVerdict = (
      role: GameReviewAttemptPolicy.ReviewAttemptRole,
      child: ChildOutcome,
      answer: GameReviewSessions.GameReviewSessionAnswerResult | null = null,
      hasCandidate = false,
    ): GameReviewAttemptPolicy.ReviewAttemptVerdict => {
      if (child.kind === "expired")
        return GameReviewAttemptPolicy.classifyReviewAttempt(role, {
          kind: "expired",
          settled: child.settled,
          evidence:
            role === "repair" ? (hasCandidate ? "usable" : "missing") : answerReadiness(answer),
        });
      if (child.kind === "failed")
        return GameReviewAttemptPolicy.classifyReviewAttempt(role, {
          kind: "unstarted",
          detail: child.reason,
        });
      const detail = answerDetail(answer);
      const exhausted = answerExhausted(answer);
      return GameReviewAttemptPolicy.classifyReviewAttempt(role, {
        kind: "terminal",
        status: child.status,
        answer: answerReadiness(answer),
        hasCandidate,
        ...(detail === undefined ? {} : { detail }),
        ...(exhausted ? { exhausted: true as const } : {}),
      });
    };

    const infrastructureReason = (reason: string) =>
      `review-infrastructure: ${reason}; the selected build is kept.`;

    /**
     * Waits for a review child inline. The wait is taken after `start` returns
     * (only then is the bound run known), but it captures the thread's event
     * sequence before reading the run, so a child that finished in that window
     * is observed rather than lost.
     */
    const awaitChild = (
      task: Task,
      record: GameRepairLoopRecord,
      input: {
        readonly role: GameReviewSessions.GameReviewTaskRole;
        readonly order: number;
        readonly roundId: string;
        /** A hard phase bound; the loop deadline still applies on top. */
        readonly allowanceMs: number;
        readonly evidence?: GameReviewSessions.GameReviewEvidenceInput | undefined;
        readonly repair?: GameReviewSessions.GameReviewRepairInput | undefined;
        readonly items?: ReadonlyArray<{ readonly id: string; readonly what: string }> | undefined;
        readonly defects?: GameReviewSessions.GameReviewSessionStartInput["defects"] | undefined;
      },
    ): Effect.Effect<ChildOutcome, GameOperationError> =>
      Effect.gen(function* () {
        const remaining = remainingBudget(record, now()).elapsedMs;
        const key = ownedKey(input.role, input.order);
        if (remaining <= 0)
          return {
            kind: "expired",
            child: null,
            settled: false,
          } as const;
        const timeoutMs = Math.max(1, Math.min(input.allowanceMs, remaining));
        // Starting the child and recording ownership is one uninterruptible
        // step: an interrupt between the dispatch commit and the Ref write
        // would otherwise release a child the loop no longer knew it owned.
        // Ownership is keyed by role:order so a sibling completing first
        // can never clear this child's ownership.
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const started = yield* sessions.start({
              threadId: record.threadId,
              loopId: record.id,
              roundId: input.roundId,
              role: input.role,
              order: input.order,
              // The immutable origin run, never whichever run is newest.
              runId: record.originatingRunId,
              nodeId: record.originatingNodeId as NodeId,
              ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
              ...(input.repair === undefined ? {} : { repair: input.repair }),
              ...(input.items === undefined ? {} : { items: input.items }),
              ...(input.defects === undefined ? {} : { defects: input.defects }),
            });
            if (started.kind !== "started")
              return { kind: "failed", reason: started.reason } as const;
            const child: OwnedChild = {
              childThreadId: started.childThreadId,
              runId: started.runId,
              label: `${input.role}:${input.order}`,
            };
            yield* Ref.update(task.owned, (current) => new Map(current).set(key, child));
            yield* recordUsage(task, child, input, false);
            const shell = yield* threads
              .getThreadShell(started.childThreadId)
              .pipe(Effect.orElseSucceed(() => null));
            if (shell === null) {
              yield* ownedRemove(task, key);
              return {
                kind: "failed",
                reason: "The review child thread vanished before it could be awaited.",
              } as const;
            }
            const waited = yield* restore(
              threads
                .waitForThread({
                  projectId: shell.projectId,
                  threadId: started.childThreadId,
                  ...(started.runId === null ? {} : { runId: started.runId }),
                  timeoutMs,
                })
                .pipe(
                  Effect.onInterrupt(() =>
                    interruptChild(child, "The review was superseded.").pipe(
                      Effect.flatMap((settled) =>
                        Effect.gen(function* () {
                          yield* recordUsage(task, child, input, settled);
                          if (settled) yield* ownedRemove(task, key);
                        }),
                      ),
                    ),
                  ),
                  Effect.mapError(
                    (cause) =>
                      new GameOperationError({
                        operation: "await game review child",
                        path: task.root,
                        reason: "thread-dispatch",
                        detail: String(cause),
                        cause,
                      }),
                  ),
                ),
            );
            if (waited.timedOut) {
              // A phase cut must not leave an orphan writer: join the child
              // before the loop restores or releases the game.
              const settled = yield* interruptChild(
                child,
                "The review phase allowance ended before the child finished.",
              );
              yield* recordUsage(task, child, input, settled);
              if (settled) yield* ownedRemove(task, key);
              return { kind: "expired", child, settled } as const;
            }
            const status = yield* sessions.runStatus({
              threadId: record.threadId,
              loopId: record.id,
              roundId: input.roundId,
              role: input.role,
              order: input.order,
            });
            yield* ownedRemove(task, key);
            yield* recordUsage(task, child, input, true);
            if (status.kind === "missing")
              return {
                kind: "failed",
                reason: "The review child's session record is missing.",
              } as const;
            if (status.kind === "pending")
              return {
                kind: "failed",
                reason: "The review child ended without a bound run.",
              } as const;
            return { kind: "terminal", status: status.status, child } as const;
          }),
        );
      });

    /** Writes the loop terminal record; never rewrites an already finished loop. */
    const finish = (input: {
      readonly root: string;
      readonly decision: "promote" | "stop" | "interrupt";
      readonly reason: string;
    }): Effect.Effect<GameRepairLoopRecord | null, never> =>
      Effect.gen(function* () {
        const current = yield* readRecord(input.root).pipe(Effect.orElseSucceed(() => null));
        if (current === null) return null;
        if (current.status !== "running") return current;
        const state = yield* rounds.read(input.root).pipe(Effect.orElseSucceed(() => null));
        const open = state?.rounds.find(
          (round) => round.loopId === current.id && round.status === "running",
        );
        if (
          open?.postRepairSourceId != null &&
          (yield* settleChildren(input.root, current.id, input.reason))
        ) {
          yield* rounds
            .reject(input.root, open.id, {
              reason: input.reason,
              decision: "stop",
              preserveDirectories: preview.directories(input.root),
            })
            .pipe(
              Effect.catchCause((cause) => logFailure("restoring a stopped review failed", cause)),
            );
        }
        yield* stopOpenRound(input.root, input.reason);
        const at = nowIso();
        return yield* save(input.root, {
          ...current,
          status: input.decision === "interrupt" ? "interrupted" : "stopped",
          finishedAt: at,
          updatedAt: at,
          decision: input.decision,
          reason: input.reason,
        }).pipe(Effect.orElseSucceed(() => current));
      }).pipe(
        Effect.catchCause((cause) =>
          logFailure("finishing a review loop failed", cause).pipe(Effect.as(null)),
        ),
      );

    const stop = (root: string, reason: string) =>
      finish({ root, decision: "stop", reason }).pipe(Effect.as(true));

    const interrupted = (root: string, reason: string) =>
      finish({ root, decision: "interrupt", reason }).pipe(Effect.as(true));

    const rejectRound = (
      record: GameRepairLoopRecord,
      roundId: string,
      reason: string,
    ): Effect.Effect<RoundOutcome, GameOperationError> =>
      Effect.gen(function* () {
        const rejected = yield* rounds
          .reject(record.root, roundId, {
            reason,
            preserveDirectories: preview.directories(record.root),
          })
          .pipe(
            Effect.map((result) => result.kind),
            Effect.orElseSucceed(() => "blocked" as const),
          );
        if (rejected === "blocked") {
          // The folder changed under the repair; restoring would discard a user
          // edit, so the loop stops and leaves the restore to its owner.
          const stopped = yield* finish({
            root: record.root,
            decision: "stop",
            reason: `reject-blocked: ${reason}`,
          });
          return { record: stopped ?? record, done: true };
        }
        return {
          record: yield* patch(record.root, (current) => ({ ...current, updatedAt: nowIso() })),
          done: false,
        };
      });

    const ballotEvidence = (
      incumbentFrames: ReadonlyArray<GameRepairFrame>,
      candidateFrames: ReadonlyArray<GameRepairFrame>,
      incumbentChecks: ReadonlyArray<GameReviewCheck>,
      candidateChecks: ReadonlyArray<GameReviewCheck>,
      plan: GameReviewBallotPlan,
      experiments: ReadonlyArray<BallotExperimentPair>,
      inputs: GameRepairLoopRecord["inputs"],
      defects: ReadonlyArray<GameReviewDefect>,
    ) => {
      const experimentFrames = (side: "incumbent" | "challenger") =>
        experiments.flatMap((pair) => (side === "challenger" ? pair.candidate : pair.incumbent));
      // Defect witnesses win the frozen budget. Ordinary citations name the
      // incumbent's fN ids, so the candidate's cN frames are matched by causal
      // route prefix (viewport plus the steps through the cited input), never
      // by id string. Try citations are already replayed as experiments and
      // windows already survive as shape evidence, so neither needs a frozen
      // slot. When many defects exhaust the frozen budget only the first
      // fitting pairs are shown; the ballot still lists every defect and judges
      // a missing witness cannot-tell instead of claiming full coverage, and
      // preservation filler never displaces a shown defect.
      const defectKeys = (() => {
        const byId = new Map(incumbentFrames.map((frame) => [frame.id, frame]));
        const seen = new Set<string>();
        const keys: string[] = [];
        for (const defect of defects) {
          if (defect.frameId.startsWith("try")) continue;
          const cited = byId.get(defect.frameId);
          if (cited === undefined || cited.window === true) continue;
          const key =
            cited.inputPair === undefined
              ? `label:${cited.label}`
              : inputRouteKey({ steps: inputs.steps }, cited.inputPair.stepIndex, inputs.viewport);
          if (!seen.has(key)) {
            seen.add(key);
            keys.push(key);
          }
        }
        return keys;
      })();
      const replayed = new Set(experiments.map((entry) => entry.key));
      const frozenKeys = defectKeys.filter((key) => !replayed.has(key));
      const restFor = (frozen: ReadonlyArray<GameRepairFrame>) =>
        frozen.filter(
          (frame) =>
            frame.window !== true &&
            (frame.inputPair === undefined ||
              !replayed.has(
                inputRouteKey({ steps: inputs.steps }, frame.inputPair.stepIndex, inputs.viewport),
              )),
        );
      const shapedFor = (frozen: ReadonlyArray<GameRepairFrame>) =>
        frozen.filter((frame) => frame.window === true);
      const groupRest = (rest: ReadonlyArray<GameRepairFrame>) => {
        const groups: Array<{ readonly key: string; readonly frames: GameRepairFrame[] }> = [];
        const byKey = new Map<string, GameRepairFrame[]>();
        for (const frame of rest) {
          const key =
            frame.inputPair === undefined
              ? `label:${frame.label}`
              : inputRouteKey({ steps: inputs.steps }, frame.inputPair.stepIndex, inputs.viewport);
          let group = byKey.get(key);
          if (group === undefined) {
            group = [];
            byKey.set(key, group);
            groups.push({ key, frames: group });
          }
          group.push(frame);
        }
        return { groups, byKey };
      };
      const restIncumbent = restFor(incumbentFrames);
      const restCandidate = restFor(candidateFrames);
      const groupedIncumbent = groupRest(restIncumbent);
      const groupedCandidate = groupRest(restCandidate);
      const commonDefectKeys = frozenKeys.filter(
        (key) => groupedIncumbent.byKey.has(key) && groupedCandidate.byKey.has(key),
      );
      const budgetFor = (shapedLength: number) =>
        Math.max(0, BALLOT_FRAMES_PER_SIDE - shapedLength);
      const budgetIncumbent = budgetFor(shapedFor(incumbentFrames).length);
      const budgetCandidate = budgetFor(shapedFor(candidateFrames).length);
      // The same defect set must appear on both builds, so the tighter budget
      // decides which prefix of the ordered defect pairs is shown.
      const shownDefectKeys: string[] = [];
      let incumbentDefectCount = 0;
      let candidateDefectCount = 0;
      for (const key of commonDefectKeys) {
        const incumbentSize = groupedIncumbent.byKey.get(key)!.length;
        const candidateSize = groupedCandidate.byKey.get(key)!.length;
        if (
          incumbentDefectCount + incumbentSize > budgetIncumbent ||
          candidateDefectCount + candidateSize > budgetCandidate
        )
          break;
        shownDefectKeys.push(key);
        incumbentDefectCount += incumbentSize;
        candidateDefectCount += candidateSize;
      }
      const shownDefects = new Set(shownDefectKeys);
      const selectRest = (
        rest: ReadonlyArray<GameRepairFrame>,
        grouped: ReturnType<typeof groupRest>,
        budget: number,
        defectCount: number,
      ): ReadonlyArray<GameRepairFrame> => {
        const selectedKeys = new Set(shownDefects);
        let used = defectCount;
        for (const group of grouped.groups) {
          if (selectedKeys.has(group.key)) continue;
          if (used + group.frames.length > budget) break;
          selectedKeys.add(group.key);
          used += group.frames.length;
        }
        const wanted = new Set<GameRepairFrame>();
        for (const group of grouped.groups) {
          if (!selectedKeys.has(group.key)) continue;
          for (const frame of group.frames) wanted.add(frame);
        }
        return rest.filter((frame) => wanted.has(frame));
      };
      const buildFrames = (side: "incumbent" | "challenger") => {
        const frozen = side === "challenger" ? candidateFrames : incumbentFrames;
        const shaped = shapedFor(frozen);
        const rest = side === "challenger" ? restCandidate : restIncumbent;
        const grouped = side === "challenger" ? groupedCandidate : groupedIncumbent;
        const budget = side === "challenger" ? budgetCandidate : budgetIncumbent;
        const defectCount = side === "challenger" ? candidateDefectCount : incumbentDefectCount;
        return ballotFrames([
          ...experimentFrames(side),
          ...selectRest(rest, grouped, budget, defectCount),
          ...shaped,
        ]);
      };
      const buildChecks = (side: "incumbent" | "challenger") =>
        side === "challenger" ? candidateChecks : incumbentChecks;
      const frames = ["A", "B"].flatMap((label) => {
        const side = label as "A" | "B";
        return assignmentFrames(buildFrames(plan.main[side]), side.toLowerCase() as "a" | "b");
      });
      const controls = ["C", "D"].flatMap((label) => {
        const side = label as "C" | "D";
        return assignmentFrames(buildFrames("incumbent"), side.toLowerCase() as "c" | "d");
      });
      const checks = [
        ...sideChecks(buildChecks(plan.main.A), "a"),
        ...sideChecks(buildChecks(plan.main.B), "b"),
        ...sideChecks(incumbentChecks, "c"),
        ...sideChecks(incumbentChecks, "d"),
      ];
      return { frames: [...frames, ...controls], checks };
    };

    /**
     * What the next repair must not repeat: the last rejected round of this
     * same loop, with its concrete failed checks. It is round history, not
     * durable game memory, and it is bounded so the brief stays dominant.
     */
    const previousRejectionFor = (
      root: string,
      loopId: string,
      roundId: string,
    ): Effect.Effect<string | undefined, GameOperationError> =>
      Effect.gen(function* () {
        const state = yield* rounds.read(root);
        const rejected = state.rounds.find(
          (entry) => entry.loopId === loopId && entry.id !== roundId && entry.status === "rejected",
        );
        if (rejected === undefined) return undefined;
        const failedChecks = (rejected.candidateChecks ?? []).filter(
          (check) => check.status === "failed",
        );
        const text = [
          rejected.reason ?? "The previous attempt was rejected.",
          ...failedChecks.map(
            (check) =>
              `failed check ${check.id}${check.detail === undefined ? "" : `: ${check.detail}`}`,
          ),
        ].join("\n");
        return text.length <= MAX_PREVIOUS_REJECTION_CHARS
          ? text
          : `${text.slice(0, MAX_PREVIOUS_REJECTION_CHARS - 1)}…`;
      });

    /** Replay every cited point on both builds before adding the frozen route. */
    const replayExperimentPairs = (input: {
      readonly threadId: ThreadId;
      readonly root: string;
      readonly incumbentBuildId: string | null;
      readonly candidateBuildId: string;
      readonly experiments: ReadonlyArray<GameReviewExperimentRoute>;
      readonly defects: ReadonlyArray<GameReviewDefect>;
      readonly doNotRegress: ReadonlyArray<GameReviewDoNotRegress>;
    }): Effect.Effect<ReadonlyArray<BallotExperimentPair>, GameOperationError> =>
      Effect.gen(function* () {
        if (input.experiments.length === 0 || input.incumbentBuildId === null) return [];
        const pairs: BallotExperimentPair[] = [];
        const seenPairs = new Set<string>();
        const seenObservations = new Set<string>();
        for (const route of input.experiments) {
          const run = (buildId: string) =>
            studio.experiment({
              threadId: input.threadId,
              root: input.root,
              buildId,
              steps: route.steps,
              ...(route.setupSteps === undefined ? {} : { setupSteps: [...route.setupSteps] }),
              captureEveryMs: route.captureEveryMs,
              viewport: route.viewport,
            });
          const incumbent = yield* run(input.incumbentBuildId);
          const candidate = yield* run(input.candidateBuildId);
          for (const citation of route.frames) {
            const stepIndex = citation.stepIndex;
            const observationMs =
              citation.observationMs ?? playtestIntervalObservation(citation.label)?.elapsedMs;
            const kinds: ReadonlyArray<"pair" | "observation"> =
              stepIndex === null
                ? ["observation"]
                : observationMs === undefined
                  ? ["pair"]
                  : ["pair", "observation"];
            for (const kind of kinds) {
              const routeKey =
                stepIndex === null
                  ? `${route.id}:${citation.frameId}`
                  : inputRouteKey(route, stepIndex, route.viewport);
              const key =
                kind === "pair"
                  ? routeKey
                  : `${routeKey}:observation:${observationMs ?? citation.label}`;
              const seen = kind === "pair" ? seenPairs : seenObservations;
              if (seen.has(key)) continue;
              const before = experimentFrames(incumbent.frames, route, citation, kind);
              const after = experimentFrames(candidate.frames, route, citation, kind);
              if (before.length === 0 || after.length === 0)
                return yield* new GameOperationError({
                  operation: "replay critic experiment",
                  path: input.root,
                  reason: "invalid-input",
                  detail: `Experiment ${route.id} has no matched ${kind} evidence for step ${stepIndex === null ? "boot" : stepIndex + 1}.`,
                });
              seen.add(key);
              pairs.push({ key, incumbent: before, candidate: after });
            }
          }
        }
        return pairs;
      });

    const decide = (
      record: GameRepairLoopRecord,
      round: GameReviewRoundRecord,
    ): Effect.Effect<RoundOutcome, GameOperationError> =>
      Effect.gen(function* () {
        const answers = round.ballotAnswers ?? [];
        const invalid = answers.find((answer) => answer.outcome === "invalid");
        if (invalid !== undefined)
          return yield* rejectRound(
            record,
            round.id,
            `invalid-ballot: ${invalid.reason ?? "the ballot answer was unusable."}`,
          );
        const plans = round.ballots ?? [];
        if (
          plans.length !== 2 ||
          !plans.some((plan) => plan.order === 0) ||
          !plans.some((plan) => plan.order === 1)
        )
          return yield* rejectRound(
            record,
            round.id,
            "invalid-ballot: both opposite-order pairwise sessions are required.",
          );
        for (const plan of plans) {
          const entry = answers.find((answer) => answer.order === plan.order);
          if (entry?.answer === undefined)
            return yield* rejectRound(
              record,
              round.id,
              `invalid-ballot: ballot ${plan.order} has no usable answer.`,
            );
          const reason = ballotReason(entry.answer, plan);
          if (reason !== null) return yield* rejectRound(record, round.id, reason);
        }
        if (answers.length < plans.length)
          return yield* rejectRound(
            record,
            round.id,
            "invalid-ballot: both pairwise sessions must answer before a decision.",
          );
        const losses = plans.map((plan) =>
          challengerLosses(answers.find((entry) => entry.order === plan.order)!.answer!, plan),
        );
        const confirmedLoss = losses[0]!.find((id) => losses[1]!.includes(id));
        if (confirmedLoss !== undefined)
          return yield* rejectRound(
            record,
            round.id,
            `preservation-lost: both ballots saw ${confirmedLoss} lost on the challenger.`,
          );
        const overallWin = plans.every((plan) => {
          const answer = answers.find((entry) => entry.order === plan.order)!.answer!;
          return (
            answer.overall !== "tie" &&
            answer.overall !== undefined &&
            plan.main[answer.overall] === "challenger"
          );
        });
        const defectWin =
          (round.defects?.length ?? 0) > 0 &&
          plans.every((plan) => {
            const answer = answers.find((entry) => entry.order === plan.order)!.answer!;
            const defects = answer.defects ?? [];
            const challenger = plan.main.A === "challenger" ? "A" : "B";
            const incumbent = challenger === "A" ? "B" : "A";
            return (
              defects.length === round.defects!.length &&
              defects.filter((entry) => entry[challenger].fixed === "yes").length >
                defects.filter((entry) => entry[incumbent].fixed === "yes").length
            );
          });
        const agreedRegression = plans.every((plan) => {
          const answer = answers.find((entry) => entry.order === plan.order)!.answer!;
          const challenger = plan.main.A === "challenger" ? "A" : "B";
          return (answer.regressions?.[challenger].length ?? 0) > 0;
        });
        if (!overallWin && (!defectWin || agreedRegression)) {
          const plan = plans.find((entry) => {
            const answer = answers.find((answer) => answer.order === entry.order)!.answer!;
            return (
              answer.overall === "tie" ||
              (answer.overall !== undefined && entry.main[answer.overall] !== "challenger")
            );
          })!;
          const answer = answers.find((entry) => entry.order === plan.order)!.answer!;
          return yield* rejectRound(
            record,
            round.id,
            agreedRegression
              ? "regression: both ballots found something worse on the challenger."
              : answer.overall === "tie"
                ? `tie: ballot ${plan.order} found no overall improvement.`
                : `worse-build: ballot ${plan.order} preferred the incumbent overall.`,
          );
        }
        // The veto is recomputed from the round's persisted checks immediately
        // before the selection moves, so no crash boundary can skip it.
        const current = yield* findRound(record.root, round.id);
        if (current === null)
          return yield* rejectRound(record, round.id, "invalid-state: the round vanished.");
        const veto = mechanicalVeto(
          current.checks ?? [],
          current.candidateChecks ?? [],
          current.doNotRegress ?? [],
        );
        if (veto !== null)
          return yield* rejectRound(record, round.id, `mechanical-veto: ${vetoReason(veto)}`);
        // Validation and the selection commit hold the admission gate, so a
        // user action either lands first (and this fiber is interrupted while
        // it waits) or after the selection; it can never bump the generation
        // between this check and the commit.
        const promoted = yield* admission.withGate(
          record.root,
          Effect.gen(function* () {
            const stamp = yield* admission.stamp(record.root);
            if (stamp.generation !== record.generation) return { kind: "superseded" } as const;
            return yield* studio.promote(
              record.threadId,
              round.id,
              // The whole-loop timeout cannot interrupt the commit, so the
              // deadline and the generation are judged again at the commit.
              Effect.gen(function* () {
                if (remainingBudget(record, now()).elapsedMs <= 0)
                  return "deadline: the review budget ran out before the selection was written.";
                const committing = yield* admission.stamp(record.root);
                return committing.generation === record.generation
                  ? null
                  : "superseded: a user action took the game before the selection was written.";
              }).pipe(
                Effect.catchCause(() =>
                  Effect.succeed("The game admission record could not be read at the commit."),
                ),
              ),
            );
          }),
        );
        if (promoted.kind === "superseded")
          return yield* rejectRound(
            record,
            round.id,
            "superseded: a user action took the game before the challenger was selected.",
          );
        if (promoted.kind === "blocked") {
          const stopped = yield* finish({
            root: record.root,
            decision: "stop",
            reason: `promotion-blocked: ${promoted.detail}`,
          });
          return { record: stopped ?? record, done: true };
        }
        const latest = yield* patch(record.root, (entry) => ({
          ...entry,
          promotedRounds: [...entry.promotedRounds, round.id],
          updatedAt: nowIso(),
        }));
        // A promoted build is the new incumbent; the next round reviews it.
        return { record: latest, done: false };
      });

    const playRound = (
      task: Task,
      opened: GameRepairLoopRecord,
    ): Effect.Effect<RoundOutcome, GameOperationError> =>
      Effect.gen(function* () {
        let record = opened;
        // A user action between rounds ends the loop before it opens a round.
        const stamp = yield* admission.stamp(task.root);
        if (stamp.generation !== record.generation)
          return {
            record,
            done: yield* stop(
              task.root,
              "superseded: a user action took the game before a new round started.",
            ),
          };
        const remaining = remainingBudget(record, now());
        const round = yield* rounds.begin(task.root, {
          threadId: record.threadId,
          preserveDirectories: preview.directories(task.root),
          budget: {
            repairs: remaining.repairs,
            elapsedMs: Math.max(1, remaining.elapsedMs),
          },
          loopId: record.id,
          builderSelection: record.builderSelection,
          reviewSelection: record.reviewSelection,
        });
        // B7: every check of every candidate replays the inputs captured once
        // when the loop opened, never the newest playtest on disk.
        const incumbentPlan = phasePlan(record, "incumbent-check", round.budget.elapsedMs);
        if (!incumbentPlan.admitted)
          return {
            record,
            done: yield* stop(
              task.root,
              "budget-admission: the remaining review budget cannot cover the selected build check; the selected build is kept.",
            ),
          };
        yield* progress(task.root, "Checking the selected build");
        const incumbentCheck = yield* withinPhase(
          studio.check({
            threadId: record.threadId,
            root: task.root,
            target: "incumbent",
            buildId: round.incumbentBuildId!,
            inputs: record.inputs,
          }),
          incumbentPlan.allowanceMs,
        );
        if (Option.isNone(incumbentCheck))
          return {
            record,
            done: yield* interrupted(
              task.root,
              "deadline: the selected build check did not finish within its phase allowance; the selected build is kept.",
            ),
          };
        const checked = incumbentCheck.value;
        // Legacy evidence recorded no viewport. This first incumbent run is its
        // one recapture: the viewport it actually played at is frozen before
        // any review, so later checks never fall back to mutable defaults.
        if (record.inputs.viewport === null && checked.viewport !== null) {
          const viewport = checked.viewport;
          record = yield* patch(task.root, (entry) => ({
            ...entry,
            inputs: { ...entry.inputs, viewport },
            updatedAt: nowIso(),
          }));
        }
        const incumbentFrames = criticFrames(checked.frames);
        yield* rounds.recordReview(task.root, round.id, { checks: [...checked.checks] });
        const criticPlan = phasePlan(record, "critic", round.budget.elapsedMs);
        if (!criticPlan.admitted)
          return {
            record,
            done: yield* stop(
              task.root,
              "budget-admission: the remaining review budget cannot cover the critic; the selected build is kept.",
            ),
          };
        yield* progress(task.root, "Reviewing frames");
        const critic = yield* awaitChild(task, record, {
          role: "critic",
          order: 0,
          roundId: round.id,
          allowanceMs: criticPlan.allowanceMs,
          evidence: {
            frames: framesFor(incumbentFrames),
            checks: [...checked.checks],
            ...(checked.nativeDiagnostics === undefined
              ? {}
              : { nativeDiagnostics: checked.nativeDiagnostics }),
            ...(checked.nativeWorld === undefined ? {} : { nativeWorld: checked.nativeWorld }),
          },
        });
        // A failed provider with a recorded answer is still judged; without one
        // it is infrastructure, and a completed child's unusable answer is the
        // review's own malformed output. Neither is a game verdict. A phase cap
        // the loop joined may likewise have left an answer on disk.
        const criticAnswer =
          critic.kind === "terminal" || (critic.kind === "expired" && critic.settled)
            ? yield* sessions.answer({
                threadId: record.threadId,
                loopId: record.id,
                roundId: round.id,
                role: "critic",
                order: 0,
              })
            : null;
        const criticVerdict = attemptVerdict("critic", critic, criticAnswer);
        if (criticVerdict.kind === "expired")
          return {
            record,
            done: yield* interrupted(
              task.root,
              `deadline: ${criticVerdict.reason} The selected build is kept.`,
            ),
          };
        if (criticVerdict.kind === "infrastructure")
          return {
            record,
            done: yield* interrupted(task.root, infrastructureReason(criticVerdict.reason)),
          };
        if (criticVerdict.kind === "cancelled")
          return {
            record,
            done: yield* stop(task.root, `interrupted: ${criticVerdict.reason}`),
          };
        if (criticVerdict.kind !== "judged")
          return {
            record,
            done: yield* stop(task.root, `invalid-critic: ${criticVerdict.reason}`),
          };
        if (criticAnswer === null || criticAnswer.kind !== "critic")
          return {
            record,
            done: yield* stop(
              task.root,
              "invalid-critic: the critic's recorded answer could not be read as a critic answer.",
            ),
          };
        const fundamentalDefects: GameReviewDefect[] = Object.entries(
          criticAnswer.answer.fundamentals,
        )
          .filter(([, judgment]) => judgment.verdict === "no" && judgment.frameIds.length > 0)
          .map(([name, judgment]) => ({
            severity: "blocker",
            what: `${name}: ${judgment.note}`,
            frameId: judgment.frameIds[0]!,
            fix: `Resolve ${name}: ${judgment.note}`,
          }));
        // An explicit unmet promise reaches repair even when the critic omits
        // it from defects: each no-verdict requirement becomes one frame-backed
        // actionable defect. Cannot-tell stays neutral and never invents one.
        const requirementDefects: GameReviewDefect[] = (criticAnswer.answer.requirements ?? [])
          .filter((requirement) => requirement.verdict === "no" && requirement.frameIds.length > 0)
          .map((requirement) => ({
            severity: "visible" as const,
            what: `Requirement ${requirement.id} unmet: ${requirement.note}`,
            frameId: requirement.frameIds[0]!,
            fix: `Fulfill ${requirement.id} and verify the actual effect with frames or game_try_input; yes/no: ${requirement.note}`,
          }));
        // Absolute quality reaches bounded repair only as frame-backed,
        // actionable failures: each visual no-verdict dimension becomes one
        // defect, capped with everything else at five and ordered after the
        // explicit design defects so a quality note never displaces an
        // approved promise. Audio never becomes a defect from screenshots:
        // judging a heard effect from frames is unsupported, and hidden
        // behavior without frames is not invented. Cannot-tell stays neutral.
        const qualityDefects = qualityRepairDefects(criticAnswer.answer.quality);
        const defects = [
          ...fundamentalDefects,
          ...requirementDefects,
          ...criticAnswer.answer.defects,
          ...qualityDefects,
        ]
          .toSorted((left, right) => {
            const rank = { blocker: 0, visible: 1, nit: 2 } as const;
            return rank[left.severity] - rank[right.severity];
          })
          .slice(0, MAX_REPAIR_PROMPT_DEFECTS);
        const doNotRegress = criticAnswer.answer.doNotRegress;
        const citedQualityFrameIds = Object.values(criticAnswer.answer.quality ?? {}).flatMap(
          (judgment) => judgment.frameIds,
        );
        const citedRequirementFrameIds = (criticAnswer.answer.requirements ?? []).flatMap(
          (requirement) => requirement.frameIds,
        );
        const citedFrameIds = [
          ...new Set([
            ...criticAnswer.answer.defects.map((defect) => defect.frameId),
            ...doNotRegress.map((item) => item.frameId),
            ...Object.values(criticAnswer.answer.fundamentals).flatMap(
              (judgment) => judgment.frameIds,
            ),
            ...citedRequirementFrameIds,
            ...citedQualityFrameIds,
          ]),
        ];
        const experimentFrameIds = citedFrameIds.filter((frameId) => frameId.startsWith("try"));
        const experiments =
          experimentFrameIds.length === 0
            ? []
            : yield* sessions.experiments({
                threadId: record.threadId,
                loopId: record.id,
                roundId: round.id,
                frameIds: experimentFrameIds,
              });
        yield* rounds.recordReview(task.root, round.id, {
          fundamentals: criticAnswer.answer.fundamentals,
          ...(criticAnswer.answer.requirements === undefined
            ? {}
            : { requirements: criticAnswer.answer.requirements }),
          ...(criticAnswer.answer.requirementsIncomplete === undefined
            ? {}
            : { requirementsIncomplete: criticAnswer.answer.requirementsIncomplete }),
          ...(criticAnswer.answer.downgradedRequirements === undefined
            ? {}
            : { downgradedRequirements: criticAnswer.answer.downgradedRequirements }),
          // Freeze the rubric, the verdicts and their exact coverage with
          // the round: a mid-round edit cannot rewrite the exam, and legacy
          // rounds simply have none of these fields.
          ...(criticAnswer.answer.quality === undefined
            ? {}
            : {
                quality: criticAnswer.answer.quality,
                qualityRubricVersion:
                  criticAnswer.qualityRubricVersion ?? GAME_REVIEW_QUALITY_RUBRIC_VERSION,
                qualityCoverage: gameReviewQualityCoverage(
                  criticAnswer.answer.quality,
                  criticAnswer.qualityRubricVersion,
                ),
              }),
          defects,
          doNotRegress,
          experiments,
        });
        if (defects.length === 0) {
          const requirementUnknowns = (criticAnswer.answer.requirements ?? []).filter(
            (requirement) => requirement.verdict === "cannot-tell",
          ).length;
          const coverage = gameReviewQualityCoverage(
            criticAnswer.answer.quality,
            criticAnswer.qualityRubricVersion,
          );
          const coverageNote =
            criticAnswer.answer.quality === undefined
              ? "quality unassessed (legacy round)"
              : `${coverage.unknowns} quality dimension(s) unknown of ${coverage.total}`;
          return {
            record,
            done: yield* stop(
              task.root,
              requirementUnknowns > 0 ||
                criticAnswer.answer.requirementsIncomplete === true ||
                coverage.unknowns > 0
                ? `zero-defects: no observed defect to repair; coverage incomplete (${requirementUnknowns} requirement(s) unknown${criticAnswer.answer.requirementsIncomplete === true ? "; the design packet was incomplete" : " on limited evidence"}; ${coverageNote}); the incumbent is kept. A selected relative improvement is not proof of absolute quality, and a finished loop is not production readiness.`
                : "zero-defects: the critic found nothing to repair; the incumbent is kept. A selected relative improvement is not proof of absolute quality, and a finished loop is not production readiness.",
            ),
          };
        }
        return yield* repairAndJudge(
          task,
          record,
          round,
          { checks: checked.checks, frames: incumbentFrames },
          {
            defects,
            doNotRegress,
            experiments,
          },
        );
      });

    /**
     * A repair that produced no candidate and judged nothing is review
     * infrastructure, not a bad repair: give the reservation back, keep usage
     * history, and end without a game verdict. The round stays the history of
     * the dispatch through `repairStartedAt`.
     */
    const repairInfrastructure = (
      task: Task,
      signal: GameReviewAttemptPolicy.ReviewAttemptSignal,
    ): Effect.Effect<RoundOutcome, GameOperationError> =>
      Effect.gen(function* () {
        const verdict = GameReviewAttemptPolicy.classifyReviewAttempt("repair", signal);
        const refunded = yield* patch(task.root, (current) => ({
          ...current,
          repairsUsed: Math.max(0, current.repairsUsed - 1),
          updatedAt: nowIso(),
        }));
        return {
          record: refunded,
          done: yield* interrupted(
            task.root,
            infrastructureReason(
              `${
                verdict.kind === "infrastructure"
                  ? verdict.reason
                  : "the repair ended before it could be judged"
              }; the reserved repair attempt was refunded`,
            ),
          ),
        };
      });

    /**
     * A host phase cap is not a user stop: `awaitChild` interrupted and joined
     * this child itself, so evidence it wrote before the cut may still be
     * judged. A candidate is usable only when the source it was exported from
     * is exactly the tree the settled child left. Otherwise the selected build
     * stays and the reserved attempt still counts.
     *
     * Returns null only when the shared candidate-check-and-ballot path below
     * may run.
     */
    const phaseCappedRepair = (
      task: Task,
      record: GameRepairLoopRecord,
      reserved: GameRepairLoopRecord,
      roundId: string,
      child: Extract<ChildOutcome, { readonly kind: "expired" }>,
    ): Effect.Effect<RoundOutcome | null, GameOperationError> =>
      Effect.gen(function* () {
        const capped = "the repair used its phase allowance before it finished";
        if (!child.settled || child.child === null)
          return {
            record: reserved,
            done: yield* interrupted(
              task.root,
              `deadline: ${capped} and its child did not settle; the attempt counts and the selected build is kept.`,
            ),
          };
        // The deadline cannot be bypassed by the cap: a phase can consume the
        // last of the loop budget while its child is joining.
        if (remainingBudget(reserved, now()).elapsedMs <= 0)
          return {
            record: reserved,
            done: yield* interrupted(
              task.root,
              `deadline: ${capped} after the review budget ran out; the attempt counts and the selected build is kept.`,
            ),
          };
        const open = yield* findRound(task.root, roundId);
        if (open === null || open.status !== "running")
          return {
            record: reserved,
            done: yield* stop(
              task.root,
              "superseded: the open round was stopped while the capped repair was joining.",
            ),
          };
        const stamp = yield* admission.stamp(task.root);
        if (stamp.generation !== record.generation)
          return {
            record: reserved,
            done: yield* stop(
              task.root,
              "superseded: a user action took the game while the capped repair was joining.",
            ),
          };
        if (open.candidate === null)
          return {
            record: reserved,
            done: yield* interrupted(task.root, `deadline: ${capped}; the attempt counts.`),
          };
        // Capture the source the writer actually left. The candidate must
        // match it exactly; a cap can land between an export and a later edit.
        yield* rounds
          .recordPostRepair(task.root, roundId)
          .pipe(
            Effect.catchCause((cause) => logFailure("recording the repair tree failed", cause)),
          );
        const afterRepair = yield* findRound(task.root, roundId);
        if (afterRepair === null || afterRepair.status !== "running")
          return {
            record: reserved,
            done: yield* stop(
              task.root,
              "superseded: the open round was stopped while the capped repair was joining.",
            ),
          };
        const candidate = afterRepair.candidate;
        if (candidate === null)
          return {
            record: reserved,
            done: yield* interrupted(task.root, `deadline: ${capped}; the attempt counts.`),
          };
        if (candidate.sourceId === null || candidate.sourceId !== afterRepair.postRepairSourceId)
          return {
            record: reserved,
            done: yield* interrupted(
              task.root,
              `repair-phase-capped: candidate ${candidate.buildId} exists but its source ${
                candidate.sourceId ?? "unknown"
              } does not match the repaired source ${
                afterRepair.postRepairSourceId ?? "unknown"
              }; the attempt counts and the selected build is kept.`,
            ),
          };
        return null;
      });

    const repairAndJudge = (
      task: Task,
      record: GameRepairLoopRecord,
      round: GameReviewRoundRecord,
      incumbent: {
        readonly checks: ReadonlyArray<GameReviewCheck>;
        readonly frames: ReadonlyArray<GameRepairFrame>;
      },
      review: {
        readonly defects: ReadonlyArray<GameReviewDefect>;
        readonly doNotRegress: ReadonlyArray<GameReviewDoNotRegress>;
        readonly experiments: ReadonlyArray<GameReviewExperimentRoute>;
      },
    ): Effect.Effect<RoundOutcome, GameOperationError> =>
      Effect.gen(function* () {
        const at = now();
        const remaining = remainingBudget(record, at);
        if (remaining.repairs <= 0 || remaining.elapsedMs <= 0)
          return {
            record,
            done: yield* stop(
              task.root,
              "budget-exhausted: the review budget ran out before another repair.",
            ),
          };
        // Keep checking and voting time out of the repair's allowance so it
        // cannot consume the whole budget before a selection is possible.
        const repairPlan = phasePlan(record, "repair", round.budget.elapsedMs);
        if (!repairPlan.admitted)
          return {
            record,
            done: yield* stop(
              task.root,
              "budget-admission: the remaining review budget cannot cover a repair plus the candidate check and two ballots; the selected build is kept.",
            ),
          };
        const previousRejection = yield* previousRejectionFor(task.root, record.id, round.id);
        const repairMinutes = Math.max(1, Math.ceil(repairPlan.allowanceMs / 60_000));
        const stamp = yield* admission.stamp(task.root);
        if (stamp.generation !== record.generation)
          return {
            record,
            done: yield* stop(
              task.root,
              "superseded: a user action took the game before the repair was dispatched.",
            ),
          };
        // Reserved before dispatch, so a crash can never leave dispatched work
        // uncounted and a later round cannot under-spend.
        const reserved = yield* patch(task.root, (current) => ({
          ...current,
          repairsUsed: Math.min(current.budget.repairs, current.repairsUsed + 1),
          updatedAt: nowIso(),
        }));
        // Marked before dispatch so a repair cancelled or interrupted mid-run
        // keeps Restore even though it never records a post-repair tree.
        yield* rounds.recordRepairStart(task.root, round.id);
        yield* progress(task.root, "Repairing the game");
        const repair = yield* awaitChild(task, reserved, {
          role: "repair",
          order: 0,
          roundId: round.id,
          allowanceMs: repairPlan.allowanceMs,
          repair: {
            remainingBudget: `${budgetText(reserved, at)}; this attempt has at most ${repairMinutes} minute${repairMinutes === 1 ? "" : "s"}`,
            defects: review.defects,
            doNotRegress: review.doNotRegress,
            ...(previousRejection === undefined ? {} : { previousRejection }),
          },
        });
        if (repair.kind === "expired") {
          const capped = yield* phaseCappedRepair(task, record, reserved, round.id, repair);
          if (capped !== null) return capped;
        }
        if (repair.kind === "failed")
          return yield* repairInfrastructure(task, {
            kind: "unstarted",
            detail: repair.reason,
          });
        if (
          repair.kind === "terminal" &&
          (repair.status === "cancelled" || repair.status === "interrupted")
        )
          return {
            record: reserved,
            done: yield* stop(
              task.root,
              `interrupted: the repair ended ${repair.status} before it was judged; the attempt counts.`,
            ),
          };
        // The capped path already captured the tree it compared the candidate
        // against; no writer remains, so recording it twice would only rehash.
        if (repair.kind !== "expired")
          yield* rounds
            .recordPostRepair(task.root, round.id)
            .pipe(
              Effect.catchCause((cause) => logFailure("recording the repair tree failed", cause)),
            );
        const endedStatus = repair.kind === "terminal" ? repair.status : "interrupted";
        // The child's own submit says which defects it believes it fixed. It is
        // testimony for the history, never evidence: the checks and ballots
        // below still decide, and a child that never submitted is still judged.
        const repairChild = repair.child;
        if (repairChild !== null && repairChild.runId !== null) {
          const claimed = yield* submissionForRun(task.root, repairChild.runId);
          if (claimed !== null)
            yield* rounds
              .recordReview(task.root, round.id, { submissionNote: claimed.note })
              .pipe(
                Effect.catchCause((cause) =>
                  logFailure("recording the repair submission note failed", cause),
                ),
              );
        }
        const afterRepair = yield* findRound(task.root, round.id);
        if (afterRepair === null || afterRepair.status !== "running")
          return {
            record: reserved,
            done: yield* stop(
              task.root,
              "superseded: the open round was stopped by another action.",
            ),
          };
        if (afterRepair.candidate === null) {
          // A provider-ended repair (failed/rolled_back) with no candidate is
          // infrastructure, not "no-output" from the game: refund the reserved
          // attempt and keep the selected build.
          const noCandidateSignal: GameReviewAttemptPolicy.ReviewAttemptSignal = {
            kind: "terminal",
            status: endedStatus,
            hasCandidate: false,
          };
          if (
            GameReviewAttemptPolicy.classifyReviewAttempt("repair", noCandidateSignal).kind ===
            "infrastructure"
          )
            return yield* repairInfrastructure(task, noCandidateSignal);
          const exported = yield* studio
            .exportState(task.root)
            .pipe(Effect.orElseSucceed(() => null));
          const exportedAt =
            exported?.finishedAt === null || exported?.finishedAt === undefined
              ? null
              : Date.parse(exported.finishedAt);
          const failedAfterStart =
            exported !== null &&
            exported.outcome === "failed" &&
            (exportedAt === null ||
              Number.isNaN(exportedAt) ||
              exportedAt >= Date.parse(round.startedAt));
          const reason = failedAfterStart
            ? `export-failed: ${exported?.detail ?? "the export command failed"}${
                endedStatus === "completed" ? "" : ` (the repair child ended ${endedStatus})`
              }`
            : `no-output: the repair produced no exported build${
                endedStatus === "completed" ? "" : ` (the repair child ended ${endedStatus})`
              }`;
          return yield* rejectRound(reserved, round.id, reason);
        }
        if (
          afterRepair.incumbentBuildId !== null &&
          afterRepair.candidate.buildId === afterRepair.incumbentBuildId
        )
          return yield* rejectRound(
            reserved,
            round.id,
            "unchanged: the repair exported the same build as the incumbent.",
          );

        yield* progress(task.root, "Checking the repaired build");
        const candidatePlan = phasePlan(record, "candidate-check", round.budget.elapsedMs);
        if (!candidatePlan.admitted)
          return {
            record: reserved,
            done: yield* interrupted(
              task.root,
              "deadline: the candidate check cannot fit before the review budget ends; the selected build is kept.",
            ),
          };
        const candidateCheck = yield* withinPhase(
          studio.check({
            threadId: record.threadId,
            root: task.root,
            target: "candidate",
            buildId: afterRepair.candidate.buildId,
            inputs: record.inputs,
          }),
          candidatePlan.allowanceMs,
        );
        if (Option.isNone(candidateCheck))
          return {
            record: reserved,
            done: yield* interrupted(
              task.root,
              "deadline: the candidate check did not finish within its phase allowance; the selected build is kept.",
            ),
          };
        const candidate = candidateCheck.value;
        const candidateFrames: GameRepairFrame[] = candidate.frames.map((frame, index) => ({
          id: `c${index + 1}`,
          label: frame.label,
          path: frame.path,
          ...(frame.inputPair === undefined ? {} : { inputPair: frame.inputPair }),
          ...(frame.width === undefined ? {} : { width: frame.width }),
          ...(frame.height === undefined ? {} : { height: frame.height }),
          ...(frame.window === true ? { window: true } : {}),
        }));
        const veto = mechanicalVeto(incumbent.checks, candidate.checks, review.doNotRegress);
        yield* rounds.recordReview(task.root, round.id, {
          candidateChecks: [...candidate.checks],
          ...(veto === null ? {} : { mechanicalVeto: vetoReason(veto) }),
        });
        if (veto !== null)
          return yield* rejectRound(reserved, round.id, `mechanical-veto: ${vetoReason(veto)}`);

        // Experiment replays are optional evidence: when no bounded allowance
        // fits before the ballots, the frozen check evidence still decides.
        const experimentPlan = phasePlan(record, "experiments", round.budget.elapsedMs);
        const experimentPairs =
          review.experiments.length === 0 || !experimentPlan.admitted
            ? []
            : Option.getOrElse(
                yield* withinPhase(
                  replayExperimentPairs({
                    threadId: record.threadId,
                    root: task.root,
                    incumbentBuildId: afterRepair.incumbentBuildId ?? round.incumbentBuildId,
                    candidateBuildId: afterRepair.candidate.buildId,
                    experiments: review.experiments,
                    defects: review.defects,
                    doNotRegress: review.doNotRegress,
                  }),
                  experimentPlan.allowanceMs,
                ),
                () => [],
              );
        const plans = ballotPlans(record.id, round.id);
        yield* rounds.recordReview(task.root, round.id, { ballots: plans });
        const currentBeforePair = yield* findRound(task.root, round.id);
        const admittedNow = yield* admission.stamp(task.root);
        if (admittedNow.generation !== record.generation)
          return {
            record: reserved,
            done: yield* stop(
              task.root,
              "superseded: a user action took the game before a ballot was dispatched.",
            ),
          };
        // The pair shares one wallclock allowance. Both votes start together;
        // insufficient budget starts neither.
        const pairPlan = phasePlan(reserved, "ballot", round.budget.elapsedMs);
        if (!pairPlan.admitted)
          return {
            record: reserved,
            done: yield* interrupted(
              task.root,
              "deadline: neither ballot can be decided within the remaining review budget; the selected build is kept.",
            ),
          };
        yield* progress(task.root, "Comparing builds, votes 1 and 2 of 2");
        const pairDefects = review.defects.map(
          ({ frameId: _frameId, recipeId: _recipeId, ...defect }, index) => ({
            id: `defect-${index + 1}`,
            ...defect,
          }),
        );
        const pairItems = review.doNotRegress.map((item) => ({ id: item.id, what: item.what }));
        const pairAllowance = pairPlan.allowanceMs;
        // Both independent blind opposite-order ballots run concurrently
        // (max 2) under the one pair allowance. Each branch awaits its child
        // and reads its answer; collection persists sorted afterwards so
        // concurrent writes never race. One infra/invalid response cannot
        // promote and never abandons its sibling: the forEach joins both.
        const pairResults = yield* Effect.forEach(
          plans,
          (plan) =>
            Effect.gen(function* () {
              const ballot = yield* awaitChild(task, reserved, {
                role: "ballot",
                order: plan.order,
                roundId: round.id,
                allowanceMs: pairAllowance,
                evidence: ballotEvidence(
                  incumbent.frames,
                  candidateFrames,
                  incumbent.checks,
                  candidate.checks,
                  plan,
                  experimentPairs,
                  record.inputs,
                  review.defects,
                ),
                defects: pairDefects,
                items: pairItems,
              });
              const ballotAnswer =
                ballot.kind === "terminal" || (ballot.kind === "expired" && ballot.settled)
                  ? yield* sessions.answer({
                      threadId: record.threadId,
                      loopId: record.id,
                      roundId: round.id,
                      role: "ballot",
                      order: plan.order,
                    })
                  : null;
              const ballotVerdict = attemptVerdict("ballot", ballot, ballotAnswer);
              const malformed =
                ballotVerdict.kind === "malformed" ||
                (ballotVerdict.kind === "judged" &&
                  (ballotAnswer === null || ballotAnswer.kind !== "ballot"));
              const malformedReason =
                ballotVerdict.kind === "malformed"
                  ? ballotVerdict.reason
                  : "the ballot's recorded answer did not belong to this ballot.";
              let entry: GameReviewBallotRecord | null = null;
              if (ballotAnswer !== null && ballotAnswer.kind === "ballot") {
                const lost = challengerLosses(ballotAnswer.answer, plan);
                entry = {
                  order: plan.order,
                  outcome: "valid",
                  answer: ballotAnswer.answer,
                  raw: ballotAnswer.raw,
                  ...(lost.length === 0
                    ? {}
                    : {
                        reason: `preservation-note: ballot ${plan.order} saw ${lost.join(", ")} lost on the challenger; requires confirmation from the opposite order.`,
                      }),
                };
              } else if (ballotAnswer !== null && ballotAnswer.kind === "invalid") {
                entry = {
                  order: plan.order,
                  outcome: "invalid",
                  reason: ballotAnswer.reason,
                  ...(ballotAnswer.raw !== null ? { raw: ballotAnswer.raw } : {}),
                };
              }
              return {
                plan,
                ballot,
                ballotAnswer,
                ballotVerdict,
                malformed,
                malformedReason,
                entry,
              };
            }),
          { concurrency: 2 },
        );
        // No promotion while a writer is still active: an unsettled phase cap
        // or an ignored interrupt leaves ownership behind and fails closed.
        const stillOwned = yield* Ref.get(task.owned);
        if (stillOwned.size > 0)
          return {
            record: reserved,
            done: yield* interrupted(
              task.root,
              "deadline: a ballot child did not settle within its phase allowance; the selected build is kept.",
            ),
          };
        // Retain all evidence: persist every settled answer sorted by order
        // before any verdict, so a valid sibling survives an infra sibling.
        const pairEntries = pairResults
          .flatMap((result) => (result.entry === null ? [] : [result.entry]))
          .toSorted((left, right) => left.order - right.order);
        let current =
          pairEntries.length === 0
            ? currentBeforePair
            : yield* rounds.recordReview(task.root, round.id, {
                ballotAnswers: [
                  ...(currentBeforePair?.ballotAnswers ?? []),
                  ...pairEntries,
                ].toSorted((left, right) => left.order - right.order),
              });
        const firstExpired = pairResults.find((result) => result.ballotVerdict.kind === "expired");
        if (firstExpired !== undefined)
          return {
            record: reserved,
            done: yield* interrupted(
              task.root,
              `deadline: ${firstExpired.ballotVerdict.kind === "expired" ? firstExpired.ballotVerdict.reason : "a ballot used its phase allowance before it finished."} The selected build is kept.`,
            ),
          };
        const firstInfra = pairResults.find(
          (result) => result.ballotVerdict.kind === "infrastructure",
        );
        if (firstInfra !== undefined)
          return {
            record: reserved,
            done: yield* interrupted(
              task.root,
              infrastructureReason(
                firstInfra.ballotVerdict.kind === "infrastructure"
                  ? firstInfra.ballotVerdict.reason
                  : "a ballot could not start",
              ),
            ),
          };
        const firstCancelled = pairResults.find(
          (result) => result.ballotVerdict.kind === "cancelled",
        );
        if (firstCancelled !== undefined)
          return {
            record: reserved,
            done: yield* stop(
              task.root,
              `interrupted: ${
                firstCancelled.ballotVerdict.kind === "cancelled"
                  ? firstCancelled.ballotVerdict.reason
                  : "a ballot was interrupted"
              }`,
            ),
          };
        const firstNoOutput = pairResults.find(
          (result) => result.ballotVerdict.kind === "no-output",
        );
        if (firstNoOutput !== undefined)
          return {
            record: reserved,
            done: yield* stop(
              task.root,
              `invalid-ballot: ${
                firstNoOutput.ballotVerdict.kind === "no-output"
                  ? firstNoOutput.ballotVerdict.reason
                  : "a ballot produced no output"
              }`,
            ),
          };
        const firstMalformed = pairResults.find((result) => result.malformed);
        if (firstMalformed !== undefined)
          return {
            record: reserved,
            done: yield* stop(task.root, `invalid-ballot: ${firstMalformed.malformedReason}`),
          };
        if (current === null) return { record: reserved, done: true };
        return yield* decide(reserved, current);
      });

    const runRounds = (task: Task, initial: GameRepairLoopRecord): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        let current = initial;
        // Zero until a round has finished, so the first round is never paced.
        let lastRoundMs = 0;
        for (;;) {
          const latest = yield* readRecord(task.root).pipe(Effect.orElseSucceed(() => null));
          if (latest === null || latest.status !== "running") return;
          const remaining = remainingBudget(latest, now());
          if (remaining.elapsedMs <= 0) {
            yield* interrupted(task.root, "deadline: the review budget ran out.");
            return;
          }
          if (remaining.repairs <= 0) {
            yield* stop(
              task.root,
              "budget-exhausted: no repairs remain; the selected build is kept.",
            );
            return;
          }
          // Another round repeats the whole sequence just measured. When that
          // round already took longer than the time left, starting it would
          // spend the tail without a selection, so keep the selected build.
          // Unusable clock readings leave the round admitted.
          if (
            Number.isFinite(lastRoundMs) &&
            lastRoundMs > 0 &&
            lastRoundMs > remaining.elapsedMs
          ) {
            yield* stop(
              task.root,
              "budget-pacing: the last round took longer than the remaining review budget; another round is unlikely to fit, so the selected build is kept.",
            );
            return;
          }
          const roundStartedAt = now();
          const outcome = yield* playRound(task, latest).pipe(
            Effect.catchCause((cause) =>
              finish({
                root: task.root,
                decision: "interrupt",
                reason: `review-error: ${Cause.pretty(cause)}`,
              }).pipe(Effect.as({ record: current, done: true })),
            ),
          );
          lastRoundMs = now() - roundStartedAt;
          current = outcome.record;
          if (outcome.done) return;
        }
      });

    const runLoop = (initial: GameRepairLoopRecord, task: Task): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const deadline = Math.max(1, remainingBudget(initial, now()).elapsedMs);
        const completed = yield* runRounds(task, initial).pipe(
          Effect.timeoutOption(Duration.millis(deadline)),
        );
        if (Option.isNone(completed)) {
          // The timeout interrupted the fiber, whose finalizer stopped the
          // owned child. No late result can promote: this fiber was the only
          // promoter and it is gone.
          yield* interrupted(
            task.root,
            `deadline: the review did not finish within its ${initial.budget.elapsedMs / 60_000}-minute budget.`,
          );
        }
      }).pipe(Effect.catchCause((cause) => logFailure("the repair loop failed", cause)));

    /** Holds the game for one loop: admission stops it through `stopLive`. */
    const hold = (root: string, loopId: string, fiber: Fiber.Fiber<void, never> | null) =>
      Effect.gen(function* () {
        const entry: GameAdmission.GameAdmissionEntry = {
          interrupt: (reason) => stopLive(root, reason),
          owns: (threadId) =>
            sessions.recordedChildren({ root, loopId }).pipe(
              Effect.map((children) => children.some((child) => child.childThreadId === threadId)),
              Effect.orElseSucceed(() => false),
            ),
        };
        const held: Live = { fiber, loopId, entry };
        live.set(root, held);
        yield* admission.register(root, entry);
        return held;
      });

    const release = (root: string, held: Live) =>
      Effect.gen(function* () {
        if (live.get(root) === held) live.delete(root);
        yield* admission.unregister(root, held.entry);
        phases.delete(root);
        yield* operations.changed(root, "Review sessions stopped.");
      });

    /** Releases the game once its recorded children are terminal; otherwise it stays held. */
    const releaseWhenSettled = (root: string, held: Live, reason: string) =>
      settleChildren(root, held.loopId, reason).pipe(
        Effect.flatMap((settled) =>
          settled
            ? release(root, held)
            : Effect.logWarning("a review child is still running; the game stays held", {
                root,
                loopId: held.loopId,
              }),
        ),
      );

    const start = (root: string, record: GameRepairLoopRecord) =>
      Effect.gen(function* () {
        const task: Task = {
          root,
          owned: yield* Ref.make<ReadonlyMap<string, OwnedChild>>(new Map()),
          usageWrite: Semaphore.makeUnsafe(1),
        };
        const fiber = yield* runLoop(record, task).pipe(Effect.forkIn(scope));
        const held = yield* hold(root, record.id, fiber);
        // Whatever ended the fiber (a decision, an error, a timeout), the game
        // is released only after the recorded children are verified stopped.
        yield* Fiber.await(fiber).pipe(
          Effect.andThen(releaseWhenSettled(root, held, "The review ended.")),
          Effect.forkIn(scope),
        );
        return fiber;
      });

    /** The gate-free supersession core; `admit` calls it under the game gate. */
    const stopLive = (root: string, reason: string): Effect.Effect<void, GameOperationError> =>
      Effect.gen(function* () {
        const held = live.get(root);
        if (held !== undefined) {
          // Interrupt and join: a user action must not race a check, a child or
          // a promotion. The fiber's finalizers stop its current child; every
          // recorded child is then verified, since a child whose dispatch was
          // never confirmed is not the fiber's to stop.
          if (held.fiber !== null) yield* Fiber.interrupt(held.fiber);
          if (!(yield* settleChildren(root, held.loopId, "The review was superseded."))) {
            yield* finish({
              root,
              decision: "interrupt",
              reason:
                "supersede-failed: the review child did not stop in time; the action was refused so it cannot race the review.",
            });
            // The game stays held: a retry is refused the same way until the
            // child is terminal.
            return yield* new GameOperationError({
              operation: "supersede game review",
              path: root,
              reason: "io",
              detail:
                "The review child did not stop in time; the action was refused so it cannot race the review.",
            });
          }
          yield* release(root, held);
        }
        yield* finish({ root, decision: "stop", reason });
      });

    const interrupt: GameRepairLoop["Service"]["interrupt"] = (threadId, reason) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId);
        // `admit` takes the gate, advances the persisted generation and then
        // runs the registered stop; every supersession path shares it.
        yield* admission.admit({ root, reason, threadId });
      });

    const submit: GameRepairLoop["Service"]["submit"] = (threadId, input) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId);
        return yield* admission.withGate(
          root,
          Effect.gen(function* () {
            const note = input.note.trim();
            const manifest = yield* projects.read(root);
            const budgetMs = gameProductionBudgetMs(manifest);
            const refused = (
              message: string,
              buildId: string | null,
              checks: ReadonlyArray<GameReviewCheck>,
              production?: GameProductionStatus,
            ): GameSubmitResult => ({
              accepted: false,
              message: `Submission refused: ${message}`,
              buildId,
              submission: null,
              checks: [...checks],
              ...(production === undefined ? {} : { production }),
            });
            if (note === "" || /[\r\n]/.test(note))
              return refused("the note must be one non-empty line on what the game is.", null, []);
            // The declaration belongs to the turn that made it: a later turn cannot
            // claim someone else's build, and the review starts for this run alone.
            const runId = yield* projects.activeRun(threadId);
            if (runId === null)
              return refused("no turn is running, so this submission has no owner.", null, []);
            const productionBefore = yield* rounds.read(root).pipe(
              Effect.map((state) =>
                productionStatus({
                  production: state.production ?? null,
                  budgetMs,
                  activeRun: runId,
                  nowMs: now(),
                }),
              ),
              Effect.orElseSucceed(() =>
                productionStatus({
                  production: null,
                  budgetMs,
                  activeRun: runId,
                  nowMs: now(),
                }),
              ),
            );
            const held = live.get(root);
            const reviewing = yield* readRecord(root);
            // A repair child may submit inside its own round. Its declaration is
            // testimony for the round; the selection belongs to the review, and
            // the builder's production clock is not the child's.
            let ownedRepair = false;
            if (held !== undefined || reviewing?.status === "running") {
              const children =
                held === undefined
                  ? []
                  : yield* sessions.recordedChildren({ root, loopId: held.loopId });
              ownedRepair = children.some(
                (child) =>
                  child.role === "repair" &&
                  child.childThreadId === threadId &&
                  String(child.runId) === String(runId),
              );
              if (!ownedRepair)
                return refused(
                  reviewing?.status === "running"
                    ? "a review is running for this game; only its owned repair child can submit."
                    : "the game is held until its review children stop; only its owned repair child can submit.",
                  input.buildId ?? null,
                  [],
                  productionBefore,
                );
            }
            const facts = yield* studio.submissionFacts(root, input.buildId);
            if (!facts.passed || facts.buildId === null)
              return refused(
                facts.reason ?? "the server could not verify a build.",
                facts.buildId,
                facts.checks,
                productionBefore,
              );
            // The facts proved these exact bytes and their source binding, so the
            // exported artifact is the one Play may show. Selecting before the
            // declaration commits nothing that a refusal could leave behind.
            const exported = yield* rounds.exported(root, facts.buildId);
            if (exported === null)
              return yield* new GameOperationError({
                operation: "submit game build",
                path: root,
                reason: "invalid-input",
                detail:
                  "The verified build has no recorded export/source binding; export the game again.",
              });
            // The immutable facts still pass for a retained build after the
            // folder moved on. A round would then snapshot the current tree and
            // repair different engine inputs than the incumbent names, so the
            // declaration is refused while the old artifact stays usable. Notes
            // and design edits are not build inputs and stay submittable.
            if (!(yield* rounds.buildIsCurrent(root, facts.buildId)))
              return refused(
                `sources-current: the game folder's engine sources changed after build ${facts.buildId.slice(0, 12)} was exported; run game_verify on the current sources and export again, then submit the new build.`,
                facts.buildId,
                [
                  ...facts.checks,
                  {
                    id: "sources-current",
                    status: "failed" as const,
                    detail:
                      "The engine sources changed after this build was exported; export the current game before submitting.",
                  },
                ],
                productionBefore,
              );
            if (!ownedRepair) {
              yield* rounds.select(root, exported.artifact);
              // A preview already open follows the declaration at once, so the
              // creator watching Play sees the first playable without pressing
              // anything. A closed preview stays closed until Play opens it.
              if (preview.url(root) !== null)
                yield* preview.select(root, exported.artifact.directory).pipe(Effect.ignore);
            }
            const submission: GameSubmission = {
              runId,
              buildId: facts.buildId,
              note,
              submittedAt: nowIso(),
            };
            yield* rounds.recordSubmission(root, submission);
            const production = ownedRepair
              ? productionStatus({
                  production: (yield* rounds.read(root)).production ?? null,
                  budgetMs,
                  activeRun: runId,
                  nowMs: now(),
                })
              : yield* rounds
                  .recordProduction(root, {
                    runId,
                    buildId: facts.buildId,
                    at: submission.submittedAt,
                  })
                  .pipe(
                    Effect.map((recorded) =>
                      productionStatus({
                        production: recorded,
                        budgetMs,
                        activeRun: runId,
                        nowMs: now(),
                      }),
                    ),
                  );
            const firstPlayable = !ownedRepair && productionBefore.firstPlayableAt === null;
            const budget = productionBudgetText(production.budgetMs, production.remainingMs);
            return {
              accepted: true,
              message: firstPlayable
                ? `Submitted ${facts.buildId.slice(0, 12)}: this is the first playable. Play shows it now. Production budget: ${budget}; keep deepening the game toward the brief and submit improved builds until it is realised.`
                : `Submitted ${facts.buildId.slice(0, 12)}: Play shows this build now. ${budget}: keep producing, and end the turn when the game fully realises the brief.`,
              buildId: facts.buildId,
              submission,
              checks: [...facts.checks],
              ...(ownedRepair ? {} : { firstPlayable }),
              production,
            };
          }),
        );
      });

    const ensure: GameRepairLoop["Service"]["ensure"] = (input) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(input.threadId);
        const current = () =>
          Effect.gen(function* () {
            const existing = yield* readRecord(root);
            // The same origin is never reviewed twice; a live loop is not
            // restarted. A stopped or interrupted loop from an older run does
            // not block the next builder turn's review, though: restart only
            // abandons the work it cut, never the game's future repairs.
            if (
              existing !== null &&
              String(existing.originatingRunId) === String(input.runId) &&
              existing.originatingNodeId === input.nodeId
            )
              return existing;
            if (existing?.status === "running") return existing;
            return null;
          });
        const already = yield* current();
        if (already !== null) return already;

        // Everything below reads state, sources and playtest evidence; none of
        // it holds the game gate, so a creator action never waits for an engine
        // read. The gate is taken only to recheck and commit.
        const records = yield* threads.getThreadRecords(input.threadId, ["runs"]).pipe(
          Effect.mapError(
            (cause) =>
              new GameOperationError({
                operation: "ensure game review",
                path: root,
                reason: "thread-dispatch",
                detail: String(cause),
                cause,
              }),
          ),
        );
        const run = records.runs.find((candidate) => candidate.id === input.runId);
        if (
          run === undefined ||
          run.status !== "completed" ||
          run.rootNodeId === null ||
          run.rootNodeId !== input.nodeId
        )
          return null;
        // A newer requested turn owns the game: this run's export is no longer
        // the current work, so a text-only follow-up cannot start a new budget.
        const newest = records.runs.reduce((latest, candidate) =>
          DateTime.toEpochMillis(candidate.requestedAt) > DateTime.toEpochMillis(latest.requestedAt)
            ? candidate
            : latest,
        );
        if (newest.id !== run.id) return null;
        // A submission is the origin: the builder named these bytes and the
        // server verified them at submit time. The facts are checked once more
        // because the build or its records can be replaced before the turn
        // ends. The current engine inputs are checked too: an edit after the
        // export would make a round snapshot an unrelated tree, so only
        // design and notes edits ride along with the declaration.
        const submitted = yield* submissionForRun(root, input.runId);
        let exportBuildId: string;
        let submissionNote: string | undefined;
        let failedFact: string | null = null;
        if (submitted !== null) {
          const facts = yield* studio.submissionFacts(root, submitted.buildId);
          if (!facts.passed || facts.buildId !== submitted.buildId)
            failedFact =
              facts.reason ??
              `build: the verified build does not match submitted build ${submitted.buildId}.`;
          exportBuildId = submitted.buildId;
          submissionNote = submitted.note;
        } else {
          // No submission: the turn's own latest export may still start the
          // review, but only on the same facts a submission would have to pass.
          const provenance = yield* studio.exportProvenance(root);
          if (provenance.exportBuildId === null || provenance.exportRunId !== String(input.runId))
            return null;
          const facts = yield* studio.submissionFacts(root, provenance.exportBuildId);
          if (!facts.passed)
            failedFact = facts.reason ?? "build: the server could not verify the exported build.";
          exportBuildId = provenance.exportBuildId;
        }
        // Defend an export/submit followed by a later engine edit before the
        // turn ended: starting a round now would snapshot an unrelated tree.
        // The retained facts and artifact stay valid; only the review is
        // skipped, with its budget, admission and deadline untouched.
        if (failedFact === null && !(yield* rounds.buildIsCurrent(root, exportBuildId)))
          failedFact = `sources-current: the game folder's engine sources changed after build ${exportBuildId.slice(0, 12)} was exported; export the current game before review. The selected build is kept.`;
        const completedAt =
          run.completedAt === null ? null : DateTime.toEpochMillis(run.completedAt);
        const inputs =
          failedFact === null
            ? yield* studio.frozenInputs(root, exportBuildId)
            : { steps: [], viewport: null, seed: "unknown" as const };
        // No recorded route means nothing honest to replay. The review is not
        // run on invented input; it is recorded as skipped so the reason stays
        // visible instead of the review silently never appearing.
        let skipped =
          failedFact ??
          (inputs.steps.length === 0
            ? "skipped: the builder's playtest recorded no input route, so there is nothing to replay. Playtest the game with input steps to enable review."
            : null);
        const stamp = yield* admission.stamp(root);
        // A creator action admitted after this run finished supersedes it, even
        // when that action's own run has not been created yet.
        if (
          stamp.admittedAt !== null &&
          completedAt !== null &&
          Date.parse(stamp.admittedAt) >= completedAt
        )
          return null;

        return yield* admission.withGate(
          root,
          Effect.gen(function* () {
            const settled = yield* current();
            if (settled !== null) return settled;
            // An earlier loop's child may still be writing: the game stays held.
            if (live.has(root)) return null;
            const latest = yield* admission.stamp(root);
            // An action took the game while the reads above ran; it owns it now.
            if (latest.generation !== stamp.generation) return null;
            if (skipped === null) {
              const exported = yield* rounds.exported(root, exportBuildId).pipe(Effect.result);
              if (exported._tag === "Failure")
                skipped =
                  exported.failure.detail ?? "sources: the recorded sources could not be read.";
              else if (exported.success === null)
                skipped = "sources: the build has no recorded export/source binding.";
              // Re-check under the gate: an engine edit that landed while the
              // reads above ran must not become the round's incumbent tree.
              else if (!(yield* rounds.buildIsCurrent(root, exportBuildId)))
                skipped = `sources-current: the game folder's engine sources changed after build ${exportBuildId.slice(0, 12)} was exported; export the current game before review. The selected build is kept.`;
              else yield* rounds.select(root, exported.success.artifact);
            }
            const builderSelection = run.modelSelection ?? records.thread.modelSelection;
            const reviewSelection = input.reviewSelection ?? builderSelection;
            const at = nowIso();
            const buildRecipeCalls = yield* sessions
              .recipeCalls(input.threadId)
              .pipe(Effect.orElseSucceed(() => null));
            const record: GameRepairLoopRecord = {
              schemaVersion: 2,
              id: NodeCrypto.randomUUID(),
              root,
              threadId: input.threadId,
              originatingRunId: input.runId,
              originatingNodeId: input.nodeId,
              exportBuildId,
              ...(submissionNote === undefined ? {} : { submissionNote }),
              status: skipped === null ? "running" : "stopped",
              repairsUsed: 0,
              budget,
              builderSelection,
              reviewSelection,
              inputs,
              generation: latest.generation,
              startedAt: at,
              updatedAt: at,
              finishedAt: skipped === null ? null : at,
              promotedRounds: [],
              decision: skipped === null ? null : "stop",
              reason: skipped,
              usage: EMPTY_GAME_REVIEW_USAGE,
              buildRecipeCalls,
            };
            yield* save(root, record);
            if (skipped === null) yield* start(root, record);
            return record;
          }),
        );
      });

    const read: GameRepairLoop["Service"]["read"] = (threadId) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId);
        return yield* readRecord(root);
      });

    const awaitIdle: GameRepairLoop["Service"]["awaitIdle"] = (threadId) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId).pipe(Effect.orElseSucceed(() => null));
        if (root === null) return;
        const current = live.get(root);
        if (current === undefined || current.fiber === null) return;
        yield* Fiber.await(current.fiber).pipe(Effect.asVoid);
      });

    const recover: GameRepairLoop["Service"]["recover"] = () =>
      Effect.gen(function* () {
        const directory = NodePath.join(options.stateDir, "game-repair-loops");
        const names = yield* attempt("read game repair loops", directory, () =>
          NodeFSP.readdir(directory),
        ).pipe(Effect.orElseSucceed(() => [] as string[]));
        const interruptedRoots: string[] = [];
        for (const name of names) {
          if (!name.endsWith(".json")) continue;
          const loops = yield* readFile(NodePath.join(directory, name)).pipe(
            Effect.orElseSucceed(() => []),
          );
          for (const loop of loops ?? []) {
            if (loop.status !== "running") continue;
            yield* rounds
              .recover(loop.root)
              .pipe(
                Effect.catchCause((cause) =>
                  logFailure("recovering interrupted review rounds failed", cause),
                ),
              );
            const state = yield* rounds.read(loop.root).pipe(Effect.orElseSucceed(() => null));
            const open = state?.rounds.find((round) => round.status === "interrupted") ?? null;
            const changed =
              open !== null &&
              (yield* rounds.sourceId(loop.root).pipe(
                Effect.map((source) => source !== open.incumbentSourceId),
                Effect.orElseSucceed(() => false),
              ));
            const at = nowIso();
            yield* save(loop.root, {
              ...loop,
              status: "interrupted",
              finishedAt: at,
              updatedAt: at,
              decision: "interrupt",
              reason: changed
                ? "The server restarted before this review finished. The game folder changed after the incumbent; restore the previous version to continue from it."
                : "The server restarted before this review finished; the incumbent stays selected.",
            }).pipe(Effect.orElseSucceed(() => loop));
            interruptedRoots.push(loop.root);
          }
          // Only the newest loop can own a child: no loop starts while one is
          // held. Re-arm the hold over all its recorded children before any
          // turn can be admitted, without first reading whether they look
          // done; only the background settle's verdict releases it.
          const latest = loops?.[0];
          if (latest !== undefined) {
            const held = yield* hold(latest.root, latest.id, null);
            yield* releaseWhenSettled(
              latest.root,
              held,
              "The server restarted before this review finished.",
            ).pipe(Effect.forkIn(scope));
          }
        }
        return interruptedRoots;
      }).pipe(Effect.catchCause(() => Effect.succeed([] as string[])));

    const restore: GameRepairLoop["Service"]["restore"] = (threadId) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId);
        // A restore rewrites the folder: it takes the game like any action,
        // so it is refused while a recorded review child may still write.
        yield* admission.admit({
          root,
          threadId,
          reason: "An explicit restore superseded the review; its candidate was not selected.",
        });
        const loop = yield* readRecord(root);
        const state = yield* rounds.read(root);
        const round =
          loop === null
            ? undefined
            : state.rounds.findLast(
                (entry) => entry.loopId === loop.id && GameRoundStore.isRestorableRound(entry),
              );
        if (round === undefined)
          return yield* new GameOperationError({
            operation: "restore game review version",
            path: root,
            reason: "invalid-input",
            detail: "The latest review has no restorable round to return from.",
          });
        const restored = yield* rounds.restore(root, round.id, {
          preserveDirectories: preview.directories(root),
        });
        yield* operations.changed(
          root,
          restored.kind === "restored" ? "Previous version restored." : "Restore was blocked.",
        );
        return restored;
      });

    return GameRepairLoop.of({
      ensure,
      submit,
      read,
      interrupt,
      recover,
      awaitIdle,
      restore,
      activity: (threadId) =>
        projects
          .resolve(threadId)
          .pipe(Effect.map((root) => ({ held: live.has(root), phase: phases.get(root) ?? null }))),
    });
  });
  return Layer.effect(GameRepairLoop, make);
};
