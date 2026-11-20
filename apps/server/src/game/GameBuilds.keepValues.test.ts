// @effect-diagnostics nodeBuiltinImport:off -- Keeping values captures a real game folder in a real repository.
// Kept values are written into the game and kept as a build whose Undo brings
// the file back as it was; a value outside its range writes nothing. The
// Stage's tuning folds into one build per session, and a session put back
// leaves no build.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ownsUndo } from "@kurambit/contracts";
import { layerFor, repo, THREAD, tuneOf } from "./gameBuildsTestkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as GameBuilds from "./GameBuilds.ts";

it.effect("keeps values as a build that Undo takes back, and refuses one outside its range", () => {
  const root = repo();
  return Effect.gen(function* () {
    const builds = yield* GameBuilds.GameBuilds;
    const speed = { key: "speed", value: 9, min: 1, max: 12 };
    const refused = yield* builds
      .keepValues(THREAD, { things: [{ id: "Rover", values: [{ ...speed, value: 13 }] }] })
      .pipe(Effect.flip);
    assert.strictEqual(refused.reason, "invalid-input");
    assert.deepStrictEqual(tuneOf(root), { Rules: { hard: false } });

    const kept = yield* builds.keepValues(THREAD, {
      things: [{ id: "Rover", values: [speed] }],
      commandId: "keep-1",
    });
    assert.deepStrictEqual(tuneOf(root), { Rules: { hard: false }, Rover: { speed: 9 } });
    // A repeat of the same request is the same build, never a second one.
    const again = yield* builds.keepValues(THREAD, {
      things: [{ id: "Rover", values: [speed] }],
      commandId: "keep-1",
    });
    assert.strictEqual(again.build, kept.build);

    const listed = yield* builds.list(THREAD, {});
    const row = listed.builds.find((build) => build.id === kept.build);
    assert.isTrue(row !== undefined && ownsUndo(row.source));
    assert.strictEqual(row?.base, kept.base);
    assert.deepStrictEqual(
      row?.files.map((file) => file.path),
      ["web/tune.json"],
    );
    assert.strictEqual(listed.current, kept.build);

    // Undo: the build before it goes back in the folder, and Redo is offered.
    const undone = yield* builds.restore(THREAD, { _tag: "build", build: kept.base }, "undo-1");
    assert.strictEqual(undone.moved, "restored");
    assert.deepStrictEqual(tuneOf(root), { Rules: { hard: false } });
    const after = yield* builds.list(THREAD, {});
    assert.strictEqual(after.restore?.target, kept.base);
    assert.isNotNull(after.restore?.undo);
  }).pipe(
    Effect.provide(
      layerFor(root).pipe(
        Layer.provideMerge(Layer.merge(NodeServices.layer, SqlitePersistence.layerMemory)),
      ),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
});

it.effect(
  "folds a session of tuning into one build, and keeps none once it is all put back",
  () => {
    const root = repo();
    return Effect.gen(function* () {
      const builds = yield* GameBuilds.GameBuilds;
      const speed = { key: "speed", value: 9, min: 1, max: 12, default: 5 };
      const first = yield* builds.keepValues(THREAD, {
        things: [{ id: "Rover", values: [speed] }],
        fold: true,
      });
      const second = yield* builds.keepValues(THREAD, {
        things: [{ id: "Rover", values: [{ ...speed, value: 11 }] }],
        fold: true,
      });
      assert.deepStrictEqual(tuneOf(root), { Rules: { hard: false }, Rover: { speed: 11 } });
      // One build for the session, and its Undo goes back to before the session.
      assert.strictEqual(second.base, first.base);
      const listed = yield* builds.list(THREAD, {});
      const tuned = listed.builds.filter((build) => build.source._tag === "saved");
      assert.deepStrictEqual(
        tuned.map((build) => build.id),
        [second.build],
      );
      assert.strictEqual(listed.current, second.build);

      // Put back to its default: the value leaves the file, which is as it was, so no build.
      const back = yield* builds.keepValues(THREAD, {
        things: [{ id: "Rover", values: [{ ...speed, value: 5 }] }],
        fold: true,
      });
      assert.deepStrictEqual(tuneOf(root), { Rules: { hard: false } });
      assert.strictEqual(back.build, first.base);
      const after = yield* builds.list(THREAD, {});
      assert.isTrue(after.builds.every((build) => build.source._tag !== "saved"));
    }).pipe(
      Effect.provide(
        layerFor(root).pipe(
          Layer.provideMerge(Layer.merge(NodeServices.layer, SqlitePersistence.layerMemory)),
        ),
      ),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  },
);
