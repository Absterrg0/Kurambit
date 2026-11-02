import type { VcsStatusResult } from "@kurambit/contracts";
import { assert, describe, it } from "vite-plus/test";
import {
  buildMenuItems,
  formatGitActionElapsed,
  requiresDefaultBranchConfirmation,
  resolveAutoFeatureBranchName,
  resolveDefaultBranchActionDialogCopy,
  resolveGitActionProgressPresentation,
  resolveGitActionResultToastTiming,
  resolveLiveThreadBranchUpdate,
  resolveQuickAction,
  resolveThreadBranchUpdate,
  resolveThreadBranchMetadataPatch,
} from "./GitActionsControl.logic";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

describe("git action progress presentation", () => {
  it("keeps the phase on the first row and hook output on the second", () => {
    assert.deepEqual(
      resolveGitActionProgressPresentation({
        isRunning: true,
        operation: "run_change_request",
        currentLabel: "Running pre-commit...",
        lastOutputLine: "Checking formatting and lint rules",
        phaseStartedAtMs: 1_000,
        hookStartedAtMs: 2_000,
      }),
      {
        status: "Running pre-commit...",
        output: "Checking formatting and lint rules",
        startedAtMs: 2_000,
      },
    );
  });

  it("omits empty output and supplies a brief startup label", () => {
    assert.deepEqual(
      resolveGitActionProgressPresentation({
        isRunning: true,
        operation: "run_change_request",
        currentLabel: "Running source control action",
        lastOutputLine: "  ",
        phaseStartedAtMs: 1_000,
        hookStartedAtMs: null,
      }),
      {
        status: "Starting source control action...",
        output: null,
        startedAtMs: 1_000,
      },
    );
  });

  it("presents pull progress inline without a second row", () => {
    assert.deepEqual(
      resolveGitActionProgressPresentation({
        isRunning: true,
        operation: "pull",
        currentLabel: "Pulling latest changes...",
        lastOutputLine: null,
        phaseStartedAtMs: 1_000,
        hookStartedAtMs: null,
      }),
      {
        status: "Pulling latest changes...",
        output: null,
        startedAtMs: 1_000,
      },
    );
  });

  it("does not present unrelated or completed actions", () => {
    const input = {
      isRunning: true,
      operation: "publish_repository",
      currentLabel: "Publishing repository",
      lastOutputLine: null,
      phaseStartedAtMs: 1_000,
      hookStartedAtMs: null,
    };

    assert.isNull(resolveGitActionProgressPresentation(input));
    assert.isNull(resolveGitActionProgressPresentation({ ...input, isRunning: false }));
  });

  it("formats compact elapsed time without allowing negative values", () => {
    assert.isNull(formatGitActionElapsed(null, 10_000));
    assert.equal(formatGitActionElapsed(10_000, 9_000), "0s");
    assert.equal(formatGitActionElapsed(10_000, 14_900), "4s");
    assert.equal(formatGitActionElapsed(10_000, 75_000), "1m 5s");
  });
});

describe("git action result toast timing", () => {
  it("keeps errors sticky and dismisses successes after visible time", () => {
    assert.deepEqual(resolveGitActionResultToastTiming("error"), {
      timeout: 0,
      dismissAfterVisibleMs: null,
    });
    assert.deepEqual(resolveGitActionResultToastTiming("success"), {
      timeout: 0,
      dismissAfterVisibleMs: 10_000,
    });
  });
});

