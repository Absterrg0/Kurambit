// @effect-diagnostics globalDate:off globalDateInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off -- This service owns the production loop's native boundary: wall-clock caps, the run state files and the skill pack in the game folder, like the bot and Blender services.
// GameRun: one game's production loop. A pure policy (run/policy.ts) decides one step at a
// time; this driver executes it with T3 services and persists `.studio/run.json` after every step.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  GameOperationError,
  type GameCreateInput,
  type GameProjectResult,
  type GameRunDecideInput,
  type GameRunDecideResult,
  type GameRunProfile,
  type GameRunProfileResult,
  type GameRunPickDetail,
  type GameRunRestoreResult,
  type GameRunRoundDetail,
  type GameRunStartInput,
  type GameRunStatusResult,
  type GameRunChecksResult,
  type GameRunSteerResult,
  type ModelSelection,
  type ProjectId,
  ThreadId,
} from "@kurambit/contracts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameService from "./GameService.ts";
import { runStateChecks } from "./run/checkRunner.ts";
import { runBotFact } from "./run/botFacts.ts";
import { artAssetFacts, reviewerFacts } from "./run/facts.ts";
import { finishExports } from "./run/finish.ts";
import { waitOutLowMemory } from "./run/lowMemory.ts";
import { makeGit, restoredPaths } from "./run/git.ts";
import { bootStep, gitStep } from "./run/steps.ts";
import { decideStep, type Answer } from "./run/decideStep.ts";
import * as Policy from "./run/policy.ts";
import { releaseWorktree, runRole, type RoleDeps } from "./run/roleRunner.ts";
import { ladderRefs, pickRef, runProgress } from "./run/progress.ts";
import { readPickEvidence, readRoundEvidence, roundOutcome } from "./run/roundDetail.ts";
import { artFacts, modelBlock, spriteBlock } from "./run/roles.ts";
import { laneProfile } from "./engineProfile.ts";
import { spriteFacts } from "./run/spriteFacts.ts";
import { modelFacts } from "./run/modelFacts.ts";
import * as State from "./run/state.ts";
import {
  causeText,
  ensureScaffold,
  logLine,
  readText,
  refreshHarnessFiles,
  writeAtomic,
} from "./runSetup.ts";
import {
  DECISION_LABEL,
  currentStep,
  decisionOf,
  describe,
  selectionFor,
  steerWhen,
  summarize,
} from "./run/runView.ts";

export class GameRunError extends Schema.TaggedError<GameRunError>()("GameRunError", {
  operation: Schema.String,
  path: Schema.String,
  reason: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail ?? `Game run ${this.operation} failed (${this.reason}).`;
  }
}

// A shipped or stalled run starts over (keeping its history); every other ending resumes.
const CONTINUABLE = new Set([
  null,
  "budget",
  "usage-limit",
  "provider-down",
  "low-memory",
  "stopped",
  "failed",
]);

const paths = (root: string) => ({
  run: NodePath.join(root, ".studio", "run.json"),
  rounds: NodePath.join(root, ".studio", "rounds.jsonl"),
  stop: NodePath.join(root, ".studio", "stop"),
  steer: NodePath.join(root, ".studio", "steer.jsonl"),
  // A profile switch waiting for the run's next step boundary; a file, like a
  // steer, so a restart before that boundary does not lose it.
  profile: NodePath.join(root, ".studio", "profile"),
  log: NodePath.join(root, ".studio", "run.log"),
  next: NodePath.join(root, ".studio", "next.md"),
});

/** One JSON string per line; a torn or foreign line is skipped. */
const parseSteer = (text: string): string[] =>
  text.split("\n").flatMap((line) => {
    if (line.trim().length === 0) return [];
    try {
      const note: unknown = JSON.parse(line);
      return typeof note === "string" && note.trim().length > 0 ? [note] : [];
    } catch {
      return [];
    }
  });

const fallbackOf = (decision: State.Decision): Answer => ({
  answer: decision.fallback,
  notes: "",
  by: "default",
});

type RunSlot = {
  fiber: Fiber.Fiber<void, never> | null;
  runId: string;
  stop: boolean;
  // A profile switch the driver takes at its next step.
  profile: GameRunProfile | null;
  // The decision the driver waits on; an answer completes it.
  waiting: { readonly decision: State.Decision; readonly answer: Deferred.Deferred<Answer> } | null;
};

export class GameRun extends Context.Service<
  GameRun,
  {
    readonly runStart: (
      input: GameRunStartInput,
    ) => Effect.Effect<
      { runId: string; root: string; stage: string; resumed: boolean },
      GameRunError
    >;
    /** A new game is a production run: create the project, then run the brief. */
    readonly createGame: (
      input: GameCreateInput,
    ) => Effect.Effect<typeof GameProjectResult.Type, GameOperationError>;
    readonly runStatus: (threadId: ThreadId) => Effect.Effect<GameRunStatusResult, GameRunError>;
    readonly runStop: (
      threadId: ThreadId,
    ) => Effect.Effect<{ stopped: boolean; message: string }, GameRunError>;
    /** The creator's answer to the decision the live run waits on; refused when it does not fit. */
    readonly runDecide: (
      input: GameRunDecideInput,
    ) => Effect.Effect<GameRunDecideResult, GameRunError>;
    /** Switches the live run between Guided and Autopilot from its next step. */
    readonly runProfile: (
      threadId: ThreadId,
      profile: GameRunProfile,
    ) => Effect.Effect<GameRunProfileResult, GameRunError>;
    /** Queue a creator note for the live run's next round. Fails when no run is live. */
    readonly runSteer: (
      threadId: ThreadId,
      text: string,
    ) => Effect.Effect<GameRunSteerResult, GameRunError>;
    /** Scores the open rung's state checks on the build in the game root now. */
    readonly runChecks: (threadId: ThreadId) => Effect.Effect<GameRunChecksResult, GameRunError>;
    /**
     * One round's evidence, read on demand. `videoFile` is the canonical bot
     * video inside the game's builds/logs, for the transport to mint a URL.
     */
    readonly roundDetail: (
      threadId: ThreadId,
      round: number,
    ) => Effect.Effect<
      {
        detail: GameRunRoundDetail;
        videoFile: string | null;
        sheetFiles: ReadonlyArray<{ readonly build: string; readonly path: string }>;
      },
      GameRunError
    >;
    /** The prototype pick's evidence; `sheetFiles` are the frame sheets the transport may sign. */
    readonly pickDetail: (threadId: ThreadId) => Effect.Effect<
      {
        detail: GameRunPickDetail;
        sheetFiles: ReadonlyArray<{ readonly build: string; readonly path: string }>;
      },
      GameRunError
    >;
    /**
     * Makes a kept round's build the game's sources again with a new commit on
     * trunk. Refused while a run is live, mid-round, off trunk or with uncommitted work.
     */
    readonly restoreRound: (
      threadId: ThreadId,
      round: number,
    ) => Effect.Effect<GameRunRestoreResult, GameRunError>;
    /** At server start: resume every run a restart cut off (no ending, no stop request). */
    readonly resumeInterrupted: () => Effect.Effect<void>;
  }
