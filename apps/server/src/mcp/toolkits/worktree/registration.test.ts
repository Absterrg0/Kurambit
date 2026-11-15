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
import * as GamePlays from "../../../game/GamePlays.ts";
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
  // Every thread here works in a three.js game made in code with the library off, except one that is no
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
        library: false,
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
  Layer.mock(GamePlays.GamePlays)({}),
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

/** One MCP request as the thread's agent, after an initialize: the reply body's JSON text. */
const request = Effect.fn("test.request")(function* (
  threadId: ThreadId,
  method: string,
  params: Record<string, unknown>,
) {
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

  const response = yield* httpClient.post("/mcp", {
    headers: {
      accept: "application/json, text/event-stream",
      authorization: auth,
      "mcp-protocol-version": "2025-06-18",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: HttpBody.text(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }),
      "application/json",
    ),
  });
  const bodyText = yield* response.text;
  return bodyText.match(/\{.*\}/s)![0];
});

const listTools = Effect.fn("test.listTools")(function* (threadId: ThreadId) {
  const payload = yield* decodeToolsListPayload(yield* request(threadId, "tools/list", {}));
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
      // A three.js chat lists its game tools from its first turn; game_blender only where the
      // person's model choice makes models in Blender.
      const five = ["game_assets", "game_builds", "game_check", "game_keep_going", "game_play"];
      expect(toolNames.filter((name) => name.startsWith("game_")).toSorted()).toEqual(five);
      const blender = yield* listTools(blenderThread);
      expect(
        blender
          .map((tool) => tool.name)
          .filter((name) => name.startsWith("game_"))
          .toSorted(),
      ).toEqual([...five, "game_blender"].toSorted());
      const noGame = (yield* listTools(noGameThread)).map((tool) => tool.name);
      expect(noGame.filter((name) => name.startsWith("game_"))).toEqual([]);

      // A retired game tool is never listed, and a game thread that still calls it by name hears
      // where its work went; outside a game it is not found.
      expect(toolNames).not.toContain("game_preview");
      const retired = yield* request(ThreadId.make("thread-scratch"), "tools/call", {
        name: "game_preview",
        arguments: {},
      });
      expect(retired).toContain("game_play op preview");
      const outside = yield* request(noGameThread, "tools/call", {
        name: "game_preview",
        arguments: {},
      });
      expect(outside).toMatch(/not found/i);

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
