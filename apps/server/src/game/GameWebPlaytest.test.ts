// @effect-diagnostics nodeBuiltinImport:off -- Verified against the installed toolchain and the managed browser checkout.
import { it, expect } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as GamePreview from "./GamePreview.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GameWebPlaytest from "./GameWebPlaytest.ts";

const workspaceRoot = (() => {
  let directory = process.cwd();
  for (
    let hops = 0;
    hops < 5 && !NodeFS.existsSync(NodePath.join(directory, "apps/server/package.json"));
    hops++
  ) {
    directory = NodePath.resolve(directory, "..");
  }
  return directory;
})();
const godotExecutable = NodePath.join(
  GameToolchain.toolsDirectory(),
  `godot-${GameToolchain.GODOT_VERSION}/Godot_v${GameToolchain.GODOT_VERSION}-stable_linux.x86_64`,
);
// Mirror PreviewBrowser's install layout (<baseDir>/tools/chrome-headless-shell/<platform>/<version>/…);
// the test picks whatever release is installed on this machine rather than re-decoding the release catalog.
const browserExecutable = (() => {
  const installRoot = NodePath.join(
    NodePath.join(workspaceRoot, ".t3"),
    "tools",
    "chrome-headless-shell",
  );
  if (!NodeFS.existsSync(installRoot)) return null;
  for (const platform of NodeFS.readdirSync(installRoot)) {
    const platformPath = NodePath.join(installRoot, platform);
    for (const version of NodeFS.readdirSync(platformPath)) {
      for (const name of ["chrome-headless-shell", "chrome-headless-shell.exe"]) {
        const candidate = NodePath.join(platformPath, version, name);
        if (NodeFS.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
})();
const available = NodeFS.existsSync(godotExecutable) && browserExecutable !== null;
const sourceBuild = NodePath.join(
  workspaceRoot,
  ".t3",
  "e2e-games",
  "island-artifacts",
  "builds",
  "web",
);
const evidenceDirectory = "/home/abstergo/Programming/Projects/game-studio-orch/round7-evidence";

it.live.skipIf(!available)(
  "playtests the exported island web build in headless Chrome",
  () =>
    Effect.gen(function* () {
      const scratch = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-playtest-")),
      );
      try {
        const web = NodePath.join(scratch, "builds", "web");
        yield* Effect.promise(() => NodeFSP.cp(sourceBuild, web, { recursive: true }));
        const preview = yield* GamePreview.GamePreview;
        const url = yield* Effect.acquireRelease(preview.open(scratch), () =>
          preview.stop(scratch),
        );
        const result = yield* GameWebPlaytest.playtest({
          executable: browserExecutable!,
          url,
          profileDirectory: NodePath.join(scratch, "browser-profile"),
          width: 1280,
          height: 720,
          bootTimeoutMs: 30_000,
          steps: [{ key: "ArrowUp", holdMs: 1500 }],
        });
        yield* Effect.log(result.message);
        yield* Effect.log(
          `${result.booted}, bootMs ${String(result.bootMs)}, console ${result.consoleMessages.length}`,
        );
        expect(result.booted).toBe(true);
        expect(result.bootMs).not.toBeNull();
        expect(result.screenshots.map((shot) => shot.label)).toEqual(["booted", "after-steps"]);
        expect(result.screenshots.every((shot) => shot.width > 0 && shot.height > 0)).toBe(true);
        yield* Effect.promise(() => NodeFSP.mkdir(evidenceDirectory, { recursive: true }));
        for (const shot of result.screenshots) {
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(evidenceDirectory, `task7b-${shot.label}.png`),
              Buffer.from(shot.data, "base64"),
            ),
          );
        }
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(scratch, { recursive: true, force: true }));
      }
    }).pipe(Effect.provide(GamePreview.layer)),
  180_000,
);
