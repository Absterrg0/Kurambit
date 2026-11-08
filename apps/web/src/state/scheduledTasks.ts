import { type EnvironmentId, WS_METHODS } from "@kurambit/contracts";
import type { AtomRegistry } from "effect/reactivity";
import * as Effect from "effect/Effect";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@kurambit/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const scheduledTaskListQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:scheduled-tasks:list",
  tag: WS_METHODS.scheduledTasksList,
  staleTimeMs: 15_000,
  idleTtlMs: 5 * 60_000,
});

// Every change reads the list again, so the page never shows a task as it was.
const refreshList = (
  target: { readonly environmentId: EnvironmentId },
  registry: AtomRegistry.AtomRegistry,
) =>
  Effect.sync(() =>
    registry.refresh(scheduledTaskListQuery({ environmentId: target.environmentId, input: {} })),
  );

export const scheduledTaskUpsert = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:scheduled-tasks:upsert",
  tag: WS_METHODS.scheduledTasksUpsert,
  onSuccess: refreshList,
});

export const scheduledTaskSetEnabled = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:scheduled-tasks:set-enabled",
  tag: WS_METHODS.scheduledTasksSetEnabled,
  onSuccess: refreshList,
});

export const scheduledTaskDelete = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:scheduled-tasks:delete",
  tag: WS_METHODS.scheduledTasksDelete,
  onSuccess: refreshList,
});

export const scheduledTaskRunNow = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:scheduled-tasks:run-now",
  tag: WS_METHODS.scheduledTasksRunNow,
  onSuccess: refreshList,
});
