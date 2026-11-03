// @effect-diagnostics nodeBuiltinImport:off -- Fixture folders are written with plain fs.
// The asset-use scan is a fact reviewers trust, so its path resolution is checked on small fixture folders.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { readAssetUse } from "./assetUse.ts";

const roots: string[] = [];
afterAll(() =>
  Promise.all(roots.map((root) => NodeFSP.rm(root, { recursive: true, force: true }))),
);

const fixture = async (files: Record<string, string>) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "asset-use-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, path), text);
  }
  return root;
};

describe("readAssetUse", () => {
  it("follows Godot paths, uids, patterns and class names from project.godot", async () => {
    const root = await fixture({
      "ASSETS.md":
        "- `godot/assets/hero.png` hero\n- `godot/assets/gone.png` lost\n- `art/key.png` key art\n",
      "godot/project.godot": '[application]\nrun/main_scene="res://main.tscn"\n',
      "godot/main.tscn":
        '[gd_scene format=3]\n[ext_resource type="Script" path="res://main.gd" id="1"]\n[ext_resource type="Texture2D" path="res://assets/hero.png" id="2"]\n[node name="Bg" type="ColorRect" parent="."]\n',
      "godot/main.gd":
        'extends Node2D\nconst S = preload("uid://abc")\nfunc _ready():\n\tHelper.go()\n\tfor i in 4: load("res://assets/walk_%02d.png" % i)\n\tload("res://assets/nope.png")\nfunc _draw():\n\tdraw_circle(Vector2.ZERO, 4, Color.RED)\n',
      "godot/helper.gd": "class_name Helper\nstatic func go(): pass\n",
      "godot/old.gd":
        'func _draw():\n\tdraw_rect(Rect2(), Color.RED)\n\tload("res://assets/unused.png")\n',
      "godot/assets/hero.png": "",
      "godot/assets/walk_00.png": "",
      "godot/assets/walk_01.png": "",
      "godot/assets/step.wav": "",
      "godot/assets/step.wav.import":
        'uid="uid://abc"\npath="res://.godot/imported/step.wav-1.sample"\n',
      "godot/assets/unused.png": "",
    });
    const use = await readAssetUse(root, "godot");
    expect(use.engine).toBe("godot");
    expect(use.assets).toBe(5);
    expect(use.unused).toEqual(["assets/unused.png"]);
    expect(use.missing).toEqual(["res://assets/nope.png in main.gd"]);
    expect(use.listedMissing).toEqual(["assets/gone.png"]);
    expect(use.unlisted).toEqual([
      "assets/step.wav",
      "assets/unused.png",
      "assets/walk_00.png",
      "assets/walk_01.png",
    ]);
    expect(use.unloaded).toEqual(["old.gd"]);
    expect(use.drawn).toEqual([
      ["ColorRect", 1],
      ["draw_circle", 1],
    ]);
  });

  it("resolves three.js imports, page-relative loads and template paths from index.html", async () => {
    const root = await fixture({
      "web/index.html": '<script type="module" src="./main.js"></script>',
      "web/main.js":
        'import { a } from "./src/a.js";\nimport * as THREE from "three";\nnew THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xff0000 }));\n',
      "web/src/a.js":
        'export const a = 1;\nloader.load("assets/bg.png");\nfor (let i = 0; i < 2; i++) loader.load(`assets/run_${i}.png`);\nnew THREE.MeshBasicMaterial({ map: tex });\nfetch("./missing.json");\n',
      "web/vendor/three.module.js": "new BoxGeometry(1, 1, 1);",
      "web/assets/bg.png": "",
      "web/assets/run_0.png": "",
      "web/assets/run_1.png": "",
      "web/assets/spare.glb": "",
    });
    const use = await readAssetUse(root, "web");
    expect(use.engine).toBe("web");
    expect(use.unused).toEqual(["assets/spare.glb"]);
    expect(use.missing).toEqual(["./missing.json in src/a.js"]);
    expect(use.listed).toBeNull();
    expect(use.drawn).toEqual([
      ["materials without a texture map", 1],
      ["primitive geometries", 1],
    ]);
  });

  it("counts library files as existing but never as game code, and resolves import maps", async () => {
    const root = await fixture({
      "web/index.html":
        '<script type="importmap">{"imports":{"three":"./vendor/three.module.js","three/addons/":"./vendor/addons/"}}</script>\n<script type="module" src="./main.js"></script>',
      "web/main.js":
        'import * as THREE from "./vendor/three.module.js";\nimport { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";\nimport { Noise } from "./lib/noise.min.js";\nnew THREE.MeshStandardMaterial(opts);\nnew THREE.BoxGeometry(1, 1, 1);\n',
      "web/vendor/three.module.js":
        'import "./three.core.js";\nload("animations/animation.js");\nnew BoxGeometry(1, 1, 1);',
      "web/vendor/three.core.js": 'fetch("fish.gltf"); new MeshBasicMaterial({});',
      "web/vendor/addons/loaders/GLTFLoader.js": 'load("draco/decoder.js");',
      "web/vendor/addons/textures/noise.png": "",
      "web/lib/noise.min.js": 'load("audio/ocean.ogg");',
    });
    const use = await readAssetUse(root, "web");
    expect(use.assets).toBe(0);
    expect(use.missing).toEqual([]);
    expect(use.unloaded).toEqual([]);
    expect(use.drawn).toEqual([["primitive geometries", 1]]);
  });

  it("treats paths built at runtime as families, never as missing files", async () => {
    const web = await fixture({
      "web/index.html": '<script type="module" src="src/main.js"></script>',
      "web/src/main.js":
        "const ASSET_ROOT = \"assets/models\";\nloader.load(ASSET_ROOT + \"/enemy.glb\");\nloader.load(`${ASSET_ROOT}/hero.glb`);\nnew Audio('assets/audio/' + name + '.wav');\n",
      "web/assets/models/enemy.glb": "",
      "web/assets/models/hero.glb": "",
      "web/assets/audio/jump.wav": "",
    });
    const webUse = await readAssetUse(web, "web");
    expect(webUse.missing).toEqual([]);
    expect(webUse.unused).toEqual([]);

    const godot = await fixture({
      "godot/project.godot": '[application]\nrun/main_scene="res://main.tscn"\n',
      "godot/main.tscn":
        '[gd_scene format=3]\n[ext_resource type="Script" path="res://main.gd" id="1"]\n',
      "godot/main.gd":
        'const TILE_DIR := "res://assets/tiles"\nconst LEVELS := "res://data/levels.json"\nfunc _ready():\n\tfor n in ["grass", "rock"]: load(TILE_DIR + "/" + n + ".png")\n\tload("res://assets/sfx/" + "hit.ogg")\n',
      "godot/data/levels.json": '{"boss": "res://assets/boss.png"}',
      "godot/assets/tiles/grass.png": "",
      "godot/assets/tiles/rock.png": "",
      "godot/assets/boss.png": "",
      "godot/assets/spare.png": "",
    });
    const godotUse = await readAssetUse(godot, "godot");
    expect(godotUse.missing).toEqual([]);
    expect(godotUse.unused).toEqual(["assets/spare.png"]);
  });

  it("reads ASSETS.md frame families as the files they name", async () => {
    const root = await fixture({
      "ASSETS.md": [
        "| godot/assets/sprites/hero_walk_*.png | hero walk |",
        "| godot/assets/sprites/slime_0.png … slime_5.png | slime |",
        "| `godot/assets/sprites/bat_0.png..bat_2.png` | bat |",
        "| godot/assets/sprites/run_[0-1].png | run |",
        "| godot/assets/sprites/gone_*.png | lost |",
        "Exported as .png, frames named _0.png upward.",
      ].join("\n"),
      "godot/project.godot": "[application]\n",
      ...Object.fromEntries(
        [
          ...[0, 1, 2].map((i) => `hero_walk_${i}`),
          ...[0, 1, 2, 3, 4, 5].map((i) => `slime_${i}`),
          ...[0, 1, 2].map((i) => `bat_${i}`),
          "run_0",
          "run_1",
          "stray",
        ].map((name) => [`godot/assets/sprites/${name}.png`, ""]),
      ),
    });
    const use = await readAssetUse(root, "godot");
    expect(use.listedMissing).toEqual(["assets/sprites/gone_*.png"]);
    expect(use.unlisted).toEqual(["assets/sprites/stray.png"]);
    expect(use.listed).toBe(15);
  });

  it("counts linked files, skips linked folders, and trusts a live uid over a stale path", async () => {
    const root = await fixture({
      "art/linked.png": "",
      "art/folder/inside.png": "",
      "godot/project.godot": '[application]\nrun/main_scene="res://main.tscn"\n',
      "godot/main.tscn":
        '[gd_scene format=3]\n[ext_resource type="Texture2D" uid="uid://tex1" path="res://assets/old/hero.png" id="1"]\n[ext_resource type="Script" path="res://main.gd" id="2"]\n',
      "godot/main.gd": 'func _ready():\n\tload("res://assets/linked.png")\n',
      "godot/assets/hero.png": "",
      "godot/assets/hero.png.import": '[remap]\nuid="uid://tex1"\n',
    });
    await NodeFSP.symlink(
      NodePath.join(root, "art/linked.png"),
      NodePath.join(root, "godot/assets/linked.png"),
    );
    await NodeFSP.symlink(NodePath.join(root, "art/folder"), NodePath.join(root, "godot/linked"));
    const use = await readAssetUse(root, "godot");
    expect(use.assets).toBe(2);
    expect(use.missing).toEqual([]);
    expect(use.unused).toEqual([]);
  });

  it("follows Unity GUIDs from the build scenes and never reads Library/", async () => {
    const meta = (guid: string) => `fileFormatVersion: 2\nguid: ${guid}\n`;
    const root = await fixture({
      "ASSETS.md": "- `unity/Assets/Art/hero.png` hero\n",
      "unity/ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.6.7f1\n",
      "unity/ProjectSettings/EditorBuildSettings.asset": `m_Scenes:\n  - enabled: 1\n    path: Assets/Scenes/Main.unity\n    guid: ${"a".repeat(32)}\n`,
      "unity/Assets/Scenes/Main.unity": `m_Script: {fileID: 11500000, guid: ${"b".repeat(32)}, type: 3}\nm_Mesh: {fileID: 10202, guid: 0000000000000000e000000000000000, type: 0}\nm_Texture: {fileID: 2800000, guid: ${"c".repeat(32)}, type: 3}\n`,
      "unity/Assets/Scenes/Main.unity.meta": meta("a".repeat(32)),
      "unity/Assets/Scripts/Player.cs":
        'public class Player : MonoBehaviour { void Start() { Score.Add(); Resources.Load<AudioClip>("Sfx/jump"); GameObject.CreatePrimitive(PrimitiveType.Cube); } }\n',
      "unity/Assets/Scripts/Player.cs.meta": meta("b".repeat(32)),
      "unity/Assets/Scripts/Score.cs":
        "public static class Score { public static void Add() {} }\n",
      "unity/Assets/Scripts/Unused.cs": "public class Unused {}\n",
      "unity/Assets/Editor/Tool.cs": "public class Tool {}\n",
      "unity/Assets/Art/hero.png": "",
      "unity/Assets/Art/hero.png.meta": meta("c".repeat(32)),
      "unity/Assets/Art/spare.png": "",
      "unity/Assets/Resources/Sfx/jump.wav": "",
      "unity/Library/PackageCache/x/huge.png": "",
    });
    const use = await readAssetUse(root, "unity");
    expect(use.engine).toBe("unity");
    expect(use.assets).toBe(3);
    expect(use.unused).toEqual(["Assets/Art/spare.png"]);
    expect(use.missing).toEqual([]);
    expect(use.listedMissing).toEqual([]);
    expect(use.unloaded).toEqual(["Assets/Scripts/Unused.cs"]);
    expect(use.drawn).toEqual([
      ["built-in primitive meshes", 1],
      ["CreatePrimitive calls", 1],
    ]);
  });

  it("reaches Unity render pipeline assets, skips disabled scenes, and reads C# declarations as code", async () => {
    const meta = (guid: string) => `fileFormatVersion: 2\nguid: ${guid}\n`;
    const g = (c: string) => c.repeat(32);
    const root = await fixture({
      "unity/ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.6.7f1\n",
      "unity/ProjectSettings/EditorBuildSettings.asset": `EditorBuildSettings:\n  m_Scenes:\n  - enabled: 1\n    path: Assets/Scenes/Main.unity\n    guid: ${g("a")}\n  - enabled: 0\n    path: Assets/Scenes/Old.unity\n    guid: ${g("d")}\n  m_configObjects: {}\n`,
      "unity/ProjectSettings/GraphicsSettings.asset": `  m_RenderPipelineGlobalSettingsMap:\n    UnityEngine.Rendering.Universal.UniversalRenderPipeline: {fileID: 11400000, guid: ${g("e")}, type: 2}\n`,
      "unity/ProjectSettings/QualitySettings.asset": `  - name: PC\n    customRenderPipeline: {fileID: 11400000, guid: ${g("f")}, type: 2}\n`,
      "unity/Assets/Scenes/Main.unity": `m_Script: {fileID: 11500000, guid: ${g("b")}, type: 3}\n`,
      "unity/Assets/Scenes/Main.unity.meta": meta(g("a")),
      "unity/Assets/Scenes/Old.unity": `m_Texture: {fileID: 2800000, guid: ${g("9")}, type: 3}\n`,
      "unity/Assets/Scenes/Old.unity.meta": meta(g("d")),
      "unity/Assets/Settings/Global.asset": "m_Name: Global\n",
      "unity/Assets/Settings/Global.asset.meta": meta(g("e")),
      "unity/Assets/Settings/PC_RPAsset.asset": `m_RendererDataList:\n  - {fileID: 11400000, guid: ${g("1")}, type: 2}\n`,
      "unity/Assets/Settings/PC_RPAsset.asset.meta": meta(g("f")),
      "unity/Assets/Settings/PC_Renderer.asset": `m_RendererFeatures:\n  - {fileID: 1}\nm_Script: {fileID: 11500000, guid: ${g("2")}, type: 3}\nm_Lut: {fileID: 2800000, guid: ${g("3")}, type: 3}\n`,
      "unity/Assets/Settings/PC_Renderer.asset.meta": meta(g("1")),
      "unity/Assets/Rendering/Outline.cs":
        "public class OutlineFeature : ScriptableRendererFeature {}\n",
      "unity/Assets/Rendering/Outline.cs.meta": meta(g("2")),
      "unity/Assets/Art/lut.png": "",
      "unity/Assets/Art/lut.png.meta": meta(g("3")),
      "unity/Assets/Art/old.png": "",
      "unity/Assets/Art/old.png.meta": meta(g("9")),
      "unity/Assets/Scripts/Player.cs": [
        "public class Player : MonoBehaviour {",
        "  void Start() {",
        '    Resources.Load<AudioClip>("Sfx/" + clip);',
        '    Resources.Load<Sprite>($"Faces/{mood}");',
        "    new Ghost(); new Sidekick();",
        "  }",
        "}",
        "",
      ].join("\n"),
      "unity/Assets/Scripts/Player.cs.meta": meta(g("b")),
      // Before the real declaration, a comment or string naming another class must not claim it.
      "unity/Assets/Scripts/Aaa.cs":
        '/* class Player */ public class Aaa { string s = "struct Player"; }\n',
      "unity/Assets/Scripts/Ghost.cs": "// class Helper used to live here\npublic class Ghost {}\n",
      "unity/Assets/Scripts/Kinds.cs": "public struct Pickup {}\npublic class Sidekick {}\n",
      "unity/Assets/Resources/Sfx/jump.wav": "",
      "unity/Assets/Resources/Faces/happy.png": "",
    });
    const use = await readAssetUse(root, "unity");
    expect(use.missing).toEqual([]);
    expect(use.unused).toEqual(["Assets/Art/old.png"]);
    expect(use.unloaded).toEqual(["Assets/Scenes/Old.unity", "Assets/Scripts/Aaa.cs"]);
  });
});
