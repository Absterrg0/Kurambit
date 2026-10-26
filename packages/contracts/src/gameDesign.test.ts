import { describe, expect, it } from "vite-plus/test";

import {
  NO_LOSE_STATE_TEXT,
  diffAcceptance,
  normalizeAcceptance,
  parseAcceptance,
  removedCriteriaWithoutRemovedLine,
  unmetRevisionObligations,
  validateDesignDocument,
  type GameAcceptanceCriterion,
} from "./gameDesign.ts";

const skeleton = `# Tiny Quest — design

## Pitch

What the player does, and why it is fun, in two or three sentences.

## Controls

Movement, camera and actions, with keyboard and gamepad bindings.

## Content

Levels, enemies and pickups, with counts and names.

## Acceptance

Write a fenced acceptance block here.

## Milestones

1. **Playable core** — the loop above running end to end.
`;

const acceptanceBlock = [
  "## Acceptance",
  "",
  "The build is judged against these.",
  "",
  "```acceptance",
  "[",
  '  { "id": "move", "kind": "control", "text": "A and D move and Space jumps", "observe": { "key": "jumps", "expect": ">=1" } },',
  '  { "id": "light-lanterns", "kind": "mechanic", "text": "Touching a lantern lights it", "observe": { "key": "collected", "expect": ">=1" } },',
  '  { "id": "nine-lanterns", "kind": "content", "text": "The player collects all nine lanterns", "observe": { "key": "collected", "expect": ">=9" } },',
  '  { "id": "reach-summit", "kind": "win", "text": "The run ends at the summit", "observe": { "key": "state", "expect": "==3" } },',
  '  { "id": "lose-all-lives", "kind": "lose", "text": "Losing every life ends the run", "observe": { "key": "lives", "expect": "<=0" } }',
  "]",
  "```",
].join("\n");

const filled = (acceptance: string) => `# Tiny Quest — design

## Pitch

You are a courier crossing moonlit rooftops, lighting lanterns to open the chimney gate. The
pleasure is a clean route, a growing string of lights below and one more run after a fall.

## Controls

Move with A and D or the left stick, jump with Space or the south face button, and pause with
Escape or Start.

## Win & lose

The run is won when the courier reaches the summit spire with the lanterns lit. Falling off the
rooftops or spending all three lives ends the run in failure; a retry starts from the first roof.

## Content

Three rooftops, nine lanterns, two moving platforms and a chimney gate. The template supplies the
controller, camera, checkpoint and pause menu, and keeps its own component checks passing; this
game adds the lanterns, the wind gusts and the chimney route, with three lives and a restart.

${acceptance}

## Milestones

1. **Playable core** — one roof, three lanterns and the chimney gate end to end.
2. **Content** — all three rooftops and nine lanterns.
3. **Polish** — audio and pause presentation.
`;

const designWith = (acceptance: string) => filled(acceptance);
const validDesign = designWith(acceptanceBlock);

