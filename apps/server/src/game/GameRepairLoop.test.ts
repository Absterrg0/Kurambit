// @effect-diagnostics nodeBuiltinImport:off -- The loop test writes a real game tree, snapshots and candidate builds.
import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type GameManifest,
  type GameOperationError,
  type GameReviewBallotAnswer,
  type GameReviewBallotPlan,
  type GameReviewRound,
  type ModelSelection,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameRepairLoop from "./GameRepairLoop.ts";
import * as GameRepairStudio from "./GameRepairStudio.ts";
import * as GameReviewSessions from "./GameReviewSessions.ts";
import * as GameRoundStore from "./GameRoundStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { hashWebBuildDirectory } from "./webBuild.ts";

const threadId = ThreadId.make("thread:repair-game");
const builderRunId = RunId.make("run:builder");
const builderNodeId = "node:builder-root";
const builderSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("opencode"),
  model: "opencode-go/deepseek-v4.1-flash",
};

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
  readonly checks: ReadonlyArray<{
    readonly id: string;
    readonly status: "passed" | "failed" | "unmeasured";
  }>;
  readonly frames: ReadonlyArray<string>;
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

interface FakeSession {
  readonly commandId: string;
  readonly childThreadId: ThreadId;
  readonly runId: RunId;
}

interface Scripted {
  playable: boolean;
  incumbent: CheckRun;
  candidate: CheckRun;
  exportOutcome: {
    outcome: "passed" | "failed" | null;
    finishedAt: string | null;
    detail: string | null;
  };
  critic: AnswerFactory | null;
  ballots: ReadonlyArray<AnswerFactory>;
  /** The child for this key stays pending from its Nth start onwards. */
  pendingAfter: Record<string, number>;
  promoteKind: "promoted" | "blocked";
  /** Per repair attempt; the last entry repeats. */
  repairs: ReadonlyArray<RepairHook | null>;
  /** Survives a restart, exactly as the on-disk session records do. */
  readonly sessions: Map<string, FakeSession>;
  readonly starts: Array<{ key: string; input: GameReviewSessions.GameReviewSessionStartInput }>;
  readonly interrupts: Array<{ threadId: ThreadId; runId: string | null; reason: string }>;
  readonly joins: Array<{ threadId: ThreadId; runId: string | null }>;
}

