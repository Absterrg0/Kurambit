// @effect-diagnostics nodeBuiltinImport:off -- These tests package real bytes in a temporary game folder.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Yauzl from "yauzl";
import { it, expect } from "@effect/vitest";
import { windowsExecutable, windowsPck } from "./windowsExport.testkit.ts";
import {
  packageWindowsRelease,
  publishWindowsArchive,
  retireWindowsArchive,
  WINDOWS_PACKAGE_FILE,
  windowsPackageArchivePath,
  type WindowsPackageFileSystem,
} from "./windowsPackage.ts";

const withDirectory = async (body: (root: string) => Promise<void>) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "windows-package-"));
  try {
    await body(root);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
};

const windowsDirectory = (root: string) => NodePath.join(root, "builds/windows");

const writeEmbeddedBuild = async (root: string) => {
  const directory = windowsDirectory(root);
  await NodeFSP.mkdir(directory, { recursive: true });
  const executable = windowsExecutable(windowsPck(["project.binary", "scenes/main.tscn"]));
  await NodeFSP.writeFile(NodePath.join(directory, "game.exe"), executable);
  return executable;
};

const writeSidecarBuild = async (root: string) => {
  const directory = windowsDirectory(root);
  await NodeFSP.mkdir(directory, { recursive: true });
  const executable = windowsExecutable(null);
  const pck = windowsPck(["project.binary", "scenes/main.tscn"]);
  await NodeFSP.writeFile(NodePath.join(directory, "game.exe"), executable);
  await NodeFSP.writeFile(NodePath.join(directory, "game.pck"), pck);
  return { executable, pck };
};

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const readArchive = (path: string) =>
  new Promise<Map<string, Buffer>>((resolve, reject) => {
    Yauzl.open(path, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error("The test archive could not be opened."));
        return;
      }
      const entries = new Map<string, Buffer>();
      zip.on("error", reject);
      zip.on("end", () => resolve(entries));
      zip.on("entry", (entry: Yauzl.Entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error(`Could not read ${entry.fileName}.`));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });

const partials = async (root: string) =>
  (await NodeFSP.readdir(windowsDirectory(root))).filter((name) => name.endsWith(".partial"));

it("packages an embedded release as a one-file ZIP with the exact checked bytes", () =>
  withDirectory(async (root) => {
    const executable = await writeEmbeddedBuild(root);
    const result = await packageWindowsRelease({ root });

    expect(result.archivePath).toBe(windowsPackageArchivePath(root));
    expect(result.fileName).toBe(WINDOWS_PACKAGE_FILE);
    expect(result.embeddedPck).toBe(true);
    expect(result.files.map((file) => file.name)).toEqual(["game.exe"]);
    expect(result.files[0]?.sha256).toBe(sha256(executable));
    expect(result.notes).toEqual([]);
    const archive = await NodeFSP.readFile(result.archivePath);
    expect(result.bytes).toBe(archive.byteLength);
    expect(result.sha256).toBe(sha256(archive));

    const entries = await readArchive(result.archivePath);
    expect([...entries.keys()]).toEqual(["game.exe"]);
    expect(entries.get("game.exe")!.equals(executable)).toBe(true);
    expect(await partials(root)).toEqual([]);
  }));

it("packages a sidecar release with both files at the archive root", () =>
  withDirectory(async (root) => {
    const { executable, pck } = await writeSidecarBuild(root);
    const result = await packageWindowsRelease({ root });

    expect(result.embeddedPck).toBe(false);
    expect(result.files.map((file) => file.name).sort()).toEqual(["game.exe", "game.pck"]);
    const entries = await readArchive(result.archivePath);
    expect([...entries.keys()].sort()).toEqual(["game.exe", "game.pck"]);
    expect(entries.get("game.exe")!.equals(executable)).toBe(true);
    expect(entries.get("game.pck")!.equals(pck)).toBe(true);
  }));

it("does not include a leftover sidecar beside an embedded executable", () =>
  withDirectory(async (root) => {
    const executable = await writeEmbeddedBuild(root);
    await NodeFSP.writeFile(
      NodePath.join(windowsDirectory(root), "game.pck"),
      windowsPck(["project.binary"]),
    );
    const result = await packageWindowsRelease({ root });
    expect(result.files.map((file) => file.name)).toEqual(["game.exe"]);
    const entries = await readArchive(result.archivePath);
    expect([...entries.keys()]).toEqual(["game.exe"]);
    expect(entries.get("game.exe")!.equals(executable)).toBe(true);
  }));

it("rejects a missing release and keeps an earlier package and any build files", () =>
  withDirectory(async (root) => {
    const directory = windowsDirectory(root);
    await NodeFSP.mkdir(directory, { recursive: true });
    const archive = windowsPackageArchivePath(root);
    await NodeFSP.writeFile(archive, "earlier package");

    await expect(packageWindowsRelease({ root })).rejects.toMatchObject({
      kind: "missing",
      message: expect.stringContaining("Export Windows first"),
    });
    expect(await NodeFSP.readFile(archive, "utf8")).toBe("earlier package");
    expect(await partials(root)).toEqual([]);
  }));

it("rejects an invalid release without touching the earlier package or its files", () =>
  withDirectory(async (root) => {
    const directory = windowsDirectory(root);
    await NodeFSP.mkdir(directory, { recursive: true });
    const executable = Buffer.from("not a PE executable");
    await NodeFSP.writeFile(NodePath.join(directory, "game.exe"), executable);
    const archive = windowsPackageArchivePath(root);
    await NodeFSP.writeFile(archive, "earlier package");

    const failure = await packageWindowsRelease({ root }).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({
      kind: "invalid",
      message: expect.stringContaining("not a PE executable"),
    });
    expect(await NodeFSP.readFile(archive, "utf8")).toBe("earlier package");
    expect(await NodeFSP.readFile(NodePath.join(directory, "game.exe"))).toEqual(executable);
    expect(await partials(root)).toEqual([]);
  }));

