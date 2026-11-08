// A keep-going step's turn is an ordinary T3 turn in the person's chat; this
// reactor watches it, the DelegatedTaskQuestionReactor way. The step's message
// id names the step and attempt, and a restart's continuation of the turn is
// the same turn, so the T3 runs say which step they are. The reactor starts
// the step when its run starts, cancels a step run that came up queued behind
// someone else's turn, and reports the turn's typed result once its run is
// over and its checkpoint (the build) has landed. It also does what keep going
// owes the game's other turns (the person goes first, in any chat): a turn
// that starts in another chat supersedes a waiting proposal and stops a step
// turn at work, a turn that ends wakes a look or an undo waiting for the game
// to be idle, and archiving the chat keep going runs in stops it. Every change
// of the run's records is pushed to the game's clients (the `run` scope).
import {
  CommandId,
  type GameOperationError,
  type GameRunStepResult,
  type GameRunTurnStep,
  type MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type ProjectId,
  type RunId,
  type ThreadId,
  gameRunStepCommandId,
} from "@kurambit/contracts";
import { latestRootProviderFailure } from "@kurambit/shared/orchestrationV2ThreadError";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as GameRunJobs from "../../orchestration-v2/gameRun/GameRunJobs.ts";
import {
  type StepTurn,
  parseStepTurn,
  stepCapCommandId,
  stepTurnCommandId,
  stepTurnMessageId,
} from "../../orchestration-v2/gameRun/ids.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../../serverActivation.ts";
import * as GameBuilds from "../GameBuilds.ts";
import * as GameOperations from "../GameOperations.ts";
import * as GameProjectService from "../GameProjectService.ts";
import { providerEnding } from "./handBack.ts";
import { type Located, locateIn, projectStep, refusedOnly, supersedeProposal } from "./inFlight.ts";
import { stepLine } from "./runView.ts";
import { type GameRunWorkBroke, retrying } from "./retrying.ts";

const ACTIVE: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);
const isActive = (run: OrchestrationV2Run) => ACTIVE.has(run.status);
const millis = (value: DateTime.Utc | null | undefined) =>
  value == null ? null : DateTime.toEpochMillis(value);

/** The step a run is, through the restart continuations that carried it on; null for any other run. */
const stepTurnOf = (
  run: OrchestrationV2Run,
  runs: ReadonlyArray<OrchestrationV2Run>,
): StepTurn | null => {
  let current: OrchestrationV2Run | undefined = run;
  for (let hops = 0; current !== undefined && hops <= runs.length; hops += 1) {
    const turn = parseStepTurn(current.userMessageId);
    if (turn !== null) return turn;
    const from: RunId | undefined = current.restartContinuationOfRunId;
    current = from === undefined ? undefined : runs.find((each) => each.id === from);
  }
  return null;
};

/** The step's turn: the run its message started, then each restart continuation of it. */
export const stepChain = (
  runs: ReadonlyArray<OrchestrationV2Run>,
  messageId: MessageId,
): ReadonlyArray<OrchestrationV2Run> => {
  const root = runs.find((run) => run.userMessageId === messageId);
  if (root === undefined) return [];
  const chain = [root];
  for (let next = root; ;) {
    const continued = runs.find((run) => run.restartContinuationOfRunId === next.id);
    if (continued === undefined || chain.includes(continued)) return chain;
    chain.push(continued);
    next = continued;
  }
};

/** What the step's turn asks of keep going now. */
export type StepTurnMove =
  /** Nothing yet: not sent, at work, or its checkpoint not in yet. */
  | { readonly kind: "wait" }
  /** It came up queued behind another turn: cancelled, the step superseded. */
  | { readonly kind: "cancel"; readonly run: OrchestrationV2Run }
  /** It waited behind another turn and started late: stopped, the step superseded. */
  | { readonly kind: "late"; readonly run: OrchestrationV2Run }
  /** It started: the step starts. */
  | { readonly kind: "start"; readonly run: OrchestrationV2Run }
  /** It is over, with its checkpoint when it has one: the step lands. */
  | { readonly kind: "land"; readonly run: OrchestrationV2Run }
  /** Stopped, its checkpoint not in: it lands once no capture is owed. */
  | { readonly kind: "uncaptured"; readonly run: OrchestrationV2Run }
  /** A restart cut it off; T3 continues it, or it lands once nothing will. */
  | { readonly kind: "cut-off"; readonly run: OrchestrationV2Run };

