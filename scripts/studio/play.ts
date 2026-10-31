#!/usr/bin/env node
// Studio v2 `play` CLI: eyes and hands on the running game for any agent.
// One game boots in a small background daemon; separate calls share it.
// Never touches GameService. No window may ever reach the user's desktop:
// every child spawns with DISPLAY/WAYLAND_DISPLAY/XAUTHORITY removed, under
// the user-space Xvfb with a private display, or headless without pictures.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { GODOT_EXPLORE_SCRIPT } from "../../apps/server/src/game/godotExploreScript.ts";
import { findExecutable } from "../../apps/server/src/game/gameNativeCapture.ts";
import {
  attachLineState,
  nativeChildEnv,
  nativeGodotArgs,
  nativeSessionToken,
  nextRunnerLine,
  sanitizeNativeObservation,
  type NativeLineState,
} from "../../apps/server/src/game/gameExploreNative.ts";
import { prepareNativeUserIsolation } from "../../apps/server/src/game/gameNativeUserDir.ts";
import { parseGodotViewport } from "../../apps/server/src/game/godotViewport.ts";

const DISPLAY_VARS = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"] as const;
const BOOT_TIMEOUT_MS = 150_000;
const ACT_TIMEOUT_MS = 120_000;

const USAGE = `play: drive the running game. Run with the game folder as cwd, or --dir PATH.
Output is always one JSON object on stdout.

  play start                        Import the project and boot the game in the background.
  play act '<json steps>'           Play steps, e.g. '[{"waitMs":500}]'.
  play inspect <path> [p1,p2]       Read script vars on a node, e.g. /root/GameState
  play view [playerPath]            Read-only view: visible things, body, state.
  play stop                         Quit the game and free the session.
  play video <out.mp4>              Stitch this session's viewport frames to mp4 (~10 fps).

  Real-time bots drive the game with back-to-back act calls at ~10 Hz (each
  act runs the game unpaused for its steps, then pauses; the bot keeps the
  key state and pipelines the next act at once). play view is one such act
  shaped for decisions; see bot.ts. The view shape (visible things, body on
  ground/touching, measured move extents) is adapted from ramenvr/autopilot
  kit/harness (Apache-2.0): only the shape is borrowed, the code is our own.

Steps (an array of objects): {"press":"Space"} taps a key; {"holdMs":300,"key":"A"}
holds one; {"waitMs":500} waits; {"click":{"x":100,"y":200}} clicks (x/y optional,
default centre); {"drag":{"from":{"x":1,"y":2},"to":{"x":3,"y":4}}} drags;
{"ui":{"id":"Hand.Card","action":"click"}} clicks a listed control (use the ui
array from the previous reply for ids; drag with "to":"Other.Id"); {"inspect":
{"path":"/root/GameState","properties":["mana"]}} reads vars; {"screenshot":true}
takes a picture only. Between calls the game stays paused.

Replies carry state (GameState vars), screenText, ui (clickable controls with
rects), errors, uiResults (whether each ui click landed: received true/false),
inspections, and screenshot (absolute PNG path, or null headless). When
received is false the game did not get the click: look at the screenshot first,
the code says what should happen but playing shows what does, and playing wins.`;

const out = (value: unknown): void => console.log(JSON.stringify(value));
const fail = (error: string): never => {
  out({ ok: false, error });
  process.exit(1);
};

const sessionDirFor = (gameDir: string): string => NodePath.join(gameDir, "builds", "logs", "play");
const here = NodeURL.fileURLToPath(import.meta.url);

const godotBinary = (): string => {
  const override = process.env.GODOT_BINARY?.trim();
  if (override) return override;
  const dataHome = process.env.XDG_DATA_HOME ?? NodePath.join(NodeOS.homedir(), ".local/share");
  return NodePath.join(dataHome, "game-studio/tools/godot-4.7.2/Godot_v4.7.2-stable_linux.x86_64");
};

