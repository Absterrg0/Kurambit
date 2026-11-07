import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.gameCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.gameOpen]: AuthOrchestrationOperateScope,
  [WS_METHODS.gameAction]: AuthOrchestrationOperateScope,
  [WS_METHODS.gameKeepGoing]: AuthOrchestrationOperateScope,
  [WS_METHODS.gameKeepGoingDecide]: AuthOrchestrationOperateScope,
  [WS_METHODS.gameWindowsPackage]: AuthOrchestrationOperateScope,
  [WS_METHODS.gameWebPackage]: AuthOrchestrationOperateScope,
  [WS_METHODS.gameMediaSave]: AuthOrchestrationOperateScope,
  [WS_METHODS.gameSavedDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.gameBuildMeasure]: AuthOrchestrationOperateScope,
  [WS_METHODS.gameBuildPlay]: AuthOrchestrationOperateScope,
  [WS_METHODS.gameBuildRestore]: AuthOrchestrationOperateScope,
  [WS_METHODS.gameBuildStop]: AuthOrchestrationOperateScope,
  [WS_METHODS.gameToolchainInstall]: AuthSettingsWriteScope,
  [WS_METHODS.gameToolchainRemove]: AuthSettingsWriteScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,
  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

export function clientRpcRequiredScopes(method: string): readonly AuthEnvironmentScope[] {
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
