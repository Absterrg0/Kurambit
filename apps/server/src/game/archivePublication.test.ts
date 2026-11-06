// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Fixture release folders are written with plain fs.
// A release replaces the previous one only whole: a failed publication puts the
// previous release back, and a crash between the two renames is repaired by the
// next sweep, never by deleting the only copy.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { publishStaged, sweepPublished } from "./archivePublication.ts";

const roots: string[] = [];
afterAll(() =>
  Promise.all(roots.map((root) => NodeFSP.rm(root, { recursive: true, force: true }))),
);
const scratch = async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "publish-staged-"));
  roots.push(root);
  return root;
};
const folder = async (path: string, files: Record<string, string>) => {
  await NodeFSP.mkdir(path, { recursive: true });
  for (const [name, text] of Object.entries(files))
    await NodeFSP.writeFile(NodePath.join(path, name), text);
};
const read = (path: string) => NodeFSP.readFile(path, "utf8");

describe("publishStaged", () => {
  it("replaces a release folder whole and leaves nothing beside it", async () => {
    const root = await scratch();
    await folder(NodePath.join(root, "linux"), { "game.x86_64": "old", "game.pck": "old pack" });
    await folder(NodePath.join(root, ".release-linux-x"), { "game.x86_64": "new" });
    await publishStaged([
      { staged: NodePath.join(root, ".release-linux-x"), final: NodePath.join(root, "linux") },
    ]);
    expect(await NodeFSP.readdir(NodePath.join(root, "linux"))).toEqual(["game.x86_64"]);
    expect(await read(NodePath.join(root, "linux/game.x86_64"))).toBe("new");
    expect(await NodeFSP.readdir(root)).toEqual(["linux"]);
  });

  it("puts the previous release back when the new one cannot take its place", async () => {
    const root = await scratch();
    await folder(NodePath.join(root, "windows"), { "game.exe": "old" });
    // The staged folder is gone before its rename: the publication fails after the move-aside.
    await expect(
      publishStaged([
        {
          staged: NodePath.join(root, ".release-windows-missing"),
          final: NodePath.join(root, "windows"),
        },
      ]),
    ).rejects.toThrow(/previous one was kept/);
    expect(await read(NodePath.join(root, "windows/game.exe"))).toBe("old");
    expect(await NodeFSP.readdir(root)).toEqual(["windows"]);
  });
});

describe("sweepPublished", () => {
  it("restores a release a crash left moved aside, and keeps the newest copy only", async () => {
    const root = await scratch();
    const older = NodePath.join(root, ".linux.11111111-1111-1111-1111-111111111111.retired");
    const newer = NodePath.join(root, ".linux.22222222-2222-2222-2222-222222222222.retired");
    await folder(older, { "game.x86_64": "older" });
    await folder(newer, { "game.x86_64": "newer" });
    const past = new Date(Date.now() - 60_000);
    await NodeFSP.utimes(older, past, past);
    await folder(NodePath.join(root, ".release-linux-33333333-3333-3333-3333-333333333333"), {
      "game.x86_64": "partial",
    });
    await sweepPublished(root, (name) => name.startsWith(".release-"));
    expect(await read(NodePath.join(root, "linux/game.x86_64"))).toBe("newer");
    expect(await NodeFSP.readdir(root)).toEqual(["linux"]);
  });

  it("removes a moved-aside copy only when its release is in place", async () => {
    const root = await scratch();
    await folder(NodePath.join(root, "web"), { "index.html": "current" });
    await folder(NodePath.join(root, ".web.44444444-4444-4444-4444-444444444444.retired"), {
      "index.html": "old",
    });
    await sweepPublished(root, () => false);
    expect(await NodeFSP.readdir(root)).toEqual(["web"]);
    expect(await read(NodePath.join(root, "web/index.html"))).toBe("current");
  });
});
