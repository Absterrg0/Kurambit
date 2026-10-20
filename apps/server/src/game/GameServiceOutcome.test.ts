// @effect-diagnostics nodeBuiltinImport:off -- Run a real child process against a stub Godot executable.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ThreadId, type GameManifest } from "@t3tools/contracts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GameService from "./GameService.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameQualification from "./GameQualification.ts";
import { previewBrowserTestLayer } from "./gameTestLayers.ts";

const threadId = ThreadId.make("outcome-test");
const manifest = (): GameManifest => ({
  schemaVersion: 1,
  name: "Outcome probe",
  brief: "",
  artDirection: "",
  engine: { name: "godot", version: "4.7.2" },
  godotProject: "godot",
  assets: [],
});
// A stand-in Godot: the check script reports a parse error, the inspect script
// reports a valid scene. Nothing here depends on a real engine install.
const fakeGodot = `#!/bin/sh
for last do :; done
case "$*" in
  *check.gd*)
    printf '%s' '{"errors":[{"file":"res://scripts/main.gd","message":"Parse Error: unexpected token"}],"warnings":[]}' > "$last"
    ;;
  *inspect.gd*)
    printf '%s' '{"scenePath":"res://scenes/main.tscn","nodes":[],"nodeCount":0,"truncated":false}' > "$last"
    ;;
esac
exit 0
`;

const withFixture = <A, E, R>(
  run: (input: { readonly root: string; readonly stateDir: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-outcome-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const root = NodePath.join(base, "game");
      const stateDir = NodePath.join(base, "state");
      const executable = NodePath.join(base, "godot");
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(root, "godot/scripts"), { recursive: true }),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "godot/project.godot"), "[application]\n"),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "godot/scripts/main.gd"), "extends Node\n"),
      );
      yield* Effect.promise(() => NodeFSP.writeFile(executable, fakeGodot, { mode: 0o755 }));
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
        Layer.provide(GameQualification.layer({ stateDir })),
        Layer.provide(NodeServices.layer),
      );
      return yield* run({ root, stateDir }).pipe(Effect.provide(services));
    }),
  );

it.live("a failing check sets both the operation and its qualification stage to failed", () =>
  withFixture(({ root }) =>
    Effect.gen(function* () {
      const game = yield* GameService.GameService;
      const check = yield* game.check(threadId);
      expect(check.ok).toBe(false);
      const status = yield* game.status(threadId);
      expect(status.operation?.state).toBe("failed");
      expect(status.qualification.state).toBe("unqualified");
      expect(status.qualification.stages.find((stage) => stage.stage === "check")?.status).toBe(
        "failed",
      );
      // Server-owned state, not anything written into the game folder.
      expect(NodeFS.existsSync(NodePath.join(root, "game-qualification"))).toBe(false);
    }),
  ),
);

it.live("a passing scene inspect still succeeds and does not qualify the game", () =>
  withFixture(() =>
    Effect.gen(function* () {
      const game = yield* GameService.GameService;
      const inspected = yield* game.inspectScene(threadId, "res://scenes/main.tscn");
      expect(inspected.nodeCount).toBe(0);
      const status = yield* game.status(threadId);
      expect(status.operation?.state).toBe("succeeded");
      expect(status.qualification.state).toBe("unqualified");
    }),
  ),
);
