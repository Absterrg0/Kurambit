// @effect-diagnostics nodeBuiltinImport:off -- Exercise executable resolution and MCP failures against files and real subprocesses.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";
import {
  EnvironmentId,
  GameOperationFailure,
  ProviderInstanceId,
  ThreadId,
  type GameManifest,
} from "@t3tools/contracts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../mcp/McpToolAccess.testkit.ts";
import { toolkitRegistration } from "../mcp/McpHttpServer.ts";
import * as GameHandlers from "../mcp/toolkits/game/handlers.ts";
import { GameToolkit } from "../mcp/toolkits/game/tools.ts";
import * as GameService from "./GameService.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GamePreview from "./GamePreview.ts";
import {
  designApprovalTestLayer,
  previewBrowserTestLayer,
  qualificationTestLayer,
  visualJudgeTestLayer,
} from "./gameTestLayers.ts";

const threadId = ThreadId.make("tool-failures");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("tool-failures"),
  requestNamespace: "tool-failures",
  thread: {
    threadId,
    providerSessionId: "tool-failures",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "game-tool-failures", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "game-tool-failures", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const manifest: GameManifest = {
  schemaVersion: 1,
  name: "Tool failures",
  brief: "",
  artDirection: "",
  engine: { name: "godot", version: "4.7.2" },
  godotProject: "godot",
  assets: [],
};
const decodeFailure = Schema.decodeUnknownSync(Schema.fromJsonString(GameOperationFailure));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const withFixture = <A, E, R>(
  tool: "blender" | "godot",
  run: (root: string, executable: string) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tool-failures-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      vi.stubEnv("XDG_DATA_HOME", root);
      const executable = NodePath.join(root, tool);
      const tools = GameToolchain.layer.pipe(
        Layer.provideMerge(GameProcesses.layer),
        Layer.provide(
          ServerSettings.layerTest({
            gameBlenderPath: NodePath.join(root, "blender"),
            gameGodotPath: NodePath.join(root, "godot"),
          }),
        ),
      );
      const services = GameService.layer.pipe(
        Layer.provideMerge(tools),
        Layer.provide(
          Layer.mock(GameProjectService.GameProjectService)({
            resolve: () => Effect.succeed(root),
            read: () => Effect.succeed(manifest),
            inventory: () =>
              Effect.succeed({
                manifest,
                design: null,
                designPath: null,
                briefPath: null,
                assets: [],
                scenes: [],
                builds: [],
                viewport: { width: 1152, height: 648 },
              }),
          }),
        ),
        Layer.provide(Layer.mock(GamePreview.GamePreview)({ url: () => null })),
        Layer.provide(previewBrowserTestLayer()),
        Layer.provideMerge(qualificationTestLayer(NodePath.join(root, ".test-state"))),
        Layer.provideMerge(visualJudgeTestLayer(NodePath.join(root, ".test-state"))),
        Layer.provideMerge(designApprovalTestLayer(NodePath.join(root, ".test-state"))),
      );
      return yield* run(root, executable).pipe(
        Effect.provide(
          toolkitRegistration(GameToolkit, GameHandlers.layer).pipe(
            Layer.provideMerge(McpServer.McpServer.layer),
            Layer.provideMerge(services),
            Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
          ),
        ),
      );
    }),
  );

const callFailure = (tool: "blender" | "godot", templates = false) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: templates
          ? "game_export"
          : tool === "blender"
            ? "game_blender_run"
            : "game_godot_import",
        arguments: templates
          ? { target: "Web" }
          : tool === "blender"
            ? { id: "cube", script: "import bpy", thumbnail: false }
            : {},
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(true);
    const content = result.content[0];
    if (content?.type !== "text") return yield* Effect.die("Expected an MCP text failure.");
    const failure = decodeFailure(content.text);
    expect(content.text).not.toContain('"cause"');
    return failure;
  });

