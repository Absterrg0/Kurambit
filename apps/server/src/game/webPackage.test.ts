// @effect-diagnostics nodeBuiltinImport:off -- These tests package real bytes in a temporary game folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it, expect } from "@effect/vitest";
import {
  readZipArchive,
  sha256Of,
  writeFixtureFiles,
  writeWebBuildFixture,
} from "./webPackage.testkit.ts";
import {
  packageWebRelease,
  WEB_PACKAGE_FILE,
  webPackageArchivePath,
  WebPackageError,
} from "./webPackage.ts";

const withDirectory = async (body: (root: string) => Promise<void>) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "web-package-"));
  try {
    await body(root);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
};

const sha256 = sha256Of;

const partials = async (root: string) => {
  try {
    return (await NodeFSP.readdir(NodePath.join(root, "builds/web-packages"))).filter((name) =>
      name.endsWith(".partial"),
    );
  } catch {
    return [];
  }
};

it("packages the exact selected build files at their relative paths, excluding sources and logs", () =>
  withDirectory(async (root) => {
    const { selected } = await writeWebBuildFixture(root);
    await writeFixtureFiles(root, {
      "godot/project.godot": "source",
      "builds/logs/private.log": "not in the archive",
      "builds/web/index.html": "draft export",
      "DESIGN.md": "private design notes",
    });
    const decoy = NodePath.join(root, "builds/candidates", "c".repeat(64), "index.html");
    await NodeFSP.mkdir(NodePath.dirname(decoy), { recursive: true });
    await NodeFSP.writeFile(decoy, "unselected candidate");
    await NodeFSP.mkdir(NodePath.join(root, "builds/web-packages"), { recursive: true });
    await NodeFSP.writeFile(webPackageArchivePath(root, "d".repeat(64)), "older package");

    const result = await packageWebRelease({ root, selected });

    expect(result.buildId).toBe(selected.buildId);
    expect(result.fileName).toBe(WEB_PACKAGE_FILE);
    expect(result.entry).toBe("index.html");
    expect(result.sourceEntry).toBe("index.html");
    expect(result.archivePath).toBe(webPackageArchivePath(root, selected.buildId));
    expect(result.files.map((file) => file.path)).toEqual([
      "assets/data.bin",
      "index.html",
      "index.js",
      "index.pck",
      "index.wasm",
    ]);
    expect(result.files.find((file) => file.path === "index.pck")?.sha256).toBe(
      sha256(Buffer.from("pck")),
    );
    const archive = await NodeFSP.readFile(result.archivePath);
    expect(result.bytes).toBe(archive.byteLength);
    expect(result.sha256).toBe(sha256(archive));
    const entries = await readZipArchive(result.archivePath);
    expect([...entries.keys()].sort()).toEqual([
      "assets/data.bin",
      "index.html",
      "index.js",
      "index.pck",
      "index.wasm",
    ]);
    expect(entries.get("index.html")!.toString()).toContain('<script src="index.js">');
    expect(entries.get("index.pck")!.toString()).toBe("pck");
    expect([...entries.keys()].some((name) => name.includes("builds/"))).toBe(false);
    expect([...entries.keys()]).not.toContain("godot/project.godot");
    expect([...entries.keys()]).not.toContain("private.log");
    // A completed package for another build is retired only after this one
    // published, so the Builds download never mixes builds.
    expect(await partials(root)).toEqual([]);
    await expect(NodeFSP.stat(webPackageArchivePath(root, "d".repeat(64)))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }));

it("reports a changed selected build and keeps the earlier package and sources", () =>
  withDirectory(async (root) => {
    const { selected } = await writeWebBuildFixture(root);
    const archive = webPackageArchivePath(root, selected.buildId);
    await NodeFSP.mkdir(NodePath.dirname(archive), { recursive: true });
    await NodeFSP.writeFile(archive, "earlier package");
    const source = NodePath.join(root, "godot/project.godot");
    await NodeFSP.mkdir(NodePath.dirname(source), { recursive: true });
    await NodeFSP.writeFile(source, "unchanged source");

    await NodeFSP.writeFile(NodePath.join(root, selected.directory, "index.pck"), "changed pck");

    const failure = await packageWebRelease({ root, selected }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(WebPackageError);
    expect(failure).toMatchObject({
      kind: "changed",
      message: expect.stringContaining("changed after it was selected"),
    });
    expect(await NodeFSP.readFile(archive, "utf8")).toBe("earlier package");
    expect(await NodeFSP.readFile(source, "utf8")).toBe("unchanged source");
    expect(await partials(root)).toEqual([]);
  }));

it("reports a missing selected build, a symlinked build and a symlink inside one", () =>
  withDirectory(async (root) => {
    const { selected } = await writeWebBuildFixture(root);
    const archive = webPackageArchivePath(root, selected.buildId);
    await NodeFSP.mkdir(NodePath.dirname(archive), { recursive: true });
    await NodeFSP.writeFile(archive, "earlier package");

    const build = NodePath.join(root, selected.directory);
    await NodeFSP.rename(build, `${build}-real`);
    const missing = await packageWebRelease({ root, selected }).catch((cause: unknown) => cause);
    expect(missing).toMatchObject({
      kind: "missing",
      message: expect.stringContaining("Build & play the game again"),
    });
    expect(await NodeFSP.readFile(archive, "utf8")).toBe("earlier package");

    await NodeFSP.symlink(`${build}-real`, build, "dir");
    const linked = await packageWebRelease({ root, selected }).catch((cause: unknown) => cause);
    expect(linked).toMatchObject({ kind: "invalid" });
    expect(await NodeFSP.readFile(archive, "utf8")).toBe("earlier package");

    await NodeFSP.rm(build);
    await NodeFSP.rename(`${build}-real`, build);
    await NodeFSP.symlink("/etc/passwd", NodePath.join(build, "escape.bin"));
    const inner = await packageWebRelease({ root, selected }).catch((cause: unknown) => cause);
    expect(inner).toMatchObject({
      kind: "invalid",
      message: expect.stringContaining("symlink"),
    });
    expect(await NodeFSP.readFile(archive, "utf8")).toBe("earlier package");
    expect(await partials(root)).toEqual([]);
  }));

it("maps a root-level custom entry to index.html without changing its bytes", () =>
  withDirectory(async (root) => {
    const files = {
      "game.html": '<html><script src="index.js"></script></html>',
      "index.js": "console.log('custom')",
      "index.pck": "pck",
    };
    const fixture = await writeWebBuildFixture(root, files, "game.html");
    const selected = {
      ...fixture.selected,
      headers: { "Cross-Origin-Opener-Policy": "same-origin" },
    };
    const result = await packageWebRelease({ root, selected });
    expect(result.entry).toBe("index.html");
    expect(result.sourceEntry).toBe("game.html");
    expect(result.notes.join(" ")).toContain("stored as index.html");
    expect(result.notes.join(" ")).toContain("Cross-Origin-Opener-Policy: same-origin");
    const entries = await readZipArchive(result.archivePath);
    expect([...entries.keys()].sort()).toEqual(["index.html", "index.js", "index.pck"]);
    expect(entries.get("index.html")!.equals(Buffer.from(files["game.html"]))).toBe(true);
    expect(entries.get("index.js")!.toString()).toBe(files["index.js"]);
  }));

it("refuses an ambiguous or nested custom entry instead of guessing", () =>
  withDirectory(async (root) => {
    const ambiguous = await writeWebBuildFixture(
      root,
      {
        "game.html": "<html>game</html>",
        "index.html": "<html>index</html>",
        "index.js": "js",
      },
      "game.html",
    );
    const both = await packageWebRelease({ root, selected: ambiguous.selected }).catch(
      (cause: unknown) => cause,
    );
    expect(both).toMatchObject({
      kind: "invalid",
      message: expect.stringContaining("both"),
    });

    const nested = await writeWebBuildFixture(
      root,
      {
        "web/game.html": "<html>nested</html>",
        "web/index.js": "js",
      },
      "web/game.html",
    );
    const failure = await packageWebRelease({ root, selected: nested.selected }).catch(
      (cause: unknown) => cause,
    );
    expect(failure).toMatchObject({
      kind: "invalid",
      message: expect.stringContaining("not at the build root"),
    });
  }));

it("cancels before publication and keeps the earlier package, sources and feedback", () =>
  withDirectory(async (root) => {
    const { selected } = await writeWebBuildFixture(root);
    const archive = webPackageArchivePath(root, selected.buildId);
    await NodeFSP.mkdir(NodePath.dirname(archive), { recursive: true });
    await NodeFSP.writeFile(archive, "earlier package");
    const controller = new AbortController();
    controller.abort();

    await expect(
      packageWebRelease({ root, selected, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await NodeFSP.readFile(archive, "utf8")).toBe("earlier package");
    expect(await partials(root)).toEqual([]);
  }));

it("keeps the earlier package when the package directory cannot be written", () =>
  withDirectory(async (root) => {
    const { selected } = await writeWebBuildFixture(root);
    const directory = NodePath.join(root, "builds/web-packages");
    const archive = webPackageArchivePath(root, selected.buildId);
    await NodeFSP.mkdir(directory, { recursive: true });
    await NodeFSP.writeFile(archive, "earlier package");
    await NodeFSP.chmod(directory, 0o500);
    try {
      const failure = await packageWebRelease({ root, selected }).catch((cause: unknown) => cause);
      expect(failure).toMatchObject({
        kind: "io",
        message: expect.stringContaining("previous package was left alone"),
      });
      expect(await NodeFSP.readFile(archive, "utf8")).toBe("earlier package");
    } finally {
      await NodeFSP.chmod(directory, 0o700);
    }
  }));

it("keeps the same archive hash when only editable sources changed", () =>
  withDirectory(async (root) => {
    const { selected } = await writeWebBuildFixture(root);
    const first = await packageWebRelease({ root, selected });
    const source = NodePath.join(root, "godot/scripts/main.gd");
    await NodeFSP.mkdir(NodePath.dirname(source), { recursive: true });
    await NodeFSP.writeFile(source, "extends Node\n# later edit\n");
    const second = await packageWebRelease({ root, selected });
    expect(second.sha256).toBe(first.sha256);
    expect(second.bytes).toBe(first.bytes);
    expect(await NodeFSP.readFile(second.archivePath)).toEqual(
      await NodeFSP.readFile(first.archivePath),
    );
  }));

it("refuses a record that is not bound to its immutable build id", () =>
  withDirectory(async (root) => {
    const { selected } = await writeWebBuildFixture(root);
    const failure = await packageWebRelease({
      root,
      selected: { ...selected, directory: "builds/web" },
    }).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({
      kind: "invalid",
      message: expect.stringContaining("immutable build"),
    });
    const wrong = await packageWebRelease({
      root,
      selected: { ...selected, buildId: "f".repeat(64) },
    }).catch((cause: unknown) => cause);
    expect(wrong).toMatchObject({ kind: "invalid" });
  }));
