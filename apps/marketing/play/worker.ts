// Serves published games at <slug>.kurambit.com from R2, and takes their uploads. Every game is
// its own origin, so one game never reads another's storage. A game's files live under
// `play/<slug>/<version>/`, and `play/<slug>/live.json` names the version that plays, so an
// update switches at once and a half-uploaded version never plays. Only kurambit.com's publish
// functions (sharing PUBLISH_SECRET) may let an upload in, make a version live or take a game down.

/** The parts of the R2 binding this worker uses. */
interface R2Object {
  readonly key: string;
  readonly size: number;
  readonly httpMetadata?: { readonly contentType?: string };
}
interface R2ObjectBody extends R2Object {
  readonly body: ReadableStream;
  json<T>(): Promise<T>;
}
interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ReadableStream | string | null,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<R2Object | null>;
  delete(keys: string | ReadonlyArray<string>): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    readonly objects: ReadonlyArray<R2Object>;
    readonly truncated: boolean;
    readonly cursor?: string;
  }>;
}
interface Env {
  readonly GAMES: R2Bucket;
  readonly PUBLISH_SECRET: string;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
/**
 * kurambit.com's own subdomains, which the wildcard route also reaches: they go on to their own
 * origin untouched. The publish functions refuse these names as games (reservedSlugs there).
 */
const OWN_HOSTS = new Set([
  "www",
  "games",
  "clerk",
  "accounts",
  "clkmail",
  "send",
  "rsend",
  "api",
  "mail",
  "hello",
  "docs",
  "blog",
  "status",
  "app",
]);
const VERSION = /^[a-z0-9]{6,20}$/;
/** A file path inside a game: no climbing out, no hidden or empty parts. */
const SAFE_PATH = /^(?:[A-Za-z0-9_\-.]+\/)*[A-Za-z0-9_\-.]+$/;
const encoder = new TextEncoder();
const base64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const sign = async (secret: string, text: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64url(await crypto.subtle.sign("HMAC", key, encoder.encode(text)));
};

/** Compares two strings in time that does not depend on where they differ. */
const same = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** `<slug>.<version>.<maxBytes>.<expires>.<signature>`, signed by the publish functions. */
const uploadGrant = async (env: Env, token: string, slug: string, version: string) => {
  const parts = token.split(".");
  if (parts.length !== 5) return null;
  const [grantSlug, grantVersion, maxBytes, expires, signature] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (grantSlug !== slug || grantVersion !== version) return null;
  if (!(Number(expires) > Date.now())) return null;
  const expected = await sign(env.PUBLISH_SECRET, parts.slice(0, 4).join("."));
  return same(signature, expected) ? { maxBytes: Number(maxBytes) } : null;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const listAll = async (bucket: R2Bucket, prefix: string) => {
  const objects: Array<R2Object> = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor === undefined ? {} : { cursor }) });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return objects;
};

const deleteAll = async (bucket: R2Bucket, keys: ReadonlyArray<string>) => {
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
};

// Read on every request, never cached: commit deletes the old version's files, so a worker that
// remembered the old pointer would serve 404s. Workers Free stops at 100k requests a day, which
// keeps this read and the file read inside R2's free operations.
const liveVersion = async (env: Env, slug: string) => {
  const pointer = await env.GAMES.get(`play/${slug}/live.json`);
  return pointer === null ? null : ((await pointer.json<{ version?: string }>()).version ?? null);
};

/** The publish functions' own requests: make a version live, or take a game down. */
const admin = async (request: Request, env: Env, slug: string) => {
  const body = (await request.json().catch(() => null)) as {
    op?: string;
    version?: string;
    maxBytes?: number;
    at?: number;
    signature?: string;
  } | null;
  if (body === null || typeof body.signature !== "string" || typeof body.at !== "number")
    return json(400, { error: "body" });
  if (Math.abs(Date.now() - body.at) > 60_000) return json(401, { error: "stale" });
  const signed = `${body.op}.${slug}.${body.version ?? ""}.${body.maxBytes ?? ""}.${body.at}`;
  if (!same(body.signature, await sign(env.PUBLISH_SECRET, signed)))
    return json(401, { error: "signature" });
  const game = await listAll(env.GAMES, `play/${slug}/`);
  if (body.op === "delete") {
    await deleteAll(
      env.GAMES,
      game.map((object) => object.key),
    );
    return json(200, { ok: true });
  }
  if (body.op !== "commit" || typeof body.version !== "string" || !VERSION.test(body.version))
    return json(400, { error: "op" });
  const prefix = `play/${slug}/${body.version}/`;
  const files = game.filter((object) => object.key.startsWith(prefix));
  const bytes = files.reduce((sum, object) => sum + object.size, 0);
  if (!files.some((object) => object.key === `${prefix}index.html`))
    return json(400, { error: "no-index" });
  if (typeof body.maxBytes === "number" && bytes > body.maxBytes) {
    await deleteAll(
      env.GAMES,
      files.map((object) => object.key),
    );
    return json(413, { error: "too-big", bytes });
  }
  await env.GAMES.put(`play/${slug}/live.json`, JSON.stringify({ version: body.version }), {
    httpMetadata: { contentType: "application/json" },
  });
  // Every other version goes: only the live one is kept.
  await deleteAll(
    env.GAMES,
    game
      .filter((object) => !object.key.startsWith(prefix) && !object.key.endsWith("/live.json"))
      .map((object) => object.key),
  );
  return json(200, { ok: true, bytes });
};

const upload = async (request: Request, env: Env, slug: string, rest: string) => {
  const slash = rest.indexOf("/");
  const version = rest.slice(0, slash);
  const path = rest.slice(slash + 1);
  if (slash < 0 || !VERSION.test(version) || !SAFE_PATH.test(path) || path.includes(".."))
    return json(400, { error: "path" });
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  const grant = await uploadGrant(env, token, slug, version);
  if (grant === null) return json(401, { error: "grant" });
  const length = Number(request.headers.get("content-length"));
  if (!(length >= 0) || length > grant.maxBytes) return json(413, { error: "too-big" });
  await env.GAMES.put(`play/${slug}/${version}/${path}`, request.body, {
    httpMetadata: {
      contentType: request.headers.get("content-type") ?? "application/octet-stream",
    },
  });
  return json(200, { ok: true });
};

const play = async (env: Env, slug: string, pathname: string) => {
  const version = await liveVersion(env, slug);
  if (version === null) return new Response("No game is published here.", { status: 404 });
  const path = pathname === "/" || pathname === "" ? "index.html" : pathname.slice(1);
  if (!SAFE_PATH.test(path) || path.includes(".."))
    return new Response("Not found.", { status: 404 });
  const object = await env.GAMES.get(`play/${slug}/${version}/${path}`);
  if (object === null) return new Response("Not found.", { status: 404 });
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      // A version's files never change, but the path stays the same across updates.
      "cache-control": "public, max-age=60",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const slug = url.hostname.split(".")[0] ?? "";
    if (OWN_HOSTS.has(slug) || url.hostname.split(".").length !== 3) return fetch(request);
    if (!SLUG.test(slug)) return new Response("Not found.", { status: 404 });
    if (url.pathname === "/_kurambit/admin" && request.method === "POST")
      return admin(request, env, slug);
    if (url.pathname.startsWith("/_kurambit/upload/") && request.method === "PUT")
      return upload(request, env, slug, url.pathname.slice("/_kurambit/upload/".length));
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Method not allowed.", { status: 405 });
    return play(env, slug, url.pathname);
  },
};
