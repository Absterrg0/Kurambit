// @effect-diagnostics nodeBuiltinImport:off -- A restore's request id is a hash of the caller's command id, as the run's restore makes it; a game's place in its repository is read from disk.
// The Builds rail, for the Game panel and the agent tools alike: every turn
// that changed the game (its T3 checkpoint, marked with the keep-going step it
// was) and every build of a stage-era run (its rounds, prototypes, stages and
// saved builds), newest first, each with what changed and its facts. Builds
// are not a record of their own: the list is read from the checkpoints and the
// run's records each time. A build plays and is measured in a copy of its own,
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
  type GameBuildComparison,
  type GameBuildFacts,
  GameBuildId,
  type GameBuildPlayResult,
  type GameBuildRef,
  GameBuildRestoreResult,
  type GameBuildsResult,
  type GameEngineId,
  type GameKeepValuesInput,
  type GameKeepValuesResult,
  GameOperationError,
  manifestProject,
  RESTORE_BEFORE_LABEL,
  type RunId,
  type ThreadId,
} from "@kurambit/contracts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { parseTurnDiffFilesFromNumstat } from "../checkpointing/Diffs.ts";
import { checkpointRefForGameRun, gameRunRefsFolder } from "../checkpointing/Utils.ts";
import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { type EarlierBuild, summaryOf, turnChangeBase } from "./buildFacts.ts";
import * as GameBuildCopies from "./GameBuildCopies.ts";
import * as GameFacts from "./GameFacts.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameRunControl from "./GameRunControl.ts";
import * as GameService from "./GameService.ts";
import { BuildName } from "./run/buildNames.ts";
import { engineProfile } from "./engineProfile.ts";
import { isRestored, measureChange, withBuildInFolder } from "./run/builds.ts";
import { projectStep, supersedeProposal } from "./run/inFlight.ts";
import { isFirstTurnLead } from "./scaffold.ts";
import { tuneFileText, tuneFileWith } from "./gameTune.ts";

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
 * A person's edit kept as a build outside a turn (the Stage's Keep as a
 * build): `edits/<request>-values` is the build, `edits/<request>-from` the
 * folder just before it, which restoring undoes it to.
 */
const EDITS = "edits/";
const VALUES_LABEL = "Values kept";
/** The folder as last compared with the build it was made from (folderEdited); no build of its own. */
const FOLDER_REF = CheckpointRef.make("refs/kurambit/game-builds/folder");
const MOVED_ON =
  "The game changed after the build this would undo, so nothing was restored and nothing was lost.";
/** Where a build with no known time sorts: last. */
const EPOCH = "1970-01-01T00:00:00.000Z";
const isoOfSeconds = (seconds: number) => DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000));
const TURN_REFS = "refs/kurambit/orchestration-v2/checkpoints/";
const MAX_FILES = 8;
const UNITY_NO_PLAY =
  "Unity builds play as a Linux player for facts and bots; the Game panel has no Unity Play yet.";
