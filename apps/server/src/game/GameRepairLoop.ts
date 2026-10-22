// @effect-diagnostics nodeBuiltinImport:off -- The loop record is a server-state file keyed by the game root.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  CommandId,
  DEFAULT_GAME_REVIEW_BUDGET,
  GameOperationError,
  type GameRepairFrame,
  GameRepairLoop as GameRepairLoopSchema,
  type GameRepairLoop as GameRepairLoopRecord,
  GAME_REVIEW_FACETS,
  type GameReviewBallotAnswer,
  type GameReviewBallotPlan,
  type GameReviewBallotRecord,
  type GameReviewCheck,
  type GameReviewDoNotRegress,
  type GameReviewRound as GameReviewRoundRecord,
  type ModelSelection,
  type NodeId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameRepairStudio from "./GameRepairStudio.ts";
import * as GameReviewSessions from "./GameReviewSessions.ts";
import * as GameRoundStore from "./GameRoundStore.ts";
import { gameRecordLocation, readRecordText } from "./gameRecord.ts";

/**
 * One record per game. The newest loop is the only live one; a finished loop
 * stays as the reason the next builder turn replaced it. The array is capped so
 * a long-lived game does not grow an unbounded file.
 */
const StoredLoops = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  loops: Schema.Array(GameRepairLoopSchema),
});
const decodeStoredLoops = Schema.decodeUnknownSync(Schema.fromJsonString(StoredLoops));
const MAX_STORED_LOOPS = 10;

const MAX_REPAIR_PROMPT_DEFECTS = 5;
/** Twelve evidence frames is the session service's limit; four sides share it. */
const BALLOT_FRAMES_PER_SIDE = 3;
const CRITIC_FRAMES = 6;
const REQUIRED_POSITIVE_CHECKS = ["boot", "input"] as const;

export interface GameRepairLoopEnsureInput {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  /** An explicit review-model override, frozen for the whole loop. */
  readonly reviewSelection?: ModelSelection | undefined;
}

