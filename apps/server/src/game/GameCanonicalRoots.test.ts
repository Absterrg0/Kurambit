// @effect-diagnostics nodeBuiltinImport:off -- The fixture uses real temporary folders and a directory symlink.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import {
  GameOperationError,
  ProjectId,
  ThreadId,
  type GameManifest,
  type OrchestrationV2ThreadShell,
  type Project,
} from "@t3tools/contracts";
import * as GameDesignApproval from "./GameDesignApproval.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameQualification from "./GameQualification.ts";
import * as GameService from "./GameService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { approvalRecordFile, designIntentFile } from "./GameDesignApproval.ts";
import { qualificationRecordPath } from "./GameQualification.ts";

const manifest: GameManifest = {
  schemaVersion: 1,
  name: "Alias game",
  brief: "",
  artDirection: "",
  testSuite: "res://tests/smoke_test.gd",
  gameplayScene: "res://scenes/game.tscn",
  engine: { name: "godot", version: "4.7.2" },
  godotProject: "godot",
  assets: [],
};
const design = "# Alias game\n\nA design to approve.\n";

const exists = (path: string) =>
  Effect.promise(() =>
    NodeFSP.stat(path).then(
      () => true,
      () => false,
    ),
  );

/** A game folder plus a directory symlink that names the same tree. */
const withAliasFixture = <A, E, R>(
  run: (input: {
    readonly base: string;
    readonly root: string;
    readonly alias: string;
    readonly stateDir: string;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-alias-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const root = NodePath.join(base, "game");
      const alias = NodePath.join(base, "alias");
      const stateDir = NodePath.join(base, "state");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(root, "godot"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(root, "godot/project.godot"), "[application]\n");
        await NodeFSP.writeFile(NodePath.join(root, "game.json"), JSON.stringify(manifest));
        await NodeFSP.writeFile(NodePath.join(root, "DESIGN.md"), design);
        await NodeFSP.symlink(root, alias, "dir");
      });
      return yield* run({ base, root, alias, stateDir });
    }),
  );

it.effect(
  "a directory-symlink alias shares records, lock and design state with the real root",
  () =>
    withAliasFixture(({ root, alias, stateDir }) =>
      Effect.gen(function* () {
        const approvals = yield* GameDesignApproval.GameDesignApproval;
        // Creation writes through whichever path it was given; both must land on
        // the real root's record.
        yield* approvals.recordIntent(alias, "required", true);
        expect(yield* approvals.readIntent(root)).toBe("required");
        expect(yield* approvals.readProbe(alias)).toBe(true);
        expect(yield* exists(designIntentFile(stateDir, alias))).toBe(false);
        expect(yield* exists(designIntentFile(stateDir, root))).toBe(true);

        const [real, viaAlias] = yield* Effect.all(
          [approvals.status(root, manifest), approvals.status(alias, manifest)],
          { concurrency: 2 },
        );
        expect(viaAlias).toEqual(real);
        expect(real.state).toBe("draft");

        // Without a canonical lock key both fibers enter the critical section.
        const active = yield* Ref.make(0);
        const peak = yield* Ref.make(0);
        const critical = Effect.gen(function* () {
          const now = yield* Ref.updateAndGet(active, (count) => count + 1);
          yield* Ref.update(peak, (value) => Math.max(value, now));
          yield* Effect.yieldNow;
          yield* Ref.update(active, (count) => count - 1);
        });
        yield* Effect.all(
          [approvals.exclusive(root, critical), approvals.exclusive(alias, critical)],
          {
            concurrency: 2,
          },
        );
        expect(yield* Ref.get(peak)).toBe(1);
      }).pipe(Effect.provide(GameDesignApproval.layer({ stateDir })), Effect.scoped),
    ),
);

it.effect("an old lexical-key approval record migrates to the canonical key", () =>
  withAliasFixture(({ root, alias, stateDir }) =>
    Effect.gen(function* () {
      const approvals = yield* GameDesignApproval.GameDesignApproval;
      // The pre-realpath record lived under the alias's lexical digest.
      const legacyFile = approvalRecordFile(stateDir, alias);
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.dirname(legacyFile), { recursive: true }).then(() =>
          NodeFSP.writeFile(
            legacyFile,
            JSON.stringify({
              schemaVersion: 1,
              game: alias,
              approvalId: "legacy-approval",
              designHash: GameDesignApproval.designDocumentHash(design),
              approvedAt: "2026-10-20T00:00:00.000Z",
              acceptance: [],
            }),
          ),
        ),
      );
      // Opening the game through the old alias is the read that migrates it.
      const viaAlias = yield* approvals.status(alias, manifest);
      expect(viaAlias.state).toBe("approved");
      expect(viaAlias.approvedHash).toBe(GameDesignApproval.designDocumentHash(design));
      expect(yield* exists(legacyFile)).toBe(false);
      expect(yield* exists(approvalRecordFile(stateDir, root))).toBe(true);
      expect((yield* approvals.status(root, manifest)).state).toBe("approved");
    }).pipe(Effect.provide(GameDesignApproval.layer({ stateDir })), Effect.scoped),
  ),
);

