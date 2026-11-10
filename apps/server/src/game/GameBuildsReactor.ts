import { GAME_BUILDS_EVENT, type OrchestrationV2DomainEvent } from "@kurambit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as KeyedLock from "@kurambit/shared/KeyedLock";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import { engineProfile } from "./engineProfile.ts";
import * as GameBuilds from "./GameBuilds.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameStage from "./GameStage.ts";

/**
 * Keeps the Builds rail current without polling: a turn's checkpoint, a
 * run's round, a run's end and a run's restore each push "builds" to the game's clients.
 * A run's round is measured as it lands, so its card
 * has facts without anyone opening it; Unity builds are left to an open, as
 * a measurement would take the one editor from the run.
 *
 * A chat turn's build has its base recorded as it lands. The turn loop: on
 * an engine whose profile has `turnLoop`, the build is measured in the
 * background, replacing an earlier turn's measure still queued. An engine
 * whose Stage plays a Web export then has it played (the folder's Web build
 * made current, as the chat's own operation, which the Stage remounts on);
 * a live-staged engine's Stage already shows the folder, so nothing is
 * built. A turn the person stopped, or one cancelled, is measured but not played.
 */
export class GameBuildsReactor extends Context.Service<
  GameBuildsReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("kurambit/game/GameBuildsReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const builds = yield* GameBuilds.GameBuilds;
  const operations = yield* GameOperations.GameOperations;
  const projects = yield* GameProjectService.GameProjectService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const stage = yield* GameStage.GameStage;
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const scope = yield* Effect.scope;
  const perThread = yield* KeyedLock.make<string>();
  const roles = new Map<string, boolean>();
  const isRole = (threadId: OrchestrationV2DomainEvent["threadId"]) =>
    roles.has(threadId)
      ? Effect.succeed(roles.get(threadId)!)
      : projections.getThreadShell(threadId).pipe(
          Effect.map((shell) => {
            const relation = shell?.lineage.relationshipToParent;
            const role = relation === "role" || relation === "subagent";
            if (roles.size > 2000) roles.clear();
            roles.set(threadId, role);
            return role;
          }),
          Effect.orElseSucceed(() => false),
        );

  const pushTo = (event: OrchestrationV2DomainEvent, message: string) =>
    projects
      .resolve(event.threadId)
      .pipe(
        Effect.flatMap((root) =>
          operations.changed(root, GAME_BUILDS_EVENT, message).pipe(Effect.as(root)),
        ),
      );

  const turnBuilt = (
    event: Extract<OrchestrationV2DomainEvent, { type: "checkpoint.captured" }>,
    runId: NonNullable<typeof event.payload.runId>,
  ) =>
    Effect.gen(function* () {
      const ref = event.payload.ref;
      yield* builds.recordTurn(event.threadId, ref);
      const root = yield* pushTo(event, "A turn changed the game.");
      const manifest = yield* projects.read(root);
      const profile = engineProfile(manifest.engine.name);
      if (!profile.turnLoop) return;
      // Skills written since the game was made reach it by its next turn.
      yield* projects.refreshGuidance(root).pipe(Effect.ignore);
      // Measured first: the measure registers at once, the play may wait on the game.
      const build = yield* checkpoints
        .listCheckpointRefs({ cwd: root, prefix: ref })
        .pipe(Effect.map((refs) => refs.find((each) => each.checkpointRef === ref)?.oid));
      // The tester's bot plays a chat turn's build only while keep going, which judges by it, is on.
      const keepGoing = yield* projections.getThreadShell(event.threadId).pipe(
        Effect.flatMap((shell) =>
          shell === null ? Effect.succeed(null) : projections.getProjectGameRun(shell.projectId),
        ),
        Effect.map((run) => run !== null && run.status !== "ended"),
        // Unknown leaves it to keep going's own judge, which asks for the bot.
        Effect.orElseSucceed(() => false),
      );
      if (build !== undefined)
        yield* builds.measureIn(root, build, { supersede: true, skilled: keepGoing });
      if (profile.stage !== "export") return;
      const stopped = yield* projections
        .getThreadRecords(event.threadId, ["runs"], { runIds: [runId] })
        .pipe(
          Effect.map((records) =>
            records.runs.some(
              (run) =>
                run.id === runId && (run.status === "interrupted" || run.status === "cancelled"),
            ),
          ),
          Effect.orElseSucceed(() => false),
        );
      if (!stopped)
        yield* stage
          .playCurrent(event.threadId)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("A turn's build could not be played.", { root, cause }),
            ),
          );
    }).pipe(Effect.ignore);

  const handle: GameBuildsReactor["Service"]["handle"] = (event) => {
    switch (event.type) {
      case "checkpoint.captured": {
        const runId = event.payload.runId;
        return event.payload.status !== "ready" ||
          event.payload.files.length === 0 ||
          runId === null
          ? Effect.void
          : Effect.flatMap(isRole(event.threadId), (role) =>
              // A run's role turns are folded into its rounds: no rail changes for them.
              role ? Effect.void : turnBuilt(event, runId),
            );
      }
      case "game-run-round.recorded": {
        const record = event.payload.round;
        return pushTo(event, `Round ${record.round} landed.`).pipe(
          Effect.flatMap((root) =>
            record.build === undefined ? Effect.void : builds.measureIn(root, record.build),
          ),
          Effect.ignore,
        );
      }
      // A run that ends with a step unjudged (stopped, paused) relabels that
      // step's build: no round lands for it, so the end itself is the push.
      case "game-run.updated":
        return event.payload.status === "ended"
          ? pushTo(event, "Keep going ended.").pipe(Effect.ignore)
          : Effect.void;
      default:
        return Effect.void;
    }
  };

  // The events from now on, and the reconcile for what landed before (or
  // was owed when the server last stopped): owed work is read from data.
  const start: GameBuildsReactor["Service"]["start"] = () =>
    Effect.andThen(
      forkParked(
        engine.streamDomainEvents.pipe(
          // A turn's play may wait minutes on its game's lock: each thread's
          // turns run forked, in order, so no game's wait holds the stream.
          Stream.mapEffect(
            (event) =>
              event.type === "checkpoint.captured"
                ? Effect.forkIn(perThread.withLock(event.threadId, handle(event)), scope).pipe(
                    Effect.asVoid,
                  )
                : handle(event),
            { concurrency: 4 },
          ),
          Stream.runDrain,
          Effect.catchCause((cause) =>
            Effect.logWarning("game builds event stream failed", { cause }),
          ),
        ),
      ),
      Effect.andThen(
        forkParked(builds.reconcile),
        // Guidance arrives with a new server: every game's skills follow it before its next turn.
        forkParked(
          projects.list().pipe(
            Effect.flatMap((games) =>
              Effect.forEach(
                games,
                (game) => projects.refreshGuidance(game.root).pipe(Effect.ignore),
                {
                  discard: true,
                },
              ),
            ),
            Effect.ignore,
          ),
        ),
      ),
    );

  return GameBuildsReactor.of({ start, handle });
});

export const layer = Layer.effect(GameBuildsReactor, make);