export interface GameRepairLoopResumeResult {
  readonly loop: GameRepairLoopRecord;
  readonly resumed: boolean;
  readonly detail: string | null;
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
  frames.map((frame) => ({ id: frame.id, label: frame.label, sourcePath: frame.path }));

const criticFrames = (frames: ReadonlyArray<GameRepairFrame>): GameRepairFrame[] =>
  frames.slice(0, CRITIC_FRAMES).map((frame, index) => ({
    id: `f${index + 1}`,
    label: frame.label,
    path: frame.path,
  }));

const assignmentFrames = (frames: ReadonlyArray<GameRepairFrame>, side: "a" | "b" | "c" | "d") =>
  frames.slice(0, BALLOT_FRAMES_PER_SIDE).map((frame, index) => ({
    id: `${side}${index + 1}`,
    label: `${side.toUpperCase()}: ${frame.label}`,
    sourcePath: frame.path,
  }));

const sideChecks = (checks: ReadonlyArray<GameReviewCheck>, side: string) =>
  checks.map((check) => ({
    id: `${side}:${check.id}`,
    status: check.status,
    ...(check.detail === undefined ? {} : { detail: check.detail }),
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
  | { readonly kind: "failed"; readonly check: string }
  | { readonly kind: "unmeasured"; readonly check: string }
  | { readonly kind: "required"; readonly check: string }
  | { readonly kind: "preservation"; readonly item: string; readonly check: string };

/**
 * The code veto: a check that passed on the incumbent may not fail or become
 * unmeasured, boot and ordinary input must be positively shown, and every
 * preservation item measured by a check must still pass.
 */
const mechanicalVeto = (
  incumbent: ReadonlyArray<GameReviewCheck>,
  candidate: ReadonlyArray<GameReviewCheck>,
  items: ReadonlyArray<GameReviewDoNotRegress>,
): VetoKind | null => {
  const after = new Map(candidate.map((check) => [check.id, check]));
  for (const before of incumbent) {
    if (before.status !== "passed") continue;
    const now = after.get(before.id);
    if (now === undefined || now.status === "unmeasured")
      return { kind: "unmeasured", check: before.id };
    if (now.status === "failed") return { kind: "failed", check: before.id };
  }
  for (const id of REQUIRED_POSITIVE_CHECKS) {
    if (after.get(id)?.status !== "passed") return { kind: "required", check: id };
  }
  for (const item of items) {
    if (item.checkId === undefined) continue;
    if (incumbent.find((check) => check.id === item.checkId)?.status !== "passed") continue;
    if (after.get(item.checkId)?.status !== "passed")
      return { kind: "preservation", item: item.id, check: item.checkId };
  }
  return null;
};

const vetoReason = (veto: VetoKind): string => {
  switch (veto.kind) {
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

/**
 * One ballot's verdict. A ballot promotes only when the challenger is no worse
 * on every facet, strictly better on one, the identical control is a clean tie
 * and every preservation item is preserved on both sides.
 */
const ballotReason = (
  answer: GameReviewBallotAnswer,
  plan: GameReviewBallotPlan,
): string | null => {
  if (GAME_REVIEW_FACETS.some((facet) => answer.control[facet] !== "tie"))
    return `failed-control: ballot ${plan.order} preferred one of two identical control builds.`;
  for (const facet of GAME_REVIEW_FACETS) {
    const choice = answer.main[facet];
    if (choice === "tie") continue;
    if (plan.main[choice] === "incumbent")
      return `worse-build: ballot ${plan.order} rated the incumbent better on ${facet}.`;
  }
  if (
    !GAME_REVIEW_FACETS.some(
      (facet) =>
        answer.main[facet] !== "tie" && plan.main[answer.main[facet] as "A" | "B"] === "challenger",
    )
  )
    return `tie: ballot ${plan.order} found no facet where the challenger is better.`;
  for (const entry of answer.preservation) {
    if (entry.A !== "preserved" || entry.B !== "preserved")
      return `preservation-lost: ballot ${plan.order} did not see ${entry.id} preserved on both builds.`;
  }
  return null;
};

export class GameRepairLoop extends Context.Service<
  GameRepairLoop,
  {
    /**
     * The reactor's entry point: create the loop for a completed builder run
     * whose export is playable, or return the loop already there. Starts the
     * worker when the loop is live.
     */
    readonly ensure: (
      input: GameRepairLoopEnsureInput,
    ) => Effect.Effect<GameRepairLoopRecord | null, GameOperationError>;
    /** The newest loop for the thread's game, if one exists. */
    readonly read: (
      threadId: ThreadId,
    ) => Effect.Effect<GameRepairLoopRecord | null, GameOperationError>;
    /**
     * An explicit Resume: reopens the interrupted round when the folder still
     * matches it, then continues with the remaining budget.
     */
    readonly resume: (
      threadId: ThreadId,
    ) => Effect.Effect<GameRepairLoopResumeResult, GameOperationError>;
    /** Drives the loop until it parks on a child or finishes. */
    readonly kick: (threadId: ThreadId) => Effect.Effect<void, never>;
    /** A child run reached a terminal status; wake its waiting loop. */
    readonly noteChildTerminal: (childThreadId: ThreadId) => Effect.Effect<void, never>;
    /**
     * A user action supersedes the loop: join the worker, cancel and join the
     * child it owns, stop the open round, and record the stop before returning.
     */
    readonly supersede: (threadId: ThreadId, reason: string) => Effect.Effect<void, never>;
    /** Startup reconciliation: running loops become paused until Resume. */
    readonly recover: () => Effect.Effect<ReadonlyArray<string>, never>;
  }
>()("t3/game/GameRepairLoop") {}

export const layer = (options: { readonly stateDir: string }) => {
  const make = Effect.gen(function* () {
    const projects = yield* GameProjectService.GameProjectService;
    const rounds = yield* GameRoundStore.GameRoundStore;
    const sessions = yield* GameReviewSessions.GameReviewSessions;
    const studio = yield* GameRepairStudio.GameRepairStudio;
    const threads = yield* ThreadManagementService.ThreadManagementService;

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
              `${JSON.stringify({ schemaVersion: 1, loops }, null, 2)}\n`,
            );
            await NodeFSP.rename(temporary, found.file);
          } finally {
            await NodeFSP.rm(temporary, { force: true });
          }
        });
        return record;
      });

    const logFailure = (message: string, cause: unknown) => Effect.logWarning(message, { cause });

    const workerFibers = new Map<string, Fiber.Fiber<void, never>>();
    const inFlight = new Set<string>();
    const queued = new Set<string>();
    const superseded = new Set<string>();

    const findRound = (root: string, roundId: string | null) =>
      Effect.gen(function* () {
        if (roundId === null) return null;
        const state = yield* rounds.read(root).pipe(Effect.orElseSucceed(() => null));
        return state?.rounds.find((round) => round.id === roundId) ?? null;
      });

    const cancelWait = (record: GameRepairLoopRecord, reason: string) =>
      Effect.gen(function* () {
        const wait = record.wait;
        if (wait === null) return;
        const childThreadId = ThreadId.make(wait.childThreadId);
        const shell = yield* threads
          .getThreadShell(childThreadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (shell === null) return;
        yield* threads
          .interruptThread({
            projectId: shell.projectId,
            commandId: CommandId.make(`game-repair-cancel:${record.id}:${wait.role}:${wait.order}`),
            threadId: childThreadId,
            ...(wait.runId === null ? {} : { runId: RunId.make(wait.runId) }),
            reason,
          })
          .pipe(
            Effect.catchCause((cause) => logFailure("cancelling a review child failed", cause)),
          );
        // Join the child before the user's action touches the same game.
        yield* threads
          .waitForThread({
            projectId: shell.projectId,
            threadId: childThreadId,
            ...(wait.runId === null ? {} : { runId: RunId.make(wait.runId) }),
            timeoutMs: 15_000,
          })
          .pipe(Effect.catchCause((cause) => logFailure("joining a review child failed", cause)));
      });

    const stopOpenRound = (root: string, reason: string) =>
      rounds.stopRunning(root, reason).pipe(
        Effect.catchCause((cause) => logFailure("stopping the open review round failed", cause)),
        Effect.asVoid,
      );

    const stopLoop = (
      root: string,
      input: GameRepairLoopRecord,
      decision: "promote" | "stop" | "interrupt",
      reason: string,
    ) =>
      Effect.gen(function* () {
        const current = yield* readRecord(root).pipe(Effect.orElseSucceed(() => null));
        const record = current ?? input;
        if (record.status === "stopped") return;
        yield* cancelWait(record, reason);
        yield* stopOpenRound(root, reason);
        const at = nowIso();
        yield* save(root, {
          ...record,
          status: "stopped",
          finishedAt: at,
          updatedAt: at,
          wait: null,
          resumeRequired: false,
          decision,
          reason,
        }).pipe(Effect.orElseSucceed(() => record));
      });

    const rejectRound = (
      root: string,
      record: GameRepairLoopRecord,
      roundId: string,
      reason: string,
    ) =>
      Effect.gen(function* () {
        const rejected = yield* rounds.reject(root, roundId, { reason }).pipe(
          Effect.map((result) => result.kind),
          Effect.orElseSucceed(() => "blocked" as const),
        );
        if (rejected === "blocked") {
          yield* stopLoop(root, record, "stop", `reject-blocked: ${reason}`);
          return false;
        }
        const at = nowIso();
        yield* save(root, {
          ...record,
          phase: "repair",
          roundId: null,
          wait: null,
          lastRejection: reason,
          candidateFrames: [],
          updatedAt: at,
        }).pipe(Effect.orElseSucceed(() => record));
        return true;
      });

    type ChildStep =
      | { readonly kind: "waiting"; readonly started: boolean }
      | { readonly kind: "failed"; readonly reason: string }
      | {
          readonly kind: "terminal";
          readonly status: "completed" | "failed" | "cancelled" | "interrupted" | "rolled_back";
          /** True when this call dispatched (or reconciled) the child itself. */
          readonly started: boolean;
        };

    /**
     * Starts or joins one child. The session record is the restart anchor: a
     * second start reconciles it and dispatches nothing, and the bound run —
     * never the newest run — is what status and answers are read from.
     */
    const childStep = (
      root: string,
      record: GameRepairLoopRecord,
      input: {
        readonly role: GameReviewSessions.GameReviewTaskRole;
        readonly order: number;
        readonly roundId: string;
        readonly evidence?: GameReviewSessions.GameReviewEvidenceInput | undefined;
        readonly repair?: GameReviewSessions.GameReviewRepairInput | undefined;
        readonly items?: ReadonlyArray<{ readonly id: string; readonly what: string }> | undefined;
      },
    ): Effect.Effect<ChildStep, GameOperationError> =>
      Effect.gen(function* () {
        const mine =
          record.wait !== null &&
          record.wait.role === input.role &&
          record.wait.order === input.order &&
          record.wait.roundId === input.roundId;
        if (!mine) {
          const started = yield* sessions.start({
            threadId: record.threadId,
            loopId: record.id,
            roundId: input.roundId,
            role: input.role,
            order: input.order,
            ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
            ...(input.repair === undefined ? {} : { repair: input.repair }),
            ...(input.items === undefined ? {} : { items: input.items }),
          });
          if (started.kind !== "started") return { kind: "failed", reason: started.reason };
          // The run may already be terminal in a scripted test or a fast child.
          const status = yield* sessions.runStatus({
            threadId: record.threadId,
            loopId: record.id,
            roundId: input.roundId,
            role: input.role,
            order: input.order,
          });
          if (status.kind === "terminal") {
            yield* save(root, { ...record, wait: null, updatedAt: nowIso() }).pipe(
              Effect.orElseSucceed(() => record),
            );
            return { kind: "terminal", status: status.status, started: true };
          }
          const at = nowIso();
          yield* save(root, {
            ...record,
            updatedAt: at,
            wait: {
              role: input.role,
              order: input.order,
              roundId: input.roundId,
              commandId: started.commandId,
              childThreadId: started.childThreadId,
              runId: started.runId === null ? null : String(started.runId),
            },
          });
          return { kind: "waiting", started: true };
        }
        const status = yield* sessions.runStatus({
          threadId: record.threadId,
          loopId: record.id,
          roundId: input.roundId,
          role: input.role,
          order: input.order,
        });
        if (status.kind === "missing")
          return { kind: "failed", reason: "The review child's session record is missing." };
        if (status.kind === "pending") return { kind: "waiting", started: false };
        yield* save(root, { ...record, wait: null, updatedAt: nowIso() }).pipe(
          Effect.orElseSucceed(() => record),
        );
        return { kind: "terminal", status: status.status, started: false };
      });

    const reviewStep = (
      root: string,
      record: GameRepairLoopRecord,
    ): Effect.Effect<boolean, GameOperationError> =>
      Effect.gen(function* () {
        const at = nowMs();
        const remaining = remainingBudget(record, at);
        if (remaining.elapsedMs <= 0) {
          yield* stopLoop(root, record, "stop", "budget-exhausted: the review budget ran out.");
          return false;
        }
        const round = yield* findRound(root, record.roundId);
        if (round === null || round.status !== "running") {
          const created = yield* rounds.begin(root, {
            threadId: record.threadId,
            budget: {
              repairs: remaining.repairs,
              elapsedMs: Math.max(1, remaining.elapsedMs),
            },
            loopId: record.id,
            builderSelection: record.builderSelection,
            reviewSelection: record.reviewSelection,
            defects: record.defects,
            doNotRegress: record.doNotRegress,
          });
          yield* save(root, {
            ...record,
            roundId: created.id,
            phase: "review",
            checksDone: false,
            criticDone: false,
            incumbentChecks: [],
            incumbentFrames: [],
            candidateFrames: [],
            wait: null,
            updatedAt: nowIso(),
          });
          return true;
        }
        if (!record.checksDone) {
          const checked = yield* studio.check({
            threadId: record.threadId,
            root,
            target: "incumbent",
          });
          const frames = criticFrames(
            checked.frames.map((frame) => ({ id: "f", label: frame.label, path: frame.path })),
          );
          yield* rounds.recordReview(root, round.id, {
            checks: checked.checks,
          });
          yield* save(root, {
            ...record,
            incumbentChecks: [...checked.checks],
            incumbentFrames: frames,
            checksDone: true,
            updatedAt: nowIso(),
          });
          return true;
        }
        const child = yield* childStep(root, record, {
          role: "critic",
          order: 0,
          roundId: round.id,
          evidence: {
            frames: framesFor(record.incumbentFrames),
            checks: [...record.incumbentChecks],
          },
        });
        if (child.kind === "waiting") return false;
        if (child.kind === "failed") {
          yield* stopLoop(root, record, "stop", `critic-failed: ${child.reason}`);
          return false;
        }
        const answered: GameReviewSessions.GameReviewSessionAnswerResult = yield* sessions.answer({
          threadId: record.threadId,
          loopId: record.id,
          roundId: round.id,
          role: "critic",
          order: 0,
        });
        if (answered.kind === "pending") return false;
        if (answered.kind !== "critic") {
          yield* stopLoop(
            root,
            record,
            "stop",
            `invalid-critic: ${answered.kind === "invalid" ? answered.reason : "the critic did not answer with defects."}`,
          );
          return false;
        }
        const defects = answered.answer.defects
          .toSorted((left, right) => {
            const rank = { blocker: 0, visible: 1, nit: 2 } as const;
            return rank[left.severity] - rank[right.severity];
          })
          .slice(0, MAX_REPAIR_PROMPT_DEFECTS);
        const doNotRegress = answered.answer.doNotRegress;
        if (defects.length === 0) {
          yield* rounds.recordReview(root, round.id, { defects, doNotRegress });
          yield* stopLoop(
            root,
            record,
            "stop",
            "zero-defects: the critic found nothing to repair; the incumbent is kept.",
          );
          return false;
        }
        yield* rounds.recordReview(root, round.id, { defects, doNotRegress });
        yield* save(root, {
          ...record,
          defects,
          doNotRegress,
          criticDone: true,
          phase: "repair",
          updatedAt: nowIso(),
        });
        return true;
      });

    const repairStep = (
      root: string,
      record: GameRepairLoopRecord,
    ): Effect.Effect<boolean, GameOperationError> =>
      Effect.gen(function* () {
        const at = nowMs();
        const remaining = remainingBudget(record, at);
        let round = yield* findRound(root, record.roundId);
        if (round !== null && round.status !== "running") {
          // Something else stopped the round (a user action). The loop must not
          // keep repairing sources it no longer owns.
          yield* stopLoop(
            root,
            record,
            "stop",
            "superseded: the open round was stopped by another action.",
          );
          return false;
        }
        if (remaining.repairs <= 0 || remaining.elapsedMs <= 0) {
          yield* stopLoop(
            root,
            record,
            "stop",
            "budget-exhausted: the review budget ran out before another repair.",
          );
          return false;
        }
        if (round === null) {
          const created = yield* rounds.begin(root, {
            threadId: record.threadId,
            budget: {
              repairs: remaining.repairs,
              elapsedMs: Math.max(1, remaining.elapsedMs),
            },
            loopId: record.id,
            builderSelection: record.builderSelection,
            reviewSelection: record.reviewSelection,
            defects: record.defects,
            doNotRegress: record.doNotRegress,
          });
          yield* save(root, {
            ...record,
            roundId: created.id,
            phase: "repair",
            checksDone: true,
            criticDone: true,
            candidateFrames: [],
            wait: null,
            updatedAt: nowIso(),
          });
          // The next pump starts the child against the newly persisted round.
          return true;
        }
        const child = yield* childStep(root, record, {
          role: "repair",
          order: 0,
          roundId: round.id,
          repair: {
            remainingBudget: budgetText(record, at),
            defects: record.defects,
            doNotRegress: record.doNotRegress,
            ...(record.lastRejection === null ? {} : { previousRejection: record.lastRejection }),
          },
        });
        if (child.kind === "failed") {
          yield* rounds
            .stop(root, round.id, `repair-unavailable: ${child.reason}`)
            .pipe(Effect.catchCause(() => Effect.void));
          yield* stopLoop(root, record, "stop", `repair-unavailable: ${child.reason}`);
          return false;
        }
        const afterChild =
          (yield* readRecord(root).pipe(Effect.orElseSucceed(() => null))) ?? record;
        const attempted: GameRepairLoopRecord = {
          ...afterChild,
          repairsUsed: child.started
            ? Math.min(afterChild.budget.repairs, afterChild.repairsUsed + 1)
            : afterChild.repairsUsed,
          wait: child.kind === "terminal" ? null : afterChild.wait,
          updatedAt: nowIso(),
        };
        // A dispatched repair consumes its attempt even when it produced
        // nothing; persist that before the judging can fail.
        yield* save(root, attempted);
        if (child.kind === "waiting") return false;
        yield* rounds
          .recordPostRepair(root, round.id)
          .pipe(
            Effect.catchCause((cause) => logFailure("recording the repair tree failed", cause)),
          );
        const current = yield* findRound(root, round.id);
        if (current?.candidate != null) {
          yield* save(root, {
            ...attempted,
            phase: "candidate",
            wait: null,
            updatedAt: nowIso(),
          });
          return true;
        }
        const exported = yield* studio.exportState(root).pipe(Effect.orElseSucceed(() => null));
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
              child.status === "completed" ? "" : ` (the repair child ended ${child.status})`
            }`
          : `no-output: the repair produced no exported build${
              child.status === "completed" ? "" : ` (the repair child ended ${child.status})`
            }`;
        return yield* rejectRound(root, attempted, round.id, reason);
      });

    const candidateStep = (
      root: string,
      record: GameRepairLoopRecord,
    ): Effect.Effect<boolean, GameOperationError> =>
      Effect.gen(function* () {
        if (record.roundId === null) {
          yield* stopLoop(root, record, "stop", "invalid-state: a candidate has no round.");
          return false;
        }
        const round = yield* findRound(root, record.roundId);
        if (round === null || round.status !== "running") {
          yield* stopLoop(
            root,
            record,
            "stop",
            "superseded: the open round was stopped by another action.",
          );
          return false;
        }
        if (round.candidate === null) {
          yield* stopLoop(
            root,
            record,
            "stop",
            "invalid-state: the round lost its candidate before it was judged.",
          );
          return false;
        }
        if (round.incumbentBuildId !== null && round.candidate.buildId === round.incumbentBuildId)
          return yield* rejectRound(
            root,
            record,
            round.id,
            "unchanged: the repair exported the same build as the incumbent.",
          );
        if (round.candidateChecks === undefined) {
          const checked = yield* studio.check({
            threadId: record.threadId,
            root,
            target: "candidate",
          });
          const veto = mechanicalVeto(record.incumbentChecks, checked.checks, record.doNotRegress);
          const frames = checked.frames.map((frame, index) => ({
            id: `c${index + 1}`,
            label: frame.label,
            path: frame.path,
          }));
          yield* rounds.recordReview(root, round.id, {
            candidateChecks: [...checked.checks],
            ...(veto === null ? {} : { mechanicalVeto: vetoReason(veto) }),
          });
          const withFrames: GameRepairLoopRecord = {
            ...record,
            candidateFrames: frames,
            updatedAt: nowIso(),
          };
          yield* save(root, withFrames);
          if (veto !== null)
            return yield* rejectRound(
              root,
              withFrames,
              round.id,
              `mechanical-veto: ${vetoReason(veto)}`,
            );
          return true;
        }
        if (round.ballots === undefined) {
          yield* rounds.recordReview(root, round.id, {
            ballots: ballotPlans(record.id, round.id),
          });
          yield* save(root, { ...record, phase: "ballots", updatedAt: nowIso() });
          return true;
        }
        yield* save(root, { ...record, phase: "ballots", updatedAt: nowIso() });
        return true;
      });

    const ballotEvidence = (
      record: GameRepairLoopRecord,
      round: GameReviewRoundRecord,
      plan: GameReviewBallotPlan,
    ) => {
      const buildFrames = (side: "incumbent" | "challenger") =>
        side === "challenger" ? record.candidateFrames : record.incumbentFrames;
      const buildChecks = (side: "incumbent" | "challenger") =>
        side === "challenger" ? (round.candidateChecks ?? []) : record.incumbentChecks;
      const frames = ["A", "B"].flatMap((label) => {
        const side = label as "A" | "B";
        const artifact = plan.main[side];
        return assignmentFrames(buildFrames(artifact), side.toLowerCase() as "a" | "b");
      });
      const controls = ["C", "D"].flatMap((label) => {
        const side = label as "C" | "D";
        return assignmentFrames(record.incumbentFrames, side.toLowerCase() as "c" | "d");
      });
      const checks = [
        ...sideChecks(buildChecks(plan.main.A), "a"),
        ...sideChecks(buildChecks(plan.main.B), "b"),
        ...sideChecks(record.incumbentChecks, "c"),
        ...sideChecks(record.incumbentChecks, "d"),
      ];
      return { frames: [...frames, ...controls], checks };
    };

    const decideStep = (
      root: string,
      record: GameRepairLoopRecord,
    ): Effect.Effect<boolean, GameOperationError> =>
      Effect.gen(function* () {
        if (record.roundId === null) return false;
        const round = yield* findRound(root, record.roundId);
        if (round === null) return false;
        const answers = round.ballotAnswers ?? [];
        const invalid = answers.find((answer) => answer.outcome === "invalid");
        if (invalid !== undefined)
          return yield* rejectRound(
            root,
            record,
            round.id,
            `invalid-ballot: ${invalid.reason ?? "the ballot answer was unusable."}`,
          );
        const plans = round.ballots ?? [];
        for (const plan of plans) {
          const entry = answers.find((answer) => answer.order === plan.order);
          if (entry?.answer === undefined)
            return yield* rejectRound(
              root,
              record,
              round.id,
              `invalid-ballot: ballot ${plan.order} has no usable answer.`,
            );
          const reason = ballotReason(entry.answer, plan);
          if (reason !== null) return yield* rejectRound(root, record, round.id, reason);
        }
        if (answers.length < plans.length)
          return yield* rejectRound(
            root,
            record,
            round.id,
            "invalid-ballot: both pairwise sessions must answer before a decision.",
          );
        const promoted = yield* studio.promote(record.threadId, round.id);
        if (promoted.kind === "blocked") {
          yield* stopLoop(root, record, "stop", `promotion-blocked: ${promoted.detail}`);
          return false;
        }
        const at = nowIso();
        yield* save(root, {
          ...record,
          phase: "review",
          roundId: null,
          checksDone: false,
          criticDone: false,
          incumbentChecks: [],
          incumbentFrames: [],
          candidateFrames: [],
          defects: [],
          doNotRegress: [],
          lastRejection: null,
          wait: null,
          promotedRounds: [...record.promotedRounds, round.id],
          updatedAt: at,
        });
        return true;
      });

    const ballotsStep = (
      root: string,
      record: GameRepairLoopRecord,
    ): Effect.Effect<boolean, GameOperationError> =>
      Effect.gen(function* () {
        if (record.roundId === null) {
          yield* stopLoop(root, record, "stop", "invalid-state: a ballot has no round.");
          return false;
        }
        let round = yield* findRound(root, record.roundId);
        if (round === null || round.status !== "running") {
          yield* stopLoop(
            root,
            record,
            "stop",
            "superseded: the open round was stopped by another action.",
          );
          return false;
        }
        const plans = round.ballots ?? [];
        for (const plan of plans) {
          if ((round.ballotAnswers ?? []).some((answer) => answer.order === plan.order)) continue;
          if (record.candidateFrames.length === 0) {
            yield* stopLoop(
              root,
              record,
              "stop",
              "invalid-state: the challenger has no evidence for a ballot.",
            );
            return false;
          }
          const child = yield* childStep(root, record, {
            role: "ballot",
            order: plan.order,
            roundId: round.id,
            evidence: ballotEvidence(record, round, plan),
            items: record.doNotRegress.map((item) => ({ id: item.id, what: item.what })),
          });
          if (child.kind === "waiting") return false;
          if (child.kind === "failed") {
            yield* recordBallot(root, round, {
              order: plan.order,
              outcome: "invalid",
              reason: child.reason,
            });
            return yield* decideStep(root, record);
          }
          const answered: GameReviewSessions.GameReviewSessionAnswerResult = yield* sessions.answer(
            {
              threadId: record.threadId,
              loopId: record.id,
              roundId: round.id,
              role: "ballot",
              order: plan.order,
            },
          );
          if (answered.kind === "pending") return false;
          if (answered.kind !== "ballot") {
            yield* recordBallot(root, round, {
              order: plan.order,
              outcome: "invalid",
              reason:
                answered.kind === "invalid"
                  ? answered.reason
                  : "the child did not return a ballot.",
              ...(answered.kind === "invalid" && answered.raw !== null
                ? { raw: answered.raw }
                : {}),
            });
            return yield* decideStep(root, record);
          }
          round = yield* recordBallot(root, round, {
            order: plan.order,
            outcome: "valid",
            answer: answered.answer,
            raw: answered.raw,
          });
        }
        return yield* decideStep(root, record);
      });

    const recordBallot = (
      root: string,
      round: GameReviewRoundRecord,
      entry: GameReviewBallotRecord,
    ) =>
      Effect.gen(function* () {
        const answers = [...(round.ballotAnswers ?? []), entry].toSorted(
          (left, right) => left.order - right.order,
        );
        const updated = yield* rounds.recordReview(root, round.id, { ballotAnswers: answers });
        return updated;
      });

    const step = (
      root: string,
      record: GameRepairLoopRecord,
    ): Effect.Effect<boolean, GameOperationError> => {
      switch (record.phase) {
        case "review":
          return reviewStep(root, record);
        case "repair":
          return repairStep(root, record);
        case "candidate":
          return candidateStep(root, record);
        case "ballots":
          return ballotsStep(root, record);
      }
    };

    const pump = (root: string) =>
      Effect.gen(function* () {
        for (;;) {
          const record = yield* readRecord(root).pipe(Effect.orElseSucceed(() => null));
          if (record === null || record.status !== "running") return;
          if (superseded.has(record.id)) return;
          const advanced = yield* step(root, record).pipe(
            Effect.catchCause((cause) =>
              stopLoop(root, record, "stop", `review-error: ${Cause.pretty(cause)}`).pipe(
                Effect.as(false),
              ),
            ),
          );
          if (!advanced) return;
        }
      });

    const kick = (threadId: ThreadId): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId).pipe(Effect.orElseSucceed(() => null));
        if (root === null) return;
        const claimed = yield* Effect.sync(() => {
          if (inFlight.has(root)) {
            queued.add(root);
            return false;
          }
          inFlight.add(root);
          return true;
        });
        if (!claimed) return;
        const record = yield* readRecord(root).pipe(Effect.orElseSucceed(() => null));
        if (record === null || record.status !== "running" || superseded.has(record.id)) {
          yield* Effect.sync(() => inFlight.delete(root));
          return;
        }
        const fiber = yield* pump(root).pipe(Effect.forkChild);
        workerFibers.set(root, fiber);
        yield* Effect.exit(Fiber.join(fiber));
        workerFibers.delete(root);
        const again = yield* Effect.sync(() => {
          inFlight.delete(root);
          return queued.delete(root);
        });
        if (again) yield* kick(threadId);
      }).pipe(Effect.catchCause((cause) => logFailure("the repair loop worker failed", cause)));

    const ensure: GameRepairLoop["Service"]["ensure"] = (input) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(input.threadId);
        const existing = yield* readRecord(root);
        if (existing !== null && existing.status !== "stopped") {
          if (existing.status === "running") yield* kick(input.threadId);
          return existing;
        }
        if (
          existing !== null &&
          String(existing.originatingRunId) === String(input.runId) &&
          existing.originatingNodeId === input.nodeId
        ) {
          if (existing.status === "running") yield* kick(input.threadId);
          return existing;
        }
        const playable = yield* studio.playable(root);
        if (!playable) return null;
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
        const builderSelection = run.modelSelection ?? records.thread.modelSelection;
        const reviewSelection = input.reviewSelection ?? builderSelection;
        const at = nowIso();
        const record: GameRepairLoopRecord = {
          schemaVersion: 1,
          id: NodeCrypto.randomUUID(),
          root,
          threadId: input.threadId,
          originatingRunId: input.runId,
          originatingNodeId: input.nodeId,
          status: "running",
          phase: "review",
          roundId: null,
          repairsUsed: 0,
          budget: DEFAULT_GAME_REVIEW_BUDGET,
          builderSelection,
          reviewSelection,
          startedAt: at,
          updatedAt: at,
          finishedAt: null,
          defects: [],
          doNotRegress: [],
          incumbentChecks: [],
          incumbentFrames: [],
          candidateFrames: [],
          checksDone: false,
          criticDone: false,
          lastRejection: null,
          wait: null,
          resumeRequired: false,
          promotedRounds: [],
          decision: null,
          reason: null,
        };
        yield* save(root, record);
        yield* kick(input.threadId);
        return record;
      });

    const read: GameRepairLoop["Service"]["read"] = (threadId) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId);
        return yield* readRecord(root);
      });

    const resume: GameRepairLoop["Service"]["resume"] = (threadId) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId);
        const record = yield* readRecord(root);
        if (record === null)
          return yield* new GameOperationError({
            operation: "resume game review",
            path: root,
            reason: "invalid-input",
            detail: "This game has no review loop to resume.",
          });
        if (record.status === "stopped")
          return { loop: record, resumed: false, detail: record.reason };
        if (record.status === "running") return { loop: record, resumed: true, detail: null };
        let resumedRecord = record;
        if (record.roundId !== null) {
          const round = yield* findRound(root, record.roundId);
          if (round !== null && round.status === "interrupted") {
            const resumableRepair =
              record.wait?.role === "repair" &&
              round.candidate !== null &&
              round.postRepairSourceId !== null;
            if (record.wait?.role === "repair" && !resumableRepair) {
              // A repair child the restart killed. If it left the incumbent's
              // own bytes untouched, abandon the unattempted round and continue
              // with the remaining budget. If it wrote, only the creator can
              // decide: restoring is an explicit UI action, never automatic.
              const current = yield* rounds.sourceId(root).pipe(Effect.orElseSucceed(() => null));
              if (current !== null && current === round.incumbentSnapshotId) {
                yield* rounds
                  .stop(
                    root,
                    round.id,
                    "The interrupted repair was not judged; a new attempt uses the remaining budget.",
                  )
                  .pipe(Effect.catchCause(() => Effect.void));
                resumedRecord = {
                  ...record,
                  roundId: null,
                  phase: "repair",
                  wait: null,
                  lastRejection:
                    "interrupted: the previous repair was interrupted before it was judged; the attempt still counts.",
                  updatedAt: nowIso(),
                };
              } else {
                const detail =
                  "The interrupted repair changed the game folder and was never judged. Restore the previous version to continue.";
                yield* stopLoop(root, record, "stop", detail);
                const stopped = yield* readRecord(root);
                return { loop: stopped ?? record, resumed: false, detail };
              }
            } else {
              const reopened = yield* rounds.resume(root, round.id);
              if (reopened.kind === "blocked") {
                const detail = `resume-blocked: ${reopened.detail}`;
                yield* stopLoop(root, record, "stop", detail);
                const stopped = yield* readRecord(root);
                return { loop: stopped ?? record, resumed: false, detail };
              }
            }
          }
        }
        const at = nowIso();
        const running: GameRepairLoopRecord = {
          ...resumedRecord,
          status: "running",
          resumeRequired: false,
          reason: null,
          decision: null,
          updatedAt: at,
        };
        yield* save(root, running);
        // Resume is explicit new work: a session record reconciles by command
        // id, so the same child answers without a second dispatch.
        yield* kick(threadId);
        const after = (yield* readRecord(root)) ?? running;
        return { loop: after, resumed: true, detail: null };
      });

    const noteChildTerminal = (childThreadId: ThreadId) =>
      Effect.gen(function* () {
        const directory = NodePath.join(options.stateDir, "game-repair-loops");
        const names = yield* attempt("read game repair loops", directory, () =>
          NodeFSP.readdir(directory),
        ).pipe(Effect.orElseSucceed(() => [] as string[]));
        for (const name of names) {
          if (!name.endsWith(".json")) continue;
          const loops = yield* readFile(NodePath.join(directory, name)).pipe(
            Effect.orElseSucceed(() => []),
          );
          for (const loop of loops ?? []) {
            if (loop.status !== "running") continue;
            if (loop.wait?.childThreadId !== String(childThreadId)) continue;
            yield* kick(loop.threadId);
          }
        }
      }).pipe(Effect.catchCause((cause) => logFailure("waking a review loop failed", cause)));

    const supersede: GameRepairLoop["Service"]["supersede"] = (threadId, reason) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId).pipe(Effect.orElseSucceed(() => null));
        if (root === null) return;
        const record = yield* readRecord(root).pipe(Effect.orElseSucceed(() => null));
        if (record === null || record.status === "stopped") return;
        superseded.add(record.id);
        const fiber = workerFibers.get(root);
        if (fiber !== undefined) {
          // Join the worker: a user action must not race a check or export.
          yield* Fiber.interrupt(fiber);
          workerFibers.delete(root);
        }
        yield* stopLoop(root, record, "stop", reason);
      }).pipe(Effect.catchCause((cause) => logFailure("superseding a review loop failed", cause)));

    const recover: GameRepairLoop["Service"]["recover"] = () =>
      Effect.gen(function* () {
        const directory = NodePath.join(options.stateDir, "game-repair-loops");
        const names = yield* attempt("read game repair loops", directory, () =>
          NodeFSP.readdir(directory),
        ).pipe(Effect.orElseSucceed(() => [] as string[]));
        const paused: string[] = [];
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
            const at = nowIso();
            yield* save(loop.root, {
              ...loop,
              status: "paused",
              resumeRequired: true,
              updatedAt: at,
              finishedAt: null,
              reason:
                "The server restarted before this review finished. Resume to continue with the remaining budget.",
            }).pipe(Effect.orElseSucceed(() => loop));
            paused.push(loop.root);
          }
        }
        return paused;
      });

    return GameRepairLoop.of({
      ensure,
      read,
      resume,
      kick,
      noteChildTerminal,
      supersede,
      recover,
    });
  });
  return Layer.effect(GameRepairLoop, make);
};
