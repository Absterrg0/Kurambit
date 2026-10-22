// @effect-diagnostics nodeBuiltinImport:off -- The test creates a real private runtime directory.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  DISPLAY_VARIABLES,
  prepareDisplaySandbox,
  sandboxDisplayEnvironment,
} from "./display-sandbox.ts";

describe("sandboxDisplayEnvironment", () => {
  it("removes every route to the user's display and points XDG_RUNTIME_DIR elsewhere", () => {
    const sandboxed = sandboxDisplayEnvironment(
      {
        PATH: "/usr/bin",
        DISPLAY: ":0",
        WAYLAND_DISPLAY: "wayland-0",
        XAUTHORITY: "/run/user/1000/xauth",
        XDG_RUNTIME_DIR: "/run/user/1000",
      },
      "/run/game-studio/display-sandbox",
    );
    for (const name of DISPLAY_VARIABLES) assert.equal(sandboxed[name], undefined);
    assert.equal(sandboxed.XDG_RUNTIME_DIR, "/run/game-studio/display-sandbox");
    // The rest of the environment is what makes headless tools work at all.
    assert.equal(sandboxed.PATH, "/usr/bin");
  });

  it("leaves the caller's environment untouched", () => {
    const environment = { DISPLAY: ":0", HOME: "/home/someone" };
    sandboxDisplayEnvironment(environment, "/run/private");
    assert.deepStrictEqual(environment, { DISPLAY: ":0", HOME: "/home/someone" });
  });
});

describe("prepareDisplaySandbox", () => {
  it("creates an empty 0700 directory under the run folder", async () => {
    const run = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "display-sandbox-test-"));
    try {
      const sandbox = await prepareDisplaySandbox(run);
      assert.equal(sandbox.runtimeDirectory, NodePath.join(run, "display-sandbox"));
      assert.deepStrictEqual(await NodeFSP.readdir(sandbox.runtimeDirectory), []);
      const mode = (await NodeFSP.stat(sandbox.runtimeDirectory)).mode & 0o777;
      assert.equal(mode, 0o700);
      assert.equal(sandbox.environment.XDG_RUNTIME_DIR, sandbox.runtimeDirectory);
      for (const name of DISPLAY_VARIABLES) assert.equal(sandbox.environment[name], undefined);
    } finally {
      await NodeFSP.rm(run, { recursive: true, force: true });
    }
  });
});
