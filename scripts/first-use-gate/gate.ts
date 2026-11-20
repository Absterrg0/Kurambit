#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off globalFetch:off -- Maintainer CLI: owns a private server, polls it, and writes a report to disk.
/**
 * The first-use gate: the golden paths a person takes on their first game, through a real
 * server, with every provider disabled and a stand-in agent (standin.mjs, no model) as the only
 * agent. Each path asserts what the person would see, and the run fails on the first that does
 * not hold.
 *
 *   node scripts/first-use-gate/gate.ts [--home <dir>] [--out <dir>]
 *
 * New game from a brief, the Stage shows a frame, play, Tune a value, Check (look, final), undo,
 * Keep going one step, Blender code, look and export (when the server finds a Blender:
 * KURAMBIT_BLENDER or PATH), export Web. `--home` keeps its `tools/` and `caches/` between runs
 * (the headless browser and Blender add-on the server downloads); the rest starts empty.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as HostProcess from "@kurambit/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RpcClient } from "effect/rpc";
import {
  CommandId,
  MessageId,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS,
  ProviderInstanceId,
  WS_METHODS,
  WsRpcGroup,
  type GameBuild,
  type ThreadId,
} from "../../packages/contracts/src/index.ts";
import { startBenchmarkServer, type BenchmarkServer } from "../lib/benchmark-server.ts";
import { prepareDisplaySandbox } from "../lib/display-sandbox.ts";
import { observationProtocolLayer } from "../lib/observation-transport.ts";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const checkout = NodePath.resolve(here, "../..");
const { values: args } = NodeUtil.parseArgs({
  options: { home: { type: "string" }, out: { type: "string" } },
});
const home = NodePath.resolve(args.home ?? NodePath.join(NodeOS.tmpdir(), "kurambit-gate"));
const out = NodePath.resolve(args.out ?? NodePath.join(home, "report"));
const gamesDir = NodePath.join(home, "games");
const stepsFile = NodePath.join(home, "steps.json");
const answersFile = NodePath.join(home, "answers.jsonl");

const began = Date.now();
const log = (line: string) =>
  console.log(`[gate ${((Date.now() - began) / 1000).toFixed(0).padStart(4)}s] ${line}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fish swims to the reeds and the run is won; its speed is a tunable value. */
const pond = (sky: string, reeds: number) => `import * as THREE from "three";
import { GameState } from "./shell/run-state.js";

export const ACTIONS = { swim: { keys: ["Space"] } };
let fish;
let tune;
export function start(ctx) {
  tune = ctx.tune("fish", { speed: 4 }, { speed: { min: 1, max: 20 } });
  ctx.scene.background = new THREE.Color(${sky});
  ctx.scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 2.2));
  const water = new THREE.Mesh(new THREE.BoxGeometry(30, 0.4, 10), new THREE.MeshStandardMaterial({ color: 0x2d6f9e }));
  water.position.set(4, -0.6, 0);
  ctx.scene.add(water);
  for (let i = 0; i < ${reeds}; i += 1) {
    const reed = new THREE.Mesh(new THREE.BoxGeometry(0.25, 3 + i * 0.4, 0.25), new THREE.MeshStandardMaterial({ color: 0x4f8a3a }));
    reed.position.set(14 + i * 0.9, 1.2, -0.5 + i * 0.4);
    ctx.scene.add(reed);
  }
  fish = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.6, 0.5), new THREE.MeshStandardMaterial({ color: 0xff8a2a }));
  fish.position.set(-6, 0.1, 0);
  fish.name = "Fish";
  ctx.scene.add(fish);
  ctx.thing(fish, { name: "Fish", kind: "player" });
  ctx.player = fish;
  ctx.camera.position.set(4, 6, 16);
  ctx.camera.lookAt(4, 0, 0);
}
export function update(dt) {
  if (GameState.state !== "playing") return;
  fish.position.x += tune.speed * dt;
  fish.position.y = 0.1 + Math.sin(fish.position.x) * 0.15;
  if (fish.position.x > 14) GameState.win("The fish reached the reeds");
}
`;

