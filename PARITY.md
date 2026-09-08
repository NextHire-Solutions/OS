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
| **Active** (has a running campaign) | ✅ | 🔸 predicate ported and tested, no pill yet |
| **Inactive** (never launched) | ✅ | 🔸 same |
| **Client Paused** tab | ✅ | 🔸 same |
| **Hidden** tab (churned clients) | ✅ | 🔸 same |
| Plan filter | ✅ | ✅ |
| **Date-range filter** (by start date) | ✅ | ⬜️ |
| Column sorting | ✅ | ✅ |

The four missing pills are the cheap ones: `applyFilters` already implements
every predicate and each is covered by a test. They are absent from the button
row, not from the logic.

### Writes — the real gap

| | Live | Workspace |
|---|---|---|
| **Sync now** → `POST /api/sync/run` | ✅ | ⬜️ |
| **Add client** → `POST /api/clients` | ✅ | ⬜️ |
| **Edit client** → `PATCH /api/clients` | ✅ | ⬜️ |
| **Delete client** → `DELETE /api/clients?id=` | ✅ | ⬜️ |
| Inline metric edit | ⛔️ | ⛔️ not a feature — see below |
| **Toggle client paused** → `PATCH` | ✅ | ⬜️ |
| Toast feedback on every write | ✅ | ⬜️ |

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

| | Live | Workspace |
|---|---|---|
| Screens | ✅ | ⬜️ embedded pane only |

**Do not move the webhooks.** This app receives Typeform, EmailBison, Stripe
and Calendly callbacks and holds the hub tokens. Those endpoints must keep
answering on their current URLs; the workspace adds screens, it does not take
over delivery.

---

## Agent Search

Source: `Scrapper`. Express, four worker processes.
Database: `AGENT_SEARCH_SUPABASE_URL` — credentials now available.

| | Live | Workspace |
|---|---|---|
| Screens | ✅ | ⬜️ embedded pane only |

⛔️ The scraping workers, the MLS monitor and the ingest endpoints stay on the
live service. The workspace reads what they produce.

---

## Things that must never regress

- `portal.brokerstaffer.com` keeps serving client portals, demo portal included.
- Onboarding keeps receiving its five webhook types on its current URLs.
- Analytics' scheduler keeps running its jobs.
- Client Health's sync worker keeps writing.
- Agent Search's workers keep scraping.

The workspace is a reader and a caller. It is not, and should not become, the
thing these depend on.