describe("parseAcceptance", () => {
  it("parses the fenced acceptance block", () => {
    const parsed = parseAcceptance(validDesign);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.criteria.map((criterion) => criterion.kind)).toEqual([
      "control",
      "mechanic",
      "content",
      "win",
      "lose",
    ]);
    expect(parsed.criteria[0]?.observe).toEqual({ key: "jumps", expect: ">=1" });
  });

  it("reports a missing section and a missing block", () => {
    const noSection = parseAcceptance("# Tiny Quest\n\nNo acceptance here.");
    expect(noSection.ok).toBe(false);
    if (!noSection.ok) expect(noSection.issues[0]).toContain('"## Acceptance"');
    const noBlock = parseAcceptance("## Acceptance\n\nNothing fenced.");
    expect(noBlock.ok).toBe(false);
    if (!noBlock.ok) expect(noBlock.issues[0]).toContain("fenced");
  });

  it("rejects invalid JSON", () => {
    const parsed = parseAcceptance(designWith("## Acceptance\n\n```acceptance\n[not json]\n```"));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues[0]).toContain("valid JSON");
  });

  it("rejects an unknown kind", () => {
    const parsed = parseAcceptance(
      designWith(
        '## Acceptance\n\n```acceptance\n[{ "id": "win", "kind": "goal", "text": "Win" }]\n```',
      ),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues[0]).toContain("unknown kind");
  });

  it("rejects duplicate ids and empty blocks", () => {
    const duplicate = parseAcceptance(
      designWith(
        '## Acceptance\n\n```acceptance\n[{ "id": "win", "kind": "win", "text": "Win" }, { "id": "win", "kind": "mechanic", "text": "Go" }]\n```',
      ),
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.issues[0]).toContain("more than once");
    const empty = parseAcceptance(designWith("## Acceptance\n\n```acceptance\n[]\n```"));
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.issues[0]).toContain("at least one criterion");
  });

  it("rejects a malformed observation", () => {
    const parsed = parseAcceptance(
      designWith(
        '## Acceptance\n\n```acceptance\n[{ "id": "win", "kind": "win", "text": "Win", "observe": { "key": "score", "expect": "more" } }]\n```',
      ),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues[0]).toContain("observe.expect");
  });

  it("names the offending criterion in every error", () => {
    const parsed = parseAcceptance(
      designWith(
        '## Acceptance\n\n```acceptance\n[{ "id": "ghost-jump", "kind": "mechanic", "text": "The player jumps again in mid-air", "observe": { "key": "jumps", "expect": "more" } }]\n```',
      ),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues[0]).toContain('Acceptance criterion 1 ("ghost-jump")');
  });

  it("rejects a presentation claim that carries an observation", () => {
    const parsed = parseAcceptance(
      designWith(
        '## Acceptance\n\n```acceptance\n[{ "id": "warm-glow", "kind": "presentation", "text": "Lanterns glow", "observe": { "key": "state", "expect": "==3" } }]\n```',
      ),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues[0]).toContain("cannot carry observe");
  });
});

describe("acceptance compatibility", () => {
  it("reads an approved record that used the old end kind as win", () => {
    expect(
      normalizeAcceptance([
        { id: "reach-summit", kind: "end", text: "Reach the summit" },
        { id: "move", kind: "control", text: "Move", observe: { key: "jumps", expect: ">=1" } },
      ]),
    ).toEqual([
      { id: "reach-summit", kind: "win", text: "Reach the summit" },
      { id: "move", kind: "control", text: "Move", observe: { key: "jumps", expect: ">=1" } },
    ]);
  });

  it("keeps the typed flag and the exact legacy token through a stored record", () => {
    expect(
      normalizeAcceptance([
        { id: "no-lose", kind: "lose", text: NO_LOSE_STATE_TEXT },
        {
          id: "no-failure",
          kind: "lose",
          text: "The run never ends in failure",
          noLoseState: true,
        },
      ]),
    ).toEqual([
      { id: "no-lose", kind: "lose", text: NO_LOSE_STATE_TEXT },
      { id: "no-failure", kind: "lose", text: "The run never ends in failure", noLoseState: true },
    ]);
  });
});

