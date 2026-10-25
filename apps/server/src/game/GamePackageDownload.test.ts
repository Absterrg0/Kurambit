import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  GAME_PACKAGE_ROUTE_PREFIX,
  issueGamePackageDownload,
  verifyGamePackageDownload,
} from "./GamePackageDownload.ts";

const layer = ServerSecretStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "game-package-token-" })),
  Layer.provideMerge(NodeServices.layer),
);

const tokenOf = (path: string) => path.slice(`${GAME_PACKAGE_ROUTE_PREFIX}/`.length);

it.effect("mints a thread-scoped download capability and refuses edited or expired tokens", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("thr_package-test");
      const issued = yield* issueGamePackageDownload(threadId);
      expect(issued.path.startsWith(`${GAME_PACKAGE_ROUTE_PREFIX}/`)).toBe(true);
      expect(issued.path).not.toContain("game-windows.zip");

      const token = tokenOf(issued.path);
      const claims = yield* verifyGamePackageDownload(token);
      expect(claims?.threadId).toBe(threadId);
      expect(claims?.expiresAt).toBe(issued.expiresAt);

      expect(yield* verifyGamePackageDownload(`${token}x`)).toBeNull();
      expect(yield* verifyGamePackageDownload("not-a-token")).toBeNull();
      expect(yield* verifyGamePackageDownload("../../etc/passwd")).toBeNull();
      expect(yield* verifyGamePackageDownload(`${token}/../other`)).toBeNull();

      const expired = yield* issueGamePackageDownload(threadId, -1);
      expect(yield* verifyGamePackageDownload(tokenOf(expired.path))).toBeNull();
    }).pipe(Effect.provide(layer)),
  ),
);
