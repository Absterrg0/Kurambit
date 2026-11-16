// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalTimers:off -- A play session's launch: a browser page on its served folder, timed on the wall clock for an honest bootMs.
// One launch for exploration and bots, so both start, track and stop a game the same way.
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { GameOperationError, type GameViewport } from "@kurambit/contracts";
import type { GameBrowser } from "./gameChromium.ts";
import { serveGameDirectory } from "./gameWebServer.ts";
import { once, type PlayEnd, type PlaySession } from "./playSession.ts";
import {
  openWebPlaySession,
  WebBrowserLaunchFailed,
  WebPageCrashed,
  WebPageNotReady,
  type KeptStorage,
} from "./webPlaySession.ts";
import { type PlayUse, resolvePlayUse } from "./assetUse.ts";
import type { PageScene } from "./sceneReport.ts";

export interface PlayLaunch {
  readonly play: PlaySession;
  /**
   * Settles when the game ends, saying by whose side: its page crashed (the
   * game's), or its browser went away (ours).
   */
  readonly ended: Promise<PlayEnd>;
  /**
   * Ends everything the launch started: the session, then the game, awaited
   * to its exit, so nothing still writes into its folder. Idempotent; a kept
   * page's storage comes back for the caller to write.
   */
  readonly stop: () => Promise<{
    readonly keptStorage: KeptStorage | null;
    /** What a recorded page loaded and played (`recordUse`); null for every other launch. */
    readonly use: PlayUse | null;
    /** How a page's play ran, as its shell measured it (`__studio.perf()`); null elsewhere. */
    readonly perf: unknown;
    /** A page's scene report, when the launch asked for one (`sceneReport`); null elsewhere. */
    readonly scene: PageScene;
  }>;
  readonly bootMs: number;
}

const isGameOperationError = Schema.is(GameOperationError);

/**
 * The game never booted: its page never became ready or crashed while loading. Evidence about the
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

/** A browser game's page in headless Chromium on its folder, served over loopback. */
export const openPagePlay = (input: {
  readonly operation: string;
  readonly root: string;
  readonly projectDir: string;
  readonly browser: GameBrowser;
  readonly viewport: GameViewport;
  readonly bootTimeoutMs: number;
  readonly keptStorage: string | null;
  /** Record which files the page loads and which sounds start playing (asset use). */
  readonly recordUse?: boolean;
  /** Start the shell's scene report as the page is ready; `stop` returns it. */
  readonly sceneReport?: boolean;
  /** The server's runtimes folder, for a game that loads Kurambit's runtime (gameRuntime.ts). */
  readonly runtimes: string | null;
}): Effect.Effect<PlayLaunch, GameOperationError | PlayDidNotBoot> =>
  Effect.gen(function* () {
    const { operation, root } = input;
    const project = NodePath.relative(root, input.projectDir);
    const loads = new Set<string>();
    const sounds = new Set<string>();
    const icons = new Set<string>();
    // Interruptible only while the page boots, which ends its browser on abort.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const served = yield* Effect.tryPromise({
          try: () =>
            serveGameDirectory(root, project || ".", {
              ...(input.recordUse === true ? { onServed: (path) => loads.add(path) } : {}),
              runtimes: input.runtimes,
            }),
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
                onSoundStarted:
                  input.recordUse === true ? (sound) => void sounds.add(sound) : undefined,
                onPageIcons:
                  input.recordUse === true
                    ? (urls) => urls.forEach((url) => icons.add(url))
                    : undefined,
                sceneReport: input.sceneReport === true,
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
            return {
              keptStorage: play.keptStorage(),
              perf: play.perf(),
              scene: play.scene(),
              use:
                input.recordUse === true
                  ? await resolvePlayUse({
                      webRoot: input.projectDir,
                      project: project.split(NodePath.sep).join("/"),
                      origin: new URL(served.url).origin,
                      served: loads,
                      sounds,
                      icons,
                    }).catch(() => null)
                  : null,
            };
          }),
          bootMs: Date.now() - bootStart,
        } satisfies PlayLaunch;
      }),
    );
  });
