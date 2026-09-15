# Client Health — parity checklist

Source of truth: `github.com/brokerstaffer/Shaurs` @ `eb7d572`
(working copy `/Users/sankalpdutt/Desktop/Code/Corofy/shaurs`, verified in sync with `origin/main`).

Every feature the live tool has, and whether the OS port has it.
`app/Dashboard.tsx` (2,424 lines) is the whole UI surface; `lib/**` and
`app/api/**` are the logic behind it.

Legend: **[x]** present and behaving · **[ ]** missing · **[~]** present but wrong

---

## 1. Data layer — `lib/**`

| # | Item | Status |
|---|------|--------|
| 1.1 | `types.ts` — Client, DashboardClient, WeeklyMetric, plans, targets, TIME_ZONES | [x] byte-identical |
| 1.2 | `derive.ts` — metricFor, weekKey, billing dates, monthlyCycleStart, clientScore, derive | [x] byte-identical |
| 1.3 | `loadDashboard.ts` — 26-week window, 1000-row pagination, campaign joins | [x] byte-identical |
| 1.4 | `seed.ts` — offline fallback data | [x] byte-identical |
| 1.5 | `matchCampaigns.ts` — normalizeForMatch, MANUAL_LINKS, autoMatchCampaignIds | [x] byte-identical |
| 1.6 | `supabase.ts` — service-role client | [x] adapted: env vars namespaced `CLIENT_HEALTH_*` |
| 1.7 | `session.ts` — auth | [x] adapted: the OS mints the tool's `bs_auth` cookie. Now reached by "Sync now" alone — the client writes no longer pass through it |
| 1.8 | `bison.ts` / `instantly.ts` / `corofy.ts` / `portals.ts` | n/a — sync-worker only, the OS proxies `/api/sync/run` rather than re-implementing it |
| 1.9 | `bs-auth.ts` / `route-auth.ts` / `middleware.ts` | n/a — the OS has its own auth |

## 2. API routes

| # | Live route | OS route | Status |
|---|-----------|----------|--------|
| 2.1 | `GET /api/clients` | reads Supabase directly via `loadDashboard` | [x] |
| 2.2 | `POST /api/clients` | `POST /api/tools/client-health/clients` → **writes Supabase directly** (`lib/tools/client-health/clientWrites.ts`) | [x] ported — and `time_zone` fixed, see **Where writes go** |
| 2.3 | `PATCH /api/clients` | `PATCH …/clients` → **writes Supabase directly**, same field allow-list | [x] ported |
| 2.4 | `DELETE /api/clients?id=` | `DELETE …/clients?id=` → **writes Supabase directly**, cascade + orphan eviction reproduced | [x] ported |
| 2.5 | `POST /api/sync/run` | `POST …/client-health/sync` → proxy, 240 s timeout | [x] |
| 2.6 | `GET /api/metrics/weekly` | n/a — a read-only endpoint the tool publishes *for* other systems; the OS reads the table itself | n/a |
| 2.7 | `GET /api/clients/status` | n/a — same, an outbound integration point | n/a |
| 2.8 | `POST /api/clients/onboard` | n/a — the Onboarding tool's inbound webhook | n/a |
| 2.9 | `POST /api/auth/login` / `logout` | n/a — the OS has its own session | n/a |

## 3. Summary cards — four groups of six (24 cards)

The live tool groups its cards under four labels. Every one is listed.

### Status
| # | Card | Status |
|---|------|--------|
| 3.1 | Clients / active | [x] |
| 3.2 | At Risk / below half target | [x] |
| 3.3 | On Track / meeting target this week | [x] |
| 3.4 | Done / met weekly target | [x] |
| 3.5 | Client Paused / manually paused | [x] |
| 3.6 | By Plan / min · prod · partner | [x] |

