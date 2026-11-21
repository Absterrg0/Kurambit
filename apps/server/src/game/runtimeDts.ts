// @effect-diagnostics nodeBuiltinImport:off -- A synchronous hash shared by a maintainer script and a test.
// What runtime.d.ts covers (scripts/runtime-dts.ts writes it): the shell modules a game's main.js
// imports. The shell's own plumbing (the bridge, the checks' probes, replay) is not a game's API.
import * as NodeCrypto from "node:crypto";

export const RUNTIME_DTS_MODULES = [
  "run-state",
  "controls",
  "look",
  "model",
  "animate",
  "juice",
  "audio",
  "assets",
  "level",
  "locomotion",
  "motion-layer",
  "sheets",
] as const;

/** The hash runtime.d.ts records of the modules it was generated from, in RUNTIME_DTS_MODULES order. */
export const runtimeDtsHash = (sources: ReadonlyArray<string>) =>
  NodeCrypto.createHash("sha256").update(sources.join("\0")).digest("hex").slice(0, 16);