const makeScripted = (): Scripted => ({
  playable: true,
  incumbent: {
    checks: [
      { id: "boot", status: "passed" },
      { id: "input", status: "passed" },
      { id: "state", status: "passed" },
    ],
    frames: [],
  },
  candidate: {
    checks: [
      { id: "boot", status: "passed" },
      { id: "input", status: "passed" },
      { id: "state", status: "passed" },
    ],
    frames: [],
  },
  exportOutcome: { outcome: "passed", finishedAt: null, detail: null },
  critic: null,
  ballots: [],
  pendingAfter: {},
  promoteKind: "promoted",
  repairs: [],
  sessions: new Map(),
  starts: [],
  interrupts: [],
  joins: [],
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

/**
 * One ballot that behaves as asked: promote says the challenger is better on
 * every facet, tie says nothing improved, worse picks the incumbent.
 */
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
        makeCandidate(input.root, options.build ?? "repaired-build"),
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

/** A repair that died before writing: the folder still matches the incumbent. */
const repairWithoutWriting: RepairHook = () => Effect.void;

interface HarnessInput {
  readonly body: (input: {
    readonly root: string;
    readonly stateDir: string;
    readonly scripted: Scripted;
    readonly loop: GameRepairLoop.GameRepairLoop["Service"];
    readonly rounds: GameRoundStore.GameRoundStore["Service"];
    readonly restart: () => Effect.Effect<{
      readonly loop: GameRepairLoop.GameRepairLoop["Service"];
      readonly rounds: GameRoundStore.GameRoundStore["Service"];
    }>;
  }) => Effect.Effect<void, GameOperationError>;
}

const withLoop = (body: HarnessInput["body"]) =>
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

      const makeLayer = () => {
        const sessions = Layer.effect(
          GameReviewSessions.GameReviewSessions,
          Effect.gen(function* () {
            const rounds = yield* GameRoundStore.GameRoundStore;
            const start: GameReviewSessions.GameReviewSessions["Service"]["start"] = (input) => {
              const order = input.order ?? 0;
              const roleKey = `${input.role}:${order}`;
              const key = `${input.roundId}:${roleKey}`;
              const existing = scripted.sessions.get(key);
              if (existing !== undefined)
                return Effect.succeed({
                  kind: "started" as const,
                  commandId: existing.commandId,
                  childThreadId: existing.childThreadId,
                  taskId: null,
                  runId: existing.runId,
                  evidenceHash: null,
                  reconciled: true,
                });
              const entry: FakeSession = {
                commandId: `command:${input.roundId}:${roleKey}`,
                childThreadId: ThreadId.make(`thread:child:${input.roundId}:${roleKey}`),
                runId: RunId.make(`run:child:${input.roundId}:${roleKey}`),
              };
              scripted.sessions.set(key, entry);
              scripted.starts.push({ key: roleKey, input });
              if (input.role === "repair") {
                const attempt = scripted.starts.filter((start) => start.key === roleKey).length;
                const hook =
                  scripted.repairs[Math.min(attempt - 1, scripted.repairs.length - 1)] ?? null;
                if (hook !== null)
                  return hook({ root, roundId: input.roundId, rounds }).pipe(
                    Effect.as({
                      kind: "started" as const,
                      commandId: entry.commandId,
                      childThreadId: entry.childThreadId,
                      taskId: null,
                      runId: entry.runId,
                      evidenceHash: null,
                      reconciled: false,
                    }),
                  );
              }
              return Effect.succeed({
                kind: "started" as const,
                commandId: entry.commandId,
                childThreadId: entry.childThreadId,
                taskId: null,
                runId: entry.runId,
                evidenceHash: null,
                reconciled: false,
              });
            };
            const answer: GameReviewSessions.GameReviewSessions["Service"]["answer"] = (input) =>
              Effect.gen(function* () {
                const order = input.order ?? 0;
                if (input.role === "critic") {
                  const factory = scripted.critic;
                  return factory === null
                    ? ({ kind: "pending" as const } as const)
                    : factory({
                        order,
                        round: null as unknown as GameReviewRound,
                        plan: null as unknown as GameReviewBallotPlan,
                      });
                }
                const state = yield* rounds.read(root);
                const round = state.rounds.find((entry) => entry.id === input.roundId);
                const plan = round?.ballots?.find((entry) => entry.order === order);
                if (round === undefined || plan === undefined)
                  return { kind: "invalid" as const, reason: "no ballot plan", raw: null };
                const factory = scripted.ballots[order];
                return factory === undefined
                  ? ({ kind: "pending" as const } as const)
                  : factory({ order, round, plan });
              });
            const runStatus: GameReviewSessions.GameReviewSessions["Service"]["runStatus"] = (
              input,
            ) => {
              const roleKey = `${input.role}:${input.order ?? 0}`;
              const entry = scripted.sessions.get(`${input.roundId}:${roleKey}`);
              if (entry === undefined) return Effect.succeed({ kind: "missing" as const });
              const attempt = scripted.starts.filter((start) => start.key === roleKey).length;
              const pendingAfter = scripted.pendingAfter[roleKey];
              return Effect.succeed(
                pendingAfter !== undefined && attempt >= pendingAfter
                  ? ({ kind: "pending" as const, runId: entry.runId } as const)
                  : ({
                      kind: "terminal" as const,
                      runId: entry.runId,
                      status: "completed" as const,
                    } as const),
              );
            };
            return GameReviewSessions.GameReviewSessions.of({
              start,
              answer,
              runStatus,
              evidenceDirectory: () => Effect.succeed(null),
              evidenceHash: () => Effect.succeed(null),
            });
          }),
        );

        const studio = Layer.effect(
          GameRepairStudio.GameRepairStudio,
          Effect.gen(function* () {
            const rounds = yield* GameRoundStore.GameRoundStore;
            const check: GameRepairStudio.GameRepairStudio["Service"]["check"] = (input) => {
              const run = input.target === "incumbent" ? scripted.incumbent : scripted.candidate;
              return Effect.succeed({
                checks: run.checks,
                frames: run.frames.map((path, index) => ({
                  label: `frame ${String(index + 1)}`,
                  path,
                })),
                steps: [],
              });
            };
            const promote: GameRepairStudio.GameRepairStudio["Service"]["promote"] = (
              _thread,
              roundId,
            ) =>
              scripted.promoteKind === "blocked"
                ? Effect.succeed({ kind: "blocked" as const, detail: "selection changed" })
                : rounds
                    .promote(root, roundId)
                    .pipe(
                      Effect.map((promotion) =>
                        promotion.kind === "promoted"
                          ? ({ kind: "promoted" as const } as const)
                          : ({ kind: "blocked" as const, detail: promotion.detail } as const),
                      ),
                    );
            return GameRepairStudio.GameRepairStudio.of({
              playable: () => Effect.succeed(scripted.playable),
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
        });

        const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: {
                id: threadId,
                title: "Build it",
                deletedAt: null,
                modelSelection: builderSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
              },
              runs: [
                {
                  id: builderRunId,
                  status: "completed",
                  rootNodeId: builderNodeId,
                  modelSelection: builderSelection,
                },
              ],
            }) as never,
          getThreadShell: () =>
            Effect.succeed({
              projectId: "project:repair",
              lineage: { relationshipToParent: "subagent", parentThreadId: null },
            }) as never,
          interruptThread: (input) => {
            scripted.interrupts.push({
              threadId: input.threadId,
              runId: input.runId === undefined ? null : String(input.runId),
              reason: input.reason ?? "",
            });
            return Effect.succeed({ type: "no_active_run" as const });
          },
          waitForThread: (input) => {
            scripted.joins.push({
              threadId: input.threadId,
              runId: input.runId === undefined ? null : String(input.runId),
            });
            return Effect.succeed({ threadId: input.threadId, run: null, timedOut: false });
          },
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>);

        return GameRepairLoop.layer({ stateDir }).pipe(
          Layer.provideMerge(
            Layer.mergeAll(studio, sessions).pipe(
              Layer.provideMerge(GameRoundStore.layer({ stateDir })),
            ),
          ),
          Layer.provide(projects),
          Layer.provide(threads),
          Layer.provide(NodeServices.layer),
        );
      };

      const build = () =>
        Effect.gen(function* () {
          const loop = yield* GameRepairLoop.GameRepairLoop;
          const rounds = yield* GameRoundStore.GameRoundStore;
          return { loop, rounds };
        }).pipe(Effect.provide(makeLayer()));

      const first = yield* build();
      return yield* body({
        root,
        stateDir,
        scripted,
        loop: first.loop,
        rounds: first.rounds,
        restart: build,
      });
    }),
  );

