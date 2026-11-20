// Tests of GameBuilds with mocked services: the game's build records in memory, and a dispatch
// that plans and applies `game-build.*` commands as the orchestrator does, a restore's move run
// as its outbox effect would be, right after its record.
import type {
  GameBuildFolder,
  GameBuildRecord,
  OrchestrationV2ServerCommand,
} from "@kurambit/contracts";
import * as Effect from "effect/Effect";

import type * as GameBuildMoves from "../orchestration-v2/gameBuilds/GameBuildMoves.ts";
import * as GameBuildProjection from "../orchestration-v2/gameBuilds/GameBuildProjection.ts";
import {
  type GameBuildEventDraft,
  planGameBuildCommand,
} from "../orchestration-v2/gameBuilds/plan.ts";
import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

type Store = ProjectionStore.ProjectionStoreV2["Service"];

export const memoryBuildRecords = () => {
  let builds: ReadonlyArray<GameBuildRecord> = [];
  let folders: ReadonlyArray<GameBuildFolder> = [];
  let runner: GameBuildMoves.GameBuildMoveRunner | null = null;
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
    getGameBuildTally: (projectId, root) =>
      Effect.succeed({
        number: Math.max(
          0,
          ...builds
            .filter((each) => each.projectId === projectId && each.root === root)
            .map((each) => each.number ?? 0),
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
      for (const effect of plan.effects)
        if (effect.request.type === "game-build.move" && runner !== null)
          yield* runner
            .move({
              effectId: effect.id,
              threadId: effect.threadId,
              projectId: effect.request.projectId,
              root: effect.request.root,
              restore: effect.request.restore,
            })
            .pipe(Effect.orDie, Effect.forkDetach);
      return done;
    }).pipe(Effect.orDie);
  return {
    reads,
    dispatch,
    attach: (each: GameBuildMoves.GameBuildMoveRunner) => Effect.sync(() => void (runner = each)),
    builds: () => builds,
  };
};
