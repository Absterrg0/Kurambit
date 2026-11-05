import { expect, it } from "@effect/vitest";

import { withRoleGroups } from "./roleGroup.ts";

it("puts blind samples with the pick before the plan and with their round after", () => {
  const roles = [
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
  ];
  expect(withRoleGroups(roles.map((role) => ({ role }))).map((entry) => entry.group)).toEqual([
    "Vision",
    "Prototypes",
    "Prototypes",
    "Blind pick",
    "Blind pick",
    "Blind pick",
    "Plan",
    "Art",
    "Art",
    "First build",
    "Round 1",
    "Round 1",
    "Round 1",
    "Round 1",
    "Round 1",
    "Round 1",
    "Round 1",
    "Round 2",
  ]);
});
