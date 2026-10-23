// @effect-diagnostics nodeBuiltinImport:off -- The loop test writes a real game tree, snapshots and candidate builds.
import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type GameReviewBallotAnswer,
  type GameReviewBallotPlan,
  type GameReviewBudget,
  type GameReviewCheck,
  type GameManifest,
  GameOperationError,
  type GameRepairLoop as GameRepairLoopRecord,
  type GameReviewRound,
  type ModelSelection,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as GameAdmission from "./GameAdmission.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameRepairLoop from "./GameRepairLoop.ts";
import * as GameRepairStudio from "./GameRepairStudio.ts";
import * as GameReviewApi from "./GameReviewApi.ts";
import * as GameReviewSessions from "./GameReviewSessions.ts";
import * as GameRoundStore from "./GameRoundStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { gameRecordLocation } from "./gameRecord.ts";
import { hashWebBuildDirectory } from "./webBuild.ts";

const threadId = ThreadId.make("thread:repair-game");
const builderRunId = RunId.make("run:builder");
const builderNodeId = "node:builder-root";
const builderSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("opencode"),
  model: "opencode-go/deepseek-v4.1-flash",
};
const BUILDER_STARTED = "2026-10-01T10:00:00.000Z";
const BUILDER_FINISHED = "2026-10-01T10:10:00.000Z";
const EXPORT_BUILD_ID = "a".repeat(64);

const manifest: GameManifest = {
  schemaVersion: 1,
  name: "Repair probe",
  brief: "Make a small platformer.",
  artDirection: "Warm paper colours.",
  engine: { name: "godot", version: "4.7.2" },
  godotProject: "godot",
  assets: [],
};

interface CheckRun {
  readonly checks: ReadonlyArray<GameReviewCheck>;
  readonly frames: ReadonlyArray<string>;
}

interface ChildCompletion {
  readonly status: string;
  readonly answer: GameReviewSessions.GameReviewSessionAnswerResult | null;
}

type AnswerFactory = (context: {
  readonly order: number;
  readonly round: GameReviewRound;
  readonly plan: GameReviewBallotPlan;
}) => GameReviewSessions.GameReviewSessionAnswerResult;

interface RepairInput {
  readonly root: string;
  readonly roundId: string;
  readonly rounds: GameRoundStore.GameRoundStore["Service"];
}

type RepairHook = (input: RepairInput) => Effect.Effect<void, GameOperationError>;

/** One review child the loop dispatched. The test completes it itself. */
interface StartedChild {
  readonly key: string;
  readonly role: GameReviewSessions.GameReviewTaskRole;
  readonly order: number;
  readonly roundId: string;
  readonly childThreadId: ThreadId;
  readonly runId: RunId;
  readonly completion: Deferred.Deferred<ChildCompletion>;
  readonly hung: boolean;
  completed: boolean;
}

interface Scripted {
  previewDirectories: string[];
  exportBuildId: string;
  exportRunId: string | null;
  /** The one running turn `projects.activeRun` reports; submit needs an owner. */
  activeRun: RunId | null;
  /** What the studio's factual check says for every build it is asked about. */
  facts: { readonly passed: boolean; readonly reason: string | null };
  incumbent: CheckRun;
  candidate: CheckRun;
  exportOutcome: {
    outcome: "passed" | "failed" | null;
    finishedAt: string | null;
    detail: string | null;
  };
  critic: AnswerFactory | null;
  ballots: ReadonlyArray<AnswerFactory>;
  promoteKind: "promoted" | "blocked";
  /** The builder's recorded route and viewport the loop freezes. */
  steps: Array<{ readonly key: string; readonly holdMs: number }>;
  viewport: { readonly width: number; readonly height: number } | null;
  /** Runs inside the promotion, after validation and before the commit. */
  beforeCommit: Effect.Effect<void> | null;
  /** Per repair attempt; the last entry repeats. */
  repairs: ReadonlyArray<RepairHook | null>;
  /** Complete this role as soon as it is dispatched, before the loop waits. */
  completeInStart: ReadonlySet<string>;
  /** This role never finishes its wait on its own. */
  hungRoles: ReadonlySet<string>;
  /** This role ignores interruptions entirely, so a supersession must fail closed. */
  ignoresInterruptRoles: ReadonlySet<string>;
  /** This role's dispatch commits, then its confirmation write fails. */
  failConfirmRoles: ReadonlySet<string>;
  /** While set, every child status read waits for it. */
  shellGate: { entered: Queue.Queue<void>; release: Deferred.Deferred<void> } | null;
  /** The thread's runs; a test may append a later text-only turn. */
  readonly runs: Array<{
    readonly id: RunId;
    readonly status: string;
    readonly rootNodeId: string | null;
    readonly modelSelection: ModelSelection;
    readonly requestedAt: DateTime.Utc;
    readonly startedAt: DateTime.Utc | null;
    readonly completedAt: DateTime.Utc | null;
  }>;
  readonly checks: Array<{ target: string; buildId: string; inputs: unknown }>;
  readonly starts: Array<StartedChild>;
  readonly interrupts: Array<{ threadId: ThreadId; runId: string | null; reason: string }>;
  readonly completed: Array<{ key: string; status: string }>;
}

const makeScripted = (): Scripted => ({
  previewDirectories: [],
  exportBuildId: EXPORT_BUILD_ID,
  exportRunId: String(builderRunId),
  activeRun: builderRunId,
  facts: { passed: true, reason: null },
  incumbent: {
    checks: [
      { id: "boot", status: "passed" },
      { id: "input", status: "passed" },
      { id: "state", status: "passed" },
      { id: "hud", status: "passed" },
    ],
    frames: [],
  },
  candidate: {
    checks: [
      { id: "boot", status: "passed" },
      { id: "input", status: "passed" },
      { id: "state", status: "passed" },
      { id: "hud", status: "passed" },
    ],
    frames: [],
  },
  exportOutcome: { outcome: "passed", finishedAt: null, detail: null },
  critic: null,
  ballots: [],
  promoteKind: "promoted",
  steps: [{ key: "ArrowRight", holdMs: 120 }],
  viewport: { width: 1152, height: 648 },
  beforeCommit: null,
  repairs: [],
  completeInStart: new Set(),
  hungRoles: new Set(),
  ignoresInterruptRoles: new Set(),
  failConfirmRoles: new Set(),
  shellGate: null,
  runs: [
    {
      id: builderRunId,
      status: "completed",
      rootNodeId: builderNodeId,
      modelSelection: builderSelection,
      requestedAt: DateTime.makeUnsafe(BUILDER_STARTED),
      startedAt: DateTime.makeUnsafe(BUILDER_STARTED),
      completedAt: DateTime.makeUnsafe(BUILDER_FINISHED),
    },
  ],
  checks: [],
  starts: [],
  interrupts: [],
  completed: [],
});

const criticAnswer = (defects: number): GameReviewSessions.GameReviewSessionAnswerResult => ({
  kind: "critic",
  raw: "{}",
  answer: {
    defects: Array.from({ length: defects }, (_, index) => ({
      severity: "visible" as const,
      what: `Fault ${String(index + 1)}`,
      frameId: "f1",
      fix: "Make it right; yes/no: it is right.",
    })),
    doNotRegress: [{ id: "turns", what: "Turning still works.", frameId: "f1" }],
  },
});

const sideFor = (plan: GameReviewBallotPlan, artifact: "incumbent" | "challenger") =>
  plan.main.A === artifact ? "A" : plan.main.B === artifact ? "B" : "tie";

