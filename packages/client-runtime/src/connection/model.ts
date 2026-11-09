import { EnvironmentId } from "@kurambit/contracts";
import * as Schema from "effect/Schema";

/**
 * The one server this client talks to: the origin the web UI was served from,
 * or the desktop app's bundled backend.
 */
export class PrimaryConnectionTarget extends Schema.TaggedClass<PrimaryConnectionTarget>()(
  "PrimaryConnectionTarget",
  {
    environmentId: EnvironmentId,
    label: Schema.String,
    httpBaseUrl: Schema.String,
    wsBaseUrl: Schema.String,
  },
) {}

export type ConnectionTarget = PrimaryConnectionTarget;

export interface ConnectionCatalogEntry {
  readonly target: ConnectionTarget;
  readonly enabled: boolean;
  readonly unsupportedReason?: string;
  readonly serverUpdateRequired?: boolean;
}

export type NetworkStatus = "unknown" | "offline" | "online";

export const ConnectionTransientReason = Schema.Literals([
  "network",
  "timeout",
  "transport",
  "endpoint-unavailable",
  "remote-unavailable",
]);
export type ConnectionTransientReason = typeof ConnectionTransientReason.Type;

export const ConnectionBlockedReason = Schema.Literals([
  "authentication",
  "configuration",
  "permission",
  "unsupported",
]);
export type ConnectionBlockedReason = typeof ConnectionBlockedReason.Type;

export class ConnectionTransientError extends Schema.TaggedError<ConnectionTransientError>()(
  "ConnectionTransientError",
  {
    reason: ConnectionTransientReason,
    detail: Schema.String,
    traceId: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class ConnectionBlockedError extends Schema.TaggedError<ConnectionBlockedError>()(
  "ConnectionBlockedError",
  {
    reason: ConnectionBlockedReason,
    detail: Schema.String,
    traceId: Schema.optionalKey(Schema.String),

    serverUpdateRequired: Schema.optionalKey(Schema.Boolean),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export type ConnectionAttemptError = ConnectionTransientError | ConnectionBlockedError;

export interface PreparedHttpAuthorization {
  readonly _tag: "Bearer";
  readonly token: string;
}

export interface PreparedConnection {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly socketUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization | null;
  readonly target: ConnectionTarget;
}

export type SupervisorConnectionPhase =
  | "available"
  | "offline"
  | "connecting"
  | "backoff"
  | "connected"
  | "blocked";

export type ConnectionAttemptStage = "preparing" | "opening" | "synchronizing";

export interface SupervisorConnectionState {
  readonly desired: boolean;
  readonly network: NetworkStatus;
  readonly phase: SupervisorConnectionPhase;
  readonly stage: ConnectionAttemptStage | null;
  readonly attempt: number;
  readonly generation: number;
  readonly lastFailure: ConnectionAttemptError | null;
  readonly retryAt: number | null;
}

export type ConnectionProjectionPhase = "disconnected" | "synchronizing" | "ready";

export function connectionProjectionPhase(
  state: SupervisorConnectionState,
): ConnectionProjectionPhase {
  switch (state.phase) {
    case "connecting":
      return "synchronizing";
    case "connected":
      return "ready";
    case "available":
    case "offline":
    case "backoff":
    case "blocked":
      return "disconnected";
  }
}

export const AVAILABLE_CONNECTION_STATE: SupervisorConnectionState = Object.freeze({
  desired: false,
  network: "unknown",
  phase: "available",
  stage: null,
  attempt: 0,
  generation: 0,
  lastFailure: null,
  retryAt: null,
});
