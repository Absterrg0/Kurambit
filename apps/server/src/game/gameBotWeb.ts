// @effect-diagnostics globalTimers:off globalDate:off nodeBuiltinImport:off preferSchemaOverJson:off -- The browser bot launch: headless Chromium on the served folder, stills stitched by ffmpeg, the bot child.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  GAME_BOT_BOUNDS,
  type GameBotFinding,
  type GameBotMode,
  type GameBotRunResult,
} from "@kurambit/contracts";
import {
  READ_STUDIO_READY,
  READ_STUDIO_STATE,
  STUDIO_SET_STATE,
  chromiumLaunchArgs,
  toPlaywrightKey,
} from "./gameChromium.ts";
import { chromiumChildEnv, serveGameDirectory } from "./gameWebServer.ts";
import {
  BOOT_TIMEOUT_MS,
  CHILD_EXTRA_MS,
  CHILD_FIRST_INPUT_MS,
  FRACTION_RE,
  RUNNER_MISS_LIMIT,
  asGameState,
  createLineReader,
  extractRunFrames,
  frozenScreenFinding,
  killPid,
  parseLine,
  sleep,
  type Jev,
  type LineReader,
  type Session,
  headlessEnv,
} from "./gameBotRuntime.ts";
// Playwright needs its files on disk; createRequire also resolves it from a Node SEA executable.
const playRequire = NodeModule.createRequire(import.meta.url);
const loadPlaywright = () => playRequire("playwright-core") as typeof import("playwright-core");

interface WebRunArgs {
  readonly root: string;
  readonly runId: string;
  readonly runDir: string;
  readonly childPath: string;
  readonly videoPath: string;
  readonly tracePath: string;
  readonly botFile: string;
  readonly decider: "policy" | "jev";
  readonly mode: GameBotMode;
  readonly jevLive: boolean;
  readonly seconds: number;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly projectDir: string;
  readonly chrome: string;
  readonly ffmpeg: string;
  readonly jevKey: string | null;
  readonly jevBase: string;
  readonly policyNote: string | null;
  readonly session: Session;
  readonly signal: AbortSignal | undefined;
  /** Where this run stands among its siblings, so runs differ. */
  readonly runIndex: number;
  readonly runTotal: number;
  readonly seed: number;
  readonly priorRuns: ReadonlyArray<{
    readonly topOptions: string;
    readonly cells: number;
    readonly ending: string;
  }>;
}

/**
 * One real-time web run: headless Chromium on the served static folder at
 * normal speed, screenshots stitched into the run video with ffmpeg, the
 * same bot child protocol as the native runner. Web games have no physics
 * sweep or velocity probe, so the overlap and long-fall detectors do not
 * apply; id-clicks have no control tree to land on and are counted, not
 * applied. Explicit set-state writes ride the game's own
 * `window.__studio.setState`.
 */
