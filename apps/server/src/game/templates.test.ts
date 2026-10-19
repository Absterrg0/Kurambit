// @effect-diagnostics nodeBuiltinImport:off -- Tests copy real template files with real filesystem I/O.
import { it, expect } from "@effect/vitest";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { GAME_TEMPLATES, GameTemplate } from "@t3tools/contracts";
import {
  copyTemplateIntoGame,
  isTemplateTextFile,
  resolveTemplatesDirectory,
  substituteGameName,
} from "./templates.ts";

const decodeTemplate = Schema.decodeUnknownSync(Schema.fromJsonString(GameTemplate));

it("substitutes the game name only in template text files", () => {
  expect(substituteGameName("{{GAME_NAME}} and {{GAME_NAME}}", "Tiny Quest")).toBe(
    "Tiny Quest and Tiny Quest",
  );
  // The escaped variant is a string body, so it drops into any quoted literal.
  expect(substituteGameName('config/name="{{GAME_NAME_ESCAPED}}"', 'My "Best" Game \\ 2')).toBe(
    'config/name="My \\"Best\\" Game \\\\ 2"',
  );
  for (const file of [
    "project.godot",
    "scenes/main.tscn",
    "art/tile.tres",
    "main.gd",
    "export_presets.cfg",
    "TEMPLATE.md",
    "data.json",
  ])
    expect(isTemplateTextFile(file)).toBe(true);
  for (const file of ["icon.bin", "notes.txt"]) expect(isTemplateTextFile(file)).toBe(false);
});

it.effect("offers only starter templates that exist on disk with matching metadata", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const templatesDirectory = yield* resolveTemplatesDirectory();
    expect(templatesDirectory).toBe(NodePath.join(import.meta.dirname, "../../templates"));
    for (const template of GAME_TEMPLATES) {
      const directory = path.join(templatesDirectory, template.id);
      expect(
        decodeTemplate(yield* fs.readFileString(path.join(directory, "template.json"))),
      ).toEqual(template);
      expect(yield* fs.exists(path.join(directory, "godot/project.godot"))).toBe(true);
      expect(yield* fs.exists(path.join(directory, "TEMPLATE.md"))).toBe(true);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("copies binaries byte for byte and substitutes only template text files", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const templatesDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "template-source-" });
    const gameRoot = yield* fs.makeTempDirectoryScoped({ prefix: "template-target-" });
    const templateDirectory = path.join(templatesDirectory, "blank");
    yield* fs.makeDirectory(path.join(templateDirectory, "godot/scenes"), { recursive: true });
    yield* fs.writeFileString(
      path.join(templateDirectory, "template.json"),
      JSON.stringify({ id: "blank", name: "Blank", description: "Test", dimension: "3d" }),
    );
    yield* fs.writeFileString(path.join(templateDirectory, "TEMPLATE.md"), "# {{GAME_NAME}}\n");
    yield* fs.writeFileString(
      path.join(templateDirectory, "godot/project.godot"),
      'config/name="{{GAME_NAME_ESCAPED}}"\n',
    );
    yield* fs.writeFileString(
      path.join(templateDirectory, "godot/scenes/main.tscn"),
      'script = "res://scripts/{{GAME_NAME_ESCAPED}}.gd"\n',
    );
    yield* fs.writeFileString(
      path.join(templateDirectory, "godot/notes.txt"),
      "{{GAME_NAME}} stays literal\n",
    );
    const binary = new Uint8Array([0, 1, 2, 255, 0, 154]);
    yield* fs.writeFile(path.join(templateDirectory, "godot/icon.bin"), binary);

    yield* copyTemplateIntoGame({
      templatesDirectory,
      templateId: "blank",
      gameRoot,
      gameName: 'My "Best" Game \\ 2',
    });

    expect(yield* fs.readFileString(path.join(gameRoot, "TEMPLATE.md"))).toBe(
      '# My "Best" Game \\ 2\n',
    );
    expect(yield* fs.readFileString(path.join(gameRoot, "godot/project.godot"))).toBe(
      'config/name="My \\"Best\\" Game \\\\ 2"\n',
    );
    expect(yield* fs.readFileString(path.join(gameRoot, "godot/scenes/main.tscn"))).toBe(
      'script = "res://scripts/My \\"Best\\" Game \\\\ 2.gd"\n',
    );
    expect(yield* fs.readFileString(path.join(gameRoot, "godot/notes.txt"))).toBe(
      "{{GAME_NAME}} stays literal\n",
    );
    expect(Array.from(yield* fs.readFile(path.join(gameRoot, "godot/icon.bin")))).toEqual(
      Array.from(binary),
    );
    expect(yield* fs.exists(path.join(gameRoot, "template.json"))).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);
