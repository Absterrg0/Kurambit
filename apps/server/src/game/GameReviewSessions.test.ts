// @effect-diagnostics nodeBuiltinImport:off -- The review session test writes real evidence and record directories.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  GAME_REVIEW_ANSWER_MAX_BYTES,
  type GameManifest,
  type GameWebPlaytestInput,
  type GameWebPlaytestResult,
  type GameReviewRound,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as GameService from "./GameService.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameReviewSessions from "./GameReviewSessions.ts";
import * as GameRoundStore from "./GameRoundStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";

const threadId = ThreadId.make("thread:review-session");
const roundId = "round-review-1";
const loopId = "loop-review-1";
const builderSelection = {
  instanceId: ProviderInstanceId.make("opencode"),
  model: "opencode-go/deepseek-v4.1-flash",
  options: [{ id: "variant", value: "high" }],
} as const;
const overrideSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
} as const;
const laterOverrideSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} as const;
const now = DateTime.makeUnsafe("2026-10-23T00:00:00.000Z");
const builderRunId = RunId.make("run:builder");
const builderNodeId = "node:builder-root";

const manifest: GameManifest = {
  schemaVersion: 1,
  name: "Review probe",
  brief: "Make a small platformer.",
  artDirection: "Warm paper colours.",
  engine: { name: "godot", version: "4.7.2" },
  godotProject: "godot",
  assets: [],
};

const runningRound: GameReviewRound = {
  schemaVersion: 1,
  id: roundId,
  threadId,
  status: "running",
  startedAt: "2026-10-23T00:00:00.000Z",
  finishedAt: null,
  incumbentSnapshotId: "source-incumbent",
  incumbentSourceId: "source-incumbent",
  incumbentBuildId: "build-incumbent",
  postRepairSourceId: null,
  candidate: null,
  budget: { repairs: 3, elapsedMs: 20 * 60_000 },
};

const parentThread = {
  id: threadId,
  title: "Build the probe",
  deletedAt: null,
  modelSelection: builderSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
} as unknown as OrchestrationV2ThreadProjection["thread"];

const builderRun = {
  id: builderRunId,
  threadId,
  ordinal: 1,
  providerInstanceId: builderSelection.instanceId,
  modelSelection: builderSelection,
  providerThreadId: null,
  userMessageId: MessageId.make("message:builder"),
  rootNodeId: builderNodeId,
  activeAttemptId: null,
  status: "completed",
  requestedAt: now,
  startedAt: now,
  completedAt: now,
  checkpointId: null,
  contextHandoffId: null,
} as unknown as OrchestrationV2Run;

const childRun = (
  childThreadId: ThreadId,
  status: OrchestrationV2Run["status"],
  options: {
    readonly userMessageId?: MessageId;
    readonly id?: RunId;
    readonly ordinal?: number;
  } = {},
) =>
  ({
    ...builderRun,
    id: options.id ?? RunId.make("run:review-child"),
    threadId: childThreadId,
    userMessageId: options.userMessageId ?? MessageId.make("message:review-child"),
    status,
    ordinal: options.ordinal ?? 1,
  }) as unknown as OrchestrationV2Run;

const assistantMessage = (
  childThreadId: ThreadId,
  text: string,
  runId: RunId = RunId.make("run:review-child"),
) =>
  ({
    id: MessageId.make(`message:${runId}`),
    threadId: childThreadId,
    runId,
    nodeId: null,
    role: "assistant",
    text,
    attachments: [],
    streaming: false,
    createdAt: now,
    updatedAt: now,
    createdBy: "agent",
    creationSource: "server",
  }) as unknown as OrchestrationV2ConversationMessage;

interface ScriptedChildRun {
  readonly id: RunId;
  readonly ordinal: number;
  readonly status: OrchestrationV2Run["status"];
  readonly answer: string;
}

const tryResult: GameWebPlaytestResult = {
  success: true,
  booted: true,
  bootMs: 10,
  responded: true,
  changedPercent: 25,
  message: "Played",
  consoleMessages: [{ level: "error", text: "observed console fault" }],
  state: null,
  screenshots: ["before", "after"].map((phase) => ({
    label: `input 1 ${phase}`,
    mimeType: "image/png",
    data: "cG5n",
    width: 640,
    height: 360,
    inputPair: {
      stepIndex: 0,
      phase: phase as "before" | "after",
      input: { press: "Space" },
      changedPercent: 25,
      stateChanges: [{ key: "state.score", before: 0, after: 1 }],
    },
  })),
};
interface Scripted {
  readonly tries: Array<{ threadId: ThreadId; buildId: string; input: GameWebPlaytestInput }>;
  builderStatus: OrchestrationV2Run["status"];
  viewport: { width: number; height: number };
  /** The commands the session service dispatched, when any ran. */
  readonly dispatches: Array<OrchestrationV2ServerCommand>;
  readonly receipts: Set<string>;
  /** Command ids the orchestrator committed as refused. */
  readonly rejectedReceipts: Set<string>;
  /** Runs that did not come from this session, e.g. a follow-up. */
  readonly extraChildRuns: Array<ScriptedChildRun>;
  /** Runs while the child's records are read, before they are returned. */
  childRecordsGate: (() => Effect.Effect<void>) | null;
  /** The thread's composer selection; tests change it mid-round. */
  parentSelection: {
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
    readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string }>;
  };
  /** "instance/model" keys the catalog does not offer. */
  readonly unavailable: Set<string>;
  childThreadId: ThreadId | null;
  /** The command that created the child; its message id names its run. */
  childCommandId: string | null;
  /** Frozen selections a loop would fold into the round record. */
  roundSelections: { builderSelection: ModelSelection; reviewSelection: ModelSelection } | null;
  childStatus: OrchestrationV2Run["status"];
  answer: string;
  available: boolean;
}

const makeScripted = (): Scripted => ({
  tries: [],
  builderStatus: "completed",
  viewport: { width: 640, height: 360 },
  dispatches: [],
  receipts: new Set(),
  rejectedReceipts: new Set(),
  extraChildRuns: [],
  childRecordsGate: null,
  parentSelection: builderSelection,
  unavailable: new Set(),
  childThreadId: null,
  childCommandId: null,
  roundSelections: null,
  childStatus: "completed",
  answer: "",
  available: true,
});

const walk = async (directory: string): Promise<Array<string>> => {
  const files: string[] = [];
  const stack = [""];
  while (stack.length > 0) {
    const relative = stack.pop()!;
    for (const entry of await NodeFSP.readdir(NodePath.join(directory, relative), {
      withFileTypes: true,
    })) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) stack.push(child);
      else files.push(child);
    }
  }
  return files.sort();
};

