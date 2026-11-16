// @effect-diagnostics nodeBuiltinImport:off -- Versions work in git worktrees on disk, and a version's briefing reads BRIEF.md.
// "Try it N ways": a message built N ways at once, each version a child thread
// of the chat working in its own git worktree of the game, so the game folder
// has one writer only. A version's build is its turn checkpoint; keeping one
// is the one restore every Undo takes, and a notice on the try's run records
// which was kept. See gameTries.ts for how a try is read back.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  CommandId,
  GAME_BUILDS_EVENT,
  type GameBuildRestoreResult,
  GameOperationError,
  type GameTriesResult,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
} from "@kurambit/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as GameTries from "../orchestration-v2/gameVersions/GameTries.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as GameBuilds from "./GameBuilds.ts";
import { recordDecision } from "./GameDecisions.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameRunControl from "./GameRunControl.ts";
import {
  readTry,
  triesInRefs,
  tryBaseRef,
  tryStartCommandId,
  versionLeftRef,
} from "./gameTries.ts";

/** Under the worktrees folder, beside the build copies. */
const GAME_VERSIONS = "game-versions";
const TRIES_LISTED = 8;
const BRIEF_MAX = 2500;
const REPLY_MAX = 2000;

const short = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/** What version n of `of` is asked: the person's words, its number, and a different approach. */
const versionTask = (input: {
  readonly text: string;
  readonly n: number;
  readonly of: number;
  readonly brief: string | null;
  readonly lastReply: string | null;
}) => {
  const section = (title: string, body: string | null) =>
    body === null || body.trim() === "" ? [] : [`${title}\n${body.trim()}`];
  return [
    input.text.trim(),
    `You are version ${input.n} of ${input.of}: ${input.of} sessions build this same request at once, each in its own copy of the game, and the person plays them all and keeps one. Take a clearly different approach from the others; you choose it. Start your final reply with one line naming your approach.`,
    "---",
    "This version runs in a session of its own, without the chat's history. What you need about the game is below; read its files only as far as this change needs.",
    ...section("BRIEF.md:", input.brief === null ? null : clip(input.brief, BRIEF_MAX)),
    ...section(
      "The chat's last reply:",
      input.lastReply === null ? null : clip(input.lastReply, REPLY_MAX),
    ),
  ].join("\n\n");
};

/** The game folder's path inside its repository ("" at the top): a version's cwd is the same path in its worktree. */
const repoPrefix = async (root: string) => {
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
};

export class GameVersions extends Context.Service<
  GameVersions,
  {
    /** The chat's tries, newest first, with each version's state, build and approach. */
    readonly tries: (threadId: ThreadId) => Effect.Effect<GameTriesResult, GameOperationError>;
    /** The game folder becomes version n's build, through the one restore; the try records the keep. */
    readonly keep: (
      threadId: ThreadId,
      input: { readonly runId: string; readonly n: number; readonly commandId: string },
    ) => Effect.Effect<typeof GameBuildRestoreResult.Type, GameOperationError>;
    /** A version child's turn checkpoint or end: measures its build and frees its worktree. */
    readonly landed: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    /** Startup: worktrees of settled versions (or of tries that never started) are removed. */
    readonly sweep: Effect.Effect<void>;
  }
