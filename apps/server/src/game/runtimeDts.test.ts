// @effect-diagnostics nodeBuiltinImport:off -- Reads the shipped runtime as games load it.
// runtime.d.ts is what agents read for the runtime's API: it must say what the shipped shell does.
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import { RUNTIME_DTS_MODULES, runtimeDtsHash } from "./runtimeDts.ts";

const runtime = new URL("../../templates/runtime/three/1/", import.meta.url);
/** Bytes an agent reads when it opens the file whole: about 42 KB on 2026-11-20. */
const RUNTIME_DTS_BUDGET = 46_000;

it("keeps runtime.d.ts generated from the shell modules it names", () => {
  const typed = NodeFS.readFileSync(new URL("runtime.d.ts", runtime), "utf8");
  const sources = RUNTIME_DTS_MODULES.map((name) =>
    NodeFS.readFileSync(new URL(`shell/${name}.js`, runtime), "utf8"),
  );
  expect(
    /^\/\/ sources ([0-9a-f]{16})$/m.exec(typed)?.[1],
    "A shell module changed since runtime.d.ts was written: run `node scripts/runtime-dts.ts`.",
  ).toBe(runtimeDtsHash(sources));
  expect(Buffer.byteLength(typed, "utf8")).toBeLessThanOrEqual(RUNTIME_DTS_BUDGET);
});
