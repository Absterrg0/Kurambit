// @effect-diagnostics nodeBuiltinImport:off -- Bot launches: the runner process on a private display, or a Chromium page.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { GameViewport } from "@kurambit/contracts";
import type { HostedWindow, WindowHost } from "./windowHost.ts";
import type { PlayProcess } from "./GameEngine.ts";
import type { BotLaunch } from "./gameBotPlay.ts";
import { BOOT_TIMEOUT_MS, type Session } from "./gameBotRuntime.ts";
import { serveGameDirectory } from "./gameWebServer.ts";
import type { listenForRunner } from "./playSession.ts";
import { openWebPlaySession } from "./webPlaySession.ts";

const stoppedError = (session: Session, error: unknown): unknown =>
  session.stopped ? new Error("Bot run stopped.") : error;

/**
 * The engine's runner process in a window host's window (Godot on its
 * sources, Unity's prepared player): the host is the same for both, and only
 * the process differs.
 */
export const launchProcessBot = async (input: {
  readonly spec: PlayProcess;
  readonly listener: Awaited<ReturnType<typeof listenForRunner>>;
  readonly requestPath: string;
  readonly host: WindowHost;
  readonly viewport: GameViewport;
  readonly runDir: string;
  readonly session: Session;
  readonly signal: AbortSignal | undefined;
}): Promise<BotLaunch> => {
  const { spec, listener, session } = input;
  let game: HostedWindow | null = null;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await game?.stop({ graceMs: 3000 });
    await listener.drop();
  };
  try {
    if (session.stopped) throw new Error("Bot run stopped.");
    await listener.writeRequest(input.requestPath, spec.request);
    const log = NodeFS.openSync(NodePath.join(input.runDir, "game.log"), "w");
    game = await input.host.launch(
      {
        executable: spec.executable,
        args: spec.args,
        env: spec.env,
        cwd: spec.cwd,
        stdio: ["ignore", log, log],
      },
      input.viewport,
    );
    NodeFS.closeSync(log);
    const child = game.process.child;
    session.processes.push(game.process);
    const play = await listener.accept({
      timeoutMs: BOOT_TIMEOUT_MS,
      what: "The game's runner",
      signal: input.signal,
      alive: () => child.exitCode === null && child.signalCode === null && !session.stopped,
    });
    return { play, stop };
  } catch (error) {
    await stop();
    throw stoppedError(session, error);
  }
};

/** A browser game's page in headless Chromium on its served folder. */
export const launchPageBot = async (input: {
  readonly root: string;
  readonly projectDir: string;
  readonly chrome: string;
  readonly viewport: GameViewport;
  readonly session: Session;
  readonly signal: AbortSignal | undefined;
  readonly keptStorage: string | null;
}): Promise<BotLaunch> => {
  if (input.session.stopped) throw new Error("Bot run stopped.");
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
  let stopped = false;
  return {
    play,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await play.close();
      await serve.close().catch(() => undefined);
    },
  };
};
