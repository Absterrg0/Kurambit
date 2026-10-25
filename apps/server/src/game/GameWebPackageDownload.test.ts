// @effect-diagnostics nodeBuiltinImport:off -- This test packages real Web build bytes in a temporary game folder and downloads them over test HTTP.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpRouter } from "effect/http";
import { GameOperationError, ThreadId } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as ServerHttp from "../http.ts";
import * as GameDesignApproval from "./GameDesignApproval.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameQualification from "./GameQualification.ts";
import * as GameRoundStore from "./GameRoundStore.ts";
import * as GameService from "./GameService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import {
  GAME_PACKAGE_ROUTE_PREFIX,
  GAME_WEB_PACKAGE_ROUTE_PREFIX,
  issueGamePackageDownload,
  issueGameWebPackageDownload,
} from "./GamePackageDownload.ts";
import { admissionTestLayer } from "./gameTestLayers.ts";
import { readZipArchive, writeWebBuildFixture } from "./webPackage.testkit.ts";
import { webPackageArchivePath } from "./webPackage.ts";

const threadId = ThreadId.make("thr-web-package-download");

const withServer = <A, E, R>(
  body: (input: {
    readonly root: string;
    readonly game: GameService.GameService["Service"];
    readonly rounds: GameRoundStore.GameRoundStore["Service"];
    readonly client: HttpClient.HttpClient;
    readonly secretStore: ServerSecretStore.ServerSecretStore["Service"];
  }) => Effect.Effect<A, E, R>,
  options?: { readonly sourceScans?: { count: number } },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-web-package-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const lexicalRoot = NodePath.join(base, "game");
      const stateDir = NodePath.join(base, "state");
      yield* Effect.promise(() => NodeFSP.mkdir(lexicalRoot, { recursive: true }));
      // The real service resolves the game root through realpath.
      const root = yield* Effect.promise(() => NodeFSP.realpath(lexicalRoot));

      const roundLayer = GameRoundStore.layer({ stateDir });
      const roundsLayer =
        options?.sourceScans === undefined
          ? roundLayer
          : roundLayer.pipe(
              Layer.flatMap((context) => {
                const rounds = Context.get(context, GameRoundStore.GameRoundStore);
                return Layer.succeed(
                  GameRoundStore.GameRoundStore,
                  GameRoundStore.GameRoundStore.of({
                    ...rounds,
                    // A package download must not pay for a source-tree snapshot.
                    sourceId: () =>
                      Effect.sync(() => {
                        options.sourceScans!.count += 1;
                      }).pipe(Effect.as("scanned")),
                  }),
                );
              }),
            );
      const gameLayer = GameService.layerWithPlaytest(() =>
        Effect.die("This test provides no browser run."),
      ).pipe(
        Layer.provide(
          Layer.mock(GameProjectService.GameProjectService)({
            resolve: () => Effect.succeed(root),
          }),
        ),
        Layer.provide(
          Layer.mock(GameProcesses.GameProcesses)({
            list: () => [],
            stop: () => Effect.void,
          }),
        ),
        Layer.provide(Layer.mock(GameToolchain.GameToolchain)({})),
        Layer.provide(
          Layer.mock(GamePreview.GamePreview)({
            directories: () => [],
            open: () => Effect.succeed("http://127.0.0.1:9/builds/web"),
            select: () => Effect.succeed("http://127.0.0.1:9/builds/web"),
            stop: () => Effect.void,
            url: () => null,
            urlFor: () => null,
            serving: () => false,
          }),
        ),
        Layer.provide(Layer.mock(PreviewBrowser.PreviewBrowser)({})),
        Layer.provideMerge(GameQualification.layer({ stateDir })),
        Layer.provideMerge(roundsLayer),
        Layer.provideMerge(GameDesignApproval.layer({ stateDir })),
        Layer.provideMerge(admissionTestLayer),
        Layer.provide(NodeServices.layer),
      );

      const services = yield* Layer.build(
        HttpRouter.serve(ServerHttp.layerGameWebPackageRoute.pipe(Layer.provideMerge(gameLayer)), {
          disableListenLog: true,
        }).pipe(
          Layer.provideMerge(ServerSecretStore.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "game-web-package-route-" }),
          ),
          Layer.provideMerge(NodeHttpServer.layerTest),
          Layer.provideMerge(NodeServices.layer),
        ),
      );
      return yield* body({
        root,
        game: Context.get(services, GameService.GameService),
        rounds: Context.get(services, GameRoundStore.GameRoundStore),
        client: Context.get(services, HttpClient.HttpClient),
        secretStore: Context.get(services, ServerSecretStore.ServerSecretStore),
      });
    }),
  );

