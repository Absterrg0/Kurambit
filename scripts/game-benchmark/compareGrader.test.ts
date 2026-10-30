// @effect-diagnostics nodeBuiltinImport:off -- Focused tests for --compare/--compare-frames opencode grader path.
import { describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { PNG } from "pngjs";
import { compareBrief, compareFramePacks, runComparison, type CompareReview } from "./compare.ts";
import {
  makeOpenCodeCompareReviewer,
  OPENCODE_COMPARE_REPLY_SHAPE,
  OPENCODE_GRADER_MODEL,
  type OpenCodeRun,
} from "../game-grade.ts";
import type { LoadedGameBenchmarkBrief } from "./artifacts.ts";

const brief: LoadedGameBenchmarkBrief = {
  id: "card-tactics",
  title: "Ember Hand",
  template: "blank",
  brief: "Turn-based card tactics on a 5x5 grid.",
  artDirection: "Parchment-and-ember card frames.",
  obligations: [
    {
      id: "play-card",
      kind: "control",
      description: "Dragging a card plays it.",
      key: "cards_played",
      expect: ">=1",
    },
  ],
  path: "/fixtures/card-tactics.json",
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

const writeGrade = async (
  directory: string,
  colors: ReadonlyArray<readonly [number, number, number]>,
) => {
  await NodeFSP.mkdir(NodePath.join(directory, "grade/frames"), { recursive: true });
  const names = colors.map((_, index) => (index === 0 ? "boot.png" : `step-0${index}.png`));
  for (const [index, name] of names.entries())
    await NodeFSP.writeFile(
      NodePath.join(directory, "grade/frames", name),
      solid(8, 4, colors[index]!),
    );
  await NodeFSP.writeFile(
    NodePath.join(directory, "grade/grade.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        brief: { id: brief.id, title: brief.title, checksum: brief.checksum },
        gameDir: directory,
        model: "opencode/opencode-go/deepseek-v4.1-flash",
        grader: { provider: "opencode", model: "opencode-go/deepseek-v4.1-flash" },
        graderVersion: 4,
        build: { kind: "exported", detail: null },
        quick: {
          booted: true,
          bootMs: 500,
          consoleErrors: 0,
          consoleErrorLines: [],
          responded: false,
          changedPercent: 0.5,
        },
        frames: names.map((name) => `frames/${name}`),
        actions: [],
        obligations: [],
        control: { description: "teapot", yes: false, answered: true, votes: [] },
        void: false,
        inconclusive: false,
        solCalls: 1,
      },
      null,
      2,
    )}\n`,
  );
};

const withLanes = async (
  body: (input: {
    readonly root: string;
    readonly harnessDir: string;
    readonly rawDir: string;
  }) => Promise<void>,
) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-compare-grader-"));
  try {
    const harnessDir = NodePath.join(root, "harness");
    const rawDir = NodePath.join(root, "raw");
    await writeGrade(NodePath.join(harnessDir, brief.id), [
      [200, 30, 30],
      [120, 30, 30],
    ]);
    await writeGrade(NodePath.join(rawDir, brief.id), [
      [30, 30, 200],
      [30, 30, 120],
    ]);
    await body({ root, harnessDir, rawDir });
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
};

const cliText = (text: string) =>
  `${JSON.stringify({ type: "text", part: { type: "text", text } })}\n`;

describe("opencode compare grader", () => {
  it("asks for the comparison JSON shape through the opencode CLI seam", async () => {
    const runs: OpenCodeRun[] = [];
    const reviewer = makeOpenCodeCompareReviewer({
      model: "opencode-go/deepseek-v4.1-flash",
      run: async (run) => {
        runs.push(run);
        return {
          output: cliText(
            '{"works":"A","look":"B","feel":"tie","play":"A","overall":"A","reason":"left reads better"}',
          ),
          exitCode: 0,
        };
      },
    });
    const answer = (await reviewer.review({
      prompt: "Which build reads better?",
      imagePaths: ["/cards/card-01.png"],
    })) as Record<string, string>;
    expect(answer.overall).toBe("A");
    expect(runs.length).toBe(1);
    expect(runs[0]!.model).toBe("opencode-go/deepseek-v4.1-flash");
    expect(runs[0]!.prompt).toContain("Which build reads better?");
    expect(runs[0]!.prompt).toContain(OPENCODE_COMPARE_REPLY_SHAPE);
    expect(runs[0]!.prompt).toContain("Answer with one JSON object and nothing else");
    expect(reviewer.usedModel()).toBe("opencode-go/deepseek-v4.1-flash");
  });

  it("defaults to the frozen opencode grader model when no model is given", async () => {
    const models: string[] = [];
    const reviewer = makeOpenCodeCompareReviewer({
      run: async (run) => {
        models.push(run.model);
        return {
          output: cliText(
            '{"works":"tie","look":"tie","feel":"tie","play":"tie","overall":"tie","reason":"even"}',
          ),
          exitCode: 0,
        };
      },
    });
    await reviewer.review({ prompt: "p", imagePaths: [] });
    expect(models).toEqual([OPENCODE_GRADER_MODEL]);
  });

  it("falls back off the free route on quota without touching DeepSeek", async () => {
    const models: string[] = [];
    const reviewer = makeOpenCodeCompareReviewer({
      run: async (run) => {
        models.push(run.model);
        if (models.length === 1) return { output: "Free usage limit reached", exitCode: 1 };
        return {
          output: cliText(
            '{"works":"tie","look":"tie","feel":"tie","play":"tie","overall":"tie","reason":"even"}',
          ),
          exitCode: 0,
        };
      },
    });
    await reviewer.review({ prompt: "p", imagePaths: [] });
    expect(models.length).toBe(2);
    expect(models.some((model) => model.includes("deepseek"))).toBe(false);
  });

  it("runComparison records the opencode grader and keeps both orders plus the control", () =>
    withLanes(async ({ harnessDir, rawDir, root }) => {
      const out = NodePath.join(root, "out");
      const answers = [
        { overall: "A", works: "A", look: "A", feel: "tie", play: "A", reason: "readable world" },
        { overall: "B", works: "B", look: "B", feel: "tie", play: "B", reason: "readable world" },
        { overall: "tie", reason: "the same frames" },
      ];
      let calls = 0;
      const review: CompareReview = async () => {
        const reply = answers[calls];
        calls += 1;
        if (reply === undefined) throw new Error("unexpected extra comparison call");
        return reply;
      };
      const { report } = await runComparison({
        harnessDir,
        rawDir,
        out,
        briefs: [brief],
        review,
        grader: { provider: "opencode", model: "opencode-go/deepseek-v4.1-flash" },
      });
      expect(report.grader).toEqual({
        provider: "opencode",
        model: "opencode-go/deepseek-v4.1-flash",
      });
      expect(report.briefs.length).toBe(1);
      expect(report.briefs[0]!.verdict).toBe("harness");
      expect(report.briefs[0]!.orders.map((order) => order.order)).toEqual([
        "harness-left",
        "raw-left",
      ]);
      expect(report.briefs[0]!.control.passed).toBe(true);
      // Blind swap: the same build wins from opposite sides.
      expect(report.briefs[0]!.orders.map((order) => order.overall)).toEqual([
        "harness",
        "harness",
      ]);
      // Control voids when it names a winner: the ruler is unchanged.
      const voidReview: CompareReview = async (request) =>
        request.prompt.includes("P1") && calls++ >= 0
          ? { overall: "A", reason: "hallucinated" }
          : { overall: "A", reason: "hallucinated" };
      const voided = await compareBrief({
        brief,
        harness: { gradeDirectory: harnessDir, grader: null, graderVersion: null, frames: [] },
        raw: { gradeDirectory: rawDir, grader: null, graderVersion: null, frames: [] },
        cardsRoot: NodePath.join(root, "unused"),
        review: voidReview,
      });
      expect(voided.verdict).toBe("invalid");
    }));

  it("compareFramePacks records the opencode grader without changing the control-first rule", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "game-compare-frames-grader-"),
    );
    try {
      const { captureRevisionFrames, readFramePack } = await import("./capture.ts");
      const route = {
        schemaVersion: 1 as const,
        label: "r",
        viewport: { width: 640, height: 360 },
        steps: [{ click: "left" }, { key: "ArrowRight", holdMs: 100 }],
      };
      const shot = (
        label: string,
        color: readonly [number, number, number],
        stepIndex?: number,
      ) => ({
        label,
        mimeType: "image/png" as const,
        data: solid(640, 360, color).toString("base64"),
        width: 640,
        height: 360,
        ...(stepIndex === undefined
          ? {}
          : {
              inputPair: {
                stepIndex,
                phase: "after" as const,
                input: (route.steps as ReadonlyArray<never>)[stepIndex]!,
                changedPercent: 1,
                stateChanges: [],
              },
            }),
      });
      const fake = (colors: ReadonlyArray<readonly [number, number, number]>) => async () => ({
        success: true as const,
        booted: true,
        bootMs: 100,
        responded: true,
        changedPercent: 42,
        message: "fake",
        consoleMessages: [],
        screenshots: [
          shot("booted", colors[0]!),
          shot("input 1 after", colors[0]!, 0),
          shot("input 2 after", colors[1]!, 1),
          shot("after-steps", colors[1]!),
        ],
        state: null,
        executedInputSteps: 2,
      });
      const mkPack = async (
        name: string,
        colors: ReadonlyArray<readonly [number, number, number]>,
      ) => {
        const artifact = NodePath.join(root, `${name}-artifact`);
        await NodeFSP.mkdir(artifact, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(artifact, "index.html"), name);
        const out = NodePath.join(root, name);
        await captureRevisionFrames({
          artifact: { directory: artifact },
          brief: { ...brief, id: "fixture", checksum: brief.checksum },
          route: route as never,
          out,
          browser: "/browser-not-launched",
          deps: { playtest: fake(colors) as never },
        });
        return readFramePack(NodePath.join(out, "frame-pack.json"));
      };
      const fixtureBrief = { ...brief, id: "fixture" };
      const first = await mkPack("first", [
        [200, 30, 30],
        [120, 30, 30],
      ]);
      const second = await mkPack("second", [
        [30, 30, 200],
        [30, 30, 120],
      ]);
      const answers = [
        {
          overall: "tie",
          works: "tie",
          look: "tie",
          feel: "tie",
          play: "tie",
          reason: "identical",
        },
        { overall: "A", works: "A", look: "A", feel: "A", play: "A", reason: "first reads better" },
        { overall: "B", works: "B", look: "B", feel: "B", play: "B", reason: "first reads better" },
      ];
      let calls = 0;
      const review: CompareReview = async () => {
        const reply = answers[calls];
        calls += 1;
        if (reply === undefined) throw new Error("unexpected extra call");
        return reply;
      };
      const comparison = await compareFramePacks({
        brief: fixtureBrief,
        first,
        second,
        cardsRoot: NodePath.join(root, "cards"),
        review,
        grader: { provider: "opencode", model: "opencode-go/deepseek-v4.1-flash" },
      });
      expect(comparison.grader).toEqual({
        provider: "opencode",
        model: "opencode-go/deepseek-v4.1-flash",
      });
      expect(comparison.attempted).toEqual(["control", "harness-left", "raw-left"]);
      expect(comparison.verdict).toBe("first");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
