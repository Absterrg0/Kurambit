// @effect-diagnostics nodeBuiltinImport:off -- The comparison test writes real grade folders and composed cards.
import { expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { PNG } from "pngjs";

import {
  compareBrief,
  decodeCompareAnswer,
  matchedIndices,
  readSavedBuild,
  renderComparisonMarkdown,
  sideOfBuild,
  summarizeComparison,
  type BriefComparison,
  type CompareAnswer,
  type CompareReview,
  type ComparisonReport,
  type SavedBuild,
} from "./compare.ts";
import type { LoadedGameBenchmarkBrief } from "./artifacts.ts";

const brief: LoadedGameBenchmarkBrief = {
  id: "platformer",
  title: "Lantern Hop",
  template: "2d-platformer",
  brief: "A jump the gaps platformer with a lantern.",
  artDirection: "Warm paper colours and a dark sky.",
  obligations: [
    {
      id: "jump",
      kind: "mechanic",
      description: "The player jumps over a gap.",
      key: "jumps",
      expect: ">=1",
    },
  ],
  path: "/fixtures/platformer.json",
  checksum: "0".repeat(64),
};

const solid = (width: number, height: number, color: readonly [number, number, number]): Buffer => {
  const png = new PNG({ width, height });
  for (let at = 0; at < png.data.length; at += 4) {
    png.data[at] = color[0];
    png.data[at + 1] = color[1];
    png.data[at + 2] = color[2];
    png.data[at + 3] = 255;
  }
  return PNG.sync.write(png);
};

const pixelAt = (png: PNG, x: number, y: number) => [
  png.data[(png.width * y + x) * 4],
  png.data[(png.width * y + x) * 4 + 1],
  png.data[(png.width * y + x) * 4 + 2],
];

const HARNESS_BOOT: readonly [number, number, number] = [200, 30, 30];
const HARNESS_ACTION: readonly [number, number, number] = [120, 30, 30];
const RAW_BOOT: readonly [number, number, number] = [30, 30, 200];
const RAW_ACTION: readonly [number, number, number] = [30, 30, 120];

/** One lane's saved grade: two frames and the notes the grade voted over. */
const writeGrade = async (
  directory: string,
  colors: ReadonlyArray<readonly [number, number, number]>,
) => {
  await NodeFSP.mkdir(NodePath.join(directory, "grade/frames"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(directory, "grade/frames/boot.png"),
    solid(8, 4, colors[0]!),
  );
  await NodeFSP.writeFile(
    NodePath.join(directory, "grade/frames/step-01.png"),
    solid(8, 4, colors[1]!),
  );
  await NodeFSP.writeFile(
    NodePath.join(directory, "grade/grade.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        brief: { id: brief.id, title: brief.title, checksum: brief.checksum },
        gameDir: directory,
        model: "codex/gpt-6.1-sol",
        grader: { provider: "codex", model: "gpt-6.1-sol" },
        graderVersion: 3,
        build: { kind: "exported", detail: null },
        quick: {
          booted: true,
          bootMs: 900,
          consoleErrors: 0,
          consoleErrorLines: [],
          responded: true,
          changedPercent: 4,
        },
        frames: ["frames/boot.png", "frames/step-01.png"],
        actions: [{ step: 1, actions: ["hold ArrowRight 500ms"], note: "moved right" }],
        obligations: [],
        control: { description: "teapot", yes: false, votes: [] },
        void: false,
        solCalls: 1,
      },
      null,
      2,
    )}\n`,
  );
};

const withGradeFolders = async (
  body: (input: {
    readonly root: string;
    readonly harness: SavedBuild;
    readonly raw: SavedBuild;
    readonly cardsRoot: string;
  }) => Promise<void>,
) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-compare-"));
  try {
    await writeGrade(NodePath.join(root, "harness", brief.id), [HARNESS_BOOT, HARNESS_ACTION]);
    await writeGrade(NodePath.join(root, "raw", brief.id), [RAW_BOOT, RAW_ACTION]);
    await body({
      root,
      harness: await readSavedBuild(NodePath.join(root, "harness", brief.id)),
      raw: await readSavedBuild(NodePath.join(root, "raw", brief.id)),
      cardsRoot: NodePath.join(root, "cards"),
    });
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
};

const answer = (
  overall: CompareAnswer["overall"],
  reason = "the pixels show it",
): CompareAnswer => ({
  works: overall,
  look: overall,
  feel: overall,
  play: overall,
  overall,
  reason,
});

/** Answers three calls in order: harness-left, raw-left, control. */
const scriptedReview = (
  answers: ReadonlyArray<unknown>,
): { readonly review: CompareReview; readonly prompts: string[] } => {
  const prompts: string[] = [];
  let call = 0;
  return {
    prompts,
    review: async (request) => {
      prompts.push(request.prompt);
      const reply = answers[call];
      call += 1;
      if (reply === undefined) throw new Error(`no scripted answer for call ${call}`);
      return reply;
    },
  };
};

it("reads A, B and tie in any case and refuses a reply with no overall", () => {
  expect(
    decodeCompareAnswer({
      works: "a",
      look: "B",
      feel: "tie",
      play: "TIE",
      overall: "b",
      reason: "x",
    }),
  ).toEqual({ works: "A", look: "B", feel: "tie", play: "tie", overall: "B", reason: "x" });
  expect(decodeCompareAnswer({ works: "A", overall: "maybe" })).toBeNull();
  expect(decodeCompareAnswer(null)).toBeNull();
  // A missing facet is no preference, never an invented one.
  expect(decodeCompareAnswer({ overall: "A", reason: "" })).toMatchObject({
    works: "tie",
    look: "tie",
    feel: "tie",
    play: "tie",
  });
});

it("spreads matched indices over both lanes and keeps the boot and last frame", () => {
  expect(matchedIndices(2, 2)).toEqual([0, 1]);
  expect(matchedIndices(10, 10)).toEqual([0, 2, 4, 5, 7, 9]);
  // The shorter lane bounds the pairs, so no index is invented on one side.
  expect(matchedIndices(10, 3)).toEqual([0, 1, 2]);
  expect(matchedIndices(0, 4)).toEqual([]);
});

it("puts each build on the side its order names", () => {
  expect(sideOfBuild("harness-left", "harness")).toBe("A");
  expect(sideOfBuild("harness-left", "raw")).toBe("B");
  expect(sideOfBuild("raw-left", "harness")).toBe("B");
  expect(sideOfBuild("raw-left", "raw")).toBe("A");
});

it("an identical winner under both orders is an agreed winner", () =>
  withGradeFolders(async ({ harness, raw, cardsRoot }) => {
    // Harness is A in the first order and B in the second: one build wins both.
    const scripted = scriptedReview([
      { overall: "A", works: "A", look: "A", feel: "tie", play: "A", reason: "readable world" },
      { overall: "B", works: "B", look: "B", feel: "tie", play: "B", reason: "readable world" },
      { overall: "tie", reason: "the same frames" },
    ]);
    const comparison = await compareBrief({
      brief,
      harness,
      raw,
      cardsRoot,
      review: scripted.review,
    });
    expect(comparison.verdict).toBe("harness");
    expect(comparison.frameCount).toBe(2);
    expect(comparison.orders.map((order) => order.overall)).toEqual(["harness", "harness"]);
    expect(comparison.facets).toEqual({
      works: "harness",
      look: "harness",
      feel: "tie",
      play: "harness",
    });
    expect(comparison.control.passed).toBe(true);
    expect(comparison.reasons).toEqual([
      "harness-left: harness wins overall — readable world",
      "raw-left: harness wins overall — readable world",
    ]);
    // Both orders carry the same labels under their own side, so the model can
    // compare like with like without learning which side is which lane.
    expect(scripted.prompts[0]).toContain("P1: A: boot, no input | B: boot, no input");
    expect(scripted.prompts[1]).toContain("P1: A: boot, no input | B: boot, no input");
    expect(scripted.prompts[0]).toContain("A: after step 1: hold ArrowRight 500ms — moved right");
  }));

it("two orders that name different builds are a split, never an average", () =>
  withGradeFolders(async ({ harness, raw, cardsRoot }) => {
    const scripted = scriptedReview([
      { overall: "A", reason: "A reads better" },
      { overall: "A", reason: "A reads better" },
      { overall: "tie", reason: "identical" },
    ]);
    const comparison = await compareBrief({
      brief,
      harness,
      raw,
      cardsRoot,
      review: scripted.review,
    });
    expect(comparison.orders.map((order) => order.overall)).toEqual(["harness", "raw"]);
    expect(comparison.verdict).toBe("split");
  }));

it("a control that names a winner voids the comparison", () =>
  withGradeFolders(async ({ harness, raw, cardsRoot }) => {
    const scripted = scriptedReview([
      { overall: "A", reason: "A reads better" },
      { overall: "B", reason: "B reads better" },
      { overall: "B", reason: "the right panel has more detail" },
    ]);
    const comparison = await compareBrief({
      brief,
      harness,
      raw,
      cardsRoot,
      review: scripted.review,
    });
    expect(comparison.orders.map((order) => order.overall)).toEqual(["harness", "harness"]);
    expect(comparison.control.passed).toBe(false);
    expect(comparison.verdict).toBe("void");
    expect(comparison.reasons.at(-1)).toContain("void");
  }));

it("a control that could not answer is reported as no answer, not a named winner", () => {
  const summary = summarizeComparison({
    orders: [
      {
        order: "harness-left",
        answer: null,
        facets: { works: "invalid", look: "invalid", feel: "invalid", play: "invalid" },
        overall: "invalid",
        reason: "The model call failed: Codex CLI exited with code 1.",
      },
      {
        order: "raw-left",
        answer: null,
        facets: { works: "invalid", look: "invalid", feel: "invalid", play: "invalid" },
        overall: "invalid",
        reason: "The model call failed: Codex CLI exited with code 1.",
      },
    ],
    control: { answer: null, passed: false },
  });
  expect(summary.verdict).toBe("void");
  const controlReason = summary.reasons.at(-1) ?? "";
  expect(controlReason).toContain("could not answer");
  expect(controlReason).not.toContain("named a winner");
});

it("swaps the panels between orders and composes the control from one capture twice", () =>
  withGradeFolders(async ({ harness, raw, cardsRoot }) => {
    const scripted = scriptedReview([
      { overall: "tie", reason: "even" },
      { overall: "tie", reason: "even" },
      { overall: "tie", reason: "identical" },
    ]);
    await compareBrief({ brief, harness, raw, cardsRoot, review: scripted.review });
    const first = PNG.sync.read(
      await NodeFSP.readFile(NodePath.join(cardsRoot, "harness-left/card-01.png")),
    );
    const reversed = PNG.sync.read(
      await NodeFSP.readFile(NodePath.join(cardsRoot, "raw-left/card-01.png")),
    );
    // Both cards are wider than one capture; the left panel is this order's A.
    expect(pixelAt(first, 1, first.height - 2)).toEqual([...HARNESS_BOOT]);
    expect(pixelAt(reversed, 1, reversed.height - 2)).toEqual([...RAW_BOOT]);
    const control = PNG.sync.read(
      await NodeFSP.readFile(NodePath.join(cardsRoot, "control/card-01.png")),
    );
    // The identical pair: both panels are byte-identical pixels of one capture.
    const halfWidth = (control.width - 8) / 2;
    for (const [x, y] of [
      [1, control.height - 2],
      [Math.floor(halfWidth) - 2, control.height - 2],
    ] as const) {
      expect(pixelAt(control, x, y)).toEqual(pixelAt(control, x + halfWidth + 8, y));
    }
  }));

it("an unreadable answer is invalid and can never agree with the other order", () => {
  const summary = summarizeComparison({
    orders: [
      {
        order: "harness-left",
        answer: null,
        facets: { works: "invalid", look: "invalid", feel: "invalid", play: "invalid" },
        overall: "invalid",
        reason: "The model call failed: quota",
      },
      {
        order: "raw-left",
        answer: answer("tie", "even"),
        facets: { works: "tie", look: "tie", feel: "tie", play: "tie" },
        overall: "tie",
        reason: "even",
      },
    ],
    control: { answer: answer("tie", "identical"), passed: true },
  });
  expect(summary.verdict).toBe("invalid");
  expect(summary.reasons[0]).toContain("no readable answer");
});

it("renders measured briefs first and gives an unmeasured one no control verdict", () => {
  const grade = {
    gradeDirectory: "/tmp/grade",
    grader: { provider: "codex", model: "gpt-6.1-sol" },
    graderVersion: 3,
    frames: 10,
  } as const;
  const measured: BriefComparison = {
    briefId: "platformer",
    title: "Lantern Hop",
    frameCount: 6,
    harness: grade,
    raw: grade,
    orders: [],
    control: { answer: answer("tie"), passed: true },
    facets: { works: "harness", look: "harness", feel: "tie", play: "raw" },
    verdict: "harness",
    reasons: ["harness-left: harness wins overall — clearer"],
    note: null,
  };
  const missing: BriefComparison = {
    briefId: "racing",
    title: "Ridge Circuit",
    frameCount: 0,
    harness: { ...grade, gradeDirectory: null, grader: null, graderVersion: null, frames: 0 },
    raw: { ...grade, gradeDirectory: null, grader: null, graderVersion: null, frames: 0 },
    orders: [],
    control: { answer: null, passed: false },
    facets: { works: "invalid", look: "invalid", feel: "invalid", play: "invalid" },
    verdict: "invalid",
    reasons: [],
    note: "No graded frames to compare: harness 0, raw 0.",
  };
  const report: ComparisonReport = {
    schemaVersion: 1,
    generatedAt: "2026-10-24T00:00:00.000Z",
    role: "look-feel-comparison",
    grader: { provider: "codex", model: "gpt-6.1-sol" },
    graderVersion: 3,
    harnessDir: "/harness",
    rawDir: "/raw",
    briefs: [missing, measured],
  };
  const markdown = renderComparisonMarkdown(report);
  expect(markdown.indexOf("Lantern Hop")).toBeLessThan(markdown.indexOf("Ridge Circuit"));
  expect(markdown).toContain(
    "| racing | 0 | invalid | invalid | invalid | invalid | invalid | — |",
  );
  expect(markdown).toContain(
    "| platformer | 6 | harness | harness | harness | tie | raw | tie (pass) |",
  );
  expect(markdown).toContain("This is a ruler beside the obligations grade.");
});
