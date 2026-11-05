// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Proves a worktree's player reuse leaves its main checkout's players whole.
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { COPY_OF, checkoutOf, reuseMainPlayer, unityPlayerDirectory } from "./unityPlayerCache.ts";

const SOURCE = "a".repeat(64);

const writePlayer = async (directory: string) => {
  await NodeFSP.mkdir(NodePath.join(directory, "game_Data/Managed"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(directory, "game.x86_64"), "elf");
  await NodeFSP.writeFile(NodePath.join(directory, "UnityPlayer.so"), "so");
  await NodeFSP.writeFile(NodePath.join(directory, "game_Data/Managed/Assembly-CSharp.dll"), "dll");
};

const scratch = () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "unity-player-cache-"));

it("copies only a complete player of the exact sources and leaves the main's untouched", async () => {
  const base = await scratch();
  try {
    const main = NodePath.join(base, "main");
    const worktree = NodePath.join(base, "worktree");
    await writePlayer(unityPlayerDirectory(main, SOURCE));

    expect(await reuseMainPlayer(main, worktree, "b".repeat(64))).toMatch(/no player/);
    expect(await reuseMainPlayer(main, main, SOURCE)).toMatch(/main checkout/);

    // A played player is touched, so the main's prune of its oldest keeps it.
    const old = new Date(Date.now() - 86_400_000);
    await NodeFSP.utimes(unityPlayerDirectory(main, SOURCE), old, old);
    expect(await reuseMainPlayer(main, worktree, SOURCE)).toBeNull();
    expect((await NodeFSP.stat(unityPlayerDirectory(main, SOURCE))).mtimeMs).toBeGreaterThan(
      old.getTime() + 60_000,
    );
    const copied = unityPlayerDirectory(worktree, SOURCE);
    expect(
      await NodeFSP.readFile(
        NodePath.join(copied, "game_Data/Managed/Assembly-CSharp.dll"),
        "utf8",
      ),
    ).toBe("dll");
    // A second start finds its own copy in place.
    expect(await reuseMainPlayer(main, worktree, SOURCE)).toBeNull();
    expect(
      (await NodeFSP.readdir(NodePath.dirname(copied))).filter((name) => name.startsWith(".")),
    ).toEqual([]);

    // Removing the worktree removes its copy only.
    await NodeFSP.rm(worktree, { recursive: true, force: true });
    expect(await NodeFSP.readdir(unityPlayerDirectory(main, SOURCE))).toEqual(
      expect.arrayContaining(["game.x86_64", "game_Data", "UnityPlayer.so"]),
    );

    // A player missing its runtime library is not complete.
    await NodeFSP.rm(NodePath.join(unityPlayerDirectory(main, SOURCE), "UnityPlayer.so"));
    expect(await reuseMainPlayer(main, worktree, SOURCE)).toMatch(/no player/);
  } finally {
    await NodeFSP.rm(base, { recursive: true, force: true });
  }
});

it("names a linked worktree's main checkout", async () => {
  const base = await scratch();
  try {
    const main = NodePath.join(base, "main");
    const worktree = NodePath.join(base, "worktree");
    const git = (cwd: string, ...args: string[]) =>
      NodeChildProcess.execFileSync("git", args, {
        cwd,
        env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
      });
    await NodeFSP.mkdir(main);
    git(main, "init", "-q");
    git(
      main,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "x",
    );
    git(main, "worktree", "add", "-q", "--detach", worktree);
    const real = await NodeFSP.realpath(main);
    expect(await checkoutOf(main)).toEqual({ kind: "own" });
    expect(await checkoutOf(worktree)).toEqual({ kind: "linked", main: real });
    // A run's plain copy of a build names its game folder instead.
    const copy = NodePath.join(base, "copy");
    await NodeFSP.mkdir(copy);
    await NodeFSP.writeFile(NodePath.join(copy, COPY_OF), `${main}\n`);
    expect(await checkoutOf(copy)).toEqual({ kind: "linked", main: real });
  } finally {
    await NodeFSP.rm(base, { recursive: true, force: true });
  }
});
