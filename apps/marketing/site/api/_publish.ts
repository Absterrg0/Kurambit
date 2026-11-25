// Publishing a game from the Kurambit app to <slug>.kurambit.com. A person signs in once on the
// Connect page (Clerk, GitHub) and their app keeps a publish key; the key starts a publish, whose
// files the app uploads straight to the play worker (apps/marketing/play) under a signed grant,
// and then makes the new version live. Files never pass through these functions: Vercel refuses
// request bodies over 4.5 MB. Everything is capped so the whole service stays inside free tiers.
import * as NodeCrypto from "node:crypto";
import { type ApiRequest, type Sql, bearer } from "./_lib.js";

/** One game's files at most. */
export const MAX_GAME_BYTES = 50 * 1024 * 1024;
/** Games one person may have published at once. */
export const MAX_GAMES_PER_PUBLISHER = 5;
/** All games together: R2's free tier is 10 GB, and past it storage costs money. */
export const MAX_TOTAL_BYTES = 9 * 1024 * 1024 * 1024;
/** How long an upload grant lasts. */
const GRANT_MS = 30 * 60 * 1000;

export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
/** kurambit.com's own subdomains, never a game's: the play worker passes these through. */
const RESERVED = new Set([
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
  "admin",
  "support",
  "kurambit",
]);
export const slugAllowed = (slug: string) => SLUG.test(slug) && !RESERVED.has(slug);

/** A slug from a game's name: "Small Arena!" → "small-arena". */
export const slugFrom = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");

export const hashKey = (key: string) => NodeCrypto.createHash("sha256").update(key).digest("hex");

export const newKey = () => `kpk_${NodeCrypto.randomBytes(24).toString("base64url")}`;

export const secret = () => {
  const value = process.env["PUBLISH_SECRET"];
  return value !== undefined && value.length >= 32 ? value : null;
};

const sign = (text: string, key: string) =>
  NodeCrypto.createHmac("sha256", key).update(text).digest("base64url");

/** The grant the play worker checks on each upload (worker.ts uploadGrant). */
export const uploadGrant = (key: string, slug: string, version: string, maxBytes: number) => {
  const body = `${slug}.${version}.${maxBytes}.${Date.now() + GRANT_MS}`;
  return `${body}.${sign(body, key)}`;
};

/** Asks the play worker to make a version live, or to take a game down. */
export const playAdmin = async (
  key: string,
  slug: string,
  request: {
    readonly op: "commit" | "delete";
    readonly version?: string;
    readonly maxBytes?: number;
  },
) => {
  const at = Date.now();
  const signature = sign(
    `${request.op}.${slug}.${request.version ?? ""}.${request.maxBytes ?? ""}.${at}`,
    key,
  );
  const response = await fetch(`https://${slug}.kurambit.com/_kurambit/admin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...request, at, signature }),
  });
  const body = (await response.json().catch(() => ({}))) as { bytes?: number; error?: string };
  return { ok: response.ok, status: response.status, ...body };
};

let schemaReady: Promise<unknown> | null = null;
/** The two tables, made on first use. */
export const ensureSchema = (sql: Sql) =>
  (schemaReady ??= sql`
    create table if not exists publishers (
      clerk_user_id text primary key,
      github_login text,
      key_hash text unique,
      created_at timestamptz not null default now()
    )`.then(
    () => sql`
    create table if not exists published_games (
      slug text primary key,
      clerk_user_id text not null references publishers(clerk_user_id),
      name text not null,
      version text,
      bytes bigint not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`,
  ));

/** The publisher a request's key belongs to, or null. */
export const publisherOf = async (sql: Sql, request: ApiRequest) => {
  const key = bearer(request);
  if (!key.startsWith("kpk_")) return null;
  const [row] = await sql`
    select clerk_user_id, github_login from publishers where key_hash = ${hashKey(key)}`;
  return row === undefined
    ? null
    : { id: String(row["clerk_user_id"]), login: (row["github_login"] as string | null) ?? null };
};
