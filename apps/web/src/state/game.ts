import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
export const gameEnvironment = {
  status: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "game:status",
    tag: WS_METHODS.gameStatus,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  }),
  create: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:create",
    tag: WS_METHODS.gameCreate,
  }),
  open: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:open",
    tag: WS_METHODS.gameOpen,
  }),
  action: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:action",
    tag: WS_METHODS.gameAction,
  }),
  install: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:install",
    tag: WS_METHODS.gameInstall,
  }),
};
