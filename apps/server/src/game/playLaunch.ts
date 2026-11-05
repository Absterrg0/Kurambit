// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalTimers:off -- A play session's launch: the engine's runner process or a browser page on its served folder, timed on the wall clock for an honest bootMs.
// One launch for exploration and bots, so both start, track and stop a game the same way.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { GameOperationError, type GameViewport } from "@kurambit/contracts";
import type { GameEngineBackend } from "./GameEngine.ts";
import type { GameBrowser } from "./gameChromium.ts";
import type * as GameProcesses from "./GameProcesses.ts";
import { serveGameDirectory } from "./gameWebServer.ts";
import { listenForRunner, type PlaySession } from "./playSession.ts";
import { openWebPlaySession, WebBrowserLaunchFailed } from "./webPlaySession.ts";
import type { WindowHost } from "./windowHost.ts";

export interface PlayLaunch {
  readonly play: PlaySession;
  /**
   * Ends everything the launch started: the session, then the game, awaited
   * to its exit, so nothing still writes into its folder. Idempotent.
   */
  readonly stop: () => Promise<void>;
  readonly bootMs: number;
  /** Folders the runner writes that go with the session. */
  readonly scratch: ReadonlyArray<string>;
  readonly inputNote: string;
}

const isGameOperationError = Schema.is(GameOperationError);

const failure =
  (operation: string, path: string, reason: GameOperationError["reason"], detail?: string) =>
  (cause: unknown) =>
    isGameOperationError(cause)
      ? cause
      : new GameOperationError({
          operation,
          path,
          reason,
          detail: detail ?? (cause instanceof Error ? cause.message : String(cause)).slice(0, 2000),
          cause,
        });

const once = (work: () => Promise<void>): (() => Promise<void>) => {
  let running: Promise<void> | null = null;
  return () => (running ??= work());
};

/**
 * The engine's runner process (Godot on its sources, Unity's prepared player)
 * in a window host's window, or headless where the engine runs without one,
 * waiting for its hello. The process is GameProcesses', so the game's Stop
 * and turn cancel reach it; everything started is ended on any failure.
 */
export const openRunnerPlay = (
  processes: GameProcesses.GameProcesses["Service"],
  input: {
    /** Names the operation in errors. */
    readonly operation: string;
    /** Names the process in the game's process list. */
    readonly process: string;
    readonly root: string;
    readonly backend: GameEngineBackend;
    readonly projectDir: string;
    readonly player: string | null;
    readonly viewport: GameViewport;
    readonly host: WindowHost | null;
    readonly scriptDir: string;
    readonly traceDir: string;
    readonly saves: string | null;
    readonly timeoutMs: number;
    readonly bootTimeoutMs: number;
    readonly what: string;
  },
): Effect.Effect<PlayLaunch, GameOperationError> =>
  Effect.gen(function* () {
    const { operation, root } = input;
    const launch = input.backend.playProcess;
    if (launch === null)
      return yield* new GameOperationError({
        operation,
        path: root,
        reason: "invalid-input",
        detail: `${input.backend.profile.displayName} games play in the browser.`,
      });
    const requestPath = NodePath.join(input.traceDir, "request.json");
    yield* Effect.tryPromise({
      try: () => NodeFSP.mkdir(input.traceDir, { recursive: true }),
      catch: failure(operation, root, "io"),
    });
    const listener = yield* Effect.tryPromise({
      try: () => listenForRunner(),
      catch: failure(operation, root, "io"),
    });
    let game: GameProcesses.StartedProcess | null = null;
    const end = async () => {
      await game?.stop();
      await listener.drop();
    };
    return yield* Effect.gen(function* () {
      const spec = yield* launch({
        projectDir: input.projectDir,
        player: input.player,
        requestPath,
        scriptDir: input.scriptDir,
        traceDir: input.traceDir,
        saves: input.saves,
        viewport: input.viewport,
        window: input.host?.kind ?? null,
      });
      yield* Effect.tryPromise({
        try: () => listener.writeRequest(requestPath, spec.request),
        catch: failure(operation, root, "io"),
      });
      const bootStart = Date.now();
      const started = yield* processes.start({
        root,
        executable: spec.executable,
        args: spec.args,
        ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
        operation: input.process,
        timeoutMs: input.timeoutMs,
        env: spec.env,
        envMode: "replace",
        window: input.host === null ? undefined : { host: input.host, viewport: input.viewport },
      });
      game = started;
      let exited = false;
      void started.exited.then(
        () => (exited = true),
        () => (exited = true),
      );
      const play = yield* Effect.tryPromise({
        try: (signal) =>
          listener.accept({
            timeoutMs: input.bootTimeoutMs,
            what: input.what,
            signal,
            alive: () => !exited,
          }),
        catch: failure(operation, root, "command-failed"),
      });
      const bootMs = Date.now() - bootStart;
      return {
        play,
        stop: once(async () => {
          await play.close();
          // A kept session's game got its quit and has a few seconds to finish
          // writing its saves before it is stopped.
          if (input.saves !== null) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
              started.exited.catch(() => undefined),
              new Promise((resolve) => (timer = setTimeout(resolve, 5_000))),
            ]);
            clearTimeout(timer);
          }
          await end();
        }),
        bootMs,
        scratch: spec.scratch,
        inputNote: spec.inputNote,
      } satisfies PlayLaunch;
    }).pipe(Effect.onError(() => Effect.promise(end)));
  });

/** A browser game's page in headless Chromium on its folder, served over loopback. */
export const openPagePlay = (input: {
  readonly operation: string;
  readonly root: string;
  readonly projectDir: string;
  readonly browser: GameBrowser;
  readonly viewport: GameViewport;
  readonly bootTimeoutMs: number;
  readonly keptStorage: string | null;
}): Effect.Effect<PlayLaunch, GameOperationError> =>
  Effect.gen(function* () {
    const { operation, root } = input;
    const served = yield* Effect.tryPromise({
      try: () => serveGameDirectory(root, NodePath.relative(root, input.projectDir) || "."),
      catch: failure(operation, root, "io", "The static project could not be served."),
    });
    const unserve = () => served.close().catch(() => undefined);
    const bootStart = Date.now();
    const play = yield* Effect.tryPromise({
      try: (signal) =>
        openWebPlaySession({
          browser: input.browser,
          url: served.url,
          width: input.viewport.width,
          height: input.viewport.height,
          bootTimeoutMs: input.bootTimeoutMs,
          signal,
          keptStorage: input.keptStorage,
        }),
      catch: (cause) =>
        failure(
          operation,
          root,
          cause instanceof WebBrowserLaunchFailed ? "tool-missing" : "command-failed",
        )(cause),
    }).pipe(Effect.onError(() => Effect.promise(unserve)));
    return {
      play,
      stop: once(async () => {
        await play.close();
        await unserve();
      }),
      bootMs: Date.now() - bootStart,
      scratch: [],
      inputNote: "",
    } satisfies PlayLaunch;
  });