/** One ballot that behaves as asked: promote says the challenger is better. */
const ballotAnswer = (
  plan: GameReviewBallotPlan,
  verdict: "promote" | "tie" | "worse",
  options: { readonly control?: "tie" | "A"; readonly preservation?: "preserved" | "unknown" } = {},
): GameReviewSessions.GameReviewSessionAnswerResult => {
  const choice =
    verdict === "tie"
      ? "tie"
      : (sideFor(plan, verdict === "promote" ? "challenger" : "incumbent") as "A" | "B");
  const control = options.control === "A" ? "A" : "tie";
  const side = options.preservation === "unknown" ? "unknown" : "preserved";
  const answer: GameReviewBallotAnswer = {
    main: { works: choice, look: choice, feel: choice, play: choice },
    preservation: [{ id: "turns", A: side, B: side, frameIds: ["a1"] }],
    control: { works: control, look: control, feel: control, play: control },
    reason: "a1 shows the change.",
  };
  return { kind: "ballot", answer, raw: JSON.stringify(answer) };
};

const makeCandidate = async (root: string, content: string) => {
  const staging = NodePath.join(root, "builds/candidates", `.staging-${NodeCrypto.randomUUID()}`);
  await NodeFSP.mkdir(staging, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(staging, "index.html"), content);
  const hashed = await hashWebBuildDirectory(staging);
  if (hashed === null) throw new Error("candidate did not hash");
  const final = NodePath.join(root, "builds/candidates", hashed.buildId);
  const existing = await NodeFSP.stat(NodePath.join(final, "index.html")).then(
    () => true,
    () => false,
  );
  if (existing) await NodeFSP.rm(staging, { recursive: true, force: true });
  else await NodeFSP.rename(staging, final);
  return { buildId: hashed.buildId, directory: `builds/candidates/${hashed.buildId}` };
};

/** The simulated repair child: write new source, record it, export a candidate. */
const repairWith =
  (options: { readonly source?: string; readonly build?: string } = {}): RepairHook =>
  (input) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(input.root, "godot/scripts/main.gd"),
          options.source ?? "extends Node2D # repair\n",
        ),
      );
      const recorded = yield* input.rounds.recordPostRepair(input.root, input.roundId);
      const candidate = yield* Effect.promise(() =>
        makeCandidate(input.root, options.build ?? `repaired-build-${input.roundId}`),
      );
      yield* input.rounds.recordCandidate(input.root, input.roundId, {
        buildId: candidate.buildId,
        directory: candidate.directory,
        sourceId: recorded.postRepairSourceId,
        engine: "godot",
        target: "Web",
        entry: "index.html",
      });
    });

interface Services {
  readonly loop: GameRepairLoop.GameRepairLoop["Service"];
  readonly rounds: GameRoundStore.GameRoundStore["Service"];
  readonly admission: GameAdmission.GameAdmission["Service"];
  readonly review: GameReviewApi.GameReviewApi["Service"];
}

interface Fixture {
  readonly root: string;
  readonly stateDir: string;
  readonly scripted: Scripted;
  /** Builds a fresh service stack (a restart) inside a fresh scope. */
  readonly withServices: <A, E>(
    use: (services: Services) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E>;
  /** Consumes every dispatched child and completes it in dispatch order. */
  readonly drive: (services: Services) => Effect.Effect<void>;
  /** Waits for the next dispatched child. */
  readonly take: Effect.Effect<StartedChild>;
  readonly complete: (
    services: Services,
    child: StartedChild,
  ) => Effect.Effect<void, GameOperationError>;
  /** A late child stops on its own, long after the loop let go of it. */
  readonly stopLate: (child: StartedChild) => Effect.Effect<void>;
}

interface FixtureOptions {
  readonly budget?: GameReviewBudget | undefined;
  readonly childJoinTimeoutMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

const withLoop = <A, E>(
  body: (fixture: Fixture) => Effect.Effect<A, E>,
  options: FixtureOptions = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-repair-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const root = NodePath.join(base, "game");
      const stateDir = NodePath.join(base, "state");
      const frameDirectory = NodePath.join(base, "frames");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(root, "godot/scripts"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(root, "game.json"),
          `${JSON.stringify({ name: "Repair probe", brief: "Make a platformer." })}\n`,
        );
        await NodeFSP.writeFile(
          NodePath.join(root, "BRIEF.md"),
          "# Repair probe\n\nMake a platformer.\n",
        );
        await NodeFSP.writeFile(NodePath.join(root, "godot/scripts/main.gd"), "extends Node\n");
        await NodeFSP.mkdir(frameDirectory, { recursive: true });
        for (const name of [
          "incumbent-boot",
          "incumbent-action",
          "candidate-boot",
          "candidate-action",
        ])
          await NodeFSP.writeFile(NodePath.join(frameDirectory, `${name}.png`), `${name}-bytes`);
      });
      const scripted = makeScripted();
      scripted.incumbent = {
        ...scripted.incumbent,
        frames: [
          NodePath.join(frameDirectory, "incumbent-boot.png"),
          NodePath.join(frameDirectory, "incumbent-action.png"),
        ],
      };
      scripted.candidate = {
        ...scripted.candidate,
        frames: [
          NodePath.join(frameDirectory, "candidate-boot.png"),
          NodePath.join(frameDirectory, "candidate-action.png"),
        ],
      };

      const startQueue = yield* Queue.unbounded<StartedChild>();
      const children = new Map<string, StartedChild>();

      const finish = (
        child: StartedChild,
        status: string,
        answer: GameReviewSessions.GameReviewSessionAnswerResult | null,
      ) =>
        Effect.gen(function* () {
          if (child.completed) return;
          child.completed = true;
          scripted.completed.push({ key: child.key, status });
          yield* Deferred.succeed(child.completion, { status, answer });
        });

      const settle = (
        services: Services,
        child: StartedChild,
      ): Effect.Effect<void, GameOperationError> =>
        Effect.gen(function* () {
          if (child.role === "repair") {
            const attempt = scripted.starts.filter((entry) => entry.role === "repair").length;
            const hook =
              scripted.repairs[Math.min(attempt - 1, scripted.repairs.length - 1)] ?? null;
            if (hook !== null)
              yield* hook({ root, roundId: child.roundId, rounds: services.rounds });
            yield* finish(child, "completed", null);
            return;
          }
          if (child.role === "critic") {
            const factory = scripted.critic;
            yield* finish(
              child,
              "completed",
              factory === null
                ? null
                : factory({ order: 0, round: null as never, plan: null as never }),
            );
            return;
          }
          const state = yield* services.rounds.read(root);
          const round = state.rounds.find((entry) => entry.id === child.roundId);
          const plan = round?.ballots?.find((entry) => entry.order === child.order);
          const factory = scripted.ballots[child.order];
          yield* finish(
            child,
            "completed",
            factory === undefined || plan === undefined || round === undefined
              ? null
              : factory({ order: child.order, round, plan }),
          );
        });