describe("validateDesignDocument", () => {
  it("accepts a filled design with bound acceptance", () => {
    expect(validateDesignDocument({ design: validDesign, skeleton }).issues).toEqual([]);
    expect(validateDesignDocument({ design: validDesign, skeleton }).acceptance).toHaveLength(5);
  });

  it("rejects a missing document and the untouched skeleton", () => {
    expect(validateDesignDocument({ design: null, skeleton }).issues[0]).toContain("missing");
    const untouched = validateDesignDocument({ design: skeleton, skeleton });
    expect(untouched.warnings.some((warning) => warning.includes("skeleton hint"))).toBe(true);
    expect(untouched.issues.some((issue) => issue.includes("Acceptance"))).toBe(true);
  });

  it("warns about a leftover hint line without blocking an otherwise valid design", () => {
    const hint = skeleton
      .split("\n")
      .find((line) => line.trim() !== "" && !line.startsWith("#") && !/^(?:-|\d+\.)\s/.test(line));
    expect(hint).toBeDefined();
    const result = validateDesignDocument({ design: `${validDesign}\n${hint}\n`, skeleton });
    expect(result.issues).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes("skeleton hint"))).toBe(true);
    expect(result.acceptance).toHaveLength(5);
  });

  it("names a missing section and a thin page", () => {
    const noPitch = validDesign.replace(/## Pitch[\s\S]*?(?=\n## Controls)/, "");
    const issues = validateDesignDocument({ design: noPitch, skeleton }).issues;
    expect(issues.some((issue) => issue.includes('"Pitch"'))).toBe(true);
    const thin = validateDesignDocument({ design: "# Tiny Quest\n\n## Pitch\n\nShort.", skeleton });
    expect(thin.issues.some((issue) => issue.includes("too thin"))).toBe(true);
  });

  it("requires control, mechanic and lose coverage but not a win", () => {
    const onlyContent = designWith(
      '## Acceptance\n\n```acceptance\n[{ "id": "nine", "kind": "content", "text": "The player collects nine lanterns", "observe": { "key": "collected", "expect": ">=9" } }]\n```',
    );
    const issues = validateDesignDocument({ design: onlyContent, skeleton }).issues;
    for (const kind of ["control", "mechanic", "lose"])
      expect(issues.some((issue) => issue.includes(`\`${kind}\``))).toBe(true);
    expect(issues.some((issue) => issue.includes("`win`"))).toBe(false);

    const noWin = validDesign
      .replace(
        /## Win & lose[\s\S]*?(?=\n## Content)/,
        `## Win & lose

This run is endless: there is no victory state and no lose state, so the player plays on.`,
      )
      .replace(
        /## Acceptance[\s\S]*?(?=\n## Milestones)/,
        `## Acceptance

The build is judged against these criteria.

\`\`\`acceptance
[
  { "id": "move", "kind": "control", "text": "Move", "observe": { "key": "jumps", "expect": ">=1" } },
  { "id": "paint", "kind": "mechanic", "text": "Paint the wall", "observe": { "key": "collected", "expect": ">=1" } },
  { "id": "no-lose", "kind": "lose", "text": "A run never ends in failure", "noLoseState": true }
]
\`\`\``,
      );
    expect(validateDesignDocument({ design: noWin, skeleton }).issues).toEqual([]);
  });

  it("requires an observation for every mechanical criterion and names it", () => {
    const design = designWith(
      `## Acceptance

\`\`\`acceptance
[
  { "id": "move", "kind": "control", "text": "Move", "observe": { "key": "jumps", "expect": ">=1" } },
  { "id": "ghost-jump", "kind": "mechanic", "text": "Double jump" },
  { "id": "win", "kind": "win", "text": "Win", "observe": { "key": "state", "expect": "==3" } },
  { "id": "lose", "kind": "lose", "text": "Lose", "observe": { "key": "lives", "expect": "<=0" } }
]
\`\`\``,
    );
    const issues = validateDesignDocument({ design, skeleton }).issues;
    expect(
      issues.some((issue) => issue.includes('"ghost-jump"') && issue.includes("needs an observe")),
    ).toBe(true);
  });

  it("accepts a typed no-lose declaration whatever the Win & lose prose says", () => {
    // The filled design's Win & lose section promises a real failure; the
    // typed declaration is the contract, so prose cannot veto it.
    const design = designWith(
      `## Acceptance

\`\`\`acceptance
[
  { "id": "move", "kind": "control", "text": "Move", "observe": { "key": "jumps", "expect": ">=1" } },
  { "id": "paint", "kind": "mechanic", "text": "Paint the wall", "observe": { "key": "collected", "expect": ">=1" } },
  { "id": "win", "kind": "win", "text": "Win", "observe": { "key": "state", "expect": "==3" } },
  { "id": "no-lose", "kind": "lose", "text": "The run never ends in failure", "noLoseState": true }
]
\`\`\``,
    );
    const result = validateDesignDocument({ design, skeleton });
    expect(result.issues).toEqual([]);
    expect(result.acceptance.find((criterion) => criterion.id === "no-lose")).toMatchObject({
      kind: "lose",
      noLoseState: true,
    });
  });

  it("keeps the exact legacy no-loss token valid without reading the prose", () => {
    const design = designWith(
      `## Acceptance

\`\`\`acceptance
[
  { "id": "move", "kind": "control", "text": "Move", "observe": { "key": "jumps", "expect": ">=1" } },
  { "id": "paint", "kind": "mechanic", "text": "Paint the wall", "observe": { "key": "collected", "expect": ">=1" } },
  { "id": "win", "kind": "win", "text": "Win", "observe": { "key": "state", "expect": "==3" } },
  { "id": "no-lose", "kind": "lose", "text": "${NO_LOSE_STATE_TEXT}" }
]
\`\`\``,
    );
    expect(validateDesignDocument({ design, skeleton }).issues).toEqual([]);
  });

  it("rejects noLoseState on a non-lose claim, with an observe, or as false", () => {
    const flagOnControl = parseAcceptance(
      designWith(
        `## Acceptance

\`\`\`acceptance
[
  { "id": "move", "kind": "control", "text": "Move", "noLoseState": true }
]
\`\`\``,
      ),
    );
    expect(flagOnControl.ok).toBe(false);
    if (!flagOnControl.ok)
      expect(flagOnControl.issues.join(" ")).toContain("only on a lose criterion");

    const flagWithObserve = parseAcceptance(
      designWith(
        `## Acceptance

\`\`\`acceptance
[
  { "id": "no-lose", "kind": "lose", "text": "No failure", "noLoseState": true, "observe": { "key": "lives", "expect": "<0" } }
]
\`\`\``,
      ),
    );
    expect(flagWithObserve.ok).toBe(false);
    if (!flagWithObserve.ok)
      expect(flagWithObserve.issues.join(" ")).toContain(
        "declares noLoseState and cannot carry observe",
      );

    const falseFlag = parseAcceptance(
      designWith(
        `## Acceptance

\`\`\`acceptance
[
  { "id": "no-lose", "kind": "lose", "text": "No failure", "noLoseState": false }
]
\`\`\``,
      ),
    );
    expect(falseFlag.ok).toBe(false);
    if (!falseFlag.ok)
      expect(falseFlag.issues.join(" ")).toContain("noLoseState must be true when present");
  });

  it("does not infer no-loss from arbitrary prose or a missing observation", () => {
    const arbitraryText = designWith(
      `## Acceptance

\`\`\`acceptance
[
  { "id": "move", "kind": "control", "text": "Move", "observe": { "key": "jumps", "expect": ">=1" } },
  { "id": "paint", "kind": "mechanic", "text": "Paint the wall", "observe": { "key": "collected", "expect": ">=1" } },
  { "id": "no-lose", "kind": "lose", "text": "The run never ends in failure" }
]
\`\`\``,
    );
    const issues = validateDesignDocument({ design: arbitraryText, skeleton }).issues;
    expect(
      issues.some((issue) => issue.includes('"no-lose"') && issue.includes("needs an observe")),
    ).toBe(true);
  });

  it("exempts only the criterion that declares noLoseState", () => {
    const design = designWith(
      `## Acceptance

\`\`\`acceptance
[
  { "id": "move", "kind": "control", "text": "Move", "observe": { "key": "jumps", "expect": ">=1" } },
  { "id": "paint", "kind": "mechanic", "text": "Paint the wall", "observe": { "key": "collected", "expect": ">=1" } },
  { "id": "no-lose", "kind": "lose", "text": "No failure", "noLoseState": true },
  { "id": "out-of-lives", "kind": "lose", "text": "Losing every life ends the run" }
]
\`\`\``,
    );
    const issues = validateDesignDocument({ design, skeleton }).issues;
    expect(
      issues.some(
        (issue) => issue.includes('"out-of-lives"') && issue.includes("needs an observe"),
      ),
    ).toBe(true);
  });

  it("rejects a page that only waits or only counts the world total", () => {
    const design = designWith(
      `## Acceptance

\`\`\`acceptance
[
  { "id": "move", "kind": "control", "text": "Move", "observe": { "key": "jumps", "expect": ">=1" } },
  { "id": "pearls", "kind": "mechanic", "text": "Collect pearls", "observe": { "key": "collected", "expect": ">=1" } },
  { "id": "five-pearls", "kind": "content", "text": "Five pearls exist", "observe": { "key": "total", "expect": "==5" } },
  { "id": "win", "kind": "win", "text": "Win", "observe": { "key": "state", "expect": "==3" } },
  { "id": "lose", "kind": "lose", "text": "Lose", "observe": { "key": "lives", "expect": "<=0" } }
]
\`\`\``,
    );
    const issues = validateDesignDocument({ design, skeleton }).issues;
    expect(
      issues.some((issue) => issue.includes('"five-pearls"') && issue.includes("world total")),
    ).toBe(true);
  });

  it("keeps presentation criteria out of the mechanical observe rule", () => {
    const design = designWith(
      `## Acceptance

\`\`\`acceptance
[
  { "id": "move", "kind": "control", "text": "Move", "observe": { "key": "jumps", "expect": ">=1" } },
  { "id": "paint", "kind": "mechanic", "text": "Paint the wall", "observe": { "key": "collected", "expect": ">=1" } },
  { "id": "win", "kind": "win", "text": "Win", "observe": { "key": "state", "expect": "==3" } },
  { "id": "lose", "kind": "lose", "text": "Lose", "observe": { "key": "lives", "expect": "<=0" } },
  { "id": "warm-glow", "kind": "presentation", "text": "Lanterns cast a warm glow" }
]
\`\`\``,
    );
    expect(validateDesignDocument({ design, skeleton }).issues).toEqual([]);
  });
});

