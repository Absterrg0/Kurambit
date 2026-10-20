import { describe, expect, it } from "vite-plus/test";

import { parseAcceptance, validateDesignDocument } from "./gameDesign.ts";

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
  '  { "id": "move", "kind": "control", "text": "A and D move", "observe": { "key": "state", "expect": "changes" } },',
  '  { "id": "light-lanterns", "kind": "mechanic", "text": "Touching a lantern lights it", "observe": { "key": "collected", "expect": ">=1" } },',
  '  { "id": "reach-summit", "kind": "end", "text": "The run ends at the summit" }',
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
      "end",
    ]);
    expect(parsed.criteria[0]?.observe).toEqual({ key: "state", expect: "changes" });
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
        '## Acceptance\n\n```acceptance\n[{ "id": "win", "kind": "end", "text": "Win" }, { "id": "win", "kind": "mechanic", "text": "Go" }]\n```',
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
        '## Acceptance\n\n```acceptance\n[{ "id": "win", "kind": "end", "text": "Win", "observe": { "key": "score", "expect": "more" } }]\n```',
      ),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues[0]).toContain("observe.expect");
  });
});

describe("validateDesignDocument", () => {
  it("accepts a filled design with bound acceptance", () => {
    expect(validateDesignDocument({ design: validDesign, skeleton }).issues).toEqual([]);
    expect(validateDesignDocument({ design: validDesign, skeleton }).acceptance).toHaveLength(3);
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

  it("requires one end and one mechanic criterion", () => {
    const onlyContent = designWith(
      '## Acceptance\n\n```acceptance\n[{ "id": "nine", "kind": "content", "text": "Nine lanterns exist" }]\n```',
    );
    const issues = validateDesignDocument({ design: onlyContent, skeleton }).issues;
    expect(issues.some((issue) => issue.includes("`end`"))).toBe(true);
    expect(issues.some((issue) => issue.includes("`mechanic`"))).toBe(true);
  });
});
