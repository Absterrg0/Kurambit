// @effect-diagnostics nodeBuiltinImport:off -- This test packages a real archive in a temporary game folder and downloads it over test HTTP.
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
import { ThreadId } from "@t3tools/contracts";
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
import { windowsExecutable, windowsPck } from "./windowsExport.testkit.ts";
import { issueGamePackageDownload } from "./GamePackageDownload.ts";
import { admissionTestLayer } from "./gameTestLayers.ts";

const threadId = ThreadId.make("thr-windows-package-download");

const embeddedBuild = (paths: readonly string[] = ["project.binary"]) =>
  windowsExecutable(windowsPck(paths));

const withServer = <A, E, R>(
  body: (input: {
    readonly root: string;
    readonly game: GameService.GameService["Service"];
    readonly client: HttpClient.HttpClient;
    readonly secretStore: ServerSecretStore.ServerSecretStore["Service"];
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-windows-package-")),
        ),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const lexicalRoot = NodePath.join(base, "game");
      const stateDir = NodePath.join(base, "state");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(lexicalRoot, "builds/windows"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(lexicalRoot, "builds/windows/game.exe"),
          embeddedBuild(),
        );
      });
      // The real service resolves the game root through realpath.
      const root = yield* Effect.promise(() => NodeFSP.realpath(lexicalRoot));

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
        Layer.provideMerge(GameRoundStore.layer({ stateDir })),
        Layer.provideMerge(GameDesignApproval.layer({ stateDir })),
        Layer.provideMerge(admissionTestLayer),
        Layer.provide(NodeServices.layer),
      );

      const services = yield* Layer.build(
        HttpRouter.serve(ServerHttp.layerGamePackageRoute.pipe(Layer.provideMerge(gameLayer)), {
          disableListenLog: true,
        }).pipe(
          Layer.provideMerge(ServerSecretStore.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "game-windows-package-route-" }),
          ),
          Layer.provideMerge(NodeHttpServer.layerTest),
          Layer.provideMerge(NodeServices.layer),
        ),
      );
      return yield* body({
        root,
        game: Context.get(services, GameService.GameService),
        client: Context.get(services, HttpClient.HttpClient),
        secretStore: Context.get(services, ServerSecretStore.ServerSecretStore),
      });
    }),
  );

it.effect("serves only the exact package a signed URL names, never a replacement", () =>
  withServer(({ root, game, client, secretStore }) =>
    Effect.gen(function* () {
      const packaged = yield* game.packageWindows(threadId);
      const first = yield* issueGamePackageDownload(threadId, packaged.sha256).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
      );
      const firstResponse = yield* client.get(first.path);
      expect(firstResponse.status).toBe(200);
      expect(
        Buffer.from(yield* firstResponse.arrayBuffer).equals(
          yield* Effect.promise(() => NodeFSP.readFile(packaged.archivePath)),
        ),
      ).toBe(true);

      // A new release and package under the same mutable archive name does not
      // turn the old URL into a link to different bytes.
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(root, "builds/windows/game.exe"),
          embeddedBuild(["project.binary", "scenes/main.tscn"]),
        ),
      );
      const repackaged = yield* game.packageWindows(threadId);
      expect(repackaged.sha256).not.toBe(packaged.sha256);

      const stale = yield* client.get(first.path);
      expect(stale.status).toBe(404);
      expect(yield* stale.text).not.toContain("PK");

      const fresh = yield* issueGamePackageDownload(threadId, repackaged.sha256).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
      );
      const freshResponse = yield* client.get(fresh.path);
      expect(freshResponse.status).toBe(200);
      expect(
        Buffer.from(yield* freshResponse.arrayBuffer).equals(
          yield* Effect.promise(() => NodeFSP.readFile(repackaged.archivePath)),
        ),
      ).toBe(true);
    }),
  ),
);

it.effect("refuses a package reached through a replaced parent directory", () =>
  withServer(({ root, game, client, secretStore }) =>
    Effect.gen(function* () {
      const packaged = yield* game.packageWindows(threadId);
      const windows = NodePath.join(root, "builds/windows");
      const moved = NodePath.join(root, "builds/windows-real");
      yield* Effect.promise(() => NodeFSP.rename(windows, moved));
      yield* Effect.promise(() => NodeFSP.symlink(moved, windows, "junction"));
      const issued = yield* issueGamePackageDownload(threadId, packaged.sha256).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
      );
      const response = yield* client.get(issued.path);
      expect(response.status).toBe(404);
    }),
  ),
);

it.effect("refuses a symlinked archive and an actionable missing package", () =>
  withServer(({ root, game, client, secretStore }) =>
    Effect.gen(function* () {
      const missing = yield* issueGamePackageDownload(threadId, "a".repeat(64)).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
      );
      const missingResponse = yield* client.get(missing.path);
      expect(missingResponse.status).toBe(404);
      expect(yield* missingResponse.text).toContain("No complete Windows package");
      const missingState = yield* Effect.promise(() =>
        NodeFSP.stat(NodePath.join(root, "builds/windows/game-windows.zip")).then(
          () => null,
          (cause: unknown) => cause,
        ),
      );
      expect(missingState).toMatchObject({ code: "ENOENT" });

      const packaged = yield* game.packageWindows(threadId);
      const outside = NodePath.join(root, "outside.txt");
      const privateBytes = Buffer.from("not the package");
      yield* Effect.promise(() => NodeFSP.writeFile(outside, privateBytes));
      yield* Effect.promise(() => NodeFSP.rm(packaged.archivePath));
      yield* Effect.promise(() =>
        NodeFSP.symlink(outside, NodePath.join(root, "builds/windows/game-windows.zip")),
      );
      const privateSha = NodeCrypto.createHash("sha256").update(privateBytes).digest("hex");
      const forged = yield* issueGamePackageDownload(threadId, privateSha).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
      );
      const response = yield* client.get(forged.path);
      expect(response.status).toBe(404);
      expect(yield* response.text).not.toContain("not the package");
    }),
  ),
);