const select = (
  rounds: GameRoundStore.GameRoundStore["Service"],
  root: string,
  artifact: {
    readonly buildId: string;
    readonly directory: string;
    readonly entry: string;
    readonly sourceId: string | null;
  },
) =>
  rounds.select(root, {
    buildId: artifact.buildId,
    directory: artifact.directory,
    sourceId: artifact.sourceId,
    entry: artifact.entry,
    engine: "godot",
    target: "Web",
  });

const writeSources = async (root: string) => {
  await NodeFSP.mkdir(NodePath.join(root, "godot"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(root, "godot/project.godot"), "config_version=5\n");
};

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const tokenOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

it.effect(
  "packages the selected Play build, never a newer candidate, and keeps later source edits out",
  () =>
    withServer(({ root, game, rounds, client, secretStore }) =>
      Effect.gen(function* () {
        // No selection is an actionable refusal, not a silent export.
        const missing = yield* game.packageWeb(threadId).pipe(Effect.flip);
        expect(missing._tag).toBe("GameOperationError");
        expect((missing as GameOperationError).reason).toBe("invalid-input");
        expect((missing as GameOperationError).detail).toContain("No Web build is selected");
        expect(
          yield* Effect.promise(() =>
            NodeFSP.stat(NodePath.join(root, "builds/web-packages")).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);

        yield* Effect.promise(() => writeSources(root));
        const sourceId = yield* rounds.sourceId(root);
        const first = yield* Effect.promise(() =>
          writeWebBuildFixture(
            root,
            {
              "index.html": '<html><script src="index.js"></script></html>',
              "index.js": "first build",
              "index.pck": "first pck",
            },
            "index.html",
            sourceId,
          ),
        );
        yield* select(rounds, root, first.selected);
        // A newer candidate exists on disk but is not the build Play serves.
        const newer = yield* Effect.promise(() =>
          writeWebBuildFixture(
            root,
            {
              "index.html": "<html>newer unselected candidate</html>",
              "index.js": "newer build",
              "index.pck": "newer pck",
            },
            "index.html",
            sourceId,
          ),
        );
        expect(newer.selected.buildId).not.toBe(first.selected.buildId);

        const packaged = yield* game.packageWeb(threadId);
        expect(packaged.buildId).toBe(first.selected.buildId);
        expect(packaged.archivePath).toBe(webPackageArchivePath(root, first.selected.buildId));
        expect(packaged.files.map((file) => file.path).sort()).toEqual([
          "index.html",
          "index.js",
          "index.pck",
        ]);
        expect(packaged.notes.join(" ")).toContain("does not compare them");
        expect(packaged.notes.join(" ")).toContain("file://");
        const entries = yield* Effect.promise(() => readZipArchive(packaged.archivePath));
        expect([...entries.keys()].sort()).toEqual(["index.html", "index.js", "index.pck"]);
        expect(entries.get("index.html")!.toString()).not.toContain("newer");
        expect(entries.get("index.pck")!.toString()).toBe("first pck");
        const archive = yield* Effect.promise(() => NodeFSP.readFile(packaged.archivePath));
        expect(packaged.bytes).toBe(archive.byteLength);
        expect(packaged.sha256).toBe(sha256(archive));

        // A later source edit is not silently packaged and does not require a
        // new export: the same selected build bytes are downloaded again.
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(root, "godot/project.godot"),
            "config_version=5\n# later edit\n",
          ),
        );
        const afterEdit = yield* game.packageWeb(threadId);
        expect(afterEdit.buildId).toBe(first.selected.buildId);
        expect(afterEdit.sha256).toBe(packaged.sha256);
        expect(afterEdit.notes.join(" ")).toContain("later source edits are not included");
        expect((yield* rounds.read(root)).selected?.buildId).toBe(first.selected.buildId);

        // The download is the exact archive, through the signed capability.
        const issued = yield* issueGameWebPackageDownload(
          threadId,
          packaged.buildId,
          packaged.sha256,
        ).pipe(Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore));
        const response = yield* client.get(issued.path);
        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toBe("application/zip");
        expect(response.headers["content-disposition"]).toContain('filename="game-web.zip"');
        expect(Buffer.from(yield* response.arrayBuffer).equals(archive)).toBe(true);

        // Changed build bytes fail before publication and leave the earlier
        // package, the selection and the game's sources alone.
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(root, first.selected.directory, "index.pck"), "mutated"),
        );
        const failure = yield* game.packageWeb(threadId).pipe(Effect.flip);
        expect(failure._tag).toBe("GameOperationError");
        expect((failure as GameOperationError).reason).toBe("invalid-input");
        expect((failure as GameOperationError).detail).toContain("changed after it was selected");
        expect(yield* Effect.promise(() => NodeFSP.readFile(packaged.archivePath))).toEqual(
          archive,
        );
        expect((yield* rounds.read(root)).selected?.buildId).toBe(first.selected.buildId);
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(root, "godot/project.godot"))),
        ).toEqual(Buffer.from("config_version=5\n# later edit\n"));
      }),
    ),
);

