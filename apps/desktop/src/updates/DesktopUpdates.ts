import type {
  DesktopUpdateState,
  DesktopUpdateChannel,
  DesktopUpdateCheckResult,
  DesktopUpdateActionResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import { createInitialDesktopUpdateState } from "./updateMachine.ts";

type DesktopUpdateConfigureError = never;
type DesktopUpdateSetChannelError = never;
interface DesktopPreparedUpdateInstallResult extends DesktopUpdateActionResult {
  readonly failed: boolean;
}

export class DesktopUpdates extends Context.Service<
  DesktopUpdates,
  {
    readonly getState: Effect.Effect<DesktopUpdateState>;
    readonly isActionActive: Effect.Effect<boolean>;
    readonly isInstallActive: Effect.Effect<boolean>;
    readonly subscribe: Effect.Effect<
      {
        readonly latest: DesktopUpdateState;
        readonly changes: Stream.Stream<DesktopUpdateState>;
      },
      never,
      Scope.Scope
    >;
    readonly emitState: Effect.Effect<void>;
    readonly disabledReason: Effect.Effect<Option.Option<string>>;
    readonly configure: Effect.Effect<void, DesktopUpdateConfigureError, Scope.Scope>;
    readonly setChannel: (
      channel: DesktopUpdateChannel,
    ) => Effect.Effect<DesktopUpdateState, DesktopUpdateSetChannelError>;
    readonly check: (reason: string) => Effect.Effect<DesktopUpdateCheckResult>;
    readonly download: Effect.Effect<DesktopUpdateActionResult>;
    readonly install: Effect.Effect<DesktopUpdateActionResult>;
    readonly installPrepared: (
      expectedVersion: string,
    ) => Effect.Effect<DesktopPreparedUpdateInstallResult>;
  }
>()("@t3tools/desktop/updates/DesktopUpdates") {}

export const UPDATES_DISABLED_REASON = "Automatic updates are unavailable in Game Studio.";

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const window = yield* ElectronWindow.ElectronWindow;
  const state = {
    ...createInitialDesktopUpdateState(
      environment.appVersion,
      environment.runtimeInfo,
      environment.defaultDesktopSettings.updateChannel,
    ),
    message: UPDATES_DISABLED_REASON,
  };
  const emitState = window.sendAll(IpcChannels.UPDATE_STATE_CHANNEL, state);
  const action = Effect.succeed({ accepted: false, completed: false, state });
  return DesktopUpdates.of({
    getState: Effect.succeed(state),
    isActionActive: Effect.succeed(false),
    isInstallActive: Effect.succeed(false),
    subscribe: Effect.succeed({ latest: state, changes: Stream.empty }),
    emitState,
    disabledReason: Effect.succeed(Option.some(UPDATES_DISABLED_REASON)),
    configure: emitState,
    setChannel: () => Effect.succeed(state),
    check: () => Effect.succeed({ checked: false, state }),
    download: action,
    install: action,
    installPrepared: () =>
      Effect.succeed({ accepted: false, completed: false, failed: true, state }),
  });
});

export const layer = Layer.effect(DesktopUpdates, make);