      const makeLayer = () => {
        const sessions = Layer.effect(
          GameReviewSessions.GameReviewSessions,
          Effect.gen(function* () {
            const start: GameReviewSessions.GameReviewSessions["Service"]["start"] = (input) =>
              Effect.gen(function* () {
                const order = input.order ?? 0;
                const key = `${input.roundId}:${input.role}:${order}`;
                const existing = children.get(key);
                if (existing !== undefined)
                  return {
                    kind: "started" as const,
                    commandId: `command:${key}`,
                    childThreadId: existing.childThreadId,
                    taskId: null,
                    runId: existing.runId,
                    evidenceHash: null,
                    reconciled: true,
                  };
                const completion = yield* Deferred.make<ChildCompletion>();
                const child: StartedChild = {
                  key,
                  role: input.role,
                  order,
                  roundId: input.roundId,
                  childThreadId: ThreadId.make(`thread:child:${key}`),
                  runId: RunId.make(`run:child:${key}`),
                  completion,
                  hung: scripted.hungRoles.has(`${input.role}:${order}`),
                  completed: false,
                };
                children.set(key, child);
                scripted.starts.push(child);
                yield* Queue.offer(startQueue, child);
                if (scripted.failConfirmRoles.has(`${input.role}:${order}`))
                  return yield* new GameOperationError({
                    operation: "write game review session",
                    path: root,
                    reason: "io",
                    detail: "The confirmation write failed after the dispatch committed.",
                  });
                if (scripted.completeInStart.has(`${input.role}:${order}`)) {
                  const factory = scripted.critic;
                  yield* finish(
                    child,
                    "completed",
                    input.role === "critic" && factory !== null
                      ? factory({ order, round: null as never, plan: null as never })
                      : null,
                  );
                }
                return {
                  kind: "started" as const,
                  commandId: `command:${key}`,
                  childThreadId: child.childThreadId,
                  taskId: null,
                  runId: child.runId,
                  evidenceHash: null,
                  reconciled: false,
                };
              });
            const answer: GameReviewSessions.GameReviewSessions["Service"]["answer"] = (input) =>
              Effect.gen(function* () {
                const order = input.order ?? 0;
                const child = children.get(`${input.roundId}:${input.role}:${order}`);
                if (child === undefined) return { kind: "pending" as const };
                const polled = yield* Deferred.poll(child.completion);
                if (Option.isNone(polled)) return { kind: "pending" as const };
                const finished = yield* polled.value;
                if (finished.answer === null)
                  return { kind: "invalid" as const, reason: "no answer", raw: null };
                return finished.answer;
              });
            const runStatus: GameReviewSessions.GameReviewSessions["Service"]["runStatus"] = (
              input,
            ) =>
              Effect.gen(function* () {
                const order = input.order ?? 0;
                const child = children.get(`${input.roundId}:${input.role}:${order}`);
                if (child === undefined) return { kind: "missing" as const };
                const polled = yield* Deferred.poll(child.completion);
                if (Option.isNone(polled)) return { kind: "pending" as const, runId: child.runId };
                const finished = yield* polled.value;
                return {
                  kind: "terminal" as const,
                  runId: child.runId,
                  status: finished.status as "completed",
                };
              });
            return GameReviewSessions.GameReviewSessions.of({
              describe: () => Effect.succeed(null),
              start,
              answer,
              runStatus,
              evidenceDirectory: () => Effect.succeed(null),
              evidenceHash: () => Effect.succeed(null),
              // Every started child was recorded before its dispatch.
              recordedChildren: () =>
                Effect.sync(() =>
                  [...children.values()].map((child) => ({
                    childThreadId: child.childThreadId,
                    runId: child.runId,
                  })),
                ),
            });
          }),
        );

        const studio = Layer.effect(
          GameRepairStudio.GameRepairStudio,
          Effect.gen(function* () {
            const rounds = yield* GameRoundStore.GameRoundStore;
            const check: GameRepairStudio.GameRepairStudio["Service"]["check"] = (input) => {
              scripted.checks.push({
                target: input.target,
                buildId: input.buildId,
                inputs: input.inputs,
              });
              const run = input.target === "incumbent" ? scripted.incumbent : scripted.candidate;
              return Effect.succeed({
                checks: run.checks,
                frames: run.frames.map((path, index) => ({
                  label: `frame ${String(index + 1)}`,
                  path,
                })),
                // What the run actually played at; a frozen viewport wins.
                viewport: input.inputs.viewport ?? { width: 1280, height: 720 },
              });
            };
            const promote: GameRepairStudio.GameRepairStudio["Service"]["promote"] = (
              _thread,
              roundId,
              guard,
            ) =>
              scripted.promoteKind === "blocked"
                ? Effect.succeed({ kind: "blocked" as const, detail: "selection changed" })
                : (scripted.beforeCommit ?? Effect.void)
                    .pipe(Effect.andThen(rounds.promote(root, roundId, { guard })))
                    .pipe(
                      Effect.map((promotion) =>
                        promotion.kind === "promoted"
                          ? ({ kind: "promoted" as const } as const)
                          : ({ kind: "blocked" as const, detail: promotion.detail } as const),
                      ),
                    );
            return GameRepairStudio.GameRepairStudio.of({
              exportProvenance: () =>
                Effect.succeed({
                  exportBuildId: scripted.exportBuildId,
                  exportRunId: scripted.exportRunId,
                }),
              submissionFacts: (_root, requested) =>
                Effect.gen(function* () {
                  const buildId = requested ?? scripted.exportBuildId;
                  if (buildId !== null) {
                    const frozen = yield* rounds.freeze(root);
                    yield* rounds.recordExport(root, {
                      buildId,
                      directory: `builds/candidates/${buildId}`,
                      sourceId: frozen.sourceId,
                      engine: "godot",
                      target: "Web",
                      entry: "index.html",
                    });
                  }
                  return {
                    buildId,
                    directory: `builds/candidates/${buildId}`,
                    checks: [],
                    passed: scripted.facts.passed,
                    reason: scripted.facts.reason,
                  };
                }),
              frozenInputs: () =>
                Effect.succeed({
                  steps: scripted.steps,
                  viewport: scripted.viewport,
                  seed: "unknown",
                }),
              check,
              exportState: () =>
                Effect.succeed({
                  outcome: scripted.exportOutcome.outcome,
                  finishedAt: scripted.exportOutcome.finishedAt,
                  buildId: null,
                  detail: scripted.exportOutcome.detail,
                }),
              promote,
            });
          }),
        );

        const projects = Layer.mock(GameProjectService.GameProjectService)({
          resolve: () => Effect.succeed(root),
          read: () => Effect.succeed(manifest),
          activeRun: () => Effect.succeed(scripted.activeRun),
        });

        const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (id: ThreadId) =>
            Effect.gen(function* () {
              if (id === threadId)
                return {
                  thread: {
                    id: threadId,
                    title: "Build it",
                    deletedAt: null,
                    modelSelection: builderSelection,
                    runtimeMode: "full-access",
                    interactionMode: "default",
                  },
                  runs: scripted.runs,
                } as never;
              const child = [...children.values()].find(
                (candidate) => candidate.childThreadId === id,
              );
              if (child === undefined) return { runs: [], providerTurns: [] } as never;
              const polled = yield* Deferred.poll(child.completion);
              const status = Option.isNone(polled) ? "running" : (yield* polled.value).status;
              return {
                runs: [{ id: child.runId, status }],
                providerTurns: [],
              } as never;
            }),
          getThreadShell: () =>
            Effect.gen(function* () {
              const gate = scripted.shellGate;
              if (gate !== null) {
                yield* Queue.offer(gate.entered, undefined);
                yield* Deferred.await(gate.release);
              }
              return {
                projectId: "project:repair",
                lineage: { relationshipToParent: "subagent", parentThreadId: null },
              } as never;
            }),
          interruptThread: (input) => {
            scripted.interrupts.push({
              threadId: input.threadId,
              runId: input.runId === undefined ? null : String(input.runId),
              reason: input.reason ?? "",
            });
            const child = [...children.values()].find(
              (candidate) => candidate.childThreadId === input.threadId,
            );
            if (child === undefined) return Effect.succeed({ type: "no_active_run" as const });
            if (scripted.ignoresInterruptRoles.has(child.key.split(":")[1]!))
              return Effect.succeed({ type: "no_active_run" as const });
            return Effect.gen(function* () {
              // A hung child still answers an interrupt; it just never finishes
              // on its own.
              yield* finish(child, "interrupted", null);
              return { type: "no_active_run" as const };
            });
          },
          waitForThread: (input) => {
            const child = [...children.values()].find(
              (candidate) => candidate.childThreadId === input.threadId,
            );
            if (child === undefined)
              return Effect.succeed({ threadId: input.threadId, run: null, timedOut: true });
            const wait = child.hung
              ? Effect.never
              : Deferred.await(child.completion).pipe(Effect.asVoid);
            return wait.pipe(
              Effect.as({ threadId: input.threadId, run: null, timedOut: false }) as never,
            );
          },
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>);

