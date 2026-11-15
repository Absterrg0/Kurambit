// A fresh run must never take the person's own native session, and the
// thread's next ordinary run must find it again.
import { describe, expect, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@kurambit/contracts";
import * as DateTime from "effect/DateTime";

import { resumeAfterFreshRuns } from "./ProviderTurnStartService.ts";

const ROW = ProviderThreadId.make("pt-1");
const AT = DateTime.makeUnsafe("2026-11-15T00:00:00Z");

const run = (ordinal: number, patch: Partial<OrchestrationV2Run> = {}): OrchestrationV2Run => ({
  id: RunId.make(`run-${ordinal}`),
  threadId: ThreadId.make("t-1"),
  ordinal,
  providerInstanceId: ProviderInstanceId.make("claude"),
  modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "m" },
  providerThreadId: ROW,
  userMessageId: MessageId.make(`m-${ordinal}`),
  rootNodeId: NodeId.make(`n-${ordinal}`),
  activeAttemptId: RunAttemptId.make(`a-${ordinal}`),
  status: "completed",
  requestedAt: AT,
  startedAt: AT,
  completedAt: AT,
  checkpointId: null,
  contextHandoffId: null,
  ...patch,
});
const attempt = (
  source: OrchestrationV2Run,
  nativeThreadId: string,
): OrchestrationV2RunAttempt => ({
  id: RunAttemptId.make(`a-${source.ordinal}`),
  nativeThreadId,
  runId: source.id,
  attemptOrdinal: 1,
  rootNodeId: NodeId.make(`n-${source.ordinal}`),
  providerInstanceId: source.providerInstanceId,
  providerThreadId: ROW,
  providerTurnId: null,
  reason: "initial",
  status: "completed",
  startedAt: AT,
  completedAt: AT,
});

describe("resumeAfterFreshRuns", () => {
  const own = run(1);
  const step1 = run(2, { freshContext: true });
  const step2 = run(3, { freshContext: true });
  const next = run(4, { status: "starting" });
  const attempts = [attempt(own, "own"), attempt(step1, "s1"), attempt(step2, "s2")];

  it("takes the person's run back to its own native session, told the fresh runs", () => {
    const resumed = resumeAfterFreshRuns({
      runs: [own, step1, step2, next],
      attempts,
      providerThreadId: ROW,
      run: next,
    });
    expect(resumed?.nativeThreadId).toBe("own");
    expect(resumed?.freshRuns.map((each) => each.ordinal)).toEqual([2, 3]);
  });

  it("changes nothing when the latest native session is the thread's own", () => {
    const later = run(5, { status: "starting" });
    expect(
      resumeAfterFreshRuns({
        runs: [own, step1, step2, next, later],
        attempts: [...attempts, attempt(next, "own")],
        providerThreadId: ROW,
        run: later,
      }),
    ).toBeNull();
  });

  it("counts a restart continuation of a fresh run as fresh", () => {
    const continued = run(4, { restartContinuationOfRunId: step2.id });
    const after = run(5, { status: "starting" });
    const resumed = resumeAfterFreshRuns({
      runs: [own, step1, step2, continued, after],
      attempts: [...attempts, attempt(continued, "s2")],
      providerThreadId: ROW,
      run: after,
    });
    expect(resumed?.nativeThreadId).toBe("own");
    expect(resumed?.freshRuns.map((each) => each.ordinal)).toEqual([2, 3, 4]);
  });
});
