// @effect-diagnostics nodeBuiltinImport:off -- Rounds and the selected build live in the server's native store.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import {
  DEFAULT_GAME_REVIEW_BUDGET,
  GameOperationError,
  GameReviewRound,
  GameSelectedBuild,
  GameSubmission,
  GameReviewArtifact,
  GamePlaytestStep,
  GameViewport,
  GameManifest,
  GameProduction,
  type GameReviewBallotPlan,
  type GameReviewBallotRecord,
  type GameReviewBudget,
  type GameReviewCheck,
  type GameReviewDefect,
  type GameReviewDoNotRegress,
  type GameReviewExperimentRoute,
  type GameReviewRequirementDowngrade,
  type GameReviewRound as GameReviewRoundType,
  type GameReviewState as GameReviewStateType,
  type ModelSelection,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as GameSnapshots from "./GameSnapshots.ts";
import {
  gameRecordLocation,
  migrateGameRecord,
  readRecordText,
  type GameRecordLocation,
} from "./gameRecord.ts";
import { candidateBuildId, hashWebBuild } from "./webBuild.ts";

const StoredState = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  selected: Schema.NullOr(GameSelectedBuild),
  rounds: Schema.Array(GameReviewRound),
  /** Builders' and repair children's declarations, newest last. */
  submissions: Schema.optionalKey(Schema.Array(GameSubmission)),
  /** The game's first playable and the producing turn's declarations. */
  production: Schema.optionalKey(Schema.NullOr(GameProduction)),
});
type StoredState = typeof StoredState.Type;
const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(StoredState));

const BuildPlaytest = Schema.Struct({
  booted: Schema.Boolean,
  responded: Schema.Boolean,
  executedInputSteps: Schema.optionalKey(Schema.Int),
  consoleErrors: Schema.Int,
  steps: Schema.Array(GamePlaytestStep),
  viewport: Schema.NullOr(GameViewport),
  /** The multiple of the base viewport this play actually used. */
  captureScale: Schema.optionalKey(Schema.Number),
  /** The run's own gameplay verdict; older records have none and stay readable. */
  qualifies: Schema.optionalKey(Schema.Boolean),
  blockers: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Game-relative playtest evidence, so review can reuse this exact run. */
  evidenceDirectory: Schema.optionalKey(Schema.String),
});
const StoredExport = Schema.Struct({
  artifact: GameReviewArtifact,
  playtest: Schema.NullOr(BuildPlaytest),
});
const decodeExport = Schema.decodeUnknownSync(Schema.fromJsonString(StoredExport));

/** A completed-round history is provenance, not a log; keep the recent window small. */
const MAX_STORED_ROUNDS = 50;
/** Submissions are the review's recent declarations, one per turn. */
const MAX_STORED_SUBMISSIONS = 20;

const isGameOperationError = Schema.is(GameOperationError);
const failure = (
  operation: string,
  path: string,
  reason: "io" | "invalid-input" | "invalid-path" | "busy",
  detail?: string,
  cause?: unknown,
) =>
  new GameOperationError({
    operation,
    path,
    reason,
    ...(detail === undefined ? {} : { detail }),
    ...(cause === undefined ? {} : { cause }),
  });
const attempt = <A>(operation: string, path: string, work: () => Promise<A>) =>
  Effect.tryPromise({
    try: work,
    catch: (cause) =>
      isGameOperationError(cause) ? cause : failure(operation, path, "io", undefined, cause),
  });

/**
 * A selectable artifact is exactly an immutable candidate directory named by
 * its own hash. The entry stays inside it. This is also what makes delete and
 * preview safe: a record can never name builds/web, another game's path or a
 * directory that does not belong to the build it claims.
 */
const validatedArtifact = (artifact: GameReviewArtifact): GameReviewArtifact => {
  if (candidateBuildId(artifact.directory) !== artifact.buildId)
    throw failure(
      "game review round",
      artifact.directory,
      "invalid-path",
      "A candidate build must live under builds/candidates/ under its own hash.",
    );
  if (
    artifact.entry.length === 0 ||
    artifact.entry.startsWith("/") ||
    artifact.entry.includes("\\") ||
    artifact.entry.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    throw failure(
      "game review round",
      artifact.entry,
      "invalid-path",
      "A build entry must be a relative path inside the build directory.",
    );
  return artifact;
};

const decodeGameManifest = Schema.decodeUnknownSync(Schema.fromJsonString(GameManifest));

/**
 * The engine project directory an export builds from. An unreadable manifest
 * is unknown, and an unknown project leaves the whole-folder identity in
 * charge, because a guard that cannot name the build inputs must not forgive
 * a change to them.
 */
const engineProject = (root: string): Effect.Effect<string | null> =>
  Effect.tryPromise(() => NodeFSP.readFile(NodePath.join(root, "game.json"), "utf8")).pipe(
    Effect.map((text) => decodeGameManifest(text).godotProject),
    Effect.map((project) =>
      project !== "" &&
      !project.startsWith("/") &&
      !project.startsWith(".") &&
      !project.split(/[\\/]/u).includes("..")
        ? project
        : null,
    ),
    Effect.orElseSucceed(() => null),
  );

/**
 * Whether the candidate's build still describes the current sources. A round
 * repairs engine code; design documents and notes are never export input, so
 * editing them after the export cannot make the bytes wrong. The whole-folder
 * identity still governs restore and user-edit detection.
 */
const sameBuildInputs = (
  snapshots: GameSnapshots.GameSnapshots["Service"],
  input: {
    readonly root: string;
    readonly candidateSourceId: string;
    readonly current: GameSnapshots.GameSourceManifest;
  },
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const project = yield* engineProject(input.root);
    if (project === null) return false;
    const frozen = yield* Effect.result(snapshots.read(input.root, input.candidateSourceId));
    const read = frozen._tag === "Success" ? frozen.success : null;
    if (read === null) return false;
    return (
      GameSnapshots.buildSourceId(read.manifest.files, project) ===
      GameSnapshots.buildSourceId(input.current.files, project)
    );
  });

