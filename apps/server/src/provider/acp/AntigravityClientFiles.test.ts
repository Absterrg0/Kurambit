import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { writeAntigravityClientTextFile } from "./AntigravityClientFiles.ts";

it.effect("does not create folders or files through a workspace link", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspace = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "kurambit-antigravity-workspace-",
    });
    const outside = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "kurambit-antigravity-outside-",
    });
    yield* fileSystem.symlink(outside, path.join(workspace, "linked"));
    const write = (relative: string) =>
      writeAntigravityClientTextFile({
        fileSystem,
        path,
        allowedRoots: [workspace],
        request: { sessionId: "session", path: path.join(workspace, relative), content: "x" },
      }).pipe(Effect.exit);

    expect((yield* write("linked/new-folder/escaped.ts"))._tag).toBe("Failure");
    expect(yield* fileSystem.exists(path.join(outside, "new-folder"))).toBe(false);
    expect((yield* write("src/kept.ts"))._tag).toBe("Success");
    expect(yield* fileSystem.readFileString(path.join(workspace, "src", "kept.ts"))).toBe("x");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
