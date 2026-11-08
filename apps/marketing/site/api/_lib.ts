import * as NodeCrypto from "node:crypto";
import { type NeonQueryFunction, neon } from "@neondatabase/serverless";

/** The parts of Vercel's Node request and response these functions use. */
export type ApiRequest = {
  method?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
};

export type ApiResponse = {
  setHeader(name: string, value: string): unknown;
  status(code: number): ApiResponse;
  send(body: string): unknown;
};

/** Rows come back as plain objects, not arrays or full results. */
export type Sql = NeonQueryFunction<false, false>;

const ALLOWED_ORIGINS = new Set(["https://kurambit.com", "https://www.kurambit.com"]);

export const ROLES = new Set(["player", "indie", "studio", "other"]);

export function database(): Sql | null {
  const url = process.env["DATABASE_URL"];
  return url ? neon(url) : null;
}

const header = (request: ApiRequest, name: string) => {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
};

/** Only our own pages may post; a missing Origin means a script, not a browser form. */
export function allowedOrigin(request: ApiRequest) {
  const origin = header(request, "origin");
  if (origin === undefined) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // Local previews of the site itself.
  return (
    process.env["VERCEL_ENV"] !== "production" &&
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  );
}

/** Raw IPs are never stored: a keyed hash is enough to rate-limit. */
export function hashIp(request: ApiRequest) {
  const ip = (header(request, "x-forwarded-for")?.split(",")[0] ?? "").trim() || "unknown";
  return NodeCrypto.createHmac("sha256", process.env["WAITLIST_HASH_SECRET"] ?? "")
    .update(ip)
    .digest("hex");
}

export function normalizeEmail(value: unknown) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  // Deliberately plain: one @, a dotted domain, no spaces or angle brackets.
  if (!/^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[a-z]{2,}$/i.test(email)) return null;
  return email;
}

export function cleanText(value: unknown, max: number) {
  if (typeof value !== "string") return null;
  // Strip control characters so nothing odd reaches a CSV or an email client.
  // oxlint-disable-next-line no-control-regex -- matching them is the point.
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text.length === 0 ? null : text.slice(0, max);
}

/** Compares digests so neither length nor content leaks through timing. */
export function tokenMatches(given: string, expected: string | undefined) {
  if (expected === undefined || expected.length < 32) return false;
  const a = NodeCrypto.createHash("sha256").update(given).digest();
  const b = NodeCrypto.createHash("sha256").update(expected).digest();
  return NodeCrypto.timingSafeEqual(a, b);
}

export function bearer(request: ApiRequest) {
  const value = header(request, "authorization");
  return value?.startsWith("Bearer ") ? value.slice(7) : "";
}

export function send(response: ApiResponse, status: number, body: Record<string, unknown>) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.status(status).send(JSON.stringify(body));
}