it.effect("packages the selected bytes without walking the game's source tree", () => {
  const sourceScans = { count: 0 };
  return withServer(
    ({ root, game, rounds }) =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() =>
          writeWebBuildFixture(root, {
            "index.html": '<html><script src="index.js"></script></html>',
            "index.js": "selected",
            "index.pck": "selected pck",
          }),
        );
        yield* select(rounds, root, fixture.selected);

        const packaged = yield* game.packageWeb(threadId);
        expect(packaged.buildId).toBe(fixture.selected.buildId);
        expect(sourceScans.count).toBe(0);
        expect(packaged.notes.join(" ")).toContain("does not compare them");
        expect(packaged.notes.join(" ")).not.toContain("matched when packaging started");
      }),
    { sourceScans },
  );
});

it.effect("invalidates an old signed Web URL when a new build is selected, and bounds tokens", () =>
  withServer(({ root, game, rounds, client, secretStore }) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeSources(root));
      const sourceId = yield* rounds.sourceId(root);
      const first = yield* Effect.promise(() =>
        writeWebBuildFixture(
          root,
          {
            "index.html": "<html>first</html>",
            "index.js": "first",
            "index.pck": "first",
          },
          "index.html",
          sourceId,
        ),
      );
      yield* select(rounds, root, first.selected);
      const packaged = yield* game.packageWeb(threadId);
      const oldUrl = yield* issueGameWebPackageDownload(
        threadId,
        packaged.buildId,
        packaged.sha256,
      ).pipe(Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore));

      const second = yield* Effect.promise(() =>
        writeWebBuildFixture(
          root,
          {
            "index.html": "<html>second</html>",
            "index.js": "second",
            "index.pck": "second",
          },
          "index.html",
          sourceId,
        ),
      );
      yield* select(rounds, root, second.selected);

      const stale = yield* client.get(oldUrl.path);
      expect(stale.status).toBe(404);
      expect(yield* stale.text).toContain(
        "No complete Web package is ready for the selected build",
      );
      expect(yield* stale.text).not.toContain("<html>first</html>");
      expect(yield* stale.text).not.toContain("<html>second</html>");

      const secondPackage = yield* game.packageWeb(threadId);
      expect(secondPackage.buildId).toBe(second.selected.buildId);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.stat(webPackageArchivePath(root, first.selected.buildId)).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false);
      const freshUrl = yield* issueGameWebPackageDownload(
        threadId,
        secondPackage.buildId,
        secondPackage.sha256,
      ).pipe(Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore));
      const fresh = yield* client.get(freshUrl.path);
      expect(fresh.status).toBe(200);
      const freshBytes = Buffer.from(yield* fresh.arrayBuffer);
      expect(sha256(freshBytes)).toBe(secondPackage.sha256);
      expect(freshBytes.toString()).toContain("second");

      // An edited capability, a Windows capability replayed on the Web route,
      // and a hash that names different bytes are all refused.
      const edited = yield* client.get(`${freshUrl.path}x`);
      expect(edited.status).toBe(404);
      const windowsToken = yield* issueGamePackageDownload(threadId, "a".repeat(64)).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
      );
      const crossTarget = yield* client.get(
        `${GAME_WEB_PACKAGE_ROUTE_PREFIX}/${tokenOf(windowsToken.path)}`,
      );
      expect(crossTarget.status).toBe(404);
      const wrongHash = yield* issueGameWebPackageDownload(
        threadId,
        secondPackage.buildId,
        "e".repeat(64),
      ).pipe(Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore));
      const mismatched = yield* client.get(wrongHash.path);
      expect(mismatched.status).toBe(404);
      expect(yield* mismatched.text).not.toContain("second");

      // A package replaced by a symlink to a private file is never served.
      const outside = NodePath.join(root, "outside.txt");
      const privateBytes = Buffer.from("private bytes outside the package");
      yield* Effect.promise(() => NodeFSP.writeFile(outside, privateBytes));
      yield* Effect.promise(() => NodeFSP.rm(secondPackage.archivePath));
      yield* Effect.promise(() => NodeFSP.symlink(outside, secondPackage.archivePath));
      const forged = yield* issueGameWebPackageDownload(
        threadId,
        secondPackage.buildId,
        sha256(privateBytes),
      ).pipe(Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore));
      const symlinked = yield* client.get(forged.path);
      expect(symlinked.status).toBe(404);
      expect(yield* symlinked.text).not.toContain("private bytes");

      const traversal = yield* client.get(
        `${GAME_WEB_PACKAGE_ROUTE_PREFIX}/..%2F..%2Fetc%2Fpasswd`,
      );
      expect(traversal.status).toBe(404);
      expect(GAME_PACKAGE_ROUTE_PREFIX).not.toBe(GAME_WEB_PACKAGE_ROUTE_PREFIX);
    }),
  ),
);
