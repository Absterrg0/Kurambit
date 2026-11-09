// @effect-diagnostics nodeBuiltinImport:off -- Proves game paths never lead out of the game folder through a link.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@kurambit/shared/HostProcess";
import { copyTree } from "./gameFiles.ts";
import { insideGame, staysInsideGame } from "./gamePath.ts";

const windows = HostProcess.Platform.defaultValue() === "win32";
let base = "";
let root = "";
let outside = "";

beforeEach(() => {
  base = NodeFS.realpathSync.native(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kurambit-game-path-")),
  );
  root = NodePath.join(base, "game");
  outside = NodePath.join(base, "home");
  NodeFS.mkdirSync(NodePath.join(root, "game", "assets"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(outside, "deep"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(outside, "secret.txt"), "the person's own file");
  NodeFS.writeFileSync(NodePath.join(root, "game", "index.html"), "<p>game</p>");
  NodeFS.writeFileSync(NodePath.join(root, "game", "assets", "hero.png"), "png");
  // A junction needs no privilege on Windows; elsewhere it is a plain link.
  NodeFS.symlinkSync(outside, NodePath.join(root, "builds"), "junction");
  NodeFS.symlinkSync(NodePath.join(outside, "secret.txt"), NodePath.join(root, "notes.txt"));
  NodeFS.symlinkSync(NodePath.join(outside, "deep"), NodePath.join(root, "deep"), "junction");
  NodeFS.symlinkSync(NodePath.join(root, "game", "assets"), NodePath.join(root, "art"), "junction");
});

afterEach(() => {
  NodeFS.rmSync(base, { recursive: true, force: true });
});

const refusal = (relative: string) => {
  try {
    insideGame(root, relative);
  } catch (error) {
    return error as { readonly reason: string };
  }
  return null;
};

describe("insideGame", () => {
  it("refuses a link to a folder outside the game, existing or not below it", () => {
    for (const relative of ["builds", "builds/web/candidates", "builds/logs/new.log"])
      expect(refusal(relative)?.reason, relative).toBe("symlink");
  });

  it("refuses a link to a file outside the game", () => {
    expect(refusal("notes.txt")?.reason).toBe("symlink");
  });

  it("resolves `..` after a link where the platform opens it", () => {
    // POSIX follows `deep` before `..`, into the folder holding it; Win32 drops `deep/..` first.
    expect(refusal("deep/../secret.txt")?.reason).toBe(windows ? undefined : "symlink");
    expect(refusal("game/../../home/secret.txt")?.reason).toBe("invalid-path");
  });

  it("keeps real files, links that stay inside, new paths and a linked game root", () => {
    expect(insideGame(root, "game/index.html")).toBe(NodePath.join(root, "game", "index.html"));
    expect(insideGame(root, "art/hero.png")).toBe(NodePath.join(root, "art", "hero.png"));
    expect(insideGame(root, "game/new/deeper/level.json")).toBe(
      NodePath.join(root, "game", "new", "deeper", "level.json"),
    );
    const linkedRoot = NodePath.join(base, "chosen");
    NodeFS.symlinkSync(root, linkedRoot, "junction");
    expect(insideGame(linkedRoot, "game/index.html")).toBe(
      NodePath.join(linkedRoot, "game", "index.html"),
    );
    expect(refusal(".")?.reason).toBe("invalid-path");
    expect(insideGame(root, ".", { root: "allowed" })).toBe(root);
    expect(staysInsideGame(root, "builds")).toBe(false);
  });
});

describe("a copy of a game tree", () => {
  it("leaves out links that lead outside it and keeps the ones that stay", async () => {
    const project = NodePath.join(root, "game");
    NodeFS.symlinkSync(outside, NodePath.join(project, "home"), "junction");
    NodeFS.symlinkSync(NodePath.join(outside, "secret.txt"), NodePath.join(project, "secret.txt"));
    NodeFS.symlinkSync(
      NodePath.join(project, "assets"),
      NodePath.join(project, "sprites"),
      "junction",
    );
    const copy = NodePath.join(base, "copy");
    await copyTree(project, copy);
    expect(NodeFS.readdirSync(copy).toSorted()).toEqual(["assets", "index.html", "sprites"]);
    expect(NodeFS.readFileSync(NodePath.join(copy, "assets", "hero.png"), "utf8")).toBe("png");
    expect(NodeFS.readdirSync(outside).toSorted()).toEqual(["deep", "secret.txt"]);
  });
});