        const stack = GameRepairLoop.layer({
          stateDir,
          ...(options.budget === undefined ? {} : { budget: options.budget }),
          childJoinTimeoutMs: options.childJoinTimeoutMs ?? 40,
          now: options.now,
        }).pipe(
          Layer.provideMerge(
            Layer.mergeAll(studio, sessions).pipe(
              Layer.provideMerge(GameRoundStore.layer({ stateDir })),
            ),
          ),
          Layer.provideMerge(GameAdmission.layer({ stateDir })),
          Layer.provide(GameOperations.layer),
          Layer.provide(
            Layer.mock(GamePreview.GamePreview)({
              directories: () => scripted.previewDirectories,
              url: () => null,
              urlFor: () => null,
              serving: () => false,
            }),
          ),
          Layer.provideMerge(projects),
          Layer.provide(threads),
          Layer.provide(NodeServices.layer),
        );
        // The API reads the same loop and round services the stack built.
        return GameReviewApi.layer.pipe(Layer.provideMerge(stack));
      };

      const withServices: Fixture["withServices"] = (use) =>
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(makeLayer());
            return yield* use({
              loop: Context.get(context, GameRepairLoop.GameRepairLoop),
              rounds: Context.get(context, GameRoundStore.GameRoundStore),
              admission: Context.get(context, GameAdmission.GameAdmission),
              review: Context.get(context, GameReviewApi.GameReviewApi),
            });
          }),
        );

      const drive = (services: Services) =>
        Effect.gen(function* () {
          for (;;) {
            const child = yield* Queue.take(startQueue);
            yield* settle(services, child).pipe(Effect.orDie);
          }
        });

      return yield* body({
        root,
        stateDir,
        scripted,
        withServices,
        drive,
        take: Queue.take(startQueue),
        complete: settle,
        stopLate: (child) => finish(child, "completed", null),
      });
    }),
  );

const ensureLoop = (services: Services) =>
  services.loop.ensure({ threadId, runId: builderRunId, nodeId: builderNodeId as never });

const readLoop = (services: Services) => services.loop.read(threadId);

/** Runs the loop to its end while completing every child as it is dispatched. */
const runToCompletion = (services: Services, fixture: Fixture) =>
  Effect.gen(function* () {
    const driver = yield* fixture.drive(services).pipe(Effect.forkChild);
    yield* ensureLoop(services);
    yield* services.loop.awaitIdle(threadId);
    yield* Fiber.interrupt(driver);
  });

const loopRecord = (record: GameRepairLoopRecord | null) => {
  expect(record).not.toBeNull();
  return record!;
};

it.live("keeps a better build, then stops when the critic finds no defects", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        const { scripted } = fixture;
        scripted.repairs = [repairWith()];
        let reviews = 0;
        scripted.critic = () => criticAnswer(reviews++ === 0 ? 1 : 0);
        scripted.ballots = [
          ({ plan }) => ballotAnswer(plan, "promote"),
          ({ plan }) => ballotAnswer(plan, "promote"),
        ];
        yield* runToCompletion(services, fixture);
        const state = loopRecord(yield* readLoop(services));
        expect(state.status).toBe("stopped");
        expect(state.promotedRounds).toHaveLength(1);
        expect(state.repairsUsed).toBe(1);
        expect(state.reason).toContain("zero-defects");
        expect(state).not.toHaveProperty("phase");
        expect(state).not.toHaveProperty("wait");
        const game = yield* services.rounds.read(fixture.root);
        expect(game.selected?.roundId).toBe(state.promotedRounds[0]);
        expect(game.rounds.find((round) => round.id === state.promotedRounds[0])?.status).toBe(
          "promoted",
        );
        expect("resume" in services.loop).toBe(false);
      }),
    ),
  ),
);

it.live("rolls back a candidate that fails a frozen check and keeps reviewing", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        const { scripted, root } = fixture;
        scripted.repairs = [repairWith()];
        scripted.candidate = {
          ...scripted.candidate,
          checks: scripted.candidate.checks.map((check) =>
            check.id === "state" ? { id: "state", status: "failed" as const } : check,
          ),
        };
        let reviews = 0;
        scripted.critic = () => criticAnswer(reviews++ === 0 ? 1 : 0);
        scripted.ballots = [
          ({ plan }) => ballotAnswer(plan, "promote"),
          ({ plan }) => ballotAnswer(plan, "promote"),
        ];
        yield* runToCompletion(services, fixture);
        const state = loopRecord(yield* readLoop(services));
        expect(state.promotedRounds).toHaveLength(0);
        const game = yield* services.rounds.read(root);
        const vetoed = game.rounds.find((round) => round.reason?.includes("mechanical-veto"));
        expect(vetoed?.status).toBe("rejected");
        expect(vetoed?.reason).toContain("check-failed: state");
        expect(game.selected?.buildId).toBe(EXPORT_BUILD_ID);
      }),
    ),
  ),
);

it.live("a ballot that prefers a control build is discarded and the incumbent is kept", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        const { scripted, root } = fixture;
        scripted.repairs = [repairWith()];
        let reviews = 0;
        scripted.critic = () => criticAnswer(reviews++ === 0 ? 1 : 0);
        scripted.ballots = [
          ({ plan }) => ballotAnswer(plan, "promote", { control: "A" }),
          ({ plan }) => ballotAnswer(plan, "promote"),
        ];
        yield* runToCompletion(services, fixture);
        expect((yield* readLoop(services))?.promotedRounds).toHaveLength(0);
        const game = yield* services.rounds.read(root);
        expect(game.rounds.some((round) => round.reason?.includes("failed-control"))).toBe(true);
      }),
    ),
  ),
);

it.live("a tie keeps the incumbent", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        const { scripted, root } = fixture;
        scripted.repairs = [repairWith()];
        let reviews = 0;
        scripted.critic = () => criticAnswer(reviews++ === 0 ? 1 : 0);
        scripted.ballots = [
          ({ plan }) => ballotAnswer(plan, "tie"),
          ({ plan }) => ballotAnswer(plan, "tie"),
        ];
        yield* runToCompletion(services, fixture);
        expect((yield* readLoop(services))?.promotedRounds).toHaveLength(0);
        const game = yield* services.rounds.read(root);
        expect(game.rounds.some((round) => round.reason?.includes("tie: ballot"))).toBe(true);
      }),
    ),
  ),
);

it.live("a ballot that did not preserve a do-not-regress item rejects the round", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        const { scripted, root } = fixture;
        scripted.repairs = [repairWith()];
        let reviews = 0;
        scripted.critic = () => criticAnswer(reviews++ === 0 ? 1 : 0);
        scripted.ballots = [
          ({ plan }) => ballotAnswer(plan, "promote", { preservation: "unknown" }),
          ({ plan }) => ballotAnswer(plan, "promote"),
        ];
        yield* runToCompletion(services, fixture);
        expect((yield* readLoop(services))?.promotedRounds).toHaveLength(0);
        const game = yield* services.rounds.read(root);
        expect(game.rounds.some((round) => round.reason?.includes("preservation-lost"))).toBe(true);
      }),
    ),
  ),
);

it.live("zero defects stop the loop without a repair or a selection change", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        fixture.scripted.critic = () => criticAnswer(0);
        yield* runToCompletion(services, fixture);
        const state = loopRecord(yield* readLoop(services));
        expect(state.status).toBe("stopped");
        expect(state.repairsUsed).toBe(0);
        expect(state.reason).toContain("zero-defects");
        expect(fixture.scripted.starts.filter((child) => child.role === "repair")).toHaveLength(0);
      }),
    ),
  ),
);

