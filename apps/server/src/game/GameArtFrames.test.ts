// @effect-diagnostics nodeBuiltinImport:off -- These tests drive sprite-frame builds with a stubbed Godot boundary; the real engine run is integration-gated.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ThreadId, type GameDesignRead, type GameManifest } from "@t3tools/contracts";
import * as GameDesignApproval from "./GameDesignApproval.ts";
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

const threadId = ThreadId.make("art-frames-test");

const manifest = (): GameManifest => ({
  schemaVersion: 1,
  name: "Frames probe",
  brief: "",
  artDirection: "",
  design: { status: "approved" },
  engine: { name: "godot", version: "4.7.2" },
  godotProject: "godot",
  assets: [],
});

const design = (state: GameDesignRead["state"]): GameDesignRead => ({
  state,
  document: null,
  documentTruncated: false,
  approvedHash: "hash",
  currentHash: "hash",
  approvedAt: "2026-10-27T00:00:00.000Z",
  acceptance: [],
  issues: [],
  pendingRevision: null,
  revisionDiff: null,
});

const withGame = <A, E, R>(
  body: (input: { readonly root: string; readonly ran: () => number }) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-art-frames-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const root = NodePath.join(base, "game");
      const stateDir = NodePath.join(base, "state");
      let calls = 0;
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(root, "godot"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(root, "godot/project.godot"), "[application]\n");
        await NodeFSP.writeFile(NodePath.join(root, "game.json"), JSON.stringify(manifest()));
        // The kit import the frames build on: the real shipped sheet bytes.
        const shipped = NodePath.join(
          import.meta.dirname,
          "..",
          "..",
          "assets",
          "art-kits",
          "kenney-pixel-platformer",
          "tilemap-characters_packed.png",
        );
        const destination = NodePath.join(root, "godot/assets/art/kits/kenney-pixel-platformer");
        await NodeFSP.mkdir(destination, { recursive: true });
        await NodeFSP.copyFile(
          shipped,
          NodePath.join(destination, "tilemap-characters_packed.png"),
        );
      });
      const services = GameService.layer.pipe(
        Layer.provide(
          Layer.mock(GameProcesses.GameProcesses)({
            // A stub Godot: the import answers success, and the frames build
            // echoes the request's animations into the result and writes a
            // minimal SpriteFrames file where res:// points.
            run: (input) =>
              input.operation === "godot-import"
                ? Effect.succeed({
                    pid: 7,
                    exitCode: 0,
                    signal: null,
                    timedOut: false,
                    stdout: "imported",
                    stderr: "",
                    logPath: NodePath.join(root, "builds/logs/import-test.log"),
                  })
                : Effect.promise(async () => {
                    calls += 1;
                    const separator = input.args.indexOf("--");
                    const requestPath = input.args[separator + 1]!;
                    const resultPath = input.args[separator + 2]!;
                    const pathIndex = input.args.indexOf("--path");
                    const cwd = input.args[pathIndex + 1]!;
                    const request = JSON.parse(await NodeFSP.readFile(requestPath, "utf8")) as {
                      animations: ReadonlyArray<{
                        name: string;
                        cells: ReadonlyArray<{ col: number; row: number }>;
                        fps: number;
                        loop: boolean;
                      }>;
                      outputPath: string;
                    };
                    const relative = request.outputPath.replace(/^res:\/\//, "");
                    const output = NodePath.isAbsolute(relative)
                      ? relative
                      : NodePath.join(cwd, relative);
                    await NodeFSP.mkdir(NodePath.dirname(output), {
                      recursive: true,
                    });
                    await NodeFSP.writeFile(output, '[gd_resource type="SpriteFrames" format=3]\n');
                    await NodeFSP.writeFile(
                      resultPath,
                      JSON.stringify({
                        animations: request.animations.map((entry) => ({
                          name: entry.name,
                          frames: entry.cells.length,
                          fps: entry.fps,
                          loop: entry.loop,
                        })),
                      }),
                    );
                    return {
                      pid: 7,
                      exitCode: 0,
                      signal: null,
                      timedOut: false,
                      stdout: "",
                      stderr: "",
                      logPath: NodePath.join(root, "builds/logs/frames-test.log"),
                    };
                  }),
            list: () => [],
            stop: () => Effect.void,
          }),
        ),
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
            status: () => Effect.succeed(design("approved")),
          }),
        ),
        Layer.provideMerge(roundStoreTestLayer(stateDir)),
        Layer.provideMerge(admissionTestLayer),
        Layer.provide(NodeServices.layer),
      );
      return yield* body({ root, ran: () => calls }).pipe(Effect.provide(services));
    }),
  );

it.live("an unknown kit id names the available ids", () =>
  withGame(({ ran }) =>
    Effect.gen(function* () {
      const game = yield* GameService.GameService;
      const error = yield* game
        .buildArtFrames(threadId, { id: "no-such-kit", sheet: "characters" })
        .pipe(Effect.flip);
      expect(error.reason).toBe("unknown-art-kit");
      expect(ran()).toBe(0);
    }),
  ),
);

