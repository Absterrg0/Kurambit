// @effect-diagnostics nodeBuiltinImport:off -- Tests copy real template files with real filesystem I/O.
import { it, expect } from "@effect/vitest";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { GAME_TEMPLATES, GameTemplate, parseGameScenario } from "@t3tools/contracts";
import {
  copyTemplateIntoGame,
  isTemplateTextFile,
  resolveTemplatesDirectory,
  substituteGameName,
} from "./templates.ts";
import { parseProjectInputActions, scenarioActionIssues } from "./gameScenarios.ts";

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

it.effect("ships a Windows Desktop export preset in every starter", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const templatesDirectory = yield* resolveTemplatesDirectory();
    for (const template of GAME_TEMPLATES) {
      const presets = yield* fs.readFileString(
        path.join(templatesDirectory, template.id, "godot/export_presets.cfg"),
      );
      expect(presets).toContain('platform="Windows Desktop"');
      expect(presets).toContain('export_path="../builds/windows/game.exe"');
      expect(presets).toContain("binary_format/embed_pck=true");
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ships a winning and a losing route whose actions exist in each template", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const templatesDirectory = yield* resolveTemplatesDirectory();
    for (const template of ["2d-platformer", "3d-explorer", "2d-screen"] as const) {
      const root = path.join(templatesDirectory, template, "godot");
      const actions = parseProjectInputActions(
        yield* fs.readFileString(path.join(root, "project.godot")),
      );
      for (const name of ["full-run", "lose-run"]) {
        const parsed = parseGameScenario(
          JSON.parse(yield* fs.readFileString(path.join(root, `tests/scenarios/${name}.json`))),
        );
        expect(parsed.ok, `${template}/${name}: ${parsed.ok ? "" : parsed.issues.join(" ")}`).toBe(
          true,
        );
        if (!parsed.ok) continue;
        expect(
          parsed.scenario.steps.some((step) => "press" in step && step.press === "ui_accept"),
          `${template}/${name} starts at the menu`,
        ).toBe(true);
        expect(
          parsed.scenario.steps.some((step) => "hold" in step),
          `${template}/${name} uses normal input`,
        ).toBe(true);
        expect(scenarioActionIssues(parsed.scenario, actions)).toEqual([]);
      }
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("states the verification authority so small games can adapt fixtures", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const templatesDirectory = yield* resolveTemplatesDirectory();
    for (const template of ["2d-platformer", "3d-explorer", "2d-screen"] as const) {
      const document = yield* fs.readFileString(
        path.join(templatesDirectory, template, "TEMPLATE.md"),
      );
      const flat = document.replace(/\s+/g, " ");
      // The old wording called the shipped routes server-owned and demanded they
      // be preserved; the server owns the policy and the approved exam instead.
      expect(flat, `${template} names no server-owned route`).not.toContain(
        "server-owned completion route",
      );
      expect(flat, `${template} names no server-owned route`).not.toContain("server-owned route");
      expect(flat).toContain("game-owned route data");
      expect(flat).toContain("canonical `res://tests/smoke_test.gd` suite path");
      expect(flat).toContain("approved DESIGN.md observations");
      expect(flat).toContain("Adapt the routes to this game's scope");
      expect(flat).toContain("keep meaningful coverage of everything retained and promised");
      expect(flat).toContain("Never weaken a route or lower a threshold to make green");
      expect(flat).toContain("tie every change to DESIGN.md acceptance");
      expect(flat).toContain("reference implementation");
      const harness = yield* fs.readFileString(
        path.join(templatesDirectory, template, "godot/tests/smoke_harness.gd"),
      );
      const harnessFlat = harness.replace(/#/g, "").replace(/\s+/g, " ");
      expect(harnessFlat).toContain("Reference-");
      expect(harnessFlat).toContain("adapts this file to its DESIGN.md scope");
      expect(harnessFlat).toContain("The server only requires that the canonical suite exits 0");
    }
    // Example counts are labelled as the reference game's, not as requirements.
    for (const template of ["2d-platformer", "3d-explorer", "2d-screen"] as const) {
      const document = yield* fs.readFileString(
        path.join(templatesDirectory, template, "TEMPLATE.md"),
      );
      expect(document).toContain("not requirements");
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