const cases = (["blender", "godot"] as const).flatMap((tool) =>
  (
    [
      "missing",
      "not executable",
      "directory",
      "wrong version",
      "missing interpreter",
      "failed version check",
      "disconnected",
    ] as const
  ).map((problem) => ({ tool, problem })),
);
it.live.each(cases)(
  "$tool: $problem reports the attempted path and recovery in MCP and panel state",
  ({ tool, problem }) =>
    withFixture(tool, (root, executable) =>
      Effect.gen(function* () {
        if (problem === "directory") yield* Effect.promise(() => NodeFSP.mkdir(executable));
        else if (problem !== "missing") {
          const version =
            tool === "blender"
              ? problem === "wrong version"
                ? "Blender 4.1.0"
                : "Blender 4.5.14"
              : problem === "wrong version"
                ? "4.6.2.stable.official"
                : "4.7.2.stable.official";
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              executable,
              problem === "missing interpreter"
                ? `#!${NodePath.join(root, "missing-shell")}\n`
                : `#!/bin/sh\nprintf '%s\\n' '${version}'\nexit ${problem === "failed version check" ? 1 : 0}\n`,
              { mode: problem === "not executable" ? 0o644 : 0o755 },
            ),
          );
          if (problem === "disconnected") {
            const tools = yield* GameToolchain.GameToolchain;
            expect((yield* tools.executable(tool)).path).toBe(executable);
            yield* Effect.promise(() => NodeFSP.rm(executable));
          }
        }
        const failure = yield* callFailure(tool);
        expect(failure.reason).toBe(
          problem === "wrong version"
            ? "wrong-version"
            : problem === "failed version check"
              ? "command-failed"
              : "tool-missing",
        );
        expect(failure.path).toBe(executable);
        expect(failure.message.toLowerCase()).toContain(tool);
        expect(failure.message).toContain(executable);
        expect(failure.message).toContain("Settings > General > Game tools");
        expect(failure.message).toContain("Install tools");
        const game = yield* GameService.GameService;
        const status = (yield* game.status(threadId)).toolchain.tools.find(
          (entry) => entry.tool === tool,
        );
        expect(status).toMatchObject({
          path: executable,
          ready: false,
          verified: false,
          message: failure.message,
        });
      }),
    ),
);

it.live.each(["absent", "incomplete"] as const)(
  "Godot %s export templates report the template path, executable and install action",
  (problem) =>
    withFixture("godot", (root, executable) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          NodeFSP.writeFile(executable, "#!/bin/sh\nprintf '4.7.2.stable.official\\n'\n", {
            mode: 0o755,
          }),
        );
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "._sc_"), ""));
        const templates = NodePath.join(root, "editor_data/export_templates/4.7.2.stable");
        if (problem === "incomplete")
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(templates, { recursive: true });
            await NodeFSP.writeFile(NodePath.join(templates, "version.txt"), "4.7.2.stable");
          });
        const failure = yield* callFailure("godot", true);
        expect(failure.reason).toBe("templates-missing");
        expect(failure.path).toBe(templates);
        for (const text of [
          "Godot",
          executable,
          templates,
          "Install tools",
          "Settings > General > Game tools",
        ])
          expect(failure.message).toContain(text);
        const game = yield* GameService.GameService;
        const status = (yield* game.status(threadId)).toolchain.tools.find(
          (entry) => entry.tool === "godot",
        );
        expect(status).toMatchObject({ path: executable, ready: false, verified: false });
        for (const text of ["Godot", executable, templates, "Install tools"])
          expect(status?.message).toContain(text);
      }),
    ),
);

it.live(
  "Install tools repairs a managed Godot install whose version file outlived its templates",
  () =>
    withFixture("godot", (root) =>
      Effect.gen(function* () {
        const managed = NodePath.join(root, "game-studio/tools");
        const blender = NodePath.join(managed, `blender-${GameToolchain.BLENDER_VERSION}`);
        const godot = NodePath.join(managed, `godot-${GameToolchain.GODOT_VERSION}`);
        const templates = NodePath.join(godot, "editor_data/export_templates/4.7.2.stable");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(blender, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(blender, "blender"), "#!/bin/sh\n", {
            mode: 0o755,
          });
          await NodeFSP.mkdir(templates, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(templates, "version.txt"), "4.7.2.stable");
          await NodeFSP.writeFile(
            NodePath.join(godot, "Godot_v4.7.2-stable_linux.x86_64"),
            "#!/bin/sh\n",
            { mode: 0o755 },
          );
        });
        const download = vi.fn(() =>
          Promise.reject(new Error("Fixture stops before downloading.")),
        );
        vi.stubGlobal("fetch", download);
        const tools = yield* GameToolchain.GameToolchain;
        const failure = yield* tools.install.pipe(Effect.flip);
        expect(failure.reason).toBe("download");
        expect(download).toHaveBeenCalledExactlyOnceWith(
          "https://github.com/godotengine/godot/releases/download/4.7.2-stable/SHA512-SUMS.txt",
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect((yield* tools.status).installing).toBe(false);
      }),
    ),
);
