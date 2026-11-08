import * as Effect from "effect/Effect";
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "@kurambit/contracts";
import { FetchHttpClient, type HttpMethod } from "effect/http";
import type { PreparedConnection } from "../connection/model.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiGroupClient,
  makeEnvironmentHttpApiUrlBuilder,
} from "../rpc/http.ts";

export interface EnvironmentHttpAuthHeaders {
  readonly authorization?: string;
}

export function withOrchestrationProtocolHeader(
  headers: EnvironmentHttpAuthHeaders,
): EnvironmentHttpAuthHeaders & {
  readonly [ORCHESTRATION_PROTOCOL_HEADER]: typeof ORCHESTRATION_PROTOCOL_VERSION_TEXT;
} {
  return {
    ...headers,
    [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  };
}

export const executeAuthenticatedEnvironmentHttpRequest = Effect.fnUntraced(function* <
  Group extends Parameters<typeof makeEnvironmentHttpApiGroupClient>[1],
  A,
  E,
  R,
>(input: {
  readonly prepared: PreparedConnection;
  readonly method: HttpMethod.HttpMethod;
  readonly url: (urls: ReturnType<typeof makeEnvironmentHttpApiUrlBuilder>[Group]) => string;
  readonly timeoutMs: number;
  readonly group: Group;
  readonly request: (input: {
    readonly client: Effect.Success<ReturnType<typeof makeEnvironmentHttpApiGroupClient<Group>>>;
    readonly headers: EnvironmentHttpAuthHeaders;
  }) => Effect.Effect<A, E, R>;
  readonly isUnauthorizedResponse?: (response: NoInfer<A>) => boolean;
}) {
  const authorization = input.prepared.httpAuthorization;
  const httpBaseUrl = input.prepared.httpBaseUrl;
  const url = input.url(makeEnvironmentHttpApiUrlBuilder(httpBaseUrl)[input.group]);
  const client = yield* makeEnvironmentHttpApiGroupClient(httpBaseUrl, input.group);
  const headers: EnvironmentHttpAuthHeaders =
    authorization === null ? {} : { authorization: `Bearer ${authorization.token}` };
  const request = input.request({ client, headers });
  return yield* executeEnvironmentHttpRequest(
    url,
    input.timeoutMs,
    authorization === null
      ? request.pipe(Effect.provideService(FetchHttpClient.RequestInit, { credentials: "include" }))
      : request,
  );
});
