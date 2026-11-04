// @effect-diagnostics nodeBuiltinImport:off -- Fixture trees are written with plain fs.
// A build is attached to sources only when they did not change under it. URP's
// runtime-settings list, which the editor empties and a build refills, is not a source.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { snapshotBuildSource } from "./sourceSnapshot.ts";

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
  const snapshot = await snapshotBuildSource(root, "unity");
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