it.live("an unknown sheet names the available sheets", () =>
  withGame(({ ran }) =>
    Effect.gen(function* () {
      const game = yield* GameService.GameService;
      const error = yield* game
        .buildArtFrames(threadId, { id: "kenney-pixel-platformer", sheet: "terrain" })
        .pipe(Effect.flip);
      expect(error.reason).toBe("invalid-input");
      expect(error.detail).toContain("characters");
      expect(ran()).toBe(0);
    }),
  ),
);

it.live("unknown animation names fail instead of building a partial set", () =>
  withGame(({ ran }) =>
    Effect.gen(function* () {
      const game = yield* GameService.GameService;
      const error = yield* game
        .buildArtFrames(threadId, {
          id: "kenney-pixel-platformer",
          sheet: "characters",
          animations: ["bat-flap", "invented"],
        })
        .pipe(Effect.flip);
      expect(error.reason).toBe("invalid-input");
      expect(error.detail).toContain("invented");
      expect(ran()).toBe(0);
    }),
  ),
);

it.live("a missing kit install fails before any engine run", () =>
  withGame(({ root, ran }) =>
    Effect.gen(function* () {
      const game = yield* GameService.GameService;
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.join(root, "godot/assets/art/kits/kenney-pixel-platformer"), {
          recursive: true,
          force: true,
        }),
      );
      const error = yield* game
        .buildArtFrames(threadId, { id: "kenney-pixel-platformer", sheet: "characters" })
        .pipe(Effect.flip);
      expect(error.detail).toContain("game_art_import");
      expect(ran()).toBe(0);
    }),
  ),
);

it.live("builds every authored animation into a SpriteFrames resource", () =>
  withGame(({ root, ran }) =>
    Effect.gen(function* () {
      const game = yield* GameService.GameService;
      const result = yield* game.buildArtFrames(threadId, {
        id: "kenney-pixel-platformer",
        sheet: "characters",
      });
      expect(ran()).toBe(1);
      expect(result.framesPath).toBe(
        "godot/assets/art/kits/kenney-pixel-platformer/characters_frames.tres",
      );
      expect(result.framesResPath).toBe(
        "res://assets/art/kits/kenney-pixel-platformer/characters_frames.tres",
      );
      expect(result.animations.map((entry) => entry.name)).toContain("bat-flap");
      expect(result.animations).toHaveLength(10);
      expect(result.animations.find((entry) => entry.name === "flying-flap")?.frames).toBe(3);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(root, result.framesPath), "utf8"),
        ),
      ).toContain("SpriteFrames");
      expect(result.message).toContain("CC0");
      expect(result.message).toContain("kenney.nl");
    }),
  ),
);

it.live("builds a named subset on request", () =>
  withGame(() =>
    Effect.gen(function* () {
      const game = yield* GameService.GameService;
      const result = yield* game.buildArtFrames(threadId, {
        id: "kenney-pixel-platformer",
        sheet: "characters",
        animations: ["bat-flap"],
      });
      expect(result.animations).toHaveLength(1);
      expect(result.animations[0]?.frames).toBe(3);
      expect(result.animations[0]?.loop).toBe(true);
    }),
  ),
);

it.live("building a subset preserves a resource already used by the full animation set", () =>
  withGame(({ root }) =>
    Effect.gen(function* () {
      const game = yield* GameService.GameService;
      const full = yield* game.buildArtFrames(threadId, {
        id: "kenney-pixel-platformer",
        sheet: "characters",
      });
      const fullPath = NodePath.join(root, full.framesPath);
      const before = yield* Effect.promise(() => NodeFSP.readFile(fullPath));
      const subset = yield* game.buildArtFrames(threadId, {
        id: "kenney-pixel-platformer",
        sheet: "characters",
        animations: ["bat-flap"],
      });
      expect(subset.framesPath).not.toBe(full.framesPath);
      expect(yield* Effect.promise(() => NodeFSP.readFile(fullPath))).toEqual(before);
    }),
  ),
);

it.live("refuses to overwrite a modified frames resource", () =>
  withGame(({ root }) =>
    Effect.gen(function* () {
      const game = yield* GameService.GameService;
      const path = NodePath.join(
        root,
        "godot/assets/art/kits/kenney-pixel-platformer/characters_frames.tres",
      );
      yield* Effect.promise(() => NodeFSP.writeFile(path, "creator edited frames"));
      const result = yield* Effect.result(
        game.buildArtFrames(threadId, { id: "kenney-pixel-platformer", sheet: "characters" }),
      );
      expect(result._tag).toBe("Failure");
      expect(yield* Effect.promise(() => NodeFSP.readFile(path, "utf8"))).toBe(
        "creator edited frames",
      );
    }),
  ),
);
