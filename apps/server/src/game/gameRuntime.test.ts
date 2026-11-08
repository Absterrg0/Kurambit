import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runtimeRequestFile } from "./gameRuntime.ts";

describe("runtimeRequestFile", () => {
  let root: string;
  let runtimes: string;
  beforeAll(() => {
    root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kurambit-runtime-"));
    runtimes = NodePath.join(root, "runtime");
    NodeFS.mkdirSync(NodePath.join(runtimes, "three", "1", "shell"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(runtimes, "three", "1", "shell", "shell.js"), "//\n");
    NodeFS.writeFileSync(NodePath.join(root, "secret.txt"), "not the runtime's\n");
    NodeFS.symlinkSync(
      NodePath.join(root, "secret.txt"),
      NodePath.join(runtimes, "three", "1", "shell", "escape.js"),
    );
  });
  afterAll(() => NodeFS.rmSync(root, { recursive: true, force: true }));

  it("serves a file of a known engine's major, and nothing outside the runtime", async () => {
    expect(await runtimeRequestFile(runtimes, "/_kurambit/runtime/three/1/shell/shell.js")).toBe(
      NodeFS.realpathSync(NodePath.join(runtimes, "three", "1", "shell", "shell.js")),
    );
    // A link inside the runtime that points out of it is refused.
    expect(await runtimeRequestFile(runtimes, "/_kurambit/runtime/three/1/shell/escape.js")).toBe(
      null,
    );
    for (const path of [
      "/_kurambit/runtime/nope/1/shell/shell.js",
      "/_kurambit/runtime/three/0/shell/shell.js",
      "/_kurambit/runtime/three/x/shell/shell.js",
      "/_kurambit/runtime/three/1/",
      "/_kurambit/runtime/three/1/shell//shell.js",
      "/_kurambit/runtime/three/1/./shell.js",
      "/shell/shell.js",
    ])
      expect(await runtimeRequestFile(runtimes, path), path).toBe(null);
  });
});
