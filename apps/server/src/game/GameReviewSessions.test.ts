// @effect-diagnostics nodeBuiltinImport:off -- The review session test writes real evidence and record directories.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { PNG } from "pngjs";
import {
  CommandId,
  GAME_REVIEW_ANSWER_MAX_BYTES,
  GameOperationError,
  type GameManifest,
  type GameStatus,
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
import * as GameDesignApproval from "./GameDesignApproval.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameReviewSessions from "./GameReviewSessions.ts";
import * as GameRoundStore from "./GameRoundStore.ts";
import { playtest } from "./GameWebPlaytest.ts";
import { previewBrowserRelease } from "../preview/PreviewBrowser.ts";
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
  evidenceDirectory: "/private/internal-experiment",
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
  liveResult?: GameWebPlaytestResult;
  tryScreenshots?: GameWebPlaytestResult["screenshots"];
  readonly tries: Array<{ threadId: ThreadId; buildId: string; input: GameWebPlaytestInput }>;
  builderStatus: OrchestrationV2Run["status"];
  viewport: { width: number; height: number };
  /** The play's capture multiple; undefined means older evidence played at base. */
  captureScale: number | undefined;
  tryGate: (() => Effect.Effect<void>) | null;
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
  /** Approved acceptance the mocked design snapshot binds; null means legacy/no record. */
  designAcceptance: ReadonlyArray<{
    readonly id: string;
    readonly kind: "control" | "mechanic" | "content" | "win" | "lose" | "presentation";
    readonly text: string;
    readonly observe?: { readonly key: string; readonly expect: string };
  }> | null;
  designReadFails?: boolean;
}

const makeScripted = (): Scripted => ({
  tries: [],
  builderStatus: "completed",
  viewport: { width: 640, height: 360 },
  captureScale: undefined,
  tryGate: null,
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
  designAcceptance: null,
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
                  qualification: {
                    servedArtifactId: "preview-id",
                    stages: [{ stage: "export", status: "passed", buildId: "build-incumbent" }],
                  },
                } as unknown as GameStatus),
              webPlaytestBuild: (threadId, buildId, input) =>
                Effect.gen(function* () {
                  scripted.tries.push({ threadId, buildId, input });
                  if (scripted.tryGate !== null) yield* scripted.tryGate();
                  const result = {
                    ...(scripted.liveResult ?? tryResult),
                    screenshots:
                      scripted.tryScreenshots ??
                      scripted.liveResult?.screenshots ??
                      tryResult.screenshots,
                  };
                  return scripted.captureScale === undefined
                    ? result
                    : {
                        ...result,
                        baseViewport: scripted.viewport,
                        captureScale: scripted.captureScale,
                      };
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
                    ...(scripted.captureScale === undefined
                      ? {}
                      : { captureScale: scripted.captureScale }),
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
          Layer.provide(
            Layer.mock(GameDesignApproval.GameDesignApproval)({
              snapshot: () =>
                scripted.designReadFails
                  ? Effect.fail(
                      new GameOperationError({
                        operation: "read-design",
                        path: root,
                        reason: "io",
                        detail: "Design record unreadable",
                      }),
                    )
                  : Effect.succeed({
                      read: {
                        state: "approved",
                        document: null,
                        documentTruncated: false,
                        approvedHash: "design-hash",
                        currentHash: "design-hash",
                        approvedAt: "2026-10-23T00:00:00.000Z",
                        acceptance: [...(scripted.designAcceptance ?? [])],
                        issues: [],
                        pendingRevision: null,
                        revisionDiff: null,
                      },
                      record:
                        scripted.designAcceptance === null
                          ? null
                          : {
                              schemaVersion: 1 as const,
                              game: root,
                              approvalId: "approval-1",
                              designHash: "design-hash",
                              approvedAt: "2026-10-23T00:00:00.000Z",
                              acceptance: [...scripted.designAcceptance],
                            },
                    }),
            }),
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

/** Modern exact-once quality coverage for session fixtures: every dimension judged. */
const quality = {
  artConsistency: { verdict: "yes" as const, frameIds: ["f1", "f2"], note: "Own look holds." },
  animation: {
    verdict: "cannot-tell" as const,
    frameIds: [],
    note: "One pose cannot show motion.",
  },
  audio: { verdict: "cannot-tell" as const, frameIds: [], note: "No audio evidence attached." },
  readability: { verdict: "yes" as const, frameIds: ["f1"], note: "State legible." },
  progression: { verdict: "cannot-tell" as const, frameIds: [], note: "Route too short." },
  agency: { verdict: "cannot-tell" as const, frameIds: [], note: "No distinct choice observed." },
  playability: { verdict: "yes" as const, frameIds: ["f1", "f2"], note: "Player can act." },
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
  quality,
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
      expect(command.task).toContain("A terminal JSON answer uses exactly the same schema");
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

it.live("the evidence manifest carries every capture size, played and window", () =>
  withSession(({ frames, service }) =>
    Effect.gen(function* () {
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: {
          frames: [
            {
              id: "incumbent-boot",
              label: "boot",
              sourcePath: frames[0]!,
              width: 1280,
              height: 720,
            },
            {
              id: "incumbent-window",
              label: "window 900x900: boot",
              sourcePath: frames[1]!,
              width: 900,
              height: 900,
            },
          ],
          checks: [],
        },
      });
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      const directory = yield* service.evidenceDirectory({
        threadId,
        loopId,
        roundId,
        role: "critic",
        order: 0,
      });
      const manifest = JSON.parse(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(directory!, "evidence.json"), "utf8"),
        ),
      ) as { frames: Array<{ id: string; width?: number; height?: number }> };
      // One folder, two window shapes: the labels name the window and the
      // manifest carries its numbers, so a viewer never has to guess.
      expect(manifest.frames.map(({ width, height }) => [width, height])).toEqual([
        [1280, 720],
        [900, 900],
      ]);
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

it.live("marks only a repair child for the reduced catalog and keeps its input route", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.childStatus = "running";
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
      if (repair.kind !== "started") return expect(repair.kind).toBe("started");
      const caller = {
        threadId: repair.childThreadId,
        providerInstanceId: builderSelection.instanceId,
      };
      expect(yield* service.repairChild(caller)).toBe(true);
      // The catalog marker must not turn a repair into an answer-bearing role.
      expect(yield* service.toolRole(caller)).toBeNull();
      // A repair keeps the same mutable input route as a builder.
      expect((yield* service.tryInput(caller, { steps: [{ press: "Space" }] })).success).toBe(true);

      const critic = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      if (critic.kind !== "started") return expect(critic.kind).toBe("started");
      expect(
        yield* service.repairChild({
          threadId: critic.childThreadId,
          providerInstanceId: builderSelection.instanceId,
        }),
      ).toBe(false);
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

it.live("the control pair is the same captured frames written twice", () =>
  withSession(({ frames, service }) =>
    Effect.gen(function* () {
      const control = (id: string, label: string, path: string) => ({
        id,
        label,
        sourcePath: path,
      });
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "ballot",
        evidence: {
          frames: [
            control("c1", "C: boot", frames[0]!),
            control("c2", "C: action", frames[1]!),
            control("d1", "D: boot", frames[0]!),
            control("d2", "D: action", frames[1]!),
          ],
          checks: [],
        },
        items: [],
      });
      expect(started.kind).toBe("started");
      const directory = yield* service.evidenceDirectory({
        threadId,
        loopId,
        roundId,
        role: "ballot",
      });
      expect(directory).not.toBeNull();
      const manifest = JSON.parse(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(directory!, "evidence.json"), "utf8"),
        ),
      ) as { frames: ReadonlyArray<{ label: string; file: string }> };
      const bytes = (label: string) => {
        const frame = manifest.frames.find((entry) => entry.label === label);
        expect(frame).toBeDefined();
        return NodeFSP.readFile(NodePath.join(directory!, frame!.file));
      };
      const [cBoot, dBoot, cAction, dAction] = yield* Effect.promise(() =>
        Promise.all([bytes("C: boot"), bytes("D: boot"), bytes("C: action"), bytes("D: action")]),
      );
      // Position bias is the only difference a control ballot can be reacting to.
      expect(cBoot.equals(dBoot)).toBe(true);
      expect(cAction.equals(dAction)).toBe(true);
    }),
  ),
);

it.live("a ballot pair becomes one composed card and keeps both originals", () =>
  withSession(({ stateDir, service }) =>
    Effect.gen(function* () {
      const sources = NodePath.join(stateDir, "pair-sources");
      const solid = (color: readonly [number, number, number]) => {
        const png = new PNG({ width: 64, height: 36 });
        for (let at = 0; at < png.data.length; at += 4) {
          png.data[at] = color[0];
          png.data[at + 1] = color[1];
          png.data[at + 2] = color[2];
          png.data[at + 3] = 255;
        }
        return PNG.sync.write(png);
      };
      const beforePath = NodePath.join(sources, "before.png");
      const afterPath = NodePath.join(sources, "after.png");
      const before = solid([200, 20, 20]);
      const after = solid([20, 20, 200]);
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(sources, { recursive: true });
        await NodeFSP.writeFile(beforePath, before);
        await NodeFSP.writeFile(afterPath, after);
      });
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "ballot",
        evidence: {
          frames: [
            {
              id: "c1",
              label: "C: input 1 (before | after): held d 1000ms",
              sourcePath: beforePath,
              pair: { beforePath, afterPath, caption: "held d 1000ms" },
            },
          ],
          checks: [],
        },
        items: [],
      });
      expect(started.kind).toBe("started");
      const directory = yield* service.evidenceDirectory({
        threadId,
        loopId,
        roundId,
        role: "ballot",
      });
      expect(directory).not.toBeNull();
      const manifest = JSON.parse(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(directory!, "evidence.json"), "utf8"),
        ),
      ) as { frames: ReadonlyArray<{ id: string; file: string; label: string }> };
      expect(manifest.frames).toHaveLength(1);
      const card = PNG.sync.read(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(directory!, manifest.frames[0]!.file)),
        ),
      );
      expect(card.width).toBe(64 + 8 + 64);
      expect(card.height).toBeGreaterThan(36);
      // The two exact captures are still in the evidence directory, byte for byte.
      const [keptBefore, keptAfter] = yield* Effect.promise(() =>
        Promise.all([
          NodeFSP.readFile(NodePath.join(directory!, "frames/source/frame-01-before.png")),
          NodeFSP.readFile(NodePath.join(directory!, "frames/source/frame-01-after.png")),
        ]),
      );
      expect(keptBefore.equals(before)).toBe(true);
      expect(keptAfter.equals(after)).toBe(true);
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
    const recipeIds = new Set(["feel.buffer"]);
    const items = ["turns"];

    expect(
      GameReviewSessions.parseCriticAnswer("not json", {
        frameIds: frames,
        checkIds: checks,
        recipeIds,
      }).kind,
    ).toBe("invalid");
    expect(
      GameReviewSessions.parseCriticAnswer(
        JSON.stringify({ defects: [], doNotRegress: [], score: 9 }),
        { frameIds: frames, checkIds: checks, recipeIds },
      ).kind,
    ).toBe("invalid");
    expect(
      GameReviewSessions.parseCriticAnswer(
        JSON.stringify({ defects: [], doNotRegress: [{ id: "x", what: "y", frameId: "f9" }] }),
        { frameIds: frames, checkIds: checks, recipeIds },
      ).kind,
    ).toBe("invalid");
    expect(
      GameReviewSessions.parseCriticAnswer(
        JSON.stringify({
          defects: [],
          doNotRegress: [{ id: "x", what: "y", frameId: "f1", checkId: "unmeasured" }],
        }),
        { frameIds: frames, checkIds: checks, recipeIds },
      ).kind,
    ).toBe("invalid");
    expect(
      GameReviewSessions.parseCriticAnswer(JSON.stringify({ defects: [] }), {
        frameIds: frames,
        checkIds: checks,
        recipeIds,
      }).kind,
    ).toBe("invalid");

    // JSON.parse keeps the last duplicate. Accepting that would let the second
    // member erase the reported defects, so a repeat is invalid at any depth.
    const duplicateTopLevel = GameReviewSessions.parseCriticAnswer(
      '{"defects":[{"severity":"visible","what":"x","frameId":"f1","fix":"y"}],"defects":[],"doNotRegress":[]}',
      { frameIds: frames, checkIds: checks, recipeIds },
    );
    expect(duplicateTopLevel.kind).toBe("invalid");
    if (duplicateTopLevel.kind === "invalid") expect(duplicateTopLevel.reason).toContain("repeats");
    expect(
      GameReviewSessions.parseCriticAnswer(
        '{"defects":[{"severity":"visible","what":"x","frameId":"f1","fix":"y","fix":"z"}],"doNotRegress":[]}',
        { frameIds: frames, checkIds: checks, recipeIds },
      ).kind,
    ).toBe("invalid");
    // Deep nesting that fits the byte limit is an invalid answer, not a stack
    // overflow, and a repeat behind it is still found.
    const deep = `{"defects":${"[".repeat(8_000)}${"]".repeat(8_000)},"doNotRegress":[]}`;
    expect(Buffer.byteLength(deep, "utf8")).toBeLessThan(16 * 1024);
    expect(
      GameReviewSessions.parseCriticAnswer(deep, { frameIds: frames, checkIds: checks, recipeIds })
        .kind,
    ).toBe("invalid");
    const deepRepeat = GameReviewSessions.parseCriticAnswer(
      `{"x":${"[".repeat(8_000)}{"a":1,"a":2}${"]".repeat(8_000)}}`,
      { frameIds: frames, checkIds: checks, recipeIds },
    );
    expect(deepRepeat.kind).toBe("invalid");
    if (deepRepeat.kind === "invalid") expect(deepRepeat.reason).toContain('"a"');

    // A defect may name a recipe the critic fetched; the field is optional and
    // only shipped ids pass, so the repair can fetch exactly that reference.
    const withRecipe = (recipeId?: string) =>
      JSON.stringify({
        fundamentals,
        defects: [
          {
            severity: "visible",
            what: "The jump feels unresponsive.",
            frameId: "f2",
            fix: "Buffer the jump input; yes/no: a jump pressed just before landing still fires.",
            ...(recipeId === undefined ? {} : { recipeId }),
          },
        ],
        doNotRegress: [],
      });
    const plain = GameReviewSessions.parseCriticAnswer(withRecipe(), {
      frameIds: frames,
      checkIds: checks,
      recipeIds,
    });
    expect(plain.kind).toBe("valid");
    if (plain.kind === "valid") expect(plain.answer.defects[0]?.recipeId).toBeUndefined();
    const known = GameReviewSessions.parseCriticAnswer(withRecipe("feel.buffer"), {
      frameIds: frames,
      checkIds: checks,
      recipeIds,
    });
    expect(known.kind).toBe("valid");
    if (known.kind === "valid") expect(known.answer.defects[0]?.recipeId).toBe("feel.buffer");
    const unknown = GameReviewSessions.parseCriticAnswer(withRecipe("invented-recipe"), {
      frameIds: frames,
      checkIds: checks,
      recipeIds,
    });
    expect(unknown.kind).toBe("invalid");
    if (unknown.kind === "invalid")
      expect(unknown.reason).toContain("recipe invented-recipe, which is not in the catalog");

    const ballot = (overrides: Record<string, unknown> = {}) =>
      JSON.stringify({
        overall: "A",
        overallReason: "The input pair shows clearer action feedback.",
        defects: [],
        regressions: { A: [], B: [] },
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
    expect(
      GameReviewSessions.parseBallotAnswer(ballot({ works: "A" }), {
        frameIds: frames,
        itemIds: items,
      }).kind,
    ).toBe("invalid");
  }),
);

it.live("recipe catalog calls are counted per thread for review usage", () =>
  withSession(({ service }) =>
    Effect.gen(function* () {
      expect(yield* service.recipeCalls(threadId)).toBe(0);
      yield* service.noteRecipeCall(threadId);
      yield* service.noteRecipeCall(threadId);
      expect(yield* service.recipeCalls(threadId)).toBe(2);
      // Another thread's calls are not this one's.
      expect(yield* service.recipeCalls(ThreadId.make("thread:someone-else"))).toBe(0);
    }),
  ),
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
        answer: JSON.stringify({ fundamentals, defects: [], doNotRegress: [], quality }),
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
    const known = {
      frameIds: new Set(["f1"]),
      checkIds: new Set(["boot"]),
      recipeIds: new Set<string>(),
    };
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
        quality,
      });
      expect(accepted).toEqual({
        accepted: true,
        error: null,
        attemptsRemaining: 0,
        ended: true,
        // Exact absolute-quality coverage rides with the accepted report.
        qualityCoverage: { rubricVersion: 2, assessed: 7, total: 7, unknowns: 4 },
      });
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
        const answer = { fundamentals, defects: [], doNotRegress: [], quality };
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
        defects: [{ id: "defect-1", severity: "visible", what: "Clipped HUD", fix: "Fit the HUD" }],
      });
      if (started.kind !== "started") return expect(started.kind).toBe("started");
      const caller = {
        threadId: started.childThreadId,
        providerInstanceId: builderSelection.instanceId,
      };
      const command = scripted.dispatches[0]!;
      if (command.type !== "game-round.task.request") return;
      expect(command.task).toContain("Call game_ballot");
      expect(command.task).toContain("Clipped HUD");
      expect(command.task).toContain("Fit the HUD");
      expect(command.task).toContain('"overall":"tie"');
      expect(command.task).toContain('"overallReason"');
      expect(command.task).toContain(
        '"works":"tie","look":"tie","feel":"tie","play":"tie","defects"',
      );
      expect(command.task).toContain("A terminal JSON answer uses exactly the same schema");
      expect(command.task).toContain("unknown is neutral");
      const value = {
        overall: "A",
        overallReason: "The input pair shows clearer action feedback.",
        defects: [
          {
            id: "defect-1",
            A: { fixed: "yes", frameIds: ["f1"] },
            B: { fixed: "no", frameIds: ["f2"] },
          },
        ],
        regressions: { A: [], B: [] },
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
        const answer = { fundamentals, defects: [], doNotRegress: [], quality };
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
          qualityRubricVersion: 2,
        });
      }),
    ),
);

it.live("a completed ballot can submit the same payload without using its offered tool", () =>
  withSession(({ frames, scripted, service }) =>
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
      expect(
        yield* service.toolRole({
          threadId: started.childThreadId,
          providerInstanceId: builderSelection.instanceId,
        }),
      ).toBe("ballot");
      scripted.answer = JSON.stringify({
        overall: "tie",
        overallReason: "Both builds show the same interaction.",
        works: "tie",
        look: "tie",
        feel: "tie",
        play: "tie",
        defects: [],
        regressions: { A: [], B: [] },
        preservation: [],
        control: { works: "tie", look: "tie", feel: "tie", play: "tie" },
        reason: "f1 and f2 show the same input response.",
      });
      scripted.childStatus = "completed";
      const result = yield* service.answer({ threadId, loopId, roundId, role: "ballot" });
      expect(result.kind).toBe("ballot");
      if (result.kind === "ballot") expect(result.answer.main.works).toBe("tie");
    }),
  ),
);

