// @effect-diagnostics nodeBuiltinImport:off -- The folder moves in a real repository.
// Data safety: the server dies between a restore's commit and its move, between the move and
// its settle, and after the settle before its effect is marked done. After each restart nothing
// is lost or doubled: the folder holds the restore's target once, the person's build is listed
// once with its number, and the list reads the same. The same holds for a kept build whose record
// died after its folder write.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { ProjectId } from "@kurambit/contracts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as GameBuilds from "./GameBuilds.ts";
import { layerFor, memoryBuildRecords, repo, THREAD, tuneOf } from "./gameBuildsTestkit.ts";

const PROJECT = ProjectId.make("rover");
const speed = { key: "speed", value: 9, min: 1, max: 12 };

/** One life of the server: its own services over the same folder and records. */
const lifeOf =
  (root: string, records: ReturnType<typeof memoryBuildRecords>) =>
  <A, E>(work: (builds: GameBuilds.GameBuilds["Service"]) => Effect.Effect<A, E>) =>
    Effect.flatMap(GameBuilds.GameBuilds, work).pipe(
      Effect.provide(
        layerFor(root, records).pipe(
          Layer.provideMerge(Layer.merge(NodeServices.layer, SqlitePersistence.layerMemory)),
        ),
      ),
    );

/** Asks for `work`, and kills the server once its move is held in the outbox. */
const dieOnceHeld = <A, E>(
  records: ReturnType<typeof memoryBuildRecords>,
  work: Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const held = yield* Deferred.make<void>();
    records.control.hold = true;
    records.control.held = held;
    const fiber = yield* Effect.forkChild(work);
    yield* Deferred.await(held);
    yield* Fiber.interrupt(fiber);
    records.control.hold = false;
    records.control.held = null;
  });

const folder = (records: ReturnType<typeof memoryBuildRecords>, root: string) =>
  records.folders().find((each) => each.projectId === PROJECT && each.root === root);
const parks = (records: ReturnType<typeof memoryBuildRecords>) =>
  records.builds().filter((each) => each.kind === "restore-before");