### Performance
| # | Card | Status |
|---|------|--------|
| 3.7 | Weekly Intros Sent | [x] |
| 3.8 | Weekly Target | [x] |
| 3.9 | Weekly Completion % | [x] |
| 3.10 | Monthly Intros Sent / this monthly cycle | [x] added |
| 3.11 | Monthly Target / intros per month | [x] added |
| 3.12 | Monthly Completion % | [x] added |

### Funnel — Lifetime  (commits `70a92ab`, `eb7d572`)
| # | Card | Status |
|---|------|--------|
| 3.13 | Emails Sent — sum of `emails_sent_total` across every campaign | [x] added |
| 3.14 | Reply Rate — replies / emails, sub = `n / n` ratio | [x] added |
| 3.15 | Positive Reply — all-time Corofy Interested / replies | [x] added |
| 3.16 | Avg Conv. — converted per 1k emails | [x] added |
| 3.17 | Converted — all-time intros | [x] added |
| 3.18 | Int → Intro — converted / whole funnel | [x] added |
| 3.19 | **All-time Corofy counters preferred over the 26-week sum** (`total_intros_corofy`, `total_interested_corofy`), falling back to the weekly sum when unbackfilled | [x] added — was missing, the whole point of `eb7d572` |

### Funnel — This Week  (commit `70a92ab`)
| # | Card | Status |
|---|------|--------|
| 3.20 | Emails Sent — this week's `weekly_metrics.emails_sent` | [x] added |
| 3.21 | Reply Rate — **per-week replies from Instantly + Bison** (`weekly_metrics.replies`, migration 0015) | [x] added |
| 3.22 | Positive Reply — weekly interested / weekly replies | [x] added |
| 3.23 | Avg Conv. — weekly intros per 1k weekly emails | [x] added |
| 3.24 | Converted — weekly intros | [x] added |
| 3.25 | Int → Intro — weekly intros / weekly funnel | [x] added |

## 4. Filters and search

| # | Control | Status |
|---|---------|--------|
| 4.1 | Free-text client search | [x] |
| 4.2 | Nine filter pills: All · At Risk · On Track · Done · Active · Campaign Paused · Inactive · Client Paused · Clients Churned | [x] labels corrected to the tool's rename pass |
| 4.3 | Default-exclude: hidden + client_paused hidden from every other filter | [x] |
| 4.4 | Plan select (All / Minimum / Production / Partner) | [x] |
| 4.5 | Time-zone select (All + 7 IANA zones by short code) | [x] added |
| 4.6 | Billing-window select (Any / next 7 / 14 / 30 days) | [x] added |
| 4.7 | Date popover — presets Last 7 / Last 30 / Year to date | [x] added |
| 4.8 | Date popover — custom From / To on `start_date` | [x] added |
| 4.9 | Date popover — Clear and Done | [x] added |
| 4.10 | Filters apply to Bi-Weekly and Client Success too (the live tool passes one `visible` list to all three) | [x] added |

## 5. Weekly table — 19 columns

