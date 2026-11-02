import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;

    readonly flush: Effect.Effect<void>;
  }
>()("kurambit/telemetry/AnalyticsService") {
  static readonly layerTest = Layer.succeed(
    AnalyticsService,
    AnalyticsService.of({
      record: () => Effect.void,
      flush: Effect.void,
    }),
  );
}

// Kurambit has no product analytics sender, identity lookup, or background flush.
export const make = Effect.succeed(
  AnalyticsService.of({ record: () => Effect.void, flush: Effect.void }),
);
export const layer = Layer.effect(AnalyticsService, make);
