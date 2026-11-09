import { EnvironmentId, ORCHESTRATION_PROTOCOL_VERSION } from "@kurambit/contracts";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ConnectionResolver from "./resolver.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import { type ConnectionCatalogEntry, PrimaryConnectionTarget } from "./model.ts";
import * as RpcHttp from "../rpc/http.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

function catalogEntry(target: PrimaryConnectionTarget): ConnectionCatalogEntry {
  return { target, enabled: true };
}

const makeDependencies = Effect.fn("TestConnectionResolver.makeDependencies")((options?: {
  readonly primaryBearerToken?: string;
  readonly descriptorProtocolVersion?: number | null | undefined;
  readonly requests?: Array<{ readonly url: string; readonly authorization: string | null }>;
}) => {
  const layerDependencies = Layer.mergeAll(
    RpcHttp.layerRemoteHttpClient(((input, init) => {
      const url = String(input);
      options?.requests?.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (url.endsWith("/api/auth/websocket-ticket")) {
        return Promise.resolve(
          Response.json({ ticket: "desktop", expiresAt: "2026-06-06T01:00:00.000Z" }),
        );
      }
      return Promise.resolve(
        Response.json({
          environmentId: ENVIRONMENT_ID,
          label: "Compatible environment",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0-test",
          ...(options?.descriptorProtocolVersion === undefined
            ? { orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION }
            : options.descriptorProtocolVersion === null
              ? {}
              : { orchestrationProtocolVersion: options.descriptorProtocolVersion }),
          capabilities: { repositoryIdentity: true },
        }),
      );
    }) satisfies typeof fetch),
    Layer.succeed(
      ClientCapabilities.PrimaryEnvironmentAuth,
      ClientCapabilities.PrimaryEnvironmentAuth.of({
        bearerToken: Effect.succeed(Option.fromNullishOr(options?.primaryBearerToken)),
      }),
    ),
    Layer.succeed(
      ClientCapabilities.ClientPresentation,
      ClientCapabilities.ClientPresentation.of({
        metadata: { label: "Test Client", deviceType: "desktop", surface: "web" },
      }),
    ),
  );

  return Effect.succeed(ConnectionResolver.layer.pipe(Layer.provide(layerDependencies)));
});

describe("ConnectionResolver", () => {
  it.effect("blocks an old host during discovery before opening orchestration RPC", () =>
    Effect.gen(function* () {
      const layerBroker = yield* makeDependencies({ descriptorProtocolVersion: null });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));
      const target = new PrimaryConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        wsBaseUrl: "ws://127.0.0.1:3777",
      });

      const error = yield* Effect.flip(broker.prepare(catalogEntry(target)));

      expect(error).toMatchObject({ reason: "unsupported" });
      expect(error.message).toContain("Update Kurambit on Compatible environment");
    }),
  );

  it.effect("blocks an incompatible host during discovery before opening orchestration RPC", () =>
    Effect.gen(function* () {
      const layerBroker = yield* makeDependencies({
        descriptorProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION + 1,
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));
      const target = new PrimaryConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        wsBaseUrl: "ws://127.0.0.1:3777",
      });

      const error = yield* Effect.flip(broker.prepare(catalogEntry(target)));

      expect(error).toMatchObject({ reason: "unsupported" });
      expect(error.message).toContain("This client is not supported");
    }),
  );

  it.effect("prepares a primary environment without remote capabilities", () =>
    Effect.gen(function* () {
      const layerBroker = yield* makeDependencies();
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));
      const target = new PrimaryConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        wsBaseUrl: "ws://127.0.0.1:3777",
      });

      expect(yield* broker.prepare(catalogEntry(target))).toEqual({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        socketUrl:
          "ws://127.0.0.1:3777/ws?clientSurface=web&clientDeviceType=desktop&connectionMethod=direct&orchestrationProtocol=2",
        httpAuthorization: null,
        target,
      });
    }),
  );

  it.effect("authorizes a desktop primary environment with its platform bearer token", () =>
    Effect.gen(function* () {
      const requests: Array<{ readonly url: string; readonly authorization: string | null }> = [];
      const layerBroker = yield* makeDependencies({
        primaryBearerToken: "desktop-bearer",
        requests,
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));
      const target = new PrimaryConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        wsBaseUrl: "ws://127.0.0.1:3777",
      });

      expect(yield* broker.prepare(catalogEntry(target))).toMatchObject({
        socketUrl:
          "ws://127.0.0.1:3777/ws?wsTicket=desktop&clientSurface=web&clientDeviceType=desktop&connectionMethod=direct&orchestrationProtocol=2",
        httpAuthorization: { _tag: "Bearer", token: "desktop-bearer" },
        target,
      });
      expect(requests.at(-1)).toEqual({
        url: "http://127.0.0.1:3777/api/auth/websocket-ticket",
        authorization: "Bearer desktop-bearer",
      });
    }),
  );
});
