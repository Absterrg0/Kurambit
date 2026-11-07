// The one interface every art provider implements, and the HTTP helper they share. An adapter
// knows its provider's API and prices; the GameArt service owns records, spend, files and
// timing. A request the provider answers at once (images, audio) finishes in `start`; a job it
// runs (3D) answers `making` with its job ids, which the service stores and `poll`s.
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import { PNG } from "pngjs";
import {
  GAME_ART_PROVIDERS,
  type GameArtLane,
  type GameArtOptions,
  type GameArtProviderId,
} from "@kurambit/contracts";
import type {
  ProviderImageGenerationInput,
  ProviderImageGenerationResult,
} from "@kurambit/provider-core/server/driver";

export class ArtProviderError extends Data.TaggedError("ArtProviderError")<{
  readonly reason: string;
  /** What the failed work still cost, when the provider charged for it. */
  readonly costUsd?: number | null;
  /** Waiting may clear it (unreachable, rate limited, the provider's own fault): a poll tries again. */
  readonly transient?: boolean;
  /** The provider's HTTP status, when it answered at all. */
  readonly status?: number;
}> {}

export interface ArtReference {
  /** Game-relative, as asked. */
  readonly path: string;
  readonly absolute: string;
  readonly mime: "image/png" | "image/jpeg" | "image/webp";
  readonly bytes: Uint8Array;
}

export interface ArtRequest {
  readonly lane: GameArtLane;
  readonly prompt: string;
  readonly candidates: number;
  readonly options: GameArtOptions;
  readonly references: ReadonlyArray<ArtReference>;
}

/** A file the provider made: `asset` is what the game uses, `preview` only shows it. */
export interface ArtFile {
  readonly role: "asset" | "preview";
  /** Without the dot: png, glb, mp3. */
  readonly ext: string;
  readonly bytes: Uint8Array;
  /** Tells files of one role apart (a clip, a rig): becomes part of the file name. */
  readonly label?: string;
}

/** The provider's own job record, kept as JSON in the generation's row. */
export type ArtRemote = { readonly [key: string]: unknown };

/**
 * The paid stage a job is about to start, or null. `poll` never starts one: it answers a remote
 * with `pending` set, the service saves that before calling `advance`, and `advance` sends the
 * request once. Neither provider has an idempotency key and both say a create whose answer was
 * lost may have happened, so a saved intent with no task after it is never sent again.
 */
export const pendingStage = (remote: ArtRemote): string | null =>
  typeof remote.pending === "string" ? remote.pending : null;

/** How many answers in a row with no status we know before a job counts as failed. */
export const UNKNOWN_STATUS_LIMIT = 10;

export type ArtStep =
  | {
      readonly kind: "making";
      readonly remote: ArtRemote;
      readonly note?: string;
      /** Files to keep now (a provider that deletes them soon); they join the one candidate. */
      readonly files?: ReadonlyArray<ArtFile>;
    }
  | {
      readonly kind: "done";
      /** One entry per candidate, each its files. */
      readonly candidates: ReadonlyArray<ReadonlyArray<ArtFile>>;
      /** What the provider reported it cost; null when it did not say. */
      readonly costUsd: number | null;
    };

export interface ArtContext {
  /** The person's key for this provider; null for Codex. */
  readonly key: string | null;
  readonly http: ArtHttp;
  /** The person's Codex, when it is installed and signed in. */
  readonly codexImages:
    | ((
        input: ProviderImageGenerationInput,
      ) => Effect.Effect<ProviderImageGenerationResult, ArtProviderError>)
    | null;
  /** A private folder of the server's for this generation (Codex works there), outside the game. */
  readonly scratch: string;
  readonly readFile: (path: string) => Effect.Effect<Uint8Array, ArtProviderError>;
}

