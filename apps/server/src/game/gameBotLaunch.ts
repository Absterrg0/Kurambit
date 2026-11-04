// @effect-diagnostics globalTimers:off globalDate:off nodeBuiltinImport:off -- Bot launches: the runner process on a recorded private display, or a Chromium page with stills; by pid.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { GameViewport } from "@kurambit/contracts";
import { openRecordedDisplay } from "./displayHost.ts";
import type { PlayProcess } from "./GameEngine.ts";
import type { BotLaunch } from "./gameBotPlay.ts";
import { BOOT_TIMEOUT_MS, headlessEnv, type Session } from "./gameBotRuntime.ts";
import { serveGameDirectory } from "./gameWebServer.ts";
import type { listenForRunner } from "./playSession.ts";
import { openWebPlaySession } from "./webPlaySession.ts";
import { runOwned, spawnOwned, type OwnedProcess } from "./processHost.ts";

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
  let game: OwnedProcess | undefined;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await game?.stop({ graceMs: 3000 });
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
      track: (owned) => session.processes.push(owned),
    });
    const log = NodeFS.openSync(NodePath.join(input.runDir, "game.log"), "w");
    const owned = spawnOwned(spec.executable, spec.args, {
      env: { ...spec.env, DISPLAY: display.display },
      cwd: spec.cwd,
      stdio: ["ignore", log, log],
      tree: true,
      window: true,
    });
    game = owned;
    const child = owned.child;
    child.unref();
    session.processes.push(owned);
    const play = await listener.accept({
      timeoutMs: BOOT_TIMEOUT_MS,
      what: "The game's runner",
      signal: input.signal,
      alive: () => child.exitCode === null && child.signalCode === null && !session.stopped,
    });
    const shown = display;
    return {
      play,
      onTick: async () => undefined,
      finishVideo: shown.finishVideo,
      snapshot: shown.snapshot,
      stop,
    };
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
  readonly keptStorage: string | null;
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
    keptStorage: input.keptStorage,
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
    snapshot: (path) => play.still(path),
    finishVideo: async () => {
      if (shots === 0) return;
      await runOwned(
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
        { env: headlessEnv(), timeoutMs: 120_000 },
      );
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await play.close();
      await serve.close().catch(() => undefined);
    },
  };
};
