// @effect-diagnostics nodeBuiltinImport:off -- This helper owns the game build path on the native filesystem.
import * as NodePath from "node:path";
import type { GameQualificationRead } from "@t3tools/contracts";

export const webBuildIndex = (root: string) => NodePath.join(root, "builds/web/index.html");

/**
 * Whether the current web build may be served or played. The export stage is
 * only passed when its source snapshot still matches the game's sources, so a
 * missing, stale, failed or unknown export always forces a rebuild.
 */
export const isWebBuildFresh = (qualification: GameQualificationRead): boolean =>
  qualification.stages.some((stage) => stage.stage === "export" && stage.status === "passed");
