import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as Updates from "./DesktopUpdates.ts";

it.effect(
  "never checks or installs updates with a packaged build, saved channel, or inherited updater configuration",
  () =>
    Effect.gen(function* () {
      const updates = yield* Updates.make;
      yield* updates.configure;
      const state = yield* updates.setChannel("nightly");
      assert.isFalse(state.enabled);
      assert.equal(state.status, "disabled");
      assert.isNull(state.checkedAt);
      assert.isFalse((yield* updates.check("startup")).checked);
      assert.isFalse((yield* updates.download).accepted);
      assert.isFalse((yield* updates.install).accepted);
      assert.isFalse((yield* updates.installPrepared("upstream-version")).accepted);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          DesktopEnvironment.layer({
            dirname: "/repo/apps/desktop/dist-electron",
            homeDirectory: "/home/test",
            platform: "linux",
            processArch: "x64",
            appVersion: "1.0.0",
            appPath: "/app",
            isPackaged: true,
            resourcesPath: "/app/resources",
            runningUnderArm64Translation: false,
          }).pipe(
            Layer.provide(
              Layer.mergeAll(
                NodeServices.layer,
                DesktopConfig.layerTest({
                  T3CODE_MOCK_UPDATES: "true",
                  T3CODE_DESKTOP_UPDATE_REPOSITORY: "pingdotgg/t3code",
                }),
              ),
            ),
          ),
          Layer.succeed(
            ElectronWindow.ElectronWindow,
            ElectronWindow.ElectronWindow.of({
              create: () => Effect.die("unexpected create"),
              main: Effect.succeed(Option.none()),
              currentMainOrFirst: Effect.succeed(Option.none()),
              focusedMainOrFirst: Effect.succeed(Option.none()),
              setMain: () => Effect.void,
              clearMain: () => Effect.void,
              prepareReveal: () => Effect.succeed(false),
              reveal: () => Effect.void,
              sendAll: () => Effect.void,
              destroyAll: Effect.void,
              syncAllAppearance: () => Effect.void,
            }),
          ),
        ),
      ),
    ),
);
