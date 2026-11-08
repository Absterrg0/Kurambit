import * as GameRunControl from "../../../game/GameRunControl.ts";
import * as GameProjectService from "../../../game/GameProjectService.ts";
import * as GameArt from "../../../game/art/GameArt.ts";
import * as GameAssetLibrary from "../../../game/GameAssetLibrary.ts";
import * as GameBlender from "../../../game/GameBlender.ts";
import * as GameBot from "../../../game/GameBot.ts";
import * as GameEngine from "../../../game/GameEngine.ts";
import * as GameExplore from "../../../game/GameExplore.ts";
import * as GameExport from "../../../game/GameExport.ts";
import * as GameSavedMediaService from "../../../game/GameSavedMediaService.ts";
import * as GameStage from "../../../game/GameStage.ts";
import * as GameStatusService from "../../../game/GameStatusService.ts";
import * as GameUnity from "../../../game/GameUnity.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ServerConfig from "../../../config.ts";
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { GameOperationError, ProviderInstanceId, ThreadId } from "@kurambit/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as GitRepositoryService from "../../../project/GitRepositoryService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as VcsStatusBroadcaster from "../../../vcs/VcsStatusBroadcaster.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as GameBuilds from "../../../game/GameBuilds.ts";
import * as GameToolchain from "../../../game/GameToolchain.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as PreviewManager from "../../../preview/Manager.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as PreviewBrowser from "../../../preview/PreviewBrowser.ts";

const noGameThread = ThreadId.make("thread-no-game");
const blenderThread = ThreadId.make("thread-blender-route");

const layerStubServices = Layer.mergeAll(
  Layer.mock(GameStatusService.GameStatusService)({}),
  Layer.mock(GameStage.GameStage)({}),
  Layer.mock(GameBlender.GameBlender)({}),
  Layer.mock(GameArt.GameArt)({}),
  Layer.mock(GameAssetLibrary.GameAssetLibrary)({}),
  Layer.mock(GameUnity.GameUnity)({ hold: () => (effect) => effect }),
  Layer.mock(GameEngine.GameEngine)({}),
  Layer.mock(GameExport.GameExport)({}),
  Layer.mock(GameSavedMediaService.GameSavedMediaService)({}),
  Layer.mock(GameExplore.GameExplore)({}),
  Layer.mock(GameBot.GameBot)({}),
  // Every thread here works in a three.js game on the library route, except one that is no
  // game and one whose person chose to make characters in Blender.
  Layer.mock(GameProjectService.GameProjectService)({
    resolve: (threadId) =>
      threadId === noGameThread
        ? Effect.fail(
            new GameOperationError({
              operation: "resolve-thread",
              path: threadId,
              reason: "project-not-found",
            }),
          )
        : Effect.succeed(threadId === blenderThread ? "/games/blender" : "/games/test"),
    read: (root) =>
      Effect.succeed({
        engine: { name: "three", version: "0" },
        ...(root === "/games/blender" ? { characters: "blender" } : {}),
      } as never),
  }),
  // This machine has a Blender.
  Layer.mock(GameToolchain.GameToolchain)({
    executable: () => Effect.succeed({ path: "/usr/bin/blender" } as never),
    revision: () => 0,
  }),
  Layer.mock(GameRunControl.GameRunControl)({}),
  Layer.mock(GameBuilds.GameBuilds)({}),
  Layer.mock(McpHttpServer.McpClientAuthenticator)({
    authenticate: () => Effect.succeed(undefined),
  }),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
  Layer.empty,
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(GitRepositoryService.GitRepositoryService)({}),
  Layer.empty,
  ServerSettings.layerTest({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(GitVcsDriver.GitVcsDriver)({}),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
  Layer.mock(PreviewManager.PreviewManager)({}),
  Layer.mock(ServerSecretStore.ServerSecretStore)({}),
  Layer.empty,
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ThreadSearch.ThreadSearch)({}),
);

const ToolsListPayload = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      tools: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          inputSchema: Schema.Struct({ type: Schema.optional(Schema.String) }),
          annotations: Schema.optional(
            Schema.Struct({
              readOnlyHint: Schema.optional(Schema.Boolean),
              destructiveHint: Schema.optional(Schema.Boolean),
              openWorldHint: Schema.optional(Schema.Boolean),
            }),
          ),
        }),
      ),
    }),
  }),
);
const decodeToolsListPayload = Schema.decodeUnknownEffect(ToolsListPayload);

