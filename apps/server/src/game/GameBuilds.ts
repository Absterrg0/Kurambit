// @effect-diagnostics nodeBuiltinImport:off -- A restore's request id is a hash of the caller's command id, as the run's restore makes it; a game's place in its repository is read from disk.
// The Builds rail, for the Game panel and the agent tools alike: every turn
// that changed the game (its T3 checkpoint) and every build of the game's run
// (its rounds, prototypes, stages and saved builds), newest first, each with
// what changed and its facts. Builds are not a record of their own: the list
// is read from the checkpoints and the run's records each time. A build plays
// and is measured in a copy of its own, and goes back into the game folder
// through the run's restore, or the same moves the run's restore makes when
// the game has no run.
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
  GameOperationError,
  manifestProject,
  type ThreadId,
} from "@kurambit/contracts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { parseTurnDiffFilesFromNumstat } from "../checkpointing/Diffs.ts";
import { checkpointRefForGameRun, gameRunRefsFolder } from "../checkpointing/Utils.ts";
import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { type EarlierBuild, summaryOf, turnChangeBase } from "./buildFacts.ts";
import * as GameBuildCopies from "./GameBuildCopies.ts";
import * as GameFacts from "./GameFacts.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameRunControl from "./GameRunControl.ts";
import * as GameService from "./GameService.ts";
import { BuildName } from "./run/buildNames.ts";
import { isRestored, withBuildInFolder } from "./run/builds.ts";

/** The refs a game with no run keeps its restores' "before" folders under. */
const NO_RUN = "game-builds";
/** Where a build with no known time sorts: last. */
const EPOCH = "1970-01-01T00:00:00.000Z";
const isoOfSeconds = (seconds: number) => DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000));
const TURN_REFS = "refs/kurambit/orchestration-v2/checkpoints/";
const MAX_FILES = 8;
const UNITY_NO_PLAY =
  "Unity builds play as a Linux player for facts and bots; the Game panel has no Unity Play yet.";
const LIVE_RUN = "A production run is working on this game: stop the run to restore a build.";
const isGameBuildId = Schema.is(GameBuildId);

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

const NoRunRestore = Schema.Struct({
  requestId: Schema.String,
  target: GameBuildId,
  label: Schema.String,
  requestedAt: Schema.String,
  before: Schema.NullOr(GameBuildId),
  outcome: Schema.NullOr(Schema.Struct({ restored: Schema.Boolean, message: Schema.String })),
});
type NoRunRestore = typeof NoRunRestore.Type;
const NoRunRestoreJson = Schema.fromJsonString(NoRunRestore);
const decodeNoRunRestore = Schema.decodeUnknownOption(NoRunRestoreJson);
const encodeNoRunRestore = Schema.encodeEffect(NoRunRestoreJson);

