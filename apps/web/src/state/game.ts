import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
export const gameEnvironment = {
  toolchain: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "game:toolchain",
    tag: WS_METHODS.gameToolchainStatus,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  }),
  verify: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:verify",
    tag: WS_METHODS.gameVerify,
  }),
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
  approveDesign: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "game:approveDesign",
    tag: WS_METHODS.gameApproveDesign,
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
