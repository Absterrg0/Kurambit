// @effect-diagnostics nodeBuiltinImport:off -- fixtures are built with plain git and fs calls.
// The differential oracle for the persistent capture index: every capture's
// tree must equal the tree a fresh index seeded from the user's index and HEAD
// gives for the same folder (the capture method before the persistent index),
// and the user's index, HEAD and branches must be byte-identical afterwards.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CheckpointRef } from "@kurambit/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll } from "vite-plus/test";

import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const layer = VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer));

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
});
const git = (cwd: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = gitEnv()) =>
  NodeChildProcess.execFileSync("git", args, { cwd, env, encoding: "utf8", maxBuffer: 1 << 26 });
const gitPath = (cwd: string, name: string) =>
  git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", name]).trim();
const write = (file: string, contents: string | Uint8Array) => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, contents);
};
const sha = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const readOr = (file: string) => (NodeFS.existsSync(file) ? NodeFS.readFileSync(file) : "");

const initRepo = (root: string) => {
  NodeFS.mkdirSync(root, { recursive: true });
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "test@test.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "protocol.file.allow", "always"]);
};
const commitAll = (root: string, message: string) => {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
};
const baseGame = (root: string) => {
  initRepo(root);
  for (let i = 0; i < 20; i += 1)
    write(NodePath.join(root, `scripts/s${i}.gd`), `extends Node # ${i}\n`);
  write(NodePath.join(root, ".gitignore"), "build/\n*.tmp\n");
  write(NodePath.join(root, "README.md"), "# game\n");
  commitAll(root, "base");
  write(NodePath.join(root, "assets/a.txt"), "asset a\n");
  write(NodePath.join(root, "build/out.bin"), "ignored\n");
};

/** The tree of the capture method this replaced, for the folder as it is now. */
const todayTree = (cwd: string) => {
  const index = NodePath.join(NodeOS.tmpdir(), `oracle-index-${NodeCrypto.randomUUID()}`);
  try {
    const userIndex = gitPath(cwd, "index");
    if (NodeFS.existsSync(userIndex)) NodeFS.copyFileSync(userIndex, index);
    const env = { ...gitEnv(), GIT_INDEX_FILE: index };
    let sparse = false;
    try {
      sparse = git(cwd, ["config", "--bool", "core.sparseCheckout"], env).trim() === "true";
    } catch {
      // Unset.
    }
    const config = [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "sparse.expectFilesOutsideOfPatterns=false",
    ];
    git(cwd, [...config, "read-tree", "--reset", "HEAD"], env);
    try {
      git(cwd, [...config, "add", ...(sparse ? ["--sparse"] : []), "-A", "--", "."], env);
    } catch {
      // The old capture's recovery: an embedded repository without a commit is left out.
      const nested = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."], env)
        .split("\0")
        .filter((entry) => entry.endsWith("/"))
        .filter((entry) => {
          try {
            git(NodePath.join(cwd, entry), ["rev-parse", "--verify", "HEAD"], gitEnv());
            return false;
          } catch {
            return true;
          }
        });
      git(
        cwd,
        [...config, "add", "-A", "--", ".", ...nested.map((entry) => `:(exclude,literal)${entry}`)],
        env,
      );
    }
    return git(cwd, [...config, "write-tree"], env).trim();
  } finally {
    NodeFS.rmSync(index, { force: true });
  }
};

