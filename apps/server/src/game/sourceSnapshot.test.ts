// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Fixture trees are written with plain fs and dated with utimes.
// A build is attached to sources only when they did not change under it. URP's
// runtime-settings list, which the editor empties and a build refills, is not a source.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { gameOperationFault } from "@kurambit/contracts";
import { GODOT_PROFILE } from "./godotProfile.ts";
import { UNITY_PROFILE } from "./unityProfile.ts";
import {
  type SourceHashCache,
  snapshotBuildSource,
  sourceIdentityError,
} from "./sourceSnapshot.ts";

const roots: string[] = [];
afterAll(() =>
  Promise.all(roots.map((root) => NodeFSP.rm(root, { recursive: true, force: true }))),
);

const settings = (list: string, quality = 1) =>
  [
    "MonoBehaviour:",
    "  m_Settings:",
    "    m_SettingsList:",
    "      m_List:",
    "      - rid: 11",
    "      - rid: 12",
    "    m_RuntimeSettings:",
    list,
    `  m_Quality: ${quality}`,
    "",
  ].join("\n");
const empty = "      m_List: []";
const filled = "      m_List:\n      - rid: 11\n      - rid: 12";

const unity = async (content: string) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "source-snapshot-"));
  roots.push(root);
  await NodeFSP.mkdir(NodePath.join(root, "unity/Assets/Settings"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(root, "unity/ProjectSettings"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(root, "unity/ProjectSettings/ProjectVersion.txt"), "v\n");
  await NodeFSP.writeFile(NodePath.join(root, "unity/Assets/Settings/Global.asset"), content);
  return root;
};

const idOf = async (root: string) => {
  const snapshot = await snapshotBuildSource(root, "unity", { rules: UNITY_PROFILE.buildInputs });
  if (snapshot.kind !== "known") throw new Error("unknown snapshot");
  return snapshot.sourceId;
};

describe("snapshotBuildSource on a Unity project", () => {
  it("keeps one identity while URP empties and refills its runtime list", async () => {
    const root = await unity(settings(empty));
    const asset = NodePath.join(root, "unity/Assets/Settings/Global.asset");
    const emptied = await idOf(root);
    await NodeFSP.writeFile(asset, settings(filled));
    expect(await idOf(root)).toBe(emptied);
    await NodeFSP.writeFile(asset, settings(empty));
    expect(await idOf(root)).toBe(emptied);
  });

  it("still moves on any other change to the same file", async () => {
    const root = await unity(settings(filled));
    const asset = NodePath.join(root, "unity/Assets/Settings/Global.asset");
    const start = await idOf(root);
    await NodeFSP.writeFile(asset, settings(filled, 2));
    expect(await idOf(root)).not.toBe(start);
    await NodeFSP.writeFile(
      asset,
      settings(filled).replace("      - rid: 12\n    m_Runtime", "      - rid: 13\n    m_Runtime"),
    );
    expect(await idOf(root)).not.toBe(start);
  });
});

describe("snapshotBuildSource with a hash cache", () => {
  it("sees a same-size edit whose mtime was put back", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "source-snapshot-"));
    roots.push(root);
    const script = NodePath.join(root, "godot/main.gd");
    await NodeFSP.mkdir(NodePath.dirname(script), { recursive: true });
    await NodeFSP.writeFile(script, "speed = 1\n");
    const old = new Date(Date.now() - 60_000);
    await NodeFSP.utimes(script, old, old);
    const cache: SourceHashCache = new Map();
    const first = await snapshotBuildSource(root, "godot", {
      cache,
      rules: GODOT_PROFILE.buildInputs,
    });
    expect(cache.size).toBe(1);
    await NodeFSP.writeFile(script, "speed = 9\n");
    await NodeFSP.utimes(script, old, old);
    const second = await snapshotBuildSource(root, "godot", {
      cache,
      rules: GODOT_PROFILE.buildInputs,
    });
    if (first.kind !== "known" || second.kind !== "known") throw new Error("unknown snapshot");
    expect(second.sourceId).not.toBe(first.sourceId);
  });

  it("does not cache a file written within the racy window", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "source-snapshot-"));
    roots.push(root);
    await NodeFSP.mkdir(NodePath.join(root, "godot"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, "godot/main.gd"), "speed = 1\n");
    const cache: SourceHashCache = new Map();
    await snapshotBuildSource(root, "godot", { cache, rules: GODOT_PROFILE.buildInputs });
    expect(cache.size).toBe(0);
  });
});

// A run judges the build on its own content and pauses on ours: an
// unidentifiable tree must never read as the run's own bad request.
describe("sourceIdentityError", () => {
  const fault = (why: Parameters<typeof sourceIdentityError>[3]) =>
    gameOperationFault(sourceIdentityError("boot", "/g", "unity", why).reason);
  it("reads a link and too many files as the build's, an unreadable or moving tree as ours", () => {
    expect(fault({ kind: "unknown", reason: "symlink", detail: "unity/Assets/x" })).toBe("build");
    expect(fault({ kind: "unknown", reason: "entry-limit" })).toBe("build");
    expect(fault({ kind: "unknown", reason: "io" })).toBe("tool");
    expect(fault({ kind: "changed", detail: "moved" })).toBe("tool");
  });
});
