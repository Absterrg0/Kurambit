import {
  ClientCapabilities,
  PlatformConnectionSource,
  Persistence,
} from "@kurambit/client-runtime/platform";
import {
  ConnectionTransientError,
  Connectivity,
  mapRemoteEnvironmentError,
  PrimaryConnectionTarget,
  Wakeups,
} from "@kurambit/client-runtime/connection";

import { fetchRemoteEnvironmentDescriptor } from "@kurambit/client-runtime/environment";
import { EnvironmentRpcRequestObserver } from "@kurambit/client-runtime/rpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";

import { APP_VERSION } from "../branding";
import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import * as PrimaryEnvironmentHttpLayer from "../environments/primary/httpLayer";
import {
  readPrimaryEnvironmentTarget,
  type PrimaryEnvironmentTarget,
} from "../environments/primary/target";
import { clearComposerDraftsEnvironment } from "../composerDraftStore";
import { isLocalEnvironmentDisabled } from "../localEnvironment";

import { acknowledgeRpcRequest, trackRpcRequestSent } from "../rpc/requestLatencyState";
import * as ConnectionStorage from "./storage";
import { clientPresentationMetadata } from "./clientMetadata";

let nextObservedRpcRequestId = 0;

function currentNetworkStatus(): "unknown" | "offline" | "online" {
  if (typeof navigator === "undefined") {
    return "unknown";
  }
  return navigator.onLine ? "online" : "offline";
}

const layerConnectivity = Connectivity.layer({
  status: Effect.sync(currentNetworkStatus),
  changes: Stream.callback((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const online = () => Queue.offerUnsafe(queue, "online");
        const offline = () => Queue.offerUnsafe(queue, "offline");
        window.addEventListener("online", online);
        window.addEventListener("offline", offline);
        return { online, offline };
      }),
      ({ online, offline }) =>
        Effect.sync(() => {
          window.removeEventListener("online", online);
          window.removeEventListener("offline", offline);
        }),
    ).pipe(Effect.asVoid),
  ),
});

interface NetworkInformationLike extends EventTarget {
  readonly type?: string;
}

/**
 * `change` also fires for bandwidth and latency estimates on the same network,
 * so only a type change counts.
 */
const networkPathChanges = Stream.callback<"network-changed">((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const connection =
        typeof navigator === "undefined"
          ? undefined
          : (navigator as Navigator & { readonly connection?: NetworkInformationLike }).connection;
      if (connection?.type === undefined) return undefined;
      let previous = connection.type;
      const listener = () => {
        const type = connection.type;
        if (type === undefined || type === previous) return;
        previous = type;
        Queue.offerUnsafe(queue, "network-changed");
      };
      connection.addEventListener("change", listener);
      return { connection, listener };
    }),
    (subscription) =>
      Effect.sync(() =>
        subscription?.connection.removeEventListener("change", subscription.listener),
      ),
  ).pipe(Effect.asVoid),
);

const layerWakeups = Wakeups.layer({
  changes: Stream.mergeAll(
    [
      Stream.callback<"application-active">((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const listener = () => {
              if (document.visibilityState === "visible") {
                Queue.offerUnsafe(queue, "application-active");
              }
            };
            document.addEventListener("visibilitychange", listener);
            return listener;
          }),
          (listener) =>
            Effect.sync(() => {
              document.removeEventListener("visibilitychange", listener);
            }),
        ).pipe(Effect.asVoid),
      ),
      networkPathChanges,
    ],
    { concurrency: "unbounded" },
  ),
});

function clientMetadata() {
  return clientPresentationMetadata({
    appVersion: APP_VERSION,
    hosted: false,
    identity: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
    },
    desktopBridge: window.desktopBridge,
  });
}

const layerCapabilities = Layer.effectContext(
  Effect.sync(() => {
    const presentation = ClientCapabilities.ClientPresentation.of({
      metadata: clientMetadata(),
    });
    const primaryAuth = ClientCapabilities.PrimaryEnvironmentAuth.of({
      bearerToken: Effect.tryPromise({
        try: readDesktopPrimaryBearerToken,
        catch: (cause) =>
          new ConnectionTransientError({
            reason: "remote-unavailable",
            detail: `Could not load the desktop primary credential: ${String(cause)}`,
          }),
      }).pipe(Effect.map(Option.fromNullishOr)),
    });
    return Context.make(ClientCapabilities.PrimaryEnvironmentAuth, primaryAuth).pipe(
      Context.add(ClientCapabilities.ClientPresentation, presentation),
    );
  }),
);

const loadPrimaryConnectionTarget = Effect.fn("web.connectionPlatform.loadPrimaryConnectionTarget")(
  function* (resolved: PrimaryEnvironmentTarget) {
    const descriptor = yield* fetchRemoteEnvironmentDescriptor({
      httpBaseUrl: resolved.target.httpBaseUrl,
    }).pipe(
      Effect.provide(PrimaryEnvironmentHttpLayer.layer),
      Effect.mapError(mapRemoteEnvironmentError),
    );
    return new PrimaryConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: resolved.target.httpBaseUrl,
      wsBaseUrl: resolved.target.wsBaseUrl,
    });
  },
);

