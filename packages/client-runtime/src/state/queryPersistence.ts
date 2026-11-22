import type { EnvironmentId } from "@kurambit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export class EnvironmentQueryStore extends Context.Reference<{
  readonly load: (
    environmentId: EnvironmentId,
    key: string,
  ) => Effect.Effect<Option.Option<string>>;
  readonly save: (
    environmentId: EnvironmentId,
    key: string,
    payload: string,
  ) => Effect.Effect<void>;
} | null>("@kurambit/client-runtime/EnvironmentQueryStore", {
  defaultValue: () => null,
}) {}

export interface QueryPersistence<A> {
  readonly load: (environmentId: EnvironmentId, key: string) => Effect.Effect<Option.Option<A>>;
  readonly save: (environmentId: EnvironmentId, key: string, value: A) => Effect.Effect<void>;
}
