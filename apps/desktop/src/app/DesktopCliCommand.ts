import type { DesktopCliCommandState } from "@kurambit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class DesktopCliCommandError extends Schema.TaggedError<DesktopCliCommandError>()(
  "DesktopCliCommandError",
  { message: Schema.String },
) {}

export class DesktopCliCommand extends Context.Service<
  DesktopCliCommand,
  {
    readonly state: Effect.Effect<DesktopCliCommandState>;
    readonly install: Effect.Effect<DesktopCliCommandState, DesktopCliCommandError>;
    readonly uninstall: Effect.Effect<DesktopCliCommandState, DesktopCliCommandError>;
  }
>()("@kurambit/desktop/app/DesktopCliCommand") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.succeed(
  DesktopCliCommand.of({
    state: Effect.succeed({ supported: false, installedPath: null, onPath: false }),
    install: Effect.fail(
      new DesktopCliCommandError({
        message: "Global CLI installation is unavailable in Kurambit.",
      }),
    ),
    uninstall: Effect.succeed({ supported: false, installedPath: null, onPath: false }),
  }),
);

export const layer = Layer.effect(DesktopCliCommand, make);
