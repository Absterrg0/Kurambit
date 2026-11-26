// Superseding drops every measure of the game that nobody will look at, running or queued:
// a person's and one somebody waits on (a keep going judge) always stay.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { GameBuildId } from "@kurambit/contracts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as GameBot from "./GameBot.ts";
import * as GameBuildCopies from "./GameBuildCopies.ts";
import * as GameEngine from "./GameEngine.ts";
import * as GameFacts from "./GameFacts.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameTemplates from "./GameTemplates.ts";

const ROOT = "/games/arena";
const build = (n: number): GameFacts.ResolvedBuild => ({
  root: ROOT,
  build: GameBuildId.make(String(n).repeat(40).slice(0, 40)),
  key: `three:tree-${n}`,
  engine: "three",
});

describe("GameFacts supersede", () => {
  it.effect("drops what nobody looks at, running or queued, and keeps what someone waits on", () =>
    Effect.gen(function* () {
      // The first measure takes the one permit and holds it: its copy never comes.
      const started = yield* Deferred.make<void>();
      const layer = GameFacts.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(GameBuildCopies.GameBuildCopies)({
              lease: () => Effect.andThen(Deferred.succeed(started, undefined), Effect.never),
              onStop: () => Effect.void,
              plays: () => [],
            }),
            Layer.mock(GameBot.GameBot)({}),
            Layer.mock(GameOperations.GameOperations)({
              current: () => null,
              events: Stream.empty,
              changed: () => Effect.void,
            }),
            Layer.mock(GameEngine.GameEngine)({}),
            Layer.mock(PreviewBrowser.PreviewBrowser)({}),
            Layer.mock(GameProcesses.GameProcesses)({ list: () => [] }),
            GameTemplates.layerAt(`${import.meta.dirname}/../../templates`),
            SqlitePersistence.layerMemory,
            NodeServices.layer,
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const facts = yield* GameFacts.GameFacts;
        const turn = { queue: "background", supersede: true } as const;
        const [running, queued, personAsked, judged, played, newest] = [1, 2, 3, 4, 5, 6].map(
          build,
        );
        yield* facts.measure(running!, turn);
        yield* Deferred.await(started);
        yield* facts.measure(queued!, { queue: "background" });
        // A person opened this build while it waited.
        yield* facts.measure(personAsked!, { queue: "person" });
        // A keep going judge waits on its step's build.
        yield* facts.measure(judged!, { queue: "background" });
        yield* Effect.forkChild(
          facts.measure(judged!, { queue: "background", waitFor: "1 hour", upTo: "boots" }),
          { startImmediately: true },
        );
        // Playing a build measures it in the background; nobody waits on that.
        yield* facts.measure(played!, { queue: "background" });
        yield* facts.measure(newest!, turn);

        const state = (b: GameFacts.ResolvedBuild) => Effect.map(facts.read(b), (f) => f.state);
        for (const gone of [running!, queued!, played!])
          assert.strictEqual(yield* state(gone), "never");
        for (const kept of [personAsked!, judged!, newest!])
          assert.include(["queued", "measuring"], yield* state(kept));
        // A dropped build owes nothing: a restart does not measure it after all.
        const owed = (yield* facts.owed).map((b) => b.key);
        for (const gone of [running!, queued!, played!]) assert.notInclude(owed, gone.key);
      }).pipe(Effect.provide(layer));
    }),
  );
});
