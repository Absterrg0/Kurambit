// @effect-diagnostics nodeBuiltinImport:off -- The review session test writes real evidence and record directories.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  type GameManifest,
  type GameReviewRound,
  MessageId,
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
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
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
  incumbentBuildId: null,
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

interface Scripted {
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
  childStatus: OrchestrationV2Run["status"];
  answer: string;
  available: boolean;
}

const makeScripted = (): Scripted => ({
  dispatches: [],
  receipts: new Set(),
  rejectedReceipts: new Set(),
  extraChildRuns: [],
  childRecordsGate: null,
  parentSelection: builderSelection,
  unavailable: new Set(),
  childThreadId: null,
  childCommandId: null,
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
  }) => Effect.Effect<A, E>,
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
        const roundState = {
          selected: null,
          rounds: [runningRound],
        };
        const service = GameReviewSessions.layer({ stateDir }).pipe(
          Layer.provide(
            Layer.mock(GameProjectService.GameProjectService)({
              resolve: () => Effect.succeed(root),
              read: () => Effect.succeed(manifest),
            }),
          ),
          Layer.provide(
            Layer.mock(GameRoundStore.GameRoundStore)({
              read: () => Effect.succeed(roundState),
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
                      runs: [builderRun],
                    } as unknown as OrchestrationV2ThreadProjection;
                  if (scripted.childThreadId !== null && target === scripted.childThreadId) {
                    if (scripted.childRecordsGate !== null) yield* scripted.childRecordsGate();
                    return {
                      runs: [
                        childRun(target, scripted.childStatus, {
                          ...(scripted.childCommandId === null
                            ? {}
                            : {
                                userMessageId: IdAllocator.derive.delegatedTaskMessage({
                                  commandId: CommandId.make(scripted.childCommandId),
                                }),
                              }),
                        }),
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
    { id: "incumbent-boot", label: "A: boot", sourcePath: paths[0]! },
    { id: "incumbent-action", label: "A: core action", sourcePath: paths[1]! },
  ],
  checks: [
    { id: "boot", status: "passed" },
    { id: "input", status: "failed", detail: "left arrow did nothing" },
  ],
});

const criticText = JSON.stringify({
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
      expect(command.task).toContain("frames/frame-01.png (f1: A: boot)");
      expect(command.task).toContain("f2: A: core action");
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
      ) as { checks: Array<{ id: string }> };
      expect(evidenceJson.checks.map((check) => check.id)).toEqual(["boot", "input"]);
      expect(started.evidenceHash).toMatch(/^[0-9a-f]{64}$/);

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

    const ballot = (overrides: Record<string, unknown> = {}) =>
      JSON.stringify({
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
    expect(
      GameReviewSessions.parseBallotAnswer(ballot({ score: 4 }), {
        frameIds: frames,
        itemIds: items,
      }).kind,
    ).toBe("invalid");
  }),
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
        answer: JSON.stringify({ defects: [], doNotRegress: [] }),
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

      const records = (yield* Effect.promise(() => walk(stateDir))).filter((file) =>
        file.endsWith("session.json"),
      );
      const recordPath = NodePath.join(stateDir, records[0]!);
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
