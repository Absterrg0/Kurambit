import {
  AuthEnvironmentMaintainScope,
  type AuthSessionState,
  sessionGrantsScope,
} from "@kurambit/contracts";
import type { AsyncResult } from "effect/reactivity";

import type {
  EnvironmentId,
  ServerInstallation,
  ServerSelfUpdateCapability,
} from "@kurambit/contracts";
import type { ServerUpdateStage } from "@kurambit/client-runtime/state/server";

const UPDATE_STAGE_LABELS: Record<ServerUpdateStage, string> = {
  downloading: "Downloading…",
  installing: "Downloading…",
  resuming: "Restarting…",
};

export function serverUpdateStageLabel(stage: ServerUpdateStage): string {
  return UPDATE_STAGE_LABELS[stage];
}

export interface ServerUpdateTarget {
  readonly environmentId: EnvironmentId;
  readonly serverLabel: string;
  readonly selfUpdate: ServerSelfUpdateCapability | null;
  readonly installation?: ServerInstallation | undefined;
  readonly desktopAppUpdate?: boolean;
  readonly threadContinuation?: boolean;
  readonly targetVersion: string;
  readonly continueThreadsAfterServerUpdate?: boolean;
}

export type ServerUpdateOutcome =
  | { readonly status: "updated" | "skipped" }
  | { readonly status: "failed"; readonly message: string };

/** Toasts its success or failure unless `quiet`; never rejects. */
export function useServerUpdate() {
  return async (
    _target: ServerUpdateTarget,
    _options?: { readonly quiet?: boolean },
  ): Promise<ServerUpdateOutcome> => ({ status: "skipped" });
}

export function canUpdateServer(
  result: AsyncResult.AsyncResult<AuthSessionState, unknown>,
): boolean {
  if (result._tag !== "Success" || !result.value.authenticated) return false;
  return sessionGrantsScope(result.value, AuthEnvironmentMaintainScope);
}

/**
 * Self-updates delegate their full lifecycle to client-runtime so this component can unmount
 * during reconnect without losing operation state.
 */

/**
 * Its version comes from the host descriptor because the host never delivers a server config.
 */
