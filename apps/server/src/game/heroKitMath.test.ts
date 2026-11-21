// @effect-diagnostics nodeBuiltinImport:off -- Runs the kit's Python math tests in a child process.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";

// The hero kit's gate and proportion math is pure numpy (no Blender), so plain python3 tests
// it; a machine without python3 and numpy skips, as tests needing Blender do.
const python = NodeChildProcess.spawnSync("python3", ["-I", "-c", "import numpy"], {
  encoding: "utf8",
});

it.skipIf(python.status !== 0)("the hero kit's gates and proportions hold", () => {
  const run = NodeChildProcess.spawnSync(
    "python3",
    ["-I", NodePath.join(import.meta.dirname, "heroKitMath.test.py")],
    { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  expect(run.stderr).toMatch(/\nOK\s*$/);
  expect(run.status).toBe(0);
});
