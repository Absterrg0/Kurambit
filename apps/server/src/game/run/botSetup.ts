// @effect-diagnostics nodeBuiltinImport:off -- Whether the play bot's file is in the game folder is read from disk.
// Keep going's play bot, written once per run as setup rather than as a step.
// The bot is the harness's measuring instrument for the skilled fact and
// changes nothing a person sees, and a step's turn re-reads the whole game
// chat, so it runs in a session of its own: a subagent of the chat
// (game-round.task.request, role "bot") with only its task as context, shown
// as a card in the chat, never a step, a build or a timeline mark.
//
// The look job drives it. A booting game with no play bot starts it; a child
// at work keeps the game busy (gameIdle), and its end wakes the look
// (GameRunTurnReactor.onOtherRun). Each session has a time cap, and a first
// session that recorded no play of the bot gets one fix-up session; then the
// folder is kept as the setup left it (GameBuilds.keepBotSetup) and the look
// reports the outcome, which the run keeps, so no later look sets up again.
// Every dispatch's command id is derived from the run, so each happens once.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  CommandId,
  type GameKeepGoingBotSetup,
  type GameRun,
  type OrchestrationV2Run,
  type ThreadId,
} from "@kurambit/contracts";
import * as IdAllocator from "@kurambit/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import type * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import type * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import type * as TurnAdmission from "../../orchestration-v2/TurnAdmission.ts";
import type * as GameBot from "../GameBot.ts";
import type * as GameBuilds from "../GameBuilds.ts";
import { type Located, refusedOnly, tokensIn } from "./inFlight.ts";

/** A session's cap: a bot for one core loop is minutes of work, never a long turn. */
const CAP_MS = 10 * 60_000;
/** The first session, then at most one fix-up. */
const SESSIONS = [0, 1] as const;

// Stops at the first finished run: measured setups that kept polishing a bot
// that had already won spent most of their tokens re-reading their own session.
const TASK =
  "Write a play bot for this game, so Kurambit can measure whether a skilled player wins. Read `BRIEF.md` and only as much of the game's code as you need for its controls and how a run is won. Write `.studio/bot/play.mjs` with the bot kit (read `.studio/bot/kit/KIT-GUIDE.md`): a `policy` bot whose goal is to win one run of the core loop. It steers by what the game reports while it plays (its state values, the player's position, the HUD): never copy positions, layouts, speeds or timings from the game's code into the bot, since a later step that moves one would break the bot, and keep going would undo that step. Run it with `game_bot_run` (decider `policy`) and fix it until one run ends: stop as soon as a run is won, or plays out in full if the game cannot be won. Don't polish a bot that has finished a run, and don't run it again to confirm. Change only files under `.studio/bot/`, outside `kit/`.";

const commandIdOf = (runId: string, n: number) =>
  CommandId.make(`server:game-run-bot-setup:${runId}:${n}`);

/** The child thread of the run's `n`th setup session, as the orchestrator derives it. */
const threadOf = (runId: string, n: number) =>
  IdAllocator.derive.delegatedTaskThread({ commandId: commandIdOf(runId, n) });

const ACTIVE: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

interface Session {
  readonly n: number;
  readonly thread: ThreadId;
  /** Null until its run exists. */
  readonly run: OrchestrationV2Run | null;
  readonly tokens: number | null;
}

type Threads = ThreadManagement.ThreadManagementService["Service"];

/** The run's dispatched setup sessions, oldest first. */
const sessionsOf = (threads: Threads, runId: string) =>
  Effect.forEach(SESSIONS, (n) =>
    Effect.gen(function* () {
      const receipt = yield* threads.getCommandReceipt(commandIdOf(runId, n));
      if (receipt === null || receipt.status !== "accepted") return [];
      const thread = threadOf(runId, n);
      const records = yield* threads.getThreadRecords(thread, [
        "runs",
        "attempts",
        "providerTurns",
      ]);
      const run = records.runs[0] ?? null;
      return [{ n, thread, run, tokens: tokensIn(records, records.runs) } satisfies Session];
    }),
  ).pipe(Effect.map((each) => each.flat()));

const millis = (value: DateTime.Utc | null | undefined) =>
  value == null ? null : DateTime.toEpochMillis(value);

