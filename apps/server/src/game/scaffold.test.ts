import { expect, it } from "@effect/vitest";

import { withoutMovedSections } from "./scaffold.ts";

// The migration rewrites a file the person and their agent own: it may take the two harness
// sections and nothing else.
it("drops only the turn rules from a game's AGENTS.md", () => {
  const head = "# Kurambit project\n\nEngine guidance.\n\n### Its own subsection\n\nKept.\n";
  const firstTurn = "## The first turn\n\n1. Read `BRIEF.md`.\n";
  const skills = "## Studio skills (read the ones this turn needs)\n\nCraft advice.\n";
  const everyTurn = "## Every turn\n\n- One visible change per turn.\n";
  const keepGoing = "## Keep going\n\n- Do that one step.\n";
  const mine = "## My notes\n\nThe person's own section.\n";

  expect(
    withoutMovedSections(
      [head, everyTurn, firstTurn, keepGoing, mine].join("\n") + `\n\n${skills}`,
    ),
  ).toBe([head, firstTurn, mine].join("\n") + `\n\n${skills}`);
  expect(withoutMovedSections([head, everyTurn, keepGoing].join("\n"))).toBe(head);
  expect(withoutMovedSections([head, firstTurn].join("\n"))).toBeNull();
});