const BRIEF = "A fish swims across the pond to the reeds.";
const PHRASES = {
  play: "Play the pond and see the fish swim",
  check: "Check the pond as a player sees it",
  blender: "Model a rock for the pond in Blender",
  // The person's note for the step: the turn rules every prompt carries name "Keep going · step".
  step: "Add two more reeds by the bank.",
} as const;

/** What the stand-in does for each message: written before the server starts. */
const standinSteps = {
  [PHRASES.step]: [{ write: ["web/main.js", pond("0x7fb0d8", 5)] }, { reply: "Two more reeds." }],
  [PHRASES.play]: [
    { tool: ["game_play", { start: {} }] },
    {
      tool: [
        "game_play",
        { act: { sessionId: "$last.sessionId", steps: [{ press: "Space" }, { waitMs: 800 }] } },
      ],
    },
    { tool: ["game_play", { close: { sessionId: "$last.sessionId" } }] },
  ],
  [PHRASES.check]: [
    { tool: ["game_check", { look: {} }] },
    { tool: ["game_check", { final: {} }] },
  ],
  [PHRASES.blender]: [
    {
      tool: [
        "game_blender",
        {
          code: {
            code: "import bpy\nbpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=0.5)\nbpy.context.object.name = 'Rock'\nprint('made', bpy.context.object.name)",
          },
        },
      ],
    },
    { tool: ["game_blender", { look: { mode: "review", target: ["Rock"] } }] },
    {
      tool: [
        "game_blender",
        { export: { objects: ["Rock"], file: "web/assets/blender/rock.glb" } },
      ],
    },
  ],
  // Last: later messages may quote the brief.
  [BRIEF]: [{ write: ["web/main.js", pond("0x6f9fc8", 3)] }, { reply: "The pond is up." }],
};

/** Every provider off but the stand-in, an ACP agent run by node. */
async function seedSettings() {
  const off = ["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity", "pi", "muse"];
  const settings = {
    providerInstances: {
      ...Object.fromEntries(off.map((driver) => [driver, { driver, enabled: false }])),
      acpRegistry: {
        driver: "acpRegistry",
        enabled: true,
        displayName: "Stand-in",
        config: {
          source: "local",
          commandPath: process.execPath,
          commandArgs: [NodePath.join(here, "standin.mjs"), stepsFile, answersFile],
        },
      },
    },
  };
  await NodeFSP.mkdir(NodePath.join(home, "userdata"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(home, "userdata", "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
  );
}

/**
 * A fresh home each run, except what the server downloaded: the headless browser (`tools/`) and
 * Blender's pinned add-on (`caches/`).
 */
async function resetHome() {
  await NodeFSP.mkdir(home, { recursive: true });
  for (const entry of await NodeFSP.readdir(home)) {
    if (entry === "tools" || entry === "caches") continue;
    await NodeFSP.rm(NodePath.join(home, entry), { recursive: true, force: true });
  }
  await NodeFSP.mkdir(gamesDir, { recursive: true });
  await NodeFSP.mkdir(out, { recursive: true });
  await NodeFSP.writeFile(stepsFile, JSON.stringify(standinSteps, null, 2));
  await NodeFSP.writeFile(answersFile, "");
}

async function openSession(server: BenchmarkServer): Promise<string> {
  const response = await fetch(`${server.url}/api/auth/browser-session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: server.credential }),
  });
  const cookie = response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
  if (!response.ok || cookie === "") throw new Error(`Pairing failed (${response.status}).`);
  return cookie;
}

const makeClient = RpcClient.make(WsRpcGroup);
type Client = Effect.Success<typeof makeClient>;

let server: BenchmarkServer;
let cookie: string;
/** One call on a fresh socket. */
async function call<A, E>(use: (client: Client) => Effect.Effect<A, E>): Promise<A> {
  const response = await fetch(`${server.url}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { cookie },
  });
  if (!response.ok) throw new Error(`A WebSocket ticket was refused (${response.status}).`);
  const ticket = (await response.json()) as { ticket: string };
  const wsUrl = new URL("/ws", server.url.replace(/^http/, "ws"));
  wsUrl.searchParams.set("wsTicket", ticket.ticket);
  wsUrl.searchParams.set(
    ORCHESTRATION_PROTOCOL_QUERY_PARAM,
    String(ORCHESTRATION_PROTOCOL_VERSION),
  );
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(observationProtocolLayer(wsUrl.toString()));
        const client = yield* makeClient.pipe(Effect.provide(context));
        return yield* use(client);
      }),
    ),
  );
}