>()("kurambit/game/GameVersions") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const projects = yield* GameProjectService.GameProjectService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const engine = yield* Orchestrator.OrchestratorV2;
  const builds = yield* GameBuilds.GameBuilds;
  const operations = yield* GameOperations.GameOperations;
  const preview = yield* GamePreview.GamePreview;
  const runControl = yield* GameRunControl.GameRunControl;
  const tryStarts = yield* GameTries.GameTries;
  const versionsRoot = NodePath.join(config.worktreesDir, GAME_VERSIONS);

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

  /** Where version n of a try works: its worktree, and its cwd there (the game's own path in the repo). */
  const placeOf = (root: string, runId: string, n: number, prefix: string) => {
    const worktree = NodePath.join(
      versionsRoot,
      `${NodePath.basename(root)}-${short(root)}`,
      `${short(runId)}-${n}`,
    );
    return { worktree, cwd: prefix === "" ? worktree : NodePath.join(worktree, prefix) };
  };

  const oidsOf = (root: string) =>
    checkpoints
      .listCheckpointRefs({ cwd: root, prefix: "refs/kurambit/" })
      .pipe(
        Effect.map((refs) => new Map(refs.map((ref) => [ref.checkpointRef as string, ref.oid]))),
      );

  const removeWorktree = (root: string, worktree: string, cwd: string) =>
    Effect.gen(function* () {
      yield* preview.forget(cwd);
      const there = yield* Effect.promise(() =>
        NodeFSP.lstat(worktree).then(
          () => true,
          () => false,
        ),
      );
      if (!there) return;
      yield* git.removeWorktree({ cwd: root, path: worktree, force: true });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("A version's worktree could not be removed.", { worktree, cause }),
      ),
    );

  const lastReply = (threadId: ThreadId, before: number) =>
    Effect.gen(function* () {
      const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
      const previous = runs
        .filter(
          (run) => run.ordinal < before && run.status === "completed" && run.versions === undefined,
        )
        .toSorted((a, b) => b.ordinal - a.ordinal)[0];
      if (previous === undefined) return null;
      const { messages } = yield* projections.getThreadRecords(threadId, ["messages"], {
        messageRoles: ["assistant"],
        messageRunIds: [previous.id],
      });
      return messages.at(-1)?.text ?? null;
    }).pipe(Effect.orElseSucceed(() => null));

  const start: GameTries.GameTryStarter["start"] = (input) =>
    Effect.gen(function* () {
      const refuse = (message: string) => Effect.fail(new GameTries.GameTryStartError({ message }));
      const root = yield* projects.resolve(input.threadId).pipe(
        Effect.mapError(
          () =>
            new GameTries.GameTryStartError({
              message: "Trying several ways works in a game's chat only.",
            }),
        ),
      );
      const keepGoing = yield* runControl
        .status(input.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (keepGoing !== null && keepGoing.mode !== "off")
        return yield* refuse("Keep going is on for this game: turn it off to try several ways.");
      const thread = yield* projections
        .getThreadRecords(input.threadId, ["runs"])
        .pipe(
          Effect.mapError(
            () => new GameTries.GameTryStartError({ message: "The chat could not be read." }),
          ),
        );
      const run = thread.runs.find((each) => each.id === input.runId);
      if (run === undefined) return yield* refuse("The try's turn is gone.");
      const prefix = yield* Effect.promise(() => repoPrefix(root));
      const places = Array.from({ length: input.versions }, (_, i) =>
        placeOf(root, input.runId, i + 1, prefix),
      );
      // The base and the worktrees, as one operation of the game: the folder is read as the
      // turns before this one left it, and nothing writes it meanwhile.
      yield* projects
        .exclusive(
          input.threadId,
          "Try ways",
          (gameRoot) =>
            Effect.gen(function* () {
              const ref = tryBaseRef(input.threadId, run.ordinal);
              const known = (yield* oidsOf(gameRoot)).get(ref);
              const base =
                known ??
                (yield* checkpoints.withWorkspaceLock(
                  gameRoot,
                  checkpoints.captureCheckpoint({ cwd: gameRoot, checkpointRef: ref }),
                ));
              for (const place of places) {
                const there = yield* Effect.promise(() =>
                  NodeFSP.lstat(NodePath.join(place.worktree, ".git")).then(
                    () => true,
                    () => false,
                  ),
                );
                if (!there) {
                  yield* Effect.promise(() =>
                    NodeFSP.rm(place.worktree, { recursive: true, force: true }),
                  );
                  yield* git.pruneWorktrees({ cwd: gameRoot }).pipe(Effect.ignore);
                  yield* git.createWorktree({ cwd: gameRoot, refName: base, path: place.worktree });
                }
              }
            }),
          { waitUntil: (yield* Clock.currentTimeMillis) + 60_000 },
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("A try's versions could not be set up.", { root, cause }).pipe(
              Effect.andThen(
                refuse("The game folder could not be copied for the versions; nothing was tried."),
              ),
            ),
          ),
        );
      const brief = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(root, "BRIEF.md"), "utf8").catch(() => null),
      );
      const reply = yield* lastReply(input.threadId, run.ordinal);
      yield* engine
        .dispatch({
          type: "game-version.start",
          commandId: tryStartCommandId(input.runId),
          threadId: input.threadId,
          runId: input.runId,
          versions: places.map((place, i) => ({
            n: i + 1,
            title: `Version ${i + 1}`,
            worktreePath: place.cwd,
            task: versionTask({
              text: input.text,
              n: i + 1,
              of: input.versions,
              brief,
              lastReply: reply,
            }),
          })),
          notice: `Trying ${input.versions} ways, each version in its own copy of the game as it is now. Play them on the Stage and keep one.`,
          createdBy: "system",
          creationSource: "server",
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("A try's versions could not be dispatched.", { root, cause }).pipe(
              Effect.andThen(
                Effect.forEach(places, (place) => removeWorktree(root, place.worktree, place.cwd)),
              ),
              Effect.andThen(refuse("The versions could not be started.")),
            ),
          ),
        );
      yield* operations.changed(root, GAME_BUILDS_EVENT, "A try started.");
    });

  const tries: GameVersions["Service"]["tries"] = (threadId) =>
    Effect.gen(function* () {
      const root = yield* projects.resolve(threadId);
      const oids = yield* oidsOf(root).pipe(
        Effect.mapError((cause) =>
          failed("Tries", root, "io", "the game's builds could not be listed", cause),
        ),
      );
      const ofChat = triesInRefs(oids.keys()).filter((each) => each.threadId === threadId);
      const read = yield* Effect.forEach(
        ofChat,
        (each) => readTry(projections, oids, each.threadId, each.runId).pipe(Effect.option),
        { concurrency: 4 },
      );
      const listed = read.flatMap((each) =>
        each._tag === "Some" && each.value !== null ? [each.value] : [],
      );
      return {
        tries: listed
          .toSorted((a, b) => (a.at < b.at ? 1 : -1))
          .slice(0, TRIES_LISTED)
          .map(({ versions, of: _of, ...rest }) => ({
            ...rest,
            versions: versions.map(({ capturedAt: _capturedAt, ...version }) => version),
          })),
      };
    });

  const keep: GameVersions["Service"]["keep"] = (threadId, input) =>
    Effect.gen(function* () {
      const root = yield* projects.resolve(threadId);
      const oids = yield* oidsOf(root).pipe(
        Effect.mapError((cause) =>
          failed("Keep version", root, "io", "the game's builds could not be listed", cause),
        ),
      );
      const read = yield* readTry(projections, oids, threadId, input.runId).pipe(
        Effect.mapError((cause) =>
          failed("Keep version", root, "io", "the try could not be read", cause),
        ),
      );
      const version = read?.versions.find((each) => each.n === input.n);
      if (read === null || version === undefined)
        return yield* failed(
          "Keep version",
          root,
          "invalid-input",
          `There is no version ${input.n}.`,
        );
      if (version.build === null)
        return yield* failed(
          "Keep version",
          root,
          "invalid-input",
          `Version ${input.n} has no build yet: keep it once it has finished.`,
        );
      // The chat's own turn writes the folder; a keep waits for it, as Undo does.
      const shell = yield* projections
        .getThreadShell(threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell !== null && shell.activeRunId !== null)
        return yield* failed(
          "Keep version",
          root,
          "busy",
          "This chat's agent is at work in the game folder: keep a version once its turn ends.",
        );
      const result = yield* builds.restore(
        threadId,
        { _tag: "build", build: version.build },
        `keep-version\0${input.runId}\0${input.n}\0${input.commandId}`,
      );
      if (result.moved === "restored" || result.moved === "current") {
        yield* engine
          .dispatch({
            type: "game-version.kept",
            commandId: CommandId.make(`game-version:kept:${short(input.commandId)}`),
            threadId,
            runId: input.runId as RunId,
            n: input.n,
            notice:
              version.approach === ""
                ? `Kept version ${input.n}.`
                : `Kept version ${input.n}: ${version.approach}`,
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(
            Effect.mapError((cause) =>
              failed(
                "Keep version",
                root,
                "io",
                "the game folder holds the version, but the chat could not record the keep",
                cause,
              ),
            ),
          );
        if (result.moved === "restored") {
          const others = read.versions.filter((each) => each.n !== input.n).map((each) => each.n);
          yield* recordDecision(root, {
            kind: "kept-over",
            text: `Kept version ${input.n} of "${read.request}"${version.approach === "" ? "" : ` (${version.approach})`}${others.length === 0 ? "" : ` over ${others.join(" and ")}`}`,
            build: version.build,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("A kept version could not be kept in the game's decisions.", {
                cause: Cause.pretty(cause),
              }),
            ),
          );
        }
        yield* operations.changed(root, GAME_BUILDS_EVENT, `Kept version ${input.n}.`);
      }
      return {
        requestId: result.requestId,
        done: result.done,
        message:
          result.moved === "restored"
            ? `Version ${input.n} is in the game folder now.`
            : result.message,
      };
    });

  /** The try a version child belongs to, read from its own thread: its chat and place. */
  const versionOf = (childThreadId: ThreadId) =>
    Effect.gen(function* () {
      const shell = yield* projections.getThreadShell(childThreadId);
      const chat = shell?.lineage.parentThreadId ?? null;
      if (shell === null || chat === null || shell.lineage.relationshipToParent !== "subagent")
        return null;
      const thread = yield* projections.getThread(childThreadId);
      const cwd = thread.worktreePath;
      if (cwd === null || !NodePath.resolve(cwd).startsWith(`${versionsRoot}${NodePath.sep}`))
        return null;
      const relative = NodePath.relative(versionsRoot, cwd).split(NodePath.sep);
      const worktree = NodePath.join(versionsRoot, relative[0] ?? "", relative[1] ?? "");
      return { chat, cwd, worktree };
    }).pipe(Effect.orElseSucceed(() => null));

  const isOver = (status: OrchestrationV2Run["status"]) =>
    status === "completed" ||
    status === "failed" ||
    status === "interrupted" ||
    status === "cancelled";

  /**
   * A version whose turn is over loses its worktree once its work is a build: its turn's
   * checkpoint, or, when the turn ended with none (a restart cancels it), a capture of the
   * worktree as it was left. The child is read-only, so nothing writes there again.
   */
  const settle = (childThreadId: ThreadId, worktree: string, cwd: string) =>
    Effect.gen(function* () {
      const records = yield* projections.getThreadRecords(childThreadId, ["runs", "checkpoints"]);
      const latest = records.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
      if (latest === undefined || records.runs.some((run) => !isOver(run.status))) return;
      const checkpointed = records.checkpoints.some(
        (each) => each.id === latest.checkpointId && each.status === "ready",
      );
      const there = yield* Effect.promise(() =>
        NodeFSP.lstat(NodePath.join(worktree, ".git")).then(
          () => true,
          () => false,
        ),
      );
      if (!checkpointed && there)
        yield* checkpoints.withWorkspaceLock(
          cwd,
          checkpoints.captureCheckpoint({ cwd, checkpointRef: versionLeftRef(childThreadId) }),
        );
      yield* preview.forget(cwd);
      // The worktree's own .git file names its repository.
      const gitFile = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(worktree, ".git"), "utf8").catch(() => null),
      );
      const gitDir = gitFile?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim() ?? null;
      const repo = gitDir === null ? null : NodePath.resolve(gitDir, "..", "..", "..");
      if (repo !== null)
        yield* git.removeWorktree({ cwd: repo, path: worktree, force: true }).pipe(Effect.ignore);
      yield* Effect.promise(() => NodeFSP.rm(worktree, { recursive: true, force: true }));
      if (repo !== null) yield* git.pruneWorktrees({ cwd: repo }).pipe(Effect.ignore);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("A version's worktree could not be settled.", {
          worktree,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const landed: GameVersions["Service"]["landed"] = (event) =>
    Effect.gen(function* () {
      if (event.type !== "checkpoint.captured" && event.type !== "run.updated") return;
      const version = yield* versionOf(event.threadId);
      if (version === null) return;
      const root = yield* projects.resolve(version.chat);
      if (event.type === "checkpoint.captured") {
        if (event.payload.status !== "ready") return;
        const oid = (yield* oidsOf(root)).get(event.payload.ref);
        // Measured in the game's name: facts are keyed by content, so a kept version has them.
        if (oid !== undefined) yield* builds.measureIn(root, oid);
        yield* operations.changed(root, GAME_BUILDS_EVENT, "A version landed.");
        // A stopped turn's checkpoint follows its end.
        yield* settle(event.threadId, version.worktree, version.cwd);
        return;
      }
      if (!isOver(event.payload.status)) return;
      yield* operations.changed(root, GAME_BUILDS_EVENT, "A version ended.");
      if (event.payload.checkpointId !== null)
        yield* settle(event.threadId, version.worktree, version.cwd);
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("A version's landing failed.", { cause })),
    );

  /** Startup: every version worktree whose turn is over is settled; one no thread owns goes. */
  const sweep: GameVersions["Service"]["sweep"] = Effect.gen(function* () {
    const games = yield* Effect.promise(() =>
      NodeFSP.readdir(versionsRoot, { withFileTypes: true }).catch(() => []),
    );
    const worktreePaths = yield* projections.getThreadWorktreePaths();
    for (const game of games) {
      if (!game.isDirectory()) continue;
      const dir = NodePath.join(versionsRoot, game.name);
      const versions = yield* Effect.promise(() => NodeFSP.readdir(dir).catch(() => []));
      for (const name of versions) {
        const worktree = NodePath.join(dir, name);
        // The cwd may sit below the worktree when the game is a subfolder of its repository.
        const owner = worktreePaths.find((each) => {
          const path = NodePath.resolve(each.worktreePath);
          return path === worktree || path.startsWith(`${worktree}${NodePath.sep}`);
        });
        // A worktree no version owns is a try whose start never committed.
        if (owner === undefined) {
          yield* Effect.promise(() => NodeFSP.rm(worktree, { recursive: true, force: true }));
          continue;
        }
        yield* settle(owner.threadId, worktree, NodePath.resolve(owner.worktreePath));
      }
    }
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("The versions sweep failed.", { cause })));

  yield* tryStarts.attach({ start });
  return GameVersions.of({ tries, keep, landed, sweep });
});

export const layer = Layer.effect(GameVersions, make);