export interface GameRoundBeginInput {
  readonly threadId?: ThreadId | undefined;
  readonly budget?: GameReviewBudget | undefined;
  /** Live previews may still request files from a round leaving the history window. */
  readonly preserveDirectories?: readonly string[] | undefined;
  /** The repair loop that owns this round, when one does. */
  readonly loopId?: string | undefined;
  /** Frozen model selections; a later composer change cannot alter this round. */
  readonly builderSelection?: ModelSelection | undefined;
  readonly reviewSelection?: ModelSelection | undefined;
  readonly defects?: ReadonlyArray<GameReviewDefect> | undefined;
  readonly doNotRegress?: ReadonlyArray<GameReviewDoNotRegress> | undefined;
}

export interface GameRoundReviewInput {
  readonly childUsage?: GameReviewRoundType["childUsage"] | undefined;
  readonly usageByRole?: GameReviewRoundType["usageByRole"] | undefined;
  readonly fundamentals?: GameReviewRoundType["fundamentals"] | undefined;
  readonly requirements?: GameReviewRoundType["requirements"] | undefined;
  readonly requirementsIncomplete?: boolean | undefined;
  /** Server-applied downgrades frozen with the round; absent on legacy rounds. */
  readonly downgradedRequirements?: ReadonlyArray<GameReviewRequirementDowngrade> | undefined;
  /** Frozen absolute-quality assessment; absent on legacy rounds, which read as unknown. */
  readonly quality?: GameReviewRoundType["quality"] | undefined;
  readonly qualityRubricVersion?: number | undefined;
  readonly qualityCoverage?: GameReviewRoundType["qualityCoverage"] | undefined;
  readonly defects?: ReadonlyArray<GameReviewDefect> | undefined;
  readonly doNotRegress?: ReadonlyArray<GameReviewDoNotRegress> | undefined;
  readonly checks?: ReadonlyArray<GameReviewCheck> | undefined;
  /** Routes of the critic's cited experiments, frozen before the repair runs. */
  readonly experiments?: ReadonlyArray<GameReviewExperimentRoute> | undefined;
  readonly candidateChecks?: ReadonlyArray<GameReviewCheck> | undefined;
  readonly mechanicalVeto?: string | undefined;
  /** The repair child's own `game_submit` note, when it made one. */
  readonly submissionNote?: string | undefined;
  readonly ballots?: ReadonlyArray<GameReviewBallotPlan> | undefined;
  readonly ballotAnswers?: ReadonlyArray<GameReviewBallotRecord> | undefined;
}

export interface GamePromoteOptions {
  /**
   * Runs after the new selection is written, still under the per-root lock, so
   * a preview switch cannot interleave with another selection change. The
   * selection is already committed when it runs; it must not fail.
   */
  readonly serve?: ((selected: GameSelectedBuild) => Effect.Effect<void>) | undefined;
  /**
   * Runs under the per-root lock immediately before the selection is written,
   * after the slow hashing and snapshotting. A reason blocks the promotion, so
   * a caller's deadline is judged at the commit, not before the slow part.
   */
  readonly guard?: Effect.Effect<string | null> | undefined;
}

export type GamePromotion =
  | { readonly kind: "promoted"; readonly selected: GameSelectedBuild }
  | {
      /**
       * A precondition failed at commit. The round is terminal `stopped`; the
       * selection, folder, snapshot and candidate stay exactly as they were.
       */
      readonly kind: "blocked";
      readonly round: GameReviewRoundType;
      readonly detail: string;
    };

export type GameRejection =
  | {
      readonly kind: "rejected";
      readonly round: GameReviewRoundType;
      readonly restored: readonly string[];
      readonly deleted: readonly string[];
      /** The candidate directory removed because no record or preview referenced it. */
      readonly discarded: readonly string[];
    }
  | {
      /**
       * The folder changed after the server last read it. Nothing was restored
       * and the snapshot and candidate stay, so a user edit was never
       * overwritten and a later explicit restore is still possible.
       */
      readonly kind: "blocked";
      readonly round: GameReviewRoundType;
      readonly detail: string;
    };

export interface GameRoundRestoreOptions {
  /** Directories a live preview still serves; they are never deleted. */
  readonly preserveDirectories?: readonly string[] | undefined;
  /**
   * Test seam: runs after the replaced version is preserved and before the
   * restore reads the folder, so a test can interleave an edit there.
   */
  readonly beforeRestore?: (() => Promise<void>) | undefined;
}

export type GameRestore =
  | {
      readonly kind: "restored";
      readonly round: GameReviewRoundType;
      readonly restored: readonly string[];
      readonly deleted: readonly string[];
      readonly discarded: readonly string[];
      /** The version present before this restore, kept so it can be returned to. */
      readonly preservedSnapshotId: string;
    }
  | {
      /** The folder changed after it was preserved; nothing was overwritten. */
      readonly kind: "blocked";
      readonly round: GameReviewRoundType;
      readonly detail: string;
    }
  | {
      /** Another round owns the folder; nothing was rewritten. */
      readonly kind: "busy";
      readonly owner: GameReviewRoundType;
    };

/**
 * The one restore-eligibility rule, shared by the status that offers the
 * restore control and the restore that acts on it. Only a round where a repair
 * was actually dispatched can have changed the folder: a clean review or an
 * invalid critic stops before dispatch, so it has nothing to return from. An
 * interrupted round is judged the same way; the dispatch marker survives the
 * recovery that marks it interrupted.
 */
export const isRestorableRound = (round: GameReviewRoundType): boolean =>
  round.restoredAt === undefined &&
  (round.status === "interrupted" || round.status === "stopped") &&
  (round.repairStartedAt !== undefined || round.postRepairSourceId !== null);

