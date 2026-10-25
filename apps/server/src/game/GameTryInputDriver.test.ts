// @effect-diagnostics nodeBuiltinImport:off -- Runs the existing CDP driver against a loopback input fixture.
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
canvas.addEventListener('mousedown', () => { count++; paint(); });
canvas.addEventListener('mousemove', event => { if (event.buttons) { count++; paint(); } });
window.__studioProbe = () => JSON.stringify({ gameState: { count }, player: null });
console.log('Godot Engine v4 fixture');
</script>`;
// A game that is already playing when the run starts, so the recorder's probe
// before the first click is a real gameplay baseline rather than a menu.
const alreadyPlayingHtml = `<!doctype html><canvas width="640" height="360" tabindex="0"></canvas><script>
const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d');
let replies = 0, x = 0;
function paint() {
  ctx.fillStyle = replies === 0 ? '#000000' : '#ffffff';
  ctx.fillRect(0, 0, 640, 360);
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(x, 180, 20, 20);
}
paint();
canvas.addEventListener('mousedown', () => { replies++; x += 20; paint(); });
addEventListener('message', event => {
  if (event.data?.type !== 'studio-visibility') return;
  const visible = event.data.visible === true;
  window.__studioVisibilityAck = { visible, paused: !visible, muted: !visible };
});
window.__studioProbe = () => JSON.stringify({
  gameState: { state: 1, replies },
  player: { x, y: 0, z: 0 },
});
console.log('Godot Engine v4 fixture');
</script>`;
// A Control-style UI game with no avatar: the typed play marker and the
// accepted choice are the only evidence the click did something.
const noPlayerHtml = `<!doctype html><canvas width="640" height="360" tabindex="0"></canvas><script>
const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d');
let choices = 0;
function paint() {
  ctx.fillStyle = '#202020';
  ctx.fillRect(0, 0, 640, 360);
  ctx.fillStyle = choices === 0 ? '#ffffff' : '#7cf2a0';
  ctx.font = '28px sans-serif';
  ctx.fillText(choices === 0 ? 'Choose a reply' : 'Reply sent', 40, 80);
}
paint();
canvas.addEventListener('mousedown', () => { choices++; paint(); });
addEventListener('message', event => {
  if (event.data?.type !== 'studio-visibility') return;
  const visible = event.data.visible === true;
  window.__studioVisibilityAck = { visible, paused: !visible, muted: !visible };
});
window.__studioProbe = () => JSON.stringify({
  gameState: { state: 1, choices },
  player: null,
});
console.log('Godot Engine v4 fixture');
</script>`;

it.live.skipIf(executable === null)(
  "plays presses, holds, clicks, drags and waits headlessly from a fresh boot",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "try-input-driver-")),
          ),
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
        const input = {
          executable: executable!,
          url: `http://127.0.0.1:${address.port}`,
          profileDirectory: NodePath.join(directory, "profile"),
          width: 640,
          height: 360,
          bootTimeoutMs: 5000,
          probeRequired: false,
          acceptance: null,
          captureAllSteps: true,
          captureEveryMs: 100,
          steps: [
            { press: "Space" },
            { hold: "w", holdMs: 200 },
            { click: "left" as const, x: 100, y: 100 },
            { drag: { from: { x: 100, y: 100 }, to: { x: 200, y: 150 } }, holdMs: 200 },
            { waitMs: 200 },
          ],
        };
        const result = yield* playtest(input);
        expect(result.booted).toBe(true);
        expect(result.executedInputSteps).toBe(4);
        for (let stepIndex = 0; stepIndex < 5; stepIndex++) {
          const pair = result.screenshots.filter(
            (frame) => frame.inputPair?.stepIndex === stepIndex,
          );
          expect(pair.map((frame) => frame.inputPair?.phase)).toEqual(["before", "after"]);
          expect(pair.every((frame) => frame.width === 640 && frame.height === 360)).toBe(true);
          expect(pair[1]?.inputPair?.changedPercent).not.toBeNull();
        }
        expect(result.screenshots.filter((frame) => frame.label.includes("during"))).toHaveLength(
          3,
        );
        expect(result.screenshots[2]?.inputPair?.stateChanges).toContainEqual({
          key: "state.count",
          before: 0,
          after: 1,
        });
        const again = yield* playtest({ ...input, steps: [{ press: "Space" }] });
        expect(again.screenshots[1]?.probe?.gameState.count).toBe(0);
        expect(again.screenshots[2]?.probe?.gameState.count).toBe(1);
      }),
    ),
);

it.live.skipIf(executable === null)(
  "baselines an already-playing game before its first click",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "try-input-playing-")),
          ),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        const server = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<NodeHttp.Server>((resolve) => {
                const server = NodeHttp.createServer((_request, response) => {
                  response.writeHead(200, { "Content-Type": "text/html" });
                  response.end(alreadyPlayingHtml);
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
        const result = yield* playtest({
          executable: executable!,
          url: `http://127.0.0.1:${address.port}`,
          profileDirectory: NodePath.join(directory, "profile"),
          width: 640,
          height: 360,
          bootTimeoutMs: 5000,
          probeRequired: true,
          acceptance: [
            {
              id: "first-reply",
              kind: "content",
              text: "the first click sends a reply",
              observe: { key: "replies", expect: ">=1" },
            },
          ],
          steps: [{ click: "left" as const }],
        });
        expect(result.booted, result.message).toBe(true);
        expect(result.state?.before?.gameState.replies, result.message).toBe(0);
        expect(result.state?.changes).toEqual([{ key: "replies", before: 0, after: 1 }]);
        expect(result.state?.playerMoved ?? 0).toBeGreaterThan(0.75);
        expect(result.qualifies, result.message).toBe(true);
        expect(result.blockers).toEqual([]);
        expect(result.pauseConfirmed).toBe(true);
        expect(result.screenshots[1]?.probe?.gameState.replies).toBe(0);
        expect(result.screenshots[2]?.probe?.gameState.replies).toBe(1);
      }),
    ),
  180_000,
);

it.live.skipIf(executable === null)(
  "qualifies a no-player Control UI choice from its typed play marker",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "try-input-ui-"))),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        const server = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<NodeHttp.Server>((resolve) => {
                const server = NodeHttp.createServer((_request, response) => {
                  response.writeHead(200, { "Content-Type": "text/html" });
                  response.end(noPlayerHtml);
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
        const result = yield* playtest({
          executable: executable!,
          url: `http://127.0.0.1:${address.port}`,
          profileDirectory: NodePath.join(directory, "profile"),
          width: 640,
          height: 360,
          bootTimeoutMs: 5000,
          probeRequired: true,
          acceptance: [
            {
              id: "first-choice",
              kind: "content",
              text: "the first click sends a reply",
              observe: { key: "choices", expect: ">=1" },
            },
          ],
          steps: [{ click: "left" as const }],
        });
        expect(result.booted, result.message).toBe(true);
        expect(result.state?.before).toMatchObject({
          gameState: { state: 1, choices: 0 },
          player: null,
        });
        expect(result.state?.after).toMatchObject({
          gameState: { state: 1, choices: 1 },
          player: null,
        });
        expect(result.state?.changes).toEqual([{ key: "choices", before: 0, after: 1 }]);
        expect(result.state?.playerMoved).toBe(0);
        expect(result.qualifies, result.message).toBe(true);
        expect(result.blockers).toEqual([]);
        expect(result.screenshots[1]?.probe?.gameState.choices).toBe(0);
        expect(result.screenshots[2]?.probe?.gameState.choices).toBe(1);
      }),
    ),
  180_000,
);