it.live("a zero-defect stop offers no Restore because no repair touched the folder", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        fixture.scripted.critic = () => criticAnswer(0);
        yield* runToCompletion(services, fixture);
        const state = loopRecord(yield* readLoop(services));
        expect(state.reason).toContain("zero-defects");
        const game = yield* services.rounds.read(fixture.root);
        const stopped = game.rounds.find((round) => round.loopId === state.id);
        expect(stopped?.status).toBe("stopped");
        expect((yield* services.review.status(threadId)).restoreOffered).toBe(false);
        expect((yield* Effect.flip(services.review.restore(threadId))).reason).toBe(
          "invalid-input",
        );
      }),
    ),
  ),
);

it.live("an invalid critic answer offers no Restore because no repair touched the folder", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        fixture.scripted.critic = () => ({
          kind: "invalid" as const,
          reason: "The critic answered with a score.",
          raw: "{}",
        });
        yield* runToCompletion(services, fixture);
        const state = loopRecord(yield* readLoop(services));
        expect(state.reason).toContain("invalid-critic");
        const game = yield* services.rounds.read(fixture.root);
        const stopped = game.rounds.find((round) => round.loopId === state.id);
        expect(stopped?.status).toBe("stopped");
        expect((yield* services.review.status(threadId)).restoreOffered).toBe(false);
        expect((yield* Effect.flip(services.review.restore(threadId))).reason).toBe(
          "invalid-input",
        );
      }),
    ),
  ),
);

it.live("the third started repair is judged before the budget stops the loop", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        const { scripted, root } = fixture;
        scripted.repairs = [
          repairWith(),
          repairWith({ build: "second" }),
          repairWith({ build: "third" }),
        ];
        scripted.critic = () => criticAnswer(1);
        scripted.ballots = [
          ({ plan }) => ballotAnswer(plan, "tie"),
          ({ plan }) => ballotAnswer(plan, "tie"),
        ];
        yield* runToCompletion(services, fixture);
        const state = loopRecord(yield* readLoop(services));
        expect(scripted.starts.filter((child) => child.role === "repair")).toHaveLength(3);
        expect(state.repairsUsed).toBe(3);
        expect(state.reason).toContain("budget-exhausted");
        const game = yield* services.rounds.read(root);
        const judged = game.rounds.filter((round) => (round.candidateChecks ?? []).length > 0);
        expect(judged).toHaveLength(3);
        expect((judged.at(-1)?.ballotAnswers ?? []).length).toBe(2);
      }),
    ),
  ),
);

it.live("a child that finished before the loop waited is never lost", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        const { scripted } = fixture;
        // The critic completes inside `start`, before `waitForThread` runs.
        scripted.completeInStart = new Set(["critic:0"]);
        scripted.critic = () => criticAnswer(0);
        yield* runToCompletion(services, fixture);
        const state = loopRecord(yield* readLoop(services));
        expect(state.reason).toContain("zero-defects");
      }),
    ),
  ),
);

it.live("superseding while a repair runs joins it and promotes nothing", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        const { scripted, root } = fixture;
        let repairRan = false;
        scripted.repairs = [
          (input) =>
            repairWith()(input).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  repairRan = true;
                }),
              ),
            ),
        ];
        scripted.critic = () => criticAnswer(1);
        yield* ensureLoop(services);
        const critic = yield* fixture.take;
        expect(critic.role).toBe("critic");
        yield* fixture.complete(services, critic);
        const repair = yield* fixture.take;
        expect(repair.role).toBe("repair");
        yield* services.loop.interrupt(threadId, "A user action superseded the review.");
        // The child was stopped before the creator action returned.
        expect(repairRan).toBe(false);
        expect(scripted.completed.some((entry) => entry.status === "interrupted")).toBe(true);
        const state = loopRecord(yield* readLoop(services));
        expect(state.status).toBe("stopped");
        expect(state.promotedRounds).toHaveLength(0);
        const game = yield* services.rounds.read(root);
        expect(game.selected?.buildId).toBe(EXPORT_BUILD_ID);
        expect(game.rounds.every((round) => round.status === "stopped")).toBe(true);
      }),
    ),
  ),
);

it.live("a child that ignores interrupts fails the creator action closed", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        const { scripted } = fixture;
        scripted.ignoresInterruptRoles = new Set(["repair"]);
        scripted.repairs = [repairWith()];
        scripted.critic = () => criticAnswer(1);
        yield* ensureLoop(services);
        const critic = yield* fixture.take;
        yield* fixture.complete(services, critic);
        const repair = yield* fixture.take;
        expect(repair.role).toBe("repair");
        const failed = yield* Effect.flip(
          services.loop.interrupt(threadId, "A user action superseded the review."),
        );
        expect(failed.operation).toBe("supersede game review");
        const state = loopRecord(yield* readLoop(services));
        expect(state.status).toBe("interrupted");
        // Nothing was promoted over the action that could not be admitted.
        expect(state.promotedRounds).toHaveLength(0);
      }),
    ),
  ),
);

/** A later builder run that exported a fresh build and finished just now. */
const ensureLaterBuild = (fixture: Fixture, services: Services) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const runId = RunId.make(`run:builder-${String(now)}`);
    const build = "c".repeat(64);
    fixture.scripted.runs.push({
      id: runId,
      status: "completed",
      rootNodeId: "node:builder-later",
      modelSelection: builderSelection,
      requestedAt: DateTime.makeUnsafe(now),
      startedAt: DateTime.makeUnsafe(now),
      completedAt: DateTime.makeUnsafe(now + 2),
    });
    fixture.scripted.exportBuildId = build;
    fixture.scripted.exportRunId = String(runId);
    return yield* services.loop.ensure({
      threadId,
      runId,
      nodeId: "node:builder-later" as never,
    });
  });

const userAction = (services: Services, root: string) =>
  services.admission.admit({ root, threadId, reason: "The creator sent a new turn." });

it.live("a failed join keeps the game held until the child really stops", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        const { scripted, root } = fixture;
        scripted.ignoresInterruptRoles = new Set(["repair"]);
        scripted.repairs = [repairWith()];
        scripted.critic = () => criticAnswer(1);
        yield* ensureLoop(services);
        yield* fixture.complete(services, yield* fixture.take);
        const repair = yield* fixture.take;
        expect(repair.role).toBe("repair");
        expect((yield* Effect.flip(userAction(services, root))).operation).toBe(
          "supersede game review",
        );
        // The loop fiber is gone, but the writer is not: a retry is refused too.
        yield* services.loop.awaitIdle(threadId);
        expect((yield* Effect.flip(userAction(services, root))).operation).toBe(
          "supersede game review",
        );
        // No new review may start over the running child either.
        expect(yield* ensureLaterBuild(fixture, services)).toBeNull();
        // The late writer finishes on its own; only then is the game free.
        yield* fixture.stopLate(repair);
        yield* userAction(services, root);
        expect(loopRecord(yield* readLoop(services)).promotedRounds).toHaveLength(0);
      }),
    ),
  ),
);

it.live("a child whose dispatch confirmation failed still holds the game", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        const { scripted, root } = fixture;
        scripted.failConfirmRoles = new Set(["critic:0"]);
        scripted.ignoresInterruptRoles = new Set(["critic"]);
        yield* ensureLoop(services);
        const critic = yield* fixture.take;
        // The loop failed on the confirmation write and ended; the child runs.
        yield* services.loop.awaitIdle(threadId);
        expect(loopRecord(yield* readLoop(services)).status).toBe("interrupted");
        expect((yield* Effect.flip(userAction(services, root))).operation).toBe(
          "supersede game review",
        );
        yield* fixture.stopLate(critic);
        yield* userAction(services, root);
      }),
    ),
  ),
);

it.live("a restart re-arms the hold from the recorded children", () =>
  withLoop((fixture) =>
    Effect.gen(function* () {
      const { scripted, root } = fixture;
      scripted.ignoresInterruptRoles = new Set(["repair"]);
      scripted.repairs = [repairWith()];
      scripted.critic = () => criticAnswer(1);
      const repair = yield* fixture.withServices((services) =>
        Effect.gen(function* () {
          yield* ensureLoop(services);
          yield* fixture.complete(services, yield* fixture.take);
          return yield* fixture.take;
        }),
      );
      // The server died; the provider child did not.
      yield* fixture.withServices((services) =>
        Effect.gen(function* () {
          yield* services.loop.recover();
          expect((yield* Effect.flip(userAction(services, root))).operation).toBe(
            "supersede game review",
          );
          yield* fixture.stopLate(repair);
          yield* userAction(services, root);
        }),
      );
    }),
  ),
);