>()("kurambit/game/GameRun") {}

export const layer = Layer.effect(
  GameRun,
  Effect.gen(function* () {
    const operations = yield* GameOperations.GameOperations;
    const projects = yield* GameProjectService.GameProjectService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const game = yield* GameService.GameService;
    const vcs = yield* GitWorkflow.GitWorkflowService;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const deps: RoleDeps = { launches, threads, game, vcs };
    // One slot per game root, claimed before runStart's first yield so two
    // starts can never both fork a loop.
    const active = new Map<string, RunSlot>();
    // Games whose tree a restore is moving; a run cannot start under one.
    const restoring = new Set<string>();
    // Serializes appends to a steer file with the driver taking it, so no note
    // lands between the driver's read and its removal.
    const steerLock = Semaphore.makeUnsafe(1);

    const resolveGame = Effect.fn("GameRun.resolveGame")(function* (threadId: ThreadId) {
      const root = yield* projects.resolve(threadId).pipe(
        Effect.mapError(
          (cause) =>
            new GameRunError({
              operation: "resolve-game",
              path: threadId,
              reason: "project-not-found",
              detail: cause.message,
            }),
        ),
      );
      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
      if (shell === null || shell.deletedAt !== null)
        return yield* new GameRunError({
          operation: "resolve-game",
          path: threadId,
          reason: "project-not-found",
          detail: "The thread is gone.",
        });
      return { root, projectId: shell.projectId };
    });

    const load = (root: string) =>
      Effect.promise(async () =>
        State.loadState(
          await readText(paths(root).run),
          (await readText(paths(root).rounds)) ?? "",
        ),
      );

    // run.json first, then the journal derived from it: run.json is the
    // authority, and a journal behind it is rewritten on the next persist.
    const persist = (root: string, state: State.RunState, roundsWritten: { count: number }) =>
      Effect.promise(async () => {
        await writeAtomic(
          paths(root).run,
          `${JSON.stringify(State.encodeRunState(state), null, 2)}\n`,
        );
        if (roundsWritten.count !== state.rounds.length) {
          await writeAtomic(
            paths(root).rounds,
            state.rounds.map((r) => JSON.stringify(r)).join("\n") +
              (state.rounds.length > 0 ? "\n" : ""),
          );
          roundsWritten.count = state.rounds.length;
        }
      }).pipe(Effect.uninterruptible);

    const stopRequested = (root: string) =>
      Effect.promise(() =>
        NodeFSP.access(paths(root).stop).then(
          () => true,
          () => false,
        ),
      );

    type Drive = {
      readonly root: string;
      readonly projectId: ProjectId;
      readonly creator: ThreadId;
      readonly deps: RoleDeps;
      readonly selection: ModelSelection;
      readonly runtimeMode: Parameters<RoleDeps["launches"]["launch"]>[0]["runtimeMode"];
      readonly slot: RunSlot;
    };

    const drive = Effect.fn("GameRun.drive")(function* (d: Drive, initial: State.RunState) {
      const { root } = d;
      const log = (line: string) => logLine(root, line);
      const git = makeGit(root, initial.lane, log);
      const written = { count: -1 };
      let state = initial;
      const save = (next: State.RunState) => {
        state = next;
        return persist(root, next, written).pipe(
          Effect.andThen(
            next.ending !== null
              ? Effect.void
              : operations.recordRun(root, {
                  step: currentStep(next),
                  startedAt: next.startedAt,
                  threads: next.threads.length,
                }),
          ),
        );
      };
      // Creator notes become run state before the policy sees them; the
      // policy uses them at the next round start and never touches files.
      const takeSteer = steerLock.withPermits(1)(
        Effect.gen(function* () {
          const notes = parseSteer(
            (yield* Effect.promise(() => readText(paths(root).steer))) ?? "",
          );
          if (notes.length === 0) return;
          yield* save({ ...state, steer: [...state.steer, ...notes] });
          yield* log(`creator steer: ${notes.length} note(s) for the next round`);
          yield* Effect.promise(() => NodeFSP.rm(paths(root).steer, { force: true }));
        }),
      );
      const takeProfile = Effect.gen(function* () {
        const requested = (yield* Effect.promise(() => readText(paths(root).profile)))?.trim();
        d.slot.profile = null;
        if (requested !== "guided" && requested !== "autopilot") return;
        yield* Effect.promise(() => NodeFSP.rm(paths(root).profile, { force: true }));
        if (requested === state.profile) return;
        yield* save({ ...state, profile: requested });
        yield* log(`creator switched the run to ${requested}`);
      });
      const inputs = (): Policy.Inputs => ({
        now: Date.now(),
        coin: NodeCrypto.randomInt(2 ** 30) / 2 ** 30,
        id: NodeCrypto.randomUUID(),
      });

      // A pair's two halves write the in-flight step at once; each write reads
      // the state only after it holds this lock, so neither loses the other's.
      const inFlightLock = Semaphore.makeUnsafe(1);
      // The run's own history of which role ran in which thread and when; a
      // resume finds the step's thread from T3, never from here.
      const started = (role: string) => (threadId: ThreadId) =>
        inFlightLock.withPermits(1)(
          Effect.suspend(() =>
            state.threads.some((t) => t.threadId === threadId)
              ? Effect.void
              : save({
                  ...state,
                  threads: [
                    ...state.threads,
                    { role, threadId, startedAt: new Date().toISOString() },
                  ],
                }),
          ),
        );
      // A finished half is saved at once, so a resume never plays it again.
      const recordHalf = (id: number, result: State.HalfResult) =>
        inFlightLock.withPermits(1)(
          Effect.suspend(() => {
            const step = state.inFlight;
            if (step?.kind !== "pair") return Effect.void;
            return save({
              ...state,
              inFlight: { ...step, results: [...step.results, { id, result }] },
            });
          }),
        );

      const execute = (step: Exclude<State.Step, State.PairStep>) => {
        switch (step.kind) {
          case "role":
            return Effect.gen(function* () {
              // The art director judges files, so it gets the asset-list and measured image facts;
              // the redo that answers it sees the same measurements.
              const task = state.task;
              const redo = step.role === "art" && task._tag === "stage" && task.phase === "redo";
              const judged = step.role === "art-director" || redo;
              const sprites = judged
                ? (yield* Effect.promise(() => spriteFacts(root, state.lane))).full
                : "";
              const models = judged
                ? (yield* Effect.promise(() => modelFacts(root, state.lane))).full
                : "";
              const prompt =
                step.role === "art-director"
                  ? `${step.prompt}${artFacts(yield* Effect.promise(() => artAssetFacts(root, state.lane)), sprites)}${modelBlock(models)}`
                  : redo
                    ? `${step.prompt}${spriteBlock(sprites, true)}${modelBlock(models, true)}`
                    : step.prompt;
              // An engine whose first editor open imports the whole project
              // (minutes; later opens take seconds) pays it here, before any
              // role's clock, so the first prototype is not capped on it
              // while the second starts warm.
              const warmFrom = Date.now();
              const engine = laneProfile(state.lane);
              if (engine.run.warmEditor && step.at === null)
                yield* waitOutLowMemory(
                  d.deps.game.warmEditor(root),
                  `${engine.displayName} warm-up`,
                  log,
                ).pipe(
                  Effect.matchEffect({
                    onSuccess: (warmed) =>
                      warmed
                        ? log(
                            `${engine.displayName} warm-up: first import took ${Math.round((Date.now() - warmFrom) / 1000)} s, before ${step.role}'s clock`,
                          )
                        : Effect.void,
                    onFailure: (error) =>
                      log(
                        `${engine.displayName} warm-up skipped (${(error.detail ?? error.reason).slice(0, 200)}); the role opens the editor itself`,
                      ),
                  }),
                );
              return yield* runRole(
                d.deps,
                {
                  root,
                  lane: state.lane,
                  projectId: d.projectId,
                  creator: d.creator,
                  runId: state.runId,
                  selection: d.selection,
                  runtimeMode: d.runtimeMode,
                  budgetEndsAt: state.budgetEndsAt,
                  started: started(step.role),
                  log,
                },
                { ...step, prompt },
              );
            });
          case "git":
            return gitStep(d.deps.game, git, root, step.op).pipe(
              Effect.flatMap((done) =>
                step.op._tag !== "init" || !done.git.ok
                  ? Effect.succeed(done)
                  : refreshHarnessFiles(git, root, state.lane, log).pipe(
                      Effect.map((sha) =>
                        sha === null ? done : { ...done, git: { ...done.git, sha } },
                      ),
                    ),
              ),
            );
          case "boot":
            return bootStep(d.deps.game, { creator: d.creator, root, lane: state.lane, log });
          case "facts":
            return Effect.gen(function* () {
              const jev = Option.isSome(
                yield* secrets
                  .get("game-bot-jev-api-key")
                  .pipe(Effect.orElseSucceed(() => Option.none())),
              );
              return {
                kind: "facts",
                jev,
                code: yield* Effect.promise(() => reviewerFacts(root, state.lane)),
              } as const;
            });
          case "checks": {
            const rung = state.ladder?.rungs.find((x) => x.id === step.rung);
            return (
              rung === undefined ? Effect.succeed([]) : runStateChecks(d.deps.game, root, rung)
            ).pipe(Effect.map((results) => ({ kind: "checks", results }) as const));
          }
          case "bot":
            return runBotFact(d.deps, { root, runId: state.runId, log }, step);
          case "decide":
            return Effect.gen(function* () {
              const answer = yield* Deferred.make<Answer>();
              d.slot.waiting = { decision: step.decision, answer };
              // Read after the wait is visible: runProfile either sees it or left its switch here.
              if ((d.slot.profile ?? state.profile) === "autopilot")
                yield* Deferred.succeed(answer, fallbackOf(step.decision));
              return yield* decideStep(
                d.deps,
                {
                  root,
                  lane: state.lane,
                  runId: state.runId,
                  creator: d.creator,
                  answer,
                  log,
                  update: (next) => save({ ...state, inFlight: next }),
                },
                step,
              ).pipe(Effect.ensuring(Effect.sync(() => void (d.slot.waiting = null))));
            });
          case "note":
            return Effect.promise(async () => {
              for (const file of step.files)
                await writeAtomic(NodePath.join(root, file.path), file.text);
              return { kind: "note" } as const;
            });
        }
      };

      // Both halves run at once, each in its own worktree; one failing never
      // cancels the other, and a stop interrupts both. The pair lands only once
      // every half has finished; until then it stays in flight with the
      // results it has, so a resume runs just the rest.
      const runPair = (pair: State.PairStep) =>
        Effect.gen(function* () {
          const ended: Array<Extract<Policy.StepResult, { kind: "ended" }>> = [];
          const exits = yield* Effect.forEach(
            // Launched in play order (ids follow the coin), so the candidate
            // never systematically starts first and wins the boot lock.
            pair.halves
              .filter((half) => !pair.results.some((r) => r.id === half.id))
              .toSorted((a, b) => a.id - b.id),
            (half) =>
              Effect.gen(function* () {
                const result = yield* execute(half);
                yield* log(`  step ${half.id}: ${summarize(result)}`);
                if (result.kind === "done" || result.kind === "failed" || result.kind === "bot")
                  yield* recordHalf(half.id, result);
                else if (result.kind === "ended") ended.push(result);
              }).pipe(Effect.exit),
            { concurrency: 2 },
          );
          const failed = exits.find(Exit.isFailure);
          if (failed !== undefined) return yield* Effect.failCause(failed.cause);
          yield* takeSteer;
          const current = state.inFlight?.kind === "pair" ? state.inFlight : pair;
          return ended[0] === undefined
            ? Policy.applyPair(state, current, inputs())
            : Policy.applyResult(state, current, ended[0], inputs());
        });

      const loop = Effect.gen(function* () {
        yield* ensureScaffold(root, state.lane, git.untrack, state.seq === 0);
        // Resume: put the tree where the next step expects it. A git step in
        // flight re-runs instead (every op is safe to repeat).
        const expected = Policy.expectedBranch(state);
        if (expected !== null && state.inFlight?.kind !== "git") {
          // Through gitStep, so live editors close before the checkout moves.
          const entered = yield* gitStep(d.deps.game, git, root, {
            _tag: "enter",
            branch: expected,
          }).pipe(
            Effect.map((r) => r.git),
            Effect.option,
          );
          if (Option.isNone(entered) || !entered.value.ok)
            yield* log(`resume: could not enter ${expected}; continuing where HEAD is`);
        }
        yield* save(state);
        for (;;) {
          if (yield* stopRequested(root)) return yield* save({ ...state, ending: "stopped" });
          yield* takeSteer;
          yield* takeProfile;
          const planned = Policy.plan(state, inputs());
          if (planned.kind === "end") {
            yield* log(`run ended: ${planned.reason}`);
            return yield* save({ ...state, ending: planned.reason });
          }
          yield* save(planned.state);
          for (const line of planned.logs ?? []) yield* log(line);
          yield* log(describe(planned.step));
          let applied: Policy.Applied;
          if (planned.step.kind === "pair") applied = yield* runPair(planned.step);
          else {
            const result = yield* execute(planned.step);
            yield* log(`  ${summarize(result)}`);
            // Again before the result lands: a ship verdict must see a note sent during its turn.
            yield* takeSteer;
            yield* takeProfile;
            applied = Policy.applyResult(state, state.inFlight ?? planned.step, result, inputs());
          }
          for (const line of applied.logs) yield* log(line);
          for (const file of applied.files)
            yield* Effect.promise(() =>
              writeAtomic(NodePath.join(root, file.path), file.text),
            ).pipe(Effect.ignore);
          yield* save(applied.state);
          for (const thread of applied.release)
            yield* releaseWorktree(d.deps, { root, log }, thread);
          if (state.ending !== null)
            return yield* log(
              `run ended: ${state.ending}${state.lastFailure ? ` (${state.lastFailure})` : ""}`,
            );
        }
      });

      yield* loop.pipe(
        // A failed step keeps its place: the run ends "failed" (resumable) and
        // the creator sees why; the step re-runs on the next start.
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            log(`run loop failed: ${causeText(cause)}`).pipe(
              Effect.andThen(
                save({
                  ...state,
                  ending: "failed",
                  lastFailure: `run loop failed: ${causeText(cause)}`,
                }),
              ),
            ),
        ),
        // Only the creator's stop (which leaves the stop file) ends the run; a
        // server shutdown interrupts it too, and that run must resume at startup.
        Effect.onInterrupt(() =>
          Effect.flatMap(stopRequested(root), (stopped) =>
            stopped ? save({ ...state, ending: "stopped" }) : Effect.void,
          ),
        ),
      );
      // Exports need the memory a low-memory ending says is missing.
      if (
        state.ending !== "stopped" &&
        state.ending !== "failed" &&
        state.ending !== "low-memory"
      ) {
        // An ending mid-round (a usage limit, a provider outage) leaves the
        // round's branch checked out with its unfinished work. The export is of
        // the best build: that work is committed to its branch (a resume enters
        // it again) and trunk is checked out first.
        if (state.trunk.length > 0) {
          const parked = yield* gitStep(d.deps.game, git, root, {
            _tag: "to-trunk",
            trunk: state.trunk,
            message: `unfinished: the run ended (${state.ending})`,
          }).pipe(Effect.option);
          if (Option.isNone(parked) || !parked.value.git.ok)
            yield* log(
              `finishExports: could not return to ${state.trunk}; exporting where HEAD is`,
            );
        }
        yield* finishExports(root, d.creator, d.deps.game, log).pipe(Effect.ignore);
      }
    });

    const startClaimed = Effect.fn("GameRun.startClaimed")(function* (
      input: GameRunStartInput,
      target: Effect.Success<ReturnType<typeof resolveGame>>,
      slot: RunSlot,
    ) {
      const { root, projectId } = target;
      // A start is an intent to run: a stale stop request would end it at once.
      yield* Effect.promise(() => NodeFSP.rm(paths(root).stop, { force: true }));
      const loaded = yield* load(root);
      if (loaded.kind === "unreadable")
        return yield* new GameRunError({
          operation: "run-start",
          path: paths(root).run,
          reason: "state-unreadable",
          detail: `${paths(root).run} could not be read as a run record. Fix or move it aside, then start again.`,
        });
      const prior = loaded.kind === "none" ? null : loaded.state;
      const resumed = prior !== null && CONTINUABLE.has(prior.ending);
      const next = ((yield* Effect.promise(() => readText(paths(root).next))) ?? "")
        .trim()
        .slice(0, 4000);
      let state: State.RunState;
      if (resumed) {
        state = {
          ...prior,
          brief: input.brief.length > 0 ? input.brief : prior.brief,
          budgetMinutes: input.budgetMinutes ?? prior.budgetMinutes,
          // A model chosen at resume replaces the run's; its variant goes with it.
          ...(input.provider === undefined && input.model === undefined
            ? {}
            : {
                provider: input.provider ?? prior.provider,
                model: input.model ?? prior.model,
                variant: input.variant ?? null,
              }),
          ending: null,
          creator: input.threadId,
          profile: input.profile ?? prior.profile,
          ...(loaded.kind === "legacy" ? { next } : {}),
        };
        if (loaded.kind === "legacy")
          yield* logLine(
            root,
            `resuming a run from the previous loop at stage ${prior.stage}; recovering trunk first`,
          );
      } else {
        if (input.brief.trim().length === 0)
          return yield* new GameRunError({
            operation: "run-start",
            path: root,
            reason: "brief-required",
            detail: "A new run needs a brief.",
          });
        const rounds =
          prior?.rounds ??
          State.parseJournal((yield* Effect.promise(() => readText(paths(root).rounds))) ?? "");
        state = {
          ...State.freshState(
            {
              runId: `run_${Date.now().toString(36)}${NodeCrypto.randomBytes(3).toString("hex")}`,
              profile: input.profile ?? "guided",
              brief: input.brief,
              artDirection: input.artDirection ?? "",
              budgetMinutes: input.budgetMinutes ?? null,
              provider: input.provider ?? null,
              model: input.model ?? null,
              variant: input.variant ?? null,
              startedAt: new Date().toISOString(),
            },
            { rounds, pending: null },
          ),
          // Stages a previous run finished are not redone.
          stage: prior === null ? State.legacyResumeStage("starting", rounds.length) : prior.stage,
          pickNotes: prior?.pickNotes ?? "",
          picked: prior?.picked ?? null,
          lastDirection: prior?.lastDirection ?? "",
          steer: prior?.steer ?? [],
          creator: input.threadId,
          next,
        };
        if (prior !== null)
          yield* logLine(
            root,
            `run ${prior.runId} ended ${prior.ending}; starting ${state.runId} from stage ${state.stage}`,
          );
      }
      const manifest = yield* projects.read(root).pipe(Effect.option);
      const projection = yield* threads.getThreadProjection(input.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new GameRunError({
              operation: "run-start",
              path: input.threadId,
              reason: "thread-read",
              cause,
            }),
        ),
      );
      const current =
        ThreadManagement.latestRun(projection)?.modelSelection ?? projection.thread.modelSelection;
      state = {
        ...state,
        lane: Option.isSome(manifest) ? manifest.value.godotProject : "godot",
        budgetEndsAt:
          state.budgetMinutes === null ? null : Date.now() + state.budgetMinutes * 60_000,
      };
      const drives: Drive = {
        root,
        projectId,
        creator: input.threadId,
        deps,
        selection: selectionFor(current, state),
        runtimeMode: projection.thread.runtimeMode,
        slot,
      };
      slot.runId = state.runId;
      // The loop outlives this request, so it gets its own scope. Fork and
      // record the fiber as one step: once a loop exists, only it releases the slot.
      const fiber = yield* Effect.uninterruptible(
        Effect.forkDetach(
          Effect.scoped(drive(drives, state)).pipe(
            Effect.catchCause((cause) => logLine(root, `run loop failed: ${causeText(cause)}`)),
            Effect.ensuring(
              Effect.sync(() => active.get(root) === slot && active.delete(root)).pipe(
                Effect.andThen(operations.recordRun(root, null)),
              ),
            ),
          ),
        ).pipe(Effect.tap((forked) => Effect.sync(() => void (slot.fiber = forked)))),
      );
      // A stop that arrived while this start was preparing.
      if (slot.stop) {
        yield* writeStopFile(root);
        yield* Fiber.interrupt(fiber);
      }
      return { runId: state.runId, root, stage: state.stage, resumed };
    });

    const runStart = Effect.fn("GameRun.runStart")(function* (input: GameRunStartInput) {
      const target = yield* resolveGame(input.threadId);
      if (restoring.has(target.root))
        return yield* new GameRunError({
          operation: "run-start",
          path: target.root,
          reason: "restoring",
          detail: "A round is being restored for this game. Start the run once it finishes.",
        });
      const existing = active.get(target.root);
      if (existing !== undefined) {
        const loaded = yield* load(target.root);
        const stage =
          loaded.kind === "v3" || loaded.kind === "legacy" ? loaded.state.stage : "running";
        return { runId: existing.runId, root: target.root, stage, resumed: true };
      }
      const slot: RunSlot = { fiber: null, runId: "", stop: false, profile: null, waiting: null };
      active.set(target.root, slot);
      return yield* startClaimed(input, target, slot).pipe(
        Effect.onExit(() =>
          Effect.sync(
            () =>
              slot.fiber === null && active.get(target.root) === slot && active.delete(target.root),
          ),
        ),
      );
    });

    const writeStopFile = (root: string) =>
      Effect.promise(() =>
        writeAtomic(paths(root).stop, `stopped by the creator at ${new Date().toISOString()}\n`),
      ).pipe(Effect.ignore);

    const runStatus = Effect.fn("GameRun.runStatus")(function* (threadId: ThreadId) {
      const { root } = yield* resolveGame(threadId);
      const loaded = yield* load(root);
      if (loaded.kind === "none" || loaded.kind === "unreadable")
        return {
          active: false,
          runId: null,
          profile: null,
          decision: null,
          stage: "none",
          step: null,
          ending: null,
          startedAt: null,
          progress: null,
          pick: null,
          ladder: [],
          rounds: [],
          steer: [],
          threads: [],
          message:
            loaded.kind === "none"
              ? "No run recorded for this game."
              : "The run record (.studio/run.json) could not be read.",
        } satisfies GameRunStatusResult;
      const state = loaded.state;
      const running = active.has(root);
      // A stop request with no live fiber means the creator stopped the run.
      const ending =
        !running && (yield* stopRequested(root)) ? "stopped" : running ? null : state.ending;
      const failure = state.lastFailure.length > 0 ? ` Last failure: ${state.lastFailure}` : "";
      const step = running ? currentStep(state) : null;
      const queued = parseSteer((yield* Effect.promise(() => readText(paths(root).steer))) ?? "");
      const slot = active.get(root);
      return {
        active: running,
        runId: state.runId,
        profile: slot?.profile ?? state.profile,
        decision: running ? decisionOf(root, state) : null,
        stage: state.stage,
        step,
        ending,
        startedAt: state.startedAt,
        progress: runProgress(state),
        pick: pickRef(state),
        ladder: ladderRefs(state),
        rounds: state.rounds.map((r) => ({
          round: r.round,
          move: r.move,
          branch: r.branch,
          kept: r.kept,
          outcome: roundOutcome(r),
          verdicts: r.verdicts,
          linesChanged: r.linesChanged,
          testerNote: r.testerNote ?? null,
          durationMs: r.durationMs,
          note: r.note ?? null,
          steer: r.steer ?? [],
          rung:
            r.rung === undefined
              ? null
              : { is: r.rung.is, checks: r.rung.checks, outcome: r.rung.outcome, why: r.rung.why },
        })),
        steer: [...state.steer, ...queued],
        threads: state.threads,
        message:
          ending !== null
            ? `The run ended: ${ending}.${failure}`
            : running && state.inFlight?.kind === "decide"
              ? `Waiting for the creator's answer on ${DECISION_LABEL[state.inFlight.decision.kind]}; answer in the game's chat.`
              : `${step ?? state.stage}, ${state.rounds.length} round${state.rounds.length === 1 ? "" : "s"} done.${failure}`,
      } satisfies GameRunStatusResult;
    });

    const runStop = Effect.fn("GameRun.runStop")(function* (threadId: ThreadId) {
      const { root } = yield* resolveGame(threadId);
      yield* writeStopFile(root);
      const running = active.get(root);
      if (running !== undefined) {
        if (running.fiber === null) running.stop = true;
        else yield* Fiber.interrupt(running.fiber);
      }
      return {
        stopped: true,
        message:
          "The run was stopped. Rejected work stays on its branch; the folder holds all state.",
      };
    });

    const runDecide = Effect.fn("GameRun.runDecide")(function* (input: GameRunDecideInput) {
      const { root } = yield* resolveGame(input.threadId);
      const no = (reason: string, detail: string) => refuse("run-decide", root, reason, detail);
      const waiting = active.get(root)?.waiting ?? null;
      if (waiting === null)
        return yield* no(
          "no-decision",
          "The run is not waiting for a decision now; it may have taken its default already. game_run_status shows where it stands. If the user was answering a question the run already decided, pass their words on with game_run_steer so they shape the next steps.",
        );
      if (waiting.decision.id !== input.decisionId)
        return yield* no(
          "stale-decision",
          `Decision ${input.decisionId} is not the one waiting; the run waits on ${waiting.decision.id}.`,
        );
      const checked = Policy.checkAnswer(waiting.decision, input.answer, input.notes ?? "");
      if ("error" in checked) return yield* no("invalid-answer", checked.error);
      const answer: Answer = { ...checked, by: "creator" };
      if (!(yield* Deferred.succeed(waiting.answer, answer)))
        return yield* no("already-decided", "The run already took an answer for this decision.");
      yield* logLine(root, `creator answered ${waiting.decision.id}: ${checked.answer}`);
      return {
        message: `Recorded: ${checked.answer}. The run goes on with it; game_run_status shows its next step.`,
      } satisfies GameRunDecideResult;
    });

    const runProfile = Effect.fn("GameRun.runProfile")(function* (
      threadId: ThreadId,
      profile: GameRunProfile,
    ) {
      const { root } = yield* resolveGame(threadId);
      const slot = active.get(root);
      if (slot === undefined)
        return yield* refuse(
          "run-profile",
          root,
          "no-live-run",
          "No live run for this game. Start or resume the run with the profile you want.",
        );
      slot.profile = profile;
      yield* Effect.promise(() => writeAtomic(paths(root).profile, `${profile}\n`));
      // Nobody needs to answer an Autopilot run: the waiting question takes its default now.
      const waiting = slot.waiting;
      if (profile === "autopilot" && waiting !== null)
        yield* Deferred.succeed(waiting.answer, fallbackOf(waiting.decision));
      return {
        profile,
        message:
          profile === "guided"
            ? "The run is Guided from its next decision point: it asks in the chat and takes its default when nobody answers."
            : "The run is on Autopilot: it decides everything itself from now on.",
      } satisfies GameRunProfileResult;
    });

    const runSteer = Effect.fn("GameRun.runSteer")(function* (threadId: ThreadId, text: string) {
      const { root } = yield* resolveGame(threadId);
      const note = text.trim().slice(0, 4000);
      if (note.length === 0)
        return yield* new GameRunError({
          operation: "run-steer",
          path: root,
          reason: "empty-note",
          detail: "The note is empty.",
        });
      const live = active.has(root);
      // A finished run comes back for a note: the creator's ask is the only thing
      // that buys rounds past its goal (one round per ask, then it stops again).
      const ended = live ? null : yield* load(root);
      if (!live && ended?.kind !== "v3")
        return yield* new GameRunError({
          operation: "run-steer",
          path: root,
          reason: "no-live-run",
          detail: "No run for this game yet. Work on the game directly, or start a run first.",
        });
      const queued = yield* steerLock.withPermits(1)(
        Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.dirname(paths(root).steer), { recursive: true });
          await NodeFSP.appendFile(paths(root).steer, `${JSON.stringify(note)}\n`);
          return parseSteer((await readText(paths(root).steer)) ?? "").length;
        }),
      );
      if (!live) {
        yield* runStart({ threadId, brief: "" });
        return {
          pending: queued,
          message:
            "The run resumes to work on this note for one round, then stops. Ask again for more.",
        } satisfies GameRunSteerResult;
      }
      const loaded = yield* load(root);
      const state = loaded.kind === "v3" ? loaded.state : null;
      return {
        pending: (state?.steer.length ?? 0) + queued,
        message: `Noted for the production run. ${steerWhen(state)}`,
      } satisfies GameRunSteerResult;
    });

    const runChecks = Effect.fn("GameRun.runChecks")(function* (threadId: ThreadId) {
      const { root } = yield* resolveGame(threadId);
      const loaded = yield* load(root);
      const state = loaded.kind === "v3" ? loaded.state : null;
      const ladder = state?.ladder ?? null;
      // The rung the round in progress builds, else the next open one.
      const current =
        state?.task._tag === "round" && state.task.rung !== null ? state.task.rung : null;
      const rung =
        ladder?.rungs.find((x) => x.id === current) ??
        ladder?.rungs.find((x) => x.status === "todo") ??
        null;
      if (ladder === null || rung === null)
        return {
          rung: null,
          is: "",
          results: [],
          message: "The run has no open rung to score.",
        } satisfies GameRunChecksResult;
      const outcomes = yield* runStateChecks(game, root, rung);
      const passed = outcomes.filter((o) => o.pass).length;
      return {
        rung: ladder.rungs.indexOf(rung) + 1,
        is: rung.is,
        results: outcomes.map((o) => ({
          check: o.k + 1,
          what: o.what,
          pass: o.pass,
          evidence: o.evidence,
          frame: o.frame,
        })),
        message:
          outcomes.length === 0
            ? "This rung has no state checks; its checks are look checks a tester judges."
            : `${passed} of ${outcomes.length} state checks pass on the build in the game folder now.`,
      } satisfies GameRunChecksResult;
    });

    const refuse = (operation: string, path: string, reason: string, detail: string) =>
      new GameRunError({ operation, path, reason, detail });

    // The run record and the round asked for, plus the game's engine directory.
    const findRound = Effect.fn("GameRun.findRound")(function* (
      operation: string,
      threadId: ThreadId,
      round: number,
    ) {
      const target = yield* resolveGame(threadId);
      const loaded = yield* load(target.root);
      if (loaded.kind === "none" || loaded.kind === "unreadable")
        return yield* refuse(
          operation,
          target.root,
          "no-run",
          loaded.kind === "none"
            ? "No run recorded for this game."
            : "The run record (.studio/run.json) could not be read.",
        );
      const record = loaded.state.rounds.find((r) => r.round === round);
      if (record === undefined)
        return yield* refuse(
          operation,
          target.root,
          "round-not-found",
          `Round ${round} is not recorded; the run has ${loaded.state.rounds.length} finished round${loaded.state.rounds.length === 1 ? "" : "s"}.`,
        );
      const manifest = yield* projects.read(target.root).pipe(Effect.option);
      const lane = Option.isSome(manifest) ? manifest.value.godotProject : loaded.state.lane;
      const trunk = loaded.state.trunk.length > 0 ? loaded.state.trunk : "main";
      return { ...target, loaded, state: loaded.state, record, lane: lane || "godot", trunk };
    });

    const roundDetail = Effect.fn("GameRun.roundDetail")(function* (
      threadId: ThreadId,
      round: number,
    ) {
      const found = yield* findRound("run-round", threadId, round);
      const { root, state, record } = found;
      const evidence = yield* Effect.promise(() => readRoundEvidence(root, state, record));
      const git = makeGit(root, found.lane, () => Effect.void);
      const sha = record.kept ? yield* git.keptCommit(record.branch, found.trunk) : null;
      const current = sha === null ? false : yield* git.sameBuild(sha);
      return {
        detail: { ...evidence.detail, restorable: sha !== null, current },
        videoFile: evidence.videoFile,
        sheetFiles: evidence.sheetFiles,
      };
    });

    const pickDetail = Effect.fn("GameRun.pickDetail")(function* (threadId: ThreadId) {
      const { root } = yield* resolveGame(threadId);
      const loaded = yield* load(root);
      if (loaded.kind === "none" || loaded.kind === "unreadable")
        return yield* refuse(
          "run-pick",
          root,
          "no-run",
          loaded.kind === "none"
            ? "No run recorded for this game."
            : "The run record (.studio/run.json) could not be read.",
        );
      return yield* Effect.promise(() => readPickEvidence(root, loaded.state));
    });

    const restoreRound = Effect.fn("GameRun.restoreRound")(function* (
      threadId: ThreadId,
      round: number,
    ) {
      const target = yield* resolveGame(threadId);
      const root = target.root;
      const no = (reason: string, detail: string) => refuse("run-restore", root, reason, detail);
      // Checked and claimed with no yield between, like runStart's slot.
      if (active.has(root) || restoring.has(root))
        return yield* no(
          "run-live",
          "A production run is live for this game. Stop it before restoring a round.",
        );
      restoring.add(root);
      return yield* Effect.gen(function* () {
        // Read only after the claim: no run can change run.json from here on.
        const found = yield* findRound("run-restore", threadId, round);
        const { state, record, trunk, lane } = found;
        if (!record.kept)
          return yield* no(
            "not-kept",
            `Round ${round} was not kept (${roundOutcome(record)}); only a kept round's build can be restored. Its work stays on branch ${record.branch}.`,
          );
        // A saved git step replays on resume with the commit ids it froze (the
        // round's branch, the old best), which a restore would leave stale. Role,
        // facts and bot steps on trunk just replay against the restored build.
        if (state.inFlight?.kind === "git" && CONTINUABLE.has(state.ending))
          return yield* no(
            "mid-step",
            "The stopped run saved an unfinished git step and would replay it on resume. Resume the run and let that step finish, then restore.",
          );
        const log = (line: string) => logLine(root, line);
        const git = makeGit(root, lane, log);
        const on = yield* git.current;
        if (on !== trunk)
          return yield* no(
            "off-trunk",
            `The game is on ${on === "HEAD" || on === "" ? "a detached commit" : `branch ${on}`}, not ${trunk}. Resume the run to let it return to ${trunk}, or switch back yourself, then restore.`,
          );
        // A stopped run resumes onto its round's branch; moving trunk under it
        // would leave that round judged against a build the tree no longer has.
        const expected = Policy.expectedBranch(state);
        if (expected !== null && expected !== trunk && CONTINUABLE.has(state.ending))
          return yield* no(
            "mid-round",
            `The stopped run is in the middle of its work on ${expected}. Resume it and let the round finish, then restore.`,
          );
        const dirty = yield* git.uncommitted;
        if (dirty.length > 0)
          return yield* no(
            "uncommitted-work",
            `The game has uncommitted changes, so nothing was restored: ${git.summary(dirty.join("\n"))}. Commit or discard them first.`,
          );
        const sha = yield* git.keptCommit(record.branch, trunk);
        if (sha === null)
          return yield* no(
            "commit-missing",
            `Round ${round}'s commit (branch ${record.branch}) is no longer on ${trunk}.`,
          );
        const what = restoredPaths(lane).join(", ");
        if (yield* git.sameBuild(sha))
          return {
            sha,
            message: `Round ${round}'s build (${what}) is already the game's current build.`,
          } satisfies GameRunRestoreResult;
        // Closed first, so no live editor saves its in-memory scene over the restored files.
        yield* game.closeLiveEditors(root);
        const restored = yield* git.restoreBuild(sha, `restore round ${round} (creator)`);
        if (!(yield* git.sameBuild(sha)))
          return yield* no(
            "restore-incomplete",
            `Restoring round ${round} did not reproduce its build; see .studio/run.log and the game's git status.`,
          );
        // The restored build becomes the run's judged best, so a resumed run
        // compares its next round against what the creator chose.
        if (found.loaded.kind === "v3")
          yield* Effect.promise(() =>
            writeAtomic(
              paths(root).run,
              `${JSON.stringify(State.encodeRunState({ ...state, best: restored, pending: null }), null, 2)}\n`,
            ),
          );
        yield* log(
          `creator restored round ${round} (${sha.slice(0, 8)}) as ${restored.slice(0, 8)} on ${trunk}: ${what}`,
        );
        return {
          sha: restored,
          message: `Round ${round}'s ${what} are back as commit ${restored.slice(0, 8)} on ${trunk}; notes, PLAN.md, VISION.md, bots and run records were left as they are. Later commits stay in git history, and restoring a later kept round goes forward again.`,
        } satisfies GameRunRestoreResult;
      }).pipe(
        Effect.catchTags({
          RunGitError: (cause) =>
            Effect.fail(
              cause.op === "restore-apply"
                ? no(
                    "local-changes",
                    `Nothing was restored: git refused to apply it (${cause.reason}). Usually a change made meanwhile touches a restored file, or another git command is running; commit or discard the change, then restore again.`,
                  )
                : no(
                    "git-failed",
                    `${cause.message} See .studio/run.log and the game's git status.`,
                  ),
            ),
        }),
        Effect.ensuring(Effect.sync(() => restoring.delete(root))),
      );
    });

    const createGame = Effect.fn("GameRun.createGame")(function* (input: GameCreateInput) {
      const created = yield* projects.create(input);
      // The game exists either way; a run that cannot start shows as not
      // started in the Run tab, where the creator can start it again.
      yield* runStart({
        threadId: created.threadId,
        brief: input.brief,
        ...(input.artDirection === undefined ? {} : { artDirection: input.artDirection }),
        ...(input.profile === undefined ? {} : { profile: input.profile }),
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("game run did not start after create", { reason: cause.message }),
        ),
      );
      return created;
    });

    // A live run's state has no ending; a creator's stop leaves the stop file,
    // so neither a stopped nor a finished run comes back on its own.
    const resumeInterrupted = Effect.fn("GameRun.resumeInterrupted")(function* () {
      const games = yield* projects.list().pipe(Effect.orElseSucceed(() => []));
      for (const game of games) {
        if (active.has(game.root) || (yield* stopRequested(game.root))) continue;
        const loaded = yield* load(game.root);
        if (loaded.kind !== "v3") continue;
        const { ending, creator } = loaded.state;
        if (ending !== null || creator.length === 0) continue;
        yield* logLine(game.root, "server restarted: resuming the live run");
        yield* runStart({ threadId: ThreadId.make(creator), brief: "" }).pipe(
          Effect.catch((cause) =>
            logLine(game.root, `resume after restart failed: ${cause.message}`.slice(0, 300)),
          ),
        );
      }
    });

    return GameRun.of({
      runStart,
      createGame,
      runStatus,
      runStop,
      runDecide,
      runProfile,
      runSteer,
      runChecks,
      roundDetail,
      pickDetail,
      restoreRound,
      resumeInterrupted,
    });
  }),
);
