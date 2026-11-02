// @effect-diagnostics globalDate:off globalDateInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off -- This service owns the production loop's native boundary: wall-clock caps, the run state files and the skill pack in the game folder, like the bot and Blender services.
// GameRun: one game's production loop. A pure policy (run/policy.ts) decides one step at a
// time; this driver executes it with T3 services and persists `.studio/run.json` after every step.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  ProviderInstanceId,
  type GameRunStartInput,
  type GameRunStatusResult,
  type ModelSelection,
  type ProjectId,
  type RunId,
  type ThreadId,
} from "@kurambit/contracts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameService from "./GameService.ts";
import * as Templates from "./templates.ts";
import { reviewerFacts } from "./run/facts.ts";
import { finishExports } from "./run/finish.ts";
import { makeGit } from "./run/git.ts";
import * as Policy from "./run/policy.ts";
import { runRole, type RoleDeps } from "./run/roleRunner.ts";
import * as State from "./run/state.ts";

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

// Run state, notes and reports are harness output, never game content:
// ignoring them keeps the tree clean so build swaps never need a stash
// (T28 wedged on a half-applied stash pop; T29 removed stash use).
const RUN_STATE_IGNORES = [
  ".studio/run.json",
  ".studio/rounds.jsonl",
  ".studio/stop",
  ".studio/run.log",
  ".studio/bot-results.jsonl",
  ".studio/player-report.md",
  ".studio/pick.txt",
  ".studio/next.md",
  ".studio/ship.md",
  ".studio/exports.json",
  ".studio/final-video.json",
  ".studio/tester-*.md",
  ".studio/reviewer-*.md",
  ".studio/worktrees/",
  ".studio/comparisons/",
  ".studio/play-*.md",
  ".studio/round-state.json",
  "PICK-NOTES.md",
  "JUDGE-NOTES.md",
] as const;

// A shipped or stalled run starts over (keeping its history); every other ending resumes.
const CONTINUABLE = new Set([null, "budget", "usage-limit", "provider-down", "stopped", "failed"]);

const SKILLS_LINE = `\n\n## Studio skills (read the ones your role needs)\n\nSkill pack in ./studio-skills, one line each: planning (look, cut to the ask, plan and rungs); game-foundations (boundaries, state ownership, data-driven content); godot-game (engine rules, CLI, export); three (three.js browser lane: static project, studio bridge, export); playtest (smoke/feature/regression/visual passes, report separately); art-pipeline (key art first, every asset as a file); audio (effects plus a music loop as files); art-director (would you ship this, defects, DO NOT REGRESS, one big move); stranger (first minute cold).\n`;

const readText = (path: string): Promise<string | null> =>
  NodeFSP.readFile(path, "utf8").catch(() => null);

