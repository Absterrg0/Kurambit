import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { type CommandId, RunId, ThreadId } from "@kurambit/contracts";
import { findFirstTurn } from "./firstTurn.ts";
import type { RoleStep } from "./state.ts";

const step = (over: Partial<RoleStep> = {}): RoleStep => ({
  kind: "role",
  id: 7,
  role: "builder-1",
  title: "studio builder 1",
  thread: null,
  at: null,
  prompt: "build",
  capMs: 60_000,
  read: [],
  clear: [],
  source: false,
  bots: false,
  release: false,
  copy: [],
  sheet: "",
  inputCapMs: 0,
  ...over,
});

const receipts =
  (
    recorded: Record<string, { readonly status: "accepted" | "rejected"; readonly thread: string }>,
  ) =>
  (commandId: CommandId) => {
    const found = recorded[commandId];
    return Effect.succeed(
      found === undefined
        ? null
        : { status: found.status, threadId: ThreadId.make(found.thread), commandType: "x" },
    );
  };

it.effect("finds nothing for a step whose first turn never committed", () =>
  Effect.gen(function* () {
    expect(yield* findFirstTurn(receipts({}), "run_a", step(), false)).toBeNull();
  }),
);

it.effect("reattaches to the thread the step's launch made", () =>
  Effect.gen(function* () {
    const found = yield* findFirstTurn(
      receipts({ "studio:run_a:7": { status: "accepted", thread: "t1" } }),
      "run_a",
      step(),
      false,
    );
    expect(found).toEqual({ threadId: "t1", kind: "" });
  }),
);

it.effect("prefers the fresh thread, then a relaunch, over the step's own", () =>
  Effect.gen(function* () {
    const all = {
      "studio:run_a:7": { status: "accepted", thread: "t1" },
      "studio:run_a:7:relaunch": { status: "accepted", thread: "t2" },
      "studio:run_a:7:fresh": { status: "accepted", thread: "t3" },
    } as const;
    expect(yield* findFirstTurn(receipts(all), "run_a", step(), false)).toEqual({
      threadId: "t3",
      kind: ":fresh",
    });
    const { "studio:run_a:7:fresh": _, ...noFresh } = all;
    expect(yield* findFirstTurn(receipts(noFresh), "run_a", step(), false)).toEqual({
      threadId: "t2",
      kind: ":relaunch",
    });
  }),
);

it.effect("finds a follow-up's turn by its send, not by a launch", () =>
  Effect.gen(function* () {
    const followUp = step({ thread: ThreadId.make("t0") });
    const recorded = receipts({
      "studio:run_a:7": { status: "accepted", thread: "stray" },
      "studio:run_a:7:send": { status: "accepted", thread: "t0" },
    });
    expect(yield* findFirstTurn(recorded, "run_a", followUp, false)).toEqual({
      threadId: "t0",
      kind: ":send",
    });
  }),
);

it.effect("ignores a refused first turn", () =>
  Effect.gen(function* () {
    const recorded = receipts({ "studio:run_a:7": { status: "rejected", thread: "t1" } });
    expect(yield* findFirstTurn(recorded, "run_a", step(), false)).toBeNull();
  }),
);

it.effect("a fresh attempt never reattaches to the thread it replaces", () =>
  Effect.gen(function* () {
    const legacy = step({ attached: { threadId: ThreadId.make("t1"), runId: RunId.make("r1") } });
    const recorded = receipts({ "studio:run_a:7": { status: "accepted", thread: "t1" } });
    expect(yield* findFirstTurn(recorded, "run_a", legacy, true)).toBeNull();
  }),
);

it.effect("an older run.json's own copy is read only when T3 has no record", () =>
  Effect.gen(function* () {
    const legacy = step({
      thread: ThreadId.make("t0"),
      attached: { threadId: ThreadId.make("t0"), runId: RunId.make("r0") },
    });
    expect(yield* findFirstTurn(receipts({}), "run_a", legacy, false)).toEqual({
      threadId: "t0",
      kind: "legacy",
    });
    const relaunched = receipts({
      "studio:run_a:7:relaunch": { status: "accepted", thread: "t2" },
    });
    expect(yield* findFirstTurn(relaunched, "run_a", legacy, false)).toEqual({
      threadId: "t2",
      kind: ":relaunch",
    });
  }),
);
