// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- A run writes its trace, use and perf records beside it on disk, as the page gave them.
// The harness's own stepped bot (templates/bot-kit/masher.mjs) played in a checkout no thread owns:
// a build's copy, for its facts. It plays inside the game's page on the run's own clock
// (gameBotStep.ts); this service opens the page, bounds the run, keeps what the page recorded
// (asset use, frame times, the scene report) beside its trace, and lets a stop end it.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as KeyedLock from "@kurambit/shared/KeyedLock";
import {
  GAME_BOT_BOUNDS,
  GameOperationError,
  type GameBotRunInput,
  type GameBotRunResult,
} from "@kurambit/contracts";
import * as GameEngine from "./GameEngine.ts";
import * as GameProjectService from "./GameProjectService.ts";
import { inGame } from "./gamePath.ts";
import { makeGameBrowser } from "./gameChromium.ts";
import { openPagePlay } from "./playLaunch.ts";
import { encodePlayUse, PLAY_USE_FILE } from "./assetUse.ts";
import { PLAY_PERF_FILE } from "./playPerf.ts";
import { encodeSceneFile, keepSceneReport, SCENE_FILE } from "./sceneReport.ts";
import { ensureGameDir } from "./gameKeptSaves.ts";
import { opError, type Session } from "./gameBotRuntime.ts";
import { isSteppedBot, playSteppedBot, runWithoutBoot } from "./gameBotStep.ts";
import * as GameMemoryGate from "./GameMemoryGate.ts";
import { runtimesFor } from "./gameRuntime.ts";
import * as GameTemplates from "./GameTemplates.ts";
import type { MemoryRoom } from "./GameMemoryGate.ts";
import { isPathWithinRoot } from "@kurambit/shared/pathContainment";
import { PLAY_BOUNDS, bounded } from "./playSession.ts";

/** A play's page at its peak. Each run's boot holds the memory gate, so the next start's check sees what this one took. */
const BOT_ROOM: MemoryRoom = {
  what: "bot run",
  neededMb: 1536,
  env: "KURAMBIT_BOT_MEMORY_MB",
};

/** How long a stop waits for a run to end: its teardown is bounded well inside. */
const STOP_WAIT_MS = 60_000;
const STOP_WAIT = Duration.millis(STOP_WAIT_MS);

interface RunOptions {
  readonly lane?: string;
  /** Step at a person's pace, so the page's frame times are a person's. */
  readonly realTime?: boolean;
}

/** The call a run holds: the checkout's own, or one lane of it when its caller plays it several ways at once. */
const sessionKey = (root: string, lane: string | undefined) =>
  lane === undefined ? root : `${root}\0${lane}`;

export class GameBot extends Context.Service<
  GameBot,
  {
    /**
     * A stepped bot file under the checkout's `.studio/bot/` played to its end. Each `lane` is a
     * call of its own beside the checkout's others; without one the checkout has one call at a
     * time, and a second is refused as busy.
     */
    readonly runIn: (
      root: string,
      input: GameBotRunInput,
      options?: RunOptions,
    ) => Effect.Effect<GameBotRunResult, GameOperationError>;
    /** Stops a checkout's runs and waits for each to end (bounded): its copy is going away. */
    readonly stop: (root: string) => Effect.Effect<void>;
  }
>()("kurambit/game/GameBot") {}