// A unique same-directory temp file plus rename: a crash never leaves a torn
// run.json behind, and concurrent writers never rename each other's inode.
const writeAtomic = async (file: string, text: string): Promise<void> => {
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${NodeCrypto.randomUUID()}`;
  try {
    await NodeFSP.writeFile(tmp, text);
    await NodeFSP.rename(tmp, file);
  } catch (error) {
    await NodeFSP.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
};

const paths = (root: string) => ({
  run: NodePath.join(root, ".studio", "run.json"),
  rounds: NodePath.join(root, ".studio", "rounds.jsonl"),
  stop: NodePath.join(root, ".studio", "stop"),
  log: NodePath.join(root, ".studio", "run.log"),
  next: NodePath.join(root, ".studio", "next.md"),
});

const logLine = (root: string, line: string): Effect.Effect<void> =>
  Effect.promise(() =>
    NodeFSP.mkdir(NodePath.join(root, ".studio"), { recursive: true }).then(() =>
      NodeFSP.appendFile(paths(root).log, `${new Date().toISOString()} ${line}\n`),
    ),
  ).pipe(Effect.ignore);

const causeText = (cause: Cause.Cause<unknown>): string => {
  const squashed: unknown = Cause.squash(cause);
  return (squashed instanceof Error ? squashed.message : "unrecognized failure").slice(0, 300);
};

// The game's chosen provider, model and options: the creator's own unless the
// run was started with overrides. A `#variant` suffix is the client's display
// form, not a routable model: launching with it fails every turn at once, so it
// becomes the `variant` option instead (T25: every #xhigh turn failed this way).
const selectionFor = (current: ModelSelection, state: State.RunState): ModelSelection => {
  let model = state.model ?? current.model;
  let variant = state.variant;
  const suffix = /#([A-Za-z][A-Za-z0-9_-]*)$/.exec(model);
  if (suffix !== null) {
    model = model.slice(0, suffix.index);
    if (variant === null || variant.length === 0) variant = suffix[1] ?? null;
  }
  if ((variant === null || variant.length === 0) && state.model === null && state.provider === null)
    return current;
  const options =
    variant === null || variant.length === 0
      ? current.options
      : [
          ...(current.options ?? []).filter((entry) => entry.id !== "variant"),
          { id: "variant", value: variant },
        ];
  return {
    ...current,
    instanceId:
      state.provider === null ? current.instanceId : ProviderInstanceId.make(state.provider),
    model,
    ...(options === undefined ? {} : { options }),
  };
};

const describe = (step: State.Step): string => {
  if (step.kind === "role")
    return `step ${step.id}: ${step.role}${step.thread === null ? "" : " (follow-up)"}${step.at === null ? "" : ` at ${step.at.slice(0, 12)}`}${step.attached === null ? "" : " (reattach)"}`;
  if (step.kind === "git") return `step ${step.id}: git ${step.op._tag}`;
  return `step ${step.id}: ${step.kind}`;
};
const summarize = (res: Policy.StepResult): string => {
  if (res.kind === "done") return `done${res.timedOut ? " (capped)" : ""} on ${res.threadId}`;
  if (res.kind === "git")
    return `git ok=${res.git.ok} ${res.git.branch} ${res.git.sha.slice(0, 8)} ${res.git.detail}`.trim();
  if (res.kind === "boot") return `boot ${res.ok ? "clean" : `failed: ${res.detail}`}`;
  if (res.kind === "ended" || res.kind === "failed") return `${res.kind}: ${res.reason}`;
  return res.kind;
};

type RunSlot = { fiber: Fiber.Fiber<void, never> | null; runId: string; stop: boolean };

export class GameRun extends Context.Service<
  GameRun,
  {
    readonly runStart: (
      input: GameRunStartInput,
    ) => Effect.Effect<
      { runId: string; root: string; stage: string; resumed: boolean },
      GameRunError
    >;
    readonly runStatus: (threadId: ThreadId) => Effect.Effect<GameRunStatusResult, GameRunError>;
    readonly runStop: (
      threadId: ThreadId,
    ) => Effect.Effect<{ stopped: boolean; message: string }, GameRunError>;
    /** MCP catalog role: "run" for threads this service launched, else null. */
    readonly toolRole: (caller: { readonly threadId: ThreadId }) => Effect.Effect<"run" | null>;
  }
>()("kurambit/game/GameRun") {}

export const layer = (options: { readonly stateDir: string }) => {
  const callerFile = (threadId: string): string =>
    NodePath.join(options.stateDir, "game-run-callers", `${encodeURIComponent(threadId)}.json`);

  // Game services resolve at call time from the request scope (as MCP handlers
  // do), so this layer only needs its state directory and never constrains
  // the server's layer order.
  const need = <S>(option: Effect.Effect<Option.Option<S>>, path: string, name: string) =>
    Effect.flatMap(option, (found) =>
      Option.isSome(found)
        ? Effect.succeed(found.value)
        : Effect.fail(
            new GameRunError({
              operation: "resolve-service",
              path,
              reason: "service-unavailable",
              detail: `${name} is not in scope for this call.`,
            }),
          ),
    );

  const make = Effect.sync(() => {
    // One slot per game root, claimed before runStart's first yield so two
    // starts can never both fork a loop.
    const active = new Map<string, RunSlot>();

    const resolveGame = Effect.fn("GameRun.resolveGame")(function* (threadId: ThreadId) {
      const projects = yield* need(
        Effect.serviceOption(GameProjectService.GameProjectService),
        threadId,
        "Game projects",
      );
      const threads = yield* need(
        Effect.serviceOption(ThreadManagement.ThreadManagementService),
        threadId,
        "Thread management",
      );
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
      return { root, projectId: shell.projectId, projects, threads };
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

    // Skill pack, bot kit and the run-state ignores. New runs and resumes both
    // refresh it, so the committed tree each worktree role starts from has them.
    const ensureScaffold = (
      root: string,
      untrack: (p: ReadonlyArray<string>) => Effect.Effect<void>,
    ) =>
      Effect.promise(async () => {
        const [bundled, monorepo] = Templates.templateDirectoryCandidates(
          NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
          NodePath.join,
        );
        const templates = (await NodeFSP.access(bundled).then(
          () => true,
          () => false,
        ))
          ? bundled
          : monorepo;
        await NodeFSP.mkdir(NodePath.join(root, ".studio", "bot"), { recursive: true });
        await NodeFSP.cp(NodePath.join(templates, "studio"), NodePath.join(root, "studio-skills"), {
          recursive: true,
        }).catch(() => undefined);
        await NodeFSP.cp(
          NodePath.join(templates, "bot-kit"),
          NodePath.join(root, ".studio", "bot", "kit"),
          { recursive: true },
        ).catch(() => undefined);
        const agents = (await readText(NodePath.join(root, "AGENTS.md"))) ?? "";
        if (!agents.includes("studio-skills/"))
          await NodeFSP.writeFile(NodePath.join(root, "AGENTS.md"), `${agents}${SKILLS_LINE}`);
        const ignore = (await readText(NodePath.join(root, ".gitignore"))) ?? "";
        const present = new Set(ignore.split("\n").map((line) => line.trim()));
        const missing = RUN_STATE_IGNORES.filter((line) => !present.has(line));
        if (missing.length > 0)
          await NodeFSP.writeFile(
            NodePath.join(root, ".gitignore"),
            `${ignore}${ignore === "" || ignore.endsWith("\n") ? "" : "\n"}${missing.join("\n")}\n`,
          );
      }).pipe(Effect.ignore, Effect.andThen(untrack(RUN_STATE_IGNORES)));

    const markRoleThread = (threadId: ThreadId) =>
      Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.dirname(callerFile(threadId)), { recursive: true });
        await NodeFSP.writeFile(callerFile(threadId), '{"role":"run"}\n');
      }).pipe(Effect.ignore);

    type Drive = {
      readonly root: string;
      readonly projectId: ProjectId;
      readonly creator: ThreadId;
      readonly deps: RoleDeps;
      readonly secrets: ServerSecretStore.ServerSecretStore["Service"] | null;
      readonly selection: ModelSelection;
      readonly runtimeMode: Parameters<RoleDeps["launches"]["launch"]>[0]["runtimeMode"];
    };

    const drive = Effect.fn("GameRun.drive")(function* (d: Drive, initial: State.RunState) {
      const { root } = d;
      const log = (line: string) => logLine(root, line);
      const git = makeGit(root, initial.lane, log);
      const written = { count: -1 };
      let state = initial;
      const save = (next: State.RunState) => {
        state = next;
        return persist(root, next, written);
      };
      const inputs = (): Policy.Inputs => ({
        now: Date.now(),
        coin: NodeCrypto.randomInt(2 ** 30) / 2 ** 30,
        id: NodeCrypto.randomUUID(),
      });

      // The role records its thread and run before waiting, so a resumed
      // driver reattaches instead of launching a second thread.
      const attach = (threadId: ThreadId, runId: RunId) =>
        Effect.gen(function* () {
          const step = state.inFlight;
          if (step === null || step.kind !== "role") return;
          const fresh = !state.threads.some((t) => t.threadId === threadId);
          if (fresh) yield* markRoleThread(threadId);
          yield* save({
            ...state,
            inFlight: { ...step, attached: { threadId, runId } },
            threads: fresh
              ? [
                  ...state.threads,
                  { role: step.role, threadId, startedAt: new Date().toISOString() },
                ]
              : state.threads,
          });
        });

      const execute = (step: State.Step) => {
        switch (step.kind) {
          case "role":
            return runRole(
              d.deps,
              {
                root,
                lane: state.lane,
                projectId: d.projectId,
                runId: state.runId,
                selection: d.selection,
                runtimeMode: d.runtimeMode,
                budgetEndsAt: state.budgetEndsAt,
                attach,
                log,
              },
              step,
            );
          case "git":
            // A git op always finishes: a stop waits for it rather than leaving a half-moved tree.
            return git.run(step.op).pipe(
              Effect.map((outcome) => ({ kind: "git", git: outcome }) as const),
              Effect.uninterruptible,
            );
          case "boot":
            return d.deps.game.check(d.creator).pipe(
              Effect.map(
                (r) =>
                  ({
                    kind: "boot",
                    ok: r.ok,
                    detail: r.ok ? "boot clean" : "check failed",
                  }) as const,
              ),
            );
          case "facts":
            return Effect.gen(function* () {
              const jev =
                d.secrets === null
                  ? false
                  : Option.isSome(
                      yield* d.secrets
                        .get("game-bot-jev-api-key")
                        .pipe(Effect.orElseSucceed(() => Option.none())),
                    );
              return {
                kind: "facts",
                jev,
                code: yield* Effect.promise(() => reviewerFacts(root, state.lane)),
              } as const;
            });
          case "note":
            return Effect.promise(async () => {
              for (const file of step.files)
                await writeAtomic(NodePath.join(root, file.path), file.text);
              return { kind: "note" } as const;
            });
        }
      };

      const loop = Effect.gen(function* () {
        yield* ensureScaffold(root, git.untrack);
        // Resume: put the tree where the next step expects it. A git step in
        // flight re-runs instead (every op is safe to repeat).
        const expected = Policy.expectedBranch(state);
        if (expected !== null && state.inFlight?.kind !== "git") {
          const entered = yield* git.run({ _tag: "enter", branch: expected }).pipe(Effect.option);
          if (Option.isNone(entered) || !entered.value.ok)
            yield* log(`resume: could not enter ${expected}; continuing where HEAD is`);
        }
        yield* save(state);
        for (;;) {
          if (yield* stopRequested(root)) return yield* save({ ...state, ending: "stopped" });
          const planned = Policy.plan(state, inputs());
          if (planned.kind === "end") {
            yield* log(`run ended: ${planned.reason}`);
            return yield* save({ ...state, ending: planned.reason });
          }
          yield* save(planned.state);
          yield* log(describe(planned.step));
          const result = yield* execute(planned.step);
          yield* log(`  ${summarize(result)}`);
          const applied = Policy.applyResult(
            state,
            state.inFlight ?? planned.step,
            result,
            inputs(),
          );
          for (const line of applied.logs) yield* log(line);
          for (const file of applied.files)
            yield* Effect.promise(() =>
              writeAtomic(NodePath.join(root, file.path), file.text),
            ).pipe(Effect.ignore);
          yield* save(applied.state);
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
        Effect.onInterrupt(() => save({ ...state, ending: "stopped" })),
      );
      if (state.ending !== "stopped" && state.ending !== "failed")
        yield* finishExports(root, d.creator, d.deps.game, log).pipe(Effect.ignore);
    });

    const startClaimed = Effect.fn("GameRun.startClaimed")(function* (
      input: GameRunStartInput,
      target: Effect.Success<ReturnType<typeof resolveGame>>,
      slot: RunSlot,
    ) {
      const { root, projectId, projects, threads } = target;
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
          ending: null,
          ...(loaded.kind === "legacy" ? { next } : {}),
        };
        if (loaded.kind === "legacy")
          yield* logLine(
            root,
            `resuming a run from the previous loop at stage ${prior.stage}; recovering trunk first`,
          );
      } else {
        const rounds =
          prior?.rounds ??
          State.parseJournal((yield* Effect.promise(() => readText(paths(root).rounds))) ?? "");
        state = {
          ...State.freshState(
            {
              runId: `run_${Date.now().toString(36)}${NodeCrypto.randomBytes(3).toString("hex")}`,
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
          lastDirection: prior?.lastDirection ?? "",
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
      const deps: RoleDeps = {
        launches: yield* need(
          Effect.serviceOption(ThreadLaunch.ThreadLaunchService),
          root,
          "Thread launching",
        ),
        threads,
        game: yield* need(Effect.serviceOption(GameService.GameService), root, "Game service"),
        vcs: Option.getOrNull(yield* Effect.serviceOption(GitWorkflow.GitWorkflowService)),
      };
      const secrets = Option.getOrNull(
        yield* Effect.serviceOption(ServerSecretStore.ServerSecretStore),
      );
      const drives: Drive = {
        root,
        projectId,
        creator: input.threadId,
        deps,
        secrets,
        selection: selectionFor(current, state),
        runtimeMode: projection.thread.runtimeMode,
      };
      slot.runId = state.runId;
      // The loop outlives this request, so it gets its own scope. Fork and
      // record the fiber as one step: once a loop exists, only it releases the slot.
      const fiber = yield* Effect.uninterruptible(
        Effect.forkDetach(
          Effect.scoped(drive(drives, state)).pipe(
            Effect.catchCause((cause) => logLine(root, `run loop failed: ${causeText(cause)}`)),
            Effect.ensuring(Effect.sync(() => active.get(root) === slot && active.delete(root))),
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
      const existing = active.get(target.root);
      if (existing !== undefined) {
        const loaded = yield* load(target.root);
        const stage =
          loaded.kind === "v3" || loaded.kind === "legacy" ? loaded.state.stage : "running";
        return { runId: existing.runId, root: target.root, stage, resumed: true };
      }
      const slot: RunSlot = { fiber: null, runId: "", stop: false };
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
          stage: "none",
          ending: null,
          rounds: [],
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
      return {
        active: running,
        runId: state.runId,
        stage: state.stage,
        ending,
        rounds: state.rounds.map((r) => ({
          round: r.round,
          move: r.move,
          branch: r.branch,
          kept: r.kept,
          verdicts: r.verdicts,
          linesChanged: r.linesChanged,
          testerNote: r.testerNote ?? null,
          durationMs: r.durationMs,
          note: r.note ?? null,
        })),
        threads: state.threads,
        message:
          ending === null
            ? `Run ${state.runId} at stage ${state.stage} with ${state.rounds.length} rounds.${failure}`
            : `Run ${state.runId} ended: ${ending}.${failure}`,
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

    const toolRole = (caller: { readonly threadId: ThreadId }): Effect.Effect<"run" | null> =>
      Effect.promise(async () =>
        (await readText(callerFile(caller.threadId)))?.includes('"run"') === true
          ? ("run" as const)
          : null,
      );

    return GameRun.of({ runStart, runStatus, runStop, toolRole });
  });
  return Layer.effect(GameRun, make);
};
