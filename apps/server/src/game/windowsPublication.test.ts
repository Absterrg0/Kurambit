// @effect-diagnostics nodeBuiltinImport:off -- These tests publish real files in a temporary directory.
import { it, expect } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { publishWindowsBuild, type WindowsPublicationFileSystem } from "./windowsPublication.ts";

interface FileSystemCall {
  readonly operation: "rename" | "rm";
  readonly from: string;
  readonly to?: string;
}

const withDirectory = async (body: (root: string) => Promise<void>) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "windows-publication-"));
  try {
    await body(root);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
};

const paths = (root: string) => ({
  stagedExecutable: NodePath.join(root, ".staged.exe"),
  stagedPck: NodePath.join(root, ".staged.pck"),
  executable: NodePath.join(root, "game.exe"),
  pck: NodePath.join(root, "game.pck"),
});

const read = (path: string) => NodeFSP.readFile(path, "utf8");
const write = (path: string, text: string) => NodeFSP.writeFile(path, text);
const backups = async (root: string) =>
  (await NodeFSP.readdir(root)).filter((name) => name.endsWith(".backup")).sort();

const injectedFileSystem = (fail: (call: FileSystemCall) => boolean) => {
  const fileSystem: WindowsPublicationFileSystem = {
    rename: async (from, to) => {
      const call = { operation: "rename", from, to } as const;
      if (fail(call)) throw new Error(`injected ${call.operation} failure`);
      await NodeFSP.rename(from, to);
    },
    rm: async (path, options) => {
      const call = { operation: "rm", from: path } as const;
      if (fail(call)) throw new Error(`injected ${call.operation} failure`);
      await NodeFSP.rm(path, options);
    },
  };
  return fileSystem;
};

const failure = async (run: Promise<unknown>) => {
  try {
    await run;
    return null;
  } catch (cause) {
    return cause;
  }
};

it("publishes a non-embedded build as an executable and sidecar", () =>
  withDirectory(async (root) => {
    const target = paths(root);
    await write(target.executable, "old exe");
    await write(target.pck, "old pck");
    await write(target.stagedExecutable, "new exe");
    await write(target.stagedPck, "new pck");

    const result = await publishWindowsBuild({ ...target, stagedPck: target.stagedPck });

    expect(result.notes).toEqual([]);
    expect(await read(target.executable)).toBe("new exe");
    expect(await read(target.pck)).toBe("new pck");
    expect(await backups(root)).toEqual([]);
  }));

it("publishes an embedded build and removes the previous sidecar", () =>
  withDirectory(async (root) => {
    const target = paths(root);
    await write(target.executable, "old exe");
    await write(target.pck, "old pck");
    await write(target.stagedExecutable, "new exe");

    const result = await publishWindowsBuild({ ...target, stagedPck: null });

    expect(result.notes).toEqual([]);
    expect(await read(target.executable)).toBe("new exe");
    await expect(NodeFSP.stat(target.pck)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await backups(root)).toEqual([]);
  }));

it("switches a published build between embedded and sidecar formats", () =>
  withDirectory(async (root) => {
    const target = paths(root);
    await write(target.executable, "old embedded exe");
    await write(target.stagedExecutable, "new embedded exe");
    await publishWindowsBuild({ ...target, stagedPck: null });
    expect(await read(target.executable)).toBe("new embedded exe");
    await expect(NodeFSP.stat(target.pck)).rejects.toMatchObject({ code: "ENOENT" });

    await write(target.stagedExecutable, "new split exe");
    await write(target.stagedPck, "new split pck");
    await publishWindowsBuild({ ...target, stagedPck: target.stagedPck });
    expect(await read(target.executable)).toBe("new split exe");
    expect(await read(target.pck)).toBe("new split pck");

    await write(target.stagedExecutable, "final embedded exe");
    await publishWindowsBuild({ ...target, stagedPck: null });
    expect(await read(target.executable)).toBe("final embedded exe");
    await expect(NodeFSP.stat(target.pck)).rejects.toMatchObject({ code: "ENOENT" });
  }));

