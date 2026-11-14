// @effect-diagnostics nodeBuiltinImport:off -- Kept plays are small JSON files in the game's ignored builds folder.
// A person's runs on the Stage, kept so a newer build can play them again. The three.js shell
// records a run as it is played (shell/replay.js) and the Stage hands it here when it ends; a
// replay runs the latest one on a build's copy (or the folder, for the agent) and says how it
// ends there and the first second it plays differently. Plays live beside the game's logs in
// builds/plays, which the game's git ignores, and only the newest few are kept.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  firstPlayDifference,
  GameBuildId,
  GameOperationError,
  GamePlay,
  type GameKeepPlayInput,
  type GameReplayResult,
  type ThreadId,
} from "@kurambit/contracts";
import * as GameBuilds from "./GameBuilds.ts";
import * as GameEngine from "./GameEngine.ts";
import * as GameProjectService from "./GameProjectService.ts";

const PLAYS = "builds/plays";
/** Plays kept per game: the newest, since a replay plays the latest. */
const KEPT = 10;

const KeptPlay = Schema.fromJsonString(
  Schema.Struct({ at: Schema.String, build: Schema.NullOr(GameBuildId), play: GamePlay }),
);
const decodeKept = Schema.decodeUnknownOption(KeptPlay);
const encodeKept = Schema.encodeSync(KeptPlay);

export class GamePlays extends Context.Service<
  GamePlays,
  {
    /** Keeps a run the person played to its end, with the build it was played on. */
    readonly keep: (
      threadId: ThreadId,
      input: Omit<GameKeepPlayInput, "threadId">,
    ) => Effect.Effect<void, GameOperationError>;
    /** The latest kept play run again on a build's copy, or on the folder as it is now. */
    readonly replay: (
      threadId: ThreadId,
      target: GameBuildId | "folder",
    ) => Effect.Effect<GameReplayResult, GameOperationError>;
  }
>()("kurambit/game/GamePlays") {}

const make = Effect.gen(function* () {
  const projects = yield* GameProjectService.GameProjectService;
  const builds = yield* GameBuilds.GameBuilds;
  const engines = yield* GameEngine.GameEngine;

  const io = (root: string, detail: string) => (cause: unknown) =>
    new GameOperationError({ operation: "plays", path: root, reason: "io", detail, cause });

  const keep: GamePlays["Service"]["keep"] = (threadId, input) =>
    Effect.gen(function* () {
      const root = yield* projects.resolve(threadId);
      // The folder's build it was played on, unless the folder was edited since that build.
      const build = yield* builds.current(threadId).pipe(
        Effect.map((current) => (current.edited ? null : current.build)),
        Effect.orElseSucceed(() => null),
      );
      const at = DateTime.formatIso(yield* DateTime.now);
      const dir = NodePath.join(root, PLAYS);
      const name = `${at.replace(/[:.]/g, "-")}-${NodeCrypto.randomBytes(3).toString("hex")}.json`;
      yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.mkdir(dir, { recursive: true });
          const temporary = NodePath.join(dir, `.${name}`);
          await NodeFSP.writeFile(temporary, encodeKept({ at, build, play: input.play }));
          await NodeFSP.rename(temporary, NodePath.join(dir, name));
          const kept = (await NodeFSP.readdir(dir)).filter((each) => each.endsWith(".json")).sort();
          for (const old of kept.slice(0, Math.max(0, kept.length - KEPT)))
            await NodeFSP.rm(NodePath.join(dir, old), { force: true });
        },
        catch: io(root, "The play could not be kept."),
      });
    });

  /** The newest kept play that still reads, or null. */
  const latest = (root: string) =>
    Effect.tryPromise({
      try: async () => {
        const dir = NodePath.join(root, PLAYS);
        const names = await NodeFSP.readdir(dir).catch(() => [] as Array<string>);
        const newestFirst = names
          .filter((each) => each.endsWith(".json"))
          .toSorted()
          .toReversed();
        for (const name of newestFirst) {
          const kept = decodeKept(await NodeFSP.readFile(NodePath.join(dir, name), "utf8"));
          if (Option.isSome(kept)) return kept.value;
        }
        return null;
      },
      catch: io(root, "The kept plays could not be read."),
    });

  const replay: GamePlays["Service"]["replay"] = (threadId, target) =>
    Effect.gen(function* () {
      const root = yield* projects.resolve(threadId);
      const kept = yield* latest(root);
      if (kept === null)
        return yield* new GameOperationError({
          operation: "replay",
          path: NodePath.join(root, PLAYS),
          reason: "invalid-input",
          detail: "No play is kept yet: a run played on the Stage to its end is kept for replays.",
        });
      const run =
        target === "folder"
          ? yield* engines.replayIn(root, kept.play)
          : yield* builds.inCopy(threadId, target, (copy) => engines.replayIn(copy, kept.play));
      return {
        kept: { at: kept.at, build: kept.build, outcome: kept.play.outcome },
        now: run.outcome,
        differs: firstPlayDifference(kept.play.marks, run.marks),
      } satisfies GameReplayResult;
    });

  return GamePlays.of({ keep, replay });
});

export const layer = Layer.effect(GamePlays, make);