| # | Column | Sortable | Status |
|---|--------|----------|--------|
| 5.1 | Client — name, "Since {date}", campaign meta line | by campaigns | [x] |
| 5.2 | — portal_url deep-link ↗ (migration 0014) | | [x] added |
| 5.3 | — "Churned" badge on hidden, "Client Paused" badge | | [x] added |
| 5.4 | — campaign meta opens the campaigns popup; "Campaign Paused" / "Not Active" when none running | | [x] added |
| 5.5 | Time Zone | yes | [x] |
| 5.6 | Monthly — `intros_this_month / monthly_target`, three-tier colour, em dash at 0 | yes | [x] |
| 5.7 | Last Intro — Today / Yesterday / Nd ago, ≤5d green else amber | yes | [x] |
| 5.8 | Last Billing | yes | [x] |
| 5.9 | Next Billing — "Set billing date" button when underivable | yes | [x] button added |
| 5.10 | Days Until Billing — ≤3 days red | yes | [x] |
| 5.11 | Daily Emails Sent — **only counts when `emails_today_date` is today in ET** | yes | [x] fixed, was showing stale values |
| 5.12 | Intros This Week — readOnly input, ok/risk tint | yes | [x] |
| 5.13 | Conv. Rate — per-1k, coloured against the dashboard average | yes | [x] |
| 5.14 | Left This Week — "N left" / grey 0 / em dash when target is 0 | yes | [x] fixed |
| 5.15 | Campaign Progress — completed/total leads, %, bar, "N sent · Running" | yes | [x] |
| 5.16 | — per-campaign dropdown when >1 active campaign | | [x] added |
| 5.17 | Status badge — Pending / At Risk / On Track / Done | no | [x] |
| 5.18 | Interested — **all-time** sum of `interested_corofy` | yes | [x] fixed, was showing this week only |
| 5.19 | Converted — **all-time** sum of `intros_corofy` | yes | [x] fixed, was showing this week only |
| 5.20 | Int → Intro — per-client conversion rate | yes | [x] added, column was absent |
| 5.21 | Plan badge | no | [x] |
| 5.22 | Portal ✓ / — | no | [x] |
| 5.23 | Actions — Edit · Pause/Resume · Hide/Unhide · Delete | no | [x] added, column was absent |

## 6. Add / Edit client modal

| # | Field | Status |
|---|-------|--------|
| 6.1 | Client name | [x] added |
| 6.2 | Live auto-link preview — "Will auto-link N matching campaigns" | [x] added |
| 6.3 | Plan select, bumping the weekly target to the plan default | [x] added |
| 6.4 | Weekly intros target | [x] added |
| 6.5 | Monthly intros target (migration 0013) | [x] added |
| 6.6 | Start date | [x] added |
| 6.7 | Billing anchor date | [x] added |
| 6.8 | Billing interval — biweekly / 28-days / monthly / custom | [x] added |
| 6.9 | Custom interval days, shown only for "custom" | [x] added |
| 6.10 | Time zone | [x] added |
| 6.11 | Save → POST or PATCH, auto-linking Instantly + Bison ids | [x] added |
| 6.12 | Cancel / backdrop click / Escape | [x] added (Escape is ours; the tool has backdrop only) |

## 7. Campaigns popup

| # | Item | Status |
|---|------|--------|
| 7.1 | Opens from the client's campaign meta line | [x] added |
| 7.2 | Header — N active campaigns · emails sent · N paused/finished | [x] added |
| 7.3 | Grouped Instantly then Bison; headers only when both are present | [x] added |
| 7.4 | Sorted running → paused → finished, then most recent transition | [x] added |
| 7.5 | Per campaign: name, %, progress bar, completed/total leads, emails sent | [x] added |
| 7.6 | Per campaign status chip: Running / Campaign Paused / Finished / Draft | [x] added |
| 7.7 | Per campaign Reply % and Positive % (migration 0009) | [x] added |
| 7.8 | Escape and backdrop close | [x] added |
| 7.9 | Empty state when nothing is linked | [x] added |

## 8. Row actions

| # | Action | Status |
|---|--------|--------|
| 8.1 | Edit → opens the modal prefilled | [x] added |
| 8.2 | Pause / resume client — optimistic, rolls back on failure | [x] added |
| 8.3 | Hide / unhide client — optimistic, rolls back on failure | [x] added |
| 8.4 | Delete — confirm naming the linked-campaign count, reports orphans removed | [x] added |
| 8.5 | Toast for every outcome | [x] added |

## 9. Header and chrome

| # | Item | Status |
|---|------|--------|
| 9.1 | Week navigation ← / → | [x] |
| 9.2 | Forward disabled on the current week | [x] |
| 9.3 | "This Week" vs the week's date range | [x] |
| 9.4 | "Today" button when viewing a past week | [x] added |
| 9.5 | Past-week read-only banner | [x] added |
| 9.6 | Sync now (`↻` in the tool) | [x] |
| 9.7 | "+ Add Client" | [x] added |
| 9.8 | Empty state with its own Add Client button | [x] added |
| 9.9 | Seed-data notice when Supabase is unreachable | [x] (the OS adds this; the tool only logs) |
| 9.10 | Sign out | n/a — the OS owns the session |

