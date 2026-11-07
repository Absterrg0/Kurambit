// @effect-diagnostics nodeBuiltinImport:off -- Writes archives and reads the extracted home on disk.
import { afterEach, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import JSZip from "jszip";
import { extractTemplates } from "./GameTemplates.ts";

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(
    scratch.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
});

const setup = async (files: Record<string, string>) => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kurambit-templates-"));
  scratch.push(dir);
  const zip = new JSZip();
  for (const [name, text] of Object.entries(files)) zip.file(name, text, { createFolders: false });
  const archive = NodePath.join(dir, "templates.zip");
  await NodeFSP.writeFile(archive, await zip.generateAsync({ type: "uint8array" }));
  const baseDir = NodePath.join(dir, "home");
  return { dir, archive, baseDir };
};

it.effect("a member that climbs out of the folder fails the extraction and writes nothing", () =>
  Effect.gen(function* () {
    const { dir, archive, baseDir } = yield* Effect.promise(() =>
      setup({ "bot-kit/kit.mjs": "ok", "../../escaped.txt": "no" }),
    );
    const exit = yield* Effect.exit(extractTemplates({ archive, baseDir, version: "1.0.0" }));
    expect(Exit.isFailure(exit)).toBe(true);
    const escaped = yield* Effect.promise(() =>
      Promise.all(
        [NodePath.join(dir, "escaped.txt"), NodePath.join(baseDir, "escaped.txt")].map((path) =>
          NodeFSP.stat(path).then(
            () => true,
            () => false,
          ),
        ),
      ),
    );
    expect(escaped).toEqual([false, false]);
    // No half-made folder is left to be taken for a complete one.
    const left = yield* Effect.promise(() =>
      NodeFSP.readdir(NodePath.join(baseDir, "templates")).catch(() => []),
    );
    expect(left).toEqual([]);
  }),
);

it.effect("a new app version extracts afresh and drops the old folder", () =>
  Effect.gen(function* () {
    const { archive, baseDir } = yield* Effect.promise(() =>
      setup({ "bot-kit/kit.mjs": "kit", "studio/AGENTS.md": "skills" }),
    );
    const first = yield* extractTemplates({ archive, baseDir, version: "1.0.0" });
    expect(
      yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(first, "bot-kit/kit.mjs"), "utf8"),
      ),
    ).toBe("kit");
    // The same version again reuses the folder it made.
    expect(yield* extractTemplates({ archive, baseDir, version: "1.0.0" })).toBe(first);
    const second = yield* extractTemplates({ archive, baseDir, version: "1.1.0" });
    expect(second).not.toBe(first);
    expect(
      yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(second, "studio/AGENTS.md"), "utf8"),
      ),
    ).toBe("skills");
    const folders = yield* Effect.promise(() =>
      NodeFSP.readdir(NodePath.join(baseDir, "templates")),
    );
    expect(folders).toEqual([NodePath.basename(second)]);
  }),
);
