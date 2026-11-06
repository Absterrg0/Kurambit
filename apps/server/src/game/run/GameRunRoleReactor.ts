// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off -- A role's result is measured in the game folder on disk, against wall-clock turn times.
// A role step ends when its thread's turn does: this reactor watches role
// threads' runs settle and dispatches the step's typed result, the
// DelegatedTaskQuestionReactor way. A turn names its step and attempt in its
// message id, and the step record names its thread, so neither a role name nor
// a launch order ever ties a thread to a step. A turn cut short by an instant
// provider failure or by memory is sent again; a usage limit, a provider that
// stays down or memory that stays short ends the run resumably.
import * as NodePath from "node:path";
import {
  CommandId,
  type GameRun,
  type GameRunStep,
  type GameRunStepId,
  type GameRunStepResult,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type ProjectId,
  type RunId,
  type ThreadId,
  gameRunStepCommandId,
  gameRunStepId,
} from "@kurambit/contracts";
import { latestRootProviderFailure } from "@kurambit/shared/orchestrationV2ThreadError";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as KeyedLock from "@kurambit/shared/KeyedLock";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as GameRunJobs from "../../orchestration-v2/gameRun/GameRunJobs.ts";
import {
  gameRunOperationOwner,
  type RoleTurn,
  type RoleTurnKind,
  parseRoleTurn,
  roleCapCommandId,
  roleThreadId as ownThreadIdOf,
  roleTurnCommandId,
  roleTurnMessageId,
} from "../../orchestration-v2/gameRun/ids.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../../serverActivation.ts";
import * as GameOperations from "../GameOperations.ts";
import * as GameProjectService from "../GameProjectService.ts";
import * as GameService from "../GameService.ts";
import { logLine } from "../runSetup.ts";
import { BuildName } from "./buildNames.ts";
import { captureBuild, freeBy, isGameCode, measureChange } from "./builds.ts";
import { MEMORY_PAUSE, MEMORY_WAITS } from "./lowMemory.ts";
import { causeText } from "../runSetup.ts";
import { RETRIES as LANDING_RETRIES, retrying } from "./retrying.ts";
import { lastPlay } from "../botEvidence.ts";
import type { RoleStep, Step } from "./state.ts";

// An instantly failed turn never reached the model (provider or session
// failure, e.g. an unroutable model): it is sent again a few times with a
// back-off, then the run ends resumably. Never loop hundreds of turns on these.
const INSTANT_MS = 8_000;
const RETRIES = 3;
const TERMINAL: ReadonlySet<string> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
export const isSettledRun = (run: OrchestrationV2Run): boolean => TERMINAL.has(run.status);

/** The role turn a step or pair half runs, by its number. */
const roleAt = (step: Step, seq: number): RoleStep | null => {
  if (step.kind === "role") return step.id === seq ? step : null;
  if (step.kind !== "pair") return null;
  const half = step.halves.find((h) => h.id === seq);
  return half?.kind === "role" ? half : null;
};

export interface AttributedTurn {
  readonly run: OrchestrationV2Run;
  readonly turn: RoleTurn;
  /** False for a server restart's continuation of the turn, which carries on its work. */
  readonly sent: boolean;
}

/**
 * Every role turn on one thread, oldest first, each with what its message id
 * says. A restart cancels a running turn and continues it in a run of its own
 * (restartContinuationOfRunId): that run is the same turn, still at work.
 */
export const roleTurns = (runs: ReadonlyArray<OrchestrationV2Run>): AttributedTurn[] => {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const sourceOf = (run: OrchestrationV2Run): RoleTurn | null => {
    let current: OrchestrationV2Run | undefined = run;
    for (let hops = 0; current !== undefined && hops <= runs.length; hops += 1) {
      const turn = parseRoleTurn(current.userMessageId);
      if (turn !== null) return turn;
      const from: RunId | undefined = current.restartContinuationOfRunId;
      current = from === undefined ? undefined : byId.get(from);
    }
    return null;
  };
  return runs
    .flatMap((run) => {
      const turn = sourceOf(run);
      return turn === null ? [] : [{ run, turn, sent: parseRoleTurn(run.userMessageId) !== null }];
    })
    .toSorted((a, b) => a.run.ordinal - b.run.ordinal);
};