const promotingRound = (scripted: Scripted) => {
  scripted.repairs = [repairWith()];
  let reviews = 0;
  scripted.critic = () => criticAnswer(reviews++ === 0 ? 1 : 0);
  scripted.ballots = [
    ({ plan }) => ballotAnswer(plan, "promote"),
    ({ plan }) => ballotAnswer(plan, "promote"),
  ];
};

it.live("a generation bump that lands during the selection commit blocks the promotion", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        const { scripted, root, stateDir } = fixture;
        promotingRound(scripted);
        // An admission's bump landing after validation, while the slow commit
        // hashes and snapshots the candidate.
        scripted.beforeCommit = Effect.promise(async () => {
          const found = await gameRecordLocation(stateDir, "game-admission", root);
          await NodeFSP.mkdir(NodePath.dirname(found.file), { recursive: true });
          await NodeFSP.writeFile(
            found.file,
            `${JSON.stringify({ schemaVersion: 1, generation: 99, admittedAt: null })}\n`,
          );
        });
        yield* runToCompletion(services, fixture);
        const state = loopRecord(yield* readLoop(services));
        expect(state.promotedRounds).toHaveLength(0);
        expect(state.reason).toContain("superseded");
        expect((yield* services.rounds.read(root)).selected?.buildId).toBe(EXPORT_BUILD_ID);
      }),
    ),
  ),
);

let skewMs = 0;
it.live("a deadline that passes during the selection commit blocks the promotion", () =>
  withLoop(
    (fixture) =>
      fixture.withServices((services) =>
        Effect.gen(function* () {
          const { scripted, root } = fixture;
          promotingRound(scripted);
          skewMs = 0;
          // The whole-loop timeout cannot interrupt the uninterruptible commit;
          // the budget runs out while it hashes the candidate.
          scripted.beforeCommit = Effect.sync(() => {
            skewMs = 21 * 60_000;
          });
          yield* runToCompletion(services, fixture);
          const state = loopRecord(yield* readLoop(services));
          expect(state.promotedRounds).toHaveLength(0);
          expect(state.reason).toContain("deadline");
          expect((yield* services.rounds.read(root)).selected?.buildId).toBe(EXPORT_BUILD_ID);
        }),
      ),
    { now: () => DateTime.toEpochMillis(DateTime.nowUnsafe()) + skewMs },
  ),
);

it.live("a restart re-arms the hold before reading whether any child looks done", () =>
  withLoop((fixture) =>
    Effect.gen(function* () {
      const { scripted, root } = fixture;
      scripted.repairs = [repairWith()];
      scripted.critic = () => criticAnswer(1);
      yield* fixture.withServices((services) =>
        Effect.gen(function* () {
          yield* ensureLoop(services);
          yield* fixture.complete(services, yield* fixture.take);
          yield* fixture.take;
        }),
      );
      // The restart's child status reads stall; recovery must not depend on them.
      const gate = {
        entered: yield* Queue.unbounded<void>(),
        release: yield* Deferred.make<void>(),
      };
      scripted.shellGate = gate;
      yield* fixture.withServices((services) =>
        Effect.gen(function* () {
          yield* services.loop.recover();
          yield* Queue.take(gate.entered);
          const action = yield* Effect.forkChild(userAction(services, root));
          // The action reached the recovered hold and awaits its child's verdict.
          yield* Queue.take(gate.entered);
          expect(action.pollUnsafe()).toBeUndefined();
          yield* Deferred.succeed(gate.release, undefined);
          yield* Fiber.join(action);
        }),
      );
    }),
  ),
);

it.live("a supersede racing loop start never leaves a loop running", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        const { scripted } = fixture;
        scripted.critic = () => criticAnswer(0);
        // A creator action admitted before the loop starts: the completion that
        // would have started it is stale, and no second loop is created later.
        yield* services.admission.admit({
          root: fixture.root,
          threadId,
          reason: "The creator sent a new turn.",
        });
        const created = yield* ensureLoop(services);
        expect(created).toBeNull();
        expect((yield* readLoop(services))?.status).not.toBe("running");

        // And the concurrent order: whichever wins, nothing is left running.
        yield* Effect.all(
          [
            ensureLoop(services),
            services.admission.admit({
              root: fixture.root,
              threadId,
              reason: "The creator sent a new turn.",
            }),
          ],
          { concurrency: 2 },
        );
        yield* services.loop.awaitIdle(threadId);
        expect((yield* readLoop(services))?.status).not.toBe("running");
        expect(scripted.completed.filter((entry) => entry.status === "completed")).toHaveLength(0);
      }),
    ),
  ),
);

it.live("the whole-loop deadline interrupts a hung child and nothing promotes", () =>
  withLoop(
    (fixture) =>
      fixture.withServices((services) =>
        Effect.gen(function* () {
          const { scripted, root } = fixture;
          scripted.repairs = [repairWith()];
          scripted.critic = () => criticAnswer(1);
          scripted.hungRoles = new Set(["repair:0"]);
          yield* ensureLoop(services);
          const critic = yield* fixture.take;
          yield* fixture.complete(services, critic);
          const repair = yield* fixture.take;
          expect(repair.role).toBe("repair");
          // Never complete it: the loop's own deadline must end the round.
          yield* services.loop.awaitIdle(threadId);
          const state = loopRecord(yield* readLoop(services));
          expect(state.status).toBe("interrupted");
          expect(state.decision).toBe("interrupt");
          expect(state.reason).toContain("deadline");
          expect(scripted.interrupts.length).toBeGreaterThan(0);
          const game = yield* services.rounds.read(root);
          expect(game.selected?.buildId).toBe(EXPORT_BUILD_ID);
        }),
      ),
    { budget: { repairs: 3, elapsedMs: 150 } },
  ),
);

it.live("a restart marks the loop interrupted, keeps the incumbent and has no Resume", () =>
  withLoop((fixture) =>
    Effect.gen(function* () {
      const { scripted, root } = fixture;
      scripted.repairs = [repairWith()];
      scripted.critic = () => criticAnswer(1);
      yield* fixture.withServices((services) =>
        Effect.gen(function* () {
          yield* ensureLoop(services);
          const critic = yield* fixture.take;
          yield* fixture.complete(services, critic);
          const repair = yield* fixture.take;
          // The repair writes the folder, then the server dies before judging.
          yield* settleRepairAndStop(fixture, services, repair);
        }),
      );

      yield* fixture.withServices((services) =>
        Effect.gen(function* () {
          const interrupted = yield* services.loop.recover();
          expect(interrupted).toContain(root);
          const state = loopRecord(yield* readLoop(services));
          expect(state.status).toBe("interrupted");
          expect(state.decision).toBe("interrupt");
          expect(state.reason).toContain("restore the previous version");
          const game = yield* services.rounds.read(root);
          expect(game.selected?.buildId).toBe(EXPORT_BUILD_ID);
          expect(game.rounds.every((round) => round.status !== "running")).toBe(true);
          expect("resume" in services.loop).toBe(false);
          // A live evidence preview may still lazily request candidate files.
          const candidate = game.rounds.find((round) => round.loopId === state.id)?.candidate;
          expect(candidate).not.toBeNull();
          scripted.previewDirectories = [candidate!.directory];
          // The explicit restore finds the round this loop owned by its id.
          const restored = yield* services.loop.restore(threadId);
          expect(restored.kind).toBe("restored");
          expect(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(root, candidate!.directory, "index.html"), "utf8"),
            ),
          ).not.toBe("");
          if (restored.kind === "restored") expect(restored.round.loopId).toBe(state.id);
          // Nothing interrupted is left to restore from.
          const again = yield* Effect.flip(services.loop.restore(threadId));
          expect(again.reason).toBe("invalid-input");
        }),
      );
    }),
  ),
);

