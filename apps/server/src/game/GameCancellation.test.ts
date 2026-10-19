// @effect-diagnostics nodeBuiltinImport:off -- Prove cancellation against a real child and an event-based readiness handshake.
import { it, expect } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { ThreadId } from "@t3tools/contracts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameService from "./GameService.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GamePreview from "./GamePreview.ts";

it.live.each(["interrupt", "stop"] as const)(
  "awaits child exit and clears tracked PIDs on %s",
  (cancellation) =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-cancel-"))),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        const readyPath = NodePath.join(root, "ready");
        const executable = NodePath.join(root, "long-tool");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            executable,
            `#!/bin/sh\nexec '${process.execPath}' -e 'require("node:fs").writeFileSync(${JSON.stringify(readyPath)}, String(process.pid)); setInterval(() => {}, 1000)'\n`,
            { mode: 0o755 },
          ),
        );
        const watcher = yield* Effect.acquireRelease(
          Effect.sync(() => NodeFS.watch(root)),
          (watch) => Effect.sync(() => watch.close()),
        );
        const ready = new Promise<void>((resolve) =>
          watcher.on("change", (_event, filename) => {
            if (filename === "ready") resolve();
          }),
        );
        const dependencies = GameService.layer.pipe(
          Layer.provideMerge(GameProcesses.layer),
          Layer.provide(
            Layer.mock(GameProjectService.GameProjectService)({
              resolve: () => Effect.succeed(root),
              read: () =>
                Effect.succeed({
                  schemaVersion: 1,
                  name: "Cancellation",
                  brief: "",
                  artDirection: "",
                  engine: { name: "godot", version: "4.7.2" },
                  godotProject: "godot",
                  assets: [],
                }),
            }),
          ),
          Layer.provide(
            Layer.mock(GameToolchain.GameToolchain)({
              executable: () =>
                Effect.succeed({ path: executable, version: "4.7.2", templates: null }),
            }),
          ),
          Layer.provide(
            Layer.mock(GamePreview.GamePreview)({ stop: () => Effect.void, url: () => null }),
          ),
        );
        yield* Effect.gen(function* () {
          const game = yield* GameService.GameService;
          const processes = yield* GameProcesses.GameProcesses;
          const threadId = ThreadId.make("cancel-test");
          const fiber = yield* game.test(threadId, "tests/long.gd").pipe(Effect.forkChild);
          yield* Effect.promise(() => ready);
          const pid = Number(yield* Effect.promise(() => NodeFSP.readFile(readyPath, "utf8")));
          expect(processes.list(root).map((entry) => entry.pid)).toEqual([pid]);
          if (cancellation === "interrupt") yield* Fiber.interrupt(fiber);
          else {
            yield* game.action(threadId, "stop");
            yield* Fiber.await(fiber);
          }
          expect(() => process.kill(pid, 0)).toThrow();
          expect(processes.list(root)).toEqual([]);
        }).pipe(Effect.provide(dependencies));
      }),
    ),
  10_000,
);
