import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
it.effect("publishes only the loopback backend", () =>
  Effect.gen(function* () {
    const exposure = yield* DesktopServerExposure.DesktopServerExposure;
    const state = yield* exposure.configureFromSettings({ port: 4888 });
    assert.equal(state.mode, "local-only");
    const config = yield* exposure.backendConfig;
    assert.equal(config.bindHost, "127.0.0.1");
    assert.equal(config.httpBaseUrl.href, "http://127.0.0.1:4888/");
    const endpoints = yield* exposure.getAdvertisedEndpoints;
    assert.lengthOf(endpoints, 1);
    assert.equal(endpoints[0]?.reachability, "loopback");
  }).pipe(Effect.provide(DesktopServerExposure.layer)),
);