it.live("a user edit that blocks the rejection keeps the round restorable", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        const { scripted, root } = fixture;
        scripted.repairs = [repairWith()];
        scripted.critic = () => criticAnswer(1);
        // Both seats keep the incumbent: the round's decision is a rejection.
        scripted.ballots = [
          ({ plan }) => ballotAnswer(plan, "worse"),
          ({ plan }) => ballotAnswer(plan, "worse"),
        ];
        yield* ensureLoop(services);
        const critic = yield* fixture.take;
        yield* fixture.complete(services, critic);
        const repair = yield* fixture.take;
        yield* fixture.complete(services, repair);
        const first = yield* fixture.take;
        expect(first.role).toBe("ballot");
        yield* fixture.complete(services, first);
        const second = yield* fixture.take;
        // A user edit lands between the repair and the rejection.
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(root, "godot/scripts/main.gd"),
            "extends Node2D # user edit\n",
          ),
        );
        yield* fixture.complete(services, second);
        yield* services.loop.awaitIdle(threadId);
        const state = loopRecord(yield* readLoop(services));
        expect(state.status).toBe("stopped");
        expect(state.reason).toContain("reject-blocked");
        const game = yield* services.rounds.read(root);
        const blocked = game.rounds.find((round) => round.loopId === state.id);
        expect(blocked?.status).toBe("stopped");
        // The stop the edit caused still offers Restore, and it works.
        expect((yield* services.review.status(threadId)).restoreOffered).toBe(true);
        const restored = yield* services.review.restore(threadId);
        expect(restored.kind).toBe("restored");
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(root, "godot/scripts/main.gd"), "utf8"),
          ),
        ).toBe("extends Node\n");
        // The restored round is closed; nothing is left to restore from.
        expect((yield* Effect.flip(services.review.restore(threadId))).reason).toBe(
          "invalid-input",
        );
      }),
    ),
  ),
);

it.live("a restore blocked by a conflict keeps the round restorable and a retry succeeds", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        const { scripted, root } = fixture;
        scripted.repairs = [repairWith()];
        scripted.critic = () => criticAnswer(1);
        yield* ensureLoop(services);
        const critic = yield* fixture.take;
        yield* fixture.complete(services, critic);
        const repair = yield* fixture.take;
        expect(repair.role).toBe("repair");
        const opened = (yield* services.rounds.read(root)).rounds.at(-1);
        expect(opened?.status).toBe("running");
        // The explicit restore preserves the folder, a user edit lands before
        // the rewrite is read, and the restore refuses instead of overwriting.
        const blocked = yield* services.rounds.restore(root, opened!.id, {
          beforeRestore: () =>
            NodeFSP.writeFile(
              NodePath.join(root, "godot/scripts/main.gd"),
              "extends Node2D # user edit\n",
            ),
        });
        expect(blocked.kind).toBe("blocked");
        if (blocked.kind === "blocked") {
          expect(blocked.round.status).toBe("stopped");
          expect(blocked.detail).toContain("changed");
        }
        yield* services.admission.admit({ root, threadId, reason: "The creator acted." });
        // A blocked restore is not the end: the round keeps its preserved
        // snapshot and stays restorable, and a retry after the folder settled
        // returns to the incumbent.
        expect((yield* services.review.status(threadId)).restoreOffered).toBe(true);
        expect(yield* services.review.restore(threadId)).toMatchObject({ kind: "restored" });
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(root, "godot/scripts/main.gd"), "utf8"),
          ),
        ).toBe("extends Node\n");
        expect((yield* Effect.flip(services.review.restore(threadId))).reason).toBe(
          "invalid-input",
        );
      }),
    ),
  ),
);

it.live("stopping the review stops the open round and leaves it restorable", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        const { scripted, root } = fixture;
        scripted.repairs = [repairWith()];
        scripted.critic = () => criticAnswer(1);
        yield* ensureLoop(services);
        const critic = yield* fixture.take;
        yield* fixture.complete(services, critic);
        const repair = yield* fixture.take;
        expect(repair.role).toBe("repair");
        // The creator stops the review while the repair child runs.
        yield* services.loop.interrupt(
          threadId,
          "The creator stopped the review; the selected build stays playable.",
        );
        const state = loopRecord(yield* readLoop(services));
        expect(state.status).toBe("stopped");
        const cancelled = (yield* services.rounds.read(root)).rounds.find(
          (round) => round.loopId === state.id,
        );
        expect(cancelled?.status).toBe("stopped");
        // The cancellation still offers Restore, and it returns the folder to
        // the incumbent snapshot.
        expect((yield* services.review.status(threadId)).restoreOffered).toBe(true);
        expect(yield* services.review.restore(threadId)).toMatchObject({ kind: "restored" });
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(root, "godot/scripts/main.gd"), "utf8"),
          ),
        ).toBe("extends Node\n");
      }),
    ),
  ),
);

/** Runs half a repair (writes + candidate) and leaves the loop before it judges. */
const settleRepairAndStop = (fixture: Fixture, services: Services, repair: StartedChild) =>
  Effect.gen(function* () {
    const attempt = fixture.scripted.starts.filter((entry) => entry.role === "repair").length;
    const hook = fixture.scripted.repairs[attempt - 1] ?? null;
    if (hook !== null)
      yield* hook({ root: fixture.root, roundId: repair.roundId, rounds: services.rounds });
  });

it.live("a new builder run after a stopped loop starts a new review", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        const { scripted } = fixture;
        scripted.critic = () => criticAnswer(0);
        yield* ensureLoop(services);
        const first = loopRecord(yield* readLoop(services));
        yield* runToCompletion(services, fixture);
        expect((yield* readLoop(services))?.status).toBe("stopped");

        const nextRunId = RunId.make("run:builder-2");
        const nextBuild = "b".repeat(64);
        scripted.runs.push({
          id: nextRunId,
          status: "completed",
          rootNodeId: "node:builder-root-2",
          modelSelection: builderSelection,
          requestedAt: DateTime.makeUnsafe("2026-10-01T10:20:00.000Z"),
          startedAt: DateTime.makeUnsafe("2026-10-01T10:20:00.000Z"),
          completedAt: DateTime.makeUnsafe("2026-10-01T10:30:00.000Z"),
        });
        scripted.exportBuildId = nextBuild;
        scripted.exportRunId = String(nextRunId);
        const created = yield* services.loop.ensure({
          threadId,
          runId: nextRunId,
          nodeId: "node:builder-root-2" as never,
        });
        expect(created?.id).not.toBe(first.id);
        expect(created?.status).toBe("running");
        expect(created?.exportBuildId).toBe(nextBuild);
        yield* services.loop.interrupt(threadId, "Test cleanup.");
      }),
    ),
  ),
);

it.live("game_submit records a verified build and refuses with the exact failed fact", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        const submitted = yield* services.review.submit(threadId, {
          note: "  A tiny platformer about lanterns.  ",
        });
        expect(submitted.accepted).toBe(true);
        expect(submitted.buildId).toBe(EXPORT_BUILD_ID);
        expect(submitted.submission?.runId).toBe(builderRunId);
        expect(submitted.submission?.note).toBe("A tiny platformer about lanterns.");
        const state = yield* services.rounds.read(fixture.root);
        expect(state.submissions).toEqual([submitted.submission]);

        fixture.scripted.facts = { passed: false, reason: "console: 2 console error(s)" };
        const refused = yield* services.review.submit(threadId, { note: "Second try." });
        expect(refused.accepted).toBe(false);
        expect(refused.message).toContain("console: 2 console error(s)");
        expect(refused.submission).toBeNull();
        // A refusal records nothing: the earlier accepted declaration stands.
        expect((yield* services.rounds.read(fixture.root)).submissions).toEqual([
          submitted.submission,
        ]);
      }),
    ),
  ),
);

