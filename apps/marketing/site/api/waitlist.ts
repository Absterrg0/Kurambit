import { waitUntil } from "@vercel/functions";
import {
  type ApiRequest,
  type ApiResponse,
  ROLES,
  type Sql,
  allowedOrigin,
  cleanText,
  database,
  hashIp,
  normalizeEmail,
  send,
} from "./_lib.js";
import { type Mailer, mailer, sendSignupMail } from "./_mail.js";

const WINDOW_MINUTES = 60;
const MAX_ATTEMPTS = 8;
// A person takes longer than this to read the form and type an address.
const MIN_FILL_MS = 1200;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

async function welcome(sql: Sql, mail: Mailer, email: string, source: string | null) {
  let count: number | null = null;
  if (mail.owner) {
    try {
      const [row] = await sql`select count(*)::int as count from waitlist`;
      count = Number(row?.["count"]) || null;
    } catch {
      // The notice still goes out, without the running total.
    }
  }
  await sendSignupMail(mail, { email, source, count });
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return send(response, 405, { error: "method" });
  }
  if (!allowedOrigin(request)) return send(response, 403, { error: "origin" });

  const sql = database();
  if (!sql || !process.env["WAITLIST_HASH_SECRET"]) return send(response, 503, { error: "closed" });

  const body = isRecord(request.body) ? request.body : {};

  // Bots fill the hidden field and submit instantly. Answer as if it worked so
  // they learn nothing, and store nothing.
  const filledHoneypot = typeof body["website"] === "string" && body["website"].length > 0;
  const elapsed = Number(body["elapsed"]);
  if (filledHoneypot || !Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) {
    return send(response, 200, { ok: true });
  }

  const email = normalizeEmail(body["email"]);
  if (!email) return send(response, 400, { error: "email" });
  const name = cleanText(body["name"], 80);
  const role = typeof body["role"] === "string" && ROLES.has(body["role"]) ? body["role"] : null;
  const source = cleanText(body["source"], 40);
  const ipHash = hashIp(request);

  const [limit] = await sql`
    insert into waitlist_rate (ip_hash, window_start, attempts)
    values (${ipHash}, now(), 1)
    on conflict (ip_hash) do update set
      attempts = case
        when waitlist_rate.window_start < now() - make_interval(mins => ${WINDOW_MINUTES}) then 1
        else waitlist_rate.attempts + 1
      end,
      window_start = case
        when waitlist_rate.window_start < now() - make_interval(mins => ${WINDOW_MINUTES}) then now()
        else waitlist_rate.window_start
      end
    returning attempts`;
  if (Number(limit?.["attempts"]) > MAX_ATTEMPTS)
    return send(response, 429, { error: "slow-down" });

  const added = await sql`
    insert into waitlist (email, name, role, source, ip_hash)
    values (${email}, ${name}, ${role}, ${source}, ${ipHash})
    on conflict (email) do nothing
    returning email`;

  // Mail goes out only for a new address, so sending someone's email again
  // cannot flood them, and only after the answer, so a new address and a
  // listed one cannot be told apart by how long the answer takes.
  const mail = mailer();
  if (added.length > 0 && mail) waitUntil(welcome(sql, mail, email, source));

  // The same answer whether or not the address was already listed, so the
  // form cannot be used to find out who signed up.
  return send(response, 200, { ok: true });
}
