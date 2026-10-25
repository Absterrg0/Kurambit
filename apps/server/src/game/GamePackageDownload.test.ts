import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  GAME_PACKAGE_ROUTE_PREFIX,
  GAME_WEB_PACKAGE_ROUTE_PREFIX,
  isGamePackageRoutePath,
  issueGamePackageDownload,
  issueGameWebPackageDownload,
  verifyGamePackageDownload,
} from "./GamePackageDownload.ts";

const layer = ServerSecretStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "game-package-token-" })),
  Layer.provideMerge(NodeServices.layer),
);

const tokenOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

it.effect("mints a package-scoped download capability and refuses edited or expired tokens", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("thr_package-test");
      const packageSha256 = "a".repeat(64);
      const issued = yield* issueGamePackageDownload(threadId, packageSha256);
      expect(issued.path.startsWith(`${GAME_PACKAGE_ROUTE_PREFIX}/`)).toBe(true);
      expect(issued.path).not.toContain("game-windows.zip");
      expect(isGamePackageRoutePath(issued.path)).toBe(true);
      expect(isGamePackageRoutePath(`${GAME_PACKAGE_ROUTE_PREFIX}-other/token`)).toBe(false);

      const token = tokenOf(issued.path);
      const claims = yield* verifyGamePackageDownload(token);
      expect(claims?.kind).toBe("windows");
      expect(claims?.threadId).toBe(threadId);
      expect(claims?.packageSha256).toBe(packageSha256);
      expect(claims?.expiresAt).toBe(issued.expiresAt);

      expect(yield* verifyGamePackageDownload(`${token}x`)).toBeNull();
      expect(yield* verifyGamePackageDownload(`${token}.extra`)).toBeNull();
      expect(yield* verifyGamePackageDownload("not-a-token")).toBeNull();
      expect(yield* verifyGamePackageDownload("../../etc/passwd")).toBeNull();
      expect(yield* verifyGamePackageDownload(`${token}/../other`)).toBeNull();

      const expired = yield* issueGamePackageDownload(threadId, packageSha256, -1);
      expect(yield* verifyGamePackageDownload(tokenOf(expired.path))).toBeNull();
    }).pipe(Effect.provide(layer)),
  ),
);

it.effect("binds a Web package capability to the selected build and its archive hash", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("thr_web-package-test");
      const buildId = "b".repeat(64);
      const packageSha256 = "c".repeat(64);
      const issued = yield* issueGameWebPackageDownload(threadId, buildId, packageSha256);
      expect(issued.path.startsWith(`${GAME_WEB_PACKAGE_ROUTE_PREFIX}/`)).toBe(true);
      expect(issued.path).not.toContain(buildId);
      expect(isGamePackageRoutePath(issued.path)).toBe(true);

      const claims = yield* verifyGamePackageDownload(tokenOf(issued.path));
      expect(claims?.kind).toBe("web");
      expect(claims?.threadId).toBe(threadId);
      expect(claims?.buildId).toBe(buildId);
      expect(claims?.packageSha256).toBe(packageSha256);

      const expired = yield* issueGameWebPackageDownload(threadId, buildId, packageSha256, -1);
      expect(yield* verifyGamePackageDownload(tokenOf(expired.path))).toBeNull();
    }).pipe(Effect.provide(layer)),
  ),
);
