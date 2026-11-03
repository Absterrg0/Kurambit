// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Git for one game root runs as async children like the bot and Blender services; branch suffixes come from the wall clock.
// Async git for one game root. Every op verifies its outcome and fails loudly; none stashes,
// and none moves trunk away from a commit that is not preserved on another branch.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { GitOutcome } from "./policy.ts";
import type { GitOp } from "./state.ts";

class RunGitError extends Schema.TaggedError<RunGitError>()("RunGitError", {
  op: Schema.String,
  path: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return `Game run git ${this.op} failed (${this.reason}).`;
  }
}

// git add/commit/diff over a game with large binary assets.
const SLOW_MS = 10 * 60_000;
const IDENTITY = ["-c", "user.email=studio@local", "-c", "user.name=studio"];

// Nothing may open on the user's desktop; every child inherits a clean room.
export const strippedEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"]) delete env[name];
  return env;
};

type Exec = { readonly code: number | null; readonly stdout: string; readonly output: string };

// Every git call is an async child: a synchronous `git add -A` on a game with
// assets would freeze the server and every connected client.
const exec = (
  root: string,
  args: ReadonlyArray<string>,
  timeoutMs = 60_000,
  env: Readonly<Record<string, string>> = {},
): Effect.Effect<Exec> =>
  Effect.promise(
    () =>
      new Promise<Exec>((resolve) => {
        const child = NodeChildProcess.spawn("git", [...args], {
          cwd: root,
          env: { ...strippedEnv(), ...env },
          timeout: timeoutMs,
        });
        // No call writes stdin; one that reads it (mktree) sees an empty input, not a hang.
        child.stdin.end();
        let stdout = "";
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          output += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
        });
        child.on("close", (code) => resolve({ code, stdout, output }));
        child.on("error", () => resolve({ code: null, stdout, output }));
      }),
  );

/**
 * The commit a comparator's worktree checks out: the empty tree with no parent,
 * a fixed identity and dates, so it is the same commit every time and says
 * nothing about the run, its rounds or either build.
 */
export const blankCommit = (root: string): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    const tree = yield* exec(root, ["mktree"]);
    if (tree.code !== 0) return null;
    const made = yield* exec(
      root,
      [...IDENTITY, "commit-tree", tree.stdout.trim(), "-m", "blind comparison"],
      60_000,
      { GIT_AUTHOR_DATE: "@0 +0000", GIT_COMMITTER_DATE: "@0 +0000" },
    );
    const sha = made.stdout.trim();
    return made.code === 0 && sha.length > 0 ? sha : null;
  });

/** The game's own sources: bots, notes and skill files never count as game change. */
const gamePaths = (lane: string) => [
  lane,
  `:(exclude)${lane}/**/*.import`,
  `:(exclude)${lane}/**/*.uid`,
  `:(exclude)${lane}/.godot`,
];

const BESIDE_ENGINE = ["art", "ASSETS.md"];
/**
 * What a creator's restore brings back: the engine project and the art
 * sources with their map, so built assets and the .blend files they came from
 * stay together. Run notes, plans, bots and .studio stay as they are.
 */
export const restoredPaths = (lane: string) => [lane, ...BESIDE_ENGINE];