it.effect("an Undo the server died before moving moves the folder once on restart", () => {
  const root = repo();
  const records = memoryBuildRecords();
  const life = lifeOf(root, records);
  return Effect.gen(function* () {
    const kept = yield* life((builds) =>
      builds.keepValues(THREAD, { things: [{ id: "Rover", values: [speed] }], commandId: "k1" }),
    );
    yield* life((builds) =>
      dieOnceHeld(
        records,
        builds.restore(THREAD, { _tag: "build", build: kept.base }, "undo-1", { person: true }),
      ),
    );
    // Dead before the move: the record says a restore is asked, and nothing moved.
    assert.deepStrictEqual(tuneOf(root).Rover, { speed: 9 });
    assert.strictEqual(folder(records, root)?.restore?.outcome, null);
    assert.strictEqual(folder(records, root)?.current, kept.build);
    assert.strictEqual(records.pending().length, 1);

    const listed = yield* life((builds) =>
      records.replay.pipe(Effect.andThen(builds.list(THREAD, {}))),
    );
    assert.strictEqual(tuneOf(root).Rover, undefined);
    assert.strictEqual(records.pending().length, 0);
    assert.strictEqual(listed.current, kept.base);
    assert.strictEqual(listed.restore?.outcome?.restored, true);
    assert.deepStrictEqual(
      listed.builds.filter((build) => build.id === kept.build).map((build) => build.name),
      ["Build 1 · tuned"],
    );
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
});

it.effect("a move whose settle died runs again and settles once, with one park", () => {
  const root = repo();
  const records = memoryBuildRecords();
  const life = lifeOf(root, records);
  return Effect.gen(function* () {
    const kept = yield* life((builds) =>
      builds.keepValues(THREAD, { things: [{ id: "Rover", values: [speed] }], commandId: "k1" }),
    );
    // The folder is edited by hand after the build, so the restore parks it as a build of its own.
    NodeFS.writeFileSync(`${root}/web/main.js`, "export function start() { /* by hand */ }\n");
    yield* life((builds) =>
      dieOnceHeld(records, builds.restore(THREAD, { _tag: "build", build: kept.base }, "back-1")),
    );
    // The second life moves the folder and dies before the settle commits.
    records.control.lose.add("game-build.restore.settle");
    yield* life(() => records.replay);
    assert.strictEqual(tuneOf(root).Rover, undefined);
    assert.strictEqual(folder(records, root)?.restore?.outcome, null);
    assert.strictEqual(records.pending().length, 1);
    // The third life runs the move again: the park is found, never taken again.
    yield* life(() => records.replay);
    assert.strictEqual(records.pending().length, 0);
    assert.strictEqual(folder(records, root)?.restore?.outcome?.moved, "restored");
    assert.strictEqual(folder(records, root)?.current, kept.base);
    assert.strictEqual(parks(records).length, 1);
    assert.strictEqual(parks(records)[0]!.nth, 1);
    assert.include(NodeFS.readFileSync(`${root}/web/main.js`, "utf8"), "start() {}");
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
});

it.effect("a settled move run again by the outbox moves nothing", () => {
  const root = repo();
  const records = memoryBuildRecords();
  const life = lifeOf(root, records);
  return Effect.gen(function* () {
    const kept = yield* life((builds) =>
      builds.keepValues(THREAD, { things: [{ id: "Rover", values: [speed] }], commandId: "k1" }),
    );
    yield* life((builds) =>
      dieOnceHeld(records, builds.restore(THREAD, { _tag: "build", build: kept.base }, "undo-1")),
    );
    const moves = records.pending();
    yield* life(() => records.replay);
    // Settled, then dead before the outbox marked the effect done: the restart runs it again.
    NodeFS.writeFileSync(`${root}/web/notes.txt`, "a later edit the move must not touch\n");
    yield* life(() => records.requeue(moves).pipe(Effect.andThen(records.replay)));
    assert.strictEqual(records.pending().length, 0);
    assert.strictEqual(NodeFS.existsSync(`${root}/web/notes.txt`), true);
    assert.strictEqual(folder(records, root)?.current, kept.base);
    assert.strictEqual(parks(records).length, 0);
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
});

it.effect("an Undo's landing the server died before moving lands once on restart", () => {
  const root = repo();
  const records = memoryBuildRecords();
  const life = lifeOf(root, records);
  return Effect.gen(function* () {
    const kept = yield* life((builds) =>
      builds.keepValues(THREAD, { things: [{ id: "Rover", values: [speed] }], commandId: "k1" }),
    );
    yield* life((builds) => dieOnceHeld(records, builds.undo(THREAD, kept.build, "undo-1")));
    // The landing and its restore committed together: listed, not yet in the folder.
    const undo = records.builds().filter((each) => each.kind === "undo");
    assert.strictEqual(undo.length, 1);
    assert.strictEqual(undo[0]!.number, 2);
    assert.strictEqual(folder(records, root)?.current, kept.build);
    const listed = yield* life((builds) =>
      records.replay.pipe(Effect.andThen(builds.list(THREAD, {}))),
    );
    assert.strictEqual(tuneOf(root).Rover, undefined);
    assert.strictEqual(listed.current, undo[0]!.id);
    assert.deepStrictEqual(
      listed.builds.map((build) => build.name),
      ["Build 2 · undo", "Build 1 · tuned"],
    );
    // The person's Undo, asked again after the restart, is the same build, never a second.
    const again = yield* life((builds) => builds.undo(THREAD, kept.build, "undo-1"));
    assert.strictEqual(again._tag === "undone" ? again.build : null, undo[0]!.id);
    assert.strictEqual(records.builds().filter((each) => each.kind === "undo").length, 1);
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
});

it.effect(
  "kept values whose record died are one build after a restart and the keep's repeat",
  () => {
    const root = repo();
    const records = memoryBuildRecords();
    const life = lifeOf(root, records);
    return Effect.gen(function* () {
      records.control.lose.add("game-build.record");
      const first = yield* life((builds) =>
        builds
          .keepValues(THREAD, { things: [{ id: "Rover", values: [speed] }], commandId: "k1" })
          .pipe(Effect.exit),
      );
      // Dead after the folder's write, before its record: the values are in the folder, unlisted.
      assert.isTrue(first._tag === "Failure");
      assert.deepStrictEqual(tuneOf(root).Rover, { speed: 9 });
      assert.strictEqual(records.builds().length, 0);

      // The Stage asks again with the same request: one build, whose Undo takes the values back.
      const kept = yield* life((builds) =>
        builds.keepValues(THREAD, { things: [{ id: "Rover", values: [speed] }], commandId: "k1" }),
      );
      const listed = yield* life((builds) => builds.list(THREAD, {}));
      assert.deepStrictEqual(
        listed.builds.map((build) => build.name),
        ["Build 1 · tuned"],
      );
      assert.strictEqual(listed.current, kept.build);
      yield* life((builds) => builds.undo(THREAD, kept.build, "undo-1"));
      assert.strictEqual(tuneOf(root).Rover, undefined);
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  },
);
