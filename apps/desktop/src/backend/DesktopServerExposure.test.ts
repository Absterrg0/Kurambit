import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
it.effect("binds the backend to loopback only", () =>
  Effect.gen(function* () {
    const exposure = yield* DesktopServerExposure.DesktopServerExposure;
    yield* exposure.configureFromSettings({ port: 4888 });
    const config = yield* exposure.backendConfig;
    assert.equal(config.bindHost, "127.0.0.1");
    assert.equal(config.httpBaseUrl.href, "http://127.0.0.1:4888/");
  }).pipe(Effect.provide(DesktopServerExposure.layer)),
);
