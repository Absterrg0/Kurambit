// @effect-diagnostics nodeBuiltinImport:off -- Root-only live probe: real Godot, templates and headless Chrome against a private copy.
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameQualification from "./GameQualification.ts";
import { approvalRecordFile } from "./GameDesignApproval.ts";
import * as GameService from "./GameService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  admissionTestLayer,
  designApprovalTestLayer,
  previewBrowserTestLayer,
  projectTestLayer,
  qualificationTestLayer,
  roundStoreTestLayer,
} from "./gameTestLayers.ts";

const enabled = process.env.GAME_STUDIO_APPROVED_VERIFY_LIVE === "1";
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
const templatesInstalled = (() => {
  const dataRoot = process.env.XDG_DATA_HOME ?? NodePath.join(NodeOS.homedir(), ".local/share");
  const roots = [
    NodePath.join(dataRoot, "godot/export_templates"),
    NodePath.join(
      GameToolchain.toolsDirectory(),
      `godot-${GameToolchain.GODOT_VERSION}`,
      "editor_data/export_templates",
    ),
  ];
  try {
    for (const root of roots) {
      if (!NodeFS.existsSync(root)) continue;
      for (const version of NodeFS.readdirSync(root))
        for (const name of ["web_nothreads_release.zip", "web_nothreads_debug.zip"])
          if (
            NodeFS.existsSync(NodePath.join(root, version, version, name)) ||
            NodeFS.existsSync(NodePath.join(root, version, name))
          )
            return true;
    }
  } catch {
    // Unreadable template roots count as missing.
  }
  return false;
})();

// Inputs are copied before any service operates; an installed home is never opened writeable.
const SOURCE_GAME = process.env.GAME_STUDIO_APPROVED_VERIFY_GAME ?? "";
const REAL_STATE = process.env.GAME_STUDIO_APPROVED_VERIFY_STATE ?? "";
const RESULT_PATH = process.env.GAME_STUDIO_APPROVED_VERIFY_RESULT;

const available =
  enabled &&
  SOURCE_GAME !== "" &&
  REAL_STATE !== "" &&
  NodeFS.existsSync(godotExecutable) &&
  browserExecutable !== null &&
  templatesInstalled;

