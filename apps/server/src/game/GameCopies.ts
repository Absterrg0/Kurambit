// @effect-diagnostics nodeBuiltinImport:off -- A copy is a git worktree on disk, and its outcome a small file under server state.
// A copy is a chat of the game working in its own worktree (T3's thread worktreePath), seated on
// one of the game's builds. Its seat is the thread's worktree seed ref, written when the copy is
// made and moved only by an Update: a merge from any other base drops the game's newer work
// without a conflict (MC design, spike 3.4), so the seat is never inferred.
//
// A copy is sticky: once a chat works in one, every later turn runs there, so its provider
// session keeps its context, until the person (or the agent that owns it or its parent) brings it
// in for the last time or throws it away. Nothing lands on its own: Bring in merges the copy's
// work into the game against the seat, checks the result in a build copy, and lands it through
// the game's one landing (GameBuilds.land). Conflicts go back to the copy, never the game.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  CheckpointRef,
  CommandId,
  GAME_BUILDS_EVENT,
  GAME_FACTS_EVENT,
  type GameBringInInput,
  type GameBringInResult,
  type GameBuildFacts,
  GameBuildId,
  type GameChatPlace,
  type GameCopiesResult,
  type GameCopy,
  GameCopyConflict,
  type GameCopyState,
  type GameCopyUpdateResult,
  GameOperationError,
  manifestProject,
  type OrchestrationV2ThreadShell,
  SAVED_PLAYS_PER_BUILD,
  type ThreadId,
} from "@kurambit/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { checkpointRefForGameRun } from "../checkpointing/Utils.ts";
import { threadRefKey, worktreeSeedOf, worktreeSeedRef } from "../checkpointing/worktreeSeed.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { regressions } from "../orchestration-v2/gameRun/decide.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as GameCopyNotes from "../orchestration-v2/gameCopies/GameCopyNotes.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { availableEngine, engineProfile } from "./engineProfile.ts";
import * as GameBuilds from "./GameBuilds.ts";
import { recordDecision } from "./GameDecisions.ts";
import * as GameFacts from "./GameFacts.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameProjectService from "./GameProjectService.ts";
import { mergeBuilds } from "./mergeBuilds.ts";
import { isRestored, measureChange } from "./run/builds.ts";
import { KEPT_DIR, SAVED_DIR, savedPlays } from "./playFiles.ts";

/** Under the worktrees folder, beside the build copies. */
const GAME_COPIES = "game-copies";
/** A person waits on a bring-in's check: as long as a boot check and the saved plays take. */
const CHECK_WAIT = "10 minutes";
const isGameBuildId = Schema.is(GameBuildId);
const short = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
const copyKey = threadRefKey;
/** The copy's work as Bring in last read it: what a thrown-away copy still brings in. */
const workRef = (threadId: ThreadId) =>
  checkpointRefForGameRun("game-builds", `copies/${copyKey(threadId)}/work`);
/**
 * When the chat moved into its copy (`in`) and back to the game (`out`), as commit times: a
 * thread's checkpoints all carry its current folder, so the rail tells the game's turns from the
 * copy's by these.
 */
const copyMoveRef = (threadId: ThreadId, way: CopyMark) =>
  checkpointRefForGameRun("game-builds", `copies/${copyKey(threadId)}/${way}`);
/** `brought`: when its work last came in, which its count of builds not in the game starts after. */
type CopyMark = "in" | "out" | "brought";
/** The game folder as a merge read it, which a landing is moved only onto. */
const gameRef = (threadId: ThreadId) =>
  checkpointRefForGameRun("game-builds", `copies/${copyKey(threadId)}/game`);

/** What a copy's last bring-in or update left that the person must decide, kept across restarts. */
const Outcome = Schema.Union([
  Schema.TaggedStruct("conflicts", { files: Schema.Array(GameCopyConflict), at: Schema.String }),
  Schema.TaggedStruct("held", { reason: Schema.String, at: Schema.String }),
]);
const OutcomeJson = Schema.fromJsonString(Outcome);
const decodeOutcome = Schema.decodeUnknownOption(OutcomeJson);
const encodeOutcome = Schema.encodeSync(OutcomeJson);

export class GameCopies extends Context.Service<
  GameCopies,
  {
    /** The game's chats in copies, and the asking chat's own place. */
    readonly copies: (threadId: ThreadId) => Effect.Effect<GameCopiesResult, GameOperationError>;
    /** Where the chat works, and for a copy its seat, how far the game is ahead and its state. */
    readonly place: (threadId: ThreadId) => Effect.Effect<GameChatPlace, GameOperationError>;
    /**
     * A new copy for `threadId`, seated on `seat` (a build of the game) at a worktree of its own,
     * and the thread's cwd moved there (a version child is made with its cwd already set).
     */
    readonly seat: (input: {
      readonly root: string;
      readonly threadId: ThreadId;
      readonly seat: string;
      readonly repoint: boolean;
    }) => Effect.Effect<{ readonly cwd: string }, GameOperationError>;
    /** The chat's turn waiting for the game folder runs in a copy of the game's build instead. */
    readonly runInCopy: (
      threadId: ThreadId,
      commandId: string | undefined,
    ) => Effect.Effect<{ readonly message: string }, GameOperationError>;
    /**
     * The copy's work into the game. An agent (`agent`) brings in its own copy or a child it
     * delegated; the person any copy of the game.
     */
    readonly bringIn: (
      input: GameBringInInput,
      options?: { readonly agent?: boolean },
    ) => Effect.Effect<GameBringInResult, GameOperationError>;
    /** The game's newer work into the copy; the seat moves to the game's build. */
    readonly update: (
      threadId: ThreadId,
      asking: ThreadId,
    ) => Effect.Effect<GameCopyUpdateResult, GameOperationError>;
    /** The copy's worktree goes and the chat works in the game; its work stays a record Bring in reads. */
    readonly throwAway: (
      threadId: ThreadId,
      asking: ThreadId,
    ) => Effect.Effect<{ readonly message: string }, GameOperationError>;
    /** A copy made for a chat that never came to be (a try that could not start) goes. */
    readonly discard: (root: string, threadId: ThreadId) => Effect.Effect<void>;
    /**
     * A copy from before seats were kept (a try's version, whose worktree is gone): its seat and
     * its work as the try recorded them, so Bring in reads them like any copy's.
     */
    readonly adopt: (input: {
      readonly root: string;
      readonly threadId: ThreadId;
      readonly seat: string;
      readonly work: string;
    }) => Effect.Effect<void, GameOperationError>;
    /** The line a copy's turn reads beside its message; null for a chat in the game. */
    readonly copyNote: (threadId: ThreadId) => Effect.Effect<string | null>;
  }
