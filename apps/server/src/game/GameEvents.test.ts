// @effect-diagnostics nodeBuiltinImport:off -- Run a real child process against a stub Godot executable.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ThreadId, type GameManifest, type GameOperationEvent } from "@t3tools/contracts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GameService from "./GameService.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameQualification from "./GameQualification.ts";
import { designApprovalTestLayer, previewBrowserTestLayer } from "./gameTestLayers.ts";

const threadId = ThreadId.make("game-events-test");
const manifest = (): GameManifest => ({
  schemaVersion: 1,
  name: "Events probe",
  brief: "",
  artDirection: "",
  engine: { name: "godot", version: "4.7.2" },
  godotProject: "godot",
  assets: [],
});

const withFixture = <A, E, R>(
  options: { readonly checkDelaySeconds?: number },
  run: (input: {
    readonly game: GameService.GameService["Service"];
    readonly root: string;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-events-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const root = NodePath.join(base, "game");
      const stateDir = NodePath.join(base, "state");
      const executable = NodePath.join(base, "godot");
      const delay = options.checkDelaySeconds ?? 0;
      const script = `#!/bin/sh
prev=
for arg do prev=$last; last=$arg; done
case "$*" in
  *check.gd*)
    sleep ${delay}
    printf '%s' '{"mainScene":"res://scenes/main.tscn","errors":[],"warnings":[]}' > "$prev"
    ;;
esac
exit 0
`;
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(root, "godot/scripts"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(root, "godot/project.godot"), "[application]\n");
        await NodeFSP.writeFile(NodePath.join(root, "godot/scripts/main.gd"), "extends Node\n");
        await NodeFSP.writeFile(executable, script, { mode: 0o755 });
      });
      const services = GameService.layer.pipe(
        Layer.provideMerge(GameProcesses.layer),
        Layer.provide(
          Layer.mock(GameProjectService.GameProjectService)({
            resolve: () => Effect.succeed(root),
            read: () => Effect.succeed(manifest()),
            inventory: () =>
              Effect.succeed({
                manifest: manifest(),
                design: null,
                designPath: null,
                briefPath: null,
                assets: [],
                scenes: [],
                builds: [],
                viewport: { width: 1152, height: 648 },
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(GameToolchain.GameToolchain)({
            executable: () =>
              Effect.succeed({ path: executable, version: "4.7.2", templates: null }),
            status: Effect.succeed({ toolsDirectory: base, installing: false, tools: [] }),
          }),
        ),
        Layer.provide(Layer.mock(GamePreview.GamePreview)({ url: () => null })),
        Layer.provide(previewBrowserTestLayer()),
        Layer.provideMerge(GameQualification.layer({ stateDir })),
        Layer.provideMerge(designApprovalTestLayer(stateDir)),
        Layer.provide(NodeServices.layer),
      );
      return yield* Effect.gen(function* () {
        const game = yield* GameService.GameService;
        return yield* run({ game, root });
      }).pipe(Effect.provide(services));
    }),
  );

const takeEvents = (queue: Queue.Dequeue<GameOperationEvent, Cause.Done>) => Queue.takeAll(queue);

it.live("publishes the start and the success of a game operation", () =>
  withFixture({}, ({ game, root }) =>
    Effect.gen(function* () {
      // Subscribe before the operation: a push stream does not replay.
      const queue = yield* game.events.pipe(Stream.toQueue({ capacity: 16 }));
      yield* Effect.yieldNow;
      const check = yield* game.check(threadId);
      expect(check.ok).toBe(true);
      // The service and the library share one record; the outer layer must not
      // have built a second GameOperations instance.
      const operations = yield* GameOperations.GameOperations;
      expect(operations.current(root)?.state).toBe("succeeded");
      const events = yield* takeEvents(queue);
      expect(events.map((event) => event.state)).toEqual(["running", "succeeded"]);
      expect(events.every((event) => event.name === "Godot check")).toBe(true);
      expect(events[0]?.message).toContain("Godot check");
    }),
  ),
);

it.live("publishes a failure when the operation errors", () =>
  withFixture({}, ({ game }) =>
    Effect.gen(function* () {
      const queue = yield* game.events.pipe(Stream.toQueue({ capacity: 16 }));
      // Let the queue's stream fiber subscribe before the operation publishes.
      yield* Effect.yieldNow;
      const error = yield* game.test(threadId, "../escape.gd").pipe(Effect.flip);
      expect(error.reason).toBe("invalid-path");
      const events = yield* takeEvents(queue);
      expect(events.map((event) => event.state)).toEqual(["running", "failed"]);
    }),
  ),
);

it.live("publishes a cancelled event when the creator stops a running operation", () =>
  withFixture({ checkDelaySeconds: 5 }, ({ game }) =>
    Effect.gen(function* () {
      const queue = yield* game.events.pipe(Stream.toQueue({ capacity: 16 }));
      yield* Effect.yieldNow;
      const running = yield* game.check(threadId).pipe(Effect.forkChild);
      const started = yield* Queue.take(queue);
      expect(started.state).toBe("running");
      yield* game.cancelThread(threadId);
      const finished = yield* Queue.take(queue);
      expect(finished.state).toBe("cancelled");
      // The cancelled work is awaited by cancelThread, so the fiber is done.
      yield* Fiber.join(running).pipe(Effect.ignore);
      const status = yield* game.status(threadId);
      expect(status.operation?.state).toBe("failed");
      expect(status.operation?.message).toContain("cancelled");
    }),
  ),
);