const modelSelection = { instanceId: ProviderInstanceId.make("acpRegistry"), model: "standin" };

class GateFailure extends Error {}
const expect = (ok: unknown, what: string): void => {
  if (!ok) throw new GateFailure(what);
};

async function until<A>(
  what: string,
  read: () => Promise<A | null | undefined | false>,
  seconds: number,
) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value as A;
    await sleep(500);
  }
  throw new GateFailure(`timed out after ${seconds} s: ${what}`);
}

const projection = (threadId: ThreadId) =>
  call((client) => client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId }));

const TERMINAL = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);
/** The thread's newest run once it is over and its checkpoint (the build) is captured. */
async function turnEnded(threadId: ThreadId, ordinal: number, seconds = 240) {
  return until(
    `turn ${ordinal} to end`,
    async () => {
      const p = await projection(threadId);
      const run = p.runs.find((each) => each.ordinal === ordinal);
      if (run === undefined || !TERMINAL.has(run.status)) return null;
      if (run.status === "completed" && run.checkpointId === null) return null;
      return { run, projection: p };
    },
    seconds,
  );
}

const newestOrdinal = async (threadId: ThreadId) =>
  Math.max(0, ...(await projection(threadId)).runs.map((run) => run.ordinal));

/** A person's message: the stand-in acts on the phrase it carries. */
async function say(threadId: ThreadId, text: string) {
  const ordinal = (await newestOrdinal(threadId)) + 1;
  await call((client) =>
    client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
      type: "message.dispatch",
      commandId: CommandId.make(`gate:${NodeCrypto.randomUUID()}`),
      createdBy: "user",
      creationSource: "web",
      threadId,
      messageId: MessageId.make(`gate-${NodeCrypto.randomUUID()}`),
      text,
      attachments: [],
      modelSelection,
      dispatchMode: { type: "queue_after_active" },
    } as never),
  );
  const ended = await turnEnded(threadId, ordinal);
  expect(ended.run.status === "completed", `"${text}" ended ${ended.run.status}`);
  return lastAnswers(text);
}

interface ToolAnswer {
  readonly tool: string;
  readonly args: unknown;
  readonly ms: number;
  readonly answer: {
    readonly isError?: boolean;
    readonly error?: string;
    readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
    readonly structuredContent?: Record<string, unknown>;
  };
}
/** The stand-in's tool answers for the last prompt that carried `phrase`. */
function lastAnswers(phrase: string): ReadonlyArray<ToolAnswer> {
  const entries = NodeFS.readFileSync(answersFile, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { key: string | null; answers: Array<ToolAnswer> });
  const key = Object.keys(standinSteps).find((each) => phrase.includes(each));
  return entries.findLast((entry) => entry.key === key)?.answers ?? [];
}

const textOf = (answer: ToolAnswer) =>
  (answer.answer.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
const imagesOf = (answer: ToolAnswer) =>
  (answer.answer.content ?? []).filter((part) => part.type === "image").length;
const succeeded = (answer: ToolAnswer | undefined, what: string) => {
  expect(answer !== undefined, `${what}: the agent's tool call never answered`);
  expect(
    answer!.answer.error === undefined && answer!.answer.isError !== true,
    `${what} was refused: ${(
      /tool call failed: (.*)/.exec(answer!.answer.error ?? "")?.[1] ??
      answer!.answer.error ??
      textOf(answer!)
    ).slice(0, 400)}`,
  );
  return answer!;
};

const builds = async (threadId: ThreadId): Promise<ReadonlyArray<GameBuild>> =>
  (await call((client) => client[WS_METHODS.gameBuilds]({ threadId }))).builds;

const readJson = (file: string) => {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8")) as Record<string, any>;
  } catch {
    return null;
  }
};

