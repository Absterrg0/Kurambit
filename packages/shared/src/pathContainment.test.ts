// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { isPathWithinRoot, realPathForContainment } from "./pathContainment.ts";
import * as HostProcess from "./HostProcess.ts";

const windows = HostProcess.Platform.defaultValue() === "win32";
let base = "";
let workspace = "";
let outside = "";

beforeEach(() => {
  base = NodeFS.realpathSync.native(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kurambit-containment-")),
  );
  workspace = NodePath.join(base, "workspace");
  outside = NodePath.join(base, "outside");
  NodeFS.mkdirSync(workspace);
  NodeFS.mkdirSync(outside);
  NodeFS.writeFileSync(NodePath.join(outside, "existing.ts"), "outside");
  NodeFS.symlinkSync(NodePath.join(outside, "existing.ts"), NodePath.join(workspace, "file-link"));
  NodeFS.symlinkSync(outside, NodePath.join(workspace, "dir-link"), "dir");
  // A junction needs no privilege on Windows; elsewhere it is a plain link.
  NodeFS.symlinkSync(outside, NodePath.join(workspace, "junction"), "junction");
});

afterEach(() => {
  NodeFS.rmSync(base, { recursive: true, force: true });
});

// Joined as text, never normalized, so `..` reaches the resolver as an agent wrote it.
const inWorkspace = (relative: string) => `${workspace}${NodePath.sep}${relative}`;
const contained = (relative: string) => {
  const real = realPathForContainment(inWorkspace(relative));
  return real !== undefined && isPathWithinRoot(real, workspace);
};

describe("realPathForContainment", () => {
  it("keeps files the workspace really holds", () => {
    NodeFS.mkdirSync(NodePath.join(workspace, "src"));
    NodeFS.writeFileSync(NodePath.join(workspace, "src", "kept.ts"), "");
    expect(contained("src/kept.ts")).toBe(true);
    expect(contained("src/new/deeper/file.ts")).toBe(true);
    expect(contained("src/./kept.ts")).toBe(true);
  });

  it("follows links out of the workspace, including folders a write would create", () => {
    for (const relative of [
      "file-link",
      "dir-link/existing.ts",
      "dir-link/new.ts",
      "dir-link/new-folder/new.ts",
      "junction/new-folder/new.ts",
    ]) {
      expect(contained(relative), relative).toBe(false);
    }
  });

  it("fails closed when a created folder would step back into a link", () => {
    // Win32 drops `missing/..` before opening anything, so there the link is simply followed.
    expect(contained("missing/../dir-link/new.ts")).toBe(false);
    if (!windows) {
      expect(realPathForContainment(inWorkspace("missing/../dir-link/new.ts"))).toBeUndefined();
    }
  });

  it("resolves `..` after a link the way the platform does", () => {
    // POSIX follows the link before `..`; Win32 drops `link/..` before opening anything.
    expect(realPathForContainment(inWorkspace("dir-link/../escaped.ts"))).toBe(
      NodePath.join(windows ? workspace : base, "escaped.ts"),
    );
  });

  it("fails closed on names Win32 rewrites to reach a link", () => {
    for (const relative of ["dir-link./new.ts", "junction /new.ts", "file-link:stream"]) {
      const real = realPathForContainment(inWorkspace(relative));
      // Elsewhere these are ordinary new names inside the workspace.
      expect(real === undefined, relative).toBe(windows);
    }
  });

  it("fails closed on a dangling link and on a relative path", () => {
    NodeFS.symlinkSync(NodePath.join(outside, "missing"), NodePath.join(workspace, "dangling"));
    expect(realPathForContainment(inWorkspace("dangling/new.ts"))).toBeUndefined();
    expect(realPathForContainment("relative/file.ts")).toBeUndefined();
  });
});
