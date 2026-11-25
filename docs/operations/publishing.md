# Publishing games

**Publish on kurambit.com** in the app puts a game's Web export at `<game>.kurambit.com`. Three
pieces run it, and every one stays on a free tier:

- **Sign-in.** An app connects the device way (RFC 8628, like `gh auth login`):
  [`site/api/publish-device.ts`](../../apps/marketing/site/api/publish-device.ts) starts a sign-in
  with a secret device code and a short user code, the app opens the
  [Connect page](../../apps/marketing/site/connect.html) with the user code and polls, and the
  person signs in with GitHub there and approves the code. The next poll hands the app its `kpk_`
  publish key, once. Sign-in goes through the `Kurambit` Clerk application (production instance,
  frontend API `clerk.kurambit.com`). Clerk needs its own GitHub OAuth app, `Kurambit` under the owner's GitHub
  account, with the callback `https://clerk.kurambit.com/v1/oauth_callback`.
- **Publish functions.** [`site/api/publish.ts`](../../apps/marketing/site/api/publish.ts) checks the limits and signs
  upload grants. Both functions store data in the waitlist's Neon database.
- **Play worker.** [`apps/marketing/play`](../../apps/marketing/play) is the `kurambit-play`
  Cloudflare Worker on the `*.kurambit.com/*` route. It takes uploads under a grant, serves the
  live version from the `kurambit-games` R2 bucket, and passes kurambit.com's own subdomains
  through.

Files go from the app straight to the worker, because Vercel refuses request bodies over 4.5 MB.

## Limits

These are in [`_publish.ts`](../../apps/marketing/site/api/_publish.ts): 50 MB per game, five games
per GitHub account, and 9 GB in total, kept under R2's free 10 GB. Past a limit, new publishes are
refused; nothing is ever billed.

The worker reads `live.json` on every request instead of caching it. Workers Free stops at 100k
requests a day, which keeps those reads under R2's free operations.

## Secrets

- `PUBLISH_SECRET` (at least 32 characters) must be the same in Vercel's production environment
  and in the worker (`wrangler secret put PUBLISH_SECRET`). It signs upload grants and the
  functions' commit and delete calls to the worker.
- `CLERK_SECRET_KEY` (Vercel production) is the Clerk production instance's `vercel-publish` key.
  The publishable key is public and lives in `connect.js`.

## DNS

On Cloudflare's `kurambit.com` zone:

- Clerk's records: `clerk`, `accounts`, `clkmail`, `clk._domainkey`, `clk2._domainkey` and
  `_dmarc`, all DNS only.
- A proxied wildcard `*` A record pointing at `192.0.2.1`, so `<game>.kurambit.com` reaches the
  worker. Names with their own records (`www`, `games`, `send`, Clerk's) are unaffected.

Cloudflare's free certificate covers one level only, so games are `<game>.kurambit.com`, never a
deeper name. Every subdomain kurambit.com uses for itself must be in the reserved list in both
`worker.ts` and `_publish.ts`.

## Deploy

The functions deploy with the site from `main`. Deploy the worker from `apps/marketing/play` with
`npx wrangler deploy`, logged in to the owner's Cloudflare account.
