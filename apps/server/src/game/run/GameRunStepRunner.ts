// The work behind keep going's step effects, as GameRunJobs runs it: each job
// reads its step from the run's records, does the step's I/O and reports
// with game-run.step.complete under the step's attempt. A job that finds its
// step moved on does nothing, so a repeat after a restart is harmless, and
// every result's command id is the attempt's, so a second report is a receipt.
//
// - look: waits for the game to be idle (GameRunTurnReactor wakes it when a
//   turn ends), then reads the folder's build, its facts, the chat's last
//   `Next:` line and whether a play bot exists.
// - turn: posts the step's message in the chat as an ordinary queued turn;
//   GameRunTurnReactor follows that turn to its build.
// - judge: measures the step's build and its base, never superseded, and
//   waits for both.
// - undo: once the game is idle, restores the base only while the folder
//   still holds the step's build.
import {
  CommandId,
  type GameBuildFacts,
  type GameBuildId,
  type GameRunStepResult,
  type ThreadId,
  gameRunStepCommandId,
} from "@kurambit/contracts";
import { readNextLine } from "@kurambit/shared/gameNextLine";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";

import * as GameRunJobs from "../../orchestration-v2/gameRun/GameRunJobs.ts";
import {
  stepCapCommandId,
  stepTurnCommandId,
  stepTurnMessageId,
  stepUndoCommandId,
} from "../../orchestration-v2/gameRun/ids.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as TurnAdmission from "../../orchestration-v2/TurnAdmission.ts";
import * as GameBot from "../GameBot.ts";
import * as GameBuilds from "../GameBuilds.ts";
import * as GameProjectService from "../GameProjectService.ts";
import * as GameRunTurnReactor from "./GameRunTurnReactor.ts";
import { toolReason, toolWait } from "./handBack.ts";
import { stepMessage } from "./loop.ts";
import { retrying } from "./retrying.ts";
import { stepNumber } from "./state.ts";

/** K6: how long a judge or a look waits for a build's facts. */
const FACTS_WAIT = "10 minutes";

/** A thread whose turn is running, queued or being captured keeps the game busy. */
const BUSY: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

export class GameRunStepRunner extends Context.Service<
  GameRunStepRunner,
  { readonly start: () => Effect.Effect<void, never, Scope.Scope> }
