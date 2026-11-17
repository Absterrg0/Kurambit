// @effect-diagnostics nodeBuiltinImport:off -- Keeping values captures a real game folder in a real repository.
// Kept values are written into the game and kept as a build whose Undo brings
// the file back as it was; a value outside its range writes nothing. The
// Stage's tuning folds into one build per session, and a session put back
// leaves no build.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type GameManifest, ownsUndo, ProjectId, ThreadId } from "@kurambit/contracts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GameBuildCopies from "./GameBuildCopies.ts";
import * as GameBuilds from "./GameBuilds.ts";
import * as GameFacts from "./GameFacts.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameRunControl from "./GameRunControl.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameFolders from "./GameFolders.ts";
import * as GameStage from "./GameStage.ts";

type GameBuildFactsShape = Effect.Success<ReturnType<GameFacts.GameFacts["Service"]["measure"]>>;
const THREAD = ThreadId.make("chat");
const manifest: GameManifest = {
  schemaVersion: 1,
  name: "Rover",
  brief: "A brief.",
  artDirection: "",
  engine: { name: "three", version: "1" },
  project: "web",
  assets: [],
};

const repo = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "keep-values-"));
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  git("init", "-q", "-b", "main");
  NodeFS.mkdirSync(NodePath.join(root, "web"));
  NodeFS.writeFileSync(NodePath.join(root, "web", "main.js"), "export function start() {}\n");
  NodeFS.writeFileSync(
    NodePath.join(root, "web", "tune.json"),
    '{\n  "Rules": { "hard": false }\n}\n',
  );
  git("add", "-A");
  git("commit", "-qm", "game");
  return root;
};

const layerFor = (root: string) =>
  GameBuilds.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        CheckpointStore.layer.pipe(
          Layer.provide(
            VcsDriverRegistry.layer.pipe(
              Layer.provide(VcsProcess.layer.pipe(Layer.provide(NodeServices.layer))),
            ),
          ),
        ),
        GameOperations.layer,
        Layer.mock(GameProjectService.GameProjectService)({
          resolve: () => Effect.succeed(root),
          read: () => Effect.succeed(manifest),
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({ projectId: ProjectId.make("rover") } as unknown as Effect.Success<
              ReturnType<ProjectionStore.ProjectionStoreV2["Service"]["getThreadShell"]>
            >),
          listProjectTurnCheckpoints: () => Effect.succeed([]),
          // No other chat of the game is at work.
          getShellSnapshot: () =>
            Effect.succeed({ threads: [] } as unknown as Effect.Success<
              ReturnType<ProjectionStore.ProjectionStoreV2["Service"]["getShellSnapshot"]>
            >),
        }),
        Layer.mock(GameFacts.GameFacts)({
          harness: "test",
          readMany: () => Effect.succeed(new Map()),
          // Queued like a turn build's measure; nothing plays here.
          measure: () => Effect.succeed({} as GameBuildFactsShape),
        }),
        Layer.mock(GameRunControl.GameRunControl)({
          steps: () => Effect.succeed(new Map()),
        }),
        Layer.mock(GameStage.GameStage)({ closeLiveEditors: () => Effect.void }),
        // No other chat writes the folder here.
        Layer.mock(GameFolders.GameFolders)({
          holder: () => Effect.succeed(null),
          withFolder: (_input, work) => work,
          release: () => Effect.void,
        }),
        Layer.mock(GamePreview.GamePreview)({
          url: () => null,
          liveUrl: () => null,
          liveState: () => "off",
          quietWrite: () => Effect.void,
        }),
        Layer.mock(GameBuildCopies.GameBuildCopies)({ plays: () => [] }),
        Layer.mock(Orchestrator.OrchestratorV2)({}),
      ),
    ),
  );

const tuneOf = (root: string) =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(root, "web", "tune.json"), "utf8"));

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
