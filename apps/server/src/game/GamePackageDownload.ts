// @effect-diagnostics nodeBuiltinImport:off -- The signed URL is the native HTTP download boundary for packaged releases.
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
export const GAME_WEB_PACKAGE_ROUTE_PREFIX = "/api/game/web-package";
const SECRET_NAME = "game-package-download-signing-key";
const DEFAULT_TTL_MS = 15 * 60 * 1000;

export type GamePackageKind = "windows" | "web";

export const gamePackageRoutePrefix = (kind: GamePackageKind) =>
  kind === "windows" ? GAME_PACKAGE_ROUTE_PREFIX : GAME_WEB_PACKAGE_ROUTE_PREFIX;

/** The path prefix carries a signed capability, so it must not reach a trace. */
export const isGamePackageRoutePath = (pathname: string) =>
  [GAME_PACKAGE_ROUTE_PREFIX, GAME_WEB_PACKAGE_ROUTE_PREFIX].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

const Claims = Schema.Struct({
  version: Schema.Literal(2),
  kind: Schema.Literals(["windows", "web"]),
  threadId: ThreadId,
  /** A web package is bound to the selected build it was made from. */
  buildId: Schema.optionalKey(Schema.String),
  packageSha256: Schema.String,
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

const issue = Effect.fn("game.packageDownload.issue")(function* (
  claims: Omit<Claims, "version" | "expiresAt">,
  ttlMs: number,
) {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const secret = yield* store.getOrCreateRandom(SECRET_NAME, 32);
  const expiresAt = (yield* Clock.currentTimeMillis) + ttlMs;
  const payload = base64UrlEncode(encodeClaims({ version: 2, ...claims, expiresAt }));
  const token = `${payload}.${signPayload(payload, secret)}`;
  return {
    path: `${gamePackageRoutePrefix(claims.kind)}/${token}`,
    expiresAt,
  } satisfies GamePackageDownload;
});

/** The Windows package capability: thread plus the exact archive hash. */
export const issueGamePackageDownload = Effect.fn("game.packageDownload.issueWindows")(function* (
  threadId: ThreadId,
  packageSha256: string,
  ttlMs = DEFAULT_TTL_MS,
) {
  return yield* issue({ kind: "windows", threadId, packageSha256 }, ttlMs);
});

/** The Web package capability additionally names the selected build. */
export const issueGameWebPackageDownload = Effect.fn("game.packageDownload.issueWeb")(function* (
  threadId: ThreadId,
  buildId: string,
  packageSha256: string,
  ttlMs = DEFAULT_TTL_MS,
) {
  return yield* issue({ kind: "web", threadId, buildId, packageSha256 }, ttlMs);
});

/** Returns the package a download token was minted for, or null for any bad token. */
export const verifyGamePackageDownload = Effect.fn("game.packageDownload.verify")(function* (
  token: string,
) {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
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
