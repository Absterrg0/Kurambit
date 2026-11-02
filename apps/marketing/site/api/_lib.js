import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { neon } from "@neondatabase/serverless";

const ALLOWED_ORIGINS = new Set(["https://kurambit.com", "https://www.kurambit.com"]);

export const ROLES = new Set(["player", "indie", "studio", "other"]);

export function database() {
  const url = process.env.DATABASE_URL;
  return url ? neon(url) : null;
}

/** Only our own pages may post; a missing Origin means a script, not a browser form. */
export function allowedOrigin(request) {
  const origin = request.headers.origin;
  if (typeof origin !== "string") return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // Local previews of the site itself.
  return (
    process.env.VERCEL_ENV !== "production" &&
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  );
}

/** Raw IPs are never stored: a keyed hash is enough to rate-limit. */
export function hashIp(request) {
  const forwarded = request.headers["x-forwarded-for"];
  const ip = (typeof forwarded === "string" ? forwarded.split(",")[0] : "").trim() || "unknown";
  return createHmac("sha256", process.env.WAITLIST_HASH_SECRET ?? "")
    .update(ip)
    .digest("hex");
}

export function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  // Deliberately plain: one @, a dotted domain, no spaces or angle brackets.
  if (!/^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[a-z]{2,}$/i.test(email)) return null;
  return email;
}

export function cleanText(value, max) {
  if (typeof value !== "string") return null;
  // Strip control characters so nothing odd reaches a CSV or an email client.
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text.length === 0 ? null : text.slice(0, max);
}

/** Compares digests so neither length nor content leaks through timing. */
export function tokenMatches(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string" || expected.length < 32)
    return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function send(response, status, body) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.status(status).send(JSON.stringify(body));
}
