// A blind sample's input cap must be on disk before the run trusts it: a
// restart reloads the record, and a cap kept only in memory would let the
// sample play past its fair budget.
// @effect-diagnostics nodeBuiltinImport:off -- The evidence dir is broken and read back on disk, as a full disk or a restart would.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@kurambit/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../config.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ExploreEvidence from "./exploreEvidence.ts";
import * as GameEngine from "./GameEngine.ts";
import * as GameExplore from "./GameExplore.ts";
import * as GameMemoryGate from "./GameMemoryGate.ts";
import * as GamePlayer from "./GamePlayer.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import { ProcessHost } from "./processHost.ts";

const layerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "game-explore-cap-",
}).pipe(Layer.provide(NodeServices.layer));

const layer = GameExplore.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
      Layer.succeed(ProcessHost, { joinJob: () => undefined, displays: new Set<number>() }),
      Layer.mock(GameProjectService.GameProjectService)({ resolve: () => Effect.succeed("/g") }),
      Layer.mock(GameProcesses.GameProcesses)({ list: () => [] }),
      Layer.mock(PreviewBrowser.PreviewBrowser)({}),
      Layer.mock(GameEngine.GameEngine)({}),
      Layer.mock(GameMemoryGate.GameMemoryGate)({}),
      Layer.mock(GamePlayer.GamePlayer)({}),
      layerConfig,
      NodeServices.layer,
    ),
  ),
  Layer.provideMerge(layerConfig),
);

it.effect("a cap whose write failed is written by the retry, never taken from memory", () =>
  Effect.gen(function* () {
    const explore = yield* GameExplore.GameExplore;
    const dir = NodePath.join((yield* ServerConfig.ServerConfig).stateDir, "explore-evidence");
    const thread = ThreadId.make("thread:sample");
    // A file where the dir should be: every write of a record fails.
    NodeFS.rmSync(dir, { recursive: true, force: true });
    NodeFS.writeFileSync(dir, "");
    const first = yield* Effect.result(explore.limitInput(thread, 60_000));
    assert.equal(first._tag, "Failure");
    const retry = yield* Effect.result(explore.limitInput(thread, 60_000));
    assert.equal(retry._tag, "Failure");
    // The disk is back: the next retry puts the cap where a restart reads it.
    NodeFS.rmSync(dir, { force: true });
    yield* explore.limitInput(thread, 60_000);
    const onDisk = yield* Effect.promise(() => ExploreEvidence.read(dir, thread));
    assert.equal(onDisk?.inputCapMs, 60_000);
  }).pipe(Effect.provide(layer)),
);
