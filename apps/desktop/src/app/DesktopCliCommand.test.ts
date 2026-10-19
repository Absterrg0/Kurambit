import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Cli from "./DesktopCliCommand.ts";
it.effect("never installs or removes a global t3 command", () =>
  Effect.gen(function* () {
    const cli = yield* Cli.make;
    assert.isFalse((yield* cli.state).supported);
    assert.include((yield* cli.install.pipe(Effect.flip)).message, "unavailable");
    assert.isNull((yield* cli.uninstall).installedPath);
  }),
);