const ensureLoop = (loop: GameRepairLoop.GameRepairLoop["Service"]) =>
  loop.ensure({ threadId, runId: builderRunId, nodeId: builderNodeId as never });

const readLoop = (loop: GameRepairLoop.GameRepairLoop["Service"]) => loop.read(threadId);

const repairStarts = (scripted: Scripted) =>
  scripted.starts.filter((start) => start.key === "repair:0");

it.live("keeps a better build, then stops when the critic finds no defects", () =>
  withLoop(({ scripted, loop, rounds, root }) =>
    Effect.gen(function* () {
      scripted.repairs = [repairWith()];
      let reviews = 0;
      scripted.critic = () => criticAnswer(reviews++ === 0 ? 1 : 0);
      scripted.ballots = [
        ({ plan }) => ballotAnswer(plan, "promote"),
        ({ plan }) => ballotAnswer(plan, "promote"),
      ];
      yield* ensureLoop(loop);
      const state = yield* readLoop(loop);
      expect(state?.status).toBe("stopped");
      expect(state?.promotedRounds).toHaveLength(1);
      expect(state?.repairsUsed).toBe(1);
      expect(state?.reason).toContain("zero-defects");
      const game = yield* rounds.read(root);
      expect(game.selected?.roundId).toBe(state?.promotedRounds[0]);
      // The winning round is promoted and the clean review round stopped.
      expect(game.rounds.find((round) => round.id === state?.promotedRounds[0])?.status).toBe(
        "promoted",
      );
      expect(repairStarts(scripted)).toHaveLength(1);
    }),
  ),
);

it.live("rolls a mechanically vetoed repair back and keeps the incumbent", () =>
  withLoop(({ scripted, loop, rounds, root }) =>
    Effect.gen(function* () {
      scripted.repairs = [
        repairWith({ source: "extends Node2D # broken\n" }),
        repairWithoutWriting,
      ];
      scripted.pendingAfter = { "repair:0": 2 };
      scripted.critic = () => criticAnswer(1);
      scripted.candidate = {
        ...scripted.candidate,
        checks: [
          { id: "boot", status: "passed" },
          { id: "input", status: "failed" },
          { id: "state", status: "passed" },
        ],
      };
      const before = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(root, "godot/scripts/main.gd"), "utf8"),
      );
      yield* ensureLoop(loop);
      const state = yield* readLoop(loop);
      expect(state?.status).toBe("running");
      expect(state?.wait?.role).toBe("repair");
      expect(state?.lastRejection).toContain("mechanical-veto");
      const after = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(root, "godot/scripts/main.gd"), "utf8"),
      );
      expect(after).toBe(before);
      const game = yield* rounds.read(root);
      const rejected = game.rounds.find((round) => round.status === "rejected");
      expect(rejected?.mechanicalVeto).toContain("check-failed");
      expect(repairStarts(scripted)).toHaveLength(2);
    }),
  ),
);

