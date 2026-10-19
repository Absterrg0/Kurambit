import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Analytics from "./AnalyticsService.ts";

it.effect("never sends or reads identity even when inherited analytics is enabled", () => {
  let requests = 0;
  let reads = 0;
  return Effect.gen(function* () {
    const analytics = yield* Analytics.AnalyticsService;
    yield* analytics.record("turn.completed", { provider: "codex" });
    yield* analytics.flush;
    assert.equal(requests, 0);
    assert.equal(reads, 0);
  }).pipe(
    Effect.provide(Analytics.layer),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => {
        requests++;
        return Effect.die("Analytics must not send HTTP requests");
      }),
    ),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        readFileString: () => {
          reads++;
          return Effect.die("Analytics must not read provider identity");
        },
      }),
    ),
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            T3CODE_TELEMETRY_ENABLED: "true",
            T3CODE_POSTHOG_HOST: "https://us.i.posthog.com",
            T3CODE_POSTHOG_KEY: "inherited-key",
          },
        }),
      ),
    ),
  );
});