const withSession = <A, E>(
  body: (input: {
    readonly root: string;
    readonly stateDir: string;
    readonly frames: ReadonlyArray<string>;
    readonly scripted: Scripted;
    readonly service: GameReviewSessions.GameReviewSessions["Service"];
    /** A second instance over the same state, like a restarted server. */
    readonly restart: () => Effect.Effect<GameReviewSessions.GameReviewSessions["Service"], never>;
  }) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-review-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const root = NodePath.join(base, "game");
      const stateDir = NodePath.join(base, "state");
      const frameDirectory = NodePath.join(base, "source-frames");
      const frames = [
        NodePath.join(frameDirectory, "boot.png"),
        NodePath.join(frameDirectory, "action.png"),
      ];
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(root, "godot/scripts"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(root, "game.json"), '{"name":"Review probe"}\n');
        await NodeFSP.writeFile(
          NodePath.join(root, "BRIEF.md"),
          "# Review probe\n\nMake a small platformer.\n",
        );
        await NodeFSP.writeFile(
          NodePath.join(root, "AGENTS.md"),
          "Builder instructions that a review child must never see.\n",
        );
        await NodeFSP.writeFile(NodePath.join(root, "godot/scripts/main.gd"), "extends Node\n");
        await NodeFSP.mkdir(frameDirectory, { recursive: true });
        await NodeFSP.writeFile(frames[0]!, "boot-png-bytes");
        await NodeFSP.writeFile(frames[1]!, "action-png-bytes");
      });
      const scripted = makeScripted();

      const makeLayer = () => {
        const roundState = () => ({
          selected: null,
          rounds: [
            scripted.roundSelections === null
              ? runningRound
              : { ...runningRound, ...scripted.roundSelections },
          ],
        });
        const service = GameReviewSessions.layer({ stateDir }).pipe(
          Layer.provide(
            Layer.mock(GameService.GameService)({
              status: () =>
                Effect.succeed({
                  qualification: { servedArtifactId: "build-incumbent" },
                } as import("@t3tools/contracts").GameStatus),
              webPlaytestBuild: (threadId, buildId, input) =>
                Effect.sync(() => {
                  scripted.tries.push({ threadId, buildId, input });
                  return tryResult;
                }),
            }),
          ),
          Layer.provide(
            Layer.mock(GameProjectService.GameProjectService)({
              resolve: () => Effect.succeed(root),
              read: () => Effect.succeed(manifest),
            }),
          ),
          Layer.provide(
            Layer.mock(GameRoundStore.GameRoundStore)({
              read: () => Effect.succeed(roundState()),
              exported: () =>
                Effect.succeed({
                  artifact: {
                    buildId: "build-incumbent",
                    sourceId: "source-incumbent",
                    directory: "builds/web",
                    engine: "godot",
                    target: "Web",
                    entry: "builds/web/index.html",
                  },
                  sourceDirectory: root,
                  playtest: {
                    booted: true,
                    responded: true,
                    consoleErrors: 0,
                    steps: [],
                    viewport: scripted.viewport,
                  },
                }),
            }),
          ),
          Layer.provide(
            Layer.mock(GameReviewSessions.GameReviewProviderCatalog)({
              available: (selection) =>
                Effect.succeed(
                  scripted.available &&
                    !scripted.unavailable.has(`${selection.instanceId}/${selection.model}`),
                ),
            }),
          ),
          Layer.provide(
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              hasReceipt: (commandId: CommandId) =>
                Effect.succeed(scripted.receipts.has(commandId)),
              getCommandReceiptStatus: (commandId: CommandId) =>
                Effect.succeed(
                  scripted.rejectedReceipts.has(commandId)
                    ? "rejected"
                    : scripted.receipts.has(commandId)
                      ? "accepted"
                      : null,
                ),
              getThreadRecords: (target: ThreadId) =>
                Effect.gen(function* () {
                  if (target === threadId)
                    return {
                      thread: { ...parentThread, modelSelection: scripted.parentSelection },
                      runs: [{ ...builderRun, status: scripted.builderStatus }],
                    } as unknown as OrchestrationV2ThreadProjection;
                  if (scripted.childThreadId !== null && target === scripted.childThreadId) {
                    if (scripted.childRecordsGate !== null) yield* scripted.childRecordsGate();
                    return {
                      runs: [
                        childRun(
                          target,
                          scripted.childStatus,
                          scripted.childCommandId === null
                            ? {}
                            : {
                                userMessageId: IdAllocator.derive.delegatedTaskMessage({
                                  commandId: CommandId.make(scripted.childCommandId),
                                }),
                              },
                        ),
                        ...scripted.extraChildRuns.map((extra) =>
                          childRun(target, extra.status, {
                            id: extra.id,
                            ordinal: extra.ordinal,
                            userMessageId: MessageId.make(`message:${extra.id}`),
                          }),
                        ),
                      ],
                      messages: [
                        assistantMessage(target, scripted.answer),
                        ...scripted.extraChildRuns.map((extra) =>
                          assistantMessage(target, extra.answer, extra.id),
                        ),
                      ],
                    } as unknown as OrchestrationV2ThreadProjection;
                  }
                  return yield* Effect.die(`unexpected thread ${target}`);
                }),
              dispatch: (command: OrchestrationV2ServerCommand) => {
                scripted.dispatches.push(command);
                scripted.receipts.add(command.commandId);
                if (command.type === "game-round.task.request") {
                  // The real Orchestrator derives the child id from the command
                  // id; the test mirrors that so `answer` finds the child.
                  scripted.childThreadId = IdAllocator.derive.delegatedTaskThread({
                    commandId: command.commandId,
                  });
                  scripted.childCommandId = command.commandId;
                }
                return Effect.succeed({
                  sequence: scripted.dispatches.length,
                  storedEvents: [],
                } as unknown as Orchestrator.OrchestratorV2DispatchResult);
              },
            } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
          ),
          Layer.provide(NodeServices.layer),
        );
        return service;
      };

      const start = () =>
        Effect.gen(function* () {
          return yield* GameReviewSessions.GameReviewSessions;
        }).pipe(Effect.provide(makeLayer()));

      const service = yield* start();
      return yield* body({
        root,
        stateDir,
        frames,
        scripted,
        service,
        restart: start,
      });
    }),
  );

const frameInput = (paths: ReadonlyArray<string>): GameReviewSessions.GameReviewEvidenceInput => ({
  frames: [
    {
      id: "incumbent-boot",
      label: "before: no input",
      sourcePath: paths[0]!,
      inputPair: {
        stepIndex: 0,
        phase: "before",
        input: { key: "ArrowRight", holdMs: 1000 },
        changedPercent: 25,
        stateChanges: [{ key: "state.card", before: "ready", after: "chosen" }],
      },
    },
    {
      id: "incumbent-action",
      label: "after: held ArrowRight 1000ms",
      sourcePath: paths[1]!,
      inputPair: {
        stepIndex: 0,
        phase: "after",
        input: { key: "ArrowRight", holdMs: 1000 },
        changedPercent: 25,
        stateChanges: [{ key: "state.card", before: "ready", after: "chosen" }],
      },
    },
  ],
  checks: [
    { id: "boot", status: "passed" },
    {
      id: "input",
      status: "passed",
      detail: "1 input step executed",
      measurements: {
        steps: [{ key: "ArrowLeft", holdMs: 100 }],
        state: null,
        changedPercent: 0,
        designObservations: [],
      },
    },
  ],
});

const fundamentals = {
  boots: { verdict: "yes" as const, frameIds: ["f1"], note: "Boot frame." },
  respondsToInput: { verdict: "yes" as const, frameIds: ["f1"], note: "Input feedback." },
  coreActionVisible: { verdict: "yes" as const, frameIds: ["f1"], note: "Core action visible." },
  stateReadable: { verdict: "yes" as const, frameIds: ["f1"], note: "State readable." },
};