it.live("a rejection reason reaches the next repair with the remaining budget", () =>
  withLoop(({ scripted, loop }) =>
    Effect.gen(function* () {
      scripted.repairs = [repairWith({ source: "extends Node2D # broken\n" })];
      scripted.critic = () => criticAnswer(1);
      scripted.candidate = {
        ...scripted.candidate,
        checks: [{ id: "boot", status: "failed" }],
      };
      yield* ensureLoop(loop);
      const state = yield* readLoop(loop);
      expect(state?.repairsUsed).toBe(3);
      expect(state?.status).toBe("stopped");
      expect(state?.reason).toContain("budget-exhausted");
      const third = repairStarts(scripted)[2]!.input;
      expect(third.repair?.previousRejection).toContain("mechanical-veto");
      expect(third.repair?.remainingBudget).toContain("1 repair");
      expect(state?.lastRejection).toContain("mechanical-veto");
    }),
  ),
);

it.live("a tie keeps the incumbent and spends the budget repairing", () =>
  withLoop(({ scripted, loop }) =>
    Effect.gen(function* () {
      scripted.repairs = [repairWith()];
      scripted.critic = () => criticAnswer(1);
      scripted.ballots = [
        ({ plan }) => ballotAnswer(plan, "tie"),
        ({ plan }) => ballotAnswer(plan, "tie"),
      ];
      yield* ensureLoop(loop);
      const state = yield* readLoop(loop);
      expect(state?.status).toBe("stopped");
      expect(state?.reason).toContain("budget-exhausted");
      expect(state?.promotedRounds).toHaveLength(0);
      expect(state?.lastRejection).toContain("tie:");
    }),
  ),
);

it.live("position-biased reverse ballots disagree and the incumbent stays", () =>
  withLoop(({ scripted, loop }) =>
    Effect.gen(function* () {
      scripted.repairs = [repairWith()];
      scripted.critic = () => criticAnswer(1);
      scripted.ballots = [
        ({ plan }) => ballotAnswer(plan, "promote"),
        ({ plan }) => ballotAnswer(plan, "worse"),
      ];
      yield* ensureLoop(loop);
      const state = yield* readLoop(loop);
      expect(state?.promotedRounds).toHaveLength(0);
      expect(state?.lastRejection).toContain("worse-build");
    }),
  ),
);

it.live("a failed identical-build control keeps the incumbent", () =>
  withLoop(({ scripted, loop }) =>
    Effect.gen(function* () {
      scripted.repairs = [repairWith()];
      scripted.critic = () => criticAnswer(1);
      scripted.ballots = [
        ({ plan }) => ballotAnswer(plan, "promote", { control: "A" }),
        ({ plan }) => ballotAnswer(plan, "promote"),
      ];
      yield* ensureLoop(loop);
      const state = yield* readLoop(loop);
      expect(state?.promotedRounds).toHaveLength(0);
      expect(state?.lastRejection).toContain("failed-control");
    }),
  ),
);

it.live("an unknown preservation item vetoes a promotion", () =>
  withLoop(({ scripted, loop }) =>
    Effect.gen(function* () {
      scripted.repairs = [repairWith()];
      scripted.critic = () => criticAnswer(1);
      scripted.ballots = [
        ({ plan }) => ballotAnswer(plan, "promote", { preservation: "unknown" }),
        ({ plan }) => ballotAnswer(plan, "promote"),
      ];
      yield* ensureLoop(loop);
      const state = yield* readLoop(loop);
      expect(state?.promotedRounds).toHaveLength(0);
      expect(state?.lastRejection).toContain("preservation-lost");
    }),
  ),
);

it.live("an invalid ballot keeps the incumbent and records why", () =>
  withLoop(({ scripted, loop, rounds, root }) =>
    Effect.gen(function* () {
      scripted.repairs = [repairWith()];
      scripted.critic = () => criticAnswer(1);
      scripted.ballots = [
        () => ({ kind: "invalid", reason: "the ballot cited a missing frame", raw: "{}" }),
        ({ plan }) => ballotAnswer(plan, "promote"),
      ];
      yield* ensureLoop(loop);
      const state = yield* readLoop(loop);
      expect(state?.promotedRounds).toHaveLength(0);
      expect(state?.lastRejection).toContain("invalid-ballot");
      const game = yield* rounds.read(root);
      expect(game.selected).toBeNull();
    }),
  ),
);

