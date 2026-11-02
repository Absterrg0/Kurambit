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
});
