// @effect-diagnostics nodeBuiltinImport:off -- A restore's request id is a hash of the caller's command id, as the run's restore makes it; a game's place in its repository is read from disk.
// The Builds rail, for the Game panel and the agent tools alike: every turn
// that changed the game (its T3 checkpoint, marked with the keep-going step it
// was), the values kept from the Stage and the folder before each restore,
// newest first, each with what changed and its facts. Builds are not a record
// of their own: the list is read from the checkpoints and refs each time. A build plays and is measured in a copy of its own,
// and goes back into the game folder through one restore, the person's Undo
// and keep going's alike.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeCrypto from "node:crypto";
import {
  CheckpointRef,
  diffBuildFacts,
  GAME_BUILDS_EVENT,
  type GameBuild,
  type GameBuildChanges,
  type GameBuildComparison,
  type GameBuildFacts,
  GameBuildId,
  type GameBuildPlayResult,
  type GameBuildRef,
  type GameBuildUndoResult,
  GameBuildRestoreResult,
  type GameBuildsResult,
  type GameEngineName,
  isAvailableEngine,
  GameKeepValuesInput as GameKeepValuesInputSchema,
  type GameKeepValuesInput,
  type GameKeepValuesResult,
  gameLookId,
  GameOperationError,
  manifestProject,
  type OrchestrationV2Run,
  unavailableEngineMessage,
  type ProjectId,
  RESTORE_BEFORE_LABEL,
  RunId,
  ThreadId,
} from "@kurambit/contracts";
import * as KeyedLock from "@kurambit/shared/KeyedLock";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import { threadRefKey, worktreeSeedRef } from "../checkpointing/worktreeSeed.ts";
import { parseTurnDiffFilesFromNumstat } from "../checkpointing/Diffs.ts";
import { checkpointRefForGameRun, gameRunRefsFolder } from "../checkpointing/Utils.ts";
import {
  checkpointRefForScopeOrdinal,
  nextTurnBaseRefForThread,
} from "../orchestration-v2/CheckpointService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { type EarlierBuild, summaryOf, turnChangeBase } from "./buildFacts.ts";
import { END_FRAME } from "./gameBotRuntime.ts";
import * as GameBuildCopies from "./GameBuildCopies.ts";
import * as GameFacts from "./GameFacts.ts";
import * as GameFolders from "./GameFolders.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameRunControl from "./GameRunControl.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameStage from "./GameStage.ts";
import { decisionsOfBuild, dropDecisions, recordDecision } from "./GameDecisions.ts";
import { nextKey, replyHeadline } from "../orchestration-v2/gameRun/decide.ts";
import { BuildName } from "./run/buildNames.ts";
import { availableEngine, engineCapabilities, engineProfile } from "./engineProfile.ts";
import { isRestored, measureChange, withBuildInFolder } from "./run/builds.ts";
import { projectStep, supersedeProposal } from "./run/inFlight.ts";
import { replaceComposerContextReferences } from "@kurambit/shared/composerContextReferences";
import { isFirstTurnLead } from "@kurambit/shared/gameFirstTurn";
import { sameTuneFile, tuneChanges, tuneFileText, tuneFileWith } from "./gameTune.ts";
import { mergeBuilds } from "./mergeBuilds.ts";
import { readTry, triesInRefs } from "./gameTries.ts";

/** The refs a game with no run keeps its restores' "before" folders under. */
const NO_RUN = "game-builds";
/**
 * Each turn build's base as it was when the turn landed, one ref per build
 * (`bases/<build>` pointing at the base), the way T3 records a checkpoint: a
 * base read later from the latest restore alone would be wrong once a second
 * restore replaced the first. The refs also keep every base restorable.
 */
const BASES = `${gameRunRefsFolder(NO_RUN)}bases/`;
/**
 * A turn folded into the build before it, as a fix of that build (`fixes/<build>`, pointing at
 * the build itself): it keeps that build's number. Earlier servers wrote these from what the agent
 * declared; they are still read, and no longer written.
 */
const FIXES = `${gameRunRefsFolder(NO_RUN)}fixes/`;
/**
 * A person's edit kept as a build outside a turn (the Stage's Keep as a
 * build): `edits/<request>-values` is the build, `edits/<request>-from` the
 * folder just before it, which restoring undoes it to.
 */
const EDITS = "edits/";
/**
 * Where the folder stood once an earlier Kurambit's keep going wrote its play
 * bot as setup (`bots/<run>`), with the build it was written on (`-from`,
 * written last, so a setup point counts only once it is whole). Still read so
 * those games list as before: it is no build of the rail, which names the
 * build it was written on.
 */
const BOTS = `${gameRunRefsFolder(NO_RUN)}bots/`;
const VALUES_LABEL = "Tuned";
/** A Library add kept as a build: `edits/<request>-library`, beside its `-from`. */
const LIBRARY_SUFFIX = "-library";
const LIBRARY_LABEL = "Added from the Library";
/**
 * A build landed in the game outside a turn by a merge: `edits/<request>-in` a copy brought in,
 * `edits/<request>-undo` one build's change reversed (`-undid` names that build), each beside
 * its `-from`, the game it landed on. The commit's subject is its label.
 */
const LANDED_SUFFIX = "-in";
const UNDO_SUFFIX = "-undo";
/** The folder as last compared with the build it was made from (folderEdited); no build of its own. */
const FOLDER_REF = CheckpointRef.make("refs/kurambit/game-builds/folder");
const MOVED_ON =
  "The game changed after the build this would undo, so nothing was restored and nothing was lost.";
/** The local branch the game's builds are written to as plain commits (mirrorHistory). */
const HISTORY_BRANCH = CheckpointRef.make("refs/heads/kurambit/history");
/** Where a build with no known time sorts: last. */
const EPOCH = "1970-01-01T00:00:00.000Z";
const isoOfSeconds = (seconds: number) => DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000));
const TURN_REFS = "refs/kurambit/orchestration-v2/checkpoints/";
const MAX_FILES = 8;
/** Why the Game panel cannot play a build of this engine's game, or null when it can. */
const noPlayReason = (engine: GameEngineName) =>
  !isAvailableEngine(engine)
    ? unavailableEngineMessage(engine)
    : engineProfile(engine).stage === "window"
      ? `${engineProfile(engine).displayName} builds play in their own window; the Game panel has no ${engineProfile(engine).displayName} Play yet.`
      : null;
/** Whether a build of this engine's game is measured: never for an engine this version does not have. */
const measurable = (engine: GameEngineName) => engineCapabilities(engine).has("play");
const isGameBuildId = Schema.is(GameBuildId);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** `copies/<chat key>/in|out` under the game-builds refs: when a chat moved into its copy and back. */
const COPY_MOVE = /^copies\/([0-9a-f]+)\/(in|out)$/;
/** Per chat key (threadRefKey), when it moved into a copy and back (unix seconds). */
type CopyMoves = Map<string, { readonly in?: number; readonly out?: number }>;
/**
 * Whether a turn's build was made in the folder `g` is: a thread's checkpoints all carry its
 * current folder, so a chat that moved into a copy or back is told apart by when it moved.
 */
const madeHere = (
  g: { readonly root: string; readonly home: string },
  moves: CopyMoves,
  row: {
    readonly threadId: ThreadId;
    readonly cwd: string | null;
    readonly checkpoint: { readonly capturedAt: DateTime.Utc };
  },
) => {
  const move = moves.size === 0 ? undefined : moves.get(threadRefKey(row.threadId));
  if (move?.in === undefined) return row.cwd === g.root;
  const at = DateTime.toEpochMillis(row.checkpoint.capturedAt) / 1000;
  const inCopy = at >= move.in && (move.out === undefined || move.out < move.in || at < move.out);
  return g.root === g.home ? !inCopy && row.cwd !== null : inCopy && row.cwd === g.root;
};

/** One build before its facts are read. */
interface Entry {
  readonly id: GameBuildId;
  readonly at: string;
  readonly source: GameBuild["source"];
  readonly summary: string;
  readonly files: GameBuild["files"];
  /** Null when the change was not counted. */
  readonly fileCount: number | null;
  /** The build it was made from, which restoring undoes it; null when unknown. */
  readonly base: string | null;
}

/** What a restore did to the folder; a failure is the restore's error instead. */
export type RestoreMoved = "restored" | "current" | "moved-on";

const NoRunRestore = Schema.Struct({
  requestId: Schema.String,
  target: GameBuildId,
  label: Schema.String,
  requestedAt: Schema.String,
  before: Schema.NullOr(GameBuildId),
  /** Restore only while the folder holds this build (keep going's undo); kept so a settle honours it. */
  expect: Schema.optionalKey(GameBuildId),
  /** The chat that asked, whose next turn a settle counts from the restored build too. */
  thread: Schema.optionalKey(ThreadId),
  outcome: Schema.NullOr(
    Schema.Struct({
      restored: Schema.Boolean,
      message: Schema.String,
      /** Absent on records written before it: read from `restored`. */
      moved: Schema.optionalKey(Schema.Literals(["restored", "current", "moved-on", "refused"])),
    }),
  ),
});
type NoRunRestore = typeof NoRunRestore.Type;
const NoRunRestoreJson = Schema.fromJsonString(NoRunRestore);
const decodeNoRunRestore = Schema.decodeUnknownOption(NoRunRestoreJson);
const encodeNoRunRestore = Schema.encodeEffect(NoRunRestoreJson);

const firstLine = (text: string | null, fallback: string) => {
  // A thing the person pointed at is a link in the message: here it is its name, before the
  // line is cut, so no surface ever shows a link's address or half of one.
  const line =
    replaceComposerContextReferences(text ?? "", (reference) => reference.label)
      .split("\n")
      .find((each) => each.trim() !== "" && !isFirstTurnLead(each.trim()))
      ?.trim() ?? "";
  return line === "" ? fallback : line.length > 140 ? `${line.slice(0, 139)}…` : line;
};

