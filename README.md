# BrokerStaffer OS

The workspace that fronts the BrokerStaffer tools: one sign-in, one place to go,
and per-person control over which tools each teammate can open.

> **This repository is public.** Never commit a `.env`, a key or a token. Every
> secret lives in Railway variables; `.env.example` holds placeholders only.

---

## What's here

```
src/                    the workspace app (Next 16) — deploys from the repo root
packages/bs-auth/       the shared SSO token — ONE source of truth
patches/                diffs that add SSO to the four tool repositories
scripts/                end-to-end verification against real running servers
```

The four tools stay in their own repositories and keep their own databases.
Nothing about them moves.

---

## How sign-in works

The workspace signs a short-lived token; every other app verifies it **offline**
with a shared secret. No network call and no database lookup on the hot path, so
a permission check costs one HMAC rather than a round trip.

```
sign in at the workspace
  → cookie bs_sso, Domain=.brokerstaffer.com, HttpOnly, Secure, SameSite=Lax
  → payload { email, grants[], ver, exp }, HMAC-SHA256
  → every app on a subdomain reads it as FIRST-PARTY
```

`SameSite=Lax` is correct **because** every app shares one apex, which makes an
embedded pane same-site. Do not "fix" it to `SameSite=None` — that turns it into
a third-party cookie, which Safari blocks by default and Chrome is retiring.

Tokens live **30 minutes**. That is the revocation window: `/api/auth/refresh`
re-reads grants on every renewal, which is how removing someone's access reaches
four apps that never query a database. Bump their `tokenVersion` to revoke
immediately.

Tools: `inbox`, `clients`, `analytics`, `search`.

---

## Where permissions live

Behind a `GrantStore` interface with two implementations. Today it reads env
vars — nothing to provision. A Postgres adapter drops in later without changing
a line in any app, because the apps read grants from the token, not the store.

### The one deliberate fail-open

With `BS_GRANTS` **unset**, everyone in `AUTH_USERS` gets every tool. Without
that, deploying this would lock the existing admin out of their own workspace
with no way back in. `AUTH_USERS` is itself an allow-list only a Railway
operator can edit, so the blast radius is "people who could already sign in keep
what they already had".

Once `BS_GRANTS` is set it is **authoritative** — being in `AUTH_USERS` no
longer implies any access. `GrantStore.describe().governed` reports which mode
is live, so this cannot go unnoticed.

---

## Verifying

```bash
node --test packages/bs-auth/index.test.ts   # 20 — the token itself
npm test                                     # 10 — the grant store
node packages/bs-auth/sync.mjs --check       #      copies have not drifted
```

The scripts in `scripts/` boot the real tool servers and assert the whole path —
matcher, cookie parsing, rewrite targets. They need the local integration
sandbox, which holds working copies of the four apps, so they are kept here for
reference rather than to run from this repo.

| Script | Asserts |
|---|---|
| `verify-client-health.mjs` | 9 checks |
| `verify-analytics.mjs` | 14 checks, including that the legacy cookie still works |
| `verify-agent-search.mjs` | 21 checks, including TypeScript-mints / JavaScript-verifies |

---

## Applying SSO to the four tools

Each patch is small and self-contained. Review it, apply it to that tool's tree,
deploy that tool the way you normally do.

| Patch | Files | Change | Adds |
|---|---|---|---|
| `client-health-sso.patch` | 5 | +470 / −28 | grant gate, no-access page, embed cookie |
| `analytics-sso.patch` | 3 | +453 / −16 | the same, keeping its own cookie working |
| `agent-search-sso.patch` | 2 | +181 / −0 | the first authentication this service has ever had |
| Master Inbox | — | — | not started, deliberately last |

```bash
cd <the tool's directory>
git apply --check /path/to/patches/<name>.patch   # dry run first
git apply         /path/to/patches/<name>.patch
```

### Why Master Inbox is last

Do **not** replace its session. 51 files read through Supabase's RLS-bound
client, and the policies key off `auth.uid()`. Swap that cookie and every query
returns **zero rows with no error** — the inbox renders empty and reads as a
data bug rather than an auth one. The plan is a `/sso/bootstrap` route that
verifies `bs_sso` and then mints a real Supabase session, leaving RLS and all 60
`requireSession()` call sites untouched.

---

## Environment

See `.env.example`. Nothing in it is a real value.

| Variable | Required | What |
|---|---|---|
| `AUTH_SECRET` | yes | signs tokens. Every other app gets the **same value** as its `BS_SSO_SECRET` |
| `AUTH_USERS` | yes | `email:sha256hex` pairs — who may sign in |
| `BS_GRANTS` | no | `email:tool,tool` per line — who may open what |
| `SSO_COOKIE_DOMAIN` | production | `.brokerstaffer.com`. **Leave unset locally** — localhost has no shared apex, and setting one silently drops the cookie |
| `MASTER_INBOX_URL`, `CLIENT_HEALTH_URL`, `ANALYTICS_URL`, `SCRAPER_URL` | yes | the tools the status board reads |

Generate a password hash:

```bash
npm run hash -- 'the-password'
```
