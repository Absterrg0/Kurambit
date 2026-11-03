import * as NodeCrypto from "node:crypto";

// Waitlist email goes through Resend's HTTP API; a plain fetch keeps the
// functions free of another dependency.
const BATCH_URL = "https://api.resend.com/emails/batch";
const SITE = "https://kurambit.com";

export type Mailer = { key: string; from: string; owner: string | null };

export type Signup = { email: string; source: string | null; count: number | null };

type Message = {
  from: string;
  to: string[];
  reply_to?: string;
  subject: string;
  text: string;
  html: string;
};

/** Mail is optional: without a key and a sender, signups are stored and nothing is sent. */
export function mailer(): Mailer | null {
  const key = process.env["RESEND_API_KEY"];
  const from = process.env["WAITLIST_FROM"];
  if (!key || !from) return null;
  return { key, from, owner: process.env["WAITLIST_NOTIFY_EMAIL"] || null };
}

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);

// Email clients ignore stylesheets and most layout, so this is one inline
// styled card in the site's paper, ink and vermilion.
function page(heading: string, paragraphs: string[]) {
  const body = paragraphs
    .map(
      (text) =>
        `<p style="margin:0 0 16px;font:16px/1.6 Georgia,'Times New Roman',serif;color:#3a3935">${text}</p>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en"><body style="margin:0;padding:0;background:#efeee9">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#efeee9"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#f8f7f3;border-radius:10px">
<tr><td style="padding:32px 32px 8px">
<img src="${SITE}/apple-touch-icon.png" width="40" height="40" alt="Kurambit" style="display:block;border:0;border-radius:8px">
<h1 style="margin:24px 0 10px;font:400 28px/1.15 Georgia,'Times New Roman',serif;color:#141412">${heading}</h1>
<div style="width:64px;height:4px;margin:0 0 24px;border-radius:4px;background:#e2582a"></div>
${body}
</td></tr>
<tr><td style="padding:8px 32px 28px;font:13px/1.5 Helvetica,Arial,sans-serif;color:#6f6d66">
<a href="${SITE}" style="color:#6f6d66">kurambit.com</a> &middot; <a href="${SITE}/privacy" style="color:#6f6d66">Privacy</a>
</td></tr>
</table></td></tr></table>
</body></html>`;
}

function welcome(mail: Mailer, email: string): Message {
  const lines = [
    "Thanks for joining the Kurambit waitlist.",
    "Kurambit turns the coding agent you already use into a game studio: it builds your game in Godot and Blender, plays every build, and keeps only the changes that make it better.",
    "We are letting people in a few at a time, so every new studio gets a good first game. We will email you again when your invite is ready.",
    "If you did not sign up, or want off the list, reply to this email and we will delete your address.",
  ];
  return {
    from: mail.from,
    to: [email],
    ...(mail.owner ? { reply_to: mail.owner } : {}),
    subject: "You're on the Kurambit waitlist",
    text: `${lines.join("\n\n")}\n\nKurambit\n${SITE}\n`,
    html: page("You're on the list.", lines),
  };
}

function notice(owner: string, mail: Mailer, { email, source, count }: Signup): Message {
  const where = source ? ` from the ${source} form` : "";
  const total = count ? ` That makes ${count} on the list.` : "";
  return {
    from: mail.from,
    to: [owner],
    reply_to: email,
    subject: `New Kurambit signup: ${email}`,
    text: `${email} joined the waitlist${where}.${total}\n\nReply to this email to write to them.\n`,
    html: page("New signup.", [
      `<b>${escapeHtml(email)}</b> joined the waitlist${escapeHtml(where)}.${escapeHtml(total)}`,
      "Reply to this email to write to them.",
    ]),
  };
}

/**
 * Sends the welcome to the new address and, when an owner address is set, a
 * notice to the owner. Never throws: the signup is already stored, so a mail
 * failure is logged, without the address, and nothing else changes.
 */
export async function sendSignupMail(mail: Mailer, signup: Signup) {
  const messages = [welcome(mail, signup.email)];
  if (mail.owner) messages.push(notice(mail.owner, mail, signup));
  try {
    const response = await fetch(BATCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mail.key}`,
        "Content-Type": "application/json",
        // A retried request for the same signup sends nothing twice.
        "Idempotency-Key": `waitlist-${NodeCrypto.createHash("sha256").update(signup.email).digest("hex").slice(0, 32)}`,
      },
      body: JSON.stringify(messages),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      // Resend's error name says what is wrong; its message can quote addresses.
      const detail: unknown = await response.json().catch(() => null);
      const name =
        detail && typeof detail === "object" && "name" in detail ? String(detail.name) : "";
      console.error(`waitlist mail failed: ${response.status} ${name}`);
    }
  } catch (error) {
    console.error(`waitlist mail failed: ${error instanceof Error ? error.name : "error"}`);
  }
}
