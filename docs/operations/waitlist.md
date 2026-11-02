# Waitlist

The kurambit.com waitlist is two Vercel functions in
[`apps/marketing/site/api`](../../apps/marketing/site/api) backed by the `kurambit-waitlist` Neon
Postgres database, provisioned through the Vercel Neon integration and connected to the `kurambit`
project. The site never reads the list; only the functions can reach the database.

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

Preview deployments get neither secret, so the form there answers that the waitlist is closed.

## What the signup endpoint guards against

- Posts from other origins, and scripted posts without an Origin header.
- Bots, through a hidden field and a minimum time on the page; both get a fake success and store
  nothing.
- Floods, through a per-IP-hash limit of 8 attempts an hour.
- Probing who signed up: a new and a repeated email get the same answer.
- Formula injection in the CSV export: cells that start with `=`, `+`, `-` or `@` are escaped.

Schema changes are plain SQL against the database; the tables are `waitlist` and `waitlist_rate`.
