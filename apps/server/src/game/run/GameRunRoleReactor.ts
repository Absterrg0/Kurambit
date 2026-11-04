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
  type GameRun,
  type GameRunStep,
  type GameRunStepId,
  type GameRunStepResult,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type ProjectId,
  type ThreadId,
  gameRunStepCommandId,
  gameRunStepId,
} from "@kurambit/contracts";
import { latestRootProviderFailure } from "@kurambit/shared/orchestrationV2ThreadError";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as GameRunJobs from "../../orchestration-v2/gameRun/GameRunJobs.ts";
import {
  type RoleTurn,
  type RoleTurnKind,
  parseRoleTurn,
  roleTurnCommandId,
  roleTurnMessageId,
} from "../../orchestration-v2/gameRun/ids.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../../serverActivation.ts";
import * as GameProjectService from "../GameProjectService.ts";
import * as GameService from "../GameService.ts";
import { logLine } from "../runSetup.ts";
import { snapshotBuildSource } from "../sourceSnapshot.ts";
import { botRunCount } from "./facts.ts";
import { MEMORY_PAUSE, MEMORY_WAITS, replayRefusedTurn } from "./lowMemory.ts";
import { lastBotRun, releaseWorktree } from "./roleRunner.ts";
import { MEMORY_RETRY } from "./roles.ts";
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
export const roleAt = (step: Step, seq: number): RoleStep | null => {
  if (step.kind === "role") return step.id === seq ? step : null;
  if (step.kind !== "pair") return null;
  const half = step.halves.find((h) => h.id === seq);
  return half?.kind === "role" ? half : null;
};

/** The step's turns on one role thread, oldest first, each with what its message id says. */
export const stepTurns = (runs: ReadonlyArray<OrchestrationV2Run>, stepId: GameRunStepId) =>
  runs
    .flatMap((run) => {
      const turn = parseRoleTurn(run.userMessageId);
      return turn !== null && turn.stepId === stepId ? [{ run, turn }] : [];
    })
    .toSorted((a, b) => a.run.ordinal - b.run.ordinal);

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

