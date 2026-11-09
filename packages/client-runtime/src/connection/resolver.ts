import type { AuthClientPresentationMetadata } from "@kurambit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as HttpClient from "effect/http/HttpClient";

import {
  appendClientConnectionParams,
  resolveRemoteWebSocketConnectionUrl,
} from "../authorization/remote.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";

import { environmentMismatchError, mapRemoteEnvironmentError } from "./errors.ts";

import type {
  ConnectionAttemptError,
  ConnectionCatalogEntry,
  PreparedConnection,
  PrimaryConnectionTarget,
} from "./model.ts";

import {
  appendOrchestrationProtocol,
  orchestrationProtocolCompatibilityError,
} from "./compatibility.ts";

import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";

export class ConnectionResolver extends Context.Service<
  ConnectionResolver,
  {
    readonly prepare: (
      entry: ConnectionCatalogEntry,
    ) => Effect.Effect<PreparedConnection, ConnectionAttemptError>;
  }
>()("@kurambit/client-runtime/connection/resolver/ConnectionResolver") {}

function cookieSocketUrl(
  target: PrimaryConnectionTarget,
  clientMetadata: AuthClientPresentationMetadata | undefined,
): string {
  const url = new URL(target.wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/ws";
  }
  appendClientConnectionParams(url, clientMetadata, "direct");
  return url.toString();
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const auth = yield* ClientCapabilities.PrimaryEnvironmentAuth;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const httpClient = yield* HttpClient.HttpClient;

  const prepare = Effect.fn("clientRuntime.connection.resolver.prepare")(function* (
    entry: ConnectionCatalogEntry,
  ) {
    const target = entry.target;
    yield* Effect.annotateCurrentSpan({ "connection.environment.id": target.environmentId });
    const descriptor = yield* fetchRemoteEnvironmentDescriptor({
      httpBaseUrl: target.httpBaseUrl,
    }).pipe(
      Effect.mapError(mapRemoteEnvironmentError),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    // The local server's id changes when it starts with a different home.
    if (descriptor.environmentId !== target.environmentId) {
      return yield* environmentMismatchError({
        expected: target.environmentId,
        actual: descriptor.environmentId,
      });
    }
    const compatibilityError = orchestrationProtocolCompatibilityError(descriptor);
    if (compatibilityError !== null) {
      return yield* compatibilityError;
    }

    // The web UI rides the session cookie of the origin that served it. The
    // desktop app holds a bearer token for its bundled backend, and a socket
    // cannot carry that header, so each upgrade gets a fresh ticket.
    const bearerToken = yield* auth.bearerToken;
    const socketUrl = Option.isNone(bearerToken)
      ? cookieSocketUrl(target, presentation.metadata)
      : yield* resolveRemoteWebSocketConnectionUrl({
          wsBaseUrl: target.wsBaseUrl,
          httpBaseUrl: target.httpBaseUrl,
          bearerToken: bearerToken.value,
          clientMetadata: presentation.metadata,
          connectionMethod: "direct",
        }).pipe(
          Effect.mapError(mapRemoteEnvironmentError),
          Effect.provideService(HttpClient.HttpClient, httpClient),
        );
    return {
      environmentId: target.environmentId,
      label: target.label,
      httpBaseUrl: target.httpBaseUrl,
      socketUrl: appendOrchestrationProtocol(socketUrl),
      httpAuthorization: Option.isNone(bearerToken)
        ? null
        : { _tag: "Bearer" as const, token: bearerToken.value },
      target,
    } satisfies PreparedConnection;
  });

  return ConnectionResolver.of({ prepare });
});

export const layer = Layer.effect(ConnectionResolver, make);
