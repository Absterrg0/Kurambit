// @effect-diagnostics nodeBuiltinImport:off -- The test installs the real shipped kit into a temporary game.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ThreadId, type GameDesignRead, type GameManifest } from "@t3tools/contracts";
import * as GameDesignApproval from "./GameDesignApproval.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameQualification from "./GameQualification.ts";
import * as GameService from "./GameService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import {
  admissionTestLayer,
  previewBrowserTestLayer,
  roundStoreTestLayer,
} from "./gameTestLayers.ts";

const threadId = ThreadId.make("art-kit-test");
const manifest = (): GameManifest => ({
  schemaVersion: 1,
  name: "Art kit probe",
  brief: "",
  artDirection: "",
  design: { status: "draft" },
  engine: { name: "godot", version: "4.7.2" },
  godotProject: "godot",
  assets: [],
});
const design = (state: GameDesignRead["state"]): GameDesignRead => ({
  state,
  document: null,
  documentTruncated: false,
  approvedHash: null,
  currentHash: null,
  approvedAt: null,
  acceptance: [],
  issues: [],
  pendingRevision: null,
  revisionDiff: null,
});

const withFixture = <A, E, R>(
  state: GameDesignRead["state"],
  run: (input: { readonly root: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-art-service-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const root = NodePath.join(base, "game");
      const stateDir = NodePath.join(base, "state");
      const manifestText = JSON.stringify(manifest());
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(root, "godot"), { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "godot/project.godot"), "[application]\n"),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "game.json"), manifestText),
      );
      const services = GameService.layer.pipe(
        Layer.provideMerge(GameProcesses.layer),
        Layer.provide(
          Layer.mock(GameProjectService.GameProjectService)({
            resolve: () => Effect.succeed(root),
            read: () => Effect.succeed(manifest()),
          }),
        ),
        Layer.provide(
          Layer.mock(GameToolchain.GameToolchain)({
            executable: () =>
              Effect.succeed({ path: "/not-used/godot", version: "4.7.2", templates: null }),
            status: Effect.succeed({ toolsDirectory: base, installing: false, tools: [] }),
          }),
        ),
        Layer.provide(
          Layer.mock(GamePreview.GamePreview)({
            directories: () => [],
            url: () => null,
            urlFor: () => null,
            serving: () => false,
          }),
        ),
        Layer.provide(previewBrowserTestLayer()),
        Layer.provideMerge(GameQualification.layer({ stateDir })),
        Layer.provide(
          Layer.mock(GameDesignApproval.GameDesignApproval)({
            status: () => Effect.succeed(design(state)),
          }),
        ),
        Layer.provideMerge(roundStoreTestLayer(stateDir)),
        Layer.provideMerge(admissionTestLayer),
        Layer.provide(NodeServices.layer),
      );
      return yield* run({ root }).pipe(Effect.provide(services));
    }),
  );

it.live("a draft design refuses an art import before any file is written", () =>
  withFixture("draft", ({ root }) =>
    Effect.gen(function* () {
      const game = yield* GameService.GameService;
      const error = yield* game
        .importArtKit(threadId, { id: "kenney-tiny-dungeon" })
        .pipe(Effect.flip);
      expect(error.reason).toBe("design-draft");
      expect(
        yield* Effect.promise(() =>
          NodeFSP.stat(NodePath.join(root, "godot/assets")).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false);
    }),
  ),
);

it.live("an approved design installs the kit and records a real operation", () =>
  withFixture("approved", ({ root }) =>
    Effect.gen(function* () {
      const game = yield* GameService.GameService;
      const result = yield* game.importArtKit(threadId, { id: "kenney-tiny-dungeon" });
      expect(result.alreadyPresent).toBe(false);
      expect(result.destination).toBe("godot/assets/art/kits/kenney-tiny-dungeon");
      expect(
        yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(root, result.files[0]!.path))),
      ).toHaveLength(5294);
      // The service's own operation record is the same one the Stage reads.
      const operations = yield* GameOperations.GameOperations;
      expect(operations.current(root)?.name).toBe("Import art kit");
      expect(operations.current(root)?.state).toBe("succeeded");
      expect(
        yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(root, "game.json"), "utf8")),
      ).toBe(JSON.stringify(manifest()));
    }),
  ),
);
