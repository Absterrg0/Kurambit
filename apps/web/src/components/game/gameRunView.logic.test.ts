import { describe, expect, it } from "vite-plus/test";

import { groupRoleThreads } from "./gameRunView.logic";

const threads = (...roles: string[]) =>
  roles.map((role, index) => ({ role, threadId: `t${index}`, startedAt: "" }));

describe("groupRoleThreads", () => {
  it("puts blind samples with the pick before the plan and with their round after", () => {
    const groups = groupRoleThreads(
      threads(
        "vision",
        "proto-0",
        "proto-1",
        "sample-a",
        "sample-b",
        "compare-c",
        "plan",
        "art",
        "art-director",
        "builder-build",
        "builder-1",
        "builder-1b",
        "tester-1",
        "sample-d",
        "compare-e",
        "reviewer-1",
        "ship-1",
        "builder-2",
      ),
    );
    expect(groups.map((group) => [group.label, group.threads.length])).toEqual([
      ["Vision", 1],
      ["Prototypes", 2],
      ["Blind pick", 3],
      ["Plan", 1],
      ["Art", 2],
      ["First build", 1],
      ["Round 1", 7],
      ["Round 2", 1],
    ]);
  });
});
