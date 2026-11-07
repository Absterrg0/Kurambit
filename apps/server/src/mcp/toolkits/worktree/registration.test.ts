import * as GameRunControl from "../../../game/GameRunControl.ts";
import * as GameService from "../../../game/GameService.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ServerConfig from "../../../config.ts";
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ThreadId } from "@kurambit/contracts";
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
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as PreviewManager from "../../../preview/Manager.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as PreviewBrowser from "../../../preview/PreviewBrowser.ts";

const roleThread = ThreadId.make("thread-role");
const unreadableThread = ThreadId.make("thread-unreadable");

const layerStubServices = Layer.mergeAll(
  Layer.mock(GameService.GameService)({}),
  Layer.mock(GameRunControl.GameRunControl)({}),
  Layer.mock(GameBuilds.GameBuilds)({}),
  Layer.mock(McpHttpServer.McpClientAuthenticator)({
    authenticate: () => Effect.succeed(undefined),
  }),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
  Layer.empty,
  Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadRecords: (threadId) =>
      threadId === unreadableThread
        ? Effect.fail(
            new Orchestrator.OrchestratorProjectionError({ threadId, cause: "unreadable" }),
          )
        : // Only the thread record is read; the rest of a real one is beside the point here.
          Effect.succeed({
            thread: threadId === roleThread ? { launchedBy: "game_run" } : {},
          } as never),
  }),
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
      for (const name of [
        "game_status",
        "game_check",
        "game_import",
        "game_export",
        "game_preview",
        "game_stop",
      ]) {
        expect(toolNames).toContain(name);
      }
      for (const name of ["game_status", "game_bot_view", "game_blender_look"]) {
        expect(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(true);
      }
      for (const name of ["game_check", "game_export", "game_preview", "game_stop"]) {
        expect(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(false);
      }

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

// Blind judging rests on this: a sample or comparator that could list threads,
// worktrees or projects could tell which build is which.
it.effect("a production run's role thread gets no thread, worktree or project tools", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* serveMcp;
      const hidden = [
        "kurambit_thread_launch",
        "kurambit_thread_search",
        "kurambit_worktree_status",
        "kurambit_worktree_handoff",
        "kurambit_project_list",
        "delegate_task",
      ];
      const names = (threadId: ThreadId) =>
        Effect.map(listTools(threadId), (tools) => tools.map((tool) => tool.name));

      const creator = yield* names(ThreadId.make("thread-creator"));
      for (const name of hidden) expect(creator).toContain(name);

      const role = yield* names(roleThread);
      for (const name of hidden) expect(role).not.toContain(name);
      expect(role).toContain("game_status");

      // A record that cannot be read fails closed.
      const unreadable = yield* names(unreadableThread);
      for (const name of hidden) expect(unreadable).not.toContain(name);
    }),
  ).pipe(Effect.provide(layerTestRuntime)),
);
