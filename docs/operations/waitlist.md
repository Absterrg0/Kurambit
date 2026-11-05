# Waitlist

The kurambit.com waitlist is two Vercel functions in
[`apps/marketing/site/api`](../../apps/marketing/site/api), written in TypeScript that Vercel
compiles itself, backed by the `kurambit-waitlist` Neon Postgres database, provisioned through the
Vercel Neon integration and connected to the `kurambit` project. The site never reads the list;
only the functions can reach the database.

## Email

A new signup gets a short welcome, and the owner gets a notice; replying to either reaches the other
person. Mail goes through [Resend](https://resend.com) from a verified `kurambit.com`, only for an
address that was not already listed, and only after the form has been answered, so neither the
timing nor the inbox reveals whether someone signed up before. If Resend fails, the signup is still
stored and the function logs the Resend error name, never an address.

`hello@kurambit.com` is a real address: Cloudflare Email Routing forwards it to the owner's Gmail,
and Gmail sends as it through `smtp.resend.com` with its own sending-only Resend key. Point
`WAITLIST_NOTIFY_EMAIL` at it so welcome replies and signup notices both go through hello@.

Without `RESEND_API_KEY` and `WAITLIST_FROM`, signups are stored and nothing is sent. Resend's free
plan allows 100 emails a day, which is 50 signups.

To check the functions, run `npm install` in `apps/marketing/site`, then `tsc -p apps/marketing/site`
from the repository root.

## Export the list

```sh
curl -fsS -H "Authorization: Bearer $(cat ~/.config/kurambit/waitlist-admin-token)" \
  https://kurambit.com/api/waitlist-export -o kurambit-waitlist.csv
```

A wrong or missing token gets a 404, so the endpoint does not advertise itself. The Neon console,
reached from the Vercel project's Storage tab, also shows the `waitlist` table.

## Configuration

Production environment variables on the `kurambit` Vercel project:

- `DATABASE_URL`: set by the Neon integration.
- `WAITLIST_HASH_SECRET`: keys the hash of each visitor's IP for rate limiting. Raw IPs are never
  stored. Rotating it resets the rate-limit windows and nothing else.
- `WAITLIST_ADMIN_TOKEN`: the bearer token for the export. Rotate it by setting a new value and
  updating your local copy.
- `RESEND_API_KEY`: a sending-only Resend key for the verified `kurambit.com` domain.
- `WAITLIST_FROM`: the sender, such as `Kurambit <hello@kurambit.com>`.
- `WAITLIST_NOTIFY_EMAIL`: where signup notices go. Leave it unset to send only welcomes.

Preview deployments get none of the waitlist secrets, so the form there answers that the waitlist is
closed and sends nothing.

## What the signup endpoint guards against

- Posts from other origins, and scripted posts without an Origin header.
- Bots, through a hidden field and a minimum time on the page; both get a fake success and store
  nothing.
- Floods, through a per-IP-hash limit of 8 attempts an hour.
- Probing who signed up: a new and a repeated email get the same answer.
- Formula injection in the CSV export: cells that start with `=`, `+`, `-` or `@` are escaped.

Schema changes are plain SQL against the database; the tables are `waitlist` and `waitlist_rate`.

## Firewall

The project is on Vercel's Hobby plan, which pauses the whole team when it runs over its monthly
allowance, so the Vercel Firewall stops abusive traffic before it is counted. Traffic the firewall
challenges, denies or rate limits does not count toward usage. Its rules live in Vercel, not in this
repository; `vercel firewall overview` from a directory linked to the `kurambit` project shows them.

- **Bot Protection** is on in challenge mode. Verified bots pass: search engines, the X, Facebook
  and LinkedIn preview bots, AI crawlers and assistants, and PageSpeed Insights. Anything else that
  does not look like a browser gets a JavaScript challenge, so `curl` against the site sees a 429
  page.
- **Public pages and the export (bypass):** GETs of the pages (`/`, `/waitlist`, `/privacy`), the
  link card (`og.png`), the icons and manifest, and the crawl files (`robots.txt`, `sitemap.xml`,
  `llms.txt`, the IndexNow key) skip Bot Protection, so link previews, launch directories and
  crawlers Vercel cannot verify can read the site. Scripts, styles, fonts and art stay behind the
  challenge; browsers pass it, scrapers do not need them. The same rule lets requests to
  `/api/waitlist-export` that carry an `Authorization` header through, so the `curl` above keeps
  working; the endpoint checks the token itself. A new public page has to be added to this list
  and to the rate limit's.
- **Rate limit:** at most 20 requests a minute per IP to `/api` and to the public paths above, ahead
  of the endpoint's own hourly limit. It is the only rate-limit rule Hobby allows, which is why it
  covers both, and it sits first so the bypass cannot skip it.

The AI Bots ruleset is left off on purpose: the site wants answer engines to read and cite it.

## Search engines

kurambit.com is a Domain property in Google Search Console, verified by the
`google-site-verification` TXT record on the apex in Cloudflare (keep it), and is in Bing Webmaster
Tools; both have the sitemap. Bing, Yandex, Seznam and Naver are also told about changed pages through IndexNow: the key is the
`<key>.txt` file in `site/`, and after a deploy that changes pages,

```sh
curl -s -H "Content-Type: application/json" https://api.indexnow.org/indexnow -d \
  '{"host":"kurambit.com","key":"<key>","urlList":["https://kurambit.com/"]}'
```

with the key from that file. Bump the sitemap's `lastmod` when a page changes.
