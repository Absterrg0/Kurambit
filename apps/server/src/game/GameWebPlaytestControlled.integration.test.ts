// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Root-owned live probe launches a real browser; wall-clock delays prove frozen game time.
// A real rAF counter catches clock APIs that accept a request but leave time frozen.
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as Effect from "effect/Effect";

const requirePlaywright = NodeModule.createRequire(import.meta.url);
const loadPlaywright = () =>
  requirePlaywright("playwright-core") as typeof import("playwright-core");

const workspaceRoot = (() => {
  let directory = process.cwd();
  for (
    let hops = 0;
    hops < 5 && !NodeFS.existsSync(NodePath.join(directory, "apps/server/package.json"));
    hops++
  ) {
    directory = NodePath.resolve(directory, "..");
  }
  return directory;
})();
const browserExecutable = (() => {
  const installRoot = NodePath.join(
    NodePath.join(workspaceRoot, ".t3"),
    "tools",
    "chrome-headless-shell",
  );
  if (!NodeFS.existsSync(installRoot)) return null;
  for (const platform of NodeFS.readdirSync(installRoot)) {
    const platformPath = NodePath.join(installRoot, platform);
    for (const version of NodeFS.readdirSync(platformPath)) {
      for (const name of ["chrome-headless-shell", "chrome-headless-shell.exe"]) {
        const candidate = NodePath.join(platformPath, version, name);
        if (NodeFS.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
})();
const browserAvailable = browserExecutable !== null;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it.live.skipIf(!browserAvailable)(
  "controlled clock freezes rAF and performance.now across wall-clock capture work",
  () =>
    Effect.gen(function* () {
      const { chromium } = loadPlaywright();
      const browser = yield* Effect.promise(() =>
        chromium.launch({
          executablePath: browserExecutable!,
          headless: true,
          args: [
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--mute-audio",
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
          ],
        }),
      );
      try {
        const report = yield* Effect.promise(async () => {
          const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
          try {
            await page.clock.install();
            await page.goto("about:blank");
            await page.evaluate(`window.n = 0;
              function tick() { window.n++; requestAnimationFrame(tick); }
              requestAnimationFrame(tick);`);
            await delay(200);
            const pausedAt = (await page.evaluate(`Date.now()`)) as number;
            await page.clock.pauseAt(pausedAt + 100);
            const paused0 = (await page.evaluate(
              `({ time: performance.now(), frames: window.n })`,
            )) as { time: number; frames: number };
            await delay(200);
            const paused1 = (await page.evaluate(
              `({ time: performance.now(), frames: window.n })`,
            )) as { time: number; frames: number };
            await page.screenshot({ type: "png" });
            await delay(200);
            const afterCapture = (await page.evaluate(
              `({ time: performance.now(), frames: window.n })`,
            )) as { time: number; frames: number };
            await page.clock.runFor(250);
            const afterRun = (await page.evaluate(
              `({ time: performance.now(), frames: window.n })`,
            )) as { time: number; frames: number };
            await page.clock.resume();
            return { paused0, paused1, afterCapture, afterRun };
          } finally {
            await page.close();
          }
        });
        // Wall time passed but the game clock did not: a fictional resume
        // policy that silently keeps RAF frozen would fail the runFor below.
        expect(report.paused1.time).toBe(report.paused0.time);
        expect(report.paused1.frames).toBe(report.paused0.frames);
        expect(report.afterCapture.time).toBe(report.paused0.time);
        expect(report.afterCapture.frames).toBe(report.paused0.frames);
        expect(report.afterRun.time).toBeGreaterThan(report.paused0.time);
        expect(report.afterRun.frames).toBeGreaterThan(report.paused0.frames);
      } finally {
        yield* Effect.promise(() => browser.close());
      }
    }),
  120_000,
);