const isGameBuildId = Schema.is(GameBuildId);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

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
  /** How the run's restore names it: a kept round, a saved build's name, or its commit. */
  readonly handle: { readonly round: number } | { readonly build: string };
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
  const line =
    (text ?? "")
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
    readonly list: (
      threadId: ThreadId,
      input: { readonly before?: string | undefined; readonly limit?: number | undefined },
    ) => Effect.Effect<GameBuildsResult, GameOperationError>;
    readonly compare: (
      threadId: ThreadId,
      a: GameBuildRef,
      b: GameBuildRef,
    ) => Effect.Effect<GameBuildComparison, GameOperationError>;
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
      options?: { readonly waitFor?: Duration.Input; readonly queue?: "person" | "background" },
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
     * A measure no thread waits for: a run's round as it lands, or a chat
     * turn's build, which with `supersede` replaces the game's earlier turn
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
    /** Stops one build's Play from its copy; the folder's own Play is never touched. */
    readonly stopPlay: (
      threadId: ThreadId,
      build: GameBuildRef,
    ) => Effect.Effect<void, GameOperationError>;
    /**
     * Puts the build's engine project, art and ASSETS.md back in the game
     * folder, keeping the folder before as a build. With `expect`, inside the
     * game lock, only when the folder still holds that build and is unedited;
     * else it is refused "moved-on" and nothing moves (keep going's undo).
     */
    readonly restore: (
      threadId: ThreadId,
      build: GameBuildRef,
      commandId: string | undefined,
      options?: { readonly waitFor?: Duration.Input; readonly expect?: GameBuildId },
    ) => Effect.Effect<
      typeof GameBuildRestoreResult.Type & { readonly moved: RestoreMoved },
      GameOperationError
    >;
    /** The folder still holds `build` in its engine project, art and ASSETS.md, read under the game's lock. */
    readonly holds: (
      threadId: ThreadId,
      build: GameBuildId,
    ) => Effect.Effect<boolean, GameOperationError>;
    /**
     * A chat turn's build once its checkpoint is kept, the build the folder
     * held when the turn started (its recorded base; null when none was
     * recorded), and how many files of the engine project, art and ASSETS.md
     * it changed since then (since `fallback` without one); null while the
     * turn has no kept checkpoint.
     */
    /**
     * Writes the Stage's live values to the engine's tune file and keeps the
     * folder as a build, the folder before it kept too so Undo restores it. A
     * repeat with the same `commandId` answers as the first did.
     */
    readonly keepValues: (
      threadId: ThreadId,
      input: Omit<GameKeepValuesInput, "threadId">,
    ) => Effect.Effect<GameKeepValuesResult, GameOperationError>;
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

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* GameProjectService.GameProjectService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const facts = yield* GameFacts.GameFacts;
  const runs = yield* GameRunControl.GameRunControl;
  const game = yield* GameService.GameService;
  const operations = yield* GameOperations.GameOperations;
  const copies = yield* GameBuildCopies.GameBuildCopies;
  const scope = yield* Effect.scope;
  const crypto = yield* Crypto.Crypto;
  const engine = yield* Orchestrator.OrchestratorV2;
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
  const gameOf = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const root = yield* projects.resolve(threadId);
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
      const run = yield* runs
        .runBuilds(threadId)
        .pipe(
          Effect.mapError((cause) => GameRunControl.GameRunError.toOperationError("Builds", cause)),
        );
      return {
        root,
        projectId: shell.projectId,
        engine: manifest.engine.name as GameEngineId,
        lane: manifestProject(manifest),
        run,
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
   * began, and a turn that began while a run round was building says so.
   */
  const turnEntries = (
    g: Game,
    refs: ReadonlyMap<string, string>,
    limit: number,
    before: string | undefined,
    fromRun: ReadonlyArray<Entry>,
    recorded: ReadonlyMap<string, string>,
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
      const restoreBefore = (e: Entry) =>
        e.source._tag === "saved" &&
        (("build" in e.handle && /^restores\/.+-before$/.test(e.handle.build)) ||
          noRun?.before === e.id ||
          e.source.label === RESTORE_BEFORE_LABEL);
      const captures = rows.flatMap((row) => {
        const oid = refs.get(row.checkpoint.ref);
        return row.cwd !== g.root || oid === undefined || !isGameBuildId(oid)
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
        ...fromRun.flatMap((e) =>
          e.at === EPOCH || restoreBefore(e)
            ? []
            : [{ id: e.id, at: e.at, thread: null, turn: null }],
        ),
        ...restoreTargets.map((t) => ({ id: t.id, at: t.at, thread: null, turn: null })),
      ];
      const spans = (g.run?.rounds ?? []).flatMap((r) =>
        r.endedAt === null
          ? []
          : [{ from: Date.parse(r.endedAt) - r.durationMs, to: Date.parse(r.endedAt) }],
      );
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
          const start = Date.parse(startedAt);
          const shared = spans.some((span) => start >= span.from && start <= span.to);
          const summary = firstLine(row.request, "A turn's changes");
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
              summary: shared
                ? `${summary} (may include the run's changes: it was building at the same time)`
                : summary,
              files: change.files,
              fileCount: change.count,
              base: base ?? t3Base,
              handle: { build: oid },
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

  const runEntries = (g: Game, noRunSaved: ReadonlyArray<GameRunControl.RunNamedBuild>) =>
    Effect.gen(function* () {
      const run = g.run;
      // A run's saved build goes back by its name; a no-run restore's "before" by its commit.
      const saved = (build: GameRunControl.RunNamedBuild, ofRun: boolean): Entry | null =>
        isGameBuildId(build.oid)
          ? {
              id: build.oid,
              at: build.at,
              source: {
                _tag: "saved",
                runId: ofRun ? (run?.runId ?? null) : null,
                label: build.label,
              },
              summary: build.label,
              files: [],
              fileCount: null,
              base: null,
              handle: { build: ofRun ? build.name : build.oid },
            }
          : null;
      const beforeRestores = noRunSaved.flatMap((build) => saved(build, false) ?? []);
      if (run === null) return beforeRestores;
      // A round is built on the best before it: the last kept round's build, or
      // the build the run's stages left (a new run's capture of the game as it
      // found it, then each stage's), whichever came last.
      const stageBuilds = run.saved.filter((b) => b.name === "base" || b.name.startsWith("stage-"));
      let kept: { readonly id: string; readonly at: string } | null = null;
      const baseBefore = (at: string | null): string | null => {
        if (at === null) return kept?.id ?? null;
        const stage = stageBuilds
          .filter((b) => b.at <= at)
          .reduce<GameRunControl.RunNamedBuild | null>(
            (newest, b) => (newest === null || b.at > newest.at ? b : newest),
            null,
          );
        if (stage === null) return kept?.id ?? null;
        return kept !== null && kept.at >= stage.at ? kept.id : stage.oid;
      };
      const rounds: Entry[] = [];
      for (const r of run.rounds) {
        const build = r.build;
        if (build !== null && isGameBuildId(build)) {
          const base = baseBefore(r.endedAt);
          const change = yield* changeOf(g.root, g.lane, base, build);
          rounds.push({
            id: build,
            at: r.endedAt ?? EPOCH,
            source: {
              _tag: "round",
              runId: run.runId,
              round: r.round,
              rung: r.rung,
              move: r.move,
              outcome: r.outcome,
              best: build === run.best,
              durationMs: r.durationMs,
              linesChanged: r.linesChanged,
            },
            summary: firstLine(r.move, `Round ${r.round}`),
            files: change.files,
            fileCount: change.count,
            base,
            handle: r.outcome === "kept" ? { round: r.round } : { build },
          });
        }
        if (r.outcome === "kept" && build !== null) kept = { id: build, at: r.endedAt ?? EPOCH };
      }
      return [
        ...rounds,
        ...run.saved.flatMap((build) => saved(build, true) ?? []),
        ...beforeRestores,
      ];
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
      const noRunSaved = refs.flatMap((ref): ReadonlyArray<GameRunControl.RunNamedBuild> =>
        ref.checkpointRef.startsWith(noRunFolder) && ref.checkpointRef.endsWith("-before")
          ? [
              {
                name: ref.checkpointRef.slice(noRunFolder.length),
                label: RESTORE_BEFORE_LABEL,
                oid: ref.oid,
                at: isoOfSeconds(ref.committedAt),
              },
            ]
          : [],
      );
      const editsFolder = `${noRunFolder}${EDITS}`;
      const edits = yield* Effect.forEach(
        refs.filter(
          (ref) =>
            ref.checkpointRef.startsWith(editsFolder) && ref.checkpointRef.endsWith("-values"),
        ),
        (ref) =>
          Effect.gen(function* () {
            if (!isGameBuildId(ref.oid)) return [];
            const base = byRef.get(ref.checkpointRef.replace(/-values$/, "-from")) ?? null;
            const change = yield* changeOf(g.root, g.lane, base, ref.oid);
            return [
              {
                id: ref.oid,
                at: isoOfSeconds(ref.committedAt),
                source: { _tag: "saved", runId: null, label: VALUES_LABEL, edit: "values" },
                summary: VALUES_LABEL,
                files: change.files,
                fileCount: change.count,
                base,
                handle: { build: ref.oid },
              } satisfies Entry,
            ];
          }),
      ).pipe(Effect.map((each) => each.flat()));
      const allRun = [...(yield* runEntries(g, noRunSaved)), ...edits];
      const recorded = new Map(
        refs.flatMap((ref) =>
          ref.checkpointRef.startsWith(BASES)
            ? [[ref.checkpointRef.slice(BASES.length), ref.oid] as const]
            : [],
        ),
      );
      const turns = yield* turnEntries(g, byRef, limit * 3, before, allRun, recorded);
      const fromRun = allRun.filter((entry) => before === undefined || entry.at < before);
      // A round's build is also a turn's at times; one entry each, the round's first.
      const seen = new Set<string>();
      const merged = [...fromRun, ...turns.entries]
        .toSorted((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
        .filter((entry) => (seen.has(entry.id) ? false : (seen.add(entry.id), true)));
      // Turns past the page's last scanned turn may be newer than run builds below it.
      const floor = turns.scanned === limit * 3 ? turns.oldest : null;
      const listed = floor === null ? merged : merged.filter((entry) => entry.at >= floor);
      return {
        entries: listed,
        kept,
        more: floor !== null || listed.length > limit,
        refs: byRef,
        recorded,
      };
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

  const rowsOf = (g: Game, entries: ReadonlyArray<Entry>, kept: ReadonlySet<string>) =>
    Effect.gen(function* () {
      const resolved = yield* resolveOf(
        g,
        entries.map((entry) => entry.id),
      );
      const measured = yield* facts.readMany([...resolved.values()]);
      const builds = entries.map((entry): GameBuild => {
        const available = kept.has(entry.id) && resolved.has(entry.id);
        const read = measured.get(entry.id);
        return {
          id: entry.id,
          at: entry.at,
          source: entry.source,
          // Only a build still kept can be restored to undo this one.
          base:
            entry.base !== null && isGameBuildId(entry.base) && kept.has(entry.base)
              ? entry.base
              : null,
          summary: entry.summary,
          files: entry.files,
          fileCount: entry.fileCount,
          available,
          noPlay: !available
            ? "This build is no longer kept."
            : g.engine === "unity"
              ? UNITY_NO_PLAY
              : null,
          noRestore: !available ? "This build is no longer kept." : null,
          facts:
            read === undefined ? { state: "never", chips: [], notMeasured: 0 } : summaryOf(read),
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
      if (id === undefined || recorded.has(id)) return;
      const base = entries.find((entry) => entry.id === id && entry.source._tag === "turn")?.base;
      if (base === undefined || base === null) return;
      yield* checkpoints.updateCheckpointRef({
        cwd: g.root,
        checkpointRef: CheckpointRef.make(`${BASES}${id}`),
        oid: base,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("A turn build's base could not be recorded.", { threadId, cause }),
      ),
    );

  const list: GameBuilds["Service"]["list"] = (threadId, input) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId);
      const limit = Math.min(50, Math.max(1, input.limit ?? 30));
      const { entries, kept, more } = yield* allEntries(g, limit, input.before);
      const page = entries.slice(0, limit);
      const { builds, measured } = yield* rowsOf(g, page, kept);
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
      const newestTurn = entries.find((entry) => entry.source._tag === "turn");
      const newestEdit = entries.find(
        (entry) => entry.source._tag === "saved" && entry.source.edit !== undefined,
      );
      // The latest restore, the run's or (with no run) the game's own.
      const restore = yield* restoreRefOf(g, entries);
      const last =
        g.run !== null && g.run.best !== null && isGameBuildId(g.run.best)
          ? {
              id: g.run.best,
              at: g.run.rounds.at(-1)?.endedAt ?? "",
            }
          : null;
      const candidates = [
        ...(newestTurn === undefined ? [] : [{ id: newestTurn.id, at: newestTurn.at }]),
        ...(newestEdit === undefined ? [] : [{ id: newestEdit.id, at: newestEdit.at }]),
        ...(last === null ? [] : [last]),
        ...(restore !== null && restore.outcome?.restored === true
          ? [{ id: restore.target, at: restore.requestedAt }]
          : []),
      ].toSorted((a, b) => (a.at < b.at ? 1 : -1));
      return {
        builds,
        next: more && page.length > 0 ? page.at(-1)!.at : null,
        current: input.before === undefined ? (candidates[0]?.id ?? null) : null,
        folderEdited:
          input.before === undefined && candidates[0] !== undefined
            ? yield* folderEditedSince(g, candidates[0].id)
            : "unknown",
        restore,
        ...(latestUse === undefined ? {} : { latestUse }),
      } satisfies GameBuildsResult;
    });

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
  const rowOf = (
    g: Game,
    id: GameBuildId,
    listed: { readonly entries: ReadonlyArray<Entry>; readonly kept: ReadonlySet<string> },
  ) =>
    Effect.gen(function* () {
      const entry =
        listed.entries.find((each) => each.id === id) ??
        ({
          id,
          at: EPOCH,
          source: { _tag: "saved", runId: g.run?.runId ?? null, label: `Build ${id.slice(0, 8)}` },
          summary: `Build ${id.slice(0, 8)}`,
          files: [],
          fileCount: null,
          base: null,
          handle: { build: id },
        } satisfies Entry);
      const [row] = (yield* rowsOf(g, [entry], new Set([...listed.kept, id]))).builds;
      return row!;
    });

  const factsOf: GameBuilds["Service"]["facts"] = (threadId, ref) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId);
      return yield* facts.read(yield* resolve(g, ref));
    });

  // A Unity measurement would take the server's one editor from a live run's roles.
  const unityHeld = (g: Game) => g.engine === "unity" && g.run?.live === true;
  const UNITY_HELD =
    "The production run holds the Unity editor; this build is measured once the run stops.";

  const measure: GameBuilds["Service"]["measure"] = (threadId, ref, options = {}) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId);
      const build = yield* resolve(g, ref);
      if (unityHeld(g)) return { ...(yield* facts.read(build)), message: UNITY_HELD };
      return yield* facts.measure(build, options);
    });

  const measureIn: GameBuilds["Service"]["measureIn"] = (root, build, options = {}) =>
    Effect.gen(function* () {
      if (!isGameBuildId(build)) return;
      const manifest = yield* projects.read(root);
      const engine = manifest.engine.name as GameEngineId;
      // A run's own builds: a Unity one would take the editor from the run's roles.
      if (engine === "unity") return;
      const lane = manifestProject(manifest);
      const [tree] = yield* checkpoints.resolveTrees({ cwd: root, revisions: [build], path: lane });
      if (tree === null || tree === undefined) return;
      yield* facts.measure(
        { root, build, key: `${engine}:${tree}`, engine },
        { queue: "background", ...(options.supersede === true ? { supersede: true } : {}) },
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
      if (!unityHeld(g)) yield* facts.measure(build, { queue: "background" });
      if (g.engine === "unity") return { _tag: "window", message: UNITY_NO_PLAY } as const;
      // The copy's one engine step at a time: a measurement's bot run and this
      // export take turns, so neither fails "busy" nor imports into the other.
      const result = yield* Effect.scoped(
        Effect.flatMap(copies.lease(g.root, { oid: build.build, key: build.key }), (copy) =>
          copies
            .exclusive(copy, game.playIn(copy, `game-builds:${threadId}`))
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

  const restore: GameBuilds["Service"]["restore"] = (threadId, ref, commandId, options = {}) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId);
      const build = yield* resolve(g, ref);
      const result = yield* restoreWithoutRun(threadId, g, build, commandId, options.expect);
      if (result.moved !== "moved-on") yield* playRestored(threadId, g);
      // Undo, Redo or Go back moved the folder a Guided proposal read (K2).
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

  const holds: GameBuilds["Service"]["holds"] = (threadId, build) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId);
      return yield* operations.exclusive(
        g.root,
        "Keep going check",
        folderAgainst(g, [build]).pipe(
          Effect.map(([changed]) => changed === false),
          Effect.mapError((cause) =>
            failed("Builds", g.root, "io", "the folder could not be compared", cause),
          ),
        ),
        String(threadId),
      );
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
      // holds exactly what the turn started from, in the paths that count.
      const startBuild = known ?? (counted === 0 ? fallback : null);
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
    engineProfile(g.engine).turnLoop && engineProfile(g.engine).stage === "export"
      ? Effect.forkIn(
          game
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
  // art and ASSETS.md brought back, and the result checked against the build.
  // The record is written before the folder moves; the moves are safe to run
  // again with the same request (the park is found, never retaken), so a
  // restart settles any restore it cut short (settleRestores).
  const moveWithoutRun = (root: string, lane: string, record: NoRunRestore, owner: string) =>
    Effect.gen(function* () {
      const moved = yield* withBuildInFolder(
        { game, checkpoints, lock: { operations, owner, waitUntil: null } },
        { root, runId: NO_RUN, lane },
        {
          sha: record.target,
          park: BuildName.restoreBefore(record.requestId),
          check: BuildName.restoreAfter(record.requestId),
          ...(record.expect === undefined ? {} : { expect: record.expect }),
        },
        (current) => Effect.succeed({ value: current, putBack: false }),
      ).pipe(
        // A failure is an answer; an interrupt is left to the settle after a restart.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.succeed({
                kind: "refused",
                why: "broke",
                detail: Cause.pretty(cause).split("\n")[0]!.slice(0, 300),
                back: "the folder may be part way between the two builds",
                parked: "",
              } as const),
        ),
      );
      const beforeRef = checkpointRefForGameRun(NO_RUN, BuildName.restoreBefore(record.requestId));
      const before = yield* checkpoints.listCheckpointRefs({ cwd: root, prefix: beforeRef }).pipe(
        Effect.map((refs) => refs.find((each) => each.checkpointRef === beforeRef)?.oid ?? null),
        Effect.orElseSucceed(() => null),
      );
      const what = `${lane}/, art/ and ASSETS.md`;
      const kept =
        before === null
          ? ""
          : ` What the folder held is kept as a build ("The game before a restore").`;
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
      // Nothing moved: the park is the folder as it still is, no build of its own.
      if (moved.kind === "current" || movedOn)
        yield* checkpoints
          .deleteCheckpointRefs({ cwd: root, checkpointRefs: [beforeRef] })
          .pipe(Effect.ignore);
      yield* saveNoRunRestore(root, {
        ...record,
        before:
          moved.kind !== "current" && !movedOn && before !== null && isGameBuildId(before)
            ? before
            : null,
        outcome,
      });
      yield* operations.changed(root, GAME_BUILDS_EVENT, outcome.message);
      return outcome;
    });

  const restoreWithoutRun = (
    threadId: ThreadId,
    g: Game,
    build: GameFacts.ResolvedBuild,
    commandId: string | undefined,
    expect: GameBuildId | undefined,
  ) =>
    Effect.gen(function* () {
      const requestId =
        commandId === undefined
          ? NodeCrypto.randomUUID()
          : NodeCrypto.createHash("sha256")
              .update(`${g.root}\0${commandId}`)
              .digest("hex")
              .slice(0, 32);
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
      yield* projects.admitWrite(threadId, g.root, "Restore build", owner);
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
      const record: NoRunRestore =
        earlier?.requestId === requestId
          ? earlier
          : {
              requestId,
              target: build.build,
              label: `Build ${build.build.slice(0, 8)}`,
              requestedAt: DateTime.formatIso(yield* DateTime.now),
              before: null,
              ...(expect === undefined ? {} : { expect }),
              outcome: null,
            };
      yield* saveNoRunRestore(g.root, record);
      // In the service's own fiber: a caller that goes away (a closed client)
      // stops waiting, never the folder's move.
      const fiber = yield* Effect.forkIn(moveWithoutRun(g.root, g.lane, record, owner), scope);
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

  const keepValues: GameBuilds["Service"]["keepValues"] = (threadId, input) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId);
      const profile = engineProfile(g.engine);
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
              message: `Kept as a build: ${summary}. Undo restores the game as it was.`,
            })
          : failed("Keep values", g.root, "io", "the kept build is not one of this game's builds");
      const said = (things: GameKeepValuesInput["things"]) =>
        things
          .map(
            (thing) =>
              `${thing.id} ${thing.values.map((v) => `${v.key} ${String(v.value)}`).join(", ")}`,
          )
          .join("; ");
      // A repeat answers as the first try did.
      const [doneFrom, doneKept] = yield* Effect.all([oidOf(fromRef), oidOf(keptRef)]);
      if (doneFrom !== null && doneKept !== null)
        return yield* answer(doneKept, doneFrom, said(input.things));
      const owner = String(threadId);
      yield* projects.admitWrite(threadId, g.root, "Keep values", owner);
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
          // A try cut short after its first capture keeps that one as the base.
          const base = doneFrom ?? (yield* capture(fromRef));
          yield* Effect.tryPromise({
            try: async () => {
              const temporary = `${path}.${request}.tmp`;
              await NodeFSP.writeFile(temporary, tuneFileText(merged.file));
              await NodeFSP.rename(temporary, path);
            },
            catch: (cause) =>
              failed("Keep values", path, "io", `${file} could not be written`, cause),
          });
          const build = yield* capture(keptRef);
          return { base, build, summary: merged.summary };
        }),
        owner,
      );
      const result = yield* answer(kept.build, kept.base, kept.summary);
      yield* operations.changed(g.root, GAME_BUILDS_EVENT, result.message);
      // Measured like a turn's build, so its facts sit beside the build before it.
      yield* measureIn(g.root, kept.build, { supersede: true });
      return result;
    });

  /** Finishes every no-run restore a restart cut short, by running its moves again. */
  const settleRestores = Effect.gen(function* () {
    const rows = yield* sql<{ readonly root: string; readonly payload_json: string }>`
      SELECT root, payload_json FROM game_build_restores
    `.pipe(Effect.orElseSucceed(() => []));
    for (const row of rows) {
      const decoded = decodeNoRunRestore(row.payload_json);
      if (Option.isNone(decoded) || decoded.value.outcome !== null) continue;
      yield* projects.read(row.root).pipe(
        Effect.flatMap((manifest) =>
          moveWithoutRun(row.root, manifestProject(manifest), decoded.value, "game-builds:settle"),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("A cut-short restore could not be settled.", { root: row.root, cause }),
        ),
      );
    }
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
        const engine = manifest.engine.name as GameEngineId;
        if (!engineProfile(engine).turnLoop) return;
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
  // reactor's subscription: every row that still owes a tier, and every live
  // run's rounds (a cache hit is free). Unity waits for an open.
  const reconcile: GameBuilds["Service"]["reconcile"] = Effect.gen(function* () {
    yield* settleRestores;
    for (const build of yield* facts.owed)
      if (build.engine !== "unity") yield* facts.measure(build, { queue: "background" });
    const threads = yield* projections
      .listGameRunThreadsToRecover()
      .pipe(Effect.orElseSucceed(() => []));
    for (const threadId of threads) {
      const live = yield* Effect.all([projects.resolve(threadId), runs.runBuilds(threadId)]).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (live === null || live[1] === null) continue;
      const [root, run] = live;
      for (const round of run.rounds) if (round.build !== null) yield* measureIn(root, round.build);
    }
    yield* reconcileTurns;
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("Build reconcile failed.", { cause })));

  const stopPlay: GameBuilds["Service"]["stopPlay"] = (threadId, ref) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId);
      const id = ref._tag === "build" ? ref.build : (yield* resolve(g, ref)).build;
      yield* copies.stopPlay(g.root, id);
    });

  return GameBuilds.of({
    stopPlay,
    reconcile,
    list,
    compare,
    facts: factsOf,
    measure,
    measureIn,
    recordTurn,
    play,
    restore,
    holds,
    keepValues,
    turnBuild,
  });
});

export const layer = Layer.effect(GameBuilds, make);
