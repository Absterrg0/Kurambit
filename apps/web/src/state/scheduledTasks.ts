import { WS_METHODS } from "@kurambit/contracts";
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

export const scheduledTaskUpsert = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:scheduled-tasks:upsert",
  tag: WS_METHODS.scheduledTasksUpsert,
});

export const scheduledTaskSetEnabled = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:scheduled-tasks:set-enabled",
  tag: WS_METHODS.scheduledTasksSetEnabled,
});

export const scheduledTaskDelete = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:scheduled-tasks:delete",
  tag: WS_METHODS.scheduledTasksDelete,
});

export const scheduledTaskRunNow = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:scheduled-tasks:run-now",
  tag: WS_METHODS.scheduledTasksRunNow,
});