it.effect("an unreadable required intent record is an error, never legacy", () =>
  withAliasFixture(({ root, stateDir }) =>
    Effect.gen(function* () {
      const approvals = yield* GameDesignApproval.GameDesignApproval;
      const file = designIntentFile(stateDir, root);
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
        await NodeFSP.writeFile(file, "{ not json");
      });
      const result = yield* Effect.result(approvals.status(root, manifest));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(GameOperationError);
        expect(result.failure.operation).toBe("read-design");
      }
    }).pipe(Effect.provide(GameDesignApproval.layer({ stateDir })), Effect.scoped),
  ),
);

const project = (id: string, workspaceRoot: string): Project => ({
  id: ProjectId.make(id),
  title: id,
  workspaceRoot,
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: "2026-10-19T00:00:00Z",
  updatedAt: "2026-10-19T00:00:00Z",
  deletedAt: null,
});
const shell = (id: string, projectId: string): OrchestrationV2ThreadShell =>
  ({
    id: ThreadId.make(id),
    projectId: ProjectId.make(projectId),
    title: id,
    updatedAt: "2026-10-20T00:00:00Z",
    archivedAt: null,
    deletedAt: null,
    worktreePath: null,
  }) as unknown as OrchestrationV2ThreadShell;

it.effect("a real root and an alias thread share one operation lock", () =>
  withAliasFixture(({ base, root, alias, stateDir }) =>
    Effect.gen(function* () {
      const realProject = project("real-project", root);
      const aliasProject = project("alias-project", alias);
      const realThread = ThreadId.make("real-thread");
      const aliasThread = ThreadId.make("alias-thread");
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const processResult = (logPath: string) => ({
        pid: 1,
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        logPath,
      });
      const layer = GameService.layer.pipe(
        Layer.provideMerge(GameProjectService.layer),
        Layer.provideMerge(GameOperations.layer),
        Layer.provideMerge(GameQualification.layer({ stateDir })),
        Layer.provideMerge(GameDesignApproval.layer({ stateDir })),
        Layer.provide(
          Layer.mock(ProjectService.ProjectService)({
            getById: (id) =>
              Effect.succeed(
                Option.fromUndefinedOr(
                  [realProject, aliasProject].find((candidate) => candidate.id === id),
                ),
              ),
          }),
        ),
        Layer.provide(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed(
                id === realThread
                  ? shell(realThread, "real-project")
                  : id === aliasThread
                    ? shell(aliasThread, "alias-project")
                    : null,
              ),
          }),
        ),
        Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
        Layer.provide(
          Layer.mock(GameToolchain.GameToolchain)({
            executable: () =>
              Effect.succeed({ path: "/unexecuted/godot", version: "4.7.2", templates: null }),
          }),
        ),
        Layer.provide(
          Layer.mock(GamePreview.GamePreview)({
            url: () => "http://127.0.0.1:0",
          }),
        ),
        Layer.provide(Layer.mock(PreviewBrowser.PreviewBrowser)({})),
        Layer.provide(
          Layer.mock(GameProcesses.GameProcesses)({
            list: () => [],
            run: (input) =>
              Effect.gen(function* () {
                if (input.operation === "godot-check") {
                  const separator = input.args.indexOf("--");
                  yield* Effect.promise(() =>
                    NodeFSP.writeFile(
                      input.args[separator + 1]!,
                      JSON.stringify({
                        mainScene: "res://main.tscn",
                        entries: ["main"],
                        errors: [],
                        warnings: [],
                      }),
                    ),
                  );
                  yield* Deferred.succeed(started, undefined);
                  yield* Deferred.await(release);
                }
                return processResult(NodePath.join(base, "stub.log"));
              }),
          }),
        ),
        Layer.provide(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const projects = yield* GameProjectService.GameProjectService;
        const game = yield* GameService.GameService;
        expect(yield* projects.resolve(aliasThread)).toBe(yield* projects.resolve(realThread));
        const running = yield* Effect.forkScoped(game.check(realThread));
        yield* Deferred.await(started);
        const blocked = yield* Effect.result(game.check(aliasThread));
        expect(blocked._tag).toBe("Failure");
        if (blocked._tag === "Failure") expect(blocked.failure.reason).toBe("busy");
        yield* Deferred.succeed(release, undefined);
        const checked = yield* Fiber.join(running);
        expect(checked.ok).toBe(true);
        // One canonical qualification record, not one per alias.
        expect(yield* exists(qualificationRecordPath(stateDir, root))).toBe(true);
        expect(yield* exists(qualificationRecordPath(stateDir, alias))).toBe(false);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
  ),
);
