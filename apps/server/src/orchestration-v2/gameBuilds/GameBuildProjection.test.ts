// Data safety: a build is numbered once, never doubled by a repeat, and a restore's record and
// its settle leave the folder naming the right build.
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  GameBuildId,
  type GameBuildRecord,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2GameBuildCommand,
  ProjectId,
  ThreadId,
} from "@kurambit/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import { planGameBuildCommand } from "./plan.ts";

const layerTest = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const projectId = ProjectId.make("project:game");
const threadId = ThreadId.make("thread:game");
const root = "/games/moth";
const id = (n: number) => GameBuildId.make(n.toString(16).padStart(40, "0"));

const turn = (n: number, at: string): GameBuildRecord => ({
  id: id(n),
  projectId,
  root,
  at,
  kind: "turn",
  number: null,
  base: n > 1 ? id(n - 1) : null,
  source: {
    _tag: "turn",
    threadId,
    threadTitle: "Moth",
    turn: n,
    runId: `run:${n}`,
    request: `turn ${n}`,
    step: null,
  },
  summary: `turn ${n}`,
  files: [],
  fileCount: 1,
});

let seq = 0;
const commit = (command: OrchestrationV2GameBuildCommand) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const plan = yield* planGameBuildCommand(
      {
        tally: store.getGameBuildTally,
        known: (p, b) => store.getGameBuilds(p, [b]).pipe(Effect.map((rows) => rows[0] ?? null)),
        folder: store.getGameBuildFolder,
      },
      command,
    );
    for (const draft of plan.events)
      yield* store.apply({
        ...draft,
        id: EventId.make(`event:${(seq += 1)}`),
      } as OrchestrationV2DomainEvent);
    return plan;
  });
const record = (build: GameBuildRecord, current = true) =>
  commit({
    type: "game-build.record",
    commandId: CommandId.make(`record:${build.id}`),
    threadId,
    build,
    current,
  });

it.layer(layerTest)("game build projection", (it) => {
  it.effect("numbers each build once, and a repeat neither renumbers nor doubles it", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* record(turn(1, "2026-11-20T10:00:00.000Z"));
      yield* record(turn(2, "2026-11-20T10:01:00.000Z"));
      yield* record(turn(1, "2026-11-20T10:00:00.000Z"));
      const builds = yield* store.listGameBuilds(projectId, { limit: 10 });
      assert.deepStrictEqual(
        builds.map((each) => [each.id, each.number]),
        [
          [id(2), 2],
          [id(1), 1],
        ],
      );
      // A late repeat of an older build never moves the folder's build back to it.
      assert.strictEqual((yield* store.getGameBuildFolder(projectId, root))?.current, id(2));
    }),
  );

  it.effect("a restore names its target only once its move settles, with its park", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* record(turn(3, "2026-11-20T10:02:00.000Z"));
      const restore = {
        requestId: "r1",
        target: id(1),
        label: "Build 1",
        requestedAt: "2026-11-20T10:03:00.000Z",
        before: null,
        outcome: null,
      };
      const asked = yield* commit({
        type: "game-build.restore",
        commandId: CommandId.make("restore:r1"),
        threadId,
        projectId,
        root,
        restore,
      });
      assert.strictEqual(asked.effects[0]?.request.type, "game-build.move");
      const pending = yield* store.getGameBuildFolder(projectId, root);
      assert.strictEqual(pending?.current, id(3));
      assert.strictEqual(asked.effects.length, 1);
      assert.strictEqual(pending?.restore?.outcome, null);
      const settle = {
        type: "game-build.restore.settle",
        commandId: CommandId.make("settle:r1"),
        threadId,
        projectId,
        root,
        restore: {
          ...restore,
          before: id(9),
          outcome: { restored: true, message: "back", moved: "restored" },
        },
        park: { id: id(9), at: "2026-11-20T10:03:00.000Z" },
      } as const;
      yield* commit(settle);
      yield* commit(settle);
      const settled = yield* store.getGameBuildFolder(projectId, root);
      assert.strictEqual(settled?.current, id(1));
      assert.strictEqual(settled?.restore?.before, id(9));
      const parks = (yield* store.listGameBuilds(projectId, { limit: 10 })).filter(
        (each) => each.kind === "restore-before",
      );
      assert.deepStrictEqual(
        parks.map((each) => [each.id, each.number, each.nth]),
        [[id(9), null, 1]],
      );
      // A park is outside the numbered sequence: the next turn is 4.
      yield* record(turn(4, "2026-11-20T10:04:00.000Z"));
      assert.strictEqual((yield* store.getGameBuilds(projectId, [id(4)]))[0]?.number, 4);
    }),
  );

  it.effect("a held keep is kept until it is dropped", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const keep = {
        request: "k1",
        at: "2026-11-20T10:05:00.000Z",
        input: {
          threadId,
          things: [{ id: "player", values: [], names: [{ key: "name", name: "Moth" }] }],
          commandId: "k1",
        },
      };
      const held = (each: typeof keep | null, drop: string | null) =>
        commit({
          type: "game-build.keep",
          commandId: CommandId.make(`keep:${each?.request ?? drop}:${drop ?? "keep"}`),
          threadId,
          projectId,
          root,
          keep: each,
          drop,
        });
      yield* held(keep, null);
      yield* held(keep, null);
      assert.strictEqual((yield* store.getGameBuildFolder(projectId, root))?.held.length, 1);
      yield* held(null, "k1");
      assert.strictEqual((yield* store.getGameBuildFolder(projectId, root))?.held.length, 0);
    }),
  );
});
