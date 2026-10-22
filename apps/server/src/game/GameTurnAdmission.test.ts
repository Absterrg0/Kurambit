// @effect-diagnostics nodeBuiltinImport:off -- The test builds real game and plain project folders.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { GameOperationError, ProjectId, ThreadId, type Project } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as TurnAdmission from "../orchestration-v2/TurnAdmission.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GameAdmission from "./GameAdmission.ts";
import * as GameTurnAdmission from "./GameTurnAdmission.ts";

const projectId = ProjectId.make("project:game-turn-admission");
const userThread = ThreadId.make("thread:game-turn-admission:user");

const fixture = (options: { readonly game: boolean }) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-turn-admission-"));
      const workspace = NodePath.join(base, "workspace");
      const stateDir = NodePath.join(base, "state");
      await NodeFSP.mkdir(workspace, { recursive: true });
      if (options.game) await NodeFSP.writeFile(NodePath.join(workspace, "game.json"), "{}\n");
      return { base, workspace: await NodeFSP.realpath(workspace), stateDir };
    }),
    ({ base }) => Effect.promise(() => NodeFSP.rm(base, { recursive: true, force: true })),
  ).pipe(
    Effect.map((paths) => ({
      ...paths,
      layer: GameTurnAdmission.layer.pipe(
        Layer.provideMerge(GameAdmission.layer({ stateDir: paths.stateDir })),
        Layer.provide(
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeed(Option.some({ workspaceRoot: paths.workspace } as Project)),
          }),
        ),
      ),
    })),
  );

const admitTurn = (threadId: ThreadId) =>
  Effect.flatMap(TurnAdmission.TurnAdmission, (admission) =>
    admission.admit({ id: threadId, projectId, worktreePath: null }),
  );

it.live("a plain project's chat turn is admitted without a game manifest or record", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const paths = yield* fixture({ game: false });
      yield* Effect.gen(function* () {
        yield* admitTurn(userThread);
        const admission = yield* GameAdmission.GameAdmission;
        expect(yield* admission.stamp(paths.workspace)).toEqual({
          generation: 0,
          admittedAt: null,
        });
        const state = yield* Effect.promise(() =>
          NodeFSP.readdir(paths.stateDir).catch(() => [] as string[]),
        );
        expect(state).toEqual([]);
      }).pipe(Effect.provide(paths.layer));
    }),
  ),
);

it.live("a turn waits for the live review to be joined before it is admitted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const paths = yield* fixture({ game: true });
      yield* Effect.gen(function* () {
        const admission = yield* GameAdmission.GameAdmission;
        const joining = yield* Deferred.make<void>();
        const joined = yield* Deferred.make<void>();
        yield* admission.register(paths.workspace, {
          interrupt: () =>
            Deferred.succeed(joining, undefined).pipe(Effect.andThen(Deferred.await(joined))),
          owns: () => Effect.succeed(false),
        });
        const turn = yield* Effect.forkChild(admitTurn(userThread));
        yield* Deferred.await(joining);
        // The review is still stopping: the turn must not have been admitted.
        expect(turn.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(joined, undefined);
        yield* Fiber.join(turn);
        expect((yield* admission.stamp(paths.workspace)).generation).toBe(1);
      }).pipe(Effect.provide(paths.layer));
    }),
  ),
);

it.live("a turn is refused when the live review cannot be stopped", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const paths = yield* fixture({ game: true });
      yield* Effect.gen(function* () {
        const admission = yield* GameAdmission.GameAdmission;
        yield* admission.register(paths.workspace, {
          interrupt: () =>
            Effect.fail(
              new GameOperationError({
                operation: "supersede game review",
                path: paths.workspace,
                reason: "io",
                detail: "The review child did not stop in time.",
              }),
            ),
          owns: () => Effect.succeed(false),
        });
        const error = yield* Effect.flip(admitTurn(userThread));
        expect(error).toBeInstanceOf(TurnAdmission.TurnAdmissionRejectedError);
      }).pipe(Effect.provide(paths.layer));
    }),
  ),
);

it.live("a review whose manifest vanished is still stopped by a turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const paths = yield* fixture({ game: true });
      yield* Effect.promise(() => NodeFSP.rm(NodePath.join(paths.workspace, "game.json")));
      yield* Effect.gen(function* () {
        const admission = yield* GameAdmission.GameAdmission;
        let stopped = 0;
        yield* admission.register(paths.workspace, {
          interrupt: () =>
            Effect.sync(() => {
              stopped += 1;
            }),
          owns: () => Effect.succeed(false),
        });
        yield* admitTurn(userThread);
        expect(stopped).toBe(1);
      }).pipe(Effect.provide(paths.layer));
    }),
  ),
);
