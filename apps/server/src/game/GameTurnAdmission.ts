// @effect-diagnostics nodeBuiltinImport:off -- Admission keys games by their real folder path.
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as TurnAdmission from "../orchestration-v2/TurnAdmission.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GameAdmission from "./GameAdmission.ts";
import { realGameRoot } from "./gameRecord.ts";

/**
 * A message turn on a game takes the game first: a live review is stopped and
 * joined, or the turn is refused. This never reads the manifest: an ordinary
 * project has no game.json and must chat as usual, and a game whose manifest
 * vanished during a review still has that review stopped. GameAdmission makes
 * both calls from the folder and its registry.
 */
export const layer = Layer.effect(
  TurnAdmission.TurnAdmission,
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const admission = yield* GameAdmission.GameAdmission;
    const reject = (detail: string) => (cause: unknown) =>
      new TurnAdmission.TurnAdmissionRejectedError({ detail, cause });
    return {
      admit: (thread) =>
        Effect.gen(function* () {
          const workspaceRoot =
            thread.worktreePath ??
            Option.getOrNull(
              yield* projects
                .getById(thread.projectId)
                .pipe(Effect.mapError(reject("The turn's project could not be read."))),
            )?.workspaceRoot ??
            null;
          // No project: the orchestrator rejects the turn on its own.
          if (workspaceRoot === null) return;
          const lexical = NodePath.resolve(workspaceRoot);
          const root = yield* Effect.promise(() => realGameRoot(lexical).catch(() => lexical));
          yield* admission
            .admit({
              root,
              threadId: thread.id,
              reason:
                "The creator's new turn superseded the review; its candidate was not selected.",
            })
            .pipe(
              Effect.mapError(
                reject("The review could not be stopped, so the turn was not admitted."),
              ),
            );
        }),
    };
  }),
);
