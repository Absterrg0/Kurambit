// @effect-diagnostics nodeBuiltinImport:off -- Builds a scratch runtime folder with a link out of it.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";

import { runtimeRequestFile } from "./gameRuntime.ts";

it("serves a file of a known engine's major, and nothing outside the runtime", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kurambit-runtime-"));
  try {
    const runtimes = NodePath.join(root, "runtime");
    const shell = NodePath.join(runtimes, "three", "1", "shell");
    NodeFS.mkdirSync(shell, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(shell, "shell.js"), "//\n");
    NodeFS.writeFileSync(NodePath.join(root, "secret.txt"), "not the runtime's\n");
    NodeFS.symlinkSync(NodePath.join(root, "secret.txt"), NodePath.join(shell, "escape.js"));

    expect(await runtimeRequestFile(runtimes, "/_kurambit/runtime/three/1/shell/shell.js")).toBe(
      NodeFS.realpathSync(NodePath.join(shell, "shell.js")),
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
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