it.live("a first terminal answer remains valid when tools were offered but unused", () =>
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
      expect((yield* service.answer(input)).kind).toBe("critic");
    }),
  ),
);

it.live("an unused review tool never makes an unsuccessful run's final text valid", () =>
  Effect.gen(function* () {
    for (const status of ["failed", "cancelled", "interrupted"] as const) {
      yield* withSession(({ frames, scripted, service }) =>
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
          yield* service.toolRole({
            threadId: started.childThreadId,
            providerInstanceId: builderSelection.instanceId,
          });
          scripted.answer = criticText;
          scripted.childStatus = status;
          const answer = yield* service.answer({ threadId, loopId, roundId, role: "critic" });
          expect(answer.kind, status).toBe("invalid");
          if (answer.kind === "invalid") expect(answer.reason).toContain(`ended ${status}`);
        }),
      );
    }
  }),
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
        (yield* service.report(caller, "critic", {
          fundamentals,
          defects: [],
          doNotRegress: [],
          quality,
        })).accepted,
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

it.live("accepts all cited ballot frames and bounds the evidence manifest", () =>
  withSession(({ frames, service }) =>
    Effect.gen(function* () {
      const evidence = frameInput(frames);
      const ballotFrames = Array.from({ length: 564 }, (_, index) => ({
        id: `source-${index}`,
        label: `${"ABCD"[Math.floor(index / 96)]}: action ${index % 6}`,
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
      ).toHaveLength(564);
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
      expect(tooMany.detail).toBe("At most 564 frames are evidence.");
    }),
  ),
);

it.live("fundamentals require typed verdicts and honest frame citations", () =>
  Effect.sync(() => {
    const known = {
      frameIds: new Set(["f1"]),
      checkIds: new Set<string>(),
      recipeIds: new Set<string>(),
    };
    // Legacy evidence frozen before the rubric: no quality field, judged on
    // fundamentals alone and never read as a quality verdict.
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
        expect(result.evidenceDirectory).toBe(".");
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
          quality,
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

it.live("freezes the routes of the critic's cited experiments", () =>
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
      const caller = {
        threadId: started.childThreadId,
        providerInstanceId: builderSelection.instanceId,
      };
      yield* service.tryInput(caller, {
        steps: [{ key: "ArrowRight", holdMs: 250 }],
        captureEveryMs: 125,
      });
      const accepted = yield* service.report(caller, "critic", {
        fundamentals,
        defects: [],
        doNotRegress: [{ id: "turns", what: "Turning still works.", frameId: "try1f1" }],
        quality,
      });
      expect(accepted.accepted).toBe(true);
      const routes = yield* service.experiments({
        threadId,
        loopId,
        roundId,
        frameIds: ["f1", "try1f1", "try1f2"],
      });
      expect(routes).toEqual([
        {
          id: "try-1",
          buildId: "build-incumbent",
          steps: [{ key: "ArrowRight", holdMs: 250 }],
          captureEveryMs: 125,
          viewport: { width: 640, height: 360 },
          frames: [
            { frameId: "try1f1", label: "input 1 before", stepIndex: 0 },
            { frameId: "try1f2", label: "input 1 after", stepIndex: 0 },
          ],
        },
      ]);
      expect(
        yield* service.experiments({
          threadId,
          loopId,
          roundId,
          frameIds: ["f1"],
        }),
      ).toEqual([]);
    }),
  ),
);

it.live("freezes a cited interval frame's identity and elapsed time", () =>
  withSession(({ service, scripted, frames }) =>
    Effect.gen(function* () {
      scripted.childStatus = "running";
      scripted.tryScreenshots = [
        ...tryResult.screenshots,
        {
          label: "step 1 during: 127ms",
          mimeType: "image/png",
          data: "cG5n",
          width: 640,
          height: 360,
        },
      ];
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      if (started.kind !== "started") return expect(started.kind).toBe("started");
      yield* service.tryInput(
        { threadId: started.childThreadId, providerInstanceId: builderSelection.instanceId },
        { steps: [{ hold: "Space", holdMs: 500 }], captureEveryMs: 125 },
      );
      const routes = yield* service.experiments({
        threadId,
        loopId,
        roundId,
        frameIds: ["try1f3", "try1f3"],
      });
      expect(routes[0]?.frames).toEqual([
        { frameId: "try1f3", label: "step 1 during: 127ms", stepIndex: 0, observationMs: 127 },
      ]);
    }),
  ),
);

it.live("replays a critic's scaled route in the window it was played in", () =>
  withSession(({ service, scripted, frames }) =>
    Effect.gen(function* () {
      scripted.viewport = { width: 640, height: 360 };
      scripted.captureScale = 2;
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
      yield* service.tryInput(caller, { steps: [{ click: "left", x: 640, y: 400 }] });
      expect(scripted.tries.at(-1)?.input).toMatchObject({
        width: 1280,
        height: 720,
      });
      const accepted = yield* service.report(caller, "critic", {
        fundamentals,
        defects: [],
        doNotRegress: [{ id: "turns", what: "Turning still works.", frameId: "try1f1" }],
        quality,
      });
      expect(accepted.accepted).toBe(true);
      const routes = yield* service.experiments({
        threadId,
        loopId,
        roundId,
        frameIds: ["try1f1"],
      });
      expect(routes[0]?.viewport).toEqual({ width: 1280, height: 720 });
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
          .tryInput(caller, { steps: [{ keys: ["ui_accept"], holdMs: 100 }] })
          .pipe(Effect.flip)).detail,
      ).toContain('"ui_accept" is not a browser key');
      expect(
        (yield* service
          .tryInput(caller, { buildId: "other", steps: [{ press: "w" }] })
          .pipe(Effect.flip)).detail,
      ).toContain("frozen build");
      expect(scripted.tries).toHaveLength(0);
      for (let call = 0; call < 6; call++) {
        const resumed = yield* restart();
        yield* resumed.tryInput(caller, { steps: [{ press: "Space" }] });
        expect(
          yield* resumed.inputCalls(started.childThreadId, RunId.make("run:review-child")),
        ).toBe(call + 1);
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

const detailPng = (
  width: number,
  height: number,
  base: readonly [number, number, number],
  patches: ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    readonly color: readonly [number, number, number];
  }>,
): Buffer => {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const patch = patches.find(
        (entry) => x >= entry.x && x < entry.x + entry.w && y >= entry.y && y < entry.y + entry.h,
      );
      const [red, green, blue] = patch?.color ?? base;
      const at = (y * width + x) * 4;
      png.data[at] = red;
      png.data[at + 1] = green;
      png.data[at + 2] = blue;
      png.data[at + 3] = 255;
    }
  return PNG.sync.write(png);
};

const WARM_PATCH = { x: 40, y: 10, w: 16, h: 16, color: [184, 136, 72] as const };
const FLAT_BASE = [101, 113, 175] as const;

it.live("critics crop a native-resolution detail without changing the evidence", () =>
  withSession(({ service, scripted, frames }) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          frames[0]!,
          detailPng(64, 48, FLAT_BASE, [{ ...WARM_PATCH, color: [...WARM_PATCH.color] }]),
        ),
      );
      yield* Effect.promise(() => NodeFSP.writeFile(frames[1]!, detailPng(64, 48, FLAT_BASE, [])));
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
      const view = yield* service.inspectDetail(caller, {
        frameId: "f1",
        x: 40,
        y: 10,
        width: 16,
        height: 16,
      });
      expect(view.screenshots).toHaveLength(1);
      expect(view.screenshots[0]).toMatchObject({ width: 32, height: 32 });
      expect(view.detail).toMatchObject({
        frameId: "f1",
        x: 40,
        y: 10,
        width: 16,
        height: 16,
        scale: 2,
        sourceWidth: 64,
        sourceHeight: 48,
        pair: false,
      });
      expect(view.detail.regions).toEqual([{ name: "frame", mean: [184, 136, 72], pixels: 256 }]);
      expect(view.detail.delta).toBeUndefined();
      const pixels = PNG.sync.read(Buffer.from(view.screenshots[0]!.data, "base64"));
      expect([pixels.data[0], pixels.data[1], pixels.data[2], pixels.data[3]]).toEqual([
        184, 136, 72, 255,
      ]);
      // A read-only crop cannot move the hash the answer validates against.
      expect(yield* service.evidenceHash({ threadId, loopId, roundId, role: "critic" })).toBe(
        started.evidenceHash,
      );
      expect(
        yield* service.detailCalls(started.childThreadId, RunId.make("run:review-child")),
      ).toBe(1);
      const accepted = yield* service.report(caller, "critic", {
        fundamentals,
        defects: [],
        doNotRegress: [{ id: "flat-roof", what: "The roof stays flat blue.", frameId: "f1" }],
        quality,
      });
      expect(accepted.accepted).toBe(true);
    }),
  ),
);

it.live("ballots compare the same region on both halves of a pair card", () =>
  withSession(({ service, scripted, frames }) =>
    Effect.gen(function* () {
      const beforePath = NodePath.join(NodePath.dirname(frames[0]!), "pair-before.png");
      const afterPath = NodePath.join(NodePath.dirname(frames[0]!), "pair-after.png");
      yield* Effect.promise(() => NodeFSP.writeFile(beforePath, detailPng(64, 48, FLAT_BASE, [])));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          afterPath,
          detailPng(64, 48, FLAT_BASE, [{ ...WARM_PATCH, color: [...WARM_PATCH.color] }]),
        ),
      );
      scripted.childStatus = "running";
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "ballot",
        evidence: {
          frames: [
            {
              id: "pair-source",
              label: "A: held ArrowRight 1000ms",
              sourcePath: beforePath,
              pair: { beforePath, afterPath, caption: "held ArrowRight 1000ms" },
            },
          ],
          checks: [],
        },
      });
      if (started.kind !== "started") return expect(started.kind).toBe("started");
      const caller = {
        threadId: started.childThreadId,
        providerInstanceId: builderSelection.instanceId,
      };
      const view = yield* service.inspectDetail(caller, {
        frameId: "f1",
        x: 40,
        y: 10,
        width: 16,
        height: 16,
        scale: 2,
      });
      expect(view.screenshots).toHaveLength(1);
      // Both halves keep their native pixels at the same scale, side by side.
      expect(view.screenshots[0]).toMatchObject({ width: 16 * 2 + 8 + 16 * 2 });
      expect(view.detail.pair).toBe(true);
      expect(view.detail.regions).toEqual([
        { name: "before", mean: [101, 113, 175], pixels: 256 },
        { name: "after", mean: [184, 136, 72], pixels: 256 },
      ]);
      expect(view.detail.delta).toEqual({ meanAbs: [83, 23, 103], changedPercent: 100 });
      expect(yield* service.evidenceHash({ threadId, loopId, roundId, role: "ballot" })).toBe(
        started.evidenceHash,
      );
    }),
  ),
);

it.live("detail views refuse strangers, bad regions and exhausted budgets", () =>
  withSession(({ service, scripted, frames }) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => NodeFSP.writeFile(frames[0]!, detailPng(64, 48, FLAT_BASE, [])));
      yield* Effect.promise(() => NodeFSP.writeFile(frames[1]!, detailPng(64, 48, FLAT_BASE, [])));
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
          .inspectDetail(caller, { frameId: "f9", x: 0, y: 0, width: 16, height: 16 })
          .pipe(Effect.flip)).detail,
      ).toContain("Unknown frame");
      expect(
        (yield* service
          .inspectDetail(caller, { frameId: "f1", x: 60, y: 10, width: 16, height: 16 })
          .pipe(Effect.flip)).detail,
      ).toContain("extends past the 64x48");
      expect(
        (yield* service
          .inspectDetail(
            { threadId, providerInstanceId: builderSelection.instanceId },
            { frameId: "f1", x: 0, y: 0, width: 16, height: 16 },
          )
          .pipe(Effect.flip)).detail,
      ).toContain("only available to the active critic or ballot session");
      for (let call = 0; call < 6; call++)
        yield* service.inspectDetail(caller, { frameId: "f1", x: 0, y: 0, width: 16, height: 16 });
      expect(
        yield* service.detailCalls(started.childThreadId, RunId.make("run:review-child")),
      ).toBe(6);
      expect(
        (yield* service
          .inspectDetail(caller, { frameId: "f1", x: 0, y: 0, width: 16, height: 16 })
          .pipe(Effect.flip)).detail,
      ).toContain("exhausted its 6 calls");
    }),
  ),
);

it.live("detail views reject oversized PNG dimensions before decoding pixels", () =>
  withSession(({ service, scripted, frames }) =>
    Effect.gen(function* () {
      const png = PNG.sync.write(new PNG({ width: 8, height: 8 }));
      png.writeUInt32BE(500_000, 16);
      yield* Effect.promise(() => NodeFSP.writeFile(frames[0]!, png));
      scripted.childStatus = "running";
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      if (started.kind !== "started") return expect(started.kind).toBe("started");
      const error = yield* service
        .inspectDetail(
          { threadId: started.childThreadId, providerInstanceId: builderSelection.instanceId },
          { frameId: "f1", x: 0, y: 0, width: 8, height: 8 },
        )
        .pipe(Effect.flip);
      expect(error.reason).toBe("invalid-input");
      expect(error.detail).toContain("500000x8 frame is outside");
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

it.live("playing in one session does not block unrelated MCP authentication", () =>
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
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      scripted.tryGate = () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(finish);
        });
      const playing = yield* service
        .tryInput(
          { threadId: started.childThreadId, providerInstanceId: builderSelection.instanceId },
          { steps: [{ press: "Space" }] },
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      expect(
        yield* service.toolRole({ threadId, providerInstanceId: builderSelection.instanceId }),
      ).toBeNull();
      yield* Deferred.succeed(finish, undefined);
      expect((yield* Fiber.join(playing)).screenshots).toHaveLength(2);
    }),
  ),
);

it.live("an unreadable design cannot silently dispatch a review without its requirements", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.designReadFails = true;
      const error = yield* service
        .start({ threadId, loopId, roundId, role: "critic", evidence: frameInput(frames) })
        .pipe(Effect.flip);
      expect(error.reason).toBe("io");
      expect(scripted.dispatches).toHaveLength(0);
    }),
  ),
);

it.live("an approved design reaches the critic as bounded requirements, not source", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = [
        { id: "warm-glow", kind: "presentation", text: "Lit lanterns cast a warm glow" },
        {
          id: "collect-two",
          kind: "content",
          text: "The player collects two lanterns",
        },
      ];
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      const command = scripted.dispatches[0]!;
      expect(command.type).toBe("game-round.task.request");
      if (command.type !== "game-round.task.request") return;
      // The critic prompt names the bounded requirements file and how to judge it.
      expect(command.task).toContain("DESIGN_REQUIREMENTS.md (approved design requirements)");
      expect(command.task).toContain("report an unmet one as a defect with frames");
      expect(command.task).toContain("never as met");
      const files = yield* Effect.promise(() => walk(command.evidenceDirectory!));
      expect(files).toContain("DESIGN_REQUIREMENTS.md");
      const requirements = yield* Effect.promise(() =>
        NodeFSP.readFile(
          NodePath.join(command.evidenceDirectory!, "DESIGN_REQUIREMENTS.md"),
          "utf8",
        ),
      );
      expect(requirements).toContain("warm-glow");
      expect(requirements).toContain("Lit lanterns cast a warm glow");
      expect(requirements).toContain("collect-two");
      // Bounded creator prose only: no observe keys, no agent instructions.
      expect(requirements).not.toContain("observe");
      expect(requirements).not.toContain("AGENTS.md");
      expect(requirements).not.toContain("game.json");
    }),
  ),
);

it.live("a repair child gets the same bounded design promises in its prompt", () =>
  withSession(({ scripted, service }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = [
        { id: "warm-glow", kind: "presentation", text: "Lit lanterns cast a warm glow" },
      ];
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "repair",
        repair: {
          remainingBudget: "2 repairs and 20 minutes left",
          defects: [
            {
              severity: "visible",
              what: "The lanterns never glow.",
              frameId: "f2",
              fix: "Light the lanterns; yes/no: lit lanterns glow.",
            },
          ],
          doNotRegress: [],
        },
      });
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      const command = scripted.dispatches[0]!;
      expect(command.type).toBe("game-round.task.request");
      if (command.type !== "game-round.task.request") return;
      expect(command.task).toContain("DESIGN (approved acceptance;");
      expect(command.task).toContain("warm-glow");
      expect(command.task).toContain("The lanterns never glow.");
    }),
  ),
);

it.live("a legacy game without an approved design reviews exactly as before", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = null;
      const critic = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      expect(critic.kind).toBe("started");
      if (critic.kind !== "started") return;
      const command = scripted.dispatches[0]!;
      expect(command.type).toBe("game-round.task.request");
      if (command.type !== "game-round.task.request") return;
      expect(command.task).not.toContain("DESIGN_REQUIREMENTS");
      const files = yield* Effect.promise(() => walk(command.evidenceDirectory!));
      expect(files).toEqual([
        "BRIEF.md",
        "evidence.json",
        "frames/frame-01.png",
        "frames/frame-02.png",
      ]);
    }),
  ),
);

it.live("an all-cannot-tell critic answer stays unknown instead of certifying quality", () =>
  Effect.sync(() => {
    const frames = new Set(["f1", "f2"]);
    const checks = new Set(["boot", "input"]);
    const recipeIds = new Set(["feel.buffer"]);
    const unknown = JSON.stringify({
      fundamentals: {
        boots: { verdict: "yes", frameIds: ["f1"], note: "Boot frame." },
        respondsToInput: {
          verdict: "cannot-tell",
          frameIds: ["f1"],
          note: "No input pair shows it.",
        },
        coreActionVisible: { verdict: "cannot-tell", frameIds: [], note: "Cannot see it." },
        stateReadable: { verdict: "cannot-tell", frameIds: [], note: "Cannot read it." },
      },
      defects: [],
      doNotRegress: [],
      // Absolute quality all unknown: exact-once coverage with no verdict.
      // Unknown stays neutral, never a pass, a fail or a score.
      quality: {
        artConsistency: { verdict: "cannot-tell", frameIds: [], note: "Cannot judge." },
        animation: { verdict: "cannot-tell", frameIds: [], note: "Cannot judge." },
        audio: { verdict: "cannot-tell", frameIds: [], note: "No audio evidence attached." },
        readability: { verdict: "cannot-tell", frameIds: [], note: "Cannot judge." },
        progression: { verdict: "cannot-tell", frameIds: [], note: "Cannot judge." },
        agency: { verdict: "cannot-tell", frameIds: [], note: "Cannot judge." },
        playability: { verdict: "cannot-tell", frameIds: [], note: "Cannot judge." },
      },
    });
    const parsed = GameReviewSessions.parseCriticAnswer(unknown, {
      frameIds: frames,
      checkIds: checks,
      recipeIds,
      requireQuality: true,
    });
    // Valid as an answer, but it names no defect and proves nothing: the loop
    // must keep the incumbent on zero defects, never promote on unknown.
    expect(parsed.kind).toBe("valid");
    if (parsed.kind !== "valid") return;
    expect(parsed.answer.defects).toEqual([]);
    expect(
      Object.values(parsed.answer.fundamentals).filter(
        (judgment) => judgment.verdict === "cannot-tell",
      ),
    ).toHaveLength(3);
  }),
);