const firstLine = (text: string | null, fallback: string) => {
  const line =
    (text ?? "")
      .split("\n")
      .find((each) => each.trim() !== "")
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
     * folder, keeping the folder before as a build. With `asBest`, a round's
     * build of a stopped run becomes the run's best (Keep on its card).
     */
    readonly restore: (
      threadId: ThreadId,
      build: GameBuildRef,
      commandId: string | undefined,
      options?: { readonly waitFor?: Duration.Input; readonly asBest?: boolean },
    ) => Effect.Effect<typeof GameBuildRestoreResult.Type, GameOperationError>;
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
      // Checkpoint paths are the repository's; a game in a subfolder of it strips its own prefix.
      const prefix = yield* repoPrefix(g.root);
      const inGame = (path: string) =>
        prefix === "" ? path : path.startsWith(prefix) ? path.slice(prefix.length) : null;
      const noRun = yield* noRunRestoreOf(g.root);
      const runRestore = g.run?.restore ?? null;
      const restoreTargets = [
        ...(noRun?.outcome?.restored === true ? [{ id: noRun.target, at: noRun.requestedAt }] : []),
        ...(runRestore?.outcome?.restored === true && runRestore.target !== null
          ? [{ id: runRestore.target, at: runRestore.requestedAt }]
          : []),
      ];
      const restoreBefore = (e: Entry) =>
        e.source._tag === "saved" &&
        (("build" in e.handle && /^restores\/.+-before$/.test(e.handle.build)) ||
          noRun?.before === e.id ||
          e.source.label === "The game before a restore");
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
          const base = turnChangeBase(
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
            base === null
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
                label: "The game before a restore",
                oid: ref.oid,
                at: isoOfSeconds(ref.committedAt),
              },
            ]
          : [],
      );
      const allRun = yield* runEntries(g, noRunSaved);
      const turns = yield* turnEntries(g, byRef, limit * 3, before, allRun);
      const fromRun = allRun.filter((entry) => before === undefined || entry.at < before);
      // A round's build is also a turn's at times; one entry each, the round's first.
      const seen = new Set<string>();
      const merged = [...fromRun, ...turns.entries]
        .toSorted((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
        .filter((entry) => (seen.has(entry.id) ? false : (seen.add(entry.id), true)));
      // Turns past the page's last scanned turn may be newer than run builds below it.
      const floor = turns.scanned === limit * 3 ? turns.oldest : null;
      const listed = floor === null ? merged : merged.filter((entry) => entry.at >= floor);
      return { entries: listed, kept, more: floor !== null || listed.length > limit, refs: byRef };
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
      return entries.map((entry): GameBuild => {
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
          noRestore: !available
            ? "This build is no longer kept."
            : g.run?.live === true
              ? LIVE_RUN
              : null,
          facts:
            read === undefined ? { state: "never", chips: [], notMeasured: 0 } : summaryOf(read),
        };
      });
    });

  const list: GameBuilds["Service"]["list"] = (threadId, input) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId);
      const limit = Math.min(50, Math.max(1, input.limit ?? 30));
      const { entries, kept, more } = yield* allEntries(g, limit, input.before);
      const page = entries.slice(0, limit);
      const builds = yield* rowsOf(g, page, kept);
      const newestTurn = entries.find((entry) => entry.source._tag === "turn");
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
        ...(last === null ? [] : [last]),
        ...(restore !== null && restore.outcome?.restored === true
          ? [{ id: restore.target, at: restore.requestedAt }]
          : []),
      ].toSorted((a, b) => (a.at < b.at ? 1 : -1));
      return {
        builds,
        next: more && page.length > 0 ? page.at(-1)!.at : null,
        current: input.before === undefined ? (candidates[0]?.id ?? null) : null,
        folderEdited: "unknown",
        restore,
      } satisfies GameBuildsResult;
    });

  const restoreRefOf = (g: Game, entries: ReadonlyArray<Entry>) =>
    Effect.gen(function* () {
      const newerThan = (at: string) =>
        entries.some((entry) => entry.source._tag === "turn" && entry.at > at);
      if (g.run !== null) {
        const r = g.run.restore;
        if (r === null || r.target === null || !isGameBuildId(r.target)) return null;
        const before = r.before !== null && isGameBuildId(r.before) ? r.before : null;
        return {
          requestId: r.requestId,
          target: r.target,
          label: r.label,
          requestedAt: r.requestedAt,
          undo: r.outcome?.restored === true && !newerThan(r.requestedAt) ? before : null,
          outcome: r.outcome,
        };
      }
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
      const [row] = yield* rowsOf(g, [entry], new Set([...listed.kept, id]));
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
      if (options.asBest === true) {
        if (g.run === null)
          return yield* failed(
            "Restore build",
            g.root,
            "invalid-input",
            "This game has no production run, so it has no best to set.",
          );
        if (g.run.live) return yield* failed("Restore build", g.root, "busy", LIVE_RUN);
      }
      if (g.run !== null) {
        const { entries } = yield* allEntries(g, 50, undefined);
        const entry = entries.find((each) => each.id === build.build);
        const round = entry?.source._tag === "round" ? entry.source.round : null;
        if (options.asBest === true && round === null)
          return yield* failed(
            "Restore build",
            g.root,
            "invalid-input",
            "Only a round's build can become the run's best; this build is not a round's.",
          );
        const handle =
          options.asBest === true && round !== null
            ? { round }
            : (entry?.handle ?? { build: build.build });
        const result = yield* runs
          .runRestore(
            {
              threadId,
              ...(commandId === undefined ? {} : { commandId }),
              ...("round" in handle ? { round: handle.round } : { build: handle.build }),
              ...(options.asBest === true ? { asBest: true } : {}),
            },
            options.waitFor === undefined ? {} : { waitFor: options.waitFor },
          )
          .pipe(
            Effect.mapError((cause) =>
              GameRunControl.GameRunError.toOperationError("Restore build", cause),
            ),
          );
        yield* operations.changed(g.root, GAME_BUILDS_EVENT, result.message);
        return result;
      }
      return yield* restoreWithoutRun(threadId, g, build, commandId);
    });

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
      const outcome =
        moved.kind === "current"
          ? {
              restored: false,
              message: `The folder already holds ${record.label}; nothing was restored.`,
            }
          : moved.kind === "done"
            ? {
                restored: true,
                message: `${record.label}: its ${what} are back in the game folder.${kept} Restoring that build undoes this.`,
              }
            : {
                restored: false,
                message: `${record.label} could not be restored (${moved.detail}). ${moved.back === null ? "The folder is back as it was." : `Putting the folder back failed too (${moved.back}).`}${kept}`,
              };
      if (moved.kind === "current")
        yield* checkpoints
          .deleteCheckpointRefs({ cwd: root, checkpointRefs: [beforeRef] })
          .pipe(Effect.ignore);
      yield* saveNoRunRestore(root, {
        ...record,
        before:
          moved.kind !== "current" && before !== null && isGameBuildId(before) ? before : null,
        outcome,
      });
      yield* operations.changed(root, GAME_BUILDS_EVENT, outcome.message);
      return { refused: moved.kind === "refused", outcome };
    });

  const restoreWithoutRun = (
    threadId: ThreadId,
    g: Game,
    build: GameFacts.ResolvedBuild,
    commandId: string | undefined,
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
      if (earlier?.requestId === requestId && earlier.outcome !== null)
        return { requestId, done: true, message: earlier.outcome.message };
      const owner = String(threadId);
      yield* projects.admitWrite(threadId, g.root, "Restore build", owner);
      const record: NoRunRestore =
        earlier?.requestId === requestId
          ? earlier
          : {
              requestId,
              target: build.build,
              label: `Build ${build.build.slice(0, 8)}`,
              requestedAt: DateTime.formatIso(yield* DateTime.now),
              before: null,
              outcome: null,
            };
      yield* saveNoRunRestore(g.root, record);
      // In the service's own fiber: a caller that goes away (a closed client)
      // stops waiting, never the folder's move.
      const fiber = yield* Effect.forkIn(moveWithoutRun(g.root, g.lane, record, owner), scope);
      const { refused, outcome } = yield* Fiber.join(fiber);
      if (refused) return yield* failed("Restore build", g.root, "tool-failed", outcome.message);
      return { requestId, done: true, message: outcome.message };
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
    play,
    restore,
  });
});

export const layer = Layer.effect(GameBuilds, make);
