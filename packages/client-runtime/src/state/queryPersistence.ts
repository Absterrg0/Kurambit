import type { EnvironmentId } from "@kurambit/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export interface QueryPersistence<A> {
  readonly load: (environmentId: EnvironmentId, key: string) => Effect.Effect<Option.Option<A>>;
  readonly save: (environmentId: EnvironmentId, key: string, value: A) => Effect.Effect<void>;
}