it.live("design requirements render bounded creator prose and nothing else", () =>
  Effect.sync(() => {
    expect(GameReviewSessions.renderDesignRequirements([])).toBeNull();
    const rendered = GameReviewSessions.renderDesignRequirements([
      { id: "warm-glow", kind: "presentation", text: "Lit lanterns cast a warm glow" },
      { id: "collect-two", kind: "content", text: "  The   player collects\ntwo lanterns  " },
    ])!;
    expect(rendered).toContain("- [presentation] warm-glow: Lit lanterns cast a warm glow");
    expect(rendered).toContain("- [content] collect-two: The player collects two lanterns");
    // A normal 198-char promise keeps its essential final clause in full.
    const full = GameReviewSessions.renderDesignRequirements([
      {
        id: "lantern-glow",
        kind: "presentation",
        text: "The lanterns are part of the evening route and the player can walk freely between the rooftops while the timer records the entire journey. After activation they MUST illuminate nearby roof surfaces.",
      },
    ])!;
    expect(full).toContain("MUST illuminate nearby roof surfaces");
    expect(full).not.toContain("Coverage incomplete");
    const long = GameReviewSessions.renderDesignRequirements([
      { id: "epic", kind: "mechanic", text: `x`.repeat(500) },
    ])!;
    expect(long.length).toBeLessThan(900);
    expect(long).toContain("[truncated]");
    expect(long).toContain("Coverage incomplete");
    expect(long).toContain("cannot-tell");
    const many = GameReviewSessions.renderDesignRequirements(
      Array.from({ length: 30 }, (_, index) => ({
        id: `criterion-${index}`,
        kind: "mechanic" as const,
        text: `Promise ${index}`,
      })),
    )!;
    expect(many.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(12);
    expect(many).toContain("Coverage incomplete");
  }),
);

it("ballots require every defect once and known evidence for fixes and regressions", () => {
  const judgment = { fixed: "yes", frameIds: ["f1"] };
  const answer = {
    overall: "tie",
    overallReason: "The defect is fixed but the rest is close.",
    main: { works: "tie", look: "tie", feel: "tie", play: "tie" },
    defects: [{ id: "defect-1", A: judgment, B: { ...judgment, fixed: "no" } }],
    regressions: { A: [], B: [] },
    preservation: [],
    control: { works: "tie", look: "tie", feel: "tie", play: "tie" },
    reason: "f1 shows the repair.",
  };
  const known = { frameIds: new Set(["f1"]), itemIds: [], defectIds: ["defect-1"] };
  const parse = (value: unknown) =>
    GameReviewSessions.parseBallotAnswer(JSON.stringify(value), known);
  expect(parse(answer).kind).toBe("valid");
  expect(parse({ ...answer, defects: [] })).toMatchObject({
    kind: "invalid",
    reason: expect.stringContaining("did not judge defects"),
  });
  expect(parse({ ...answer, defects: [...answer.defects, ...answer.defects] }).kind).toBe(
    "invalid",
  );
  expect(parse({ ...answer, defects: [{ ...answer.defects[0], id: "unknown" }] }).kind).toBe(
    "invalid",
  );
  expect(
    parse({ ...answer, regressions: { A: [{ what: "Clipped", frameIds: ["f99"] }], B: [] } }).kind,
  ).toBe("invalid");
  expect(
    parse({
      ...answer,
      defects: [{ id: "defect-1", A: { fixed: "yes", frameIds: [] }, B: judgment }],
    }).kind,
  ).toBe("invalid");
});

it.live("incomplete requirements cannot receive unsupported yes verdicts", () =>
  Effect.sync(() => {
    const known = {
      frameIds: new Set(["f1"]),
      checkIds: new Set<string>(),
      recipeIds: new Set<string>(),
      requirementIds: ["glow"],
    };
    const answer = {
      fundamentals,
      defects: [],
      doNotRegress: [],
      requirements: [
        { id: "glow", verdict: "yes", frameIds: new Array<string>(), note: "A halo is visible." },
      ],
    };
    expect(GameReviewSessions.parseCriticAnswer(JSON.stringify(answer), known)).toMatchObject({
      kind: "invalid",
      reason: expect.stringContaining("needs a frame"),
    });
    answer.requirements[0]!.frameIds.push("f1");
    expect(
      GameReviewSessions.parseCriticAnswer(JSON.stringify(answer), {
        ...known,
        incompleteRequirementIds: ["glow"],
        requirementsIncomplete: true,
      }),
    ).toMatchObject({ kind: "invalid", reason: expect.stringContaining("incomplete") });
    expect(
      GameReviewSessions.parseCriticAnswer(JSON.stringify(answer), {
        ...known,
        requirementsIncomplete: true,
      }),
    ).toMatchObject({ kind: "valid", answer: { requirementsIncomplete: true } });
  }),
);

it.live("a bound critic must assess every requirement exactly once with cited frames", () =>
  Effect.sync(() => {
    const frames = new Set(["f1", "f2"]);
    const checks = new Set(["boot"]);
    const recipeIds = new Set<string>();
    const known = {
      frameIds: frames,
      checkIds: checks,
      recipeIds,
      requirementIds: ["glow", "lit"],
    };
    const base = {
      fundamentals,
      defects: [],
      doNotRegress: [],
      requirements: [
        { id: "glow", verdict: "yes" as const, frameIds: ["f1"], note: "Roof glows." },
        { id: "lit", verdict: "cannot-tell" as const, frameIds: [], note: "Cannot see it." },
      ],
    };
    expect(GameReviewSessions.parseCriticAnswer(JSON.stringify(base), known).kind).toBe("valid");
    // Missing one requirement is not silently accepted.
    expect(
      GameReviewSessions.parseCriticAnswer(
        JSON.stringify({ ...base, requirements: [base.requirements[0]] }),
        known,
      ),
    ).toMatchObject({ kind: "invalid", reason: expect.stringContaining("did not assess") });
    // Unknown ids and duplicates are rejected through the same validation.
    expect(
      GameReviewSessions.parseCriticAnswer(
        JSON.stringify({
          ...base,
          requirements: [
            base.requirements[0],
            { id: "unknown", verdict: "yes" as const, frameIds: ["f1"], note: "Unknown." },
          ],
        }),
        known,
      ).kind,
    ).toBe("invalid");
    expect(
      GameReviewSessions.parseCriticAnswer(
        JSON.stringify({ ...base, requirements: [base.requirements[0], base.requirements[0]] }),
        known,
      ).kind,
    ).toBe("invalid");
    // An unmet promise without frames and an unknown frame are both invalid.
    expect(
      GameReviewSessions.parseCriticAnswer(
        JSON.stringify({
          ...base,
          requirements: [
            { id: "glow", verdict: "no" as const, frameIds: [], note: "No glow." },
            base.requirements[1],
          ],
        }),
        known,
      ),
    ).toMatchObject({ kind: "invalid", reason: expect.stringContaining("needs a frame") });
    expect(
      GameReviewSessions.parseCriticAnswer(
        JSON.stringify({
          ...base,
          requirements: [
            { id: "glow", verdict: "no" as const, frameIds: ["f9"], note: "No glow." },
            base.requirements[1],
          ],
        }),
        known,
      ).kind,
    ).toBe("invalid");
    // Legacy games with no bound requirements stay compatible and need no field.
    expect(
      GameReviewSessions.parseCriticAnswer(
        JSON.stringify({ fundamentals, defects: [], doNotRegress: [] }),
        { frameIds: frames, checkIds: checks, recipeIds },
      ).kind,
    ).toBe("valid");
  }),
);

describe("last-attempt requirement downgrades", () => {
  const knownBase = {
    frameIds: new Set(["f1", "f2"]),
    checkIds: new Set(["boot"]),
    recipeIds: new Set<string>(),
  };
  const text = (requirements?: unknown) =>
    JSON.stringify({
      fundamentals,
      defects: [],
      doNotRegress: [],
      ...(requirements === undefined ? {} : { requirements }),
    });
  const decodedAnswer = (requirements: unknown) => {
    const parsed = GameReviewSessions.parseCriticAnswer(text(requirements), knownBase);
    expect(parsed.kind).toBe("valid");
    if (parsed.kind !== "valid") throw new Error("The downgrade fixture must parse cleanly.");
    return parsed.answer;
  };
  const reparse = (
    answer: GameReviewSessions.DowngradedCriticAnswer["answer"],
    known: GameReviewSessions.CriticAnswerKnownIds,
  ) => GameReviewSessions.parseCriticAnswer(JSON.stringify(answer), known);

  it("turns omitted requirements into cannot-tell with the server-applied list", () => {
    const known = { ...knownBase, requirementIds: ["req-a", "req-b"] };
    const downgraded = GameReviewSessions.downgradeUnsupportedRequirements(
      decodedAnswer(undefined),
      known,
    );
    expect(downgraded).not.toBeNull();
    expect(downgraded!.answer.requirements).toEqual([
      {
        id: "req-a",
        verdict: "cannot-tell",
        frameIds: [],
        note: expect.stringContaining("did not assess requirements"),
      },
      {
        id: "req-b",
        verdict: "cannot-tell",
        frameIds: [],
        note: expect.stringContaining("did not assess requirements"),
      },
    ]);
    expect(downgraded!.downgrades).toEqual([
      { id: "req-a", reason: expect.stringContaining("did not assess requirements") },
      { id: "req-b", reason: expect.stringContaining("did not assess requirements") },
    ]);
    expect(reparse(downgraded!.answer, known).kind).toBe("valid");
  });

  it("fills a missing requirement while leaving the critic's verdicts alone", () => {
    const known = { ...knownBase, requirementIds: ["req-a", "req-b"] };
    const downgraded = GameReviewSessions.downgradeUnsupportedRequirements(
      decodedAnswer([{ id: "req-a", verdict: "yes", frameIds: ["f1"], note: "Lit." }]),
      known,
    );
    expect(downgraded).not.toBeNull();
    expect(downgraded!.answer.requirements).toEqual([
      { id: "req-a", verdict: "yes", frameIds: ["f1"], note: "Lit." },
      { id: "req-b", verdict: "cannot-tell", frameIds: [], note: expect.stringContaining("req-b") },
    ]);
    expect(downgraded!.downgrades.map((entry) => entry.id)).toEqual(["req-b"]);
    expect(reparse(downgraded!.answer, known).kind).toBe("valid");
  });

  it("turns a temporally refused yes into cannot-tell with the rule's reason", () => {
    const known = {
      ...knownBase,
      requirementIds: ["req-a"],
      temporalRequirementIds: ["req-a"],
      evidenceFrames: [{ id: "f1" }, { id: "f2" }],
    };
    const downgraded = GameReviewSessions.downgradeUnsupportedRequirements(
      decodedAnswer([{ id: "req-a", verdict: "yes", frameIds: ["f1"], note: "Lit." }]),
      known,
    );
    expect(downgraded).not.toBeNull();
    expect(downgraded!.answer.requirements).toEqual([
      {
        id: "req-a",
        verdict: "cannot-tell",
        frameIds: ["f1"],
        note: expect.stringContaining("before/after witness"),
      },
    ]);
    expect(downgraded!.downgrades).toHaveLength(1);
    expect(downgraded!.downgrades[0]).toMatchObject({
      id: "req-a",
      reason: expect.stringContaining("before/after witness"),
    });
    expect(reparse(downgraded!.answer, known).kind).toBe("valid");
  });

  it("turns an end-state refused yes into cannot-tell with the rule's reason", () => {
    const known = {
      ...knownBase,
      requirementIds: ["req-win"],
      endStateRequirements: [{ id: "req-win", kind: "win" as const, key: "won", expect: "==1" }],
      evidenceFrames: [{ id: "f1" }, { id: "f2" }],
    };
    const downgraded = GameReviewSessions.downgradeUnsupportedRequirements(
      decodedAnswer([{ id: "req-win", verdict: "yes", frameIds: ["f1", "f2"], note: "Won." }]),
      known,
    );
    expect(downgraded).not.toBeNull();
    expect(downgraded!.answer.requirements?.[0]).toMatchObject({
      id: "req-win",
      verdict: "cannot-tell",
      note: expect.stringContaining("matched ordinary-input transition"),
    });
    expect(downgraded!.downgrades).toHaveLength(1);
    expect(reparse(downgraded!.answer, known).kind).toBe("valid");
  });

  it("never changes a requirement no", () => {
    const known = { ...knownBase, requirementIds: ["req-a", "req-b"] };
    const downgraded = GameReviewSessions.downgradeUnsupportedRequirements(
      decodedAnswer([{ id: "req-a", verdict: "no", frameIds: ["f1"], note: "Not lit." }]),
      known,
    );
    expect(downgraded).not.toBeNull();
    expect(downgraded!.answer.requirements?.[0]).toMatchObject({ id: "req-a", verdict: "no" });
    expect(downgraded!.downgrades.map((entry) => entry.id)).toEqual(["req-b"]);
    expect(reparse(downgraded!.answer, known).kind).toBe("valid");
  });

  it("leaves unknown ids, citation failures and other faults invalid", () => {
    const requirementIds = ["req-a"];
    // Unknown requirement id.
    expect(
      GameReviewSessions.downgradeUnsupportedRequirements(
        decodedAnswer([{ id: "unknown", verdict: "yes", frameIds: ["f1"], note: "X." }]),
        { ...knownBase, requirementIds },
      ),
    ).toBeNull();
    // Requirement no without frames.
    expect(
      GameReviewSessions.downgradeUnsupportedRequirements(
        decodedAnswer([{ id: "req-a", verdict: "no", frameIds: [], note: "Not lit." }]),
        { ...knownBase, requirementIds },
      ),
    ).toBeNull();
    // A defect citing a frame outside the frozen manifest.
    const parsed = GameReviewSessions.parseCriticAnswer(
      JSON.stringify({
        fundamentals,
        defects: [{ severity: "visible", what: "Fault.", frameId: "f9", fix: "Fix it." }],
        doNotRegress: [],
        requirements: [{ id: "req-a", verdict: "yes", frameIds: ["f1"], note: "Lit." }],
      }),
      { ...knownBase, frameIds: new Set(["f1", "f2", "f9"]) },
    );
    expect(parsed.kind).toBe("valid");
    if (parsed.kind !== "valid") throw new Error("The downgrade fixture must parse cleanly.");
    expect(
      GameReviewSessions.downgradeUnsupportedRequirements(parsed.answer, {
        ...knownBase,
        requirementIds: ["req-b"],
      }),
    ).toBeNull();
  });

  it("returns null when there is nothing to downgrade", () => {
    const known = { ...knownBase, requirementIds: ["req-a"] };
    expect(
      GameReviewSessions.downgradeUnsupportedRequirements(
        decodedAnswer([{ id: "req-a", verdict: "cannot-tell", frameIds: [], note: "Unseen." }]),
        known,
      ),
    ).toBeNull();
    // Legacy records without frozen requirements never downgrade.
    expect(
      GameReviewSessions.downgradeUnsupportedRequirements(decodedAnswer(undefined), knownBase),
    ).toBeNull();
  });
});

it.live("a corrupt frozen critic record cannot fall back to a changed approval", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = [
        { id: "glow", kind: "presentation", text: "The roof lights up." },
      ];
      const critic = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      expect(critic.kind).toBe("started");
      const directory = yield* service.evidenceDirectory({
        threadId,
        loopId,
        roundId,
        role: "critic",
      });
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(directory!, "../session.json"), "{broken"),
      );
      scripted.designAcceptance = [];
      const failure = yield* service
        .start({ threadId, loopId, roundId, role: "ballot", evidence: frameInput(frames) })
        .pipe(Effect.flip);
      expect(failure.reason).toBe("io");
      expect(scripted.dispatches).toHaveLength(1);
    }),
  ),
);

it.live(
  "the requirement packet preserves every included id and its incomplete notice within budget",
  () =>
    Effect.sync(() => {
      const bound = GameReviewSessions.boundDesignRequirements(
        Array.from({ length: 12 }, (_, index) => ({
          id: `requirement-${index}`,
          kind: "presentation" as const,
          text: "A".repeat(500),
        })),
      )!;
      expect(bound.markdown.length).toBeLessThanOrEqual(4000);
      expect(bound.markdown).toContain("Coverage incomplete");
      expect(bound.requirements).toHaveLength(12);
      for (const requirement of bound.requirements) {
        expect(bound.markdown).toContain(`${requirement.id}:`);
        expect(requirement.incomplete).toBe(true);
      }
    }),
);

it.live("repair and ballot reuse the critic's frozen requirements when approval changes", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = [
        { id: "lantern-glow", kind: "presentation", text: "Lit lanterns cast a warm glow" },
      ];
      const critic = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      expect(critic.kind).toBe("started");
      if (critic.kind !== "started") return;
      const criticCommand = scripted.dispatches.at(-1)!;
      expect(criticCommand.type).toBe("game-round.task.request");
      if (criticCommand.type !== "game-round.task.request") return;
      expect(criticCommand.task).toContain("DESIGN_REQUIREMENTS.md");
      const criticDirectory = yield* service.evidenceDirectory({
        threadId,
        loopId,
        roundId,
        role: "critic",
      });
      const criticRequirements = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(criticDirectory!, "DESIGN_REQUIREMENTS.md"), "utf8"),
      );
      expect(criticRequirements).toContain("lantern-glow");

      // The approval changes after the critic started; the round must not follow it.
      scripted.designAcceptance = [
        { id: "replaced-promise", kind: "presentation", text: "A different promise entirely" },
      ];
      const repair = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "repair",
        repair: { remainingBudget: "2 repairs left", defects: [], doNotRegress: [] },
      });
      expect(repair.kind).toBe("started");
      if (repair.kind !== "started") return;
      const repairCommand = scripted.dispatches.at(-1)!;
      if (repairCommand.type !== "game-round.task.request") return;
      expect(repairCommand.task).toContain("lantern-glow");
      expect(repairCommand.task).not.toContain("replaced-promise");

      const ballot = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "ballot",
        order: 1,
        evidence: frameInput(frames),
        items: [],
      });
      expect(ballot.kind).toBe("started");
      if (ballot.kind !== "started") return;
      const ballotCommand = scripted.dispatches.at(-1)!;
      if (ballotCommand.type !== "game-round.task.request") return;
      expect(ballotCommand.task).toContain("DESIGN_REQUIREMENTS.md");
      const directory = yield* service.evidenceDirectory({
        threadId,
        loopId,
        roundId,
        role: "ballot",
        order: 1,
      });
      const ballotRequirements = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(directory!, "DESIGN_REQUIREMENTS.md"), "utf8"),
      );
      expect(ballotRequirements).toContain("lantern-glow");
      expect(ballotRequirements).not.toContain("replaced-promise");
    }),
  ),
);