const criticText = JSON.stringify({
  fundamentals,
  defects: [
    {
      severity: "visible",
      what: "The player stands on nothing.",
      frameId: "f2",
      fix: "Spawn the player on the platform; yes/no: player overlaps ground on boot.",
    },
  ],
  doNotRegress: [{ id: "turns", what: "Left and right still turn the player.", frameId: "f1" }],
});

it.live("a critic runs fresh on the game thread's model with evidence only", () =>
  withSession(({ root, stateDir, frames, scripted, service }) =>
    Effect.gen(function* () {
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      expect(started.reconciled).toBe(false);

      expect(scripted.dispatches).toHaveLength(1);
      const command = scripted.dispatches[0]!;
      expect(command.type).toBe("game-round.task.request");
      if (command.type !== "game-round.task.request") return;
      expect(command.modelSelection).toEqual(builderSelection);
      expect(command.originatingRunId).toBe(builderRunId);
      expect(command.originatingNodeId).toBe(builderNodeId);
      expect(command.evidenceDirectory).not.toBeNull();
      expect(command.evidenceDirectory!.startsWith(stateDir)).toBe(true);
      expect(command.evidenceDirectory!.startsWith(`${root}${NodePath.sep}`)).toBe(false);
      // The prompt carries the manifest, never a build id or a source path.
      expect(command.task).toContain("frames/frame-01.png (f1: before: no input)");
      expect(command.task).toContain("f2: after: held ArrowRight 1000ms");
      expect(command.task).toContain("Call game_critic_report");
      expect(command.task).toContain('"fundamentals"');
      expect(command.task).toContain("Judge input response from the before/after pairs.");
      expect(command.task).toContain(
        "If unsure whether something works, try it with game_try_input and cite those frames.",
      );
      expect(command.task).not.toContain("Do not edit, execute, browse");
      expect(command.task).toContain("Correct tool validation errors in this session");
      expect(command.task).toContain("Only when tools are unavailable");
      expect(command.task).not.toContain("builds/");

      // Evidence only: brief, anonymous frames and normalized checks.
      const files = yield* Effect.promise(() => walk(command.evidenceDirectory!));
      expect(files).toEqual([
        "BRIEF.md",
        "evidence.json",
        "frames/frame-01.png",
        "frames/frame-02.png",
      ]);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(
            NodePath.join(command.evidenceDirectory!, "frames/frame-01.png"),
            "utf8",
          ),
        ),
      ).toBe("boot-png-bytes");
      const evidenceJson = JSON.parse(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(command.evidenceDirectory!, "evidence.json"), "utf8"),
        ),
      ) as { checks: Array<{ id: string }>; frames: Array<{ id: string }> };
      expect(evidenceJson.checks.map((check) => check.id)).toEqual(["boot", "input"]);
      expect(evidenceJson.frames).toEqual([
        expect.objectContaining({
          id: "f1",
          label: "before: no input",
          inputPair: frameInput(frames).frames[0]!.inputPair,
        }),
        expect.objectContaining({
          id: "f2",
          label: "after: held ArrowRight 1000ms",
          inputPair: frameInput(frames).frames[1]!.inputPair,
        }),
      ]);
      expect(evidenceJson.checks[1]).toMatchObject({
        measurements: frameInput(frames).checks[1]!.measurements,
      });
      expect(started.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
      const description = yield* service.describe({
        threadId,
        loopId: command.loopId,
        roundId: command.roundId,
        role: "critic",
        order: 0,
      });
      expect(description).toMatchObject({
        role: "critic",
        hash: started.evidenceHash,
        childThreadId: started.childThreadId,
        frames: [{ id: "f1" }, { id: "f2" }],
      });
      expect(description?.frames[0]?.path.startsWith(command.evidenceDirectory!)).toBe(true);

      // The answer is read only while the evidence still matches that hash.
      scripted.answer = criticText;
      const answer = yield* service.answer({ threadId, loopId, roundId, role: "critic" });
      expect(answer.kind).toBe("critic");
    }),
  ),
);

it.live("a review override applies to review roles only and freezes per round", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      const critic = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
        selection: overrideSelection,
      });
      expect(critic.kind).toBe("started");
      const criticCommand = scripted.dispatches.at(-1)!;
      expect(criticCommand.type).toBe("game-round.task.request");
      if (criticCommand.type !== "game-round.task.request") return;
      expect(criticCommand.modelSelection).toEqual(overrideSelection);

      // A repair keeps the builder's selection, whatever override it is given.
      const repair = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "repair",
        selection: laterOverrideSelection,
        repair: {
          remainingBudget: "2 repairs and 11 minutes left",
          defects: [],
          doNotRegress: [],
        },
      });
      expect(repair.kind).toBe("started");
      const repairCommand = scripted.dispatches.at(-1)!;
      expect(repairCommand.type).toBe("game-round.task.request");
      if (repairCommand.type !== "game-round.task.request") return;
      expect(repairCommand.modelSelection).toEqual(builderSelection);
      expect(repairCommand.evidenceDirectory).toBeNull();
      expect(repairCommand.task).toContain("REMAINING_BUDGET: 2 repairs and 11 minutes left");

      // The round froze the critic's override: a later ballot must use it, not
      // its own override or the thread's current selection.
      const ballot = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "ballot",
        evidence: frameInput(frames),
        items: [{ id: "turns", what: "Left and right still turn the player." }],
        selection: laterOverrideSelection,
      });
      expect(ballot.kind).toBe("started");
      const ballotCommand = scripted.dispatches.at(-1)!;
      if (ballotCommand.type !== "game-round.task.request") return;
      expect(ballotCommand.modelSelection).toEqual(overrideSelection);
    }),
  ),
);

it.live("a repair uses the builder selection frozen at round start", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      const critic = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
        selection: overrideSelection,
      });
      expect(critic.kind).toBe("started");

      // The composer moves on after critique, and the new model is not even
      // available any more. The repair must still use the original builder.
      scripted.parentSelection = laterOverrideSelection;
      scripted.unavailable.add(
        `${laterOverrideSelection.instanceId}/${laterOverrideSelection.model}`,
      );
      const repair = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "repair",
        repair: {
          remainingBudget: "2 repairs and 11 minutes left",
          defects: [],
          doNotRegress: [],
        },
      });
      expect(repair.kind).toBe("started");
      const repairCommand = scripted.dispatches.at(-1)!;
      if (repairCommand.type !== "game-round.task.request") return;
      expect(repairCommand.modelSelection).toEqual(builderSelection);
    }),
  ),
);

it.live("a round's own frozen selections win over the session file and the thread", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.roundSelections = {
        builderSelection: overrideSelection,
        reviewSelection: laterOverrideSelection,
      };
      // The thread composer offers yet another model; the round's record wins.
      scripted.parentSelection = builderSelection;
      const critic = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
        selection: builderSelection,
      });
      expect(critic.kind).toBe("started");
      const criticCommand = scripted.dispatches.at(-1)!;
      if (criticCommand.type !== "game-round.task.request") return;
      expect(criticCommand.modelSelection).toEqual(laterOverrideSelection);

      // Repairs always use the round's builder selection.
      const repair = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "repair",
        selection: laterOverrideSelection,
        repair: {
          remainingBudget: "2 repairs left",
          defects: [],
          doNotRegress: [],
          previousRejection: "mechanical-veto: input failed",
        },
      });
      expect(repair.kind).toBe("started");
      const repairCommand = scripted.dispatches.at(-1)!;
      if (repairCommand.type !== "game-round.task.request") return;
      expect(repairCommand.modelSelection).toEqual(overrideSelection);
      expect(repairCommand.task).toContain("PREVIOUS ATTEMPT (rejected; do not repeat):");
      expect(repairCommand.task).toContain("mechanical-veto: input failed");
    }),
  ),
);

