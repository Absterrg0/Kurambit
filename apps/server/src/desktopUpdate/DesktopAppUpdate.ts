import {
  ServerSelfUpdateError,
  type ServerSelfUpdateProgressStage,
  type ServerSelfUpdateResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class DesktopAppUpdate extends Context.Service<
  DesktopAppUpdate,
  {
    readonly available: boolean;
    readonly run: (
      reportProgress: (
        stage: ServerSelfUpdateProgressStage,
      ) => Effect.Effect<void, ServerSelfUpdateError>,
    ) => Effect.Effect<ServerSelfUpdateResult, ServerSelfUpdateError>;
    /** Success stops this server, so this effect
        returns only when installation fails or times out. */
    readonly commit: (
      requestId: string,
      onHandoffAccepted?: () => Effect.Effect<void>,
    ) => Effect.Effect<never, ServerSelfUpdateError>;
  }
>()("t3/desktopUpdate/DesktopAppUpdate") {}

export const make = () =>
  Effect.succeed(
    DesktopAppUpdate.of({
      available: false,
      run: () =>
        Effect.fail(
          new ServerSelfUpdateError({ reason: "Desktop updates are unavailable in Game Studio." }),
        ),
      commit: () =>
        Effect.fail(
          new ServerSelfUpdateError({ reason: "Desktop updates are unavailable in Game Studio." }),
        ),
    }),
  );
export const layer = Layer.effect(DesktopAppUpdate, make());
