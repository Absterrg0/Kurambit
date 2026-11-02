import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@kurambit/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as DesktopPreReadyFileSystem from "./DesktopPreReadyFileSystem.ts";
import * as DesktopUserData from "./DesktopUserData.ts";

const resolveWindowsUserData = (appDataDirectory: string) =>
  DesktopUserData.resolveUserDataPath({
    appDataDirectory,
    isDevelopment: false,
    platform: "win32",
  }).pipe(Effect.provide(DesktopPreReadyFileSystem.layer));

it.layer(NodeServices.layer)("DesktopPreReadyFileSystem", (it) => {
  it.effect("does not read or copy the legacy Windows profile state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kurambit-pre-ready-fs-" });
      yield* fileSystem.makeDirectory(path.join(root, "Kurambit (Alpha)"));
      yield* fileSystem.writeFileString(path.join(root, "Kurambit (Alpha)", "Local State"), "keys");

      const userData = yield* resolveWindowsUserData(root);

      assert.equal(userData, path.join(root, "kurambit"));
      assert.isFalse(yield* fileSystem.exists(path.join(userData, "Local State")));
    }),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32" || process.getuid?.() === 0)(
    "does not inspect an unreadable Kurambit profile",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "kurambit-pre-ready-fs-",
        });
        yield* fileSystem.chmod(root, 0o000);
        yield* Effect.addFinalizer(() => fileSystem.chmod(root, 0o700).pipe(Effect.orDie));

        const exit = yield* Effect.exit(resolveWindowsUserData(root));

        assert.isTrue(Exit.isSuccess(exit));
      }),
  );
});
