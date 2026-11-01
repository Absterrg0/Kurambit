// @effect-diagnostics nodeBuiltinImport:off -- Game records live on the native filesystem outside the game workspace.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** The realpath of an existing game root; the caller decides how to report a failure. */
export const realGameRoot = (root: string) => NodeFSP.realpath(NodePath.resolve(root));