export const makeGit = (root: string, lane: string, log: (line: string) => Effect.Effect<void>) => {
  const fail = (op: string, reason: string, result?: Exec) =>
    (result === undefined
      ? Effect.void
      : log(
          `git ${op}: ${reason} (exit ${result.code ?? "none"}): ${result.output.trim().slice(0, 300)}`,
        )
    ).pipe(Effect.andThen(Effect.fail(new RunGitError({ op, path: root, reason }))));
  const out = (args: ReadonlyArray<string>) =>
    exec(root, args).pipe(Effect.map((r) => (r.code === 0 ? r.stdout.trim() : "")));
  const current = out(["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = out(["rev-parse", "HEAD"]);
  const exists = (name: string) =>
    exec(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]).pipe(
      Effect.map((r) => r.code === 0),
    );
  const unique = (name: string) =>
    Effect.map(exists(name), (taken) => (taken ? `${name}-${Date.now().toString(36)}` : name));
  const dirt = out(["status", "--porcelain=v1", "--", "."]);
  const summary = (text: string) =>
    text.split("\n").filter(Boolean).slice(0, 8).join(" | ").slice(0, 300);

  // Plain checkout, verified by the branch HEAD lands on. A blocked checkout
  // names real dirt: run state and notes are git-ignored.
  const checkout = Effect.fn("RunGit.checkout")(function* (ref: string) {
    const result = yield* exec(root, ["checkout", "-q", ref]);
    if (result.code === 0 && (yield* current) === ref) return true;
    yield* log(`checkout ${ref} blocked; refs left alone. Dirt: ${summary(yield* dirt)}`);
    return false;
  });

  const createBranch = Effect.fn("RunGit.createBranch")(function* (name: string) {
    const created = yield* exec(root, ["checkout", "-qb", name]);
    const on = yield* current;
    if (created.code !== 0 || on !== name)
      return yield* fail("branch", `expected ${name}, on ${on || "?"}`, created);
  });

  // Commits the whole tree and returns HEAD; a clean tree returns HEAD unchanged.
  // A git failure is never read as "nothing to commit".
  const commitAll = Effect.fn("RunGit.commitAll")(function* (message: string) {
    const added = yield* exec(root, ["add", "-A"], SLOW_MS);
    if (added.code !== 0) return yield* fail("commit", "add failed", added);
    const staged = yield* exec(root, ["diff", "--cached", "--quiet"], SLOW_MS);
    if (staged.code === 1) {
      const done = yield* exec(
        root,
        [...IDENTITY, "commit", "-qm", message.slice(0, 200)],
        SLOW_MS,
      );
      if (done.code !== 0) return yield* fail("commit", "commit failed", done);
    } else if (staged.code !== 0) return yield* fail("commit", "diff failed", staged);
    const sha = yield* head;
    if (sha.length === 0) return yield* fail("commit", "no HEAD after commit");
    return sha;
  });

  const changedSince = Effect.fn("RunGit.changedSince")(function* (base: string) {
    const result = yield* exec(
      root,
      ["diff", "--quiet", `${base}..HEAD`, "--", ...gamePaths(lane)],
      SLOW_MS,
    );
    if (result.code === 0) return false;
    if (result.code === 1) return true;
    return yield* fail("commit", "game diff failed", result);
  });

  // Descriptive only: a failed diff counts 0 lines.
  const linesSince = (base: string) =>
    exec(root, ["diff", "--numstat", `${base}..HEAD`, "--", ...gamePaths(lane)], SLOW_MS).pipe(
      Effect.map((r) =>
        r.code !== 0
          ? 0
          : r.stdout
              .split("\n")
              .flatMap((line) => line.split("\t").slice(0, 2).map(Number))
              .filter(Number.isFinite)
              .reduce((sum, n) => sum + n, 0),
      ),
    );

  const outcome = (patch: Partial<GitOutcome>): GitOutcome => ({
    ok: true,
    sha: "",
    branch: "",
    changed: false,
    entered: false,
    lines: 0,
    detail: "",
    ...patch,
  });

  // Moves dirt off any non-trunk branch and returns to trunk. Trunk is the one
  // conventional name the repo has, or the branch HEAD is on.
  const init = Effect.fn("RunGit.init")(function* () {
    const on = yield* current;
    const trunk = (yield* exists("main"))
      ? "main"
      : (yield* exists("master"))
        ? "master"
        : /^(round-|proto-|rejected\/|studio-wt\/)/.test(on) || on === "HEAD" || on === ""
          ? ""
          : on;
    if (trunk.length === 0) return yield* fail("init", "no trunk branch");
    if (on !== trunk) {
      if ((yield* dirt).length > 0) {
        if (on === "HEAD") return yield* fail("init", "detached HEAD with uncommitted work");
        const saved = yield* commitAll(`${on} recovered`);
        yield* log(`recovered uncommitted work on ${on} at ${saved.slice(0, 8)}`);
      }
      if (!(yield* checkout(trunk))) return yield* fail("init", `cannot reach ${trunk}`);
    }
    return outcome({ sha: yield* head, branch: trunk });
  });

  const rejectWork = Effect.fn("RunGit.reject")(function* (op: Extract<GitOp, { _tag: "reject" }>) {
    const on = yield* current;
    if (on === "HEAD" || on === "") return yield* fail("reject", "detached HEAD");
    const sha = yield* commitAll(`rejected ${op.label}: ${op.why}`);
    const name = yield* unique(`rejected/${op.label}`);
    const made = yield* exec(root, ["branch", name, sha]);
    if (made.code !== 0 || (yield* out(["rev-parse", `refs/heads/${name}`])) !== sha)
      return yield* fail("reject", `could not save ${name}`, made);
    if (on !== op.trunk) {
      if (!(yield* checkout(op.trunk))) return yield* fail("reject", `cannot reach ${op.trunk}`);
      return outcome({ branch: name, sha });
    }
    // Work committed on trunk itself (a stage): trunk goes back to best only
    // now that the rejected branch holds that commit and the tree is clean.
    if (sha !== op.best) {
      const clean = (yield* dirt).length === 0;
      const bestOk = (yield* exec(root, ["cat-file", "-e", `${op.best}^{commit}`])).code === 0;
      if (!clean || !bestOk)
        return yield* fail("reject", clean ? "best unreachable" : "tree not clean");
      const reset = yield* exec(root, ["reset", "--hard", "-q", op.best]);
      if (reset.code !== 0 || (yield* head) !== op.best)
        return yield* fail("reject", "reset failed", reset);
    }
    return outcome({ branch: name, sha });
  });

  const toTrunk = Effect.fn("RunGit.toTrunk")(function* (trunk: string, message: string) {
    const on = yield* current;
    if (on === trunk) return outcome({ branch: trunk });
    if (on !== "HEAD") yield* commitAll(message);
    const ok = yield* checkout(trunk);
    return outcome({ ok, branch: ok ? trunk : on, detail: ok ? "" : `cannot reach ${trunk}` });
  });

  // Prototype adoption on the pick only, never for judged rounds: ff-only
  // first, then a merge commit recording the selection. A failed merge aborts
  // verified clean; builders never run on conflicts.
  const adopt = Effect.fn("RunGit.adopt")(function* (trunk: string, ref: string, label: string) {
    if (!(yield* checkout(trunk)))
      return outcome({ ok: false, sha: yield* head, detail: `cannot reach ${trunk}` });
    const contains = exec(root, ["merge-base", "--is-ancestor", ref, "HEAD"]).pipe(
      Effect.map((r) => r.code === 0),
    );
    if ((yield* exec(root, ["merge", "--ff-only", "-q", ref])).code === 0 || (yield* contains))
      return outcome({ sha: yield* head, branch: trunk });
    const merged = yield* exec(root, [
      ...IDENTITY,
      "merge",
      "-q",
      "--no-ff",
      "-m",
      `pick base ${label} (unjudged)`,
      ref,
    ]);
    if (merged.code === 0 && (yield* contains)) return outcome({ sha: yield* head, branch: trunk });
    yield* log(`pick merge of ${label} failed: ${merged.output.trim().slice(0, 200)}; aborting`);
    const aborted = yield* exec(root, ["merge", "--abort"]);
    if ((yield* out(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])).length > 0)
      return yield* fail("adopt", "merge abort left MERGE_HEAD", aborted);
    return outcome({ ok: false, sha: yield* head, branch: trunk, detail: "merge failed" });
  });

  const ffMerge = Effect.fn("RunGit.ffMerge")(function* (trunk: string, branch: string) {
    const tip = yield* out(["rev-parse", `refs/heads/${branch}`]);
    if (tip.length === 0)
      return outcome({ ok: false, branch: yield* current, detail: `${branch} missing` });
    if (!(yield* checkout(trunk)))
      return outcome({ ok: false, branch: yield* current, detail: `cannot reach ${trunk}` });
    const merged = yield* exec(root, ["merge", "--ff-only", "-q", branch]);
    const now = yield* head;
    if (merged.code === 0 && now === tip) return outcome({ sha: now, branch: trunk });
    yield* log(`merge ${branch} failed: ${merged.output.trim().slice(0, 200)}`);
    return outcome({ ok: false, sha: now, branch: trunk, detail: "not a fast-forward" });
  });

  // Game files back to `sha` (HEAD is the judged candidate): tracked edits
  // revert and files added there go. Bots and notes live outside the lane.
  const restoreCommit = Effect.fn("RunGit.restoreCommit")(function* (sha: string, message: string) {
    const paths = gamePaths(lane);
    const status = yield* exec(
      root,
      ["status", "--porcelain=v1", "--untracked-files=all", "--", ...paths],
      SLOW_MS,
    );
    if (status.code !== 0) return yield* fail("restore", "status failed", status);
    const changed = status.stdout.split("\n").filter(Boolean);
    if (changed.length > 0) {
      yield* log(
        `restoring ${changed.length} game path(s) to ${sha.slice(0, 8)}: ${summary(status.stdout)}`,
      );
      const restored = yield* exec(
        root,
        ["restore", `--source=${sha}`, "--staged", "--worktree", "--", ...paths],
        SLOW_MS,
      );
      if (restored.code !== 0) return yield* fail("restore", "restore failed", restored);
      const cleaned = yield* exec(root, ["clean", "-fdq", "--", ...paths], SLOW_MS);
      if (cleaned.code !== 0) return yield* fail("restore", "clean failed", cleaned);
    }
    return outcome({ sha: yield* commitAll(message), branch: yield* current });
  });

  const run = (op: GitOp): Effect.Effect<GitOutcome, RunGitError> => {
    switch (op._tag) {
      case "init":
        return init();
      case "enter":
        return Effect.gen(function* () {
          if ((yield* current) === op.branch) return outcome({ branch: op.branch });
          const ok = yield* checkout(op.branch);
          return outcome({ ok, branch: yield* current });
        });
      case "start-round":
        return Effect.gen(function* () {
          if (!(yield* checkout(op.trunk)))
            return outcome({ ok: false, detail: summary(yield* dirt) || "checkout blocked" });
          // An open pending line grows from its own branch, against the same best.
          const entered =
            op.from !== null && (yield* exists(op.from)) && (yield* checkout(op.from));
          if (op.from !== null && !entered && (yield* current) !== op.trunk)
            return yield* fail("start-round", `left ${op.trunk} without entering ${op.from}`);
          const name = yield* unique(op.key);
          yield* createBranch(name);
          return outcome({ branch: name, sha: yield* head, entered });
        });
      case "commit":
        return Effect.gen(function* () {
          const sha = yield* commitAll(op.message);
          return outcome({
            sha,
            branch: yield* current,
            changed: yield* changedSince(op.base),
            lines: yield* linesSince(op.base),
          });
        });
      case "branch-commit":
        return Effect.gen(function* () {
          // The work must land on its own branch, never on trunk.
          if ((yield* current) !== op.name) yield* createBranch(yield* unique(op.name));
          return outcome({ sha: yield* commitAll(op.message), branch: yield* current });
        });
      case "reject":
        return rejectWork(op);
      case "to-trunk":
        return toTrunk(op.trunk, op.message);
      case "adopt":
        return adopt(op.trunk, op.sha, op.label);
      case "ff-merge":
        return ffMerge(op.trunk, op.branch);
      case "restore-commit":
        return restoreCommit(op.sha, op.message);
    }
  };

  // Run state is harness bookkeeping, never game content: tracked copies from
  // before the ignore rule leave the index, never the disk.
  const untrack = (paths: ReadonlyArray<string>) =>
    exec(root, ["rm", "--cached", "-q", "--ignore-unmatch", "--", ...paths]).pipe(Effect.asVoid);

  // A kept round's build: its branch tip, provided trunk still contains it.
  const keptCommit = Effect.fn("RunGit.keptCommit")(function* (branch: string, trunk: string) {
    const tip = yield* out(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
    if (tip.length === 0) return null;
    const contained = yield* exec(root, [
      "merge-base",
      "--is-ancestor",
      tip,
      `refs/heads/${trunk}`,
    ]);
    return contained.code === 0 ? tip : null;
  });

  // The creator's restore: `restoredPaths` become `sha`'s (files added since
  // go) as one new commit on HEAD, so nothing later is lost. The commit is
  // built in a private index and the working tree is first touched by a
  // fast-forward merge, which refuses when local changes touch a file the
  // restore changes. A failure before that leaves trunk, index and tree as they were.
  // Untracked files are never added.
  const restoreBuild = Effect.fn("RunGit.restoreBuild")(function* (sha: string, message: string) {
    const base = yield* head;
    if (base.length === 0) return yield* fail("restore", "no HEAD");
    // A pathspec in neither commit fails the whole `git restore`.
    const present: Array<string> = [];
    for (const path of restoredPaths(lane)) {
      const inSha = (yield* exec(root, ["cat-file", "-e", `${sha}:${path}`])).code === 0;
      if (inSha || (yield* exec(root, ["cat-file", "-e", `${base}:${path}`])).code === 0)
        present.push(path);
    }
    // An exclude-only pathspec would mean every path.
    if (present.length === 0) return yield* fail("restore", "nothing to restore");
    const gitDir = yield* out(["rev-parse", "--absolute-git-dir"]);
    if (gitDir.length === 0) return yield* fail("restore", "no git directory");
    const index = NodePath.join(gitDir, `kurambit-restore-${NodeCrypto.randomUUID()}.index`);
    const env = { GIT_INDEX_FILE: index };
    const created = yield* Effect.gen(function* () {
      const read = yield* exec(root, ["read-tree", base], SLOW_MS, env);
      if (read.code !== 0) return yield* fail("restore", "read-tree failed", read);
      const staged = yield* exec(
        root,
        ["restore", `--source=${sha}`, "--staged", "--", ...present, `:(exclude)${lane}/.godot`],
        SLOW_MS,
        env,
      );
      if (staged.code !== 0) return yield* fail("restore", "restore failed", staged);
      const tree = yield* exec(root, ["write-tree"], SLOW_MS, env);
      if (tree.code !== 0) return yield* fail("restore", "write-tree failed", tree);
      const made = yield* exec(
        root,
        [...IDENTITY, "commit-tree", tree.stdout.trim(), "-p", base, "-m", message.slice(0, 200)],
        SLOW_MS,
      );
      const commit = made.stdout.trim();
      if (made.code !== 0 || commit.length === 0)
        return yield* fail("restore", "commit failed", made);
      return commit;
    }).pipe(
      Effect.ensuring(Effect.promise(() => NodeFSP.rm(index, { force: true }).catch(() => {}))),
    );
    // A commit that landed since `base` would drop off trunk with the reset.
    const now = yield* head;
    if (now !== base) return yield* fail("restore", `trunk moved to ${now.slice(0, 8)} meanwhile`);
    // A fast-forward refuses when local changes touch a file it changes, and
    // its ref update fails if HEAD moved since the check; unrelated staged
    // changes survive.
    const reset = yield* exec(root, ["merge", "-q", "--ff-only", created], SLOW_MS);
    const after = yield* head;
    if (reset.code !== 0)
      return yield* fail(
        "restore-apply",
        after === base
          ? summary(reset.output)
          : `trunk moved to ${after.slice(0, 8)}: ${summary(reset.output)}`,
        reset,
      );
    if (after !== created) return yield* fail("restore", "HEAD is not the restored commit", reset);
    return created;
  });

  // Whether HEAD's restorable sources are those of `sha`; import sidecars do
  // not count. A failed diff says no.
  const sameBuild = (sha: string) =>
    exec(
      root,
      ["diff", "--quiet", sha, "HEAD", "--", ...gamePaths(lane), ...BESIDE_ENGINE],
      SLOW_MS,
    ).pipe(Effect.map((r) => r.code === 0));

  // Every uncommitted change in the tree, untracked files included; run state is ignored.
  const uncommitted = exec(root, ["status", "--porcelain=v1"], SLOW_MS).pipe(
    Effect.flatMap((r) =>
      r.code === 0
        ? Effect.succeed(r.stdout.split("\n").filter(Boolean))
        : fail("status", "status failed", r),
    ),
  );

  return { run, untrack, current, keptCommit, restoreBuild, sameBuild, uncommitted, summary };
};