## 10. Bi-Weekly view

| # | Item | Status |
|---|------|--------|
| 10.1 | Six columns: Client · Time Zone · Billing Date · Days Until Billing · Introductions · Left This Cycle | [x] |
| 10.2 | Cycle target scaled to the billing interval | [x] |
| 10.3 | Introductions three-tier colour, Left This Cycle "Done" / "N left" | [x] |
| 10.4 | Default sort: soonest billing first, unset last | [x] |
| 10.5 | All six columns sortable, desc → asc → reset | [x] |
| 10.6 | "Set" / "Set billing date" buttons open the edit modal | [x] added |
| 10.7 | Shares the Weekly view's filters | [x] plan / tz / billing / date added |

## 11. Client Success view

| # | Item | Status |
|---|------|--------|
| 11.1 | Eleven columns: Client · Plan · Score · Time Zone · Launch Date · Portal Updated · Stagnant Intros · Hired · Last Hire · DNC · Agents | [x] |
| 11.2 | `clientScore` 0–10 over eight weeks, null for new clients | [x] |
| 11.3 | Score colour: ≥8 good, ≥5 mid, else low | [x] |
| 11.4 | `humanizeAgo` for Portal Updated and Last Hire | [x] |
| 11.5 | All eleven columns sortable, missing values sink both ways | [x] |
| 11.6 | "Set" / "Set date" buttons open the edit modal | [x] added |
| 11.7 | Shares the Weekly view's filters | [x] plan / tz / billing / date added |

## 12. Cross-cutting

| # | Item | Status |
|---|------|--------|
| 12.1 | Week switching is a client-side re-derive, no round trip | [x] |
| 12.2 | Sort cycles desc → asc → reset on every table | [x] |
| 12.3 | Missing values sink to the bottom in both directions | [x] |
| 12.4 | Every `.update()` and `.delete()` is scoped to specific rows | [x] enforced by `src/lib/guards/blast-radius.test.ts` — **6 pass** |
| 12.5 | Mockup styling throughout — `.card`, `.fp`, `.tnum`, `.tg`, `.badge`, `.plan`, `.mi`, `.track` | [x] |

---

## Verification

Run against a dev server on **3310** with headless Chrome on **9444**. No other
agent's ports were touched; the dev server ran from an isolated copy because
another process held the repo's Turbopack lock on 3111.

| Suite | Command | Result |
|-------|---------|--------|
| Client Health logic | `node --test 'src/lib/tools/client-health/*.test.ts'` | **128 pass · 0 fail** |
| Whole repo | `npm test` | **349 pass · 0 fail** |
| Write-scoping guard | `node --test src/lib/guards/blast-radius.test.ts` | **6 pass · 0 fail** |
| Types | `npx tsc --noEmit -p tsconfig.json` | **0 errors** |
| Behaviour + layout (read-only) | `node scripts/client-health-ui-test.mjs` | **67 pass · 0 fail** |
| Writes, verified in the database | `node scripts/client-health-write-test.mjs` | **61 pass · 0 fail** |

The UI test drives every control rather than counting nodes: it types in the
search box and asserts the row count fell and then recovered, clicks each sort
header three times and asserts the order changed, reversed and reset, operates
all three selects and the date popover, steps the week back and returns, opens
the campaigns popup and the client modal and dismisses each by Escape, backdrop
and Cancel. Live data: 35 clients, 24 cards, 19 columns, 0 elements past the
viewport edge on all three screens.

It is READ-ONLY against the database — it opens the modal and cancels. Nothing
saves, pauses, churns or deletes, because verifying those would mean mutating a
live product's clients.