/** The user's git state a capture must never write. */
const userState = (cwd: string) =>
  [
    sha(readOr(gitPath(cwd, "index"))),
    readOr(gitPath(cwd, "HEAD")).toString(),
    git(cwd, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags"]),
    sha(readOr(gitPath(cwd, "packed-refs"))),
  ].join("\n");

const captureIndexes = (cwd: string) => {
  const dir = NodePath.join(git(cwd, ["rev-parse", "--absolute-git-dir"]).trim(), "kurambit");
  return NodeFS.existsSync(dir)
    ? NodeFS.readdirSync(dir)
        .filter((name) => name.startsWith("capture-index-"))
        .map((name) => NodePath.join(dir, name))
    : [];
};

const randomFile = (file: string, bytes: number) => write(file, NodeCrypto.randomBytes(bytes));

interface Step {
  readonly name: string;
  readonly act?: (cwd: string) => void;
  /** Whether the capture seeds a fresh index (true) or reuses the kept one (false). */
  readonly seeds: boolean;
  readonly preWrites?: boolean;
  readonly restoreTo?: { readonly step: string; readonly paths: ReadonlyArray<string> };
}
interface Case {
  readonly name: string;
  /** Builds the fixture under `root` and returns the folder to capture. */
  readonly setup: (root: string) => string;
  readonly steps: ReadonlyArray<Step>;
}

const cases: ReadonlyArray<Case> = [
  {
    name: "capture states",
    setup: (root) => (baseGame(root), root),
    steps: [
      { name: "cold", seeds: true },
      { name: "no-op", seeds: false },
      {
        name: "small change",
        seeds: false,
        act: (cwd) => {
          write(NodePath.join(cwd, "scripts/s1.gd"), "extends Node # changed\n");
          write(NodePath.join(cwd, "assets/b.txt"), "asset b\n");
          NodeFS.rmSync(NodePath.join(cwd, "scripts/s2.gd"));
        },
      },
      {
        name: "large change",
        seeds: false,
        preWrites: true,
        act: (cwd) => {
          for (let i = 0; i < 7; i += 1)
            randomFile(NodePath.join(cwd, `assets/big/b${i}.bin`), 10 << 20);
          randomFile(NodePath.join(cwd, "scripts/s3.gd"), 2 << 20);
        },
      },
      { name: "no-op after large", seeds: false },
      {
        name: "after a scoped restore",
        seeds: false,
        restoreTo: { step: "cold", paths: ["assets", "scripts"] },
      },
      {
        name: "deleted index",
        seeds: true,
        act: (cwd) => captureIndexes(cwd).forEach((file) => NodeFS.rmSync(file)),
      },
      {
        name: "corrupt index",
        seeds: true,
        act: (cwd) => captureIndexes(cwd).forEach((file) => write(file, "not an index at all")),
      },
      { name: "no-op after reseed", seeds: false },
      {
        name: "gc'd blob named only by the index",
        seeds: true,
        act: (cwd) => randomFile(NodePath.join(cwd, "assets/lonely.bin"), 4096),
      },
    ],
  },
  {
    name: "CRLF autocrlf",
    setup: (root) => {
      initRepo(root);
      git(root, ["config", "core.autocrlf", "false"]);
      write(NodePath.join(root, "raw.txt"), "committed\r\nwith crlf\r\n");
      write(NodePath.join(root, "lf.txt"), "plain\n");
      commitAll(root, "raw crlf");
      git(root, ["config", "core.autocrlf", "true"]);
      write(NodePath.join(root, "new.txt"), "new\r\nfile\r\n");
      return root;
    },
    steps: [
      { name: "cold", seeds: true },
      {
        name: "committed CRLF file rewritten LF",
        seeds: false,
        act: (cwd) => write(NodePath.join(cwd, "raw.txt"), "now lf\nonly\n"),
      },
      {
        name: "and back to CRLF",
        seeds: false,
        act: (cwd) => write(NodePath.join(cwd, "raw.txt"), "back\r\nto crlf\r\n"),
      },
      {
        name: "lone CR then CRLF",
        seeds: false,
        act: (cwd) => write(NodePath.join(cwd, "odd.txt"), "lone\rcr\n"),
      },
      {
        name: "lone CR file becomes text",
        seeds: false,
        act: (cwd) => write(NodePath.join(cwd, "odd.txt"), "now\r\ncrlf\r\n"),
      },
      {
        name: "autocrlf changes",
        seeds: true,
        act: (cwd) => git(cwd, ["config", "core.autocrlf", "input"]),
      },
    ],
  },
  {
    name: "clean filter",
    setup: (root) => {
      initRepo(root);
      git(root, ["config", "filter.up.clean", "tr a-z A-Z"]);
      git(root, ["config", "filter.up.smudge", "cat"]);
      write(NodePath.join(root, ".gitattributes"), "*.dat filter=up\n");
      write(NodePath.join(root, "tracked.dat"), "tracked\n");
      commitAll(root, "filter");
      write(NodePath.join(root, "new.dat"), "new data\n");
      write(NodePath.join(root, "plain.txt"), "plain text\n");
      // Git applies an ignored .gitattributes from the working tree all the same.
      write(NodePath.join(root, ".gitignore"), "d/.gitattributes\n");
      write(NodePath.join(root, "d/.gitattributes"), "# nothing yet\n");
      write(NodePath.join(root, "d/y.md"), "lower case\n");
      // Old enough that git's racy check does not re-read it anyway.
      NodeFS.utimesSync(NodePath.join(root, "d/y.md"), 1_700_000_000, 1_700_000_000);
      return root;
    },
    steps: [
      { name: "cold", seeds: true },
      {
        name: "filtered file changes",
        seeds: false,
        act: (cwd) => write(NodePath.join(cwd, "new.dat"), "changed data\n"),
      },
      {
        name: "attributes change",
        seeds: true,
        act: (cwd) =>
          write(NodePath.join(cwd, ".gitattributes"), "*.dat filter=up\n*.txt filter=up\n"),
      },
      { name: "no-op", seeds: false },
      {
        name: "an ignored attributes file changes",
        seeds: true,
        act: (cwd) => write(NodePath.join(cwd, "d/.gitattributes"), "*.md filter=up\n"),
      },
    ],
  },
  {
    name: "symlinks and exec bits",
    setup: (root) => {
      initRepo(root);
      write(NodePath.join(root, "target.txt"), "target\n");
      write(NodePath.join(root, "tool.sh"), "#!/bin/sh\n");
      NodeFS.chmodSync(NodePath.join(root, "tool.sh"), 0o755);
      NodeFS.mkdirSync(NodePath.join(root, "dir"));
      write(NodePath.join(root, "dir/inside.txt"), "inside\n");
      NodeFS.symlinkSync("target.txt", NodePath.join(root, "link"));
      commitAll(root, "links");
      NodeFS.symlinkSync("dir", NodePath.join(root, "dirlink"));
      return root;
    },
    steps: [
      { name: "cold", seeds: true },
      {
        name: "link retargeted, exec bit flipped",
        seeds: false,
        act: (cwd) => {
          NodeFS.rmSync(NodePath.join(cwd, "link"));
          NodeFS.symlinkSync("dir/inside.txt", NodePath.join(cwd, "link"));
          NodeFS.chmodSync(NodePath.join(cwd, "tool.sh"), 0o644);
          write(NodePath.join(cwd, "new.sh"), "#!/bin/sh\n");
          NodeFS.chmodSync(NodePath.join(cwd, "new.sh"), 0o755);
        },
      },
      {
        name: "link replaced by a file",
        seeds: false,
        act: (cwd) => {
          NodeFS.unlinkSync(NodePath.join(cwd, "dirlink"));
          write(NodePath.join(cwd, "dirlink"), "a file now\n");
        },
      },
    ],
  },
  {
    name: "exec bits without core.filemode",
    setup: (root) => {
      initRepo(root);
      git(root, ["config", "core.filemode", "false"]);
      write(NodePath.join(root, "tool.sh"), "#!/bin/sh\n");
      git(root, ["add", "tool.sh"]);
      git(root, ["update-index", "--chmod=+x", "tool.sh"]);
      git(root, ["commit", "-q", "-m", "exec"]);
      return root;
    },
    steps: [
      { name: "cold", seeds: true },
      {
        name: "exec file deleted",
        seeds: false,
        act: (cwd) => NodeFS.rmSync(NodePath.join(cwd, "tool.sh")),
      },
      {
        name: "and recreated",
        seeds: false,
        act: (cwd) => write(NodePath.join(cwd, "tool.sh"), "#!/bin/sh\necho again\n"),
      },
    ],
  },
  {
    name: "submodule and nested repositories",
    setup: (root) => {
      const library = NodePath.join(root, "library");
      initRepo(library);
      write(NodePath.join(library, "lib.txt"), "lib\n");
      commitAll(library, "lib");
      const game = NodePath.join(root, "game");
      initRepo(game);
      write(NodePath.join(game, "main.gd"), "main\n");
      commitAll(game, "game");
      git(game, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", library, "sub"]);
      git(game, ["commit", "-q", "-m", "submodule"]);
      const nested = NodePath.join(game, "nested");
      initRepo(nested);
      write(NodePath.join(nested, "n.txt"), "nested\n");
      commitAll(nested, "nested");
      return game;
    },
    steps: [
      { name: "cold", seeds: true },
      {
        name: "submodule and nested repo move",
        seeds: false,
        act: (cwd) => {
          write(NodePath.join(cwd, "sub/lib.txt"), "lib moved\n");
          commitAll(NodePath.join(cwd, "sub"), "move");
          write(NodePath.join(cwd, "nested/n.txt"), "nested moved\n");
          commitAll(NodePath.join(cwd, "nested"), "move");
        },
      },
      {
        name: "a moved submodule's checkout goes",
        seeds: false,
        act: (cwd) => {
          NodeFS.rmSync(NodePath.join(cwd, "sub"), { recursive: true, force: true });
          NodeFS.mkdirSync(NodePath.join(cwd, "sub"));
        },
      },
      {
        name: "nested repo re-made without a commit",
        seeds: false,
        act: (cwd) => {
          NodeFS.rmSync(NodePath.join(cwd, "nested/.git"), { recursive: true, force: true });
          git(NodePath.join(cwd, "nested"), ["init", "-q"]);
        },
      },
      {
        name: "nested repo emptied and re-made",
        seeds: false,
        act: (cwd) => {
          write(NodePath.join(cwd, "nested2/x.txt"), "x\n");
          initRepo(NodePath.join(cwd, "nested2"));
          commitAll(NodePath.join(cwd, "nested2"), "nested2");
        },
      },
      {
        name: "and re-made with nothing in it",
        seeds: false,
        act: (cwd) => {
          NodeFS.rmSync(NodePath.join(cwd, "nested2"), { recursive: true, force: true });
          git(cwd, ["init", "-q", "nested2"]);
        },
      },
    ],
  },
  {
    name: "folders become nested repositories",
    setup: (root) => {
      initRepo(root);
      write(NodePath.join(root, "main.gd"), "main\n");
      commitAll(root, "game");
      write(NodePath.join(root, "sub/a.txt"), "a\n");
      write(NodePath.join(root, "bare/c.txt"), "c\n");
      return root;
    },
    steps: [
      { name: "cold", seeds: true },
      {
        name: "a captured folder becomes a repository with a commit",
        seeds: false,
        act: (cwd) => {
          write(NodePath.join(cwd, "sub/b.txt"), "b\n");
          initRepo(NodePath.join(cwd, "sub"));
          commitAll(NodePath.join(cwd, "sub"), "sub");
        },
      },
      {
        name: "a captured folder becomes a repository without one",
        seeds: false,
        act: (cwd) => git(NodePath.join(cwd, "bare"), ["init", "-q"]),
      },
    ],
  },
  {
    name: "sparse checkout",
    setup: (root) => {
      initRepo(root);
      write(NodePath.join(root, "in/a.txt"), "in\n");
      write(NodePath.join(root, "out/b.txt"), "out\n");
      commitAll(root, "sparse");
      git(root, ["sparse-checkout", "set", "--cone", "in"]);
      write(NodePath.join(root, "in/new.txt"), "new\n");
      return root;
    },
    steps: [
      { name: "cold", seeds: true },
      // Skip-worktree bits live in the user's index: a sparse checkout always seeds from it.
      {
        name: "change",
        seeds: true,
        act: (cwd) => write(NodePath.join(cwd, "in/a.txt"), "changed\n"),
      },
    ],
  },
  {
    name: "split index",
    setup: (root) => {
      baseGame(root);
      git(root, ["config", "core.splitIndex", "true"]);
      git(root, ["update-index", "--split-index"]);
      return root;
    },
    steps: [
      { name: "cold", seeds: true },
      { name: "no-op", seeds: false },
      {
        name: "change, shared index files expired",
        seeds: false,
        act: (cwd) => {
          write(NodePath.join(cwd, "assets/a.txt"), "changed\n");
          git(cwd, ["-c", "splitIndex.sharedIndexExpire=now", "update-index", "--split-index"]);
        },
      },
    ],
  },
  {
    name: "linked worktree",
    setup: (root) => {
      const main = NodePath.join(root, "main");
      baseGame(main);
      git(main, ["worktree", "add", "-q", "-b", "side", NodePath.join(root, "side")]);
      write(NodePath.join(root, "side/assets/side.txt"), "side only\n");
      return NodePath.join(root, "side");
    },
    steps: [
      { name: "cold", seeds: true },
      { name: "no-op", seeds: false },
      {
        name: "main worktree changes do not reach the side",
        seeds: false,
        act: (cwd) => write(NodePath.join(cwd, "../main/assets/main.txt"), "main only\n"),
      },
    ],
  },
  {
    name: "game in a subfolder",
    setup: (root) => {
      initRepo(root);
      write(NodePath.join(root, "tools/t.txt"), "tool\n");
      write(NodePath.join(root, "game/main.gd"), "main\n");
      commitAll(root, "mono");
      write(NodePath.join(root, "game/new.gd"), "new\n");
      write(NodePath.join(root, "tools/untracked.txt"), "outside\n");
      return NodePath.join(root, "game");
    },
    steps: [
      { name: "cold", seeds: true },
      {
        name: "changes inside and outside",
        seeds: false,
        act: (cwd) => {
          write(NodePath.join(cwd, "main.gd"), "main changed\n");
          write(NodePath.join(cwd, "../tools/t.txt"), "tool changed\n");
        },
      },
      {
        name: "HEAD moves outside the game",
        seeds: true,
        act: (cwd) => {
          const top = NodePath.join(cwd, "..");
          git(top, ["add", "tools"]);
          git(top, ["commit", "-q", "-m", "tools"]);
        },
      },
      { name: "no-op", seeds: false },
    ],
  },
  {
    name: "ignore rules and HEAD",
    setup: (root) => {
      initRepo(root);
      write(NodePath.join(root, ".gitignore"), "*.log\n");
      write(NodePath.join(root, "kept.log"), "tracked though ignored\n");
      git(root, ["add", "-f", "kept.log", ".gitignore"]);
      git(root, ["commit", "-q", "-m", "ignored but tracked"]);
      write(NodePath.join(root, "export/out.bin"), "export\n");
      write(NodePath.join(root, "Player.gd"), "player\n");
      return root;
    },
    steps: [
      { name: "cold", seeds: true },
      {
        name: "a captured file becomes ignored",
        seeds: false,
        act: (cwd) => write(NodePath.join(cwd, ".gitignore"), "*.log\nexport/\n"),
      },
      {
        name: "tracked ignored file deleted",
        seeds: false,
        act: (cwd) => NodeFS.rmSync(NodePath.join(cwd, "kept.log")),
      },
      {
        name: "and recreated",
        seeds: false,
        act: (cwd) => write(NodePath.join(cwd, "kept.log"), "back again\n"),
      },
      {
        name: "case-only rename under core.ignorecase",
        seeds: true,
        act: (cwd) => {
          git(cwd, ["config", "core.ignorecase", "true"]);
          NodeFS.renameSync(NodePath.join(cwd, "Player.gd"), NodePath.join(cwd, "player.gd"));
        },
      },
      {
        name: "case-only rename on a kept index",
        seeds: false,
        act: (cwd) =>
          NodeFS.renameSync(NodePath.join(cwd, "player.gd"), NodePath.join(cwd, "PLAYER.gd")),
      },
      {
        name: "user commits",
        seeds: true,
        act: (cwd) => commitAll(cwd, "user work"),
      },
      { name: "no-op", seeds: false },
    ],
  },
];

// The suite's git setup pins core.autocrlf and core.filemode for byte-exact
// fixtures; the oracle needs each repository's own line-ending and mode config.
const pinned = new Map<string, string | undefined>();
beforeAll(() => {
  for (const [name, value] of Object.entries(process.env))
    if (/^GIT_CONFIG_KEY_\d+$/.test(name) && /^core\.(?:autocrlf|filemode)$/i.test(value ?? "")) {
      pinned.set(name, value);
      process.env[name] = "kurambit.oracle-unpinned";
    }
});
afterAll(() => {
  for (const [name, value] of pinned) process.env[name] = value;
});

it.layer(layer)("persistent capture index oracle", (it) => {
  it.effect.each(cases)(
    "$name",
    (testCase) =>
      Effect.gen(function* () {
        const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kurambit-capture-oracle-"));
        try {
          const cwd = testCase.setup(root);
          const live = yield* VcsProcess.VcsProcess;
          let commands: string[][] = [];
          const driver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
            Effect.provideService(VcsProcess.VcsProcess, {
              run: (input) => {
                commands.push([...input.args]);
                return live.run(input);
              },
            }),
          );
          const captured = new Map<string, string>();
          const capture = (name: string) =>
            driver.checkpoints.captureCheckpoint({
              cwd,
              checkpointRef: CheckpointRef.make(`refs/kurambit/checkpoints/oracle/${name}`),
            });
          for (const [index, step] of testCase.steps.entries()) {
            const label = `${testCase.name} / ${step.name}`;
            step.act?.(cwd);
            if (step.restoreTo) {
              yield* driver.checkpoints.restoreCheckpoint({
                cwd,
                checkpointRef: CheckpointRef.make(captured.get(step.restoreTo.step)!),
                filePaths: step.restoreTo.paths,
              });
            }
            if (step.name.startsWith("gc'd blob")) {
              // The index now names lonely.bin's blob; every Kurambit ref goes and gc prunes.
              yield* capture(`pre-gc-${index}`);
              for (const ref of git(cwd, ["for-each-ref", "--format=%(refname)", "refs/kurambit"])
                .split("\n")
                .filter((line) => line.length > 0))
                git(cwd, ["update-ref", "-d", ref]);
              git(cwd, ["reflog", "expire", "--expire=now", "--all"]);
              git(cwd, ["gc", "-q", "--prune=now"]);
              write(NodePath.join(cwd, "assets/after-gc.txt"), "after gc\n");
            }
            const before = userState(cwd);
            commands = [];
            const commit = yield* capture(`${index}-${step.name.replace(/[^a-z0-9]+/gi, "-")}`);
            const ran = commands;
            assert.strictEqual(userState(cwd), before, `${label}: the user's git state changed`);
            // Every object the capture names exists, before the oracle writes any.
            git(cwd, ["fsck", "--connectivity-only", "--no-dangling", "--no-progress", commit]);
            const tree = git(cwd, ["rev-parse", `${commit}^{tree}`]).trim();
            captured.set(step.name, commit);
            assert.strictEqual(tree, todayTree(cwd), `${label}: tree differs from a fresh seed`);
            assert.strictEqual(userState(cwd), before, `${label}: the oracle changed git state`);
            const seeded = ran.some((args) => args.includes("read-tree"));
            assert.strictEqual(seeded, step.seeds, `${label}: seeded=${seeded}`);
            const preWrote = ran.some((args) => args.includes("hash-object"));
            assert.strictEqual(
              preWrote,
              step.preWrites ?? false,
              `${label}: pre-wrote=${preWrote}`,
            );
            if (testCase.name === "split index")
              for (const file of captureIndexes(cwd))
                // Never a split index pointing at a shared index file git could expire.
                assert.isFalse(NodeFS.readFileSync(file).includes("link"), `${label}: split`);
          }
          if (testCase.name === "capture states") {
            const kept = captureIndexes(cwd);
            assert.strictEqual(kept.length, 1, "one kept index per place, no stray temp files");
          }
        } finally {
          NodeFS.rmSync(root, { recursive: true, force: true });
        }
      }),
    120_000,
  );
});

it.layer(layer)("capture index lifetime", (it) => {
  it.effect("goes with the last checkpoint that names its commit, freeing what it pinned", () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kurambit-capture-release-"));
      try {
        baseGame(root);
        const driver = yield* GitVcsDriver.makeVcsDriverShape();
        const ref = (name: string) =>
          CheckpointRef.make(`refs/kurambit/checkpoints/release/${name}`);
        const capture = (name: string) =>
          driver.checkpoints.captureCheckpoint({ cwd: root, checkpointRef: ref(name) });
        const indexRefs = () =>
          git(root, ["for-each-ref", "--format=%(refname)", "refs/kurambit/capture-index/"]).trim();
        const asset = git(root, ["hash-object", "assets/a.txt"]).trim();
        yield* capture("first");
        yield* capture("second");
        // An older checkpoint goes: the index's commit is still named by "second".
        yield* driver.checkpoints.deleteCheckpointRefs({
          cwd: root,
          checkpointRefs: [ref("first")],
        });
        assert.notStrictEqual(indexRefs(), "");
        assert.strictEqual(captureIndexes(root).length, 1);
        // The last one goes: so do the index's ref and file, and gc frees the asset.
        yield* driver.checkpoints.deleteCheckpointRefs({
          cwd: root,
          checkpointRefs: [ref("second")],
        });
        assert.strictEqual(indexRefs(), "");
        assert.strictEqual(captureIndexes(root).length, 0);
        NodeFS.rmSync(NodePath.join(root, "assets"), { recursive: true });
        git(root, ["reflog", "expire", "--expire=now", "--all"]);
        git(root, ["gc", "-q", "--prune=now"]);
        assert.throws(() => git(root, ["cat-file", "-e", asset]));
        // The next capture seeds afresh and keeps an index again.
        write(NodePath.join(root, "assets/a.txt"), "asset a\n");
        const commit = yield* capture("third");
        assert.strictEqual(git(root, ["rev-parse", `${commit}^{tree}`]).trim(), todayTree(root));
        assert.strictEqual(captureIndexes(root).length, 1);
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }),
  );
});
