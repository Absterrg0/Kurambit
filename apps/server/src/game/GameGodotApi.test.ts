// @effect-diagnostics nodeBuiltinImport:off -- Writes a fake ClassDB result through the mocked process layer.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ThreadId } from "@t3tools/contracts";
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

const threadId = ThreadId.make("godot-api-test");
const manifest = () => ({
  schemaVersion: 1 as const,
  name: "API probe",
  brief: "",
  artDirection: "",
  design: { status: "draft" as const },
  engine: { name: "godot" as const, version: "4.7.2" },
  godotProject: "godot",
  assets: [],
});

const withApi = <A, E, R>(
  probe: (resultPath: string, args: readonly string[]) => Promise<void>,
  run: (input: { readonly root: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "godot-api-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const root = NodePath.join(base, "game");
      const stateDir = NodePath.join(base, "state");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(root, "godot"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(root, "godot/project.godot"), "[application]\n");
        await NodeFSP.writeFile(NodePath.join(root, "game.json"), JSON.stringify(manifest()));
      });
      const services = GameService.layer.pipe(
        Layer.provide(
          Layer.mock(GameProjectService.GameProjectService)({
            resolve: () => Effect.succeed(root),
            read: () => Effect.succeed(manifest()),
          }),
        ),
        Layer.provide(
          Layer.mock(GameToolchain.GameToolchain)({
            executable: () =>
              Effect.succeed({ path: "/fake/godot", version: "4.7.2.stable", templates: null }),
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
            status: () =>
              Effect.succeed({
                state: "legacy",
                document: null,
                documentTruncated: false,
                approvedHash: null,
                currentHash: null,
                approvedAt: null,
                acceptance: [],
                issues: [],
                pendingRevision: null,
                revisionDiff: null,
              }),
          }),
        ),
        Layer.provideMerge(roundStoreTestLayer(stateDir)),
        Layer.provideMerge(admissionTestLayer),
        Layer.provide(NodeServices.layer),
        Layer.provide(
          Layer.mock(GameProcesses.GameProcesses)({
            run: (input) =>
              Effect.gen(function* () {
                const args = [...input.args];
                const resultPath = args.at(-1)!;
                yield* Effect.promise(() => probe(resultPath, args));
                return {
                  pid: 1,
                  exitCode: 0,
                  signal: null,
                  timedOut: false,
                  stdout: "",
                  stderr: "",
                  logPath: NodePath.join(root, "builds/logs/fake.log"),
                };
              }),
            start: () => Effect.succeed({ pid: 1, logPath: "fake" }),
            stop: () => Effect.void,
            list: () => [],
          }),
        ),
      );
      return yield* run({ root }).pipe(Effect.provide(services));
    }),
  );

it.live("queries ClassDB through an isolated probe without touching the game", () =>
  withApi(
    async (resultPath) => {
      await NodeFSP.writeFile(
        resultPath,
        JSON.stringify({
          className: "PointLight2D",
          found: true,
          parent: "Light2D",
          inheritance: ["Light2D", "Node2D"],
          methods: [{ name: "get_energy", signature: "get_energy() -> float" }],
          totalMethods: 1,
          properties: [{ name: "energy", type: "float" }],
          totalProperties: 1,
          signals: [],
          totalSignals: 0,
          constants: [],
          totalConstants: 0,
          truncated: false,
          suggestions: [],
          message: "PointLight2D: 1 method(s).",
        }),
      );
    },
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const before = yield* Effect.promise(() =>
          NodeFSP.readdir(NodePath.join(root, "godot")).catch(() => [] as string[]),
        );
        const result = yield* game.godotApi(threadId, { className: "PointLight2D" });
        expect(result.found).toBe(true);
        expect(result.engineVersion).toContain("4.7.2");
        expect(result.parent).toBe("Light2D");
        expect(result.methods[0]).toMatchObject({ name: "get_energy" });
        expect(result.message).toContain("PointLight2D");
        // The probe ran in an isolated scratch project: the game's own
        // godot/ tree gained no probe files.
        const after = yield* Effect.promise(() =>
          NodeFSP.readdir(NodePath.join(root, "godot")).catch(() => [] as string[]),
        );
        expect(after).toEqual(before);
      }),
  ),
);

it.live("reports unknown classes with suggestions and bounds member output", () =>
  withApi(
    async (resultPath) => {
      await NodeFSP.writeFile(
        resultPath,
        JSON.stringify({
          className: "Nope",
          found: false,
          parent: null,
          inheritance: [],
          methods: [],
          totalMethods: 0,
          properties: [],
          totalProperties: 0,
          signals: [],
          totalSignals: 0,
          constants: [],
          totalConstants: 0,
          truncated: false,
          suggestions: ["Node", "Node2D"],
          message: "Nope is not an engine class in ClassDB. ClassDB covers engine classes only.",
        }),
      );
    },
    () =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const unknown = yield* game.godotApi(threadId, { className: "Nope" });
        expect(unknown.found).toBe(false);
        expect(unknown.suggestions).toContain("Node2D");
        expect(unknown.message).toContain("ClassDB covers engine classes only");
      }),
  ),
);

it.live("rejects an invalid class name before running Godot", () =>
  withApi(
    async () => {
      throw new Error("Godot must not run for invalid input");
    },
    () =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const error = yield* game
          .godotApi(threadId, { className: "not-a-class!" })
          .pipe(Effect.flip);
        expect(error.reason).toBe("invalid-input");
      }),
  ),
);