it("restores the previous pair when the sidecar was replaced but the executable failed", () =>
  withDirectory(async (root) => {
    const target = paths(root);
    await write(target.executable, "old exe");
    await write(target.pck, "old pck");
    await write(target.stagedExecutable, "new exe");
    await write(target.stagedPck, "new pck");
    const fileSystem = injectedFileSystem(
      (call) => call.operation === "rename" && call.from === target.stagedExecutable,
    );

    const cause = await failure(
      publishWindowsBuild({ ...target, stagedPck: target.stagedPck }, fileSystem),
    );

    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toContain("previous Windows build was kept");
    expect(await read(target.executable)).toBe("old exe");
    expect(await read(target.pck)).toBe("old pck");
    expect(await backups(root)).toEqual([]);
  }));

it("restores a sidecar build when an embedded replacement cannot remove the sidecar", () =>
  withDirectory(async (root) => {
    const target = paths(root);
    await write(target.executable, "old exe");
    await write(target.pck, "old pck");
    await write(target.stagedExecutable, "new embedded exe");
    const fileSystem = injectedFileSystem(
      (call) => call.operation === "rename" && call.from === target.pck,
    );

    const cause = await failure(publishWindowsBuild({ ...target, stagedPck: null }, fileSystem));

    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toContain("previous Windows build was kept");
    expect(await read(target.executable)).toBe("old exe");
    expect(await read(target.pck)).toBe("old pck");
    expect(await backups(root)).toEqual([]);
  }));

it("restores an embedded build when a sidecar replacement fails before the executable", () =>
  withDirectory(async (root) => {
    const target = paths(root);
    await write(target.executable, "old embedded exe");
    await write(target.stagedExecutable, "new split exe");
    await write(target.stagedPck, "new split pck");
    const fileSystem = injectedFileSystem(
      (call) => call.operation === "rename" && call.from === target.stagedExecutable,
    );

    const cause = await failure(
      publishWindowsBuild({ ...target, stagedPck: target.stagedPck }, fileSystem),
    );

    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toContain("previous Windows build was kept");
    expect(await read(target.executable)).toBe("old embedded exe");
    await expect(NodeFSP.stat(target.pck)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await backups(root)).toEqual([]);
  }));

it("removes an incomplete new build when there was no previous one", () =>
  withDirectory(async (root) => {
    const target = paths(root);
    await write(target.stagedExecutable, "new exe");
    await write(target.stagedPck, "new pck");
    const fileSystem = injectedFileSystem(
      (call) => call.operation === "rename" && call.from === target.stagedExecutable,
    );

    const cause = await failure(
      publishWindowsBuild({ ...target, stagedPck: target.stagedPck }, fileSystem),
    );

    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toContain("No previous Windows build was changed");
    await expect(NodeFSP.stat(target.executable)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(NodeFSP.stat(target.pck)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await backups(root)).toEqual([]);
  }));

it("keeps the only preserved backup and names it when recovery fails", () =>
  withDirectory(async (root) => {
    const target = paths(root);
    await write(target.executable, "old exe");
    await write(target.pck, "old pck");
    await write(target.stagedExecutable, "new exe");
    await write(target.stagedPck, "new pck");
    const fileSystem = injectedFileSystem(
      (call) =>
        call.operation === "rename" &&
        (call.from === target.stagedExecutable ||
          (call.from.includes(".pck.") && call.from.endsWith(".backup"))),
    );

    const cause = await failure(
      publishWindowsBuild({ ...target, stagedPck: target.stagedPck }, fileSystem),
    );

    expect(cause).toBeInstanceOf(Error);
    const message = (cause as Error).message;
    expect(message).toContain("could not be fully restored");
    const remaining = await backups(root);
    expect(remaining).toHaveLength(1);
    expect(message).toContain(remaining[0]!);
    expect(await read(NodePath.join(root, remaining[0]!))).toBe("old pck");
  }));

it("reports a leftover backup without failing a completed publication", () =>
  withDirectory(async (root) => {
    const target = paths(root);
    await write(target.executable, "old exe");
    await write(target.pck, "old pck");
    await write(target.stagedExecutable, "new exe");
    await write(target.stagedPck, "new pck");
    const fileSystem = injectedFileSystem(
      (call) => call.operation === "rm" && call.from.endsWith(".backup"),
    );

    const result = await publishWindowsBuild(
      { ...target, stagedPck: target.stagedPck },
      fileSystem,
    );

    expect(await read(target.executable)).toBe("new exe");
    expect(await read(target.pck)).toBe("new pck");
    const remaining = await backups(root);
    expect(remaining).toHaveLength(2);
    for (const name of remaining) expect(result.notes.join(" ")).toContain(name);
  }));
