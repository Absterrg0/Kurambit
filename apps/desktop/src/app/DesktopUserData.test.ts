import * as NodePath from "@effect/platform-node/NodePath";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect.each(["linux", "darwin", "win32"] as const)(
  "uses fresh fork profiles on %s without inspecting legacy storage",
  (platform) =>
    Effect.gen(function* () {
      assert.equal(
        yield* resolveUserDataPath({
          appDataDirectory: "/profiles",
          isDevelopment: true,
          platform,
        }),
        "/profiles/kurambit-dev",
      );
      assert.equal(
        yield* resolveUserDataPath({
          appDataDirectory: "/profiles",
          isDevelopment: false,
          platform,
        }),
        "/profiles/kurambit",
      );
    }).pipe(Effect.provide(NodePath.layerPosix)),
);
