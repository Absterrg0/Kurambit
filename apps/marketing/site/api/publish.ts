// A publisher's games, with their key: `list`, `begin` a publish (a slug and an upload grant),
// `commit` it once its files are uploaded (the play worker makes it live), `delete` a game.
import { type ApiRequest, type ApiResponse, cleanText, database, send } from "./_lib.js";
import {
  MAX_GAME_BYTES,
  MAX_GAMES_PER_PUBLISHER,
  MAX_TOTAL_BYTES,
  SLUG,
  ensureSchema,
  playAdmin,
  publisherOf,
  secret,
  slugAllowed,
  slugFrom,
  uploadGrant,
} from "./_publish.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const urlOf = (slug: string) => `https://${slug}.kurambit.com/`;

export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return send(response, 405, { error: "method" });
  }
  const sql = database();
  const key = secret();
  if (!sql || key === null) return send(response, 503, { error: "closed" });
  await ensureSchema(sql);
  const publisher = await publisherOf(sql, request);
  if (publisher === null) return send(response, 401, { error: "key" });
  const body = isRecord(request.body) ? request.body : {};
  const step = body["step"];

  if (step === "list") {
    const rows = await sql`
      select slug, name, bytes, updated_at from published_games
      where clerk_user_id = ${publisher.id} and version is not null order by updated_at desc`;
    return send(response, 200, {
      login: publisher.login,
      games: rows.map((row) => ({
        slug: row["slug"],
        name: row["name"],
        url: urlOf(String(row["slug"])),
        bytes: Number(row["bytes"]),
      })),
    });
  }

  const requested = typeof body["slug"] === "string" ? body["slug"] : "";

  if (step === "begin") {
    const name = cleanText(body["name"], 80) ?? "Untitled game";
    const bytes = Number(body["bytes"]);
    if (!Number.isFinite(bytes) || bytes <= 0) return send(response, 400, { error: "bytes" });
    if (bytes > MAX_GAME_BYTES)
      return send(response, 413, {
        error: "too-big",
        message: `A published game can be at most ${MAX_GAME_BYTES / 1024 / 1024} MB; this one is ${Math.ceil(bytes / 1024 / 1024)} MB.`,
      });
    const slug = requested === "" ? slugFrom(name) : requested;
    if (!slugAllowed(slug))
      return send(response, 400, {
        error: "slug",
        message: "That address cannot be used: pick letters, digits and dashes, 2 to 32 long.",
      });
    const [owner] = await sql`select clerk_user_id from published_games where slug = ${slug}`;
    if (owner !== undefined && owner["clerk_user_id"] !== publisher.id)
      return send(response, 409, {
        error: "taken",
        message: `${slug}.kurambit.com is someone else's game: pick another address.`,
      });
    if (owner === undefined) {
      const [mine] = await sql`
        select count(*)::int as count from published_games where clerk_user_id = ${publisher.id}`;
      if (Number(mine?.["count"]) >= MAX_GAMES_PER_PUBLISHER)
        return send(response, 409, {
          error: "limit",
          message: `You can publish ${MAX_GAMES_PER_PUBLISHER} games: unpublish one to publish another.`,
        });
    }
    const [total] = await sql`select coalesce(sum(bytes), 0)::bigint as bytes from published_games`;
    if (Number(total?.["bytes"]) + bytes > MAX_TOTAL_BYTES)
      return send(response, 507, {
        error: "full",
        message: "Publishing is full for now. Your game is safe in the app; try again later.",
      });
    await sql`
      insert into published_games (slug, clerk_user_id, name)
      values (${slug}, ${publisher.id}, ${name})
      on conflict (slug) do update set name = excluded.name, updated_at = now()`;
    const version = Date.now().toString(36);
    return send(response, 200, {
      slug,
      version,
      upload: `https://${slug}.kurambit.com/_kurambit/upload/${version}/`,
      grant: uploadGrant(key, slug, version, MAX_GAME_BYTES),
      url: urlOf(slug),
    });
  }

  if (!SLUG.test(requested)) return send(response, 400, { error: "slug" });
  const [game] = await sql`
    select clerk_user_id from published_games where slug = ${requested}`;
  if (game === undefined || game["clerk_user_id"] !== publisher.id)
    return send(response, 404, { error: "game" });

  if (step === "commit") {
    const version = typeof body["version"] === "string" ? body["version"] : "";
    const made = await playAdmin(key, requested, {
      op: "commit",
      version,
      maxBytes: MAX_GAME_BYTES,
    });
    if (!made.ok) return send(response, 502, { error: made.error ?? "commit" });
    await sql`
      update published_games set version = ${version}, bytes = ${made.bytes ?? 0}, updated_at = now()
      where slug = ${requested}`;
    return send(response, 200, { slug: requested, url: urlOf(requested) });
  }

  if (step === "delete") {
    const gone = await playAdmin(key, requested, { op: "delete" });
    if (!gone.ok) return send(response, 502, { error: gone.error ?? "delete" });
    await sql`delete from published_games where slug = ${requested}`;
    return send(response, 200, { ok: true });
  }

  return send(response, 400, { error: "step" });
}
