// @effect-diagnostics nodeBuiltinImport:off -- Proves per-run user:// isolation stays scoped and never touches HOME.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  isPathInside,
  nativeUserEnv,
  nativeUserLayout,
  prepareNativeUserIsolation,
  userDirConfigIssues,
} from "./gameNativeUserDir.ts";

it("keeps containment checks exact", () => {
  expect(isPathInside("/tmp/a/data/godot/app_userdata/x", "/tmp/a/data")).toBe(true);
  expect(isPathInside("/tmp/a/data", "/tmp/a/data")).toBe(true);
  expect(isPathInside("/tmp/a/other", "/tmp/a/data")).toBe(false);
  expect(isPathInside("/tmp/a/data/../other", "/tmp/a/data")).toBe(false);
});

it("accepts default and plain custom names but refuses escaping ones", () => {
  expect(userDirConfigIssues('[application]\nconfig/name="x"\n')).toEqual([]);
  expect(
    userDirConfigIssues(
      '[application]\nconfig/use_custom_user_dir=true\nconfig/custom_user_dir_name="MyGame"\n',
    ),
  ).toEqual([]);
  expect(userDirConfigIssues("[application]\nconfig/use_custom_user_dir=true\n")).toHaveLength(1);
  expect(
    userDirConfigIssues(
      '[application]\nconfig/use_custom_user_dir=true\nconfig/custom_user_dir_name="/abs/path"\n',
    ),
  ).toHaveLength(1);
  expect(
    userDirConfigIssues(
      '[application]\nconfig/use_custom_user_dir=true\nconfig/custom_user_dir_name="../escape"\n',
    ),
  ).toHaveLength(1);
});

it("mints a fresh trio per call without touching HOME", async () => {
  const homeBefore = process.env.HOME;
  const parent = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "userdir-test-"));
  try {
    const first = await prepareNativeUserIsolation(parent);
    const second = await prepareNativeUserIsolation(parent);
    expect(first.dir).not.toBe(second.dir);
    expect(first.dataDir).not.toBe(second.dataDir);
    expect(isPathInside(first.dataDir, parent)).toBe(true);
    expect(first.env.XDG_DATA_HOME).toBe(first.dataDir);
    expect(first.env.XDG_CONFIG_HOME).toBe(first.configDir);
    expect(first.env.XDG_CACHE_HOME).toBe(first.cacheDir);
    // Scoped overrides only: the process environment is never rewritten.
    expect(process.env.HOME).toBe(homeBefore);
    expect(process.env.XDG_DATA_HOME).not.toBe(first.dataDir);
    const probe = nativeUserEnv("/d", "/c", "/k");
    expect(probe).toEqual({ XDG_DATA_HOME: "/d", XDG_CONFIG_HOME: "/c", XDG_CACHE_HOME: "/k" });
  } finally {
    await NodeFSP.rm(parent, { recursive: true, force: true });
  }
});

it("fails when the owned parent is not writable instead of leaking fallback directories", async () => {
  const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "userdir-parent-"));
  try {
    const parent = NodePath.join(base, "not-a-directory");
    await NodeFSP.writeFile(parent, "owned file");
    await expect(prepareNativeUserIsolation(parent)).rejects.toThrow();
    expect(await NodeFSP.readdir(base)).toEqual(["not-a-directory"]);
  } finally {
    await NodeFSP.rm(base, { recursive: true, force: true });
  }
});

it("points each OS's Godot data root into the isolation", () => {
  expect(nativeUserLayout("/r", "linux").env).toEqual({
    XDG_DATA_HOME: "/r/data",
    XDG_CONFIG_HOME: "/r/config",
    XDG_CACHE_HOME: "/r/cache",
  });
  const mac = nativeUserLayout("/r", "darwin");
  expect(mac.env).toEqual({ HOME: "/r/home" });
  expect(mac.dataDir).toBe("/r/home/Library/Application Support");
  const windows = nativeUserLayout("C:\\r", "win32");
  expect(windows.env).toEqual({ APPDATA: "C:\\r\\data", LOCALAPPDATA: "C:\\r\\cache" });
  expect(windows.dataDir).toBe("C:\\r\\data");
});