it.live("a submission decides the loop's build, not the export provenance", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        const submittedBuild = "b".repeat(64);
        yield* services.rounds.recordSubmission(fixture.root, {
          runId: builderRunId,
          buildId: submittedBuild,
          note: "A tiny platformer.",
          submittedAt: "2026-10-01T10:06:00.000Z",
        });
        const created = loopRecord(yield* ensureLoop(services));
        expect(created.exportBuildId).toBe(submittedBuild);
        expect(created.submissionNote).toBe("A tiny platformer.");
        const critic = yield* fixture.take;
        expect(critic.role).toBe("critic");
        expect(fixture.scripted.checks[0]?.buildId).toBe(submittedBuild);
        expect((yield* services.rounds.read(fixture.root)).selected?.buildId).toBe(submittedBuild);
        expect((yield* services.rounds.read(fixture.root)).rounds[0]?.incumbentBuildId).toBe(
          submittedBuild,
        );
        yield* services.loop.interrupt(threadId, "Test cleanup.");
      }),
    ),
  ),
);

it.live("a DESIGN.md edit after submitting changes nothing about the review's build", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        const submittedBuild = "c".repeat(64);
        yield* services.rounds.recordSubmission(fixture.root, {
          runId: builderRunId,
          buildId: submittedBuild,
          note: "A tiny platformer.",
          submittedAt: "2026-10-01T10:06:00.000Z",
        });
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(fixture.root, "DESIGN.md"),
            "# Rewritten after the submission\n",
          ),
        );
        const created = loopRecord(yield* ensureLoop(services));
        expect(created.exportBuildId).toBe(submittedBuild);
        yield* services.loop.interrupt(threadId, "Test cleanup.");
      }),
    ),
  ),
);

it.live("without a submission the latest export starts only when the same facts pass", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        fixture.scripted.facts = {
          passed: false,
          reason: "bytes: the build's files changed after export",
        };
        expect(yield* ensureLoop(services)).toBeNull();
        expect(yield* readLoop(services)).toBeNull();

        fixture.scripted.facts = { passed: true, reason: null };
        const created = loopRecord(yield* ensureLoop(services));
        expect(created.exportBuildId).toBe(EXPORT_BUILD_ID);
        expect(created.submissionNote).toBeUndefined();
        yield* services.loop.interrupt(threadId, "Test cleanup.");
      }),
    ),
  ),
);

it.live("a repair child's submit note is recorded on the round", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        const { scripted } = fixture;
        scripted.repairs = [
          (input) =>
            Effect.gen(function* () {
              // The child's own run owns the declaration while it runs.
              scripted.activeRun = RunId.make(`run:child:${input.roundId}:repair:0`);
              const submitted = yield* services.review.submit(threadId, {
                note: "Fixed the player's speed and kept the owls slow.",
              });
              expect(submitted.accepted).toBe(true);
              yield* repairWith()(input);
            }),
        ];
        let reviews = 0;
        scripted.critic = () => criticAnswer(reviews++ === 0 ? 1 : 0);
        scripted.ballots = [
          ({ plan }) => ballotAnswer(plan, "promote"),
          ({ plan }) => ballotAnswer(plan, "promote"),
        ];
        yield* runToCompletion(services, fixture);
        const state = yield* services.rounds.read(fixture.root);
        const noted = state.rounds.filter((round) => round.submissionNote !== undefined);
        expect(noted).toHaveLength(1);
        expect(noted[0]?.submissionNote).toBe("Fixed the player's speed and kept the owls slow.");
      }),
    ),
  ),
);

it.live("a later text-only turn never starts a loop", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        const { scripted } = fixture;
        const textRunId = RunId.make("run:text-only");
        scripted.runs.push({
          id: textRunId,
          status: "completed",
          rootNodeId: "node:text-only",
          modelSelection: builderSelection,
          requestedAt: DateTime.makeUnsafe("2026-10-01T10:20:00.000Z"),
          startedAt: DateTime.makeUnsafe("2026-10-01T10:20:00.000Z"),
          completedAt: DateTime.makeUnsafe("2026-10-01T10:21:00.000Z"),
        });
        // The later turn exported nothing, so it starts no review.
        expect(
          yield* services.loop.ensure({
            threadId,
            runId: textRunId,
            nodeId: "node:text-only" as never,
          }),
        ).toBeNull();
        // The original builder run is no longer the newest work either.
        expect(yield* ensureLoop(services)).toBeNull();
        expect(yield* readLoop(services)).toBeNull();
      }),
    ),
  ),
);

it.live("an export another thread made inside this run's window never starts a loop", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        // A second thread on the same game exported while this text-only run
        // was active; its timestamps fit this run, its exporter does not.
        fixture.scripted.exportRunId = "run:other-thread";
        expect(yield* ensureLoop(services)).toBeNull();
        expect(yield* readLoop(services)).toBeNull();
        // The run that did export it qualifies.
        fixture.scripted.exportRunId = String(builderRunId);
        expect((yield* ensureLoop(services))?.status).toBe("running");
        yield* services.loop.interrupt(threadId, "Test cleanup.");
      }),
    ),
  ),
);

it.live("an absent route skips the review with a durable reason and invents no input", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        fixture.scripted.steps = [];
        const skipped = loopRecord(yield* ensureLoop(services));
        expect(skipped.status).toBe("stopped");
        expect(skipped.reason).toContain("skipped");
        expect(loopRecord(yield* readLoop(services)).reason).toBe(skipped.reason);
        expect(fixture.scripted.checks).toHaveLength(0);
        expect(fixture.scripted.starts).toHaveLength(0);
        // The same origin is not reconsidered.
        expect((yield* ensureLoop(services))?.id).toBe(skipped.id);
      }),
    ),
  ),
);

it.live("legacy evidence without a viewport is recaptured once and frozen before review", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        const { scripted } = fixture;
        scripted.viewport = null;
        promotingRound(scripted);
        yield* runToCompletion(services, fixture);
        const state = loopRecord(yield* readLoop(services));
        expect(state.inputs.viewport).toEqual({ width: 1280, height: 720 });
        expect(state.inputs.seed).toBe("unknown");
        // Only the first incumbent run used the defaults; every later check
        // replayed the frozen viewport.
        expect(scripted.checks.length).toBeGreaterThan(2);
        expect(
          scripted.checks.slice(1).every((check) => {
            const inputs = check.inputs as { readonly viewport: unknown };
            return inputs.viewport !== null;
          }),
        ).toBe(true);
        // The seed is unknown and promotion still happened.
        expect(state.promotedRounds).toHaveLength(1);
      }),
    ),
  ),
);

it.live("a repair playtest cannot replace the frozen route", () =>
  withLoop((fixture) =>
    fixture.withServices((services) =>
      Effect.gen(function* () {
        const { scripted } = fixture;
        scripted.repairs = [repairWith()];
        let reviews = 0;
        scripted.critic = () => criticAnswer(reviews++ === 0 ? 1 : 0);
        scripted.ballots = [
          ({ plan }) => ballotAnswer(plan, "promote"),
          ({ plan }) => ballotAnswer(plan, "promote"),
        ];
        yield* runToCompletion(services, fixture);
        // Every check, including the challenger's, used the inputs captured at
        // start rather than anything the repair wrote.
        expect(scripted.checks.length).toBeGreaterThanOrEqual(2);
        for (const check of scripted.checks) {
          expect(check.inputs).toEqual({
            steps: [{ key: "ArrowRight", holdMs: 120 }],
            viewport: { width: 1152, height: 648 },
            seed: "unknown",
          });
        }
      }),
    ),
  ),
);