export class GameRoundStore extends Context.Service<
  GameRoundStore,
  {
    /** The selected build and recent rounds, recovering interrupted rounds first. */
    readonly read: (root: string) => Effect.Effect<GameReviewStateType, GameOperationError>;
    /**
     * Records a verified declaration beside the review state. A later submit in
     * the same turn replaces it; the review starts from the declaration.
     */
    readonly recordSubmission: (
      root: string,
      submission: GameSubmission,
    ) => Effect.Effect<GameSubmission, GameOperationError>;
    /**
     * Advances the production record for one accepted builder declaration: the
     * game's first playable is set once, and a new turn starts its own clock.
     * Repair children never call this; their declarations are testimony for the
     * round, not the builder's production.
     */
    readonly recordProduction: (
      root: string,
      input: { readonly runId: RunId; readonly buildId: string; readonly at: string },
    ) => Effect.Effect<GameProduction, GameOperationError>;
    /** Export provenance survives later exports and mutable qualification records. */
    readonly recordExport: (
      root: string,
      artifact: GameReviewArtifact,
    ) => Effect.Effect<void, GameOperationError>;
    readonly exported: (
      root: string,
      buildId: string,
    ) => Effect.Effect<
      {
        readonly artifact: GameReviewArtifact;
        readonly sourceDirectory: string;
        readonly playtest: typeof BuildPlaytest.Type | null;
      } | null,
      GameOperationError
    >;
    readonly recordBuildPlaytest: (
      root: string,
      buildId: string,
      playtest: typeof BuildPlaytest.Type,
    ) => Effect.Effect<void, GameOperationError>;
    /** The byte-accurate source identity round decisions use. */
    readonly sourceId: (root: string) => Effect.Effect<string, GameOperationError>;
    /**
     * Copies the game's current source into the immutable store and returns
     * that copy. An export builds from this snapshot, so its bytes are the
     * exact input its candidate record names.
     */
    readonly freeze: (
      root: string,
    ) => Effect.Effect<
      { readonly directory: string; readonly sourceId: string },
      GameOperationError
    >;
    /** Re-identifies a private export copy so an export can prove its input did not move. */
    readonly frozenSourceId: (directory: string) => Effect.Effect<string, GameOperationError>;
    /**
     * Whether the named export still describes the current engine inputs. It
     * reads the validated export/source binding and compares only the Godot
     * project bytes, so a design-doc or notes edit stays current while an
     * engine-source edit does not. Unknown, unreadable or unbound builds are
     * not current; callers refuse with `sources-current` instead of selecting
     * or reviewing them. Never throws for a stale tree.
     */
    readonly buildIsCurrent: (root: string, buildId: string) => Effect.Effect<boolean>;
    /** Snapshots the source and opens a round before the repair child writes. */
    readonly begin: (
      root: string,
      input?: GameRoundBeginInput,
    ) => Effect.Effect<GameReviewRoundType, GameOperationError>;
    /** Records the tree the repair child left behind, before any later edit. */
    readonly recordPostRepair: (
      root: string,
      roundId: string,
    ) => Effect.Effect<GameReviewRoundType, GameOperationError>;
    /** Marks the round as one the repair child may have written in. */
    readonly recordRepairStart: (
      root: string,
      roundId: string,
    ) => Effect.Effect<GameReviewRoundType, GameOperationError>;
    /** Records what a review found and how it judged the challenger. */
    readonly recordReview: (
      root: string,
      roundId: string,
      input: GameRoundReviewInput,
    ) => Effect.Effect<GameReviewRoundType, GameOperationError>;
    /** Names the candidate a round's export produced. */
    readonly recordCandidate: (
      root: string,
      roundId: string,
      artifact: GameReviewArtifact,
    ) => Effect.Effect<GameReviewRoundType, GameOperationError>;
    /** Makes a build the one Play serves, without a round (a direct publish). */
    readonly select: (
      root: string,
      artifact: GameReviewArtifact,
    ) => Effect.Effect<GameSelectedBuild, GameOperationError>;
    /** Switches the selected build to the round's candidate, if its bytes still match. */
    readonly promote: (
      root: string,
      roundId: string,
      options?: GamePromoteOptions,
    ) => Effect.Effect<GamePromotion, GameOperationError>;
    /** Restores the pre-repair snapshot and drops an unreferenced candidate build. */
    readonly reject: (
      root: string,
      roundId: string,
      options?: {
        /** Directories a live preview still serves; they are never deleted. */
        readonly preserveDirectories?: readonly string[] | undefined;
        /** The exact reason the round was rejected, kept as provenance. */
        readonly reason?: string | undefined;
        /** A safety rollback after an unfinished review carries no game judgment. */
        readonly decision?: "reject" | "stop" | undefined;
      },
    ) => Effect.Effect<GameRejection, GameOperationError>;
    /**
     * A requested return to the pre-repair version. Stops the running round,
     * snapshots the current version first, and then restores.
     */
    readonly restore: (
      root: string,
      roundId: string,
      options?: GameRoundRestoreOptions,
    ) => Effect.Effect<GameRestore, GameOperationError>;
    /** Ends one round without touching the folder or the selection. */
    readonly stop: (
      root: string,
      roundId: string,
      reason?: string,
    ) => Effect.Effect<GameReviewRoundType, GameOperationError>;
    /** Ends whichever round is open; the caller is about to supersede it. */
    readonly stopRunning: (
      root: string,
      reason?: string,
    ) => Effect.Effect<readonly GameReviewRoundType[], GameOperationError>;
    /** Marks every unfinished round interrupted; the selected build is kept. */
    readonly recover: (
      root: string,
    ) => Effect.Effect<readonly GameReviewRoundType[], GameOperationError>;
  }
>()("t3/game/GameRoundStore") {}