export const runWebBot = async (jevApi: Jev, args: WebRunArgs): Promise<GameBotRunResult> => {
  const stopped = (): boolean => args.session.stopped || args.signal?.aborted === true;
  let browser: { close: () => Promise<void> } | null = null;
  let botChild: NodeChildProcess.ChildProcess | undefined;
  const track = (child: NodeChildProcess.ChildProcess | undefined): void => {
    if (child?.pid !== undefined) args.session.pids.push(child.pid);
  };
  const killAll = (): void => {
    for (const pid of args.session.pids) killPid(pid);
    try {
      botChild?.kill("SIGTERM");
    } catch {
      /* gone */
    }
  };
  const waitExit = async (
    child: NodeChildProcess.ChildProcess | undefined,
    ms: number,
  ): Promise<void> => {
    if (child === undefined || child.exitCode !== null) return;
    const end = Date.now() + ms;
    while (child.exitCode === null && Date.now() < end) await sleep(100);
    if (child.exitCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* gone */
      }
    }
  };
  let serve: { url: string; close: () => Promise<void> } | null = null;
  const readers: LineReader[] = [];
  try {
    if (stopped()) throw new Error("Bot run stopped.");
    serve = await serveGameDirectory(
      args.root,
      NodePath.relative(args.root, args.projectDir) || ".",
    );
    const origin = new URL(serve.url).origin;
    const { chromium } = loadPlaywright();
    const launched = await chromium.launch({
      executablePath: args.chrome,
      headless: true,
      args: [...chromiumLaunchArgs()],
      env: chromiumChildEnv(),
    });
    browser = launched;
    const page = await launched.newPage({
      viewport: { width: args.viewport.width, height: args.viewport.height },
    });
    const pageErrors: Array<{ message: string; stack?: string | undefined }> = [];
    page.on("pageerror", (error) => {
      if (pageErrors.length < 100)
        pageErrors.push({
          message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
          stack: error instanceof Error ? error.stack : undefined,
        });
    });
    page.on("console", (message) => {
      if (message.type() !== "error" || pageErrors.length >= 100) return;
      pageErrors.push({ message: message.text().slice(0, 500) });
    });
    await page.goto(serve.url, { timeout: BOOT_TIMEOUT_MS, waitUntil: "load" });
    const bootEnd = Date.now() + BOOT_TIMEOUT_MS;
    let booted = false;
    while (Date.now() < bootEnd) {
      if (stopped()) throw new Error("Bot run stopped.");
      try {
        if ((await page.evaluate(READ_STUDIO_READY)) === true) {
          booted = true;
          break;
        }
      } catch {
        /* navigation race; keep polling */
      }
      await sleep(500);
    }
    if (!booted) throw new Error("The three.js page never reported ready in 90s.");
    const framesDir = NodePath.join(args.runDir, "frames");
    await NodeFSP.mkdir(framesDir, { recursive: true });
    const childLog = NodeFS.openSync(NodePath.join(args.runDir, "child-stderr.log"), "w");
    botChild = NodeChildProcess.spawn(
      process.execPath,
      [args.childPath, args.botFile, args.decider, args.mode, args.jevLive ? "jev-live" : "no-jev"],
      {
        env: {
          PATH: process.env.PATH ?? "",
          ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
          NODE_OPTIONS: "--max-old-space-size=1536",
          HOME: NodeOS.homedir(),
          LANG: process.env.LANG ?? "C.UTF-8",
        },
        cwd: args.root,
        detached: false,
        stdio: ["pipe", "pipe", childLog],
      },
    );
    track(botChild);
    const childLines = createLineReader(botChild.stdout!);
    readers.push(childLines);
    let goal = "play the game";
    let childDone: { state: string; note: string; evidence: unknown } | null = null;
    const firstLine = await childLines.next(10_000);
    const first = firstLine === null ? null : parseLine(firstLine);
    if (first !== null && first["op"] === "hello" && typeof first["goal"] === "string")
      goal = (first["goal"] as string).slice(0, 500);
    else if (first !== null && first["op"] === "status")
      childDone = {
        state: String(first["state"] ?? "error"),
        note: String(first["note"] ?? "").slice(0, 500),
        evidence: first["evidence"] ?? {},
      };
    let childGone = false;
    botChild.on("exit", () => {
      childGone = true;
    });
    const findings: GameBotFinding[] = [];
    const seen = new Set<string>();
    const picks: Array<{ t: number; name: string; via: string; randomized: boolean }> = [];
    const offered: Array<{ t: number; options: string[] }> = [];
    const setStates: Array<{ t: number; target: string; values: unknown }> = [];
    const samples: Array<{ t: number; pos: [number, number, number] | null; state: unknown }> = [];
    const jevLog: Array<{ t: number; failure: string }> = [];
    const jevLatencies: Array<{ ms: number; warm: boolean }> = [];
    let jevCalls = 0;
    let jevFailures = 0;
    let jevDecisions2Plus = 0;
    let decisions = 0;
    let ticks = 0;
    let misses = 0;
    let lastT = 0;
    let lastPos: [number, number, number] | null = null;
    let lastGameState: Record<string, number | boolean | string | null> = {};
    let moveWindow: Array<{ wall: number; pos: [number, number, number] }> = [];
    let noMoveReported = false;
    const browserHeld = new Set<string>();
    let skippedIdClicks = 0;
    let shotIndex = 0;
    const pickTrail: Array<{ name: string; pos: [number, number, number] | null }> = [];
    const stuckOf = (): {
      readonly option: string;
      readonly picks: number;
      readonly movedM: number;
    } | null => {
      if (pickTrail.length < 6) return null;
      const tail = pickTrail.slice(-6);
      const name = tail[0]!.name;
      if (!tail.every((entry) => entry.name === name)) return null;
      const base = tail[0]!.pos;
      if (base === null) return null;
      let moved = 0;
      for (const entry of tail) {
        if (entry.pos === null) return null;
        moved = Math.max(
          moved,
          Math.hypot(entry.pos[0] - base[0], entry.pos[1] - base[1], entry.pos[2] - base[2]),
        );
      }
      if (moved >= 1) return null;
      return { option: name, picks: tail.length, movedM: moved };
    };
    const coverageOf = (): {
      readonly cells4m: number;
      readonly samples: number;
      readonly bbox: string | null;
    } => {
      const cells = new Set<string>();
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const sample of samples) {
        if (sample.pos === null) continue;
        const [x, , z] = sample.pos;
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
        cells.add(`${Math.floor(x / 4) * 4},${Math.floor(z / 4) * 4}`);
      }
      return {
        cells4m: cells.size,
        samples: samples.length,
        bbox:
          cells.size === 0
            ? null
            : ` (x ${minX.toFixed(1)}..${maxX.toFixed(1)}, z ${minZ.toFixed(1)}..${maxZ.toFixed(1)})`,
      };
    };
    const wallStart = Date.now();
    const budgetMs = args.seconds * 1000;
    const addFinding = (
      detector: string,
      severity: string,
      summary: string,
      t: number,
      pos: [number, number, number] | null,
      detail: string,
    ): void => {
      const sig = `${detector}:${summary.slice(0, 120)}`;
      if (seen.has(sig) || findings.length >= GAME_BOT_BOUNDS.maxFindings) return;
      seen.add(sig);
      findings.push({ detector, severity, summary, t, pos, detail: detail.slice(0, 400) });
    };
    const writeChild = (msg: Record<string, unknown>): void => {
      try {
        botChild?.stdin?.write(`${JSON.stringify(msg)}\n`);
      } catch {
        /* closed */
      }
    };
    const WEB_MOVERS = new Set([
      "w",
      "a",
      "s",
      "d",
      "W",
      "A",
      "S",
      "D",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Space",
    ]);
    let errorsSeen = 0;
    while (!stopped()) {
      if (childDone !== null || childGone) break;
      if (Date.now() - wallStart > budgetMs) break;
      const loopStart = Date.now();
      const rawState: unknown = await page.evaluate(READ_STUDIO_STATE).catch(() => null);
      if (typeof rawState !== "string") {
        misses += 1;
        if (misses > RUNNER_MISS_LIMIT) throw new Error("The game stopped answering mid-run.");
        await sleep(Math.max(0, 100 - (Date.now() - loopStart)));
        continue;
      }
      misses = 0;
      ticks += 1;
      const t = (Date.now() - wallStart) / 1000;
      lastT = t;
      let parsed: Record<string, unknown> | null = null;
      try {
        const value: unknown = JSON.parse(rawState);
        if (typeof value === "object" && value !== null) parsed = value as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      const pos: [number, number, number] | null =
        parsed !== null &&
        typeof parsed["player"] === "object" &&
        parsed["player"] !== null &&
        typeof (parsed["player"] as Record<string, unknown>)["x"] === "number" &&
        typeof (parsed["player"] as Record<string, unknown>)["y"] === "number" &&
        typeof (parsed["player"] as Record<string, unknown>)["z"] === "number"
          ? [
              (parsed["player"] as Record<string, unknown>)["x"] as number,
              (parsed["player"] as Record<string, unknown>)["y"] as number,
              (parsed["player"] as Record<string, unknown>)["z"] as number,
            ]
          : null;
      if (pos !== null) lastPos = pos;
      const gameState = asGameState(
        (parsed as Record<string, unknown> | null)?.["gameState"] ?? null,
      );
      if (Object.keys(gameState).length > 0) lastGameState = gameState;
      const hudText =
        parsed !== null && typeof parsed["hudText"] === "string"
          ? (parsed["hudText"] as string)
          : "";
      if (pos !== null) {
        if (
          Math.abs(pos[0]) > 2000 ||
          Math.abs(pos[1]) > 2000 ||
          Math.abs(pos[2]) > 2000 ||
          pos[1] < -50
        )
          addFinding(
            "out_of_world",
            "error",
            `Player out of world at (${pos[0].toFixed(0)}, ${pos[1].toFixed(0)}, ${pos[2].toFixed(0)})`,
            t,
            pos,
            "",
          );
      }
      if (hudText !== "") {
        for (const match of hudText.matchAll(new RegExp(FRACTION_RE, "g"))) {
          const a = Number(match[1]);
          const b = Number(match[2]);
          if (b > 0 && a > b)
            addFinding(
              "hud_fraction",
              "error",
              `HUD shows ${a}/${b}: more than its stated maximum`,
              t,
              pos,
              match[0].slice(0, 120),
            );
        }
      }
      if (pos !== null) {
        moveWindow.push({ wall: Date.now(), pos });
        moveWindow = moveWindow.filter((entry) => Date.now() - entry.wall < 2000);
        const moving = [...browserHeld].some((key) => WEB_MOVERS.has(key));
        if (moving && !noMoveReported && moveWindow.length >= 2) {
          const firstPos = moveWindow[0]!.pos;
          const dist = Math.hypot(pos[0] - firstPos[0], pos[1] - firstPos[1], pos[2] - firstPos[2]);
          if (Date.now() - moveWindow[0]!.wall >= 1900 && dist < 0.3) {
            noMoveReported = true;
            addFinding(
              "no_move",
              "warning",
              `Holding ${[...browserHeld]
                .filter((key) => WEB_MOVERS.has(key))
                .slice(0, 3)
                .join("+")} 2s moved nobody (${dist.toFixed(1)}m)`,
              t,
              pos,
              "",
            );
          }
        }
        if (!moving) moveWindow = [];
      }
      if (pageErrors.length > errorsSeen) {
        for (const entry of pageErrors.slice(errorsSeen)) {
          addFinding(
            "log_error",
            "error",
            `Page error: ${entry.message.slice(0, 160)}`,
            t,
            pos,
            (entry.stack ?? "").slice(0, 200),
          );
        }
        errorsSeen = pageErrors.length;
      }
      if (ticks % 10 === 1) {
        samples.push({
          t,
          pos,
          state: typeof gameState["state"] === "string" ? gameState["state"] : null,
        });
        shotIndex += 1;
        await page
          .screenshot({
            path: NodePath.join(framesDir, `shot-${String(shotIndex).padStart(4, "0")}.png`),
          })
          .catch(() => undefined);
      }
      writeChild({
        op: "obs",
        tick: ticks,
        t,
        observation: {
          tick: ticks,
          t,
          // The kit's posOf reads {x, y, z}, the shape the native runner sends.
          probe: {
            gameState,
            player: pos === null ? null : { x: pos[0], y: pos[1], z: pos[2] },
            hudText,
          },
          errors: pageErrors.slice(-5).map((entry) => ({ message: entry.message, where: "" })),
        },
        runContext: {
          seed: args.seed,
          runIndex: args.runIndex,
          runTotal: args.runTotal,
          priorRuns: args.priorRuns,
        },
      });
      let answer: {
        held: string[];
        taps: string[];
        clicks: unknown[];
        setStates: unknown[];
      } | null = null;
      for (let i = 0; i < 8; i++) {
        const line = await childLines.next(i === 0 ? CHILD_FIRST_INPUT_MS : CHILD_EXTRA_MS);
        if (line === null) break;
        const childMsg = parseLine(line);
        if (childMsg === null) continue;
        if (childMsg["op"] === "input") {
          answer = {
            held: Array.isArray(childMsg["held"])
              ? (childMsg["held"] as unknown[]).map(String).slice(0, 8)
              : [],
            taps: Array.isArray(childMsg["taps"])
              ? (childMsg["taps"] as unknown[]).map(String).slice(0, 8)
              : [],
            clicks: Array.isArray(childMsg["clicks"]) ? (childMsg["clicks"] as unknown[]) : [],
            setStates: Array.isArray(childMsg["setStates"])
              ? (childMsg["setStates"] as unknown[])
              : [],
          };
        } else if (childMsg["op"] === "decide") {
          if (args.decider === "jev" && args.jevKey !== null) {
            jevCalls += 1;
            const id = childMsg["id"];
            const decideOpts =
              (childMsg["options"] as Array<{
                name: string;
                description: string;
                facts: unknown;
              }>) ?? [];
            const decideFacts = childMsg["facts"] ?? null;
            const decideTried =
              (childMsg["tried"] as Record<string, { picks: number; ok: number; fail: number }>) ??
              {};
            const decideNow =
              typeof childMsg["nowDoing"] === "string" ? (childMsg["nowDoing"] as string) : null;
            const decideFor =
              typeof childMsg["nowDoingFor"] === "number"
                ? (childMsg["nowDoingFor"] as number)
                : null;
            const decideRecent = (childMsg["recent"] as Array<{ name: string; ok: boolean }>) ?? [];
            const decidePlan = childMsg["plan"] ?? null;
            try {
              const names = (decideOpts as Array<{ name?: unknown }>)
                .map((o) => String(o?.name ?? ""))
                .filter((name) => name !== "");
              if (names.length > 0) offered.push({ t, options: names.slice(0, 20) });
            } catch {
              /* offered is best effort */
            }
            const warm = jevApi.touch(args.jevBase, args.jevKey);
            void (async () => {
              const enriched = decideOpts.map((o) => {
                const name = String(o.name);
                const tried =
                  (decideTried as Record<string, unknown>)[name] !== undefined
                    ? (decideTried as Record<string, unknown>)[name]
                    : { picks: 0, ok: 0, fail: 0 };
                const base =
                  o.facts !== null && typeof o.facts === "object" && !Array.isArray(o.facts)
                    ? (o.facts as Record<string, unknown>)
                    : {};
                return {
                  name,
                  description: String(o.description ?? ""),
                  facts: { ...base, tried },
                };
              });
              const { pick, probs, failure, latencyMs } = await jevApi.pick({
                key: args.jevKey!,
                base: args.jevBase,
                goal,
                facts: decideFacts,
                options: enriched,
                nowDoing: decideNow,
                nowDoingFor: decideFor,
                recent: decideRecent,
                plan: decidePlan,
                tried: decideTried as Record<string, { picks: number; ok: number; fail: number }>,
                coverage: coverageOf(),
                run:
                  args.runTotal > 1
                    ? { index: args.runIndex, total: args.runTotal, priorRuns: args.priorRuns }
                    : null,
                stuck: stuckOf(),
              });
              jevLatencies.push({ ms: latencyMs, warm });
              if (pick === null) {
                jevFailures += 1;
                jevLog.push({ t, failure: failure ?? "unknown" });
              }
              writeChild({ op: "decision", id, pick, probs });
            })();
          } else {
            writeChild({ op: "decision", id: childMsg["id"], pick: null, probs: {} });
          }
        } else if (childMsg["op"] === "picked") {
          decisions += 1;
          const via = String(childMsg["via"] ?? "");
          const twoPlus = childMsg["twoPlus"] === true;
          if (via === "jev" && twoPlus) jevDecisions2Plus += 1;
          const pickedName = String(childMsg["name"] ?? "");
          pickTrail.push({ name: pickedName, pos });
          if (pickTrail.length > 12) pickTrail.shift();
          picks.push({
            t,
            name: pickedName,
            via,
            randomized: childMsg["randomized"] === true,
          });
        } else if (childMsg["op"] === "status") {
          childDone = {
            state: String(childMsg["state"] ?? "error"),
            note: String(childMsg["note"] ?? "").slice(0, 500),
            evidence: childMsg["evidence"] ?? {},
          };
        }
      }
      if (answer === null) answer = { held: [...browserHeld], taps: [], clicks: [], setStates: [] };
      const wanted = new Set(answer.held.map(String));
      for (const key of wanted)
        if (!browserHeld.has(key)) {
          await page.keyboard.down(toPlaywrightKey(key)).catch(() => undefined);
          browserHeld.add(key);
        }
      for (const key of browserHeld)
        if (!wanted.has(key)) {
          await page.keyboard.up(toPlaywrightKey(key)).catch(() => undefined);
          browserHeld.delete(key);
        }
      for (const tap of answer.taps.slice(0, 8)) {
        await page.keyboard.down(toPlaywrightKey(String(tap))).catch(() => undefined);
        await sleep(15);
        await page.keyboard.up(toPlaywrightKey(String(tap))).catch(() => undefined);
      }
      for (const click of answer.clicks) {
        const spec = click as { x?: unknown; y?: unknown };
        if (typeof spec?.x === "number" && typeof spec?.y === "number") {
          await page.mouse.click(Math.round(spec.x), Math.round(spec.y)).catch(() => undefined);
        } else {
          // No control tree on the web: id-clicks have nothing to land on.
          skippedIdClicks += 1;
        }
      }
      for (const entry of answer.setStates) {
        const spec = entry as { target?: unknown; values?: unknown };
        if (typeof spec?.target !== "string") continue;
        const applied = await page
          .evaluate(STUDIO_SET_STATE, {
            target: spec.target,
            values: (spec.values ?? {}) as Record<string, unknown>,
          })
          .catch(() => false);
        setStates.push({ t, target: spec.target, values: spec.values ?? null });
        void applied;
      }
      const elapsed = Date.now() - loopStart;
      if (elapsed < 100) await sleep(100 - elapsed);
    }
    const wallSeconds = Math.max(0.1, (Date.now() - wallStart) / 1000);
    const tickHz = ticks / wallSeconds;
    const gameSeconds = lastT;
    const timeRatio = gameSeconds / wallSeconds;
    const status = childDone ?? {
      state: stopped() ? "error" : "budget",
      note: stopped() ? "The run was stopped." : `Wall budget of ${args.seconds}s ended.`,
      evidence: {},
    };
    try {
      botChild?.stdin?.end();
    } catch {
      /* closed */
    }
    killAll();
    await waitExit(botChild, 3000);
    await page.close().catch(() => undefined);
    // Stills to video: one frame a second stitched at 2 fps, same codec as
    // the native runner so the report and players treat both lanes alike.
    if (shotIndex > 0) {
      await new Promise<void>((resolve) => {
        const child = NodeChildProcess.spawn(
          args.ffmpeg,
          [
            "-y",
            "-framerate",
            "2",
            "-i",
            NodePath.join(framesDir, "shot-%04d.png"),
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-pix_fmt",
            "yuv420p",
            args.videoPath,
          ],
          {
            env: headlessEnv(),
            stdio: "ignore",
          },
        );
        child.once("exit", () => resolve());
        child.once("error", () => resolve());
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* gone */
          }
          resolve();
        }, 120_000).unref?.();
      });
    }
    const usedSetState = setStates.length > 0;
    const frames = await extractRunFrames(args.ffmpeg, args.videoPath, args.runDir);
    const frozen = await frozenScreenFinding(frames, lastT, lastPos);
    const allFindings = frozen === null ? findings : [...findings, frozen];
    const median = (xs: number[]): number | null => {
      if (xs.length === 0) return null;
      const sorted = [...xs].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)]!;
    };
    const jevUsage =
      args.decider === "jev" && args.jevKey !== null
        ? {
            calls: jevCalls,
            failures: jevFailures,
            medianMs: median(jevLatencies.map((entry) => entry.ms)),
            warmMedianMs: median(
              jevLatencies.filter((entry) => entry.warm).map((entry) => entry.ms),
            ),
            decisions2Plus: jevDecisions2Plus,
            valid: jevDecisions2Plus >= 3,
          }
        : null;
    const trace = {
      runId: args.runId,
      file: NodePath.relative(args.root, args.botFile),
      decider: args.decider,
      mode: args.mode,
      goal,
      ticks,
      tickHz: Number(tickHz.toFixed(2)),
      timeRatio: Number(timeRatio.toFixed(3)),
      gameSeconds: Number(gameSeconds.toFixed(2)),
      wallSeconds: Number(wallSeconds.toFixed(1)),
      decisions,
      jev: jevUsage,
      jevLog: jevLog.slice(0, 20),
      policyNote: args.decider === "jev" && args.jevKey === null ? args.policyNote : null,
      usedSetState,
      setStates,
      skippedIdClicks,
      picks,
      offered: offered.slice(0, 400),
      status,
      findings: allFindings,
      samples,
      finalPos: lastPos,
      finalState: lastGameState,
    };
    await NodeFSP.writeFile(args.tracePath, JSON.stringify(trace, null, 2));
    await NodeFSP.writeFile(
      NodePath.join(args.runDir, "summary.json"),
      JSON.stringify({ ...trace, samples: trace.samples.length }, null, 2),
    );
    const jev: GameBotRunResult["jev"] = trace.jev;
    const jevLine =
      jev === null
        ? ""
        : `, Jev ${jev.calls} calls/${jev.failures} failed` +
          `, latency median ${jev.medianMs ?? "?"}ms${jev.warmMedianMs === null || jev.warmMedianMs === undefined ? "" : ` (${jev.warmMedianMs}ms warm)`}` +
          `, ${jev.decisions2Plus ?? 0} decisions among 2+ options` +
          (jev.valid === true ? "" : " (NOT a valid Jev run: fewer than 3)");
    const message =
      `Bot "${trace.file}" (${args.decider}): ${status.state} — ${status.note}. ` +
      `${ticks} ticks at ${tickHz.toFixed(1)} Hz, game/wall ${timeRatio.toFixed(2)}. ` +
      `${decisions} decisions` +
      jevLine +
      (trace.policyNote !== null ? `. ${trace.policyNote}` : "") +
      `. ${allFindings.length} finding(s). ` +
      (usedSetState ? "Used explicit set-state writes (not pure play)." : "Pure input play.") +
      (skippedIdClicks > 0
        ? ` ${skippedIdClicks} id-click(s) skipped: the web lane has no control tree.`
        : "") +
      ` Video: ${args.videoPath}`;
    void origin;
    return {
      runId: args.runId,
      goal,
      status: { state: status.state, note: status.note },
      ticks,
      tickHz: Number(tickHz.toFixed(2)),
      timeRatio: Number(timeRatio.toFixed(3)),
      gameSeconds: Number(gameSeconds.toFixed(2)),
      decisions,
      jev,
      policyNote: trace.policyNote,
      usedSetState,
      findings: allFindings,
      finalState: lastGameState,
      finalPos: lastPos,
      mode: args.mode,
      runIds: [args.runId],
      reportPath: null,
      tracePath: args.tracePath,
      videoPath: args.videoPath,
      frames,
      message,
    };
  } catch (error) {
    killAll();
    throw error;
  } finally {
    for (const reader of readers) reader.close();
    if (browser !== null) await browser.close().catch(() => undefined);
    if (serve !== null) await serve.close().catch(() => undefined);
  }
};
