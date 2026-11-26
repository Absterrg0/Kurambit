// @effect-diagnostics nodeBuiltinImport:off -- A step's briefing reads the game's BRIEF.md from disk.
// The work behind keep going's step effects, as GameRunJobs runs it: each job
// reads its step from the run's records, does the step's I/O and reports
// with game-run.step.complete under the step's attempt. A job that finds its
// step moved on does nothing, so a repeat after a restart is harmless, and
// every result's command id is the attempt's, so a second report is a receipt.
//
// - look: waits for the game to be idle (GameRunTurnReactor wakes it when a
//   turn ends), then reads the folder's build and whether the folder still
//   holds it, the facts measured on it so far (never waited for: a step starts
//   at once), the chat's newest `Next:` line and whether a play bot exists.
// - turn: posts the step's message in the chat as an ordinary queued turn in a
//   fresh provider session (`freshContext`), the message carrying a compact
//   briefing; GameRunTurnReactor follows that turn to its build.
// - judge: measures the step's build and its base, never superseded, and
//   waits only for their boot checks and QA plays; the random-input play goes
//   on behind the next step.
// - undo: once the game is idle, restores the base only while the folder
//   still holds the step's build.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  CommandId,
  type GameBuildFacts,
  type GameBuildId,
  type GameRunRound,
  type GameRunStepResult,
  type ThreadId,
  gameRunStepCommandId,
} from "@kurambit/contracts";
import { readNextLine } from "@kurambit/shared/gameNextLine";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import {
  directionFinished,
  isStepRecord,
  stepMessage,
} from "../../orchestration-v2/gameRun/decide.ts";
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
import * as GameBuilds from "../GameBuilds.ts";
import * as GameEngine from "../GameEngine.ts";
import * as GameFreshEyes from "../GameFreshEyes.ts";
import * as GameProjectService from "../GameProjectService.ts";
import { decidedKeys } from "../GameDecisions.ts";
import * as GameRunTurnReactor from "./GameRunTurnReactor.ts";
import { toolReason, toolWait } from "./handBack.ts";
import { retrying } from "./retrying.ts";

/**
 * How long a judge waits for a build's boot check before the step ends unmeasured. Only a
 * measurement that never ends should reach it: on a software renderer a heavy game's boot check
 * takes minutes, and it can start only once the build before it has booted.
 */
const FACTS_WAIT = "15 minutes";
/**
 * A step turn is stopped at this many times its cap of its own runs' time, however much of it
 * went to Kurambit's tools: a tool that never answers must not hold a step forever.
 */
const CAP_BACKSTOP = 3;
/** The least a cap that is not due yet is set again for. */
const CAP_RECHECK_MS = 5_000;
/** How many of the chat's latest replies the look reads for the newest `Next:` line. */
const NEXT_LOOKBACK = 20;
const Critique = Schema.Struct({ major: Schema.Boolean, biggest: Schema.String });
/**
 * A final game_check's declaration about the reference, as the call's input carries it: the op
 * `{final: {critique}}`, or `{final: true, critique}` from calls made before the tool took ops.
 */
