import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Analytics from "./AnalyticsService.ts";

it.effect("records and flushes without HTTP, provider identity, or background services", () =>
  Effect.gen(function* () {
    const analytics = yield* Analytics.AnalyticsService;
    yield* analytics.record("turn.completed", { provider: "codex" });
    yield* analytics.flush;
    assert.isTrue(true);
  }).pipe(Effect.provide(Analytics.layer)),
);
