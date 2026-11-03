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
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  GameOperationError,
  ProviderInstanceId,
  gameRunRoleLabel,
  type GameCreateInput,
  type GameProjectResult,
  type GameRunRestoreResult,
  type GameRunRoundDetail,
  type GameRunStartInput,
  type GameRunStatusResult,
  type GameRunSteerResult,
  type ModelSelection,
  type ProjectId,
  type RunId,
  ThreadId,
} from "@kurambit/contracts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameService from "./GameService.ts";
import { CREATOR_SESSION_SECTION } from "./scaffold.ts";
import * as Templates from "./templates.ts";
import { runBotFact } from "./run/botFacts.ts";
import { artAssetFacts, reviewerFacts } from "./run/facts.ts";
import { finishExports } from "./run/finish.ts";
import { makeGit, restoredPaths } from "./run/git.ts";
import * as Policy from "./run/policy.ts";
import { releaseWorktree, runRole, type RoleDeps } from "./run/roleRunner.ts";
import { readRoundEvidence, roundOutcome } from "./run/roundDetail.ts";
import { artFacts, modelBlock, spriteBlock } from "./run/roles.ts";
import { spriteFacts } from "./run/spriteFacts.ts";
import { modelFacts } from "./run/modelFacts.ts";
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
  ".studio/steer.jsonl",
  ".studio/run.log",
  ".studio/bot-results.jsonl",
  ".studio/player-report.md",
  ".studio/pick.txt",
  ".studio/next.md",
  ".studio/ship.md",
  ".studio/art-review.md",
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

// The pack's own AGENTS.md is the one index, so this line cannot drift from the pack.
const SKILLS_HEADING = "## Studio skills (read the ones your role needs)";
const SKILLS_LINE = `\n\n${SKILLS_HEADING}\n\nCraft advice lives in ./studio-skills, indexed in ./studio-skills/AGENTS.md.\n`;
const STALE_SKILLS =
  /\n*## Studio skills \(read the ones your role needs\)\n\nSkill pack in \.\/studio-skills, one line each:[^\n]*\n/;

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
  steer: NodePath.join(root, ".studio", "steer.jsonl"),
  log: NodePath.join(root, ".studio", "run.log"),
  next: NodePath.join(root, ".studio", "next.md"),
});

const logLine = (root: string, line: string): Effect.Effect<void> =>
  Effect.promise(() =>
    NodeFSP.mkdir(NodePath.join(root, ".studio"), { recursive: true }).then(() =>
      NodeFSP.appendFile(paths(root).log, `${new Date().toISOString()} ${line}\n`),
    ),
  ).pipe(Effect.ignore);

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

const currentStep = (state: State.RunState): string => {
  const t = state.task;
  const step = state.inFlight?.kind === "pair" ? state.inFlight.halves[0] : state.inFlight;
  if (step?.kind === "role") {
    const label = gameRunRoleLabel(step.role);
    return t._tag === "round" && !label.includes("round") ? `Round ${t.n} · ${label}` : label;
  }
  switch (t._tag) {
    case "init":
      return "Setting up";
    case "stage":
      return t.name === "build" ? "First full build" : gameRunRoleLabel(t.name);
    case "proto":
      return `Prototype ${t.i + 1}`;
    case "pick":
      return "Blind pick of the prototypes";
    case "round":
      return `Round ${t.n} · ${t.phase.replace("-", " ")}`;
    case "ship":
      return `Ship review after round ${t.n}`;
    case "leave":
      return "Wrapping up at the budget";
  }
};