/** The headless browser the server installed for its own checks. */
function serverBrowser(): string {
  const root = NodePath.join(home, "tools", "chrome-headless-shell");
  const name =
    HostProcess.Platform.defaultValue() === "win32"
      ? "chrome-headless-shell.exe"
      : "chrome-headless-shell";
  for (const platform of NodeFS.existsSync(root) ? NodeFS.readdirSync(root) : [])
    for (const version of NodeFS.readdirSync(NodePath.join(root, platform))
      .toSorted()
      .toReversed()) {
      const file = NodePath.join(root, platform, version, name);
      if (NodeFS.existsSync(file)) return file;
    }
  throw new GateFailure("the server installed no headless browser");
}

/**
 * The Stage's page as a person's browser loads it, one frame of it, and how much of that frame
 * is the game's own sky and fish: a blank, black or error page has neither.
 */
async function stageFrame(url: string, shot: string) {
  const require = NodeModule.createRequire(NodePath.join(checkout, "apps/server/package.json"));
  const { chromium } = require("playwright-core") as { chromium: Chromium };
  const browser = await chromium.launch({
    executablePath: serverBrowser(),
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const errors: Array<string> = [];
    page.on("pageerror", (error) => errors.push(String(error).slice(0, 300)));
    await page.goto(url);
    await page.locator("canvas").first().waitFor({ timeout: 60_000 });
    await sleep(2500);
    const png = await page.screenshot({ path: shot });
    await page.goto("about:blank");
    const share = (await page.evaluate(
      `(${SHARES})(${JSON.stringify(png.toString("base64"))})`,
    )) as {
      sky: number;
      fish: number;
    };
    return { ...share, errors };
  } finally {
    await browser.close();
  }
}

/** What the gate uses of playwright-core, which it borrows from the server's dependencies. */
interface Chromium {
  launch(options: { executablePath: string; args: Array<string> }): Promise<{
    newPage(options: { viewport: { width: number; height: number } }): Promise<{
      on(event: "pageerror", listener: (error: Error) => void): void;
      goto(url: string): Promise<unknown>;
      locator(selector: string): {
        first(): { waitFor(options: { timeout: number }): Promise<void> };
      };
      screenshot(options: { path: string }): Promise<Buffer>;
      evaluate(expression: string): Promise<unknown>;
    }>;
    close(): Promise<void>;
  }>;
}

/**
 * Run in the browser on a screenshot: the share of its pixels that are the pond's sky, and the
 * share that are the orange fish. Plain JS text, so this file needs no DOM types.
 */
const SHARES = `async (data) => {
  const image = new Image();
  image.src = "data:image/png;base64," + data;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const draw = canvas.getContext("2d");
  draw.drawImage(image, 0, 0);
  const pixels = draw.getImageData(0, 0, image.width, image.height).data;
  let sky = 0;
  let fish = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    if (Math.abs(r - 0x6f) + Math.abs(g - 0x9f) + Math.abs(b - 0xc8) < 60) sky += 1;
    if (r > 140 && r - g > 50 && g - b > 30) fish += 1;
  }
  const all = pixels.length / 4;
  return { sky: sky / all, fish: fish / all };
}`;

interface PathResult {
  readonly path: string;
  readonly ok: boolean;
  readonly seconds: number;
  readonly saw: string;
}
const results: Array<PathResult> = [];
async function path(name: string, run: () => Promise<string>) {
  const started = Date.now();
  try {
    const saw = await run();
    results.push({ path: name, ok: true, seconds: (Date.now() - started) / 1000, saw });
    log(`ok   ${name}: ${saw}`);
  } catch (cause) {
    const saw = cause instanceof Error ? cause.message : String(cause);
    results.push({ path: name, ok: false, seconds: (Date.now() - started) / 1000, saw });
    log(`FAIL ${name}: ${saw}`);
    throw cause;
  }
}

async function main() {
  await resetHome();
  await seedSettings();
  const sandbox = await prepareDisplaySandbox(home);
  // The server's scratch stays inside the gate's home, so a run leaves nothing behind it.
  const scratch = NodePath.join(home, "tmp");
  await NodeFSP.mkdir(scratch, { recursive: true });
  sandbox.environment.TMPDIR = scratch;
  sandbox.environment.TEMP = scratch;
  sandbox.environment.TMP = scratch;
  server = await startBenchmarkServer({
    checkout,
    homeDir: home,
    sandbox,
    logPath: NodePath.join(out, "server.log"),
    provider: "acpRegistry",
  });
  log(`server up (pid ${server.pid})`);
  try {
    cookie = await openSession(server);
    let threadId!: ThreadId;
    let root!: string;

    await path("new game from a brief", async () => {
      const game = await call((client) =>
        client[WS_METHODS.gameCreate]({
          name: "Pond",
          parentDirectory: gamesDir,
          brief: BRIEF,
          engine: "three",
          // The Blender route lists game_blender: the Blender path needs it.
          characters: "blender",
          modelSelection,
        } as never),
      );
      threadId = game.threadId;
      root = game.root;
      const ended = await turnEnded(threadId, 1);
      expect(ended.run.status === "completed", `the first turn ended ${ended.run.status}`);
      const build = await until(
        "the first turn's build",
        async () => (await builds(threadId))[0],
        60,
      );
      expect(build.source._tag === "turn", `the first build came from ${build.source._tag}`);
      const ref = { threadId, build: { _tag: "build" as const, build: build.id } };
      const facts = await until(
        "the first build's facts",
        async () => {
          const read = await call((client) => client[WS_METHODS.gameBuildFacts](ref));
          return read.state === "measured" || read.state === "incomplete" ? read : null;
        },
        240,
      );
      expect(
        facts.boots.status === "measured" && facts.boots.value.ok,
        `the first build does not boot: ${JSON.stringify(facts.boots).slice(0, 300)}`,
      );
      return `build ${build.number} from the first turn, boots`;
    });

    await path("the Stage shows a frame", async () => {
      const preview = await call((client) =>
        client[WS_METHODS.gameAction]({ threadId, action: "preview" }),
      );
      expect(preview.url !== null, `the Stage has no URL: ${preview.message}`);
      const frame = await stageFrame(preview.url!, NodePath.join(out, "stage.png"));
      expect(frame.errors.length === 0, `the Stage's page threw: ${frame.errors.join(" | ")}`);
      expect(frame.sky > 0.2, `the Stage shows ${Math.round(frame.sky * 100)}% of the game's sky`);
      expect(frame.fish > 0.0002, "the Stage shows no fish");
      return `${Math.round(frame.sky * 100)}% sky, fish on screen (stage.png)`;
    });

    await path("play", async () => {
      const answers = await say(threadId, PHRASES.play);
      const start = succeeded(answers[0], "game_play start");
      const act = succeeded(answers[1], "game_play act");
      succeeded(answers[2], "game_play close");
      const result = act.answer.structuredContent ?? {};
      expect(typeof result.screenshotPath === "string", "the play answered no frame");
      const player = (result.probe as { player?: { x?: number } } | null)?.player;
      expect(typeof player?.x === "number" && player.x > -6, "the fish did not swim while played");
      return `played ${result.nominalMs} ms of game after a ${start.answer.structuredContent?.bootMs} ms boot; the fish swam to x ${player!.x!.toFixed(1)}`;
    });

    let tuned!: GameBuild;
    await path("Tune a value", async () => {
      const kept = await call((client) =>
        client[WS_METHODS.gameKeepValues]({
          threadId,
          things: [{ id: "fish", values: [{ key: "speed", value: 9, min: 1, max: 20 }] }],
        }),
      );
      expect(
        readJson(NodePath.join(root, "web/tune.json"))?.fish?.speed === 9,
        "tune.json lacks the tuned speed",
      );
      tuned = await until(
        "the tuning's build",
        async () => (await builds(threadId)).find((build) => build.id === kept.build),
        30,
      );
      return `speed 9 in tune.json, build ${tuned.number} "${tuned.summary}"`;
    });

    await path("Check (look, final)", async () => {
      const answers = await say(threadId, PHRASES.check);
      const look = succeeded(answers[0], "game_check look");
      const final = succeeded(answers[1], "game_check final");
      expect(imagesOf(look) >= 1, "the look attached no picture");
      expect(imagesOf(final) >= 1, "the final check attached no picture");
      const lookText = textOf(look);
      expect(lookText.length > 0, "the look answered no text");
      return `look ${lookText.length} chars + ${imagesOf(look)} image(s), final ${textOf(final).length} chars + ${imagesOf(final)}`;
    });

    await path("undo", async () => {
      const undone = await call((client) =>
        client[WS_METHODS.gameBuildUndo]({ threadId, build: tuned.id }),
      );
      expect(undone._tag === "undone", `undo answered ${undone._tag}: ${undone.message}`);
      expect(
        readJson(NodePath.join(root, "web/tune.json"))?.fish?.speed !== 9,
        "the tuned speed is still in tune.json",
      );
      return `the tuning is undone (${undone.message.slice(0, 80)})`;
    });

    await path("Keep going one step", async () => {
      const before = new Set((await builds(threadId)).map((build) => build.id));
      await call((client) =>
        client[WS_METHODS.gameKeepGoing]({
          threadId,
          commandId: `gate-${NodeCrypto.randomUUID()}`,
          mode: "autopilot",
          budgetMinutes: 10,
          note: PHRASES.step,
        } as never),
      );
      try {
        const step = await until(
          "a keep-going step's build",
          async () =>
            (await builds(threadId)).find(
              (build) =>
                !before.has(build.id) && build.source._tag === "turn" && build.source.step !== null,
            ),
          300,
        );
        const main = NodeFS.readFileSync(NodePath.join(root, "web/main.js"), "utf8");
        expect(main.includes("i < 5"), "the step's change is not in the game");
        return `step ${step.source._tag === "turn" ? step.source.step?.n : "?"} made build ${step.number}`;
      } finally {
        await call((client) =>
          client[WS_METHODS.gameKeepGoing]({
            threadId,
            commandId: `gate-${NodeCrypto.randomUUID()}`,
            mode: "off",
          } as never),
        );
        await until(
          "keep going to stop",
          async () => {
            const p = await projection(threadId);
            return p.runs.every(
              (run) =>
                TERMINAL.has(run.status) &&
                (run.status !== "completed" || run.checkpointId !== null),
            );
          },
          240,
        );
      }
    });

    const toolchain = await call((client) => client[WS_METHODS.gameToolchainStatus]({}));
    const hasBlender = toolchain.tools.some(
      (tool) => tool.tool === "blender" && tool.installed && tool.status !== "error",
    );
    if (hasBlender) {
      await path("Blender code, look and export", async () => {
        const answers = await say(threadId, PHRASES.blender);
        const code = succeeded(answers[0], "game_blender code");
        const look = succeeded(answers[1], "game_blender look");
        succeeded(answers[2], "game_blender export");
        expect(textOf(code).includes("made Rock"), "Blender's code printed nothing");
        expect(imagesOf(look) >= 1, "Blender's look attached no picture");
        expect(
          NodeFS.existsSync(NodePath.join(root, "web/assets/blender/rock.glb")),
          "the rock's GLB is missing",
        );
        return `rock.glb exported, look ${imagesOf(look)} image(s)`;
      });
    } else log("skip Blender: the server found none (set KURAMBIT_BLENDER)");

    await path("export Web", async () => {
      // The Stage's Export… → Web, then its download.
      const exported = await call((client) =>
        client[WS_METHODS.gameAction]({ threadId, action: "rebuild" }),
      );
      expect(exported.success, `Export Web failed: ${exported.message}`);
      const zip = await call((client) => client[WS_METHODS.gameWebPackage]({ threadId }));
      expect(NodeFS.existsSync(zip.archivePath), "the Web ZIP is not on disk");
      expect(
        zip.files.some((file) => file.path === "index.html"),
        `the Web ZIP holds no index.html (${zip.files
          .map((file) => file.path)
          .slice(0, 8)
          .join(", ")})`,
      );
      return `${zip.files.length} files in ${NodePath.basename(zip.archivePath)}`;
    });
  } finally {
    await server.stop();
    const seconds = Math.round((Date.now() - began) / 1000);
    await NodeFSP.writeFile(
      NodePath.join(out, "gate.json"),
      `${JSON.stringify({ seconds, results }, null, 2)}\n`,
    );
    log(
      `server stopped; ${results.filter((each) => each.ok).length}/${results.length} paths in ${seconds} s`,
    );
  }
}

main().catch((cause) => {
  console.error(cause instanceof GateFailure ? `first-use gate failed: ${cause.message}` : cause);
  process.exit(1);
});