export interface ArtAdapter {
  readonly id: GameArtProviderId;
  /** USD this request should cost, from the provider's price table; null when it is free (plan usage). */
  readonly estimate: (
    request: Omit<ArtRequest, "references"> & {
      readonly references: number;
      /** An edit's image size, when it reads as a PNG: an edit keeps it, and pays for it. */
      readonly edited?: { readonly width: number; readonly height: number };
    },
  ) => number | null;
  /** Why this provider cannot make this request (a lane or option it lacks); null when it can. */
  readonly refuse?: (request: Omit<ArtRequest, "references">) => string | null;
  readonly start: (
    context: ArtContext,
    request: ArtRequest,
  ) => Effect.Effect<ArtStep, ArtProviderError>;
  /**
   * For jobs: asks after one and downloads what finished; safe to repeat. When a paid stage
   * should follow (a rig after a mesh), it answers `making` with the stage in `pending`.
   */
  readonly poll?: (
    context: ArtContext,
    remote: ArtRemote,
  ) => Effect.Effect<ArtStep, ArtProviderError>;
  /** Starts the remote's `pending` stage: one request, sent once, answering the new job. */
  readonly advance?: (
    context: ArtContext,
    remote: ArtRemote,
  ) => Effect.Effect<ArtStep, ArtProviderError>;
  readonly pollEvery: Duration.Duration;
  readonly cancel?: (context: ArtContext, remote: ArtRemote) => Effect.Effect<void>;
  /** The licence line recorded with every file it makes. */
  readonly licence: string;
  /** A lane whose terms differ from the provider's usual ones (ElevenLabs music). */
  readonly laneLicence?: Partial<Record<GameArtLane, string>>;
  /** A free request that says whether a key works; absent when the provider has none we trust. */
  /**
   * A free check of the person's key. It may answer what the key can do now: `ready: false`
   * when it works but cannot pay (an empty balance), with the note shown in Settings.
   */
  readonly checkKey?: (
    context: ArtContext,
  ) => Effect.Effect<void | { readonly ready: boolean; readonly note: string }, ArtProviderError>;
}

const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

const messageOf = (body: unknown): string | null => {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  for (const key of ["message", "detail", "error", "task_error"]) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
    const nested = messageOf(value);
    if (nested !== null) return nested;
  }
  return null;
};

export interface ArtHttpRequest {
  readonly method: "GET" | "POST" | "DELETE";
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly json?: unknown;
  readonly form?: FormData;
}

export interface ArtHttp {
  /** A call to the provider's own API (its key goes only to its own hosts), answering JSON. */
  readonly json: (
    provider: GameArtProviderId,
    request: ArtHttpRequest,
  ) => Effect.Effect<unknown, ArtProviderError>;
  /** The same, answering the body's bytes (audio). */
  readonly bytes: (
    provider: GameArtProviderId,
    request: ArtHttpRequest,
  ) => Effect.Effect<Uint8Array, ArtProviderError>;
  /** A result file at the URL the provider handed back: https, no credentials sent. */
  readonly download: (url: string) => Effect.Effect<Uint8Array, ArtProviderError>;
}