`scripts/client-health-write-test.mjs` is the other half of the UI test, and the
half that matters now the OS owns the writes: it sends the request each control
sends, then reads the row back through PostgREST and asserts on what the
DATABASE says. A route answering 200 proves nothing about what landed.

It touches no real client. It creates two throwaway clients under a
`ZZ Port Test` name, seeds two throwaway campaign cache rows and one
`weekly_metrics` row, drives create / edit / pause / resume / churn / restore /
delete against them, and deletes them; a `finally` block clears anything left
standing and the last two checks assert the cleanup happened. The fixtures exist
because a cascade cannot be verified by reading about it — you have to put a row
on the far side of the foreign key and watch it go.

`scripts/client-health-fingerprint.mjs` (read-only) snapshots every client plus
the row counts of `clients`, `weekly_metrics`, `instantly_campaigns` and
`bison_campaigns`, and reports anything that shrank. **Run, either side of the
write test:**

```
node scripts/client-health-fingerprint.mjs save    # before
node scripts/client-health-fingerprint.mjs check   # after
```

| Table | Before | After |
|-------|-------:|------:|
| clients | 48 | 48 |
| weekly_metrics | 1,840 | 1,840 |
| instantly_campaigns | 340 | 340 |
| bison_campaigns | 205 | 205 |

48 clients, 35 active, both times — no client removed, no table shrank, no field
changed on any existing row.

---

## Where writes go — settled

Client edits, pauses, churns and deletes **no longer touch the live tool**. They
are performed by the OS, against Client Health's own Supabase project, in
`src/lib/tools/client-health/clientWrites.ts`.

The open decision above asked for the account owner's own word before writing to
a live production database, because the instruction had arrived second-hand and
reversed the brief. It has since been given directly: the OS is to read and write
everything for every tool, because the tools are being switched off. So the proxy
had to go — it dies with the thing it proxies to, and the failure would not be
loud. The screens would still load, because reads already come from the database;
only saving, pausing, churning and deleting would break, one toast at a time.

Nothing else changed. The route paths, the request bodies and the response shapes
(`{ client }`, `{ ok, orphansRemoved }`) are the tool's own, so no browser code
was touched.

### What a DELETE actually removes

Three things, and the second is invisible in the code:

1. **the `clients` row** — the only explicit delete;
2. **every `weekly_metrics` row for that client** — the DATABASE does this.
   `weekly_metrics.client_id` is `references clients(id) on delete cascade`
   (migration 0001), so the client's entire history goes the instant the row
   does. That is roughly 26–40 rows per client on this data, and nothing reports
   them. Verified, not assumed: the write test seeds a metric row, deletes the
   client through the API, and reads the metrics table back empty;
3. **`instantly_campaigns` / `bison_campaigns` cache rows for campaigns no other
   client still links to** — application logic, reproduced from the tool. It runs
   *after* the client is deleted, so the departing client no longer counts as a
   referrer. This is a cache eviction, not a loss: the next sync re-adds the
   campaign if it still exists upstream. It exists so that re-adding a client of
   the same name does not immediately show months-old campaign figures.

Nothing else. The project has five tables — `clients`, `weekly_metrics`,
`instantly_campaigns`, `bison_campaigns`, `sync_runs` — and `weekly_metrics` holds
the only foreign key to `clients` in the whole schema. The campaign tables have no
key to `clients` at all; the link is a `text[]` column on the client, which is
exactly why step 3 has to be written by hand rather than declared.

### Deliberate divergences from the live tool