// The desktop bridge has no change event for the backend's address, so the
// renderer polls. A discovered target is reused while its address is unchanged.
const PLATFORM_POLL_INTERVAL = "3 seconds";

interface CachedPrimaryTarget {
  readonly signature: string;
  readonly target: PrimaryConnectionTarget;
}

export type PrimaryEnvironmentTargetRead =
  | {
      readonly _tag: "Success";
      readonly target: PrimaryEnvironmentTarget | null;
    }
  | {
      readonly _tag: "Failure";
      readonly cause: unknown;
    };

export function readPrimaryEnvironmentTargetResult(
  readTarget: () => PrimaryEnvironmentTarget | null = readPrimaryEnvironmentTarget,
): PrimaryEnvironmentTargetRead {
  try {
    return { _tag: "Success", target: readTarget() };
  } catch (cause) {
    return { _tag: "Failure", cause };
  }
}

/** A failed read keeps the last target; a successful read that finds none removes it. */
export function primaryToRetainAfterTopologyRead(
  previous: CachedPrimaryTarget | undefined,
  topologyRead: PrimaryEnvironmentTargetRead,
): CachedPrimaryTarget | undefined {
  return topologyRead._tag === "Failure" ? previous : undefined;
}

const layerPlatformConnectionSource = Layer.effect(
  PlatformConnectionSource.PlatformConnectionSource,
  Effect.gen(function* () {
    if (isLocalEnvironmentDisabled()) {
      return PlatformConnectionSource.PlatformConnectionSource.of({ primary: Stream.empty });
    }
    const cacheRef = yield* Ref.make<CachedPrimaryTarget | undefined>(undefined);

    const readPrimary = Effect.gen(function* () {
      const previous = yield* Ref.get(cacheRef);
      const topologyRead = readPrimaryEnvironmentTargetResult();
      let next = primaryToRetainAfterTopologyRead(previous, topologyRead);
      if (topologyRead._tag === "Failure") {
        yield* Effect.logWarning("Could not read the primary environment topology.", {
          cause: topologyRead.cause,
        });
      } else if (topologyRead.target !== null) {
        const primaryTarget = topologyRead.target;
        const signature = `${primaryTarget.target.httpBaseUrl}|${primaryTarget.target.wsBaseUrl}`;
        if (previous?.signature === signature) {
          next = previous;
        } else {
          const built = yield* loadPrimaryConnectionTarget(primaryTarget).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Could not discover the primary environment.", { error }),
            ),
            Effect.option,
          );
          next = Option.isSome(built) ? { signature, target: built.value } : undefined;
        }
      }
      yield* Ref.set(cacheRef, next);
      return Option.fromUndefinedOr(next?.target);
    }).pipe(Effect.provide(FetchHttpClient.layer));

    return PlatformConnectionSource.PlatformConnectionSource.of({
      primary: Stream.tick(PLATFORM_POLL_INTERVAL).pipe(Stream.mapEffect(() => readPrimary)),
    });
  }),
);

const layerEnvironmentOwnedDataCleanup = Layer.succeed(
  Persistence.EnvironmentOwnedDataCleanup,
  Persistence.EnvironmentOwnedDataCleanup.of({
    clear: (environmentId) =>
      Effect.sync(() => {
        clearComposerDraftsEnvironment(environmentId);
      }),
  }),
);

const layerRpcRequestObserver = Layer.succeed(
  EnvironmentRpcRequestObserver,
  EnvironmentRpcRequestObserver.of({
    observe: ({ environmentId, method }) =>
      Effect.sync(() => {
        nextObservedRpcRequestId += 1;
        const requestId = `${environmentId}:${nextObservedRpcRequestId}`;
        trackRpcRequestSent(requestId, method, `${method} · ${environmentId}`);
        return Effect.sync(() => {
          acknowledgeRpcRequest(requestId);
        });
      }),
  }),
);

type ConnectionPlatformLayerSource =
  | typeof ConnectionStorage.layer
  | typeof layerConnectivity
  | typeof layerWakeups
  | typeof layerCapabilities
  | typeof layerPlatformConnectionSource
  | typeof layerEnvironmentOwnedDataCleanup
  | typeof layerRpcRequestObserver;

export const layer: Layer.Layer<
  Layer.Success<ConnectionPlatformLayerSource>,
  Layer.Error<ConnectionPlatformLayerSource>,
  Layer.Services<ConnectionPlatformLayerSource>
> = Layer.mergeAll(
  ConnectionStorage.layer,
  layerConnectivity,
  layerWakeups,
  layerCapabilities,
  layerPlatformConnectionSource,
  layerEnvironmentOwnedDataCleanup,
  layerRpcRequestObserver,
);
