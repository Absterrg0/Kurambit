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
import * as Deferred from "effect/Deferred";
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
  CommandId,
  diffBuildFacts,
  GAME_BUILDS_EVENT,
  type GameBuild,
  type GameBuildChanges,
  type GameBuildComparison,
  type GameBuildFacts,
  type GameBuildFolder,
  GameBuildId,
  type GameBuildKind,
  gameBuildName,
  type GameBuildRecord,
  type GameBuildRestore,
  type GameBuildRestoreOutcome,
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
import * as GameBuildMoves from "../orchestration-v2/gameBuilds/GameBuildMoves.ts";
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
/** Where a capture lands before it is kept under its own id (keepRef). */
const CAPTURE_REF = CheckpointRef.make("refs/kurambit/game-builds/capture");
/** A build made outside a turn, kept reachable: the ref holds its commit and means nothing else. */
const KEEP_REFS = "refs/kurambit/game-builds/builds/";
const keepRef = (id: string) => CheckpointRef.make(`${KEEP_REFS}${id}`);
/**
 * The base a keep outside a turn started from, written before it writes the folder and gone once
 * its build is recorded: a repeat after a death in between finds the folder already written, and
 * only this says what Undo goes back to. Never a build of the list.
 */
const requestRef = (request: string) =>
  CheckpointRef.make(`refs/kurambit/game-builds/requests/${request}`);
/** The folder as last compared with the build it was made from (folderEdited); no build of its own. */
const FOLDER_REF = CheckpointRef.make("refs/kurambit/game-builds/folder");
const MOVED_ON =
  "The game changed after the build this would undo, so nothing was restored and nothing was lost.";
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

