import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type GameVerifyResult,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import {
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerResponse,
} from "effect/http";

import * as GameRecipes from "../game/GameRecipes.ts";
import * as GameReviewApi from "../game/GameReviewApi.ts";
import * as GameReviewSessions from "../game/GameReviewSessions.ts";
import * as GameService from "../game/GameService.ts";
import * as ServerConfig from "../config.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const alternateTabId = PreviewTabId.make("tab-mcp-alternate");
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const invocation = {
  environmentId,
  requestNamespace: "provider-session-mcp-test",
  thread: {
    threadId,
    providerSessionId: "provider-session-mcp-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const layerTest = McpHttpServer.layerPreviewToolkit.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provideMerge(PreviewAutomationBroker.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-http-server-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const snapshotResult = {
  url: "http://example.test/",
  title: "Example",
  loading: false,
  visibleText: "Example",
  interactiveElements: [],
  accessibilityTree: {},
  consoleEntries: [],
  networkEntries: [],
  actionTimeline: [],
  screenshot: {
    mimeType: "image/png",
    data: Buffer.from("png").toString("base64"),
    width: 10,
    height: 5,
  },
};

const serveSnapshots = (clientId: string, result: unknown) =>
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const connected = yield* Deferred.make<void>();
    const inputs: Array<unknown> = [];
    const events = yield* broker.connect({ clientId, environmentId });
    yield* Stream.runForEach(events, (event) => {
      if (event.type === "connected") return Deferred.succeed(connected, undefined);
      inputs.push(event.request.input);
      return broker.respond({
        clientId,
        connectionId: event.connectionId,
        requestId: event.request.requestId,
        ok: true,
        result,
      });
    }).pipe(Effect.forkScoped);
    yield* Deferred.await(connected);
    return inputs;
  });

const callSnapshot = (args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name: "preview_snapshot", arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it("normalizes empty successful notification responses to accepted", () => {
  const notificationResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.text("", { status: 200, contentType: "application/json" }),
  );
  expect(notificationResponse.status).toBe(202);

  const resultResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: {} }),
  );
  expect(resultResponse.status).toBe(200);
});

