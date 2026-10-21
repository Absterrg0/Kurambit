import { describe, expect, it } from "vite-plus/test";

import {
  NO_LOSE_STATE_TEXT,
  normalizeAcceptance,
  parseAcceptance,
  validateDesignDocument,
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
});

describe("validateDesignDocument", () => {
  it("accepts a filled design with bound acceptance", () => {
    expect(validateDesignDocument({ design: validDesign, skeleton }).issues).toEqual([]);
    expect(validateDesignDocument({ design: validDesign, skeleton }).acceptance).toHaveLength(5);
  });

  it("rejects a missing document and the untouched skeleton", () => {
    expect(validateDesignDocument({ design: null, skeleton }).issues[0]).toContain("missing");
    const issues = validateDesignDocument({ design: skeleton, skeleton }).issues;
    expect(issues.some((issue) => issue.includes("skeleton hint"))).toBe(true);
    expect(issues.some((issue) => issue.includes("Acceptance"))).toBe(true);
  });

  it("names a missing section and a thin page", () => {
    const noPitch = validDesign.replace(/## Pitch[\s\S]*?(?=\n## Controls)/, "");
    const issues = validateDesignDocument({ design: noPitch, skeleton }).issues;
    expect(issues.some((issue) => issue.includes('"Pitch"'))).toBe(true);
    const thin = validateDesignDocument({ design: "# Tiny Quest\n\n## Pitch\n\nShort.", skeleton });
    expect(thin.issues.some((issue) => issue.includes("too thin"))).toBe(true);
  });

  it("requires control, mechanic, win and lose coverage", () => {
    const onlyContent = designWith(
      '## Acceptance\n\n```acceptance\n[{ "id": "nine", "kind": "content", "text": "The player collects nine lanterns", "observe": { "key": "collected", "expect": ">=9" } }]\n```',
    );
    const issues = validateDesignDocument({ design: onlyContent, skeleton }).issues;
    for (const kind of ["control", "mechanic", "win", "lose"])
      expect(issues.some((issue) => issue.includes(`\`${kind}\``))).toBe(true);
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

  it("allows the one no-lose-state exception", () => {
    const design = designWith(
      `## Win & lose

This game has no lose state: a run always ends in a win, and there is no failure screen.

## Acceptance

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

    // The declaration has to be in the design, not invented by the criterion.
    const undeclared = design.replace(
      "This game has no lose state: a run always ends in a win, and there is no failure screen.",
      "A run ends in a win.",
    );
    expect(validateDesignDocument({ design: undeclared, skeleton }).issues).toEqual(
      expect.arrayContaining([expect.stringContaining(NO_LOSE_STATE_TEXT)]),
    );
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
