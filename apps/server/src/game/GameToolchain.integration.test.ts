import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GameProcesses from "./GameProcesses.ts";
it.live.skipIf(process.env.GAME_STUDIO_INSTALL_TEST !== "1")(
  "installs the pinned toolchain and performs real headless checks",
  () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const tools = yield* GameToolchain.GameToolchain;
          return yield* tools.install;
        }).pipe(
          Effect.provide(
            GameToolchain.layer.pipe(
              Layer.provide(GameProcesses.layer),
              Layer.provide(ServerSettings.layerTest()),
            ),
          ),
        ),
      );
      yield* Effect.log(result);
      expect(result.tools.every((tool) => tool.ready && tool.verified)).toBe(true);
    }),
  3600000,
);