describe("diffAcceptance", () => {
  const move: GameAcceptanceCriterion = {
    id: "move",
    kind: "control",
    text: "Move",
    observe: { key: "jumps", expect: ">=1" },
  };
  const lanterns: GameAcceptanceCriterion = {
    id: "light-lanterns",
    kind: "mechanic",
    text: "Touching a lantern lights it",
    observe: { key: "collected", expect: ">=1" },
  };
  const win: GameAcceptanceCriterion = {
    id: "win",
    kind: "win",
    text: "Win",
    observe: { key: "state", expect: "==3" },
  };

  it("counts only the promises that differ, keyed by id", () => {
    expect(diffAcceptance([move, lanterns, win], [move, lanterns, win])).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    const diff = diffAcceptance([move, lanterns, win], [move, lanterns]);
    expect(diff.added).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.removed.map((criterion) => criterion.id)).toEqual(["win"]);
  });

  it("shows an added criterion and an in-place change of one id", () => {
    const raised: GameAcceptanceCriterion = {
      ...lanterns,
      observe: { key: "collected", expect: ">=2" },
    };
    const doubleJump: GameAcceptanceCriterion = {
      id: "double-jump",
      kind: "mechanic",
      text: "A second jump while airborne raises the courier",
      observe: { key: "air_jumps", expect: ">=1" },
    };
    const diff = diffAcceptance([move, lanterns], [move, raised, doubleJump]);
    expect(diff.added.map((criterion) => criterion.id)).toEqual(["double-jump"]);
    expect(diff.changed.map((criterion) => criterion.id)).toEqual(["light-lanterns"]);
    // The change is the raised bar, not a removed-then-added pair.
    expect(diff.changed[0]).toEqual(raised);
    expect(diff.removed).toEqual([]);
  });

  it("treats reordering and a kind or observe edit as changes, not removals", () => {
    const rethrown: GameAcceptanceCriterion = { ...move, kind: "mechanic" };
    const expectEdit: GameAcceptanceCriterion = {
      ...move,
      observe: { key: "jumps", expect: ">=2" },
    };
    for (const current of [
      [rethrown, lanterns],
      [expectEdit, lanterns],
    ]) {
      const diff = diffAcceptance([move, lanterns], current);
      expect(diff.changed.map((criterion) => criterion.id)).toEqual(["move"]);
      expect(diff.removed).toEqual([]);
      expect(diff.added).toEqual([]);
    }
  });

  it("treats a changed noLoseState declaration as a change", () => {
    const legacy: GameAcceptanceCriterion = {
      id: "no-lose",
      kind: "lose",
      text: "No lose state",
    };
    const typed: GameAcceptanceCriterion = { ...legacy, noLoseState: true };
    expect(diffAcceptance([legacy], [typed]).changed).toEqual([typed]);
    expect(diffAcceptance([legacy], [legacy])).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
  });
});