it.live.skipIf(!available)(
  "one-call verify refreshes the stale state exam on the retained tinygame copy",
  () =>
    Effect.gen(function* () {
      const base = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(process.env.TMPDIR ?? "/tmp", "approved-verify-")),
      );
      const root = NodePath.join(base, "game");
      const stateDir = NodePath.join(base, "state");
      yield* Effect.promise(() => NodeFSP.cp(SOURCE_GAME, root, { recursive: true }));
      // Only the root binding changes; approval identity and promises are preserved.
      yield* Effect.promise(async () => {
        const realGame = await NodeFSP.realpath(SOURCE_GAME);
        const newGame = await NodeFSP.realpath(root);
        for (const extension of [".json", ".intent.json"] as const) {
          const from =
            extension === ".json"
              ? approvalRecordFile(REAL_STATE, realGame)
              : NodePath.join(
                  NodePath.dirname(approvalRecordFile(REAL_STATE, realGame)),
                  `${NodePath.basename(approvalRecordFile(REAL_STATE, realGame), ".json")}.intent.json`,
                );
          const text = await NodeFSP.readFile(from, "utf8");
          const parsed = JSON.parse(text) as Record<string, unknown>;
          const to =
            extension === ".json"
              ? approvalRecordFile(stateDir, newGame)
              : NodePath.join(
                  NodePath.dirname(approvalRecordFile(stateDir, newGame)),
                  `${NodePath.basename(approvalRecordFile(stateDir, newGame), ".json")}.intent.json`,
                );
          await NodeFSP.mkdir(NodePath.dirname(to), { recursive: true });
          await NodeFSP.writeFile(to, JSON.stringify({ ...parsed, game: newGame }, null, 2));
        }
        const qualificationRecord = JSON.parse(
          await NodeFSP.readFile(
            GameQualification.qualificationRecordPath(REAL_STATE, realGame),
            "utf8",
          ),
        ) as Record<string, unknown>;
        const target = GameQualification.qualificationRecordPath(stateDir, newGame);
        await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
        await NodeFSP.writeFile(target, JSON.stringify({ ...qualificationRecord, game: newGame }));
      });
      const dependencies = GameService.layer.pipe(
        Layer.provideMerge(GameProjectService.layer),
        Layer.provideMerge(GameOperations.layer),
        Layer.provideMerge(GameToolchain.layer),
        Layer.provideMerge(GamePreview.layer),
        Layer.provideMerge(GameProcesses.layer),
        Layer.provide(projectTestLayer()),
        Layer.provide(previewBrowserTestLayer(browserExecutable!)),
        Layer.provideMerge(qualificationTestLayer(stateDir)),
        Layer.provideMerge(designApprovalTestLayer(stateDir)),
        Layer.provideMerge(roundStoreTestLayer(stateDir)),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provideMerge(admissionTestLayer),
        Layer.provide(NodeServices.layer),
      );
      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const projects = yield* GameProjectService.GameProjectService;
            const game = yield* GameService.GameService;
            const registered = yield* projects.open({
              path: root,
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-6.1-sol",
              },
            });
            yield* Effect.addFinalizer(() =>
              game.action(registered.threadId, "stop").pipe(Effect.ignore),
            );
            const before = (yield* game.status(registered.threadId, { checkSources: true }))
              .qualification;
            expect(before.stages.find((stage) => stage.stage === "state")?.status).toBe("stale");
            expect(before.mechanicsQualified).toBe(false);
            const approvalBefore = yield* Effect.promise(() =>
              NodeFSP.readFile(approvalRecordFile(stateDir, root), "utf8"),
            );
            const result = yield* game.verify(registered.threadId, {
              steps: [
                { press: "Enter" },
                { hold: "ArrowRight", holdMs: 1100 },
                { keys: ["ArrowRight", "Space"], holdMs: 400 },
                { hold: "ArrowRight", holdMs: 2500 },
              ],
              bootTimeoutMs: 45_000,
            });
            expect(result.success, result.message).toBe(true);
            expect(result.completed).toEqual(["check", "test", "state", "export", "playtest"]);
            expect(result.scenarios?.summary.passed).toBe(true);
            const read = (yield* game.status(registered.threadId, { checkSources: true }))
              .qualification;
            expect(read.stages.find((stage) => stage.stage === "state")?.status).toBe("passed");
            expect(read.mechanicsQualified).toBe(true);
            expect(read.completion).toBe("complete");
            expect(read.sourceId).toBe(before.sourceId);
            expect(
              yield* Effect.promise(() =>
                NodeFSP.readFile(approvalRecordFile(stateDir, root), "utf8"),
              ),
            ).toBe(approvalBefore);
            const capture =
              process.env.GAME_STUDIO_APPROVED_VERIFY_CAPTURE === "1"
                ? yield* game.nativeCapture(registered.threadId, {
                    scenarioId: "full-run",
                    fps: process.env.GAME_STUDIO_APPROVED_VERIFY_CAPTURE_FPS === "60" ? 60 : 30,
                  })
                : null;
            if (capture !== null) expect(capture.sourceId).toBe(read.sourceId);
            // A caller can retain the probe output while all source inputs stay read-only.
            const at = yield* DateTime.now;
            if (RESULT_PATH !== undefined)
              yield* Effect.promise(() =>
                NodeFSP.writeFile(
                  RESULT_PATH,
                  JSON.stringify(
                    {
                      at: DateTime.formatIso(at),
                      sourceGame: SOURCE_GAME,
                      privateCopy: root,
                      privateStateDir: stateDir,
                      beforeQualification: before,
                      nativeCapture: capture,
                      buildId: result.build?.buildId ?? null,
                      completed: result.completed,
                      scenarios: result.scenarios?.summary ?? null,
                      qualification: read,
                    },
                    null,
                    2,
                  ),
                ),
              );
            yield* Effect.log(`approved verify live pass: ${result.message}`);
          }).pipe(Effect.provide(dependencies)),
        );
      } finally {
        if (process.env.GAME_STUDIO_KEEP_TEST !== "1")
          yield* Effect.promise(() => NodeFSP.rm(base, { recursive: true, force: true }));
      }
    }),
  600_000,
);
