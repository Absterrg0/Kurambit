// @effect-diagnostics nodeBuiltinImport:off -- Prove cancellation against a real child and an event-based readiness handshake.
import { it, expect } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import {
  EventId,
  GameOperationError,
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameService from "./GameService.ts";
import * as GameTurnCancellationReactor from "./GameTurnCancellationReactor.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GamePreview from "./GamePreview.ts";
import {
  designApprovalTestLayer,
  previewBrowserTestLayer,
  qualificationTestLayer,
  visualJudgeTestLayer,
} from "./gameTestLayers.ts";

it.live.each(["interrupt", "stop", "interrupted run"] as const)(
  "awaits child exit and clears tracked PIDs on %s",
  (cancellation) =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-cancel-"))),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        const readyPath = NodePath.join(root, "ready");
        const executable = NodePath.join(root, "long-tool");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            executable,
            `#!/bin/sh\nexec '${process.execPath}' -e 'require("node:fs").writeFileSync(${JSON.stringify(readyPath)}, String(process.pid)); setInterval(() => {}, 1000)'\n`,
            { mode: 0o755 },
          ),
        );
        const watcher = yield* Effect.acquireRelease(
          Effect.sync(() => NodeFS.watch(root)),
          (watch) => Effect.sync(() => watch.close()),
        );
        const ready = new Promise<void>((resolve) =>
          watcher.on("change", (_event, filename) => {
            if (filename === "ready") resolve();
          }),
        );
        let previewStopped = false;
        const dependencies = GameService.layer.pipe(
          Layer.provideMerge(GameProcesses.layer),
          Layer.provide(
            Layer.mock(GameProjectService.GameProjectService)({
              resolve: (threadId) =>
                threadId === "non-game"
                  ? Effect.fail(
                      new GameOperationError({
                        operation: "read-game",
                        path: root,
                        reason: "invalid-project",
                      }),
                    )
                  : Effect.succeed(root),
              read: () =>
                Effect.succeed({
                  schemaVersion: 1,
                  name: "Cancellation",
                  brief: "",
                  artDirection: "",
                  engine: { name: "godot", version: "4.7.2" },
                  godotProject: "godot",
                  assets: [],
                }),
            }),
          ),
          Layer.provide(
            Layer.mock(GameToolchain.GameToolchain)({
              executable: () =>
                Effect.succeed({ path: executable, version: "4.7.2", templates: null }),
            }),
          ),
          Layer.provide(
            Layer.mock(GamePreview.GamePreview)({
              stop: () =>
                Effect.sync(() => {
                  previewStopped = true;
                }),
              url: () => null,
            }),
          ),
          Layer.provide(previewBrowserTestLayer()),
          Layer.provideMerge(qualificationTestLayer(NodePath.join(root, ".test-state"))),
          Layer.provideMerge(visualJudgeTestLayer(NodePath.join(root, ".test-state"))),
          Layer.provideMerge(designApprovalTestLayer(NodePath.join(root, ".test-state"))),
        );
        yield* Effect.gen(function* () {
          const game = yield* GameService.GameService;
          const processes = yield* GameProcesses.GameProcesses;
          const threadId = ThreadId.make("cancel-test");
          const reactor = yield* GameTurnCancellationReactor.GameTurnCancellationReactor;
          const native =
            cancellation === "interrupted run"
              ? yield* processes.start({
                  root,
                  executable: process.execPath,
                  args: ["-e", "setInterval(() => {}, 1000)"],
                  operation: "native",
                })
              : null;
          const fiber = yield* game.test(threadId, "tests/long.gd").pipe(Effect.forkChild);
          yield* Effect.promise(() => ready);
          const pid = Number(yield* Effect.promise(() => NodeFSP.readFile(readyPath, "utf8")));
          expect(
            processes
              .list(root)
              .filter((entry) => entry.operation !== "native")
              .map((entry) => entry.pid),
          ).toEqual([pid]);
          if (cancellation === "interrupt") yield* Fiber.interrupt(fiber);
          else if (cancellation === "interrupted run") {
            yield* game.cancelThread(ThreadId.make("non-game"));
            for (const status of ["running", "completed", "failed", "cancelled"] as const) {
              yield* reactor.handle(runUpdated(threadId, status));
              expect(processes.list(root).some((entry) => entry.pid === pid)).toBe(true);
            }
            yield* reactor.handle(runUpdated(threadId, "interrupted"));
            expect(() => process.kill(pid, 0)).toThrow();
            expect(processes.list(root).map((entry) => entry.pid)).toEqual([native!.pid]);
            expect(() => process.kill(native!.pid, 0)).not.toThrow();
            expect(previewStopped).toBe(false);
            yield* Fiber.await(fiber);
            yield* reactor.handle(runUpdated(threadId, "interrupted"));
            yield* game.action(threadId, "stop");
          } else {
            yield* game.action(threadId, "stop");
            yield* Fiber.await(fiber);
          }
          expect(() => process.kill(pid, 0)).toThrow();
          expect(processes.list(root)).toEqual([]);
        }).pipe(
          Effect.provide(
            GameTurnCancellationReactor.layer.pipe(
              Layer.provide(Layer.mock(Orchestrator.OrchestratorV2)({})),
              Layer.provideMerge(dependencies),
            ),
          ),
        );
      }),
    ),
  10_000,
);

function runUpdated(
  threadId: ThreadId,
  status: OrchestrationV2Run["status"],
): OrchestrationV2DomainEvent {
  const runId = RunId.make("cancel-run");
  const at = DateTime.makeUnsafe("2026-10-19T00:00:00Z");
  const providerInstanceId = ProviderInstanceId.make("codex");
  return {
    type: "run.updated",
    id: EventId.make(`cancel-event:${status}`),
    threadId,
    runId,
    occurredAt: at,
    payload: {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-6.1-sol" },
      providerThreadId: null,
      userMessageId: MessageId.make("cancel-message"),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: at,
      startedAt: at,
      completedAt: status === "running" ? null : at,
      checkpointId: null,
      contextHandoffId: null,
    },
  };
}
