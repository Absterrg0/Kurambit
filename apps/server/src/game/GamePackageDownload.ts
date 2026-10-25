// @effect-diagnostics nodeBuiltinImport:off -- The signed URL is the native HTTP download boundary for the packaged release.
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ThreadId } from "@t3tools/contracts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export const GAME_PACKAGE_ROUTE_PREFIX = "/api/game/windows-package";
const SECRET_NAME = "game-package-download-signing-key";
const DEFAULT_TTL_MS = 15 * 60 * 1000;

const Claims = Schema.Struct({
  version: Schema.Literal(1),
  threadId: ThreadId,
  expiresAt: Schema.Number,
});
type Claims = typeof Claims.Type;
const ClaimsJson = Schema.fromJsonString(Claims);
const decodeClaims = Schema.decodeUnknownOption(ClaimsJson);
const encodeClaims = Schema.encodeSync(ClaimsJson);

/** A capability URL minted after the authenticated package RPC. It names no path. */
export interface GamePackageDownload {
  readonly path: string;
  readonly expiresAt: number;
}

export const issueGamePackageDownload = Effect.fn("game.packageDownload.issue")(function* (
  threadId: ThreadId,
  ttlMs = DEFAULT_TTL_MS,
) {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const secret = yield* store.getOrCreateRandom(SECRET_NAME, 32);
  const expiresAt = (yield* Clock.currentTimeMillis) + ttlMs;
  const payload = base64UrlEncode(encodeClaims({ version: 1, threadId, expiresAt }));
  const token = `${payload}.${signPayload(payload, secret)}`;
  return {
    path: `${GAME_PACKAGE_ROUTE_PREFIX}/${token}`,
    expiresAt,
  } satisfies GamePackageDownload;
});

/** Returns the thread a download token was minted for, or null for any bad token. */
export const verifyGamePackageDownload = Effect.fn("game.packageDownload.verify")(function* (
  token: string,
) {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const secret = yield* store.get(SECRET_NAME).pipe(Effect.orElseSucceed(() => Option.none()));
  if (Option.isNone(secret)) return null;
  if (!timingSafeEqualBase64Url(signature, signPayload(payload, secret.value))) return null;
  const decoded = yield* Effect.result(
    Effect.try({
      try: () => base64UrlDecodeUtf8(payload),
      catch: () => null,
    }),
  );
  if (decoded._tag === "Failure") return null;
  const claims: Claims | null = Option.getOrNull(decodeClaims(decoded.success));
  if (claims === null || claims.expiresAt <= (yield* Clock.currentTimeMillis)) return null;
  return claims;
});
