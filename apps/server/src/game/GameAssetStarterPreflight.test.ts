// @effect-diagnostics nodeBuiltinImport:off -- Focused red-green for shipped starter SVG preflight.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { preflightImportSafety, walkGameFiles } from "./gameAssetInventory.ts";
import { templateDirectoryCandidates } from "./templates.ts";

const resolveTemplatesRootForTest = async (): Promise<string> => {
  const [bundled, monorepo] = templateDirectoryCandidates(import.meta.dirname, NodePath.join);
  for (const candidate of [bundled, monorepo]) {
    try {
      const stat = await NodeFSP.lstat(candidate);
      if (stat.isDirectory() && !stat.isSymbolicLink()) return candidate;
    } catch {
      continue;
    }
  }
  throw new Error("starter templates missing for test");
};

const writeGameWithIcon = async (root: string, iconBytes: Uint8Array | string): Promise<void> => {
  await NodeFSP.mkdir(NodePath.join(root, "godot"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(root, "godot/project.godot"), "[application]\n");
  await NodeFSP.writeFile(NodePath.join(root, "godot/icon.svg"), iconBytes);
};

it.effect("shipped starter icons pass preflight by byte-exact match", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const templatesRoot = yield* Effect.promise(() => resolveTemplatesRootForTest());
      const platformer = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(templatesRoot, "2d-platformer/godot/icon.svg")),
      );
      const explorer = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(templatesRoot, "3d-explorer/godot/icon.svg")),
      );
      const screen = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(templatesRoot, "2d-screen/godot/icon.svg")),
      );
      // Distinct bytes: platformer and explorer share the 595-byte icon, screen is 919 bytes.
      expect(platformer.length).toBe(595);
      expect(explorer.length).toBe(595);
      expect(screen.length).toBe(919);
      expect(platformer.equals(explorer)).toBe(true);
      expect(platformer.equals(screen)).toBe(false);
      for (const [name, bytes] of [
        ["2d-platformer", platformer],
        ["3d-explorer", explorer],
        ["2d-screen", screen],
      ] as const) {
        const parent = yield* Effect.acquireRelease(
          Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starter-svg-"))),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        const root = NodePath.join(parent, "game");
        yield* Effect.promise(() => writeGameWithIcon(root, bytes));
        const before = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(root, "godot/icon.svg")),
        );
        const scan = yield* Effect.promise(() => walkGameFiles(root));
        const result = yield* Effect.promise(() =>
          preflightImportSafety({ root, godotProject: "godot", scan }),
        );
        expect(result.ok, name).toBe(true);
        const after = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(root, "godot/icon.svg")),
        );
        expect(after, name).toEqual(before);
      }
    }),
  ),
);

it.effect("edited, malicious and overlarge SVGs refuse without mutation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const templatesRoot = yield* Effect.promise(() => resolveTemplatesRootForTest());
      const shipped = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(templatesRoot, "2d-platformer/godot/icon.svg")),
      );
      const cases: ReadonlyArray<{ readonly name: string; readonly bytes: Buffer }> = [
        {
          name: "edited-same-filename",
          bytes: Buffer.concat([shipped, Buffer.from("<!--edited-->")]),
        },
        {
          name: "malicious-xxe",
          bytes: Buffer.from(
            `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg width="128" height="128" xmlns="http://www.w3.org/2000/svg"><text>&xxe;</text></svg>`,
          ),
        },
        {
          name: "malicious-script",
          bytes: Buffer.from(
            `<svg width="128" height="128" xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="128" height="128" fill="red"/></svg>`,
          ),
        },
        {
          name: "overlarge-svg",
          bytes: Buffer.concat([
            Buffer.from(`<svg width="128" height="128" xmlns="http://www.w3.org/2000/svg">`),
            Buffer.alloc(9000, 65),
            Buffer.from(`</svg>`),
          ]),
        },
      ];
      for (const entry of cases) {
        const parent = yield* Effect.acquireRelease(
          Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starter-svg-bad-"))),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        const root = NodePath.join(parent, "game");
        yield* Effect.promise(() => writeGameWithIcon(root, entry.bytes));
        const before = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(root, "godot/icon.svg")),
        );
        const scan = yield* Effect.promise(() => walkGameFiles(root));
        // Preflight itself never spawns a process or import; ok:false is the
        // refusal GameService uses to skip `--editor --import` entirely.
        const result = yield* Effect.promise(() =>
          preflightImportSafety({
            root,
            godotProject: "godot",
            scan,
          }),
        );
        expect(result.ok, entry.name).toBe(false);
        expect(result.reason, entry.name).toContain(".svg");
        const after = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(root, "godot/icon.svg")),
        );
        expect(after, entry.name).toEqual(before);
      }
    }),
  ),
);
