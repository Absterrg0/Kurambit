// @effect-diagnostics globalTimers:off globalDate:off nodeBuiltinImport:off preferSchemaOverJson:off -- The Godot native bot launch: private Xvfb display, Godot, ffmpeg x11grab and the bot child, by pid.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  GAME_BOT_BOUNDS,
  type GameBotFinding,
  type GameBotMode,
  type GameBotRunResult,
} from "@kurambit/contracts";
import { type NativeUserIsolation } from "./gameNativeUserDir.ts";
import { nativeChildEnv, nativeGodotArgs } from "./gameExploreNative.ts";
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
  MOVERS,
  RUNNER_OBS_TIMEOUT_MS,
  asNumber,
  claimed,
  perfFrom,
  pickDisplay,
  posOf,
  waitDisplay,
} from "./gameBotRuntime.ts";

interface NativeRunArgs {
  readonly root: string;
  readonly runId: string;
  readonly runDir: string;
  readonly scriptPath: string;
  readonly requestPath: string;
  readonly childPath: string;
  readonly videoPath: string;
  readonly tracePath: string;
  readonly botFile: string;
  readonly decider: "policy" | "jev";
  readonly mode: GameBotMode;
  readonly jevLive: boolean;
  readonly seconds: number;
  readonly token: string;
  readonly isolation: NativeUserIsolation;
  readonly viewport: { width: number; height: number };
  readonly godotPath: string;
  readonly projectDir: string;
  readonly ffmpeg: string;
  readonly xvfb: string;
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
 * One real-time run: private Xvfb display, Godot unpaused at normal speed,
 * one continuous ffmpeg x11grab, a 10 Hz controller loop bridging the game
 * and the bot child. Per-tick screenshots never happen (that capped T20 at
 * ~1 Hz); the video is the picture and frames are extracted afterwards.
 */
export const runNativeBot = async (jevApi: Jev, args: NativeRunArgs): Promise<GameBotRunResult> => {
  const stopped = (): boolean => args.session.stopped || args.signal?.aborted === true;
  let godotChild: NodeChildProcess.ChildProcess | undefined;
  let ffmpegChild: NodeChildProcess.ChildProcess | undefined;
  let botChild: NodeChildProcess.ChildProcess | undefined;
  let xvfbChild: NodeChildProcess.ChildProcess | undefined;
  const runner: { socket: NodeNet.Socket | null } = { socket: null };
  const readers: LineReader[] = [];
  const server: NodeNet.Server = NodeNet.createServer();
  const track = (child: NodeChildProcess.ChildProcess | undefined): void => {
    if (child?.pid !== undefined) args.session.pids.push(child.pid);
  };
  const killAll = (): void => {
    for (const pid of args.session.pids) killPid(pid);
    for (const child of [godotChild, botChild, xvfbChild]) {
      try {
        child?.kill("SIGTERM");
      } catch {
        /* gone */
      }
    }
    try {
      // SIGINT lets ffmpeg finalize the mp4; anything else just dies.
      if (ffmpegChild !== undefined && ffmpegChild.exitCode === null) ffmpegChild.kill("SIGINT");
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
      const end2 = Date.now() + 2000;
      while (child.exitCode === null && Date.now() < end2) await sleep(100);
      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* gone */
        }
      }
    }
  };
  let picked: number | null = null;
  try {
    if (stopped()) throw new Error("Bot run stopped.");
    const display = await pickDisplay();
    if (display === null) throw new Error("No free private X display.");
    picked = display;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const port = (server.address() as NodeNet.AddressInfo).port;
    server.on("connection", (sock) => {
      if (runner.socket !== null) {
        sock.destroy();
        return;
      }
      runner.socket = sock;
    });
    await NodeFSP.writeFile(
      args.requestPath,
      JSON.stringify({
        port,
        token: args.token,
        bootScreenshotPath: null,
        expectedUserDataPrefix: args.isolation.dataDir,
      }),
    );
    const displayEnv = { ...nativeChildEnv(args.isolation), DISPLAY: `:${display}` };
    xvfbChild = NodeChildProcess.spawn(
      args.xvfb,
      [`:${display}`, "-screen", "0", `${args.viewport.width}x${args.viewport.height}x24`],
      { env: displayEnv, detached: true, stdio: "ignore" },
    );
    xvfbChild.unref();
    track(xvfbChild);
    if (!(await waitDisplay(display, 15_000)))
      throw new Error("The private display did not start.");
    const ffmpegLog = NodeFS.openSync(NodePath.join(args.runDir, "ffmpeg.log"), "w");
    ffmpegChild = NodeChildProcess.spawn(
      args.ffmpeg,
      [
        "-y",
        "-f",
        "x11grab",
        "-video_size",
        `${args.viewport.width}x${args.viewport.height}`,
        "-framerate",
        "12",
        "-i",
        `:${display}`,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        args.videoPath,
      ],
      {
        env: displayEnv,
        detached: false,
        stdio: ["ignore", ffmpegLog, ffmpegLog],
      },
    );
    track(ffmpegChild);
    const godotLog = NodeFS.openSync(NodePath.join(args.runDir, "godot.log"), "w");
    godotChild = NodeChildProcess.spawn(
      args.godotPath,
      [
        ...nativeGodotArgs({
          projectDir: args.projectDir,
          scriptPath: args.scriptPath,
          requestPath: args.requestPath,
          width: args.viewport.width,
          height: args.viewport.height,
          hasDisplay: true,
        }),
      ],
      {
        env: displayEnv,
        cwd: args.projectDir,
        detached: true,
        stdio: ["ignore", godotLog, godotLog],
      },
    );
    godotChild.unref();
    track(godotChild);
    const waitSocket = async (): Promise<NodeNet.Socket> => {
      const end = Date.now() + BOOT_TIMEOUT_MS;
      while (Date.now() < end) {
        if (runner.socket !== null) return runner.socket;
        if (stopped()) throw new Error("Bot run stopped.");
        await sleep(50);
      }
      throw new Error("The bot runner never connected.");
    };
    const socket = await waitSocket();
    const runnerLines = createLineReader(socket);
    readers.push(runnerLines);
    let hello: Record<string, unknown> | null = null;
    const bootEnd = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < bootEnd) {
      if (stopped()) throw new Error("Bot run stopped.");
      const line = await runnerLines.next(Math.min(2000, Math.max(100, bootEnd - Date.now())));
      if (line === null) continue;
      const parsed = parseLine(line.trim());
      if (parsed === null) continue;
      if (typeof parsed["error"] === "string") throw new Error(parsed["error"] as string);
      if (parsed["token"] === args.token && parsed["boot"] === true) {
        hello = parsed;
        break;
      }
    }
    if (hello === null) throw new Error("The bot runner did not boot in 90s.");
    // The bot child: allowlisted environment only, so no key or display
    // route can reach it. Game data reaches it only through our messages.
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
    let lastObsWall = Date.now();
    let lastT = 0;
    let lastPos: [number, number, number] | null = null;
    let lastGameState: Record<string, number | boolean | string | null> = {};
    let perf = perfFrom(hello["perf"], null);
    let fallStart: number | null = null;
    let overlapStreak = 0;
    let moveWindow: Array<{ wall: number; pos: [number, number, number] }> = [];
    let noMoveReported = false;
    let lastHeld: string[] = [];
    // Stuck watch (service side, positions only): the last picks with the
    // player position at pick time. Six same-name picks inside a metre
    // means the choice is not moving play, whatever Jev hoped.
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
    // Visited-area coverage (service side): 4 m cells over x/z plus the
    // bounding box, from the same samples the report uses.
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
    const writeRunner = (msg: Record<string, unknown>): void => {
      try {
        runner.socket?.write(`${JSON.stringify(msg)}\n`);
      } catch {
        /* closed */
      }
    };
    let setStateId = 0;
    let inputId = 0;
    while (!stopped()) {
      if (childDone !== null || childGone) break;
      if (Date.now() - wallStart > budgetMs) break;
      const raw = await runnerLines.next(RUNNER_OBS_TIMEOUT_MS);
      if (raw === null) {
        misses += 1;
        if (misses > RUNNER_MISS_LIMIT) throw new Error("The game stopped answering mid-run.");
        continue;
      }
      const msg = parseLine(raw.trim());
      if (msg === null || typeof msg["tick"] !== "number") continue;
      misses = 0;
      ticks += 1;
      const wallNow = Date.now();
      const gap = wallNow - lastObsWall;
      const t = asNumber(msg["t"]) ?? lastT;
      lastT = t;
      const pos = posOf(msg);
      if (pos !== null) lastPos = pos;
      const gameState = asGameState(
        (msg["probe"] as Record<string, unknown> | undefined)?.["gameState"],
      );
      if (Object.keys(gameState).length > 0) lastGameState = gameState;
      perf = perfFrom(msg["perf"], perf);
      // Detectors, adapted from the Aura in-game checks (Apache-2.0) plus
      // the sweep's movement/hitch probes; the code here is our own.
      if (gap > 1500 && ticks > 2)
        addFinding("hitch", "warning", `No tick for ${(gap / 1000).toFixed(1)}s wall`, t, pos, "");
      lastObsWall = wallNow;
      for (const entry of (msg["errors"] as Array<{ message: string; where: string }>) ?? []) {
        if (typeof entry?.message !== "string") continue;
        const category = /script|parse/i.test(`${entry.message} ${entry.where ?? ""}`)
          ? "Script"
          : "Engine";
        addFinding(
          "log_error",
          "error",
          `${category} error: ${entry.message.slice(0, 160)}`,
          t,
          pos,
          String(entry.where ?? ""),
        );
      }
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
      const body = msg["body"] as Record<string, unknown> | null | undefined;
      if (body !== null && body !== undefined && typeof body === "object") {
        const vy = asNumber(body["vy"]);
        if (body["onGround"] === false && vy !== null && vy < -1) {
          if (fallStart === null) fallStart = t;
          else if (t - fallStart >= 6)
            addFinding("long_fall", "error", "Player kept falling for 6s", t, pos, "");
        } else fallStart = null;
      } else fallStart = null;
      const sweep = msg["sweep"] as { overlaps?: unknown; overlapNames?: unknown } | null;
      if (sweep !== null && typeof sweep === "object" && typeof sweep.overlaps === "number") {
        if (sweep.overlaps > 0) {
          overlapStreak += 1;
          if (overlapStreak === 2)
            addFinding(
              "overlap",
              "error",
              `Player overlapping solid geometry (${sweep.overlaps} at ${String(sweep.overlapNames ?? "").slice(0, 120)})`,
              t,
              pos,
              "",
            );
        } else overlapStreak = 0;
      }
      if (pos !== null) {
        moveWindow.push({ wall: wallNow, pos });
        moveWindow = moveWindow.filter((entry) => wallNow - entry.wall < 2000);
        const moving = lastHeld.some((key) => MOVERS.has(key));
        if (moving && !noMoveReported && moveWindow.length >= 2) {
          const first = moveWindow[0]!.pos;
          const dist = Math.hypot(pos[0] - first[0], pos[1] - first[1], pos[2] - first[2]);
          if (wallNow - moveWindow[0]!.wall >= 1900 && dist < 0.3) {
            noMoveReported = true;
            addFinding(
              "no_move",
              "warning",
              `Holding ${lastHeld
                .filter((key) => MOVERS.has(key))
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
      const hudText = (msg["probe"] as Record<string, unknown> | undefined)?.["hudText"];
      if (typeof hudText === "string" && hudText !== "") {
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
      if (ticks % 10 === 1) {
        samples.push({
          t,
          pos,
          state: typeof gameState["state"] === "string" ? gameState["state"] : null,
        });
      }
      writeChild({
        op: "obs",
        tick: ticks,
        t,
        observation: msg,
        runContext: {
          seed: args.seed,
          runIndex: args.runIndex,
          runTotal: args.runTotal,
          priorRuns: args.priorRuns,
        },
      });
      // The child answers each tick with its inputs; decide/picked/status
      // ride the same stream and are handled here, never blocking play.
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
            // The child's own per-option tried counts (picks, ok, fail),
            // tracked for every run even when the bot tracks nothing.
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
            // What the bot offered, whether or not Jev was asked: the
            // player report needs offered-but-never-picked options too.
            try {
              const names = (decideOpts as Array<{ name?: unknown }>)
                .map((o) => String(o?.name ?? ""))
                .filter((name) => name !== "");
              if (names.length > 0) offered.push({ t, options: names.slice(0, 20) });
            } catch {
              /* offered is best effort */
            }
            // Re-warm when Jev sat idle: the next decision must not wait
            // on a new connection.
            const warm = jevApi.touch(args.jevBase, args.jevKey);
            void (async () => {
              // Each option's facts carry how many times it was tried and
              // what happened, on top of whatever the bot put there; the
              // state carries what has been visited and tried, where this
              // run stands, and whether one pick is stuck without moving.
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
      if (answer === null) answer = { held: lastHeld, taps: [], clicks: [], setStates: [] };
      lastHeld = [...answer.held];
      for (const entry of answer.setStates) {
        const spec = entry as { target?: unknown; values?: unknown };
        if (typeof spec?.target !== "string") continue;
        setStateId += 1;
        setStates.push({ t, target: spec.target, values: spec.values ?? null });
        writeRunner({
          op: "setState",
          id: setStateId,
          target: spec.target,
          values: spec.values ?? {},
        });
      }
      inputId += 1;
      writeRunner({
        op: "input",
        id: inputId,
        held: answer.held,
        taps: answer.taps,
        clicks: answer.clicks,
      });
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
    writeRunner({ op: "quit", id: 0 });
    await sleep(500);
    try {
      if (ffmpegChild !== undefined && ffmpegChild.exitCode === null) ffmpegChild.kill("SIGINT");
    } catch {
      /* gone */
    }
    await waitExit(ffmpegChild, 15_000);
    // Every private-display child ends with the run: the bot child's
    // stdin pipe closes so its read loop exits on its own, and the
    // tracked pids (runner, display, bot) get a SIGTERM backstop so one
    // call that makes many runs cannot leak a process per run.
    try {
      botChild?.stdin?.end();
    } catch {
      /* closed */
    }
    killAll();
    await waitExit(botChild, 3000);
    await waitExit(xvfbChild, 3000);
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
      picks,
      offered: offered.slice(0, 400),
      status,
      findings: allFindings,
      samples,
      finalPos: lastPos,
      finalState: lastGameState,
      ...(perf === null ? {} : { perf }),
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
      (perf === null
        ? ""
        : `Scene nodes ${perf.nodesStart} start, ${perf.nodesPeak} peak, ${perf.nodesEnd} end; ${perf.orphansEnd} orphans. `) +
      (usedSetState ? "Used explicit set-state writes (not pure play)." : "Pure input play.") +
      ` Video: ${args.videoPath}`;
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
      ...(perf === null ? {} : { perf }),
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
    try {
      runner.socket?.destroy();
    } catch {
      /* closed */
    }
    await new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
    if (picked !== null) claimed.delete(picked);
  }
};