>()("kurambit/game/GameCopies") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const projects = yield* GameProjectService.GameProjectService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const builds = yield* GameBuilds.GameBuilds;
  const engine = yield* Orchestrator.OrchestratorV2;
  const facts = yield* GameFacts.GameFacts;
  const operations = yield* GameOperations.GameOperations;
  const preview = yield* GamePreview.GamePreview;
  const scope = yield* Effect.scope;
  const copiesRoot = NodePath.join(config.worktreesDir, GAME_COPIES);
  const outcomesDir = NodePath.join(config.stateDir, GAME_COPIES);
  /**
   * Bring-ins in flight, per copy: a second ask joins the first (a double click, the agent and the
   * person at once), and Bring in now ends its check's wait. The check's progress is the copy's
   * state while it runs. In memory: a restart ends the bring-in, and its record settles it.
   */
  const inFlight = new Map<
    ThreadId,
    {
      readonly fiber: Fiber.Fiber<GameBringInResult, GameOperationError>;
      readonly skip: Deferred.Deferred<void>;
      progress: { readonly play: number; readonly plays: number } | null;
    }
  >();

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
  const io = (operation: string, path: string, detail: string) => (cause: unknown) =>
    failed(operation, path, "io", detail, cause);

  const outcomeFile = (threadId: ThreadId) => NodePath.join(outcomesDir, `${short(threadId)}.json`);
  const readOutcome = (threadId: ThreadId) =>
    Effect.promise(() => NodeFSP.readFile(outcomeFile(threadId), "utf8").catch(() => null)).pipe(
      Effect.map((text) => (text === null ? null : Option.getOrNull(decodeOutcome(text)))),
    );
  const writeOutcome = (threadId: ThreadId, outcome: typeof Outcome.Type | null) =>
    Effect.promise(async () => {
      if (outcome === null) return NodeFSP.rm(outcomeFile(threadId), { force: true });
      await NodeFSP.mkdir(outcomesDir, { recursive: true });
      const temporary = `${outcomeFile(threadId)}.tmp`;
      await NodeFSP.writeFile(temporary, encodeOutcome(outcome));
      await NodeFSP.rename(temporary, outcomeFile(threadId));
    });
  const now = Effect.map(DateTime.now, DateTime.formatIso);

  const shellOf = (threadId: ThreadId) =>
    projections.getThreadShell(threadId).pipe(
      Effect.mapError(io("Copy", threadId, "the chat could not be read")),
      Effect.flatMap((shell) =>
        shell === null
          ? Effect.fail(failed("Copy", threadId, "project-not-found", "the chat is gone"))
          : Effect.succeed(shell),
      ),
    );
  const atWork = (shell: OrchestrationV2ThreadShell) =>
    shell.activeRunId !== null || (shell.activityRunStatus ?? null) !== null;
  const exists = (path: string) =>
    Effect.promise(() =>
      NodeFSP.lstat(path).then(
        () => true,
        () => false,
      ),
    );

  /** The game a chat belongs to, at home: its folder, engine folder and tune file. */
  const gameOf = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const { root, projectId } = yield* projects.home(threadId);
      const manifest = yield* projects.read(root);
      const lane = manifestProject(manifest);
      const profile = engineProfile(yield* availableEngine(manifest.engine.name));
      return {
        root,
        projectId,
        lane,
        tuneFile: profile.tuneFile === null ? null : `${lane}/${profile.tuneFile}`,
        union: ["ASSETS.md", `${lane}/${profile.layout.credits}`],
      };
    });
  type Game = Effect.Success<ReturnType<typeof gameOf>>;

  /** Where a copy's worktree goes, and its cwd there (the game's own path in its repository). */
  const placeOf = (root: string, threadId: ThreadId, prefix: string) => {
    const worktree = NodePath.join(
      copiesRoot,
      `${NodePath.basename(root)}-${short(root)}`,
      short(threadId),
    );
    return { worktree, cwd: prefix === "" ? worktree : NodePath.join(worktree, prefix) };
  };
  const repoPrefix = (root: string) =>
    Effect.promise(async () => {
      let dir = NodePath.resolve(root);
      let prefix = "";
      for (;;) {
        const git = await NodeFSP.lstat(NodePath.join(dir, ".git")).then(
          () => true,
          () => false,
        );
        if (git) return prefix;
        const up = NodePath.dirname(dir);
        if (up === dir) return "";
        prefix = prefix === "" ? NodePath.basename(dir) : `${NodePath.basename(dir)}/${prefix}`;
        dir = up;
      }
    });
  /** The worktree a copy's cwd sits in (the cwd itself unless the game is a subfolder). */
  const worktreeOf = (root: string, cwd: string) =>
    Effect.map(repoPrefix(root), (prefix) =>
      prefix === "" ? cwd : NodePath.resolve(cwd, ...prefix.split("/").map(() => "..")),
    );

  // A fresh commit's time marks the move; its tree is the seat's, so it holds nothing new.
  const markMove = (root: string, threadId: ThreadId, way: CopyMark, at: string) =>
    checkpoints
      .commitTree({ cwd: root, tree: `${at}^{tree}`, parent: at, message: `copy ${way}` })
      .pipe(
        Effect.flatMap((oid) =>
          checkpoints.updateCheckpointRef({
            cwd: root,
            checkpointRef: copyMoveRef(threadId, way),
            oid,
          }),
        ),
        Effect.mapError(io("Copy", root, "the copy's move could not be kept")),
      );

  const seat: GameCopies["Service"]["seat"] = (input) =>
    Effect.gen(function* () {
      const where = placeOf(input.root, input.threadId, yield* repoPrefix(input.root));
      const operation = "Make a copy";
      yield* checkpoints
        .updateCheckpointRef({
          cwd: input.root,
          checkpointRef: worktreeSeedRef(input.threadId),
          oid: input.seat,
        })
        .pipe(Effect.mapError(io(operation, input.root, "the copy's seat could not be kept")));
      if (!(yield* exists(NodePath.join(where.worktree, ".git")))) {
        yield* Effect.promise(() => NodeFSP.rm(where.worktree, { recursive: true, force: true }));
        yield* git.pruneWorktrees({ cwd: input.root }).pipe(Effect.ignore);
        yield* git
          .createWorktree({ cwd: input.root, refName: input.seat, path: where.worktree })
          .pipe(Effect.mapError(io(operation, input.root, "the copy could not be made")));
      }
      if (input.repoint) yield* markMove(input.root, input.threadId, "in", input.seat);
      if (input.repoint)
        yield* threads
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`game-copy:seat:${input.threadId}:${short(input.seat)}`),
            threadId: input.threadId,
            worktreePath: where.cwd,
            expectedWorktreePath: null,
          })
          .pipe(Effect.mapError(io(operation, input.root, "the chat could not move to its copy")));
      return { cwd: where.cwd };
    });

  /** The copy goes; the chat works in the game folder again. */
  const close = (g: Game, shell: OrchestrationV2ThreadShell) =>
    Effect.gen(function* () {
      const cwd = shell.worktreePath;
      if (cwd === null) return;
      const worktree = yield* worktreeOf(g.root, cwd);
      const seated = yield* seatOf(g, shell);
      if (seated !== null) yield* markMove(g.root, shell.id, "out", seated);
      yield* threads
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`game-copy:close:${shell.id}:${short(cwd)}`),
          threadId: shell.id,
          worktreePath: null,
          expectedWorktreePath: cwd,
        })
        .pipe(
          Effect.mapError(io("Close copy", g.root, "the chat could not move back to the game")),
        );
      yield* preview.forget(cwd);
      yield* git.removeWorktree({ cwd: g.root, path: worktree, force: true }).pipe(Effect.ignore);
      yield* Effect.promise(() => NodeFSP.rm(worktree, { recursive: true, force: true }));
      yield* git.pruneWorktrees({ cwd: g.root }).pipe(Effect.ignore);
    });

  /** The copy's work now: its folder captured, else the record of its last reading. */
  const workOf = (g: Game, shell: OrchestrationV2ThreadShell) =>
    Effect.gen(function* () {
      const cwd = shell.worktreePath;
      if (cwd !== null && (yield* exists(cwd)))
        return yield* checkpoints
          .withWorkspaceLock(
            cwd,
            checkpoints.captureCheckpoint({ cwd, checkpointRef: workRef(shell.id) }),
          )
          .pipe(Effect.mapError(io("Bring in", cwd, "the copy could not be read")));
      const kept = yield* checkpoints
        .listCheckpointRefs({ cwd: g.root, prefix: workRef(shell.id) })
        .pipe(Effect.orElseSucceed(() => []));
      return kept.find((each) => each.checkpointRef === workRef(shell.id))?.oid ?? null;
    });

  const captureGame = (g: Game, threadId: ThreadId) =>
    checkpoints
      .withWorkspaceLock(
        g.root,
        checkpoints.captureCheckpoint({ cwd: g.root, checkpointRef: gameRef(threadId) }),
      )
      .pipe(Effect.mapError(io("Bring in", g.root, "the game folder could not be read")));

  /**
   * The copy holds `game`'s newer work merged with its own: written into its folder, conflicts
   * as both sides (markers in text, the copy's own binary), and its seat moved to `game`.
   */
  const updateTo = (g: Game, shell: OrchestrationV2ThreadShell, seatOf: string, game: string) =>
    Effect.gen(function* () {
      const cwd = shell.worktreePath;
      if (cwd === null || !(yield* exists(cwd)))
        return yield* failed("Update", g.root, "invalid-input", "This chat works in no copy.");
      const work = yield* workOf(g, shell);
      if (work === null) return yield* failed("Update", cwd, "io", "the copy could not be read");
      const merged = yield* mergeBuilds(checkpoints, {
        root: g.root,
        tuneFile: g.tuneFile,
        union: g.union,
        base: seatOf,
        ours: work,
        theirs: game,
        game: "theirs",
        // The game's decisions are the game's: a copy's own file never merges.
        within: (path) => path !== ".studio/decisions.md",
      }).pipe(Effect.mapError(io("Update", cwd, "the game's work could not be merged")));
      const commit = yield* checkpoints
        .commitTree({ cwd: g.root, tree: merged.tree, parent: game, message: "Update" })
        .pipe(Effect.mapError(io("Update", cwd, "the merge could not be kept")));
      const numstat = yield* checkpoints
        .diffCheckpoints({
          cwd,
          fromCheckpointRef: CheckpointRef.make(work),
          toCheckpointRef: CheckpointRef.make(commit),
          ignoreWhitespace: false,
          format: "numstat",
          relative: true,
        })
        .pipe(Effect.mapError(io("Update", cwd, "the merge could not be read")));
      const changed = numstat
        .split("\0")
        .flatMap((field) => {
          const path = field.split("\t")[2];
          return path === undefined || path === "" ? [] : [path];
        })
        .filter((path) => path !== ".studio/decisions.md");
      if (changed.length > 0)
        yield* checkpoints
          .withWorkspaceLock(
            cwd,
            checkpoints.restoreCheckpoint({
              cwd,
              checkpointRef: CheckpointRef.make(commit),
              filePaths: changed,
            }),
          )
          .pipe(Effect.mapError(io("Update", cwd, "the copy could not be written")));
      yield* checkpoints
        .updateCheckpointRef({ cwd: g.root, checkpointRef: worktreeSeedRef(shell.id), oid: game })
        .pipe(Effect.mapError(io("Update", cwd, "the copy's seat could not move")));
      yield* writeOutcome(
        shell.id,
        merged.conflicts.length === 0
          ? null
          : { _tag: "conflicts", files: merged.conflicts, at: yield* now },
      );
      return merged.conflicts;
    });

  /** A copy's seat, or why it cannot come in. */
  const seatOf = (g: Game, shell: OrchestrationV2ThreadShell) =>
    worktreeSeedOf(checkpoints, g.root, shell.id).pipe(
      Effect.mapError(io("Bring in", g.root, "the copy's seat could not be read")),
    );
  const NO_SEAT =
    "This copy started from an empty game before Kurambit kept a copy's seat: ask its agent to redo the work in the game.";

  /** The game's numbered builds, for a seat's number and how far the game is ahead of it. */
  const aheadOf = (threadId: ThreadId, seated: string) =>
    Effect.gen(function* () {
      const listed = yield* builds.list(threadId, { home: true, limit: 50 });
      const at = yield* checkpoints
        .listCheckpointRefs({
          cwd: (yield* projects.home(threadId)).root,
          prefix: worktreeSeedRef(threadId),
        })
        .pipe(
          Effect.map(
            (refs) =>
              refs.find((each) => each.checkpointRef === worktreeSeedRef(threadId))?.committedAt,
          ),
          Effect.orElseSucceed(() => undefined),
        );
      const seatedAt = at === undefined ? null : DateTime.formatIso(DateTime.makeUnsafe(at * 1000));
      const numbered = listed.builds.filter((build) => build.number !== null);
      const exact = numbered.find((build) => build.id === seated);
      const before =
        exact ?? (seatedAt === null ? undefined : numbered.find((build) => build.at <= seatedAt));
      const ahead =
        seatedAt === null
          ? 0
          : numbered.filter((build) => build.id !== seated && build.at > (exact?.at ?? seatedAt))
              .length;
      return { number: before?.number ?? null, ahead };
    });

  const stateOf = (
    g: Game,
    shell: OrchestrationV2ThreadShell,
    seated: string,
  ): Effect.Effect<GameCopyState, GameOperationError> =>
    Effect.gen(function* () {
      const checking = inFlight.get(shell.id)?.progress ?? null;
      if (checking !== null) return { _tag: "checking", ...checking } as const;
      if (atWork(shell)) return { _tag: "working" } as const;
      const outcome = yield* readOutcome(shell.id);
      const lastWork = shell.latestRunCompletedAt ?? null;
      if (outcome !== null && (lastWork === null || DateTime.formatIso(lastWork) <= outcome.at))
        return outcome._tag === "conflicts"
          ? ({ _tag: "conflicts", files: outcome.files } as const)
          : ({ _tag: "held", reason: outcome.reason } as const);
      // Its newest turn's build against its seat, in what a build is.
      const { checkpoints: captured } = yield* projections
        .getThreadRecords(shell.id, ["checkpoints"])
        .pipe(Effect.orElseSucceed(() => ({ checkpoints: [] })));
      const newest = captured
        .filter((each) => each.status === "ready")
        .toSorted((a, b) => b.ordinalWithinScope - a.ordinalWithinScope)[0];
      const oid =
        newest === undefined
          ? null
          : ((yield* checkpoints
              .listCheckpointRefs({ cwd: g.root, prefix: newest.ref })
              .pipe(Effect.orElseSucceed(() => []))).find(
              (each) => each.checkpointRef === newest.ref,
            )?.oid ?? null);
      if (oid === null) return { _tag: "same" } as const;
      const change = yield* measureChange(checkpoints, g.root, isRestored(g.lane), seated, oid);
      return change.changed ? ({ _tag: "ready" } as const) : ({ _tag: "same" } as const);
    });

  const markedAt = (root: string, threadId: ThreadId, way: CopyMark) =>
    checkpoints.listCheckpointRefs({ cwd: root, prefix: copyMoveRef(threadId, way) }).pipe(
      Effect.map(
        (refs) =>
          refs.find((each) => each.checkpointRef === copyMoveRef(threadId, way))?.committedAt ?? 0,
      ),
      Effect.orElseSucceed(() => 0),
    );
  /** The copy's own builds since it was made or its work last came in. */
  const buildsNotIn = (g: Game, shell: OrchestrationV2ThreadShell) =>
    Effect.gen(function* () {
      const since = Math.max(
        yield* markedAt(g.root, shell.id, "in"),
        yield* markedAt(g.root, shell.id, "brought"),
      );
      const after = DateTime.formatIso(DateTime.makeUnsafe(since * 1000));
      const listed = yield* builds.list(shell.id, { limit: 50 });
      // Its own turns: the rail of a chat in a copy also lists the game's kept edits and versions.
      return listed.builds.filter(
        (build) =>
          build.at > after && build.source._tag === "turn" && build.source.threadId === shell.id,
      ).length;
    }).pipe(Effect.orElseSucceed(() => 0));

  const place: GameCopies["Service"]["place"] = (threadId) =>
    Effect.gen(function* () {
      const shell = yield* shellOf(threadId);
      if (shell.worktreePath === null) return { _tag: "game" } as const;
      const g = yield* gameOf(threadId);
      const seated = yield* seatOf(g, shell);
      if (seated === null)
        return {
          _tag: "copy",
          seat: null,
          seatNumber: null,
          ahead: 0,
          builds: 0,
          state: { _tag: atWork(shell) ? "working" : "ready" },
          noBringIn: NO_SEAT,
        } satisfies GameChatPlace as GameChatPlace;
      const where = yield* aheadOf(threadId, seated).pipe(
        Effect.orElseSucceed(() => ({ number: null, ahead: 0 })),
      );
      const state = yield* stateOf(g, shell, seated);
      return {
        _tag: "copy",
        seat: isGameBuildId(seated) ? seated : null,
        seatNumber: where.number,
        ahead: where.ahead,
        builds: state._tag === "same" ? 0 : yield* buildsNotIn(g, shell),
        state,
        noBringIn: null,
      } satisfies GameChatPlace as GameChatPlace;
    });

  const copies: GameCopies["Service"]["copies"] = (threadId) =>
    Effect.gen(function* () {
      const { projectId } = yield* projects.home(threadId);
      const { threads: shells } = yield* projections
        .getShellSnapshot({ projectId, location: "active" })
        .pipe(Effect.mapError(io("Copies", threadId, "the game's chats could not be read")));
      const inCopies = shells.filter((shell) => shell.worktreePath !== null);
      const listed = yield* Effect.forEach(
        inCopies,
        (shell) =>
          place(shell.id).pipe(
            Effect.map((placed): ReadonlyArray<GameCopy> =>
              placed._tag === "copy"
                ? [{ threadId: shell.id, title: shell.title, place: placed }]
                : [],
            ),
            Effect.orElseSucceed(() => []),
          ),
        { concurrency: 4 },
      );
      return { copies: listed.flat(), place: yield* place(threadId) };
    });

  const runInCopy: GameCopies["Service"]["runInCopy"] = (threadId, commandId) =>
    Effect.gen(function* () {
      const shell = yield* shellOf(threadId);
      if (shell.worktreePath !== null) return { message: "This chat already works in a copy." };
      const g = yield* gameOf(threadId);
      // The game's newest build, never a folder another chat is half way through writing.
      // Read from the builds list, never under the game's operation lock: a check measuring the
      // game holds that lock for minutes, and the person asked to start now.
      const current = (yield* builds.list(threadId, { home: true, limit: 1 })).current;
      const seated =
        current ??
        (yield* checkpoints
          .withWorkspaceLock(
            g.root,
            checkpoints.captureCheckpoint({
              cwd: g.root,
              checkpointRef: worktreeSeedRef(threadId),
            }),
          )
          .pipe(Effect.mapError(io("Run in a copy", g.root, "the game could not be read"))));
      yield* seat({ root: g.root, threadId, seat: seated, repoint: true });
      // Its waiting turn starts there now.
      yield* threads
        .dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`game-copy:run:${threadId}:${commandId ?? short(seated)}`),
          threadId,
        })
        .pipe(Effect.mapError(io("Run in a copy", g.root, "the waiting turn could not start")));
      yield* operations.changed(g.root, GAME_BUILDS_EVENT, "A chat works in a copy.");
      const number = (yield* aheadOf(threadId, seated).pipe(Effect.orElseSucceed(() => null)))
        ?.number;
      return {
        message: `This chat works in a copy of ${number == null ? "the game" : `Build ${number}`} from now on. Bring it in when its work is ready.`,
      };
    });

  /**
   * Saved plays the copy made and the runs kept on its Stage come in as files of their own: new
   * files only, outside what a build is, so no undo ever takes a test.
   */
  const bringPlays = (g: Game, shell: OrchestrationV2ThreadShell, game: string, work: string) =>
    Effect.gen(function* () {
      const numstat = yield* checkpoints.diffCheckpoints({
        cwd: g.root,
        fromCheckpointRef: CheckpointRef.make(game),
        toCheckpointRef: CheckpointRef.make(work),
        ignoreWhitespace: false,
        format: "numstat",
        relative: true,
      });
      const plays = numstat.split("\0").flatMap((field) => {
        const path = field.split("\t")[2];
        return path !== undefined && path.startsWith(`${SAVED_DIR}/`) ? [path] : [];
      });
      for (const path of plays) {
        const target = NodePath.join(g.root, path);
        if (yield* exists(target)) continue;
        const text = yield* checkpoints.readFileAt({ cwd: g.root, revision: work, path });
        if (text === null) continue;
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
          await NodeFSP.writeFile(target, text, { flag: "wx" }).catch(() => undefined);
        });
      }
      const cwd = shell.worktreePath;
      if (cwd === null) return;
      const kept = yield* Effect.promise(() =>
        NodeFSP.readdir(NodePath.join(cwd, KEPT_DIR)).catch(() => [] as string[]),
      );
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(g.root, KEPT_DIR), { recursive: true });
        for (const name of kept)
          await NodeFSP.copyFile(
            NodePath.join(cwd, KEPT_DIR, name),
            NodePath.join(g.root, KEPT_DIR, name),
            NodeFSP.constants.COPYFILE_EXCL,
          ).catch(() => undefined);
      });
    });

  const health = (g: Game, from: string, candidate: string, copyId: ThreadId) =>
    Effect.gen(function* () {
      const flight = inFlight.get(copyId);
      const plays = yield* Effect.promise(() =>
        savedPlays(g.root).then(
          (saved) => Math.min(saved.plays.length, SAVED_PLAYS_PER_BUILD),
          () => 0,
        ),
      );
      const progress = (play: number) =>
        Effect.suspend(() => {
          if (flight === undefined) return Effect.void;
          flight.progress = { play, plays };
          return operations.changed(g.root, GAME_BUILDS_EVENT, "A bring-in is being checked.");
        });
      yield* progress(0);
      // The candidate's facts say how far its check is: its boot, then each test play.
      const said = `Build ${candidate.slice(0, 8)}: test play `;
      yield* operations.events.pipe(
        Stream.filter(
          (event) =>
            event.root === g.root &&
            event.name === GAME_FACTS_EVENT &&
            event.message.startsWith(said),
        ),
        Stream.runForEach((event) => progress(Number.parseInt(event.message.slice(said.length)))),
        Effect.forkScoped,
      );
      const resolved = (build: string) =>
        checkpoints.resolveTrees({ cwd: g.root, revisions: [build], path: g.lane }).pipe(
          Effect.map(([tree]) => tree ?? null),
          Effect.orElseSucceed(() => null),
        );
      const engine = (yield* projects.read(g.root)).engine.name;
      const measure = (build: string) =>
        Effect.flatMap(resolved(build), (tree) =>
          tree === null || !isGameBuildId(build)
            ? Effect.succeed<GameBuildFacts | null>(null)
            : facts.measure(
                { root: g.root, build, key: `${engine}:${tree}`, engine },
                { queue: "person", upTo: "boots", waitFor: CHECK_WAIT },
              ),
        );
      // Bring in now ends the wait: the check goes on in the background, and lands nothing.
      const measured = yield* Effect.raceFirst(
        Effect.all([measure(from), measure(candidate)]).pipe(Effect.asSome),
        flight === undefined
          ? Effect.never
          : Deferred.await(flight.skip).pipe(Effect.as(Option.none())),
      );
      if (Option.isNone(measured)) return null;
      const [before, after] = measured.value;
      if (before === null || after === null) return null;
      const broke = regressions(before, after).map((each) => each.why);
      // Each saved play read on its own: one that ended the same on the game and ends otherwise
      // with the copy's work. (The two builds' facts may hold different saved sets.)
      const readings = (facts: GameBuildFacts) =>
        facts.savedPlays?.status === "measured" ? facts.savedPlays.value.plays : [];
      const was = new Map(readings(before).map((each) => [each.name, each.reading]));
      const changed = readings(after).filter(
        (each) => each.reading === "ending-changed" && was.get(each.name) !== "ending-changed",
      );
      const reasons = [
        ...broke,
        ...changed.map(
          (each) =>
            `the test play "${each.name}" now ends "${each.now?.text ?? "differently"}" (it ended "${each.saved.text}")`,
        ),
      ];
      return reasons.length === 0 ? null : reasons.join("; ");
    }).pipe(Effect.scoped);

  // In the service's own fiber, as a restore is: a caller that goes away (an agent's tool call
  // timing out during a long check) stops waiting, never the check and landing.
  // A second ask while one runs joins it; with `anyway` it is Bring in now, ending the check's wait.
  const bringIn: GameCopies["Service"]["bringIn"] = (input, options = {}) =>
    Effect.gen(function* () {
      const copyId = input.chat ?? input.threadId;
      const running = inFlight.get(copyId);
      if (running !== undefined) {
        if (input.anyway === true) yield* Deferred.succeed(running.skip, undefined);
        return yield* Fiber.join(running.fiber);
      }
      const skip = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkIn(
        bringInNow(input, options).pipe(
          Effect.ensuring(
            Effect.suspend(() => {
              inFlight.delete(copyId);
              return Effect.void;
            }),
          ),
        ),
        scope,
        { startImmediately: false },
      );
      inFlight.set(copyId, { fiber, skip, progress: null });
      return yield* Fiber.join(fiber);
    });
  const bringInNow = (input: GameBringInInput, options: { readonly agent?: boolean }) =>
    Effect.gen(function* () {
      const operation = "Bring in";
      const copyId = input.chat ?? input.threadId;
      const g = yield* gameOf(copyId);
      const asker = yield* projects.home(input.threadId);
      if (asker.projectId !== g.projectId)
        return yield* failed(operation, g.root, "invalid-input", "That chat is not of this game.");
      const shell = yield* shellOf(copyId);
      if (
        options.agent === true &&
        copyId !== input.threadId &&
        shell.lineage.parentThreadId !== input.threadId
      )
        return yield* failed(
          operation,
          g.root,
          "invalid-input",
          "An agent brings in its own copy or a child it delegated; the person brings in other chats.",
        );
      const seated = yield* seatOf(g, shell);
      if (seated === null) return yield* failed(operation, g.root, "invalid-input", NO_SEAT);
      if (atWork(shell) && copyId !== input.threadId)
        return yield* failed(
          operation,
          g.root,
          "busy",
          `${shell.title} is still working in its copy: bring it in once its turn ends.`,
        );
      // Keep the game's: the copy takes the game's file first. After a conflict the copy's seat is
      // the game, so a merge alone would bring the copy's file in again.
      const takeGame = Object.entries(input.keep ?? {}).flatMap(([path, side]) =>
        side === "game" ? [path] : [],
      );
      const copyCwd = shell.worktreePath;
      if (takeGame.length > 0 && copyCwd !== null && (yield* exists(copyCwd))) {
        const game = yield* captureGame(g, copyId);
        yield* checkpoints
          .withWorkspaceLock(
            copyCwd,
            checkpoints.restoreCheckpoint({
              cwd: copyCwd,
              checkpointRef: CheckpointRef.make(game),
              filePaths: takeGame,
            }),
          )
          .pipe(Effect.mapError(io(operation, copyCwd, "the game's file could not be kept")));
      }
      const work = yield* workOf(g, shell);
      if (work === null)
        return yield* failed(operation, g.root, "invalid-input", "This chat works in no copy.");
      const request = NodeCrypto.createHash("sha256")
        .update(`${g.root}\0bring-in\0${copyId}\0${input.commandId ?? work}`)
        .digest("hex")
        .slice(0, 32);
      for (let attempt = 0; ; attempt += 1) {
        const game = yield* captureGame(g, copyId);
        const restored = isRestored(g.lane);
        // Always merged, never a fast-forward to the copy's tree: what the check plays must hold
        // the game's saved plays and notes, which live outside what a build is.
        const merged = yield* mergeBuilds(checkpoints, {
          root: g.root,
          tuneFile: g.tuneFile,
          union: g.union,
          base: seated,
          ours: game,
          theirs: work,
          game: "ours",
          ...(input.keep === undefined ? {} : { keep: input.keep }),
          within: restored,
        }).pipe(Effect.mapError(io(operation, g.root, "the copy's work could not be merged")));
        if (merged.conflicts.length > 0) {
          // Back to the copy, never the game: it holds both sides now, seated on this game.
          const files =
            shell.worktreePath === null
              ? merged.conflicts
              : yield* updateTo(g, shell, seated, game);
          yield* writeOutcome(copyId, { _tag: "conflicts", files, at: yield* now });
          yield* operations.changed(g.root, GAME_BUILDS_EVENT, "A bring-in has conflicts.");
          return {
            _tag: "conflicts",
            files,
            message: `Nothing came in: ${files.map((each) => each.path).join(", ")} changed in the game and in the copy. The copy now holds both sides${files.some((each) => each.binary) ? "; for art, sound and models keep the game's or the copy's" : ""}. Resolve them in the copy, then bring it in again.`,
          } as const;
        }
        const tree = merged.tree;
        const candidate = yield* checkpoints
          .commitTree({ cwd: g.root, tree, parent: game, message: `Brought in ${shell.title}` })
          .pipe(Effect.mapError(io(operation, g.root, "the copy's work could not be kept")));
        if (!(yield* measureChange(checkpoints, g.root, restored, game, candidate)).changed) {
          yield* writeOutcome(copyId, null);
          if (input.close === true) yield* close(g, shell);
          return {
            _tag: "same",
            message: "The game already has everything this copy made.",
          } as const;
        }
        if (input.anyway !== true) {
          const lost = yield* health(g, game, candidate, copyId);
          if (lost !== null) {
            yield* writeOutcome(copyId, { _tag: "held", reason: lost, at: yield* now });
            yield* operations.changed(g.root, GAME_BUILDS_EVENT, "A bring-in is held.");
            return {
              _tag: "held",
              reason: lost,
              message: `Nothing came in: with this copy's work ${lost}. Bring in anyway lands it; Undo takes it out again.`,
            } as const;
          }
        }
        if (!isGameBuildId(game))
          return yield* failed(operation, g.root, "io", "the game folder is not a build");
        const landed = yield* builds.land(input.threadId, {
          request: attempt === 0 ? request : `${request.slice(0, 30)}-${attempt}`,
          tree,
          from: game,
          kind: "in",
          label: `Brought in ${shell.title}`,
        });
        // The folder changed between the read and the move (a kept edit): read it again, once.
        if (landed.moved === "moved-on") {
          if (attempt === 0) continue;
          return yield* failed(
            operation,
            g.root,
            "busy",
            "The game kept changing while it was brought in, so nothing came in. Try again.",
          );
        }
        yield* bringPlays(g, shell, game, work).pipe(Effect.ignore);
        yield* recordDecision(g.root, {
          kind: "brought-in",
          text: `Brought in ${shell.title}`,
          build: landed.build,
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("A bring-in could not be kept in the game's decisions.", {
              cause: Cause.pretty(cause),
            }),
          ),
        );
        yield* writeOutcome(copyId, null);
        yield* markMove(g.root, copyId, "brought", landed.build).pipe(Effect.ignore);
        const number = (yield* builds
          .list(input.threadId, { home: true, limit: 10 })
          .pipe(Effect.orElseSucceed(() => ({ builds: [] })))).builds.find(
          (build) => build.id === landed.build,
        )?.number;
        const said =
          number == null ? "Brought into the game." : `Brought into the game as Build ${number}.`;
        // The person's bring-in is a line in the copy's chat; an agent's is its own tool call.
        if (options.agent !== true) {
          yield* engine
            .dispatch({
              type: "game.notice",
              commandId: CommandId.make(`game-copy:in:${copyId}:${short(landed.build)}`),
              threadId: copyId,
              notice: said,
              createdBy: "user",
              creationSource: "web",
            })
            .pipe(Effect.ignoreCause({ log: true }));
        }
        // The copy goes on from the game it came into, or goes.
        if (input.close === true) yield* close(g, shell);
        else if (shell.worktreePath !== null)
          yield* updateTo(g, shell, seated, landed.build).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("A copy could not take the build it was brought in as.", {
                cause: Cause.pretty(cause),
              }),
            ),
          );
        yield* operations.changed(g.root, GAME_BUILDS_EVENT, `Brought in ${shell.title}.`);
        return {
          _tag: "landed",
          build: landed.build,
          message: `${said} Undo takes it out again.`,
        } as const;
      }
    });

  const update: GameCopies["Service"]["update"] = (threadId, asking) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId);
      const shell = yield* shellOf(threadId);
      if (atWork(shell) && threadId !== asking)
        return yield* failed(
          "Update",
          g.root,
          "busy",
          `${shell.title} is working in its copy: update it once its turn ends.`,
        );
      const seated = yield* seatOf(g, shell);
      if (seated === null) return yield* failed("Update", g.root, "invalid-input", NO_SEAT);
      // The game's newest build: never a folder another chat is half way through writing.
      const listed = yield* builds.list(threadId, { home: true, limit: 1 });
      const game = listed.current;
      if (game === null) return { conflicts: [], message: "The game has no build to take yet." };
      if (!(yield* measureChange(checkpoints, g.root, isRestored(g.lane), seated, game)).changed)
        return { conflicts: [], message: "The copy already has the game's newest build." };
      const conflicts = yield* updateTo(g, shell, seated, game);
      yield* operations.changed(g.root, GAME_BUILDS_EVENT, "A copy took the game's newer work.");
      return {
        conflicts,
        message:
          conflicts.length === 0
            ? "The copy has the game's newer work now."
            : `The copy has the game's newer work, but ${conflicts.map((each) => each.path).join(", ")} changed on both sides: they hold both now, to resolve.`,
      };
    });

  const throwAway: GameCopies["Service"]["throwAway"] = (threadId, asking) =>
    Effect.gen(function* () {
      const g = yield* gameOf(threadId);
      const shell = yield* shellOf(threadId);
      if (shell.worktreePath === null) return { message: "This chat works in no copy." };
      if (atWork(shell) && threadId !== asking)
        return yield* failed(
          "Throw away",
          g.root,
          "busy",
          `${shell.title} is working in its copy: stop its turn first.`,
        );
      // Its work stays a record, so Bring in can still take it.
      yield* workOf(g, shell);
      yield* close(g, shell);
      yield* writeOutcome(threadId, null);
      yield* operations.changed(g.root, GAME_BUILDS_EVENT, "A copy was thrown away.");
      return {
        message: `${shell.title}'s copy is gone and the chat works in the game. Its work is kept: Bring in still takes it.`,
      };
    });

  const copyNote: GameCopies["Service"]["copyNote"] = (threadId) =>
    place(threadId).pipe(
      Effect.map((placed) => {
        if (placed._tag !== "copy") return null;
        const of = placed.seatNumber === null ? "the game" : `Build ${placed.seatNumber}`;
        const ahead =
          placed.ahead === 0
            ? "the game has no newer build."
            : `the game is ${placed.ahead} build${placed.ahead === 1 ? "" : "s"} ahead. Use game_builds op update to take its newer work.`;
        return `You work in a copy of ${of}; ${ahead} Your work reaches the game only through game_builds op bring_in.`;
      }),
      Effect.orElseSucceed(() => null),
    );

  const discard: GameCopies["Service"]["discard"] = (root, threadId) =>
    Effect.gen(function* () {
      const where = placeOf(root, threadId, yield* repoPrefix(root));
      yield* git
        .removeWorktree({ cwd: root, path: where.worktree, force: true })
        .pipe(Effect.ignore);
      yield* Effect.promise(() => NodeFSP.rm(where.worktree, { recursive: true, force: true }));
      yield* git.pruneWorktrees({ cwd: root }).pipe(Effect.ignore);
    });

  const adopt: GameCopies["Service"]["adopt"] = (input) =>
    Effect.forEach(
      [
        [worktreeSeedRef(input.threadId), input.seat],
        [workRef(input.threadId), input.work],
      ] as const,
      ([checkpointRef, oid]) =>
        checkpoints
          .updateCheckpointRef({ cwd: input.root, checkpointRef, oid })
          .pipe(Effect.mapError(io("Bring in", input.root, "the copy's record could not be kept"))),
      { discard: true },
    );

  // A turn in a copy is told where it works, as its start reads it.
  yield* (yield* GameCopyNotes.GameCopyNotes).attach(copyNote);
  return GameCopies.of({
    discard,
    adopt,
    copies,
    place,
    seat,
    runInCopy,
    bringIn,
    update,
    throwAway,
    copyNote,
  });
});

export const layer = Layer.effect(GameCopies, make);
