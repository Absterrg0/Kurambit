// Opt-in live probe for setupSteps late-game evidence. NEVER run in normal
// validation (parent runs real JS/Godot probes and the Kitchen late-order
// trial instead). Run explicitly with a real preview browser only:
//   TMPDIR=/home/abstergo/.gs-tmp NODE_OPTIONS=--max-old-space-size=1536 \
//   RAYON_NUM_THREADS=2 vp test run --config ../../vite.config.ts \
//   --dir src src/GameTryInputSetup.live.test.ts --maxWorkers=1 --no-file-parallelism
// @effect-diagnostics nodeBuiltinImport:off -- Opt-in loopback probe against the real CDP driver.
import { it, expect } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { playtest } from "./GameWebPlaytest.ts";

const browserRoot = NodePath.resolve(
  import.meta.dirname,
  "../../../..",
  ".t3/tools/chrome-headless-shell",
);
const executable = (() => {
  if (!NodeFS.existsSync(browserRoot)) return null;
  for (const platform of NodeFS.readdirSync(browserRoot))
    for (const version of NodeFS.readdirSync(NodePath.join(browserRoot, platform))) {
      const file = NodePath.join(browserRoot, platform, version, "chrome-headless-shell");
      if (NodeFS.existsSync(file)) return file;
    }
  return null;
})();
const html = `<!doctype html><canvas width="640" height="360" tabindex="0"></canvas><script>
const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d');
let count = 0;
function paint() { ctx.fillStyle = count % 2 ? '#ffffff' : '#000000'; ctx.fillRect(0, 0, 640, 360); }
paint();
addEventListener('keydown', () => { count++; paint(); });
window.__studioProbe = () => JSON.stringify({ gameState: { count, elapsed: performance.now() }, player: null });
console.log('Godot Engine v4 fixture');
</script>`;

it.live.skipIf(process.env.GAME_STUDIO_TRY_SETUP_LIVE !== "1")(
  "replays a >12-step <30s setup+suffix within the 32-frame cap",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "setup-live-"))),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        const server = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<NodeHttp.Server>((resolve) => {
                const server = NodeHttp.createServer((_request, response) => {
                  response.writeHead(200, { "Content-Type": "text/html" });
                  response.end(html);
                });
                server.listen(0, "127.0.0.1", () => resolve(server));
              }),
          ),
          (server) =>
            Effect.promise(
              () =>
                new Promise<void>((resolve, reject) =>
                  server.close((error) => (error ? reject(error) : resolve())),
                ),
            ),
        );
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("No loopback address");
        if (executable === null) throw new Error("No preview browser for opt-in live probe");
        // The leading observed wait must run after the setup capture boundary.
        const setupLength = 20;
        const fullSteps = [
          ...Array.from({ length: setupLength }, () => ({ press: "Enter" })),
          { waitMs: 200 },
          ...Array.from({ length: 8 }, () => ({ press: "Space" })),
        ];
        const result = yield* playtest({
          executable,
          url: `http://127.0.0.1:${address.port}`,
          profileDirectory: NodePath.join(directory, "profile"),
          width: 640,
          height: 360,
          bootTimeoutMs: 5000,
          probeRequired: false,
          acceptance: null,
          captureAllSteps: true,
          captureEveryMs: 1000,
          steps: fullSteps,
          captureFromStep: setupLength,
        });
        expect(result.booted).toBe(true);
        // No setup frames: every pair belongs to the observed suffix.
        for (const frame of result.screenshots) {
          if (frame.inputPair !== undefined)
            expect(frame.inputPair.stepIndex).toBeGreaterThanOrEqual(setupLength);
        }
        const firstObserved = result.screenshots.find(
          (frame) => frame.inputPair?.stepIndex === setupLength,
        );
        expect(firstObserved?.inputPair?.phase).toBe("before");
        expect(firstObserved?.probe?.gameState.count).toBe(20);
        const waited = result.screenshots.find(
          (frame) =>
            frame.inputPair?.stepIndex === setupLength && frame.inputPair.phase === "after",
        );
        expect(
          Number(waited?.probe?.gameState.elapsed) -
            Number(firstObserved?.probe?.gameState.elapsed),
        ).toBeCloseTo(200, 0);
        expect(
          result.screenshots.findLast((frame) => frame.inputPair?.phase === "after")?.probe
            ?.gameState.count,
        ).toBe(28);
        expect(result.executedInputSteps).toBe(28);
        expect(result.screenshots.length).toBeLessThanOrEqual(32);
      }),
    ),
);
