import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Update from "./DesktopAppUpdate.ts";
it.effect("rejects desktop updates without contacting a desktop or network service", () =>
  Effect.gen(function* () {
    const update = yield* Update.make();
    assert.isFalse(update.available);
    assert.include((yield* update.run(() => Effect.void).pipe(Effect.flip)).reason, "unavailable");
    assert.include((yield* update.commit("saved-update").pipe(Effect.flip)).reason, "unavailable");
  }),
);