it.live("runStatus reads the bound child run, never a newer follow-up", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      expect(String(started.runId)).toBe("run:review-child");

      scripted.childStatus = "running";
      const pending = yield* service.runStatus({ threadId, loopId, roundId, role: "critic" });
      expect(pending.kind).toBe("pending");

      scripted.childStatus = "completed";
      const terminal = yield* service.runStatus({ threadId, loopId, roundId, role: "critic" });
      expect(terminal.kind).toBe("terminal");
      if (terminal.kind === "terminal") expect(terminal.status).toBe("completed");

      const missing = yield* service.runStatus({
        threadId,
        loopId,
        roundId,
        role: "ballot",
        order: 1,
      });
      expect(missing.kind).toBe("missing");
    }),
  ),
);

it.live("an unavailable review model is unavailable, never substituted", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.available = false;
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      expect(started.kind).toBe("unavailable");
      expect(scripted.dispatches).toHaveLength(0);
    }),
  ),
);

it.live("changed evidence invalidates an otherwise valid answer", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      scripted.answer = criticText;
      const first = yield* service.answer({ threadId, loopId, roundId, role: "critic" });
      expect(first.kind).toBe("critic");

      const directory = yield* service.evidenceDirectory({
        threadId,
        loopId,
        roundId,
        role: "critic",
      });
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(directory!, "frames/frame-01.png"), "tampered"),
      );
      const second = yield* service.answer({ threadId, loopId, roundId, role: "critic" });
      expect(second.kind).toBe("invalid");
      if (second.kind === "invalid") expect(second.reason).toContain("evidence changed");
    }),
  ),
);

it.live("evidence is verified after the terminal answer is read", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      expect(started.kind).toBe("started");
      const directory = yield* service.evidenceDirectory({
        threadId,
        loopId,
        roundId,
        role: "critic",
      });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // Hold the terminal read open, exactly where the child could still be
      // changing its evidence.
      scripted.childRecordsGate = () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        });
      scripted.childStatus = "running";
      const pending = yield* Effect.forkScoped(
        service.answer({ threadId, loopId, roundId, role: "critic" }),
      );
      yield* Deferred.await(entered);
      // The child tampers with a frame and finishes while the reader waits.
      scripted.childStatus = "completed";
      scripted.answer = criticText;
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(directory!, "frames/frame-01.png"), "tampered"),
      );
      yield* Deferred.succeed(release, undefined);
      const answer = yield* Fiber.join(pending);
      expect(answer.kind).toBe("invalid");
      if (answer.kind === "invalid") expect(answer.reason).toContain("evidence changed");
    }),
  ),
);

it.live("strict parsing rejects malformed, extra-key and unknown-id answers", () =>
  Effect.sync(() => {
    const frames = new Set(["f1", "f2"]);
    const checks = new Set(["boot", "input"]);
    const items = ["turns"];

    expect(
      GameReviewSessions.parseCriticAnswer("not json", { frameIds: frames, checkIds: checks }).kind,
    ).toBe("invalid");
    expect(
      GameReviewSessions.parseCriticAnswer(
        JSON.stringify({ defects: [], doNotRegress: [], score: 9 }),
        { frameIds: frames, checkIds: checks },
      ).kind,
    ).toBe("invalid");
    expect(
      GameReviewSessions.parseCriticAnswer(
        JSON.stringify({ defects: [], doNotRegress: [{ id: "x", what: "y", frameId: "f9" }] }),
        { frameIds: frames, checkIds: checks },
      ).kind,
    ).toBe("invalid");
    expect(
      GameReviewSessions.parseCriticAnswer(
        JSON.stringify({
          defects: [],
          doNotRegress: [{ id: "x", what: "y", frameId: "f1", checkId: "unmeasured" }],
        }),
        { frameIds: frames, checkIds: checks },
      ).kind,
    ).toBe("invalid");
    expect(
      GameReviewSessions.parseCriticAnswer(JSON.stringify({ defects: [] }), {
        frameIds: frames,
        checkIds: checks,
      }).kind,
    ).toBe("invalid");

    // JSON.parse keeps the last duplicate. Accepting that would let the second
    // member erase the reported defects, so a repeat is invalid at any depth.
    const duplicateTopLevel = GameReviewSessions.parseCriticAnswer(
      '{"defects":[{"severity":"visible","what":"x","frameId":"f1","fix":"y"}],"defects":[],"doNotRegress":[]}',
      { frameIds: frames, checkIds: checks },
    );
    expect(duplicateTopLevel.kind).toBe("invalid");
    if (duplicateTopLevel.kind === "invalid") expect(duplicateTopLevel.reason).toContain("repeats");
    expect(
      GameReviewSessions.parseCriticAnswer(
        '{"defects":[{"severity":"visible","what":"x","frameId":"f1","fix":"y","fix":"z"}],"doNotRegress":[]}',
        { frameIds: frames, checkIds: checks },
      ).kind,
    ).toBe("invalid");
    // Deep nesting that fits the byte limit is an invalid answer, not a stack
    // overflow, and a repeat behind it is still found.
    const deep = `{"defects":${"[".repeat(8_000)}${"]".repeat(8_000)},"doNotRegress":[]}`;
    expect(Buffer.byteLength(deep, "utf8")).toBeLessThan(16 * 1024);
    expect(
      GameReviewSessions.parseCriticAnswer(deep, { frameIds: frames, checkIds: checks }).kind,
    ).toBe("invalid");
    const deepRepeat = GameReviewSessions.parseCriticAnswer(
      `{"x":${"[".repeat(8_000)}{"a":1,"a":2}${"]".repeat(8_000)}}`,
      { frameIds: frames, checkIds: checks },
    );
    expect(deepRepeat.kind).toBe("invalid");
    if (deepRepeat.kind === "invalid") expect(deepRepeat.reason).toContain('"a"');

    const ballot = (overrides: Record<string, unknown> = {}) =>
      JSON.stringify({
        overall: "A",
        overallReason: "The input pair shows clearer action feedback.",
        main: { works: "A", look: "tie", feel: "B", play: "tie" },
        preservation: [{ id: "turns", A: "preserved", B: "unknown", frameIds: ["f1"] }],
        control: { works: "tie", look: "tie", feel: "tie", play: "tie" },
        reason: "f1 shows the turn still works.",
        ...overrides,
      });
    expect(
      GameReviewSessions.parseBallotAnswer(ballot(), { frameIds: frames, itemIds: items }).kind,
    ).toBe("valid");
    expect(
      GameReviewSessions.parseBallotAnswer(ballot({ preservation: [] }), {
        frameIds: frames,
        itemIds: items,
      }).kind,
    ).toBe("invalid");
    expect(
      GameReviewSessions.parseBallotAnswer(
        ballot({
          preservation: [{ id: "unknown", A: "preserved", B: "unknown", frameIds: ["f1"] }],
        }),
        { frameIds: frames, itemIds: items },
      ).kind,
    ).toBe("invalid");
    expect(
      GameReviewSessions.parseBallotAnswer(
        ballot({
          preservation: [{ id: "turns", A: "preserved", B: "unknown", frameIds: ["f9"] }],
        }),
        { frameIds: frames, itemIds: items },
      ).kind,
    ).toBe("invalid");
    for (const overall of [undefined, "C", "accept"]) {
      expect(
        GameReviewSessions.parseBallotAnswer(ballot({ overall }), {
          frameIds: frames,
          itemIds: items,
        }).kind,
      ).toBe("invalid");
    }
    expect(
      GameReviewSessions.parseBallotAnswer(ballot({ overallReason: "" }), {
        frameIds: frames,
        itemIds: items,
      }).kind,
    ).toBe("invalid");
    expect(
      GameReviewSessions.parseBallotAnswer(ballot({ score: 4 }), {
        frameIds: frames,
        itemIds: items,
      }).kind,
    ).toBe("invalid");
  }),
);

