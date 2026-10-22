// @effect-diagnostics nodeBuiltinImport:off -- Rounds and the selected build live in the server's native store.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  DEFAULT_GAME_REVIEW_BUDGET,
  GameOperationError,
  GameReviewRound,
  GameSelectedBuild,
  type GameReviewArtifact,
  type GameReviewBudget,
  type GameReviewRound as GameReviewRoundType,
  type GameReviewState as GameReviewStateType,
  type ThreadId,
} from "@t3tools/contracts";
import * as GameSnapshots from "./GameSnapshots.ts";
import { gameRecordLocation, migrateGameRecord, readRecordText } from "./gameRecord.ts";
import { candidateBuildId } from "./webBuild.ts";

const StoredState = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  selected: Schema.NullOr(GameSelectedBuild),
  rounds: Schema.Array(GameReviewRound),
});
type StoredState = typeof StoredState.Type;
const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(StoredState));

/** A completed-round history is provenance, not a log; keep the recent window small. */
const MAX_STORED_ROUNDS = 50;

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

export interface GameRoundBeginInput {
  readonly threadId?: ThreadId | undefined;
  readonly budget?: GameReviewBudget | undefined;
}

export type GamePromotion =
  | { readonly kind: "promoted"; readonly selected: GameSelectedBuild }
  | { readonly kind: "blocked"; readonly detail: string };

export type GameRejection =
  | {
      readonly kind: "rejected";
      readonly round: GameReviewRoundType;
      readonly restored: readonly string[];
      readonly deleted: readonly string[];
    }
  | {
      /**
       * The folder changed after the server last read it. Nothing was restored
       * and the snapshot stays, so a user edit was never overwritten.
       */
      readonly kind: "blocked";
      readonly round: GameReviewRoundType;
      readonly detail: string;
    };

export class GameRoundStore extends Context.Service<
  GameRoundStore,
  {
    /** The selected build and recent rounds, recovering interrupted rounds first. */
    readonly read: (root: string) => Effect.Effect<GameReviewStateType, GameOperationError>;
    /** The byte-accurate source identity round decisions use. */
    readonly sourceId: (root: string) => Effect.Effect<string, GameOperationError>;
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
    /** Switches the selected build to the round's candidate. */
    readonly promote: (
      root: string,
      roundId: string,
    ) => Effect.Effect<GamePromotion, GameOperationError>;
    /** Restores the pre-repair snapshot and drops the candidate build. */
    readonly reject: (
      root: string,
      roundId: string,
    ) => Effect.Effect<GameRejection, GameOperationError>;
    /** Marks every unfinished round interrupted; the selected build is kept. */
    readonly recover: (
      root: string,
    ) => Effect.Effect<readonly GameReviewRoundType[], GameOperationError>;
  }
>()("t3/game/GameRoundStore") {}

