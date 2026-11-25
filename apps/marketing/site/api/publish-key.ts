// The Connect page's one call: a signed-in person (Clerk, GitHub) gets a publish key for their
// Kurambit app. A new key replaces the old one, so connecting again signs the old app out.
import { createClerkClient, verifyToken } from "@clerk/backend";
import { type ApiRequest, type ApiResponse, allowedOrigin, database, send } from "./_lib.js";
import { ensureSchema, hashKey, newKey } from "./_publish.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return send(response, 405, { error: "method" });
  }
  if (!allowedOrigin(request)) return send(response, 403, { error: "origin" });
  const sql = database();
  const secretKey = process.env["CLERK_SECRET_KEY"];
  if (!sql || !secretKey) return send(response, 503, { error: "closed" });
  const body = isRecord(request.body) ? request.body : {};
  const token = typeof body["token"] === "string" ? body["token"] : "";
  let userId: string;
  try {
    const claims = await verifyToken(token, {
      secretKey,
      authorizedParties: ["https://kurambit.com", "https://www.kurambit.com"],
    });
    userId = claims.sub;
  } catch {
    return send(response, 401, { error: "session" });
  }
  const user = await createClerkClient({ secretKey }).users.getUser(userId);
  const login =
    user.externalAccounts.find((account) => account.provider.includes("github"))?.username ??
    user.username ??
    null;
  const key = newKey();
  await ensureSchema(sql);
  await sql`
    insert into publishers (clerk_user_id, github_login, key_hash)
    values (${userId}, ${login}, ${hashKey(key)})
    on conflict (clerk_user_id) do update
      set github_login = excluded.github_login, key_hash = excluded.key_hash`;
  return send(response, 200, { key, login });
}