it.live("preserves an older session's rubric version in reports and answers after restart", () =>
  withSession(({ stateDir, frames, scripted, service, restart }) =>
    Effect.gen(function* () {
      scripted.childStatus = "running";
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      const recordPath = NodePath.join(
        stateDir,
        (yield* Effect.promise(() => walk(stateDir))).find((file) =>
          file.endsWith("session.json"),
        )!,
      );
      const stored = JSON.parse(
        yield* Effect.promise(() => NodeFSP.readFile(recordPath, "utf8")),
      ) as { qualityRubricVersion: number; command: { task: string } };
      stored.qualityRubricVersion = 1;
      stored.command.task = "Frozen version-one critic task";
      yield* Effect.promise(() => NodeFSP.writeFile(recordPath, JSON.stringify(stored)));
      const resumed = yield* restart();
      const result = yield* resumed.report(
        { threadId: started.childThreadId, providerInstanceId: builderSelection.instanceId },
        "critic",
        { fundamentals, defects: [], doNotRegress: [], quality },
      );
      expect(result.accepted).toBe(true);
      expect(result.qualityCoverage?.rubricVersion).toBe(1);
      scripted.childStatus = "interrupted";
      const answer = yield* resumed.answer({ threadId, loopId, roundId, role: "critic", order: 0 });
      expect(answer.kind).toBe("critic");
      if (answer.kind === "critic") expect(answer.qualityRubricVersion).toBe(1);
    }),
  ),
);

it.live("temporal policy replays the Workshop Rover static win as invalid, pair as valid", () =>
  Effect.sync(() => {
    // Frozen Rover route: Enter (f1/f2) then hold w 3000ms (f3 before, f4 after win).
    // The shipped tool-answer marked park-in-bay yes with ONLY f4; the new
    // policy must reject that static final frame and accept the cited pair.
    const evidenceFrames = [
      {
        id: "f1",
        inputPair: { stepIndex: 0, phase: "before" as const, input: { press: "Enter" } },
      },
      {
        id: "f2",
        inputPair: { stepIndex: 0, phase: "after" as const, input: { press: "Enter" } },
      },
      {
        id: "f3",
        inputPair: { stepIndex: 1, phase: "before" as const, input: { hold: "w", holdMs: 3000 } },
      },
      {
        id: "f4",
        inputPair: { stepIndex: 1, phase: "after" as const, input: { hold: "w", holdMs: 3000 } },
      },
    ];
    const known = {
      frameIds: new Set(["f1", "f2", "f3", "f4"]),
      checkIds: new Set<string>(),
      recipeIds: new Set<string>(),
      requirementIds: ["park-in-bay"],
      temporalRequirementIds: ["park-in-bay"],
      evidenceFrames,
    };
    const answer = (frameIds: string[]) =>
      JSON.stringify({
        fundamentals,
        defects: [],
        doNotRegress: [],
        requirements: [
          {
            id: "park-in-bay",
            verdict: "yes" as const,
            frameIds,
            note: "Parking inside marked bay after all 3 gates wins run.",
          },
        ],
      });
    expect(GameReviewSessions.parseCriticAnswer(answer(["f4"]), known).kind).toBe("invalid");
    const staticReason = GameReviewSessions.parseCriticAnswer(answer(["f4"]), known);
    if (staticReason.kind === "invalid")
      expect(staticReason.reason).toMatch(/before\/after|finished state|cannot-tell/i);
    expect(GameReviewSessions.parseCriticAnswer(answer(["f3", "f4"]), known).kind).toBe("valid");
    // cannot-tell with no witness stays neutral.
    expect(
      GameReviewSessions.parseCriticAnswer(
        JSON.stringify({
          fundamentals,
          defects: [],
          doNotRegress: [],
          requirements: [
            {
              id: "park-in-bay",
              verdict: "cannot-tell" as const,
              frameIds: [],
              note: "No transition shows the bay trigger.",
            },
          ],
        }),
        known,
      ).kind,
    ).toBe("valid");
  }),
);

it.live(
  "temporal pairs reject duplicates, unrelated, cross-experiment and wait-only witnesses",
  () =>
    Effect.sync(() => {
      const evidenceFrames = [
        {
          id: "f1",
          inputPair: { stepIndex: 0, phase: "before" as const, input: { press: "Enter" } },
        },
        {
          id: "f2",
          inputPair: { stepIndex: 0, phase: "after" as const, input: { press: "Enter" } },
        },
        {
          id: "f3",
          inputPair: { stepIndex: 1, phase: "before" as const, input: { hold: "w", holdMs: 3000 } },
        },
        {
          id: "f4",
          inputPair: { stepIndex: 1, phase: "after" as const, input: { hold: "w", holdMs: 3000 } },
        },
        {
          id: "try2f6",
          inputPair: { stepIndex: 2, phase: "before" as const, input: { hold: "w", holdMs: 1200 } },
        },
        {
          id: "try2f8",
          inputPair: { stepIndex: 2, phase: "after" as const, input: { hold: "w", holdMs: 1200 } },
        },
        {
          id: "try3f6",
          inputPair: { stepIndex: 2, phase: "before" as const, input: { hold: "w", holdMs: 1200 } },
        },
        {
          id: "try3f8",
          inputPair: { stepIndex: 2, phase: "after" as const, input: { hold: "w", holdMs: 1200 } },
        },
        {
          id: "w1",
          inputPair: { stepIndex: 3, phase: "before" as const, input: { waitMs: 600 } },
        },
        {
          id: "w2",
          inputPair: { stepIndex: 3, phase: "after" as const, input: { waitMs: 600 } },
        },
        { id: "static" },
      ];
      const knownFor = (temporal: ReadonlyArray<string>) => ({
        frameIds: new Set(evidenceFrames.map((frame) => frame.id)),
        checkIds: new Set<string>(),
        recipeIds: new Set<string>(),
        requirementIds: ["win-bay"],
        temporalRequirementIds: temporal,
        evidenceFrames,
      });
      const answer = (frameIds: string[]) =>
        JSON.stringify({
          fundamentals,
          defects: [],
          doNotRegress: [],
          requirements: [
            { id: "win-bay", verdict: "yes" as const, frameIds, note: "Stateful win." },
          ],
        });
      const known = knownFor(["win-bay"]);
      // Valid experiment pair from one try_input call.
      expect(GameReviewSessions.parseCriticAnswer(answer(["try2f6", "try2f8"]), known).kind).toBe(
        "valid",
      );
      // Duplicated id is not a pair.
      expect(GameReviewSessions.parseCriticAnswer(answer(["f4", "f4"]), known).kind).toBe(
        "invalid",
      );
      // Two after frames never satisfy, even across experiments.
      expect(GameReviewSessions.parseCriticAnswer(answer(["f4", "try2f8"]), known).kind).toBe(
        "invalid",
      );
      // Unrelated before/after (different steps) never satisfy.
      expect(GameReviewSessions.parseCriticAnswer(answer(["f1", "f4"]), known).kind).toBe(
        "invalid",
      );
      // Cross-experiment alias with same step and input never satisfies.
      expect(GameReviewSessions.parseCriticAnswer(answer(["try2f6", "try3f8"]), known).kind).toBe(
        "invalid",
      );
      // Wait-only pairs are not ordinary input and never satisfy.
      expect(GameReviewSessions.parseCriticAnswer(answer(["w1", "w2"]), known).kind).toBe(
        "invalid",
      );
      // Source-less frames never satisfy.
      expect(GameReviewSessions.parseCriticAnswer(answer(["static"]), known).kind).toBe("invalid");
      expect(
        GameReviewSessions.hasMatchingOrdinaryInputPair(["try2f6", "try2f8"], evidenceFrames),
      ).toBe(true);
      expect(
        GameReviewSessions.hasMatchingOrdinaryInputPair(["try2f6", "try3f8"], evidenceFrames),
      ).toBe(false);
    }),
);

it.live("temporal policy leaves presentation and legacy sessions compatible", () =>
  Effect.sync(() => {
    const evidenceFrames = [
      {
        id: "f1",
        inputPair: { stepIndex: 0, phase: "before" as const, input: { press: "Enter" } },
      },
      {
        id: "f2",
        inputPair: { stepIndex: 0, phase: "after" as const, input: { press: "Enter" } },
      },
      {
        id: "f4",
        inputPair: { stepIndex: 1, phase: "after" as const, input: { hold: "w", holdMs: 3000 } },
      },
    ];
    const frameIds = new Set(["f1", "f2", "f4"]);
    // Presentation yes from one static frame stays valid under the policy.
    const presentationKnown = {
      frameIds,
      checkIds: new Set<string>(),
      recipeIds: new Set<string>(),
      requirementIds: ["toy-workshop"],
      temporalRequirementIds: [] as ReadonlyArray<string>,
      evidenceFrames,
    };
    expect(
      GameReviewSessions.parseCriticAnswer(
        JSON.stringify({
          fundamentals,
          defects: [],
          doNotRegress: [],
          requirements: [
            { id: "toy-workshop", verdict: "yes" as const, frameIds: ["f4"], note: "Toy look." },
          ],
        }),
        presentationKnown,
      ).kind,
    ).toBe("valid");
    // Legacy sessions without a frozen temporal policy keep the old rule: one
    // known frame is enough even for a stateful win.
    const legacyKnown = {
      frameIds,
      checkIds: new Set<string>(),
      recipeIds: new Set<string>(),
      requirementIds: ["park-in-bay"],
    };
    expect(
      GameReviewSessions.parseCriticAnswer(
        JSON.stringify({
          fundamentals,
          defects: [],
          doNotRegress: [],
          requirements: [
            { id: "park-in-bay", verdict: "yes" as const, frameIds: ["f4"], note: "Win." },
          ],
        }),
        legacyKnown,
      ).kind,
    ).toBe("valid");
    // Eligibility is kinds plus observe only: presentation and observe-less
    // promises never join the frozen list.
    expect(
      GameReviewSessions.temporalEligibleRequirementIds([
        {
          id: "drive",
          kind: "control",
          text: "Drive.",
          observe: { key: "collected", expect: ">=1" },
        },
        { id: "look", kind: "presentation", text: "Look." },
        { id: "win", kind: "win", text: "Win." },
        { id: "lose-free", kind: "lose", text: "No lose state", noLoseState: true as const },
      ]),
    ).toEqual(["drive"]);
  }),
);

it.live(
  "end-state policy needs a measured after-satisfying transition with a non-terminal before",
  () =>
    Effect.sync(() => {
      const evidenceFrames = [
        { id: "f1" },
        {
          id: "f3",
          inputPair: { stepIndex: 1, phase: "before" as const, input: { hold: "w", holdMs: 3000 } },
          observations: { won: 0 },
        },
        {
          id: "f4",
          inputPair: { stepIndex: 1, phase: "after" as const, input: { hold: "w", holdMs: 3000 } },
          observations: { won: 1 },
        },
        {
          id: "try1f1",
          inputPair: { stepIndex: 0, phase: "before" as const, input: { press: "Space" } },
          observations: { won: 0 },
        },
        {
          id: "try1f2",
          inputPair: { stepIndex: 0, phase: "after" as const, input: { press: "Space" } },
          observations: { won: 0 },
        },
      ];
      const known = {
        frameIds: new Set(["f1", "f3", "f4", "try1f1", "try1f2"]),
        checkIds: new Set<string>(),
        recipeIds: new Set<string>(),
        requirementIds: ["park-in-bay"],
        temporalRequirementIds: ["park-in-bay"],
        endStateRequirements: [
          { id: "park-in-bay", kind: "win" as const, key: "won", expect: "==1" },
        ],
        evidenceFrames,
      };
      const answer = (frameIds: string[], challenge?: unknown) =>
        JSON.stringify({
          fundamentals,
          defects: [],
          doNotRegress: [],
          requirements: [
            {
              id: "park-in-bay",
              verdict: "yes" as const,
              frameIds,
              note: "Parking inside the marked bay after all 3 gates wins the run.",
              ...(challenge === undefined ? {} : { challenge }),
            },
          ],
        });
      const goodChallenge = {
        frameIds: ["try1f1", "try1f2"],
        note: "Drove without parking; won stayed 0, missing bay trigger tested.",
      };
      // False->true positive plus a separate false->false ordinary-play
      // counterexample is the only accepted shape.
      expect(answer(["f3", "f4"], goodChallenge)).toSatisfy(
        (text) => GameReviewSessions.parseCriticAnswer(text as string, known).kind === "valid",
      );
      // Arbitrary won=false pair (after does not satisfy) cannot substantiate yes.
      const wrongCounterFrames = [
        { id: "f1" },
        {
          id: "f3",
          inputPair: { stepIndex: 1, phase: "before" as const, input: { hold: "w", holdMs: 3000 } },
          observations: { won: 0 },
        },
        {
          id: "f4",
          inputPair: { stepIndex: 1, phase: "after" as const, input: { hold: "w", holdMs: 3000 } },
          observations: { won: 0 },
        },
        ...evidenceFrames.slice(3),
      ];
      const wrongKnown = { ...known, evidenceFrames: wrongCounterFrames };
      expect(
        GameReviewSessions.parseCriticAnswer(answer(["f3", "f4"], goodChallenge), wrongKnown).kind,
      ).toBe("invalid");
      // Missing scalar justifies cannot-tell, never yes.
      const missingFrames = [
        { id: "f1" },
        { id: "f3", inputPair: evidenceFrames[1]!.inputPair! },
        { id: "f4", inputPair: evidenceFrames[2]!.inputPair! },
        ...evidenceFrames.slice(3),
      ];
      expect(
        GameReviewSessions.parseCriticAnswer(answer(["f3", "f4"], goodChallenge), {
          ...known,
          evidenceFrames: missingFrames,
        }).kind,
      ).toBe("invalid");
      expect(
        GameReviewSessions.parseCriticAnswer(
          JSON.stringify({
            fundamentals,
            defects: [],
            doNotRegress: [],
            requirements: [
              {
                id: "park-in-bay",
                verdict: "cannot-tell" as const,
                frameIds: [],
                note: "No measured transition shows the bay trigger.",
              },
            ],
          }),
          { ...known, evidenceFrames: missingFrames },
        ).kind,
      ).toBe("valid");
      // Before already terminal (won 1->1) proves nothing about this input.
      const terminalBefore = [
        { id: "f1" },
        {
          id: "f3",
          inputPair: { stepIndex: 1, phase: "before" as const, input: { hold: "w", holdMs: 3000 } },
          observations: { won: 1 },
        },
        {
          id: "f4",
          inputPair: { stepIndex: 1, phase: "after" as const, input: { hold: "w", holdMs: 3000 } },
          observations: { won: 1 },
        },
        ...evidenceFrames.slice(3),
      ];
      expect(
        GameReviewSessions.parseCriticAnswer(answer(["f3", "f4"], goodChallenge), {
          ...known,
          evidenceFrames: terminalBefore,
        }).kind,
      ).toBe("invalid");
    }),
);

it.live("end-state challenge must be a separate unsatisfied counterexample", () =>
  Effect.sync(() => {
    const evidenceFrames = [
      { id: "f1" },
      {
        id: "f3",
        inputPair: { stepIndex: 1, phase: "before" as const, input: { hold: "w", holdMs: 3000 } },
        observations: { won: 0 },
      },
      {
        id: "f4",
        inputPair: { stepIndex: 1, phase: "after" as const, input: { hold: "w", holdMs: 3000 } },
        observations: { won: 1 },
      },
      {
        id: "try1f1",
        inputPair: { stepIndex: 0, phase: "before" as const, input: { press: "Space" } },
        observations: { won: 0 },
      },
      {
        id: "try1f2",
        inputPair: { stepIndex: 0, phase: "after" as const, input: { press: "Space" } },
        observations: { won: 0 },
      },
      {
        id: "try2f1",
        inputPair: { stepIndex: 0, phase: "before" as const, input: { press: "Space" } },
        observations: { won: 0 },
      },
      {
        id: "try2f2",
        inputPair: { stepIndex: 0, phase: "after" as const, input: { press: "Space" } },
        observations: { won: 1 },
      },
    ];
    const known = {
      frameIds: new Set(evidenceFrames.map((frame) => frame.id)),
      checkIds: new Set<string>(),
      recipeIds: new Set<string>(),
      requirementIds: ["park-in-bay"],
      temporalRequirementIds: ["park-in-bay"],
      endStateRequirements: [
        { id: "park-in-bay", kind: "win" as const, key: "won", expect: "==1" },
      ],
      evidenceFrames,
    };
    const answer = (challenge: unknown) =>
      JSON.stringify({
        fundamentals,
        defects: [],
        doNotRegress: [],
        requirements: [
          {
            id: "park-in-bay",
            verdict: "yes" as const,
            frameIds: ["f3", "f4"],
            note: "Won 0->1 on the parking drive.",
            ...(challenge === undefined ? {} : { challenge }),
          },
        ],
      });
    // Missing challenge cannot prove the trigger necessary.
    expect(GameReviewSessions.parseCriticAnswer(answer(undefined), known).kind).toBe("invalid");
    // Same pair reused as challenge is not separate.
    expect(
      GameReviewSessions.parseCriticAnswer(
        answer({ frameIds: ["f3", "f4"], note: "Same pair." }),
        known,
      ).kind,
    ).toBe("invalid");
    // Same experiment (base) with a different step is still the same run.
    const baseExtra = [
      ...evidenceFrames,
      {
        id: "f5",
        inputPair: { stepIndex: 2, phase: "before" as const, input: { hold: "w", holdMs: 500 } },
        observations: { won: 0 },
      },
      {
        id: "f6",
        inputPair: { stepIndex: 2, phase: "after" as const, input: { hold: "w", holdMs: 500 } },
        observations: { won: 0 },
      },
    ];
    expect(
      GameReviewSessions.parseCriticAnswer(
        answer({ frameIds: ["f5", "f6"], note: "Separate base steps." }),
        {
          ...known,
          frameIds: new Set(baseExtra.map((frame) => frame.id)),
          evidenceFrames: baseExtra,
        },
      ).kind,
    ).toBe("invalid");
    // A challenge that itself reaches won=1 cannot prove the trigger.
    expect(
      GameReviewSessions.parseCriticAnswer(
        answer({ frameIds: ["try2f1", "try2f2"], note: "Unparked drive still won." }),
        known,
      ).kind,
    ).toBe("invalid");
    const resetChallenge = evidenceFrames.map((frame) =>
      frame.id === "try1f1" ? { ...frame, observations: { won: 1 } } : frame,
    );
    expect(
      GameReviewSessions.parseCriticAnswer(
        answer({ frameIds: ["try1f1", "try1f2"], note: "Reset an already won run." }),
        { ...known, evidenceFrames: resetChallenge },
      ).kind,
    ).toBe("invalid");
    // Missing measurement in the challenge justifies cannot-tell, never yes.
    const missingChallenge = [
      ...evidenceFrames.slice(0, 5),
      { id: "try2f1", inputPair: evidenceFrames[5]!.inputPair! },
      { id: "try2f2", inputPair: evidenceFrames[6]!.inputPair! },
    ];
    expect(
      GameReviewSessions.parseCriticAnswer(
        answer({ frameIds: ["try2f1", "try2f2"], note: "No measurement." }),
        {
          ...known,
          frameIds: new Set(missingChallenge.map((frame) => frame.id)),
          evidenceFrames: missingChallenge,
        },
      ).kind,
    ).toBe("invalid");
    // Unknown challenge frames never count.
    expect(
      GameReviewSessions.parseCriticAnswer(
        answer({ frameIds: ["try9f1", "try9f2"], note: "Unknown." }),
        known,
      ).kind,
    ).toBe("invalid");
  }),
);

