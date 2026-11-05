// @effect-diagnostics nodeBuiltinImport:off -- A decision shows the creator only the evidence files that exist in the game folder.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { findKeyArt } from "../keyArt.ts";
import type { Decision } from "./state.ts";

/** The decision's evidence that exists on disk, with the vision's key art for a style call. */
export const presentable = async (root: string, lane: string, decision: Decision) => {
  const art = decision.kind === "style" ? await findKeyArt(root, lane, "vision") : null;
  const all = [...(art === null ? [] : [{ label: "Key art", path: art }]), ...decision.evidence];
  const kept: Array<Decision["evidence"][number]> = [];
  for (const entry of all) {
    const info = await NodeFSP.stat(NodePath.join(root, entry.path)).catch(() => null);
    if (info?.isFile() === true && info.size > 0) kept.push(entry);
  }
  return kept;
};
