import type {
  GitRunStackedActionResult,
  GitStackedAction,
  VcsStatusResult,
} from "@t3tools/contracts";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";

export type GitActionIconName = "commit" | "push";

export type GitDialogAction = "commit" | "push";

export interface GitActionMenuItem {
  id: "commit" | "push";
  label: string;
  disabled: boolean;
  icon: GitActionIconName;
  kind: "open_dialog";
  dialogAction?: GitDialogAction;
}

export interface GitQuickAction {
  label: string;
  disabled: boolean;
  kind: "run_action" | "run_pull" | "show_hint";
  action?: GitStackedAction;
  hint?: string;
}

export interface DefaultBranchActionDialogCopy {
  title: string;
  description: string;
  continueLabel: string;
}

export interface GitActionProgressPresentation {
  readonly status: string;
  readonly output: string | null;
  readonly startedAtMs: number | null;
}

export interface GitActionResultToastTiming {
  readonly timeout: 0;
  readonly dismissAfterVisibleMs: number | null;
}

export type DefaultBranchConfirmableAction = "push" | "commit_push";

export const GIT_ACTION_SUCCESS_VISIBLE_MS = 10_000;

export function resolveGitActionResultToastTiming(
  type: "error" | "success",
): GitActionResultToastTiming {
  return {
    timeout: 0,
    dismissAfterVisibleMs: type === "success" ? GIT_ACTION_SUCCESS_VISIBLE_MS : null,
  };
}

export function resolveGitActionProgressPresentation(input: {
  readonly isRunning: boolean;
  readonly operation: string | null;
  readonly currentLabel: string | null;
  readonly lastOutputLine: string | null;
  readonly phaseStartedAtMs: number | null;
  readonly hookStartedAtMs: number | null;
}): GitActionProgressPresentation | null {
  if (
    !input.isRunning ||
    (input.operation !== "run_change_request" && input.operation !== "pull")
  ) {
    return null;
  }

  const currentLabel = input.currentLabel?.trim();
  const output = input.lastOutputLine?.trim();
  const isPull = input.operation === "pull";
  return {
    status:
      currentLabel && currentLabel !== "Running source control action"
        ? currentLabel
        : isPull
          ? "Pulling latest changes..."
          : "Starting source control action...",
    output: !isPull && output ? output : null,
    startedAtMs: isPull
      ? input.phaseStartedAtMs
      : (input.hookStartedAtMs ?? input.phaseStartedAtMs),
  };
}

export function formatGitActionElapsed(startedAtMs: number | null, nowMs: number): string | null {
  if (startedAtMs === null) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export function buildMenuItems(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  hasPrimaryRemote = true,
): GitActionMenuItem[] {
  if (!gitStatus) return [];
  return [
    {
      id: "commit",
      label: "Commit",
      disabled: isBusy || !gitStatus.hasWorkingTreeChanges,
      icon: "commit",
      kind: "open_dialog",
      dialogAction: "commit",
    },
    ...(hasPrimaryRemote
      ? [
          {
            id: "push" as const,
            label: "Push",
            disabled:
              isBusy ||
              gitStatus.refName === null ||
              gitStatus.behindCount > 0 ||
              gitStatus.aheadCount === 0,
            icon: "push" as const,
            kind: "open_dialog" as const,
            dialogAction: "push" as const,
          },
        ]
      : []),
  ];
}

export function resolveQuickAction(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  _isDefaultRef = false,
  hasPrimaryRemote = true,
): GitQuickAction {
  if (isBusy || !gitStatus)
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: isBusy ? "Git action in progress." : "Git status is unavailable.",
    };
  if (gitStatus.hasWorkingTreeChanges)
    return { label: "Commit", disabled: false, kind: "run_action", action: "commit" };
  if (gitStatus.refName === null)
    return {
      label: "Push",
      disabled: true,
      kind: "show_hint",
      hint: "Check out a branch before pushing.",
    };
  if (!hasPrimaryRemote)
    return {
      label: "Push",
      disabled: true,
      kind: "show_hint",
      hint: "Add a Git remote before pushing.",
    };
  if (gitStatus.aheadCount > 0 && gitStatus.behindCount > 0)
    return {
      label: "Sync ref",
      disabled: true,
      kind: "show_hint",
      hint: "Branch has diverged from upstream. Rebase/merge first.",
    };
  if (gitStatus.behindCount > 0) return { label: "Pull", disabled: false, kind: "run_pull" };
  if (gitStatus.aheadCount > 0)
    return { label: "Push", disabled: false, kind: "run_action", action: "push" };
  return {
    label: "Commit",
    disabled: true,
    kind: "show_hint",
    hint: "Branch is up to date. No action needed.",
  };
}

export function requiresDefaultBranchConfirmation(
  action: GitStackedAction,
  isDefaultRef: boolean,
): boolean {
  if (!isDefaultRef) return false;
  return action === "push" || action === "commit_push";
}

export function resolveDefaultBranchActionDialogCopy(input: {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
}): DefaultBranchActionDialogCopy {
  const branchLabel = input.branchName;
  const suffix = ` on "${branchLabel}". You can continue on this ref or create a feature ref and run the same action there.`;
  if (input.includesCommit) {
    return {
      title: "Commit & push to default ref?",
      description: `This action will commit and push changes${suffix}`,
      continueLabel: `Commit & push to ${branchLabel}`,
    };
  }
  return {
    title: "Push to default ref?",
    description: `This action will push local commits${suffix}`,
    continueLabel: `Push to ${branchLabel}`,
  };
}

export function resolveThreadBranchUpdate(
  result: GitRunStackedActionResult,
): { branch: string } | null {
  if (result.branch.status !== "created" || !result.branch.name) {
    return null;
  }

  return {
    branch: result.branch.name,
  };
}

export function resolveThreadBranchMetadataPatch(
  branch: string | null,
  expectedBranch: string | null,
): {
  branch: string | null;
  expectedBranch: string | null;
} {
  return { branch, expectedBranch };
}

export function resolveLiveThreadBranchUpdate(input: {
  threadBranch: string | null;
  gitStatus: VcsStatusResult | null;
}): { branch: string | null } | null {
  if (!input.gitStatus) {
    return null;
  }

  if (input.gitStatus.refName === null && input.threadBranch !== null) {
    return null;
  }

  if (input.threadBranch === input.gitStatus.refName) {
    return null;
  }

  if (
    input.threadBranch !== null &&
    input.gitStatus.refName !== null &&
    !isTemporaryWorktreeBranch(input.threadBranch) &&
    isTemporaryWorktreeBranch(input.gitStatus.refName)
  ) {
    return null;
  }

  return {
    branch: input.gitStatus.refName,
  };
}

export { resolveAutoFeatureBranchName } from "@t3tools/shared/git";