it.live("end-state refusals name the way out with the attempts left", () =>
  Effect.sync(() => {
    const evidenceFrames = [
      { id: "f1" },
      {
        id: "f3",
        inputPair: { stepIndex: 1, phase: "before" as const, input: { hold: "w", holdMs: 3000 } },
        observations: { won: 0 },
      },
      {
        id: "f4",
        inputPair: { stepIndex: 1, phase: "after" as const, input: { hold: "w", holdMs: 3000 } },
        observations: { won: 1 },
      },
    ];
    const base = {
      frameIds: new Set(["f1", "f3", "f4"]),
      endStateRequirements: [
        { id: "park-in-bay", kind: "win" as const, key: "won", expect: "==1" },
      ],
      evidenceFrames,
    };
    const answer = {
      fundamentals,
      defects: [],
      doNotRegress: [],
      requirements: [
        {
          id: "park-in-bay",
          verdict: "yes" as const,
          frameIds: ["f3", "f4"],
          note: "Won without proving the trigger.",
        },
      ],
    } as unknown as Parameters<typeof GameReviewSessions.endStateRefusalReason>[0];
    for (const attemptsRemaining of [2, 1]) {
      const refusal = GameReviewSessions.endStateRefusalReason(answer, {
        ...base,
        attemptsRemaining,
      });
      expect(refusal).not.toBeNull();
      expect(refusal ?? "").toContain("game_try_input");
      expect(refusal ?? "").toContain("cannot-tell");
      expect(refusal ?? "").toContain("stays available");
      expect(refusal ?? "").toContain(
        attemptsRemaining === 1 ? "1 attempt remains" : "2 attempts remain",
      );
    }
  }),
);

it.live(
  "a missing positive transition names its own way out, not the missing-trigger experiment",
  () =>
    Effect.sync(() => {
      const evidenceFrames = [{ id: "f1" }];
      const base = {
        frameIds: new Set(["f1"]),
        endStateRequirements: [
          { id: "park-in-bay", kind: "win" as const, key: "won", expect: "==1" },
        ],
        evidenceFrames,
      };
      const answer = {
        fundamentals,
        defects: [],
        doNotRegress: [],
        requirements: [
          {
            id: "park-in-bay",
            verdict: "yes" as const,
            frameIds: ["f1"],
            note: "Won without a transition.",
          },
        ],
      } as unknown as Parameters<typeof GameReviewSessions.endStateRefusalReason>[0];
      const refusal = GameReviewSessions.endStateRefusalReason(answer, {
        ...base,
        attemptsRemaining: 2,
      });
      expect(refusal).not.toBeNull();
      expect(refusal ?? "").toContain("reaches the end state");
      expect(refusal ?? "").not.toContain("trigger deliberately missing");
      expect(refusal ?? "").toContain("cannot-tell");
    }),
);

it.live("an exhausted end-state refusal says the session has ended", () =>
  Effect.sync(() => {
    const evidenceFrames = [{ id: "f1" }];
    const base = {
      frameIds: new Set(["f1"]),
      endStateRequirements: [
        { id: "park-in-bay", kind: "win" as const, key: "won", expect: "==1" },
      ],
      evidenceFrames,
    };
    const answer = {
      fundamentals,
      defects: [],
      doNotRegress: [],
      requirements: [
        {
          id: "park-in-bay",
          verdict: "yes" as const,
          frameIds: ["f1"],
          note: "Won without a transition.",
        },
      ],
    } as unknown as Parameters<typeof GameReviewSessions.endStateRefusalReason>[0];
    const refusal = GameReviewSessions.endStateRefusalReason(answer, {
      ...base,
      attemptsRemaining: 0,
    });
    expect(refusal).not.toBeNull();
    expect(refusal ?? "").toContain("has ended");
    expect(refusal ?? "").not.toContain("game_try_input");
    expect(refusal ?? "").not.toContain("stays available");
    expect(refusal ?? "").not.toContain("0 attempts remain");
  }),
);

it.live("a refused end-state report keeps the session open with one attempt left", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = [
        {
          id: "park-in-bay",
          kind: "win",
          text: "Parking inside the marked bay after all 3 gates wins the run",
          observe: { key: "won", expect: "==1" },
        },
      ];
      scripted.childStatus = "running";
      const measuredEvidence = frameInput(frames);
      const withWon = {
        ...measuredEvidence,
        frames: measuredEvidence.frames.map((frame, index) => ({
          ...frame,
          observations: index === 0 ? { won: 0 as const } : { won: 1 as const },
        })),
      };
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: withWon,
      });
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      const caller = {
        threadId: started.childThreadId,
        providerInstanceId: builderSelection.instanceId,
      };
      const staticAnswer = {
        fundamentals,
        defects: [],
        doNotRegress: [],
        requirements: [
          { id: "park-in-bay", verdict: "yes" as const, frameIds: ["f1", "f2"], note: "Win run." },
        ],
        quality,
      };
      const first = yield* service.report(caller, "critic", staticAnswer);
      expect(first.accepted).toBe(false);
      expect(first.attemptsRemaining).toBe(2);
      expect(first.ended).toBe(false);
      expect(first.error ?? "").toContain("game_try_input");
      expect(first.error ?? "").toContain("2 attempts remain");
      // The session stays open between refused attempts, so a second
      // ordinary-play experiment can still be recorded with game_try_input.
      expect(yield* service.toolRole(caller)).toBe("critic");
      const second = yield* service.report(caller, "critic", staticAnswer);
      expect(second.accepted).toBe(false);
      expect(second.attemptsRemaining).toBe(1);
      expect(second.ended).toBe(false);
      expect(second.error ?? "").toContain("game_try_input");
      expect(second.error ?? "").toContain("1 attempt remains");
      expect(second.error ?? "").toContain("cannot-tell");
    }),
  ),
);

it.live("the last tool attempt accepts omitted requirements as a server downgrade", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = [
        { id: "look-a", kind: "presentation", text: "Warm light fills the room." },
        { id: "look-b", kind: "presentation", text: "Soft shadows ground the player." },
      ];
      scripted.childStatus = "running";
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      const caller = {
        threadId: started.childThreadId,
        providerInstanceId: builderSelection.instanceId,
      };
      const input = { threadId, loopId, roundId, role: "critic" as const };
      const hashBefore = yield* service.evidenceHash(input);
      const answer = { fundamentals, defects: [], doNotRegress: [], quality };
      const first = yield* service.report(caller, "critic", answer);
      expect(first.accepted).toBe(false);
      expect(first.attemptsRemaining).toBe(2);
      expect(first.ended).toBe(false);
      expect(first.error).toContain("did not assess requirements");
      const second = yield* service.report(caller, "critic", answer);
      expect(second).toMatchObject({ accepted: false, attemptsRemaining: 1, ended: false });
      expect(second.error).toContain("did not assess requirements");
      const third = yield* service.report(caller, "critic", answer);
      expect(third.accepted).toBe(true);
      expect(third.ended).toBe(true);
      const directory = yield* service.evidenceDirectory(input);
      const sessionDir = NodePath.join(directory!, "..");
      const readJson = (name: string) =>
        Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(sessionDir, name), "utf8").then(
            (text) => JSON.parse(text) as Record<string, unknown>,
          ),
        );
      const recorded = (yield* readJson("tool-answer.json")) as { raw: string };
      const raw = JSON.parse(recorded.raw) as {
        requirements: Array<{ id: string; verdict: string }>;
        downgradedRequirements: Array<{ id: string; reason: string }>;
      };
      expect(raw.requirements).toHaveLength(2);
      expect(raw.downgradedRequirements.map((entry) => entry.id).sort()).toEqual([
        "look-a",
        "look-b",
      ]);
      // The answer endpoint surfaces the server-applied list, not a critic verdict.
      scripted.childStatus = "completed";
      const read = yield* service.answer(input);
      expect(read.kind).toBe("critic");
      if (read.kind !== "critic") return;
      expect((read.answer.downgradedRequirements ?? []).map((entry) => entry.id).sort()).toEqual([
        "look-a",
        "look-b",
      ]);
      // Both refused attempts left their payload and error beside the tool record.
      for (const attempt of [1, 2]) {
        const retained = yield* readJson(`tool-attempt-${attempt}.json`);
        expect(String(retained.error)).toContain("did not assess requirements");
        expect(String(retained.payload)).toContain("fundamentals");
      }
      // The rescued third attempt still shows what the model actually sent.
      const rescued = (yield* readJson("tool-attempt-3.json")) as Record<string, unknown>;
      expect(rescued.serverDowngraded).toBe(true);
      expect(rescued.error).toBeNull();
      expect(String(rescued.validationError)).toContain("did not assess requirements");
      // Retaining attempts never changes the sealed evidence hash.
      expect(yield* service.evidenceHash(input)).toBe(hashBefore);
    }),
  ),
);

it.live("the last tool attempt downgrades an end-state refused yes", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = [
        {
          id: "park-in-bay",
          kind: "win",
          text: "Parking inside the marked bay after all 3 gates wins the run",
          observe: { key: "won", expect: "==1" },
        },
      ];
      scripted.childStatus = "running";
      const measuredEvidence = frameInput(frames);
      const withWon = {
        ...measuredEvidence,
        frames: measuredEvidence.frames.map((frame, index) => ({
          ...frame,
          observations: index === 0 ? { won: 0 as const } : { won: 1 as const },
        })),
      };
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: withWon,
      });
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      const caller = {
        threadId: started.childThreadId,
        providerInstanceId: builderSelection.instanceId,
      };
      const staticAnswer = {
        fundamentals,
        defects: [
          {
            severity: "visible" as const,
            what: "The gate sign clips the bay marker.",
            frameId: "f2",
            fix: "Move the sign; yes/no: the marker reads fully.",
          },
        ],
        doNotRegress: [],
        requirements: [
          { id: "park-in-bay", verdict: "yes" as const, frameIds: ["f1", "f2"], note: "Win run." },
        ],
        quality,
      };
      const first = yield* service.report(caller, "critic", staticAnswer);
      expect(first.accepted).toBe(false);
      expect(first.error ?? "").toContain("game_try_input");
      const second = yield* service.report(caller, "critic", staticAnswer);
      expect(second).toMatchObject({ accepted: false, attemptsRemaining: 1, ended: false });
      const third = yield* service.report(caller, "critic", staticAnswer);
      expect(third.accepted).toBe(true);
      expect(third.ended).toBe(true);
      const input = { threadId, loopId, roundId, role: "critic" as const };
      const directory = yield* service.evidenceDirectory(input);
      const recorded = (yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(directory!, "..", "tool-answer.json"), "utf8").then(
          (text) => JSON.parse(text) as { raw: string },
        ),
      )) as { raw: string };
      const raw = JSON.parse(recorded.raw) as {
        requirements: Array<{ id: string; verdict: string; note: string }>;
        downgradedRequirements: Array<{ id: string; reason: string }>;
      };
      expect(raw.requirements).toHaveLength(1);
      expect(raw.requirements[0]).toMatchObject({
        id: "park-in-bay",
        verdict: "cannot-tell",
        note: expect.stringContaining("counterexample experiment"),
      });
      expect(raw.downgradedRequirements).toHaveLength(1);
      expect(raw.downgradedRequirements[0]).toMatchObject({
        id: "park-in-bay",
        reason: expect.stringContaining("counterexample experiment"),
      });
    }),
  ),
);

it.live("a downgraded cannot-tell still owes the coverage work rule", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = [
        {
          id: "park-in-bay",
          kind: "win",
          text: "Parking inside the marked bay after all 3 gates wins the run",
          observe: { key: "won", expect: "==1" },
        },
      ];
      scripted.childStatus = "running";
      const measuredEvidence = frameInput(frames);
      const withWon = {
        ...measuredEvidence,
        frames: measuredEvidence.frames.map((frame, index) => ({
          ...frame,
          observations: index === 0 ? { won: 0 as const } : { won: 1 as const },
        })),
      };
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: withWon,
      });
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      const caller = {
        threadId: started.childThreadId,
        providerInstanceId: builderSelection.instanceId,
      };
      const staticAnswer = {
        fundamentals,
        defects: [],
        doNotRegress: [],
        requirements: [
          { id: "park-in-bay", verdict: "yes" as const, frameIds: ["f1", "f2"], note: "Win run." },
        ],
        quality,
      };
      yield* service.report(caller, "critic", staticAnswer);
      yield* service.report(caller, "critic", staticAnswer);
      // The yes is downgraded, but the honest cannot-tell still names an
      // eligible promise the critic never tried, so the work rule refuses
      // exactly as it would for a critic-written cannot-tell.
      const last = yield* service.report(caller, "critic", staticAnswer);
      expect(last.accepted).toBe(false);
      expect(last.ended).toBe(true);
      expect(last.error ?? "").toContain("cannot-tell on eligible stateful promises");
    }),
  ),
);

it.live("an undecodable last attempt stays invalid", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = [
        { id: "look-a", kind: "presentation", text: "Warm light fills the room." },
      ];
      scripted.childStatus = "running";
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      const caller = {
        threadId: started.childThreadId,
        providerInstanceId: builderSelection.instanceId,
      };
      const unknownId = {
        fundamentals,
        defects: [],
        doNotRegress: [],
        requirements: [{ id: "unknown", verdict: "yes", frameIds: ["f1"], note: "Unknown." }],
        quality,
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const refused = yield* service.report(caller, "critic", unknownId);
        expect(refused.accepted).toBe(false);
        expect(refused.ended).toBe(false);
      }
      const last = yield* service.report(caller, "critic", unknownId);
      expect(last).toMatchObject({ accepted: false, ended: true, attemptsRemaining: 0 });
      expect(last.error ?? "").toContain("unknown");
    }),
  ),
);

it.live("a terminal answer with omitted requirements is rescued as a server downgrade", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = [
        { id: "look-a", kind: "presentation", text: "Warm light fills the room." },
      ];
      scripted.childStatus = "completed";
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      const input = { threadId, loopId, roundId, role: "critic" as const };
      scripted.answer = "not one JSON object";
      const undecodable = yield* service.answer(input);
      expect(undecodable.kind).toBe("invalid");
      scripted.answer = criticText;
      const read = yield* service.answer(input);
      expect(read.kind).toBe("critic");
      if (read.kind !== "critic") return;
      expect(read.answer.requirements).toEqual([
        {
          id: "look-a",
          verdict: "cannot-tell",
          frameIds: [],
          note: expect.stringContaining("did not assess requirements"),
        },
      ]);
      expect(read.answer.downgradedRequirements).toHaveLength(1);
      expect(read.answer.downgradedRequirements?.[0]).toMatchObject({
        id: "look-a",
        reason: expect.stringContaining("did not assess requirements"),
      });
    }),
  ),
);

it.live("a second schema refusal names the last-attempt way out", () =>
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
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      const caller = {
        threadId: started.childThreadId,
        providerInstanceId: builderSelection.instanceId,
      };
      const invalidAnswer = {
        fundamentals,
        defects: [],
        doNotRegress: "wrong",
      };
      const first = yield* service.report(caller, "critic", invalidAnswer);
      expect(first.accepted).toBe(false);
      expect(first.attemptsRemaining).toBe(2);
      const second = yield* service.report(caller, "critic", invalidAnswer);
      expect(second.accepted).toBe(false);
      expect(second.attemptsRemaining).toBe(1);
      expect(second.ended).toBe(false);
      expect(second.error ?? "").toContain("last attempt");
      expect(second.error ?? "").toContain("cannot-tell");
    }),
  ),
);

it.live("end-state policy excludes presentation, no-loss and old records", () =>
  Effect.sync(() => {
    const evidenceFrames = [
      {
        id: "f1",
        inputPair: { stepIndex: 0, phase: "before" as const, input: { press: "Enter" } },
      },
      {
        id: "f4",
        inputPair: { stepIndex: 1, phase: "after" as const, input: { hold: "w", holdMs: 3000 } },
      },
    ];
    // Presentation yes from one static frame stays valid under the policy.
    expect(
      GameReviewSessions.parseCriticAnswer(
        JSON.stringify({
          fundamentals,
          defects: [],
          doNotRegress: [],
          requirements: [
            { id: "toy-workshop", verdict: "yes" as const, frameIds: ["f4"], note: "Toy look." },
          ],
        }),
        {
          frameIds: new Set(["f1", "f4"]),
          checkIds: new Set<string>(),
          recipeIds: new Set<string>(),
          requirementIds: ["toy-workshop"],
          temporalRequirementIds: [],
          endStateRequirements: [],
          evidenceFrames,
        },
      ).kind,
    ).toBe("valid");
    // No-loss declarations carry no observe and are never eligible.
    expect(
      GameReviewSessions.endStateEligibleRequirements([
        { id: "lose-free", kind: "lose", text: "No lose state" },
        {
          id: "two-failed",
          kind: "lose",
          text: "Two fails end the shift",
          observe: { key: "fails", expect: ">=2" },
        },
        { id: "look", kind: "presentation", text: "Look" },
        {
          id: "win-changes",
          kind: "win",
          text: "Win changes",
          observe: { key: "won", expect: "changes" },
        },
      ]),
    ).toEqual([{ id: "two-failed", kind: "lose", key: "fails", expect: ">=2" }]);
    // Legacy records without the frozen policy keep the old rule.
    expect(
      GameReviewSessions.parseCriticAnswer(
        JSON.stringify({
          fundamentals,
          defects: [],
          doNotRegress: [],
          requirements: [
            { id: "park-in-bay", verdict: "yes" as const, frameIds: ["f4"], note: "Win." },
          ],
        }),
        {
          frameIds: new Set(["f1", "f4"]),
          checkIds: new Set<string>(),
          recipeIds: new Set<string>(),
          requirementIds: ["park-in-bay"],
        },
      ).kind,
    ).toBe("valid");
  }),
);