const topFiles = (
  files: ReadonlyArray<{
    readonly path: string;
    readonly additions: number;
    readonly deletions: number;
  }>,
) =>
  files
    .toSorted((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
    .slice(0, MAX_FILES)
    .map(({ path, additions, deletions }) => ({ path, additions, deletions }));

export class GameBuilds extends Context.Service<
  GameBuilds,
  {
    /** The rail; with `home`, the game folder's even for a chat in a copy. */
    readonly list: (
      threadId: ThreadId,
      input: {
        readonly before?: string | undefined;
        readonly limit?: number | undefined;
        readonly home?: boolean;
      },
    ) => Effect.Effect<GameBuildsResult, GameOperationError>;
    readonly compare: (
      threadId: ThreadId,
      a: GameBuildRef,
      b: GameBuildRef,
    ) => Effect.Effect<GameBuildComparison, GameOperationError>;
    /** Every file the build changed from its base, and the tuned values among them. */
    readonly changes: (
      threadId: ThreadId,
      build: GameBuildId,
    ) => Effect.Effect<GameBuildChanges, GameOperationError>;
    /** The build's facts as measured; starts nothing. */
    readonly facts: (
      threadId: ThreadId,
      build: GameBuildRef,
    ) => Effect.Effect<GameBuildFacts, GameOperationError>;
    /**
     * Measures what the build lacks. A person's measure waits behind at most
     * three others; an agent's waits up to `waitFor` for the result.
     */
    readonly measure: (
      threadId: ThreadId,
      build: GameBuildRef,
      options?: {
        readonly waitFor?: Duration.Input;
        readonly queue?: "person" | "background";
        /** Wait only for the boot check, the QA play and the saved plays (GameFacts.measure). */
        readonly upTo?: "boots";
      },
    ) => Effect.Effect<GameBuildFacts, GameOperationError>;
    /** Measures the work owed by data (rows owing tiers, live runs' rounds) and settles cut-short restores. */
    readonly reconcile: Effect.Effect<void>;
    /**
     * Fixes a turn build's base (what restoring undoes it to) as the turn
     * lands; the reactor calls it on the turn's checkpoint, a reconcile after
     * a restart for the newest turn.
     */
    readonly recordTurn: (threadId: ThreadId, checkpointRef: string) => Effect.Effect<void>;
    /**
     * A measure no thread waits for: a keep-going step's build as it lands,
     * or a chat turn's build, which with `supersede` replaces the game's earlier turn
     * builds still queued.
     */
    readonly measureIn: (
      root: string,
      build: string,
      options?: { readonly supersede?: boolean },
    ) => Effect.Effect<void>;
    /** Plays the build from its copy; the game folder is never touched. Measures it if it never was. */
    readonly play: (
      threadId: ThreadId,
      build: GameBuildRef,
    ) => Effect.Effect<GameBuildPlayResult, GameOperationError>;
    /**
     * Runs `work` on the build's copy while it is leased; the folder is never touched. Not an
     * engine step: work that only reads the copy (a replay serves its files) never waits on one.
     */
    readonly inCopy: <A, E, R>(
      threadId: ThreadId,
      build: GameBuildId,
      work: (copy: string) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | GameOperationError, R>;
    /** Stops one build's Play from its copy; the folder's own Play is never touched. */
    readonly stopPlay: (
      threadId: ThreadId,
      build: GameBuildRef,
    ) => Effect.Effect<void, GameOperationError>;
    /**
     * Puts the build's engine project, art, ASSETS.md and play bot back in the game
     * folder, keeping the folder before as a build. With `expect`, inside the
     * game lock, only when the folder still holds that build and is unedited;
     * else it is refused "moved-on" and nothing moves (keep going's undo).
     */
    readonly restore: (
      threadId: ThreadId,
      build: GameBuildRef,
      commandId: string | undefined,
      options?: {
        readonly expect?: GameBuildId;
        /** The person asked (Undo, Redo, Go back): what it turned down goes in the game's decisions. */
        readonly person?: boolean;
      },
    ) => Effect.Effect<
      typeof GameBuildRestoreResult.Type & { readonly moved: RestoreMoved },
      GameOperationError
    >;
    /**
     * Lands `tree` in the game folder as a build of its own made on `from` (the game as the
     * merge read it), labelled `label`: moved only while the folder still holds `from`, else
     * `moved-on` and nothing moves. It goes through the restore's record, so a restart settles
     * a landing it cut short. A repeat with the same request answers as the first did.
     */
    readonly land: (
      threadId: ThreadId,
      input: {
        readonly request: string;
        readonly tree: string;
        readonly from: GameBuildId;
        readonly kind: "in" | "undo";
        readonly label: string;
        readonly undid?: GameBuildId;
      },
    ) => Effect.Effect<
      { readonly build: GameBuildId; readonly moved: RestoreMoved },
      GameOperationError
    >;
    /**
     * Undo: one build's change reversed in the game folder, every later build kept (a reverse
     * merge from the build's recorded base). For the newest build it is the build it was made
     * from. Redo is the undo of an undo. Later work that changed the same lines refuses it.
     */
    readonly undo: (
      threadId: ThreadId,
      build: GameBuildId,
      commandId: string | undefined,
    ) => Effect.Effect<GameBuildUndoResult, GameOperationError>;
    /**
     * The folder's current build (currentBuild), and whether its engine
     * project, art, ASSETS.md and play bot are no longer that build's, read under the
     * game's lock.
     */
    readonly current: (
      threadId: ThreadId,
    ) => Effect.Effect<
      { readonly build: GameBuildId | null; readonly edited: boolean },
      GameOperationError
    >;
    /** The folder still holds `build` in what a restore covers (restoredPaths), read under the game's lock. */
    readonly holds: (
      threadId: ThreadId,
      build: GameBuildId,
    ) => Effect.Effect<boolean, GameOperationError>;
    /**
     * Writes the Stage's live values to the engine's tune file and keeps the
     * folder as a build, the folder before it kept too so Undo restores it. A
     * repeat with the same `commandId` answers as the first did.
     */
    readonly keepValues: (
      threadId: ThreadId,
      input: Omit<GameKeepValuesInput, "threadId">,
    ) => Effect.Effect<GameKeepValuesResult, GameOperationError>;
    /**
     * Values kept while a turn worked in their folder, landed now that it has ended: each as
     * its own build, merged per value onto what the turn left. A turn still at work keeps them.
     */
    readonly landHeldKeeps: (root: string) => Effect.Effect<void>;
    /**
     * Runs `write` on the game folder as the game's one operation and keeps what it changed as
     * a build, the folder before it kept too so Undo restores it: a person's change made outside
     * a turn (a Library add). A repeat with the same `commandId` answers as the first did.
     */
    readonly keepEdit: <E>(
      threadId: ThreadId,
      input: {
        readonly operation: string;
        readonly edit: "library";
        readonly commandId?: string | undefined;
        readonly write: (root: string) => Effect.Effect<void, E>;
      },
    ) => Effect.Effect<{ readonly build: string; readonly base: string }, E | GameOperationError>;
    /**
     * A chat turn's build once its checkpoint is kept, the build the folder
     * held when the turn started (its recorded base; null when none was
     * recorded), and how many files of what a restore covers (restoredPaths)
     * it changed since then (since `fallback` without one); null while the
     * turn has no kept checkpoint.
     */
    readonly turnBuild: (
      threadId: ThreadId,
      runId: RunId,
      fallback: GameBuildId | null,
    ) => Effect.Effect<
      {
        readonly build: GameBuildId;
        readonly startBuild: GameBuildId | null;
        readonly files: number;
      } | null,
      GameOperationError
    >;
  }
>()("kurambit/game/GameBuilds") {}

/** A build that may be the folder's, with when it came into the folder. */
interface Placed {
  readonly id: string;
  readonly at: string;
}

/** A page of turn builds, newest first, from the projection's newest-first turn rows. */
export interface TurnPage {
  readonly newest: Placed | null;
  /** When the page's oldest row was captured: the next page starts below it. */
  readonly oldest: string | null;
  /** The page was full: older turns may follow. */
  readonly more: boolean;
}

/**
 * The folder's current build: the newest turn build that changed game files,
 * or a later kept edit or restore target (`others`). Turns that changed only
 * notes are no builds, so the turns are read page by page however far back
 * they go. The walk ends when a page holds a build, the turns end, or a page
 * reaches back past the newest of `others` (an older turn cannot win). Each
 * page starts strictly below the last, so it always ends.
 */
export const currentBuild = <E, R>(
  others: ReadonlyArray<Placed>,
  turns: (before: string | undefined) => Effect.Effect<TurnPage, E, R>,
): Effect.Effect<string | null, E, R> =>
  Effect.gen(function* () {
    const newestOf = (all: ReadonlyArray<Placed>) =>
      all.reduce<Placed | null>((best, e) => (best === null || e.at > best.at ? e : best), null);
    const floor = newestOf(others)?.at ?? null;
    let before: string | undefined;
    for (;;) {
      const page = yield* turns(before);
      if (page.newest !== null) return newestOf([page.newest, ...others])?.id ?? null;
      const oldest = page.oldest;
      if (
        !page.more ||
        oldest === null ||
        (floor !== null && oldest <= floor) ||
        (before !== undefined && oldest >= before)
      )
        return newestOf(others)?.id ?? null;
      before = oldest;
    }
  });

/** Turn rows a page of the current-build walk reads. */
const TURN_PAGE = 30;
/** Every turn row older than a page, read to number its builds. */
const ALL_TURNS = 1_000_000;

/** A build's number, and which fix of it it is (null for the build itself). */
interface BuildNumber {
  readonly number: number;
  readonly fix: number | null;
}

/**
 * A chat turn whose build has not settled: still running, or over with its checkpoint, the build
 * if it made one, still being saved. T3 holds a finished run at `waiting` until that checkpoint
 * commits; a stopped run is terminal at once and its checkpoint follows.
 */
export const turnPending = (
  run: Pick<OrchestrationV2Run, "status" | "startedAt" | "checkpointId">,
) =>
  run.status === "running" ||
  run.status === "waiting" ||
  ((run.status === "interrupted" || run.status === "cancelled") &&
    run.startedAt !== null &&
    run.checkpointId === null);

/**
 * A build in the game's one numbered sequence, the way a person counts what they see land: a
 * chat's turn, a keep-going step and values kept from the Stage. A restore's parked folder is
 * the game as it was, not a new build.
 */
const isNumbered = (entry: Entry) =>
  entry.source._tag === "turn" ||
  (entry.source._tag === "saved" && entry.source.edit !== undefined);

interface KeptChange {
  readonly label: string;
  readonly from: string;
  readonly to: string;
}
const valueWords = (value: unknown, colour = false) =>
  typeof value === "number"
    ? colour
      ? `#${Math.round(value).toString(16).padStart(6, "0")}`
      : String(Math.round(value * 1000) / 1000)
    : typeof value === "boolean"
      ? String(value)
      : "default";
const GAME_LOOK_PREFIX = gameLookId("");
/** A thing's name in a line: the last part of its id, without an extension. */
const thingWords = (id: string) =>
  id
    .split("/")
    .at(-1)!
    .replace(/\.[a-z0-9]+$/i, "") || id;

/** Each kept value from where the session started (the base file's value, else its default). */
const keptChanges = (
  baseFile: unknown,
  things: GameKeepValuesInput["things"],
): ReadonlyArray<KeptChange> =>
  things.flatMap((thing) =>
    thing.values.map((value) => {
      const kept =
        baseFile !== null && typeof baseFile === "object"
          ? (baseFile as Record<string, unknown>)[thing.id]
          : undefined;
      const was =
        kept !== null && typeof kept === "object"
          ? (kept as Record<string, unknown>)[value.key]
          : undefined;
      // A look's keys are a material's place and name ("3:roof/color"): its label says it.
      const look = thing.id.startsWith(GAME_LOOK_PREFIX) && value.label !== undefined;
      return {
        label: look
          ? `${thingWords(thing.id.slice(GAME_LOOK_PREFIX.length))} ${value.label!.toLowerCase()}`
          : `${thingWords(thing.id)} ${value.key}`,
        from: valueWords(was ?? value.default, value.colour === true),
        to: valueWords(value.value, value.colour === true),
      };
    }),
  );

/** The "label from → to" parts of a kept-values line, by label. */
const keptSegments = (text: string) =>
  text
    .slice(text.indexOf(": ") + 2)
    .split("; ")
    .flatMap((part): ReadonlyArray<readonly [string, { from: string; to: string }]> => {
      const match = /^(.+) (\S+) → (\S+)$/.exec(part);
      return match === null ? [] : [[match[1]!, { from: match[2]!, to: match[3]! }]];
    });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const projects = yield* GameProjectService.GameProjectService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const facts = yield* GameFacts.GameFacts;
  const runs = yield* GameRunControl.GameRunControl;
  const stage = yield* GameStage.GameStage;
  const preview = yield* GamePreview.GamePreview;
  const operations = yield* GameOperations.GameOperations;
  const copies = yield* GameBuildCopies.GameBuildCopies;
  const scope = yield* Effect.scope;
  const crypto = yield* Crypto.Crypto;
  const engine = yield* Orchestrator.OrchestratorV2;
  const folders = yield* GameFolders.GameFolders;
  // Older turns never change their builds: a page's count below it is read once per ref set.
  const numberedCounts = new Map<string, number>();
  const mirrorLock = yield* KeyedLock.make<string>();
  // A round's change against the build before it never changes: read once.
  const roundFiles = new Map<string, { files: GameBuild["files"]; count: number | null }>();

  const failed = (
    operation: string,
    path: string,
    reason: GameOperationError["reason"],
    detail: string,
    cause?: unknown,
  ) =>
    new GameOperationError({
      operation,
      path,
      reason,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  /** Every ref a build of the game lives under: turn checkpoints and run builds, never a capture's index. */
  const buildRefs = (root: string) =>
    Effect.forEach([TURN_REFS, "refs/kurambit/game-runs/"], (prefix) =>
      checkpoints.listCheckpointRefs({ cwd: root, prefix }),
    ).pipe(
      Effect.map((lists) => lists.flat()),
      Effect.mapError((cause) =>
        failed("Builds", root, "io", "the game's builds could not be listed", cause),
      ),
    );

  /** The thread's game: its folder, project, engine and engine folder. */
  // The thread's folder (a copy's own), or with `home` the game's folder whatever the thread's.
  const gameOf = (threadId: ThreadId, home = false) =>
    Effect.gen(function* () {
      const root = home ? (yield* projects.home(threadId)).root : yield* projects.resolve(threadId);
      const manifest = yield* projects.read(root);
      const shell = yield* projections
        .getThreadShell(threadId)
        .pipe(
          Effect.mapError((cause) =>
            failed("Builds", root, "io", "the thread could not be read", cause),
          ),
        );
      if (shell === null)
        return yield* failed("Builds", root, "project-not-found", "the thread is gone");
      return {
        root,
        // The game's own folder, where its one decisions file lives, even for a chat in a copy.
        home: home ? root : (yield* projects.home(threadId)).root,
        projectId: shell.projectId,
        engine: manifest.engine.name,
        lane: manifestProject(manifest),
      };
    });
  type Game = Effect.Success<ReturnType<typeof gameOf>>;

  // The game folder's path inside its repository ("" at the top), found once per game.
  const prefixes = new Map<string, string>();
  const repoPrefix = (root: string) =>
    Effect.promise(async () => {
      const known = prefixes.get(root);
      if (known !== undefined) return known;
      let dir = NodePath.resolve(root);
      let prefix = "";
      for (;;) {
        const git = await NodeFSP.lstat(NodePath.join(dir, ".git")).then(
          () => true,
          () => false,
        );
        if (git) break;
        const up = NodePath.dirname(dir);
        if (up === dir) {
          prefix = "";
          break;
        }
        prefix = `${NodePath.basename(dir)}/${prefix}`;
        dir = up;
      }
      if (prefixes.size > 200) prefixes.clear();
      prefixes.set(root, prefix);
      return prefix;
    });

  // Checkpoint paths are the repository's; a game in a subfolder of it strips its own prefix.
  const gamePaths = (root: string) =>
    Effect.map(
      repoPrefix(root),
      (prefix) => (path: string) =>
        prefix === "" ? path : path.startsWith(prefix) ? path.slice(prefix.length) : null,
    );

  // A step mark is the strip's line, never the list's reason to fail.
  const stepsOf = (threadIds: ReadonlySet<ThreadId>) =>
    Effect.forEach([...threadIds], (threadId) => runs.steps(threadId), { concurrency: 4 }).pipe(
      Effect.map((maps) => new Map(maps.flatMap((each) => [...each]))),
      Effect.catchCause((cause) =>
        Effect.logWarning("Keep-going step marks could not be read.", { cause }).pipe(
          Effect.as(new Map<RunId, GameRunControl.GameRunStepMark>()),
        ),
      ),
    );

  /**
   * The turn checkpoints, each a build listing only its own turn's changes.
   * T3 diffs a turn's checkpoint against its thread's previous one, so a turn
   * after the run (or another chat) changed the folder would list that work as
   * its own: the base is the newest build of the game captured before the turn
   * began.
   */
  const turnEntries = (
    g: Game,
    refs: ReadonlyMap<string, string>,
    limit: number,
    before: string | undefined,
    saved: ReadonlyArray<Entry>,
    recorded: ReadonlyMap<string, string>,
    setups: ReadonlyArray<Placed>,
    moves: CopyMoves,
  ) =>
    Effect.gen(function* () {
      const rows = yield* projections
        .listProjectTurnCheckpoints(g.projectId, { limit, before })
        .pipe(
          Effect.mapError((cause) =>
            failed("Builds", g.root, "io", "the game's turns could not be read", cause),
          ),
        );
      const restored = isRestored(g.lane);
      const inGame = yield* gamePaths(g.root);
      const steps = yield* stepsOf(new Set(rows.map((row) => row.threadId)));
      const noRun = yield* noRunRestoreOf(g.root);
      const restoreTargets =
        noRun?.outcome?.restored === true ? [{ id: noRun.target, at: noRun.requestedAt }] : [];
      // A restore's "before" can be a build listed in its own right (a turn's,
      // a kept edit), so only the park's own entry is left out.
      const restoreBefore = (e: Entry) =>
        e.source._tag === "saved" && e.source.label === RESTORE_BEFORE_LABEL;
      const captures = rows.flatMap((row) => {
        const oid = refs.get(row.checkpoint.ref);
        return !madeHere(g, moves, row) || oid === undefined || !isGameBuildId(oid)
          ? []
          : [{ row, oid, at: DateTime.formatIso(row.checkpoint.capturedAt) }];
      });
      // Every build captured before a turn began, its thread's own turns among them.
      const earlier: ReadonlyArray<EarlierBuild> = [
        ...captures.map((c) => ({
          id: c.oid,
          at: c.at,
          thread: c.row.threadId,
          turn: c.row.runOrdinal,
        })),
        // A build with no known time (EPOCH) is never taken as what came just
        // before a turn, nor is a restore's "before": the folder became the
        // restore's target then, which stands in for it at that time.
        ...saved.flatMap((e) =>
          e.at === EPOCH || restoreBefore(e)
            ? []
            : [{ id: e.id, at: e.at, thread: null, turn: null }],
        ),
        ...restoreTargets.map((t) => ({ id: t.id, at: t.at, thread: null, turn: null })),
        ...setups.map((t) => ({ id: t.id, at: t.at, thread: null, turn: null })),
      ];
      const entries = yield* Effect.forEach(captures, ({ row, oid, at }) =>
        Effect.gen(function* () {
          const startedAt = row.startedAt;
          // The base recorded as the turn landed, else what the builds read now say.
          const base =
            recorded.get(oid) ??
            turnChangeBase(
              { id: oid, startedAt, thread: row.threadId, turn: row.runOrdinal },
              earlier,
            );
          // T3's own base: the thread's checkpoint before this one, which for
          // turn 1 is the thread's start (ordinal 0, captured as it began).
          const ordinal = row.checkpoint.ordinalWithinScope;
          const t3Base =
            ordinal === 0
              ? null
              : (refs.get(
                  yield* checkpointRefForScopeOrdinal({
                    scopeId: row.checkpoint.scopeId,
                    ordinalWithinScope: ordinal - 1,
                  }).pipe(Effect.provideService(Crypto.Crypto, crypto)),
                ) ?? null);
          const t3Files = row.checkpoint.files.flatMap((file) => {
            const path = inGame(file.path);
            return path !== null && restored(path) ? [{ ...file, path }] : [];
          });
          const change =
            base === null || base === t3Base
              ? { files: topFiles(t3Files), count: t3Files.length }
              : yield* changeOf(g.root, g.lane, base, oid);
          if (change.count === 0) return [];
          return [
            {
              id: oid,
              at,
              source: {
                _tag: "turn",
                threadId: row.threadId,
                threadTitle: row.threadTitle,
                turn: row.runOrdinal,
                runId: row.runId,
                request: firstLine(row.request, "(no request text)"),
                step: steps.get(row.runId) ?? null,
              },
              summary: firstLine(row.request, "A turn's changes"),
              files: change.files,
              fileCount: change.count,
              base: base ?? t3Base,
            } satisfies Entry,
          ];
        }),
      );
      return {
        scanned: rows.length,
        oldest:
          rows.at(-1) === undefined ? null : DateTime.formatIso(rows.at(-1)!.checkpoint.capturedAt),
        entries: entries.flat(),
      };
    });

  /** A build's change from the build before it, or not counted (null) when there is none or its diff cannot be read. */
  const changeOf = (root: string, lane: string, from: string | null, to: string) =>
    Effect.gen(function* () {
      if (from === null) return { files: [], count: null };
      const key = `${from}:${to}`;
      const known = roundFiles.get(key);
      if (known !== undefined) return known;
      const numstat = yield* checkpoints
        .diffCheckpoints({
          cwd: root,
          fromCheckpointRef: CheckpointRef.make(from),
          toCheckpointRef: CheckpointRef.make(to),
          ignoreWhitespace: false,
          format: "numstat",
          relative: true,
        })
        .pipe(Effect.orElseSucceed(() => null));
      if (numstat === null) return { files: [], count: null };
      const files = parseTurnDiffFilesFromNumstat(numstat).filter((file) =>
        isRestored(lane)(file.path),
      );
      const change = { files: topFiles(files), count: files.length };
      if (roundFiles.size > 500) roundFiles.clear();
      roundFiles.set(key, change);
      return change;
    });

  /**
   * The versions of every try of the game that have a build. They stay out of
   * the builds a turn counts from (`saved`): the folder never held one unless it
   * was kept, and a keep is a restore, which the turns already count from.
   */
  const versionEntries = (g: Game, refs: ReadonlyMap<string, string>) =>
    Effect.gen(function* () {
      const tries = yield* Effect.forEach(
        triesInRefs(refs.keys()),
        (each) =>
          readTry(projections, refs, each.threadId, each.runId).pipe(
            Effect.orElseSucceed(() => null),
          ),
        { concurrency: 4 },
      );
      const entries = yield* Effect.forEach(
        tries.flatMap((read) =>
          read === null ? [] : read.versions.map((version) => ({ read, version })),
        ),
        ({ read, version }) =>
          Effect.gen(function* () {
            if (version.build === null || !isGameBuildId(version.build)) return [];
            const kept = read.kept?.n === version.n;
            const change = yield* changeOf(g.root, g.lane, read.base, version.build);
            return [
              {
                id: version.build,
                // A kept version came into the folder when it was kept.
                at: kept ? read.kept!.at : (version.capturedAt ?? read.at),
                source: {
                  _tag: "version",
                  threadId: read.threadId,
                  runId: read.runId,
                  request: read.request === "" ? "(no request text)" : read.request,
                  n: version.n,
                  of: read.of,
                  approach: version.approach,
                  kept,
                },
                summary: version.approach === "" ? `Version ${version.n}` : version.approach,
                files: change.files,
                fileCount: change.count,
                base: read.base,
              } satisfies Entry,
            ];
          }),
      );
      return entries.flat();
    });

  const noRunRestoreOf = (root: string) =>
    sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM game_build_restores WHERE root = ${root}
    `.pipe(
      Effect.map((rows) => {
        const row = rows[0];
        if (row === undefined) return null;
        const decoded = decodeNoRunRestore(row.payload_json);
        return Option.isSome(decoded) ? decoded.value : null;
      }),
      Effect.orElseSucceed(() => null),
    );
  const saveNoRunRestore = (root: string, record: NoRunRestore) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const payload = yield* encodeNoRunRestore(record);
      yield* sql`
        INSERT INTO game_build_restores (root, payload_json, updated_at)
        VALUES (${root}, ${payload}, ${now})
        ON CONFLICT (root) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at
      `;
    }).pipe(Effect.ignore);

  // Every build of the game, newest first, from `before`; the turn page is
  // read a little long, since turns that changed only notes are no builds.
  const allEntries = (g: Game, limit: number, before: string | undefined) =>
    Effect.gen(function* () {
      const refs = yield* buildRefs(g.root);
      const byRef = new Map(refs.map((ref) => [ref.checkpointRef as string, ref.oid]));
      const kept = new Set(refs.map((ref) => ref.oid));
      const noRunFolder = gameRunRefsFolder(NO_RUN);
      // Saved builds of one kind are told apart by their place among the game's, oldest 1.
      const nthOf = (ofKind: ReadonlyArray<{ readonly committedAt: number }>) => {
        const order = ofKind.toSorted((a, b) => a.committedAt - b.committedAt);
        return (ref: { readonly committedAt: number }) => order.indexOf(ref) + 1;
      };
      // The folder as it was before each restore, which going back to undoes it.
      const befores = refs.filter(
        (ref) => ref.checkpointRef.startsWith(noRunFolder) && ref.checkpointRef.endsWith("-before"),
      );
      const beforeNth = nthOf(befores);
      const beforeRestores = befores.flatMap((ref): ReadonlyArray<Entry> => {
        if (!isGameBuildId(ref.oid)) return [];
        return [
          {
            id: ref.oid,
            at: isoOfSeconds(ref.committedAt),
            source: { _tag: "saved", label: RESTORE_BEFORE_LABEL, nth: beforeNth(ref) },
            summary: "What the game folder held when a restore replaced it",
            files: [],
            fileCount: null,
            base: null,
          },
        ];
      });
      const editsFolder = `${noRunFolder}${EDITS}`;
      const tunings = refs.filter(
        (ref) => ref.checkpointRef.startsWith(editsFolder) && ref.checkpointRef.endsWith("-values"),
      );
      const tuningNth = nthOf(tunings);
      const edits = yield* Effect.forEach(tunings, (ref) =>
        Effect.gen(function* () {
          if (!isGameBuildId(ref.oid)) return [];
          const base = byRef.get(ref.checkpointRef.replace(/-values$/, "-from")) ?? null;
          const change = yield* changeOf(g.root, g.lane, base, ref.oid);
          return [
            {
              id: ref.oid,
              at: isoOfSeconds(ref.committedAt),
              source: {
                _tag: "saved",
                label: VALUES_LABEL,
                edit: "values",
                nth: tuningNth(ref),
              },
              summary: "Values tuned on the Stage",
              files: change.files,
              fileCount: change.count,
              base,
            } satisfies Entry,
          ];
        }),
      ).pipe(Effect.map((each) => each.flat()));
      const libraryAdds = refs.filter(
        (ref) =>
          ref.checkpointRef.startsWith(editsFolder) && ref.checkpointRef.endsWith(LIBRARY_SUFFIX),
      );
      const libraryNth = nthOf(libraryAdds);
      const added = yield* Effect.forEach(libraryAdds, (ref) =>
        Effect.gen(function* () {
          if (!isGameBuildId(ref.oid)) return [];
          const base =
            byRef.get(ref.checkpointRef.slice(0, -LIBRARY_SUFFIX.length) + "-from") ?? null;
          const change = yield* changeOf(g.root, g.lane, base, ref.oid);
          return [
            {
              id: ref.oid,
              at: isoOfSeconds(ref.committedAt),
              source: {
                _tag: "saved",
                label: LIBRARY_LABEL,
                edit: "library",
                nth: libraryNth(ref),
              },
              summary: "Added from the Library",
              files: change.files,
              fileCount: change.count,
              base,
            } satisfies Entry,
          ];
        }),
      ).pipe(Effect.map((each) => each.flat()));
      // A copy brought in or a build undone: its label is its commit's subject.
      const landings = refs.filter(
        (ref) =>
          ref.checkpointRef.startsWith(editsFolder) &&
          (ref.checkpointRef.endsWith(LANDED_SUFFIX) || ref.checkpointRef.endsWith(UNDO_SUFFIX)),
      );
      const landed = yield* Effect.forEach(landings, (ref) =>
        Effect.gen(function* () {
          if (!isGameBuildId(ref.oid)) return [];
          const undo = ref.checkpointRef.endsWith(UNDO_SUFFIX);
          const prefix = ref.checkpointRef.slice(0, -(undo ? UNDO_SUFFIX : LANDED_SUFFIX).length);
          const base = byRef.get(`${prefix}-from`) ?? null;
          const change = yield* changeOf(g.root, g.lane, base, ref.oid);
          const entry: Entry = {
            id: ref.oid,
            at: isoOfSeconds(ref.committedAt),
            source: { _tag: "saved", label: ref.subject ?? "", edit: undo ? "undo" : "bring-in" },
            summary: ref.subject ?? "",
            files: change.files,
            fileCount: change.count,
            base,
          };
          return [entry];
        }),
      ).pipe(Effect.map((each) => each.flat()));
      const saved = [...beforeRestores, ...edits, ...added, ...landed];
      const setups = refs.flatMap((ref) => {
        const from = byRef.get(`${ref.checkpointRef}-from`);
        return ref.checkpointRef.startsWith(BOTS) && from !== undefined && isGameBuildId(ref.oid)
          ? [{ id: ref.oid, at: isoOfSeconds(ref.committedAt), from }]
          : [];
      });
      const moves: CopyMoves = new Map();
      for (const ref of refs) {
        const move = COPY_MOVE.exec(ref.checkpointRef.slice(noRunFolder.length));
        if (move === null) continue;
        moves.set(move[1]!, { ...moves.get(move[1]!), [move[2]!]: ref.committedAt });
      }
      const recorded = new Map(
        refs.flatMap((ref) =>
          ref.checkpointRef.startsWith(BASES)
            ? [[ref.checkpointRef.slice(BASES.length), ref.oid] as const]
            : [],
        ),
      );
      const fixes: ReadonlySet<string> = new Set(
        refs.flatMap((ref) =>
          ref.checkpointRef.startsWith(FIXES) ? [ref.checkpointRef.slice(FIXES.length)] : [],
        ),
      );
      const turnPage = (rows: number, from: string | undefined) =>
        turnEntries(g, byRef, rows, from, saved, recorded, setups, moves).pipe(
          Effect.map((page): TurnPage => ({
            newest: page.entries[0] ?? null,
            oldest: page.oldest,
            more: page.scanned === rows,
          })),
        );
      const turns = yield* turnEntries(g, byRef, limit * 3, before, saved, recorded, setups, moves);
      const savedPage = [...saved, ...(yield* versionEntries(g, byRef))].filter(
        (entry) => before === undefined || entry.at < before,
      );
      // A saved build is also a turn's at times; one entry each, the saved one first.
      const seen = new Set<string>();
      const merged = [...savedPage, ...turns.entries]
        .toSorted((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
        .filter((entry) => (seen.has(entry.id) ? false : (seen.add(entry.id), true)));
      // Turns past the page's last scanned turn may be newer than saved builds below it.
      const floor = turns.scanned === limit * 3 ? turns.oldest : null;
      const listed = floor === null ? merged : merged.filter((entry) => entry.at >= floor);
      return {
        entries: listed,
        kept,
        more: floor !== null || listed.length > limit,
        // How many numbered builds the game has from before `at`: every older
        // turn read, so a page's numbers never depend on what else was loaded.
        numberedBefore: (at: string) => {
          const key = `${g.root}\0${at}\0${refs.length}`;
          const known = numberedCounts.get(key);
          if (known !== undefined) return Effect.succeed(known);
          return turnEntries(g, byRef, ALL_TURNS, at, saved, recorded, setups, moves).pipe(
            Effect.map(({ entries }) => {
              const ids = new Set(
                [...entries, ...saved.filter((entry) => entry.at < at)]
                  .filter((entry) => isNumbered(entry) && !fixes.has(entry.id))
                  .map((entry) => entry.id),
              );
              if (numberedCounts.size > 200) numberedCounts.clear();
              numberedCounts.set(key, ids.size);
              return ids.size;
            }),
          );
        },
        refs: byRef,
        recorded,
        fixes,
        saved,
        setups,
        // The first page as read above, then older pages of TURN_PAGE rows.
        turns: (from: string | undefined) =>
          from === undefined
            ? Effect.succeed<TurnPage>({
                newest: turns.entries[0] ?? null,
                oldest: turns.oldest,
                more: turns.scanned === limit * 3,
              })
            : turnPage(TURN_PAGE, from),
      };
    });

  /** The folder's current build (currentBuild) over the game's turns, its newest kept edit and restore. */
  const currentOf = (g: Game, listed: Effect.Success<ReturnType<typeof allEntries>>) =>
    Effect.gen(function* () {
      const restore = yield* noRunRestoreOf(g.root);
      const edits = listed.saved.filter(
        (entry) => entry.source._tag === "saved" && entry.source.edit !== undefined,
      );
      const others = [
        ...edits.map((entry) => ({ id: entry.id, at: entry.at })),
        ...(restore?.outcome?.restored === true
          ? [{ id: restore.target, at: restore.requestedAt }]
          : []),
        ...listed.setups,
      ];
      const id = yield* currentBuild(others, listed.turns);
      return id !== null && isGameBuildId(id) ? id : null;
    });

  /** Each numbered build's number among `entries`, a contiguous stretch of the game's builds. */
  const numbersOf = (
    listed: Effect.Success<ReturnType<typeof allEntries>>,
    entries: ReadonlyArray<Entry>,
  ) =>
    Effect.gen(function* () {
      const numbered = entries
        .filter(isNumbered)
        .toSorted((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      const oldest = numbered[0];
      if (oldest === undefined) return new Map<string, BuildNumber>();
      let n = yield* listed.numberedBefore(oldest.at);
      let fix = 0;
      // A fix keeps the number of the build before it and counts as that build's next fix.
      return new Map(
        numbered.map((entry): readonly [string, BuildNumber] => {
          if (listed.fixes.has(entry.id) && n > 0)
            return [entry.id, { number: n, fix: (fix += 1) }];
          fix = 0;
          return [entry.id, { number: (n += 1), fix: null }];
        }),
      );
    });

  /** The content key of each build: its engine folder's tree. */
  const resolveOf = (g: Game, ids: ReadonlyArray<GameBuildId>) =>
    Effect.gen(function* () {
      const trees = yield* checkpoints
        .resolveTrees({ cwd: g.root, revisions: ids, path: g.lane })
        .pipe(Effect.orElseSucceed(() => ids.map(() => null)));
      return new Map(
        ids.flatMap((id, i) => {
          const tree = trees[i];
          return tree === null || tree === undefined
            ? []
            : [
                [
                  id,
                  {
                    root: g.root,
                    build: id,
                    key: `${g.engine}:${tree}`,
                    engine: g.engine,
                  } satisfies GameFacts.ResolvedBuild,
                ] as const,
              ];
        }),
      );
    });

  /**
   * A frame of the build playing, for its card: the earliest grid frame of the
   * random-input run, before any later one or the run's last screen, which is
   * often its ending. Only a file still there.
   */
  const stillOf = (root: string, read: GameBuildFacts | undefined) =>
    Effect.promise(async () => {
      if (read === undefined) return null;
      // The earliest frame of play first: a bot's later frames are usually its loss, and every
      // build's game-over screen looks alike, so builds could not be told apart by picture.
      for (const name of ["frame-001.png", "frame-002.png", END_FRAME]) {
        const fact = read.masher;
        if (fact.status !== "measured" || fact.value.evidence === null) return null;
        const path = `${fact.value.evidence}/frames/${name}`;
        const there = await NodeFSP.access(NodePath.join(root, path)).then(
          () => true,
          () => false,
        );
        if (there) return path;
      }
      return null;
    });

  const rowsOf = (
    g: Game,
    entries: ReadonlyArray<Entry>,
    kept: ReadonlySet<string>,
    numbers: ReadonlyMap<string, BuildNumber>,
  ) =>
    Effect.gen(function* () {
      const resolved = yield* resolveOf(
        g,
        entries.map((entry) => entry.id),
      );
      const measured = yield* facts.readMany([...resolved.values()]);
      const stills = yield* Effect.forEach(
        entries,
        (entry) => stillOf(g.root, measured.get(entry.id)),
        { concurrency: 8 },
      );
      const builds = entries.map((entry, index): GameBuild => {
        const available = kept.has(entry.id) && resolved.has(entry.id);
        const read = measured.get(entry.id);
        return {
          id: entry.id,
          at: entry.at,
          source: entry.source,
          number: numbers.get(entry.id)?.number ?? null,
          ...(numbers.get(entry.id)?.fix == null ? {} : { fix: numbers.get(entry.id)!.fix! }),
          // Only a build still kept can be restored to undo this one.
          base:
            entry.base !== null && isGameBuildId(entry.base) && kept.has(entry.base)
              ? entry.base
              : null,
          summary: entry.summary,
          files: entry.files,
          fileCount: entry.fileCount,
          available,
          noPlay: !available ? "This build is no longer kept." : noPlayReason(g.engine),
          noRestore: !available ? "This build is no longer kept." : null,
          facts:
            read === undefined
              ? { state: "never", chips: [], notMeasured: 0, good: 0, bad: 0 }
              : summaryOf(read),
          still: stills[index] ?? null,
        };
      });
      return { builds, measured };
    });

  // The folder captured (T3's capture, its kept index makes it cheap) and its
  // restored paths compared with each build; a diff that cannot be read is a change.
  const folderAgainst = (g: Game, builds: ReadonlyArray<string>) =>
    checkpoints
      .withWorkspaceLock(
        g.root,
        checkpoints.captureCheckpoint({ cwd: g.root, checkpointRef: FOLDER_REF }),
      )
      .pipe(
        Effect.flatMap((folder) =>
          Effect.forEach(builds, (build) =>
            measureChange(checkpoints, g.root, isRestored(g.lane), build, folder).pipe(
              Effect.map((change) => change.changed),
            ),
          ),
        ),
      );
  const folderEditedSince = (g: Game, current: string) =>
    folderAgainst(g, [current]).pipe(
      Effect.map(([changed]) => changed ?? true),
      Effect.orElseSucceed(() => "unknown" as const),
    );

  const recordTurn: GameBuilds["Service"]["recordTurn"] = (threadId, checkpointRef) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId);
      const { entries, refs, recorded } = yield* allEntries(g, 50, undefined);
      const id = refs.get(checkpointRef);
      if (id === undefined) return;
      const entry = entries.find((each) => each.id === id && each.source._tag === "turn");
      if (entry === undefined || entry.base === null) return;
      if (recorded.has(id)) return;
      yield* checkpoints.updateCheckpointRef({
        cwd: g.root,
        checkpointRef: CheckpointRef.make(`${BASES}${id}`),
        oid: entry.base,
      });
      const number = (yield* numbersOf(yield* allEntries(g, 50, undefined), entries)).get(
        id,
      )?.number;
      yield* mirrorHistory(
        g,
        id,
        `${number === undefined ? "Build" : `Build ${number}`}: ${entry.summary}${entry.source._tag === "turn" ? `\n\nChat: ${entry.source.threadTitle}` : ""}`,
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("A turn build's base could not be recorded.", { threadId, cause }),
      ),
    );

  const pendingTurnOf = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const runId = (yield* projections.getThreadShell(threadId))?.latestRunId ?? null;
      if (runId === null) return null;
      const { runs } = yield* projections.getThreadRecords(threadId, ["runs"], { runIds: [runId] });
      const run = runs.find((each) => each.id === runId);
      return run !== undefined && turnPending(run) ? run.id : null;
    }).pipe(Effect.orElseSucceed(() => null));

  /** When a ref under the game's builds was last written (unix seconds), or null. */
  const refTime = (root: string, ref: string) =>
    checkpoints.listCheckpointRefs({ cwd: root, prefix: ref }).pipe(
      Effect.map((refs) => refs.find((each) => each.checkpointRef === ref)?.committedAt ?? null),
      Effect.orElseSucceed(() => null),
    );

  /**
   * A chat in a copy: the game's builds up to the copy's seat, then the copy's own turns since it
   * was made or last brought in, numbered on from the seat. One numbering, never the game's later
   * builds, its kept edits or another chat's versions. Null for a copy with no seat kept.
   */
  const copyRail = (threadId: ThreadId, g: Game, limit: number, before: string | undefined) =>
    Effect.gen(function* () {
      const seatedAt = yield* refTime(g.home, worktreeSeedRef(threadId));
      if (seatedAt === null) return null;
      const home: Game = { ...g, root: g.home };
      // The seat's own build commits within the second its ref says.
      const upTo = isoOfSeconds(seatedAt + 1);
      const game = yield* allEntries(home, limit, before ?? upTo);
      const gamePage = game.entries.filter((entry) => entry.at < upTo).slice(0, limit);
      const gameRows = yield* rowsOf(home, gamePage, game.kept, yield* numbersOf(game, gamePage));
      if (before !== undefined)
        return {
          rows: gameRows.builds.map((build) => ({ ...build, inCopy: false })),
          measured: gameRows.measured,
          next: game.more && gamePage.length > 0 ? gamePage.at(-1)!.at : null,
        };
      const copiesFolder = `${gameRunRefsFolder(NO_RUN)}copies/${threadRefKey(threadId)}`;
      const since = Math.max(
        (yield* refTime(g.home, `${copiesFolder}/in`)) ?? 0,
        (yield* refTime(g.home, `${copiesFolder}/brought`)) ?? 0,
      );
      const copy = yield* allEntries(g, 50, undefined);
      const own = copy.entries.filter(
        (entry) =>
          entry.source._tag === "turn" &&
          entry.source.threadId === threadId &&
          entry.at > isoOfSeconds(since),
      );
      const seatNumber = yield* game.numberedBefore(upTo);
      const oldestFirst = own.toSorted((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      const numbers = new Map(
        oldestFirst.map(
          (entry, index) => [entry.id, { number: seatNumber + index + 1, fix: null }] as const,
        ),
      );
      const copyRows = yield* rowsOf(g, own, copy.kept, numbers);
      return {
        rows: [
          ...copyRows.builds.map((build) => ({ ...build, inCopy: true })),
          ...gameRows.builds.map((build) => ({ ...build, inCopy: false })),
        ],
        measured: new Map([...gameRows.measured, ...copyRows.measured]),
        next: game.more && gamePage.length > 0 ? gamePage.at(-1)!.at : null,
      };
    });

  const list: GameBuilds["Service"]["list"] = (threadId, input) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId, input.home === true);
      const limit = Math.min(50, Math.max(1, input.limit ?? 30));
      // Read before the turns: a checkpoint committing between the two reads then leaves the turn
      // pending or listed, never neither, which would show the build before it for a moment.
      const pending = input.before === undefined ? yield* pendingTurnOf(threadId) : null;
      const listed = yield* allEntries(g, limit, input.before);
      const { entries, kept, more } = listed;
      const page = entries.slice(0, limit);
      const rail = g.root === g.home ? null : yield* copyRail(threadId, g, limit, input.before);
      const { builds, measured } =
        rail === null
          ? yield* rowsOf(g, page, kept, yield* numbersOf(listed, page))
          : { builds: rail.rows, measured: rail.measured };
      // The generation cards read the newest build whose asset use was measured.
      const latestUse =
        input.before === undefined
          ? builds.flatMap((build) => {
              const use = measured.get(build.id)?.use;
              return use?.status === "measured"
                ? [{ build: build.id, generations: use.value.generations ?? [] }]
                : [];
            })[0]
          : undefined;
      const restore = yield* restoreRefOf(g, entries);
      const current = input.before === undefined ? yield* currentOf(g, listed) : null;
      const pendingTurn = listed.entries.some(
        (entry) => entry.source._tag === "turn" && entry.source.runId === pending,
      )
        ? null
        : pending;
      return {
        builds,
        next: rail !== null ? rail.next : more && page.length > 0 ? page.at(-1)!.at : null,
        current: shownAs(listed, current),
        folderEdited: current !== null ? yield* folderEditedSince(g, current) : "unknown",
        restore,
        ...(latestUse === undefined ? {} : { latestUse }),
        ...(pendingTurn === null ? {} : { pendingTurn }),
      } satisfies GameBuildsResult;
    });

  /** The build the rail shows for the folder's: a bot setup's point shows as the build it was written on. */
  const shownAs = (
    listed: { readonly setups: ReadonlyArray<Placed & { readonly from: string }> },
    id: GameBuildId | null,
  ) => {
    const from = listed.setups.find((setup) => setup.id === id)?.from;
    return from !== undefined && isGameBuildId(from) ? from : id;
  };

  const restoreRefOf = (g: Game, entries: ReadonlyArray<Entry>) =>
    Effect.gen(function* () {
      const newerThan = (at: string) =>
        entries.some((entry) => entry.source._tag === "turn" && entry.at > at);
      const r = yield* noRunRestoreOf(g.root);
      if (r === null) return null;
      return {
        requestId: r.requestId,
        target: r.target,
        label: r.label,
        requestedAt: r.requestedAt,
        undo: r.outcome?.restored === true && !newerThan(r.requestedAt) ? r.before : null,
        outcome: r.outcome,
      };
    });

  /** A build the caller named, checked to be one of this game's: its entry and content key. */
  const resolve = (g: Game, ref: GameBuildRef) =>
    Effect.gen(function* () {
      const refs = yield* buildRefs(g.root);
      let id: string | null = null;
      if (ref._tag === "build") id = ref.build;
      else {
        const records = yield* projections
          .getThreadRecords(ref.threadId, ["checkpoints"])
          .pipe(Effect.orElseSucceed(() => null));
        const checkpoint = records?.checkpoints.find(
          (each) => each.runId === ref.runId && each.status === "ready",
        );
        id =
          checkpoint === undefined
            ? null
            : (refs.find((each) => each.checkpointRef === checkpoint.ref)?.oid ?? null);
        if (id === null)
          return yield* failed(
            "Build",
            g.root,
            "invalid-input",
            "That turn captured no build of this game.",
          );
      }
      if (id === null || !isGameBuildId(id) || !refs.some((each) => each.oid === id))
        return yield* failed(
          "Build",
          g.root,
          "invalid-input",
          "That is not one of this game's builds, or it is no longer kept.",
        );
      const resolved = (yield* resolveOf(g, [id])).get(id);
      if (resolved === undefined)
        return yield* failed(
          "Build",
          g.root,
          "invalid-input",
          `Build ${id.slice(0, 8)} holds no ${g.lane}/ project.`,
        );
      return resolved;
    });

  /** The list row of one build: found among the given builds, else a bare row. */
  const rowOf = (g: Game, id: GameBuildId, listed: Effect.Success<ReturnType<typeof allEntries>>) =>
    Effect.gen(function* () {
      const entry =
        listed.entries.find((each) => each.id === id) ??
        ({
          id,
          at: EPOCH,
          source: { _tag: "saved", label: `Build ${id.slice(0, 8)}` },
          summary: `Build ${id.slice(0, 8)}`,
          files: [],
          fileCount: null,
          base: null,
        } satisfies Entry);
      const kept = new Set([...listed.kept, id]);
      const [row] = (yield* rowsOf(g, [entry], kept, yield* numbersOf(listed, [entry]))).builds;
      return row!;
    });

  const changes: GameBuilds["Service"]["changes"] = (threadId, id) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId);
      const row = yield* rowOf(g, id, yield* allEntries(g, 50, undefined));
      if (row.base === null) return { files: row.files, count: row.fileCount, tunes: [] };
      const between = (format: "numstat" | "patch", filePaths?: ReadonlyArray<string>) =>
        checkpoints
          .diffCheckpoints({
            cwd: g.root,
            fromCheckpointRef: CheckpointRef.make(row.base!),
            toCheckpointRef: CheckpointRef.make(id),
            ignoreWhitespace: false,
            format,
            relative: true,
            ...(filePaths === undefined ? {} : { filePaths }),
          })
          .pipe(Effect.orElseSucceed(() => null));
      const numstat = yield* between("numstat");
      if (numstat === null) return { files: row.files, count: row.fileCount, tunes: [] };
      const files = parseTurnDiffFilesFromNumstat(numstat).filter((file) =>
        isRestored(g.lane)(file.path),
      );
      const tuneFile = isAvailableEngine(g.engine) ? engineProfile(g.engine).tuneFile : null;
      const tunePath = tuneFile === null ? null : `${g.lane}/${tuneFile}`;
      const patch =
        tunePath !== null && files.some((file) => file.path === tunePath)
          ? yield* between("patch", [tunePath])
          : null;
      return {
        files: files
          .toSorted((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
          .slice(0, 300)
          .map(({ path, additions, deletions }) => ({ path, additions, deletions })),
        count: files.length,
        tunes: patch === null ? [] : tuneChanges(patch).slice(0, 200),
      };
    });

  const factsOf: GameBuilds["Service"]["facts"] = (threadId, ref) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId);
      return yield* facts.read(yield* resolve(g, ref));
    });

  const measure: GameBuilds["Service"]["measure"] = (threadId, ref, options = {}) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId);
      const build = yield* resolve(g, ref);
      if (!measurable(g.engine))
        return { ...(yield* facts.read(build)), message: unavailableEngineMessage(g.engine) };
      return yield* facts.measure(build, options);
    });

  const measureIn: GameBuilds["Service"]["measureIn"] = (root, build, options = {}) =>
    Effect.gen(function* () {
      if (!isGameBuildId(build)) return;
      const manifest = yield* projects.read(root);
      const engine = manifest.engine.name;
      if (!measurable(engine)) return;
      const lane = manifestProject(manifest);
      const [tree] = yield* checkpoints.resolveTrees({ cwd: root, revisions: [build], path: lane });
      if (tree === null || tree === undefined) return;
      yield* facts.measure(
        { root, build, key: `${engine}:${tree}`, engine },
        {
          queue: "background",
          ...(options.supersede === true ? { supersede: true } : {}),
        },
      );
    }).pipe(Effect.ignore);

  const compare: GameBuilds["Service"]["compare"] = (threadId, a, b) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId);
      const ra = yield* resolve(g, a);
      const rb = yield* resolve(g, b);
      const listed = yield* allEntries(g, 50, undefined);
      const [rowA, rowB, factsA, factsB] = yield* Effect.all([
        rowOf(g, ra.build, listed),
        rowOf(g, rb.build, listed),
        facts.read(ra),
        facts.read(rb),
      ]);
      return {
        a: rowA,
        b: rowB,
        factsA,
        factsB,
        deltas: diffBuildFacts(factsA, factsB),
      } satisfies GameBuildComparison;
    });

  const play: GameBuilds["Service"]["play"] = (threadId, ref) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId);
      const build = yield* resolve(g, ref);
      // Playing a build measures it if it never was.
      if (measurable(g.engine)) yield* facts.measure(build, { queue: "background" });
      const noPlay = noPlayReason(g.engine);
      if (noPlay !== null) return { _tag: "window", message: noPlay } as const;
      // The copy's one engine step at a time: a measurement's bot run and this
      // export take turns, so neither fails "busy" nor imports into the other.
      const result = yield* Effect.scoped(
        Effect.flatMap(copies.lease(g.root, { oid: build.build, key: build.key }), (copy) =>
          copies
            .exclusive(copy, stage.playIn(copy, `game-builds:${threadId}`))
            .pipe(
              Effect.tap((played) =>
                played.url === null
                  ? Effect.void
                  : copies.playing(g.root, build.build, copy, played.url),
              ),
            ),
        ),
      );
      return result.url !== null
        ? ({ _tag: "web", url: result.url } as const)
        : ({ _tag: "window", message: result.message } as const);
    });

  const inCopy: GameBuilds["Service"]["inCopy"] = (threadId, id, work) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId);
      const build = yield* resolve(g, { _tag: "build", build: id });
      return yield* Effect.scoped(
        Effect.flatMap(copies.lease(g.root, { oid: build.build, key: build.key }), work),
      );
    });

  /**
   * A restore or a kept edit moved the folder outside any turn: each of the
   * game's chats lists its next turn's changes from where the folder now is,
   * as the rail does, so an undo never reads as the agent's work. T3's
   * next-turn base (CheckpointService), as the bot setup sets it.
   */
  const nextTurnsFrom = (
    g: Pick<Game, "root" | "projectId">,
    threadId: ThreadId | undefined,
    oid: string,
  ) =>
    Effect.gen(function* () {
      const recent = yield* projections.listProjectTurnCheckpoints(g.projectId, { limit: 50 });
      const chats = new Set([
        ...(threadId === undefined ? [] : [threadId]),
        ...recent.filter((row) => row.cwd === g.root).map((row) => row.threadId),
      ]);
      for (const chat of chats)
        yield* checkpoints.updateCheckpointRef({
          cwd: g.root,
          checkpointRef: yield* nextTurnBaseRefForThread(chat).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
          ),
          oid,
        });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("The next turn's base could not be set.", { root: g.root, cause }),
      ),
    );

  const restore: GameBuilds["Service"]["restore"] = (threadId, ref, commandId, options = {}) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId);
      const build = yield* resolve(g, ref);
      // What the folder held, read before it moves: what the person's restore turns down.
      // A retried request answers from its record and decides nothing again.
      const repeat =
        commandId !== undefined &&
        (yield* noRunRestoreOf(g.root))?.requestId === restoreRequestId(g.root, commandId);
      const held =
        options.person === true && !repeat
          ? yield* heldBefore(g).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("The builds a restore leaves could not be read.", { cause }).pipe(
                  Effect.as(null),
                ),
              ),
            )
          : null;
      const result = yield* restoreWithoutRun(threadId, g, build, commandId, options.expect);
      if (result.moved === "restored" && held !== null)
        yield* decideRestore(g, held, build.build).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("A restore could not be kept in the game's decisions.", { cause }),
          ),
        );
      if (result.moved !== "moved-on") yield* playRestored(threadId, g);
      // Undo, Redo or Go back moved the folder a Guided proposal read: the person goes first.
      if (result.moved === "restored")
        yield* Effect.flatMap(projectStep(projections, g.projectId), (located) =>
          located === null ? Effect.void : supersedeProposal(engine, located),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("A restore could not supersede keep going's proposal.", { cause }),
          ),
        );
      return result;
    });

  /** The game's newest builds, their numbers and the folder's build: what a restore leaves. */
  const heldBefore = (g: Game) =>
    Effect.gen(function* () {
      const listed = yield* allEntries(g, 50, undefined);
      return {
        entries: listed.entries,
        numbers: yield* numbersOf(listed, listed.entries),
        current: yield* currentOf(g, listed),
      };
    });

  /**
   * The person's Undo, Redo or Go back in the game's decisions. Restoring what an undo of theirs
   * left takes that undo back; bringing back a step keep going undid keeps it; any other restore
   * turns down the build the folder held, which their next message may say why.
   */
  const decideRestore = (
    g: Game,
    held: Effect.Success<ReturnType<typeof heldBefore>>,
    target: GameBuildId,
  ) =>
    Effect.gen(function* () {
      const nameOf = (id: string) => {
        const number = held.numbers.get(id)?.number;
        const entry = held.entries.find((each) => each.id === id);
        if (number !== undefined) return `Build ${number}`;
        if (entry?.source._tag === "saved")
          return `"${entry.source.label}${entry.source.nth === undefined ? "" : ` ${entry.source.nth}`}"`;
        if (entry?.source._tag === "version")
          return `version ${entry.source.n} of "${entry.source.request}"`;
        return `build ${id.slice(0, 7)}`;
      };
      const takenBack = yield* dropDecisions(
        g.home,
        (each) => (each.kind === "undone" || each.kind === "went-back") && each.build === target,
      );
      if (takenBack > 0) return;
      const brought = held.entries.find((each) => each.id === target);
      if (brought?.source._tag === "turn" && brought.source.step?.verdict === "undone") {
        const what = yield* whatBuildDid(g, brought);
        return yield* recordDecision(g.home, {
          kind: "redid",
          text: `Brought back ${nameOf(target)} after keep going undid it: ${what.text}`,
          build: target,
          key: what.key,
        });
      }
      const left =
        held.current === null ? undefined : held.entries.find((each) => each.id === held.current);
      if (left === undefined)
        return yield* recordDecision(g.home, {
          kind: "went-back",
          text: `Went back to ${nameOf(target)} from a folder edited outside any build`,
        });
      const what = yield* whatBuildDid(g, left);
      return yield* recordDecision(g.home, {
        kind: left.base === target ? "undone" : "went-back",
        text:
          left.base === target
            ? `Undid ${nameOf(left.id)}: ${what.text}`
            : `Went back to ${nameOf(target)} from ${nameOf(left.id)}: ${what.text}`,
        build: left.id,
        key: what.key,
        awaiting: true,
      });
    });

  /**
   * What a build did, in a line, and keep going's key for it: a turn's reply's first sentence
   * (its request's when it has none), a step's own key or the key of the request as a `Next:`
   * line; tuned values as the decisions kept them.
   */
  const whatBuildDid = (g: Game, entry: Entry) =>
    Effect.gen(function* () {
      if (entry.source._tag === "saved") {
        const kept = (yield* decisionsOfBuild(g.home, entry.id).pipe(
          Effect.orElseSucceed(() => []),
        )).find((each) => each.kind === "kept-values");
        return {
          text: kept === undefined ? entry.summary : kept.text.replace(/^[^:]*:\s*/, "tuned "),
          key: null,
        };
      }
      if (entry.source._tag === "version")
        return {
          text: entry.source.approach === "" ? entry.summary : entry.source.approach,
          key: nextKey(entry.source.request),
        };
      const source = entry.source;
      const { messages } = yield* projections
        .getThreadRecords(source.threadId, ["messages"], {
          messageRoles: ["user", "assistant"],
          messageRunIds: [RunId.make(source.runId)],
        })
        .pipe(Effect.orElseSucceed(() => ({ messages: [] })));
      const reply = replyHeadline(
        messages.findLast((each) => each.role === "assistant")?.text ?? "",
      );
      const request = messages.find((each) => each.role === "user")?.text ?? source.request;
      const step =
        source.step === null
          ? undefined
          : (yield* stepsOf(new Set([source.threadId]))).get(RunId.make(source.runId));
      return {
        text: reply !== "" ? reply : source.step?.move || entry.summary,
        key: step !== undefined && step.key !== "" ? step.key : nextKey(request),
      };
    });

  const holdsIn = (g: Game, build: GameBuildId, owner: string) =>
    operations.exclusive(
      g.root,
      "Keep going check",
      folderAgainst(g, [build]).pipe(
        Effect.map(([changed]) => changed === false),
        Effect.mapError((cause) =>
          failed("Builds", g.root, "io", "the folder could not be compared", cause),
        ),
      ),
      owner,
    );
  const holds: GameBuilds["Service"]["holds"] = (threadId, build) =>
    Effect.flatMap(gameOf(threadId), (g) => holdsIn(g, build, String(threadId)));

  const current: GameBuilds["Service"]["current"] = (threadId) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId);
      const build = yield* currentOf(g, yield* allEntries(g, 1, undefined));
      return {
        build,
        edited: build !== null && !(yield* holdsIn(g, build, String(threadId))),
      };
    });

  const turnBuild: GameBuilds["Service"]["turnBuild"] = (threadId, runId, fallback) =>
    Effect.gen(function* () {
      const root = yield* projects.resolve(threadId);
      const lane = manifestProject(yield* projects.read(root));
      const { checkpoints: captured } = yield* projections
        .getThreadRecords(threadId, ["checkpoints"])
        .pipe(
          Effect.mapError((cause) =>
            failed("Builds", root, "io", "the turn's checkpoint could not be read", cause),
          ),
        );
      const checkpoint = captured.find((each) => each.runId === runId && each.status === "ready");
      if (checkpoint === undefined) return null;
      const id = yield* checkpoints.listCheckpointRefs({ cwd: root, prefix: checkpoint.ref }).pipe(
        Effect.map((refs) => refs.find((each) => each.checkpointRef === checkpoint.ref)?.oid),
        Effect.mapError((cause) =>
          failed("Builds", root, "io", "the turn's build could not be read", cause),
        ),
      );
      if (id === undefined || !isGameBuildId(id)) return null;
      // Recorded as the turn lands (the reactor may not have yet): idempotent.
      yield* recordTurn(threadId, checkpoint.ref);
      const recorded = yield* checkpoints
        .listCheckpointRefs({ cwd: root, prefix: `${BASES}${id}` })
        .pipe(
          Effect.map(
            (refs) => refs.find((each) => each.checkpointRef === `${BASES}${id}`)?.oid ?? null,
          ),
          Effect.orElseSucceed(() => null),
        );
      const known = recorded !== null && isGameBuildId(recorded) ? recorded : null;
      const base = known ?? fallback;
      const counted = base === null ? null : (yield* changeOf(root, lane, base, id)).count;
      // A turn that changed no game files records no base; the fallback then
      // holds exactly what the turn started from, in the paths that count. A
      // recorded base with the fallback's game files is the fallback too: a
      // turn between them that changed only notes or a bot is no build, so the
      // look that planned the step read the older build.
      const sameAsFallback =
        known !== null &&
        fallback !== null &&
        known !== fallback &&
        (yield* changeOf(root, lane, fallback, known)).count === 0;
      const startBuild = sameAsFallback ? fallback : (known ?? (counted === 0 ? fallback : null));
      if (counted !== null) return { build: id, startBuild, files: counted };
      // No base to diff against: T3's own change list for the turn.
      const inGame = yield* gamePaths(root);
      const restored = isRestored(lane);
      return {
        build: id,
        startBuild,
        files: checkpoint.files.filter((file) => {
          const path = inGame(file.path);
          return path !== null && restored(path);
        }).length,
      };
    });

  // On the turn loop's engines whose Stage plays a Web export, a restore that
  // moved the folder plays what it brought back, as the restoring thread's own
  // operation, in the service's fiber so the caller has its answer at once. A
  // folder that already held the build is fresh, so nothing rebuilds. A live
  // Stage serves the folder itself: its watch shows the restore.
  const playRestored = (threadId: ThreadId, g: Game) =>
    isAvailableEngine(g.engine) &&
    engineProfile(g.engine).turnLoop &&
    engineProfile(g.engine).stage === "export"
      ? Effect.forkIn(
          stage
            .playCurrent(threadId)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("A restored build could not be played.", { root: g.root, cause }),
              ),
            ),
          scope,
        ).pipe(Effect.asVoid)
      : Effect.void;

  // A game with no run restores through the same moves as the run's restore:
  // the folder parked first as a build of its own, the build's engine project,
  // art, ASSETS.md and play bot brought back, and the result checked against the build.
  // The record is written before the folder moves; the moves are safe to run
  // again with the same request (the park is found, never retaken), so a
  // restart settles any restore it cut short (settleRestores).
  const moveWithoutRun = (
    root: string,
    lane: string,
    record: NoRunRestore,
    owner: string,
    folderBuild: GameBuildId | null,
    projectId: ProjectId | null,
  ) =>
    Effect.gen(function* () {
      const moved = yield* withBuildInFolder(
        { stage, checkpoints, lock: { operations, owner, waitUntil: null } },
        { root, runId: NO_RUN, lane },
        {
          sha: record.target,
          park: BuildName.restoreBefore(record.requestId),
          check: BuildName.restoreAfter(record.requestId),
          ...(record.expect === undefined ? {} : { expect: record.expect }),
        },
        (current) => Effect.succeed({ value: current, putBack: false }),
      ).pipe(
        // A failure is an answer; an interrupt is left to the settle after a restart. Only
        // what comes before the first move (the park, the comparisons) fails out of
        // withBuildInFolder, so the folder is as it was.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.succeed({
                kind: "refused",
                why: "broke",
                detail: Cause.pretty(cause).split("\n")[0]!.slice(0, 300),
                back: null,
                parked: "",
              } as const),
        ),
      );
      const beforeRef = checkpointRefForGameRun(NO_RUN, BuildName.restoreBefore(record.requestId));
      const parks = yield* checkpoints
        .listCheckpointRefs({ cwd: root, prefix: gameRunRefsFolder(NO_RUN) })
        .pipe(
          Effect.map((refs) =>
            refs
              .filter((each) => each.checkpointRef.endsWith("-before"))
              .toSorted((a, b) => a.committedAt - b.committedAt),
          ),
          Effect.orElseSucceed(() => []),
        );
      const parked = parks.findIndex((each) => each.checkpointRef === beforeRef);
      const before = parked === -1 ? null : parks[parked]!.oid;
      const what = `${lane}/, art/, ASSETS.md and play bot`;
      // A folder that was exactly a build already (an Undo, a Redo) needs no
      // park of its own: that build is what undoes this restore.
      const same =
        moved.kind === "done" &&
        before !== null &&
        folderBuild !== null &&
        !(yield* measureChange(checkpoints, root, isRestored(lane), before, folderBuild)).changed
          ? folderBuild
          : null;
      const kept =
        before === null
          ? ""
          : same !== null
            ? " What the folder held is already a build in the history."
            : ` What the folder held is kept as a build ("${RESTORE_BEFORE_LABEL} ${parked + 1}").`;
      const movedOn = moved.kind === "refused" && moved.why === "moved-on";
      const outcome =
        moved.kind === "current"
          ? {
              restored: false,
              message: `The folder already holds ${record.label}; nothing was restored.`,
              moved: "current" as const,
            }
          : moved.kind === "done"
            ? {
                restored: true,
                message: `${record.label}: its ${what} are back in the game folder.${kept} Restoring that build undoes this.`,
                moved: "restored" as const,
              }
            : movedOn
              ? { restored: false, message: MOVED_ON, moved: "moved-on" as const }
              : {
                  restored: false,
                  message: `${record.label} could not be restored (${moved.detail}). ${moved.back === null ? "The folder is back as it was." : `Putting the folder back failed too (${moved.back}).`}${kept}`,
                  moved: "refused" as const,
                };
      // Before the outcome is saved, so a restart that settles the restore sets it too. The
      // move's own check captured the folder as it left it.
      if (moved.kind === "done") {
        const afterRef = checkpointRefForGameRun(NO_RUN, BuildName.restoreAfter(record.requestId));
        const after = yield* checkpoints.listCheckpointRefs({ cwd: root, prefix: afterRef }).pipe(
          Effect.map((refs) => refs.find((each) => each.checkpointRef === afterRef)?.oid),
          Effect.orElseSucceed(() => undefined),
        );
        if (after !== undefined && projectId !== null)
          yield* nextTurnsFrom({ root, projectId }, record.thread, after);
      }
      // Nothing moved: the park is the folder as it still is, no build of its own.
      if (moved.kind === "current" || movedOn)
        yield* checkpoints
          .deleteCheckpointRefs({ cwd: root, checkpointRefs: [beforeRef] })
          .pipe(Effect.ignore);
      yield* saveNoRunRestore(root, {
        ...record,
        before:
          same ??
          (moved.kind !== "current" && !movedOn && before !== null && isGameBuildId(before)
            ? before
            : null),
        outcome,
      });
      // After the record names the build, so a death in between leaves at most a spare mark.
      if (same !== null)
        yield* checkpoints
          .deleteCheckpointRefs({ cwd: root, checkpointRefs: [beforeRef] })
          .pipe(Effect.ignore);
      yield* operations.changed(root, GAME_BUILDS_EVENT, outcome.message);
      return outcome;
    });

  const restoreRequestId = (root: string, commandId: string | undefined) =>
    commandId === undefined
      ? NodeCrypto.randomUUID()
      : NodeCrypto.createHash("sha256").update(`${root}\0${commandId}`).digest("hex").slice(0, 32);

  const restoreWithoutRun = (
    threadId: ThreadId,
    g: Game,
    build: GameFacts.ResolvedBuild,
    commandId: string | undefined,
    expect: GameBuildId | undefined,
    label?: string,
    /** What the folder holds as it moves, when the caller read it (a landing's merge did). */
    holding?: GameBuildId,
    /** Written once the record is: a restart then settles a move whose rail already names it. */
    afterRecord?: Effect.Effect<void, GameOperationError>,
  ) =>
    Effect.gen(function* () {
      const requestId = restoreRequestId(g.root, commandId);
      const earlier = yield* noRunRestoreOf(g.root);
      // A repeat answers as the first try did.
      if (earlier?.requestId === requestId && earlier.outcome !== null) {
        const moved = earlier.outcome.moved ?? (earlier.outcome.restored ? "restored" : "current");
        if (moved === "refused")
          return yield* failed("Restore build", g.root, "tool-failed", earlier.outcome.message);
        return {
          requestId,
          done: moved !== "moved-on",
          message: earlier.outcome.message,
          moved,
        };
      }
      const owner = String(threadId);
      // Checked first, under the game's lock, so a folder that moved on keeps
      // the game's restore record (and its Redo) as it was. The move checks
      // again against its park, which a repeat after a restart reads too.
      if (expect !== undefined && earlier?.requestId !== requestId) {
        const [atTarget, movedOn] = yield* operations.exclusive(
          g.root,
          "Restore check",
          folderAgainst(g, [build.build, expect]).pipe(
            Effect.mapError((cause) =>
              failed("Restore build", g.root, "io", "the folder could not be compared", cause),
            ),
          ),
          owner,
        );
        if (atTarget === false)
          return {
            requestId,
            done: true,
            message: `The folder already holds Build ${build.build.slice(0, 8)}; nothing was restored.`,
            moved: "current" as const,
          };
        if (movedOn !== false)
          return { requestId, done: false, message: MOVED_ON, moved: "moved-on" as const };
      }
      // The build the folder holds as it moves: a park equal to it is no mark of its own.
      const folderBuild =
        earlier?.requestId === requestId
          ? null
          : holding !== undefined
            ? holding
            : yield* currentOf(g, yield* allEntries(g, 1, undefined)).pipe(
                Effect.orElseSucceed(() => null),
              );
      const record: NoRunRestore =
        earlier?.requestId === requestId
          ? earlier
          : {
              requestId,
              target: build.build,
              label: label ?? `Build ${build.build.slice(0, 8)}`,
              requestedAt: DateTime.formatIso(yield* DateTime.now),
              before: null,
              ...(expect === undefined ? {} : { expect }),
              thread: threadId,
              outcome: null,
            };
      // In the service's own fiber: a caller that goes away (a closed client) stops waiting,
      // never the folder's move. The folder is this move's alone while it moves: another
      // chat's turn refuses it before anything is recorded, and a turn sent meanwhile waits.
      // A retried restore that already happened answered from its record above.
      const fiber = yield* Effect.forkIn(
        folders.withFolder(
          {
            root: g.root,
            projectId: g.projectId,
            asking: threadId,
            name: label ?? record.label,
            operation: "Restore build",
          },
          saveNoRunRestore(g.root, record).pipe(
            Effect.andThen(afterRecord ?? Effect.void),
            Effect.andThen(moveWithoutRun(g.root, g.lane, record, owner, folderBuild, g.projectId)),
          ),
        ),
        scope,
      );
      const outcome = yield* Fiber.join(fiber);
      if (outcome.moved === "refused")
        return yield* failed("Restore build", g.root, "tool-failed", outcome.message);
      return {
        requestId,
        done: outcome.moved !== "moved-on",
        message: outcome.message,
        moved: outcome.moved,
      };
    });

  /**
   * The game's builds as plain git history, for `git log` and editors: each build that lands in
   * the game folder is also a commit on the local branch `kurambit/history`, its parent the
   * branch's last commit and its tree the build's. The harness never reads it. It cannot diverge
   * from the rail: it is only appended to, from the builds themselves, one game at a time. A
   * person's own commits on their branch never reach it, and while they have it checked out it
   * is left alone, so their HEAD and working tree are never moved.
   */
  const mirrorHistory = (g: Pick<Game, "root" | "home">, build: string, message: string) =>
    Effect.gen(function* () {
      if (g.root !== g.home) return;
      const head = yield* Effect.promise(async () => {
        let dir = NodePath.resolve(g.root);
        for (;;) {
          const text = await NodeFSP.readFile(NodePath.join(dir, ".git", "HEAD"), "utf8").catch(
            () => null,
          );
          if (text !== null) return text.trim();
          const up = NodePath.dirname(dir);
          if (up === dir) return "";
          dir = up;
        }
      });
      if (head === `ref: ${HISTORY_BRANCH}`) return;
      const [last] = yield* checkpoints.listCheckpointRefs({ cwd: g.root, prefix: HISTORY_BRANCH });
      const parent = last?.checkpointRef === HISTORY_BRANCH ? last.oid : undefined;
      if (parent !== undefined) {
        const [was, now] = yield* checkpoints.resolveTrees({
          cwd: g.root,
          revisions: [parent, build],
          path: "",
        });
        if (was !== null && was === now) return;
      }
      const commit = yield* checkpoints.commitTree({
        cwd: g.root,
        tree: `${build}^{tree}`,
        ...(parent === undefined ? {} : { parent }),
        message,
      });
      yield* checkpoints.updateCheckpointRef({
        cwd: g.root,
        checkpointRef: HISTORY_BRANCH,
        oid: commit,
      });
    }).pipe(
      // One game's history is appended to in order.
      (work) => mirrorLock.withLock(g.root, work),
      Effect.catchCause((cause) =>
        Effect.logWarning("A build could not be written to the game's history branch.", {
          root: g.root,
          cause,
        }),
      ),
    );

  const editRef = (request: string, suffix: string) =>
    checkpointRefForGameRun(NO_RUN, `${EDITS}${request}${suffix}`);
  const oidAt = (root: string, ref: CheckpointRef) =>
    checkpoints.listCheckpointRefs({ cwd: root, prefix: ref }).pipe(
      Effect.map((refs) => refs.find((each) => each.checkpointRef === ref)?.oid ?? null),
      Effect.mapError((cause) =>
        failed("Builds", root, "io", "the game's builds could not be read", cause),
      ),
    );

  const land: GameBuilds["Service"]["land"] = (threadId, input) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId, true);
      const io = (detail: string) => (cause: unknown) =>
        failed("Land build", g.root, "io", detail, cause);
      const suffix = input.kind === "in" ? LANDED_SUFFIX : UNDO_SUFFIX;
      const known = yield* oidAt(g.root, editRef(input.request, suffix));
      const made =
        known ??
        (yield* checkpoints
          .commitTree({ cwd: g.root, tree: input.tree, parent: input.from, message: input.label })
          .pipe(Effect.mapError(io("the build could not be made"))));
      if (!isGameBuildId(made)) return yield* failed("Land build", g.root, "io", "not a build");
      // Listed once the landing's record is saved, before the folder moves: a restart settles
      // the move and the rail already names it; a death before the record leaves neither.
      const listRefs = Effect.forEach(
        [
          ["-from", input.from] as const,
          ...(input.undid === undefined ? [] : [["-undid", input.undid] as const]),
          [suffix, made] as const,
        ],
        ([suffixOf, oid]) =>
          checkpoints
            .updateCheckpointRef({
              cwd: g.root,
              checkpointRef: editRef(input.request, suffixOf),
              oid,
            })
            .pipe(Effect.mapError(io("the build could not be kept"))),
        { discard: true },
      );
      const resolved = (yield* resolveOf(g, [made])).get(made);
      if (resolved === undefined)
        return yield* failed("Land build", g.root, "io", `the build holds no ${g.lane}/ project`);
      const result = yield* restoreWithoutRun(
        threadId,
        g,
        resolved,
        `land\0${input.request}`,
        input.from,
        input.label,
        input.from,
        known === null ? listRefs : Effect.void,
      );
      if (result.moved === "moved-on") {
        yield* checkpoints
          .deleteCheckpointRefs({
            cwd: g.root,
            checkpointRefs: ["-from", "-undid", suffix].map((each) => editRef(input.request, each)),
          })
          .pipe(Effect.ignore);
        return { build: made, moved: result.moved };
      }
      yield* playRestored(threadId, g);
      yield* mirrorHistory(g, made, input.label);
      yield* operations.changed(g.root, GAME_BUILDS_EVENT, input.label);
      yield* measureIn(g.root, made, { supersede: true });
      return { build: made, moved: result.moved };
    });

  const undo: GameBuilds["Service"]["undo"] = (threadId, build, commandId) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId, true);
      const profile = engineProfile(yield* availableEngine(g.engine));
      const listed = yield* allEntries(g, 50, undefined);
      const entry =
        listed.entries.find((each) => each.id === build) ??
        (yield* allEntries(g, ALL_TURNS, undefined)).entries.find((each) => each.id === build);
      const numbers = yield* numbersOf(listed, listed.entries);
      const name = (id: string) => {
        const number = numbers.get(id)?.number;
        return number === undefined ? `build ${id.slice(0, 7)}` : `Build ${number}`;
      };
      if (entry === undefined || entry.base === null || !isGameBuildId(entry.base))
        return yield* failed(
          "Undo build",
          g.root,
          "invalid-input",
          `${name(build)} has no recorded build it was made from, so its change cannot be undone alone. Go back to a build instead.`,
        );
      const request =
        commandId === undefined
          ? NodeCrypto.randomUUID().replaceAll("-", "")
          : NodeCrypto.createHash("sha256")
              .update(`${g.root}\0undo\0${commandId}`)
              .digest("hex")
              .slice(0, 32);
      // The game as it is now: the merge's ours, and what the undo lands on.
      const now =
        (yield* oidAt(g.root, editRef(request, "-from"))) ??
        (yield* checkpoints
          .withWorkspaceLock(
            g.root,
            checkpoints.captureCheckpoint({
              cwd: g.root,
              checkpointRef: editRef(request, "-from"),
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              failed("Undo build", g.root, "io", "the game folder could not be read", cause),
            ),
          ));
      if (!isGameBuildId(now)) return yield* failed("Undo build", g.root, "io", "not a build");
      const merged = yield* mergeBuilds(checkpoints, {
        root: g.root,
        tuneFile: profile.tuneFile === null ? null : `${g.lane}/${profile.tuneFile}`,
        union: [],
        base: build,
        ours: now,
        theirs: entry.base,
        game: "ours",
        within: isRestored(g.lane),
      }).pipe(
        Effect.mapError((cause) =>
          failed("Undo build", g.root, "io", "the build's change could not be reversed", cause),
        ),
      );
      if (merged.conflicts.length > 0) {
        yield* checkpoints
          .deleteCheckpointRefs({ cwd: g.root, checkpointRefs: [editRef(request, "-from")] })
          .pipe(Effect.ignore);
        return {
          _tag: "conflicts",
          files: merged.conflicts,
          message: `Later builds changed the same lines as ${name(build)} (${merged.conflicts.map((each) => each.path).join(", ")}), so nothing was undone. Go back to the build before it, or ask the agent to take its change out.`,
        } as const;
      }
      // Undoing an undo is its Redo: it takes that undo's decision back.
      const undid =
        entry.source._tag === "saved" && entry.source.edit === "undo"
          ? (listed.refs.get(
              [...listed.refs.entries()]
                .find(([, oid]) => oid === build)?.[0]
                ?.replace(/-undo$/, "-undid") ?? "",
            ) ?? null)
          : null;
      const what = yield* whatBuildDid(g, entry);
      const label =
        undid !== null && isGameBuildId(undid)
          ? `Redid ${name(undid)}`
          : `Undid ${name(build)}: ${what.text}`.slice(0, 140);
      const landed = yield* land(threadId, {
        request,
        tree: merged.tree,
        from: now,
        kind: "undo",
        label,
        undid: build,
      });
      if (landed.moved === "moved-on") return yield* failed("Undo build", g.root, "busy", MOVED_ON);
      yield* (
        undid !== null
          ? dropDecisions(g.home, (each) => each.kind === "undone" && each.build === undid)
          : recordDecision(g.home, {
              kind: "undone",
              text: `Undid ${name(build)}: ${what.text}`,
              build,
              key: what.key,
              awaiting: true,
            })
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("An undo could not be kept in the game's decisions.", { cause }),
        ),
      );
      return {
        _tag: "undone",
        build: landed.build,
        message:
          landed.moved === "current"
            ? `The game already had ${name(build)}'s change undone.`
            : `${label}. Every later build stays; undoing this build brings it back.`,
      } as const;
    });

  // Held keeps: one file per request under server state, so a restart lands them all.
  const heldKeepsDir = (root: string) =>
    NodePath.join(
      config.stateDir,
      "game-held-keeps",
      NodeCrypto.createHash("sha256").update(root).digest("hex").slice(0, 16),
    );
  const HeldKeep = Schema.fromJsonString(
    Schema.Struct({ root: Schema.String, input: GameKeepValuesInputSchema }),
  );
  const encodeHeldKeep = Schema.encodeEffect(HeldKeep);
  const holdKeep = (root: string, request: string, input: GameKeepValuesInput) =>
    Effect.flatMap(Effect.orDie(encodeHeldKeep({ root, input })), (text) =>
      Effect.promise(async () => {
        const dir = heldKeepsDir(root);
        await NodeFSP.mkdir(dir, { recursive: true });
        const file = NodePath.join(dir, `${request}.json`);
        await NodeFSP.writeFile(`${file}.tmp`, text);
        await NodeFSP.rename(`${file}.tmp`, file);
      }),
    );
  /** The chat whose turn writes this folder now (null: none): a copy's own chat in a copy. */
  const turnIn = (g: Game, threadId: ThreadId) =>
    Effect.gen(function* () {
      if (g.root === g.home) {
        const holder = yield* folders.holder(g.root, g.projectId, null);
        return holder?.threadId === null || holder === null ? null : holder.title;
      }
      const shell = yield* projections
        .getThreadShell(threadId)
        .pipe(Effect.orElseSucceed(() => null));
      return shell !== null &&
        (shell.activeRunId !== null || (shell.activityRunStatus ?? null) !== null)
        ? shell.title
        : null;
    });
  const decodeHeldKeep = Schema.decodeUnknownOption(HeldKeep);
  const landHeldKeeps: GameBuilds["Service"]["landHeldKeeps"] = (root) =>
    Effect.gen(function* () {
      const dir = heldKeepsDir(root);
      const files = yield* Effect.promise(() => NodeFSP.readdir(dir).catch(() => [] as string[]));
      for (const name of files.filter((each) => each.endsWith(".json")).toSorted()) {
        const file = NodePath.join(dir, name);
        const text = yield* Effect.promise(() => NodeFSP.readFile(file, "utf8").catch(() => null));
        const held = text === null ? Option.none() : decodeHeldKeep(text);
        if (Option.isNone(held)) {
          yield* Effect.promise(() => NodeFSP.rm(file, { force: true }));
          continue;
        }
        const { threadId, ...input } = held.value.input;
        const kept = yield* keepValues(threadId, input).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Values kept during a turn could not land.", { root, cause }).pipe(
              Effect.as(null),
            ),
          ),
        );
        // Still held (a turn at work again) keeps its file; landed or refused for good, it goes.
        if (kept?.heldFor !== undefined) return;
        yield* Effect.promise(() => NodeFSP.rm(file, { force: true }));
      }
    });

  /** Each game's tuning session's base, and its tune file's text there (null: no file). */
  const tuningBases = new Map<string, { readonly base: string; readonly text: string | null }>();
  const keepValues: GameBuilds["Service"]["keepValues"] = (threadId, input) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId);
      const profile = engineProfile(yield* availableEngine(g.engine));
      if (profile.tuneFile === null)
        return yield* failed(
          "Keep values",
          g.root,
          "invalid-input",
          `Live values are not in ${profile.displayName} games yet.`,
        );
      const file = `${g.lane}/${profile.tuneFile}`;
      const request =
        input.commandId === undefined
          ? NodeCrypto.randomUUID()
          : NodeCrypto.createHash("sha256")
              .update(`${g.root}\0keep-values\0${input.commandId}`)
              .digest("hex")
              .slice(0, 32);
      const fromRef = checkpointRefForGameRun(NO_RUN, `${EDITS}${request}-from`);
      const keptRef = checkpointRefForGameRun(NO_RUN, `${EDITS}${request}-values`);
      const oidOf = (ref: CheckpointRef) =>
        checkpoints.listCheckpointRefs({ cwd: g.root, prefix: ref }).pipe(
          Effect.map((refs) => refs.find((each) => each.checkpointRef === ref)?.oid ?? null),
          Effect.mapError((cause) =>
            failed("Keep values", g.root, "io", "the game's builds could not be read", cause),
          ),
        );
      const capture = (ref: CheckpointRef) =>
        checkpoints
          .withWorkspaceLock(
            g.root,
            checkpoints.captureCheckpoint({ cwd: g.root, checkpointRef: ref }),
          )
          .pipe(
            Effect.mapError((cause) =>
              failed("Keep values", g.root, "io", "the game folder could not be kept", cause),
            ),
          );
      const answer = (build: string, base: string, summary: string) =>
        isGameBuildId(build) && isGameBuildId(base)
          ? Effect.succeed({
              build,
              base,
              message: `Saved as a build: ${summary}. Undo puts the game back as it was.`,
            })
          : failed("Keep values", g.root, "io", "the kept build is not one of this game's builds");
      // The tuning build the folder still holds, with the folder it was made from: the Stage's
      // next values fold into it, so a session of tuning stays one build and one Undo.
      const heldTuning = Effect.gen(function* () {
        const refs = yield* checkpoints
          .listCheckpointRefs({ cwd: g.root, prefix: `${gameRunRefsFolder(NO_RUN)}${EDITS}` })
          .pipe(
            Effect.mapError((cause) =>
              failed("Keep values", g.root, "io", "the game's builds could not be read", cause),
            ),
          );
        const newest = refs
          .filter((ref) => ref.checkpointRef.endsWith("-values"))
          .toSorted((a, b) => b.committedAt - a.committedAt)[0];
        if (newest === undefined || !isGameBuildId(newest.oid)) return null;
        const from = refs.find(
          (ref) => ref.checkpointRef === newest.checkpointRef.replace(/-values$/, "-from"),
        );
        if (from === undefined || !isGameBuildId(from.oid)) return null;
        const [changed] = yield* folderAgainst(g, [newest.oid]).pipe(
          Effect.mapError((cause) =>
            failed("Keep values", g.root, "io", "the folder could not be compared", cause),
          ),
        );
        return changed === false
          ? { base: from.oid, build: newest.oid, refs: [from.checkpointRef, newest.checkpointRef] }
          : null;
      });
      const said = (things: GameKeepValuesInput["things"]) =>
        things
          .map(
            (thing) =>
              `${thing.id} ${[
                ...thing.values.map((v) => `${v.key} ${String(v.value)}`),
                ...(thing.names ?? []).map((n) => `${n.key} ${n.name ?? "the game's own"}`),
              ].join(", ")}`,
          )
          .join("; ");
      // The folder as the session found it. Still the build it holds (nothing edited since), it
      // is that build by its own id, so Undo goes back to a build the Stage can name.
      const sessionBase = Effect.gen(function* () {
        const captured = yield* capture(fromRef);
        const listed = yield* allEntries(g, 1, undefined);
        const current = yield* currentOf(g, listed);
        if (current === null || (yield* folderEditedSince(g, current)) !== false) return captured;
        yield* checkpoints
          .updateCheckpointRef({ cwd: g.root, checkpointRef: fromRef, oid: current })
          .pipe(
            Effect.mapError((cause) =>
              failed("Keep values", g.root, "io", "the game folder could not be kept", cause),
            ),
          );
        return current;
      });
      // A repeat answers as the first try did.
      const [doneFrom, doneKept] = yield* Effect.all([oidOf(fromRef), oidOf(keptRef)]);
      if (doneFrom !== null && doneKept !== null)
        return yield* answer(doneKept, doneFrom, said(input.things));
      // A turn at work in this folder (any chat's, this one's too) would write over the values or
      // be captured half done: they are kept aside and land when its turn ends (landHeldKeeps).
      const writer = yield* turnIn(g, threadId);
      if (writer !== null) {
        // The same request lands it later, so a repeat of this keep is still one build.
        yield* holdKeep(g.root, request, {
          ...input,
          threadId,
          commandId: input.commandId ?? request,
        });
        const folder = yield* currentOf(g, yield* allEntries(g, 1, undefined));
        if (folder === null)
          return yield* failed("Keep values", g.root, "busy", `${writer} is working in the game.`);
        return {
          build: folder,
          base: folder,
          message: `Kept: the values save as a build when ${writer}'s turn ends.`,
          heldFor: writer,
        };
      }
      const owner = String(threadId);
      const path = NodePath.join(g.root, g.lane, profile.tuneFile);
      const kept = yield* operations.exclusive(
        g.root,
        "Keep values",
        Effect.gen(function* () {
          const text = yield* Effect.tryPromise({
            try: () =>
              NodeFSP.readFile(path, "utf8").catch((cause: NodeJS.ErrnoException) => {
                if (cause?.code === "ENOENT") return null;
                throw cause;
              }),
            catch: (cause) => failed("Keep values", path, "io", `${file} could not be read`, cause),
          });
          const parsed = text === null ? Option.some(null) : decodeJson(text);
          if (Option.isNone(parsed))
            return yield* failed(
              "Keep values",
              path,
              "invalid-input",
              `${file} is not JSON: fix or remove it, then keep again.`,
            );
          const existing = parsed.value;
          const merged = tuneFileWith(file, existing, input.things);
          if ("refusal" in merged)
            return yield* failed("Keep values", path, "invalid-input", merged.refusal);
          const held = input.fold === true && doneFrom === null ? yield* heldTuning : null;
          // A try cut short after its first capture keeps that one as the base; a fold keeps
          // the base of the build it replaces, so Undo still goes back to before the session.
          const base =
            doneFrom ??
            (held === null
              ? yield* sessionBase
              : yield* checkpoints
                  .updateCheckpointRef({ cwd: g.root, checkpointRef: fromRef, oid: held.base })
                  .pipe(
                    Effect.as(held.base),
                    Effect.mapError((cause) =>
                      failed(
                        "Keep values",
                        g.root,
                        "io",
                        "the game folder could not be kept",
                        cause,
                      ),
                    ),
                  ));
          // The session's base file as it was: values put back write it again byte for byte, so
          // the folder is the base again whatever formatting the file had. Kept in memory; after
          // a server restart a session put back stays one build, as before.
          if (held === null) tuningBases.set(g.root, { base, text });
          const before = tuningBases.get(g.root);
          const baseText = before !== undefined && before.base === base ? before.text : undefined;
          const putBack =
            baseText !== undefined &&
            sameTuneFile(merged.file, baseText === null ? Option.some({}) : decodeJson(baseText));
          // Each value against the session's start: the base file's, else the game's default.
          const baseFile =
            baseText === undefined
              ? existing
              : baseText === null
                ? null
                : Option.getOrNull(decodeJson(baseText));
          const changes = keptChanges(baseFile, input.things);
          const written =
            putBack && baseText === null
              ? null
              : putBack && baseText !== undefined
                ? baseText
                : tuneFileText(merged.file);
          // The running game already plays these values: its Stage must not reload for them.
          yield* preview.quietWrite(g.root, file, written);
          yield* Effect.tryPromise({
            try: async () => {
              if (written === null) return NodeFSP.rm(path, { force: true });
              const temporary = `${path}.${request}.tmp`;
              await NodeFSP.writeFile(temporary, written);
              await NodeFSP.rename(temporary, path);
            },
            catch: (cause) =>
              failed("Keep values", path, "io", `${file} could not be written`, cause),
          });
          const build = yield* capture(keptRef);
          const drop = (refs: ReadonlyArray<CheckpointRef>) =>
            checkpoints
              .deleteCheckpointRefs({ cwd: g.root, checkpointRefs: refs })
              .pipe(
                Effect.mapError((cause) =>
                  failed("Keep values", g.root, "io", "the game's builds could not be kept", cause),
                ),
              );
          // Written before the build it replaces is dropped: a stop between the two leaves two
          // tuning builds, never none.
          if (held !== null) yield* drop(held.refs.map((ref) => CheckpointRef.make(ref)));
          // Every value put back: the session leaves no build, and the folder is its base again.
          if ((yield* changeOf(g.root, g.lane, base, build)).count === 0) {
            yield* drop([fromRef, keptRef]);
            return {
              base,
              build: base,
              summary: merged.summary,
              unchanged: true,
              held: held?.build ?? null,
              changes,
            };
          }
          return {
            base,
            build,
            summary: merged.summary,
            unchanged: false,
            held: held?.build ?? null,
            changes,
          };
        }),
        owner,
      );
      if (kept.unchanged) {
        if (!isGameBuildId(kept.base))
          return yield* failed("Keep values", g.root, "io", "the game's build is not a build");
        yield* nextTurnsFrom(g, threadId, kept.base);
        // The session left no build, so it decided nothing.
        if (kept.held !== null)
          yield* dropDecisions(
            g.home,
            (each) => each.kind === "kept-values" && each.build === kept.held,
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Tuned values put back could not leave the decisions.", { cause }),
            ),
          );
        yield* operations.changed(g.root, GAME_BUILDS_EVENT, "Tuned values put back.");
        return {
          build: kept.base,
          base: kept.base,
          message: "Every value is back as it was, so no build was kept.",
        };
      }
      const result = yield* answer(kept.build, kept.base, kept.summary);
      yield* nextTurnsFrom(g, threadId, kept.build);
      yield* mirrorHistory(g, kept.build, `Tuned values: ${kept.summary}`);
      yield* decideKept(g, kept.build, kept.held, kept.changes).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Kept values could not be kept in the game's decisions.", { cause }),
        ),
      );
      yield* operations.changed(g.root, GAME_BUILDS_EVENT, result.message);
      // Measured like a turn's build, so its facts sit beside the build before it.
      yield* measureIn(g.root, kept.build, { supersede: true });
      return result;
    });

  /**
   * Values kept from the Stage in the game's decisions, as "player jump 9 → 12". A tuning
   * session folds into one build, so its line folds too: the build it replaces gives way, each
   * value keeping where the session started.
   */
  const decideKept = (
    g: Game,
    build: string,
    replaces: string | null,
    changes: ReadonlyArray<KeptChange>,
  ) =>
    Effect.gen(function* () {
      const before =
        replaces === null
          ? []
          : (yield* decisionsOfBuild(g.home, replaces)).filter(
              (each) => each.kind === "kept-values",
            );
      const started = new Map(before.flatMap((each) => keptSegments(each.text)));
      const told = new Map(started);
      for (const change of changes)
        told.set(change.label, {
          from: started.get(change.label)?.from ?? change.from,
          to: change.to,
        });
      const segments = [...told].flatMap(([label, { from, to }]) =>
        from === to ? [] : [`${label} ${from} → ${to}`],
      );
      if (segments.length === 0) return;
      const listed = yield* allEntries(g, 5, undefined);
      const number = (yield* numbersOf(listed, listed.entries)).get(build)?.number;
      yield* recordDecision(g.home, {
        kind: "kept-values",
        text: `Kept tuned values as ${number === undefined ? `build ${build.slice(0, 7)}` : `Build ${number}`}: ${segments.join("; ")}`,
        build,
        ...(replaces === null ? {} : { replaces }),
      });
    });

  /** Finishes every no-run restore a restart cut short, by running its moves again. */
  const settleRestores = Effect.gen(function* () {
    const rows = yield* sql<{ readonly root: string; readonly payload_json: string }>`
      SELECT root, payload_json FROM game_build_restores
    `.pipe(Effect.orElseSucceed(() => []));
    const unsettled = rows.flatMap((row) => {
      const decoded = decodeNoRunRestore(row.payload_json);
      return Option.isSome(decoded) && decoded.value.outcome === null
        ? [{ root: row.root, record: decoded.value }]
        : [];
    });
    if (unsettled.length === 0) return;
    const games = yield* projects.list().pipe(Effect.orElseSucceed(() => []));
    for (const row of unsettled)
      yield* projects.read(row.root).pipe(
        Effect.flatMap((manifest) =>
          moveWithoutRun(
            row.root,
            manifestProject(manifest),
            row.record,
            "game-builds:settle",
            null,
            games.find((game) => game.root === row.root)?.projectId ?? null,
          ),
        ),
        // A landing (a bring-in, an undo) the restart cut short is a build: into the history too.
        Effect.tap((outcome) =>
          outcome.moved !== "restored"
            ? Effect.void
            : Effect.flatMap(
                checkpoints.listCheckpointRefs({
                  cwd: row.root,
                  prefix: `${gameRunRefsFolder(NO_RUN)}${EDITS}`,
                }),
                (refs) => {
                  const landed = refs.find(
                    (ref) =>
                      ref.oid === row.record.target &&
                      (ref.checkpointRef.endsWith(LANDED_SUFFIX) ||
                        ref.checkpointRef.endsWith(UNDO_SUFFIX)),
                  );
                  return landed === undefined
                    ? Effect.void
                    : mirrorHistory(
                        { root: row.root, home: row.root },
                        landed.oid,
                        landed.subject ?? row.record.label,
                      );
                },
              ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("A cut-short restore could not be settled.", { root: row.root, cause }),
        ),
      );
  });

  // A chat turn's work is registered after its checkpoint commits, so a
  // restart can cut it off. Owed from data: the newest turn build of each
  // turn-loop game gets its base recorded and, with no facts yet, its
  // background measure. Its play is not replayed: the Stage offers Rebuild.
  const reconcileTurns = Effect.gen(function* () {
    const games = yield* projects.list().pipe(Effect.orElseSucceed(() => []));
    for (const summary of games)
      yield* Effect.gen(function* () {
        const manifest = yield* projects.read(summary.root);
        const engine = manifest.engine.name;
        if (!isAvailableEngine(engine) || !engineProfile(engine).turnLoop) return;
        const rows = yield* projections.listProjectTurnCheckpoints(summary.projectId, { limit: 5 });
        const newest = rows.find(
          (row) => row.cwd === summary.root && row.checkpoint.files.length > 0,
        );
        if (newest === undefined) return;
        yield* recordTurn(newest.threadId, newest.checkpoint.ref);
        const ref = (yield* checkpoints.listCheckpointRefs({
          cwd: summary.root,
          prefix: newest.checkpoint.ref,
        })).find((each) => each.checkpointRef === newest.checkpoint.ref);
        if (ref === undefined || !isGameBuildId(ref.oid)) return;
        const lane = manifestProject(manifest);
        const [tree] = yield* checkpoints.resolveTrees({
          cwd: summary.root,
          revisions: [ref.oid],
          path: lane,
        });
        if (tree === null || tree === undefined) return;
        const build = { root: summary.root, build: ref.oid, key: `${engine}:${tree}`, engine };
        if ((yield* facts.read(build)).state === "never")
          yield* facts.measure(build, { queue: "background", supersede: true });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("A game's owed turn work could not be reconciled.", {
            root: summary.root,
            cause,
          }),
        ),
      );
  });

  // Measures owed from data, after a restart or between startup and the
  // reactor's subscription: every row that still owes a tier. Builds of an
  // engine this version does not have are not measured.
  const reconcile: GameBuilds["Service"]["reconcile"] = Effect.gen(function* () {
    yield* settleRestores;
    for (const build of yield* facts.owed)
      if (measurable(build.engine)) yield* facts.measure(build, { queue: "background" });
    yield* reconcileTurns;
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("Build reconcile failed.", { cause })));

  const stopPlay: GameBuilds["Service"]["stopPlay"] = (threadId, ref) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId);
      const id = ref._tag === "build" ? ref.build : (yield* resolve(g, ref)).build;
      yield* copies.stopPlay(g.root, id);
    });

  const keepEdit: GameBuilds["Service"]["keepEdit"] = (threadId, input) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId);
      const request =
        input.commandId === undefined
          ? NodeCrypto.randomUUID()
          : NodeCrypto.createHash("sha256")
              .update(`${g.root}\0keep-edit\0${input.commandId}`)
              .digest("hex")
              .slice(0, 32);
      const fromRef = checkpointRefForGameRun(NO_RUN, `${EDITS}${request}-from`);
      const keptRef = checkpointRefForGameRun(NO_RUN, `${EDITS}${request}-${input.edit}`);
      const io = (detail: string) => (cause: unknown) =>
        failed(input.operation, g.root, "io", detail, cause);
      const oidOf = (ref: CheckpointRef) =>
        checkpoints.listCheckpointRefs({ cwd: g.root, prefix: ref }).pipe(
          Effect.map((refs) => refs.find((each) => each.checkpointRef === ref)?.oid ?? null),
          Effect.mapError(io("the game's builds could not be read")),
        );
      const capture = (ref: CheckpointRef) =>
        checkpoints
          .withWorkspaceLock(
            g.root,
            checkpoints.captureCheckpoint({ cwd: g.root, checkpointRef: ref }),
          )
          .pipe(Effect.mapError(io("the game folder could not be kept")));
      const [doneFrom, doneKept] = yield* Effect.all([oidOf(fromRef), oidOf(keptRef)]);
      if (doneFrom !== null && doneKept !== null) return { build: doneKept, base: doneFrom };
      const kept = yield* operations.exclusive(
        g.root,
        input.operation,
        Effect.gen(function* () {
          // The folder as it stood: still the build it holds, that build by its own id, so Undo
          // goes back to a build the Stage can name.
          const base =
            doneFrom ??
            (yield* Effect.gen(function* () {
              const captured = yield* capture(fromRef);
              const listed = yield* allEntries(g, 1, undefined);
              const current = yield* currentOf(g, listed);
              if (current === null || (yield* folderEditedSince(g, current)) !== false)
                return captured;
              yield* checkpoints
                .updateCheckpointRef({ cwd: g.root, checkpointRef: fromRef, oid: current })
                .pipe(Effect.mapError(io("the game folder could not be kept")));
              return current;
            }));
          yield* input.write(g.root);
          return { base, build: yield* capture(keptRef) };
        }),
        String(threadId),
      );
      if (isGameBuildId(kept.build)) {
        yield* nextTurnsFrom(g, threadId, kept.build);
        yield* mirrorHistory(g, kept.build, input.operation);
        yield* operations.changed(
          g.root,
          GAME_BUILDS_EVENT,
          `${input.operation}: kept as a build.`,
        );
        yield* measureIn(g.root, kept.build, { supersede: true });
      }
      return kept;
    });

  return GameBuilds.of({
    stopPlay,
    reconcile,
    list,
    compare,
    facts: factsOf,
    changes,
    measure,
    measureIn,
    recordTurn,
    play,
    inCopy,
    restore,
    land,
    undo,
    holds,
    current,
    keepValues,
    landHeldKeeps,
    keepEdit,
    turnBuild,
  });
});

export const layer = Layer.effect(GameBuilds, make);