| # | The tool | The OS | Why |
|---|----------|--------|-----|
| 1 | `POST /api/clients` never reads `body.time_zone`, though its own modal sends it — every client added through that UI arrives with no time zone | stores it | A bug, not a behaviour. Its `PATCH` handles the field, which is what makes it an omission rather than a decision. Reproducing it would mean shipping a form whose field does nothing. |
| 2 | `''` is stored literally in `time_zone` and in the date columns | `''` normalises to `null` | The modal's "none" option has the value `''`, and `''` is not an IANA zone: stored literally it renders as a blank cell instead of the em dash that means "not set". |
| 3 | an id that does not exist returns 400 | returns 404 | The blanket 400 leaves the reader guessing whether they sent something wrong. |
| 4 | a `PATCH` body of `{ id }` alone reaches PostgREST and fails on the JSON | returns 400 "No fields to update" | Saying what is wrong is cheaper than explaining it later. |
| 5 | an invalid `plan` or `billing_interval` fails on a Postgres CHECK constraint | refused before the request is made | Same 400, readable message, and nothing reaches the database. |

The field allow-list is the tool's, kept deliberately. Most of `clients` is
written by the sync worker — `emails_today`, `portal_url`, `intros_this_month`,
the Corofy totals — and a PATCH that spread the body into the update would let a
stale browser tab overwrite numbers the sync owns. Asserted in both test suites.

---

## Deliberately not ported

- **Sign in / sign out, `middleware.ts`, `bs-auth.ts`** — the OS has its own session and its own grants.
- **The sync worker itself** (`scripts/sync.ts`, `lib/instantly.ts`, `lib/bison.ts`, `lib/corofy.ts`, `lib/portals.ts`) — the OS proxies `POST /api/sync/run` so the tool runs its own sweep. A second implementation would drift, and two dashboards disagreeing about a client's numbers is the failure this avoids.
- **`GET /api/metrics/weekly`, `GET /api/clients/status`, `POST /api/clients/onboard`** — outbound and inbound integration points the tool publishes for *other* systems. The OS reads the same tables directly.
- **The tool's own logo header** — replaced by the workspace shell.
- **"Sync now"** — still a proxy to the tool's `POST /api/sync/run`, and the only thing left that is. Not a write the OS is qualified to make: `runSync()` walks Instantly and EmailBison, reconciles campaigns and pulls introductions from Corofy, and a second implementation would drift. `session.ts` now survives exactly as long as that worker does.

## Still pointing at the live app — reads, and out of scope here

This pass converted the **writes**. Several *reads* elsewhere in the OS still go
over HTTP to `CLIENT_HEALTH_URL` rather than to the database, and they will fail
the day the app is switched off. None of them is a Client Health screen — the
three screens read Supabase directly — but they are listed so the switch-off is
not a surprise:

| File | Endpoint |
|------|----------|
| `src/lib/clients/overview.ts` | `GET /api/clients` |
| `src/lib/workspace/performance.ts` | `GET /api/clients` |
| `src/lib/reconcile/rosters.ts` | `GET /api/clients` |
| `src/lib/reconcile/readers.ts` | `GET /api/clients`, `GET /api/clients/status` |
| `src/lib/tools/onboarding/health.ts` | `GET /api/clients/status` |
| `src/lib/connectors/client-health.ts`, `src/lib/workspace/nav.ts` | health probe — *should* stay an HTTP probe while the app exists |

Each is a `loadDashboard`-shaped read that the OS could already serve itself.

## Routing

No wiring change is needed, so there is no `CLIENT-HEALTH-WIRING.md`. All three
screens were already addressed and all three were confirmed serving:
`/clients` → Weekly, `/clients/biweekly` → Bi-Weekly, `/clients/success` →
Client Success.

> **2026-09-15 — sync worker ported in-process.** `lib/session.ts` (the proxy to the live
> app) is removed; `POST /api/tools/client-health/sync` runs `runSync()` in this process
> with a lock and a fail-closed `CLIENT_HEALTH_SYNC_SECRET` (or the workspace session);
> the `*/15` cron cadence is reproduced by a server ticker started from
> `src/instrumentation.ts` plus the browser tick, both gated by
> `CLIENT_HEALTH_SYNC_ENABLED=1`. `CLIENT_HEALTH_DASHBOARD_PASSWORD` is no longer read by
> app code. Rows 1.7, 1.8 and 2.5 below predate this and describe the proxy era.