/** Whether `url` is https on one of the provider's own hosts: the only place its key may go. */
export const isProviderUrl = (provider: GameArtProviderId, url: string): boolean => {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      GAME_ART_PROVIDERS[provider].hosts.includes(parsed.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
};

export const makeArtHttp = (client: HttpClient.HttpClient): ArtHttp => {
  const send = (provider: GameArtProviderId, request: ArtHttpRequest) =>
    Effect.gen(function* () {
      const label = GAME_ART_PROVIDERS[provider].label;
      if (!isProviderUrl(provider, request.url))
        return yield* new ArtProviderError({
          reason: `${label}'s adapter asked for ${request.url}, which is not one of its hosts; nothing was sent.`,
        });
      let built = HttpClientRequest.make(request.method)(request.url);
      built = HttpClientRequest.setHeaders(built, request.headers ?? {});
      if (request.form !== undefined) built = HttpClientRequest.bodyFormData(built, request.form);
      else if (request.json !== undefined)
        built = HttpClientRequest.bodyJsonUnsafe(built, request.json);
      const response = yield* client
        .execute(built)
        .pipe(
          Effect.mapError(
            () =>
              new ArtProviderError({ reason: `${label} could not be reached.`, transient: true }),
          ),
        );
      if (response.status >= 400) {
        const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
        // A provider's own advice ("use the secret key, not the client id") is the fix the person needs.
        const message = messageOf(body);
        const suggestion =
          typeof body === "object" &&
          body !== null &&
          typeof (body as Record<string, unknown>).suggestion === "string"
            ? ((body as Record<string, unknown>).suggestion as string)
            : null;
        const said =
          message === null
            ? suggestion
            : suggestion === null
              ? message
              : `${message}. ${suggestion}`;
        return yield* new ArtProviderError({
          reason: `${label} refused (HTTP ${response.status})${said === null ? "." : `: ${said.slice(0, 400).replace(/[^.!?]$/, "$&.")}`}`,
          transient: response.status === 429 || response.status >= 500,
          status: response.status,
        });
      }
      return response;
    });
  const readBytes = (response: HttpClientResponse.HttpClientResponse, what: string) =>
    response.arrayBuffer.pipe(
      Effect.map((buffer) => new Uint8Array(buffer)),
      Effect.mapError(
        () => new ArtProviderError({ reason: `${what}: the answer could not be read.` }),
      ),
    );
  return {
    json: (provider, request) =>
      send(provider, request).pipe(
        Effect.flatMap((response) =>
          response.json.pipe(
            Effect.mapError(
              () =>
                new ArtProviderError({
                  reason: `${GAME_ART_PROVIDERS[provider].label} answered something that is not JSON.`,
                }),
            ),
          ),
        ),
      ),
    bytes: (provider, request) =>
      send(provider, request).pipe(
        Effect.flatMap((response) => readBytes(response, GAME_ART_PROVIDERS[provider].label)),
      ),
    download: (url) =>
      Effect.gen(function* () {
        const parsed = URL.canParse(url) ? new URL(url) : null;
        if (parsed === null)
          return yield* new ArtProviderError({
            reason: `The provider gave a file address that is not a URL.`,
          });
        if (parsed.protocol !== "https:")
          return yield* new ArtProviderError({
            reason: `The provider gave a file address that is not https.`,
          });
        const response = yield* client
          .execute(HttpClientRequest.get(url))
          .pipe(
            Effect.mapError(
              () => new ArtProviderError({ reason: `A result file could not be downloaded.` }),
            ),
          );
        if (response.status >= 400)
          return yield* new ArtProviderError({
            reason: `A result file could not be downloaded (HTTP ${response.status}).`,
          });
        const length = Number(response.headers["content-length"] ?? "0");
        if (length > MAX_DOWNLOAD_BYTES)
          return yield* new ArtProviderError({
            reason: `A result file is larger than 200 MB; refused.`,
          });
        const bytes = yield* readBytes(response, "A result file");
        if (bytes.byteLength > MAX_DOWNLOAD_BYTES)
          return yield* new ArtProviderError({
            reason: `A result file is larger than 200 MB; refused.`,
          });
        return bytes;
      }),
  };
};

/** The key an adapter needs, or the refusal naming where to add it. */
export const requireKey = (
  provider: GameArtProviderId,
  context: ArtContext,
): Effect.Effect<string, ArtProviderError> =>
  context.key === null || context.key === ""
    ? Effect.fail(
        new ArtProviderError({
          reason: `No ${GAME_ART_PROVIDERS[provider].label} key: add one in Settings → Art providers.`,
        }),
      )
    : Effect.succeed(context.key);

export const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
export const fromBase64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64"));
export const dataUri = (reference: ArtReference): string =>
  `data:${reference.mime};base64,${base64(reference.bytes)}`;

/** A field read from a provider's JSON, whatever its nesting. */
export const field = (value: unknown, ...path: ReadonlyArray<string | number>): unknown => {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
};
export const stringField = (value: unknown, ...path: ReadonlyArray<string | number>) => {
  const found = field(value, ...path);
  return typeof found === "string" && found !== "" ? found : null;
};
export const numberField = (value: unknown, ...path: ReadonlyArray<string | number>) => {
  const found = field(value, ...path);
  return typeof found === "number" && Number.isFinite(found) ? found : null;
};

export const roundUsd = (usd: number): number => Math.round(usd * 10_000) / 10_000;

/**
 * A PNG's size and the share of its pixels that are fully clear (0..1); null when the bytes are
 * not a PNG that decodes. An edit keeps its original's size, and a cut-out is only one when some
 * of it is truly transparent: a provider that answers opaque is never passed off as a cut-out.
 */
export const readPng = (
  bytes: Uint8Array,
): { readonly width: number; readonly height: number; readonly clear: number } | null => {
  try {
    const png = PNG.sync.read(Buffer.from(bytes));
    let clear = 0;
    for (let index = 3; index < png.data.length; index += 4) if (png.data[index] === 0) clear += 1;
    return { width: png.width, height: png.height, clear: clear / (png.width * png.height) };
  } catch {
    return null;
  }
};
