// @effect-diagnostics globalDate:off -- The scripted clock starts from a fixed epoch so deadlines are exact.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import {
  summarizeRepairLoop,
  type RepairLoopView,
  type RepairRoundView,
  watchRepairLoop,
} from "./repairLoop.ts";

const START = Date.parse("2026-10-01T10:00:00.000Z");
const at = (milliseconds: number) => new Date(START + milliseconds).toISOString();
const BUILD = "a".repeat(64);

const runningLoop = (overrides: Partial<RepairLoopView> = {}): RepairLoopView => ({
  id: "loop-1",
  status: "running",
  startedAt: at(0),
  finishedAt: null,
  budget: { repairs: 3, elapsedMs: 20 * 60_000 },
  decision: null,
  reason: null,
  repairsUsed: 0,
  ...overrides,
});

const round = (
  overrides: Partial<RepairRoundView> & Pick<RepairRoundView, "id">,
): RepairRoundView => ({
  status: "running",
  startedAt: at(0),
  finishedAt: null,
  loopId: "loop-1",
  candidate: null,
  ...overrides,
});

/** A status read that yields each scripted value once, then repeats the last. */
const scriptedStatus = (scripts: ReadonlyArray<RepairLoopView | null>) =>
  Effect.gen(function* () {
    const index = yield* Ref.make(0);
    return {
      read: Effect.gen(function* () {
        const position = yield* Ref.get(index);
        yield* Ref.update(index, (value) => value + 1);
        return { loop: scripts[Math.min(position, scripts.length - 1)] ?? null };
      }),
    };
  });

it.effect(
  "waits past the grace for a loop, then until it is terminal, and reports its rounds",
  () =>
    Effect.gen(function* () {
      const clock = yield* Ref.make(START);
      const stopped = runningLoop({
        status: "stopped",
        finishedAt: at(30_000),
        decision: "promote",
        reason: "The candidate is better.",
        repairsUsed: 1,
      });
      const reads = yield* scriptedStatus([
        null,
        runningLoop(),
        runningLoop({ repairsUsed: 1 }),
        stopped,
      ]);
      const waited = yield* watchRepairLoop({
        status: reads.read,
        history: Effect.succeed({
          rounds: [
            {
              round: round({
                id: "round-1",
                status: "promoted",
                decision: "promote",
                reason: "The candidate is better.",
                finishedAt: at(30_000),
                candidate: { buildId: BUILD, directory: `builds/candidates/${BUILD}` },
              }),
            },
            {
              round: round({
                id: "round-from-another-loop",
                loopId: "loop-0",
                status: "rejected",
              }),
            },
          ],
        }),
        now: Ref.get(clock),
        sleep: Ref.update(clock, (milliseconds) => milliseconds + 10_000),
        onWait: () => undefined,
      });
      assert(waited !== null);
      assert.equal(waited.loop.status, "stopped");
      assert.equal(waited.timedOut, false);
      assert.equal(waited.waitedMs, 30_000);
      // Another loop's history is not this loop's summary.
      assert.equal(waited.rounds.length, 1);
      const summary = summarizeRepairLoop({ watched: waited, selectedBuildId: "selected-build" });
      assert.equal(summary.selectedBuildId, "selected-build");
      assert.equal(summary.decision, "promote");
      assert.equal(summary.reason, "The candidate is better.");
      assert.equal(summary.rounds[0]?.candidateBuildId, BUILD);
      assert.equal(summary.rounds[0]?.decision, "promote");
    }),
);

it.effect("returns null when no loop opens inside the start grace", () =>
  Effect.gen(function* () {
    const clock = yield* Ref.make(START);
    const reads = yield* scriptedStatus([null]);
    const waited = yield* watchRepairLoop({
      status: reads.read,
      history: Effect.succeed({ rounds: [] }),
      now: Ref.get(clock),
      sleep: Ref.update(clock, (milliseconds) => milliseconds + 60_000),
      startGraceMs: 60_000,
    });
    assert.equal(waited, null);
  }),
);

it.effect("returns a running loop once its budget plus the shutdown margin runs out", () =>
  Effect.gen(function* () {
    const clock = yield* Ref.make(START);
    const reads = yield* scriptedStatus([runningLoop()]);
    const waits: string[] = [];
    const waited = yield* watchRepairLoop({
      status: reads.read,
      history: Effect.succeed({ rounds: [] }),
      now: Ref.get(clock),
      sleep: Ref.update(clock, (milliseconds) => milliseconds + 60_000),
      marginMs: 5 * 60_000,
      pollMs: 60_000,
      onWait: (message) => waits.push(message),
    });
    assert(waited !== null);
    assert.equal(waited.timedOut, true);
    assert.equal(waited.loop.status, "running");
    // 20 minutes of budget plus the 5 minute margin, polled once a minute.
    assert.equal(waited.waitedMs, 25 * 60_000);
    assert.equal(waits.length, 1);
    assert.match(waits[0]!, /waiting up to 25 more minute/);
  }),
);

it.effect("a loop already terminal needs no wait", () =>
  Effect.gen(function* () {
    const clock = yield* Ref.make(START);
    const reads = yield* scriptedStatus([
      runningLoop({ status: "interrupted", finishedAt: at(0), decision: "interrupt" }),
    ]);
    const waits: string[] = [];
    const waited = yield* watchRepairLoop({
      status: reads.read,
      history: Effect.succeed({ rounds: [] }),
      now: Ref.get(clock),
      sleep: Effect.die("a terminal loop must not sleep"),
      onWait: (message) => waits.push(message),
    });
    assert(waited !== null);
    assert.equal(waited.waitedMs, 0);
    assert.equal(waited.timedOut, false);
    assert.deepEqual(waits, []);
  }),
);