it.live("zero defects stops before any repair child", () =>
  withLoop(({ scripted, loop, rounds, root }) =>
    Effect.gen(function* () {
      scripted.critic = () => criticAnswer(0);
      yield* ensureLoop(loop);
      const state = yield* readLoop(loop);
      expect(state?.status).toBe("stopped");
      expect(state?.reason).toContain("zero-defects");
      expect(state?.repairsUsed).toBe(0);
      expect(repairStarts(scripted)).toHaveLength(0);
      const game = yield* rounds.read(root);
      expect(game.rounds[0]?.status).toBe("stopped");
      expect(game.rounds[0]?.decision).toBe("stop");
    }),
  ),
);

it.live("the budget stops after three attempted repairs", () =>
  withLoop(({ scripted, loop, rounds, root }) =>
    Effect.gen(function* () {
      scripted.repairs = [repairWith()];
      scripted.critic = () => criticAnswer(1);
      scripted.ballots = [
        ({ plan }) => ballotAnswer(plan, "tie"),
        ({ plan }) => ballotAnswer(plan, "tie"),
      ];
      yield* ensureLoop(loop);
      const state = yield* readLoop(loop);
      expect(state?.repairsUsed).toBe(3);
      expect(repairStarts(scripted)).toHaveLength(3);
      const game = yield* rounds.read(root);
      expect(game.rounds.filter((round) => round.status === "rejected")).toHaveLength(3);
    }),
  ),
);

it.live("a repair that exports the incumbent's own bytes is rejected unchanged", () =>
  withLoop(({ scripted, loop }) =>
    Effect.gen(function* () {
      scripted.repairs = [repairWith()];
      scripted.critic = () => criticAnswer(1);
      scripted.ballots = [
        ({ plan }) => ballotAnswer(plan, "promote"),
        ({ plan }) => ballotAnswer(plan, "promote"),
      ];
      yield* ensureLoop(loop);
      const state = yield* readLoop(loop);
      expect(state?.promotedRounds).toHaveLength(1);
      expect(state?.lastRejection).toContain("unchanged");
      expect(state?.status).toBe("stopped");
    }),
  ),
);

it.live("a user action cancels and joins a running repair before it proceeds", () =>
  withLoop(({ scripted, loop, rounds, root }) =>
    Effect.gen(function* () {
      scripted.repairs = [repairWith()];
      scripted.critic = () => criticAnswer(1);
      scripted.pendingAfter = { "repair:0": 1 };
      yield* ensureLoop(loop);
      const parked = yield* readLoop(loop);
      expect(parked?.status).toBe("running");
      expect(parked?.wait?.role).toBe("repair");

      yield* loop.supersede(threadId, "The creator's new turn superseded the review.");
      expect(scripted.interrupts).toHaveLength(1);
      expect(scripted.interrupts[0]?.runId).toBe(String(parked?.wait?.runId));
      expect(scripted.joins).toHaveLength(1);
      const state = yield* readLoop(loop);
      expect(state?.status).toBe("stopped");
      expect(state?.decision).toBe("stop");
      const game = yield* rounds.read(root);
      expect(game.rounds[0]?.status).toBe("stopped");
      expect(game.selected).toBeNull();

      // The child finishing after supersession cannot promote.
      scripted.pendingAfter = {};
      yield* loop.kick(threadId);
      expect((yield* readLoop(loop))?.status).toBe("stopped");
      expect((yield* rounds.read(root)).selected).toBeNull();
    }),
  ),
);

