// Runs played to an end, kept so a newer build can play them again, and the ones someone saved
// as tests. The three.js shell records a run as it is played (shell/replay.js); the Stage hands
// a person's here when it ends, and an agent's game_play session keeps its own (GameExplore).
// A replay runs the latest kept run on a build's copy (or the folder, for the agent) and says
// how it ends there and the first second it plays differently. A saved play (playFiles.ts) is
// a kept run named as a test: saved only once it replays the same on the build it was played
// on, then replayed by every build's measure (GameFacts, the Saved plays fact).
// @effect-diagnostics nodeBuiltinImport:off -- A replayed moment's frame is a file in the game's logs.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  firstPlayDifference,
  GameOperationError,
  GamePlayName,
  type GameBuildId,
  type GameKeepPlayInput,
  type GamePlay,
  type GameReplayMoment,
  type GameReplayResult,
  type GameSavePlayInput,
  type GameSavedPlaySummary,
  type GameSavedPlaysReading,
  savedPlayReading,
  savedPlayWords,
  type ThreadId,
} from "@kurambit/contracts";
import * as GameBuilds from "./GameBuilds.ts";
import * as GameEngine from "./GameEngine.ts";
import * as GameProjectService from "./GameProjectService.ts";
import {
  deleteSavedPlay,
  keepPlay,
  keptPlay,
  replaySavedPlays,
  SAVED_DIR,
  savedPlays,
  writeSavedPlay,
} from "./playFiles.ts";
import { ensureGameDir } from "./gameKeptSaves.ts";

const isGameOperationError = Schema.is(GameOperationError);
const isPlayName = Schema.is(GamePlayName);

export class GamePlays extends Context.Service<
  GamePlays,
  {
    /** Keeps a run the person played to its end, with the build it was played on; its id. */
    readonly keep: (
      threadId: ThreadId,
      input: Omit<GameKeepPlayInput, "threadId">,
    ) => Effect.Effect<{ readonly kept: string }, GameOperationError>;
    /** The latest kept play run again on a build's copy, or on the folder as it is now. */
    readonly replay: (
      threadId: ThreadId,
      target: GameBuildId | "folder",
    ) => Effect.Effect<GameReplayResult, GameOperationError>;
    /**
     * Saves a kept run (the newest, or `kept`) as a test play, once a replay on the build it
     * was played on ends the same way; refused, with the first difference, when it does not.
     */
    readonly save: (
      threadId: ThreadId,
      input: Omit<GameSavePlayInput, "threadId">,
    ) => Effect.Effect<GameSavedPlaySummary & { readonly replaced: boolean }, GameOperationError>;
    /** The game's saved plays, newest saved first. */
    readonly saved: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<GameSavedPlaySummary>, GameOperationError>;
    readonly remove: (threadId: ThreadId, name: string) => Effect.Effect<void, GameOperationError>;
    /**
     * `game_play` op `replay`: every saved play replayed on the folder as it is now; with none
     * saved, the latest run played to an end.
     */
    readonly replaySaved: (
      threadId: ThreadId,
    ) => Effect.Effect<GameSavedPlaysReading | GameReplayResult, GameOperationError>;
    /**
     * `game_play` op `replay` with `run`: a saved play by its name, or a kept run by its id,
     * replayed on the folder to `at` seconds (its end without), with the frame and values there.
     */
    readonly moment: (
      threadId: ThreadId,
      input: { readonly run: string; readonly at?: number },
    ) => Effect.Effect<GameReplayMoment, GameOperationError>;
  }
>()("kurambit/game/GamePlays") {}