/** The step's turns on one role thread, continuations included, oldest first. */
export const stepTurns = (runs: ReadonlyArray<OrchestrationV2Run>, stepId: GameRunStepId) =>
  roleTurns(runs).filter((t) => t.turn.stepId === stepId);

const millis = (value: DateTime.Utc | null | undefined) =>
  value == null ? null : DateTime.toEpochMillis(value);

/** The run's step in flight that `stepId` names (the step or one of its pair's halves). */
export interface Located {
  readonly run: GameRun;
  readonly record: GameRunStep;
  readonly seq: number;
  readonly role: RoleStep | null;
}
const locateIn = (
  records: ProjectionStore.GameRunThreadRecords,
  stepId: GameRunStepId,
  attempt: number,
): Located | null => {
  const run = records.gameRuns.at(-1);
  if (run === undefined || run.status === "ended" || run.inFlight === null) return null;
  const record = records.gameRunSteps.find((s) => s.runId === run.id && s.seq === run.inFlight);
  if (record === undefined || record.attempt !== attempt) return null;
  if (record.status !== "planned" && record.status !== "running") return null;
  const seq =
    record.step.kind === "pair"
      ? (record.step.halves.find((h) => gameRunStepId(run.id, h.id) === stepId)?.id ?? null)
      : record.id === stepId
        ? record.seq
        : null;
  if (seq === null) return null;
  if (record.step.kind === "pair" && record.step.results.some((r) => r.id === seq)) return null;
  if (record.endedHalves.some((r) => r.seq === seq)) return null;
  return { run, record, seq, role: roleAt(record.step, seq) };
};

/** What landing a settled turn leaves to the step's job; null when nothing does. */
export type SettleOutcome = "fresh" | "continue" | null;

/**
 * A turn a server restart cut off: the recovery cancels a running turn, and
 * the run, never the generic restart continuation, carries it on.
 */
export const isCutOff = (run: OrchestrationV2Run): boolean => run.status === "cancelled";

