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
- **Waitlist API rate limit:** at most 10 requests a minute per IP to `/api`, ahead of the
  endpoint's own hourly limit.
- **Link previews and crawl files:** Slack, Discord, Telegram and WhatsApp preview bots cannot be
  verified, so a bypass lets their GET requests through to pages and images, never to `/api`. The
  same rule lets any GET of `robots.txt`, `sitemap.xml`, `llms.txt` and the IndexNow key file
  through, for crawlers Vercel does not verify. Hobby allows three custom rules, which is why the
  two share one.
- **Waitlist export:** requests to `/api/waitlist-export` that carry an `Authorization` header skip
  Bot Protection so the `curl` above keeps working; the endpoint checks the token itself.

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
