import type {
  AuthClientPresentationMetadata,
  ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";

import { appendClientConnectionParams } from "../authorization/remote.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  SshConnectionProfile,
} from "./catalog.ts";

import { environmentMismatchError, mapRemoteEnvironmentError } from "./errors.ts";

import type { ConnectionTarget, PreparedConnection, PrimaryConnectionTarget } from "./model.ts";
import { ConnectionBlockedError, type ConnectionAttemptError } from "./model.ts";

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
    /**
     * Authorizes a socket without the orchestration protocol gate, for hosts
     * too old to connect normally. Only update RPCs may run over it.
     */
    readonly prepareForUpdate: (entry: ConnectionCatalogEntry) => Effect.Effect<
      {
        readonly prepared: PreparedConnection;
        readonly descriptor: ExecutionEnvironmentDescriptor;
      },
      ConnectionAttemptError
    >;
  }
>()("@t3tools/client-runtime/connection/resolver/ConnectionResolver") {}

const isBearerProfile = Schema.is(BearerConnectionProfile);
const isSshProfile = Schema.is(SshConnectionProfile);
const isBearerCredential = Schema.is(BearerConnectionCredential);

function primarySocketUrl(
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

const makePrimaryBroker = Effect.fn("clientRuntime.connection.broker.makePrimary")(function* () {
  const auth = yield* ClientCapabilities.PrimaryEnvironmentAuth;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

  return Effect.fn("clientRuntime.connection.broker.primary")(function* (
    target: PrimaryConnectionTarget,
  ) {
    const bearerToken = yield* auth.bearerToken;
    if (Option.isNone(bearerToken)) {
      return {
        environmentId: target.environmentId,
        label: target.label,
        httpBaseUrl: target.httpBaseUrl,
        socketUrl: primarySocketUrl(target, presentation.metadata),
        httpAuthorization: null,
        target,
      } satisfies PreparedConnection;
    }

    const authorized = yield* remote.authorizeBearer({
      expectedEnvironmentId: target.environmentId,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
      bearerToken: bearerToken.value,
      connectionMethod: "direct",
    });
    return {
      ...authorized,
      target,
    } satisfies PreparedConnection;
  });
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const primary = yield* makePrimaryBroker();
  const httpClient = yield* HttpClient.HttpClient;

  const authorize = Effect.fn("clientRuntime.connection.broker.authorize")(function* (
    entry: ConnectionCatalogEntry,
  ) {
    const target: ConnectionTarget = entry.target;
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": target.environmentId,
      "connection.target.kind": target._tag,
    });
    const prepared = yield* (() => {
      switch (target._tag) {
        case "PrimaryConnectionTarget":
          return primary(target);
        default:
          return Effect.fail(
            new ConnectionBlockedError({
              reason: "configuration",
              detail: "Game Studio connects only to its local server.",
            }),
          );
      }
    })();
    const descriptor = yield* fetchRemoteEnvironmentDescriptor({
      httpBaseUrl: prepared.httpBaseUrl,
    }).pipe(
      Effect.mapError(mapRemoteEnvironmentError),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    if (descriptor.environmentId !== target.environmentId) {
      return yield* environmentMismatchError({
        expected: target.environmentId,
        actual: descriptor.environmentId,
      });
    }
    return { prepared, descriptor };
  });

  const prepare = Effect.fn("clientRuntime.connection.broker.prepare")(function* (
    entry: ConnectionCatalogEntry,
  ) {
    const { prepared, descriptor } = yield* authorize(entry);
    const compatibilityError = orchestrationProtocolCompatibilityError(descriptor);
    if (compatibilityError !== null) {
      return yield* compatibilityError;
    }
    return {
      ...prepared,
      socketUrl: appendOrchestrationProtocol(prepared.socketUrl),
    };
  });

  return ConnectionResolver.of({ prepare, prepareForUpdate: authorize });
});

export const layer = Layer.effect(ConnectionResolver, make);
