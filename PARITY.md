# Feature parity with the live tools

What each live tool does, and whether the workspace does it yet. The point of
this file is that nothing gets quietly dropped: a screen that renders the right
numbers but is missing the button somebody presses twice a day has not replaced
anything.

Kept in the repo rather than a ticket so it is reviewed in the same diff as the
code it describes.

**Legend** — ✅ built · 🔸 partial · ⬜️ not started · ⛔️ deliberately excluded

---

## The rule that governs all of this

The live tools keep running, untouched. The workspace reads their databases
directly using their own query code, and writes through their own endpoints.
Nothing here changes a deployed app's behaviour or UI.

Two consequences worth stating plainly:

- **Reads** are copied code against the same database. They cannot drift.
- **Writes** go to the tool's own API, so its validation, its side effects and
  its sync workers all still apply. The workspace never writes to a tool's
  tables directly.

---

## Client Health

Source: `apps/client-health`. Database: `CLIENT_HEALTH_SUPABASE_URL`.

### Views

| | Live | Workspace |
|---|---|---|
| Weekly | ✅ | ✅ |
| Bi-Weekly | ✅ | ✅ |
| Client Success | ✅ | ✅ |
| Week navigation (← This Week →) | ✅ | ✅ |

### Filtering and sorting

| | Live | Workspace |
|---|---|---|
| Search by name | ✅ | ✅ |
| All / At Risk / On Track / Done / Paused | ✅ | ✅ |
| Active (has a running campaign) | ✅ | ✅ |
| Inactive (never launched) | ✅ | ✅ |
| Client Paused tab | ✅ | ✅ |
| Hidden tab (churned clients) | ✅ | ✅ |
| Plan filter | ✅ | ✅ |
| **Date-range filter** (by start date) | ✅ | ⬜️ |
| Column sorting | ✅ | ✅ |

All nine of the tool's filters are present, on all three screens, sharing one
list so they cannot drift apart. Hidden and Client Paused matter more than they
look: those clients are excluded from every other view, so without those tabs a
churned client is unreachable from the workspace entirely.

Still missing: the date-range filter on start date.

### Writes

| | Live | Workspace |
|---|---|---|
| **Sync now** → `POST /api/sync/run` | ✅ | ✅ button, on all three screens |
| Add client → `POST /api/clients` | ✅ | 🔸 API proxied, no form yet |
| Edit client → `PATCH /api/clients` | ✅ | 🔸 API proxied, no form yet |
| Delete client → `DELETE /api/clients?id=` | ✅ | 🔸 API proxied, no confirm dialog yet |
| Toggle client paused → `PATCH` | ✅ | 🔸 API proxied, no control yet |
| Inline metric edit | ⛔️ | ⛔️ not a feature — see below |
| Toast feedback on writes | ✅ | ✅ on sync |

The Weekly table's number cells look editable — they are `<input>` elements —
but the live tool marks them `readOnly` and its `/api/metrics/weekly` is a GET.
Those figures come from Instantly, EmailBison and Master Inbox via the sync
worker, so typing over one would be overwritten on the next sync and would
meanwhile make the dashboard disagree with the systems it reports on. I had
this listed as a missing feature until I read the handler; it is not one.

Writes reach the tool through **its own API**, authenticated by minting the
`bs_auth` cookie its login produces. That is why no change to the deployed app
was needed: its existing auth is used as intended. The password lives only in
Railway and never reaches the browser — every write is proxied through the
workspace's own routes.

---

## Campaign Analytics

Source: `apps/analytics`. Database: `ANALYTICS_SUPABASE_URL`.
Query layer copied verbatim; connection verified against the live database.

| Screen | Live | Workspace |
|---|---|---|
| Overview (KPIs) | ✅ | 🔸 loader built, screen not yet |
| Campaign analytics | ✅ | ⬜️ |
| Attribution | ✅ | ⬜️ |
| Copy & offer | ✅ | ⬜️ |
| Infrastructure | ✅ | ⬜️ |
| Campaigns list + detail | ✅ | ⬜️ |
| Clients | ✅ | ⬜️ |
| Schedule / job runs | ✅ | ⬜️ |