it.live("an oversized multibyte answer is bounded and marked truncated", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      expect(started.kind).toBe("started");
      scripted.answer = "é".repeat(GAME_REVIEW_ANSWER_MAX_BYTES + 1024);
      const answer = yield* service.answer({ threadId, loopId, roundId, role: "critic" });
      expect(answer.kind).toBe("invalid");
      if (answer.kind !== "invalid") return;
      expect(answer.truncated).toBe(true);
      expect(Buffer.byteLength(answer.raw ?? "", "utf8")).toBeLessThanOrEqual(
        GAME_REVIEW_ANSWER_MAX_BYTES,
      );
      // The cut is on a byte boundary, not inside a character.
      expect(answer.raw ?? "").not.toContain("\uFFFD");
    }),
  ),
);

it.live("an answer is bound to the run the round dispatched", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      expect(started.kind).toBe("started");
      scripted.answer = criticText;
      // A later, unrelated follow-up finishes with a different valid answer.
      scripted.extraChildRuns.push({
        id: RunId.make("run:review-followup"),
        ordinal: 2,
        status: "completed",
        answer: JSON.stringify({ fundamentals, defects: [], doNotRegress: [] }),
      });
      const bound = yield* service.answer({ threadId, loopId, roundId, role: "critic" });
      expect(bound.kind).toBe("critic");
      if (bound.kind === "critic") expect(bound.answer.defects).toHaveLength(1);

      // An interrupted original stays invalid even though the follow-up has a
      // perfectly good answer; the follow-up never replaces it.
      scripted.childStatus = "interrupted";
      const interrupted = yield* service.answer({ threadId, loopId, roundId, role: "critic" });
      expect(interrupted.kind).toBe("invalid");
      if (interrupted.kind === "invalid") expect(interrupted.reason).toContain("interrupted");
    }),
  ),
);

it.live("a restart reconciles a committed session without dispatching again", () =>
  withSession(({ root, stateDir, frames, scripted, service, restart }) =>
    Effect.gen(function* () {
      const first = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      expect(first.kind).toBe("started");
      if (first.kind !== "started") return;
      expect(scripted.dispatches).toHaveLength(1);

      const restarted = yield* restart();
      const second = yield* restarted.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      expect(second.kind).toBe("started");
      if (second.kind !== "started") return;
      expect(second.reconciled).toBe(true);
      expect(second.childThreadId).toBe(first.childThreadId);
      expect(scripted.dispatches).toHaveLength(1);

      // A crash after the command committed but before its record was
      // confirmed: the pending record must recover the same child, the
      // original hash and enough audit data to answer, without dispatching.
      const records = (yield* Effect.promise(() => walk(stateDir))).filter((file) =>
        file.endsWith("session.json"),
      );
      expect(records).toHaveLength(1);
      const recordPath = NodePath.join(stateDir, records[0]!);
      const stored = JSON.parse(
        yield* Effect.promise(() => NodeFSP.readFile(recordPath, "utf8")),
      ) as { commandId: string; dispatch: { state: string }; evidenceHash: string | null };
      expect(stored.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
      stored.dispatch = { state: "pending" };
      yield* Effect.promise(() =>
        NodeFSP.writeFile(recordPath, `${JSON.stringify(stored, null, 2)}\n`),
      );
      // An unconfirmed child is still the loop's: it is listed for the hold.
      const listed = yield* service.recordedChildren({ root, loopId });
      expect(listed.map((child) => child.childThreadId)).toEqual([first.childThreadId]);
      expect(yield* service.recordedChildren({ root, loopId: "loop:other" })).toEqual([]);
      scripted.answer = criticText;
      const recovered = yield* (yield* restart()).start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      expect(recovered.kind).toBe("started");
      if (recovered.kind !== "started") return;
      expect(recovered.reconciled).toBe(true);
      expect(recovered.childThreadId).toBe(first.childThreadId);
      expect(recovered.evidenceHash).toBe(first.evidenceHash);
      expect(scripted.dispatches).toHaveLength(1);
      const recoveredAnswer = yield* (yield* restart()).answer({
        threadId,
        loopId,
        roundId,
        role: "critic",
      });
      expect(recoveredAnswer.kind).toBe("critic");

      // The record is the audit truth. A receipt without it cannot recreate the
      // manifest mapping or the original hash, so it is a failed start rather
      // than a phantom success.
      yield* Effect.promise(() => NodeFSP.rm(recordPath, { force: true }));
      const refused = yield* (yield* restart()).start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      expect(refused.kind).toBe("failed");
      expect(scripted.dispatches).toHaveLength(1);
    }),
  ),
);

it.live("a rejected dispatch receipt fails the start instead of recovering it", () =>
  withSession(({ stateDir, frames, scripted, service, restart }) =>
    Effect.gen(function* () {
      const first = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      expect(first.kind).toBe("started");
      if (first.kind !== "started") return;

      const recordPath = NodePath.join(
        stateDir,
        (yield* Effect.promise(() => walk(stateDir))).find((file) =>
          file.endsWith("session.json"),
        )!,
      );
      const stored = JSON.parse(
        yield* Effect.promise(() => NodeFSP.readFile(recordPath, "utf8")),
      ) as { commandId: string; dispatch: { state: string } };
      stored.dispatch = { state: "pending" };
      yield* Effect.promise(() =>
        NodeFSP.writeFile(recordPath, `${JSON.stringify(stored, null, 2)}\n`),
      );
      // The orchestrator committed a refusal for this command id.
      scripted.receipts.delete(stored.commandId);
      scripted.rejectedReceipts.add(stored.commandId);

      const recovered = yield* (yield* restart()).start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      expect(recovered.kind).toBe("failed");
      expect(scripted.dispatches).toHaveLength(1);

      // The refusal is durable; a retry cannot turn it into a start later.
      const again = yield* (yield* restart()).start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      expect(again.kind).toBe("failed");
      expect(scripted.dispatches).toHaveLength(1);
    }),
  ),
);

it.live("a repair is a separate writable child in the game folder", () =>
  withSession(({ scripted, service }) =>
    Effect.gen(function* () {
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "repair",
        repair: {
          remainingBudget: "3 repairs and 19 minutes left",
          defects: [
            {
              severity: "blocker",
              what: "The game does not boot.",
              frameId: "f1",
              fix: "Fix the boot error; yes/no: the first frame renders.",
            },
          ],
          doNotRegress: [{ id: "turns", what: "Turning works.", frameId: "f1" }],
        },
      });
      expect(started.kind).toBe("started");
      const command = scripted.dispatches.at(-1)!;
      expect(command.type).toBe("game-round.task.request");
      if (command.type !== "game-round.task.request") return;
      expect(command.evidenceDirectory).toBeNull();
      expect(command.task).toContain("[blocker] The game does not boot.");
      expect(command.task).toContain("DO_NOT_REGRESS:\n- turns: Turning works.");
      expect(
        yield* service.evidenceDirectory({ threadId, loopId, roundId, role: "repair" }),
      ).toBeNull();
    }),
  ),
);

