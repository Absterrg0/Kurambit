import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";



import * as IpcChannels from "../channels.ts";
import { makeSyncIpcMethod } from "../DesktopIpc.ts";

export const getLocalEnvironmentEnabled = makeSyncIpcMethod({
  channel: IpcChannels.GET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.localEnvironment.getEnabled")(function* () {
    return true;
  }),
});