it.live("tool path freezes the temporal policy across an approval revision", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = [
        {
          id: "park-in-bay",
          kind: "win",
          text: "Parking inside the marked bay after all 3 gates wins the run",
          observe: { key: "won", expect: "==1" },
        },
      ];
      scripted.childStatus = "running";
      const measuredEvidence = frameInput(frames);
      const withWon = {
        ...measuredEvidence,
        frames: measuredEvidence.frames.map((frame, index) => ({
          ...frame,
          observations: index === 0 ? { won: 0 as const } : { won: 1 as const },
        })),
      };
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: withWon,
      });
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      const caller = {
        threadId: started.childThreadId,
        providerInstanceId: builderSelection.instanceId,
      };
      const staticAnswer = {
        fundamentals,
        defects: [],
        doNotRegress: [],
        requirements: [
          { id: "park-in-bay", verdict: "yes" as const, frameIds: ["f2"], note: "Win screen." },
        ],
        quality,
      };
      const staticRefused = yield* service.report(caller, "critic", staticAnswer);
      expect(staticRefused.accepted).toBe(false);
      expect(staticRefused.error ?? "").toMatch(/before\/after|finished state|cannot-tell/i);
      // Midround approval revision replaces the promise; the frozen round
      // must still judge the original id with the original witness rule.
      scripted.designAcceptance = [
        {
          id: "replaced-promise",
          kind: "win",
          text: "A different promise entirely",
          observe: { key: "won", expect: "==1" },
        },
      ];
      const stillFrozen = yield* service.report(caller, "critic", staticAnswer);
      expect(stillFrozen.accepted).toBe(false);
      expect(stillFrozen.error ?? "").toMatch(/before\/after|finished state|cannot-tell/i);
      expect(stillFrozen.error ?? "").not.toContain("unknown or repeated");
      // A measured base pair alone still needs its separate measured
      // counterexample: run one ordinary-play try_input that stays unwon.
      scripted.tryScreenshots = ["before", "after"].map((phase) => ({
        label: `input 1 ${phase}`,
        mimeType: "image/png" as const,
        data: "cG5n",
        width: 640,
        height: 360,
        inputPair: {
          stepIndex: 0,
          phase: phase as "before" | "after",
          input: { press: "Space" },
          changedPercent: 25,
          stateChanges: [{ key: "state.won", before: 0, after: 0 }],
        },
        probe: { gameState: { won: 0 }, player: null },
      }));
      yield* service.tryInput(caller, { steps: [{ press: "Space" }] });
      const paired = yield* service.report(caller, "critic", {
        ...staticAnswer,
        requirements: [
          {
            id: "park-in-bay",
            verdict: "yes" as const,
            frameIds: ["f1", "f2"],
            note: "Won 0->1 on the parking drive.",
            challenge: {
              frameIds: ["try1f1", "try1f2"],
              note: "Drove without parking; won stayed 0, missing bay trigger tested.",
            },
          },
        ],
      });
      expect(paired.accepted).toBe(true);
    }),
  ),
);

it.live("terminal text path downgrades an unsupported yes instead of losing the review", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = [
        {
          id: "park-in-bay",
          kind: "win",
          text: "Parking inside the marked bay after all 3 gates wins the run",
          observe: { key: "won", expect: "==1" },
        },
      ];
      scripted.childStatus = "running";
      const measuredEvidence = frameInput(frames);
      const withWon = {
        ...measuredEvidence,
        frames: measuredEvidence.frames.map((frame, index) => ({
          ...frame,
          observations: index === 0 ? { won: 0 as const } : { won: 1 as const },
        })),
      };
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: withWon,
      });
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      const caller = {
        threadId: started.childThreadId,
        providerInstanceId: builderSelection.instanceId,
      };
      scripted.tryScreenshots = ["before", "after"].map((phase) => ({
        label: `input 1 ${phase}`,
        mimeType: "image/png" as const,
        data: "cG5n",
        width: 640,
        height: 360,
        inputPair: {
          stepIndex: 0,
          phase: phase as "before" | "after",
          input: { press: "Space" },
          changedPercent: 25,
          stateChanges: [{ key: "state.won", before: 0, after: 0 }],
        },
        probe: { gameState: { won: 0 }, player: null },
      }));
      yield* service.tryInput(caller, { steps: [{ press: "Space" }] });
      const staticText = JSON.stringify({
        fundamentals,
        defects: [],
        doNotRegress: [],
        requirements: [
          { id: "park-in-bay", verdict: "yes" as const, frameIds: ["f2"], note: "Win screen." },
        ],
        quality,
      });
      const pairedText = JSON.stringify({
        fundamentals,
        defects: [],
        doNotRegress: [],
        requirements: [
          {
            id: "park-in-bay",
            verdict: "yes" as const,
            frameIds: ["f1", "f2"],
            note: "Won 0->1 on the parking drive.",
            challenge: {
              frameIds: ["try1f1", "try1f2"],
              note: "Drove without parking; won stayed 0, missing bay trigger tested.",
            },
          },
        ],
        quality,
      });
      scripted.answer = staticText;
      scripted.childStatus = "completed";
      const terminalStatic = yield* service.answer({ threadId, loopId, roundId, role: "critic" });
      expect(terminalStatic.kind).toBe("critic");
      if (terminalStatic.kind !== "critic") return;
      expect(terminalStatic.answer.requirements).toHaveLength(1);
      expect(terminalStatic.answer.requirements?.[0]).toMatchObject({
        id: "park-in-bay",
        verdict: "cannot-tell",
        note: expect.stringMatching(/before\/after|finished state/i),
      });
      expect(terminalStatic.answer.downgradedRequirements).toHaveLength(1);
      expect(terminalStatic.answer.downgradedRequirements?.[0]).toMatchObject({
        id: "park-in-bay",
        reason: expect.stringMatching(/before\/after|finished state/i),
      });
      scripted.answer = pairedText;
      const terminalPaired = yield* service.answer({ threadId, loopId, roundId, role: "critic" });
      expect(terminalPaired.kind).toBe("critic");
    }),
  ),
);

it.live("end-state freeze keeps keys and observations across revision and restart", () =>
  withSession(({ frames, stateDir, scripted, service, restart }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = [
        {
          id: "park-in-bay",
          kind: "win",
          text: "Parking inside the marked bay after all 3 gates wins the run",
          observe: { key: "won", expect: "==1" },
        },
      ];
      scripted.childStatus = "running";
      const measuredEvidence = frameInput(frames);
      const withWon = {
        ...measuredEvidence,
        frames: measuredEvidence.frames.map((frame, index) => ({
          ...frame,
          observations:
            index === 0
              ? { won: 0 as const, collected: 5 as const }
              : { won: 1 as const, collected: 5 as const },
        })),
      };
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: withWon,
      });
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      // Only the frozen approved key rides the sealed manifest; unapproved
      // counters never reach the frozen record.
      const directory = yield* service.evidenceDirectory({
        threadId,
        loopId,
        roundId,
        role: "critic",
        order: 0,
      });
      const manifest = JSON.parse(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(directory!, "evidence.json"), "utf8"),
        ),
      ) as { frames: Array<{ id: string; observations?: Record<string, number | boolean> }> };
      expect(manifest.frames[0]?.observations).toEqual({ won: 0 });
      expect(manifest.frames[1]?.observations).toEqual({ won: 1 });
      const recordPath = NodePath.join(
        stateDir,
        (yield* Effect.promise(() => walk(stateDir))).find((file) =>
          file.endsWith("session.json"),
        )!,
      );
      const stored = JSON.parse(
        yield* Effect.promise(() => NodeFSP.readFile(recordPath, "utf8")),
      ) as { endStatePolicyVersion?: number; endStateRequirements?: unknown };
      expect(stored.endStatePolicyVersion).toBe(2);
      expect(stored.endStateRequirements).toEqual([
        { id: "park-in-bay", kind: "win", key: "won", expect: "==1" },
      ]);
      // Midround approval rewrites the key; the frozen exam still demands won.
      scripted.designAcceptance = [
        {
          id: "park-in-bay",
          kind: "win",
          text: "Parking wins",
          observe: { key: "collected", expect: ">=3" },
        },
      ];
      const caller = {
        threadId: started.childThreadId,
        providerInstanceId: builderSelection.instanceId,
      };
      scripted.tryScreenshots = ["before", "after"].map((phase) => ({
        label: `input 1 ${phase}`,
        mimeType: "image/png" as const,
        data: "cG5n",
        width: 640,
        height: 360,
        inputPair: {
          stepIndex: 0,
          phase: phase as "before" | "after",
          input: { press: "Space" },
          changedPercent: 25,
          stateChanges: [{ key: "state.won", before: 0, after: 0 }],
        },
        probe: { gameState: { won: 0, collected: 9 }, player: null },
      }));
      yield* service.tryInput(caller, { steps: [{ press: "Space" }] });
      // The try append also filters to the frozen key, not the revised one.
      const afterTry = JSON.parse(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(directory!, "evidence.json"), "utf8"),
        ),
      ) as { frames: Array<{ id: string; observations?: Record<string, number | boolean> }> };
      expect(afterTry.frames.find((frame) => frame.id === "try1f2")?.observations).toEqual({
        won: 0,
      });
      const good = {
        fundamentals,
        defects: [],
        doNotRegress: [],
        requirements: [
          {
            id: "park-in-bay",
            verdict: "yes" as const,
            frameIds: ["f1", "f2"],
            note: "Won 0->1 on the parking drive.",
            challenge: {
              frameIds: ["try1f1", "try1f2"],
              note: "Drove without parking; won stayed 0, missing bay trigger tested.",
            },
          },
        ],
        quality,
      };
      const resumed = yield* restart();
      const accepted = yield* resumed.report(caller, "critic", good);
      expect(accepted.accepted).toBe(true);
      // The prompt orders the critic to name the missing trigger in the
      // challenge note; the validator checks measurements and separation,
      // never the English semantics of that note.
    }),
  ),
);

it.live("invalid preflight cannot fabricate an observed challenge", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = [
        {
          id: "park-in-bay",
          kind: "win",
          text: "Parking inside the marked bay after all 3 gates wins the run",
          observe: { key: "won", expect: "==1" },
        },
      ];
      scripted.childStatus = "running";
      const measuredEvidence = frameInput(frames);
      const withWon = {
        ...measuredEvidence,
        frames: measuredEvidence.frames.map((frame, index) => ({
          ...frame,
          observations: index === 0 ? { won: 0 as const } : { won: 1 as const },
        })),
      };
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: withWon,
      });
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      const caller = {
        threadId: started.childThreadId,
        providerInstanceId: builderSelection.instanceId,
      };
      const invalid = yield* service
        .tryInput(caller, { steps: Array.from({ length: 13 }, () => ({ press: "w" })) })
        .pipe(Effect.flip);
      expect(invalid.detail).toContain("1–12 steps");
      expect(yield* service.inputCalls(caller.threadId, started.runId!)).toBe(0);
      // No try frames were recorded, so a challenge citing them is unknown.
      const fabricated = yield* service.report(caller, "critic", {
        fundamentals,
        defects: [],
        doNotRegress: [],
        requirements: [
          {
            id: "park-in-bay",
            verdict: "yes" as const,
            frameIds: ["f1", "f2"],
            note: "Won 0->1.",
            challenge: { frameIds: ["try1f1", "try1f2"], note: "Fabricated." },
          },
        ],
        quality,
      });
      expect(fabricated.accepted).toBe(false);
    }),
  ),
);

it.live("end-state v2 cross-terminal guard keeps kitchen pairs, refuses contamination", () =>
  Effect.sync(() => {
    const frozen = [
      { id: "finish-the-shift", kind: "win" as const, key: "won", expect: "==1" },
      { id: "two-failed-orders", kind: "lose" as const, key: "fails", expect: ">=2" },
    ];
    const mkFrames = (
      posBefore: Record<string, number | boolean> | undefined,
      posAfter: Record<string, number | boolean> | undefined,
      chalBefore: Record<string, number | boolean> | undefined,
      chalAfter: Record<string, number | boolean> | undefined,
    ) => [
      { id: "f1" },
      {
        id: "f3",
        inputPair: { stepIndex: 1, phase: "before" as const, input: { press: "s" } },
        ...(posBefore === undefined ? {} : { observations: posBefore }),
      },
      {
        id: "f4",
        inputPair: { stepIndex: 1, phase: "after" as const, input: { press: "s" } },
        ...(posAfter === undefined ? {} : { observations: posAfter }),
      },
      {
        id: "try1f1",
        inputPair: { stepIndex: 0, phase: "before" as const, input: { press: "Space" } },
        ...(chalBefore === undefined ? {} : { observations: chalBefore }),
      },
      {
        id: "try1f2",
        inputPair: { stepIndex: 0, phase: "after" as const, input: { press: "Space" } },
        ...(chalAfter === undefined ? {} : { observations: chalAfter }),
      },
    ];
    const knownFor = (frames: ReturnType<typeof mkFrames>, version?: number) => ({
      frameIds: new Set(frames.map((frame) => frame.id)),
      checkIds: new Set<string>(),
      recipeIds: new Set<string>(),
      requirementIds: ["finish-the-shift", "two-failed-orders"],
      temporalRequirementIds: [] as string[],
      endStateRequirements: frozen,
      ...(version === undefined ? {} : { endStatePolicyVersion: version }),
      evidenceFrames: frames,
    });
    const winYes = (challenge: unknown) =>
      JSON.stringify({
        fundamentals,
        defects: [],
        doNotRegress: [],
        requirements: [
          {
            id: "finish-the-shift",
            verdict: "yes" as const,
            frameIds: ["f3", "f4"],
            note: "Win trigger.",
            ...(challenge === undefined ? {} : { challenge }),
          },
          {
            id: "two-failed-orders",
            verdict: "cannot-tell" as const,
            frameIds: [],
            note: "No loss observed.",
          },
        ],
      });
    const loseYes = (challenge: unknown) =>
      JSON.stringify({
        fundamentals,
        defects: [],
        doNotRegress: [],
        requirements: [
          {
            id: "two-failed-orders",
            verdict: "yes" as const,
            frameIds: ["f3", "f4"],
            note: "Lose trigger.",
            ...(challenge === undefined ? {} : { challenge }),
          },
          {
            id: "finish-the-shift",
            verdict: "cannot-tell" as const,
            frameIds: [],
            note: "No win observed.",
          },
        ],
      });
    const goodChallenge = {
      frameIds: ["try1f1", "try1f2"],
      note: "Ordinary play without trigger; both scalars stayed down.",
    };
    // Valid kitchen-like win/lose pairs remain accepted under v2.
    expect(
      GameReviewSessions.parseCriticAnswer(
        winYes(goodChallenge),
        knownFor(
          mkFrames(
            { won: 0, fails: 0 },
            { won: 1, fails: 0 },
            { won: 0, fails: 0 },
            { won: 0, fails: 0 },
          ),
          2,
        ),
      ).kind,
    ).toBe("valid");
    expect(
      GameReviewSessions.parseCriticAnswer(
        loseYes(goodChallenge),
        knownFor(
          mkFrames(
            { won: 0, fails: 1 },
            { won: 0, fails: 2 },
            { won: 0, fails: 0 },
            { won: 0, fails: 0 },
          ),
          2,
        ),
      ).kind,
    ).toBe("valid");
    // Win challenge already lost.
    expect(
      GameReviewSessions.parseCriticAnswer(
        winYes(goodChallenge),
        knownFor(
          mkFrames(
            { won: 0, fails: 0 },
            { won: 1, fails: 0 },
            { won: 0, fails: 2 },
            { won: 0, fails: 2 },
          ),
          2,
        ),
      ).kind,
    ).toBe("invalid");
    // Lose challenge already won.
    expect(
      GameReviewSessions.parseCriticAnswer(
        loseYes(goodChallenge),
        knownFor(
          mkFrames(
            { won: 0, fails: 1 },
            { won: 0, fails: 2 },
            { won: 1, fails: 0 },
            { won: 1, fails: 0 },
          ),
          2,
        ),
      ).kind,
    ).toBe("invalid");
    // Positive starts already terminal (other predicate).
    expect(
      GameReviewSessions.parseCriticAnswer(
        winYes(goodChallenge),
        knownFor(
          mkFrames(
            { won: 0, fails: 2 },
            { won: 1, fails: 0 },
            { won: 0, fails: 0 },
            { won: 0, fails: 0 },
          ),
          2,
        ),
      ).kind,
    ).toBe("invalid");
    // Positive ends mutually contradictory (opposite kind after).
    expect(
      GameReviewSessions.parseCriticAnswer(
        winYes(goodChallenge),
        knownFor(
          mkFrames(
            { won: 0, fails: 0 },
            { won: 1, fails: 2 },
            { won: 0, fails: 0 },
            { won: 0, fails: 0 },
          ),
          2,
        ),
      ).kind,
    ).toBe("invalid");
    expect(
      GameReviewSessions.parseCriticAnswer(
        loseYes(goodChallenge),
        knownFor(
          mkFrames(
            { won: 0, fails: 1 },
            { won: 1, fails: 2 },
            { won: 0, fails: 0 },
            { won: 0, fails: 0 },
          ),
          2,
        ),
      ).kind,
    ).toBe("invalid");
    // Missing other terminal measurement fails closed to cannot-tell.
    expect(
      GameReviewSessions.parseCriticAnswer(
        winYes(goodChallenge),
        knownFor(
          mkFrames({ won: 0 }, { won: 1, fails: 0 }, { won: 0, fails: 0 }, { won: 0, fails: 0 }),
          2,
        ),
      ).kind,
    ).toBe("invalid");
    expect(
      GameReviewSessions.parseCriticAnswer(
        winYes({
          frameIds: ["try1f1", "try1f2"],
          note: "Missing fails measurement.",
        }),
        knownFor(mkFrames({ won: 0, fails: 0 }, { won: 1, fails: 0 }, { won: 0 }, { won: 0 }), 2),
      ).kind,
    ).toBe("invalid");
    // Neutral cannot-tell stays valid when measurement is missing.
    expect(
      GameReviewSessions.parseCriticAnswer(
        JSON.stringify({
          fundamentals,
          defects: [],
          doNotRegress: [],
          requirements: [
            {
              id: "finish-the-shift",
              verdict: "cannot-tell" as const,
              frameIds: [],
              note: "No win observed.",
            },
            {
              id: "two-failed-orders",
              verdict: "cannot-tell" as const,
              frameIds: [],
              note: "No loss observed.",
            },
          ],
        }),
        knownFor(mkFrames({ won: 0 }, { won: 1, fails: 0 }, { won: 0 }, { won: 0 }), 2),
      ).kind,
    ).toBe("valid");
    // Same-kind simultaneous completion remains valid under v2.
    const sameKindFrozen = [
      { id: "win-a", kind: "win" as const, key: "won", expect: "==1" },
      { id: "win-b", kind: "win" as const, key: "collected", expect: ">=3" },
    ];
    const sameKindFrames = [
      { id: "f1" },
      {
        id: "f3",
        inputPair: { stepIndex: 1, phase: "before" as const, input: { press: "s" } },
        observations: { won: 0, collected: 0 },
      },
      {
        id: "f4",
        inputPair: { stepIndex: 1, phase: "after" as const, input: { press: "s" } },
        observations: { won: 1, collected: 3 },
      },
      {
        id: "try1f1",
        inputPair: { stepIndex: 0, phase: "before" as const, input: { press: "Space" } },
        observations: { won: 0, collected: 0 },
      },
      {
        id: "try1f2",
        inputPair: { stepIndex: 0, phase: "after" as const, input: { press: "Space" } },
        observations: { won: 0, collected: 0 },
      },
    ];
    expect(
      GameReviewSessions.parseCriticAnswer(
        JSON.stringify({
          fundamentals,
          defects: [],
          doNotRegress: [],
          requirements: [
            {
              id: "win-a",
              verdict: "yes" as const,
              frameIds: ["f3", "f4"],
              note: "Both win predicates describe the same ending.",
              challenge: goodChallenge,
            },
            {
              id: "win-b",
              verdict: "cannot-tell" as const,
              frameIds: [],
              note: "Same ending as win-a; not separately judged.",
            },
          ],
        }),
        {
          frameIds: new Set(sameKindFrames.map((frame) => frame.id)),
          checkIds: new Set<string>(),
          recipeIds: new Set<string>(),
          requirementIds: ["win-a", "win-b"],
          temporalRequirementIds: [] as string[],
          endStateRequirements: sameKindFrozen,
          endStatePolicyVersion: 2,
          evidenceFrames: sameKindFrames,
        },
      ).kind,
    ).toBe("valid");
    // Version 1 and legacy keep the own-predicate-only rule.
    const crossTerminal = mkFrames(
      { won: 0, fails: 0 },
      { won: 1, fails: 0 },
      { won: 0, fails: 2 },
      { won: 0, fails: 2 },
    );
    expect(
      GameReviewSessions.parseCriticAnswer(winYes(goodChallenge), knownFor(crossTerminal, 1)).kind,
    ).toBe("valid");
    expect(
      GameReviewSessions.parseCriticAnswer(winYes(goodChallenge), knownFor(crossTerminal)).kind,
    ).toBe("valid");
  }),
);

