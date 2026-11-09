import {
  AVAILABLE_CONNECTION_STATE,
  connectionProjectionPhase,
} from "@kurambit/client-runtime/connection";
import {
  createEnvironmentShellAtoms,
  createEnvironmentSnapshotAtom,
  createShellEnvironmentAtoms,
  type EnvironmentShellState,
  type EnvironmentShellStatus,
} from "@kurambit/client-runtime/state/shell";
import {
  type EnvironmentCatalogState,
  enabledEnvironmentIds,
} from "@kurambit/client-runtime/state/connections";
import type { EnvironmentId } from "@kurambit/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";

export const shellEnvironment = createShellEnvironmentAtoms(connectionAtomRuntime);
export const environmentShell = createEnvironmentShellAtoms(connectionAtomRuntime);
export const environmentSnapshotAtom = createEnvironmentSnapshotAtom(environmentShell.stateAtom);

const NO_SHELL_STATUS_ATOM = Atom.make<EnvironmentShellStatus | null>(null).pipe(
  Atom.withLabel("web-environment-shell-status:none"),
);
const NO_SHELL_SNAPSHOT_ATOM = Atom.make(false).pipe(
  Atom.withLabel("web-environment-shell-has-snapshot:none"),
);

export function useEnvironmentShellStatus(
  environmentId: EnvironmentId | null,
): EnvironmentShellStatus | null {
  return useAtomValue(
    environmentId === null ? NO_SHELL_STATUS_ATOM : environmentShell.statusAtom(environmentId),
  );
}

export function useEnvironmentShellHasSnapshot(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(
    environmentId === null
      ? NO_SHELL_SNAPSHOT_ATOM
      : environmentShell.hasSnapshotAtom(environmentId),
  );
}

export const allEnvironmentShellsBootstrappedAtom = Atom.make((get) => {
  const catalog = AsyncResult.value(get(environmentCatalog.catalogAtom));
  if (Option.isNone(catalog)) {
    return false;
  }
  for (const environmentId of enabledEnvironmentIds(catalog.value)) {
    if (Option.isSome(get(environmentShell.stateValueAtom(environmentId)).snapshot)) {
      continue;
    }
    const connection = Option.getOrElse(
      AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
      () => AVAILABLE_CONNECTION_STATE,
    );
    if (connectionProjectionPhase(connection) !== "disconnected") {
      return false;
    }
    if (connection.phase === "backoff" && connection.desired && connection.attempt <= 2) {
      return false;
    }
  }
  return true;
}).pipe(Atom.withLabel("web-all-environment-shells-bootstrapped"));

/**
 * The catalog emits before platform discovery registers the local server, so
 * an empty catalog does not prove a project is absent.
 */
function catalogIsComplete(catalog: EnvironmentCatalogState): boolean {
  return catalog.isReady && catalog.entries.size > 0;
}

export function createAllEnvironmentProjectSnapshotsReadyAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly shellStateValueAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>;
}) {
  return Atom.make((get) => {
    const catalog = get(input.catalogValueAtom);
    if (!catalogIsComplete(catalog)) return false;
    for (const environmentId of enabledEnvironmentIds(catalog)) {
      const shell = get(input.shellStateValueAtom(environmentId));
      if (shell.status !== "live" || Option.isNone(shell.snapshot)) return false;
    }
    return true;
  }).pipe(Atom.withLabel("web-all-environment-project-snapshots-ready"));
}

export const allEnvironmentProjectSnapshotsReadyAtom =
  createAllEnvironmentProjectSnapshotsReadyAtom({
    catalogValueAtom: environmentCatalog.catalogValueAtom,
    shellStateValueAtom: environmentShell.stateValueAtom,
  });

export const allReachableShellsLiveAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  if (!catalogIsComplete(catalog)) return false;
  for (const environmentId of enabledEnvironmentIds(catalog)) {
    const shell = get(environmentShell.stateValueAtom(environmentId));
    if (shell.status === "live" && Option.isSome(shell.snapshot)) continue;
    const state = AsyncResult.value(get(environmentCatalog.stateAtom(environmentId)));
    if (Option.isNone(state)) return false;
    const connection = state.value;
    const settledOffline =
      connection.phase === "offline" ||
      connection.phase === "blocked" ||
      (connection.phase === "backoff" && connection.attempt > 2);
    if (!settledOffline) return false;
  }
  return true;
}).pipe(Atom.withLabel("web-all-reachable-shells-live"));
