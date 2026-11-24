// @effect-diagnostics nodeBuiltinImport:off -- Tests of the builds keep a real game folder in a real repository.
// Tests of GameBuilds with mocked services: the game's build records in memory, and a dispatch
// that plans and applies `game-build.*` commands as the orchestrator does, a restore's move run
// as its outbox effect would be, right after its record.
import type {
  GameBuildFolder,
  GameBuildRecord,
  OrchestrationV2ServerCommand,
} from "@kurambit/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { type GameManifest, ProjectId, ThreadId } from "@kurambit/contracts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as GameBuildMoves from "../orchestration-v2/gameBuilds/GameBuildMoves.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GameBuildCopies from "./GameBuildCopies.ts";
import * as GameBuilds from "./GameBuilds.ts";
import * as GameFacts from "./GameFacts.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameRunControl from "./GameRunControl.ts";
import * as GamePreview from "./GamePreview.ts";
import * as ServerConfig from "../config.ts";
import * as GameFolders from "./GameFolders.ts";
import * as GameStage from "./GameStage.ts";

import * as GameBuildProjection from "../orchestration-v2/gameBuilds/GameBuildProjection.ts";
import {
  type GameBuildEventDraft,
  planGameBuildCommand,
} from "../orchestration-v2/gameBuilds/plan.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

type Store = ProjectionStore.ProjectionStoreV2["Service"];

export const memoryBuildRecords = () => {
  let builds: ReadonlyArray<GameBuildRecord> = [];
  let folders: ReadonlyArray<GameBuildFolder> = [];
  let runner: GameBuildMoves.GameBuildMoveRunner | null = null;
  // A server's death, as these tests make it: effects held in the outbox until a restart replays
  // them, and a command lost before it committed.
  const control = {
    hold: false,
    lose: new Set<string>(),
    /** Done once a move is held: the test kills the server then. */
    held: null as Deferred.Deferred<void> | null,
  };
  let pending: Array<GameBuildMoves.GameBuildMove> = [];
  const folderOf = (projectId: string, root: string) =>
    folders.find((each) => each.projectId === projectId && each.root === root) ?? null;
  const reads = {
    getGameBuildFolder: (projectId, root) => Effect.succeed(folderOf(projectId, root)),
    listGameBuildFolders: () => Effect.succeed(folders),
    listGameBuilds: (projectId, options) =>
      Effect.succeed(
        builds
          .map((build, order) => ({ build, order }))
          .filter(
            ({ build }) =>
              build.projectId === projectId &&
              (options.root === undefined || build.root === options.root) &&
              (options.before === undefined || build.at < options.before),
          )
          .toSorted((a, b) => b.build.at.localeCompare(a.build.at) || b.order - a.order)
          .slice(0, options.limit)
          .map(({ build }) => build),
      ),
    getGameBuilds: (projectId, ids) =>
      Effect.succeed(
        builds.filter((each) => each.projectId === projectId && ids.includes(each.id)),
      ),
    getGameBuildTally: (projectId) =>
      Effect.succeed({
        number: Math.max(
          0,
          ...builds.filter((each) => each.projectId === projectId).map((each) => each.number ?? 0),
        ),
        parks: builds.filter(
          (each) => each.projectId === projectId && each.kind === "restore-before",
        ).length,
      }),
  } satisfies Pick<
    Store,
    | "getGameBuildFolder"
    | "listGameBuildFolders"
    | "listGameBuilds"
    | "getGameBuilds"
    | "getGameBuildTally"
  >;
  const apply = (event: GameBuildEventDraft) => {
    if (event.type === "game-build.dropped")
      builds = builds.filter(
        (each) =>
          each.projectId !== event.payload.projectId || !event.payload.ids.includes(each.id),
      );
    if (
      event.type === "game-build.recorded" &&
      !builds.some(
        (each) =>
          each.projectId === event.payload.build.projectId && each.id === event.payload.build.id,
      )
    )
      builds = [...builds, event.payload.build];
    const key =
      event.type === "game-build.recorded"
        ? { projectId: event.payload.build.projectId, root: event.payload.build.root }
        : { projectId: event.payload.projectId, root: event.payload.root };
    const known = folderOf(key.projectId, key.root);
    const next = GameBuildProjection.applyToFolder(
      known ?? GameBuildProjection.emptyFolder(key.projectId, key.root),
      event as Parameters<typeof GameBuildProjection.applyToFolder>[1],
    );
    if (next !== null) folders = [...folders.filter((each) => each !== known), next];
  };
  const dispatch = (command: OrchestrationV2ServerCommand) =>
    Effect.gen(function* () {
      const done = {} as Orchestrator.OrchestratorV2DispatchResult;
      if (!command.type.startsWith("game-build.")) return done;
      if (control.lose.delete(command.type)) return yield* Effect.die("the server died");
      const plan = yield* planGameBuildCommand(
        {
          tally: reads.getGameBuildTally,
          known: (projectId, id) =>
            reads.getGameBuilds(projectId, [id]).pipe(Effect.map((rows) => rows[0] ?? null)),
          folder: reads.getGameBuildFolder,
        },
        command as Parameters<typeof planGameBuildCommand>[1],
      );
      for (const event of plan.events) apply(event);
      for (const effect of plan.effects) {
        if (effect.request.type !== "game-build.move") continue;
        const move = {
          effectId: effect.id,
          threadId: effect.threadId,
          projectId: effect.request.projectId,
          root: effect.request.root,
          restore: effect.request.restore,
        };
        if (control.hold || runner === null) {
          pending.push(move);
          if (control.held !== null) yield* Deferred.succeed(control.held, undefined);
        } else yield* runner.move(move).pipe(Effect.orDie, Effect.forkDetach);
      }
      return done;
    }).pipe(Effect.orDie);
  return {
    reads,
    dispatch,
    attach: (each: GameBuildMoves.GameBuildMoveRunner) => Effect.sync(() => void (runner = each)),
    builds: () => builds,
    folders: () => folders,
    control,
    pending: () => pending,
    /** The outbox runs a move again whose effect a death left unmarked. */
    requeue: (moves: ReadonlyArray<GameBuildMoves.GameBuildMove>) =>
      Effect.sync(() => void pending.push(...moves)),
    /** A restart's outbox: every pending move runs again in turn; one that fails stays pending. */
    replay: Effect.suspend(() => {
      const moves = pending;
      pending = [];
      return Effect.forEach(
        moves,
        (move) =>
          runner === null
            ? Effect.sync(() => void (pending = [...pending, move]))
            : runner
                .move(move)
                .pipe(
                  Effect.catchCause(() => Effect.sync(() => void (pending = [...pending, move]))),
                ),
        { discard: true },
      );
    }),
  };
};