export const layer = (options: { readonly stateDir: string }) => {
  return Layer.effect(
    GameRoundStore,
    Effect.gen(function* () {
      const snapshots = yield* GameSnapshots.GameSnapshots;
      const location = (root: string) => gameRecordLocation(options.stateDir, "game-rounds", root);
      const migrate = (root: string) =>
        attempt("read game rounds", root, async () => {
          const found = await location(root);
          await migrateGameRecord(found).catch(() => false);
          return found;
        });
      const readState = async (file: string): Promise<StoredState> => {
        const text = await readRecordText(file);
        if (text === null) return { schemaVersion: 1, selected: null, rounds: [] };
        try {
          return decodeState(text);
        } catch (cause) {
          throw failure(
            "read game rounds",
            file,
            "io",
            "The review record is unreadable; selection is unknown until it is repaired.",
            cause,
          );
        }
      };
      const writeState = async (file: string, state: StoredState) => {
        const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
        await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
        try {
          await NodeFSP.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
          await NodeFSP.rename(temporary, file);
        } finally {
          await NodeFSP.rm(temporary, { force: true });
        }
      };
      const readStateEffect = (file: string) =>
        attempt("read game rounds", file, () => readState(file));
      const writeStateEffect = (file: string, state: StoredState) =>
        attempt("write game rounds", file, () => writeState(file, state));

      // One semaphore per canonical root. The map is only touched
      // synchronously, so two first calls cannot each create their own lock.
      const locks = new Map<string, Semaphore.Semaphore>();
      const lockFor = (key: string) => {
        const existing = locks.get(key);
        if (existing !== undefined) return existing;
        const created = Semaphore.makeUnsafe(1);
        locks.set(key, created);
        return created;
      };
      /**
       * A transition is one uninterruptible section once it starts. A pending
       * cancellation is observed before the first write; after that, the caller
       * waits for the transition to finish instead of abandoning half of it.
       */
      const critical = <A, E>(effect: Effect.Effect<A, E>) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* restore(Effect.yieldNow);
            return yield* effect;
          }),
        );
      const withLock = <A, E>(
        root: string,
        operation: string,
        work: (found: GameRecordLocation) => Effect.Effect<A, E>,
      ) =>
        Effect.gen(function* () {
          const found = yield* migrate(root);
          const lock = lockFor(found.canonicalRoot);
          return yield* lock.withPermits(1)(critical(work(found)));
        });

      // Recovery is a startup act: a round this process opened is live, not
      // interrupted. One pass per game per server process, so a read cannot
      // interrupt the round it is observing.
      const recovered = new Set<string>();
      const recoverLocked = (
        found: GameRecordLocation,
      ): Effect.Effect<readonly GameReviewRoundType[], GameOperationError> =>
        Effect.gen(function* () {
          const state = yield* readStateEffect(found.file);
          if (recovered.has(found.canonicalRoot)) return [];
          recovered.add(found.canonicalRoot);
          const at = DateTime.formatIso(yield* DateTime.now);
          const interrupted: GameReviewRoundType[] = [];
          const rounds = state.rounds.map((round) => {
            if (round.status !== "running") return round;
            const stopped: GameReviewRoundType = {
              ...round,
              status: "interrupted",
              finishedAt: at,
              decision: "interrupt",
              reason:
                "The server restarted before this round finished. The selected build was kept; the game folder is as the repair left it.",
            };
            interrupted.push(stopped);
            return stopped;
          });
          if (interrupted.length > 0) yield* writeStateEffect(found.file, { ...state, rounds });
          return interrupted;
        });

      const roundById = (state: StoredState, roundId: string, operation: string) => {
        const round = state.rounds.find((entry) => entry.id === roundId);
        if (round === undefined)
          throw failure(
            operation,
            roundId,
            "invalid-input",
            "That round is not in this game's record.",
          );
        return round;
      };
      const terminal = (
        round: GameReviewRoundType,
        status: "stopped" | "rejected",
        decision: "stop" | "reject",
        reason: string,
        at: string,
        extras: Partial<GameReviewRoundType> = {},
      ): GameReviewRoundType => ({
        ...round,
        ...extras,
        status,
        finishedAt: at,
        decision,
        reason,
      });
      const replaceRound = (state: StoredState, round: GameReviewRoundType): StoredState => ({
        ...state,
        rounds: state.rounds.map((entry) => (entry.id === round.id ? round : entry)),
      });
      const stopLocked = (
        state: StoredState,
        round: GameReviewRoundType,
        reason: string,
        at: string,
      ): { readonly state: StoredState; readonly round: GameReviewRoundType } => {
        if (round.status !== "running") return { state, round };
        const stopped = terminal(round, "stopped", "stop", reason, at);
        return { state: replaceRound(state, stopped), round: stopped };
      };

      /**
       * A candidate directory is shared by content-addressed identity: an
       * identical repair can name the selected directory itself. Delete only a
       * directory nothing else still points at.
       */
      const discardCandidate = (
        root: string,
        state: StoredState,
        candidate: GameReviewArtifact,
        preserve: readonly string[],
      ): Effect.Effect<readonly string[], GameOperationError> =>
        Effect.gen(function* () {
          const referenced = new Set<string>(preserve);
          if (state.selected !== null) referenced.add(state.selected.directory);
          for (const round of state.rounds) {
            if (round.candidate === null) continue;
            if (round.status === "rejected" || round.status === "promoted") continue;
            referenced.add(round.candidate.directory);
          }
          if (referenced.has(candidate.directory)) return [];
          const target = NodePath.join(root, candidate.directory);
          yield* attempt("discard game candidate", target, () =>
            NodeFSP.rm(target, { recursive: true, force: true }),
          );
          return [candidate.directory];
        });

      const exportFile = (root: string, buildId: string) =>
        Effect.gen(function* () {
          if (!/^[0-9a-f]{64}$/.test(buildId))
            return yield* failure(
              "read exported build",
              root,
              "invalid-input",
              "Invalid build hash.",
            );
          const found = yield* attempt("read exported build", root, () => location(root));
          return NodePath.join(
            NodePath.dirname(found.file),
            NodePath.basename(found.file, ".json"),
            `${buildId}.json`,
          );
        });
      const readExport = (root: string, buildId: string) =>
        Effect.gen(function* () {
          const file = yield* exportFile(root, buildId);
          return yield* attempt("read exported build", file, async () => {
            const text = await readRecordText(file);
            return text === null ? null : decodeExport(text);
          });
        });
      const writeExport = (root: string, buildId: string, record: typeof StoredExport.Type) =>
        Effect.gen(function* () {
          const file = yield* exportFile(root, buildId);
          yield* attempt("record exported build", file, async () => {
            await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
            const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
            try {
              await NodeFSP.writeFile(temporary, `${JSON.stringify(record)}\n`);
              await NodeFSP.rename(temporary, file);
            } finally {
              await NodeFSP.rm(temporary, { force: true });
            }
          });
        });

      return GameRoundStore.of({
        read: (root) =>
          withLock(root, "read game rounds", (found) =>
            Effect.gen(function* () {
              yield* recoverLocked(found);
              const state = yield* readStateEffect(found.file);
              return {
                selected: state.selected,
                rounds: state.rounds,
                ...(state.submissions === undefined ? {} : { submissions: state.submissions }),
                ...(state.production === undefined ? {} : { production: state.production }),
              };
            }),
          ),
        recordSubmission: (root, submission) =>
          withLock(root, "record game submission", (found) =>
            Effect.gen(function* () {
              const state = yield* readStateEffect(found.file);
              const submissions = [
                ...(state.submissions ?? []).filter(
                  (entry) => String(entry.runId) !== String(submission.runId),
                ),
                submission,
              ].slice(-MAX_STORED_SUBMISSIONS);
              yield* writeStateEffect(found.file, { ...state, submissions });
              return submission;
            }),
          ),
        recordProduction: (root, input) =>
          withLock(root, "record game production", (found) =>
            Effect.gen(function* () {
              const state = yield* readStateEffect(found.file);
              const previous = state.production ?? null;
              const sameTurn =
                previous !== null &&
                previous.runId !== null &&
                String(previous.runId) === String(input.runId);
              const production = {
                firstPlayableAt: previous?.firstPlayableAt ?? input.at,
                firstPlayableBuildId: previous?.firstPlayableBuildId ?? input.buildId,
                runId: input.runId,
                turnFirstSubmitAt: sameTurn ? previous.turnFirstSubmitAt : input.at,
                turnLastSubmitAt: input.at,
                submissions: sameTurn ? previous.submissions + 1 : 1,
              } satisfies GameProduction;
              yield* writeStateEffect(found.file, { ...state, production });
              return production;
            }),
          ),
        recordExport: (root, artifact) =>
          withLock(root, "record exported build", () =>
            Effect.gen(function* () {
              validatedArtifact(artifact);
              if (artifact.sourceId === null)
                return yield* failure(
                  "record exported build",
                  root,
                  "invalid-input",
                  "The export has no source manifest.",
                );
              const existing = yield* readExport(root, artifact.buildId);
              if (existing !== null) return;
              yield* writeExport(root, artifact.buildId, { artifact, playtest: null });
            }),
          ),
        exported: (root, buildId) =>
          Effect.gen(function* () {
            const recorded = yield* readExport(root, buildId);
            if (recorded === null) return null;
            const artifact = validatedArtifact(recorded.artifact);
            if (artifact.buildId !== buildId || artifact.sourceId === null)
              return yield* failure(
                "read exported build",
                root,
                "invalid-input",
                "The export's build/source binding is invalid.",
              );
            const stored = yield* snapshots.read(root, artifact.sourceId);
            const sourceDirectory = NodePath.join(stored.directory, "files");
            const actual = yield* snapshots.capture(sourceDirectory);
            if (
              actual.sourceId !== artifact.sourceId ||
              GameSnapshots.gameSourceId(stored.manifest.files) !== artifact.sourceId
            )
              return yield* failure(
                "read exported build",
                root,
                "invalid-input",
                "The export's recorded source manifest or snapshot changed.",
              );
            return { ...recorded, sourceDirectory };
          }),
        recordBuildPlaytest: (root, buildId, playtest) =>
          withLock(root, "record build playtest", () =>
            Effect.gen(function* () {
              const recorded = yield* readExport(root, buildId);
              if (recorded !== null) yield* writeExport(root, buildId, { ...recorded, playtest });
            }),
          ),
        sourceId: (root) =>
          snapshots.capture(root).pipe(Effect.map((manifest) => manifest.sourceId)),
        freeze: (root) =>
          snapshots.store(root).pipe(
            Effect.map((stored) => ({
              directory: stored.directory,
              sourceId: stored.manifest.sourceId,
            })),
          ),
        frozenSourceId: (directory) =>
          snapshots.capture(directory).pipe(Effect.map((manifest) => manifest.sourceId)),
        buildIsCurrent: (root, buildId) =>
          Effect.gen(function* () {
            if (!/^[0-9a-f]{64}$/.test(buildId)) return false;
            const recorded = yield* readExport(root, buildId).pipe(
              Effect.orElseSucceed(() => null),
            );
            if (recorded === null) return false;
            let artifact: GameReviewArtifact;
            try {
              artifact = validatedArtifact(recorded.artifact);
            } catch {
              return false;
            }
            if (artifact.buildId !== buildId || artifact.sourceId === null) return false;
            const current = yield* Effect.result(snapshots.capture(root));
            if (current._tag === "Failure") return false;
            if (current.success.sourceId === artifact.sourceId) return true;
            return yield* sameBuildInputs(snapshots, {
              root,
              candidateSourceId: artifact.sourceId,
              current: current.success,
            }).pipe(Effect.orElseSucceed(() => false));
          }),
        begin: (root, input) =>
          withLock(root, "begin game review round", (found) =>
            Effect.gen(function* () {
              yield* recoverLocked(found);
              const before = yield* readStateEffect(found.file);
              if (before.rounds.some((round) => round.status === "running"))
                return yield* failure(
                  "begin game review round",
                  root,
                  "busy",
                  "Another repair round is already open for this game.",
                );
              // Snapshot inside the lock: no transition can move selection while
              // the round's incumbent identities are being read.
              const snapshot = yield* snapshots.store(root);
              const state = yield* readStateEffect(found.file);
              if (state.rounds.some((round) => round.status === "running"))
                return yield* failure(
                  "begin game review round",
                  root,
                  "busy",
                  "Another repair round is already open for this game.",
                );
              const at = DateTime.formatIso(yield* DateTime.now);
              const created: GameReviewRoundType = {
                schemaVersion: 1,
                id: NodeCrypto.randomUUID(),
                threadId: input?.threadId ?? null,
                status: "running",
                startedAt: at,
                finishedAt: null,
                incumbentSnapshotId: snapshot.manifest.sourceId,
                incumbentSourceId: state.selected?.sourceId ?? snapshot.manifest.sourceId,
                incumbentBuildId: state.selected?.buildId ?? null,
                postRepairSourceId: null,
                candidate: null,
                ...(input?.loopId === undefined ? {} : { loopId: input.loopId }),
                ...(input?.builderSelection === undefined
                  ? {}
                  : { builderSelection: input.builderSelection }),
                ...(input?.reviewSelection === undefined
                  ? {}
                  : { reviewSelection: input.reviewSelection }),
                ...(input?.defects === undefined ? {} : { defects: [...input.defects] }),
                ...(input?.doNotRegress === undefined
                  ? {}
                  : { doNotRegress: [...input.doNotRegress] }),
                budget: input?.budget ?? DEFAULT_GAME_REVIEW_BUDGET,
              };
              const retained: StoredState = {
                ...state,
                rounds: [created, ...state.rounds].slice(0, MAX_STORED_ROUNDS),
              };
              yield* writeStateEffect(found.file, retained);
              // Expired history must not retain exports that no round, selection or preview uses.
              for (const dropped of [created, ...state.rounds].slice(MAX_STORED_ROUNDS)) {
                if (dropped.candidate === null) continue;
                yield* Effect.suspend(() =>
                  discardCandidate(
                    root,
                    retained,
                    validatedArtifact(dropped.candidate!),
                    input?.preserveDirectories ?? [],
                  ),
                ).pipe(
                  Effect.catchCause(() =>
                    Effect.logWarning("discarding an evicted review candidate failed", {
                      roundId: dropped.id,
                    }),
                  ),
                  Effect.asVoid,
                );
              }
              return created;
            }),
          ),
        recordPostRepair: (root, roundId) =>
          withLock(root, "record game review repair", (found) =>
            Effect.gen(function* () {
              const state = yield* readStateEffect(found.file);
              const current = roundById(state, roundId, "record game review repair");
              if (current.status !== "running")
                return yield* failure(
                  "record game review repair",
                  roundId,
                  "invalid-input",
                  "That round is no longer running.",
                );
              const manifest = yield* snapshots.capture(root);
              const round = { ...current, postRepairSourceId: manifest.sourceId };
              yield* writeStateEffect(found.file, replaceRound(state, round));
              return round;
            }),
          ),
        recordRepairStart: (root, roundId) =>
          withLock(root, "record game review repair start", (found) =>
            Effect.gen(function* () {
              const state = yield* readStateEffect(found.file);
              const current = roundById(state, roundId, "record game review repair start");
              if (current.status !== "running")
                return yield* failure(
                  "record game review repair start",
                  roundId,
                  "invalid-input",
                  "That round is no longer running.",
                );
              const round = {
                ...current,
                repairStartedAt: DateTime.formatIso(yield* DateTime.now),
              };
              yield* writeStateEffect(found.file, replaceRound(state, round));
              return round;
            }),
          ),
        recordReview: (root, roundId, input) =>
          withLock(root, "record game review", (found) =>
            Effect.gen(function* () {
              const state = yield* readStateEffect(found.file);
              const current = roundById(state, roundId, "record game review");
              if (current.status !== "running")
                return yield* failure(
                  "record game review",
                  roundId,
                  "invalid-input",
                  "That round is no longer running.",
                );
              const round: GameReviewRoundType = {
                ...current,
                ...(input.childUsage === undefined ? {} : { childUsage: input.childUsage }),
                ...(input.usageByRole === undefined ? {} : { usageByRole: input.usageByRole }),
                ...(input.fundamentals === undefined ? {} : { fundamentals: input.fundamentals }),
                ...(input.requirements === undefined
                  ? {}
                  : { requirements: [...input.requirements] }),
                ...(input.requirementsIncomplete === undefined
                  ? {}
                  : { requirementsIncomplete: input.requirementsIncomplete }),
                ...(input.downgradedRequirements === undefined
                  ? {}
                  : { downgradedRequirements: [...input.downgradedRequirements] }),
                ...(input.quality === undefined ? {} : { quality: input.quality }),
                ...(input.qualityRubricVersion === undefined
                  ? {}
                  : { qualityRubricVersion: input.qualityRubricVersion }),
                ...(input.qualityCoverage === undefined
                  ? {}
                  : { qualityCoverage: input.qualityCoverage }),
                ...(input.defects === undefined ? {} : { defects: [...input.defects] }),
                ...(input.doNotRegress === undefined
                  ? {}
                  : { doNotRegress: [...input.doNotRegress] }),
                ...(input.checks === undefined ? {} : { checks: [...input.checks] }),
                ...(input.experiments === undefined ? {} : { experiments: [...input.experiments] }),
                ...(input.candidateChecks === undefined
                  ? {}
                  : { candidateChecks: [...input.candidateChecks] }),
                ...(input.mechanicalVeto === undefined
                  ? {}
                  : { mechanicalVeto: input.mechanicalVeto }),
                ...(input.submissionNote === undefined
                  ? {}
                  : { submissionNote: input.submissionNote }),
                ...(input.ballots === undefined ? {} : { ballots: [...input.ballots] }),
                ...(input.ballotAnswers === undefined
                  ? {}
                  : { ballotAnswers: [...input.ballotAnswers] }),
              };
              yield* writeStateEffect(found.file, replaceRound(state, round));
              return round;
            }),
          ),
        recordCandidate: (root, roundId, artifact) =>
          withLock(root, "record game review candidate", (found) =>
            Effect.gen(function* () {
              const candidate = validatedArtifact(artifact);
              const state = yield* readStateEffect(found.file);
              const current = roundById(state, roundId, "record game review candidate");
              if (current.status !== "running")
                return yield* failure(
                  "record game review candidate",
                  roundId,
                  "invalid-input",
                  "That round is no longer running; an expired round cannot record a candidate.",
                );
              const round = { ...current, candidate };
              yield* writeStateEffect(found.file, replaceRound(state, round));
              return round;
            }),
          ),
        select: (root, artifact) =>
          withLock(root, "select game build", (found) =>
            Effect.gen(function* () {
              const build = validatedArtifact(artifact);
              const state = yield* readStateEffect(found.file);
              const running = state.rounds.find((round) => round.status === "running");
              if (running !== undefined)
                return yield* failure(
                  "select game build",
                  root,
                  "busy",
                  "A repair round is open; a direct publish would replace the build it is reviewing.",
                );
              const selected: GameSelectedBuild = {
                ...build,
                promotedAt: DateTime.formatIso(yield* DateTime.now),
                roundId: null,
              };
              yield* writeStateEffect(found.file, { ...state, selected });
              return selected;
            }),
          ),
        promote: (root, roundId, promoteOptions) =>
          withLock(root, "promote game review build", (found) =>
            Effect.gen(function* () {
              const state = yield* readStateEffect(found.file);
              const round = roundById(state, roundId, "promote game review build");
              const at = DateTime.formatIso(yield* DateTime.now);
              const blocked = (detail: string): Effect.Effect<GamePromotion, GameOperationError> =>
                Effect.gen(function* () {
                  const stopped = stopLocked(state, round, detail, at);
                  if (stopped.state !== state) yield* writeStateEffect(found.file, stopped.state);
                  return { kind: "blocked" as const, round: stopped.round, detail };
                });
              if (round.status !== "running" || round.candidate === null)
                return yield* blocked("That round has no running candidate build to promote.");
              const candidate = validatedArtifact(round.candidate);
              // The directory name is the hash of the candidate's bytes. Re-derive
              // it the way explicit Play does: a file changed after the export
              // must not become the build Play serves.
              const hashed = yield* Effect.tryPromise(() =>
                hashWebBuild(root, candidate.directory),
              ).pipe(Effect.orElseSucceed(() => null));
              if (hashed === null || hashed.buildId !== candidate.buildId)
                return yield* blocked(
                  "artifact-changed: the candidate build's files are no longer the bytes it was exported as; the candidate was not promoted.",
                );
              // A folder that cannot be read is a failed precondition, not a
              // crash: the round stops with the reason instead of staying
              // running against sources nobody could check.
              const captured = yield* Effect.result(snapshots.capture(root));
              if (captured._tag === "Failure")
                return yield* blocked(
                  `The game folder could not be read to check the candidate, so the round was stopped. ${captured.failure.message}`,
                );
              const current = captured.success;
              // The candidate was built from these sources. If the folder moved
              // on, promoting would serve bytes the current game did not produce.
              // Only build inputs count: a note or design edit after the export
              // does not change a single byte a rebuild would produce.
              if (
                candidate.sourceId !== null &&
                current.sourceId !== candidate.sourceId &&
                !(yield* sameBuildInputs(snapshots, {
                  root,
                  candidateSourceId: candidate.sourceId,
                  current,
                }))
              )
                return yield* blocked(
                  "source-changed: the game folder changed after the candidate build; the candidate was not promoted.",
                );
              // A newer publication supersedes this round's evidence. Its
              // incumbent is the selection the round opened against.
              if ((state.selected?.buildId ?? null) !== round.incumbentBuildId)
                return yield* blocked(
                  "The selected build changed after this round opened; the older candidate was not promoted.",
                );
              const refused =
                promoteOptions?.guard === undefined ? null : yield* promoteOptions.guard;
              if (refused !== null) return yield* blocked(refused);
              const selected: GameSelectedBuild = {
                ...candidate,
                promotedAt: at,
                roundId,
              };
              const record: GameReviewRoundType = {
                ...round,
                status: "promoted",
                finishedAt: at,
                decision: "promote",
                reason: "The candidate build won the round and is now what Play serves.",
              };
              yield* writeStateEffect(found.file, {
                ...replaceRound(state, record),
                selected,
              });
              // Inside the lock: the preview follows this selection before any
              // other transition can move it.
              if (promoteOptions?.serve !== undefined) yield* promoteOptions.serve(selected);
              return { kind: "promoted", selected };
            }),
          ),
        reject: (root, roundId, rejectOptions) =>
          withLock(root, "reject game review build", (found) =>
            Effect.gen(function* () {
              const state = yield* readStateEffect(found.file);
              const round = roundById(state, roundId, "reject game review build");
              const at = DateTime.formatIso(yield* DateTime.now);
              const stopped = (detail: string): Effect.Effect<GameRejection, GameOperationError> =>
                Effect.gen(function* () {
                  const stoppedRound = terminal(round, "stopped", "stop", detail, at);
                  yield* writeStateEffect(found.file, replaceRound(state, stoppedRound));
                  return { kind: "blocked", round: stoppedRound, detail };
                });
              if (round.status !== "running")
                return yield* failure(
                  "reject game review build",
                  roundId,
                  "invalid-input",
                  "That round is no longer running.",
                );
              if (round.postRepairSourceId === null)
                return yield* stopped(
                  "The server never read the folder after the repair, so it cannot tell an edit from the repair itself; the previous version was not restored.",
                );
              const current = yield* snapshots.capture(root);
              if (current.sourceId !== round.postRepairSourceId)
                return yield* stopped(
                  "The game folder changed after the repair finished, so the previous version was not restored. The snapshot and candidate are kept.",
                );
              const snapshot = yield* snapshots.read(root, round.incumbentSnapshotId);
              const restored = yield* snapshots.restore(root, snapshot.manifest, {
                expectSourceId: round.postRepairSourceId,
              });
              if (restored.kind === "blocked") return yield* stopped(restored.detail);
              const decision = rejectOptions?.decision ?? "reject";
              const rejected = terminal(
                { ...round, restoredAt: at },
                decision === "stop" ? "stopped" : "rejected",
                decision,
                rejectOptions?.reason ??
                  (decision === "stop"
                    ? "The review stopped before a decision; the previous source snapshot was restored."
                    : "The round was rejected; the previous source snapshot was restored."),
                at,
              );
              yield* writeStateEffect(found.file, replaceRound(state, rejected));
              const discarded =
                round.candidate === null
                  ? []
                  : yield* discardCandidate(
                      root,
                      replaceRound(state, rejected),
                      validatedArtifact(round.candidate),
                      rejectOptions?.preserveDirectories ?? [],
                    );
              return {
                kind: "rejected",
                round: rejected,
                restored: restored.restored,
                deleted: restored.deleted,
                discarded,
              };
            }),
          ),
        restore: (root, roundId, restoreOptions) =>
          withLock(root, "restore game review version", (found) =>
            Effect.gen(function* () {
              const state = yield* readStateEffect(found.file);
              const round = roundById(state, roundId, "restore game review version");
              if (
                round.status === "promoted" ||
                round.status === "rejected" ||
                round.restoredAt !== undefined
              )
                return yield* failure(
                  "restore game review version",
                  roundId,
                  "invalid-input",
                  "That round is already closed; there is no repair version to return from.",
                );
              // Another round owns the folder. Rewriting it here would leave
              // that repair authorized against sources it never produced.
              const owner = state.rounds.find(
                (entry) => entry.status === "running" && entry.id !== round.id,
              );
              if (owner !== undefined) return { kind: "busy", owner };
              const at = DateTime.formatIso(yield* DateTime.now);
              // Joining owned work means no round stays open while the folder is
              // rewritten; the caller's request is the newer decision.
              const joined = stopLocked(
                state,
                round,
                "An explicit restore superseded this round before the folder was rewritten.",
                at,
              );
              let stoppedState = state;
              if (joined.state !== state) {
                yield* writeStateEffect(found.file, joined.state);
                stoppedState = joined.state;
              }
              // Preserve the version about to be replaced before touching it.
              const preserved = yield* snapshots.store(root);
              const preservedRound = {
                ...joined.round,
                preRestoreSnapshotId: preserved.manifest.sourceId,
              };
              yield* writeStateEffect(found.file, replaceRound(stoppedState, preservedRound));
              const recordedState = replaceRound(stoppedState, preservedRound);
              if (restoreOptions?.beforeRestore !== undefined)
                yield* attempt("restore game review version", root, restoreOptions.beforeRestore);
              const snapshot = yield* snapshots.read(root, round.incumbentSnapshotId);
              // The preserved version is the accepted baseline: an edit that
              // arrived after it was taken must not become the thing this
              // restore silently overwrites.
              const restored = yield* snapshots.restore(root, snapshot.manifest, {
                expectSourceId: preserved.manifest.sourceId,
              });
              if (restored.kind === "blocked")
                return { kind: "blocked", round: preservedRound, detail: restored.detail };
              const restoredRound = terminal(
                { ...preservedRound, restoredAt: DateTime.formatIso(yield* DateTime.now) },
                "rejected",
                "reject",
                `The previous version was restored on request; the version it replaced is kept as snapshot ${preserved.manifest.sourceId}.`,
                DateTime.formatIso(yield* DateTime.now),
              );
              yield* writeStateEffect(found.file, replaceRound(recordedState, restoredRound));
              const discarded =
                restoredRound.candidate === null
                  ? []
                  : yield* discardCandidate(
                      root,
                      replaceRound(recordedState, restoredRound),
                      validatedArtifact(restoredRound.candidate),
                      restoreOptions?.preserveDirectories ?? [],
                    );
              return {
                kind: "restored",
                round: restoredRound,
                restored: restored.restored,
                deleted: restored.deleted,
                discarded,
                preservedSnapshotId: preserved.manifest.sourceId,
              };
            }),
          ),
        stop: (root, roundId, reason) =>
          withLock(root, "stop game review round", (found) =>
            Effect.gen(function* () {
              const state = yield* readStateEffect(found.file);
              const round = roundById(state, roundId, "stop game review round");
              const at = DateTime.formatIso(yield* DateTime.now);
              const stopped = stopLocked(
                state,
                round,
                reason ?? "The round was stopped before it finished.",
                at,
              );
              if (stopped.state !== state) yield* writeStateEffect(found.file, stopped.state);
              return stopped.round;
            }),
          ),
        stopRunning: (root, reason) =>
          withLock(root, "stop game review round", (found) =>
            Effect.gen(function* () {
              const state = yield* readStateEffect(found.file);
              const at = DateTime.formatIso(yield* DateTime.now);
              const stoppedRounds: GameReviewRoundType[] = [];
              const rounds = state.rounds.map((round) => {
                if (round.status !== "running") return round;
                const stoppedRound = terminal(
                  round,
                  "stopped",
                  "stop",
                  reason ?? "The round was stopped before it finished.",
                  at,
                );
                stoppedRounds.push(stoppedRound);
                return stoppedRound;
              });
              if (stoppedRounds.length > 0)
                yield* writeStateEffect(found.file, { ...state, rounds });
              return stoppedRounds;
            }),
          ),
        recover: (root) =>
          withLock(root, "recover game rounds", (found) =>
            Effect.gen(function* () {
              recovered.delete(found.canonicalRoot);
              return yield* recoverLocked(found);
            }),
          ),
      });
    }),
  ).pipe(Layer.provide(GameSnapshots.layer({ stateDir: options.stateDir })));
};
