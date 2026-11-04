// @effect-diagnostics globalTimers:off globalDate:off nodeBuiltinImport:off -- Bot launches: the runner process on a recorded private display, or a Chromium page with stills; by pid.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { GameViewport } from "@kurambit/contracts";
import { openRecordedDisplay } from "./displayHost.ts";
import type { PlayProcess } from "./GameEngine.ts";
import type { BotLaunch } from "./gameBotPlay.ts";
import { BOOT_TIMEOUT_MS, headlessEnv, killPid, sleep, type Session } from "./gameBotRuntime.ts";
import { serveGameDirectory } from "./gameWebServer.ts";
import type { listenForRunner } from "./playSession.ts";
import { openWebPlaySession } from "./webPlaySession.ts";

const stoppedError = (session: Session, error: unknown): unknown =>
  session.stopped ? new Error("Bot run stopped.") : error;

/**
 * The engine's runner process on a private display recorded to the run
 * video (Godot on its sources, Unity's prepared player): the display host is
 * the same for both, and only the process differs.
 */
export const launchProcessBot = async (input: {
  readonly spec: PlayProcess;
  readonly listener: Awaited<ReturnType<typeof listenForRunner>>;
  readonly requestPath: string;
  readonly xvfb: string;
  readonly ffmpeg: string;
  readonly viewport: GameViewport;
  readonly runDir: string;
  readonly videoPath: string;
  readonly session: Session;
  readonly signal: AbortSignal | undefined;
}): Promise<BotLaunch> => {
  const { spec, listener, session } = input;
  let display: Awaited<ReturnType<typeof openRecordedDisplay>> | null = null;
  let game: NodeChildProcess.ChildProcess | undefined;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (game !== undefined && game.exitCode === null) {
      killPid(game.pid);
      const end = Date.now() + 3000;
      while (game.exitCode === null && Date.now() < end) await sleep(100);
      if (game.exitCode === null)
        try {
          game.kill("SIGKILL");
        } catch {
          /* gone */
        }
    }
    await display?.release();
    await listener.drop();
  };
  try {
    if (session.stopped) throw new Error("Bot run stopped.");
    await listener.writeRequest(input.requestPath, spec.request);
    display = await openRecordedDisplay({
      xvfb: input.xvfb,
      ffmpeg: input.ffmpeg,
      viewport: input.viewport,
      videoPath: input.videoPath,
      logDir: input.runDir,
      track: (pid) => session.pids.push(pid),
    });
    const log = NodeFS.openSync(NodePath.join(input.runDir, "game.log"), "w");
    const child = NodeChildProcess.spawn(spec.executable, [...spec.args], {
      env: { ...spec.env, DISPLAY: display.display },
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      detached: true,
      stdio: ["ignore", log, log],
    });
    game = child;
    child.unref();
    if (child.pid !== undefined) session.pids.push(child.pid);
    const play = await listener.accept({
      timeoutMs: BOOT_TIMEOUT_MS,
      what: "The game's runner",
      signal: input.signal,
      alive: () => child.exitCode === null && child.signalCode === null && !session.stopped,
    });
    const shown = display;
    return { play, onTick: async () => undefined, finishVideo: shown.finishVideo, stop };
  } catch (error) {
    await stop();
    throw stoppedError(session, error);
  }
};

/**
 * A browser game's page in headless Chromium on its served folder. The
 * browser is its own display host: one still every tenth tick, stitched into
 * the run video at 2 fps with the same codec, so reports and players treat
 * every run alike.
 */
export const launchPageBot = async (input: {
  readonly root: string;
  readonly projectDir: string;
  readonly chrome: string;
  readonly ffmpeg: string;
  readonly viewport: GameViewport;
  readonly runDir: string;
  readonly videoPath: string;
  readonly session: Session;
  readonly signal: AbortSignal | undefined;
}): Promise<BotLaunch> => {
  if (input.session.stopped) throw new Error("Bot run stopped.");
  const framesDir = NodePath.join(input.runDir, "frames");
  await NodeFSP.mkdir(framesDir, { recursive: true });
  const serve = await serveGameDirectory(
    input.root,
    NodePath.relative(input.root, input.projectDir) || ".",
  );
  const play = await openWebPlaySession({
    executable: input.chrome,
    url: serve.url,
    width: input.viewport.width,
    height: input.viewport.height,
    bootTimeoutMs: BOOT_TIMEOUT_MS,
    signal: input.signal,
  }).catch(async (error: unknown) => {
    await serve.close().catch(() => undefined);
    throw stoppedError(input.session, error);
  });
  let shots = 0;
  let stopped = false;
  return {
    play,
    onTick: async (tick) => {
      if (tick % 10 !== 1) return;
      shots += 1;
      await play.still(NodePath.join(framesDir, `shot-${String(shots).padStart(4, "0")}.png`));
    },
    finishVideo: async () => {
      if (shots === 0) return;
      await new Promise<void>((resolve) => {
        const child = NodeChildProcess.spawn(
          input.ffmpeg,
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
            input.videoPath,
          ],
          { env: headlessEnv(), stdio: "ignore" },
        );
        const timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* gone */
          }
          resolve();
        }, 120_000);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        child.once("exit", done);
        child.once("error", done);
      });
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await play.close();
      await serve.close().catch(() => undefined);
    },
  };
};