const serveMcp = HttpRouter.serve(
  McpHttpServer.layer.pipe(Layer.provide(McpSessionRegistry.layer)),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provide(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed("environment-scratch" as never),
    }),
  ),
  Layer.provide(PreviewAutomationBroker.layer),
  Layer.provide(PreviewBrowser.layer),
  Layer.provide(layerStubServices),
  Layer.build,
);

const listTools = Effect.fn("test.listTools")(function* (threadId: ThreadId) {
  const credential = yield* McpSessionRegistry.issueActiveMcpCredential({
    threadId,
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  });
  expect(credential).toBeDefined();

  const httpClient = yield* HttpClient.HttpClient;
  const auth = credential!.config.authorizationHeader;
  const initResponse = yield* httpClient.post("/mcp", {
    headers: {
      accept: "application/json, text/event-stream",
      authorization: auth,
    },
    body: HttpBody.text(
      `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"scratch","version":"1.0.0"}}}`,
      "application/json",
    ),
  });
  expect(initResponse.status).toBe(200);
  const sessionId = initResponse.headers["mcp-session-id"];

  const listResponse = yield* httpClient.post("/mcp", {
    headers: {
      accept: "application/json, text/event-stream",
      authorization: auth,
      "mcp-protocol-version": "2025-06-18",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: HttpBody.text(
      `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
      "application/json",
    ),
  });
  const bodyText = yield* listResponse.text;
  const payload = yield* decodeToolsListPayload(bodyText.match(/\{.*\}/s)![0]);
  return payload.result.tools;
});

const layerTestRuntime = Layer.mergeAll(
  NodeHttpServer.layerTest,
  ServerConfig.layerTest(process.cwd(), { prefix: "kurambit-worktree-mcp-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  NodeServices.layer,
);

it.effect("production mcp layer lists worktree tools over http", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* serveMcp;
      const tools = yield* listTools(ThreadId.make("thread-scratch"));
      const toolNames = tools.map((tool) => tool.name);
      expect(toolNames).toContain("kurambit_worktree_handoff");
      expect(toolNames).toContain("kurambit_worktree_status");
      expect(toolNames).toContain("preview_status");
      expect(toolNames).toContain("delegate_task");
      // A three.js chat: its engine's tools, and the asked-for ones only through game_more.
      for (const name of ["game_status", "game_check", "game_export", "game_more"]) {
        expect(toolNames).toContain(name);
      }
      for (const name of ["game_import", "game_preview", "game_bot_run", "game_unity_edit"]) {
        expect(toolNames).not.toContain(name);
      }
      // The library route asks for the Blender tools through game_more; the Blender route lists them.
      for (const name of ["game_blender_look", "game_blender_code", "game_animate"]) {
        expect(toolNames).not.toContain(name);
      }
      const blender = yield* listTools(blenderThread);
      for (const name of ["game_blender_look", "game_blender_code", "game_animate"]) {
        expect(blender.map((tool) => tool.name)).toContain(name);
      }
      expect(blender.map((tool) => tool.name)).not.toContain("game_blender_paint");
      for (const tool of [
        tools.find((tool) => tool.name === "game_status"),
        blender.find((tool) => tool.name === "game_blender_look"),
      ]) {
        expect(tool?.annotations?.readOnlyHint).toBe(true);
      }
      for (const name of ["game_check", "game_export"]) {
        expect(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(false);
      }
      const noGame = (yield* listTools(noGameThread)).map((tool) => tool.name);
      expect(noGame.filter((name) => name.startsWith("game_"))).toEqual([]);

      const handoff = tools.find((tool) => tool.name === "kurambit_worktree_handoff");
      expect(handoff?.annotations?.readOnlyHint).toBe(false);
      expect(handoff?.annotations?.destructiveHint).toBe(true);
      expect(handoff?.annotations?.openWorldHint).toBe(true);
      const status = tools.find((tool) => tool.name === "kurambit_worktree_status");
      expect(status?.annotations?.readOnlyHint).toBe(true);
      expect(status?.annotations?.destructiveHint).toBe(false);

      // MCP requires every tool input schema to be a top-level object schema.
      // A non-object schema (e.g. the anyOf produced by an empty
      // Schema.Struct({})) makes clients reject the entire server.
      for (const tool of tools) {
        expect(tool.inputSchema.type, `inputSchema.type of ${tool.name}`).toBe("object");
      }
    }),
  ).pipe(Effect.provide(layerTestRuntime)),
);