const decodeCritique = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({ final: Schema.Struct({ critique: Critique }) }),
    Schema.Struct({ final: Schema.Literal(true), critique: Critique }),
  ]),
);

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
  const projects = yield* GameProjectService.GameProjectService;
  const engines = yield* GameEngine.GameEngine;
  const freshEyes = yield* GameFreshEyes.GameFreshEyes;
  const jobs = yield* GameRunJobs.GameRunJobs;
  const turns = yield* GameRunTurnReactor.GameRunTurnReactor;

  /** The run and its step in flight, if this job's attempt still holds it. */
  const current = (job: GameRunJobs.GameRunStepJob) =>
    Effect.map(projections.getGameRunRecords(job.threadId, { steps: "in-flight" }), (records) => {
      const located = GameRunTurnReactor.locateIn(records, job.stepId, job.attempt);
      return located === null || located.run.id !== job.runId
        ? null
        : { ...located, rounds: records.gameRunRounds, gameLastStep: records.gameLastStep };
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
      // Only the folder's writers: a chat working in a copy never holds keep going back.
      (shells) =>
        !shells.some(
          (shell) =>
            shell.worktreePath === null && (shell.activeRunId !== null || BUSY.has(shell.status)),
        ),
    );

  /** A build's facts once its boot check (or every check) is in; null when they cannot be read. */
  const factsOf = (
    threadId: ThreadId,
    build: GameBuildId | null,
    upTo: "boots" | "all" = "boots",
  ) =>
    build === null
      ? Effect.succeed<GameBuildFacts | null>(null)
      : builds
          .measure(
            threadId,
            { _tag: "build", build },
            // The run waits on these facts as a person would: at background priority, every
            // other game's older builds measured first while the step sat queued.
            { waitFor: FACTS_WAIT, queue: "person", ...(upTo === "boots" ? { upTo } : {}) },
          )
          .pipe(
            Effect.map((facts): GameBuildFacts | null => facts),
            Effect.catchCause((cause) =>
              Effect.logWarning("keep going could not measure a build", {
                build,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(null)),
            ),
          );

  /** The facts measured on a build so far, never waited for; null when none can be read. */
  const factsSoFar = (threadId: ThreadId, build: GameBuildId | null) =>
    build === null
      ? Effect.succeed<GameBuildFacts | null>(null)
      : builds.facts(threadId, { _tag: "build", build }).pipe(
          Effect.map((facts): GameBuildFacts | null => facts),
          Effect.orElseSucceed(() => null),
        );

  /** The chat's settled replies, newest first, a page at a time. */
  const repliesOf = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
      const newest = runs
        .filter((run) => run.status !== "queued" && run.status !== "running")
        .toSorted((a, b) => b.ordinal - a.ordinal)
        .slice(0, NEXT_LOOKBACK);
      if (newest.length === 0) return [];
      const { messages } = yield* threads.getThreadRecords(threadId, ["messages"], {
        messageRoles: ["assistant"],
        messageRunIds: newest.map((run) => run.id),
      });
      // A run's last assistant message is its reply.
      return newest.flatMap((run) => {
        const reply = messages.findLast((message) => message.runId === run.id);
        return reply === undefined ? [] : [reply.text];
      });
    });

  /**
   * The newest `Next:` line in the chat: a reply without one (a question
   * answered, a step that ended without it) never wipes the plan. Null when no
   * recent reply has one.
   */
  const nextLine = (threadId: ThreadId) =>
    Effect.map(
      repliesOf(threadId),
      (replies) => replies.map(readNextLine).find((line) => line !== null) ?? null,
    );

  /**
   * What the chat's newest final game_check declared about the reference (its `critique` input):
   * the biggest difference left while it is major, "none" once it is not, or null when no recent
   * final check declared one.
   * Read from the call as the agent made it, so the step follows a typed declaration, never prose.
   */
  const referenceCritique = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
      const newest = runs
        .filter((run) => run.status !== "queued" && run.status !== "running")
        .toSorted((a, b) => b.ordinal - a.ordinal)
        .slice(0, NEXT_LOOKBACK);
      if (newest.length === 0) return null;
      const { turnItems } = yield* threads.getThreadRecords(threadId, ["turnItems"], {
        turnItemRunIds: newest.map((run) => run.id),
        turnItemTypes: ["dynamic_tool"],
      });
      for (const run of newest) {
        const declared = turnItems
          .filter((item) => item.runId === run.id && item.type === "dynamic_tool")
          .flatMap((item) => {
            if (item.type !== "dynamic_tool" || !(item.toolName ?? "").endsWith("game_check"))
              return [];
            const declaration = decodeCritique(item.input);
            if (Option.isNone(declaration)) return [];
            const { value } = declaration;
            return ["critique" in value ? value.critique : value.final.critique];
          })
          .at(-1);
        if (declared === undefined) continue;
        return declared.major ? { text: declared.biggest.slice(0, 400) } : ("none" as const);
      }
      return null;
    });

  /**
   * The biggest problem fresh eyes see in the game as it is now: a quick check's frames (the page
   * as opened, then play), shown to a separate model with only the brief. Without it a step with
   * nothing measured to fix was the agent's own plan, never what a player sees: steps went to
   * sound and pause menus while judges marked the games down for empty scenes and unreadable
   * HUDs. Null when there is no frame or the review could not run.
   */
  const freshLook = (threadId: ThreadId, root: string) =>
    Effect.gen(function* () {
      const checked = yield* Effect.option(engines.check(threadId));
      const views = Option.isSome(checked) ? (checked.value.views ?? []) : [];
      if (views.length === 0) return null;
      const seen = yield* freshEyes.defects({
        threadId,
        root,
        images: views.map((view) => NodePath.join(root, view.path)),
        about: GameFreshEyes.checkFramesAbout(views.map((view) => view.entry)),
      });
      if (seen._tag === "failed") {
        yield* Effect.logWarning("Fresh eyes could not look at the game.", {
          threadId,
          reason: seen.reason,
        });
        return null;
      }
      const biggest = seen.defects[0];
      return biggest === undefined ? ("none" as const) : { text: biggest.slice(0, 600) };
    });

  const look = (located: GameRunTurnReactor.Located, rounds: ReadonlyArray<GameRunRound>) =>
    Effect.gen(function* () {
      const step = located.record.step;
      if (step.kind !== "look") return;
      // Never two writers: the person's turn goes first. A turn that ends wakes this job again.
      if (!(yield* gameIdle(located))) return;
      yield* startStep(located);
      const threadId = located.run.threadId;
      const root = yield* projects.resolve(threadId);
      const { build, edited } = yield* builds.current(threadId);
      const records = rounds
        .filter((r) => r.runId === located.run.id)
        .map((r) => r.round)
        .filter(isStepRecord);
      // Once the direction is done this look may end the run on "no check found a problem", so it
      // waits for the random-input play too: the judge waited only for the boot check, and an
      // error only random play finds would show as a ✗ after the run said there was none.
      const finished = directionFinished(located.run.steer, records);
      const facts = edited
        ? null
        : yield* finished ? factsOf(threadId, build, "all") : factsSoFar(threadId, build);
      // The step build this one came from, while this one's random-input play has no reading yet
      // (queued, playing, or dropped for a newer build): an error that play found there is the
      // next blocker.
      const made = rounds
        .map((r) => r.round)
        .findLast((record) => record.build !== undefined && record.build === build)?.step?.base;
      const earlier =
        facts !== null && facts.masher.status !== "measured" && made != null
          ? yield* factsSoFar(threadId, made)
          : null;
      const critique = yield* referenceCritique(threadId);
      const next = yield* nextLine(threadId);
      // Fresh eyes only when nothing else says what to do: the person's picture while it still
      // differs, their direction, and the agent's own `Next:` all go first, and a model call no
      // step would take is tokens spent on nothing. Once their direction is done, none would.
      const fresh =
        (critique !== null && critique !== "none") ||
        located.run.steer.length > 0 ||
        finished ||
        (next !== null && next !== "none")
          ? undefined
          : yield* freshLook(threadId, root);
      yield* complete(located, {
        kind: "look",
        current: build,
        facts,
        ...(earlier === null ? {} : { earlier }),
        next,
        critique,
        ...(fresh === undefined ? {} : { fresh }),
        edited,
        decided: yield* decidedKeys(root).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("The game's decisions could not be read.", { root, cause }).pipe(
              Effect.as([]),
            ),
          ),
        ),
      });
    });

  /**
   * The step's message, once per attempt (its id is the attempt's), queued
   * behind any turn so it never steers someone else's; then the reactor
   * follows it. A turn another chat started since the look goes first.
   */
  const turn = (
    located: GameRunTurnReactor.Located,
    rounds: Parameters<typeof stepMessage>[0],
    gameLastStep: number,
  ) =>
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
        // The step was proposed from the build the look read; a folder that
        // moved since (a turn, an Undo or Redo) gets a fresh look.
        if (step.base !== null && !(yield* builds.holds(threadId, step.base)))
          return yield* complete(
            located,
            GameRunTurnReactor.supersededTurn(null, "the game changed since keep going looked"),
          );
        // The step starts a turn in the chat, so it takes the admission any message turn does.
        const admitted = yield* turnAdmission.admit(yield* projections.getThread(threadId));
        const root = yield* projects.resolve(threadId);
        const message = stepMessage(
          rounds,
          gameLastStep,
          step.proposal,
          {
            brief: yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(root, "BRIEF.md"), "utf8").catch(() => null),
            ),
            lastReply: (yield* repliesOf(threadId))[0] ?? null,
            facts: yield* factsSoFar(threadId, step.base),
            direction: step.steer,
          },
          step.capMs,
        );
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
            // A step re-reading the whole chat cost millions of tokens; its own
            // session starts from the briefing, and the person's chat keeps theirs.
            freshContext: true,
            ...(admitted === undefined ? {} : { queueHold: admitted.hold }),
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
      // Both register at once and wait on the server's one play lane (no
      // supersede, so the reactor's own measure of the build is kept too).
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
      // A turn at work may not have written yet, so `expect` alone cannot
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
            return look(located, located.rounds);
          case "turn":
            return turn(located, located.rounds, located.gameLastStep);
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
          cause: Cause.pretty(Cause.fail(cause)),
        }),
      ),
    );

  /**
   * A step turn's cap, on the agent's own time: its runs' time without the time the app was off
   * between them or its waits on game_check and game_blender (stepTurnTime). The decider sets it
   * at step.start for the whole cap; one that finds less of the agent's time spent is set again
   * for what is left, inside its effect, so a death in between runs it again.
   */
  const deadline = (job: GameRunJobs.GameRunStepJob & GameRunJobs.GameRunEffectTry) =>
    Effect.gen(function* () {
      const located = yield* current(job);
      if (located === null || located.record.step.kind !== "turn") return;
      const capMs = located.record.step.capMs;
      const { runs } = yield* threads.getThreadRecords(job.threadId, ["runs"]);
      const chain = GameRunTurnReactor.stepChain(runs, stepTurnMessageId(job.stepId, job.attempt));
      const live = chain.at(-1);
      if (live === undefined) return;
      if (!["preparing", "queued", "starting", "running"].includes(live.status)) return;
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const { turnItems } = yield* threads.getThreadRecords(job.threadId, ["turnItems"], {
        turnItemRunIds: chain.map((run) => run.id),
      });
      const spent = GameRunTurnReactor.stepTurnTime(chain, turnItems, now);
      if (spent.own < capMs && spent.live < capMs * CAP_BACKSTOP) {
        const due = now + Math.max(CAP_RECHECK_MS, capMs - spent.own);
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
      }
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