/**
 * PURE. The step's turn as its thread's runs show it. A step starts from the
 * folder its proposal read, so a turn that waited behind another (the person
 * sent a message between the look and the dispatch) never runs late.
 */
export const stepTurnMove = (
  chain: ReadonlyArray<OrchestrationV2Run>,
  runs: ReadonlyArray<OrchestrationV2Run>,
  started: boolean,
): StepTurnMove => {
  const root = chain[0];
  const latest = chain.at(-1);
  if (root === undefined || latest === undefined) return { kind: "wait" };
  if (latest.status === "queued")
    return chain.length === 1 ? { kind: "cancel", run: latest } : { kind: "wait" };
  if (isActive(latest)) {
    if (started || latest.status === "preparing" || latest.status === "starting")
      return { kind: "wait" };
    const requested = DateTime.toEpochMillis(root.requestedAt);
    const behind = runs.some(
      (other) =>
        other.ordinal < root.ordinal &&
        !chain.includes(other) &&
        (millis(other.completedAt) ?? 0) > requested,
    );
    return behind ? { kind: "late", run: latest } : { kind: "start", run: latest };
  }
  switch (latest.status) {
    case "completed":
    case "failed":
    case "rolled_back":
      return { kind: "land", run: latest };
    case "interrupted":
      return latest.checkpointId === null
        ? { kind: "uncaptured", run: latest }
        : { kind: "land", run: latest };
    case "cancelled":
      // Cancelled in the queue is the end; once at work, a restart cut it off.
      return latest.startedAt === null
        ? { kind: "land", run: latest }
        : { kind: "cut-off", run: latest };
    default:
      return { kind: "wait" };
  }
};

export { type Located, locateIn, refusedOnly };

type TurnResult = Extract<GameRunStepResult, { readonly kind: "turn" }>;

