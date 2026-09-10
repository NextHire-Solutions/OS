# Agent Search — parity checklist

**Source of truth:** `NextHire-Solutions/Scrapper` @ `fee0f43` ("15-day refresh: rolling
auto re-scrape of every Courted account", 2026-08-04T15:00:13Z).

**How that was verified — three independent checks, all agreeing:**

1. Ported from the coordinator's fresh clone,
   `/Users/sankalpdutt/Desktop/Code/_os-sources/scrapper`, whose `origin` is
   `github.com/NextHire-Solutions/Scrapper` and whose HEAD is `fee0f43` —
   the **same sha** `gh api repos/NextHire-Solutions/Scrapper/commits/main`
   returns. There are no other branches.

   Work began against `BrokerStaffer-SSO/apps/agent-search` (itself a clone of the
   same repo at the same sha). When the fresh clone arrived, `diff -rq` between the
   two trees returned **exactly two entries** — `web/server/bs-auth.js` (added) and
   `web/server/index.js` (modified): the uncommitted SSO patch described below,
   which had already been excluded from the port. `git show HEAD:web/server/index.js`
   from the old tree is byte-identical to the new clone's. Every file the port
   reads was md5-compared across both trees: all 14 identical. The differential
   test (below) was then re-run against the fresh clone: 48/48 identical. **No
   re-port was required**, and the fresh clone is now the cited source.
2. `curl https://search.brokerstaffer.com` and `.../app.js` are **byte-identical**
   (13060 and 27k bytes) to `web/public/index.html` and `web/public/app.js` at that
   commit. The live deployment is running exactly this code.
3. The Railway service `agent-search` (project `peaceful-purpose`,
   `RAILWAY_PUBLIC_DOMAIN=search.brokerstaffer.com`) has
   `SUPABASE_URL = https://wiybrtexmohfaukadpmb.supabase.co` — identical to
   `AGENT_SEARCH_SUPABASE_URL` in the OS `.env.local`. Same database.

The only local deviation from the commit is an **uncommitted, undeployed** SSO patch
(`web/server/bs-auth.js` + 94 lines in `index.js`). It is not part of the product and
was deliberately excluded from this port — the live service still answers
`/api/status` with HTTP 200 and no cookie, so `BS_SSO_SECRET` is unset in production.

> A separate, much more active repo — `NextHire-Solutions/Databaseproject`
> (pushed 2026-09-10) — owns the `agents` / `offices` / `mls` / `agent_mls` /
> `saved_lists` tables in the *same* Supabase project. It is a different product.
> `DATABASE_APP_URL` in `.env.local` is **empty**, and nav's `search` product is
> bound to `SCRAPER_URL`. See "Finding 2" below.

---

## What the tool is

An **Express** app (`web/server/index.js`, 546 lines) serving a static vanilla-JS
bundle (`web/public/`). It is a **scraping worker with a control panel**, not a
data-browsing app:

```
Courted / Zillow / Realtor  ──scrape──>  in-memory job  ──ingest webhook──>  DB app  ──>  Supabase
                                              │
                                              └── polled by the browser every 1.5s
```

Scraping needs Playwright + Crawlee + a Bright Data unblocker + a Docker image
carrying Chromium, and a single sweep runs for hours. **A Next.js route handler cannot
be any of those things.** So the port is: **pure logic copied verbatim, the two
endpoints that are pure data reimplemented natively, every job endpoint proxied, and
the operational state read natively.** See Finding 4 for what that means for
switching the tool off.

### Endpoint coverage — all 19

| # | Tool endpoint | Here | How |
|---|---|---|---|
| 1 | `GET /api/columns` | `columns` | **native** (ported constants, live upgrade) |
| 2 | `GET /api/status` | `status` | proxied |
| 3 | `POST /api/courted/account` | `courted/account` | proxied |
| 4 | `POST /api/courted/mls-list` | `courted/mls-list` | proxied |
| 5 | `POST /api/courted/mls-scan` | `courted/mls-scan` | proxied |
| 6 | `GET /api/courted/mls-scan/:id` | `courted/mls-scan/[id]` | proxied |
| 7 | `POST /api/courted/mls-scan/:id/stop` | `…/[id]/stop` | proxied |
| 8 | `POST /api/courted/mls-monitor/run` | `courted/mls-monitor` | proxied |
| 9 | `POST /api/courted/refresh/run` | `courted/refresh` | proxied |
| 10 | `POST /api/enrich/resolve` | `enrich/resolve` | **native** (verbatim `resolveInput`) |
| 11 | `POST /api/enrich` | `enrich` | proxied |
| 12 | `GET /api/enrich/:id` | `enrich/[id]` | proxied |
| 13 | `POST /api/enrich/:id/stop` | `enrich/[id]/stop` | proxied |
| 14 | `POST /api/search` | `search` | proxied |
| 15 | `POST /api/search/:id/stop` | `search/[id]/stop` | proxied |
| 16 | `GET /api/search/:id/results` | `search/[id]/results` | proxied |
| 17 | `GET /api/search/:id/master` | `search/[id]/master` | proxied |
| 18 | `GET /api/search/:id/export` | `search/[id]/export` | proxied (byte stream) |
| 19 | `GET /api/search/:id/stream` | — | **not ported, deliberately** — dead code; the tool's own frontend abandoned SSE ("was dropping the realtor record burst") and polls instead |

Plus one endpoint the tool does not have: `GET courted-state`, reading
`mls_monitor_state` and `refresh_state` natively (Finding 3).

---

## Screens — the mockup's five vs. the product

The nav defines five destinations. The live tool is **one long scrolling page**; each
of the five is a real, distinct `<section>` in it. Mapping, verified against
`web/public/index.html`:

| Nav destination | Live element | Exists? |
|---|---|---|
| `search:search` — Search | `<section class="search-card">` + `<section class="results">` | **Yes** |
| `search:master` — Master List | `<section class="panel master" id="panel-master">` | **Yes** |
| `search:accounts` — Courted accounts | `<section class="search-card add-account" id="add-account-card">` | **Yes** |
| `search:mls` — MLS monitor | `<section class="search-card mls-monitor" id="mls-monitor-card">` | **Yes** |
| `search:import` — Import Profile URLs | `<section class="search-card import-card" id="import-card">` | **Yes** |

**No mockup screen is a candidate for removal.** All five are real. See "Finding 2"
for the one that goes the *other* way — an OS screen with no counterpart in the tool.

---

## Feature checklist

Legend: **[x]** ported and working · **[~]** ported with a stated limit · **[ ]** not ported

### 1. Search  (`search:search`)

| # | Feature | Live source | Status |
|---|---|---|---|
| 1.1 | Locations / ZIPs textarea, split on newline + `;` only (never `,` — "City, ST") | `app.js:startSearch` | **[x]** |
| 1.2 | Source toggles: Courted (on), Zillow (on), Realtor.com (off) | `index.html` `.sources` | **[x]** |
| 1.3 | "Show all columns" toggle — full column set vs. `KEY_COLS` | `app.js:22,79` | **[x]** |
| 1.4 | Courted opts: Max results (0=all), Min LTM sales volume, Enrich, All agents | `index.html` `.opt-group` | **[x]** |
| 1.5 | Zillow opts: Max pages/location (≤25), Concurrency, Enrich | same | **[x]** |
| 1.6 | Realtor opts: Max results, Enrich concurrency, Enrich | same | **[x]** |
| 1.7 | `POST /api/search` → `{jobId}` | `index.js:367` | **[x]** proxied |
| 1.8 | Poll `/api/search/:id/results?courted=N&zillow=N&realtor=N` at 1500ms | `app.js:poll` | **[x]** |
| 1.9 | Per-source status pill (idle/queued/running/done/error) + message | `app.js:setStatus` | **[x]** |
| 1.10 | Per-source count badge, `fetched / total` when total known | `app.js:updateCount` | **[x]** |
| 1.11 | `serverCount` — full sweeps stream to the DB, not the table; count still rises | `app.js:262` | **[x]** |
| 1.12 | Search button doubles as Stop → `POST /api/search/:id/stop` | `app.js:stopSearch` | **[x]** |
| 1.13 | Export CSV per source → `/api/search/:id/export?source=` | `app.js:85` | **[x]** proxied, UTF-8 BOM preserved |
| 1.14 | URL cells render as `link`; money cells render `$1,234,567` | `app.js:cell` | **[x]** |
| 1.15 | Inactive source panels dimmed to 0.4 | `app.js:resetUi` | **[x]** |
| 1.16 | New-row flash (`tr.new` for 1s) | `app.js:addRow` | **[x]** |
| 1.17 | SSE `/api/search/:id/stream` | `index.js:453` | **[ ]** dead code — `app.js` polls instead ("SSE was dropping the realtor burst"). Not ported, deliberately. |

### 2. Master List  (`search:master`)

| # | Feature | Live source | Status |
|---|---|---|---|
| 2.1 | "Build master list" enabled only once a job produced rows | `app.js:finishRun` | **[x]** |
| 2.2 | `GET /api/search/:id/master` → `{columns, rows, stats}` | `index.js:461` | **[x]** proxied |
| 2.3 | Cross-source dedup: phone / email / license+lastname / name+city | `merge.js` | **[x]** **copied verbatim** |
| 2.4 | Union-Find clustering | `merge.js:makeUF` | **[x]** verbatim |
| 2.5 | Value preference Courted > Realtor > Zillow on collision | `merge.js:fuse` | **[x]** verbatim |
| 2.6 | `Sources`, `Platform Count`, `Match Basis` meta columns | `merge.js:META_COLUMNS` | **[x]** verbatim |
| 2.7 | Column union across all three sources, Courted-first order | `merge.js:buildColumns` | **[x]** verbatim |
| 2.8 | Sort: multi-platform first, then by name | `merge.js:buildMaster` | **[x]** verbatim |
| 2.9 | Stats line: unique / duplicates merged / on 2+ platforms / per-source | `app.js:buildMaster` | **[x]** |
| 2.10 | Multi-platform rows highlighted (`tr.multi`) | `app.js:renderMaster` | **[x]** |
| 2.11 | Export merged CSV (`?source=master`) | `index.js:469` | **[x]** proxied |
| 2.12 | Button relabels to "Rebuild master list" after first build | `app.js:203` | **[x]** |

### 3. Courted accounts  (`search:accounts`)

| # | Feature | Live source | Status |
|---|---|---|---|
| 3.1 | Add account: email + password | `index.html` | **[x]** |
| 3.2 | `POST /api/courted/mls-list` — log in, enumerate MLSs + exact per-MLS counts | `index.js:219` | **[x]** proxied |
| 3.3 | MLS picker: "Whole account" vs. specific codes, mutually exclusive, never empty | `app.js:renderMlsPicker` | **[x]** |
| 3.4 | `CTD_*` unnamed codes relabelled "Custom list (Courted)" | `app.js:mlsDisplayName` | **[x]** verbatim |
| 3.5 | `POST /api/courted/account` — validate login, write `COURTED_EMAIL_n` to Railway | `index.js:147` | **[x]** proxied |
| 3.6 | Existing account + different password ⇒ **password update**, validated first | `index.js:161` | **[x]** proxied; the distinct "redeploying, click again" message is reproduced |
| 3.7 | Poll `/api/status` until `courtedAccounts >= expected` (survives redeploy) | `app.js:waitForAccounts` | **[x]** 10s delay then 5s ticks, verbatim |
| 3.8 | Auto-sweep after add: `courtedOnly:[email]`, `courtedAllAgents`, `courtedBanded` | `app.js:startAccountSweep` | **[x]** |
| 3.9 | Per-MLS sweep when codes picked (`courtedMlsIds`) | same | **[x]** |
| 3.10 | Stop sweep button | `app.js:295` | **[x]** |
| 3.11 | Header status badge: Courted · N accts, Unblocker · brightdata | `app.js:38` | **[x]** |
| 3.12 | *The list of the nine configured accounts* | — | **[+] NEW** — the live UI never shows them. Read natively from `refresh_state`. See Finding 3. |

### 4. MLS monitor  (`search:mls`)

| # | Feature | Live source | Status |
|---|---|---|---|
| 4.1 | `POST /api/courted/mls-scan` → background job over every account | `index.js:245` | **[x]** proxied |
| 4.2 | Poll `/api/courted/mls-scan/:id` every 2000ms | `app.js:pollMlsScan` | **[x]** |
| 4.3 | Stop scan | `index.js:264` | **[x]** proxied |
| 4.4 | Baseline in **browser localStorage** (`mlsBaseline_v1`) | `app.js:MLS_BASELINE_KEY` | **[x]** same key, same shape |
| 4.5 | Diff vs baseline: `+ added` / `− removed` badges, `changed` marker | `app.js:renderMlsScan` | **[x]** |
| 4.6 | Failed accounts excluded from the baseline (would look "removed") | `app.js:indexScan` | **[x]** verbatim |
| 4.7 | *Server-side baseline* (`mls_monitor_state`, 9 rows) | `mls-monitor.js` | **[+] NEW** — the scheduler writes it every 24h and the live UI never reads it. Now shown. See Finding 3. |
| 4.8 | Scheduler itself (`MLS_MONITOR_ENABLED=1`, 24h, Slack alerts) | `mls-monitor.js:startMlsMonitor` | **[ ]** stays on the live service — deliberately. Its state is displayed. |
| 4.9 | `POST /api/courted/mls-monitor/run` (ADMIN_TOKEN-gated manual run) | `index.js:273` | **[x]** proxied |

### 5. Import Profile URLs  (`search:import`)

| # | Feature | Live source | Status |
|---|---|---|---|
| 5.1 | Google Sheet link input | `index.html` | **[x]** |
| 5.2 | CSV paste textarea | same | **[x]** |
| 5.3 | `.csv` file picker → FileReader into the textarea | `app.js:importFile` | **[x]** |
| 5.4 | Concurrency (1–8, default 4) | `index.html` | **[x]** |
| 5.5 | "Run on a schedule" checkbox | `index.html` | **[~]** rendered; the live tool only appends a sentence to a message — it is **not implemented there either** (`app.js:610`). Same behaviour, same caveat text. |
| 5.6 | `POST /api/enrich/resolve` — counts + est. cost, no scraping | `index.js:308` | **[x]** proxied |
| 5.7 | Sheet → CSV export URL rewrite, no API key | `sheet-source.js:toCsvExportUrl` | **[x]** **verbatim** |
| 5.8 | RFC4180-ish CSV grid parser (quotes, `""`, CR/LF) | `sheet-source.js:parseCsvGrid` | **[x]** verbatim |
| 5.9 | Header alias detection (10 fields, first-match-wins, one column each) | `sheet-source.js:HEADER_ALIASES` | **[x]** verbatim |
| 5.10 | Fallback to bare-URL scan when no real header | `sheet-source.js:parseDataset` | **[x]** verbatim |
| 5.11 | De-dupe on normalized URL | same | **[x]** verbatim |
| 5.12 | `detectSource` — zillow.com/profile vs realtor.com/realestateagents | `profile-parser.js` | **[x]** verbatim |
| 5.13 | Cost estimate `n * 0.0015` to 3dp | `index.js:enrichCost` | **[x]** verbatim |
| 5.14 | `POST /api/enrich` → `{enrichId,…}` | `index.js:319` | **[x]** proxied |
| 5.15 | Poll `/api/enrich/:id?offset=N` every 1500ms | `app.js:pollImport` | **[x]** |
| 5.16 | Progress bar + counter tags: scraped / new / enriched / skipped / dead / blocked+err / cost | `app.js:updateImportProgress` | **[x]** |
| 5.17 | Results table: Status, Source, Name, Phone, Email, License, Profile URL, Note | `app.js:IMPORT_COLS` | **[x]** |
| 5.18 | Human-readable Note per status (blocked/dead/skipped/error) | `app.js:importNote` | **[x]** verbatim |
| 5.19 | Stop enrichment | `index.js:361` | **[x]** proxied |
| 5.20 | Pre-scrape DB cross-check (skip agents already in `agents`) | `reconcile.js` | **[ ]** runs **inside the live service** during the job; its outcome shows up as `skipped` rows. The normalizers are ported + tested for the UI's own use. |

### 6. Cross-cutting

| # | Feature | Status |
|---|---|---|
| 6.1 | `GET /api/columns` — full per-source column lists | **[x]** ported as static constants **and** proxied (see `columns.ts`) |
| 6.2 | `GET /api/status` — courted / courtedAccounts / unblocker | **[x]** proxied |
| 6.3 | CSV writer with UTF-8 BOM (Excel accents) | **[x]** verbatim, tested |
| 6.4 | 15-day rolling refresh scheduler | **[ ]** stays live; `refresh_state` is displayed |
| 6.5 | `POST /api/courted/refresh/run` | **[x]** proxied |
| 6.6 | Slack alerting | **[ ]** stays live (correct — one alert source) |
| 6.7 | `ADMIN_TOKEN` header pass-through | **[x]** `AGENT_SEARCH_ADMIN_TOKEN`, optional |

---

## Findings needing the user's decision

### Finding 1 — the three scraper tables do not exist

`web/server/schema.sql` defines `courted_agents`, `zillow_agents`, `realtor_agents`.
Probed against the live Supabase with the service-role key, **all three return HTTP
404** (`mls_monitor_state` and `refresh_state` return 206 with 9 rows each). So
`db.js:persistSource` — which catches and only logs — has been failing silently on
every scrape. It is dead code: the real write path is `ingest.js` → the DB app's
`/api/ingest/agents` webhook, which is what `INGEST_TOKEN` is for. Nothing is being
lost, but `db.js` is misleading and `schema.sql` is wrong. **Not a port issue** — no
port action taken. Flagged for the tool's own repo.

### Finding 2 — an OS screen with no counterpart in the tool

`src/components/screens/agent-search/agents.tsx` (currently wired to `search:search`)
is a **browser for the `agents` / `offices` / `mls` / `saved_lists` tables** — 1.17M
rows. Those tables belong to `NextHire-Solutions/Databaseproject`, a *different*
product. The Agent Search scraper has no such screen: it never reads those tables,
only writes to them through the ingest webhook.

It is a genuinely useful screen and it works. But it is not one of the five, and
`search:search` must be the tool's actual Search screen. **This is the reverse of the
question asked** — not a mockup screen missing a product, but an OS screen belonging
to a product that is not yet in the nav.

**Left in place, not deleted.** Three options, user's call:
  a. give it a sixth nav leaf under Agent Search ("Agent database");
  b. move it to its own product once `DATABASE_APP_URL` is filled in;
  c. drop it.
Wiring for (a) is written out in `AGENT-SEARCH-WIRING.md`.

### Finding 3 — two live datasets the tool collects but never shows

The scheduler writes `mls_monitor_state` (9 accounts, their full MLS lists, scan
timestamps) and `refresh_state` (9 accounts, last refresh time/status/message) every
24 hours. **The tool's own UI reads neither.** The MLS monitor screen diffs against a
baseline in one browser's localStorage, so it is blank on a new machine and disagrees
between machines, while the authoritative server baseline sits unread.

Both are now read natively over the OS's Supabase client and shown. This is the one
place the port is deliberately *ahead* of the tool, and it is marked `[+] NEW` above
rather than claimed as parity.


---

## Test results

Every number below is real output, reproduced in the report.

### Differential — is "verbatim" true?

A harness imports the TOOL'S OWN `merge.js`, `sheet-source.js` and
`profile-parser.js` from the authoritative clone and runs them against the ported
TypeScript on identical input, asserting deep equality.

```
  48/48 identical  — ports are exact
```

Covering `buildMaster` (columns, rows, stats) across all four match bases plus
non-matches, `parseCsvGrid` / `parseDataset` / `summarize` / `extractUrls` over six
CSV shapes, `toCsvExportUrl` over five links, and `detectSource` / `normalizeUrl`
over seven URLs.

### Unit — `node --test`

```
  ℹ tests 56    ℹ pass 56    ℹ fail 0
```

Whole repo, confirming nothing else broke:

```
  ℹ tests 334   ℹ pass 334   ℹ fail 0
```

Guard:

```
  node --test src/lib/guards/blast-radius.test.ts
  ℹ tests 6     ℹ pass 6     ℹ fail 0
```

### UI — real Chrome over CDP, no Playwright

Driving the REAL workspace routes through the real shell — `/search`,
`/search/master`, `/search/accounts`, `/search/mls`, `/search/import` — not a
harness:

```
  node scripts/agent-search-ui-test.mjs
  37 passed, 0 failed
```

Highlights, verbatim from the run:

```
    ok  header renders with live status badges  → Courted · 9 accts
    ok  Options reveals 3 groups, 6 numeric fields and 5 checkboxes
    ok  empty search is refused, not sent  → "Enter at least one location or ZIP…"
    ok  no scrape was started
    ok  nine live Courted accounts listed  → 9 rows
    ok  MLS names resolved, not raw codes
    ok  the scheduler's last scan is shown without scanning  → 9 account blocks
    ok  server baseline is the default comparison
    ok  no-baseline accounts are not falsely marked changed
    ok  Detect parses the CSV: 2 URLs, 1 Zillow, 1 Realtor, cost estimated
    ok  Start enrichment is now enabled (NOT clicked — it costs money)
    ok  no console errors
    ok  no failed requests
```

### Layout — nothing overflows

Five real routes × three widths (1440 / 1180 / 1024), Options expanded:

```
  15/15 screen×width combinations fit the viewport
```

Every screen reports `doc overflow 0px · 0 element(s) past the edge`. The only
horizontal scrollers are the accounts table at the two narrower widths —
`tbl-scroll (788→940)` and `tbl-scroll (632→940)` — scrolling inside their own
box, which is the correct behaviour and the reason 77-column tables are viable
at all.

### Data safety

`scripts/agent-search-fingerprint.mjs`, before and after all testing:

```
    agents                 1174131 (+4)
    agent_mls              1333458 (+11)
    offices                 177828 (unchanged)
    mls                         54 (unchanged)
    saved_lists                 31 (unchanged)
    mls_monitor_state            9 (unchanged)
    refresh_state                9 (unchanged)

  ✅ no table shrank · no Courted account lost · no MLS reach fell
```

The `+4` / `+11` are the **live service's own** 15-day refresh scheduler running on
Railway during the session. This port issued **zero writes**: the only POSTs made were
to `enrich/resolve`, which parses text locally and touches no database.

### What was deliberately NOT executed

Five controls spend money or hammer a third party. None was fired:

| Control | Why not |
|---|---|
| **Search** | Bright Data traffic + Realtor.com credits, hours of a shared container |
| **Add account & start sweep** | writes Railway vars → redeploy → re-scrapes up to 866,000 agents |
| **Detect MLSs** | logs into Courted with real credentials |
| **Scan all accounts** / **Run monitor now** | logs into all nine Courted accounts |
| **Re-scrape** | a full whole-account sweep |
| **Start enrichment** | ~$1.50 per 1,000 profile fetches |

Instead their request bodies are asserted by 11 tests against pure builders in
`payload.ts` — exact objects, no request — and the proxy plumbing was proven with
nonexistent job ids, which reach the live service and return its real 404s:

```
  GET  search/nope-123/results   {"error":"job not found"}[404]
  GET  search/nope-123/master    {"error":"job not found"}[404]
  GET  search/nope-123/export    job not found[404]
  GET  courted/mls-scan/nope-123 {"error":"scan not found"}[404]
  GET  enrich/nope-123           {"error":"enrich job not found"}[404]
  (identical to the same calls made directly against search.brokerstaffer.com)
```

And the natively reimplemented `resolve` was checked against the live service on the
same input — **byte-identical**:

```
  ours  {"total":2,"zillow":1,"realtor":1,"withIdentity":1,"estCostUsd":0.003}
  live  {"total":2,"zillow":1,"realtor":1,"withIdentity":1,"estCostUsd":0.003}
```

---

## Finding 4 — switching Agent Search off breaks 16 of the 19 endpoints

The brief is that the OS replaces the tool and the tool is then switched off. That is
achievable, but not by this port alone, and the distinction matters:

**What can be switched off today:** the tool's *UI* — `web/public/`, and the Express
static handler in front of it. Everything a person does with Agent Search is now done
here. Nobody needs to visit search.brokerstaffer.com again.

**What cannot be switched off:** the *worker*. Sixteen of the nineteen endpoints are
proxied because they drive a headless Chromium through a Bright Data unblocker, hold
nine Courted sessions, write Railway variables, or read jobs held in one container's
memory. Two schedulers also run in that process — the 24-hour MLS monitor and the
15-day refresh — and both are on right now (`MLS_MONITOR_ENABLED=1`,
`REFRESH_ENABLED=1`). Stop the service and scraping stops.

So the honest end state is: **Agent Search becomes a headless worker with no UI, and
the OS is its only control surface.** That is what this port delivers.

Genuinely absorbing the worker is a separate piece of work, and it is not small:

1. a long-running process (not request handlers — a sweep runs for hours);
2. Chromium in the OS's deploy image, plus Playwright and Crawlee;
3. a durable job store, since `jobs.js` keeps jobs in a `Map` and a redeploy loses them;
4. moving nine Courted credentials, the Bright Data token and the Railway token;
5. relocating the two schedulers;
6. a decision about `ingest.js`, which posts into the **Database app**, not this one.

Worth doing deliberately, and worth not pretending is done. **Needs the user's
decision on sequencing.**