export class GameRunRoleReactor extends Context.Service<
  GameRunRoleReactor,
  {
    /**
     * Lands a role turn that settled, by the rule the event stream applies.
     * "fresh": the step's game-folder role moves to a fresh thread, which the
     * step's job launches. "continue": the turn was cut off (a server restart
     * cancels a running turn), so it is no result; the step's job continues it.
     */
    readonly settle: (
      roleThreadId: ThreadId,
      turnRun: OrchestrationV2Run,
    ) => Effect.Effect<SettleOutcome, Orchestrator.OrchestratorV2Error>;
    /** Sends a role step's turn on its thread, once per message id. */
    readonly sendTurn: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly stepId: GameRunStepId;
      readonly attempt: number;
      readonly kind: RoleTurnKind;
      readonly n: number;
      readonly text: string;
    }) => Effect.Effect<
      void,
      ThreadManagement.ThreadManagementError | Orchestrator.OrchestratorV2Error
    >;
    /**
     * The step `stepId` names while its attempt is in flight, else null. A read
     * that fails is an error, never null: a timer that took it for "the step
     * moved on" would drop or interrupt a turn the step still runs.
     */
    readonly locate: (
      creator: ThreadId,
      stepId: GameRunStepId,
      attempt: number,
    ) => Effect.Effect<Located | null, ProjectionStore.ProjectionStoreV2Error>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("kurambit/game/run/GameRunRoleReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const game = yield* GameService.GameService;
  const operations = yield* GameOperations.GameOperations;
  const projects = yield* GameProjectService.GameProjectService;
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const jobs = yield* GameRunJobs.GameRunJobs;
  // One settle per step attempt at a time: a turn's run is updated more than
  // once after it ends, and its evidence is read (and reset) only once. Other
  // steps (a pair's other half) land meanwhile.
  const locks = yield* KeyedLock.make<string>();

  const locate: GameRunRoleReactor["Service"]["locate"] = (creator, stepId, attempt) =>
    projections
      .getGameRunRecords(creator, { steps: "in-flight" })
      .pipe(Effect.map((records) => locateIn(records, stepId, attempt)));

  const sendTurn: GameRunRoleReactor["Service"]["sendTurn"] = (input) => {
    const messageId = roleTurnMessageId(input.stepId, input.attempt, input.kind, input.n);
    return threads
      .sendToThread({
        projectId: input.projectId,
        commandId: roleTurnCommandId(messageId),
        threadId: input.threadId,
        messageId,
        text: input.text,
        attachments: [],
        // Always a run of its own, behind any run on the thread: "auto" would
        // steer a turn into a run someone else started there, under that run's
        // message id, and the step could no longer tell its turn apart.
        mode: "queue",
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(Effect.asVoid);
  };

  const report = (
    creator: ThreadId,
    at: Located,
    stepId: GameRunStepId,
    result: GameRunStepResult,
  ) =>
    engine
      .dispatch({
        type: "game-run.step.complete",
        commandId: gameRunStepCommandId(stepId, at.record.attempt, "complete"),
        threadId: creator,
        runId: at.run.id,
        stepId,
        attempt: at.record.attempt,
        result,
      })
      .pipe(
        Effect.asVoid,
        Effect.catchTags({
          OrchestratorGameRunRefusedError: (refused) =>
            Effect.logInfo("game run role result not taken", { stepId, detail: refused.detail }),
          OrchestratorCommandPreviouslyRejectedError: () => Effect.void,
        }),
      );

  const assistantText = (threadId: ThreadId, run: OrchestrationV2Run) =>
    threads
      .getThreadRecords(threadId, ["messages"], {
        messageRoles: ["assistant"],
        messageRunIds: [run.id],
      })
      .pipe(
        Effect.map((records) =>
          records.messages
            .map((m) => m.text)
            .join("\n")
            .trim(),
        ),
      );

  const failureOf = (threadId: ThreadId, run: OrchestrationV2Run) =>
    threads
      .getThreadRecords(threadId, ["turnItems"], {
        turnItemRunId: run.id,
        turnItemTypes: ["error"],
      })
      .pipe(Effect.map((records) => latestRootProviderFailure(run, records.turnItems)));

  /**
   * A step whose landing or timer could not be written however often it was
   * tried fails, so the run ends resumably with why instead of holding a step
   * nothing will move. A refusal means the step moved on already.
   */
  const failStep = (input: {
    readonly creator: ThreadId;
    readonly runId: GameRun["id"];
    readonly stepId: GameRunStepId;
    readonly attempt: number;
    readonly reason: string;
  }) =>
    engine
      .dispatch({
        type: "game-run.step.fail",
        commandId: gameRunStepCommandId(input.stepId, input.attempt, "fail"),
        threadId: input.creator,
        runId: input.runId,
        stepId: input.stepId,
        attempt: input.attempt,
        reason: input.reason.slice(0, 300),
      })
      .pipe(
        Effect.asVoid,
        Effect.catchTags({
          OrchestratorGameRunRefusedError: () => Effect.void,
          OrchestratorCommandPreviouslyRejectedError: () => Effect.void,
        }),
        retrying,
        // Recovery owes a step whose failure never got through: it wakes it at startup.
        Effect.catch((cause) =>
          Effect.logWarning("game run step could not be failed; recovery owes it", {
            stepId: input.stepId,
            cause,
          }),
        ),
      );

  // A turn sent again after a pause: a durable timer of the step's, so a
  // restart keeps it and a stop cancels it; the step is checked again when it fires.
  const resendLater = (input: {
    readonly creator: ThreadId;
    readonly at: Located;
    readonly stepId: GameRunStepId;
    readonly turn: "retry" | "memory";
    readonly n: number;
    readonly after: Duration.Input;
  }) =>
    Effect.flatMap(DateTime.now, (now) =>
      engine
        .dispatch({
          type: "game-run.step.schedule",
          commandId: CommandId.make(
            `server:game-run-resend:${input.stepId}:attempt:${input.at.record.attempt}:${input.turn}:${input.n}`,
          ),
          threadId: input.creator,
          runId: input.at.run.id,
          stepId: input.stepId,
          attempt: input.at.record.attempt,
          at:
            DateTime.toEpochMillis(now) + Duration.toMillis(Duration.fromInputUnsafe(input.after)),
          timer: { kind: "resend", turn: input.turn, n: input.n },
        })
        .pipe(
          Effect.asVoid,
          Effect.catchTags({
            OrchestratorGameRunRefusedError: () => Effect.void,
            OrchestratorCommandPreviouslyRejectedError: () => Effect.void,
          }),
          retrying,
          Effect.catch((error) =>
            failStep({
              creator: input.creator,
              runId: input.at.run.id,
              stepId: input.stepId,
              attempt: input.at.record.attempt,
              reason: `its turn could not be set to go again (${causeText(Cause.fail(error))})`,
            }),
          ),
        ),
    );

  /** What a landing reads only once, kept across its retries: closing the explorer resets it. */
  interface Once {
    evidence?: Effect.Success<ReturnType<typeof readEvidence>>;
  }
  const readEvidence = (roleThreadId: ThreadId) =>
    game.finishExploration(roleThreadId).pipe(
      Effect.map((e) => ({
        sessions: e.sessions,
        actions: e.actions,
        executedInputSteps: e.executedInputSteps,
        nominalMs: e.nominalMs,
        images: e.images,
      })),
    );

  const settleLocked = (roleThreadId: ThreadId, turnRun: OrchestrationV2Run, once: Once) =>
    Effect.gen(function* () {
      const { thread, runs } = yield* threads.getThreadRecords(roleThreadId, ["runs"]);
      const turn = roleTurns(runs).find((t) => t.run.id === turnRun.id)?.turn;
      if (turn === undefined) return null;
      const creator = thread.lineage.parentThreadId;
      if (creator === null || thread.launchedBy !== "game_run") return null;
      const at = yield* locate(creator, turn.stepId, turn.attempt);
      if (at === null || at.role === null) return null;
      // The step record says which thread runs it; a thread of another project is never its.
      const entry = at.record.roles.find((r) => r.seq === at.seq);
      if (entry?.threadId !== roleThreadId || thread.projectId !== at.run.projectId) return null;
      const turns = stepTurns(runs, turn.stepId).filter((t) => t.turn.attempt === turn.attempt);
      // The latest run of the turn decides: a restart's continuation still at work is the turn.
      const latest = turns.at(-1);
      if (latest === undefined || latest.run.id !== turnRun.id || !isSettledRun(latest.run))
        return null;
      if (
        (yield* threads.getCommandReceipt(
          gameRunStepCommandId(turn.stepId, turn.attempt, "complete"),
        )) !== null
      )
        return null;
      if (isCutOff(latest.run)) return "continue" as const;
      const role = at.role;
      const root = yield* projects.resolve(creator);
      const log = (line: string) => logLine(root, line);
      const run = latest.run;
      const next = Math.max(...turns.map((t) => t.turn.n)) + 1;
      const again = (kind: "retry" | "memory", after: Duration.Input) =>
        resendLater({ creator, at, stepId: turn.stepId, turn: kind, n: next, after });
      const end = (ending: "usage-limit" | "provider-down" | "low-memory", reason: string) =>
        report(creator, at, turn.stepId, { kind: "ended", ending, reason: reason.slice(0, 300) });

      if (run.status === "failed") {
        const failure = yield* failureOf(roleThreadId, run);
        if (failure?.class === "usage_limit")
          return yield* end(
            "usage-limit",
            `usage limit${failure.resetAt ? ` until ${failure.resetAt}` : ""}: ${failure.message}`,
          );
        const startedAt = millis(run.startedAt);
        const completedAt = millis(run.completedAt) ?? Date.now();
        const instant =
          (startedAt === null || completedAt - startedAt < INSTANT_MS) &&
          (yield* assistantText(roleThreadId, run)).length === 0;
        if (instant) {
          const reason =
            failure === null
              ? "run failed with no provider message"
              : `${failure.class}: ${failure.message}`;
          const retries = turns.filter((t) => t.sent && t.turn.kind === "retry").length;
          // A thread that had turns before this step can be refused by its own
          // provider session (reasoning under an earlier quota or key), and every
          // resend fails the same way: a game-folder role continues once in a
          // fresh thread, since its work is in the files.
          const fresh = ownThreadIdOf(turn.stepId, turn.attempt, "fresh");
          if (
            retries === 0 &&
            at.role.at === null &&
            roleThreadId !== fresh &&
            roleThreadId !== ownThreadIdOf(turn.stepId, turn.attempt)
          ) {
            yield* log(
              `${role.role}: thread ${roleThreadId} fails at once; continuing in a fresh thread`,
            );
            return "fresh" as const;
          }
          if (retries >= RETRIES) return yield* end("provider-down", reason);
          yield* log(`${role.role}: instant-failed turn (${reason}) [${retries + 1}/${RETRIES}]`);
          return yield* again("retry", Duration.seconds(15 * 2 ** retries));
        }
      }
      // A sample's play turn that did not play because its explore start was
      // refused for memory plays again on a fresh clock; memory that never
      // frees ends the run resumably instead of voiding the sample. Only play
      // turns: the write-up does not play.
      if (role.inputCapMs > 0 && !role.release) {
        // The marks count from this turn's send (the memory resend resets
        // them): a turn that played keeps its result, since a replay would
        // give one side a second turn, and one that never tried to start is
        // not the machine's fault.
        const mark = yield* game.exploreMemoryWait(roleThreadId);
        if (mark.refused && mark.executedInputSteps === 0) {
          const waits = turns.filter((t) => t.sent && t.turn.kind === "memory").length;
          if (waits >= MEMORY_WAITS)
            return yield* end("low-memory", `${role.role}: explore start refused, memory short`);
          yield* log(
            `${role.role}: explore start refused, memory short; waiting ${MEMORY_PAUSE} (${waits + 1} of ${MEMORY_WAITS})`,
          );
          // The marks stay until the resend starts the next turn over: a landing
          // run again before then reads the same marks and sets the same timer.
          return yield* again("memory", MEMORY_PAUSE);
        }
      }

      const first = turns[0]?.run ?? run;
      const startedMs = millis(first.startedAt) ?? millis(first.requestedAt) ?? Date.now();
      const now = Date.now();
      // Capped only by the cap's own interrupt; any other interrupt is the turn's end.
      const timedOut =
        run.status === "interrupted" &&
        (yield* threads.getCommandReceipt(roleCapCommandId(turn.stepId, turn.attempt, run.id)))
          ?.status === "accepted";
      const budgetCut = timedOut && at.run.budgetEndsAt !== null && now >= at.run.budgetEndsAt;
      // Evidence is cumulative per thread; closing here also releases the
      // thread's explorer so nothing stays open between roles.
      once.evidence ??= yield* readEvidence(roleThreadId);
      const evidence = once.evidence;
      // A missing sheet is no verdict: the comparators then see neither build's.
      const sheet =
        role.sheet === ""
          ? ""
          : yield* game.exploreSheet(roleThreadId, NodePath.join(root, role.sheet)).pipe(
              Effect.flatMap((drawn) =>
                drawn > 0
                  ? Effect.succeed(role.sheet)
                  : log(`${role.role}: no frames to draw a sheet from`).pipe(Effect.as("")),
              ),
              Effect.catch((error) =>
                log(`${role.role}: frame sheet not drawn: ${error.detail ?? error.reason}`).pipe(
                  Effect.as(""),
                ),
              ),
            );
      // A source role's work is a build of its own, measured against the build
      // before it; a diff that cannot be read counts as a change.
      const since = role.since ?? "";
      const sourceAfter = role.source
        ? yield* captureBuild(
            {
              checkpoints,
              // The landing waits out another owner's operation rather than
              // fail its capture on contention.
              lock: {
                operations,
                owner: gameRunOperationOwner(at.run.id),
                waitUntil: yield* freeBy,
              },
            },
            root,
            at.run.id,
            // A turn not kept as a build has no build to judge: the landing is tried again.
            BuildName.turn(turn.stepId, turn.attempt),
          )
        : "";
      const changed = role.source
        ? (yield* measureChange(checkpoints, root, isGameCode(at.run.lane), since, sourceAfter))
            .changed
        : undefined;
      // The bot service's record of this thread's runs: a file in the folder
      // the role works in could say anything.
      const bots = role.bots ? yield* game.botRuns(roleThreadId) : null;
      yield* log(
        `  step ${at.seq}: ${role.role} done${timedOut ? " (capped)" : ""} on ${roleThreadId}`,
      );
      yield* report(creator, at, turn.stepId, {
        kind: "done",
        threadId: roleThreadId,
        evidence,
        timedOut,
        budgetCut,
        elapsedMs: now - startedMs,
        sourceBefore: since,
        sourceAfter,
        ...(changed === undefined ? {} : { changed }),
        bots: bots?.count ?? 0,
        bot: bots === null ? null : lastPlay(bots),
        sheet,
      });
    });

  /** The step turn a settled run belongs to, read off its thread; null for any other run. */
  const turnOf = (roleThreadId: ThreadId, turnRun: OrchestrationV2Run) => {
    const candidate =
      parseRoleTurn(turnRun.userMessageId) !== null ||
      turnRun.restartContinuationOfRunId !== undefined;
    if (!candidate || !isSettledRun(turnRun)) return Effect.succeed(null);
    const own = parseRoleTurn(turnRun.userMessageId);
    if (own !== null) return Effect.succeed(own);
    return threads
      .getThreadRecords(roleThreadId, ["runs"])
      .pipe(
        Effect.map(
          ({ runs }) => roleTurns(runs).find((t) => t.run.id === turnRun.id)?.turn ?? null,
        ),
      );
  };

  const settle: GameRunRoleReactor["Service"]["settle"] = (roleThreadId, turnRun) =>
    Effect.flatMap(turnOf(roleThreadId, turnRun), (turn) =>
      turn === null ? Effect.succeed(null) : settleTurn(roleThreadId, turnRun, turn),
    );

  // A landing that breaks is tried again; one that never lands fails its step.
  const settleTurn = (roleThreadId: ThreadId, turnRun: OrchestrationV2Run, turn: RoleTurn) => {
    const once: Once = {};
    return locks
      .withLock(
        `${turn.stepId}:${turn.attempt}`,
        retrying(settleLocked(roleThreadId, turnRun, once)),
      )
      .pipe(
        Effect.map((outcome): SettleOutcome =>
          outcome === "fresh" || outcome === "continue" ? outcome : null,
        ),
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("game run role result failed", {
              threadId: roleThreadId,
              error,
            });
            const shell = yield* retrying(threads.getThreadShell(roleThreadId)).pipe(
              Effect.orElseSucceed(() => null),
            );
            const creator = shell?.lineage.parentThreadId ?? null;
            if (creator === null) return null;
            yield* failStep({
              creator,
              runId: turn.runId,
              stepId: turn.stepId,
              attempt: turn.attempt,
              reason: `its turn could not be landed after ${LANDING_RETRIES + 1} tries (${causeText(Cause.fail(error))})`,
            });
            return null;
          }),
        ),
      );
  };

  // The event consumer only reads and hands over: landing a turn (closing its
  // explorer, drawing its sheet, hashing its sources) is a job of the run's.
  // A move to a fresh thread and a cut-off turn's continuation are the step
  // job's: it launches the role's threads and sends its turns.
  const handle: GameRunRoleReactor["Service"]["handle"] = (event) =>
    event.type !== "run.updated"
      ? Effect.void
      : Effect.flatMap(
          // A continuation names its turn only through the run it continues;
          // a read that never gets through leaves it to recovery at startup.
          retrying(turnOf(event.threadId, event.payload)).pipe(
            Effect.catch((error) =>
              Effect.logWarning("a role turn could not be read; recovery owes its step", {
                threadId: event.threadId,
                error,
              }).pipe(Effect.as(null)),
            ),
          ),
          (turn) =>
            turn === null
              ? Effect.void
              : jobs.fork(
                  `land:${turn.stepId}:attempt:${turn.attempt}:${event.payload.id}`,
                  turn.runId,
                  settleTurn(event.threadId, event.payload, turn).pipe(
                    Effect.flatMap((outcome) =>
                      outcome === null
                        ? Effect.void
                        : Effect.gen(function* () {
                            const { thread } = yield* threads.getThreadRecords(event.threadId, []);
                            const creator = thread.lineage.parentThreadId;
                            if (creator === null) return;
                            // The step's job runs the whole step record: a pair's half
                            // hands over its pair, whose job carries on only the owed half.
                            const at = yield* locate(creator, turn.stepId, turn.attempt);
                            if (at === null) return;
                            yield* jobs.execute({
                              threadId: creator,
                              runId: turn.runId,
                              stepId: at.record.id,
                              attempt: turn.attempt,
                            });
                          }).pipe(
                            // Without the handoff nothing moves the step on: tried
                            // again, and one that never gets through is logged for
                            // recovery, which wakes the step at startup.
                            retrying,
                            Effect.catch((error) =>
                              Effect.logWarning(
                                "a role's move to its step job failed; recovery owes it",
                                { threadId: event.threadId, error },
                              ),
                            ),
                          ),
                    ),
                  ),
                ),
        );

  const start: GameRunRoleReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("game run role event stream failed", { cause }),
        ),
      ),
    );

  return GameRunRoleReactor.of({ settle, sendTurn, locate, start, handle });
});

export const layer = Layer.effect(GameRunRoleReactor, make);