/** The sessions as the status shows them. */
const viewOf = (
  sessions: ReadonlyArray<Session>,
  now: number,
  state: GameKeepGoingBotSetup["state"],
  reason: string,
): GameKeepGoingBotSetup | null => {
  const last = sessions.at(-1);
  if (last === undefined) return null;
  const tokens = sessions.reduce<number | null>(
    (sum, each) => (each.tokens === null ? sum : (sum ?? 0) + each.tokens),
    null,
  );
  const ms = sessions.reduce((sum, each) => {
    const from = millis(each.run?.startedAt) ?? millis(each.run?.requestedAt);
    return from === null ? sum : sum + Math.max(0, (millis(each.run?.completedAt) ?? now) - from);
  }, 0);
  return {
    thread: last.thread,
    state,
    tokens,
    minutes: Math.round(ms / 6000) / 10,
    reason,
  };
};

/** The run's setup for the status: what the run kept, else a session at work; null when none ran. */
export const botSetupView = (threads: Threads, run: GameRun) =>
  run.botSetup !== undefined
    ? Effect.succeed<GameKeepGoingBotSetup | null>(run.botSetup)
    : Effect.gen(function* () {
        const sessions = yield* sessionsOf(threads, run.id);
        const working = sessions.some((each) => each.run !== null && ACTIVE.has(each.run.status));
        if (!working) return null;
        return viewOf(sessions, DateTime.toEpochMillis(yield* DateTime.now), "running", "");
      }).pipe(Effect.orElseSucceed(() => null));

/** Keep going stopped: a setup session at work stops with it, so nothing writes for a run that is over. */
export const stopBotSetup = (
  engine: Orchestrator.OrchestratorV2["Service"],
  threads: Threads,
  run: GameRun,
) =>
  Effect.gen(function* () {
    if (run.botSetup !== undefined) return;
    for (const session of yield* sessionsOf(threads, run.id))
      if (
        session.run !== null &&
        ACTIVE.has(session.run.status) &&
        session.run.status !== "waiting"
      )
        yield* refusedOnly(
          engine.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make(`server:game-run-bot-setup-stop:${run.id}:${session.n}`),
            threadId: session.thread,
            runId: session.run.id,
            reason: "Keep going stopped; its bot setup ends.",
          }),
        );
  });

export interface BotSetupDeps {
  readonly engine: Orchestrator.OrchestratorV2["Service"];
  readonly threads: Threads;
  readonly projections: ProjectionStore.ProjectionStoreV2["Service"];
  readonly turnAdmission: {
    readonly admit: (
      thread: TurnAdmission.TurnAdmissionThread,
    ) => Effect.Effect<void, TurnAdmission.TurnAdmissionRejectedError>;
  };
  readonly bots: GameBot.GameBot["Service"];
  readonly builds: GameBuilds.GameBuilds["Service"];
}

