// @effect-diagnostics nodeBuiltinImport:off -- A real repository on disk is what a worktree is seated in.
// A game's work is all uncommitted, so a worktree seated on HEAD is an empty scaffold; and a merge
// back against any base but the copy's recorded seat drops the game's newer work without a
// conflict (the MC design's spike 3.4). Both lose a person's work silently.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CheckpointRef, ThreadId } from "@kurambit/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import { seedWorktree, worktreeSeedOf } from "./worktreeSeed.ts";

const layer = CheckpointStore.layer.pipe(
  Layer.provide(
    VcsDriverRegistry.layer.pipe(
      Layer.provide(VcsProcess.layer.pipe(Layer.provide(NodeServices.layer))),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const game = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worktree-seed-"));
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  const write = (dir: string, file: string, text: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(dir, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, file), text);
  };
  git("init", "-q", "-b", "main");
  write(root, "game.json", "{}\n");
  git("add", "-A");
  git("commit", "-qm", "chore: create game project");
  // Every turn's work stays uncommitted, as in a Kurambit game.
  write(root, "web/main.js", "// the game\n");
  write(root, "web/hud.js", "// The page over the game\n");
  return { root, git, write };
};

it.effect("seats a game's worktree on its files, and a merge from that seat keeps both sides", () =>
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointStore.CheckpointStore;
    const { root, git, write } = game();
    const copy = `${root}-copy`;
    const thread = ThreadId.make("thread-copy");
    const seat = yield* seedWorktree(checkpoints, root, thread);
    git("worktree", "add", "-q", "--detach", copy, seat);
    expect(NodeFS.readFileSync(NodePath.join(copy, "web", "main.js"), "utf8")).toBe(
      "// the game\n",
    );
    expect(yield* worktreeSeedOf(checkpoints, root, thread)).toBe(seat);

    // The game moves on while the copy works.
    write(root, "web/hud.js", "// A: hud polish\n");
    const folder = yield* checkpoints.captureCheckpoint({
      cwd: root,
      checkpointRef: CheckpointRef.make("refs/kurambit/test/game"),
    });
    write(copy, "web/save.js", "// saves\n");
    const work = yield* checkpoints.captureCheckpoint({
      cwd: copy,
      checkpointRef: CheckpointRef.make("refs/kurambit/test/copy"),
    });
    const merged = yield* checkpoints.mergeCheckpoints({
      cwd: root,
      base: seat,
      ours: folder,
      theirs: work,
    });
    expect(merged.conflicts).toEqual([]);
    const at = (path: string) => checkpoints.readFileAt({ cwd: root, revision: merged.tree, path });
    expect(yield* at("web/hud.js")).toBe("// A: hud polish\n");
    expect(yield* at("web/save.js")).toBe("// saves\n");
    git("worktree", "remove", "--force", copy);
    NodeFS.rmSync(root, { recursive: true, force: true });
  }).pipe(Effect.provide(layer)),
);
