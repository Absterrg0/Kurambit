// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- The capture fixture writes a real served artifact and reads its own evidence back.
import { describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { PNG } from "pngjs";
import type { GameWebPlaytestResult } from "../../packages/contracts/src/index.ts";
import type { LoadedGameBenchmarkBrief } from "./artifacts.ts";
import {
  CAPTURE_MANIFEST_FILE,
  captureRouteDigest,
  captureRevisionFrames,
  hashArtifact,
  readFramePack,
  type CapturePlaytest,
  type CaptureRevisionOptions,
  type CaptureRoute,
} from "./capture.ts";

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

const shot = (label: string, color: readonly [number, number, number], stepIndex?: number) => ({
  label,
  mimeType: "image/png" as const,
  data: solid(960, 540, color).toString("base64"),
  width: 960,
  height: 540,
  ...(stepIndex === undefined
    ? {}
    : {
        inputPair: {
          stepIndex,
          phase: "after" as const,
          input: route.steps[stepIndex]!,
          changedPercent: 1,
          stateChanges: [],
        },
      }),
});

const result = (): GameWebPlaytestResult => ({
  success: true,
  booted: true,
  bootMs: 500,
  responded: true,
  changedPercent: 42,
  message: "fixture capture",
  consoleMessages: [
    { level: "warning", text: "fixture warning" },
    { level: "error", text: "fixture error" },
  ],
  screenshots: [
    shot("booted", [200, 30, 30]),
    shot("input 1 after: clicked left at 480,270 0ms", [30, 200, 30], 0),
    shot("input 2 after: held ArrowRight 100ms", [30, 30, 200], 1),
    shot("after-steps", [200, 200, 30]),
  ],
  state: null,
  executedInputSteps: 2,
  qualifies: false,
  blockers: ["fixture blocker"],
});

const rejects = async (promise: Promise<unknown>, pattern: RegExp): Promise<void> => {
  let failure: unknown = null;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure instanceof Error ? failure.message : String(failure)).toMatch(pattern);
};

const withTemp = async (body: (root: string) => Promise<void>) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-capture-test-"));
  try {
    await body(root);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
};

const writeArtifact = async (root: string, name = "artifact") => {
  const directory = NodePath.join(root, name);
  await NodeFSP.mkdir(directory, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(directory, "index.html"), "selected build");
  await NodeFSP.writeFile(NodePath.join(directory, "index.wasm"), "wasm bytes");
  return directory;
};

describe("captureRevisionFrames", () => {
  it("serves the exact artifact, captures real route frames and writes a frame pack, not a grade", () =>
    withTemp(async (root) => {
      const artifact = await writeArtifact(root);
      let served: string | null = null;
      const playtest: CapturePlaytest = async (input) => {
        served = await (await fetch(input.url)).text();
        expect(input.width).toBe(960);
        expect(input.height).toBe(540);
        expect(input.captureAllSteps).toBe(true);
        expect(input.steps).toHaveLength(2);
        return result();
      };
      const out = NodePath.join(root, "pack");
      const capture = await captureRevisionFrames({
        artifact: { directory: artifact },
        brief,
        route,
        out,
        browser: "/browser-not-launched",
        deps: { playtest },
      });

      expect(served).toBe("selected build");
      expect(capture.manifest.role).toBe("revision-frame-capture");
      expect(capture.manifest.capture.modelCalls).toBe(0);
      expect(capture.manifest.capture.booted).toBe(true);
      expect(capture.manifest.capture.executedInputSteps).toBe(2);
      expect(capture.manifest.capture.consoleErrors).toBe(1);
      expect(capture.manifest.capture.consoleWarnings).toBe(1);
      expect(capture.manifest.capture.consoleMessages).toEqual(result().consoleMessages);
      expect(capture.manifest.capture.comparisonReady).toBe(true);
      expect(capture.manifest.route.sha256).toBe(captureRouteDigest(route));
      expect(capture.manifest.route.viewport).toEqual({ width: 960, height: 540 });
      expect(capture.manifest.artifact.sha256).toBe((await hashArtifact(artifact, null)).sha256);
      expect(capture.manifest.frames.map((frame) => frame.label)).toEqual([
        "boot, no input",
        "after step 1: clicked left 0ms",
        "after step 2: held ArrowRight 100ms",
        "after step 3: after route — the route ended",
      ]);
      expect(
        await NodeFSP.access(NodePath.join(out, "grade.json")).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      const pack = await readFramePack(NodePath.join(out, CAPTURE_MANIFEST_FILE));
      expect(pack.manifest).toEqual(capture.manifest);
      expect(pack.frames).toHaveLength(4);
      expect(pack.frames.map((frame) => frame.label)).toEqual(
        capture.manifest.frames.map((frame) => frame.label),
      );
    }));

  it("has no review or generation seam to call", () =>
    withTemp(async (root) => {
      const artifact = await writeArtifact(root);
      let reviewRead = false;
      const deps = {
        playtest: async () => result(),
        get review() {
          reviewRead = true;
          return async () => {
            throw new Error("capture must not ask for a review");
          };
        },
      } as unknown as NonNullable<CaptureRevisionOptions["deps"]>;
      await captureRevisionFrames({
        artifact: { directory: artifact },
        brief,
        route,
        out: NodePath.join(root, "pack"),
        browser: "/browser-not-launched",
        deps,
      });
      expect(reviewRead).toBe(false);
    }));

  it("refuses bytes that do not match the declared artifact hash before it serves or plays", () =>
    withTemp(async (root) => {
      const artifact = await writeArtifact(root);
      let played = false;
      const playtest: CapturePlaytest = async () => {
        played = true;
        return result();
      };
      await rejects(
        captureRevisionFrames({
          artifact: { directory: artifact },
          brief,
          route,
          out: NodePath.join(root, "pack"),
          expectedArtifactSha256: "0".repeat(64),
          deps: { playtest },
        }),
        /Artifact bytes do not match the expected sha256/,
      );
      expect(played).toBe(false);
    }));

  it("refuses a changed frame when the pack is read back", () =>
    withTemp(async (root) => {
      const artifact = await writeArtifact(root);
      const out = NodePath.join(root, "pack");
      const capture = await captureRevisionFrames({
        artifact: { directory: artifact },
        brief,
        route,
        out,
        browser: "/browser-not-launched",
        deps: { playtest: async () => result() },
      });
      const first = capture.manifest.frames[0]!;
      await NodeFSP.writeFile(NodePath.join(out, first.file), solid(960, 540, [1, 2, 3]));
      await rejects(
        readFramePack(NodePath.join(out, CAPTURE_MANIFEST_FILE)),
        /changed since capture/,
      );
    }));

  it("refuses a route with no ordinary input step before opening a browser", () =>
    withTemp(async (root) => {
      const artifact = await writeArtifact(root);
      let played = false;
      await rejects(
        captureRevisionFrames({
          artifact: { directory: artifact },
          brief,
          route: { ...route, steps: [{ waitMs: 100 }] },
          out: NodePath.join(root, "pack"),
          browser: "/browser-not-launched",
          deps: {
            playtest: async () => {
              played = true;
              return result();
            },
          },
        }),
        /at least one real input step/,
      );
      expect(played).toBe(false);
    }));
});