it.live("accepts one JSON fence and truncates prose while keeping decisions and ids strict", () =>
  Effect.sync(() => {
    const known = { frameIds: new Set(["f1"]), checkIds: new Set(["boot"]) };
    const critic = {
      fundamentals,
      defects: [
        { severity: "visible", what: "w".repeat(401), frameId: "f1", fix: "f".repeat(401) },
      ],
      doNotRegress: [{ id: "input", what: "p".repeat(401), frameId: "f1" }],
    };
    const raw = JSON.stringify(critic);
    for (const text of [raw, `\n\`\`\`json\n${raw}\n\`\`\`\n`]) {
      const parsed = GameReviewSessions.parseCriticAnswer(text, known);
      expect(parsed.kind).toBe("valid");
      if (parsed.kind !== "valid") continue;
      for (const field of [
        parsed.answer.defects[0]!.what,
        parsed.answer.defects[0]!.fix,
        parsed.answer.doNotRegress[0]!.what,
      ]) {
        expect(field).toHaveLength(400);
        expect(field).toMatch(/\[truncated\]$/);
      }
    }
    for (const text of [
      `Here is JSON: ${raw}`,
      `\`\`\`json\n${raw}\n\`\`\`\n\`\`\`json\n${raw}\n\`\`\``,
      `\`\`\`js\n${raw}\n\`\`\``,
    ])
      expect(GameReviewSessions.parseCriticAnswer(text, known).kind).toBe("invalid");
    expect(
      GameReviewSessions.parseCriticAnswer(
        JSON.stringify({
          ...critic,
          defects: [{ ...critic.defects[0], severity: "visible".repeat(80) }],
        }),
        known,
      ).kind,
    ).toBe("invalid");
    expect(
      GameReviewSessions.parseCriticAnswer(
        JSON.stringify({
          ...critic,
          doNotRegress: [{ ...critic.doNotRegress[0], id: "i".repeat(81) }],
        }),
        known,
      ).kind,
    ).toBe("invalid");
  }),
);

it.live("returns the schema error, accepts a valid retry, and ends on the first valid call", () =>
  withSession(({ frames, scripted, service, restart }) =>
    Effect.gen(function* () {
      scripted.childStatus = "running";
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      if (started.kind !== "started") return expect(started.kind).toBe("started");
      const caller = {
        threadId: started.childThreadId,
        providerInstanceId: builderSelection.instanceId,
      };
      expect(yield* service.toolRole(caller)).toBe("critic");
      const invalid = yield* service.report(caller, "critic", {
        fundamentals,
        defects: [],
        doNotRegress: "wrong",
      });
      expect(invalid).toMatchObject({ accepted: false, attemptsRemaining: 2, ended: false });
      expect(invalid.error).toContain("doNotRegress");
      expect(scripted.dispatches).toHaveLength(1);
      const resumed = yield* restart();
      const accepted = yield* resumed.report(caller, "critic", {
        fundamentals,
        defects: [],
        doNotRegress: [],
      });
      expect(accepted).toEqual({ accepted: true, error: null, attemptsRemaining: 0, ended: true });
      expect(scripted.dispatches.at(-1)).toMatchObject({
        type: "run.interrupt",
        runId: started.runId,
      });
      expect(
        (yield* resumed.report(caller, "critic", { fundamentals, defects: [], doNotRegress: [] }))
          .accepted,
      ).toBe(false);
    }),
  ),
);

it.live(
  "refuses other threads, roles, providers and follow-up runs without spending attempts",
  () =>
    withSession(({ frames, scripted, service }) =>
      Effect.gen(function* () {
        scripted.childStatus = "running";
        const started = yield* service.start({
          threadId,
          loopId,
          roundId,
          role: "critic",
          evidence: frameInput(frames),
        });
        if (started.kind !== "started") return expect(started.kind).toBe("started");
        const caller = {
          threadId: started.childThreadId,
          providerInstanceId: builderSelection.instanceId,
        };
        const answer = { fundamentals, defects: [], doNotRegress: [] };
        expect(yield* service.toolRole({ ...caller, threadId })).toBeNull();
        expect((yield* service.report({ ...caller, threadId }, "critic", answer)).accepted).toBe(
          false,
        );
        expect((yield* service.report(caller, "ballot", answer)).accepted).toBe(false);
        expect(
          (yield* service.report(
            { ...caller, providerInstanceId: overrideSelection.instanceId },
            "critic",
            answer,
          )).accepted,
        ).toBe(false);
        scripted.childStatus = "completed";
        scripted.extraChildRuns.push({
          id: RunId.make("run:follow-up"),
          ordinal: 2,
          status: "running",
          answer: "",
        });
        expect(yield* service.toolRole(caller)).toBeNull();
        expect((yield* service.report(caller, "critic", answer)).accepted).toBe(false);
        expect(scripted.dispatches).toHaveLength(1);
      }),
    ),
);

it.live("ends after three invalid calls and refuses a fourth valid call", () =>
  withSession(({ frames, scripted, service, restart }) =>
    Effect.gen(function* () {
      scripted.childStatus = "running";
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      if (started.kind !== "started") return expect(started.kind).toBe("started");
      const caller = {
        threadId: started.childThreadId,
        providerInstanceId: builderSelection.instanceId,
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = yield* service.report(caller, "critic", {
          defects: [{ severity: "score" }],
          doNotRegress: [],
        });
        expect(result).toMatchObject({
          accepted: false,
          attemptsRemaining: 2 - attempt,
          ended: attempt === 2,
        });
      }
      expect(scripted.dispatches.at(-1)).toMatchObject({ type: "run.interrupt" });
      const resumed = yield* restart();
      expect(
        (yield* resumed.report(caller, "critic", { fundamentals, defects: [], doNotRegress: [] }))
          .accepted,
      ).toBe(false);
    }),
  ),
);

it.live("validates ballot coverage and evidence before recording the top-level facet choices", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.childStatus = "running";
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "ballot",
        evidence: frameInput(frames),
        items: [{ id: "turns", what: "Turning works" }],
      });
      if (started.kind !== "started") return expect(started.kind).toBe("started");
      const caller = {
        threadId: started.childThreadId,
        providerInstanceId: builderSelection.instanceId,
      };
      const command = scripted.dispatches[0]!;
      if (command.type !== "game-round.task.request") return;
      expect(command.task).toContain("Call game_ballot");
      expect(command.task).toContain('"overall":"tie"');
      expect(command.task).toContain('"overallReason"');
      expect(command.task).toContain(
        '"works":"tie","look":"tie","feel":"tie","play":"tie","preservation"',
      );
      expect(command.task).toContain('four choices wrapped in "main"');
      expect(command.task).toContain("unknown is neutral");
      const value = {
        overall: "A",
        overallReason: "The input pair shows clearer action feedback.",
        works: "tie",
        look: "B",
        feel: "tie",
        play: "tie",
        preservation: [],
        control: { works: "tie", look: "tie", feel: "tie", play: "tie" },
        reason: "f2 shows the improvement.",
      };
      expect((yield* service.report(caller, "ballot", value)).error).toContain(
        "did not judge preservation items: turns",
      );
      const preservation = [{ id: "turns", A: "preserved", B: "unknown", frameIds: ["f99"] }];
      expect((yield* service.report(caller, "ballot", { ...value, preservation })).error).toContain(
        "frame f99",
      );
      preservation[0]!.frameIds = ["f2"];
      expect((yield* service.report(caller, "ballot", { ...value, preservation })).accepted).toBe(
        true,
      );
    }),
  ),
);

