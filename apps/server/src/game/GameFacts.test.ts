// Superseding drops only what nobody but a newer turn wanted: a running
// measure, a person's and a run's always stay.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { GameBuildId } from "@kurambit/contracts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as GameBot from "./GameBot.ts";
import * as GameBuildCopies from "./GameBuildCopies.ts";
import * as GameFacts from "./GameFacts.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameService from "./GameService.ts";

const ROOT = "/games/arena";
const build = (n: number): GameFacts.ResolvedBuild => ({
  root: ROOT,
  build: GameBuildId.make(String(n).repeat(40).slice(0, 40)),
  key: `three:tree-${n}`,
  engine: "three",
});

describe("GameFacts supersede", () => {
  it.effect("drops only a queued turn measure that nobody else asked for", () =>
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
            Layer.mock(GameBot.GameBot)({ latestPlayBot: () => Effect.succeed(null) }),
            Layer.mock(GameOperations.GameOperations)({
              current: () => null,
              events: Stream.empty,
              changed: () => Effect.void,
            }),
            Layer.mock(GameService.GameService)({}),
            Layer.mock(GameProcesses.GameProcesses)({ list: () => [] }),
            SqlitePersistence.layerMemory,
            NodeServices.layer,
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const facts = yield* GameFacts.GameFacts;
        const turn = { queue: "background", supersede: true } as const;
        const [running, dropped, personAsked, played, round, newest] = [1, 2, 3, 4, 5, 6].map(
          build,
        );
        yield* facts.measure(running!, turn);
        yield* Deferred.await(started);
        yield* facts.measure(dropped!, turn);
        // A person opened this turn's build while it waited.
        yield* facts.measure(personAsked!, turn);
        yield* facts.measure(personAsked!, { queue: "person" });
        // Playing a build measures it in the background, without supersede.
        yield* facts.measure(played!, turn);
        yield* facts.measure(played!, { queue: "background" });
        yield* facts.measure(round!, { queue: "background" });
        yield* facts.measure(newest!, turn);

        const state = (b: GameFacts.ResolvedBuild) => Effect.map(facts.read(b), (f) => f.state);
        assert.strictEqual(yield* state(running!), "measuring");
        assert.strictEqual(yield* state(dropped!), "never");
        assert.strictEqual(yield* state(personAsked!), "queued");
        assert.strictEqual(yield* state(played!), "queued");
        assert.strictEqual(yield* state(round!), "queued");
        assert.strictEqual(yield* state(newest!), "queued");
        // The dropped build owes nothing: a restart does not measure it after all.
        const owed = (yield* facts.owed).map((b) => b.key);
        assert.notInclude(owed, dropped!.key);
      }).pipe(Effect.provide(layer));
    }),
  );
});
