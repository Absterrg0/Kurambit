// @effect-diagnostics nodeBuiltinImport:off -- A version's briefing reads BRIEF.md.
// "Try it N ways": a message built N ways at once, each version a child thread of the chat
// working in a copy of the game seated on the try's base (GameCopies), so the game folder has
// one writer only. A version's build is its turn checkpoint; keeping one is a Bring in of that
// copy, merged against the try's base so builds that landed since stay, and the other copies
// are thrown away (their builds stay reachable). A notice on the try's run records which was
// kept. See gameTries.ts for how a try is read back.
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
import * as GameTries from "../orchestration-v2/gameVersions/GameTries.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as GameBuilds from "./GameBuilds.ts";
import * as GameCopies from "./GameCopies.ts";
import { recordDecision } from "./GameDecisions.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameRunControl from "./GameRunControl.ts";
import {
  readTry,
  triesInRefs,
  tryBaseRef,
  tryStartCommandId,
  versionLeftRef,
  versionThreadId,
} from "./gameTries.ts";
import { worktreeSeedRef as worktreeSeedRefOf } from "../checkpointing/worktreeSeed.ts";

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

export class GameVersions extends Context.Service<
  GameVersions,
  {
    /** The chat's tries, newest first, with each version's state, build and approach. */
    readonly tries: (threadId: ThreadId) => Effect.Effect<GameTriesResult, GameOperationError>;
    /** Version n's copy is brought in, the others thrown away; the try records the keep. */
    readonly keep: (
      threadId: ThreadId,
      input: { readonly runId: string; readonly n: number; readonly commandId: string },
    ) => Effect.Effect<typeof GameBuildRestoreResult.Type, GameOperationError>;
    /** A version child's turn checkpoint or end: its build measured in the game's name, the rail told. */
    readonly landed: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("kurambit/game/GameVersions") {}

const make = Effect.gen(function* () {
  const projects = yield* GameProjectService.GameProjectService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const engine = yield* Orchestrator.OrchestratorV2;
  const builds = yield* GameBuilds.GameBuilds;
  const operations = yield* GameOperations.GameOperations;
  const copies = yield* GameCopies.GameCopies;
  const runControl = yield* GameRunControl.GameRunControl;
  const tryStarts = yield* GameTries.GameTries;

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

  const oidsOf = (root: string) =>
    checkpoints
      .listCheckpointRefs({ cwd: root, prefix: "refs/kurambit/" })
      .pipe(
        Effect.map((refs) => new Map(refs.map((ref) => [ref.checkpointRef as string, ref.oid]))),
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
      const children = Array.from({ length: input.versions }, (_, i) =>
        versionThreadId(input.runId, i + 1),
      );
      // The base and the copies, as one operation of the game: the folder is read as the
      // turns before this one left it, and nothing writes it meanwhile. Each version is a copy
      // seated on the base, so Keep merges against it.
      const places = yield* projects
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
              return yield* Effect.forEach(children, (threadId) =>
                copies.seat({ root: gameRoot, threadId, seat: base, repoint: false }),
              );
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
                Effect.forEach(children, (child) => copies.discard(root, child), { discard: true }),
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
      // A version from before its copy was kept: its seat and work as the try recorded them.
      if (oids.get(worktreeSeedRefOf(version.childThreadId)) === undefined && read.base !== null)
        yield* copies.adopt({
          root,
          threadId: version.childThreadId,
          seat: read.base,
          work: version.build,
        });
      const brought = yield* copies.bringIn({
        threadId,
        chat: version.childThreadId,
        close: true,
        commandId: `keep-version\0${input.runId}\0${input.n}\0${input.commandId}`,
      });
      if (brought._tag === "landed" || brought._tag === "same") {
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
                "the game holds the version, but the chat could not record the keep",
                cause,
              ),
            ),
          );
        const others = read.versions.filter((each) => each.n !== input.n);
        // The others' copies go; their builds stay reachable on the rail.
        yield* Effect.forEach(
          others,
          (each) => copies.throwAway(each.childThreadId, threadId).pipe(Effect.ignore),
          { discard: true },
        );
        if (brought._tag === "landed")
          yield* recordDecision(root, {
            kind: "kept-over",
            text: `Kept version ${input.n} of "${read.request}"${version.approach === "" ? "" : ` (${version.approach})`}${others.length === 0 ? "" : ` over ${others.map((each) => each.n).join(" and ")}`}`,
            build: brought.build,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("A kept version could not be kept in the game's decisions.", {
                cause: Cause.pretty(cause),
              }),
            ),
          );
        yield* operations.changed(root, GAME_BUILDS_EVENT, `Kept version ${input.n}.`);
      }
      return {
        requestId: input.commandId,
        done: brought._tag === "landed" || brought._tag === "same",
        message:
          brought._tag === "landed"
            ? `Version ${input.n} is in the game now; builds that landed since the try stay.`
            : brought.message,
      };
    });

  /** A child of a game's chat working in a copy (a try's version, a delegated child): its cwd. */
  const childCopyOf = (childThreadId: ThreadId) =>
    Effect.gen(function* () {
      const shell = yield* projections.getThreadShell(childThreadId);
      if (
        shell === null ||
        shell.lineage.parentThreadId === null ||
        shell.lineage.relationshipToParent !== "subagent" ||
        shell.worktreePath === null
      )
        return null;
      return { cwd: shell.worktreePath };
    }).pipe(Effect.orElseSucceed(() => null));

  const isOver = (status: OrchestrationV2Run["status"]) =>
    status === "completed" ||
    status === "failed" ||
    status === "interrupted" ||
    status === "cancelled";

  const landed: GameVersions["Service"]["landed"] = (event) =>
    Effect.gen(function* () {
      if (event.type !== "checkpoint.captured" && event.type !== "run.updated") return;
      const child = yield* childCopyOf(event.threadId);
      if (child === null) return;
      const { root } = yield* projects.home(event.threadId);
      if (event.type === "checkpoint.captured") {
        if (event.payload.status !== "ready") return;
        const oid = (yield* oidsOf(root)).get(event.payload.ref);
        // Measured in the game's name: facts are keyed by content, so a kept version has them.
        if (oid !== undefined) yield* builds.measureIn(root, oid);
        yield* operations.changed(root, GAME_BUILDS_EVENT, "A version landed.");
        return;
      }
      if (!isOver(event.payload.status)) return;
      // A turn a restart cut off has no checkpoint: what its copy holds is its build.
      if (event.payload.checkpointId === null)
        yield* checkpoints
          .withWorkspaceLock(
            child.cwd,
            checkpoints.captureCheckpoint({
              cwd: child.cwd,
              checkpointRef: versionLeftRef(event.threadId),
            }),
          )
          .pipe(Effect.ignore);
      yield* operations.changed(root, GAME_BUILDS_EVENT, "A version ended.");
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("A version's landing failed.", { cause })),
    );

  yield* tryStarts.attach({ start, copyNote: copies.copyNote });
  return GameVersions.of({ tries, keep, landed });
});

export const layer = Layer.effect(GameVersions, make);