// A real game folder in a real repository, with every other service the builds use mocked.
type GameBuildFactsShape = Effect.Success<ReturnType<GameFacts.GameFacts["Service"]["measure"]>>;
export const THREAD = ThreadId.make("chat");
const manifest: GameManifest = {
  schemaVersion: 1,
  name: "Rover",
  brief: "A brief.",
  artDirection: "",
  engine: { name: "three", version: "1" },
  project: "web",
  assets: [],
};

export const repo = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "keep-values-"));
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  git("init", "-q", "-b", "main");
  NodeFS.mkdirSync(NodePath.join(root, "web"));
  NodeFS.writeFileSync(NodePath.join(root, "web", "main.js"), "export function start() {}\n");
  NodeFS.writeFileSync(
    NodePath.join(root, "web", "tune.json"),
    '{\n  "Rules": { "hard": false }\n}\n',
  );
  git("add", "-A");
  git("commit", "-qm", "game");
  return root;
};

export const layerFor = (root: string, records = memoryBuildRecords()) =>
  GameBuilds.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        CheckpointStore.layer.pipe(
          Layer.provide(
            VcsDriverRegistry.layer.pipe(
              Layer.provide(VcsProcess.layer.pipe(Layer.provide(NodeServices.layer))),
            ),
          ),
        ),
        GameOperations.layer,
        Layer.mock(GameProjectService.GameProjectService)({
          resolve: () => Effect.succeed(root),
          home: () => Effect.succeed({ root: root, projectId: ProjectId.make("rover") }),
          read: () => Effect.succeed(manifest),
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          ...records.reads,
          getThreadShell: () =>
            Effect.succeed({ projectId: ProjectId.make("rover") } as unknown as Effect.Success<
              ReturnType<ProjectionStore.ProjectionStoreV2["Service"]["getThreadShell"]>
            >),
          listProjectTurnCheckpoints: () => Effect.succeed([]),
          // No other chat of the game is at work.
          getShellSnapshot: () =>
            Effect.succeed({ threads: [] } as unknown as Effect.Success<
              ReturnType<ProjectionStore.ProjectionStoreV2["Service"]["getShellSnapshot"]>
            >),
        }),
        Layer.mock(GameFacts.GameFacts)({
          harness: "test",
          readMany: () => Effect.succeed(new Map()),
          // Queued like a turn build's measure; nothing plays here.
          measure: () => Effect.succeed({} as GameBuildFactsShape),
        }),
        Layer.mock(GameRunControl.GameRunControl)({
          steps: () => Effect.succeed(new Map()),
        }),
        Layer.mock(GameStage.GameStage)({ closeLiveEditors: () => Effect.void }),
        ServerConfig.layerTest(process.cwd(), { prefix: "game-builds-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        // No other chat writes the folder here.
        Layer.mock(GameFolders.GameFolders)({
          holder: () => Effect.succeed(null),
          withFolder: (_input, work) => work,
          release: () => Effect.void,
        }),
        Layer.mock(GamePreview.GamePreview)({
          url: () => null,
          liveUrl: () => null,
          liveState: () => "off",
          quietWrite: () => Effect.void,
        }),
        Layer.mock(GameBuildCopies.GameBuildCopies)({ plays: () => [] }),
        Layer.mock(Orchestrator.OrchestratorV2)({ dispatch: records.dispatch }),
        Layer.mock(GameBuildMoves.GameBuildMoves)({ attach: records.attach }),
      ),
    ),
  );

export const tuneOf = (root: string) =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(root, "web", "tune.json"), "utf8"));