export class GameRunTurnReactor extends Context.Service<
  GameRunTurnReactor,
  {
    /**
     * Does what the step's turn asks now (start, cancel, land), by its
     * thread's runs. `fromJob` is the step's own job (its dispatch, or a
     * recovery's re-run): only it lands a turn a restart cut off, since by
     * then T3 has continued it or never will.
     */
    readonly settle: (
      located: Located,
      turn: StepTurn,
      options: { readonly fromJob: boolean },
    ) => Effect.Effect<
      void,
      | Orchestrator.OrchestratorV2Error
      | GameOperationError
      | GameRunWorkBroke
      | EffectOutbox.EffectOutboxError
    >;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("kurambit/game/run/GameRunTurnReactor") {}

/** A step's turn that never ran, or ran behind another: the run looks again. */
export const supersededTurn = (runId: RunId | null, reason: string): TurnResult => ({
  kind: "turn",
  runId,
  outcome: "superseded",
  build: null,
  startBuild: null,
  files: 0,
  tokens: null,
  elapsedMs: 0,
  personSteered: false,
  reason,
});

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const builds = yield* GameBuilds.GameBuilds;
  const jobs = yield* GameRunJobs.GameRunJobs;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const operations = yield* GameOperations.GameOperations;
  const projects = yield* GameProjectService.GameProjectService;

  const complete = (located: Located, result: GameRunStepResult) =>
    refusedOnly(
      engine.dispatch({
        type: "game-run.step.complete",
        commandId: gameRunStepCommandId(located.record.id, located.record.attempt, "complete"),
        threadId: located.run.threadId,
        runId: located.run.id,
        stepId: located.record.id,
        attempt: located.record.attempt,
        result,
      }),
    );

  // A queued turn is cancelled; one at work is interrupted, as T3's Stop does.
  const interrupt = (threadId: ThreadId, run: OrchestrationV2Run, key: string, reason: string) =>
    refusedOnly(
      engine.dispatch(
        run.status === "queued"
          ? {
              type: "queued-run.cancel",
              commandId: CommandId.make(`server:game-run-step-${key}:${run.id}`),
              threadId,
              runId: run.id,
            }
          : {
              type: "run.interrupt",
              commandId: CommandId.make(`server:game-run-step-${key}:${run.id}`),
              threadId,
              runId: run.id,
              reason,
            },
      ),
    );

  /**
   * The step starts with its turn. A start the run refuses (it ended, the step
   * moved on) leaves a turn no step owns: it is stopped, so nothing edits the
   * game for a run that is over.
   */
  const startStep = (located: Located, run: OrchestrationV2Run) =>
    engine
      .dispatch({
        type: "game-run.step.start",
        commandId: gameRunStepCommandId(located.record.id, located.record.attempt, "start"),
        threadId: located.run.threadId,
        runId: located.run.id,
        stepId: located.record.id,
        attempt: located.record.attempt,
      })
      .pipe(
        Effect.asVoid,
        Effect.catchTags({
          OrchestratorGameRunRefusedError: () =>
            isActive(run)
              ? interrupt(
                  located.run.threadId,
                  run,
                  "orphan",
                  "Keep going moved on before this step's turn started.",
                )
              : Effect.void,
          OrchestratorCommandPreviouslyRejectedError: () => Effect.void,
        }),
      );

  /** Input plus output tokens of the turn's provider turns, as the provider reported them. */
  const tokensOf = (threadId: ThreadId, chain: ReadonlyArray<OrchestrationV2Run>) =>
    Effect.map(threads.getThreadRecords(threadId, ["attempts", "providerTurns"]), (records) => {
      const ids = new Set(chain.map((run) => run.id));
      const attempts = new Set(
        records.attempts.filter((each) => ids.has(each.runId)).map((each) => each.id),
      );
      let sum: number | null = null;
      for (const turn of records.providerTurns) {
        const usage = turn.turnTokenUsage;
        if (turn.runAttemptId === null || !attempts.has(turn.runAttemptId) || usage === undefined)
          continue;
        if (usage.inputTokens === undefined && usage.outputTokens === undefined) continue;
        sum = (sum ?? 0) + (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      }
      return sum;
    });

  /** The person steered the turn: a message of theirs went into one of its runs. */
  const steeredBy = (threadId: ThreadId, chain: ReadonlyArray<OrchestrationV2Run>) =>
    Effect.map(
      threads.getThreadRecords(threadId, ["messages"], {
        messageRoles: ["user"],
        messageRunIds: chain.map((run) => run.id),
      }),
      (records) => {
        const own = new Set<string>(chain.map((run) => run.userMessageId));
        return records.messages.some((message) => !own.has(message.id));
      },
    );

  const land = (
    located: Located,
    turn: GameRunTurnStep,
    chain: ReadonlyArray<OrchestrationV2Run>,
    latest: OrchestrationV2Run,
    cutOff: boolean,
  ) =>
    Effect.gen(function* () {
      const threadId = located.run.threadId;
      const stepId = located.record.id;
      const attempt = located.record.attempt;
      // A turn that ran lands as started: the captured steer it carried is spent.
      if (located.record.status === "planned" && chain.some((run) => run.startedAt !== null))
        yield* startStep(located, latest);
      let failed = "its turn failed";
      if (latest.status === "failed") {
        const { turnItems } = yield* threads.getThreadRecords(threadId, ["turnItems"], {
          turnItemRunId: latest.id,
          turnItemTypes: ["error"],
        });
        const failure = latestRootProviderFailure(latest, turnItems);
        const ended = providerEnding(failure);
        if (ended !== null) return yield* complete(located, ended);
        if (failure !== null) failed = `its turn failed: ${failure.message}`.slice(0, 300);
      }
      const capped =
        latest.status === "interrupted" &&
        (yield* threads.getCommandReceipt(stepCapCommandId(stepId, attempt, latest.id)))?.status ===
          "accepted";
      const outcome: TurnResult["outcome"] =
        latest.status === "completed"
          ? "completed"
          : latest.status === "failed" || cutOff
            ? "failed"
            : capped
              ? "capped"
              : latest.status === "cancelled"
                ? "superseded"
                : "stopped-by-person";
      const kept =
        outcome === "superseded" || latest.status === "failed"
          ? null
          : yield* builds.turnBuild(threadId, latest.id, turn.base);
      const first = chain[0] ?? latest;
      const from = millis(first.startedAt) ?? DateTime.toEpochMillis(first.requestedAt);
      const to = millis(latest.completedAt) ?? DateTime.toEpochMillis(yield* DateTime.now);
      const reason =
        outcome === "capped"
          ? `stopped at its ${Math.round(turn.capMs / 60_000)}-minute cap`
          : outcome === "superseded"
            ? "another turn went first"
            : outcome === "stopped-by-person"
              ? latest.status === "rolled_back"
                ? "you rolled the chat back past it"
                : "you stopped its turn"
              : cutOff
                ? "the server restarted during its turn and did not continue it"
                : latest.status === "failed"
                  ? failed
                  : "";
      yield* complete(located, {
        kind: "turn",
        runId: latest.id,
        outcome,
        build: kept?.build ?? null,
        startBuild: kept?.startBuild ?? null,
        files: kept?.files ?? 0,
        tokens: yield* tokensOf(threadId, chain),
        elapsedMs: Math.max(0, to - from),
        personSteered: yield* steeredBy(threadId, chain),
        reason,
      });
    });

  const superseded = (located: Located, runId: RunId | null, reason: string) =>
    complete(located, supersededTurn(runId, reason));

  /** The step's job runs again behind the thread's owed effects (a checkpoint capture). */
  const wakeLater = (located: Located) =>
    Effect.flatMap(DateTime.now, (now) =>
      refusedOnly(
        engine.dispatch({
          type: "game-run.step.schedule",
          commandId: CommandId.make(
            `server:game-run-step-capture:${located.record.id}:attempt:${located.record.attempt}:${DateTime.toEpochMillis(now)}`,
          ),
          threadId: located.run.threadId,
          runId: located.run.id,
          stepId: located.record.id,
          attempt: located.record.attempt,
          at: DateTime.toEpochMillis(now),
          timer: { kind: "recover" },
        }),
      ),
    );

  const settle: GameRunTurnReactor["Service"]["settle"] = (located, turn, options) =>
    Effect.gen(function* () {
      const step = located.record.step;
      if (step.kind !== "turn") return;
      const threadId = located.run.threadId;
      const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
      const chain = stepChain(runs, stepTurnMessageId(turn.stepId, turn.attempt));
      const move = stepTurnMove(chain, runs, located.record.status === "running");
      const own = stepTurnCommandId(stepTurnMessageId(turn.stepId, turn.attempt));
      switch (move.kind) {
        case "wait":
          return;
        case "start":
          return yield* startStep(located, move.run);
        case "cancel":
          yield* refusedOnly(
            engine.dispatch({
              type: "queued-run.cancel",
              commandId: CommandId.make(`${own}:cancel`),
              threadId,
              runId: move.run.id,
            }),
          );
          return yield* superseded(located, move.run.id, "your message went first");
        case "late":
          yield* interrupt(
            threadId,
            move.run,
            "late",
            "Keep going's step waited behind another turn; it starts again from the game as it is now.",
          );
          return yield* superseded(located, move.run.id, "your message went first");
        case "land":
          return yield* land(located, step, chain, move.run, false);
        // A stopped or cut-off turn's checkpoint may still be on its way; once no
        // capture is owed none will come (T3 records a restart's cut-off with no
        // checkpoint), so the step lands rather than wait forever. A cut-off
        // lands only from the step's own job: recovery's wake runs it behind
        // the thread's owed effects, after any restart continuation, so a turn
        // T3 carries on is never landed. A stopped turn has no continuation.
        case "uncaptured":
        case "cut-off": {
          if (move.kind === "cut-off" && !options.fromJob) return;
          const owed =
            move.run.checkpointId === null &&
            (yield* outbox.hasUnsettled({ threadId, effectTypes: ["checkpoint.capture"] }));
          // The capture's own run.updated lands it; the job's wake waits behind it.
          if (owed) return options.fromJob ? yield* wakeLater(located) : undefined;
          return yield* land(located, step, chain, move.run, move.kind === "cut-off");
        }
      }
    });

  /** A step turn's run moved: the step's own work, in the step's job lane. */
  const onStepRun = (threadId: ThreadId, turn: StepTurn, run: OrchestrationV2Run) =>
    jobs.fork(
      `turn:${turn.stepId}:attempt:${turn.attempt}`,
      turn.runId,
      retrying(
        Effect.gen(function* () {
          const records = yield* projections.getGameRunRecords(threadId, { steps: "in-flight" });
          const located = locateIn(records, turn.stepId, turn.attempt);
          if (located !== null) return yield* settle(located, turn, { fromJob: false });
          // No step owns this turn any more (the run stopped, the step moved on):
          // it is stopped, so nothing edits the game for a run that is over.
          if (isActive(run) && run.status !== "waiting")
            yield* interrupt(threadId, run, "orphan", "Keep going stopped; this step's turn ends.");
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("a keep-going step's turn could not be read; recovery owes it", {
            threadId,
            stepId: turn.stepId,
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    );

  // A thread's project and whether it is a person's own chat (no parent), read
  // once: neither ever changes. A subagent's or delegated task's thread works
  // for the turn that launched it, the step's own included.
  const threadOf = new Map<ThreadId, { readonly projectId: ProjectId; readonly own: boolean }>();
  const threadInfo = (threadId: ThreadId) =>
    threadOf.has(threadId)
      ? Effect.succeed(threadOf.get(threadId) ?? null)
      : Effect.map(projections.getThreadShell(threadId), (shell) => {
          if (shell === null) return null;
          const info = { projectId: shell.projectId, own: shell.lineage.parentThreadId === null };
          if (threadOf.size > 2000) threadOf.clear();
          threadOf.set(threadId, info);
          return info;
        });

  /**
   * Another turn on the game moved. One that starts in a person's chat goes
   * first: it supersedes a waiting proposal, and stops a step turn at work in
   * another chat, so the step never runs beside it and its build never holds
   * the person's changes. One that ends wakes a look or an undo waiting for
   * the game to be idle.
   */
  const onOtherRun = (threadId: ThreadId, run: OrchestrationV2Run) =>
    Effect.gen(function* () {
      const info = yield* threadInfo(threadId);
      if (info === null) return;
      const located = yield* projectStep(projections, info.projectId);
      if (located === null) return;
      const step = located.record.step;
      const starting =
        run.status === "preparing" || run.status === "starting" || run.status === "running";
      if (starting && info.own && step.kind === "propose")
        return yield* supersedeProposal(engine, located);
      if (starting && info.own && step.kind === "turn" && threadId !== located.run.threadId)
        return yield* personFirst(located, threadId);
      if ((step.kind === "look" || step.kind === "undo") && !isActive(run))
        yield* jobs.execute({
          threadId: located.run.threadId,
          runId: located.run.id,
          stepId: located.record.id,
          attempt: located.record.attempt,
        });
    });

  /** A person's turn in another chat started while the step's turn works: it goes first. */
  const personFirst = (located: Located, threadId: ThreadId) =>
    Effect.gen(function* () {
      const { runs } = yield* threads.getThreadRecords(located.run.threadId, ["runs"]);
      const chain = stepChain(runs, stepTurnMessageId(located.record.id, located.record.attempt));
      const live = chain.at(-1);
      if (live !== undefined && isActive(live) && live.status !== "waiting")
        yield* interrupt(
          located.run.threadId,
          live,
          "person",
          "Your turn in another chat goes first; keep going looks again after it.",
        );
      const shell = yield* projections.getThreadShell(threadId);
      yield* superseded(
        located,
        live?.id ?? null,
        `your turn in ${shell?.title.trim() || "another chat"} went first`,
      );
    });

  /**
   * Every change of a run's records is news to the game's clients (the
   * control, the banner, the palette, the sidebar), which reread keep going's
   * status on the `run` scope; nothing polls.
   */
  const pushRun = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const root = yield* projects.resolve(threadId, { deleted: "allowed" });
      const records = yield* projections.getGameRunRecords(threadId, { steps: "in-flight" });
      const run = records.gameRuns.at(-1);
      if (run === undefined) return;
      yield* operations.runChanged(root, run.status === "ended" ? null : stepLine());
      // A run that ended has no work left: Off, a pause or the end stop its jobs.
      if (run.status === "ended") yield* jobs.stopRun(run.id);
    });

  /**
   * Keep going runs in an open chat: archiving the chat it runs in stops it
   * (resumable once the chat is back), and its step turn at work is stopped
   * with it. The person's own turns there are left to T3.
   */
  const onArchived = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const records = yield* projections.getGameRunRecords(threadId, { steps: "in-flight" });
      const gameRun = records.gameRuns.at(-1);
      if (gameRun === undefined || gameRun.status === "ended") return;
      yield* refusedOnly(
        engine.dispatch({
          type: "game-run.stop",
          commandId: CommandId.make(`server:game-run-chat-archived:${gameRun.id}`),
          threadId,
          runId: gameRun.id,
          reason: "its chat was archived",
        }),
      );
      const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
      for (const run of runs)
        if (
          isActive(run) &&
          run.status !== "waiting" &&
          stepTurnOf(run, runs)?.runId === gameRun.id
        )
          yield* interrupt(threadId, run, "archived", "Keep going stopped: its chat was archived.");
    });

  // The event consumer only reads and hands over: landing a turn is the step's job.
  const handle: GameRunTurnReactor["Service"]["handle"] = (event) =>
    event.type === "game-run.created" ||
    event.type === "game-run.updated" ||
    event.type === "game-run-step.updated" ||
    event.type === "game-run-round.recorded"
      ? pushRun(event.threadId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("keep going's change could not be pushed", {
              threadId: event.threadId,
              cause: Cause.pretty(cause),
            }),
          ),
        )
      : event.type === "thread.archived"
        ? onArchived(event.threadId).pipe(
            retrying,
            Effect.catchCause((cause) =>
              Effect.logWarning("keep going could not stop in an archived chat", {
                threadId: event.threadId,
                cause: Cause.pretty(cause),
              }),
            ),
          )
        : event.type !== "run.updated"
          ? Effect.void
          : Effect.gen(function* () {
              const run = event.payload;
              const own = parseStepTurn(run.userMessageId);
              if (own !== null) return yield* onStepRun(event.threadId, own, run);
              // A continuation names its step only through the run it continues.
              if (run.restartContinuationOfRunId !== undefined) {
                const { runs } = yield* threads.getThreadRecords(event.threadId, ["runs"]);
                const turn = stepTurnOf(run, runs);
                if (turn !== null) return yield* onStepRun(event.threadId, turn, run);
              }
              yield* onOtherRun(event.threadId, run);
            }).pipe(
              retrying,
              Effect.catchCause((cause) =>
                Effect.logWarning("keep going could not follow a turn", {
                  threadId: event.threadId,
                  cause: Cause.pretty(cause),
                }),
              ),
            );

  const start: GameRunTurnReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("keep going's turn stream failed", { cause: Cause.pretty(cause) }),
        ),
      ),
    );

  return GameRunTurnReactor.of({ settle, start, handle });
});

export const layer = Layer.effect(GameRunTurnReactor, make);