it.effect.each([{}, { includeImage: false }])(
  "returns bounded structural preview snapshot failures %#",
  (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
        const events = yield* broker.connect({
          clientId: "mcp-failure-client",
          environmentId,
        });
        yield* Stream.runForEach(events, (event) =>
          event.type === "connected"
            ? Effect.void
            : broker.respond({
                clientId: "mcp-failure-client",
                connectionId: event.connectionId,
                requestId: event.request.requestId,
                ok: false,
                error: {
                  _tag: "PreviewAutomationExecutionError",
                  message: "sensitive renderer failure",
                  detail: { consoleOutput: "sensitive browser output" },
                },
              }),
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        const snapshot = yield* server
          .callTool({ name: "preview_snapshot", arguments: input })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );

        const message = "Preview automation snapshot failed on client mcp-failure-client.";
        expect(snapshot.isError).toBe(true);
        expect(snapshot.content).toEqual([
          { type: "text", text: `Preview snapshot failed: ${message}` },
        ]);
        expect(snapshot.structuredContent).toEqual({
          error: {
            _tag: "PreviewAutomationExecutionError",
            operation: "snapshot",
            failureCount: 1,
            message,
          },
        });
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { args: {}, advice: "No active preview tab was found for snapshot. Call preview_open first." },
  {
    args: { tabId: alternateTabId },
    advice: `Preview tab ${alternateTabId} was not found for snapshot. Omit tabId to use the current tab, or call preview_open.`,
  },
])("tells the agent to open a tab when the snapshot has none $args", ({ args, advice }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const connected = yield* Deferred.make<void>();
      const events = yield* broker.connect({ clientId: "mcp-no-tab-client", environmentId });
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected"
          ? Deferred.succeed(connected, undefined)
          : broker.respond({
              clientId: "mcp-no-tab-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: false,
              error: { _tag: "PreviewAutomationTabNotFoundError", message: "no tab" },
            }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);

      const snapshot = yield* callSnapshot(args);

      expect(snapshot.isError).toBe(true);
      expect(snapshot.content).toEqual([
        { type: "text", text: `Preview snapshot failed: ${advice}` },
      ]);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("tells the agent how to recover when no preview host can run the snapshot", () =>
  Effect.gen(function* () {
    const snapshot = yield* callSnapshot({});

    expect(snapshot.isError).toBe(true);
    const [text] = snapshot.content;
    expect(text?.type === "text" ? text.text : "").toContain(
      "Retry preview_status, then call preview_open",
    );
    expect(snapshot.structuredContent).toMatchObject({
      error: { _tag: "PreviewAutomationNoAvailableHostError" },
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { mode: "default", input: {}, images: false },
  { mode: "explicit image", input: { includeImage: true }, images: true },
  { mode: "text only", input: { includeImage: false }, images: false },
])("returns fresh $mode snapshots on repeated MCP calls", ({ input, images }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const connected = yield* Deferred.make<void>();
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
      const page = {
        url: "http://example.test/",
        loading: false,
        visibleText: "Save your changes",
        interactiveElements: [
          {
            tag: "button",
            role: "button",
            name: "Save",
            selector: "#save",
            x: 0,
            y: 0,
            width: 20,
            height: 10,
          },
        ],
        accessibilityTree: { role: "document", name: "Example" },
        consoleEntries: [],
        networkEntries: [],
        actionTimeline: [],
      };
      const screenshot = { mimeType: "image/png", width: 1, height: 1 };
      let requests = 0;
      const events = yield* broker.connect({ clientId: "mcp-image-option-client", environmentId });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Deferred.succeed(connected, undefined);
        requests += 1;
        expect(event.request).toMatchObject({
          operation: "snapshot",
          tabId: alternateTabId,
          threadId,
        });
        expect(event.request.input).toEqual({});
        return broker.respond({
          clientId: "mcp-image-option-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result: {
            ...page,
            title: `Snapshot ${requests}`,
            screenshot: { ...screenshot, data: png },
          },
        });
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);

      for (const call of [1, 2, 3, 4, 5, 6]) {
        const snapshot = yield* server
          .callTool({
            name: "preview_snapshot",
            arguments: { ...input, tabId: alternateTabId },
          })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        const metadata = { ...page, title: `Snapshot ${call}`, screenshot };
        const { accessibilityTree: _tree, ...boundedMetadata } = metadata;
        expect(snapshot.isError).toBe(false);
        expect(snapshot.structuredContent).toEqual({
          ...boundedMetadata,
          omitted: ["accessibilityTree (use interactiveElements locators or preview_evaluate)"],
        });
        const [identity, text, ...rest] = snapshot.content;
        expect(identity?.type === "text" ? decodeJsonText(identity.text) : null).toEqual({
          url: page.url,
        });
        expect(text?.type === "text" ? decodeJsonText(text.text) : null).toEqual(boundedMetadata);
        expect(rest).toEqual([
          {
            type: "text",
            text: "Snapshot text was bounded. Omitted: accessibilityTree (use interactiveElements locators or preview_evaluate).",
          },
          ...(images
            ? [
                {
                  type: "image",
                  mimeType: "image/png",
                  data: new Uint8Array(Buffer.from(png, "base64")),
                },
              ]
            : []),
        ]);
      }

      const nextDefault = yield* server
        .callTool({
          name: "preview_snapshot",
          arguments: { tabId: alternateTabId },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(nextDefault.content.map((content) => content.type)).toEqual(["text", "text", "text"]);
      expect(nextDefault.structuredContent).toMatchObject({ title: "Snapshot 7", screenshot });
      expect(nextDefault.structuredContent).not.toHaveProperty("accessibilityTree");
      expect(requests).toBe(7);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("refuses preview tools to a client outside a thread before they run", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const readOnly = {
      ...invocation,
      thread: undefined,
      requestNamespace: "client:session-1",
      client: { sessionId: "session-1", label: "Claude Code", access: "read-only" as const },
    };
    const click = yield* server
      .callTool({ name: "preview_click", arguments: { locator: "text=Send" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, readOnly),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(click.isError).toBe(true);
    expect(click.content).toEqual([
      { type: "text", text: expect.stringContaining("needs an agent running inside T3 Code") },
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects non-boolean snapshot image options before selecting a browser host", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const includeImage of ["false", 0, null]) {
      const result = yield* server
        .callTool({
          name: "preview_snapshot",
          arguments: { includeImage },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "Preview snapshot failed: AiError." }]);
      expect(result.structuredContent).toEqual({
        error: { _tag: "AiError", operation: "snapshot", failureCount: 1 },
      });
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("saves the snapshot PNG on request and reports its path", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const inputs = yield* serveSnapshots("mcp-save-client", snapshotResult);

      const snapshot = yield* callSnapshot({ save: true, includeImage: true });

      expect(snapshot.isError).toBe(false);
      expect(inputs).toEqual([{}]);
      expect(snapshot.content.map((content) => content.type)).toContain("image");
      const structured = snapshot.structuredContent as { readonly screenshotPath?: string };
      const screenshotPath = structured.screenshotPath;
      expect(typeof screenshotPath).toBe("string");
      expect(path.dirname(screenshotPath!)).toBe(config.browserArtifactsDir);
      expect(path.basename(screenshotPath!)).toMatch(
        /^browser-screenshot-example-test-[0-9a-z]+-[0-9a-f]{8}\.png$/,
      );
      expect(Buffer.from(yield* fileSystem.readFile(screenshotPath!)).toString()).toBe("png");
      const [, text] = snapshot.content;
      expect(text?.type === "text" ? text.text : "").toContain(screenshotPath);

      const unsaved = yield* callSnapshot({});
      expect(unsaved.structuredContent).not.toHaveProperty("screenshotPath");

      const pathOnly = yield* callSnapshot({ save: true });
      const saved = pathOnly.structuredContent as { readonly screenshotPath: string };
      expect(saved).toEqual({ url: snapshotResult.url, screenshotPath: expect.any(String) });
      expect(Buffer.from(yield* fileSystem.readFile(saved.screenshotPath)).toString()).toBe("png");
      const [only, ...others] = pathOnly.content;
      expect(others).toEqual([]);
      expect(only?.type === "text" ? decodeJsonText(only.text) : null).toEqual(saved);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("reports a tagged error when the screenshot cannot be saved", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(config.browserArtifactsDir, "");
      yield* serveSnapshots("mcp-save-failure-client", snapshotResult);

      const snapshot = yield* callSnapshot({ save: true });

      expect(snapshot.isError).toBe(true);
      expect(snapshot.content).toEqual([
        { type: "text", text: "Preview snapshot failed: PreviewScreenshotSaveError." },
      ]);
      expect(snapshot.structuredContent).toEqual({
        error: { _tag: "PreviewScreenshotSaveError", operation: "snapshot", failureCount: 1 },
      });
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("returns server ARIA refs to agents in text and structured results", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const accessibilityTree =
        '- button "delete" [ref=t3-snapshot-e1]\n- iframe [ref=t3-snapshot-e2]:\n  - textbox "child" [ref=t3-snapshot-f1e1]';
      yield* serveSnapshots("mcp-server-refs", { ...snapshotResult, accessibilityTree });
      const result = yield* callSnapshot({ includeImage: false });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({ accessibilityTree });
      expect(
        result.content.some(
          (entry) => entry.type === "text" && entry.text.includes("t3-snapshot-f1e1"),
        ),
      ).toBe(true);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("bounds large ARIA trees without dropping every server locator", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const accessibilityTree = Array.from(
        { length: 2_000 },
        (_, index) => `- button "删除 ${index}" [ref=t3-snapshot-e${index}]`,
      ).join("\n");
      yield* serveSnapshots("mcp-large-server-refs", { ...snapshotResult, accessibilityTree });
      const result = yield* callSnapshot({ includeImage: false });
      expect(result.isError).toBe(false);
      const metadata = result.structuredContent as { accessibilityTree: string };
      expect(metadata.accessibilityTree).toContain("[ref=t3-snapshot-e0]");
      expect(metadata.accessibilityTree.length).toBeLessThan(accessibilityTree.length);
      const body = result.content[1];
      expect(Buffer.byteLength(body?.type === "text" ? body.text : "", "utf8")).toBeLessThanOrEqual(
        McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
      );
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("keeps the snapshot text under the agent's output ceiling", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pageText = "/Users/theo/Code/project\nClaude, Codex · 79 threads\n".repeat(600);
      const element = (name: string, index: number) => ({
        tag: "div",
        role: "presentation",
        name,
        selector: `div:nth-of-type(${index})`,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      });
      const oversized = {
        ...snapshotResult,
        visibleText: pageText,
        interactiveElements: [
          element(pageText, 1),
          element(pageText, 2),
          element(pageText, 3),
          element("Continue", 4),
        ],
        accessibilityTree: { nodes: Array.from({ length: 2_000 }, (_, i) => ({ nodeId: `${i}` })) },
        consoleEntries: Array.from({ length: 100 }, (_, i) => ({
          level: "log",
          text: `entry ${i}`,
          timestamp: "t",
        })),
      };
      yield* serveSnapshots("mcp-bounded-client", oversized);

      const snapshot = yield* callSnapshot({ includeImage: false });

      expect(snapshot.isError).toBe(false);
      const [identity, text, notice] = snapshot.content;
      expect(identity?.type === "text" ? decodeJsonText(identity.text) : null).toEqual({
        url: oversized.url,
      });
      expect(text?.type).toBe("text");
      const body = text?.type === "text" ? text.text : "";
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
        McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
      );
      const parsed = decodeJsonText(body) as {
        readonly accessibilityTree?: unknown;
        readonly visibleText: string;
        readonly interactiveElements: ReadonlyArray<{ readonly name: string }>;
        readonly consoleEntries: ReadonlyArray<{ readonly text: string }>;
      };
      expect(parsed.accessibilityTree).toBeUndefined();
      expect(parsed.visibleText.length).toBeLessThanOrEqual(8_001);
      expect(parsed.interactiveElements).toHaveLength(4);
      expect(parsed.interactiveElements[0]?.name.length).toBeLessThanOrEqual(201);
      expect(parsed.interactiveElements[3]?.name).toBe("Continue");
      expect(parsed.consoleEntries).toHaveLength(40);
      expect(parsed.consoleEntries[0]?.text).toBe("entry 60");
      expect(notice?.type === "text" ? notice.text : "").toContain("accessibilityTree");
      expect(notice?.type === "text" ? notice.text : "").toContain("60 older console entries");
      // Claude Code shows the model structuredContent instead of the text, so it is bounded too.
      expect(snapshot.structuredContent).toEqual({
        ...parsed,
        omitted: expect.arrayContaining(["60 older console entries"]),
      });
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("bounds the snapshot text even when nothing but logs and the title are large", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const oversized = {
        ...snapshotResult,
        title: "t".repeat(70_000),
        interactiveElements: [],
        consoleEntries: [{ level: "log", text: "x".repeat(70_000), timestamp: "t" }],
      };
      yield* serveSnapshots("mcp-bounded-logs-client", oversized);

      const snapshot = yield* callSnapshot({ includeImage: false });

      const [, text] = snapshot.content;
      const body = text?.type === "text" ? text.text : "";
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
        McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
      );
      const parsed = decodeJsonText(body) as {
        readonly title: string;
        readonly consoleEntries: ReadonlyArray<{ readonly text: string }>;
      };
      expect(parsed.title.length).toBe(2_049);
      expect(parsed.consoleEntries[0]?.text.length).toBe(501);
      const notice = snapshot.content[2];
      const noticeText = notice?.type === "text" ? notice.text : "";
      expect(noticeText).toContain("url or title after 2048 characters");
      expect(noticeText).toContain("console entries text after 500 characters");
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("bounds page text made of wide characters before dropping locators", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* serveSnapshots("mcp-wide-text-client", {
        ...snapshotResult,
        visibleText: "界".repeat(9_000),
        interactiveElements: Array.from({ length: 20 }, (_, i) => ({
          tag: "button",
          role: "button",
          name: `Button ${i}`,
          selector: `#button-${i}`,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        })),
      });

      const snapshot = yield* callSnapshot({ includeImage: false });

      const [, text, notice] = snapshot.content;
      const body = text?.type === "text" ? text.text : "";
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
        McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
      );
      const parsed = decodeJsonText(body) as {
        readonly visibleText: string;
        readonly interactiveElements: ReadonlyArray<unknown>;
      };
      expect(parsed.visibleText).toMatch(/^界+…$/);
      expect(parsed.interactiveElements).toHaveLength(20);
      expect(notice?.type === "text" ? notice.text : "").toContain(
        "visibleText after 4000 characters",
      );
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("sheds log entries before locators when every list is full", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const long = "x".repeat(2_000);
      const oversized = {
        ...snapshotResult,
        interactiveElements: Array.from({ length: 20 }, (_, i) => ({
          tag: "button",
          role: "button",
          name: `Button ${i}`,
          selector: `#button-${i}`,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        })),
        consoleEntries: Array.from({ length: 200 }, () => ({
          level: long,
          text: long,
          timestamp: long,
          source: long,
        })),
        networkEntries: Array.from({ length: 200 }, () => ({
          url: long,
          method: long,
          status: 200,
          failed: false,
          errorText: long,
          timestamp: long,
        })),
        actionTimeline: Array.from({ length: 200 }, () => ({
          id: long,
          action: long,
          status: "succeeded",
          startedAt: long,
          completedAt: long,
          error: long,
        })),
      };
      yield* serveSnapshots("mcp-full-logs-client", oversized);

      const snapshot = yield* callSnapshot({ includeImage: false });

      const [, text, notice] = snapshot.content;
      const body = text?.type === "text" ? text.text : "";
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
        McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
      );
      const parsed = decodeJsonText(body) as {
        readonly interactiveElements: ReadonlyArray<unknown>;
        readonly consoleEntries: ReadonlyArray<unknown>;
        readonly networkEntries: ReadonlyArray<unknown>;
        readonly actionTimeline: ReadonlyArray<unknown>;
      };
      expect(parsed.interactiveElements).toHaveLength(20);
      expect(
        parsed.consoleEntries.length + parsed.networkEntries.length + parsed.actionTimeline.length,
      ).toBeLessThan(120);
      const noticeText = notice?.type === "text" ? notice.text : "";
      expect(noticeText).toContain("40 of 40 actionTimeline");
      expect(noticeText).not.toMatch(/\d+ of \d+ interactiveElements/);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const token = "providerTokenWithoutDots";
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        requestNamespace: "provider-session",
        thread: {
          threadId: ThreadId.make("thread-provider"),
          providerSessionId: "provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const layerServer = McpHttpServer.layerMcpTransport.pipe(
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (presented) =>
              Effect.succeed(
                presented === token
                  ? (scope as McpInvocationContext.McpThreadInvocationScope)
                  : undefined,
              ),
          }),
        ),
      );
      yield* HttpRouter.serve(layerServer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
      );

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeNull();

      const missingSessionResponse = yield* httpClient.del("/mcp");
      expect(missingSessionResponse.status).toBe(400);

      const unknownSessionResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": "unknown-session" },
      });
      expect(unknownSessionResponse.status).toBe(404);

      const terminateResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": sessionId! },
      });
      expect(terminateResponse.status).toBe(204);

      const reusedSessionResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
          "application/json",
        ),
      });
      expect(reusedSessionResponse.status).toBe(404);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("registers annotated tools and preserves authenticated request context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const toolIcon = {
        _tag: "website" as const,
        pageUrl: "http://example.test/",
      };
      const routedRequests: Array<{
        readonly operation: string;
        readonly tabId?: string | undefined;
      }> = [];
      const events = yield* broker.connect({
        clientId: "mcp-test-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Effect.void;
        routedRequests.push(event.request);
        return broker.respond({
          clientId: "mcp-test-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result:
            event.request.operation === "snapshot"
              ? snapshotResult
              : event.request.operation === "evaluate"
                ? ["Connect", "Continue"]
                : event.request.operation === "press"
                  ? undefined
                  : {
                      available: true,
                      visible: true,
                      tabId,
                      url: "http://example.test/",
                      title: "Example",
                      loading: false,
                    },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const statusTool = server.tools.find(({ tool }) => tool.name === "preview_status");
      expect(statusTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(statusTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(statusTool?.tool.annotations?.destructiveHint).toBe(false);

      const snapshotTool = server.tools.find(({ tool }) => tool.name === "preview_snapshot");
      expect(snapshotTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(snapshotTool?.tool.annotations?.idempotentHint).toBe(false);
      expect(snapshotTool?.tool.annotations?.openWorldHint).toBe(true);

      const clickTool = server.tools.find(({ tool }) => tool.name === "preview_click");
      expect(clickTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(clickTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(clickTool?.tool.annotations?.openWorldHint).toBe(true);
      expect(clickTool?.tool.outputSchema).toMatchObject({
        type: "object",
        additionalProperties: true,
        description: "The preview action completed successfully.",
      });

      const navigateTool = server.tools.find(({ tool }) => tool.name === "preview_navigate");
      expect(navigateTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(navigateTool?.tool.annotations?.openWorldHint).toBe(true);

      const status = yield* server
        .callTool({ name: "preview_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        available: true,
        tabId,
      });

      const malformed = yield* server
        .callTool({ name: "preview_click", arguments: { selector: "" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.flip,
        );
      expect(malformed._tag).toBe("InvalidParams");

      const snapshot = yield* server
        .callTool({
          name: "preview_snapshot",
          arguments: { tabId: alternateTabId, includeImage: true },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(snapshot.isError).toBe(false);
      expect(snapshot.content.some((content) => content.type === "image")).toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 10, height: 5 },
      });
      expect(routedRequests.find(({ operation }) => operation === "snapshot")?.tabId).toBe(
        alternateTabId,
      );

      // Arrays and primitives are wrapped so structuredContent stays a JSON object.
      // Claude Code rejects the whole result otherwise.
      const evaluateTool = server.tools.find(({ tool }) => tool.name === "preview_evaluate");
      expect(evaluateTool?.tool.outputSchema).toMatchObject({ type: "object" });
      const evaluated = yield* server
        .callTool({ name: "preview_evaluate", arguments: { expression: "buttons()" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(evaluated.isError).toBe(false);
      expect(evaluated.structuredContent).toEqual({ value: ["Connect", "Continue"], toolIcon });
      const evaluatedText = evaluated.content[0];
      expect(evaluatedText?.type === "text" ? decodeJsonText(evaluatedText.text) : null).toEqual({
        toolIcon,
        value: ["Connect", "Continue"],
      });

      const actionRequests = [
        { name: "preview_click", arguments: { x: 10, y: 10 } },
        { name: "preview_type", arguments: { text: "Hello" } },
        { name: "preview_press", arguments: { key: "Enter" } },
        { name: "preview_scroll", arguments: { deltaY: 100 } },
        { name: "preview_wait_for", arguments: { text: "Example" } },
      ];
      for (const request of actionRequests) {
        const result = yield* server
          .callTool(request)
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toEqual({ toolIcon });
        expect(routedRequests.at(-1)?.operation).toBe("status");
        const text = result.content[0];
        expect(text?.type === "text" ? decodeJsonText(text.text) : null).toEqual({ toolIcon });
      }
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("admits provider and OAuth client credentials and points only clients at OAuth", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const providerToken = "providerTokenWithoutDots";
      const clientToken = "client-payload.client-signature";
      const providerScope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        requestNamespace: "provider-session",
        thread: {
          threadId: ThreadId.make("thread-provider"),
          providerSessionId: "provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const clientScope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        requestNamespace: "client:session-1",
        thread: undefined,
        client: { sessionId: "session-1", label: "Claude Code", access: "auto" },
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const seen: Array<McpInvocationContext.McpInvocationScope> = [];
      const ProbeToolkit = Toolkit.make(
        Tool.make("probe", {
          description: "Reports the caller.",
          success: Schema.Struct({ ok: Schema.Boolean }),
          failure: OrchestratorMcpFailure,
          failureMode: "return",
          dependencies: [McpInvocationContext.McpInvocationContext],
        }),
      );
      const serverLayer = McpHttpServer.toolkitRegistration(
        ProbeToolkit,
        McpToolAccess.toLayer(ProbeToolkit, {
          probe: McpToolAccess.reads(() =>
            McpInvocationContext.McpInvocationContext.pipe(
              Effect.tap((scope) => Effect.sync(() => seen.push(scope))),
              Effect.as({ ok: true }),
            ),
          ),
        }),
      ).pipe(
        Layer.provideMerge(McpHttpServer.layerMcpTransport),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (token) =>
              Effect.succeed(
                token === providerToken
                  ? (providerScope as McpInvocationContext.McpThreadInvocationScope)
                  : undefined,
              ),
          }),
        ),
        Layer.provide(
          Layer.succeed(McpHttpServer.McpClientAuthenticator, {
            authenticate: (request) =>
              Effect.succeed(
                request.headers.authorization === `Bearer ${clientToken}` ? clientScope : undefined,
              ),
          }),
        ),
      );
      yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const httpClient = yield* HttpClient.HttpClient;
      const call = (token: string | undefined) =>
        Effect.gen(function* () {
          const headers = {
            accept: "application/json, text/event-stream",
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          };
          const initialize = yield* httpClient.post("/mcp", {
            headers,
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
              "application/json",
            ),
          });
          if (initialize.status !== 200) return initialize;
          return yield* httpClient.post("/mcp", {
            headers: {
              ...headers,
              "mcp-session-id": initialize.headers["mcp-session-id"]!,
              "mcp-protocol-version": "2025-06-18",
            },
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"probe","arguments":{}}}`,
              "application/json",
            ),
          });
        });

      expect((yield* call(providerToken)).status).toBe(200);
      expect((yield* call(clientToken)).status).toBe(200);
      expect(seen.map((scope) => scope.requestNamespace)).toEqual([
        "provider-session",
        "client:session-1",
      ]);

      const missing = yield* call(undefined);
      expect(missing.status).toBe(401);
      expect(missing.headers["www-authenticate"]).toMatch(
        /^Bearer resource_metadata="http:\/\/[^"]+\/\.well-known\/oauth-protected-resource\/mcp"$/,
      );

      const expiredClient = yield* call("stale-payload.stale-signature");
      expect(expiredClient.headers["www-authenticate"]).toContain("resource_metadata=");
      expect(expiredClient.headers["www-authenticate"]).toContain('error="invalid_token"');

      const deadProvider = yield* call("deadProviderToken");
      expect(deadProvider.status).toBe(401);
      expect(deadProvider.headers["www-authenticate"]).toBe('Bearer error="invalid_token"');
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "only lists the matching internal review answer tool and returns validation feedback through MCP",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seen: unknown[] = [];
        const tried: unknown[] = [];
        const imported: unknown[] = [];
        const verified: unknown[] = [];
        const submitted: unknown[] = [];
        const reviewControlCalls: unknown[] = [];
        const verifyBuildId = "a".repeat(64);
        const verifyResult: GameVerifyResult = {
          success: true,
          message: "Mechanical verification passed for build test.",
          completed: ["check", "test", "export", "playtest"],
          check: {
            ok: true,
            errors: [],
            warnings: [],
            entries: ["main", "gameplay"],
            durationMs: 4,
          },
          test: { success: true, message: "ok", path: null, url: null, process: null },
          export: {
            success: true,
            message: "Web game is ready to play.",
            path: `builds/candidates/${verifyBuildId}/index.html`,
            url: null,
            process: null,
          },
          build: {
            buildId: verifyBuildId,
            directory: `builds/candidates/${verifyBuildId}`,
            path: `/games/demo/builds/candidates/${verifyBuildId}/index.html`,
          },
          playtest: {
            success: true,
            booted: true,
            bootMs: 12,
            responded: true,
            executedInputSteps: 1,
            changedPercent: 14,
            message: "Playtest succeeded: fake run.",
            consoleMessages: [],
            state: null,
            qualifies: true,
            blockers: [],
            interaction: "fake response",
          },
          screenshots: [
            {
              label: "after-steps",
              mimeType: "image/png",
              data: "cG5n",
              width: 640,
              height: 360,
            },
          ],
        };
        const switchedRole = yield* Ref.make<"critic" | "ballot" | null>("critic");
        const reducedRepairCatalog = yield* Ref.make(false);
        const serverLayer = McpHttpServer.layerGameToolkit.pipe(
          Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
          Layer.provide(
            Layer.mock(GameReviewApi.GameReviewApi)({
              status: (threadId) =>
                Effect.sync(() => {
                  reviewControlCalls.push({ operation: "status", threadId });
                  return {} as never;
                }),
              stop: (threadId) =>
                Effect.sync(() => {
                  reviewControlCalls.push({ operation: "stop", threadId });
                  return {} as never;
                }),
              submit: (threadId, input) =>
                Effect.sync(() => {
                  submitted.push({ threadId, input });
                  return {
                    accepted: true,
                    message: "Accepted the repair build.",
                    buildId: null,
                    submission: null,
                    checks: [],
                  };
                }),
            }),
          ),
          Layer.provide(
            Layer.mock(GameService.GameService)({
              importArtKit: (_threadId, input) =>
                Effect.sync(() => {
                  imported.push(input);
                  return {} as never;
                }),
              verify: (threadId, input) =>
                Effect.sync(() => {
                  verified.push({ threadId, input });
                  // A playtest that stops short is a result, not a toolkit
                  // failure; its frames still belong in the tool response.
                  return input.steps.some((step) => "press" in step && step.press === "F")
                    ? {
                        ...verifyResult,
                        success: false,
                        failedStage: "playtest" as const,
                        message: "Stopped at the playtest.",
                      }
                    : verifyResult;
                }),
            }),
          ),
          Layer.provideMerge(McpHttpServer.layerMcpTransport),
          Layer.provide(GameRecipes.layer),
          Layer.provide(
            Layer.mock(GameReviewSessions.GameReviewSessions)({
              tryInput: (caller, input) =>
                Effect.sync(() => {
                  tried.push({ caller, input });
                  return {
                    success: true,
                    booted: true,
                    bootMs: 5,
                    responded: true,
                    changedPercent: 2,
                    message: "experiment",
                    consoleMessages: [],
                    state: null,
                    screenshots: [
                      {
                        label: "input 1 after",
                        frameId: "try1f2",
                        mimeType: "image/png",
                        width: 640,
                        height: 360,
                        data: "cG5n",
                        inputPair: {
                          stepIndex: 0,
                          phase: "after",
                          input: { press: "Space" },
                          changedPercent: 2,
                          stateChanges: [],
                        },
                      },
                    ],
                  };
                }),
              toolRole: (caller) =>
                caller.threadId === ThreadId.make("switch-thread")
                  ? Ref.get(switchedRole)
                  : Effect.succeed(
                      caller.threadId === threadId
                        ? "critic"
                        : caller.threadId === ThreadId.make("ballot-child")
                          ? "ballot"
                          : null,
                    ),
              repairChild: (caller) =>
                caller.threadId === ThreadId.make("repairer-thread")
                  ? Ref.get(reducedRepairCatalog)
                  : Effect.succeed(false),
              report: (_caller, _role, value) =>
                Effect.sync(() => {
                  seen.push(value);
                  return seen.length === 1
                    ? {
                        accepted: false,
                        error: "doNotRegress must be an array",
                        attemptsRemaining: 2,
                        ended: false,
                      }
                    : { accepted: true, error: null, attemptsRemaining: 0, ended: true };
                }),
            }),
          ),
          Layer.provide(
            Layer.mock(McpSessionRegistry.McpSessionRegistry)({
              resolve: (token) =>
                Effect.succeed({
                  ...invocation,
                  thread: {
                    ...invocation.thread,
                    threadId:
                      token === "critic"
                        ? threadId
                        : ThreadId.make(
                            token === "ballot"
                              ? "ballot-child"
                              : token === "builder"
                                ? "builder-thread"
                                : token === "repairer"
                                  ? "repairer-thread"
                                  : token === "switch"
                                    ? "switch-thread"
                                    : "other-thread",
                          ),
                  },
                }),
            }),
          ),
        );
        yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
          Layer.build,
        );
        const client = yield* HttpClient.HttpClient;
        const rpc = (
          token: string,
          sessionId: string | undefined,
          method: string,
          params: unknown,
        ) =>
          client.post("/mcp", {
            headers: {
              accept: "application/json, text/event-stream",
              authorization: `Bearer ${token}`,
              ...(sessionId === undefined
                ? {}
                : { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" }),
            },
            body: HttpBody.text(
              JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
              "application/json",
            ),
          });
        const connect = (token: string) =>
          rpc(token, undefined, "initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "review-test", version: "1" },
          }).pipe(Effect.map((response) => response.headers["mcp-session-id"]!));
        const critic = yield* connect("critic");
        const ballot = yield* connect("ballot");
        const builder = yield* connect("builder");
        const repairer = yield* connect("repairer");
        const other = yield* connect("other");
        const switching = yield* connect("switch");
        const list = (token: string, session: string) =>
          rpc(token, session, "tools/list", {}).pipe(Effect.flatMap((response) => response.text));
        const toolNames = (token: string, session: string) =>
          list(token, session).pipe(
            Effect.map((body) => {
              const data = body
                .split("\n")
                .find((line) => line.startsWith("data:"))
                ?.slice("data:".length)
                .trim();
              const envelope = decodeJsonText(data ?? body) as {
                readonly result?: { readonly tools?: ReadonlyArray<{ readonly name?: unknown }> };
              };
              return (envelope.result?.tools ?? [])
                .flatMap((tool) => (typeof tool.name === "string" ? [tool.name] : []))
                .sort();
            }),
          );
        // The builder toolkit is the largest catalog; a fresh review must not
        // pay for its schemas in every code-mode search.
        const builderTools = [
          "game_art_get",
          "game_art_import",
          "game_art_search",
          "game_blender_run",
          "game_export",
          "game_godot_check",
          "game_godot_import",
          "game_godot_test",
          "game_package_web",
          "game_package_windows",
          "game_preview",
          "game_recipe_get",
          "game_recipe_search",
          "game_review_history",
          "game_review_restore",
          "game_review_status",
          "game_review_stop",
          "game_run_native",
          "game_scenarios_run",
          "game_scene_inspect",
          "game_status",
          "game_stop",
          "game_submit",
          "game_try_input",
          "game_verify",
          "game_web_playtest",
        ].sort();
        const criticTools = [
          "game_art_get",
          "game_art_search",
          "game_critic_report",
          "game_recipe_get",
          "game_recipe_search",
          "game_try_input",
          "game_web_playtest",
        ].sort();
        const reviewControlTools = [
          "game_review_history",
          "game_review_restore",
          "game_review_status",
          "game_review_stop",
        ];
        const repairTools = builderTools.filter((name) => !reviewControlTools.includes(name));
        // Before the repair flag, the repair child gets the full builder catalog.
        // The same HTTP session then flips to the reduced catalog; bytes are the
        // real serialized tools/list body, not a schema estimate.
        const builderBody = yield* list("builder", builder);
        const repairBeforeBody = yield* list("repairer", repairer);
        expect(yield* toolNames("builder", builder)).toEqual(builderTools);
        expect(yield* toolNames("repairer", repairer)).toEqual(builderTools);
        expect(Buffer.byteLength(repairBeforeBody)).toBe(Buffer.byteLength(builderBody));
        yield* Ref.set(reducedRepairCatalog, true);
        const repairAfterBody = yield* list("repairer", repairer);
        expect(yield* toolNames("repairer", repairer)).toEqual(repairTools);
        expect(Buffer.byteLength(repairAfterBody)).toBeLessThan(
          Buffer.byteLength(repairBeforeBody),
        );
        for (const name of reviewControlTools) {
          expect(repairAfterBody).not.toContain(`"name":"${name}"`);
        }
        expect(yield* toolNames("critic", critic)).toEqual(criticTools);
        expect(yield* toolNames("ballot", ballot)).toEqual(["game_ballot"]);
        // Roles are resolved per request, not per session or server. The same
        // MCP session must get the new catalog when the thread's review role
        // changes, and the old one when it changes back.
        expect(yield* toolNames("switch", switching)).toEqual(criticTools);
        yield* Ref.set(switchedRole, "ballot");
        expect(yield* toolNames("switch", switching)).toEqual(["game_ballot"]);
        yield* Ref.set(switchedRole, null);
        expect(yield* toolNames("switch", switching)).toEqual(builderTools);
        yield* Ref.set(switchedRole, "critic");
        expect(yield* toolNames("switch", switching)).toEqual(criticTools);
        // The repair flag is request-scoped too, on the one session that has
        // already listed both catalogs.
        yield* Ref.set(reducedRepairCatalog, false);
        expect(yield* toolNames("repairer", repairer)).toEqual(builderTools);
        yield* Ref.set(reducedRepairCatalog, true);
        expect(yield* toolNames("repairer", repairer)).toEqual(repairTools);
        expect(yield* list("critic", critic)).toContain('"name":"game_critic_report"');
        expect(yield* list("critic", critic)).not.toContain('"name":"game_ballot"');
        expect(yield* list("ballot", ballot)).toContain('"name":"game_ballot"');
        expect(yield* list("ballot", ballot)).not.toContain('"name":"game_try_input"');
        expect(yield* list("critic", critic)).toContain('"name":"game_try_input"');
        expect(yield* list("other", other)).toContain('"name":"game_try_input"');
        // The read-only know-how toolkit is listed for the three working roles and
        // hidden from ballots.
        for (const [token, session] of [
          ["builder", builder],
          ["repairer", repairer],
          ["critic", critic],
        ] as const) {
          expect(yield* list(token, session)).toContain('"name":"game_recipe_search"');
          expect(yield* list(token, session)).toContain('"name":"game_recipe_get"');
        }
        expect(yield* list("ballot", ballot)).not.toContain("game_recipe_search");
        expect(yield* list("ballot", ballot)).not.toContain("game_recipe_get");
        const forbiddenInput = yield* rpc("ballot", ballot, "tools/call", {
          name: "game_try_input",
          arguments: { steps: [{ press: "Space" }] },
        }).pipe(Effect.flatMap((response) => response.text));
        expect(forbiddenInput).toContain("error");
        expect(tried).toHaveLength(0);
        // A ballot cannot retrieve recipes either, even by naming the tool.
        const forbiddenRecipe = yield* rpc("ballot", ballot, "tools/call", {
          name: "game_recipe_search",
          arguments: {},
        }).pipe(Effect.flatMap((response) => response.text));
        expect(forbiddenRecipe).toContain("error");
        // The T115 child's 13-step route is refused by the advertised schema
        // before it reaches the review service.
        const tooManyInputSteps = yield* rpc("repairer", repairer, "tools/call", {
          name: "game_try_input",
          arguments: { steps: Array.from({ length: 13 }, () => ({ press: "Space" })) },
        }).pipe(Effect.flatMap((response) => response.text));
        expect(tooManyInputSteps).toContain('"isError":true');
        expect(tooManyInputSteps).toContain("12");
        expect(tried).toHaveLength(0);
        // The reduced repair catalog still reaches the mutable testing and
        // submission routes; review control is hidden and refused even by name.
        const repairInput = yield* rpc("repairer", repairer, "tools/call", {
          name: "game_try_input",
          arguments: { steps: [{ press: "Space" }] },
        }).pipe(Effect.flatMap((response) => response.text));
        expect(repairInput).not.toContain('"isError":true');
        expect(tried).toEqual([
          {
            caller: {
              threadId: ThreadId.make("repairer-thread"),
              providerSessionId: "provider-session-mcp-test",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
            input: { steps: [{ press: "Space" }] },
          },
        ]);
        const repairSubmit = yield* rpc("repairer", repairer, "tools/call", {
          name: "game_submit",
          arguments: { note: "Fixed the visible defect." },
        }).pipe(Effect.flatMap((response) => response.text));
        expect(repairSubmit).not.toContain('"isError":true');
        expect(repairSubmit).toContain('"accepted":true');
        expect(submitted).toEqual([
          {
            threadId: ThreadId.make("repairer-thread"),
            input: { note: "Fixed the visible defect." },
          },
        ]);
        for (const name of ["game_review_status", "game_review_stop"]) {
          const denied = yield* rpc("repairer", repairer, "tools/call", {
            name,
            arguments: {},
          }).pipe(Effect.flatMap((response) => response.text));
          expect(denied).toContain("error");
        }
        expect(reviewControlCalls).toHaveLength(0);
        // Art search/get are read-only and follow the know-how rules; import is
        // a build write, so critics and ballots never receive the tool.
        for (const [token, session] of [
          ["builder", builder],
          ["repairer", repairer],
          ["critic", critic],
        ] as const) {
          expect(yield* list(token, session)).toContain('"name":"game_art_search"');
          expect(yield* list(token, session)).toContain('"name":"game_art_get"');
        }
        expect(yield* list("builder", builder)).toContain('"name":"game_art_import"');
        expect(yield* list("repairer", repairer)).toContain('"name":"game_art_import"');
        expect(yield* list("critic", critic)).not.toContain("game_art_import");
        expect(yield* list("ballot", ballot)).not.toContain("game_art_search");
        expect(yield* list("ballot", ballot)).not.toContain("game_art_get");
        expect(yield* list("ballot", ballot)).not.toContain("game_art_import");
        const forbiddenArt = yield* rpc("critic", critic, "tools/call", {
          name: "game_art_import",
          arguments: { id: "kenney-tiny-dungeon" },
        }).pipe(Effect.flatMap((response) => response.text));
        expect(forbiddenArt).toContain("error");
        expect(imported).toHaveLength(0);
        // game_verify is a complete write cycle: builders and repair children get
        // it; fresh critic and ballot scopes never do.
        expect(yield* list("builder", builder)).toContain('"name":"game_verify"');
        expect(yield* list("repairer", repairer)).toContain('"name":"game_verify"');
        expect(yield* list("critic", critic)).not.toContain('"name":"game_verify"');
        expect(yield* list("ballot", ballot)).not.toContain('"name":"game_verify"');
        // The critic may replay a window layout; a ballot compares frozen frames
        // only and never plays the build.
        expect(yield* list("critic", critic)).toContain('"name":"game_web_playtest"');
        expect(yield* list("ballot", ballot)).not.toContain('"name":"game_web_playtest"');
        const forbiddenVerify = yield* rpc("critic", critic, "tools/call", {
          name: "game_verify",
          arguments: { steps: [{ press: "Space" }] },
        }).pipe(Effect.flatMap((response) => response.text));
        expect(forbiddenVerify).toContain("error");
        expect(verified).toHaveLength(0);
        // The advertised route is required, and exactSize is rejected rather
        // than stripped into a scaled capture; neither reaches the service.
        const missingRoute = yield* rpc("builder", builder, "tools/call", {
          name: "game_verify",
          arguments: {},
        }).pipe(Effect.flatMap((response) => response.text));
        expect(missingRoute).toContain('"isError":true');
        expect(missingRoute).toContain("steps");
        const tooManyVerifySteps = yield* rpc("builder", builder, "tools/call", {
          name: "game_verify",
          arguments: { steps: Array.from({ length: 61 }, () => ({ press: "Space" })) },
        }).pipe(Effect.flatMap((response) => response.text));
        expect(tooManyVerifySteps).toContain('"isError":true');
        expect(tooManyVerifySteps).toContain("60");
        expect(verified).toHaveLength(0);
        const layoutVerify = yield* rpc("builder", builder, "tools/call", {
          name: "game_verify",
          arguments: { steps: [{ press: "Space" }], width: 900, height: 900, exactSize: true },
        }).pipe(Effect.flatMap((response) => response.text));
        expect(layoutVerify).toContain('"isError":true');
        expect(layoutVerify).toContain("exactSize");
        expect(verified).toHaveLength(0);
        const verifiedCall = yield* rpc("builder", builder, "tools/call", {
          name: "game_verify",
          arguments: { steps: [{ press: "Space" }] },
        }).pipe(Effect.flatMap((response) => response.text));
        expect(verifiedCall).not.toContain('"isError":true');
        expect(verifiedCall).toContain('"completed":["check","test","export","playtest"]');
        expect(verifiedCall).toContain(`"buildId":"${verifyBuildId}"`);
        expect(verifiedCall).toContain('"label":"after-steps"');
        expect(verifiedCall).toContain('"type":"image"');
        expect(verifiedCall).toContain('"mimeType":"image/png"');
        expect(verifiedCall).toContain('"data":"cG5n"');
        expect(verified).toHaveLength(1);
        expect(verified[0]).toEqual({
          threadId: ThreadId.make("builder-thread"),
          input: { steps: [{ press: "Space" }] },
        });
        // includeImage is transport metadata read by this registration, not a
        // tool option; strict decoding must not turn the text-only request into
        // an error.
        const textOnlyVerify = yield* rpc("builder", builder, "tools/call", {
          name: "game_verify",
          arguments: { steps: [{ press: "Space" }], includeImage: false },
        }).pipe(Effect.flatMap((response) => response.text));
        expect(textOnlyVerify).not.toContain('"isError":true');
        expect(textOnlyVerify).not.toContain('"type":"image"');
        expect(textOnlyVerify).toContain('"label":"after-steps"');
        // A verify that stops at the playtest still has useful frames; only a
        // declared toolkit failure is an error result.
        const failedFrames = yield* rpc("builder", builder, "tools/call", {
          name: "game_verify",
          arguments: { steps: [{ press: "F" }] },
        }).pipe(Effect.flatMap((response) => response.text));
        expect(failedFrames).not.toContain('"isError":true');
        expect(failedFrames).toContain('"success":false');
        expect(failedFrames).toContain('"failedStage":"playtest"');
        expect(failedFrames).toContain('"type":"image"');
        expect(verified).toHaveLength(3);
        // The builder searches by tags and gets the complete reference back.
        const builderSearch = yield* rpc("builder", builder, "tools/call", {
          name: "game_recipe_search",
          arguments: { genre: "platformer", defect: "unresponsive-jump" },
        }).pipe(Effect.flatMap((response) => response.text));
        expect(builderSearch).toContain('"id":"loop.platformer"');
        expect(builderSearch).toContain('"matchingTags":["platformer","unresponsive-jump"]');
        expect(builderSearch).toContain('"engines":["godot"]');
        expect(builderSearch).toContain('"nextCursor":"5"');
        // Actual builder calls used `query`. It is a literal alias search, so it
        // must find the dialogue recipe instead of browsing the whole catalog.
        const querySearch = yield* rpc("builder", builder, "tools/call", {
          name: "game_recipe_search",
          arguments: { query: "dialogue" },
        }).pipe(Effect.flatMap((response) => response.text));
        expect(querySearch).toContain('"id":"loop.dialogue"');
        expect(querySearch).toContain('"matchingTags":["dialogue tree"]');
        expect(querySearch).not.toContain('"id":"feel.buffer"');
        // A phrase with no declared alias match is an honest empty page, not a
        // semantic guess and not a browse.
        const queryMiss = yield* rpc("builder", builder, "tools/call", {
          name: "game_recipe_search",
          arguments: { query: "dragon riding school" },
        }).pipe(Effect.flatMap((response) => response.text));
        expect(queryMiss).toContain('"recipes":[]');
        // An unrecognized filter name is refused with the field named instead of
        // silently dropping all search intent and returning a catalog page.
        const misspelled = yield* rpc("builder", builder, "tools/call", {
          name: "game_recipe_search",
          arguments: { genere: "dialogue" },
        }).pipe(Effect.flatMap((response) => response.text));
        expect(misspelled).toContain('"code":-32602');
        expect(misspelled).toContain("genere");
        expect(misspelled).not.toContain('"recipes"');
        // Two different literal searches in one call are refused, not merged or
        // resolved by precedence.
        const conflicting = yield* rpc("builder", builder, "tools/call", {
          name: "game_recipe_search",
          arguments: { text: "jump", query: "dialogue" },
        }).pipe(Effect.flatMap((response) => response.text));
        expect(conflicting).toContain("text");
        expect(conflicting).toContain("query");
        expect(conflicting).not.toContain('"recipes"');
        // The corrected call still returns the recipe the caller wanted.
        const corrected = yield* rpc("builder", builder, "tools/call", {
          name: "game_recipe_search",
          arguments: { genre: "dialogue" },
        }).pipe(Effect.flatMap((response) => response.text));
        expect(corrected).toContain('"id":"loop.dialogue"');
        const builderGet = yield* rpc("builder", builder, "tools/call", {
          name: "game_recipe_get",
          arguments: { id: "loop.platformer" },
        }).pipe(Effect.flatMap((response) => response.text));
        expect(builderGet).toContain('"engine":"godot"');
        expect(builderGet).toContain("func snapshot() -> Dictionary:");
        expect(builderGet).toContain('"tryInput"');
        expect(builderGet).toContain('"kind":"write-original"');
        expect(builderGet).toContain("Build a move, jump, collect and retry platformer");
        // A repairer reads the guidance for the defect it is fixing, with no code.
        const repairSearch = yield* rpc("repairer", repairer, "tools/call", {
          name: "game_recipe_search",
          arguments: { defect: "weak-impact" },
        }).pipe(Effect.flatMap((response) => response.text));
        expect(repairSearch).toContain('"id":"feel.hit-stop"');
        expect(repairSearch).toContain('"id":"feel.shake"');
        const repairGuidance = yield* rpc("repairer", repairer, "tools/call", {
          name: "game_recipe_get",
          arguments: { id: "feel.hit-stop", includeReference: false },
        }).pipe(Effect.flatMap((response) => response.text));
        expect(repairGuidance).toContain('"adapter":null');
        expect(repairGuidance).toContain("Hold only the two bodies of an impact");
        expect(repairGuidance).toContain('"version":1');
        // A critic may retrieve guidance and cite it, but gets no reference by default
        // when it asks for guidance only.
        const criticSearch = yield* rpc("critic", critic, "tools/call", {
          name: "game_recipe_search",
          arguments: { mechanic: "impact" },
        }).pipe(Effect.flatMap((response) => response.text));
        expect(criticSearch).toContain('"id":"feel.hit-stop"');
        expect(criticSearch).toContain('"id":"feel.shake"');
        const criticGuidance = yield* rpc("critic", critic, "tools/call", {
          name: "game_recipe_get",
          arguments: { id: "read.silhouette", includeReference: false },
        }).pipe(Effect.flatMap((response) => response.text));
        expect(criticGuidance).toContain("walkable edge and the objective");
        expect(criticGuidance).toContain('"adapter":null');
        // The exact unknown-id reason names the alternatives.
        const unknownRecipe = yield* rpc("builder", builder, "tools/call", {
          name: "game_recipe_get",
          arguments: { id: "loop.missing" },
        }).pipe(Effect.flatMap((response) => response.text));
        expect(unknownRecipe).toContain("No recipe with id 'loop.missing'. Available ids:");
        expect(unknownRecipe).toContain("loop.platformer");
        const experiment = yield* rpc("critic", critic, "tools/call", {
          name: "game_try_input",
          arguments: { steps: [{ press: "Space" }] },
        }).pipe(Effect.flatMap((response) => response.text));
        expect(experiment).toContain('"frameId":"try1f2"');
        expect(experiment).toContain('"label":"input 1 after"');
        expect(experiment).toContain('"changedPercent":2');
        expect(experiment).toContain('"type":"image"');
        expect(tried).toHaveLength(2);
        expect(tried[1]).toMatchObject({ caller: { threadId } });
        expect(yield* list("other", other)).not.toContain("game_critic_report");
        const refused = yield* rpc("other", other, "tools/call", {
          name: "game_critic_report",
          arguments: {},
        }).pipe(Effect.flatMap((response) => response.text));
        expect(refused).toContain("error");
        expect(seen).toEqual([]);
        const invalid = yield* rpc("critic", critic, "tools/call", {
          name: "game_critic_report",
          arguments: { defects: [], doNotRegress: "wrong" },
        }).pipe(Effect.flatMap((response) => response.text));
        expect(invalid).toContain("doNotRegress must be an array");
        expect(invalid).toContain('"attemptsRemaining":2');
        const accepted = yield* rpc("critic", critic, "tools/call", {
          name: "game_critic_report",
          arguments: { defects: [], doNotRegress: [] },
        }).pipe(Effect.flatMap((response) => response.text));
        expect(accepted).toContain('"accepted":true');
        expect(seen).toHaveLength(2);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