/** The look's side of the setup. Every answer is "wait" (a session works, the look ends) or what the look reports. */
export const makeBotSetup = (deps: BotSetupDeps) => {
  const { engine, threads, projections, bots, builds } = deps;
  const now = Effect.map(DateTime.now, DateTime.toEpochMillis);

  /** A play of the game's latest bot recorded since `since` (epoch ms), with its file still in the folder. */
  const played = (root: string, since: number) =>
    Effect.gen(function* () {
      const latest = yield* bots.latestPlayBot(root);
      if (latest === null || DateTime.toEpochMillis(DateTime.makeUnsafe(latest.at)) < since)
        return false;
      return yield* Effect.promise(() =>
        NodeFSP.access(NodePath.join(root, latest.file)).then(
          () => true,
          () => false,
        ),
      );
    });

  /** The run's setup sessions, while it has not kept an outcome. */
  const sessions = (located: Located) =>
    located.run.botSetup === undefined
      ? sessionsOf(threads, located.run.id)
      : Effect.succeed<ReadonlyArray<Session>>([]);

  /** A session past its cap is stopped; its end wakes the look. */
  const cap = (located: Located, all: ReadonlyArray<Session>) =>
    Effect.gen(function* () {
      const at = yield* now;
      for (const session of all) {
        const run = session.run;
        const from = millis(run?.startedAt) ?? millis(run?.requestedAt);
        if (run === null || !ACTIVE.has(run.status) || run.status === "waiting" || from === null)
          continue;
        if (at < from + CAP_MS) continue;
        yield* refusedOnly(
          engine.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make(
              `server:game-run-bot-setup-cap:${located.run.id}:${session.n}`,
            ),
            threadId: session.thread,
            runId: run.id,
            reason: `Keep going's bot setup reached its ${CAP_MS / 60_000}-minute cap.`,
          }),
        );
      }
    });

  const failed = (all: ReadonlyArray<Session>, at: number, reason: string, thread: ThreadId) =>
    viewOf(all, at, "failed", reason) ?? {
      thread,
      state: "failed" as const,
      tokens: null,
      minutes: null,
      reason,
    };

  /**
   * Session `n` starts, attached to the chat's latest finished turn (a game
   * round's parent is a completed run) and woken again at its cap.
   */
  const begin = (located: Located, all: ReadonlyArray<Session>, n: number, before: string) =>
    Effect.gen(function* () {
      const threadId = located.run.threadId;
      const thread = yield* projections.getThread(threadId);
      const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
      const origin = runs
        .filter((run) => run.status === "completed" && run.rootNodeId !== null)
        .toSorted((a, b) => b.ordinal - a.ordinal)[0];
      const at = yield* now;
      if (origin?.rootNodeId == null)
        return failed(all, at, "the chat has no finished turn to start it from", threadId);
      yield* deps.turnAdmission.admit(thread);
      yield* engine.dispatch({
        type: "game-round.task.request",
        createdBy: "system",
        creationSource: "server",
        commandId: commandIdOf(located.run.id, n),
        originatingThreadId: threadId,
        originatingRunId: origin.id,
        originatingNodeId: origin.rootNodeId,
        loopId: located.run.id,
        roundId: "bot-setup",
        role: "bot",
        order: n,
        task: n === 0 ? TASK : `${before}\n\n${TASK} Start from what is in \`.studio/bot/\` now.`,
        title: n === 0 ? "Play bot" : "Play bot (fix-up)",
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        evidenceDirectory: null,
      });
      yield* refusedOnly(
        engine.dispatch({
          type: "game-run.step.schedule",
          commandId: CommandId.make(`server:game-run-bot-setup-wake:${located.run.id}:${n}`),
          threadId,
          runId: located.run.id,
          stepId: located.record.id,
          attempt: located.record.attempt,
          at: at + CAP_MS + 5_000,
          timer: { kind: "recover" },
        }),
      );
      return "wait" as const;
    }).pipe(
      // A setup that cannot start is reported, never retried: keep going goes on without it.
      Effect.catch((cause) =>
        Effect.map(now, (at) =>
          failed(
            all,
            at,
            `its session could not start (${"message" in cause ? cause.message : String(cause)})`.slice(
              0,
              300,
            ),
            located.run.threadId,
          ),
        ),
      ),
    );

  /** Why a session left no recorded play. */
  const whyNot = (session: Session) =>
    session.run?.status === "interrupted"
      ? `its session was stopped (at its ${CAP_MS / 60_000}-minute cap, or by you)`
      : session.run?.status === "failed"
        ? "its session failed"
        : "it recorded no play of `.studio/bot/play.mjs` with `game_bot_run`";

  /**
   * The finished sessions move on: the folder is kept once a play is
   * recorded, else one fix-up session starts, else the setup failed. Null
   * while none was dispatched.
   */
  const finish = (located: Located, root: string, all: ReadonlyArray<Session>) =>
    Effect.gen(function* () {
      const first = all[0];
      const last = all.at(-1);
      if (first === undefined || last === undefined) return null;
      if (last.run === null || ACTIVE.has(last.run.status)) return "wait" as const;
      const since = millis(first.run?.requestedAt) ?? 0;
      const at = yield* now;
      if (yield* played(root, since)) {
        const refused = yield* builds.keepBotSetup(located.run.threadId, located.run.id);
        return refused === null
          ? (viewOf(all, at, "written", "") ?? failed(all, at, "", last.thread))
          : failed(all, at, refused, last.thread);
      }
      if (all.length < SESSIONS.length)
        return yield* begin(
          located,
          all,
          all.length,
          `An earlier session left no working play bot: ${whyNot(last)}.`,
        );
      return failed(
        all,
        at,
        `two sessions left no working play bot (${whyNot(last)})`,
        last.thread,
      );
    });

  return {
    played,
    sessions,
    cap,
    finish,
    /** The first session, for a booting game with no play bot. */
    start: (located: Located) => begin(located, [], 0, ""),
  };
};