describe("local Git actions", () => {
  it.each([
    {
      changes: true,
      ahead: 0,
      behind: 0,
      label: "Commit",
      action: "commit",
      kind: "run_action",
      disabled: false,
    },
    {
      changes: true,
      ahead: 2,
      behind: 1,
      label: "Commit",
      action: "commit",
      kind: "run_action",
      disabled: false,
    },
    {
      changes: false,
      ahead: 2,
      behind: 0,
      label: "Push",
      action: "push",
      kind: "run_action",
      disabled: false,
    },
    { changes: false, ahead: 0, behind: 1, label: "Pull", kind: "run_pull", disabled: false },
    { changes: false, ahead: 1, behind: 1, label: "Sync ref", kind: "show_hint", disabled: true },
    { changes: false, ahead: 0, behind: 0, label: "Commit", kind: "show_hint", disabled: true },
  ] as const)("chooses $label for dirty=$changes ahead=$ahead behind=$behind", (scenario) => {
    assert.deepInclude(
      resolveQuickAction(
        status({
          hasWorkingTreeChanges: scenario.changes,
          aheadCount: scenario.ahead,
          behindCount: scenario.behind,
        }),
        false,
      ),
      {
        label: scenario.label,
        kind: scenario.kind,
        disabled: scenario.disabled,
        ...("action" in scenario ? { action: scenario.action } : {}),
      },
    );
  });

  it("keeps local actions available without a hosted provider or remote", () => {
    assert.deepInclude(
      resolveQuickAction(status({ hasWorkingTreeChanges: true }), false, false, false),
      { action: "commit", disabled: false },
    );
    assert.deepInclude(resolveQuickAction(status({ aheadCount: 2 }), false, false, false), {
      kind: "show_hint",
      disabled: true,
      hint: "Add a Git remote before pushing.",
    });
    assert.deepEqual(
      buildMenuItems(status({ hasWorkingTreeChanges: true }), false, false).map((item) => item.id),
      ["commit"],
    );
  });

  it("disables unavailable, busy, and detached actions", () => {
    for (const quick of [
      resolveQuickAction(null, false),
      resolveQuickAction(status(), true),
      resolveQuickAction(status({ refName: null }), false),
    ])
      assert.isTrue(quick.disabled);
    assert.deepEqual(buildMenuItems(null, false), []);
    assert.isTrue(
      buildMenuItems(status({ hasWorkingTreeChanges: true, aheadCount: 2 }), true).every(
        (item) => item.disabled,
      ),
    );
  });

  it.each([
    {
      changes: false,
      ahead: 0,
      behind: 0,
      detached: false,
      commitDisabled: true,
      pushDisabled: true,
    },
    {
      changes: true,
      ahead: 2,
      behind: 0,
      detached: false,
      commitDisabled: false,
      pushDisabled: false,
    },
    {
      changes: true,
      ahead: 2,
      behind: 1,
      detached: false,
      commitDisabled: false,
      pushDisabled: true,
    },
    {
      changes: false,
      ahead: 2,
      behind: 0,
      detached: true,
      commitDisabled: true,
      pushDisabled: true,
    },
  ])(
    "offers only commit and push with dirty=$changes ahead=$ahead behind=$behind detached=$detached",
    (scenario) => {
      const items = buildMenuItems(
        status({
          hasWorkingTreeChanges: scenario.changes,
          aheadCount: scenario.ahead,
          behindCount: scenario.behind,
          refName: scenario.detached ? null : "feature/test",
        }),
        false,
      );
      assert.deepEqual(
        items.map((item) => [item.id, item.disabled]),
        [
          ["commit", scenario.commitDisabled],
          ["push", scenario.pushDisabled],
        ],
      );
    },
  );

  it("confirms pushes to the default branch", () => {
    assert.isTrue(requiresDefaultBranchConfirmation("push", true));
    assert.isTrue(requiresDefaultBranchConfirmation("commit_push", true));
    assert.isFalse(requiresDefaultBranchConfirmation("commit", true));
    assert.isFalse(requiresDefaultBranchConfirmation("push", false));
    assert.equal(
      resolveDefaultBranchActionDialogCopy({
        action: "push",
        branchName: "main",
        includesCommit: false,
      }).continueLabel,
      "Push to main",
    );
    assert.equal(
      resolveDefaultBranchActionDialogCopy({
        action: "commit_push",
        branchName: "main",
        includesCommit: true,
      }).title,
      "Commit & push to default ref?",
    );
  });
});