/** Every child loses the desktop routes; software GL, limited threads. */
const scrubbedEnv = (extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const name of DISPLAY_VARS) delete env[name];
  env.LIBGL_ALWAYS_SOFTWARE = "1";
  env.LP_NUM_THREADS = "2";
  const lib = NodePath.join(NodeOS.homedir(), ".gs-tmp/xvfb-local/usr/lib/x86_64-linux-gnu");
  env.LD_LIBRARY_PATH = `${lib}${NodePath.delimiter}${process.env.LD_LIBRARY_PATH ?? ""}`;
  return env;
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readSession = async (dir: string): Promise<Record<string, unknown> | null> => {
  try {
    return JSON.parse(await NodeFSP.readFile(NodePath.join(dir, "session.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
};

/** One JSON line over TCP, both directions, for CLI<->daemon and daemon<->runner. */
const sendLine = (socket: NodeNet.Socket, value: unknown): void => {
  socket.write(`${JSON.stringify(value)}\n`);
};
const readLine = (socket: NodeNet.Socket, timeoutMs: number): Promise<string> => {
  const state: NativeLineState = { buffer: "", notify: null, closed: false };
  attachLineState(socket, state);
  const timer = setTimeout(() => state.notify?.(), timeoutMs);
  return (async () => {
    for (;;) {
      const line = await nextRunnerLine(state).catch(() => null);
      if (line !== null) {
        clearTimeout(timer);
        return line;
      }
      if (state.closed) throw new Error("The play session is gone; run `play start` again.");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })().finally(() => clearTimeout(timer));
};

const callDaemon = async (session: Record<string, unknown>, message: unknown): Promise<unknown> => {
  const socket = NodeNet.createConnection({
    host: "127.0.0.1",
    port: session.ipcPort as number,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  sendLine(socket, { ...(message as Record<string, unknown>), token: session.ipcToken });
  const line = await readLine(socket, ACT_TIMEOUT_MS);
  socket.destroy();
  return JSON.parse(line) as unknown;
};

const runImport = async (gameDir: string, env: NodeJS.ProcessEnv): Promise<void> => {
  const child = NodeChildProcess.spawn(
    godotBinary(),
    ["--headless", "--path", NodePath.join(gameDir, "godot"), "--editor", "--import"],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    child.on("close", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  if (code !== 0) fail(`Godot import failed (exit ${code}). ${output.slice(-1500)}`);
};

/** Observation shape shared by start/act/inspect. */
const shape = (
  reply: Record<string, unknown>,
  screenshot: string | null,
  extra?: Record<string, unknown>,
): unknown => {
  const clean = sanitizeNativeObservation(reply);
  return {
    ok: true,
    state: clean.probe?.gameState ?? null,
    screenText: clean.screenText,
    ui: clean.ui,
    errors: clean.errors,
    uiResults: clean.uiResults,
    inspections: clean.inspections,
    screenshot,
    ...extra,
  };
};

// ---------------------------------------------------------------- daemon ---

const daemon = async (gameDir: string): Promise<void> => {
  const dir = sessionDirFor(gameDir);
  await NodeFSP.mkdir(dir, { recursive: true });
  const runtimeDir = NodePath.join(dir, "runtime");
  await NodeFSP.rm(runtimeDir, { recursive: true, force: true });
  await NodeFSP.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await NodeFSP.writeFile(NodePath.join(dir, "play.pid"), `${process.pid}\n`);
  const isolation = await prepareNativeUserIsolation(dir);
  const projectText = await NodeFSP.readFile(
    NodePath.join(gameDir, "godot", "project.godot"),
    "utf8",
  ).catch(() => "");
  const viewport = parseGodotViewport(projectText);
  // Explicit private display (never xvfb-run -a, never the desktop): the
  // display number is recorded in session.json so ffmpeg x11grab can capture
  // real motion on exactly this screen. Renderer is Compatibility (software
  // GL under Xvfb); Forward+ was verified to boot but runs ~2x slower.
  const pathEnv = `${process.env.HOME ?? "~"}/.gs-tmp/xvfb-local/usr/bin${NodePath.delimiter}${process.env.PATH ?? ""}`;
  const [xvfbBin, ffmpegBin] = await Promise.all([
    findExecutable("Xvfb", { pathEnv }),
    findExecutable("ffmpeg", { pathEnv }),
  ]);
  const pickDisplay = async (): Promise<number | null> => {
    for (let n = 119; n < 250; n++) {
      try {
        await NodeFSP.access(`/tmp/.X${n}-lock`);
        continue;
      } catch {
        /* no lock: candidate */
      }
      const taken = await new Promise<boolean>((resolve) => {
        const s = NodeNet.connect(6000 + n, "127.0.0.1");
        s.once("connect", () => {
          s.destroy();
          resolve(true);
        });
        s.once("error", () => {
          s.destroy();
          resolve(false);
        });
      });
      if (!taken) return n;
    }
    return null;
  };
  const displayNum = xvfbBin !== null ? await pickDisplay() : null;
  const hasDisplay = displayNum !== null;
  const token = nativeSessionToken();
  const ipcToken = nativeSessionToken();
  // Runner listener first: Godot connects out to us over loopback.
  const listener = NodeNet.createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      listener.off("error", reject);
      resolve();
    });
  });
  const runnerPort = (listener.address() as NodeNet.AddressInfo).port;
  let runner: NodeNet.Socket | null = null;
  const lineState: NativeLineState = { buffer: "", notify: null, closed: false };
  listener.on("connection", (sock) => {
    if (runner !== null) {
      sock.destroy();
      return;
    }
    runner = sock;
    attachLineState(sock, lineState);
  });
  const scriptPath = NodePath.join(dir, "explore.gd");
  const requestPath = NodePath.join(dir, "request.json");
  await NodeFSP.writeFile(scriptPath, GODOT_EXPLORE_SCRIPT);
  await NodeFSP.writeFile(
    requestPath,
    JSON.stringify({
      port: runnerPort,
      token,
      bootScreenshotPath: hasDisplay ? NodePath.join(dir, "boot.png") : null,
      expectedUserDataPrefix: isolation.dataDir,
    }),
  );
  const godotArgs = nativeGodotArgs({
    projectDir: NodePath.join(gameDir, "godot"),
    scriptPath,
    requestPath,
    width: viewport.width,
    height: viewport.height,
    hasDisplay,
  });
  const childEnv = {
    ...nativeChildEnv(isolation),
    LIBGL_ALWAYS_SOFTWARE: "1",
    LP_NUM_THREADS: "2",
    ...(hasDisplay ? { DISPLAY: `:${displayNum}` } : {}),
  };
  // Private Xvfb for this session only. Recorded PID below; only this PID is
  // ever signalled, never a name or pattern.
  let xvfbProc: NodeChildProcess.ChildProcess | null = null;
  if (hasDisplay) {
    xvfbProc = NodeChildProcess.spawn(
      xvfbBin!,
      [`:${displayNum}`, "-screen", "0", `${viewport.width}x${viewport.height}x24`],
      { env: scrubbedEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const seenAt = Date.now();
    for (;;) {
      try {
        await NodeFSP.access(`/tmp/.X11-unix/X${displayNum}`);
        break;
      } catch {
        /* not up yet */
      }
      if (xvfbProc.exitCode !== null || Date.now() - seenAt > 15_000) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  const child = NodeChildProcess.spawn(godotBinary(), [...godotArgs], {
    env: childEnv,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Never by name: only this spawn's PID (negative = its own group).
  const groupPid = child.pid!;
  const killGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-groupPid, signal);
    } catch {
      // Already gone.
    }
  };
  const bootDeadline = Date.now() + BOOT_TIMEOUT_MS;
  let hello: Record<string, unknown> | null = null;
  while (Date.now() < bootDeadline && hello === null) {
    const remaining = Math.min(5000, bootDeadline - Date.now());
    const line = await nextRunnerLine(
      lineState,
      AbortSignal.timeout(Math.max(100, remaining)),
    ).catch(() => null);
    if (line === null) {
      if (child.exitCode !== null)
        fail(`The game exited during boot (code ${child.exitCode}). See builds/logs/play/.`);
      continue;
    }
    const text = line.trim();
    if (text === "") continue;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    if (typeof record["error"] === "string") fail(`The game failed to boot: ${record["error"]}`);
    if (record["token"] === token) hello = record;
  }
  if (hello === null) {
    killGroup("SIGKILL");
    fail("The game did not boot in time.");
  }
  // Real-motion capture: when STUDIO_RECORD=1 (tester/final sessions), each
  // act records the private display in real time with ffmpeg x11grab. Paused
  // gaps between calls are never recorded, so concatenating the segments is
  // already gap-free. Stills remain the fallback.
  const recordActs = process.env.STUDIO_RECORD === "1" && hasDisplay && ffmpegBin !== null;
  let segIndex = 0;
  const segsDir = NodePath.join(dir, "segments");
  const segPrefix = `seg-${Date.now().toString(36)}`;
  let acts = 0;
  const bootShot = hasDisplay ? NodePath.join(dir, "boot.png") : null;
  const bootOut = shape(hello!, bootShot, { hasDisplay, viewport });
  await NodeFSP.writeFile(NodePath.join(dir, "boot.json"), JSON.stringify(bootOut, null, 2));
  // IPC for the short-lived CLI calls.
  const ipc = NodeNet.createServer((sock) => {
    let buffer = "";
    sock.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      void (async () => {
        let reply: unknown;
        try {
          const msg = JSON.parse(raw) as Record<string, unknown>;
          if (msg["token"] !== ipcToken) throw new Error("bad token");
          if (msg["op"] === "stop") {
            sendLine(runner!, { op: "quit", id: 0 });
            await nextRunnerLine(lineState, AbortSignal.timeout(10_000)).catch(() => null);
            reply = { ok: true, stopped: true };
            sock.write(`${JSON.stringify(reply)}\n`, () => {
              killGroup("SIGTERM");
              try {
                xvfbProc?.kill("SIGTERM");
              } catch {
                /* gone */
              }
              setTimeout(() => {
                killGroup("SIGKILL");
                try {
                  xvfbProc?.kill("SIGKILL");
                } catch {
                  /* gone */
                }
              }, 2000).unref();
              setTimeout(() => process.exit(0), 500).unref();
            });
            await NodeFSP.rm(NodePath.join(dir, "play.pid"), { force: true });
            return;
          }
          const steps = msg["op"] === "act" ? msg["steps"] : [];
          if (!Array.isArray(steps)) throw new Error("steps must be an array");
          acts += 1;
          const shot = hasDisplay
            ? NodePath.join(dir, `act-${String(acts).padStart(2, "0")}.png`)
            : null;
          let rec: NodeChildProcess.ChildProcess | null = null;
          let segPath = "";
          if (recordActs) {
            try {
              segIndex += 1;
              await NodeFSP.mkdir(segsDir, { recursive: true });
              segPath = NodePath.join(
                segsDir,
                `${segPrefix}-${String(segIndex).padStart(3, "0")}.mp4`,
              );
              rec = NodeChildProcess.spawn(
                ffmpegBin!,
                [
                  "-y",
                  "-v",
                  "error",
                  "-f",
                  "x11grab",
                  "-framerate",
                  "15",
                  "-s",
                  `${viewport.width}x${viewport.height}`,
                  "-i",
                  `:${displayNum}`,
                  "-c:v",
                  "libx264",
                  "-pix_fmt",
                  "yuv420p",
                  "-preset",
                  "ultrafast",
                  segPath,
                ],
                {
                  env: { ...scrubbedEnv(), DISPLAY: `:${displayNum}` },
                  detached: true,
                  stdio: "ignore",
                },
              );
              await new Promise((resolve) => setTimeout(resolve, 400));
            } catch {
              rec = null;
            }
          }
          sendLine(runner!, { id: acts, op: "act", steps, screenshotPath: shot });
          const answered = await nextRunnerLine(
            lineState,
            AbortSignal.timeout(ACT_TIMEOUT_MS),
          ).catch(() => null);
          if (rec !== null) {
            try {
              rec.kill("SIGINT");
              await new Promise((resolve) => {
                rec!.on("exit", () => resolve(undefined));
                setTimeout(() => resolve(undefined), 8000);
              });
            } catch {
              /* already gone */
            }
            try {
              const st = await NodeFSP.stat(segPath);
              if (st.size < 1000) await NodeFSP.rm(segPath, { force: true });
            } catch {
              /* tiny/failed segment */
            }
          }
          if (answered === null) throw new Error("The game stopped answering.");
          const record = JSON.parse(answered) as Record<string, unknown>;
          if (record["ok"] !== true)
            throw new Error(
              typeof record["error"] === "string" ? record["error"] : "The act failed.",
            );
          if (shot !== null && record["screenshot"] === true)
            await NodeFSP.copyFile(shot, NodePath.join(dir, "latest.png")).catch(() => undefined);
          reply = shape(record, shot, { hasDisplay, viewport });
        } catch (error) {
          reply = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        sock.write(`${JSON.stringify(reply)}\n`);
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    ipc.once("error", reject);
    ipc.listen(0, "127.0.0.1", () => {
      ipc.off("error", reject);
      resolve();
    });
  });
  await NodeFSP.writeFile(
    NodePath.join(dir, "session.json"),
    JSON.stringify({
      ready: true,
      ipcPort: (ipc.address() as NodeNet.AddressInfo).port,
      ipcToken,
      gamePid: groupPid,
      xvfbPid: xvfbProc?.pid ?? null,
      display: hasDisplay ? `:${displayNum}` : null,
      record: recordActs,
      hasDisplay,
      viewport,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }),
  );
  const exitDead = (): never => {
    try {
      xvfbProc?.kill("SIGKILL");
    } catch {
      /* gone */
    }
    process.exit(1);
  };
  runner!.on("close", exitDead);
  child.on("exit", exitDead);
  await new Promise(() => undefined);
};

// ---------------------------------------------------------------- CLI -----

const main = async (): Promise<void> => {
  const raw = process.argv.slice(2);
  let gameDir = process.cwd();
  const args: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "--dir") {
      gameDir = NodePath.resolve(raw[++i]!);
    } else args.push(raw[i]!);
  }
  const [command, ...rest] = args;
  if (command === "__daemon") {
    await daemon(NodePath.resolve(raw[raw.indexOf("__daemon") + 1]!));
    return;
  }
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }
  const dir = sessionDirFor(gameDir);
  if (command === "start") {
    await NodeFSP.mkdir(dir, { recursive: true });
    const pidText = await NodeFSP.readFile(NodePath.join(dir, "play.pid"), "utf8").catch(
      () => null,
    );
    if (pidText !== null && alive(Number(pidText.trim()))) {
      const existing = await readSession(dir);
      if (existing?.["ready"] === true)
        fail("A play session is already running; `play stop` first.");
      await NodeFSP.rm(NodePath.join(dir, "play.pid"), { force: true });
    }
    await NodeFSP.rm(NodePath.join(dir, "session.json"), { force: true });
    await runImport(
      gameDir,
      scrubbedEnv({
        XDG_RUNTIME_DIR: NodePath.join(dir, "runtime-import"),
      }),
    );
    const runtimeDir = NodePath.join(dir, "runtime");
    await NodeFSP.rm(runtimeDir, { recursive: true, force: true });
    await NodeFSP.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    const daemonLog = await NodeFSP.open(NodePath.join(dir, "daemon.log"), "w").catch(() => null);
    const child = NodeChildProcess.spawn(process.execPath, [here, "__daemon", gameDir], {
      env: scrubbedEnv({ XDG_RUNTIME_DIR: runtimeDir }),
      detached: true,
      stdio: daemonLog === null ? "ignore" : ["ignore", daemonLog.fd, daemonLog.fd],
    });
    child.unref();
    await daemonLog?.close().catch(() => undefined);
    const deadline = Date.now() + BOOT_TIMEOUT_MS + 60_000;
    for (;;) {
      const session = await readSession(dir);
      if (session?.["ready"] === true) {
        const boot = JSON.parse(
          await NodeFSP.readFile(NodePath.join(dir, "boot.json"), "utf8"),
        ) as unknown;
        out(boot);
        return;
      }
      if (Date.now() > deadline) fail("Timed out waiting for the game to boot.");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  const session = await readSession(dir);
  if (!session || session["ready"] !== true)
    fail("No play session is running; `play start` first.");
  if (command === "stop") {
    try {
      out(await callDaemon(session, { op: "stop" }));
    } catch {
      await NodeFSP.rm(NodePath.join(dir, "play.pid"), { force: true });
      out({ ok: true, stopped: true, note: "daemon was already gone" });
    }
    return;
  }
  if (command === "act") {
    let steps: unknown;
    try {
      steps = JSON.parse(rest[0] ?? "");
    } catch {
      fail("act needs one JSON array argument, e.g. '[{\"waitMs\":500}]'.");
    }
    if (!Array.isArray(steps)) fail("act needs one JSON array argument.");
    try {
      out(await callDaemon(session, { op: "act", steps }));
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (command === "view") {
    // Read-only: one act that only reads (sweepCheck + inspects, no inputs),
    // shaped as Aura's view: visible things, the body, the game state.
    // Ways (how far it can move each way) are measured by bot.ts with real
    // probe taps, since the paused runner cannot raycast generically.
    const playerPath = rest[0] ?? "/root/GameState";
    try {
      const reply = (await callDaemon(session, {
        op: "act",
        steps: [
          { sweepCheck: true },
          { inspect: { path: playerPath } },
          { inspect: { path: "/root/GameState" } },
        ],
      })) as Record<string, unknown>;
      const clean = sanitizeNativeObservation(reply);
      const inspections = (clean.inspections ?? []) as Array<Record<string, unknown>>;
      const sweep = inspections.find(
        (i) => ((i?.["values"] ?? {}) as Record<string, unknown>)["dim"] !== undefined,
      );
      const sweepValues = (sweep?.["values"] ?? {}) as Record<string, unknown>;
      out({
        ok: true,
        view: {
          visible: { text: clean.screenText, ui: clean.ui },
          body: {
            pos: clean.probe?.player ?? null,
            onGround: sweepValues["onFloor"] ?? null,
            touching: sweepValues["overlapNames"] ?? null,
            overlaps: sweepValues["overlaps"] ?? null,
            vel: [sweepValues["vx"] ?? null, sweepValues["vy"] ?? null, sweepValues["vz"] ?? null],
          },
          state: clean.probe?.gameState ?? null,
          errors: clean.errors,
        },
        screenshot: (reply as Record<string, unknown>)["screenshot"] ?? null,
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (command === "inspect") {
    const path = rest[0];
    if (!path) fail("inspect needs a node path, e.g. /root/GameState.");
    const properties = rest[1]?.split(",").filter(Boolean);
    try {
      out(
        await callDaemon(session, {
          op: "act",
          steps: [{ inspect: { path, ...(properties ? { properties } : {}) } }],
        }),
      );
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (command === "video") {
    const outPath = rest[0];
    if (!outPath) fail("video needs an output path, e.g. round-1.mp4.");
    // Real motion first: concatenate this session's per-act x11grab segments
    // (already gap-free). Stills via video.ts are the fallback.
    const segsDir = NodePath.join(dir, "segments");
    const segs = (await NodeFSP.readdir(segsDir).catch(() => [] as string[]))
      .filter((name) => /^seg-.*\.mp4$/.test(name))
      .sort();
    if (segs.length > 0) {
      const { spawnSync } = await import("node:child_process");
      const listPath = NodePath.join(dir, "concat.txt");
      await NodeFSP.writeFile(
        listPath,
        segs.map((name) => `file '${NodePath.join(segsDir, name)}'`).join("\n"),
      );
      const done = spawnSync(
        "ffmpeg",
        [
          "-y",
          "-v",
          "error",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          listPath,
          "-c",
          "copy",
          NodePath.resolve(gameDir, outPath),
        ],
        { env: scrubbedEnv(), timeout: 300_000 },
      );
      const text = `${done.stdout?.toString() ?? ""}${done.stderr?.toString() ?? ""}`;
      if (done.status === 0) {
        out({
          ok: true,
          video: NodePath.resolve(gameDir, outPath),
          realMotion: true,
          segments: segs.length,
        });
        return;
      }
      console.error(`segment concat failed, falling back to stills: ${text.slice(-300)}`);
    }
    const { spawnSync } = await import("node:child_process");
    const done = spawnSync(
      process.execPath,
      [NodePath.join(NodePath.dirname(here), "video.ts"), "--dir", gameDir, "--out", outPath],
      { env: scrubbedEnv(), timeout: 300_000 },
    );
    const text = `${done.stdout?.toString() ?? ""}${done.stderr?.toString() ?? ""}`;
    if (done.status !== 0) fail(`video failed: ${text.slice(-500)}`);
    out({ ok: true, video: NodePath.resolve(gameDir, outPath), log: text.trim().slice(-300) });
    return;
  }
  console.log(USAGE);
  process.exit(2);
};

await main().catch((error: unknown) =>
  fail(error instanceof Error ? error.message : String(error)),
);
