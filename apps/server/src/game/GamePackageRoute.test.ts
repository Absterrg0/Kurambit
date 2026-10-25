// @effect-diagnostics nodeBuiltinImport:off -- This route test writes a real archive in a temporary directory and reads it back over test HTTP.
import * as NodeFS from "node:fs";
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
import * as ServerHttp from "../http.ts";
import * as GameService from "./GameService.ts";
import { GAME_PACKAGE_ROUTE_PREFIX, issueGamePackageDownload } from "./GamePackageDownload.ts";

const packageSha = "a".repeat(64);

interface FakePackageFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256?: string;
  readonly identity?: { readonly device: string; readonly inode: string };
}

const makeService = (file: FakePackageFile | null) =>
  ({
    windowsPackageFile: () => {
      if (file === null)
        return Effect.fail(
          new GameOperationError({
            operation: "Download Windows package",
            path: "/missing/game-windows.zip",
            reason: "download",
            detail: "No Windows package is ready.",
          }),
        );
      const stat = NodeFS.statSync(file.path);
      return Effect.succeed({
        path: file.path,
        fileName: "game-windows.zip",
        bytes: file.bytes,
        sha256: file.sha256 ?? packageSha,
        identity: file.identity ?? { device: String(stat.dev), inode: String(stat.ino) },
      });
    },
  }) as unknown as GameService.GameService["Service"];

const layerApp = (file: FakePackageFile | null) =>
  HttpRouter.serve(
    ServerHttp.layerGamePackageRoute.pipe(
      Layer.provideMerge(Layer.succeed(GameService.GameService, makeService(file))),
    ),
    { disableListenLog: true },
  ).pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "game-package-route-" })),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect("streams only the archive a valid capability names", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-package-route-file-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      );
      const path = NodePath.join(directory, "game-windows.zip");
      const bytes = Buffer.from("PK\u0003\u0004test package bytes");
      yield* Effect.promise(() => NodeFSP.writeFile(path, bytes));

      const services = yield* Layer.build(layerApp({ path, bytes: bytes.byteLength }));
      const client = Context.get(services, HttpClient.HttpClient);
      const secretStore = Context.get(services, ServerSecretStore.ServerSecretStore);
      const threadId = ThreadId.make("thr_route-test");
      const issued = yield* issueGamePackageDownload(threadId, packageSha).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
      );

      const response = yield* client.get(issued.path);
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("application/zip");
      expect(response.headers["content-disposition"]).toContain(
        'attachment; filename="game-windows.zip"',
      );
      expect(Buffer.from(yield* response.arrayBuffer).equals(bytes)).toBe(true);

      const edited = yield* client.get(`${issued.path}x`);
      expect(edited.status).toBe(404);

      const traversal = yield* client.get(`${GAME_PACKAGE_ROUTE_PREFIX}/..%2F..%2Fetc%2Fpasswd`);
      expect(traversal.status).toBe(404);
    }),
  ),
);

it.effect("does not serve an archive replaced after the capability was minted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-package-route-swap-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      );
      const path = NodePath.join(directory, "game-windows.zip");
      const replacement = NodePath.join(directory, "replacement.zip");
      yield* Effect.promise(() => NodeFSP.writeFile(path, "package A"));
      const stat = NodeFS.statSync(path);
      const services = yield* Layer.build(
        layerApp({
          path,
          bytes: Buffer.byteLength("package A"),
          sha256: packageSha,
          identity: { device: String(stat.dev), inode: String(stat.ino) },
        }),
      );
      const client = Context.get(services, HttpClient.HttpClient);
      const secretStore = Context.get(services, ServerSecretStore.ServerSecretStore);
      const threadId = ThreadId.make("thr_route-swap");
      const issued = yield* issueGamePackageDownload(threadId, packageSha).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
      );

      yield* Effect.promise(() => NodeFSP.writeFile(replacement, "package B"));
      yield* Effect.promise(() => NodeFSP.rm(path));
      yield* Effect.promise(() => NodeFSP.rename(replacement, path));

      const response = yield* client.get(issued.path);
      expect(response.status).toBe(404);
      expect(yield* response.text).toContain("changed before it could be downloaded");
    }),
  ),
);

it.effect("does not create a package when the download route finds none", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(layerApp(null));
      const client = Context.get(services, HttpClient.HttpClient);
      const secretStore = Context.get(services, ServerSecretStore.ServerSecretStore);
      const threadId = ThreadId.make("thr_route-missing");
      const issued = yield* issueGamePackageDownload(threadId, packageSha).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
      );

      const response = yield* client.get(issued.path);
      expect(response.status).toBe(404);
      expect(yield* response.text).toContain("No complete Windows package is ready");
    }),
  ),
);
