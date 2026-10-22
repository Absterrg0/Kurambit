import { expect, it } from "@effect/vitest";
import { RunId, ThreadId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as GameRepairLoop from "./GameRepairLoop.ts";
import * as GameRepairReactor from "./GameRepairReactor.ts";

const builderThread = ThreadId.make("thread:reactor:builder");
const childThread = ThreadId.make("thread:reactor:child");

const completed = (threadId: ThreadId, runId: string) =>
  ({
    type: "run.updated",
    threadId,
    payload: { id: RunId.make(runId), status: "completed", rootNodeId: `node:${runId}` },
  }) as unknown as OrchestrationV2DomainEvent;

const created = (threadId: ThreadId) =>
  ({ type: "run.created", threadId, payload: {} }) as unknown as OrchestrationV2DomainEvent;

it.effect(
  "only a top-level run's completion asks for a review; child and creation events do not",
  () =>
    Effect.gen(function* () {
      const ensured = yield* Deferred.make<string>();
      const asked: Array<string> = [];
      const layer = GameRepairReactor.layer.pipe(
        Layer.provide(Layer.mock(Orchestrator.OrchestratorV2)({})),
        Layer.provide(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: (threadId) =>
              Effect.succeed({
                id: threadId,
                lineage: {
                  relationshipToParent: threadId === childThread ? "subagent" : null,
                },
              }) as never,
          }),
        ),
        Layer.provide(
          Layer.mock(GameRepairLoop.GameRepairLoop)({
            ensure: (input) =>
              Effect.gen(function* () {
                asked.push(String(input.runId));
                yield* Deferred.succeed(ensured, String(input.runId));
                return null;
              }),
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const reactor = yield* GameRepairReactor.GameRepairReactor;
        // A review child's completion, and a run merely being created, never
        // start or supersede anything: supersession is pre-commit admission.
        yield* reactor.handle(completed(childThread, "run:child"));
        yield* reactor.handle(created(builderThread));
        yield* reactor.handle(completed(builderThread, "run:builder"));
        expect(yield* Deferred.await(ensured)).toBe("run:builder");
        expect(asked).toEqual(["run:builder"]);
      }).pipe(Effect.provide(layer));
    }),
);