const make = Effect.gen(function* () {
  const projects = yield* GameProjectService.GameProjectService;
  const builds = yield* GameBuilds.GameBuilds;
  const engines = yield* GameEngine.GameEngine;

  // A refusal from inside a game path (a link out of the game) passes as it is.
  const io = (root: string, detail: string) => (cause: unknown) =>
    isGameOperationError(cause)
      ? cause
      : new GameOperationError({ operation: "plays", path: root, reason: "io", detail, cause });
  const refused = (path: string, detail: string) =>
    new GameOperationError({ operation: "plays", path, reason: "invalid-input", detail });

  /** The folder's build, unless the folder was edited since that build. */
  const folderBuild = (threadId: ThreadId) =>
    builds.current(threadId).pipe(
      Effect.map((current) => (current.edited ? null : current.build)),
      Effect.orElseSucceed(() => null),
    );

  const keep: GamePlays["Service"]["keep"] = (threadId, input) =>
    Effect.gen(function* () {
      const root = yield* projects.resolve(threadId);
      const build = input.build ?? (yield* folderBuild(threadId));
      const at = DateTime.formatIso(yield* DateTime.now);
      const kept = yield* Effect.tryPromise({
        try: () => keepPlay(root, { at, build, play: input.play }),
        catch: io(root, "The play could not be kept."),
      });
      return { kept };
    });

  const latest = (root: string, id?: string) =>
    Effect.tryPromise({
      try: () => keptPlay(root, id),
      catch: io(root, "The kept plays could not be read."),
    });

  /** A play run on a build's copy, or on the folder as it is now. */
  const replayOn = (threadId: ThreadId, root: string, target: GameBuildId | "folder") =>
    target === "folder"
      ? (play: GamePlay) => engines.replayIn(root, play)
      : (play: GamePlay) => builds.inCopy(threadId, target, (copy) => engines.replayIn(copy, play));

  const replay: GamePlays["Service"]["replay"] = (threadId, target) =>
    Effect.gen(function* () {
      const root = yield* projects.resolve(threadId);
      const kept = yield* latest(root);
      if (kept === null)
        return yield* refused(
          root,
          "No play is kept yet: a run played on the Stage to its end is kept for replays.",
        );
      const run = yield* replayOn(threadId, root, target)(kept.play);
      return {
        kept: { at: kept.at, build: kept.build, outcome: kept.play.outcome },
        now: run.outcome,
        differs: firstPlayDifference(kept.play.marks, run.marks),
      } satisfies GameReplayResult;
    });

  const all = (root: string) =>
    Effect.tryPromise({
      try: () => savedPlays(root),
      catch: io(root, "The saved plays could not be read."),
    });

  // The folder's build measured again, so its Saved plays fact follows the plays now saved.
  const remeasure = (threadId: ThreadId, root: string) =>
    builds.current(threadId).pipe(
      Effect.flatMap((current) =>
        current.build === null ? Effect.void : builds.measureIn(root, current.build),
      ),
      Effect.ignore,
    );

  const save: GamePlays["Service"]["save"] = (threadId, input) =>
    Effect.gen(function* () {
      const root = yield* projects.resolve(threadId);
      // The agent's name comes unchecked through its tool.
      if (!isPlayName(input.name))
        return yield* refused(
          root,
          "A test play's name is 1 to 60 letters, digits, spaces, dashes, underscores or apostrophes.",
        );
      const kept = yield* latest(root, input.kept);
      if (kept === null)
        return yield* refused(
          root,
          input.kept === undefined
            ? "No run is kept yet: play one to its end, on the Stage or with game_play start and act, then save it."
            : "That run is no longer kept (only the newest ten are): play it again and save it.",
        );
      if (kept.play.outcome.left === true)
        return yield* refused(
          root,
          "That run was left before it ended, so it has no ending to test: save a run played to its end.",
        );
      // A play that does not repeat itself on its own build is noise, never a test.
      const target = kept.build ?? "folder";
      const run = yield* replayOn(threadId, root, target)(kept.play);
      const check = savedPlayReading(input.name, kept.play, run);
      if (check.reading !== "same")
        return yield* refused(
          root,
          `"${input.name}" does not replay the same on ${kept.build === null ? "the folder it was played on" : "the build it was played on"}, so it was not saved as a test: ${savedPlayWords(check)}. The game reads something a replay does not repeat: usually its own timers or listeners, or chance or time outside ctx.random(), ctx.after() and update().`,
        );
      const before = yield* all(root);
      const replaced = before.plays.some((each) => each.name === input.name);
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* Effect.tryPromise({
        try: () =>
          writeSavedPlay(root, { name: input.name, at, build: kept.build, play: kept.play }),
        catch: io(root, "The play could not be saved."),
      });
      yield* remeasure(threadId, root);
      return { name: input.name, at, build: kept.build, outcome: kept.play.outcome, replaced };
    });

  const saved: GamePlays["Service"]["saved"] = (threadId) =>
    Effect.gen(function* () {
      const root = yield* projects.resolve(threadId);
      return (yield* all(root)).plays.map((each) => ({
        name: each.name,
        at: each.at,
        build: each.build,
        outcome: each.play.outcome,
      }));
    });

  const remove: GamePlays["Service"]["remove"] = (threadId, name) =>
    Effect.gen(function* () {
      const root = yield* projects.resolve(threadId);
      const deleted = yield* Effect.tryPromise({
        try: () => deleteSavedPlay(root, name),
        catch: io(root, "The saved play could not be deleted."),
      });
      if (!deleted)
        return yield* refused(`${root}/${SAVED_DIR}`, `No saved play is called "${name}".`);
      yield* remeasure(threadId, root);
    });

  const replaySaved: GamePlays["Service"]["replaySaved"] = (threadId) =>
    Effect.gen(function* () {
      const root = yield* projects.resolve(threadId);
      const plays = yield* all(root);
      if (plays.plays.length === 0) return yield* replay(threadId, "folder");
      return yield* replaySavedPlays(plays, replayOn(threadId, root, "folder"));
    });

  const moment: GamePlays["Service"]["moment"] = (threadId, input) =>
    Effect.gen(function* () {
      const root = yield* projects.resolve(threadId);
      const named = (yield* all(root)).plays.find((each) => each.name === input.run);
      const found = named ?? (yield* latest(root, input.run));
      if (found === undefined || found === null)
        return yield* refused(
          root,
          `No saved play or kept run is "${input.run}": a saved play goes by its name, a run by the id its message gave (only the newest ten runs are kept).`,
        );
      const { play } = found;
      // A moment past the run's end shows nothing the person saw.
      const at = Math.min(Math.max(0, input.at ?? play.outcome.seconds), play.outcome.seconds);
      const logs = yield* Effect.tryPromise({
        try: () => ensureGameDir(root, "builds/logs"),
        catch: io(root, "The replay's frame could not be kept."),
      });
      const image = NodePath.join(logs, `replay-${NodeCrypto.randomUUID()}.png`);
      const run = yield* engines.replayIn(root, play, { at, image });
      if (run.missing !== undefined && run.missing.length > 0)
        return yield* refused(
          root,
          `This run presses ${run.missing.join(", ")}, which the game no longer has, so it cannot replay.`,
        );
      const stopped = run.stopped ?? run.marks.at(-1);
      const upTo = (marks: ReadonlyArray<GamePlay["marks"][number]>) =>
        marks.filter((mark) => mark.t <= run.seconds + 0.05);
      const drawn = yield* Effect.promise(() =>
        NodeFSP.stat(image).then(
          () => true,
          () => false,
        ),
      );
      return {
        run: input.run,
        played: play.outcome,
        at: run.seconds,
        ended: run.outcome,
        player: stopped?.at ?? null,
        values: stopped?.values ?? {},
        differs: firstPlayDifference(upTo(play.marks), upTo(run.marks)),
        image: drawn ? NodePath.relative(root, image) : null,
      } satisfies GameReplayMoment;
    });

  return GamePlays.of({ keep, replay, save, saved, remove, replaySaved, moment });
});

export const layer = Layer.effect(GamePlays, make);