export class GameRunRoleReactor extends Context.Service<
  GameRunRoleReactor,
  {
    /** Lands a role turn that settled, by the rule the event stream applies. */
    readonly settle: (roleThreadId: ThreadId, turnRun: OrchestrationV2Run) => Effect.Effect<void>;
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
    readonly locate: (
      creator: ThreadId,
      stepId: GameRunStepId,
      attempt: number,
    ) => Effect.Effect<Located | null>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("kurambit/game/run/GameRunRoleReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const game = yield* GameService.GameService;
  const projects = yield* GameProjectService.GameProjectService;
  const vcs = yield* GitWorkflow.GitWorkflowService;
  const jobs = yield* GameRunJobs.GameRunJobs;
  const deps = { threads, game, vcs };
  // One settle per step at a time: a turn's run is updated more than once
  // after it ends, and its evidence is read (and reset) only once.
  const lock = yield* Semaphore.make(1);

  const locate: GameRunRoleReactor["Service"]["locate"] = (creator, stepId, attempt) =>
    projections.getGameRunRecords(creator, { steps: "in-flight" }).pipe(
      Effect.map((records) => locateIn(records, stepId, attempt)),
      Effect.orElseSucceed(() => null),
    );

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
        mode: "auto",
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
        Effect.orElseSucceed(() => ""),
      );

  const failureOf = (threadId: ThreadId, run: OrchestrationV2Run) =>
    threads
      .getThreadRecords(threadId, ["turnItems"], {
        turnItemRunId: run.id,
        turnItemTypes: ["error"],
      })
      .pipe(
        Effect.map((records) => latestRootProviderFailure(run, records.turnItems)),
        Effect.orElseSucceed(() => null),
      );

  // A turn sent again after a pause: the pause is a job of the run's, so a
  // stop ends it, and the step is checked again before anything is sent.
  const resendLater = (input: {
    readonly creator: ThreadId;
    readonly at: Located;
    readonly stepId: GameRunStepId;
    readonly roleThreadId: ThreadId;
    readonly projectId: ProjectId;
    readonly kind: RoleTurnKind;
    readonly n: number;
    readonly text: string;
    readonly after: Duration.Input;
  }) =>
    jobs.fork(
      `resend:${input.stepId}:attempt:${input.at.record.attempt}:${input.kind}:${input.n}`,
      input.at.run.id,
      Effect.gen(function* () {
        yield* Effect.sleep(input.after);
        const still = yield* locate(input.creator, input.stepId, input.at.record.attempt);
        if (still === null) return;
        yield* sendTurn({
          projectId: input.projectId,
          threadId: input.roleThreadId,
          stepId: input.stepId,
          attempt: input.at.record.attempt,
          kind: input.kind,
          n: input.n,
          text: input.text,
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("game run role turn could not be sent again", {
              stepId: input.stepId,
              cause,
            }),
          ),
        );
      }),
    );

  const settleLocked = (roleThreadId: ThreadId, turnRun: OrchestrationV2Run, turn: RoleTurn) =>
    Effect.gen(function* () {
      const { thread, runs } = yield* threads.getThreadRecords(roleThreadId, ["runs"]);
      const creator = thread.lineage.parentThreadId;
      if (creator === null || thread.launchedBy !== "game_run") return;
      const at = yield* locate(creator, turn.stepId, turn.attempt);
      if (at === null || at.role === null) return;
      // The step record says which thread runs it; a thread of another project is never its.
      const entry = at.record.roles.find((r) => r.seq === at.seq);
      if (entry?.threadId !== roleThreadId || thread.projectId !== at.run.projectId) return;
      const turns = stepTurns(runs, turn.stepId).filter((t) => t.turn.attempt === turn.attempt);
      const latest = turns.at(-1);
      if (latest === undefined || latest.run.id !== turnRun.id || !isSettledRun(latest.run)) return;
      if (
        (yield* threads.getCommandReceipt(
          gameRunStepCommandId(turn.stepId, turn.attempt, "complete"),
        )) !== null
      )
        return;
      const role = at.role;
      const root = yield* projects.resolve(creator);
      const log = (line: string) => logLine(root, line);
      const run = latest.run;
      const next = Math.max(...turns.map((t) => t.turn.n)) + 1;
      const again = (kind: RoleTurnKind, text: string, after: Duration.Input) =>
        resendLater({
          creator,
          at,
          stepId: turn.stepId,
          roleThreadId,
          projectId: thread.projectId,
          kind,
          n: next,
          text,
          after,
        });
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
          const retries = turns.filter((t) => t.turn.kind === "retry").length;
          if (retries >= RETRIES) return yield* end("provider-down", reason);
          yield* log(`${role.role}: instant-failed turn (${reason}) [${retries + 1}/${RETRIES}]`);
          return yield* again("retry", role.prompt, Duration.seconds(15 * 2 ** retries));
        }
      }
      // A sample's play turn that did not play because its explore start was
      // refused for memory plays again on a fresh clock; memory that never
      // frees ends the run resumably instead of voiding the sample. Only play
      // turns: the write-up does not play.
      if (role.inputCapMs > 0 && !role.release) {
        const mark = yield* game
          .exploreMemoryWait(roleThreadId)
          .pipe(Effect.orElseSucceed(() => null));
        const atStart = { refusals: 0, refused: false, executedInputSteps: 0 };
        if (mark !== null && replayRefusedTurn(atStart, mark)) {
          const waits = turns.filter((t) => t.turn.kind === "memory").length;
          if (waits >= MEMORY_WAITS)
            return yield* end("low-memory", `${role.role}: explore start refused, memory short`);
          yield* log(
            `${role.role}: explore start refused, memory short; waiting ${MEMORY_PAUSE} (${waits + 1} of ${MEMORY_WAITS})`,
          );
          // The next turn's marks count from here.
          yield* game.finishExploration(roleThreadId).pipe(Effect.ignore);
          return yield* again("memory", `${MEMORY_RETRY}\n\n${role.prompt}`, MEMORY_PAUSE);
        }
      }

      const first = turns[0]?.run ?? run;
      const startedMs = millis(first.startedAt) ?? millis(first.requestedAt) ?? Date.now();
      const now = Date.now();
      const timedOut = run.status === "interrupted";
      const budgetCut = timedOut && at.run.budgetEndsAt !== null && now >= at.run.budgetEndsAt;
      // Evidence is cumulative per thread; closing here also releases the
      // thread's explorer so nothing stays open between roles.
      const evidence = yield* game.finishExploration(roleThreadId).pipe(
        Effect.map((e) => ({
          sessions: e.sessions,
          actions: e.actions,
          executedInputSteps: e.executedInputSteps,
          nominalMs: e.nominalMs,
          images: e.images,
        })),
        Effect.orElseSucceed(() => null),
      );
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
      const before = entry.before ?? { source: "", bots: 0 };
      const sourceAfter = role.source
        ? yield* Effect.promise(() =>
            snapshotBuildSource(root, at.run.lane).then(
              (s) => (s.kind === "known" ? s.sourceId : ""),
              () => "",
            ),
          )
        : "";
      const botsAfter = role.bots ? yield* Effect.promise(() => botRunCount(root)) : 0;
      const bot = role.bots ? yield* Effect.promise(() => lastBotRun(root, before.bots)) : null;
      if (role.at !== null && (role.release || budgetCut))
        yield* releaseWorktree(deps, { root, log }, roleThreadId);
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
        sourceBefore: before.source,
        sourceAfter,
        botsBefore: before.bots,
        botsAfter,
        bot,
        sheet,
      });
    });

  const settle: GameRunRoleReactor["Service"]["settle"] = (roleThreadId, turnRun) => {
    const turn = parseRoleTurn(turnRun.userMessageId);
    if (turn === null || !isSettledRun(turnRun)) return Effect.void;
    return lock
      .withPermits(1)(settleLocked(roleThreadId, turnRun, turn))
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("game run role result failed", { threadId: roleThreadId, cause }),
        ),
      );
  };

  const handle: GameRunRoleReactor["Service"]["handle"] = (event) =>
    event.type === "run.updated" ? settle(event.threadId, event.payload) : Effect.void;

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
