// One writer per game folder. A chat's turn writes the game folder only while no other chat's turn
// is at work there; a chat and its delegated children (subagent threads sharing its folder) are
// one writer. A turn that would be a second writer waits in its own thread's T3 queue, held with
// a reason, and starts when the folder frees (T3's queue.resume). A move of the folder outside
// any turn (a bring-in, an undo, a held kept edit) is a writer too, for as long as it moves.
//
// The claim is made at turn admission, which every message surface passes before its turn
// commits, under one lock per folder: two chats sending at once are decided in order, and the
// second sees the first's claim before the first's run exists. A claim stays live while its
// chat has a run at work in the folder, and for a short grace before its run commits; the
// projection's runs are the truth after a restart, when no claim survives.
import {
  CommandId,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadId,
  GameOperationError,
} from "@kurambit/contracts";
import * as KeyedLock from "@kurambit/shared/KeyedLock";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TurnAdmission from "../orchestration-v2/TurnAdmission.ts";
import * as GameProjectService from "./GameProjectService.ts";

/** Who writes a folder now: a chat's turn (its family's first thread) or a move named for a person. */
export interface FolderHolder {
  readonly threadId: ThreadId | null;
  readonly title: string;
}

/** Between a turn's admission and its run committing, its claim stands on its own. */
const GRACE = Duration.seconds(20);

export const heldReason = (holder: FolderHolder) =>
  `Waits for ${holder.title} to finish in the game`;