it("rejects a split release whose sidecar is missing", () =>
  withDirectory(async (root) => {
    const directory = windowsDirectory(root);
    await NodeFSP.mkdir(directory, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(directory, "game.exe"), windowsExecutable(null));

    await expect(packageWindowsRelease({ root })).rejects.toMatchObject({
      kind: "invalid",
      message: expect.stringContaining(".pck"),
    });
    expect(await partials(root)).toEqual([]);
  }));

it("cancels before publication and keeps the earlier package", () =>
  withDirectory(async (root) => {
    await writeEmbeddedBuild(root);
    const archive = windowsPackageArchivePath(root);
    await NodeFSP.writeFile(archive, "earlier package");
    const controller = new AbortController();
    controller.abort();

    await expect(packageWindowsRelease({ root, signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(await NodeFSP.readFile(archive, "utf8")).toBe("earlier package");
    expect(await partials(root)).toEqual([]);
  }));

it("restores the previous package when the replacement cannot be moved into place", () =>
  withDirectory(async (root) => {
    const archive = NodePath.join(root, "game-windows.zip");
    const staged = NodePath.join(root, ".game-windows.zip.partial");
    await NodeFSP.writeFile(archive, "earlier package");
    await NodeFSP.writeFile(staged, "new package");
    let renames = 0;
    const fileSystem: WindowsPackageFileSystem = {
      async rename(from, to) {
        renames += 1;
        if (from === staged && renames === 1)
          throw Object.assign(new Error("busy"), { code: "EEXIST" });
        if (from === staged) throw Object.assign(new Error("still busy"), { code: "EEXIST" });
        await NodeFSP.rename(from, to);
      },
      rm: (path, options) => NodeFSP.rm(path, options),
    };

    await expect(
      publishWindowsArchive({ stagedArchive: staged, archive }, fileSystem),
    ).rejects.toThrow("previous package was kept");
    expect(await NodeFSP.readFile(archive, "utf8")).toBe("earlier package");
    expect(await NodeFSP.readFile(staged, "utf8")).toBe("new package");
  }));

it("names the preserved backup when the previous package cannot be restored", () =>
  withDirectory(async (root) => {
    const archive = NodePath.join(root, "game-windows.zip");
    const staged = NodePath.join(root, ".game-windows.zip.partial");
    await NodeFSP.writeFile(archive, "earlier package");
    await NodeFSP.writeFile(staged, "new package");
    let renamedBackup = "";
    const fileSystem: WindowsPackageFileSystem = {
      async rename(from, to) {
        if (from === staged) throw Object.assign(new Error("busy"), { code: "EEXIST" });
        if (from.endsWith(".backup") && to === archive && renamedBackup !== "") {
          throw new Error("restore blocked");
        }
        if (from === archive) renamedBackup = to;
        await NodeFSP.rename(from, to);
      },
      rm: (path, options) => NodeFSP.rm(path, options),
    };

    const failure = await publishWindowsArchive(
      { stagedArchive: staged, archive },
      fileSystem,
    ).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({ name: "WindowsPackageError" });
    expect((failure as Error).message).toContain("preserved at");
    expect((failure as Error).message).toContain(renamedBackup);
    expect(await NodeFSP.readFile(renamedBackup, "utf8")).toBe("earlier package");
    await expect(NodeFSP.stat(archive)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await NodeFSP.readFile(staged, "utf8")).toBe("new package");
  }));

it("retires an incumbent package before publication and restores it on failure", () =>
  withDirectory(async (root) => {
    const archive = NodePath.join(root, "game-windows.zip");
    await NodeFSP.writeFile(archive, "earlier package");
    const retirement = await retireWindowsArchive({ archive });
    expect(retirement).not.toBeNull();
    await expect(NodeFSP.stat(archive)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await NodeFSP.readFile(retirement!.backup, "utf8")).toBe("earlier package");

    await retirement!.restore();
    expect(await NodeFSP.readFile(archive, "utf8")).toBe("earlier package");
    await expect(NodeFSP.stat(retirement!.backup)).rejects.toMatchObject({ code: "ENOENT" });
  }));

it("removes the retired package after publication", () =>
  withDirectory(async (root) => {
    const archive = NodePath.join(root, "game-windows.zip");
    await NodeFSP.writeFile(archive, "earlier package");
    const retirement = await retireWindowsArchive({ archive });
    expect(await retirement!.discard()).toEqual([]);
    await expect(NodeFSP.stat(retirement!.backup)).rejects.toMatchObject({ code: "ENOENT" });
  }));

it("reports a retired package it cannot delete without advertising it for download", () =>
  withDirectory(async (root) => {
    const archive = NodePath.join(root, "game-windows.zip");
    await NodeFSP.writeFile(archive, "earlier package");
    const fileSystem: WindowsPackageFileSystem = {
      rename: (from, to) => NodeFSP.rename(from, to),
      rm: async () => {
        throw new Error("delete blocked");
      },
    };
    const retirement = await retireWindowsArchive({ archive }, fileSystem);
    const notes = await retirement!.discard();
    expect(notes.join(" ")).toContain(retirement!.backup);
    expect(await NodeFSP.readFile(retirement!.backup, "utf8")).toBe("earlier package");
    await expect(NodeFSP.stat(archive)).rejects.toMatchObject({ code: "ENOENT" });
  }));

it("does not retire a package that is not there", () =>
  withDirectory(async (root) => {
    expect(
      await retireWindowsArchive({ archive: NodePath.join(root, "game-windows.zip") }),
    ).toBeNull();
  }));
