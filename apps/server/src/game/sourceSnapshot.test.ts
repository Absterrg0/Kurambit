// @effect-diagnostics nodeBuiltinImport:off -- Fixture repositories are written with plain fs and git.
// A build is attached to sources only when they did not change under it; a file the
// engine rewrote back to its committed bytes is the one change that still counts as current.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "@effect/vitest";
import {
  changedFiles,
  headCommit,
  restoredToCommit,
  snapshotBuildSource,
} from "./sourceSnapshot.ts";

const roots: string[] = [];
afterAll(() =>
  Promise.all(roots.map((root) => NodeFSP.rm(root, { recursive: true, force: true }))),
);

const git = (root: string, args: string[]) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });

const repo = async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "source-snapshot-"));
  roots.push(root);
  await NodeFSP.mkdir(NodePath.join(root, "unity/Assets/Settings"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(root, "unity/ProjectSettings"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(root, "unity/ProjectSettings/ProjectVersion.txt"), "v\n");
  await NodeFSP.writeFile(
    NodePath.join(root, "unity/Assets/Settings/PC_RPAsset.asset"),
    "committed\n",
  );
  await NodeFSP.writeFile(NodePath.join(root, "unity/Assets/Player.cs"), "class Player {}\n");
  await NodeFSP.writeFile(NodePath.join(root, ".gitignore"), "unity/Library/\n*.tmp\n");
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "init"]);
  return root;
};

const known = async (root: string) => {
  const snapshot = await snapshotBuildSource(root, "unity");
  if (snapshot.kind !== "known") throw new Error("unknown snapshot");
  return snapshot;
};

/** What a build did to the tree, judged the way the Unity player build judges it. */
const across = async (root: string, before: () => Promise<void>, during: () => Promise<void>) => {
  await before();
  const start = await known(root);
  const head = await headCommit(root);
  await during();
  const end = await known(root);
  const changed = changedFiles(start, end).map((path) => `unity/${path}`);
  return { changed, current: await restoredToCommit(root, "unity", start, end, head) };
};

const asset = (root: string) => NodePath.join(root, "unity/Assets/Settings/PC_RPAsset.asset");

describe("restoredToCommit", () => {
  it("accepts a build that wrote a rewritten file back to its committed bytes", async () => {
    const root = await repo();
    const result = await across(
      root,
      () => NodeFSP.writeFile(asset(root), "rewritten by the import\n"),
      () => NodeFSP.writeFile(asset(root), "committed\n"),
    );
    expect(result).toEqual({ changed: ["unity/Assets/Settings/PC_RPAsset.asset"], current: true });
  });

  it("still catches an edit, a new file, an ignored file and a deletion made during the build", async () => {
    const root = await repo();
    const nothing = async () => {};
    expect(
      (
        await across(root, nothing, () =>
          NodeFSP.writeFile(
            NodePath.join(root, "unity/Assets/Player.cs"),
            "class Player { int x; }\n",
          ),
        )
      ).current,
    ).toBe(false);
    git(root, ["checkout", "-q", "--", "."]);
    expect(
      (
        await across(root, nothing, () =>
          NodeFSP.writeFile(NodePath.join(root, "unity/Assets/New.cs"), "class New {}\n"),
        )
      ).current,
    ).toBe(false);
    await NodeFSP.rm(NodePath.join(root, "unity/Assets/New.cs"));
    expect(
      (
        await across(root, nothing, () =>
          NodeFSP.writeFile(NodePath.join(root, "unity/Assets/scratch.tmp"), "x\n"),
        )
      ).current,
    ).toBe(false);
    await NodeFSP.rm(NodePath.join(root, "unity/Assets/scratch.tmp"));
    expect((await across(root, nothing, () => NodeFSP.rm(asset(root)))).current).toBe(false);
  });

  it("rejects a commit, a deleted untracked file and a revert of a dirty script made during the build", async () => {
    const root = await repo();
    const player = NodePath.join(root, "unity/Assets/Player.cs");
    const nothing = async () => {};
    const committedMidBuild = await across(root, nothing, async () => {
      await NodeFSP.writeFile(player, "class Player { int y; }\n");
      git(root, ["commit", "-qam", "mid-build"]);
    });
    expect(committedMidBuild.current).toBe(false);
    const fresh = NodePath.join(root, "unity/Assets/New.cs");
    const deletedMidBuild = await across(
      root,
      () => NodeFSP.writeFile(fresh, "class New {}\n"),
      () => NodeFSP.rm(fresh),
    );
    expect(deletedMidBuild.current).toBe(false);
    const revertedMidBuild = await across(
      root,
      () => NodeFSP.writeFile(player, "class Player { dirty; }\n"),
      async () => {
        git(root, ["checkout", "-q", "--", "."]);
      },
    );
    expect(revertedMidBuild.current).toBe(false);
  });

  it("rejects a rewritten asset when HEAD moved during the build", async () => {
    const root = await repo();
    const result = await across(
      root,
      () => NodeFSP.writeFile(asset(root), "rewritten by the import\n"),
      async () => {
        await NodeFSP.writeFile(asset(root), "committed\n");
        await NodeFSP.writeFile(NodePath.join(root, "notes.md"), "x\n");
        git(root, ["add", "notes.md"]);
        git(root, ["commit", "-qm", "elsewhere"]);
      },
    );
    expect(result.current).toBe(false);
  });
});