/** What a folder move did, and the park it left as a build of its own. */
interface MoveResult {
  readonly outcome: GameBuildRestoreOutcome;
  readonly before: GameBuildId | null;
  readonly park: { readonly id: GameBuildId; readonly at: string } | null;
}

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
  const buildMoves = yield* GameBuildMoves.GameBuildMoves;
  // Who waits for a recorded restore's move, by request: the move runs as an outbox effect.
  const waiters = new Map<string, Deferred.Deferred<MoveResult>>();
  // Older turns never change their builds: a page's count below it is read once per ref set.
  const numberedCounts = new Map<string, number>();
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

  /**
   * A build into the game's records (`game-build.record`): the decider numbers it. One command
   * per build, so a repeat (a landing settled again, a reconcile) is the first one's receipt.
   */
  const recordBuild = (
    threadId: ThreadId,
    g: Pick<Game, "root" | "projectId">,
    entry: Entry,
    kind: GameBuildKind,
    options: {
      readonly current: boolean;
      readonly undid?: GameBuildId | undefined;
      readonly replaces?: GameBuildId | undefined;
      readonly request?: string | undefined;
    },
  ) =>
    ensureMigrated(threadId, g).pipe(
      Effect.andThen(
        engine.dispatch({
          type: "game-build.record",
          commandId: CommandId.make(`game-build:record:${g.projectId}:${entry.id}`),
          threadId,
          build: toRecord(g, entry, kind, options),
          current: options.current,
          ...(options.replaces === undefined ? {} : { replaces: options.replaces }),
        }),
      ),
      Effect.asVoid,
      Effect.mapError((cause) =>
        failed("Builds", g.root, "io", "the build could not be recorded", cause),
      ),
    );

  /** A build as the records keep it; its number and park place are the decider's. */
  const toRecord = (
    g: Pick<Game, "root" | "projectId">,
    entry: Entry,
    kind: GameBuildKind,
    options: { readonly undid?: GameBuildId | undefined; readonly request?: string | undefined },
  ): GameBuildRecord => ({
    id: entry.id,
    projectId: g.projectId,
    root: g.root,
    at: entry.at,
    kind,
    number: null,
    base: entry.base !== null && isGameBuildId(entry.base) ? entry.base : null,
    ...(options.undid === undefined ? {} : { undid: options.undid }),
    // A step's mark is read live: its verdict comes after the build.
    source: entry.source._tag === "turn" ? { ...entry.source, step: null } : entry.source,
    summary: entry.summary,
    files: entry.files,
    fileCount: entry.fileCount,
    ...(options.request === undefined ? {} : { request: options.request }),
  });

  /**
   * The one-time read of a folder's legacy builds into the records: the turn checkpoints, the
   * suffix refs (kept edits, landings, undos, parks, fixes, bases), the restore record and the
   * held-keep files, numbered and named as the legacy reader numbered and named them, so an old
   * game lists the same. Nothing legacy is deleted. Every write of a build waits for it first, so
   * a build landing during it is read in with the rest and never numbered twice.
   */
  const migratedFolders = new Set<string>();
  const migrateLock = yield* KeyedLock.make<string>();
  const ensureMigrated = (threadId: ThreadId, g: Pick<Game, "root" | "projectId">) =>
    Effect.suspend(() => {
      const key = `${g.projectId}\0${g.root}`;
      if (migratedFolders.has(key)) return Effect.void;
      return migrateLock.withLock(
        key,
        Effect.gen(function* () {
          if (migratedFolders.has(key)) return;
          const folder = yield* projections.getGameBuildFolder(g.projectId, g.root);
          if (folder?.migrated !== true) {
            const home = (yield* projects.home(threadId)).root;
            yield* migrateFolder(threadId, yield* gameOf(threadId, g.root === home));
          }
          migratedFolders.add(key);
        }),
      );
    });

  const kindOf = (entry: Pick<Entry, "source">): GameBuildKind => {
    switch (entry.source._tag) {
      case "turn":
        return "turn";
      case "version":
        return "version";
      case "saved":
        return entry.source.edit === "bring-in"
          ? "bring-in"
          : (entry.source.edit ?? "restore-before");
    }
  };

  const migrateFolder = (threadId: ThreadId, g: Game) =>
    Effect.gen(function* () {
      const home = g.root === g.home;
      const listed = yield* allEntries(g, ALL_TURNS / 3, undefined);
      const undoneBy = new Map(
        [...listed.refs].flatMap(([ref, oid]) =>
          ref.endsWith(UNDO_SUFFIX)
            ? [[oid, listed.refs.get(ref.replace(/-undo$/, "-undid"))] as const]
            : [],
        ),
      );
      // A copy's own turns, numbered on from its seat, as the copy's rail listed them.
      const rows = home
        ? listed.entries.map((entry) => ({ entry, number: undefined as BuildNumber | undefined }))
        : ((yield* copyRail(threadId, g, 50, undefined))?.rows ?? [])
            .filter((row) => row.inCopy === true)
            .map((row) => ({
              entry: {
                id: row.id,
                at: row.at,
                source: row.source,
                summary: row.summary,
                files: row.files,
                fileCount: row.fileCount,
                base: row.base,
              } satisfies Entry,
              number:
                row.number === null ? undefined : { number: row.number, fix: row.fix ?? null },
            }));
      const numbers = home ? yield* numbersOf(listed, listed.entries) : new Map();
      const builds = rows
        .toSorted((a, b) => (a.entry.at < b.entry.at ? -1 : a.entry.at > b.entry.at ? 1 : 0))
        .map(({ entry, number }): GameBuildRecord => {
          const numbered = number ?? numbers.get(entry.id);
          const undid = undoneBy.get(entry.id);
          return {
            id: entry.id,
            projectId: g.projectId,
            root: g.root,
            at: entry.at,
            kind: kindOf(entry),
            number: numbered?.number ?? null,
            ...(numbered?.fix == null ? {} : { fix: numbered.fix }),
            ...(entry.source._tag === "saved" &&
            entry.source.nth !== undefined &&
            entry.source.edit === undefined
              ? { nth: entry.source.nth }
              : {}),
            base: entry.base !== null && isGameBuildId(entry.base) ? entry.base : null,
            ...(undid !== undefined && isGameBuildId(undid) ? { undid } : {}),
            source: entry.source._tag === "turn" ? { ...entry.source, step: null } : entry.source,
            summary: entry.summary,
            files: entry.files,
            fileCount: entry.fileCount,
          };
        });
      const legacy = yield* noRunRestoreOf(g.root);
      const restore = legacy === null ? null : fromLegacyRestore(legacy);
      const held = yield* heldKeepsOf(g.root);
      yield* engine.dispatch({
        type: "game-build.migrate",
        commandId: CommandId.make(
          `game-build:migrate:${g.projectId}:${NodeCrypto.createHash("sha256").update(g.root).digest("hex").slice(0, 24)}`,
        ),
        threadId,
        projectId: g.projectId,
        root: g.root,
        builds,
        current: shownAs(listed, yield* currentOf(g, listed)),
        restore,
        held,
      });
      yield* Effect.logInfo("A game's builds were read into its records.", {
        root: g.root,
        builds: builds.length,
      });
    });

  /** A build made outside a turn, as the rail lists it: its change counted from its base. */
  const savedEntry = (
    g: Pick<Game, "root" | "lane">,
    build: GameBuildId,
    base: GameBuildId,
    label: string,
    edit: "values" | "library" | "bring-in" | "undo",
    summary: string,
  ) =>
    Effect.gen(function* () {
      const change = yield* changeOf(g.root, g.lane, base, build);
      return {
        id: build,
        at: DateTime.formatIso(yield* DateTime.now),
        source: { _tag: "saved", label, edit },
        summary,
        files: change.files,
        fileCount: change.count,
        base,
      } satisfies Entry;
    });

  const dropBuilds = (
    threadId: ThreadId,
    g: Pick<Game, "root" | "projectId">,
    ids: ReadonlyArray<GameBuildId>,
    current: GameBuildId | null,
  ) =>
    engine
      .dispatch({
        type: "game-build.drop",
        commandId: CommandId.make(
          `game-build:drop:${g.projectId}:${ids.join(",").slice(0, 200)}:${current ?? ""}`,
        ),
        threadId,
        projectId: g.projectId,
        root: g.root,
        ids,
        current,
      })
      .pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("Builds could not be dropped from the records.", {
            root: g.root,
            cause,
          }),
        ),
      );

  /** Every ref a build of the game lives under: turn checkpoints and run builds, never a capture's index. */
  const buildRefs = (root: string) =>
    Effect.forEach([TURN_REFS, "refs/kurambit/game-runs/", KEEP_REFS], (prefix) =>
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
        threadId,
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
  /** An earlier server's restore record, as the game's records keep one. */
  const fromLegacyRestore = (legacy: NoRunRestore): GameBuildRestore => ({
    requestId: legacy.requestId,
    target: legacy.target,
    label: legacy.label,
    requestedAt: legacy.requestedAt,
    before: legacy.before,
    ...(legacy.expect === undefined ? {} : { expect: legacy.expect }),
    ...(legacy.thread === undefined ? {} : { thread: legacy.thread }),
    outcome:
      legacy.outcome === null
        ? null
        : {
            restored: legacy.outcome.restored,
            message: legacy.outcome.message,
            moved: legacy.outcome.moved ?? (legacy.outcome.restored ? "restored" : "current"),
          },
  });
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
          name: "",
          undone: false,
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

  /**
   * A turn's build as it lands, or null when the turn changed no game files (no build). T3 diffs
   * a turn against its thread's previous checkpoint, which in a game includes whatever another
   * chat or a restore did in between: the base is the newest build that came into the folder
   * after the thread's previous turn and before this one began (turnChangeBase), else T3's own.
   */
  const turnEntryOf = (g: Game, checkpointRef: string) =>
    Effect.gen(function* () {
      const rows = yield* projections.listProjectTurnCheckpoints(g.projectId, { limit: 100 });
      const row = rows.find((each) => each.checkpoint.ref === checkpointRef);
      if (row === undefined) return null;
      const oid = yield* oidAt(g.root, CheckpointRef.make(checkpointRef));
      if (oid === null || !isGameBuildId(oid)) return null;
      const folder = yield* folderOf(g);
      const restore = folder?.restore ?? null;
      const recent = yield* recordsOf(g, 50);
      const earlier: ReadonlyArray<EarlierBuild> = [
        ...rows
          .filter((each) => each.threadId === row.threadId)
          .map((each) => ({
            id: "",
            at: DateTime.formatIso(each.checkpoint.capturedAt),
            thread: each.threadId,
            turn: each.runOrdinal,
          })),
        ...recent
          .filter((r) => r.kind !== "restore-before" && r.id !== oid)
          .map((r) => ({ id: r.id, at: r.at, thread: null, turn: null })),
        ...(restore?.outcome?.restored === true
          ? [{ id: restore.target, at: restore.requestedAt, thread: null, turn: null }]
          : []),
      ];
      const ordinal = row.checkpoint.ordinalWithinScope;
      const t3Base =
        ordinal === 0
          ? null
          : yield* oidAt(
              g.root,
              yield* checkpointRefForScopeOrdinal({
                scopeId: row.checkpoint.scopeId,
                ordinalWithinScope: ordinal - 1,
              }).pipe(Effect.provideService(Crypto.Crypto, crypto)),
            );
      const base =
        turnChangeBase(
          { id: oid, startedAt: row.startedAt, thread: row.threadId, turn: row.runOrdinal },
          earlier,
        ) ?? t3Base;
      const inGame = yield* gamePaths(g.root);
      const restored = isRestored(g.lane);
      const t3Files = row.checkpoint.files.flatMap((file) => {
        const path = inGame(file.path);
        return path !== null && restored(path) ? [{ ...file, path }] : [];
      });
      const change =
        base === null || base === t3Base
          ? { files: topFiles(t3Files), count: t3Files.length }
          : yield* changeOf(g.root, g.lane, base, oid);
      if (change.count === 0) return null;
      return {
        id: oid,
        at: DateTime.formatIso(row.checkpoint.capturedAt),
        source: {
          _tag: "turn",
          threadId: row.threadId,
          threadTitle: row.threadTitle,
          turn: row.runOrdinal,
          runId: row.runId,
          request: firstLine(row.request, "(no request text)"),
          step: null,
        },
        summary: firstLine(row.request, "A turn's changes"),
        files: change.files,
        fileCount: change.count,
        base,
      } satisfies Entry;
    });

  const recordTurn: GameBuilds["Service"]["recordTurn"] = (threadId, checkpointRef) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId);
      const entry = yield* turnEntryOf(g, checkpointRef);
      if (entry === null) return;
      yield* recordBuild(threadId, g, entry, "turn", { current: true });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("A turn's build could not be recorded.", { threadId, cause }),
      ),
    );

  const readFailed = (root: string) => (cause: unknown) =>
    failed("Builds", root, "io", "the game's builds could not be read", cause);

  /** A folder's state from the records, once its legacy builds are read in. */
  const folderOf = (g: Pick<Game, "threadId" | "root" | "projectId">) =>
    ensureMigrated(g.threadId, g).pipe(
      Effect.andThen(projections.getGameBuildFolder(g.projectId, g.root)),
      Effect.mapError(readFailed(g.root)),
    );
  /** The build the folder holds, as the records say: its newest landing, keep or restore. */
  const folderCurrent = (g: Pick<Game, "threadId" | "root" | "projectId">) =>
    Effect.map(folderOf(g), (folder) => folder?.current ?? null);
  /** A folder's builds, newest first, from `before`. */
  const recordsOf = (
    g: Pick<Game, "threadId" | "root" | "projectId">,
    limit: number,
    before?: string | undefined,
  ) =>
    ensureMigrated(g.threadId, g).pipe(
      Effect.andThen(projections.listGameBuilds(g.projectId, { root: g.root, before, limit })),
      Effect.mapError(readFailed(g.root)),
    );
  const recordOf = (g: Pick<Game, "root" | "projectId">, id: string) =>
    (isGameBuildId(id)
      ? projections.getGameBuilds(g.projectId, [id])
      : Effect.succeed([] as ReadonlyArray<GameBuildRecord>)
    ).pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.mapError(readFailed(g.root)),
    );

  /** Records as the rail's entries, each turn with its keep-going step's mark as it is now. */
  const entriesOf = (records: ReadonlyArray<GameBuildRecord>) =>
    Effect.gen(function* () {
      const steps = yield* stepsOf(
        new Set(records.flatMap((r) => (r.source._tag === "turn" ? [r.source.threadId] : []))),
      );
      return records.map((r): Entry => ({
        id: r.id,
        at: r.at,
        source:
          r.source._tag === "turn"
            ? { ...r.source, step: steps.get(RunId.make(r.source.runId)) ?? null }
            : r.source,
        summary: r.summary,
        files: r.files,
        fileCount: r.fileCount,
        base: r.base,
      }));
    });
  const numbersFrom = (records: ReadonlyArray<GameBuildRecord>) =>
    new Map(
      records.flatMap((r): ReadonlyArray<readonly [string, BuildNumber]> =>
        r.number === null ? [] : [[r.id, { number: r.number, fix: r.fix ?? null }]],
      ),
    );

  /** The rail's rows of records: their facts, their names and whether a restore undid them. */
  const rowsFrom = (
    g: Game,
    records: ReadonlyArray<GameBuildRecord>,
    folder: GameBuildFolder | null,
    inCopy?: boolean,
  ) =>
    Effect.gen(function* () {
      const entries = yield* entriesOf(records);
      const restore = folder?.restore ?? null;
      const target =
        restore?.outcome?.restored === true ? yield* recordOf(g, restore.target) : null;
      const resolved = yield* resolveOf(
        g,
        records.map((r) => r.id),
      );
      const measured = yield* facts.readMany([...resolved.values()]);
      const stills = yield* Effect.forEach(records, (r) => stillOf(g.root, measured.get(r.id)), {
        concurrency: 8,
      });
      const where = inCopy === true ? " · in this copy" : inCopy === false ? " · in the game" : "";
      const builds = records.map((r, index): GameBuild => {
        const entry = entries[index]!;
        const available = resolved.has(r.id);
        const read = measured.get(r.id);
        return {
          id: r.id,
          at: r.at,
          source: entry.source,
          number: r.number,
          ...(r.fix === undefined ? {} : { fix: r.fix }),
          ...(inCopy === undefined ? {} : { inCopy }),
          name: `${gameBuildName(r, entry.source._tag === "turn" && entry.source.step !== null)}${where}`,
          // Made after the build a restore put back and before the restore: not in the game now.
          undone:
            restore !== null &&
            target !== null &&
            (r.kind === "turn" || r.kind === "version") &&
            r.id !== folder?.current &&
            r.at > target.at &&
            r.at < restore.requestedAt,
          base: r.base,
          summary: r.summary,
          files: r.files,
          fileCount: r.fileCount,
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
      // Read before the builds: a turn's build recorded between the two reads then leaves the
      // turn pending or listed, never neither, which would show the build before it for a moment.
      const pending = input.before === undefined ? yield* pendingTurnOf(threadId) : null;
      const folder = yield* folderOf(g);
      const rail = g.root === g.home ? null : yield* copyRailOf(g, limit, input.before);
      const page = rail === null ? yield* recordsOf(g, limit + 1, input.before) : [];
      const builds =
        rail === null ? (yield* rowsFrom(g, page.slice(0, limit), folder)).builds : rail.rows;
      const current = input.before === undefined ? (folder?.current ?? null) : null;
      const pendingTurn = builds.some(
        (build) => build.source._tag === "turn" && build.source.runId === pending,
      )
        ? null
        : pending;
      return {
        builds,
        next: rail !== null ? rail.next : page.length > limit ? page[limit - 1]!.at : null,
        current,
        folderEdited: current !== null ? yield* folderEditedSince(g, current) : "unknown",
        restore: yield* restoreRefOf(g, folder),
        ...(pendingTurn === null ? {} : { pendingTurn }),
      } satisfies GameBuildsResult;
    });

  /**
   * A chat in a copy: the game's builds up to the copy's seat, then the copy's own builds since it
   * was made or last brought in, in the game's one numbering. Never the game's later builds, its
   * kept edits or another chat's copies. Null for a copy with no seat kept.
   */
  const copyRailOf = (g: Game, limit: number, before: string | undefined) =>
    Effect.gen(function* () {
      const seatedAt = yield* refTime(g.home, worktreeSeedRef(g.threadId));
      if (seatedAt === null) return null;
      const home: Game = { ...g, root: g.home };
      // The seat's own build commits within the second its ref says.
      const upTo = isoOfSeconds(seatedAt + 1);
      const gamePage = yield* recordsOf(home, limit + 1, before ?? upTo);
      const gameRows = yield* rowsFrom(
        home,
        gamePage.slice(0, limit),
        yield* folderOf(home),
        false,
      );
      const next = gamePage.length > limit ? gamePage[limit - 1]!.at : null;
      if (before !== undefined) return { rows: gameRows.builds, measured: gameRows.measured, next };
      const copiesFolder = `${gameRunRefsFolder(NO_RUN)}copies/${threadRefKey(g.threadId)}`;
      const since = isoOfSeconds(
        Math.max(
          (yield* refTime(g.home, `${copiesFolder}/in`)) ?? 0,
          (yield* refTime(g.home, `${copiesFolder}/brought`)) ?? 0,
        ),
      );
      const own = (yield* recordsOf(g, 50)).filter((r) => r.at > since);
      const copyRows = yield* rowsFrom(g, own, yield* folderOf(g), true);
      return {
        rows: [...copyRows.builds, ...gameRows.builds],
        measured: new Map([...gameRows.measured, ...copyRows.measured]),
        next,
      };
    });

  /** The build the rail shows for the folder's: a bot setup's point shows as the build it was written on. */
  const shownAs = (
    listed: { readonly setups: ReadonlyArray<Placed & { readonly from: string }> },
    id: GameBuildId | null,
  ) => {
    const from = listed.setups.find((setup) => setup.id === id)?.from;
    return from !== undefined && isGameBuildId(from) ? from : id;
  };

  /** The folder's latest restore, with the build that undoes it while no turn came since. */
  const restoreRefOf = (g: Game, folder: GameBuildFolder | null) =>
    Effect.gen(function* () {
      const r = folder?.restore ?? null;
      if (r === null) return null;
      const newer = (yield* recordsOf(g, 50)).some(
        (record) => record.kind === "turn" && record.at > r.requestedAt,
      );
      return {
        requestId: r.requestId,
        target: r.target,
        label: r.label,
        requestedAt: r.requestedAt,
        undo: r.outcome?.restored === true && !newer ? r.before : null,
        outcome:
          r.outcome === null ? null : { restored: r.outcome.restored, message: r.outcome.message },
      };
    });

  /** A build the caller named, checked to be one of this game's: its content key. */
  const resolve = (g: Game, ref: GameBuildRef) =>
    Effect.gen(function* () {
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
            : yield* oidAt(g.root, CheckpointRef.make(checkpoint.ref)).pipe(
                Effect.orElseSucceed(() => null),
              );
        if (id === null)
          return yield* failed(
            "Build",
            g.root,
            "invalid-input",
            "That turn captured no build of this game.",
          );
      }
      // One of the game's records, or a commit the game keeps (a turn's checkpoint that changed
      // no game files, the folder an edit started from).
      const known =
        id !== null && isGameBuildId(id)
          ? ref._tag === "turn" ||
            (yield* recordOf(g, id)) !== null ||
            (yield* buildRefs(g.root).pipe(Effect.orElseSucceed(() => []))).some(
              (each) => each.oid === id,
            )
          : false;
      if (id === null || !isGameBuildId(id) || !known)
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

  /** The list row of one build: its record's, else a bare row. */
  const rowOf = (g: Game, id: GameBuildId) =>
    Effect.gen(function* () {
      const record = yield* recordOf(g, id);
      const [row] = (yield* rowsFrom(
        g,
        [
          record ??
            ({
              id,
              projectId: g.projectId,
              root: g.root,
              at: EPOCH,
              kind: "setup",
              number: null,
              base: null,
              source: { _tag: "saved", label: `Build ${id.slice(0, 8)}` },
              summary: `Build ${id.slice(0, 8)}`,
              files: [],
              fileCount: null,
            } satisfies GameBuildRecord),
        ],
        null,
      )).builds;
      return row!;
    });

  const changes: GameBuilds["Service"]["changes"] = (threadId, id) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId);
      const row = yield* rowOf(g, id);
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
      const [rowA, rowB, factsA, factsB] = yield* Effect.all([
        rowOf(g, ra.build),
        rowOf(g, rb.build),
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
        (yield* folderOf(g))?.restore?.requestId === restoreRequestId(g.root, commandId);
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
      const records = yield* recordsOf(g, 50);
      return {
        entries: yield* entriesOf(records),
        numbers: numbersFrom(records),
        current: yield* folderCurrent(g),
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
      const build = yield* folderCurrent(g);
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
      const projectId = (yield* gameOf(threadId)).projectId;
      const recorded = (yield* recordOf({ root, projectId }, id))?.base ?? null;
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
    record: GameBuildRestore,
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
      const parkedAt = parked === -1 ? null : isoOfSeconds(parks[parked]!.committedAt);
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
      const keptWords =
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
                message: `${record.label}: its ${what} are back in the game folder.${keptWords} Restoring that build undoes this.`,
                moved: "restored" as const,
              }
            : movedOn
              ? { restored: false, message: MOVED_ON, moved: "moved-on" as const }
              : {
                  restored: false,
                  message: `${record.label} could not be restored (${moved.detail}). ${moved.back === null ? "The folder is back as it was." : `Putting the folder back failed too (${moved.back}).`}${keptWords}`,
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
      const kept =
        moved.kind !== "current" && !movedOn && before !== null && isGameBuildId(before)
          ? before
          : null;
      // After the record names the build, so a death in between leaves at most a spare mark.
      if (same !== null)
        yield* checkpoints
          .deleteCheckpointRefs({ cwd: root, checkpointRefs: [beforeRef] })
          .pipe(Effect.ignore);
      yield* operations.changed(root, GAME_BUILDS_EVENT, outcome.message);
      return {
        outcome,
        before: same ?? kept,
        park:
          same === null && kept !== null && parkedAt !== null ? { id: kept, at: parkedAt } : null,
      } satisfies MoveResult;
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
    /** The build a landing brings in, recorded with the restore. */
    landing?: GameBuildRecord,
  ) =>
    Effect.gen(function* () {
      const requestId = restoreRequestId(g.root, commandId);
      const earlier = (yield* folderOf(g))?.restore ?? null;
      // A repeat answers as the first try did.
      if (earlier?.requestId === requestId && earlier.outcome !== null) {
        const moved = earlier.outcome.moved;
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
      // Named as the Builds list names it: the message is what the person and the agent read.
      const named =
        label ??
        (yield* recordOf(g, build.build).pipe(
          Effect.map((record) => (record?.number == null ? null : `Build ${record.number}`)),
          Effect.orElseSucceed(() => null),
        )) ??
        `Build ${build.build.slice(0, 8)}`;
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
            message: `The folder already holds ${named}; nothing was restored.`,
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
            : yield* folderCurrent(g).pipe(Effect.orElseSucceed(() => null));
      const record: GameBuildRestore =
        earlier?.requestId === requestId
          ? earlier
          : {
              requestId,
              target: build.build,
              label: named,
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
          recordedMove(
            threadId,
            g,
            {
              ...record,
              ...(folderBuild === null ? {} : { holding: folderBuild }),
              outcome: null,
            },
            landing,
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
   * A restore into the game's records, its folder move the record's outbox effect (moveRecorded):
   * the record commits before anything moves, and a restart runs a move it cut short again.
   * Waits for the move here, so the person's Undo answers with what it did.
   */
  const recordedMove = (
    threadId: ThreadId,
    g: Game,
    restore: GameBuildRestore,
    landing: GameBuildRecord | undefined,
  ) =>
    Effect.gen(function* () {
      yield* ensureMigrated(threadId, g).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("A game's builds could not be read into its records.", { cause }),
        ),
      );
      const waiter = yield* Deferred.make<MoveResult>();
      waiters.set(restore.requestId, waiter);
      yield* engine
        .dispatch({
          type: "game-build.restore",
          commandId: CommandId.make(`game-build:restore:${g.projectId}:${restore.requestId}`),
          threadId,
          projectId: g.projectId,
          root: g.root,
          restore,
          ...(landing === undefined ? {} : { landing }),
        })
        .pipe(
          Effect.mapError((cause) =>
            failed("Restore build", g.root, "io", "the restore could not be recorded", cause),
          ),
        );
      const moved = yield* Deferred.await(waiter).pipe(Effect.timeoutOption("5 minutes"));
      if (moved._tag === "None")
        return yield* failed(
          "Restore build",
          g.root,
          "busy",
          "The restore is saved and still moving the game folder; the builds show it once it is done.",
        );
      return moved.value.outcome;
    }).pipe(Effect.ensuring(Effect.sync(() => waiters.delete(restore.requestId))));

  /**
   * A recorded restore's move, as its outbox effect runs it: the folder's moves (safe to run again
   * with the same request), then the settle into the records. A move a restart cut short after
   * its outcome was saved settles from that outcome without moving again.
   */
  const moveRecorded: GameBuildMoves.GameBuildMoveRunner["move"] = (move) =>
    Effect.gen(function* () {
      const { root, restore } = move;
      const settled = (yield* projections.getGameBuildFolder(move.projectId, root))?.restore;
      // Settled before a restart marked the effect done: answer from the record, move nothing.
      const result: MoveResult =
        settled?.requestId === restore.requestId && settled.outcome !== null
          ? { outcome: settled.outcome, before: settled.before, park: null }
          : yield* moveWithoutRun(
              root,
              manifestProject(yield* projects.read(root)),
              restore,
              String(move.threadId),
              restore.holding ?? null,
              move.projectId,
            );
      yield* engine.dispatch({
        type: "game-build.restore.settle",
        commandId: CommandId.make(`game-build:settle:${move.projectId}:${restore.requestId}`),
        threadId: move.threadId,
        projectId: move.projectId,
        root,
        restore: { ...restore, before: result.before, outcome: result.outcome },
        park: result.park,
      });
      const waiter = waiters.get(restore.requestId);
      if (waiter !== undefined) yield* Deferred.succeed(waiter, result);
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.fail(new GameBuildMoves.GameBuildMoveError({ cause: Cause.squash(cause) })),
      ),
      Effect.asVoid,
    );
  yield* buildMoves.attach({ move: moveRecorded });

  const oidAt = (root: string, ref: CheckpointRef) =>
    checkpoints.listCheckpointRefs({ cwd: root, prefix: ref }).pipe(
      Effect.map((refs) => refs.find((each) => each.checkpointRef === ref)?.oid ?? null),
      Effect.mapError((cause) =>
        failed("Builds", root, "io", "the game's builds could not be read", cause),
      ),
    );

  /** The folder captured as a commit, kept under a ref named by its id alone. */
  const captureFolder = (root: string) =>
    checkpoints
      .withWorkspaceLock(
        root,
        checkpoints.captureCheckpoint({ cwd: root, checkpointRef: CAPTURE_REF }),
      )
      .pipe(Effect.tap((oid) => pin(root, oid)));
  const pin = (root: string, oid: string) =>
    checkpoints.updateCheckpointRef({ cwd: root, checkpointRef: keepRef(oid), oid });
  /** The folder's build made outside a turn by this request, when an earlier try recorded it. */
  const byRequest = (g: Game, request: string) =>
    Effect.map(recordsOf(g, 100), (records) => records.find((r) => r.request === request) ?? null);
  const startRequest = (root: string, request: string, base: string) =>
    checkpoints.updateCheckpointRef({ cwd: root, checkpointRef: requestRef(request), oid: base });
  const endRequest = (root: string, request: string) =>
    checkpoints
      .deleteCheckpointRefs({ cwd: root, checkpointRefs: [requestRef(request)] })
      .pipe(Effect.ignore);

  /** `captured`, or the build the folder holds when the capture is that build in every restored path. */
  const heldBuildOr = (g: Game, captured: GameBuildId) =>
    Effect.gen(function* () {
      const current = yield* folderCurrent(g).pipe(Effect.orElseSucceed(() => null));
      if (current === null || !isGameBuildId(current) || current === captured) return captured;
      const change = yield* measureChange(
        checkpoints,
        g.root,
        isRestored(g.lane),
        current,
        captured,
      );
      return change.changed ? captured : current;
    });

  const land: GameBuilds["Service"]["land"] = (threadId, input) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId, true);
      const io = (detail: string) => (cause: unknown) =>
        failed("Land build", g.root, "io", detail, cause);
      const kind = input.kind === "in" ? "bring-in" : "undo";
      const earlier = yield* byRequest(g, input.request);
      const known = earlier?.id ?? null;
      // The folder the move read, by the build it still holds when nothing in the game changed
      // since (a decisions line is no change), as Keep values does: Undo then goes back to a
      // build the Stage can name, not to a capture no list holds. A repeat keeps its first read.
      const from =
        earlier?.base != null && isGameBuildId(earlier.base)
          ? earlier.base
          : yield* heldBuildOr(g, input.from);
      const made =
        known ??
        (yield* checkpoints
          .commitTree({ cwd: g.root, tree: input.tree, parent: from, message: input.label })
          .pipe(Effect.mapError(io("the build could not be made"))));
      if (!isGameBuildId(made)) return yield* failed("Land build", g.root, "io", "not a build");
      yield* pin(g.root, made).pipe(Effect.mapError(io("the build could not be kept")));
      const resolved = (yield* resolveOf(g, [made])).get(made);
      if (resolved === undefined)
        return yield* failed("Land build", g.root, "io", `the build holds no ${g.lane}/ project`);
      // Recorded in the restore's own commit: a death leaves both or neither.
      const landing = toRecord(
        g,
        yield* savedEntry(g, made, from, input.label, kind, input.label),
        kind,
        { undid: input.undid, request: input.request },
      );
      const result = yield* restoreWithoutRun(
        threadId,
        g,
        resolved,
        `land\0${input.request}`,
        from,
        input.label,
        from,
        landing,
      );
      if (result.moved === "moved-on") {
        yield* dropBuilds(threadId, g, [made], null);
        yield* checkpoints
          .deleteCheckpointRefs({ cwd: g.root, checkpointRefs: [keepRef(made)] })
          .pipe(Effect.ignore);
        return { build: made, moved: result.moved };
      }
      yield* playRestored(threadId, g);
      yield* operations.changed(g.root, GAME_BUILDS_EVENT, input.label);
      yield* measureIn(g.root, made, { supersede: true });
      return { build: made, moved: result.moved };
    });

  const undo: GameBuilds["Service"]["undo"] = (threadId, build, commandId) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId, true);
      const profile = engineProfile(yield* availableEngine(g.engine));
      const record = yield* recordOf(g, build);
      const [entry] = record === null ? [] : yield* entriesOf([record]);
      const undid = record?.kind === "undo" ? (record.undid ?? null) : null;
      const named = new Map(
        (yield* projections
          .getGameBuilds(g.projectId, [build, ...(undid === null ? [] : [undid])])
          .pipe(Effect.mapError(readFailed(g.root)))).map((r) => [r.id as string, r.number]),
      );
      const name = (id: string) => {
        const number = named.get(id) ?? null;
        return number === null ? `build ${id.slice(0, 7)}` : `Build ${number}`;
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
      // The game as it is now: the merge's ours, and what the undo lands on. A repeat whose
      // undo was recorded lands on what that one read.
      const now =
        (yield* byRequest(g, request))?.base ??
        (yield* captureFolder(g.root).pipe(
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
        return {
          _tag: "conflicts",
          files: merged.conflicts,
          message: `Later builds changed the same lines as ${name(build)} (${merged.conflicts.map((each) => each.path).join(", ")}), so nothing was undone. Go back to the build before it, or ask the agent to take its change out.`,
        } as const;
      }
      // Undoing an undo is its Redo: it takes that undo's decision back.
      const what = yield* whatBuildDid(g, entry);
      const label =
        undid !== null
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
  const holdKeep = (
    g: Pick<Game, "threadId" | "root" | "projectId">,
    request: string,
    input: GameKeepValuesInput,
  ) =>
    heldKeepEvent(input.threadId, g, { request, input }, null).pipe(
      Effect.mapError((cause) =>
        failed("Keep values", g.root, "io", "the kept values could not be held", cause),
      ),
    );
  const heldKeepEvent = (
    threadId: ThreadId,
    g: Pick<Game, "root" | "projectId">,
    keep: { readonly request: string; readonly input: GameKeepValuesInput } | null,
    drop: string | null,
  ) =>
    Effect.gen(function* () {
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* ensureMigrated(threadId, g);
      yield* engine.dispatch({
        type: "game-build.keep",
        commandId: CommandId.make(
          `game-build:keep:${g.projectId}:${keep?.request ?? drop}:${keep === null ? "drop" : "hold"}`,
        ),
        threadId,
        projectId: g.projectId,
        root: g.root,
        keep: keep === null ? null : { ...keep, at },
        drop,
      });
    });
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
  /** The held keeps' files of a folder, oldest first. */
  const heldKeepsOf = (root: string) =>
    Effect.gen(function* () {
      const dir = heldKeepsDir(root);
      const files = yield* Effect.promise(() => NodeFSP.readdir(dir).catch(() => [] as string[]));
      const at = DateTime.formatIso(yield* DateTime.now);
      const held = [];
      for (const name of files.filter((each) => each.endsWith(".json")).toSorted()) {
        const text = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(dir, name), "utf8").catch(() => null),
        );
        const decoded = text === null ? Option.none() : decodeHeldKeep(text);
        if (Option.isSome(decoded))
          held.push({ request: name.slice(0, -".json".length), input: decoded.value.input, at });
      }
      return held;
    });
  const landHeldKeeps: GameBuilds["Service"]["landHeldKeeps"] = (root) =>
    Effect.gen(function* () {
      const held = (yield* projections.listGameBuildFolders())
        .filter((folder) => folder.root === root)
        .flatMap((folder) => folder.held.map((keep) => ({ projectId: folder.projectId, keep })))
        .toSorted((a, b) => (a.keep.at < b.keep.at ? -1 : a.keep.at > b.keep.at ? 1 : 0));
      for (const { projectId, keep } of held) {
        const { threadId, ...input } = keep.input;
        const kept = yield* keepValues(threadId, input).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Values kept during a turn could not land.", { root, cause }).pipe(
              Effect.as(null),
            ),
          ),
        );
        // Still held (a turn at work again) stays held; landed or refused for good, it goes.
        if (kept?.heldFor !== undefined) return;
        yield* heldKeepEvent(threadId, { root, projectId }, null, keep.request);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Held keeps could not land.", { root, cause }),
      ),
    );

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
      const capture = captureFolder(g.root).pipe(
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
        const newest = (yield* recordsOf(g, 50)).find((r) => r.kind === "values");
        if (newest === undefined || newest.base === null) return null;
        const [changed] = yield* folderAgainst(g, [newest.id]).pipe(
          Effect.mapError((cause) =>
            failed("Keep values", g.root, "io", "the folder could not be compared", cause),
          ),
        );
        return changed === false ? { base: newest.base, build: newest.id } : null;
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
        const captured = yield* capture;
        const current = yield* folderCurrent(g);
        if (current === null || (yield* folderEditedSince(g, current)) !== false) return captured;
        return current;
      });
      // A repeat answers as the first try did.
      const done = yield* byRequest(g, request);
      if (done !== null && done.base !== null)
        return yield* answer(done.id, done.base, said(input.things));
      const startedFrom = yield* oidAt(g.root, requestRef(request));
      // A turn at work in this folder (any chat's, this one's too) would write over the values or
      // be captured half done: they are kept aside and land when its turn ends (landHeldKeeps).
      const writer = yield* turnIn(g, threadId);
      if (writer !== null) {
        // The same request lands it later, so a repeat of this keep is still one build.
        yield* holdKeep(g, request, {
          ...input,
          threadId,
          commandId: input.commandId ?? request,
        });
        const folder = yield* folderCurrent(g);
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
          const held = input.fold === true && startedFrom === null ? yield* heldTuning : null;
          // A try cut short after it wrote keeps its first base; a fold keeps the base of the
          // build it replaces, so Undo still goes back to before the session.
          const base = startedFrom ?? (held === null ? yield* sessionBase : held.base);
          yield* startRequest(g.root, request, base).pipe(
            Effect.mapError((cause) =>
              failed("Keep values", g.root, "io", "the game folder could not be kept", cause),
            ),
          );
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
          const build = yield* capture;
          // Every value put back: the session leaves no build, and the folder is its base again.
          if ((yield* changeOf(g.root, g.lane, base, build)).count === 0) {
            yield* checkpoints
              .deleteCheckpointRefs({ cwd: g.root, checkpointRefs: [keepRef(build)] })
              .pipe(Effect.ignore);
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
        if (kept.held !== null && isGameBuildId(kept.held))
          yield* dropBuilds(threadId, g, [kept.held], kept.base);
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
        yield* endRequest(g.root, request);
        yield* operations.changed(g.root, GAME_BUILDS_EVENT, "Tuned values put back.");
        return {
          build: kept.base,
          base: kept.base,
          message: "Every value is back as it was, so no build was kept.",
        };
      }
      const result = yield* answer(kept.build, kept.base, kept.summary);
      yield* recordBuild(
        threadId,
        g,
        yield* savedEntry(
          g,
          result.build,
          result.base,
          VALUES_LABEL,
          "values",
          "Values tuned on the Stage",
        ),
        "values",
        {
          current: true,
          replaces: kept.held !== null && isGameBuildId(kept.held) ? kept.held : undefined,
          request,
        },
      );
      yield* endRequest(g.root, request);
      yield* nextTurnsFrom(g, threadId, kept.build);
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
      const number = (yield* recordOf(g, build))?.number ?? undefined;
      yield* recordDecision(g.home, {
        kind: "kept-values",
        text: `Kept tuned values as ${number === undefined ? `build ${build.slice(0, 7)}` : `Build ${number}`}: ${segments.join("; ")}`,
        build,
        ...(replaces === null ? {} : { replaces }),
      });
    });

  /**
   * Finishes every no-run restore an earlier server's restart cut short, by running its moves
   * again. A restore in the game's records is left to its outbox effect, which a restart runs.
   */
  const settleRestores = Effect.gen(function* () {
    const rows = yield* sql<{ readonly root: string; readonly payload_json: string }>`
      SELECT root, payload_json FROM game_build_restores
    `.pipe(Effect.orElseSucceed(() => []));
    const recorded = new Set(
      (yield* projections.listGameBuildFolders().pipe(Effect.orElseSucceed(() => []))).flatMap(
        (folder) => (folder.restore === null ? [] : [folder.restore.requestId]),
      ),
    );
    const unsettled = rows.flatMap((row) => {
      const decoded = decodeNoRunRestore(row.payload_json);
      return Option.isSome(decoded) &&
        decoded.value.outcome === null &&
        !recorded.has(decoded.value.requestId)
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
            fromLegacyRestore(row.record),
            "game-builds:settle",
            null,
            games.find((game) => game.root === row.root)?.projectId ?? null,
          ),
        ),
        // Its own record settles, so the read into the game's records takes the outcome.
        Effect.tap(({ outcome, before }) =>
          saveNoRunRestore(row.root, { ...row.record, before, outcome }),
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

  /** Every game folder's legacy builds read into the records, once (ensureMigrated). */
  const migrateGames = Effect.gen(function* () {
    const games = yield* projects.list().pipe(Effect.orElseSucceed(() => []));
    for (const summary of games)
      yield* Effect.gen(function* () {
        const [turn] = yield* projections.listProjectTurnCheckpoints(summary.projectId, {
          limit: 1,
        });
        // A game no chat ever changed has no builds to read.
        if (turn === undefined) return;
        yield* ensureMigrated(turn.threadId, { root: summary.root, projectId: summary.projectId });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("A game's builds could not be read into its records.", {
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
    yield* migrateGames;
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
      const io = (detail: string) => (cause: unknown) =>
        failed(input.operation, g.root, "io", detail, cause);
      const capture = captureFolder(g.root).pipe(
        Effect.mapError(io("the game folder could not be kept")),
      );
      // A repeat answers as the first try did.
      const done = yield* byRequest(g, request);
      if (done !== null && done.base !== null) return { build: done.id, base: done.base };
      const startedFrom = yield* oidAt(g.root, requestRef(request));
      const kept = yield* operations.exclusive(
        g.root,
        input.operation,
        Effect.gen(function* () {
          // The folder as it stood: still the build it holds, that build by its own id, so Undo
          // goes back to a build the Stage can name.
          const base =
            startedFrom ??
            (yield* Effect.gen(function* () {
              const captured = yield* capture;
              const current = yield* folderCurrent(g);
              return current === null || (yield* folderEditedSince(g, current)) !== false
                ? captured
                : current;
            }));
          yield* startRequest(g.root, request, base).pipe(
            Effect.mapError(io("the game folder could not be kept")),
          );
          yield* input.write(g.root);
          return { base, build: yield* capture };
        }),
        String(threadId),
      );
      if (isGameBuildId(kept.build)) {
        if (isGameBuildId(kept.base))
          yield* recordBuild(
            threadId,
            g,
            yield* savedEntry(
              g,
              kept.build,
              kept.base,
              LIBRARY_LABEL,
              "library",
              "Added from the Library",
            ),
            "library",
            { current: true, request },
          );
        yield* endRequest(g.root, request);
        yield* nextTurnsFrom(g, threadId, kept.build);
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
