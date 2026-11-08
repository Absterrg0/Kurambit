// @effect-diagnostics nodeBuiltinImport:off -- A real repository on disk is what the run's builds live in.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { checkpointRefForGameRun } from "../../checkpointing/Utils.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as Fiber from "effect/Fiber";
import * as GameOperations from "../GameOperations.ts";
import type * as GameService from "../GameService.ts";
import { BuildName } from "./buildNames.ts";
import { buildStep, captureBuild, withBuildInFolder } from "./builds.ts";

const layer = Layer.mergeAll(
  CheckpointStore.layer.pipe(
    Layer.provide(
      VcsDriverRegistry.layer.pipe(
        Layer.provide(VcsProcess.layer.pipe(Layer.provide(NodeServices.layer))),
      ),
    ),
    Layer.provide(NodeServices.layer),
  ),
  // The game's real operation lock: another owner's work holds the folder as it would live.
  GameOperations.layer,
);

const repo = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "run-builds-"));
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  git("init", "-q", "-b", "main");
  NodeFS.mkdirSync(NodePath.join(root, "godot"));
  NodeFS.writeFileSync(NodePath.join(root, "godot", "main.gd"), "extends Node\n");
  git("add", "-A");
  git("commit", "-qm", "game");
  return { root, git };
};

const game = {
  closeLiveEditors: () => Effect.void,
} as unknown as GameService.GameService["Service"];
// The run's own moves pass through the game's operation lock.
const lockOf = Effect.map(GameOperations.GameOperations, (operations) => ({
  operations,
  owner: "game-run:test",
  waitUntil: null,
}));

it.effect("keeps a restore's builds under names git can store, again and again", () =>
  Effect.gen(function* () {
    const lock = yield* lockOf;
    const { root, git } = repo();
    const checkpoints = yield* CheckpointStore.CheckpointStore;
    const runId = "no-run";
    const capture = (name: string) => captureBuild({ checkpoints, lock }, root, runId, name);
    // Every kind of name a restore makes, as a real request id gives it.
    const before = yield* capture(BuildName.restoreBefore("8c1f-uuid:1"));
    const keep = buildStep(
      { game, checkpoints, lock },
      { root, runId, lane: "godot" },
      { _tag: "keep", names: [BuildName.restoreAfter("8c1f-uuid:1")], sha: before },
    );
    // A keep beside the restore's other build, and its repeat.
    assert.isTrue((yield* keep).build.ok);
    assert.isTrue((yield* keep).build.ok);
    assert.equal(
      git("rev-parse", checkpointRefForGameRun(runId, BuildName.restoreAfter("8c1f-uuid:1"))),
      before,
    );
    NodeFS.rmSync(root, { recursive: true, force: true });
  }).pipe(Effect.provide(layer)),
);

// The run is the folder's one writer only through the game's real lock: a move
// while another owner's operation holds the game is refused as busy, never run
// beside it, so the step waits for it instead of capturing a folder in motion.
it.effect(
  "a build move while another owner holds the game is refused busy, not run beside it",
  () =>
    Effect.gen(function* () {
      const lock = yield* lockOf;
      const { root } = repo();
      const checkpoints = yield* CheckpointStore.CheckpointStore;
      const held = yield* Effect.forkChild(
        lock.operations.exclusive(root, "Export Linux", Effect.never, "thread:creator"),
      );
      yield* Effect.yieldNow;
      const refused = yield* captureBuild({ checkpoints, lock }, root, "run_busy", "proto-1").pipe(
        Effect.flip,
      );
      expect(refused).toMatchObject({ _tag: "GameOperationError", reason: "busy" });
      yield* Fiber.interrupt(held);
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(layer)),
);

// Keep going's undo restores a step's base only while the folder still holds
// the step's build: a person's turn or edit after it is never thrown away.
it.effect("an undo with expect moves nothing once the folder moved on, and undoes otherwise", () =>
  Effect.gen(function* () {
    const lock = yield* lockOf;
    const { root } = repo();
    const checkpoints = yield* CheckpointStore.CheckpointStore;
    const main = NodePath.join(root, "web", "main.js");
    NodeFS.mkdirSync(NodePath.dirname(main), { recursive: true });
    const write = (text: string) => NodeFS.writeFileSync(main, text);
    const read = () => NodeFS.readFileSync(main, "utf8");
    const runId = "game-builds";
    write("base\n");
    const base = yield* captureBuild({ checkpoints, lock }, root, runId, "t/base");
    write("step\n");
    const step = yield* captureBuild({ checkpoints, lock }, root, runId, "t/step");
    const undo = (park: string) =>
      withBuildInFolder(
        { game, checkpoints, lock },
        { root, runId, lane: "web" },
        { sha: base, park, expect: step },
        (current) => Effect.succeed({ value: current, putBack: false }),
      );

    // The person's turn changed the game after the step: refused, their work stays.
    write("the person's work\n");
    const refused = yield* undo("restores/moved-before");
    expect(refused).toMatchObject({ kind: "refused", why: "moved-on" });
    expect(read()).toBe("the person's work\n");

    // The folder holds the step's build: the base comes back, and a repeat agrees.
    write("step\n");
    expect((yield* undo("restores/held-before")).kind).toBe("done");
    expect(read()).toBe("base\n");
    expect((yield* undo("restores/held-before")).kind).toBe("done");
    expect(read()).toBe("base\n");
    NodeFS.rmSync(root, { recursive: true, force: true });
  }).pipe(Effect.provide(layer)),
);