describe("removedCriteriaWithoutRemovedLine", () => {
  const nine: GameAcceptanceCriterion = {
    id: "nine-lanterns",
    kind: "content",
    text: "Nine lanterns exist",
    observe: { key: "total", expect: "==9" },
  };

  it("returns a removal the document never owned", () => {
    const diff = diffAcceptance([nine], []);
    expect(removedCriteriaWithoutRemovedLine(diff, "## Content\n\nOne rooftop now.")).toEqual([
      nine,
    ]);
  });

  it("accepts a Removed line with bullet, prose or casing, matching by id", () => {
    for (const line of [
      "- Removed: nine-lanterns",
      "* Removed: nine-lanterns",
      "Removed: the nine-lanterns promise went away with the second roof",
      "  Removed: Nine-Lanterns",
    ]) {
      const diff = diffAcceptance([nine], []);
      expect(removedCriteriaWithoutRemovedLine(diff, `## Content\n\n${line}\n`)).toEqual([]);
    }
  });

  it("needs a token that names the id, not just any Removed line", () => {
    const diff = diffAcceptance([nine], []);
    expect(
      removedCriteriaWithoutRemovedLine(diff, "## Content\n\nRemoved: the second roof\n"),
    ).toEqual([nine]);
    // An id split by its hyphen cannot be named; the line must carry the slug.
    expect(
      removedCriteriaWithoutRemovedLine(diff, "## Content\n\nRemoved: the nine lanterns\n"),
    ).toEqual([nine]);
  });
});

describe("unmetRevisionObligations", () => {
  it("passes an obligation one criterion observes with kind, key and expect", () => {
    const airJumps: GameAcceptanceCriterion = {
      id: "double-jump",
      kind: "mechanic",
      text: "A second jump while airborne raises the courier",
      observe: { key: "air_jumps", expect: ">=1" },
    };
    expect(
      unmetRevisionObligations([airJumps], [{ kind: "mechanic", key: "air_jumps", expect: ">=1" }]),
    ).toEqual([]);
  });

  it("reports an obligation nothing observes, including observe-less criteria", () => {
    const paint: GameAcceptanceCriterion = {
      id: "paint",
      kind: "mechanic",
      text: "Paint the wall",
    };
    const win: GameAcceptanceCriterion = {
      id: "win",
      kind: "win",
      text: "Win",
      observe: { key: "state", expect: "==3" },
    };
    expect(
      unmetRevisionObligations(
        [paint, win],
        [
          { kind: "mechanic", key: "air_jumps", expect: ">=1" },
          { kind: "mechanic", key: "collected", expect: ">=1" },
        ],
      ).map((obligation) => obligation.key),
    ).toEqual(["air_jumps", "collected"]);
  });
});