export class GameFolders extends Context.Service<
  GameFolders,
  {
    /**
     * Who writes the game folder `root` now, outside `asking`'s family (null: nobody excluded):
     * a chat's turn at work there, or a move. Null when it is free.
     */
    readonly holder: (
      root: string,
      projectId: ProjectId,
      asking: ThreadId | null,
    ) => Effect.Effect<FolderHolder | null>;
    /**
     * `work` as the folder's one writer, named `name` to a turn that waits for it. Refused `busy`
     * while another family's turn holds the folder (`asking`'s own family may be at work: its
     * agent asked). Turns admitted meanwhile wait held, and start when it ends.
     */
    readonly withFolder: <A, E>(
      input: {
        readonly root: string;
        readonly projectId: ProjectId;
        readonly asking: ThreadId | null;
        readonly name: string;
        readonly operation: string;
      },
      work: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | GameOperationError>;
    /** A writer of `root` may have ended: the oldest held turn gets the folder, if it is free. */
    readonly release: (root: string, projectId: ProjectId) => Effect.Effect<void>;
  }
>()("kurambit/game/GameFolders") {}

interface TurnClaim {
  readonly family: ThreadId;
  readonly title: string;
  readonly at: number;
}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projects = yield* GameProjectService.GameProjectService;
  const projectStore = yield* ProjectService.ProjectService;
  const admission = yield* TurnAdmission.TurnAdmission;
  const scope = yield* Effect.scope;
  const locks = yield* KeyedLock.make<string>();
  const claims = new Map<string, TurnClaim>();
  const moves = new Map<string, string>();
  const games = new Map<string, boolean>();

  const isGame = (root: string) =>
    games.has(root)
      ? Effect.succeed(games.get(root)!)
      : projects.read(root).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
          Effect.tap((game) =>
            Effect.sync(() => {
              if (games.size > 500) games.clear();
              games.set(root, game);
            }),
          ),
        );

  const shellsOf = (projectId: ProjectId) =>
    projections.getShellSnapshot({ projectId, location: "active" }).pipe(
      Effect.map((snapshot) => snapshot.threads),
      Effect.orElseSucceed((): ReadonlyArray<OrchestrationV2ThreadShell> => []),
    );

  // A chat and the subagents it delegated to are one writer: the family is its first thread.
  const familyOf = (shells: ReadonlyArray<OrchestrationV2ThreadShell>, threadId: ThreadId) => {
    const byId = new Map(shells.map((shell) => [shell.id, shell]));
    let id = threadId;
    for (let depth = 0; depth < 16; depth += 1) {
      const shell = byId.get(id);
      const parent = shell?.lineage.parentThreadId ?? null;
      if (
        shell === undefined ||
        parent === null ||
        shell.lineage.relationshipToParent !== "subagent"
      )
        return id;
      id = parent;
    }
    return id;
  };

  const inFolder = (shell: OrchestrationV2ThreadShell) =>
    shell.worktreePath === null && shell.archivedAt === null;
  const atWork = (shell: OrchestrationV2ThreadShell) =>
    shell.activeRunId !== null || (shell.activityRunStatus ?? null) !== null;

  const holderIn = (root: string, projectId: ProjectId, asking: ThreadId | null) =>
    Effect.gen(function* () {
      const move = moves.get(root);
      if (move !== undefined) return { threadId: null, title: move } satisfies FolderHolder;
      const shells = yield* shellsOf(projectId);
      const family = asking === null ? null : familyOf(shells, asking);
      const titleOf = (id: ThreadId) => shells.find((shell) => shell.id === id)?.title ?? "a chat";
      const working = shells.find(
        (shell) => inFolder(shell) && atWork(shell) && familyOf(shells, shell.id) !== family,
      );
      if (working !== undefined) {
        const of = familyOf(shells, working.id);
        return { threadId: of, title: titleOf(of) } satisfies FolderHolder;
      }
      const claim = claims.get(root);
      if (claim === undefined || claim.family === family) return null;
      const fresh = (yield* Clock.currentTimeMillis) - claim.at < Duration.toMillis(GRACE);
      const claimed = shells.some(
        (shell) => inFolder(shell) && atWork(shell) && familyOf(shells, shell.id) === claim.family,
      );
      return claimed || fresh
        ? ({ threadId: claim.family, title: claim.title } satisfies FolderHolder)
        : null;
    });

  const holder: GameFolders["Service"]["holder"] = (root, projectId, asking) =>
    holderIn(root, projectId, asking);

  // Held turns of the folder's chats, oldest first: only the ones this admission held.
  const heldTurns = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const shells = (yield* shellsOf(projectId)).filter(inFolder);
      const held = yield* Effect.forEach(
        shells,
        (shell) =>
          projections.getThreadRecords(shell.id, ["runs"]).pipe(
            Effect.map((records) =>
              records.runs
                .filter(
                  (run) =>
                    run.status === "queued" &&
                    run.queueHeld === true &&
                    run.queueHeldReason !== undefined,
                )
                .map((run) => ({ shell, run })),
            ),
            Effect.orElseSucceed(() => []),
          ),
        { concurrency: 4 },
      );
      return {
        shells,
        held: held
          .flat()
          .toSorted(
            (a, b) => a.run.requestedAt.epochMilliseconds - b.run.requestedAt.epochMilliseconds,
          ),
      };
    });

  const release: GameFolders["Service"]["release"] = (root, projectId) =>
    locks
      .withLock(
        root,
        Effect.gen(function* () {
          if ((yield* holderIn(root, projectId, null)) !== null) return null;
          const { shells, held } = yield* heldTurns(projectId);
          const next = held[0];
          if (next === undefined) return null;
          const family = familyOf(shells, next.shell.id);
          claims.set(root, {
            family,
            title: shells.find((shell) => shell.id === family)?.title ?? next.shell.title,
            at: yield* Clock.currentTimeMillis,
          });
          yield* engine.dispatch({
            type: "queue.resume",
            commandId: CommandId.make(`game-folder:resume:${next.run.id}`),
            threadId: next.shell.id,
          });
          return next.shell.id;
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("A held turn could not be given the game folder.", { root, cause }),
        ),
        Effect.asVoid,
      );

  // A claim still in its grace after its turn ended keeps the folder a moment: look again then.
  const releaseLater = (root: string, projectId: ProjectId) =>
    Effect.forkIn(Effect.sleep(GRACE).pipe(Effect.andThen(release(root, projectId))), scope).pipe(
      Effect.asVoid,
    );

  const withFolder: GameFolders["Service"]["withFolder"] = (input, work) =>
    Effect.gen(function* () {
      const taken = yield* locks.withLock(
        input.root,
        Effect.gen(function* () {
          const holding = yield* holderIn(input.root, input.projectId, input.asking);
          if (holding !== null) return holding;
          moves.set(input.root, input.name);
          return null;
        }),
      );
      if (taken !== null)
        return yield* new GameOperationError({
          operation: input.operation,
          path: input.root,
          reason: "busy",
          detail: `${taken.title} is working in the game, so nothing moved. Try again once it ends.`,
        });
      return yield* work.pipe(
        Effect.ensuring(
          Effect.sync(() => moves.delete(input.root)).pipe(
            Effect.andThen(release(input.root, input.projectId)),
            Effect.andThen(releaseLater(input.root, input.projectId)),
          ),
        ),
      );
    });

  const admit = (thread: TurnAdmission.TurnAdmissionThread) =>
    Effect.gen(function* () {
      // A chat in a copy, or in any worktree, writes its own folder.
      if (thread.worktreePath !== null) return undefined;
      const project = yield* projectStore.getById(thread.projectId).pipe(
        Effect.map(Option.getOrNull),
        Effect.orElseSucceed(() => null),
      );
      if (project === null) return undefined;
      const root = project.workspaceRoot;
      if (!(yield* isGame(root))) return undefined;
      return yield* locks.withLock(
        root,
        Effect.gen(function* () {
          const holding = yield* holderIn(root, thread.projectId, thread.id);
          const shells = yield* shellsOf(thread.projectId);
          const family = familyOf(shells, thread.id);
          // Turns already waiting go first, oldest first.
          const first = (yield* heldTurns(thread.projectId)).held.find(
            (each) => familyOf(shells, each.shell.id) !== family,
          );
          if (holding === null && first === undefined) {
            claims.set(root, {
              family,
              title: shells.find((shell) => shell.id === family)?.title ?? "a chat",
              at: yield* Clock.currentTimeMillis,
            });
            return undefined;
          }
          // A free folder with others waiting is handed on; this lock is held, so after it.
          if (holding === null) yield* Effect.forkIn(release(root, thread.projectId), scope);
          const before = holding ?? {
            threadId: familyOf(shells, first!.shell.id),
            title: first!.shell.title,
          };
          return { hold: heldReason(before) };
        }),
      );
    }).pipe(Effect.orElseSucceed(() => undefined));

  yield* admission.attach?.({ admit }) ?? Effect.void;
  return GameFolders.of({ holder, withFolder, release });
});

export const layer = Layer.effect(GameFolders, make);