it.live("a restart mid-ballot reconciles and resumes without a second dispatch", () =>
  withLoop(({ scripted, loop, restart }) =>
    Effect.gen(function* () {
      scripted.repairs = [repairWith()];
      scripted.critic = () => criticAnswer(1);
      scripted.ballots = [
        ({ plan }) => ballotAnswer(plan, "promote"),
        ({ plan }) => ballotAnswer(plan, "promote"),
      ];
      scripted.pendingAfter = { "ballot:0": 1 };
      yield* ensureLoop(loop);
      const parked = yield* readLoop(loop);
      expect(parked?.phase).toBe("ballots");
      expect(scripted.starts.filter((start) => start.key === "ballot:0")).toHaveLength(1);

      const second = yield* restart();
      yield* second.loop.recover();
      const paused = yield* second.loop.read(threadId);
      expect(paused?.status).toBe("paused");
      expect(paused?.resumeRequired).toBe(true);

      scripted.pendingAfter = {};
      const resumed = yield* second.loop.resume(threadId);
      expect(resumed.resumed).toBe(true);
      const state = yield* second.loop.read(threadId);
      expect(state?.status).toBe("stopped");
      expect(state?.promotedRounds).toHaveLength(1);
      // The ballot that was already dispatched was read from its record; the
      // restart dispatched no replacement command.
      expect(scripted.starts.filter((start) => start.key === "ballot:0")).toHaveLength(1);
    }),
  ),
);

it.live("Resume continues an interrupted repair with the remaining budget", () =>
  withLoop(({ scripted, loop, restart }) =>
    Effect.gen(function* () {
      scripted.repairs = [repairWith(), repairWithoutWriting, repairWith()];
      scripted.critic = () => criticAnswer(1);
      scripted.ballots = [
        ({ plan }) => ballotAnswer(plan, "tie"),
        ({ plan }) => ballotAnswer(plan, "tie"),
      ];
      scripted.pendingAfter = { "repair:0": 2 };
      yield* ensureLoop(loop);
      const parked = yield* readLoop(loop);
      expect(parked?.wait?.role).toBe("repair");
      expect(parked?.repairsUsed).toBe(2);

      const second = yield* restart();
      yield* second.loop.recover();
      scripted.pendingAfter = {};
      const resumed = yield* second.loop.resume(threadId);
      expect(resumed.resumed).toBe(true);
      const state = yield* second.loop.read(threadId);
      expect(state?.repairsUsed).toBe(3);
      const third = repairStarts(scripted)[2]!.input;
      expect(third.repair?.remainingBudget).toContain("1 repair");
      expect(third.repair?.previousRejection).toContain("interrupted");
    }),
  ),
);

it.live("a repair that wrote nothing but never exported is rejected as no-output", () =>
  withLoop(({ scripted, loop, rounds, root }) =>
    Effect.gen(function* () {
      scripted.repairs = [repairWithoutWriting];
      scripted.critic = () => criticAnswer(1);
      scripted.pendingAfter = { "repair:0": 2 };
      yield* ensureLoop(loop);
      const state = yield* readLoop(loop);
      expect(state?.lastRejection).toContain("no-output");
      const game = yield* rounds.read(root);
      const rejected = game.rounds.find((round) => round.status === "rejected");
      expect(rejected?.reason).toContain("no-output");
    }),
  ),
);

it.live("an export failure is recorded separately from no output", () =>
  withLoop(({ scripted, loop }) =>
    Effect.gen(function* () {
      scripted.repairs = [repairWithoutWriting];
      scripted.critic = () => criticAnswer(1);
      scripted.pendingAfter = { "repair:0": 2 };
      scripted.exportOutcome = {
        outcome: "failed",
        finishedAt: DateTime.formatIso(
          DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe()) + 1_000),
        ),
        detail: "export command failed",
      };
      yield* ensureLoop(loop);
      const state = yield* readLoop(loop);
      expect(state?.lastRejection).toContain("export-failed");
      expect(state?.lastRejection).toContain("export command failed");
    }),
  ),
);

it.live("the builder is never woken; every child is a round task", () =>
  withLoop(({ scripted, loop }) =>
    Effect.gen(function* () {
      scripted.critic = () => criticAnswer(0);
      yield* ensureLoop(loop);
      expect(scripted.starts.length).toBeGreaterThan(0);
      expect(scripted.starts.every((start) => start.input.threadId === threadId)).toBe(true);
      expect(scripted.interrupts).toHaveLength(0);
    }),
  ),
);

it.live("only a playable export starts a loop", () =>
  withLoop(({ scripted, loop }) =>
    Effect.gen(function* () {
      scripted.playable = false;
      expect(yield* ensureLoop(loop)).toBeNull();
      expect(yield* readLoop(loop)).toBeNull();
    }),
  ),
);

it.live("a second completion does not create a second loop", () =>
  withLoop(({ scripted, loop }) =>
    Effect.gen(function* () {
      scripted.critic = () => criticAnswer(0);
      const first = yield* ensureLoop(loop);
      const second = yield* ensureLoop(loop);
      expect(second?.id).toBe(first?.id);
    }),
  ),
);