// When a note takes effect: a round's direction is fixed once it starts.
const steerWhen = (state: State.RunState | null): string => {
  const t = state?.task;
  if (t?._tag === "round" && t.phase === "start" && state?.inFlight === null)
    return `Round ${t.n} starts with it.`;
  if (t?._tag === "round")
    return `Round ${t.n} is in progress and finishes as planned; round ${t.n + 1} starts with it.`;
  if (t?._tag === "ship")
    return "A ship review is in progress; the next round starts with it before the run can end.";
  if (t?._tag === "leave") return "The run is ending at its budget; a resumed run starts with it.";
  return "The run is still making its first build; its first round starts with it.";
};

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
  // Options belong to a provider: another provider's (Codex effort on an
  // OpenCode model) would make every turn fail, so they carry over only when
  // the provider stays.
  const base =
    state.provider === null || state.provider === current.instanceId ? current.options : [];
  const options =
    variant === null || variant.length === 0
      ? base
      : [
          ...(base ?? []).filter((entry) => entry.id !== "variant"),
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
  if (step.kind === "pair") return step.halves.map(describe).join(" | ");
  if (step.kind === "role")
    return `step ${step.id}: ${step.role}${step.thread === null ? "" : " (follow-up)"}${step.at === null ? "" : ` at ${step.at.slice(0, 12)}`}${step.attached === null ? "" : " (reattach)"}`;
  if (step.kind === "git") return `step ${step.id}: git ${step.op._tag}`;
  if (step.kind === "bot") return `step ${step.id}: bot ${step.file} at ${step.sha.slice(0, 12)}`;
  return `step ${step.id}: ${step.kind}`;
};
const summarize = (res: Policy.StepResult): string => {
  if (res.kind === "done") return `done${res.timedOut ? " (capped)" : ""} on ${res.threadId}`;
  if (res.kind === "git")
    return `git ok=${res.git.ok} ${res.git.branch} ${res.git.sha.slice(0, 8)} ${res.git.detail}`.trim();
  if (res.kind === "boot") return `boot ${res.ok ? "clean" : `failed: ${res.detail}`}`;
  if (res.kind === "ended" || res.kind === "failed") return `${res.kind}: ${res.reason}`;
  if (res.kind === "bot")
    return `bot ${res.fact.ending} after ${res.fact.seconds.toFixed(0)}s ${JSON.stringify(res.fact.final)} ${res.fact.note}`.trim();
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
    /** A new game is a production run: create the project, then run the brief. */
    readonly createGame: (
      input: GameCreateInput,
    ) => Effect.Effect<typeof GameProjectResult.Type, GameOperationError>;
    readonly runStatus: (threadId: ThreadId) => Effect.Effect<GameRunStatusResult, GameRunError>;
    readonly runStop: (
      threadId: ThreadId,
    ) => Effect.Effect<{ stopped: boolean; message: string }, GameRunError>;
    /** Queue a creator note for the live run's next round. Fails when no run is live. */
    readonly runSteer: (
      threadId: ThreadId,
      text: string,
    ) => Effect.Effect<GameRunSteerResult, GameRunError>;
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
    // Games whose tree a restore is moving; a run cannot start under one.
    const restoring = new Set<string>();
    // Serializes appends to a steer file with the driver taking it, so no note
    // lands between the driver's read and its removal.
    const steerLock = Semaphore.makeUnsafe(1);

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

    // Skill pack, bot kit and the run-state ignores, so the committed tree each
    // worktree role starts from has them. Only a new run refreshes the skills
    // and the kit: a resume after a server update would otherwise change them
    // mid-run, and the next build's commit would carry harness text as its
    // own work while earlier builds were made under different guidance.
    const ensureScaffold = (
      root: string,
      untrack: (p: ReadonlyArray<string>) => Effect.Effect<void>,
      fresh: boolean,
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
        const copy = async (from: string, to: string) => {
          const present = await NodeFSP.access(to).then(
            () => true,
            () => false,
          );
          if (fresh || !present)
            await NodeFSP.cp(from, to, { recursive: true }).catch(() => undefined);
        };
        await copy(NodePath.join(templates, "studio"), NodePath.join(root, "studio-skills"));
        await copy(
          NodePath.join(templates, "bot-kit"),
          NodePath.join(root, ".studio", "bot", "kit"),
        );
        const before = (await readText(NodePath.join(root, "AGENTS.md"))) ?? "";
        let agents = before.replace(STALE_SKILLS, "");
        if (!agents.includes(SKILLS_HEADING)) agents = `${agents}${SKILLS_LINE}`;
        if (!agents.includes("game_run_steer"))
          agents = `${agents.trimEnd()}\n\n${CREATOR_SESSION_SECTION}`;
        if (agents !== before) await NodeFSP.writeFile(NodePath.join(root, "AGENTS.md"), agents);
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
      const inputs = (): Policy.Inputs => ({
        now: Date.now(),
        coin: NodeCrypto.randomInt(2 ** 30) / 2 ** 30,
        id: NodeCrypto.randomUUID(),
      });

      // A pair's two halves write the in-flight step at once; each write reads
      // the state only after it holds this lock, so neither loses the other's.
      const inFlightLock = Semaphore.makeUnsafe(1);
      // The role records its thread and run before waiting, so a resumed
      // driver reattaches instead of launching a second thread.
      const attach = (stepId: number) => (threadId: ThreadId, runId: RunId) =>
        inFlightLock.withPermits(1)(
          Effect.gen(function* () {
            const step = state.inFlight;
            const halves = step === null ? [] : step.kind === "pair" ? step.halves : [step];
            const role = halves.find(
              (h): h is State.RoleStep => h.kind === "role" && h.id === stepId,
            );
            if (step === null || role === undefined) return;
            const attached = { ...role, attached: { threadId, runId } };
            const fresh = !state.threads.some((t) => t.threadId === threadId);
            if (fresh) yield* markRoleThread(threadId);
            yield* save({
              ...state,
              inFlight:
                step.kind === "pair"
                  ? { ...step, halves: step.halves.map((h) => (h.id === stepId ? attached : h)) }
                  : attached,
              threads: fresh
                ? [
                    ...state.threads,
                    { role: role.role, threadId, startedAt: new Date().toISOString() },
                  ]
                : state.threads,
            });
          }),
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
                  attach: attach(step.id),
                  log,
                },
                { ...step, prompt },
              );
            });
          case "git":
            // A git op always finishes: a stop waits for it rather than leaving a half-moved tree.
            return git.run(step.op).pipe(
              Effect.map((outcome) => ({ kind: "git", git: outcome }) as const),
              Effect.uninterruptible,
            );
          case "boot": {
            // A check that could not run is not a verdict on the build: a busy
            // game or a cancelled check is retried; memory short is waited out
            // (it clears on its own, often when the run's own processes end);
            // a missing tool, or memory still short after about 15 minutes,
            // ends the run (resumable) rather than rejecting good work.
            // Anything else the check reports is the build failing to boot.
            const check = (
              attempt: number,
              memoryWaits = 0,
            ): Effect.Effect<Policy.StepResult, GameOperationError> =>
              d.deps.game.check(d.creator).pipe(
                Effect.map(
                  (r) =>
                    ({
                      kind: "boot",
                      ok: r.ok,
                      detail: r.ok ? "boot clean" : "check failed",
                    }) as const,
                ),
                Effect.catchTags({
                  GameOperationError: (error) => {
                    const transient =
                      error.reason === "busy" || error.detail === "Operation cancelled.";
                    if (transient && attempt < 3)
                      return log(`boot check ${error.detail ?? error.reason}; retrying`).pipe(
                        Effect.andThen(Effect.sleep("5 seconds")),
                        Effect.andThen(check(attempt + 1, memoryWaits)),
                      );
                    if (error.reason === "low-memory" && memoryWaits < 7)
                      return log(
                        `boot check refused, memory short (${(error.detail ?? "").split("\n").at(-1)?.slice(0, 200) ?? ""}); waiting 2 minutes (${memoryWaits + 1} of 7)`,
                      ).pipe(
                        Effect.andThen(Effect.sleep("2 minutes")),
                        Effect.andThen(check(attempt, memoryWaits + 1)),
                      );
                    if (error.reason === "tool-missing" || error.reason === "low-memory")
                      return Effect.fail(error);
                    return Effect.succeed({
                      kind: "boot",
                      ok: false,
                      detail: (error.detail ?? error.reason).slice(0, 300),
                    } as const);
                  },
                }),
              );
            return check(1);
          }
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
          case "bot":
            return runBotFact(d.deps, { root, runId: state.runId, log }, step);
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
        yield* ensureScaffold(root, git.untrack, state.seq === 0);
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
          yield* takeSteer;
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
          step: null,
          ending: null,
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
      return {
        active: running,
        runId: state.runId,
        stage: state.stage,
        step,
        ending,
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
        })),
        steer: [...state.steer, ...queued],
        threads: state.threads,
        message:
          ending === null
            ? `Run ${state.runId}: ${step ?? state.stage}, ${state.rounds.length} round${state.rounds.length === 1 ? "" : "s"} done.${failure}`
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
      if (!active.has(root))
        return yield* new GameRunError({
          operation: "run-steer",
          path: root,
          reason: "no-live-run",
          detail: "No live run for this game. Work on the game directly, or start a run first.",
        });
      const queued = yield* steerLock.withPermits(1)(
        Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.dirname(paths(root).steer), { recursive: true });
          await NodeFSP.appendFile(paths(root).steer, `${JSON.stringify(note)}\n`);
          return parseSteer((await readText(paths(root).steer)) ?? "").length;
        }),
      );
      const loaded = yield* load(root);
      const state = loaded.kind === "v3" ? loaded.state : null;
      return {
        pending: (state?.steer.length ?? 0) + queued,
        message: `Noted for the production run. ${steerWhen(state)}`,
      } satisfies GameRunSteerResult;
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
      const manifest = yield* target.projects.read(target.root).pipe(Effect.option);
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
        const restored = yield* git.restoreBuild(sha, `restore round ${round} (creator)`);
        const game = yield* Effect.serviceOption(GameService.GameService);
        if (Option.isSome(game)) yield* game.value.closeLiveEditors(root);
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

    const toolRole = (caller: { readonly threadId: ThreadId }): Effect.Effect<"run" | null> =>
      Effect.promise(async () =>
        (await readText(callerFile(caller.threadId)))?.includes('"run"') === true
          ? ("run" as const)
          : null,
      );

    const createGame = Effect.fn("GameRun.createGame")(function* (input: GameCreateInput) {
      const projects = yield* Effect.serviceOption(GameProjectService.GameProjectService);
      if (Option.isNone(projects))
        return yield* new GameOperationError({
          operation: "create-game",
          path: input.name,
          reason: "io",
          detail: "Game projects are not in scope for this call.",
        });
      const created = yield* projects.value.create(input);
      // The game exists either way; a run that cannot start shows as not
      // started in the Run tab, where the creator can start it again.
      yield* runStart({
        threadId: created.threadId,
        brief: input.brief,
        ...(input.artDirection === undefined ? {} : { artDirection: input.artDirection }),
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
      const projects = yield* Effect.serviceOption(GameProjectService.GameProjectService);
      if (Option.isNone(projects)) return;
      const games = yield* projects.value.list().pipe(Effect.orElseSucceed(() => []));
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
      runSteer,
      roundDetail,
      restoreRound,
      resumeInterrupted,
      toolRole,
    });
  });
  return Layer.effect(GameRun, make);
};