>()("kurambit/game/run/GameRunStepRunner") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const turnAdmission = yield* TurnAdmission.TurnAdmission;
  const builds = yield* GameBuilds.GameBuilds;
  const bots = yield* GameBot.GameBot;
  const projects = yield* GameProjectService.GameProjectService;
  const jobs = yield* GameRunJobs.GameRunJobs;
  const turns = yield* GameRunTurnReactor.GameRunTurnReactor;

  /** The run and its step in flight, if this job's attempt still holds it. */
  const current = (job: GameRunJobs.GameRunStepJob) =>
    Effect.map(projections.getGameRunRecords(job.threadId, { steps: "in-flight" }), (records) => {
      const located = GameRunTurnReactor.locateIn(records, job.stepId, job.attempt);
      return located === null || located.run.id !== job.runId
        ? null
        : { ...located, rounds: records.gameRunRounds };
    });

  const complete = (located: GameRunTurnReactor.Located, result: GameRunStepResult) =>
    GameRunTurnReactor.refusedOnly(
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
  const startStep = (located: GameRunTurnReactor.Located) =>
    GameRunTurnReactor.refusedOnly(
      engine.dispatch({
        type: "game-run.step.start",
        commandId: gameRunStepCommandId(located.record.id, located.record.attempt, "start"),
        threadId: located.run.threadId,
        runId: located.run.id,
        stepId: located.record.id,
        attempt: located.record.attempt,
      }),
    );

  /** No turn of any chat of the game runs, is queued or is being captured. */
  const gameIdle = (located: GameRunTurnReactor.Located) =>
    Effect.map(
      threads.listProjectThreads({ projectId: located.run.projectId, includeSubagents: true }),
      (shells) => !shells.some((shell) => shell.activeRunId !== null || BUSY.has(shell.status)),
    );

  /** The facts of a build, waited for; null when they cannot be read. */
  const factsOf = (threadId: ThreadId, build: GameBuildId | null) =>
    build === null
      ? Effect.succeed<GameBuildFacts | null>(null)
      : builds
          .measure(threadId, { _tag: "build", build }, { waitFor: FACTS_WAIT, queue: "background" })
          .pipe(
            Effect.map((facts): GameBuildFacts | null => facts),
            Effect.catchCause((cause) =>
              Effect.logWarning("keep going could not measure a build", { build, cause }).pipe(
                Effect.as(null),
              ),
            ),
          );

  /** The `Next:` line of the chat's latest reply, when that reply is the latest turn's. */
  const nextLine = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
      const latest = runs.reduce<(typeof runs)[number] | undefined>(
        (newest, run) => (newest === undefined || run.ordinal > newest.ordinal ? run : newest),
        undefined,
      );
      if (latest === undefined) return null;
      const { messages } = yield* threads.getThreadRecords(threadId, ["messages"], {
        messageRoles: ["assistant"],
        messageRunIds: [latest.id],
      });
      const reply = messages.at(-1);
      return reply === undefined ? null : readNextLine(reply.text);
    });

  const look = (located: GameRunTurnReactor.Located) =>
    Effect.gen(function* () {
      // K2: never two writers. A turn that ends wakes this job again.
      if (!(yield* gameIdle(located))) return;
      yield* startStep(located);
      const threadId = located.run.threadId;
      const root = yield* projects.resolve(threadId);
      const listed = yield* builds.list(threadId, { limit: 1 });
      yield* complete(located, {
        kind: "look",
        current: listed.current,
        facts: yield* factsOf(threadId, listed.current),
        next: yield* nextLine(threadId),
        bot: (yield* bots.latestPlayBot(root)) !== null,
      });
    });

  /**
   * The step's message, once per attempt (its id is the attempt's), queued
   * behind any turn so it never steers someone else's; then the reactor
   * follows it. A turn another chat started since the look goes first.
   */
  const turn = (located: GameRunTurnReactor.Located, rounds: Parameters<typeof stepNumber>[0]) =>
    Effect.gen(function* () {
      const step = located.record.step;
      if (step.kind !== "turn") return;
      const threadId = located.run.threadId;
      const ids = { stepId: located.record.id, attempt: located.record.attempt };
      const messageId = stepTurnMessageId(ids.stepId, ids.attempt);
      const commandId = stepTurnCommandId(messageId);
      const sent = (yield* threads.getCommandReceipt(commandId)) !== null;
      if (!sent) {
        if (!(yield* gameIdle(located)))
          return yield* complete(
            located,
            GameRunTurnReactor.supersededTurn(null, "your message went first"),
          );
        // The step starts a turn in the chat, so it takes the admission any message turn does.
        yield* turnAdmission.admit(yield* projections.getThread(threadId));
        const message = stepMessage(stepNumber(rounds), step.proposal);
        yield* GameRunTurnReactor.refusedOnly(
          engine.dispatch({
            type: "message.dispatch",
            commandId,
            threadId,
            messageId,
            text: message.text,
            notification: {
              source: { kind: "game_run" },
              outcome: "updated",
              summary: message.summary,
            },
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "server",
          }),
        );
      }
      yield* turns.settle(
        located,
        { ...ids, runId: located.run.id },
        // A recovery's re-run lands a turn a restart cut off that T3 did not continue.
        { fromJob: sent },
      );
    });

  const judge = (located: GameRunTurnReactor.Located) =>
    Effect.gen(function* () {
      const step = located.record.step;
      if (step.kind !== "judge") return;
      yield* startStep(located);
      const threadId = located.run.threadId;
      // Both register at once and wait on the server's one facts permit (B3:
      // no supersede, so the reactor's own measure of the build is kept too).
      const [base, build] = yield* Effect.all(
        [factsOf(threadId, step.base), factsOf(threadId, step.build)],
        { concurrency: 2 },
      );
      yield* complete(located, { kind: "judge", base, build });
    });

  const undo = (located: GameRunTurnReactor.Located) =>
    Effect.gen(function* () {
      const step = located.record.step;
      if (step.kind !== "undo") return;
      // K2: a turn at work may not have written yet, so `expect` alone cannot
      // tell; the undo waits for it to end like a look does.
      if (!(yield* gameIdle(located))) return;
      yield* startStep(located);
      const restored = yield* builds
        .restore(
          located.run.threadId,
          { _tag: "build", build: step.target },
          stepUndoCommandId(located.record.id, located.record.attempt),
          { expect: step.expect },
        )
        .pipe(Effect.result);
      if (Result.isFailure(restored)) {
        // Another operation held the game: waiting may clear it.
        if (restored.failure.reason === "busy") return yield* Effect.fail(restored.failure);
        return yield* complete(located, {
          kind: "undo",
          restored: false,
          why: "refused",
          message: toolReason("the undo", restored.failure),
        });
      }
      const { moved, message } = restored.success;
      yield* complete(located, {
        kind: "undo",
        restored: moved === "restored",
        why:
          moved === "restored" ? "restored" : moved === "current" ? "undone-by-person" : "moved-on",
        message,
      });
    });

  /**
   * One step's job: its work tried again a few times when it breaks, then a
   * durable wait for the tool, then a pause. An interrupt (a stop) reports nothing.
   */
  const runStep = (job: GameRunJobs.GameRunStepJob) =>
    Effect.gen(function* () {
      const located = yield* retrying(current(job));
      if (located === null) return;
      const what = `step ${located.record.seq}'s ${located.record.kind}`;
      const work = () => {
        switch (located.record.step.kind) {
          case "look":
            return look(located);
          case "turn":
            return turn(located, located.rounds);
          case "judge":
            return judge(located);
          case "undo":
            return undo(located);
          default:
            return Effect.void;
        }
      };
      yield* retrying(Effect.suspend(work)).pipe(
        Effect.catch((cause) =>
          toolWait(engine, { ...job, record: located.record }, toolReason(what, cause), (result) =>
            complete(located, result),
          ),
        ),
      );
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("a keep-going step's job failed; recovery owes it", {
          stepId: job.stepId,
          cause,
        }),
      ),
    );

  /**
   * A step turn's cap, due at the turn's start plus its cap (the decider set
   * it at step.start). One that fires early (a restart re-ran it) is set
   * again for the time left; inside its effect, so a death in between runs it again.
   */
  const deadline = (job: GameRunJobs.GameRunStepJob & GameRunJobs.GameRunEffectTry) =>
    Effect.gen(function* () {
      const located = yield* current(job);
      if (located === null || located.record.step.kind !== "turn") return;
      const capMs = located.record.step.capMs;
      const { runs } = yield* threads.getThreadRecords(job.threadId, ["runs"]);
      const chain = GameRunTurnReactor.stepChain(runs, stepTurnMessageId(job.stepId, job.attempt));
      const live = chain.at(-1);
      const first = chain[0];
      if (live === undefined || first === undefined) return;
      if (!["preparing", "queued", "starting", "running"].includes(live.status)) return;
      const due = DateTime.toEpochMillis(first.startedAt ?? first.requestedAt) + capMs;
      if (DateTime.toEpochMillis(yield* DateTime.now) < due)
        return yield* GameRunTurnReactor.refusedOnly(
          engine.dispatch({
            type: "game-run.step.schedule",
            commandId: CommandId.make(
              `server:game-run-step-cap:${job.stepId}:attempt:${job.attempt}:due:${due}`,
            ),
            threadId: job.threadId,
            runId: job.runId,
            stepId: job.stepId,
            attempt: job.attempt,
            at: due,
            timer: { kind: "cap" },
          }),
        );
      yield* GameRunTurnReactor.refusedOnly(
        engine.dispatch({
          type: "run.interrupt",
          commandId: stepCapCommandId(job.stepId, job.attempt, live.id),
          threadId: job.threadId,
          runId: live.id,
          reason: "Keep going's step reached its time cap.",
        }),
      );
    }).pipe(
      Effect.catch((cause) =>
        job.final
          ? // On the outbox's last try the cap is set again a minute on, so no step turn goes uncapped.
            Effect.flatMap(DateTime.now, (now) =>
              GameRunTurnReactor.refusedOnly(
                engine.dispatch({
                  type: "game-run.step.schedule",
                  commandId: CommandId.make(
                    `server:game-run-step-cap:${job.stepId}:attempt:${job.attempt}:rearm:${job.effectId}`,
                  ),
                  threadId: job.threadId,
                  runId: job.runId,
                  stepId: job.stepId,
                  attempt: job.attempt,
                  at: DateTime.toEpochMillis(now) + 60_000,
                  timer: { kind: "cap" },
                }),
              ),
            ).pipe(Effect.mapError((error) => new GameRunJobs.GameRunEffectError({ cause: error })))
          : Effect.fail(new GameRunJobs.GameRunEffectError({ cause })),
      ),
    );

  const start: GameRunStepRunner["Service"]["start"] = () =>
    jobs.attach({
      runStep,
      deadline,
      // A step turn that failed at once pauses the run (provider-down) rather
      // than repeat its message in the person's chat: a keep-going run never
      // sets this timer, and a row an older server left settles with no work.
      resend: () => Effect.void,
    });

  return GameRunStepRunner.of({ start });
});

export const layer = Layer.effect(GameRunStepRunner, make);