it.live("end-state v2 session report enforces fully non-terminal and freezes version", () =>
  withSession(({ frames, stateDir, scripted, service, restart }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = [
        {
          id: "finish-the-shift",
          kind: "win",
          text: "Serving all three wins the shift",
          observe: { key: "won", expect: "==1" },
        },
        {
          id: "two-failed-orders",
          kind: "lose",
          text: "Two failed orders end the shift",
          observe: { key: "fails", expect: ">=2" },
        },
      ];
      scripted.childStatus = "running";
      const measuredEvidence = frameInput(frames);
      const withBoth = {
        ...measuredEvidence,
        frames: measuredEvidence.frames.map((frame, index) => ({
          ...frame,
          observations:
            index === 0
              ? { won: 0 as const, fails: 0 as const }
              : { won: 1 as const, fails: 0 as const },
        })),
      };
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: withBoth,
      });
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      const recordPath = NodePath.join(
        stateDir,
        (yield* Effect.promise(() => walk(stateDir))).find((file) =>
          file.endsWith("session.json"),
        )!,
      );
      const stored = JSON.parse(
        yield* Effect.promise(() => NodeFSP.readFile(recordPath, "utf8")),
      ) as { endStatePolicyVersion?: number; endStateRequirements?: unknown };
      expect(stored.endStatePolicyVersion).toBe(2);
      const sealedPath = NodePath.join(
        stateDir,
        (yield* Effect.promise(() => walk(stateDir))).find((file) =>
          file.endsWith("END_STATE_REQUIREMENTS.json"),
        )!,
      );
      const sealed = JSON.parse(
        yield* Effect.promise(() => NodeFSP.readFile(sealedPath, "utf8")),
      ) as { policyVersion?: number };
      expect(sealed.policyVersion).toBe(2);
      const resumed = yield* restart();
      const reread = JSON.parse(
        yield* Effect.promise(() => NodeFSP.readFile(recordPath, "utf8")),
      ) as { endStatePolicyVersion?: number };
      expect(reread.endStatePolicyVersion).toBe(2);
      const caller = {
        threadId: started.childThreadId,
        providerInstanceId: builderSelection.instanceId,
      };
      // Challenge already lost (fails 2) must be refused under v2, even after restart.
      scripted.tryScreenshots = ["before", "after"].map((phase) => ({
        label: `input 1 ${phase}`,
        mimeType: "image/png" as const,
        data: "cG5n",
        width: 640,
        height: 360,
        inputPair: {
          stepIndex: 0,
          phase: phase as "before" | "after",
          input: { press: "Space" },
          changedPercent: 0,
          stateChanges: [],
        },
        probe: { gameState: { won: 0, fails: 2 }, player: null },
      }));
      yield* resumed.tryInput(caller, { steps: [{ press: "Space" }] });
      const refused = yield* resumed.report(caller, "critic", {
        fundamentals,
        defects: [],
        doNotRegress: [],
        requirements: [
          {
            id: "finish-the-shift",
            verdict: "yes" as const,
            frameIds: ["f1", "f2"],
            note: "Won 0->1.",
            challenge: { frameIds: ["try1f1", "try1f2"], note: "Already lost; fails stayed 2." },
          },
          {
            id: "two-failed-orders",
            verdict: "cannot-tell" as const,
            frameIds: [],
            note: "Not judged.",
          },
        ],
        quality,
      });
      expect(refused.accepted).toBe(false);
      expect(refused.error ?? "").toMatch(/terminal|cross-terminal|non-terminal|opposite/i);
      // Fully non-terminal challenge stays accepted under v2.
      scripted.tryScreenshots = ["before", "after"].map((phase) => ({
        label: `input 2 ${phase}`,
        mimeType: "image/png" as const,
        data: "cG5n",
        width: 640,
        height: 360,
        inputPair: {
          stepIndex: 0,
          phase: phase as "before" | "after",
          input: { press: "ArrowLeft" },
          changedPercent: 0,
          stateChanges: [],
        },
        probe: { gameState: { won: 0, fails: 0 }, player: null },
      }));
      yield* resumed.tryInput(caller, { steps: [{ press: "ArrowLeft" }] });
      const accepted = yield* resumed.report(caller, "critic", {
        fundamentals,
        defects: [],
        doNotRegress: [],
        requirements: [
          {
            id: "finish-the-shift",
            verdict: "yes" as const,
            frameIds: ["f1", "f2"],
            note: "Won 0->1 from fully non-terminal before.",
            challenge: {
              frameIds: ["try2f1", "try2f2"],
              note: "Ordinary play without trigger; both stayed down.",
            },
          },
          {
            id: "two-failed-orders",
            verdict: "cannot-tell" as const,
            frameIds: [],
            note: "Not judged.",
          },
        ],
        quality,
      });
      expect(accepted.accepted).toBe(true);
    }),
  ),
);

it.live("end-state v2 terminal answer downgrades an opposite-kind yes", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = [
        {
          id: "finish-the-shift",
          kind: "win",
          text: "Serving all three wins the shift",
          observe: { key: "won", expect: "==1" },
        },
        {
          id: "two-failed-orders",
          kind: "lose",
          text: "Two failed orders end the shift",
          observe: { key: "fails", expect: ">=2" },
        },
      ];
      scripted.childStatus = "running";
      const measuredEvidence = frameInput(frames);
      const withBoth = {
        ...measuredEvidence,
        frames: measuredEvidence.frames.map((frame, index) => ({
          ...frame,
          observations:
            index === 0
              ? { won: 0 as const, fails: 0 as const }
              : { won: 1 as const, fails: 2 as const },
        })),
      };
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: withBoth,
      });
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      const caller = {
        threadId: started.childThreadId,
        providerInstanceId: builderSelection.instanceId,
      };
      scripted.tryScreenshots = ["before", "after"].map((phase) => ({
        label: `input 1 ${phase}`,
        mimeType: "image/png" as const,
        data: "cG5n",
        width: 640,
        height: 360,
        inputPair: {
          stepIndex: 0,
          phase: phase as "before" | "after",
          input: { press: "Space" },
          changedPercent: 0,
          stateChanges: [],
        },
        probe: { gameState: { won: 0, fails: 0 }, player: null },
      }));
      yield* service.tryInput(caller, { steps: [{ press: "Space" }] });
      // Positive after reaches the opposite kind (won 1 fails 2): invalid under v2.
      scripted.answer = JSON.stringify({
        fundamentals,
        defects: [],
        doNotRegress: [],
        requirements: [
          {
            id: "finish-the-shift",
            verdict: "yes" as const,
            frameIds: ["f1", "f2"],
            note: "Won but also already lost.",
            challenge: { frameIds: ["try1f1", "try1f2"], note: "Ordinary play stayed down." },
          },
          {
            id: "two-failed-orders",
            verdict: "cannot-tell" as const,
            frameIds: [],
            note: "Not judged.",
          },
        ],
        quality,
      });
      scripted.childStatus = "completed";
      const rescued = yield* service.answer({ threadId, loopId, roundId, role: "critic" });
      expect(rescued.kind).toBe("critic");
      if (rescued.kind !== "critic") return;
      expect(rescued.answer.requirements?.[0]).toMatchObject({
        id: "finish-the-shift",
        verdict: "cannot-tell",
        note: expect.stringMatching(/opposite|cross-terminal|fully non-terminal/i),
      });
      expect(rescued.answer.downgradedRequirements).toHaveLength(1);
      expect(rescued.answer.downgradedRequirements?.[0]).toMatchObject({
        id: "finish-the-shift",
        reason: expect.stringMatching(/opposite|cross-terminal|fully non-terminal/i),
      });
    }),
  ),
);

it.live("try_input appends are citable witnesses for the frozen temporal rule", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = [
        {
          id: "drive-gate1",
          kind: "control",
          text: "WASD driving carries the crate through gate 1",
          observe: { key: "collected", expect: ">=1" },
        },
      ];
      scripted.childStatus = "running";
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      const caller = {
        threadId: started.childThreadId,
        providerInstanceId: builderSelection.instanceId,
      };
      yield* service.tryInput(caller, { steps: [{ press: "Space" }] });
      const base = {
        fundamentals,
        defects: [],
        doNotRegress: [],
        quality,
      };
      const staticTry = yield* service.report(caller, "critic", {
        ...base,
        requirements: [
          { id: "drive-gate1", verdict: "yes" as const, frameIds: ["try1f2"], note: "After only." },
        ],
      });
      expect(staticTry.accepted).toBe(false);
      const pairedTry = yield* service.report(caller, "critic", {
        ...base,
        requirements: [
          {
            id: "drive-gate1",
            verdict: "yes" as const,
            frameIds: ["try1f1", "try1f2"],
            note: "Same try_input press transition.",
          },
        ],
      });
      expect(pairedTry.accepted).toBe(true);
    }),
  ),
);

const kitchenAcceptance = [
  {
    id: "add-ingredient",
    kind: "control" as const,
    text: "Clicking ingredients fills the pan",
    observe: { key: "added", expect: ">=2" },
  },
  {
    id: "start-cooking",
    kind: "control" as const,
    text: "Cook puts the full pan on the burner",
    observe: { key: "on_burner", expect: ">=1" },
  },
  {
    id: "empty-pan",
    kind: "control" as const,
    text: "Empty clears a filled pan without failing",
    observe: { key: "emptied", expect: ">=1" },
  },
  {
    id: "bad-serve-fails",
    kind: "mechanic" as const,
    text: "Serving early or wrong fails that order",
    observe: { key: "fails", expect: ">=1" },
  },
  {
    id: "serve-all-three",
    kind: "content" as const,
    text: "All three customers are served",
    observe: { key: "served", expect: ">=3" },
  },
  {
    id: "finish-the-shift",
    kind: "win" as const,
    text: "Serving all three wins the shift",
    observe: { key: "won", expect: "==1" },
  },
  {
    id: "two-failed-orders",
    kind: "lose" as const,
    text: "Two failed orders end the shift",
    observe: { key: "fails", expect: ">=2" },
  },
  {
    id: "copper-kitchen-look",
    kind: "presentation" as const,
    text: "Copper kitchen with tickets and pan",
  },
];

const kitchenRequirements = [
  { id: "add-ingredient", verdict: "yes" as const, frameIds: ["f1", "f2"], note: "Press adds." },
  { id: "start-cooking", verdict: "yes" as const, frameIds: ["f1", "f2"], note: "Cook works." },
  {
    id: "empty-pan",
    verdict: "cannot-tell" as const,
    frameIds: [],
    note: "No empty observed.",
  },
  {
    id: "bad-serve-fails",
    verdict: "cannot-tell" as const,
    frameIds: [],
    note: "No early serve observed.",
  },
  {
    id: "serve-all-three",
    verdict: "cannot-tell" as const,
    frameIds: [],
    note: "Only first order served.",
  },
  {
    id: "finish-the-shift",
    verdict: "cannot-tell" as const,
    frameIds: [],
    note: "No win screen observed.",
  },
  {
    id: "two-failed-orders",
    verdict: "cannot-tell" as const,
    frameIds: [],
    note: "No loss observed.",
  },
  {
    id: "copper-kitchen-look",
    verdict: "cannot-tell" as const,
    frameIds: [],
    note: "Look not judged for play.",
  },
];

it.live(
  "coverage work rule refuses a static no-defect unknown then accepts after one try_input",
  () =>
    withSession(({ frames, scripted, service }) =>
      Effect.gen(function* () {
        scripted.designAcceptance = [...kitchenAcceptance];
        scripted.childStatus = "running";
        const started = yield* service.start({
          threadId,
          loopId,
          roundId,
          role: "critic",
          evidence: frameInput(frames),
        });
        expect(started.kind).toBe("started");
        if (started.kind !== "started") return;
        const caller = {
          threadId: started.childThreadId,
          providerInstanceId: builderSelection.instanceId,
        };
        const payload = {
          fundamentals,
          defects: [],
          doNotRegress: [],
          requirements: kitchenRequirements,
          quality,
        };
        const first = yield* service.report(caller, "critic", payload);
        expect(first.accepted).toBe(false);
        expect(first.error ?? "").toContain("finish-the-shift");
        expect(first.error ?? "").toContain("game_try_input");
        expect(first.attemptsRemaining).toBe(2);
        expect(first.ended).toBe(false);
        expect(yield* service.inputCalls(caller.threadId, started.runId!)).toBe(0);
        expect(scripted.tries).toHaveLength(0);

        yield* service.tryInput(caller, { steps: [{ press: "Space" }] });
        expect(yield* service.inputCalls(caller.threadId, started.runId!)).toBe(1);
        expect(scripted.tries).toHaveLength(1);

        const second = yield* service.report(caller, "critic", payload);
        expect(second.accepted).toBe(true);
        expect(second.error).toBeNull();
      }),
    ),
);

it.live("terminal text path enforces the same coverage work rule", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = [...kitchenAcceptance];
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      const payload = {
        fundamentals,
        defects: [],
        doNotRegress: [],
        requirements: kitchenRequirements,
        quality,
      };
      scripted.answer = JSON.stringify(payload);
      scripted.childStatus = "completed";
      const refused = yield* service.answer({ threadId, loopId, roundId, role: "critic" });
      expect(refused.kind).toBe("invalid");
      if (refused.kind === "invalid") {
        expect(refused.reason).toContain("finish-the-shift");
        expect(refused.reason).toContain("game_try_input");
      }
    }),
  ),
);

it.live("a valid earlier attempt already counts and a failed bounded attempt may abstain", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = [...kitchenAcceptance];
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
      const payload = {
        fundamentals,
        defects: [],
        doNotRegress: [],
        requirements: kitchenRequirements,
        quality,
      };
      scripted.tryScreenshots = [];
      yield* service.tryInput(caller, { steps: [{ press: "Space" }] });
      expect(yield* service.inputCalls(caller.threadId, started.runId!)).toBe(1);
      const accepted = yield* service.report(caller, "critic", payload);
      expect(accepted.accepted).toBe(true);
    }),
  ),
);

it.live("presentation-only unknowns do not force physical play", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = [
        { id: "copper-kitchen-look", kind: "presentation" as const, text: "Copper look" },
      ];
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
      const accepted = yield* service.report(caller, "critic", {
        fundamentals,
        defects: [],
        doNotRegress: [],
        requirements: [
          {
            id: "copper-kitchen-look",
            verdict: "cannot-tell" as const,
            frameIds: [],
            note: "Look.",
          },
        ],
        quality,
      });
      expect(accepted.accepted).toBe(true);
    }),
  ),
);

it.live("requirement no skips the coverage work rule", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = [...kitchenAcceptance];
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
      const actionable = kitchenRequirements.map((entry) =>
        entry.id === "empty-pan"
          ? { ...entry, verdict: "no" as const, frameIds: ["f1"], note: "Observed missing." }
          : entry,
      );
      const accepted = yield* service.report(caller, "critic", {
        fundamentals,
        defects: [],
        doNotRegress: [],
        requirements: actionable,
        quality,
      });
      expect(accepted.accepted).toBe(true);
    }),
  ),
);

it.live("quality no and fundamental no skip the coverage work rule", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = [...kitchenAcceptance];
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
      const qualityNo = {
        ...quality,
        readability: { verdict: "no" as const, frameIds: ["f1"], note: "Contradicts consequence." },
      };
      const acceptedQualityNo = yield* service.report(caller, "critic", {
        fundamentals,
        defects: [],
        doNotRegress: [],
        requirements: kitchenRequirements,
        quality: qualityNo,
      });
      expect(acceptedQualityNo.accepted).toBe(true);
    }),
  ),
);

