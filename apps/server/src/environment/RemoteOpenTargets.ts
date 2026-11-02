import type { RemoteOpenTarget } from "@kurambit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class RemoteOpenTargets extends Context.Service<
  RemoteOpenTargets,
  {
    readonly resolveTargets: () => Effect.Effect<ReadonlyArray<RemoteOpenTarget>>;
  }
>()("kurambit/environment/RemoteOpenTargets") {}

export const layer = Layer.succeed(RemoteOpenTargets, { resolveTargets: () => Effect.succeed([]) });
