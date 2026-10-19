import { SourceControlProviderKind } from "@t3tools/contracts";
import { ProjectId, type PullRequestSummary, type VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";
import type { AnimationEvent } from "react";

import {
  ChangeRequestStatusIcon,
  nextThreadChangeRequestSnapshot,
  prStatusIndicator,
  resolveDisplayedThreadPr,
  resolveDisplayedThreadPrProvider,
  resolveThreadPr,
  threadChangeRequestSnapshotsEqual,
  threadChangeRequestSnapshotsAtom,
  type ThreadChangeRequestSnapshot,
  resolveThreadPullRequestBadgePresentation,
  synchronizeTerminalPulse,
} from "./ThreadStatusIndicators";
import { newestPullRequestSummary } from "../state/pullRequests";

describe("synchronizeTerminalPulse", () => {
  it("pins only the status pulse to the document clock", () => {
    const pulse = { animationName: "status-pulse", startTime: 975 } as CSSAnimation;
    const otherCss = { animationName: "other-animation", startTime: 125 } as CSSAnimation;
    const otherAnimation = { startTime: 250 } as Animation;

    synchronizeTerminalPulse({
      animationName: "status-pulse",
      currentTarget: { getAnimations: () => [pulse, otherCss, otherAnimation] },
    } as AnimationEvent<SVGSVGElement>);

    expect([pulse.startTime, otherCss.startTime, otherAnimation.startTime]).toEqual([0, 125, 250]);
  });
});

describe("ChangeRequestStatusIcon", () => {});

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/current",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: {
      number: 42,
      title: "PR branch",
      url: "https://github.com/pingdotgg/t3code/pull/42",
      baseRef: "main",
      headRef: "feature/current",
      state: "open",
    },
    ...overrides,
  };
}

function mergedFeaturePr(): NonNullable<VcsStatusResult["pr"]> {
  return {
    number: 42,
    title: "Feature PR",
    url: "https://github.com/pingdotgg/t3code/pull/42",
    baseRef: "main",
    headRef: "feature/current",
    state: "merged",
  };
}

function snapshotFor(
  branch: string,
  pr: NonNullable<VcsStatusResult["pr"]>,
  sourceControlProvider?: VcsStatusResult["sourceControlProvider"],
): ThreadChangeRequestSnapshot {
  return { branch, pr, sourceControlProvider };
}

function pullRequestSummary(
  state: PullRequestSummary["state"],
  updatedAt: string,
): PullRequestSummary {
  return {
    provider: SourceControlProviderKind.make("github"),
    projectId: ProjectId.make("project-1"),
    repository: "pingdotgg/t3code",
    number: 42,
    title: "Feature PR",
    url: "https://github.com/pingdotgg/t3code/pull/42",
    state,
    headBranch: "feature/current",
    baseBranch: "main",
    updatedAt,
  };
}

describe("resolveThreadPr", () => {});

describe("resolveDisplayedThreadPr + nextThreadChangeRequestSnapshot", () => {
  const featureBranch = "feature/current";
  const mergedPr = mergedFeaturePr();
  const linkedPullRequest = {
    projectId: ProjectId.make("project-1"),
    repository: "pingdotgg/t3code",
    number: 42,
    url: "https://github.com/pingdotgg/t3code/pull/42",
  };
  const provider = {
    kind: SourceControlProviderKind.make("github"),
    name: "GitHub",
    baseUrl: "https://github.com",
  };

  it("retains a local terminal snapshot when thread metadata follows the new branch", () => {
    const otherBranchSnapshot = snapshotFor("feature/other", mergedPr, provider);

    expect(
      resolveDisplayedThreadPr({
        threadBranch: featureBranch,
        gitStatus: status({ refName: "main", pr: null }),
        snapshot: otherBranchSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toEqual(mergedPr);
  });

  it("clears an open snapshot when a local checkout moves to a different branch", () => {
    const openSnapshot = snapshotFor(featureBranch, { ...mergedPr, state: "open" });

    expect(
      nextThreadChangeRequestSnapshot({
        threadBranch: featureBranch,
        gitStatus: status({ refName: "main", pr: null }),
        snapshot: openSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeNull();
  });

  it("clears a retained snapshot when the thread branch is cleared", () => {
    const terminalSnapshot = snapshotFor(featureBranch, mergedPr, provider);

    expect(
      nextThreadChangeRequestSnapshot({
        threadBranch: null,
        gitStatus: status({ refName: "main", pr: null }),
        snapshot: terminalSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeNull();
    expect(
      resolveDisplayedThreadPr({
        threadBranch: null,
        gitStatus: status({ refName: "main", pr: null }),
        snapshot: terminalSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeNull();
    expect(
      resolveDisplayedThreadPrProvider({
        threadBranch: null,
        gitStatus: status({ refName: "main", pr: null }),
        snapshot: terminalSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeUndefined();
  });

  it("does not erase a terminal snapshot when VCS data is missing", () => {
    const terminalSnapshot = snapshotFor(featureBranch, mergedPr, provider);

    expect(
      nextThreadChangeRequestSnapshot({
        threadBranch: featureBranch,
        gitStatus: null,
        snapshot: terminalSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeUndefined();
    expect(
      resolveDisplayedThreadPr({
        threadBranch: featureBranch,
        gitStatus: null,
        snapshot: terminalSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toEqual(mergedPr);
  });
});

describe("threadChangeRequestSnapshotsAtom", () => {
  it.effect("retains snapshots while sidebar and chat consumers are unmounted", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const threadKey = "environment-1:thread-1";
      const snapshot = snapshotFor("feature/current", mergedFeaturePr());

      const unmount = registry.mount(threadChangeRequestSnapshotsAtom);
      registry.set(threadChangeRequestSnapshotsAtom, new Map([[threadKey, snapshot]]));
      unmount();

      yield* Effect.yieldNow;

      const remount = registry.mount(threadChangeRequestSnapshotsAtom);
      expect(registry.get(threadChangeRequestSnapshotsAtom).get(threadKey)).toEqual(snapshot);

      remount();
      registry.dispose();
    }),
  );
});

describe("prStatusIndicator", () => {});

describe("resolveThreadPullRequestBadgePresentation", () => {
  const url = "https://github.com/pingdotgg/t3code/pull/42";

  it("returns the pending pull-request badge when no snapshot is available", () => {
    expect(
      resolveThreadPullRequestBadgePresentation({
        badge: null,
        number: 42,
        url,
        status: null,
      }),
    ).toEqual({
      Icon: PullRequestGlyph.pullRequest,
      toneClassName: "text-muted-foreground",
      label: "PR #42, status pending",
      text: 42,
    });
  });

  it.each([
    ["open", "text-emerald-600 dark:text-emerald-300/90"],
    ["draft", "text-zinc-500 dark:text-zinc-400/80"],
    ["merged", "text-violet-600 dark:text-violet-300/90"],
  ] as const)(
    "uses a layers badge with the %s stack tone without a link identity",
    (state, expectedToneClassName) => {
      expect(
        resolveThreadPullRequestBadgePresentation({
          badge: { kind: "stack", layers: 3, state },
          status: null,
        }),
      ).toEqual({
        Icon: PullRequestGlyph.stack,
        toneClassName: expectedToneClassName,
        label: `Stack of 3 pull requests, ${state}`,
        text: 3,
      });
    },
  );

  it("omits the control when neither a stack nor a linked identity can be shown", () => {
    expect(resolveThreadPullRequestBadgePresentation({ badge: null, status: null })).toBeNull();
  });
});