export const layer = (options: { readonly stateDir: string }) => {
  const writes = new Map<string, Promise<void>>();
  const serialized = (key: string, work: () => Promise<void>) => {
    const previous = writes.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    writes.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  };

  return Layer.effect(
    GameRoundStore,
    Effect.gen(function* () {
      const snapshots = yield* GameSnapshots.GameSnapshots;
      const location = async (root: string) => {
        const found = await gameRecordLocation(options.stateDir, "game-rounds", root);
        await migrateGameRecord(found).catch(() => false);
        return found;
      };
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
      const update = async <A>(
        root: string,
        work: (state: StoredState) => { readonly state: StoredState; readonly value: A },
      ): Promise<A> => {
        const found = await location(root);
        let value!: A;
        await serialized(found.canonicalRoot, async () => {
          const result = work(await readState(found.file));
          value = result.value;
          await writeState(found.file, result.state);
        });
        return value;
      };
      // Recovery is a startup act: a round this process opened is live, not
      // interrupted. One pass per game per server process, so a read cannot
      // interrupt the round it is observing.
      const recovered = new Set<string>();
      const recoverOnce = async (root: string) => {
        const found = await location(root);
        if (recovered.has(found.canonicalRoot)) return [];
        recovered.add(found.canonicalRoot);
        return recover(root);
      };
      const recover = async (root: string): Promise<readonly GameReviewRoundType[]> => {
        const found = await location(root);
        let interrupted: GameReviewRoundType[] = [];
        await serialized(found.canonicalRoot, async () => {
          const state = await readState(found.file);
          const at = DateTime.formatIso(DateTime.nowUnsafe());
          const rounds = state.rounds.map((round) => {
            if (round.status !== "running") return round;
            interrupted = [
              ...interrupted,
              {
                ...round,
                status: "interrupted",
                finishedAt: at,
                decision: "interrupt",
                reason:
                  "The server restarted before this round finished. The selected build was kept; the game folder is as the repair left it.",
              },
            ];
            return interrupted.at(-1)!;
          });
          if (interrupted.length > 0) await writeState(found.file, { ...state, rounds });
        });
        return interrupted;
      };
      return GameRoundStore.of({
        read: (root) =>
          attempt("read game rounds", root, async () => {
            await recoverOnce(root);
            const found = await location(root);
            const state = await readState(found.file);
            return { selected: state.selected, rounds: state.rounds };
          }),
        sourceId: (root) =>
          attempt("identity game source", root, async () => {
            const manifest = await snapshots.capture(root).pipe(Effect.runPromise);
            return manifest.sourceId;
          }),
        begin: (root, input) =>
          attempt("begin game review round", root, async () => {
            await recoverOnce(root);
            const found = await location(root);
            const before = await readState(found.file);
            if (before.rounds.some((round) => round.status === "running"))
              throw failure(
                "begin game review round",
                root,
                "busy",
                "Another repair round is already open for this game.",
              );
            const snapshot = await snapshots.store(root).pipe(Effect.runPromise);
            let created: GameReviewRoundType | null = null;
            await serialized(found.canonicalRoot, async () => {
              const state = await readState(found.file);
              if (state.rounds.some((round) => round.status === "running"))
                throw failure(
                  "begin game review round",
                  root,
                  "busy",
                  "Another repair round is already open for this game.",
                );
              const at = DateTime.formatIso(DateTime.nowUnsafe());
              created = {
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
                budget: input?.budget ?? DEFAULT_GAME_REVIEW_BUDGET,
              };
              await writeState(found.file, {
                ...state,
                rounds: [created, ...state.rounds].slice(0, MAX_STORED_ROUNDS),
              });
            });
            return created!;
          }),
        recordPostRepair: (root, roundId) =>
          attempt("record game review repair", root, async () => {
            const manifest = await snapshots.capture(root).pipe(Effect.runPromise);
            return update(root, (state) => {
              const current = state.rounds.find((round) => round.id === roundId);
              if (current === undefined)
                throw failure(
                  "record game review repair",
                  roundId,
                  "invalid-input",
                  "That round is not in this game's record.",
                );
              if (current.status !== "running")
                throw failure(
                  "record game review repair",
                  roundId,
                  "invalid-input",
                  "That round is no longer running.",
                );
              const round = { ...current, postRepairSourceId: manifest.sourceId };
              return {
                state: {
                  ...state,
                  rounds: state.rounds.map((entry) => (entry.id === roundId ? round : entry)),
                },
                value: round,
              };
            });
          }),
        recordCandidate: (root, roundId, artifact) =>
          attempt("record game review candidate", root, async () => {
            const candidate = validatedArtifact(artifact);
            return update(root, (state) => {
              const current = state.rounds.find((round) => round.id === roundId);
              if (current === undefined)
                throw failure(
                  "record game review candidate",
                  roundId,
                  "invalid-input",
                  "That round is not in this game's record.",
                );
              if (current.status !== "running")
                throw failure(
                  "record game review candidate",
                  roundId,
                  "invalid-input",
                  "That round is no longer running.",
                );
              const round = { ...current, candidate };
              return {
                state: {
                  ...state,
                  rounds: state.rounds.map((entry) => (entry.id === roundId ? round : entry)),
                },
                value: round,
              };
            });
          }),
        select: (root, artifact) =>
          attempt("select game build", root, async () => {
            const build = validatedArtifact(artifact);
            return update(root, (state) => {
              const selected: GameSelectedBuild = {
                ...build,
                promotedAt: DateTime.formatIso(DateTime.nowUnsafe()),
                roundId: null,
              };
              return { state: { ...state, selected }, value: selected };
            });
          }),
        promote: (root, roundId) =>
          attempt("promote game review build", root, async () => {
            const found = await location(root);
            const state = await readState(found.file);
            const round = state.rounds.find((entry) => entry.id === roundId);
            if (round === undefined || round.status !== "running" || round.candidate === null)
              return {
                kind: "blocked" as const,
                detail: "That round has no running candidate build to promote.",
              };
            const candidate = validatedArtifact(round.candidate);
            const current = await snapshots.capture(root).pipe(Effect.runPromise);
            // The candidate was built from these sources. If the folder moved on,
            // promoting would serve bytes the current game did not produce.
            if (candidate.sourceId !== null && current.sourceId !== candidate.sourceId)
              return {
                kind: "blocked" as const,
                detail:
                  "The game folder changed after the candidate build; the candidate was not promoted.",
              };
            const selected: GameSelectedBuild = {
              ...candidate,
              promotedAt: DateTime.formatIso(DateTime.nowUnsafe()),
              roundId,
            };
            await update(root, (latest) => ({
              state: {
                ...latest,
                selected,
                rounds: latest.rounds.map((entry) =>
                  entry.id === roundId
                    ? {
                        ...entry,
                        status: "promoted" as const,
                        finishedAt: selected.promotedAt,
                        decision: "promote" as const,
                        reason: "The candidate build won the round and is now what Play serves.",
                      }
                    : entry,
                ),
              },
              value: selected,
            }));
            return { kind: "promoted" as const, selected };
          }),
        reject: (root, roundId) =>
          attempt("reject game review build", root, async () => {
            const found = await location(root);
            const state = await readState(found.file);
            const round = state.rounds.find((entry) => entry.id === roundId);
            if (round === undefined)
              throw failure(
                "reject game review build",
                roundId,
                "invalid-input",
                "That round is not in this game's record.",
              );
            if (round.status !== "running")
              throw failure(
                "reject game review build",
                roundId,
                "invalid-input",
                "That round is no longer running.",
              );
            const stopped = async (detail: string): Promise<GameRejection> => {
              const at = DateTime.formatIso(DateTime.nowUnsafe());
              const updated: GameReviewRoundType = {
                ...round,
                status: "stopped",
                finishedAt: at,
                decision: "stop",
                reason: detail,
              };
              await update(root, (latest) => ({
                state: {
                  ...latest,
                  rounds: latest.rounds.map((entry) => (entry.id === roundId ? updated : entry)),
                },
                value: updated,
              }));
              return { kind: "blocked" as const, round: updated, detail };
            };
            if (round.postRepairSourceId === null)
              return stopped(
                "The server never read the folder after the repair, so it cannot tell an edit from the repair itself; the previous version was not restored.",
              );
            const current = await snapshots.capture(root).pipe(Effect.runPromise);
            if (current.sourceId !== round.postRepairSourceId)
              return stopped(
                "The game folder changed after the repair finished, so the previous version was not restored. The snapshot is kept.",
              );
            const snapshot = await snapshots
              .read(root, round.incumbentSnapshotId)
              .pipe(Effect.runPromise);
            const restored = await snapshots
              .restore(root, snapshot.manifest, {
                expectSourceId: round.postRepairSourceId,
              })
              .pipe(Effect.runPromise);
            if (restored.kind === "blocked") return stopped(restored.detail);
            if (round.candidate !== null) {
              const candidate = validatedArtifact(round.candidate);
              await NodeFSP.rm(NodePath.join(root, candidate.directory), {
                recursive: true,
                force: true,
              });
            }
            const at = DateTime.formatIso(DateTime.nowUnsafe());
            const rejected: GameReviewRoundType = {
              ...round,
              status: "rejected",
              finishedAt: at,
              decision: "reject",
              reason:
                "The round was rejected; the previous source snapshot was restored and the candidate build was discarded.",
            };
            await update(root, (latest) => ({
              state: {
                ...latest,
                rounds: latest.rounds.map((entry) => (entry.id === roundId ? rejected : entry)),
              },
              value: rejected,
            }));
            return {
              kind: "rejected" as const,
              round: rejected,
              restored: restored.restored,
              deleted: restored.deleted,
            };
          }),
        recover: (root) => attempt("recover game rounds", root, () => recover(root)),
      });
    }),
  ).pipe(Layer.provide(GameSnapshots.layer({ stateDir: options.stateDir })));
};
