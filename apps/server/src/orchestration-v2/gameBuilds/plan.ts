// One game-build command planned against the projection: the decider numbers a build and its
// park from what is recorded, so two builds never share a number, and a restore's folder move is
// an outbox effect of the record that asks for it. No I/O beyond the projection reads.
import {
  type GameBuildFolder,
  type GameBuildRecord,
  isNumberedGameBuildKind,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2GameBuildCommand,
  RESTORE_BEFORE_LABEL,
} from "@kurambit/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as EffectOutbox from "../EffectOutbox.ts";
import type { ProjectionStoreV2Error } from "../ProjectionStore.ts";
import type { GameBuildTally } from "./GameBuildProjection.ts";

type Unidentified<E> = E extends unknown ? Omit<E, "id"> : never;
export type GameBuildEventDraft = Unidentified<
  Extract<OrchestrationV2DomainEvent, { readonly type: `game-build.${string}` }>
>;

export interface GameBuildPlanReads {
  readonly tally: (
    projectId: GameBuildRecord["projectId"],
    root: string,
  ) => Effect.Effect<GameBuildTally, ProjectionStoreV2Error>;
  readonly known: (
    projectId: GameBuildRecord["projectId"],
    id: GameBuildRecord["id"],
  ) => Effect.Effect<GameBuildRecord | null, ProjectionStoreV2Error>;
  readonly folder: (
    projectId: GameBuildRecord["projectId"],
    root: string,
  ) => Effect.Effect<GameBuildFolder | null, ProjectionStoreV2Error>;
}

export interface GameBuildPlan {
  readonly events: ReadonlyArray<GameBuildEventDraft>;
  readonly effects: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
}

/** A build as the projection keeps it: numbered on from its folder's last, a park by its place. */
const numbered = (
  build: GameBuildRecord,
  tally: GameBuildTally,
  numberFrom: number | undefined,
): GameBuildRecord => {
  const { number: _number, nth: _nth, ...rest } = build;
  return {
    ...rest,
    number: isNumberedGameBuildKind(build.kind)
      ? Math.max(tally.number, numberFrom ?? 0) + 1
      : null,
    ...(build.kind === "restore-before" ? { nth: tally.parks + 1 } : {}),
  };
};

export const planGameBuildCommand = (
  reads: GameBuildPlanReads,
  command: OrchestrationV2GameBuildCommand,
) =>
  Effect.gen(function* () {
    const occurredAt = yield* DateTime.now;
    const base = { threadId: command.threadId, occurredAt } as const;
    switch (command.type) {
      case "game-build.record": {
        const { projectId, root } = command.build;
        const known = yield* reads.known(projectId, command.build.id);
        const replaced =
          command.replaces === undefined || known !== null
            ? null
            : yield* reads.known(projectId, command.replaces);
        const build =
          known ??
          (replaced !== null
            ? { ...command.build, number: replaced.number }
            : numbered(command.build, yield* reads.tally(projectId, root), command.numberFrom));
        // The folder's build never moves back to an older one: a turn recorded late (a
        // reconcile after a restart) lands after a restore or a keep that came since.
        const folder = command.current ? yield* reads.folder(projectId, root) : null;
        const holding =
          folder?.current === null || folder?.current === undefined || folder.current === build.id
            ? null
            : yield* reads.known(projectId, folder.current);
        const newer =
          (holding !== null && holding.at > build.at) ||
          (folder?.restore?.outcome?.moved === "restored" && folder.restore.requestedAt > build.at);
        return {
          events: [
            ...(replaced === null
              ? []
              : [
                  {
                    ...base,
                    type: "game-build.dropped",
                    payload: { projectId, root, ids: [replaced.id], current: null },
                  } as const,
                ]),
            {
              ...base,
              type: "game-build.recorded",
              payload: { build, current: command.current && !newer },
            },
          ],
          effects: [],
        } satisfies GameBuildPlan;
      }
      case "game-build.drop":
        return {
          events: [
            {
              ...base,
              type: "game-build.dropped",
              payload: {
                projectId: command.projectId,
                root: command.root,
                ids: command.ids,
                current: command.current,
              },
            },
          ],
          effects: [],
        } satisfies GameBuildPlan;
      case "game-build.restore": {
        const landing =
          command.landing === undefined
            ? null
            : ((yield* reads.known(command.projectId, command.landing.id)) ??
              numbered(
                command.landing,
                yield* reads.tally(command.projectId, command.root),
                undefined,
              ));
        return {
          events: [
            ...(landing === null
              ? []
              : [
                  {
                    ...base,
                    type: "game-build.recorded",
                    payload: { build: landing, current: false },
                  } as const,
                ]),
            {
              ...base,
              type: "game-build.restored",
              payload: {
                projectId: command.projectId,
                root: command.root,
                restore: { ...command.restore, outcome: null },
                current: null,
              },
            },
          ],
          effects: [
            {
              id: `effect:${command.commandId}:game-build.move`,
              commandId: command.commandId,
              threadId: command.threadId,
              request: {
                type: "game-build.move",
                projectId: command.projectId,
                root: command.root,
                restore: { ...command.restore, outcome: null },
              },
            },
          ],
        } satisfies GameBuildPlan;
      }
      case "game-build.restore.settle": {
        const events: Array<GameBuildEventDraft> = [];
        if (
          command.park !== null &&
          (yield* reads.known(command.projectId, command.park.id)) === null
        )
          events.push({
            ...base,
            type: "game-build.recorded",
            payload: {
              build: numbered(
                {
                  id: command.park.id,
                  projectId: command.projectId,
                  root: command.root,
                  at: command.park.at,
                  kind: "restore-before",
                  number: null,
                  base: null,
                  source: { _tag: "saved", label: RESTORE_BEFORE_LABEL },
                  summary: "What the game folder held when a restore replaced it",
                  files: [],
                  fileCount: null,
                },
                yield* reads.tally(command.projectId, command.root),
                undefined,
              ),
              current: false,
            },
          });
        return {
          events: [
            ...events,
            {
              ...base,
              type: "game-build.restored",
              payload: {
                projectId: command.projectId,
                root: command.root,
                restore: command.restore,
                // A move that found the folder already at its target leaves it there too.
                current:
                  command.restore.outcome?.moved === "restored" ||
                  command.restore.outcome?.moved === "current"
                    ? command.restore.target
                    : null,
              },
            },
          ],
          effects: [],
        } satisfies GameBuildPlan;
      }
      case "game-build.keep":
        return {
          events: [
            {
              ...base,
              type: "game-build.kept",
              payload: {
                projectId: command.projectId,
                root: command.root,
                keep: command.keep,
                drop: command.drop,
              },
            },
          ],
          effects: [],
        } satisfies GameBuildPlan;
      case "game-build.migrate": {
        const events: Array<GameBuildEventDraft> = command.builds.map((build) => ({
          ...base,
          type: "game-build.recorded",
          payload: { build, current: false },
        }));
        for (const keep of command.held)
          events.push({
            ...base,
            type: "game-build.kept",
            payload: { projectId: command.projectId, root: command.root, keep, drop: null },
          });
        events.push({
          ...base,
          type: "game-build.migrated",
          payload: {
            projectId: command.projectId,
            root: command.root,
            current: command.current,
            restore: command.restore,
          },
        });
        return { events, effects: [] } satisfies GameBuildPlan;
      }
    }
  });
