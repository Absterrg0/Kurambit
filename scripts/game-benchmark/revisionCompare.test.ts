// @effect-diagnostics nodeBuiltinImport:off -- The comparison test captures real frame packs and reads them back.
import { describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { PNG } from "pngjs";
import type { GameWebPlaytestResult } from "../../packages/contracts/src/index.ts";
import type { LoadedGameBenchmarkBrief } from "./artifacts.ts";
import { captureRevisionFrames, readFramePack, type CaptureRoute } from "./capture.ts";
import { compareFramePacks, type CompareReview } from "./compare.ts";

const brief: LoadedGameBenchmarkBrief = {
  id: "fixture",
  title: "Fixture",
  template: "blank",
  brief: "A tiny platformer: run right and reach the flag.",
  artDirection: "Warm dawn, one bright flag.",
  obligations: [
    { id: "jump", kind: "control", description: "The player jumps.", key: "jumps", expect: ">=1" },
  ],
  path: "/fixtures/fixture.json",
  checksum: "0".repeat(64),
};

const route: CaptureRoute = {
  schemaVersion: 1,
  label: "ordinary input route",
  viewport: { width: 960, height: 540 },
  steps: [{ click: "left" }, { key: "ArrowRight", holdMs: 100 }],
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

const result = (
  captureRoute: CaptureRoute,
  colors: ReadonlyArray<readonly [number, number, number]>,
): GameWebPlaytestResult => {
  const shot = (label: string, color: readonly [number, number, number], stepIndex?: number) => ({
    label,
    mimeType: "image/png" as const,
    data: solid(captureRoute.viewport.width, captureRoute.viewport.height, color).toString(
      "base64",
    ),
    width: captureRoute.viewport.width,
    height: captureRoute.viewport.height,
    ...(stepIndex === undefined
      ? {}
      : {
          inputPair: {
            stepIndex,
            phase: "after" as const,
            input: captureRoute.steps[stepIndex]!,
            changedPercent: 1,
            stateChanges: [],
          },
        }),
  });
  return {
    success: true,
    booted: true,
    bootMs: 500,
    responded: true,
    changedPercent: 42,
    message: "fixture capture",
    consoleMessages: [],
    screenshots: [
      shot("booted", colors[0]!),
      shot("input 1 after: clicked left at 480,270 0ms", colors[1]!, 0),
      shot("input 2 after: held ArrowRight 100ms", colors[2]!, 1),
      shot("after-steps", colors[3]!),
    ],
    state: null,
    executedInputSteps: 2,
  };
};

const withTemp = async (body: (root: string) => Promise<void>) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-revision-test-"));
  try {
    await body(root);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
};

const makePack = async (
  root: string,
  name: string,
  colors: ReadonlyArray<readonly [number, number, number]>,
  captureRoute: CaptureRoute = route,
) => {
  const artifact = NodePath.join(root, `${name}-artifact`);
  await NodeFSP.mkdir(artifact, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(artifact, "index.html"), `${name} exact export`);
  const out = NodePath.join(root, name);
  await captureRevisionFrames({
    artifact: { directory: artifact },
    brief,
    route: captureRoute,
    out,
    browser: "/browser-not-launched",
    deps: { playtest: async () => result(captureRoute, colors) },
  });
  return readFramePack(NodePath.join(out, "frame-pack.json"));
};

const answer = (overall: "A" | "B" | "tie", reason = "the pixels show it") => ({
  works: overall,
  look: overall,
  feel: overall,
  play: overall,
  overall,
  reason,
});

const withPacks = async (
  body: (input: {
    readonly root: string;
    readonly first: Awaited<ReturnType<typeof makePack>>;
    readonly second: Awaited<ReturnType<typeof makePack>>;
    readonly cardsRoot: string;
  }) => Promise<void>,
) =>
  withTemp(async (root) => {
    const first = await makePack(root, "first", [
      [200, 30, 30],
      [120, 30, 30],
      [80, 30, 30],
      [40, 30, 30],
    ]);
    const second = await makePack(root, "second", [
      [30, 30, 200],
      [30, 30, 120],
      [30, 30, 80],
      [30, 30, 40],
    ]);
    await body({ root, first, second, cardsRoot: NodePath.join(root, "cards") });
  });

describe("compareFramePacks", () => {
  it("asks the identical-pair control first and stops after one call when it fails", () =>
    withPacks(async ({ first, second, cardsRoot }) => {
      let calls = 0;
      const review: CompareReview = async () => {
        calls += 1;
        if (calls > 1) throw new Error("orders must not be called after a failed control");
        return {};
      };
      const comparison = await compareFramePacks({
        brief,
        first,
        second,
        cardsRoot,
        review,
      });
      expect(calls).toBe(1);
      expect(comparison.attempted).toEqual(["control"]);
      expect(comparison.orders).toEqual([]);
      expect(comparison.control.passed).toBe(false);
      expect(comparison.control.answer).toBeNull();
      expect(comparison.verdict).toBe("void");
      expect(comparison.reasons[0]).toContain("could not answer");
      expect(comparison.note).toContain("neither order was requested");
    }));

  it("runs both orders after a tied control and agrees when both name the first pack", () =>
    withPacks(async ({ first, second, cardsRoot }) => {
      const answers = [answer("tie", "identical"), answer("A"), answer("B")];
      let calls = 0;
      const review: CompareReview = async () => {
        const reply = answers[calls];
        calls += 1;
        if (reply === undefined) throw new Error("unexpected extra comparison call");
        return reply;
      };
      const comparison = await compareFramePacks({
        brief,
        first,
        second,
        cardsRoot,
        review,
      });
      expect(calls).toBe(3);
      expect(comparison.attempted).toEqual(["control", "harness-left", "raw-left"]);
      expect(comparison.control.passed).toBe(true);
      expect(comparison.orders.map((order) => order.overall)).toEqual(["first", "first"]);
      expect(comparison.verdict).toBe("first");
      expect(comparison.reasons).toEqual([
        "first-left: first wins overall — the pixels show it",
        "second-left: first wins overall — the pixels show it",
      ]);
    }));

  it("cannot produce a valid verdict when one order has no readable answer", () =>
    withPacks(async ({ first, second, cardsRoot }) => {
      let calls = 0;
      const review: CompareReview = async () => {
        calls += 1;
        if (calls === 1) return answer("tie", "identical");
        if (calls === 2) return answer("A");
        throw new Error("quota");
      };
      const comparison = await compareFramePacks({
        brief,
        first,
        second,
        cardsRoot,
        review,
      });
      expect(calls).toBe(3);
      expect(comparison.attempted).toEqual(["control", "harness-left", "raw-left"]);
      expect(comparison.orders.map((order) => order.overall)).toEqual(["first", "invalid"]);
      expect(comparison.verdict).toBe("invalid");
      expect(comparison.control.passed).toBe(true);
    }));

  it("refuses different capture routes before any model call", () =>
    withTemp(async (root) => {
      const first = await makePack(root, "first", [
        [200, 30, 30],
        [120, 30, 30],
        [80, 30, 30],
        [40, 30, 30],
      ]);
      const second = await makePack(
        root,
        "second",
        [
          [30, 30, 200],
          [30, 30, 120],
          [30, 30, 80],
          [30, 30, 40],
        ],
        { ...route, steps: [{ click: "left" }, { key: "ArrowRight", holdMs: 200 }] },
      );
      let calls = 0;
      await expect(
        compareFramePacks({
          brief,
          first,
          second,
          cardsRoot: NodePath.join(root, "cards"),
          review: async () => {
            calls += 1;
            return answer("tie");
          },
        }),
      ).rejects.toThrow(/Capture routes differ/);
      expect(calls).toBe(0);
    }));

  it("refuses packs whose card frames are not the same moments, before any model call", () =>
    withTemp(async (root) => {
      const first = await makePack(root, "first", [
        [200, 30, 30],
        [120, 30, 30],
        [80, 30, 30],
        [40, 30, 30],
      ]);
      // A missing closing frame is still a comparison-ready pack, but its
      // indices no longer name the same moments as the other arm's.
      const artifact = NodePath.join(root, "short-artifact");
      await NodeFSP.mkdir(artifact, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(artifact, "index.html"), "short exact export");
      const out = NodePath.join(root, "short");
      const complete = result(route, [
        [30, 30, 200],
        [30, 30, 120],
        [30, 30, 80],
        [30, 30, 40],
      ]);
      await captureRevisionFrames({
        artifact: { directory: artifact },
        brief,
        route,
        out,
        browser: "/browser-not-launched",
        deps: {
          playtest: async () => ({
            ...complete,
            screenshots: complete.screenshots.filter((shot) => shot.label !== "after-steps"),
          }),
        },
      });
      const second = await readFramePack(NodePath.join(out, "frame-pack.json"));
      let calls = 0;
      await expect(
        compareFramePacks({
          brief,
          first,
          second,
          cardsRoot: NodePath.join(root, "cards"),
          review: async () => {
            calls += 1;
            return answer("tie");
          },
        }),
      ).rejects.toThrow(/different frame sets/);
      expect(calls).toBe(0);
    }));

  it("refuses a manifest whose viewport does not match its frames", () =>
    withPacks(async ({ first, second, cardsRoot }) => {
      const forged = {
        ...second,
        manifest: {
          ...second.manifest,
          route: {
            ...second.manifest.route,
            viewport: { width: 800, height: 450 },
          },
          frames: second.manifest.frames.map((frame) => ({
            ...frame,
            width: 800,
            height: 450,
          })),
        },
      };
      let calls = 0;
      await expect(
        compareFramePacks({
          brief,
          first,
          second: forged,
          cardsRoot,
          review: async () => {
            calls += 1;
            return answer("tie");
          },
        }),
      ).rejects.toThrow(/Capture viewports differ/);
      expect(calls).toBe(0);
    }));
});