describe("resolveThreadBranchUpdate", () => {
  it("returns a branch update when the action created a new branch", () => {
    const update = resolveThreadBranchUpdate({
      action: "commit_push_pr",
      branch: {
        status: "created",
        name: "feature/fix-toast-copy",
      },
      commit: {
        status: "created",
        commitSha: "89abcdef01234567",
        subject: "feat: add ref sync",
      },
      push: { status: "pushed", branch: "feature/fix-toast-copy" },
      pr: { status: "skipped_not_requested" },
      toast: {
        title: "Pushed 89abcde to origin/feature/fix-toast-copy",
        cta: { kind: "none" },
      },
    });

    assert.deepEqual(update, {
      branch: "feature/fix-toast-copy",
    });
  });

  it("returns null when the action stayed on the existing branch", () => {
    const update = resolveThreadBranchUpdate({
      action: "commit_push",
      branch: {
        status: "skipped_not_requested",
      },
      commit: {
        status: "created",
        commitSha: "89abcdef01234567",
        subject: "feat: add ref sync",
      },
      push: { status: "pushed", branch: "feature/fix-toast-copy" },
      pr: { status: "skipped_not_requested" },
      toast: {
        title: "Pushed 89abcde to origin/feature/fix-toast-copy",
        cta: { kind: "none" },
      },
    });

    assert.equal(update, null);
  });
});

describe("resolveLiveThreadBranchUpdate", () => {
  it("returns a branch update when live git status differs from stored thread metadata", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "feature/old-ref",
      gitStatus: status({ refName: "effect-atom" }),
    });

    assert.deepEqual(update, {
      branch: "effect-atom",
    });
  });

  it("returns null when live git status is unavailable", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "feature/old-ref",
      gitStatus: null,
    });

    assert.equal(update, null);
  });

  it("returns null when the stored thread ref already matches git status", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "effect-atom",
      gitStatus: status({ refName: "effect-atom" }),
    });

    assert.equal(update, null);
  });

  it("returns null when git status is detached HEAD but the thread already has a ref", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "effect-atom",
      gitStatus: status({ refName: null }),
    });

    assert.equal(update, null);
  });

  it("does not regress a semantic thread ref back to a temporary worktree ref", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "kurambit/github-query-rate-limit",
      gitStatus: status({ refName: "kurambit/bda76797" }),
    });

    assert.equal(update, null);
  });

  it("allows a temporary worktree ref to reconcile to a semantic branch", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "kurambit/a9628676",
      gitStatus: status({ refName: "feature/diff-panel-toggle" }),
    });

    assert.deepEqual(update, { branch: "feature/diff-panel-toggle" });
  });
});

describe("resolveThreadBranchMetadataPatch", () => {
  it("does not overwrite worktree metadata while reconciling a branch", () => {
    assert.deepEqual(
      resolveThreadBranchMetadataPatch("feature/current-ref", "feature/previous-ref"),
      {
        branch: "feature/current-ref",
        expectedBranch: "feature/previous-ref",
      },
    );
  });
});

describe("resolveAutoFeatureBranchName", () => {
  it("uses semantic preferred ref names when available", () => {
    const ref = resolveAutoFeatureBranchName(["main", "feature/other"], "fix toast copy");
    assert.equal(ref, "feature/fix-toast-copy");
  });

  it("normalizes preferred names that already include a ref namespace", () => {
    const ref = resolveAutoFeatureBranchName(["main"], "feature/refine-toolbar-actions");
    assert.equal(ref, "feature/refine-toolbar-actions");
  });

  it("increments suffix when the preferred ref name already exists", () => {
    const ref = resolveAutoFeatureBranchName(
      ["main", "feature/fix-toast-copy", "feature/fix-toast-copy-2"],
      "fix toast copy",
    );
    assert.equal(ref, "feature/fix-toast-copy-3");
  });

  it("treats existing ref names as case-insensitive for collision checks", () => {
    const ref = resolveAutoFeatureBranchName(["Feature/Ticket-1"], "feature/ticket-1");
    assert.equal(ref, "feature/ticket-1-2");
  });

  it("falls back to feature/update when no preferred name is provided", () => {
    const ref = resolveAutoFeatureBranchName(["main"]);
    assert.equal(ref, "feature/update");
  });
});