const make = Effect.gen(function* () {
  const engines = yield* GameEngine.GameEngine;
  const projects = yield* GameProjectService.GameProjectService;
  const gameBrowser = yield* makeGameBrowser;
  const gate = yield* GameMemoryGate.GameMemoryGate;
  const templates = yield* GameTemplates.GameTemplates;

  const sessions = new Map<
    string,
    {
      readonly root: string;
      readonly session: Session;
      readonly done: Deferred.Deferred<void>;
      /** Completed by a stop, which every wait of the call races: gate, boot, play. */
      readonly stopRequested: Deferred.Deferred<void>;
    }
  >();
  const botLocks = yield* KeyedLock.make<string>();
  // A stop flips the flag before it ends anything, so the run reads its end as stopped, never as
  // the game crashing.
  const drop = (key: string) => {
    const entry = sessions.get(key);
    if (entry === undefined) return null;
    entry.session.stopped = true;
    Deferred.doneUnsafe(entry.stopRequested, Exit.void);
    for (const owned of entry.session.processes) void owned.stop();
    return entry.done;
  };

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const key of sessions.keys()) drop(key);
    }),
  );

  const isGameOperationError = Schema.is(GameOperationError);

  const runLocked = (root: string, input: GameBotRunInput, { lane, realTime }: RunOptions) =>
    Effect.gen(function* () {
      const botDir = NodePath.resolve(root, ".studio/bot");
      const botFile = NodePath.resolve(root, input.file);
      if (!isPathWithinRoot(botFile, botDir) || botFile === botDir || !botFile.endsWith(".mjs"))
        return yield* opError(
          "Bot run",
          input.file,
          "invalid-input",
          "The bot file must live under .studio/bot/ and end with .mjs.",
        );
      // The run executes the file: one that leads out of the checkout through a link is refused.
      yield* inGame(root, NodePath.relative(root, botFile));
      const source = yield* Effect.promise(() =>
        NodeFSP.readFile(botFile, "utf8").catch(() => null),
      );
      if (source === null)
        return yield* opError("Bot run", input.file, "invalid-input", "No bot file there.");
      if (!isSteppedBot(source))
        return yield* opError(
          "Bot run",
          input.file,
          "invalid-input",
          "Only a stepped bot (one that exports decide) plays.",
        );
      const seconds = Math.min(
        GAME_BOT_BOUNDS.maxSeconds,
        Math.max(GAME_BOT_BOUNDS.minSeconds, input.seconds ?? GAME_BOT_BOUNDS.defaultSeconds),
      );
      const manifest = yield* projects.read(root);
      const backend = yield* engines.backendFor(manifest.engine.name);
      const projectDir = yield* inGame(root, manifest.project);
      const viewport = yield* backend.viewport(projectDir);
      const browser = yield* gameBrowser("Bot run", root);
      const runtimes = yield* runtimesFor(templates, manifest);
      const runId = NodeCrypto.randomUUID();
      const session: Session = { root, runId, stopped: false, processes: [] };
      const runDir = NodePath.join(root, "builds/logs", `game-bot-${runId}`);
      const tracePath = NodePath.join(runDir, "trace.json");
      return yield* Effect.acquireUseRelease(
        Effect.gen(function* () {
          const done = yield* Deferred.make<void>();
          const stopRequested = yield* Deferred.make<void>();
          sessions.set(sessionKey(root, lane), { root, session, done, stopRequested });
          return { done, stopRequested };
        }),
        ({ stopRequested }) =>
          Effect.gen(function* () {
            const stoppedError = opError("Bot run", root, "cancelled", "Bot run stopped.");
            // A fresh folder of its own under a logs folder checked to be the checkout's: nothing
            // the run writes there can follow a planted link.
            yield* Effect.tryPromise({
              try: async () => {
                await ensureGameDir(root, "builds/logs");
                await NodeFSP.mkdir(runDir);
              },
              catch: (cause) => opError("Bot run", runDir, "io", undefined, cause),
            });
            // Anything the run throws that is not already ours to name is a fault of our own
            // side: the game's ends are results.
            const failed = (cause: unknown) =>
              isGameOperationError(cause)
                ? cause
                : opError(
                    "Bot run",
                    root,
                    "tool-failed",
                    cause instanceof Error
                      ? cause.message.slice(0, 2000)
                      : String(cause).slice(0, 2000),
                    cause,
                  );
            // The boot is the start's own memory peak, so it runs inside the gate; a stop ends
            // it wherever it waits.
            const open = Effect.raceFirst(
              gate.admit(
                "Bot run",
                root,
                BOT_ROOM,
                openPagePlay({
                  operation: "Bot run",
                  root,
                  projectDir,
                  browser,
                  viewport,
                  bootTimeoutMs: PLAY_BOUNDS.bootMs,
                  keptStorage: null,
                  recordUse: true,
                  sceneReport: true,
                  runtimes,
                }),
              ),
              Deferred.await(stopRequested).pipe(Effect.andThen(Effect.fail(stoppedError))),
            );
            // An interrupt does not wait for the play promise: the release waits for it
            // (bounded), so nothing writes into the run's folder once the call returns.
            let playing: Promise<unknown> = Promise.resolve();
            return yield* Effect.acquireUseRelease(
              open.pipe(
                Effect.interruptible,
                Effect.mapError((error) => (session.stopped ? stoppedError : error)),
              ),
              (opened) =>
                (session.stopped ? Effect.fail(stoppedError) : Effect.void).pipe(
                  Effect.andThen(
                    Effect.tryPromise({
                      try: () => {
                        const run = playSteppedBot(opened, {
                          root,
                          runId,
                          runDir,
                          tracePath,
                          botFile,
                          source,
                          seconds,
                          ...(realTime === true ? { realTime } : {}),
                        });
                        playing = run;
                        return run;
                      },
                      catch: failed,
                    }).pipe(
                      // The backstop behind every per-call bound: a run past it is our own side
                      // hung, never the game.
                      Effect.timeoutOrElse({
                        duration: Duration.millis(PLAY_BOUNDS.bootMs + (seconds + 300) * 1000),
                        orElse: () =>
                          Effect.fail(
                            opError(
                              "Bot run",
                              root,
                              "tool-failed",
                              "The bot run overran its bound.",
                            ),
                          ),
                      }),
                    ),
                  ),
                ),
              (opened) =>
                Effect.gen(function* () {
                  yield* Effect.promise(() =>
                    bounded(
                      playing.catch(() => undefined),
                      STOP_WAIT_MS / 2,
                    ),
                  );
                  const stopped = yield* Effect.promise(() => opened.stop());
                  // Evidence beside the trace: the build's facts read it (asset use, performance).
                  const use = stopped.use;
                  if (use !== null)
                    yield* Effect.promise(() =>
                      NodeFSP.writeFile(
                        NodePath.join(runDir, PLAY_USE_FILE),
                        encodePlayUse(use),
                      ).catch(() => undefined),
                    );
                  const perf = stopped.perf;
                  if (perf !== null && perf !== undefined)
                    yield* Effect.promise(() =>
                      NodeFSP.writeFile(
                        NodePath.join(runDir, PLAY_PERF_FILE),
                        `${JSON.stringify(perf)}\n`,
                      ).catch(() => undefined),
                    );
                  // The scene report's frames go beside it, named from the run folder.
                  const scene = stopped.scene;
                  if (scene !== null)
                    yield* Effect.promise(async () => {
                      const kept =
                        scene === "no-shell" ? scene : await keepSceneReport(scene.raw, runDir, "");
                      if (kept !== null)
                        await NodeFSP.writeFile(
                          NodePath.join(runDir, SCENE_FILE),
                          encodeSceneFile(kept),
                        ).catch(() => undefined);
                    });
                }),
            ).pipe(
              // The game never booted: measured.
              Effect.catchTags({
                PlayDidNotBoot: (error) =>
                  Effect.promise(() =>
                    runWithoutBoot({ root, runId, botFile, tracePath }, error.detail),
                  ),
              }),
            );
          }),
        // The map entry spans the whole call, so a stop during it is heard.
        ({ done }) =>
          Effect.sync(() => {
            const key = sessionKey(root, lane);
            if (sessions.get(key)?.session === session) sessions.delete(key);
          }).pipe(Effect.andThen(Deferred.succeed(done, undefined))),
      );
    });

  const runIn: GameBot["Service"]["runIn"] = (root, input, options = {}) =>
    botLocks
      .tryWithLock(sessionKey(root, options.lane), 0, runLocked(root, input, options))
      .pipe(
        Effect.flatMap((ran) =>
          Option.isSome(ran)
            ? Effect.succeed(ran.value)
            : Effect.fail(
                opError(
                  "Bot run",
                  root,
                  "busy",
                  "A bot run is already in progress here: wait for it to end before starting another.",
                ),
              ),
        ),
      );

  const stop: GameBot["Service"]["stop"] = (root) =>
    Effect.gen(function* () {
      const ending = [...sessions.entries()]
        .filter(([, entry]) => entry.root === root)
        .map(([key]) => drop(key))
        .filter((done) => done !== null);
      for (const done of ending) {
        const ended = yield* Deferred.await(done).pipe(Effect.timeoutOption(STOP_WAIT));
        if (Option.isNone(ended))
          yield* Effect.logWarning("A stopped bot run did not end within its bound.");
      }
    });

  return GameBot.of({ runIn, stop });
});

export const layer = Layer.effect(GameBot, make);
