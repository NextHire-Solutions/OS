# BrokerStaffer OS — Developer Handover

**Written 25 September 2026. Re-verified 26 September.** Every number here was
measured live against the four production databases, not remembered. Where a
figure will age, the query that produced it is given so you can re-run it.

---

## Contents

| | |
|---|---|
| **0** | [Read this first](#0-read-this-first) — what this project is, in five minutes |
| **1** | [The estate](#1-the-estate) — repos, Railway projects, hosts, credentials |
| **2** | [Deploying anything](#2-deploying-anything) — the command, and three traps |
| **3** | [The OS itself](#3-the-os-itself) — routing, auth, connectors, schedulers, data model |
| **4** | [Every page in the OS](#4-every-page-in-the-os) — all 34 destinations, screen by screen |
| **5** | [The client's document, section by section](#5-the-clients-architecture-document-section-by-section) — Objective and §1–§23 |
| **6** | [What is left](#6-what-is-left) — grouped by who can unblock it |
| **7** | [Runbook](#7-runbook) — re-measure, read the roster, change a status, add a client |
| **8** | [Traps that have already cost time](#8-traps-that-have-already-cost-time) |
| **9** | [Open questions for the client](#9-open-questions-for-the-client) |
| **10** | [Reference](#10-reference) |

If you read only two things: **§0** for orientation and **§6** for what to pick
up on day one.

---

## 0. Read this first

BrokerStaffer runs its client operations on five separate web tools. Each one
grew its own client list, its own "Add Client" button and its own idea of a
client's status. The client wrote a 23-section specification —
*Client Data & Platform Architecture* — whose thesis is one sentence:

> ONE CLIENT → ONE MASTER RECORD → ONE SOURCE OF TRUTH → MULTIPLE CONNECTED TOOLS

and whose stated objective is blunt about what that means:

> The objective is not simply to "connect" our tools.
> The objective is to eliminate the concept of separate client databases.

**BrokerStaffer OS** (`os.brokerstaffer.com`, this repo) is the answer to that
specification. It is a Next.js app that does two things at once:

1. **It is the master client system.** `os_clients` is the one client list.
   Every other tool's client row resolves back to a row in it. Status is set
   here and propagates outward.
2. **It is a workspace that re-implements the five tools' screens** over those
   tools' own databases, so people can work in one place.

The critical thing to understand before you change anything:

> **The five standalone tools are still live and clients still use them.**
> The OS did not replace them. It sits alongside them and shares their
> databases. A change that breaks a standalone tool breaks a customer.

Client portals in particular (`portal.brokerstaffer.com/<token>`) are used by
paying customers daily. **A portal token must never change** — a churned
client's portal URL still has to exist and simply refuse to open, so that
reactivating restores the same address.

### How the whole thing fits together

Read this bit slowly; everything else follows from it.

```
                      ┌──────────────────────────────┐
                      │   os_clients  (52 rows)      │   ← THE master list
                      │   name · status · aliases    │     lives in Master
                      │   mi_id · ch_id · an_id      │     Inbox's database
                      │   orch_id · §6 fields        │
                      └───────────────┬──────────────┘
                                      │  one row links to each tool's row
        ┌───────────────┬─────────────┼─────────────┬──────────────┐
        ▼               ▼             ▼             ▼              ▼
   Master Inbox    Client Health   Analytics    Database      Onboarding
   + portals       (50 rows)       (53 rows)    (44 rows)     (orchestrator)
   (57 rows)
        │               │             │             │              │
        └───────────────┴─────────────┴─────────────┴──────────────┘
                                      │
                      ┌───────────────▼──────────────┐
                      │  BrokerStaffer OS            │  ← one workspace that
                      │  os.brokerstaffer.com        │    renders all of them
                      └──────────────────────────────┘
```

**The row counts differ on purpose, and the arithmetic balances.** This is the
first question everybody asks, so here it is in full — measured 26 Sep:

| Tool | Rows | = clients | + second rows | + not a client | clients absent |
|---|---|---|---|---|---|
| Master Inbox | **57** | 51 | 2 | 4 | 1 |
| Client Health | **50** | 50 | — | — | 2 |
| Analytics | **53** | 48 | 2 | 3 | 4 |
| Database app | **43** | 43 | — | — | 9 |

* **"Not a client"** — `Demo Portal`, `New client portal`, `Test FUB`,
  `Unknown`, `ZZ Portal Delete Test`. ⚠️ Demo Portal backs the live demo portal:
  **do not delete it.**
* **"Second rows"** — one client, two markets. Properties & Estates (Boston +
  Florida) and SERHANT. PA (base + "15M+"). Legitimate, and the subject of the
  open question in §6.4. The one that was an accident — the Database app's
  `Camelot Realty` beside `Camelot Realty Group` — was deleted on 26 September,
  which is why that tool now reads 43 = 43 exactly.
* **"Absent"** — every one is a churned, paused or still-onboarding client.
  **Not one active client is missing from any tool**; all 32 are in all four.

§2 sets the test as "never 40 in one system, 38 in another". What it actually
asks is that every tool can *identify the same clients* — which holds. The
Consistency screen now proves it row by row rather than asking you to trust it.

**Two jobs in one app.** The OS is simultaneously:

1. **The master system** — it owns `os_clients`, and status set here propagates
   outward to the other tools and to the customer's portal.
2. **A workspace** — it re-implements the five tools' screens over *those
   tools' own databases*, so staff work in one place instead of five.

Job 2 is why this repo is 152,000 lines. Job 1 is what the client's document is
actually about.

**Nothing was switched off.** All five standalone tools are still deployed and
still used — by staff and, in the portals' case, by paying customers. The OS
shares their databases rather than replacing them. That constraint explains most
of the design decisions you will find odd otherwise.

### Vocabulary

| Term | Means |
|---|---|
| **Master record** | a row in `os_clients` — the one canonical client |
| **Tool row** | that client's row inside Master Inbox / Client Health / Analytics / Database |
| **Link** | an id column on the master record pointing at a tool row (`mi_client_id`, `ch_client_id`, `an_client_id`, `orch_client_id`) |
| **Alias** | another spelling of a client's name, recorded so tools that match by name still resolve. 21 spellings across 19 clients |
| **Propagation** | writing a status change outward to every tool that needs it (`status-propagate.ts`) |
| **Drift** | the tools disagreeing — different status, a missing row, a duplicate, an unknown spelling |
| **Portal** | the customer-facing page at `portal.brokerstaffer.com/<token>`. One client can have several |
| **Lifecycle status** | onboarding / active / paused / churned — *is this still a client?* |
| **Onboarding status** | the Database app's pipeline stage — *how far through setup are they?* Different question, and the two both use the word "paused" |

> The last two rows of that table are the single most common source of
> confusion in this codebase. They are different fields with overlapping
> vocabulary, and §8 of the client's document asks for **both** to be visible.

### Where the project stands in one line

Scored against §22, the client's own Definition of Done: **18 of 25
requirements met**, 5 partly met, 2 not met. Neither unmet requirement is
blocked on engineering — see §6 of this document.

---

## 1. The estate

### 1.1 Repositories — every link your team needs

**Everything now lives in the `NextHire-Solutions` GitHub org.** The old
`brokerstaffer` org no longer lists these repos; git still pushes through the
redirect and prints *"This repository moved"*, which is harmless.

| Repo | Link | Runs as | Cloned on this machine |
|---|---|---|---|
| **OS** | https://github.com/NextHire-Solutions/OS | `os.brokerstaffer.com` | `~/Desktop/Code/brokerstaffer-os` |
| **Masterinbox** | https://github.com/NextHire-Solutions/Masterinbox | `inbox.` + `portal.brokerstaffer.com` | `~/Desktop/Code/Corofy/Master Inbox` |
| **Campaign-tool** | https://github.com/NextHire-Solutions/Campaign-tool | `analytics.brokerstaffer.com` | `~/Desktop/Code/Corofy/Analytics Dashboard` |
| **Databaseproject** | https://github.com/NextHire-Solutions/Databaseproject | Database `web` service | `~/Desktop/Code/Corofy/Database` |
| **Scrapper** | https://github.com/NextHire-Solutions/Scrapper | `search.brokerstaffer.com` (agent-search) | not cloned |
| **Shaurs** | https://github.com/NextHire-Solutions/Shaurs | — | `~/Desktop/Code/Corofy/shaurs` |

> **Two repos are not accounted for above: Client Health and the Onboarding
> orchestrator.** Both are deployed and running, neither is cloned on this
> machine, and because no Railway service is GitHub-linked (see §2) the platform
> cannot tell you where their source lives either. **Ask the current owner for
> those two repository URLs before the handover completes** — without them, two
> live services have no reachable source.

> **All six repos are PUBLIC.** Verified 25 Sep. Nothing secret is committed in
> any of them — no `.env` file has ever been added to any repo's history, and
> the only matches for key-shaped strings are prefix checks
> (`key.startsWith("sk_live_")`) and test fixtures. So this is an intellectual
> property question, not a credential leak. It is still very likely unintended
> for a client operations platform: consider switching them to private.
> **Changing visibility does not require rotating any token.**

### 1.2 Live URLs

| Tool | URL |
|---|---|
| **BrokerStaffer OS** | https://os.brokerstaffer.com |
| Master Inbox | https://inbox.brokerstaffer.com |
| Client portals (customer-facing) | `https://portal.brokerstaffer.com/<token>` |
| Client Health | https://clients.brokerstaffer.com |
| Campaign Analytics | https://analytics.brokerstaffer.com |
| Onboarding | https://onboarding.brokerstaffer.com |
| Agent Search | https://search.brokerstaffer.com |
| Database app | https://web-production-34f4a.up.railway.app |
| Reply agent sandbox | https://sandbox-production-774c.up.railway.app |

### 1.3 Railway projects — dashboard links

Open any of these at `https://railway.app/project/<id>`.

| Project | Services | Project ID |
|---|---|---|
| **OS** | `os`, `mockup`, `graceful-purpose` | `dc38dde7-1233-4f24-a77a-44252e5199bd` |
| **Masterinbox + Client Portals** | `alluring-ambition`, `loopmessage-notifier` | `d9b691c5-6ade-47fa-a29e-af2f973b2558` |
| **Analytics Dashboard** | `analytics-web`, `analytics-cron` | `57444d94-d18f-4813-ba4a-f20451d6edb0` |
| **Health Dashboard** | `web`, `sync-worker` | `fb1fcda3-0fcf-4df4-8e93-15cbed90ed31` |
| **adorable-truth** (Onboarding) | `orchestrator`, `appealing-reprieve` | `fa436326-2dec-4404-aed4-cd606597c1c8` |
| **peaceful-purpose** (Agent Search) | `agent-search` | `0e42a605-7beb-4aef-98e9-1e3d0926c678` |
| **Database** | `web`, `enrich-worker`, `bison-cron`, `feisty-imagination` | `91332c4a-aa85-4709-84f2-8225e2e97c5b` |
| **Corofy Reply Agent Testing** | `sandbox` | `4d027a6c-ce87-4ef6-ba4c-83cf84f516d6` |

Note the Master Inbox service is called **`alluring-ambition`**, not anything
recognisable — Railway's generated name was never changed.

### 1.4 What to give a new team member

1. **GitHub** — membership of the `NextHire-Solutions` org (all six repos).
2. **Railway** — access to the eight projects above. Project *tokens* are
   per-project and cannot see each other, so give dashboard access rather than
   handing tokens around.
3. **Supabase** — four databases: Master Inbox's (which also holds every
   `os_*` table), Client Health's, Analytics', and the Database app's Postgres.
4. **BrokerStaffer OS login** — created in the OS itself at **Admin → Team
   access**. It shows a one-time password; it is never emailed, and the person
   changes it at `/account`. Grant the tools they need — the Owner always has
   all five.
5. **The `.env.local` files.** These are not in git (correctly). Copy them from
   the current machine, or pull each value from the Railway dashboard. `.env.example`
   in the OS repo lists and explains every variable.

### 1.5 Deployment state, 25 September 2026

| Service | Newest deployment | Note |
|---|---|---|
| OS / `os` | `904d3a77` · 25 Sep 12:09 | current |
| Analytics / `analytics-web` | `fa946db1` · 24 Sep 23:28 | current |
| Analytics / `analytics-cron` | `492b021d` · 24 Sep 23:43 | current |
| Client Health / `web` | `cd6153df` · 24 Sep 04:07 | current |
| Client Health / `sync-worker` | `5175db98` · 24 Sep 23:50 | current |
| Onboarding / `orchestrator` | `1d1eb000` · 3 Sep 23:25 | untouched since Sept 3 |
| **Database / `web`** | `85a45464` · 26 Sep 22:40 | current — the two commits are live and switched on |
| Database / `bison-cron` | `0f336b46` · 17 Sep 21:13 | `0 */6 * * *` |
| Database / `enrich-worker` | `fd0b5550` · 9 Sep 20:11 | |
| Agent Search / `agent-search` | `baf448b4` · 25 Sep 02:02 | serving; two FAILED builds sit above it in the list — see below |

> **Agent Search shows two FAILED deployments (25 Sep, 03:13 and 11:05).**
> They are harmless and they are mine: I deployed the wrong repository to that
> service while tracing which app served `search.brokerstaffer.com`. A failed
> build never replaces a running one, so `baf448b4` kept serving throughout and
> the site has been up the whole time (verified again 26 Sep: `/` and
> `/api/status` both 200). Leave them; they are history, not a fault.

#### Source state — everything is committed and pushed

Checked 25 Sep. Every repository on this machine is clean and level with
`origin/main`: nothing uncommitted, nothing unpushed.

| Repo | vs origin/main | Working tree | Newest commit |
|---|---|---|---|
| OS | level | clean | `4e74225` the handover document |
| Master Inbox | level | clean | `46ad797` |
| Analytics Dashboard | level | clean | `68ed3cb` the campaigns cache-key fix |
| Database | level | clean* | `ad78784` the Client status column |

\* one untracked file, `supabase/migrations/0089_location_exclude_antijoin.sql`,
which is **deliberately** untracked — see §2.4.

> **Pushed is not deployed.** Because nothing is GitHub-linked, the work above
> reaches GitHub but not the running services — every deploy is a deliberate
> `railway up`. As of 26 September everything committed is also deployed: the
> OS, Analytics, and the Database app (§6.1). Keep checking after a push, not
> assuming.

### 1.6 Credentials

Railway project tokens live in **two** stores and **neither is complete**:

| Store | Holds |
|---|---|
| `~/.brokerstaffer/railway.env` (chmod 600) | OS, Master Inbox, Analytics, Client Health, Sandbox, **Database**, plus `SERVICE_*` ids |
| `brokerstaffer-os/.env.local` | OS, Analytics, Client Health, **Onboarding**, **Agent Search** |

The two stores can hold **different values for the same project, and one can be
dead**. On 25 Sep the store's `RAILWAY_TOKEN_OS` was rejected
(`Invalid RAILWAY_TOKEN`) while `.env.local` held a working one. Compare by hash
before concluding anything. When a Railway command says **"Not signed in."**,
suspect the token, not the CLI.

App secrets (Supabase service keys, provider API keys) live in each repo's
`.env.local`. **Never print a secret value.** Copy Railway variables by name.

---

## 2. Deploying anything

### 2.1 The command

```bash
set -a; . ~/.brokerstaffer/railway.env; set +a     # or the OS repo's .env.local
cd "<repo>"
RAILWAY_TOKEN=$RAILWAY_TOKEN_<PROJECT> railway up --service <service> --ci
```

### 2.2 Three traps, all of which have bitten

**Trap 1 — pushing to `main` deploys NOTHING, anywhere in this estate.**

Checked service by service on 25 Sep across all eight projects: **not one
service is GitHub-linked.** Every deployment of every service — the OS, Master
Inbox, Analytics, Client Health, Onboarding, Agent Search, the Database app —
is a `railway up` CLI upload.

Two consequences, and the second is the dangerous one:

* A green push means nothing. The service keeps serving whatever was last
  uploaded. Always run `railway deployment list --service <s>` after a push.
* **The running image came off somebody's laptop**, so it may contain work that
  was never committed. Before you deploy over a service you did not deploy
  yourself, ask whoever last shipped it whether everything is pushed.

**Trap 2 — `railway up` uploads the WORKING DIRECTORY, not the commit.**
Check `git status` is clean and
`git rev-list --left-right --count origin/main...HEAD` is `0 0` first, or you
ship something other than what you pushed.

Do **not** use `railway redeploy` to ship a new commit — it redeploys the
*latest existing* deployment, which is the old code.

**Trap 3 — Railway builds fail spuriously.** On 25 Sep two OS builds were marked
FAILED while their own logs showed the image compiled, exported and pushed; a
plain retry succeeded. Before debugging your code, run `npm run build` locally;
if that is clean, retry the deploy once.

### 2.3 Health after deploying

`/` returns **307** (redirect to login) and `/login` returns **200**. An API
route answering **401** is correct, not a failure.

```bash
for p in / /login /consistency /clients /roster; do
  printf '%-14s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' https://os.brokerstaffer.com$p)"
done
```

### 2.4 Repo-specific notes

* **`Corofy/Database`** — `.railwayignore` excludes `.next`, `node_modules`,
  `.git`, `.env.local`, so stale local build output never ships. Local
  `tsc --noEmit` reports errors in `.next/types/routes.d 2.ts`, a macOS
  duplicate of a *generated* file — read past it, it is not source.
  `supabase/migrations/0089_location_exclude_antijoin.sql` is **deliberately
  untracked** (superseded by `0091`); commit `16bae22` is literally
  *"Untrack 0089 again — it was swept in by `git add -A`"*. **Never
  `git add -A` in that repo.**
* **A deploy never runs migrations** anywhere in this estate. Migrations are
  applied by hand.

---

## 3. The OS itself

### 3.1 Scale

| | |
|---|---|
| Source files | 909 `.ts`/`.tsx` |
| Lines of source | 152,185 |
| Test files | 103 |
| Tests | **1,131, all passing** |
| API routes | 217 |
| Migrations | 15 |

Test runner is **Node's built-in** (`node --test`) with type-stripping, so
TypeScript-only syntax that cannot be stripped is banned: no `enum`, no
constructor parameter properties, no `namespace`. `npm test`, `npm run typecheck`.
`eslint` is declared but not installed locally — typecheck and tests are the
real gates.

### 3.2 Routing and the shell

Everything renders through one catch-all: `src/app/[[...slug]]/page.tsx`.
**Every screen is mounted on every request** — the shell keeps them all alive so
switching is instant and costs no round trip (`workspace.tsx` navigates with
`pushState`).

> **Consequence you must respect:** a screen cannot assume the URL belongs to
> it. `ThreadDetail` once treated *any* UUID in the third segment as a thread
> id, so `/inbox/portals/<clientId>` handed a client id to `loadThreadDetail`,
> which called `notFound()` — and because it renders on every request, that
> 404'd the entire page including the portal screen that was meant to show.
> Guard on "is this URL actually mine?", never on shape alone.

The navigation tree is `src/lib/workspace/nav.ts` — one rail replacing each
tool's own navigation:

* **Workspace** — Home, Performance, Clients (`/roster`), Consistency
* **Products** — Master Inbox (6 leaves), Client Health (3), Campaign Analytics
  (8), Onboarding (4), Agent Search (5)
* **Admin** — Assistant, Team access, Reply agent

A leaf is a *destination*. Tabs that filter what you are already looking at stay
inside the tool. `verified: true` means the path was confirmed against the
running app rather than guessed.

The tool's own hostname never appears in the address bar.

### 3.3 Authentication

`src/proxy.ts` (Next 16 renamed middleware to `proxy`; same Edge execution
model) runs before every matched request and verifies the `bs_sso` cookie —
the same token every other BrokerStaffer app verifies. The OS issues it.

Three escape hatches, and the distinction between the last two has already
caused a production-only 401:

| Set | Auth | Why separate |
|---|---|---|
| public paths | none | `/login`, `/api/health` — Railway's healthcheck has no credential |
| `TOKEN_ROUTES` | `x-admin-token` **header** | server-to-server, e.g. the status feed Master Inbox reads |
| `CRON_BEARER_ROUTES` | `Authorization: Bearer` | cron |

> `TOKEN_ROUTES` matches on the **header**, not just the path. Listing a bearer
> route there means the check never matches and the caller gets a 401 from the
> proxy *before its own gate runs*. That is exactly what happened to the
> consistency check in production while every local test passed.

Renewal is **not** done in the proxy — the Edge has no access to the grant
store, and reissuing from stale claims would defeat the 30-minute revocation
window. The client posts to `/api/auth/refresh`, which does have the store.

Tools are `"inbox" | "clients" | "analytics" | "search" | "onboarding"`
(`src/lib/bs-auth.ts`). Grants live in `os_tool_grants`; users in `os_users`.
The Owner always has every tool. Invites show a one-time password and are never
emailed; everyone changes it at `/account`.

### 3.4 How the OS reaches the tools

Two different mechanisms, and the difference matters:

**(a) Connectors** — `src/lib/connectors/` — for status/health cards.
Five: `master-inbox`, `client-health`, `analytics`, `scraper`, `onboarding`.
The Database connector was **deleted rather than left dormant**: a dormant
connector is a file nobody runs, nobody tests and nobody notices rotting.

**(b) Direct database reads** — for the re-implemented screens. The OS holds
each tool's Supabase service key and reads the tool's own tables, then renders
its own UI. `src/lib/tools/{master-inbox,client-health,analytics,onboarding,agent-search}/`.

The OS's own tables live **inside Master Inbox's database**, reached through a
separate client (`src/lib/clients/os-db.ts`) from the read-only one used for
Master Inbox's tables. That separation is deliberate and load-bearing:

> Master Inbox's tables carry triggers that reach the outside world.
> `client_pipeline_intro_label_trigger` creates a pipeline row when a thread is
> labelled, and **that row appears in a customer's live portal**. The triggers
> fire for whoever writes, but the columns they depend on are set correctly only
> by the code that knows about them — so writes go through Master Inbox's own
> API, where its validation lives. `os_clients` and friends are different: new
> tables, no triggers, owned by the workspace. `src/lib/clients/os-tables.ts`
> enforces the allowlist so a client that can write our tables cannot write
> Master Inbox's forty.

**Portal writes (team / agents / DNC) go through the portal's own API**, never
straight to the table, because `enforceBlocklist()` must run first — it blocks
on Instantly and EmailBison *before* the row is written with its push flags.

### 3.5 Background work

The OS has **no Railway cron service**. Every absorbed schedule runs in-process,
started once per Node process from `src/instrumentation.ts`:

| Scheduler | Gate |
|---|---|
| Analytics sync | `ANALYTICS_ENABLE_SCHEDULER` |
| Client Health sync | `CLIENT_HEALTH_SYNC_ENABLED=1` |
| Master Inbox cron | `MASTER_INBOX_CRON_ENABLED` |
| Onboarding | `ONBOARDING_CRON_ENABLED` |
| **Reconcile / drift check** | `OS_RECONCILE_ALERT_ENABLED=1` — **currently OFF** |

They start at boot rather than lazily on first request because a lazy scheduler
does nothing until somebody opens the right screen after a deploy, and overnight
nobody does. Starting here means a deploy at 05:59 still fires the 06:00 slot.

Each uses the same shape: a `Symbol.for` process-wide slot, `setInterval`,
`timer.unref()` so the ticker never holds the process open, and an idempotent
`ensure*()`. Decisions are slot-based ("has anything run in this slot?"), not
"N minutes since last run", so cadence does not drift by each run's duration.

`instrumentation.ts` also warms one cache at boot: Open Responses walks every
open thread's labels and last message — 12–13 seconds, paid on every deploy's
first visit. It is computed 5 s after boot for every workspace, fire-and-forget.

### 3.6 Data model — the OS's own tables

| Migration | Adds |
|---|---|
| `0001` | `side_effect_outbox` — Master Inbox introduction side effects |
| `0002` | **`os_clients`** — the one client list, plus per-tool onboarding record |
| `0003` | `os_tool_grants` — Team access actually grants access |
| `0004` | `os_users` — invites |
| `0005`, `0007` | `os_client_contacts` — who an introduction is addressed to (up to three) |
| `0006` | reply intelligence — what the reply agent knows and learns |
| `0008` | draft verdict upsertable |
| `0009` | reply agent operating modes |
| `0010` | `v_reply_agent_stats` |
| `0011` | `os_client_aliases`, `os_assistant_chats`, `os_assistant_messages` |
| `0012` | **client lifecycle** — the spec's four statuses + `os_client_status_history` |
| `0013` | retire `prospect`, the old spelling of `onboarding` |
| `0014` | **`os_client_tool_exceptions`** — §17's intentional exceptions |
| `0015` | the six master-record fields that were recorded nowhere |

Key columns on `os_clients`: `name`, `status`, `aliases`, `slug`,
`mi_client_id`, `ch_client_id`, `an_client_id`, `orch_client_id`, plus the §6
fields `market`, `mls`, `area`, `sender_name`, `salesperson`, `account_manager`,
`brokerage`, `timezone`, and three contact triplets.

`0014`'s reason column is `NOT NULL CHECK (btrim(reason) <> '')` — an exception
with no reason is indistinguishable from the forgetfulness the table exists to
rule out, so the database refuses it rather than storing a blank that looks
intentional on screen.

> **Migration discipline:** expand/contract. `0012` added the status column and
> backfilled; `0013` tightened only after every writer had been deployed. Adding
> a constraint in the same migration that adds the column will lock out the
> running app.

---

## 4. Every page in the OS

There are **34 destinations in the rail**, plus detail screens reached from
them, plus 8 Master Inbox settings tabs. Every screen is server-rendered from
the same data the API serves, so the first paint already carries real numbers.

**Every screen below is mounted on every request** (§3.2). All screen source is
under `src/components/screens/`.

### 4.1 Workspace — the four screens the OS itself owns

These are the only screens that are *not* a port of an existing tool. They are
the architecture document made visible.

| Page | Route | What it does | File |
|---|---|---|---|
| **Home** | `/` | Tool cards with live numbers, read from the same status store the API serves — useful before any JavaScript runs. Headline card summarises the estate. | `home.tsx`, `overview-card.tsx` |
| **Performance** | `/performance` | Client base, plans and movement. Greys out clients who are not contributing, by design. | `performance.tsx` |
| **Clients** (the roster) | `/roster` | **The spine of the whole project.** One row per client; the columns are what each tool knows about them. Status, plan, billing interval and next billing date, links to each tool's row. Add / Edit / Delete / Onboard / People all hang off it. | `clients.tsx` |
| **Consistency** | `/consistency` | §16 made visible. Opens with **Client counts** — why each tool's total is not 52, as arithmetic that must balance — then status conflicts, coverage gaps with written reasons, duplicates, broken links, alias drift. **Designed to be boring**: it should say "all explained" almost always. | `discrepancies.tsx` |

Sub-screens of the roster:

| Panel | What it does | File |
|---|---|---|
| Edit client | Every master-record field (§6), with `Intl`-validated timezone and name suggestions drawn from values already in use | `clients-edit.tsx` |
| Onboard client | The form, and **the plan it produces** — you see what will be created in each tool before anything is written | `clients-onboard.tsx` |
| Delete client | Guarded; deletion is rare and never the answer to churn | `clients-delete.tsx` |
| **People** | A client's team, agents and do-not-contact list, **shown and edited here** — §23's "open one system and know their team". Two-way: writes go through the portal's own API so `enforceBlocklist()` runs first | `clients-people.tsx` |

> Consistency was routed here until a refactor on 11 Sep dropped the import, and
> the screen was unreachable for weeks — including the status-conflict, coverage
> and link-integrity checks added to it later. **A screen nobody can open cannot
> report anything.** It is back in the rail; keep it there.

### 4.2 Master Inbox — 6 rail destinations + 2 detail screens + 8 settings tabs

The tool's own navigation was an icon rail plus a sidebar plus a second settings
sidebar. It collapses into six rail entries.

| Page | Path | What it does | File |
|---|---|---|---|
| All Email | `/inbox/all-email` | The conversation list, with unread badge | `master-inbox/full-inbox.tsx` |
| Reminders | `/reminders` | The tool's own page — **replaced a hand-written screen that listed reminders and could not dismiss them** | `master-inbox/reminders.tsx` |
| Archive | `/inbox/archive` | Archived conversations | (full-inbox view) |
| Trash | `/inbox/trash` | Third folder; without this entry a trashed conversation could only be found by typing the URL | (full-inbox view) |
| **Client Portals** | `/portals` | The admin table of which clients have a portal. The portals themselves live on `portal.brokerstaffer.com` and are deliberately outside the workspace | `master-inbox/portals.tsx` |
| Settings | `/settings/clients` | Eight pages behind the tool's own sub-navigation | `master-inbox/settings.tsx` |

Detail screens (no rail entry):

* **Thread detail** — one conversation, ported line-for-line. This is where the
  Introduce macro and the reply agent's drafts appear. `master-inbox/thread-detail.tsx`
* **Portal detail** — the staff drill-down for one client's portal.
  `master-inbox/portal-detail.tsx`

Settings tabs (`master-inbox/settings-tabs/`): `clients`, `labels`, `members`,
`personal`, `templates`, `ai-labeling`, `reply-agents`, `webhooks`.
**Webhooks is built but not offered in the strip, at the user's request** — the
component and its route still exist.

*Leads* was removed at the user's request: `/roster` is the roster now. Its
route still resolves, so an old bookmark degrades to All Email rather than 404s.

### 4.3 Client Health — 3 destinations

In the live tool these are three states of one page with **no URL of their
own**. Here each is a real address, which is what lets the rail link straight to
Bi-Weekly and the back button work.

| Page | Path | Question it answers | File |
|---|---|---|---|
| **Weekly** | `/` | Did we deliver this week? The design's own cards, table and class names; 24 summary cards (Status, Performance, Funnel Lifetime, Funnel Week) | `client-health/weekly.tsx` |
| **Bi-Weekly** | `/?view=biweekly` | **Who bills next, and are they owed introductions when it happens?** | `client-health/biweekly.tsx` |
| **Client Success** | `/?view=success` | The relationship lens, independent of throughput | `client-health/success.tsx` |

Shared: `filter-bar.tsx` (one `visible` list feeds all three, because the tool
shares it), `toolbar.tsx` (← / This Week / → / Today / + Add Client / Sync now),
`summary-cards.tsx`, `client-modal.tsx` (every field the tool's modal has, plus
a read-only **"Also known as"** showing campaign aliases), `campaigns-popup.tsx`
(every campaign linked to a client — the Weekly row only shows what is
*running*, which is the tool's spec), `sync-button.tsx`, `sync-scheduler.tsx`,
`frame.tsx`, `dialog.tsx`, `toast.tsx`.

### 4.4 Campaign Analytics — 8 destinations + campaign detail

| Page | Path | What it shows | File |
|---|---|---|---|
| Campaign | `/analytics/campaign` | KPI band over a segmented control | `analytics/campaign.tsx` |
| Volume | `/analytics/volume` | How much the estate can send, and where what goes | `analytics/volume.tsx` |
| Infrastructure | `/analytics/infrastructure` | The sending estate, lifetime | `analytics/infrastructure.tsx` |
| Attribution | `/analytics/attribution` | What the sending actually produced | `analytics/attribution.tsx` |
| Copy & Offer | `/analytics/copy-offer` | Which words work, and which offers work | `analytics/copy.tsx` |
| Campaigns | `/analytics/campaigns` | Every campaign on both platforms | `analytics/campaigns.tsx` |
| Schedule | `/analytics/schedule` | What goes out next — a different question from "how did it do" | `analytics/schedule.tsx` |
| **Clients** | `/analytics/clients` | **The most consequential screen in the product to get wrong** — it is where campaigns are attributed to clients | `analytics/clients.tsx` |

**Campaign detail** (`analytics/campaign-detail.tsx`) has **no nav destination**
— it is the drill-down from Campaigns. It carries the write-heavy features:

`sequence-editor.tsx`, `copy-sequence-dialog.tsx`, `push-sequence-dialog.tsx`,
`bulk-deploy.tsx`, `fan-out-dialog.tsx` (one campaign per client),
`re-campaign-dialog.tsx` (duplicate and load with the people who never
answered), `assign-inboxes-dialog.tsx`, `remove-leads-dialog.tsx`,
`campaign-leads.tsx`, `email-panel.tsx`, `copy-tags-panel.tsx`.

Two notes for whoever works here:

* `chart.tsx` draws the time series **as hand-written SVG** — the tool uses
  Recharts, the workspace has no charting library.
* `staleness-strip.tsx` exists because every number on these screens is a
  **cached copy** of EmailBison and Instantly. Always show how old it is.
* `filters.tsx` is the one place this port deliberately deviates from the tool.

### 4.5 Onboarding — 4 destinations + client detail

The orchestrator keeps running untouched: it receives the Typeform, Stripe and
Calendly webhooks. These screens read its database.

| Page | Path | What it does | File |
|---|---|---|---|
| Pipeline | `/` | The onboarding pipeline | `onboarding/pipeline.tsx` |
| Stages | `/stages` | The stage board | `onboarding/stages.tsx` |
| Templates | `/templates` | Message templates | `onboarding/templates.tsx` |
| Settings | `/settings` | Five panels | `onboarding/settings.tsx` |

**Client detail** — `/onboarding/clients/<id>` with three tabs (`leads`,
`agents`, `team`) plus the profile. `onboarding/client.tsx`, `client-tabs.tsx`,
`client-steps.tsx`, `client-fields.tsx` (the MLS they recruit in, and custom
fields), `photo-input.tsx`, `replies-panel.tsx`.

> This screen was unreachable for a while: `idForPath` resolves
> `/onboarding/clients/<id>` to `onboarding:pipeline` (deliberately, so the rail
> stays highlighted on Pipeline), and the router rendered the pipeline over the
> top of it. Thirty-eight clients you could move between stages and not open.
> Fixed; the routing exception is in `[[...slug]]/page.tsx`.

### 4.6 Agent Search — 5 destinations

| Page | What it does | File |
|---|---|---|
| Search | The tool's main card plus its three result panels | `agent-search/search.tsx` |
| Master List | The de-duplicated view across all three sources (`buildMaster`, ported verbatim) | `agent-search/master.tsx` |
| Courted accounts | Add a login, choose what to import, start the sweep | `agent-search/accounts.tsx` |
| MLS monitor | Which MLSs each Courted account can see, and what changed | `agent-search/mls.tsx` |
| Import Profile URLs | The F1 enrichment flow — paste a Google Sheet or CSV of Zillow / Realtor profile URLs | `agent-search/import.tsx` |

### 4.7 Admin — 3 destinations

| Page | Route | What it does | File |
|---|---|---|---|
| **Assistant** | `/assistant` | Cross-product assistant with stored chats; can answer questions across all tools | `assistant.tsx`, `assistant-markdown.tsx` |
| **Team access** | `/admin/team` | Who may open which tool. Backed by `os_users` + `os_tool_grants`; invites show a one-time password and are never emailed | `team-access.tsx` |
| **Reply agent** | `/reply-agent` | What the agent knows, whether it is working, and its configuration — modes, clients, questions, handover, schedule | `reply-agent.tsx`, `reply-agent-config.tsx` |

### 4.8 Account and Login

| Page | Route | What it does |
|---|---|---|
| Account | `/account` | The one screen about the signed-in person, not the business. Today: their password. |
| Login | `/login` | Issues the `bs_sso` cookie every other BrokerStaffer app verifies. Public. |

### 4.9 What is deliberately NOT in the OS

* **The individual client portals** (`portal.brokerstaffer.com/<token>`) — they
  are customer-facing and stay outside. The admin list of them is in scope.
* **The Database app's own screens** (`/search`, `/import`, `/webhooks`) — the
  Database connector was deleted rather than left dormant, and the Database app
  keeps its own UI. The OS's Agent Search screens are a different application.
---

## 5. The client's architecture document, section by section

Status key: **✅ done** · **◐ partly** · **✗ not done**.
Every figure measured 25 Sep 2026.

### Objective — *eliminate the concept of separate client databases* ◐

Achieved for **client identity and client status**: one master list, every tool
row resolves to it, a status set once travels to the other tools and to the
portal. Not achieved for **billing** — Stripe still hangs off the onboarding
tool's table. Elsewhere progress is limited less by architecture than by empty
fields (§6).

The four problems named in the opening — unnecessary manual work, inconsistent
data, conflicting statuses, different client counts — are each now either fixed
or visible on screen with a reason attached.

---

### §1 Our Current Tools — context

| Tool | In the OS |
|---|---|
| Master Inbox | ✅ full set of views |
| Client Health Dashboard | ✅ Weekly, Bi-Weekly, Client Success |
| Client Portals | ✅ managed from the OS — **38 open, 19 closed** |
| Analytics | ✅ eight views |
| Database / Agent Search | ✅ search, master list, MLS monitor |
| Onboarding | ✅ pipeline, stages, templates |
| Commission Tracker | ✗ does not exist yet — §18 covers how it would connect |
| Future CRM / CSM | ✗ do not exist yet |

---

### §2 Layer One: ONE MASTER CLIENT LIST — ✅ (mostly)

`os_clients` **is** that list: **52 clients**, each with one unique ID.

The §2 checklist — "when a new client is onboarded, the system should
automatically…":

| Step | Status | Where |
|---|---|---|
| Create the master client record | ✅ | `lib/clients/os-clients.ts` |
| Create/connect in Master Inbox | ✅ | `lib/clients/onboard-run.ts` |
| Create/connect the Client Health record | ✅ | same |
| Create the Client Portal | ✅ minted immediately with its own token | `lib/portals/` |
| Make available in Analytics | ✅ | connector leg |
| **Create the Database record** | ✅ | `lib/clients/database-record.ts` |
| Create the appropriate saved view | ✗ | lives in the Database app — see §6.5 |
| Connect the client's leads | ◐ matched by name | Database app |
| Connect their campaigns | ◐ matched by name, not linked by ID | `lib/tools/analytics/` |
| Connect their Stripe subscription | ✗ | paused by the client |
| Commission Tracker record | ✗ | tool does not exist |

`database-record.ts` **reads before it writes** and links to an existing row
rather than creating a second one. Links today: **43 of 52** overall, **33 of
the 34 active/onboarding clients** — the remainder are churned clients that
never had a Database row.

**The critical requirement — one master list — holds, and the Consistency
screen now proves it.** The spec's test was that "40 in one system, 38 in
another, 42 in another" must never happen. The four tools *do* report different
totals (57 / 50 / 53 / 44 against 52), so the screen opens with **Client
counts**, which states the arithmetic per tool and requires it to balance:

> rows in the tool = rows belonging to a client + a second row for a client that
> already had one + rows that are not a client at all, each named.

All four balance today. Every absence is a churned, paused or still-onboarding
client; not one active client is missing anywhere. The only rows belonging to no
client are five named non-clients: `Demo Portal`, `New client portal`,
`Test FUB`, `Unknown`, and a parked Analytics deletion test.

Code: `lib/reconcile/counts.ts` (pure, 10 tests) and `gatherCountReport()`.

> **Demo Portal must not be deleted** — it backs the live demo client portal.

One deliberate exception to "one place to create a client": the standalone tools
keep their own Add Client buttons, because they stay live and clients use them.

---

### §3 Client Status — ✅

Exactly the four statuses, and no others. A database constraint rejects any
other word, so the vocabulary cannot drift again; it replaced an older
five-status scheme that included "prospect" (`0013`).

| Status | Clients |
|---|---|
| Onboarding | 2 |
| Active | 32 |
| Paused | 8 |
| Churned | 10 |
| **Total** | **52** |

---

### §4 Layer Two: ONE CENTRALIZED CLIENT RECORD — ◐

The five "where do we update it?" questions now have single written answers:

* **Master record** — Account Manager, Salesperson, Sender, Market, MLS, Area
* **Master Inbox** — Team, Agents, DNC
* **Client Health** — Plan, targets, timezone, billing dates

**What is missing is not structure but data** (§6).

One finding worth keeping: the duplication this section warns about was **mostly
an illusion**. Measured field by field, four of the six supposedly contested
fields were only ever maintained in one place. Two corrections came out of that
exercise — Team, Agents and DNC belong to **Master Inbox**, not Onboarding as
first assumed.

---

### §5 Centralized Does NOT Mean Everything Appears Everywhere — ◐

Honoured by design: each tool keeps a purpose-built view and pulls from the same
record. Billing does not appear in the Database view; campaigns do not appear in
the portal; individual leads do not appear in Client Health.

The section's three worked examples:

| Example | Status |
|---|---|
| Change Account Manager once → every tool updates | ✗ **cannot be demonstrated — 0 of 52 clients have one** |
| Change the DNC list once → every system receives it | ✅ Master Inbox owns it, the portal reads it |
| Change the status once → all platforms update | ✅ verified, §10 |

---

### §6 Master Client Record — ◐ structure complete, data nearly empty

Every field in the section's four categories has an owner. "Owned elsewhere" is
deliberate: copying a field onto the master record would re-create the problem
the document exists to solve.

**Client Information**

| Field | Owner | State |
|---|---|---|
| Client ID | Master record | ✅ 52 / 52 unique |
| Client name | Master record | ✅ complete |
| Status | Master record | ✅ complete, constrained |
| Plan | Client Health | ✅ owned there, shown on the OS record |
| Start date | Client Health | ✅ |
| Onboarding date | Master record | ✅ in status history |
| Date added | Master record | ✅ |
| Market | Master record | ◐ **1 / 52** |
| MLS | Master record | ✗ **0 / 52** |
| Area | Master record | ✗ **0 / 52** |
| Timezone | Client Health | ✅ |
| Team / Agents / DNC | Master Inbox | ✅ |
| Sender | Master record | ✗ **0 / 52** |
| Salesperson | Master record | ◐ **3 / 52** |
| Account Manager | Master record | ✗ **0 / 52** |
| Brokerage | Master record | ◐ 30 / 52 |

**Billing** — first billing date, anchor, interval, next billing date all owned
by Client Health ✅ (14- and 28-day both supported, plus monthly and custom).
**Stripe Customer ID and Subscription ID ✗ still on the onboarding table.**

**Campaign** — name ✅, aliases ✅ (owned by Client Health and treated as
identity), status ✅ live from the platforms, ID ◐ matched by name,
MLS/location ✗ 0 / 52 on the master record (1 of 44 rows in the Database app).

**Performance** — weekly and monthly targets ✅, introductions delivered,
replies, bounces, leads in review, leads exported ✅ all generated and fed back.

> The emptiness is the single biggest gap in the whole project, and it is data
> entry, not engineering. The edit dialog offers names already in use, so
> filling these in is mostly clicking. See §6.6 of this document.

---

### §7 Source of Truth — ✅

The section closes with *"this needs to become an actual data dictionary before
development is finalized."* It exists: **`docs/CLIENT-DATA-DICTIONARY.md`**,
**58 fields across 9 categories**, each with definition, source of truth, who
may edit, consuming tools, and whether syncing is required.

It also answers §7's fourth question — *what happens when it changes* — by
sorting every field into five behaviours: propagates automatically; written
straight to the owning tool on save; nothing propagates because the field is
read where it lives; recalculated by a job; and **nothing happens, and that IS
the gap**.

Several rows read ◐ because the owner is a specialist tool rather than the
master record. Each has exactly one owner and one place to edit it — which is
what the section actually asks for. Moving them onto the master record is a
further step, not a missing answer.

---

### §8 Tool-Specific Views — ◐

| Tool | State |
|---|---|
| **Database** | ◐ client, status, campaign, leads, sequencers, replies, bounces, in review, exported, onboarding status all present. **Client status** was missing and is now built (below). **MLS/location still 1 of 44** — so it cannot be filtered the way this section intends |
| Client Health | ✅ plan, status, targets, start date, billing anchor, interval, timezone, campaign, aliases, performance, health indicators |
| Client Portal | ✅ client/team, agents, DNC, client-facing introductions |
| Onboarding | ✅ client, team, agents, DNC, date added, progress, plus real plan and weekly target |
| Analytics | ✅ campaigns, introductions, replies, leads, campaign-level performance across eight views |
| Commission Tracker | ✗ does not exist |
| Future CRM / CSM | ✅ will connect to the master record and cannot do otherwise — §18 |

§8 lists **"Client status"** and **"Onboarding status"** as two separate fields
of the Database view, and only the second existed: `orch_clients.status` is the
*pipeline stage* (new → … → live → paused), which says how far through
onboarding a client is, not whether they are still a client. The two even share
the word "paused".

Built in `Corofy/Database` (commits `adada98`, `ad78784`): the old column is
renamed **Onboarding status**, and the client's lifecycle sits beside it as
**Client status** in the document's colours (§11). Unknown renders as "—",
never "active". **Live since 26 September — §6.1.**

---

### §9 Layer Three: Client Lifecycle — ◐

The four statuses are standardised platform-wide with one definition each. The
closing line — *"the exact operational behavior of each status needs to be
defined for every connected system"* — is answered system by system in
**`docs/STATUS-BEHAVIOUR.md`**:

| System | Behaviour |
|---|---|
| Client portal | ✅ opens on active, closes on paused and churned. **Onboarding deliberately leaves the portal exactly as it is** — a client being set up is neither running nor stopped, and portals are often opened during setup so the client can look |
| Client Health | ✅ a trigger keeps status and its two older booleans in step **in both directions**, so the tool's own screens keep working and neither can be left stale |
| Analytics | ✅ a trigger derives its active flag from status; **campaign history is never deleted**, which is what makes reactivation possible |
| Master Inbox | ✅ status drives whether the portal is open, and every client list shows 🟢 🟡 🔴 from the same feed |
| **Campaigns** | ✅ **decided and built — pause, never delete** |
| **Billing** | ✗ undecided, deliberately left manual |
| **Database / scraper** | ◐ now defined for lead *building*; scraping and enrichment still undefined |

**Campaigns** was the costliest open question and is now settled: a client going
paused or churned **pauses** its EmailBison and Instantly campaigns as a leg of
status propagation, and never deletes them. Pausing is reversible and keeps the
history, which is what makes §21 step 10 possible. Two limits: only campaigns
the platform will accept a pause for are touched (`canApply("pause", status)`
is true only for `active`, `queued`, `launching`), and a campaign is found by
**name**, so one named unlike its client is not matched.
Code: `lib/clients/pause-campaigns.ts`.

**Database / scraper**: the Database now refuses to attach newly imported agents
to a churned client, at the only writer of `orch_client_leads`. It reads status
from the OS rather than keeping a copy and **fails open** — an unreadable feed
never blocks an operator's import, because this is a tidy-up rule, not a safety
interlock. Still undefined: scraping and enrichment, which run on their own
workers and cost money per row.

---

### §10 Status Synchronization — ✅

Changing a status happens once and propagates: Client Health → Analytics →
client portal → campaigns. **The portal token is never changed by any status**,
so a churned client's URL still exists and simply refuses to open; reactivating
restores the same address.

Verified 25 Sep:

* Client Health — all **50** rows internally consistent (32 active, 10 churned,
  8 paused), zero disagreements between `status` and `client_paused`.
* Analytics — all **53** rows internally consistent; `status` and the `active`
  flag agree on every row.
* **Zero status conflicts against the master record**, confirmed two independent
  ways: the drift check reports 0 across all 52, and comparing every Analytics
  row to its master client by ID link and by alias separately finds 0.
* Works in both directions — a status set directly in a standalone tool still
  propagates, because the tools are not being switched off.

The four disagreements this section used to carry have cleared. Two were Master
Inbox's status column being read by nothing (it now drives the portal); two were
onboarding clients Analytics called active — Cardinal Realty Group and Brokerage
Realty, which have no Analytics or Client Health row at all yet. **An onboarding
client that has not been provisioned is an absence, not a conflict.**

Code: `lib/clients/status-propagate.ts` (four legs: `client_health`,
`analytics`, `portal`, `campaigns`), `lib/clients/status-feed.ts`,
`lib/portals/status-push.ts`.

---

### §11 Status Visuals — ✅

All six items standardised: status names (constrained at the database level),
**colours — paused orange, churned red, exactly as fixed here**, badges (one
component, one tone per status), filters, terminology ("prospect" retired), and
behaviour (§9).

Built on the pattern Master Inbox already used, as the section suggests.
**Scope note:** the shared language governs the OS. The standalone tools' own
interfaces were left untouched on instruction, because clients are actively
using them — so §22's "status colors/visuals are consistent across tools" reads
◐ rather than ✅ by deliberate choice, not oversight.

---

### §12 Layer Four: Dates & Billing — ◐

**The nine dates.** Onboarding, pause, churn and reactivation dates all exist:
every status change is written to `os_client_status_history` — **56 entries
covering all 52 clients** — and shows on the client record. Date added ✅.
First billing date, anchor, interval and next billing date ✅ — one owner
(Client Health), documented, not duplicated; 14- and 28-day both supported.

**Stripe → master client record: ✗ not connected.** Stripe still hangs off the
onboarding tool's own table, and only for clients who came through Typeform
intake. The chain the section asks for — Client → Billing → Subscription →
Billing Dates — is not yet one chain. This is the main remaining gap in Layer
Four and the one §22 billing requirement that fails.

Billing's *reaction* to a status change is deliberately not automated: a wrong
churn flag that cancels a subscription cannot be undone by flipping the flag
back.

---

### §13 What We Do NOT Want — 13 of 14 addressed

The only one still true is **"an Add Client button in every tool"**, and it is
true deliberately — the standalone tools stay live and clients use them.
Removing those buttons is a decision about switching tools off, not missing
engineering.

The rest: manual duplicate creation ✅, different counts ✅ (all 32 active
clients present in all four tools), different statuses ✅ (zero conflicts),
different billing dates ✅ (one owner, so they cannot differ), different client
information ✅, manual multi-system updates ✅ (true for status), remembering
which systems need updating ✅, separate versions of the same client ✅, a
client in one system but not another without an obvious reason ✅ (**0
unexplained**), a new tool creating another client database ✅ (enforced in
code, §18), different terminology ✅, different visual indicators ✅, manual
synchronization ✅.

---

### §14 What We DO Want — 13 done, 5 partly

| # | Want | State |
|---|---|---|
| 1 | One master client list | ✅ 52 clients |
| 2 | One unique Client ID | ✅ 52 / 52 |
| 3 | One master client record | ✅ |
| 4 | One source of truth per field | ✅ 58 fields documented |
| 5 | One place to create a client | ✅ in the OS |
| 6 | Automatic creation/connectivity across all required tools | ◐ **5 of 7 systems** |
| 7 | Automatic sync when client info changes | ◐ status yes, other fields not yet |
| 8 | Automatic status synchronization | ✅ verified |
| 9 | Consistent status colours and visuals | ✅ in the OS |
| 10 | Centralized billing information | ◐ one owner, Stripe unlinked |
| 11 | Centralized client/team/agent/DNC | ✅ Master Inbox owns it |
| 12 | Centralized campaign relationships | ◐ matched, not linked by ID |
| 13 | Tool-specific views | ✅ |
| 14 | Master vs tool-specific data distinction | ✅ the dictionary draws it |
| 15 | A way to detect synchronization errors | ✅ Consistency screen + daily check |
| 16 | A way to identify which system owns each field | ✅ |
| 17 | An explicit exception process | ✅ `os_client_tool_exceptions`; built, no entries needed yet |
| 18 | Scalable for future CRM/CSM/Commission | ◐ enforced in code, unproven until one connects |

---

### §15 Master Client Data Dictionary — ✅

A gate on the whole project — *"before this architecture is considered
complete"*. Delivered: `docs/CLIENT-DATA-DICTIONARY.md`, **58 fields in nine
categories**, each with the five columns asked for.

It covers Database, Master Inbox, Client Health, Client Portal, Onboarding,
Stripe and Analytics, with Commission Tracker, CRM and CSM listed as future
consumers.

Writing it forced the answer to the section's "most important question" and
twice corrected a belief we had been working from.

---

### §16 Error Detection & Reconciliation — ✅ (one switch left)

The section asks for two things:

> "We need to know **immediately** that there is a synchronization problem."
> "We should **not** have to discover these issues manually."

**The Consistency screen** (`/consistency`) answers the first. It reports the
section's exact scenarios — the count mismatch and the
"Active in Master / Paused in Database / Active in Health / Missing from Portal"
case. The screen went from 34 one-sided differences down to 10, each now
carrying a written reason, so the badge reads "All explained" rather than a
count nobody can act on.

Six checks, all green today across 52 clients:

| Check | Today | Code |
|---|---|---|
| Sync status / last synchronized | ✅ | `lib/reconcile/` |
| Error state, failed connection | ✅ | `connectors/failure.test.ts` |
| Missing record (with stated reason) | ✅ 0 unexplained | `lib/reconcile/coverage.ts` |
| **Duplicate record** | ✅ 0 | `lib/reconcile/duplicates.ts` |
| Conflicting data | ✅ 0 | `lib/reconcile/status-conflicts.ts` |
| Alias drift | ✅ 0 | `lib/reconcile/alias-drift.ts` |
| **Client counts reconcile** | ✅ all four balance | `lib/reconcile/counts.ts` |

**The second line — not discovering manually — was unmet in practice until 25
Sep.** `/api/cron/reconcile-alert` existed and worked, but appeared in exactly
two places in the repo: the proxy's auth table and its own route. Nothing ever
called it. Its own comment said "schedule it like the other crons"; no cron
existed.

Now: `lib/reconcile/schedule.ts` + `scheduler.ts`, registered in
`instrumentation.ts`, running daily. The gather-and-decide logic moved into
`lib/reconcile/run.ts` so the route and the clock cannot drift apart. 20 tests.

**It ships switched off, and needs one decision from the client** — see §6.4.

---

### §17 Exceptions — ✅

`os_client_tool_exceptions` (migration `0014`) implements
*Client exists in master system → Tool connection = Yes/No, and if No a clear
reason*. A row per (client, tool), not a column per tool, so a new tool needs no
schema change. The reason is `NOT NULL` and non-blank by constraint.

Built; no entries have been needed yet, because every current absence is
explained by a standing rule.

---

### §18 Future-Proofing — ✅

*New Tool → Connect to Master Client Record → Define Required Fields →
Automatically Sync* is **enforced in code, not merely intended**: a new tool
connects through the connector registry and the OS tables allowlist, and there
is no path by which it can mint its own client list and be accepted by the
Consistency screen.

Unproven only in the sense that no new tool has connected yet.

---

### §19 The Core Architecture — 5 of 6 bands

| Band | State |
|---|---|
| **Client Identity** — name, ID, status, plan, dates | ✅ |
| **People & Relationships** — salesperson, AM, team, agents, DNC | ◐ Team/Agents/DNC resolve through the record; Salesperson and Account Manager have a home and almost no data |
| **Billing** — Stripe, anchor, interval, next date | ✗ Stripe attached elsewhere |
| **Campaigns** — ID, name, aliases, MLS, sender | ◐ the link is now RECORDED as an id (26 Sep, migration 0122) — 217 of 256 campaigns stamped; the matcher still *derives* it from the name, and 17 client-shaped campaigns resolve to nobody |
| **Operational Data** — leads, replies, bounces, sequencers, exports | ✅ |
| **Performance** — targets, introductions, analytics, health | ✅ |

---

### §20 The Simplest Way to Think About This — ✅ as a model

One client → one master record → all data → each tool displays the part it
needs. That is what the OS implements, and the tools are genuinely different
interfaces into the same client ecosystem.

---

### §21 The Ideal Workflow — 7 of 10 steps

| Step | State |
|---|---|
| 1 Create Client, once, from the master system | ✅ |
| 2 Master Record Created — unique Client ID | ✅ 52 / 52 |
| 3 Automatic Connections | ◐ Master Inbox, Portal, Client Health, Analytics and the Database record are automatic; **Stripe is not**, and campaigns are matched by name rather than connected |
| 4 Client Data Added | ✅ |
| 5 Tools Populate Automatically | ✅ |
| 6 Client Changes — the change is made once | ◐ status yes; other fields still tool-by-tool |
| 7 Automatic Propagation | ◐ status propagates; other centralized fields do not yet |
| 8 Client Pauses — every relevant system reflects it | ◐ portal, Client Health, Analytics and campaigns do; **billing does not** |
| 9 Client Churns — every relevant system reflects it | ◐ the same four do; **billing does not** |
| 10 Reactivation — the same record is reactivated | ✅ and the portal URL still works |

Steps 8 and 9 are now held back **only** by the billing decision.

---

### §22 Definition of Done — 18 of 25 (72%)

| Group | Met |
|---|---|
| Client Creation | 2 of 4 |
| Client Data | 2 of 3 |
| Client Status | 2 of 3 |
| Billing | 2 of 3 |
| Tool Synchronization | **5 of 5** |
| User Experience | 3 of 4 |
| Future Tools | 2 of 3 |

**The two unmet:**

1. *We no longer need independent Add Client buttons across tools* — deliberate.
2. *Stripe is connected to the correct client record* — paused by the client.

**The five partly met:** creating a client connects 5 of 7 systems; changes to
centralized fields propagate (status does, the rest wait on data); status
colours are consistent in the OS but standalone UIs were left alone on
instruction; team members do not re-enter the same information (true for status,
some fields still entered twice); the architecture scales without manual sync
work (enforced in code, unproven until a new tool connects).

---

### §23 Final Principle — *control the client list from one place* — ◐

Open one system (`/roster`) and know:

| | |
|---|---|
| Exactly who our clients are | ✅ 52, one list |
| Their current status | ✅ |
| Their lifecycle dates | ✅ |
| Their assigned team | ✅ |
| Their agents | ✅ |
| Their campaigns | ✅ |
| Their relevant operational information | ✅ |
| Their plan | ✅ shown on the record, read through from Client Health |
| Their billing information | ◐ interval and next date shown; **Stripe unlinked** |
| **Their account manager** | ✗ **nobody has one — 0 of 52** |

CREATE ONCE → CONNECT EVERYWHERE ✅ (5 of 7 systems) ·
CHANGE ONCE → UPDATE EVERYWHERE ◐ (status yes) ·
PAUSE ONCE → PAUSE EVERYWHERE ✅ (except billing) ·
CHURN ONCE → CHURN EVERYWHERE ✅ (except billing)

---

## 6. What is left

Grouped by **who can unblock it**, because that is the only grouping that
decides what you can pick up on day one.

### 6.1 The Database app — DONE, 26 September

Deployed and switched on. Nothing here is outstanding.

| | |
|---|---|
| Deployment | `26178c54`, then `85a45464` when the variables were set |
| Rollback point | `05ebc358` (25 Sep 22:13) — still in Railway's history |
| Health after | `/login` 200, `/webhooks` `/search` `/import` all 307 |
| Other services | `enrich-worker`, `bison-cron` untouched |
| Data | 44 rows before and after |

What went live:

* `adada98` — churn guard at the only writer of `orch_client_leads`; the
  duplicate guard on client creation now uses the matcher's own `normClientName`
* `ad78784` — the §8 **Client status** column, beside the renamed
  "Onboarding status"

And the two variables are now set, so the guard actually reads the feed:

```
CLIENT_STATUS_URL   = https://os.brokerstaffer.com/api/workspace/clients/status-feed
CLIENT_STATUS_TOKEN = <the OS's OS_CLIENT_STATUS_TOKEN>
```

The feed was verified before switching it on: 200 with the token, **401
without**, 65 entries covering 50 distinct clients. Fifty rather than 52 is
correct — a client still onboarding is deliberately absent from the feed, so
the Database never blocks a client who has not started.

#### The duplicate row — deleted 26 September

`orch_clients` held `Camelot Realty` and `Camelot Realty Group` as separate rows
for one client, created three minutes apart on 10 August, both pointing at the
same Client Health row. Checked against all fourteen tables that reference
`orch_clients`: the first had **zero** references anywhere, the second held
5,579 bison leads, 10 introductions, 3 deliveries and 2,246 agent campaigns.

Deleted inside a transaction that re-asserted both facts — the name, and zero
references — before removing anything, and rolled back otherwise. Both rows were
backed up first to `~/camelot-duplicate-backup-20260926.json`.

**The Database app now reads 43 rows = 43 clients**, with no second rows and no
non-client rows. The `adada98` guard prevents the next one.

### 6.2 "Can we just add the missing clients so the numbers match?"

It is the obvious fix and it is worth writing down why the answer differs for
each group, because they are not the same question.

**The 2 onboarding clients — yes, but through the OS, not by hand.**
Brokerage Realty and Cardinal Realty Group are current clients mid-setup; they
belong everywhere once provisioned. Do NOT insert rows directly: `runOnboarding`
creates them in every tool *and records the link back on the master record*.
A hand-made row leaves `ch_client_id` / `an_client_id` empty, so the OS falls
back to matching by name — the exact fragility this project exists to remove.
First settle the open question on Cardinal, which may in fact have churned.

**The churned and paused ones — no.** Five churned and three paused clients are
absent from the Database app, two churned from Analytics. Adding them back:

* **reverses the lifecycle behaviour you approved** — §9 defines churned as
  removed from the delivery tools, and that is what propagation does; and
* **is actively risky in the Database app.** A new `orch_clients` row defaults
  `weekly_target` to 3, and `bison-cron` matches campaigns **by name** every six
  hours — so a churned client's old campaigns can re-attach and start counting
  again, against a target that a connector uses to pause campaigns.

**And equal totals are not what §2 asks for.** The sentence is that every
connected system should be able to *identify the same clients*; §17 then says
in as many words that a client not existing in a tool is fine **when it is an
intentional exception with a clear reason**. So the target is not 52 rows
everywhere — it is that every difference is named, which the Client counts panel
now does.

**Non-client rows stay exactly as they are.** `Demo Portal` backs the live demo
client portal and is never counted as a client and never written to — it sits in
`NOT_CLIENTS` in `lib/clients/roster.ts` with that reason, alongside
`New client portal`, `Test FUB`, `ZZ Portal Delete Test`, `Unassigned` and
`Unknown`. The counts panel prints the reason beside each.

**The one row that was genuinely wrong** — the `Camelot Realty` duplicate — was
deleted on 26 September (§6.1). Every remaining row in every tool is now either
a client, a named non-client, or a deliberate second market.

### 6.3 Three client names, and 7,036 leads attributed to nobody

Recording campaign links as ids (migration 0122) made a problem visible that
name-matching had been hiding. Of 256 campaigns, 217 now carry their client and
39 do not. Most of those 39 are templates and internal campaigns — *Template
Zillow Flex*, *Not Interested - All Clients*, the *OpsLabs Test* rows — and are
correctly unattached.

**But 17 are client-shaped, and four of them carry 7,036 leads that belong to a
client and are credited to nobody:**

| Campaign | Leads | The client it belongs to |
|---|---|---|
| `Douglas Elliman Los Angeles + Nicole + SOCAL` | 3,348 | Douglas Elliman **LA** |
| `Indy Realty 4 + Nicole + MIBOR` | 1,931 | **LIV** Indy Realty |
| `Douglas Elliman Los Angeles + Nicole + Beverly Hills` | 928 | Douglas Elliman **LA** |
| `Douglas Elliman Los Angeles 2 + Nicole + Beverly Hills` | 829 | Douglas Elliman **LA** |

Plus six `Momentum Realty …` campaigns against a client row named **Momentum
Lux Realty** — no leads yet, but the same fault waiting to happen.

Every one is a single spelling. Three fixes, and they are not equally safe:

1. **`Douglas Elliman LA` → `Douglas Elliman Los Angeles`.** The OS master
   record already calls it Douglas Elliman Los Angeles, and so do the campaigns;
   the Database row is the odd one out. Renaming it aligns all three and fixes
   5,105 leads. **Safest of the three**, because it moves toward the master.
2. **`Momentum Lux Realty` → `Momentum Realty`.** Same shape — the master says
   Momentum Realty. Fixes six campaigns before they carry leads.
3. **`Indy Realty 4` is a campaign-naming problem, not a client one.** The
   client is correctly `LIV Indy Realty`; the campaign simply omits "LIV".
   Renaming the client would break its other matches. This one needs either the
   campaign renamed in EmailBison, or the link recorded by hand.

Recording a link by hand is now safe and permanent: the matcher only overwrites
a link when it positively identifies a *different* client, so a hand-set id
survives every sync. That property exists specifically for this case.

**None of these renames have been made** — they change client identity, which
is a decision rather than a fix.

### 6.4 Needs a decision from the client, then minutes of work

| Decision | What is already built | What to do on a yes |
|---|---|---|
| **Where should drift alerts go?** Slack was paused | the whole daily check, off by default | set `OS_RECONCILE_ALERT_ENABLED=1` **and** `OS_RECONCILE_ALERT_SEND=1` **and** `OS_ALERT_SLACK_CHANNEL_ID`; optionally `OS_RECONCILE_ALERT_HOUR_UTC` (default 13) |
| **What should pause/churn do to billing?** | nothing — deliberately | wire a leg into `status-propagate.ts` alongside the campaigns leg |
| **Should a churned client's leads stop being scraped and enriched?** | lead *building* stops | tell `enrich-worker` and the scraper to read the same status feed |
| **One client with two portals — how should it count?** | both portals resolve to one master client via aliases | either give the second market its own Client Health row, or teach Client Health that one client has several portals |

> Do **not** enable the drift alerter before there is a destination. With
> `SEND` off and no channel, a daily run computes a report and discards it —
> cost without benefit. The two switches are deliberately separate so that
> turning the clock on cannot start messaging a channel by itself.

**The two-portal case affects two clients, not one:**

| Client | Portals (both open) | Client Health rows |
|---|---|---|
| Properties & Estates | Florida + Boston | 1 — Boston only |
| SERHANT. PA | "SERHANT. PA 15M+" + "SERHANT. PA" | 1 — base only |

In both cases the second portal's introductions are invisible to targets and
billing.

### 6.5 Needs the Database developer

* **The MLS relation.** Agreed design: a new table keyed on `orch_clients.id`,
  distinguishing `declared` from `derived`, with a 10% floor and a coverage
  share, and dropping the scalar `orch_clients.mls`. Measured basis: of 41
  clients, **41 sit at 0%** on the strict test and **16 clear 10%**; the median
  top-MLS share is **82.8%**. Until this lands, §8's MLS filtering cannot work
  — MLS is recorded on **1 of 44** Database rows and **0 of 52** master rows.
* **Saved views.** §2 asks the system to "create the appropriate saved view"
  when a client is created. That lives in the Database app and was decided to
  stay manual for now; it is the one §2 checklist item with no code anywhere.
* **Linking campaigns by ID rather than name.** §19's campaigns band and §14
  item 12 both read ◐ for this reason. Names work today and the six-hourly
  matcher is reliable, but a campaign named unlike its client is silently
  unmatched.

### 6.6 Needs data entry, not engineering — the single biggest gap

| Field | Recorded |
|---|---|
| Account Manager | **0 of 52** |
| Sender | **0 of 52** |
| Area | **0 of 52** |
| MLS | **0 of 52** |
| Market | 1 of 52 |
| Salesperson | 3 of 52 |
| Brokerage | 30 of 52 |

Until Account Manager is populated, §5's worked example ("change it once →
every tool updates") **cannot be demonstrated at all**, §23's checklist keeps a
✗, and §22's "changes propagate to relevant tools" stays ◐. The plumbing is
finished; nothing is flowing through it.

`/roster` → open a client → **Edit**. The dialog offers names already in use,
so this is mostly clicking.

### 6.7 Blocked on tools that do not exist

Commission Tracker (§1, §2, §8, §18) and future CRM / CSM. The architecture is
ready for them; §18's connection path is enforced in code.

### 6.8 Deliberately not done

* **Add Client buttons in the standalone tools** (§13, §22). They stay because
  the tools stay live.
* **Standalone tools' own status colours** (§11, §22). Left untouched on
  instruction — clients are using those interfaces.
* **Billing reacting to status** (§9, §12). A wrong churn flag that cancels a
  subscription cannot be undone by flipping the flag back.

---

## 7. Runbook

### 7.1 Re-measure everything

The drift check is the fastest whole-estate health read. It is report-only
without `?send=1`:

```bash
# OS_CRON_SECRET lives on the os service; read it by name, never print it
curl -s -H "Authorization: Bearer $OS_CRON_SECRET" \
  https://os.brokerstaffer.com/api/cron/reconcile-alert | python3 -m json.tool
```

Healthy output: `statusConflicts 0`, `unexplainedOneSided 0`, `duplicates 0`,
`brokenLinks 0`, `aliasDrift 0`, `failedChecks []`, `clientsChecked 52`.

`/consistency` in the UI is the same data with explanations attached.

### 7.2 Read the roster directly

`os_clients` lives in **Master Inbox's** Supabase.

```bash
cd brokerstaffer-os
g(){ grep -m1 "^$1=" .env.local | cut -d= -f2- | tr -d '"'"'"' \r'; }
curl -s "$(g MASTER_INBOX_SUPABASE_URL)/rest/v1/os_clients?select=name,status,aliases&limit=1000" \
  -H "apikey: $(g MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY)" \
  -H "Authorization: Bearer $(g MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY)"
```

> **PostgREST silently caps reads at 1,000 rows.** Always pass an explicit
> `limit` and page. Never treat a `0` as "unpopulated" without checking you got
> the whole table.

### 7.3 Changing a client's status

Never write `os_clients.status` directly. Use `/roster` or
`POST /api/workspace/clients/status`, which runs `status-propagate.ts` — four
legs, each reporting success or failure independently, so a partial failure is
visible rather than silent.

### 7.4 Adding a client

`/roster` → Add. This runs `lib/clients/onboard-run.ts`, which creates the
master record and then each tool's record. `POST /api/workspace/clients/onboard/execute`
is the same thing over HTTP; it supports `stopBefore` for dry runs.

---

### 7.5 Verification record

Re-run §7.1 and compare. Nothing here should change without somebody changing it.

| Checked | 25 Sep | 26 Sep |
|---|---|---|
| Clients in `os_clients` | 52 | 52 |
| active / paused / churned / onboarding | 32 / 8 / 10 / 2 | 32 / 8 / 10 / 2 |
| Client Health rows | 50 | 50 |
| Analytics rows | 53 | 53 |
| Portals open / closed | 38 / 19 | 38 / 19 |
| Database app client rows | 44 | 44 |
| Linked to the Database app | 43 | 43 |
| Account Manager / Sender / Area / MLS recorded | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| Drift check — all six | clean | clean |
| New commits by anyone | — | none, all four repos level |

On 26 Sep every host answered: OS, Master Inbox, Client Health, Analytics and
Agent Search healthy; Onboarding returns 401 at its root, which is its own auth,
not an outage. Two things changed that day: somebody else redeployed the
Database app overnight without the pushed commits, and it was then deployed
properly and switched on — §6.1.

---

## 8. Traps that have already cost time

1. **`TOKEN_ROUTES` matches on the `x-admin-token` header, not the path.** A
   bearer-auth cron route listed there gets a proxy 401 before its own gate
   runs — production-only, while every local test passes. Use
   `CRON_BEARER_ROUTES`.
2. **React Query compares keys structurally.** `["campaign", 276]` is not
   `["campaign", "276"]`. This produced Eddy's "the save button is not working"
   report on Analytics: the save succeeded every time — the audit log proves it
   — but the cache key was built from a number in one place and a string in
   another, so the UI re-read a different entry. The same defect existed in
   **three** places; all three now share one builder,
   `src/lib/campaigns/query-keys.ts`, with a test pinning it.
3. **`Number(null) === 0`.** A NULL Instantly status was reported as "draft".
   Guard to non-integer → "error".
4. **Three different name normalisations exist, deliberately.**
   `keyOf` (roster) maps `&`→`and` and keeps word spacing;
   `normClientName` / `orchKey` (Database app) strips everything and also drops
   `copy of` and a leading `the`; `lifecycleKey` is the plain strip. They are
   not interchangeable. `keyOf` does **not** collapse RE/MAX → REMAX.
5. **Master Inbox keeps one row per PORTAL, not per client.** A multi-market
   client owns several rows. Any coverage check that reads `os_clients`
   **must select the `aliases` column** or it will invent orphans — this
   produced a false "seven unresolved rows" alarm on 25 Sep.
6. **Three alias stores** — `os_clients.aliases`,
   `analytics.clients.aliases`, `client_health.campaign_aliases` — and all
   three match campaigns by **name**.
7. **Node's `console.log` does not support `%-30s` padding.** Use `padEnd`.
8. **A hung `next build` can sit for hours at 0 bytes.** If a build has produced
   nothing for more than a few minutes, kill it.
9. **The alerter's first live finding was a false positive** — a client whose
   link pointed at one market and whose name matched another. Fixed with
   `ownsLinkedRow` in `link-integrity.ts`. Treat a single finding as a
   hypothesis until you have checked it by hand.

---

## 9. Open questions for the client

Four decisions, three of them unchanged from the original report and one now
answered:

1. ~~What should pause and churn do to campaigns?~~ **Answered: pause, never
   delete.** Built.
2. **What should pause and churn do to billing?** Costs money; not reversible by
   flipping the flag back.
3. **Should a churned client's leads stop being scraped and enriched?** Lead
   building already stops; scraping and enrichment cost money per row.
4. **One client with two portals — how should it count?** Affects Properties &
   Estates and SERHANT. PA.

Also waiting on the client: the real status of the two remaining onboarding
clients (Cardinal Realty Group and Brokerage Realty — Cardinal may in fact be
churned); who owns the Bison campaign IDs; and whether the weekly target of 3,
set identically on all 44 rows of the Database app's client table, is
intentional — because a connector pauses campaigns once that target is reached.

---

## 10. Reference

* `docs/CLIENT-DATA-DICTIONARY.md` — 58 fields, nine categories, the answer to
  §7 and §15.
* `docs/STATUS-BEHAVIOUR.md` — what each status does in each system; every row
  says either where it is implemented or that it is undecided.
* `src/lib/workspace/nav.ts` — the screen inventory.
* `src/lib/reconcile/` — every §16 check.
* `src/lib/clients/` — the master record, propagation, onboarding, people.
* `.env.example` — every variable any connector reads, with comments.
