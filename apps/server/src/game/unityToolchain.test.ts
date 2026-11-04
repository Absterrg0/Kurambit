// @effect-diagnostics nodeBuiltinImport:off -- Reads the shipped template's ProjectVersion.txt.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { UNITY_MIN_VERSION } from "@kurambit/contracts";
import { toolCandidates } from "./GameToolchain.ts";
import {
  parseSecondaryInstallPath,
  parseUnityVersion,
  pickUnityEditor,
  projectEditorVersion,
  unityEditorDir,
  unityEditorExecutable,
  unityVersionFromPath,
} from "./unityToolchain.ts";

const editor = (version: string, source: "settings" | "env" | "unity-hub" | "kurambit") => ({
  editor: `/hub/${version}/Editor/Unity`,
  source,
  version: parseUnityVersion(version),
});
const picked = (choice: ReturnType<typeof pickUnityEditor>) =>
  choice.kind === "picked"
    ? { version: choice.candidate.version?.text, upgrades: choice.upgradesProject?.text ?? null }
    : choice.kind;

describe("Unity editor selection", () => {
  it("accepts the template's version as the floor", () => {
    const template = NodeFS.readFileSync(
      NodePath.join(
        import.meta.dirname,
        "../../templates/blank-unity/unity/ProjectSettings/ProjectVersion.txt",
      ),
      "utf8",
    );
    expect(projectEditorVersion(template)?.text).toBe(UNITY_MIN_VERSION);
  });

  it("picks the newest supported editor, ordering streams and numbers", () => {
    const candidates = [
      editor("6000.6.7f1", "unity-hub"),
      editor("6000.7.0b3", "unity-hub"),
      editor("6000.6.10f1", "unity-hub"),
      editor("2022.3.40f1", "unity-hub"),
    ];
    expect(picked(pickUnityEditor(candidates, null))).toEqual({
      version: "6000.7.0b3",
      upgrades: null,
    });
  });

  it("keeps a game on its own installed editor, and reports an upgrade otherwise", () => {
    const candidates = [editor("6000.6.7f1", "unity-hub"), editor("6000.7.1f1", "unity-hub")];
    expect(picked(pickUnityEditor(candidates, parseUnityVersion("6000.6.7f1")))).toEqual({
      version: "6000.6.7f1",
      upgrades: null,
    });
    expect(picked(pickUnityEditor(candidates, parseUnityVersion("6000.6.9f1")))).toEqual({
      version: "6000.7.1f1",
      upgrades: "6000.6.9f1",
    });
  });

  it("refuses editors below the floor or outside Unity 6, and an explicit path wins alone", () => {
    expect(picked(pickUnityEditor([editor("6000.6.6f1", "unity-hub")], null))).toBe("unsupported");
    expect(picked(pickUnityEditor([editor("6001.0.0f1", "unity-hub")], null))).toBe("unsupported");
    expect(picked(pickUnityEditor([], null))).toBe("none");
    expect(
      picked(
        pickUnityEditor(
          [editor("6000.6.6f1", "settings"), editor("6000.7.1f1", "unity-hub")],
          null,
        ),
      ),
    ).toBe("unsupported");
    expect(
      picked(
        pickUnityEditor(
          [{ editor: "/opt/unity/Editor/Unity", source: "env", version: null }],
          null,
        ),
      ),
    ).toBe("unknown-version");
  });

  it("reads Hub layouts on each platform", () => {
    const mac = unityEditorExecutable("/Applications/Unity/Hub/Editor/6000.6.7f1", "darwin");
    expect(unityEditorDir(mac)).toBe("/Applications/Unity/Hub/Editor/6000.6.7f1");
    expect(unityVersionFromPath(mac)?.text).toBe("6000.6.7f1");
    const linux = unityEditorExecutable("/home/u/Unity/Hub/Editor/6000.7.1f1", "linux");
    expect(linux).toBe("/home/u/Unity/Hub/Editor/6000.7.1f1/Editor/Unity");
    expect(unityVersionFromPath(linux)?.text).toBe("6000.7.1f1");
    expect(unityVersionFromPath("/opt/unity/Editor/Unity")).toBeNull();
    expect(parseSecondaryInstallPath('"/data/UnityEditors"')).toBe("/data/UnityEditors");
    expect(parseSecondaryInstallPath('""')).toBeNull();
    expect(parseSecondaryInstallPath("not json")).toBeNull();
  });
});

describe("tool candidates", () => {
  it("tries an explicit path alone, else an earlier Kurambit install before PATH", () => {
    expect(toolCandidates("godot", " /x/godot ", "/env/godot", "/tools", "/bin")).toEqual([
      { path: "/x/godot", source: "settings" },
    ]);
    expect(toolCandidates("godot", "", "/env/godot", "/tools", "/bin")).toEqual([
      { path: "/env/godot", source: "env" },
    ]);
    expect(toolCandidates("godot", "", undefined, "/tools", "/bin:/usr/bin")).toEqual([
      { path: "/tools/godot-4.7.2/Godot_v4.7.2-stable_linux.x86_64", source: "kurambit" },
      { path: "/bin/godot", source: "path" },
      { path: "/bin/godot4", source: "path" },
      { path: "/usr/bin/godot", source: "path" },
      { path: "/usr/bin/godot4", source: "path" },
    ]);
  });
});
