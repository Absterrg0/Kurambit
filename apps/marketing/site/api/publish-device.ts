// Connecting a Kurambit app to a publisher, the device way (RFC 8628, as `gh auth login` does):
// the app starts a sign-in and gets a secret device code and a short user code, opens the Connect
// page with the user code, and polls. The person signs in with GitHub there, checks the code
// matches the one their app shows, and approves; the app's next poll gets its publish key, once.
import * as NodeCrypto from "node:crypto";
import { createClerkClient, verifyToken } from "@clerk/backend";
import {
  type ApiRequest,
  type ApiResponse,
  type Sql,
  allowedOrigin,
  database,
  hashIp,
  send,
} from "./_lib.js";
import { ensureSchema, hashKey, newKey } from "./_publish.js";

const DEVICE_MINUTES = 10;
/** Seconds the app waits between polls. */
const INTERVAL = 3;
/** Sign-ins one address may have waiting at once. */
const MAX_WAITING_PER_IP = 5;
/** No vowels or look-alikes, so a code never spells a word or misreads. */
const CODE_LETTERS = "BCDFGHJKLMNPQRSTVWXZ";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const text = (body: Record<string, unknown>, name: string) =>
  typeof body[name] === "string" ? body[name] : "";

const userCode = () => {
  const letters = Array.from(
    NodeCrypto.randomBytes(8),
    (byte) => CODE_LETTERS[byte % CODE_LETTERS.length],
  );
  return `${letters.slice(0, 4).join("")}-${letters.slice(4).join("")}`;
};

let deviceSchema: Promise<unknown> | null = null;
const ensureDeviceSchema = (sql: Sql) =>
  (deviceSchema ??= sql`
    create table if not exists publish_devices (
      device_hash text primary key,
      user_code text unique not null,
      ip_hash text not null,
      clerk_user_id text,
      github_login text,
      expires_at timestamptz not null
    )`);

const start = async (sql: Sql, request: ApiRequest, response: ApiResponse) => {
  const ip = hashIp(request);
  await sql`delete from publish_devices where expires_at < now()`;
  const [waiting] = await sql`select count(*)::int as n from publish_devices where ip_hash = ${ip}`;
  if (Number(waiting?.["n"] ?? 0) >= MAX_WAITING_PER_IP)
    return send(response, 429, { error: "busy" });
  const deviceCode = NodeCrypto.randomBytes(32).toString("base64url");
  const code = userCode();
  await sql`
    insert into publish_devices (device_hash, user_code, ip_hash, expires_at)
    values (${hashKey(deviceCode)}, ${code}, ${ip},
      now() + make_interval(mins => ${DEVICE_MINUTES}))`;
  return send(response, 200, {
    deviceCode,
    userCode: code,
    verifyUrl: `https://kurambit.com/connect?code=${code}`,
    interval: INTERVAL,
    expiresIn: DEVICE_MINUTES * 60,
  });
};

const poll = async (sql: Sql, deviceCode: string, response: ApiResponse) => {
  const [row] = await sql`
    select clerk_user_id, github_login from publish_devices
    where device_hash = ${hashKey(deviceCode)} and expires_at > now()`;
  if (row === undefined) return send(response, 200, { status: "expired" });
  const userId = row["clerk_user_id"] as string | null;
  if (userId === null) return send(response, 200, { status: "pending" });
  // Taken before the key is minted, so two polls racing hand out one key between them.
  const taken = await sql`
    delete from publish_devices where device_hash = ${hashKey(deviceCode)} returning 1`;
  if (taken.length === 0) return send(response, 200, { status: "expired" });
  const login = (row["github_login"] as string | null) ?? null;
  const key = newKey();
  await ensureSchema(sql);
  // A new key replaces the old one, so connecting again signs the old app out.
  await sql`
    insert into publishers (clerk_user_id, github_login, key_hash)
    values (${userId}, ${login}, ${hashKey(key)})
    on conflict (clerk_user_id) do update
      set github_login = excluded.github_login, key_hash = excluded.key_hash`;
  return send(response, 200, { status: "done", key, login });
};

const approve = async (
  sql: Sql,
  request: ApiRequest,
  body: Record<string, unknown>,
  response: ApiResponse,
) => {
  if (!allowedOrigin(request)) return send(response, 403, { error: "origin" });
  const secretKey = process.env["CLERK_SECRET_KEY"];
  if (!secretKey) return send(response, 503, { error: "closed" });
  let userId: string;
  try {
    const claims = await verifyToken(text(body, "token"), {
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
  const approved = await sql`
    update publish_devices set clerk_user_id = ${userId}, github_login = ${login}
    where user_code = ${text(body, "userCode").toUpperCase()}
      and clerk_user_id is null and expires_at > now()
    returning 1`;
  if (approved.length === 0) return send(response, 404, { error: "code" });
  return send(response, 200, { ok: true, login });
};

export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return send(response, 405, { error: "method" });
  }
  const sql = database();
  if (!sql) return send(response, 503, { error: "closed" });
  await ensureDeviceSchema(sql);
  const body = isRecord(request.body) ? request.body : {};
  switch (body["step"]) {
    case "start":
      return start(sql, request, response);
    case "poll":
      return poll(sql, text(body, "deviceCode"), response);
    case "approve":
      return approve(sql, request, body, response);
    default:
      return send(response, 400, { error: "step" });
  }
}
