import * as Context from "effect/Context";
import type * as Option from "effect/Option";
import type * as Stream from "effect/Stream";

import type { PrimaryConnectionTarget } from "../connection/model.ts";

export class PlatformConnectionSource extends Context.Service<
  PlatformConnectionSource,
  {
    // Each emission is the current local server, or none when this client has
    // no local server to connect to.
    readonly primary: Stream.Stream<Option.Option<PrimaryConnectionTarget>>;
  }
>()("@kurambit/client-runtime/platform/source/PlatformConnectionSource") {}