it.live("fundamental no skips the coverage work rule", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = [...kitchenAcceptance];
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
      const accepted = yield* service.report(caller, "critic", {
        fundamentals: {
          ...fundamentals,
          respondsToInput: { verdict: "no" as const, frameIds: ["f1"], note: "No response." },
        },
        defects: [],
        doNotRegress: [],
        requirements: kitchenRequirements,
        quality,
      });
      expect(accepted.accepted).toBe(true);
    }),
  ),
);

it.live("non-booting and actionable reports skip the work rule", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = [...kitchenAcceptance];
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
      const base = {
        defects: [] as const,
        doNotRegress: [] as const,
        requirements: kitchenRequirements,
        quality,
      };
      const notBooting = yield* service.report(caller, "critic", {
        ...base,
        fundamentals: {
          ...fundamentals,
          boots: { verdict: "cannot-tell" as const, frameIds: [], note: "No boot." },
        },
      });
      expect(notBooting.accepted).toBe(true);
    }),
  ),
);

it.live("actionable reports with defects or no verdicts skip the work rule", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = [...kitchenAcceptance];
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
      const withDefect = yield* service.report(caller, "critic", {
        fundamentals,
        defects: [
          {
            severity: "visible" as const,
            what: "Fault",
            frameId: "f1",
            fix: "Fix it; yes/no: fixed.",
          },
        ],
        doNotRegress: [],
        requirements: kitchenRequirements,
        quality,
      });
      expect(withDefect.accepted).toBe(true);
    }),
  ),
);

it.live("legacy sessions without the frozen work flag stay compatible", () =>
  withSession(({ stateDir, frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = null;
      scripted.childStatus = "running";
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      if (started.kind !== "started") return expect(started.kind).toBe("started");
      const recordPath = NodePath.join(
        stateDir,
        (yield* Effect.promise(() => walk(stateDir))).find((file) =>
          file.endsWith("session.json"),
        )!,
      );
      const stored = JSON.parse(
        yield* Effect.promise(() => NodeFSP.readFile(recordPath, "utf8")),
      ) as Record<string, unknown>;
      expect(stored["coverageAttemptPolicyVersion"]).toBeUndefined();
      const caller = {
        threadId: started.childThreadId,
        providerInstanceId: builderSelection.instanceId,
      };
      const accepted = yield* service.report(caller, "critic", {
        fundamentals,
        defects: [],
        doNotRegress: [],
        quality,
      });
      expect(accepted.accepted).toBe(true);
    }),
  ),
);

it.live("the work flag freezes across approval edits and restarts", () =>
  withSession(({ stateDir, frames, scripted, service, restart }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = [...kitchenAcceptance];
      scripted.childStatus = "running";
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: frameInput(frames),
      });
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      const recordPath = NodePath.join(
        stateDir,
        (yield* Effect.promise(() => walk(stateDir))).find((file) =>
          file.endsWith("session.json"),
        )!,
      );
      const stored = JSON.parse(
        yield* Effect.promise(() => NodeFSP.readFile(recordPath, "utf8")),
      ) as { coverageAttemptPolicyVersion?: number; temporalRequirementIds?: string[] };
      expect(stored.coverageAttemptPolicyVersion).toBe(1);
      expect(stored.temporalRequirementIds).toContain("finish-the-shift");
      const caller = {
        threadId: started.childThreadId,
        providerInstanceId: builderSelection.instanceId,
      };
      const payload = {
        fundamentals,
        defects: [],
        doNotRegress: [],
        requirements: kitchenRequirements,
        quality,
      };
      scripted.designAcceptance = [
        {
          id: "replaced-promise",
          kind: "win" as const,
          text: "Different",
          observe: { key: "won", expect: "==1" },
        },
      ];
      const stillFrozen = yield* (yield* restart()).report(caller, "critic", payload);
      expect(stillFrozen.accepted).toBe(false);
      expect(stillFrozen.error ?? "").toContain("finish-the-shift");
      expect(stillFrozen.error ?? "").not.toContain("unknown or repeated");
    }),
  ),
);

it.live("invalid preflight requests do not count as coverage attempts", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      scripted.designAcceptance = [...kitchenAcceptance];
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
      const invalid = yield* service
        .tryInput(caller, { steps: Array.from({ length: 13 }, () => ({ press: "w" })) })
        .pipe(Effect.flip);
      expect(invalid.detail).toContain("1–12 steps");
      expect(yield* service.inputCalls(caller.threadId, started.runId!)).toBe(0);
      const payload = {
        fundamentals,
        defects: [],
        doNotRegress: [],
        requirements: kitchenRequirements,
        quality,
      };
      const refused = yield* service.report(caller, "critic", payload);
      expect(refused.accepted).toBe(false);
      expect(scripted.tries).toHaveLength(0);
    }),
  ),
);

it.live.skipIf(process.env.GAME_REVIEW_END_STATE_LIVE !== "1")(
  "real browser observations survive sealed session evidence and the challenge guard",
  () =>
    withSession(({ service, scripted, frames, stateDir }) =>
      Effect.gen(function* () {
        const html = `<!doctype html><canvas width="640" height="360" tabindex="0"></canvas><script>
      const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d');
      let won = false;
      const paint = () => {ctx.fillStyle = won ? '#80d080' : '#305080'; ctx.fillRect(0,0,640,360);};
      paint();
      addEventListener('keydown', event => {if(event.code === 'Space') won = true; paint();});
      window.__studioProbe = () => JSON.stringify({gameState:{won, unrelated:17},player:null});
      console.log('Godot Engine v4 browser fixture');
    </script>`;
        const server = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<NodeHttp.Server>((resolve) => {
                const server = NodeHttp.createServer((_request, response) => {
                  response.writeHead(200, { "Content-Type": "text/html" });
                  response.end(html);
                });
                server.listen(0, "127.0.0.1", () => resolve(server));
              }),
          ),
          (server) =>
            Effect.promise(
              () =>
                new Promise<void>((resolve, reject) =>
                  server.close((error) => (error ? reject(error) : resolve())),
                ),
            ),
        );
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("No loopback address");
        scripted.designAcceptance = [
          {
            id: "finish",
            kind: "win",
            text: "Space completes the round.",
            observe: { key: "won", expect: "==1" },
          },
        ];
        scripted.childStatus = "running";
        const started = yield* service.start({
          threadId,
          loopId,
          roundId,
          role: "critic",
          evidence: frameInput(frames),
        });
        expect(started.kind).toBe("started");
        if (started.kind !== "started") return;
        const caller = {
          threadId: started.childThreadId,
          providerInstanceId: builderSelection.instanceId,
        };
        const platform = yield* HostProcess.Platform;
        const release = previewBrowserRelease(platform, yield* HostProcess.Architecture);
        if (release === null) throw new Error("Managed preview browser unsupported on this host");
        const executable =
          process.env.GAME_REVIEW_BROWSER_EXECUTABLE ??
          NodePath.resolve(
            import.meta.dirname,
            "../../../../.t3/tools/chrome-headless-shell",
            release.platform,
            release.version,
            platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell",
          );
        const run = (key: string, name: string) =>
          playtest({
            executable,
            url: `http://127.0.0.1:${address.port}`,
            profileDirectory: NodePath.join(stateDir, name),
            width: 640,
            height: 360,
            bootTimeoutMs: 5000,
            probeRequired: false,
            acceptance: null,
            captureAllSteps: true,
            steps: [{ press: key }, { waitMs: 100 }],
          });
        scripted.liveResult = yield* run("Space", "positive-browser");
        expect(scripted.liveResult.booted).toBe(true);
        const positive = yield* service.tryInput(caller, {
          steps: [{ press: "Space" }, { waitMs: 100 }],
        });
        scripted.liveResult = yield* run("ArrowLeft", "challenge-browser");
        const challenge = yield* service.tryInput(caller, {
          steps: [{ press: "ArrowLeft" }, { waitMs: 100 }],
        });
        const pairIds = (result: typeof positive) =>
          result.screenshots
            .filter((frame) => frame.inputPair?.stepIndex === 0)
            .map((frame) => frame.frameId!);
        const positiveIds = pairIds(positive),
          challengeIds = pairIds(challenge);
        expect(positiveIds).toHaveLength(2);
        expect(challengeIds).toHaveLength(2);
        const accepted = yield* service.report(caller, "critic", {
          fundamentals,
          defects: [],
          doNotRegress: [],
          quality,
          requirements: [
            {
              id: "finish",
              verdict: "yes",
              frameIds: positiveIds,
              note: "Space changed won false to true.",
              challenge: {
                frameIds: challengeIds,
                note: "Moving left without pressing Space did not finish.",
              },
            },
          ],
        });
        expect(accepted.accepted).toBe(true);
        const directory = yield* service.evidenceDirectory({
          threadId,
          loopId,
          roundId,
          role: "critic",
          order: 0,
        });
        expect(directory).not.toBeNull();
        const predicates = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(directory!, "END_STATE_REQUIREMENTS.json"), "utf8"),
        );
        expect(predicates).toContain('"key": "won"');
        expect(predicates).toContain('"expect": "==1"');
        const frozen = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(directory!, "evidence.json"), "utf8"),
        );
        expect(frozen).toContain('"observations"');
        expect(frozen).not.toContain('"unrelated"');
      }),
    ),
  60_000,
);

const worldTextForSession = () =>
  `${JSON.stringify(
    {
      note: "Same-source headless world measurements at probe frames; verify on Web frames, never cite as proof. containsPlayerOrigin tests the probed origin point only.",
      sourceId: "sources",
      evidenceDirectory: "builds/logs/scenarios-1",
      scenarios: [
        {
          id: "full-run",
          spatial: {
            snapshots: [
              {
                scenarioFrame: 30,
                step: null,
                player: {
                  present: true,
                  position: [100, 200],
                  velocity: [0, 0],
                  bodyKind: "CharacterBody2D",
                },
                areas: [
                  {
                    nodePath: "Main/Zone",
                    type: "Area2D",
                    monitoring: true,
                    monitorable: true,
                    visible: true,
                    shapes: [
                      {
                        nodePath: "Main/Zone/Shape",
                        shapeKind: "RectangleShape2D",
                        disabled: false,
                        bounds: { kind: "rect2", min: [50, 150], max: [150, 250] },
                        conservative: false,
                        containsPlayerOrigin: true,
                      },
                    ],
                  },
                ],
              },
            ],
            coverage: {
              snapshots: 1,
              omittedSnapshots: 0,
              visitedNodes: 42,
              areas: 1,
              shapes: 1,
              skippedFreed: 0,
              truncated: false,
            },
          },
        },
      ],
      omitted: 0,
      truncated: false,
    },
    null,
    2,
  )}\n`;

it.live("a critic start seals native world byte-exact with hash and stable reuse", () =>
  withSession(({ frames, scripted, service, restart }) =>
    Effect.gen(function* () {
      const text = worldTextForSession();
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(32_768);
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: {
          ...frameInput(frames),
          nativeWorld: {
            sourceId: "sources",
            evidenceDirectory: "builds/logs/scenarios-1",
            text,
          },
        },
      });
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      expect(started.reconciled).toBe(false);
      expect(started.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
      const command = scripted.dispatches[0]!;
      expect(command.type).toBe("game-round.task.request");
      if (command.type !== "game-round.task.request") return;
      const directory = command.evidenceDirectory!;
      // Byte-exact: the sealed file equals the Studio text, no slicing.
      const sealed = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(directory, "NATIVE_WORLD.json"), "utf8"),
      );
      expect(sealed).toBe(text);
      expect(() => JSON.parse(sealed)).not.toThrow();
      expect(sealed).toContain("containsPlayerOrigin");
      // FILES/manifest discoverability: prompt lists the file, evidence.json
      // keeps root frames/check ids unchanged.
      expect(command.task).toContain("NATIVE_WORLD.json (same-source headless world measurements");
      const files = yield* Effect.promise(() => walk(directory));
      expect(files).toContain("NATIVE_WORLD.json");
      expect(files).toContain("evidence.json");
      const manifest = JSON.parse(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(directory, "evidence.json"), "utf8"),
        ),
      ) as { frames: Array<{ id: string }>; checks: Array<{ id: string }> };
      expect(manifest.frames.map((frame) => frame.id)).toEqual(["f1", "f2"]);
      expect(manifest.checks.map((check) => check.id)).toEqual(["boot", "input"]);
      // Evidence hash includes the world file: it matches the stored hash.
      expect(yield* service.evidenceHash({ threadId, loopId, roundId, role: "critic" })).toBe(
        started.evidenceHash,
      );
      // Restart/frozen reuse is stable: same child, same hash, no new dispatch
      // and no new approval/measurement rewrite.
      const dispatchesBefore = scripted.dispatches.length;
      const second = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: {
          ...frameInput(frames),
          nativeWorld: {
            sourceId: "sources",
            evidenceDirectory: "builds/logs/scenarios-1",
            text,
          },
        },
      });
      expect(second.kind).toBe("started");
      if (second.kind !== "started") return;
      expect(second.reconciled).toBe(true);
      expect(second.childThreadId).toBe(started.childThreadId);
      expect(second.evidenceHash).toBe(started.evidenceHash);
      expect(scripted.dispatches.length).toBe(dispatchesBefore);
      const resumed = yield* restart();
      const third = yield* resumed.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: {
          ...frameInput(frames),
          nativeWorld: {
            sourceId: "sources",
            evidenceDirectory: "builds/logs/scenarios-1",
            text,
          },
        },
      });
      expect(third.kind).toBe("started");
      if (third.kind !== "started") return;
      expect(third.reconciled).toBe(true);
      expect(third.evidenceHash).toBe(started.evidenceHash);
      const resealed = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(directory, "NATIVE_WORLD.json"), "utf8"),
      );
      expect(resealed).toBe(text);
    }),
  ),
);

it.live("tampering native world invalidates the answer while legacy absence stays valid", () =>
  withSession(({ frames, scripted, service }) =>
    Effect.gen(function* () {
      const text = worldTextForSession();
      const started = yield* service.start({
        threadId,
        loopId,
        roundId,
        role: "critic",
        evidence: {
          ...frameInput(frames),
          nativeWorld: {
            sourceId: "sources",
            evidenceDirectory: "builds/logs/scenarios-1",
            text,
          },
        },
      });
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      scripted.answer = criticText;
      expect(yield* service.answer({ threadId, loopId, roundId, role: "critic" })).toMatchObject({
        kind: "critic",
      });
      const directory = yield* service.evidenceDirectory({
        threadId,
        loopId,
        roundId,
        role: "critic",
      });
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(directory!, "NATIVE_WORLD.json"), "tampered"),
      );
      const tampered = yield* service.answer({ threadId, loopId, roundId, role: "critic" });
      expect(tampered.kind).toBe("invalid");
      if (tampered.kind === "invalid") expect(tampered.reason).toContain("evidence changed");
    }),
  ),
);

it.live("legacy sessions without native world review exactly as before", () =>
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
      const command = scripted.dispatches[0]!;
      expect(command.type).toBe("game-round.task.request");
      if (command.type !== "game-round.task.request") return;
      // The static prompt always names the optional file "when present";
      // the FILES listing is what must omit it for legacy sessions.
      expect(command.task).not.toContain("NATIVE_WORLD.json (same-source");
      const files = yield* Effect.promise(() => walk(command.evidenceDirectory!));
      expect(files).not.toContain("NATIVE_WORLD.json");
      expect(files).toEqual([
        "BRIEF.md",
        "evidence.json",
        "frames/frame-01.png",
        "frames/frame-02.png",
      ]);
      scripted.answer = criticText;
      expect(yield* service.answer({ threadId, loopId, roundId, role: "critic" })).toMatchObject({
        kind: "critic",
      });
    }),
  ),
);

it.live("oversized or invalid native world is honestly omitted without breaking the review", () =>
  Effect.gen(function* () {
    const valid = worldTextForSession();
    const oversized = `${valid}${"x".repeat(40_000)}`;
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(32_768);
    const cases = [oversized, "not json", ""];
    for (const text of cases) {
      yield* withSession(({ frames, scripted, service }) =>
        Effect.gen(function* () {
          const started = yield* service.start({
            threadId,
            loopId,
            roundId,
            role: "critic",
            evidence: {
              ...frameInput(frames),
              nativeWorld: {
                sourceId: "sources",
                evidenceDirectory: "builds/logs/scenarios-1",
                text,
              },
            },
          });
          expect(started.kind).toBe("started");
          if (started.kind !== "started") return;
          const command = scripted.dispatches.at(-1)!;
          expect(command.type).toBe("game-round.task.request");
          if (command.type !== "game-round.task.request") return;
          // Listing agrees with existence: omitted file is never named in FILES.
          expect(command.task).not.toContain("NATIVE_WORLD.json (same-source");
          const files = yield* Effect.promise(() => walk(command.evidenceDirectory!));
          expect(files).not.toContain("NATIVE_WORLD.json");
          expect(files).toContain("evidence.json");
          // Root frames/checks are unchanged and the review still answers.
          const manifest = JSON.parse(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(command.evidenceDirectory!, "evidence.json"), "utf8"),
            ),
          ) as { frames: Array<{ id: string }>; checks: Array<{ id: string }> };
          expect(manifest.frames.map((frame) => frame.id)).toEqual(["f1", "f2"]);
          expect(manifest.checks.map((check) => check.id)).toEqual(["boot", "input"]);
        }),
      );
    }
    // A multibyte payload split mid-character would previously slice into
    // malformed JSON; the writer now omits instead of writing half a char.
    const multibyte = `{"note":"${"霜".repeat(20_000)}"}`;
    expect(Buffer.byteLength(multibyte, "utf8")).toBeGreaterThan(32_768);
    yield* withSession(({ frames, scripted, service }) =>
      Effect.gen(function* () {
        const split = yield* service.start({
          threadId,
          loopId,
          roundId,
          role: "critic",
          evidence: {
            ...frameInput(frames),
            nativeWorld: {
              sourceId: "sources",
              evidenceDirectory: "builds/logs/scenarios-1",
              text: multibyte,
            },
          },
        });
        expect(split.kind).toBe("started");
        if (split.kind !== "started") return;
        const last = scripted.dispatches.at(-1)!;
        expect(last.type).toBe("game-round.task.request");
        if (last.type !== "game-round.task.request") return;
        expect(last.task).not.toContain("NATIVE_WORLD.json (same-source");
        const lastFiles = yield* Effect.promise(() => walk(last.evidenceDirectory!));
        expect(lastFiles).not.toContain("NATIVE_WORLD.json");
      }),
    );
  }),
);
