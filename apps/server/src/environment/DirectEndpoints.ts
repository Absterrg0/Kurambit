import type { ServerDirectEndpoint } from "@kurambit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class DirectEndpoints extends Context.Service<
  DirectEndpoints,
  {
    readonly resolve: () => Effect.Effect<ReadonlyArray<ServerDirectEndpoint>>;
  }
>()("kurambit/environment/DirectEndpoints") {}

export const layer = Layer.succeed(DirectEndpoints, { resolve: () => Effect.succeed([]) });