> **Paused deliberately.** The tool is being changed right now, so building
> screens against it would mean doing the work twice — the copied query layer
> would need re-copying after those changes land too. Agent Search and
> Onboarding come first; Analytics resumes once its changes have settled.

**Cron triggers.** `GET /api/cron/[job]`, guarded by `CRON_SECRET`, is how a
human re-runs a job by hand. Every job is idempotent, so re-running one costs
freshness and nothing else. The workspace should expose these; it does not yet.

Writes this tool has that the workspace will need: campaign settings, offers,
copy, merge tags, and the bulk actions in `/api/campaigns/actions`.

---

## Master Inbox

Source: `apps/master-inbox`. The largest by far — 50,290 lines, 297 files, 51
of them bound to Supabase RLS.

| | Live | Workspace |
|---|---|---|
| Every screen | ✅ | ⬜️ embedded pane only |

Its data layer reads through an RLS-bound client keyed to the signed-in user,
so it cannot be lifted the way Client Health's was without replacing that
session. This is the one to do last and most carefully.

⛔️ **Client portals stay where they are.** `portal.brokerstaffer.com` is served
by this app and is untouched — including the demo portal, which is a live
client-facing demo and must not be treated as clutter.

---

## Onboarding

Source: `corofy-onboarding`. Orchestrator on Railway.
Database: shared with Agent Search — see below.

| | Live | Workspace |
|---|---|---|
| Pipeline (clients by stage) | ✅ | ✅ |
| Stage board with counts | ✅ | ✅ |
| Templates | ✅ | ⬜️ |
| Settings | ✅ | ⬜️ |
| Stage transitions (writes) | ✅ | ⬜️ |

Live data: 37 clients across 8 stages, 344 introductions. The screen leads with
what is stuck — waiting 14 days or more, paid but not live, live but unpaid —
rather than with a total that never changes.

**Do not move the webhooks.** This app receives Typeform, EmailBison, Stripe
and Calendly callbacks and holds the hub tokens. Those endpoints must keep
answering on their current URLs; the workspace adds screens, it does not take
over delivery.

---

## Agent Search

Source: `Scrapper`. Express, four worker processes.

| | Live | Workspace |
|---|---|---|
| Agent browser (search, filter, sort) | ✅ | ✅ server-paged |
| Saved lists | ✅ | 🔸 listed, not openable |
| Start / stop a scrape | ✅ | ⬜️ |
| Enrichment runs | ✅ | ⬜️ |
| MLS monitor + scan | ✅ | ⬜️ |
| CSV / Sheet import | ✅ | ⬜️ |
| Master list build + export | ✅ | ⬜️ |

Live data: 1,173,896 agents, 177,766 offices, 54 MLS boards, 31 saved lists.

**Server-paged out of necessity.** Every other table in the workspace filters
in the browser because it holds forty rows; doing that here would mean sending
a million. The browser never receives more than one page, and the page size is
enforced server-side — this route is reachable by anyone signed in, and
`&limit=100000` in an address bar must not be able to pull the table.

The job controls above are the remaining gap. They are all *actions* on the
live service rather than reads, so they follow the pattern the Client Health
sync button established: trigger the tool's own endpoint, never reimplement it.

⛔️ The scraping workers, the MLS monitor and the ingest endpoints stay on the
live service. The workspace reads what they produce.

### One database, two tools

Agent Search and Onboarding point at the **same Supabase project**. Neither
codebase says so — each reads a plain `SUPABASE_URL` and neither mentions the
other — and it changes what a migration on "the onboarding database" can safely
touch. They are cleanly separated by prefix:

    orch_*                                     Onboarding
    agents, offices, mls, agent_mls,           Agent Search
    saved_lists

One client serves both; two would open two pools to the same Postgres.

---

## Things that must never regress

- `portal.brokerstaffer.com` keeps serving client portals, demo portal included.
- Onboarding keeps receiving its five webhook types on its current URLs.
- Analytics' scheduler keeps running its jobs.
- Client Health's sync worker keeps writing.
- Agent Search's workers keep scraping.

The workspace is a reader and a caller. It is not, and should not become, the
thing these depend on.