it.live(
  "reads the persisted tool answer from its bound interrupted run despite printed JSON and later runs",
  () =>
    withSession(({ frames, scripted, service, restart }) =>
      Effect.gen(function* () {
        scripted.childStatus = "running";
        const started = yield* service.start({
          threadId,
          loopId,
          roundId,
          role: "critic",
          evidence: frameInput(frames),
        });
        if (started.kind !== "started") return expect(started.kind).toBe("started");
        const caller = {
          threadId: started.childThreadId,
          providerInstanceId: builderSelection.instanceId,
        };
        const answer = { fundamentals, defects: [], doNotRegress: [] };
        expect((yield* service.report(caller, "critic", answer)).accepted).toBe(true);
        const input = { threadId, loopId, roundId, role: "critic" as const };
        expect(yield* service.answer(input)).toEqual({ kind: "pending" });
        scripted.childStatus = "interrupted";
        scripted.answer = criticText;
        scripted.extraChildRuns.push({
          id: RunId.make("run:later"),
          ordinal: 2,
          status: "running",
          answer: criticText,
        });
        const resumed = yield* restart();
        expect(yield* resumed.answer(input)).toEqual({
          kind: "critic",
          answer,
          raw: JSON.stringify(answer),
        });
      }),
    ),
);

it.live("printed JSON is only a fallback when the session never received tools", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.childStatus = "running";
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      if (started.kind !== "started") return expect(started.kind).toBe("started");
      const caller = {
        threadId: started.childThreadId,
        providerInstanceId: builderSelection.instanceId,
      };
      scripted.childStatus = "completed";
      scripted.answer = criticText;
      const input = { threadId, loopId, roundId, role: "critic" as const };
      expect((yield* service.answer(input)).kind).toBe("critic");
      scripted.childStatus = "running";
      expect(yield* service.toolRole(caller)).toBe("critic");
      scripted.childStatus = "completed";
      expect(yield* service.answer(input)).toMatchObject({
        kind: "invalid",
        reason: expect.stringContaining("without calling it successfully"),
      });
    }),
  ),
);

it.live("rejects a tool answer if its run binding or evidence hash changed", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.childStatus = "running";
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      if (started.kind !== "started") return expect(started.kind).toBe("started");
      const caller = {
        threadId: started.childThreadId,
        providerInstanceId: builderSelection.instanceId,
      };
      expect(
        (yield* service.report(caller, "critic", { fundamentals, defects: [], doNotRegress: [] }))
          .accepted,
      ).toBe(true);
      scripted.childStatus = "interrupted";
      const input = { threadId, loopId, roundId, role: "critic" as const };
      const directory = yield* service.evidenceDirectory(input);
      const file = NodePath.join(directory!, "..", "tool-answer.json");
      const recorded = yield* Effect.promise(async () =>
        JSON.parse(await NodeFSP.readFile(file, "utf8")),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(file, JSON.stringify({ ...recorded, runId: "another-run" })),
      );
      expect(yield* service.answer(input)).toMatchObject({
        kind: "invalid",
        reason: expect.stringContaining("another run or evidence hash"),
      });
      yield* Effect.promise(() => NodeFSP.writeFile(file, JSON.stringify(recorded)));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(directory!, "frames/frame-01.png"), "changed"),
      );
      expect(yield* service.answer(input)).toMatchObject({
        kind: "invalid",
        reason: expect.stringContaining("evidence changed"),
      });
    }),
  ),
);

it.live("an invalid tool attempt cannot be bypassed with a printed answer", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.childStatus = "running";
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      if (started.kind !== "started") return expect(started.kind).toBe("started");
      yield* service.report(
        { threadId: started.childThreadId, providerInstanceId: builderSelection.instanceId },
        "critic",
        {},
      );
      scripted.childStatus = "completed";
      scripted.answer = criticText;
      expect(yield* service.answer({ threadId, loopId, roundId, role: "critic" })).toMatchObject({
        kind: "invalid",
        reason: expect.stringContaining("schema"),
      });
    }),
  ),
);

it.live("accepts the full six-frame ballot budget for all four slots", () =>
  withSession(({ frames, service }) =>
    Effect.gen(function* () {
      const evidence = frameInput(frames);
      const ballotFrames = Array.from({ length: 24 }, (_, index) => ({
        id: `source-${index}`,
        label: `${"ABCD"[Math.floor(index / 6)]}: action ${index % 6}`,
        sourcePath: frames[index % frames.length]!,
      }));
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "ballot",
        evidence: { ...evidence, frames: ballotFrames },
      });
      expect(started.kind).toBe("started");
      expect(
        (yield* service.describe({ threadId, loopId, roundId, role: "ballot" }))?.frames,
      ).toHaveLength(24);
      const tooMany = yield* service
        .start({
          threadId,
          loopId,
          roundId,
          role: "ballot",
          order: 1,
          evidence: { ...evidence, frames: [...ballotFrames, ballotFrames[0]!] },
        })
        .pipe(Effect.flip);
      expect(tooMany.detail).toBe("At most 24 frames are evidence.");
    }),
  ),
);

it.live("fundamentals require typed verdicts and honest frame citations", () =>
  Effect.sync(() => {
    const known = { frameIds: new Set(["f1"]), checkIds: new Set<string>() };
    const answer = { fundamentals, defects: [], doNotRegress: [] };
    const parse = (judgment: unknown) =>
      GameReviewSessions.parseCriticAnswer(
        JSON.stringify({ ...answer, fundamentals: { ...fundamentals, respondsToInput: judgment } }),
        known,
      );
    expect(parse({ verdict: "no", frameIds: ["f1"], note: "Only scenery changes." }).kind).toBe(
      "valid",
    );
    expect(
      parse({ verdict: "cannot-tell", frameIds: [], note: "No interaction frame." }).kind,
    ).toBe("valid");
    expect(parse({ verdict: "no", frameIds: [], note: "No evidence." })).toMatchObject({
      kind: "invalid",
      reason: expect.stringContaining("needs a frame"),
    });
    expect(parse({ verdict: "yes", frameIds: ["f9"], note: "Unknown frame." })).toMatchObject({
      kind: "invalid",
      reason: expect.stringContaining("not in its manifest"),
    });
    expect(parse({ verdict: "maybe", frameIds: ["f1"], note: "Invalid enum." }).kind).toBe(
      "invalid",
    );
    expect(
      GameReviewSessions.parseCriticAnswer(JSON.stringify({ defects: [], doNotRegress: [] }), known)
        .kind,
    ).toBe("invalid");
  }),
);

