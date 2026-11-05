// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off -- A real repository on disk is what the repair works on, and its lock's age is a file's wall-clock mtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { repairGit } from "./git.ts";

const repo = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "git-repair-"));
  const git = (...args: string[]) =>
    NodeChildProcess.spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: root,
      encoding: "utf8",
    });
  git("init", "-q", "-b", "main");
  NodeFS.writeFileSync(NodePath.join(root, "game.txt"), "base\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  return { root, git, at: (name: string) => NodePath.join(root, ".git", name) };
};

// A merge stopped on a conflict, as a server death leaves one half-way.
const conflictedMerge = (r: ReturnType<typeof repo>, message: string) => {
  r.git("checkout", "-qb", "proto-1");
  NodeFS.writeFileSync(NodePath.join(r.root, "game.txt"), "proto\n");
  r.git("commit", "-qam", "proto");
  r.git("checkout", "-q", "main");
  NodeFS.writeFileSync(NodePath.join(r.root, "game.txt"), "main\n");
  r.git("commit", "-qam", "main");
  r.git("merge", "-q", "--no-ff", "-m", message, "proto-1");
  assert.isTrue(NodeFS.existsSync(r.at("MERGE_HEAD")));
};

const lines: string[] = [];
const log = (line: string) => Effect.sync(() => void lines.push(line));
const nobody = Effect.succeed(null);

it.live("clears only a stale index lock nothing works on, and only the run's own merge", () =>
  Effect.gen(function* () {
    const r = repo();
    const lock = r.at("index.lock");

    // A lock touched just now may belong to a git still running: left, with why.
    NodeFS.writeFileSync(lock, "");
    const fresh = yield* repairGit(r.root, nobody, log).pipe(Effect.flip);
    assert.match(fresh.reason, /changed \d+ s ago/);
    assert.isTrue(NodeFS.existsSync(lock));

    // Old, but a live turn works in the folder: its git may hold it.
    const old = new Date(Date.now() - 11 * 60_000);
    NodeFS.utimesSync(lock, old, old);
    const held = yield* repairGit(r.root, Effect.succeed('"Builder" (thread-1)'), log).pipe(
      Effect.flip,
    );
    assert.match(held.reason, /while "Builder" \(thread-1\) works there/);
    assert.isTrue(NodeFS.existsSync(lock));

    // Old and nothing works there: removed, and git runs again.
    yield* repairGit(r.root, nobody, log);
    assert.isFalse(NodeFS.existsSync(lock));
    assert.equal(r.git("status", "--porcelain").status, 0);

    // The run's own pick merge, cut half-way: aborted back to a clean trunk.
    conflictedMerge(r, "pick base B (unjudged)");
    yield* repairGit(r.root, nobody, log);
    assert.isFalse(NodeFS.existsSync(r.at("MERGE_HEAD")));
    assert.equal(r.git("status", "--porcelain").stdout, "");
    assert.equal(NodeFS.readFileSync(NodePath.join(r.root, "game.txt"), "utf8"), "main\n");
    assert.isTrue(lines.some((line) => line.includes("aborted the run's own unfinished merge")));

    // A merge someone else started is left as it is, and reported.
    const other = repo();
    conflictedMerge(other, "merge proto-1 by hand");
    const theirs = yield* repairGit(other.root, nobody, log).pipe(Effect.flip);
    assert.match(theirs.reason, /a merge the run did not start is in progress/);
    assert.isTrue(NodeFS.existsSync(other.at("MERGE_HEAD")));
    for (const dir of [r.root, other.root]) NodeFS.rmSync(dir, { recursive: true, force: true });
  }),
);
