// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalTimers:off -- A play session's launch: the engine's runner process or a browser page on its served folder, timed on the wall clock for an honest bootMs.
// One launch for exploration and bots, so both start, track and stop a game the same way.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { GameOperationError, type GameProcessResult, type GameViewport } from "@kurambit/contracts";
import type { GameEngineBackend } from "./GameEngine.ts";
import type { GameBrowser } from "./gameChromium.ts";
import type * as GameProcesses from "./GameProcesses.ts";
import { serveGameDirectory } from "./gameWebServer.ts";
import {
  PLAY_BOUNDS,
  PlayNotBooted,
  bounded,
  listenForRunner,
  type PlayEnd,
  type PlaySession,
} from "./playSession.ts";
import {
  openWebPlaySession,
  WebBrowserLaunchFailed,
  WebPageCrashed,
  WebPageNotReady,
  type KeptStorage,
} from "./webPlaySession.ts";
import { DISPLAY_LOST_EXIT, type WindowHost } from "./windowHost.ts";

export interface PlayLaunch {
  readonly play: PlaySession;
  /**
   * Settles when the game ends, saying by whose side: its process exited or
   * its page crashed (the game's), or its display or browser went away (ours).
   */
  readonly ended: Promise<PlayEnd>;
  /**
   * Ends everything the launch started: the session, then the game, awaited
   * to its exit, so nothing still writes into its folder. Idempotent; a kept
   * page's storage comes back for the caller to write.
   */
  readonly stop: () => Promise<{ readonly keptStorage: KeptStorage | null }>;
  readonly bootMs: number;
  /** Folders the runner writes that go with the session. */
  readonly scratch: ReadonlyArray<string>;
  readonly inputNote: string;
}

const isGameOperationError = Schema.is(GameOperationError);

/**
 * The game never booted: its process exited or never said hello in time, or
 * its page never became ready or crashed while loading. Evidence about the
 * build, never a tool fault; a bot run reports it as its `not-booted` status.
 */
export class PlayDidNotBoot extends Schema.TaggedError<PlayDidNotBoot>()("PlayDidNotBoot", {
  /** What the game did instead, in its runner's or page's words. */
  detail: Schema.String,
}) {
  override get message(): string {
    return "The game did not boot.";
  }
}
const didNotBoot = (detail: string) => new PlayDidNotBoot({ detail: detail.slice(0, 2000) });

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

const once = <A>(work: () => Promise<A>): (() => Promise<A>) => {
  let running: Promise<A> | null = null;
  return () => (running ??= work());
};

/** How a runner process's exit reads: our display wrapper says when its display died first. */
const runnerEnd = (result: GameProcessResult | null): PlayEnd =>
  result !== null && result.exitCode === DISPLAY_LOST_EXIT
    ? { by: "host", detail: "The private display ended while the game ran." }
    : {
        by: "game",
        detail:
          result === null
            ? "The game's process ended."
            : result.signal !== null
              ? `The game's process was ended by ${result.signal}.`
              : `The game's process exited with code ${result.exitCode}.`,
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
): Effect.Effect<PlayLaunch, GameOperationError | PlayDidNotBoot> =>
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
    // Interruptible only where it waits (the launch spec, the request, the
    // hello): what it starts is known to `end` before an interrupt can land.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
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
          const spec = yield* restore(
            launch({
              projectDir: input.projectDir,
              player: input.player,
              requestPath,
              scriptDir: input.scriptDir,
              traceDir: input.traceDir,
              saves: input.saves,
              viewport: input.viewport,
              window: input.host?.kind ?? null,
            }),
          );
          yield* restore(
            Effect.tryPromise({
              try: () => listener.writeRequest(requestPath, spec.request),
              catch: failure(operation, root, "io"),
            }),
          );
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
            window:
              input.host === null ? undefined : { host: input.host, viewport: input.viewport },
          });
          game = started;
          const play = yield* restore(
            Effect.tryPromise({
              try: (signal) =>
                listener.accept({
                  timeoutMs: input.bootTimeoutMs,
                  what: input.what,
                  signal,
                  exited: started.exited,
                }),
              catch: (cause) =>
                cause instanceof PlayNotBooted
                  ? didNotBoot(cause.message)
                  : failure(operation, root, "tool-failed")(cause),
            }),
          );
          const bootMs = Date.now() - bootStart;
          return {
            play,
            ended: started.exited.then(runnerEnd, () => runnerEnd(null)),
            stop: once(async () => {
              await play.close();
              // A kept session's game got its quit and has a few seconds to finish
              // writing its saves before it is stopped.
              if (input.saves !== null) await bounded(started.exited, PLAY_BOUNDS.keptSavesMs);
              await end();
              return { keptStorage: null };
            }),
            bootMs,
            scratch: spec.scratch,
            inputNote: spec.inputNote,
          } satisfies PlayLaunch;
        }).pipe(Effect.onError(() => Effect.promise(end)));
      }),
    );
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
}): Effect.Effect<PlayLaunch, GameOperationError | PlayDidNotBoot> =>
  Effect.gen(function* () {
    const { operation, root } = input;
    // Interruptible only while the page boots, which ends its browser on abort.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const served = yield* Effect.tryPromise({
          try: () => serveGameDirectory(root, NodePath.relative(root, input.projectDir) || "."),
          catch: failure(operation, root, "io", "The static project could not be served."),
        });
        const unserve = () => served.close().catch(() => undefined);
        const bootStart = Date.now();
        const play = yield* restore(
          Effect.tryPromise({
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
            // The page not booting or crashing is the game's; the browser is ours.
            catch: (cause) =>
              cause instanceof WebPageNotReady || cause instanceof WebPageCrashed
                ? didNotBoot(cause.message)
                : failure(
                    operation,
                    root,
                    cause instanceof WebBrowserLaunchFailed ? "tool-missing" : "tool-failed",
                  )(cause),
          }),
        ).pipe(Effect.onError(() => Effect.promise(unserve)));
        return {
          play,
          ended: play.ended,
          stop: once(async () => {
            await play.close();
            await unserve();
            return { keptStorage: play.keptStorage() };
          }),
          bootMs: Date.now() - bootStart,
          scratch: [],
          inputNote: "",
        } satisfies PlayLaunch;
      }),
    );
  });