it.live(
  "records active critic frames, validates citations and preserves hashes across restart",
  () =>
    withSession(({ service, restart, scripted, frames }) =>
      Effect.gen(function* () {
        scripted.childStatus = "running";
        const started = yield* service.start({
          threadId,
          loopId,
          roundId,
          role: "critic",
          evidence: frameInput(frames),
        });
        if (started.kind !== "started") return expect(started.kind).toBe("started");
        const caller = {
          threadId: started.childThreadId,
          providerInstanceId: builderSelection.instanceId,
        };
        expect(yield* service.toolRole(caller)).toBe("critic");
        scripted.viewport = { width: 1280, height: 720 };
        const result = yield* service.tryInput(caller, { steps: [{ press: "Space" }] });
        expect(result.consoleMessages).toEqual(tryResult.consoleMessages);
        expect(result.screenshots.map((frame) => frame.frameId)).toEqual(["try1f1", "try1f2"]);
        expect(result.screenshots[1]?.inputPair?.stateChanges).toEqual([
          { key: "state.score", before: 0, after: 1 },
        ]);
        expect(scripted.tries).toEqual([
          {
            threadId,
            buildId: "build-incumbent",
            input: {
              steps: [{ press: "Space" }],
              captureEveryMs: 1000,
              captureAllSteps: true,
              width: 640,
              height: 360,
            },
          },
        ]);
        const ref = yield* service.describe({ threadId, loopId, roundId, role: "critic" });
        expect(ref?.frames.map((frame) => frame.id)).toEqual(["f1", "f2", "try1f1", "try1f2"]);
        expect(ref?.hash).not.toBe(started.evidenceHash);
        const bytes = yield* Effect.promise(() => NodeFSP.readFile(ref!.frames[3]!.path));
        expect(bytes.toString()).toBe("png");
        const recorded = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(ref!.directory, "try-1.json"), "utf8"),
        );
        expect(JSON.parse(recorded)).toMatchObject({
          buildId: "build-incumbent",
          steps: [{ press: "Space" }],
          consoleMessages: tryResult.consoleMessages,
        });
        const resumed = yield* restart();
        expect(yield* resumed.toolRole(caller)).toBe("critic");
        const accepted = yield* resumed.report(caller, "critic", {
          fundamentals,
          defects: [
            {
              severity: "visible",
              what: "Observed fault",
              frameId: "try1f2",
              fix: "Fix and verify with input",
            },
          ],
          doNotRegress: [{ id: "working-input", what: "Input responds", frameId: "try1f1" }],
        });
        expect(accepted.accepted).toBe(true);
        expect(
          (yield* resumed.tryInput(caller, { steps: [{ press: "Space" }] }).pipe(Effect.flip))
            .detail,
        ).toContain("ended");
        scripted.childStatus = "interrupted";
        expect((yield* resumed.answer({ threadId, loopId, roundId, role: "critic" })).kind).toBe(
          "critic",
        );
      }),
    ),
);

it.live("bounds active calls durably and rejects invalid routes before launching", () =>
  withSession(({ service, restart, scripted, frames }) =>
    Effect.gen(function* () {
      scripted.childStatus = "running";
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      if (started.kind !== "started") return expect(started.kind).toBe("started");
      const caller = {
        threadId: started.childThreadId,
        providerInstanceId: builderSelection.instanceId,
      };
      expect(
        (yield* service
          .tryInput(caller, { steps: Array.from({ length: 13 }, () => ({ press: "w" })) })
          .pipe(Effect.flip)).detail,
      ).toContain("1–12 steps");
      expect(
        (yield* service
          .tryInput(caller, { buildId: "other", steps: [{ press: "w" }] })
          .pipe(Effect.flip)).detail,
      ).toContain("frozen build");
      expect(scripted.tries).toHaveLength(0);
      for (let call = 0; call < 6; call++) {
        const resumed = yield* restart();
        yield* resumed.tryInput(caller, { steps: [{ press: "Space" }] });
      }
      const resumed = yield* restart();
      expect(
        (yield* resumed.tryInput(caller, { steps: [{ press: "Space" }] }).pipe(Effect.flip)).detail,
      ).toBe("game_try_input exhausted its 6 calls for this session.");
      expect(scripted.tries).toHaveLength(6);
      const ref = yield* resumed.describe({ threadId, loopId, roundId, role: "critic" });
      expect(ref?.frames).toHaveLength(14);
      expect(new Set(ref?.frames.map((frame) => frame.id)).size).toBe(14);
    }),
  ),
);

it.live("ballots cannot play and their frozen evidence remains unchanged", () =>
  withSession(({ service, scripted, frames }) =>
    Effect.gen(function* () {
      scripted.childStatus = "running";
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "ballot",
        evidence: frameInput(frames),
      });
      if (started.kind !== "started") return expect(started.kind).toBe("started");
      const error = yield* service
        .tryInput(
          { threadId: started.childThreadId, providerInstanceId: builderSelection.instanceId },
          { steps: [{ press: "Space" }] },
        )
        .pipe(Effect.flip);
      expect(error.detail).toContain("ballots compare frozen evidence only");
      expect(scripted.tries).toHaveLength(0);
      expect(yield* service.evidenceHash({ threadId, loopId, roundId, role: "ballot" })).toBe(
        started.evidenceHash,
      );
    }),
  ),
);

it.live("builders and repair children can verify their exported game before submitting", () =>
  withSession(({ service, scripted }) =>
    Effect.gen(function* () {
      scripted.builderStatus = "running";
      yield* service.tryInput(
        { threadId, providerInstanceId: builderSelection.instanceId },
        { steps: [{ press: "Space" }] },
      );
      scripted.builderStatus = "completed";
      scripted.childStatus = "running";
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "repair",
        repair: { remainingBudget: "1 repair", defects: [], doNotRegress: [] },
      });
      if (started.kind !== "started") return expect(started.kind).toBe("started");
      yield* service.tryInput(
        { threadId: started.childThreadId, providerInstanceId: builderSelection.instanceId },
        { steps: [{ click: "left" }] },
      );
      expect(scripted.tries.map((call) => call.threadId)).toEqual([
        threadId,
        started.childThreadId,
      ]);
      expect(
        (yield* service
          .tryInput(
            { threadId: started.childThreadId, providerInstanceId: overrideSelection.instanceId },
            { steps: [{ press: "Space" }] },
          )
          .pipe(Effect.flip)).detail,
      ).toContain("active provider run");
      scripted.childStatus = "completed";
      expect(
        (yield* service
          .tryInput(
            { threadId: started.childThreadId, providerInstanceId: builderSelection.instanceId },
            { steps: [{ press: "Space" }] },
          )
          .pipe(Effect.flip)).detail,
      ).toContain("active provider run");
    }),
  ),
);

it.live("active input cannot legitimize changed critic evidence", () =>
  withSession(({ service, scripted, frames }) =>
    Effect.gen(function* () {
      scripted.childStatus = "running";
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      if (started.kind !== "started") return expect(started.kind).toBe("started");
      const directory = yield* service.evidenceDirectory({
        threadId,
        loopId,
        roundId,
        role: "critic",
      });
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(directory!, "frames/frame-01.png"), "tampered"),
      );
      expect(
        (yield* service
          .tryInput(
            { threadId: started.childThreadId, providerInstanceId: builderSelection.instanceId },
            { steps: [{ press: "Space" }] },
          )
          .pipe(Effect.flip)).detail,
      ).toContain("evidence changed");
      expect(scripted.tries).toHaveLength(0);
    }),
  ),
);
