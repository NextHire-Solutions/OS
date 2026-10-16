# BrokerStaffer OS — Developer Handover

**Written 25 September 2026. Re-verified 26 September.** Every number here was
measured live against the four production databases, not remembered. Where a
figure will age, the query that produced it is given so you can re-run it.

---

## Contents

| | |
|---|---|
| **0** | [Read this first](#0-read-this-first) — what this project is, in five minutes |
| **0.1** | [BrokerStaffer OS for Claude, 15 October](#01-brokerstaffer-os-for-claude-15-october) — a read-only connector: admins add the OS to Claude and ask it anything the Assistant can answer |
| **0.2** | [Interested leads → Slack, 14 October](#02-interested-leads--slack-14-october) — one Slack post per conversation newly labelled Interested, to #client-interested-updates; needs Master Inbox migration 0033 |
| **0.3** | [OS feedback batch, 13–14 October](#03-os-feedback-batch-1314-october) — ~45 items across the OS, LIVE 14 Oct (`28d910b`, standalone inbox `840094f`); what each became, what was not done, what was never exercised |
| **0.4** | [Campaign leads: search by office city, and a Location filter, 13 October](#04-campaign-leads-search-by-office-city-and-a-location-filter-13-october) — two asks on the Leads tab; needs analytics migration 097 |
| **0.5** | [Client Portals as its own product, 13 October](#05-client-portals-as-its-own-product-13-october) — its own menu section and Team access switch, deleting one portal, and a count that matches Consistency |
| **0.6** | [SMS alerts for introductions, 13 October](#06-sms-alerts-for-introductions-13-october) — the standalone inbox's SMS switches, now obeyed (and set) by the OS |
| **0.7** | [Master Inbox parity, 12 October](#07-master-inbox-parity-12-october) — twelve things the standalone inbox did that the OS inbox did not; the Clients panel beside a conversation |
| **0.8** | [Navigation clean-up, 9 October](#08-navigation-clean-up-9-october) — removed and renamed screens, Campaign Management, what old links open |
| **0.9** | [What changed on 6–7 October](#09-what-changed-on-67-october) — profile completeness, billing across subscriptions, failed payments and portal blocks, introductions, the assistant |
| **0.10** | [What changed on 30 September](#010-what-changed-on-30-september) — Clients as the master client system, §8 tool views, §15 dictionary, one status visual |
| **0.11** | [What changed on 29 September](#011-what-changed-on-29-september) — Client Health billing cycles and Play/Pause; one look across the OS |
| **0.12** | [What changed on 28 September](#012-what-changed-on-28-september) — the latest work, how it was verified, what is open |
| **0.13** | [Switching off Analytics, Client Health and Onboarding](#013-switching-off-analytics-client-health-and-onboarding) — what is ready, the order, and what needs people |
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
  open question in §6.5. The one that was an accident — the Database app's
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

Scored against §22, the client's own Definition of Done: **19 of 25
requirements met**, 5 partly met, 1 not met — and the one unmet requirement is
deliberate, not outstanding: the standalone tools keep their own Add Client
buttons because they stay live and clients use them. See §6 for what remains.

---

## 0.1 BrokerStaffer OS for Claude, 15 October

**What was asked.** "An API for BrokerStaffer OS so the client can access
everything via Claude … it should have knowledge of each and everything."
Built as an MCP connector: `https://os.brokerstaffer.com/api/mcp`. Commit
`5c33da2`, deployed to Railway `os`. No migration, no new setting.

**Connecting (each admin, once).** In Claude: Settings → Connectors → Add
custom connector → name "BrokerStaffer OS", URL
`https://os.brokerstaffer.com/api/mcp` → Connect. Claude opens the OS login
(the normal one), then "Connect Claude" → **Allow**. Custom connectors need a
paid Claude plan; on Team/Enterprise an owner adds it for the organisation and
each person then connects with their own OS login. It then works in claude.ai,
Claude Desktop and the mobile apps.

**What Claude gets.** Every Assistant tool (44) plus `os_guide` — the
Assistant's briefing (products, vocabulary, which tool answers what, every
release note), sent both as the server's instructions and as that tool.
One set of tools: a tool added to the Assistant (`TOOL_SCHEMA` + `HANDLERS`
in `lib/tools/assistant/engine.ts`) is in Claude on the next deploy.

**Rules.**

| Rule | Where |
|---|---|
| Read-only — every tool runs through the Assistant's write-refusing guard and is marked `readOnlyHint` | `lib/mcp/tools.ts`, `tools/assistant/read-only.ts` |
| Admins only (the Assistant's rule), re-checked on EVERY request: deactivated, admin removed, password changed (`token_version`) or "log everyone out" (`SSO_SESSIONS_NOT_BEFORE`) → refused at once | `lib/mcp/access.ts`, `oauth.ts authenticate` |
| Sign-in = the OS login + an Allow page; Claude never sees a password | `app/oauth/authorize/page.tsx`, `app/api/oauth/authorize/route.ts` |
| OAuth 2.1: discovery (RFC 9728/8414), dynamic registration only for Claude's callbacks and loopback, code + PKCE S256 only, refresh tokens | `lib/mcp/oauth.ts` |
| Tokens stateless, signed with per-kind keys derived from `AUTH_SECRET`: a connector token never opens the OS as a cookie, nor the cookie the connector. Access 1 h, refresh 30 days, code 5 min | `lib/mcp/tokens.ts` |
| Open at the proxy: only `/api/mcp`, `/api/oauth/token`, `/api/oauth/register`, `/.well-known/*`. The Allow page and its POST need the OS session; Allow from another site's Origin is refused | `src/proxy.ts` |

**Reading it in production.** Railway logs of `os`: `[mcp] <email> <tool> ok|failed <ms>`
for every tool call, `[mcp-auth] <email> connected <client>` for every Allow,
`[mcp-auth] token … refused: <why>`. To cut everyone off at once: set
`SSO_SESSIONS_NOT_BEFORE` (it logs everyone out of the OS too).

**Verified.** 22 unit tests (21/21 deliberate breakages of the security rules
caught); 1,980 tests in all; production build; on a local build against live
data, the whole sign-in and use as Claude performs it (26/26: discovery,
registration, login redirect, Allow, PKCE exchange, 45 tools, four real tool
calls, refresh, every refusal); the Allow page in Chrome as an admin, a
non-admin and at phone width (6/6). Then the same 26 checks against
production after the deploy (deployment `1320cb61`): 26/26, `client_report`
3.6 s, `list_clients` 0.6 s. Not yet done by a real Claude account — the first
admin to connect is that test.

### 16 October: the agent database in Claude (and the in-OS Assistant)

"For mcp, we need to check the database project supabase as well (onboarding
and scraper project uses same supabase project) … example of question: How
many agents are there in, let's say, Dallas?" That Supabase is the one the OS
already calls Agent Search (`AGENT_SEARCH_SUPABASE_*`, same host as the
Database project's `NEXT_PUBLIC_SUPABASE_URL`); it was only missing tools.
Three new tools, one extended — 48 in the connector:

| Tool | Answers | Reads |
|---|---|---|
| `search_agents` | agents (or offices) in a city/county/state/zip, with MLS, brokerage, office, sales volume, transactions, has email, emailed or not, replied, one client's lists; optional top N (no contact details) and top brokerages | the Database app's own `fn_filter_search`, `fn_search_options`, `fn_facet_options` — STABLE, so the count is the one its Agent Search screen shows |
| `agent_places` | cities/counties/zips of a state, states, or brokerages nationally, ranked | `location_options` (the place index its Location filter lists; refresh time returned) |
| `onboarding_records` | the onboarding app's own status, stage, copy status, sender, intro log per client | `orch_*`; its Stripe and campaign fields are left out (all "unpaid"/empty on 16 Oct — not true) |
| `find_agent` (extended) | now also the campaigns an agent is a lead in, replied/bounced | `v_agent_campaigns` |

A place matches an agent's office, home OR most-transacted location (as the
Database screen defaults); the answer gives each separately too. Without a
state, the largest place of that name is counted and the others listed —
Dallas = Dallas, TX 15,484 agents (11,667 by office), Dallas, GA 972. Live
figures on 16 Oct: whole database 1,188,261; Dallas County, TX 22,568; Texas
138,863; NTREIS 57,084. Parsing and the filter are pure and tested
(`assistant/agent-query.ts`); the tools are `assistant/tools-phase10.ts`.

The read-only guard now also refuses the agent database's writers
(`fn_update_*`, `fn_set_*`, `fn_rebuild_*`, `fn_rollup_*`) and its `_timeit`/`_t2`
helpers, which run whatever SQL they are given.

### Also 15 October: account managers get Client Portals

Asked by the user. The **Account manager** role on Team access now brings
Client Portals with it, the way it already opens the Clients page — a rule
(`src/lib/identity/role-grants.ts`, applied in `identity/store.ts
findByEmail`), so the session token carries it and the proxy, menu and APIs
follow unchanged. Team access shows that switch On and locked ("Comes with the
Account manager role"); inviting an account manager no longer requires another
tool. Taking the role away removes it unless Client Portals is also switched on
for them. Deleting a portal stays admins only. Commit `d0a3546`, deployed;
verified on production through each account manager's real session refresh
(Amy, Gabriel, and Eddy as admin: Client Portals granted, `/portals` 200), and
in Chrome on a local build (10/10).

### Also 15 October: one correct introductions count (and migration 0078)

Asked by the user: 54 Realty showed 34 introductions in the OS and 50 in its
portal. Both were wrong in a different way — the true figure is 53:
- the OS counted only conversations labelled Introduction, so it missed the
  portal's introductions that have no Master Inbox conversation (history
  loaded when the portals opened — 19 of 54 Realty's, 413 overall);
- 123 labelled introductions (27 portals, May–Sept 2026) never reached the
  portal: the label trigger skips a conversation with no client and nothing
  revisited it when the client was set.

Fixed: `src/lib/tools/master-inbox/portals/intro-counts.ts` (and the same file
in the standalone app) counts our portal entries (not the client's own "Client
Entry" candidates) plus labelled conversations with no entry; the client
record says "N not in the portal". Every introductions figure in both apps uses
it. **Migration 0078** (standalone repo) creates the portal entry when a
labelled conversation gets its client later — for introductions from 15 Oct
on. **No backfill** (user decision): the 123 old ones stay out of the portals
and are shown as "not in the portal". Known gap: an entry created late this way
sends no SMS / Bison / Follow Up Boss notification. OS `0df2a54`, standalone
`3fb860e`, both deployed; 0078 is run by hand in the Master Inbox database.

### Also 15 October: every page and product has its own switch on Team access

Eddy: "All products should be on settings and I can choose who sees what."
Team access now has ten switches, grouped as the menu is — Workspace:
**Clients, Commissions, Performance**; Products: Master Inbox, Client Portals,
Client Health, **Campaign Analytics, Campaign Management, Inboxes**, Agent
Search. Before, Clients and Commissions followed the Account manager /
Salesperson roles, Performance was admins-only, and one switch opened all of
Campaign Analytics, Campaign Management and Inboxes. Roles no longer open
pages (Commissions still shows a non-admin only their own payouts). Team
access itself, the Assistant, Consistency, Reply agent and the Claude
connector stay admins-only. The 14 Oct "account managers get Client Portals"
rule is gone; Client Portals is an ordinary switch.

- New tool ids appended to `ALL_TOOLS` (`roster`, `commissions`,
  `performance`, `campaigns`, `inboxes`); every URL is unchanged.
- The three analytics sections are still one tool: the proxy picks the switch
  by section (`tool-paths.ts grantsForRequest`, any-of). Inboxes' data needs
  Inboxes; reading campaign data needs Campaign Analytics or Campaign
  Management; **changing a campaign needs Campaign Management**; Campaign
  Analytics' own settings need Campaign Analytics. A test fails when a new
  write route is added without a decided switch.
- Clients, Commissions and Performance are decided by `nav.ts canSeePage`
  (page and page guards). Clients' billing pause/resume and inbox rows follow
  the Clients switch.
- `switch-transition.ts`: sessions signed before the deploy were read as they
  were meant until they renewed, so nobody at work was sent Home by it. Its
  cut-off was moved to 16:00 UTC (`7b62fa5`) so Eddy's own changes applied at
  once; it is inert now and can be deleted in a later clean-up.
- Data: to keep what they had, Amy and Gabriel had Clients, Commissions,
  Client Portals, Campaign Management and Inboxes switched on at the deploy.
  Eddy did not want that and set them himself at 16:21 UTC (Commissions off
  for both, Inboxes off for Amy). **Rule from this: never switch new access on
  for anyone by default — leave it off and let Eddy decide.** (The Commissions
  page only ever showed a non-admin their own earnings.)

Commit `d50aa4f`, deployed. Verified: 2,025 tests, 18/18 mutations caught,
38/38 in Chrome on a local build (three widths, seven access profiles, a
pre-deploy session), 41/41 on production.

### 16 October: the client's portal redesign, as an Owner-only preview

The client sent a redesign of the client portal ("BrokerStaffer CRM": 56
mockup screens, README, tokens). The user: "we do not change our current
client portals. first we need to see and experience this for few clients",
then: "make sure clients cannot see this and client portals do not get
broken … not all team should see this … do not add this to product switch …
only we should be able to see this".

**`/crm-preview`** draws the design on any client's real data — pick a client,
then every page of the design's sidebar: Pipeline (board and list, stage and
tag chips, the five time ranges, search, the agent panel, the read-only
conversation, notes, Manage stages opened read-only), Reports (All market and
Interested only), Campaigns (a coming-soon page in the design too), Market,
Prospects, My Agents, DNC List, Team, Integrations and Help — and since the
evening of 16 Oct every one of the handoff's 55 screens: its pop-ups (Add
agent, Upload CSV, Edit lead with Add field, My Agents / Team / DNC add and
import), ticked-row states (the bulk bars, Move to, Assign to, Select all),
Market's row menu, selection bar and no-results state, Prospects' empty state,
the support chat, and the six-step Setup wizard (top bar › Setup wizard;
`view=setup&step=1…6`, on the client's real team, lists, market and
prospects). Fields take typing and menus open; every Add, Save, Import, Move,
Delete and Send is inert. Only Billing (a link to Stripe) is not drawn.

**Market, Prospects and Reports** (added later on 16 Oct) read the agent
database — the Database project's Supabase — through two Owner-only GET routes,
`/api/crm-preview/market` and `/api/crm-preview/report` (`lib/crm-preview/market.ts`):
- *Market* = every agent in an MLS on the client's record
  (`os_clients.mls_codes`; Areas are free text and not used). A code the agent
  database lacks is named, never guessed — 5 of our 35 codes (ECOAR, realMLS,
  CHMLS, REcolorado, SEFMLS; the database has ECAOR, CHSMLS, SEFMIAMI). 14
  clients have no MLS, so no market. C21: 115,720 agents.
- *Prospects* = the agents in the client's lists in the agent database — the
  Database app's own client filter (its campaign leads). C21: 12,100.
- The List column: DNC List, My Agents, In your pipeline, Prospects or Not on
  a list — matched by email, by full name only where the list entry has no email.
- Counts are the Database app's own (`fn_filter_search`, `fn_facet_options`,
  both STABLE), so they equal its Agent Search screen. Reports' brokerages are
  its exact brand counts (it lists the largest 50, so the card says "Top 8 of
  50+ brokerages"); office cities are its Location view by office, city level —
  every city's agents and how many cities (C21: ~1,450; the agents with no
  office city are "Unknown"). A report's counts run four at a time and are kept
  30 minutes. "Years licensed" is recorded for ~1 agent in 80 — its menu says so.

| Rule | Where |
|---|---|
| **Owners only** (`ADMIN_EMAILS`), **plus Eddy by name** as its reviewer (16 Oct — he asked to review before any launch; the user chose to open the preview to him, not to every admin: `PREVIEW_REVIEWERS`). Not other admins, not account managers. Anyone else gets Not found. Owners fail closed when `ADMIN_EMAILS` is unset | `lib/crm-preview/access.ts`, `app/crm-preview/page.tsx` |
| Not a product: no menu item, no Team access switch, no grant, nothing in the proxy | test `access.test.ts` |
| **Read-only**: reads what the portal reads (`portal-data.ts`); every add/edit/delete/save is drawn exactly as the design draws it (not greyed) and is inert — `RO` in `k.ts` marks it, the preview's frame catches the click and says "read-only" (what the design itself shows disabled, like the bulk bar, stays disabled); the browser's requests are GETs only (the conversation feed and the two data routes). A test fails on any write call in the preview's files | `access.test.ts`, `components/crm-preview/k.ts` |
| The live portal (portal.brokerstaffer.com, the standalone app) is untouched — no code, URL, stage or lead changed | — |
| The Follow Up Boss key never reaches the browser, only whether one is saved | `page.tsx` |
| The two data routes: Owners only, checked first, GET only, a bare 404 for anyone else; the agent database only through the read-only guard and only its two search functions | `api/crm-preview/*`, test `access.test.ts` |
| The design's CSS is generated from the handoff with every class prefixed `crx-`, so it and the OS's `.app`/`.rail`/`.card` never meet. Re-run on a new handoff: `node scripts/crm-preview-css.mjs <folder>` | `app/crm-preview/crm-preview.css` (generated), `preview.css` (the preview's own) |

How the design is read on today's data (`lib/crm-preview/model.ts`): the
forward stages (the client's own names, Interview Scheduled only where the
client has it) are columns; **Nurture, Not a Fit and No Response are tags**,
as the design asks. Today they are stages, so such an agent has no forward
stage: as Eddy approved (16 Oct), the preview places them at the **furthest
forward stage on record** before the tag (`pipeline_outcome_events`), else the
first stage, with the tag under the name. A stage chip
counts everyone at the stage, a tag chip shows that tag's agents in their
columns. Nothing is moved — read, not written.

**Fidelity (audited 16 Oct, screen by screen against the handoff's 55
screenshots):** every fixed text of the design is on the preview and nothing
else is (copy compared both ways by script), every element's computed style
was compared with the handoff's in the same browser, the handoff's own pages
and the preview were compared pixel by pixel in the same browser (the
sidebar, headers, toolbars, Reports, My Agents, DNC and Team identical), and a
second reviewer compared the screenshots independently. The preview uses the
handoff's own font files (Inter Tight 400/500/600, `app/crm-preview/fonts`),
not Google's newer cut. `scripts/crm-preview-css.mjs` merges all 55 screens'
stylesheets: four families define a few names differently (`.dlg`, `.ov`,
`.drop`, `.bulk`, `.sec`…), so each family's are renamed (.adlg/.aov/.adrop/
.abulk for the list pages, .sbulk/.ssec/.snx/.sacts for Setup, .mmenu/.mlnk for
Market, .rlg for Reports) and its element rules are scoped with `:where()` so
they keep the handoff's specificity. The OS's global styles
(Tailwind's reset, workspace.css, ds.css) had leaked into the design — line
height, box sizing, form controls, table header and row borders, antialiased
text; `preview.css` puts the design back on the browser's defaults (icons
excepted — reverting an SVG's attributes erases it). Two quirks of the design's
own CSS are reproduced, as delivered: on its board screens the sidebar's
collapse button shares `.col` with a board column (the collapsed sidebar's big
gap), and on Reports its legend's `.lg` draws a faint line under the logo. The
preview adds nothing the design lacks except, to fit real data: the dark
preview bar on top (with, on Market and Reports, what "market" means for this
client); the board scrolls sideways to every column (the mockup clips at four)
and holds to the window's height; a picked chip is highlighted; long tables
(My Agents, DNC) page 50 at a time with the design's own list footer; DNC
companies are listed under the agents (the design only counts them); an email
is shown as text from its HTML part without the quoted history; the chat's
example conversation is marked "Example conversation" (the design: "Today"),
since no chat exists; the Setup welcome line shows the client's areas (the
design: "Done For You · Atlanta" — no plan is on record). Not drawn: Billing (a
link to Stripe). The audit drove a real Chrome, GETs only.

**Data protection (17 Oct).** The user: "no one should be able to extract
data from this new client portals" — the agent database behind Market,
Prospects and Reports is the sensitive part (C21's market alone is 115,720
agents). Nothing on a screen can be made uncopyable by hand; bulk extraction
is refused by the server and noticed (`lib/crm-preview/data-guard.ts`, tests
`data-guard.test.ts`):
- only the page's own fetch is served — a request without the browser's
  same-origin fetch headers (curl, a script, a scraping tool, even one holding
  a copied session cookie) gets 403; signed out gets 401 at the proxy;
- per person: requests a minute and agent rows a day (staff 120/min,
  60,000/day; the client limits, 30/min, 2,000/day, 20 reports/day, are
  defined for the client build);
- one search goes 1,000 agents deep at most (`MAX_ROWS`, 20 pages of 50) —
  past that, narrow the filters;
- a market agent's or a prospect's email never leaves the server; only
  agents already on the client's own lists (My Agents, DNC, its pipeline) carry
  one, and only in the Setup tables;
- every data response is `no-store` and `noindex`; every request is logged
  (`[crm-preview] data`), every refusal warned (`[crm-preview] refused`).

Must-haves before ANY client sees the new portal's Market / Prospects: every
person signs in (no data behind a shareable link, unlike today's portals);
the counters move to the database (one per person and per client) with an
alert to staff and an automatic lock when exceeded or when paging looks
automated; no export of the market or prospects (exports only of the client's
own lists); a bot challenge on suspicious use; a few canary agents per client
so a leaked list can be traced; an anti-scraping clause in the client terms.

Eddy's decisions (16 Oct, two rounds): stages → tags **yes**, and a tagged
agent stays at the furthest forward stage on record — **approved** (of 971
agents in the three today, 90 went past Introduction; the other 881 have only
Introduction on record, history being kept since 3 Aug). Pipeline entry: a
**per-client switch** — existing clients keep Introduction, new clients enter
at Interested, via **Postmark** (confirmed). Text alerts: yes, where enabled.
Prospects: added to live campaigns automatically; DNC **and My Agents** removed
from campaigns — approved (My Agents never has been; a change to live
campaigns). Billing: clients can update, cancel and see paid invoices; a
client who cancels in the Stripe portal is marked **Churned**; and clients
should be able to **pause until a date** on the portal (new). **"Do not launch
this new CRM until we've reviewed it on Demo Portal or on a staging
environment."** None of this is built for real clients; the preview reads only.

### 16 October: a portal's URL can be changed from the OS — the old link keeps working

Amy could not change Jeff Cook's portal URL: the OS refused any change to
`clients.portal_token` (`assertPortalUrlStable`), because a portal's URL IS its
token and a new one killed every link the client already had. The user: "we
need a system to control things from here".

- **Master Inbox migration 0079** — `portal_token_aliases` (old token → portal)
  and a trigger on every change of `clients.portal_token`, from either app:
  keeps the old token, refuses a token that is another portal's old one,
  and a portal going back to its own old token makes it current again.
  Additive; tested on a local Postgres (10 cases) before it was handed over.
- **The portal app** (`beba2ed`): a token that finds no portal is looked up
  there and forwarded to the portal's current link (its front page — every
  link we send is the front page). Off / Unknown portals stay "not found" on
  old links too. Without the table: "not found", exactly as before.
- **The OS** (Client Portals → Portals → pencil): the change is allowed only
  when 0079 is in (otherwise a clear refusal, nothing written); the OS
  records the old token itself before changing, as well as the trigger;
  "Keep the old link working" is ticked by default and can be unticked on
  purpose (the old link then stops at once). Anyone with the Client Portals
  switch, as before. The inbox-row rename still never touches the URL.

Order used: portal app, then OS, then the migration — nothing could change a
URL before old links forward.

## 0.2 Interested leads → Slack, 14 October

**State, 14 Oct 2026.** Code LIVE: `a896bb3` on `main`, deployed to Railway
`os` (deployment `53c5b4a6`, SUCCESS 14:26 UTC) from a clean export, with
`MASTER_INBOX_SLACK_CHANNEL_INTERESTED=C0C941UQCHE` set. Migration 0033 was
run in the Master Inbox database the same day (confirmed: the table now accepts
the kind). The bot must also be in the channel — its membership cannot be read
(no `channels:read`). No test post was sent — the first real Interested lead is
the test, and its result is in the logs and in `side_effect_outbox`.

**What was asked.** Amy (via Eddy, in Slack): a channel that is told whenever
a lead is labelled **Interested** in Master Inbox. Eddy gave the channel:
`C0C941UQCHE`, #client-interested-updates, in the BrokerStaffer workspace.

**What it does.** When a conversation is labelled Interested — by the AI as a
reply arrives (that happens in the standalone inbox, which receives the
EmailBison webhooks) or by a person in either app — the OS posts one message
to that channel: the client, the lead's name, email and phone, their
brokerage, the campaign, the first 280 characters of their reply (quoted
history stripped), and a link to the conversation in the OS
(`/inbox/all-email/<thread id>`).

**The rules, all tested** (`interested-alerts.test.ts`, 9 tests;
`interested-alert.test.ts`, 7; 13/13 mutations caught):

| Rule | How |
|---|---|
| Once per conversation, ever | Claimed in `side_effect_outbox` as kind `slack_interested`, subject = thread. Its unique index (workspace, kind, subject) lets exactly one claim succeed — re-labelled, labelled in both apps, or seen by two sweeps, it posts once. |
| No backfill | Only assignments since go-live, `2026-10-14T02:00Z` (`INTERESTED_ALERTS_FROM`), and within the last 30 minutes. |
| Never Demo Portal | Checked by Master Inbox client name. |
| Label taken off or changed before the post | Re-checked just before posting; nothing is sent, the job is marked done with `no_longer_interested`. |
| Only "Interested" | Exact name, any case. "Not Interested" never matches. |
| Slack refuses (e.g. bot not in the channel) | The job stays pending with Slack's reason in `last_error` (`not_in_channel`), and the outbox drain the OS already runs retries it, up to five times. |

**Where.** `src/lib/tools/master-inbox/interested-alert.ts` (pure: rules and
wording) and `interested-alerts.ts` (the sweep and the post); started every
minute from `src/instrumentation.ts`, Railway only, never overlapped;
`outbox.ts` gained the `slack_interested` case so a failed post is retried
rather than marked done. **Why a sweep and not a hook:** Interested is applied
in three places across two codebases; `label_assignments` is the one table all
of them write, so reading it once a minute needs no change in either app.

**Switches.**
- `MASTER_INBOX_SLACK_CHANNEL_INTERESTED` on Railway `os` — unset = off.
- Migration **0033** (`migrations/0033_outbox_slack_interested.sql`, Master
  Inbox database) lets the outbox hold the new kind. Until it runs, the claim
  is refused and **nothing is posted** — an alert that cannot be de-duplicated
  is not sent. The log line then reads `off: migration 0033 has not been run`.
- Token: the existing `MASTER_INBOX_SLACK_BOT_TOKEN` (bot "brokerstaffer_bot").
  The bot must be a member of the channel; it has no `channels:read` scope, so
  membership is only visible from the first post's answer.

**Reading it in production.** Railway logs of `os`, prefix `[interested-alerts]`
(a line only when something was claimed or failed). The record of every alert
is `side_effect_outbox where kind = 'slack_interested'` — `status`, `attempts`,
`last_error` (`excluded` for Demo Portal, `no_longer_interested`, or Slack's
error).

### Also 14 October: introductions are signed by Nicole

Asked by the user with a screenshot: an introduction sent From
nicole.c@brokerstaffer.com was signed "Best, Lydia Reed" — the name of the
campaign mailbox that first emailed the lead, because the macro's
`{{sender.name}}` was filled from the thread's own mailbox before From switched
to Nicole. Now the sign-off is the name on the mailbox the introduction goes
out from ("Nicole Collins"), in the Introduce button and in the reply agent's
handover, in BOTH apps (OS `130e09b`, standalone Master Inbox `69b3a30`).
`introSignOffName` in `inbox/intro-sender.ts`; the agent's run input carries
`introSenderName`, and runtime and the release sweep share
`handoverVariables()`. Unchanged: ordinary replies, the Templates picker (it
does not switch From), and Instantly conversations (Nicole's Instantly mailbox
is disconnected, so they go from — and are signed by — the campaign mailbox).
A draft saved before the change keeps the old name until Introduce is pressed
again. Verified in Chrome on a local build against the thread in the
screenshot, every save blocked: From Nicole, signed "Nicole Collins", wording
otherwise identical.

## 0.3 OS feedback batch, 13–14 October

**LIVE since 14 Oct 2026.** OS commit `28d910b` on `main`, deployed to Railway
`os` (deployment `ae108eb6`, SUCCESS 13 Oct 23:22 UTC) from a clean export of
the commit. The Reply agent change also went to the standalone Master Inbox —
`840094f` on its `main`, deployed to `alluring-ambition` — because THAT app
receives the EmailBison webhooks and runs the agent on inbound replies (the
OS receives none). No migration. Verified on production, read-only: the 164
browser checks of the batch, every write blocked in the browser; both
services' logs after the deploy; the first post-deploy agent run drafted for
an "Objection" reply (not Interested), as it should.

The batch was one message of ~45 items across the whole OS, with a 3-page
wireframe for Performance. What each item became:

### Shell, Home, Performance, Commissions, Client Portals

| Asked | Built | Where |
|---|---|---|
| Side menu broken when retracted | A retracted rail shows each item's name on hover, and a product's screens in a fly-out (mouse and keyboard). The choice survives a reload (cookie `os_rail`); under 1000px the rail is retracted by itself | `components/shell/rail.tsx`, `rail-state.ts`, `workspace.tsx`, `shell.css` |
| Home: drop Median Reply and the client counts; add Interested Reply, Interested Reply Rate, Reply Rate per Contact (keep per email) | Six tiles: Emails sent · Replies · Reply rate per email · Reply rate per contact · Interested replies · Interested reply rate. **Interested comes from Master Inbox** (threads labelled Interested or Introduction, one per thread), not EmailBison's "positive" | `lib/workspace/overview-model.ts`, `interested.ts`, `overview.ts`, `screens/overview-card.tsx` |
| Home graph = the campaign tool's graph | The same chart component as Campaign Analytics (series chips, Volume / Rates, Normalize) | `screens/analytics/chart.tsx` (`labels`, `only` props) |
| Performance wireframe | Date filter (This month / 30 / 90 / YTD default / All time / Custom) with Compare; three rows of tiles tagged RANGE / TODAY / ALL TIME; Active and Paused subscriptions open a side panel; a month expands to the clients added, paused and churned | `lib/workspace/performance-range.ts`, `performance.ts`, `screens/performance.tsx`, `lib/clients/billing-model.ts` |
| "$6,624 not tied to a client — what are these?" | The tile opens the list: every Stripe customer with money and no client | `unattributedByCustomer` in `billing-model.ts` |
| Commissions: closings per month; a Month column | A bar chart of clients closed per month beside the person's card, and a Month column (which month of service the client is in) — both only when ONE salesperson is in view | `lib/commissions/closings.ts`, `load.ts`, `screens/commissions.tsx` |
| Live portals should match active clients; Demo portal separate at the top | The page says "N live portals for M active clients" and names any mismatch; the Demo Portal is its own block above the list | `lib/tools/master-inbox/portals/live-vs-active.ts`, `portals-admin.tsx` |

Decisions taken where the wireframe had placeholders — **confirm with the
client**: *Signed* = first $1 Stripe charge, else the sign-up date entered, else
the onboarding date. *Customer lifespan* = months of service actually paid for
(a 14-day invoice is 0.46 of a month), averaged over clients signed in the
range. *Interested rate* = interested ÷ replies. *This week* = Monday to today.

### Campaign Analytics

| Asked | Built | Where |
|---|---|---|
| Metrics not showing | Positive, Positive Rate, Lead to Email and Bounces were a dash whenever Instantly was merely not filtered out. **An Instantly that sent and received nothing in the window is no longer treated as half the figures** | `lib/tools/analytics/instantly-idle.ts`, `kpis.ts` |
| Reply rate per email sent | The Reply Rate tile says "per email sent" and gives the per-contact rate under it; two decimals | `kpi-band.tsx`, `metrics.ts` |
| Today, Yesterday, This week | Three new quick ranges before 7d / 30d / 90d. A one-day range reads as one date | `query-params.ts` (`presetRange`), `format.ts` |
| Filter by Tag | A Tags picker beside Campaigns / Clients / Platform. A tag is an EmailBison campaign tag, resolved to campaign ids in ONE place and honoured by all eleven analytics endpoints. A tag that matches nothing shows nothing (`NO_CAMPAIGN`), never everything | `tag-filter-rule.ts`, `tag-filter.ts`, `filters.tsx` |
| Sending Capacity seems off; show capacity needed | **A platform with no active campaign is not counted** — 536 idle Instantly inboxes were a quarter of the headline. New tile: *Needed by active campaigns* = their daily send limits added up, with the gap. "How this is worked out" is on the page | `sending-capacity.ts`, `sending-capacity-load.ts`, `screens/analytics/volume.tsx` |
| Use the original tool's UI | The KPI band is two rows of six again (ds.css's auto-fit made it 7 + 5) | `os.css` `.kpi.kpi-band` |

### Campaign Management

| Asked | Built | Where |
|---|---|---|
| Launch tab on a campaign | **Launch** tab (EmailBison): six live checks — sequence, client fields, leads, inboxes, client, limits — and a two-step button that launches a draft or resumes a paused campaign. The checks run again on the server before the one call | `campaigns/launch.ts`, `launch-load.ts`, `api/.../campaigns/[id]/launch`, `launch-tab.tsx` |
| Area and Client Alias as merge fields | `{CLIENT_AREA}` and `{CLIENT_ALIAS}` in Insert field. **The OS fills them in, from the campaign's client, when a sequence is saved, copied in, or fanned out** — EmailBison would send the placeholder itself. A campaign with no client keeps them (a template); a campaign still holding one cannot be started | `campaigns/client-fields.ts`, `client-fields-load.ts`, sequence route, `copy-sequence.ts`, `fan-out.ts`, `actions.ts` |
| Several inbox groups at once | The pools in the Inboxes dialog are tick boxes. Counts are over the UNION of the ticked pools (an inbox carries several tags); the write stays one pool at a time through the existing function | `campaigns/inbox-pools.ts`, `inbox-assignment.ts`, `assign-inboxes-dialog.tsx` |
| Kill Copy dimension and Blueprint | Removed from the editor, the preview and the copy dialog. `/copy/tags` and the stored tags are untouched | `sequence-editor.tsx`, `email-panel.tsx`, `copy-sequence-dialog.tsx` |
| Volume needed for the active campaigns | One line above the Campaigns list: what they are set to send against what connected inboxes can | `screens/analytics/campaigns.tsx` |
| Schedule shows 15 of 22 | `/api/campaigns/sending-schedules` ignores cursor paging and answers with numbered pages; the walk stopped after page 1. `fetchAllPages` now follows numbered pages when the first answer is page-shaped | `emailbison/client.ts` |
| Instantly campaigns still showing | The Clients tab counted MAPPINGS, and a mapping outlives its campaign: every client read "12 on Instantly" after all 333 Instantly campaigns were archived. Only live campaigns are counted | `clients/campaign-counts.ts` |

### Client Health, Clients, Database, Reply agent, Inboxes

| Asked | Built | Where |
|---|---|---|
| Delivery: keep only the last row of tiles | The four summary sections are gone from Delivery | `client-health/biweekly.tsx` |
| **Wagner says Billing in 2 days; the Client says another date** | See "One billing date" below | `lib/clients/billing-align.ts` |
| Remove onboarding status everywhere | Onboarding status, stage and step progress removed from the Clients table, the record's Tools tab, the Database view and Agent Search → Clients. **Kept:** the lifecycle status "Onboarding" and the Onboarding date | `field-registry.ts`, `cells.tsx`, `master-list.ts`, `database/clients.ts` |
| Leads in review / Leads exported — kill if unused | Two flags only the retired Onboarding flow ever set. Removed from every OS screen; the Database columns are untouched | same files |
| Reply agent: all categories except Interested | Each agent has *Categories left to a person* (default **Interested**). A conversation carrying one is not drafted for and not sent to. Stored in the `qualification` jsonb as `skip_labels` — no migration. **The agent was not switched to Live** | `ai/agent-config.ts`, `runtime.ts`, `reply-agent-config.tsx` |
| New product: Inboxes | **Inboxes → All inboxes** (`/analytics/inboxes`, the Campaign Analytics grant): every sending inbox, sortable on every column, tick filters and number filters. Warmup (3 / 7 days) and Assigned are read from EmailBison in the background | `analytics/inboxes.ts`, `inbox-extras*.ts`, `inbox-ranges.ts`, `screens/analytics/inboxes.tsx` |

### One billing date (the Wagner item)

Two things were both called "the billing date": Client Health's **schedule**
(the billing anchor date on the record — or, with none, the start date —
stepped in 14- or 28-day cycles) and **Stripe's** actual charge. Nothing kept
them in step; the anchor is typed by hand. On 13 Oct, 18 of the 22 clients
billed through Stripe agreed to the day. Wagner had no anchor (cycle from its
start date: 13 Oct; Stripe: 23 Oct); Jeff Cook and SERHANT NJ were a few days
out; Rise's record says every 28 days while Stripe charges every 14.

`alignWithStripe` (pure) decides per client: **aligned** (nothing changes),
**follow** (same interval, different day — the cycle is re-anchored on Stripe's
next charge, IN MEMORY, so the billing date, the cycle window and its intro
counts move together), **differs** (a different interval, or subscriptions on
different days — left alone and said in red), **none** (no active Stripe
subscription). `scheduleFor` reads `stripe_anchor ?? billing_anchor_date ??
start_date`; the three loaders that build billing figures apply it
(`client-health/loadDashboard.ts`, `clients/master-list.ts`,
`clients/overview.ts`). Nothing is written: the anchor on the record still
shows what was typed, and the screen says "per Stripe".

**It never holds a page up.** A cold Stripe read takes tens of seconds; the
first build that waited for it made `/roster` miss the link audit's 25-second
limit. `stripeFactsByClient` waits at most 4 seconds (`STRIPE_WAIT_MS`); past
that the page uses the record's dates and the read carries on into the shared
cache, so the next load has it. On production the cache is kept warm, so this
only matters in the first minute after a restart.

The lasting fix for the three is to type the right anchor on their records
(a data write, not done); Rise needs its interval corrected by a person.

### Inboxes: where each column comes from

Daily limit, Sent, Replied (people who replied), Bounced, Status, Vendor, Tags,
Type: `sender_emails`, as the three-hourly sync stores them. **Warmup 3 / 7
days** and **Assigned to campaign** are stored nowhere, so
`inbox-extras-load.ts` reads them from EmailBison — about 700 GETs, three at a
time, under three minutes — the first time someone opens the page, and keeps
the answer for six hours in the process (a restart reads again). Assigned is
exact: one active campaign's inbox list is walked (the pool nearly all share),
then only the inboxes still unsettled are asked one by one. Until the read
finishes the table shows a dash for warmup and an estimate from the send
history for Assigned, and says so.

### What was NOT done, and why

| Item | Why |
|---|---|
| Password on the old products | Needs the client: which products, and the client portals are deliberately login-free |
| Re-sequence (info on the OpsLabs portal) | The spec is on a portal this work has no access to |
| Move the Database to db.brokerstaffer.com | **Half done 14 Oct:** the custom domain is added on Railway (project Database, service `web`). It goes live once two records exist at name.com, which hosts the DNS: CNAME `db` → `bwn3ladj.up.railway.app`, TXT `_railway-verify.db` → the `railway-verify=…` value `railway domain status db.brokerstaffer.com --service web` prints. Then set `NEXT_PUBLIC_SITE_URL=https://db.brokerstaffer.com` on `web` (a rebuild of Akeesh's service — ask first) and add the address to Supabase Auth's redirect list so invite and reset emails link there. The old address keeps working throughout |
| Type the right billing anchors; fix Rise's interval; add the two missing aliases | Real-data writes — listed for a person |
| Switch the Reply agent to Live | Emailing leads automatically needs an explicit go-ahead |

A finding, not caused by this release: the OS's 30-minute `sync-external-intros`
job (and the standalone's copy) reads the legacy introductions feed at
`web-production-d18b09.up.railway.app/api/masterinbox/intros` — Health Dashboard's
`web` service — and that feed answers **401** to an unauthenticated request. That
service was last deployed 1 Oct; the job has been failing quietly since then.
Either send it the credential it now wants or retire the job.

A finding for the Analytics database, not fixed (it needs SQL run there):
`analytics_kpis` counts **1 reply when none match** — `COUNT(*)` over a LEFT
JOIN counts the empty row — so a filter matching nothing reads "Replies 1". The
fix is `COUNT(r.id)` in the `reply_counts` CTE; the standalone tool shares the
function.

### Verified

Unit tests 1,932 / 1,932; `tsc` clean; a local production build. Real Chrome
against the local server behind the write guard (reads only — no Assign, Save,
Launch or Pause was ever confirmed): rail + portals, Home, Performance,
Commissions, Campaign Analytics + Volume, Inboxes, Campaign Management,
Delivery + record + Database view + Reply agent.

**Never exercised against the real platforms** (they write): saving a sequence
with client fields, copy and fan-out filling them, launching a campaign,
assigning several pools. Each is unit-tested against a fake EmailBison; do the
first real one on a throwaway campaign.

### Traps met

- **Turbopack dev keeps a stale module** for a server lib with a module-level
  cache (`master-list.ts`) after an edit: the route's chunk is rebuilt, the
  running instance is not. Restart `next dev`, or check on a production build.
- A `shared` ttlCache survives hot reloads — bump its key when a payload's
  shape changes (`home-overview-v2`, `performance-v2`).
- The global `.tip` class translates by −50%; the rail's tooltip is
  `.rail-fly-tip` for that reason.
- A browser test that navigates away from the sequence editor with unsaved
  edits hangs on the `beforeunload` prompt — press Cancel → Discard first.
- `~/Desktop` is an iCloud Drive folder: `.next` collects "name 2" conflict
  copies and the next build dies with `ENOTEMPTY`. `rm -rf .next` first.
- Most of the repo's older audit suites (client-health-ui-test,
  reply-agent-config-ui-test, settings-ui-test, parts of analytics-ui-test)
  fail on `main` too — they test screens as they were before earlier releases.
  Compare against a baseline build of `main` before blaming a change.


## 0.4 Campaign leads: search by office city, and a Location filter, 13 October

Campaign Management → Campaigns → a campaign → **Leads**. Two asks, the same
morning:

| Asked | By | Built |
|---|---|---|
| "Could we add the ability to search by office city in the search box" | Amy | The search box also matches the lead's office city |
| "add location filter (office city, home city and most transacted city)" | Eddy | A **Location** chip beside Sales volume: pick cities per field |

**Both are SQL, in the Analytics database — migration `097_os_lead_location_filter.sql`.**
The Leads tab is searched, filtered, sorted and paged on the server (a campaign
has thousands of leads; the Sales volume filter, analytics 096, is the precedent), so the
OS only passes what was asked for. 097 changes the two OS-only EmailBison
functions from 095/096 and adds one:

| Function | Change |
|---|---|
| `analytics_os_campaign_lead_rows`, `…_lead_ids` | `p_search` also matches the `office city` attribute; new `p_loc jsonb` |
| `analytics_os_campaign_lead_locations` | new — each field's cities in one campaign, with lead counts, as ONE json value |

Dropped and recreated in one transaction, never overloaded (two versions with
defaulted arguments make PostgREST's calls ambiguous). `p_loc` defaults to "no
filter". The standalone Analytics app calls none of these.

**The fields are lead attributes** (`lead_attributes`, the custom variables
EmailBison carries). The mapping is fixed in
`lib/tools/analytics/campaigns/location-filter.ts`:

| Field | Attribute | Data on 13 Oct |
|---|---|---|
| Office city | `office city` | on nearly every lead ("Valencia, CA") |
| Most transacted city | `top producing city` (the "Top city" column) | on most leads |
| Home city | `home city` | **none** — the lists are not uploaded with it |

Home city is wired end to end and offers nothing to choose until a list is
uploaded with a `home city` variable; then it fills in with no code change.

**The rule.** Cities ticked in one field are alternatives; fields combine (a
lead must match every field that has cities ticked). Exact city, any case —
the cities are picked from the campaign's own list, with counts, never typed.
A lead with nothing on file for a ticked field is hidden while the filter is
on. The filter holds across paging, sorting, the total and **Select all
matching** — the reason it was wanted: tick a city, select everyone in it,
remove them from the campaign.

**Order of release, and why either order is safe.**

| State | What people see |
|---|---|
| 097 run, OS not deployed | Search starts matching office city. Nothing else changes |
| OS deployed, 097 not run | Search as before. The Location chip opens and says "The Location filter isn't switched on yet." |
| Both | Everything above |

The OS sends `p_loc` **only when a city is ticked**. Before 097 the functions
have no such argument; sending it with every request would drop every Leads tab
to the fallback and lose the Introduced status and the Sales volume filter. With
a city ticked and 097 missing, the request is refused with that plain message —
never answered unfiltered. `leads/route.test.ts` pins all three.

**EmailBison only.** Instantly leads carry no attributes; the chip is not shown
and city parameters on an Instantly address are ignored.

**Also fixed.** With only a Sales volume range applied and nothing matching,
the table said "No leads recorded for this campaign yet"; any filter now gives
"No leads match that."

**How it was verified.** The SQL: 699 checks on a local Postgres holding a
copy of one real campaign (1,589 leads) — every result compared with an
independent reading of the same data in JS, 436 of them proving 096 and 097
answer identically when the new things are not used, and the copy itself
checked against production's current functions. The OS: 24 unit and route
tests, each rule broken on purpose and caught; a local build in Chrome twice —
against the live database before 097 (14 checks), and against the local copy
with 097 (32 checks). After 097 runs: re-check on production, read-only.

---

## 0.5 Client Portals as its own product, 13 October

Four pieces of feedback on Client Portals, and what was decided for each:

| Asked for | Decided (by the user, 13 Oct) | Built |
|---|---|---|
| "Add the ability to delete client portals" | **Admins only. "Portal only, client stays."** Ask for confirmation first | Delete button per portal; the client is never touched |
| "Add the missing SMS option" | Already done — §0.6 | — |
| "Make Client Portals its own standalone product" | **Its own switch on Team access; admins only to start** | Own menu section, own grant `portals`, own address `/portals` |
| "Client Portals should sync with Consistency" | The count mismatch: the page said 57 clients, Consistency said 54 | The shared count line; the page now counts *portals* |

**Its own product.** `portals` is a sixth tool id (`ALL_TOOLS` in `bs-auth.ts`),
a product in the menu (`nav.ts`) and a column on Team access (`GRANTABLE_TOOLS`
in `identity/admin.ts`). `os_tool_grants.tools` is a plain `text[]`, so there
was **no migration**.

| | Before | Now |
|---|---|---|
| The list | `/inbox/portals` | `/portals` |
| One portal | `/inbox/portals/<id>` | `/portals/<id>` |
| Client view (§8) | `/inbox/client-view` | `/portals/client-view` |
| Grant | `inbox` | `portals` |

The old addresses redirect (`app/[[...slug]]/page.tsx`), and are guarded by the
**new** grant (`tool-paths.ts`), so a bookmark moves for someone who has Client
Portals and is not a way in for someone who only has Master Inbox.

**Its routes did not move.** They still live under `/api/tools/master-inbox`,
because that tree is kept the same as the standalone tool's. The grant is
decided per route family in `isPortalsApi` (`tool-paths.ts`):
`/portals`, `/portal/<token>/…`, `/clients/<uuid>` and anything under it belong
to `portals`; `/clients`, `/clients/status`, `/clients/intro-stats`,
`/clients/intros` and `/clients/portals` stay with `inbox` because inbox
screens and token feeds call them. `tool-paths.test.ts` pins both lists; move a
route between them only with its callers in hand.

**Nobody was granted it.** That was the decision: admins hold every tool, so
they have it; everyone else gets it when an admin switches it on. On the day it
shipped that meant two people had Client Portals and two who used to reach it
through Master Inbox did not. A signed-in admin gains the grant at their next
token refresh (ten minutes at most, or on returning to the tab).

**Deleting one portal.** A portal is a row of Master Inbox's `clients` table.
`DELETE /api/tools/master-inbox/clients/[id]` with `{ confirm, acceptDataLoss }`;
the preview is `GET …/[id]/delete-plan`. Rules in
`lib/clients/delete-portal-rule.ts` (pure, tested), reading and writing in
`delete-portal.ts`.

| Rule | Why |
|---|---|
| Admins only — checked in both routes, not only in the page | The page only decides whether the button is drawn |
| **Demo Portal** and the **Unknown** bucket are never deletable, on or off | Standing rule: the demo portal backs the live demo |
| A **live** portal is refused — switch it off first | Somebody outside may be using the link; switching off is the reversible step |
| The portal's exact name must be typed; if it holds anything, a box ticked too; then a final "Are you sure?" | "Ask for the confirmation too" |
| Everything is re-read at the moment of deleting | A portal switched back on after the preview must still be refused |

What goes: the row and, by foreign key, its pipeline (with notes), agents,
do-not-contact list, team, custom stages, its list in the inbox's Clients panel
and its campaign routing choices (`os_campaign_portals`); plus its
"Intro Macro - <name>" template, by exact name. Conversations are kept and lose
the client tag. What the code does by hand, because no foreign key does:

* `os_clients.mi_client_id` — if it pointed at the deleted portal it moves to
  the client's other portal (lowest id) or is cleared. Never left stale.
* `os_client_tool_exceptions` (tool `master_inbox`) — written when the client is
  left with **no** portal, so Consistency shows "explained: its portal was
  deleted on <date> by <person>" instead of a gap.

**The client record is never deleted or renamed** — `delete-portal.test.ts`
asserts that no path writes anything to `os_clients` but that one link column.

**One consequence worth knowing before pressing it.** A portal's leads *are*
the client's introductions on record. Client Health recounts every week and
billing cycle from them on each sync (`sync/runSync.ts`, `runCorofy`), so
deleting a portal with 30 leads lowers that client's introduction numbers by
30, past weeks included. The dialog says so. For a client that should keep its
history, switch the portal off and leave it.

**The button's place.** A fourth icon would have made the page wider than a
laptop screen (the page is as wide as its table — `mi-portals.css`). Delete
takes the slot "Open live portal" leaves empty once a portal is off; the two
can never both apply.

**The count.** The page listed 57 rows and called them clients. They are
portals: 54 clients, two second portals (a client with two markets) and the
demo portal. It now leads with the same line as every other tool's client
screen (`ClientCountLine`, from the reconciliation Consistency uses), says
"57 portals" where it said "57 clients", and marks the three rows that are not
one more client. `omit` on the count line takes Master Inbox's "Unknown" bucket
off the arithmetic, because this page does not list it.

**Not changed.** The portals clients open (`portal.brokerstaffer.com`) are
served by the standalone app; no portal address, token, stage or lead was
touched. Clients → Delete (the whole client, at a chosen scope) is unchanged
and is still open to any team member — only the portal-only delete is
admins-only.

**How it was verified.** 1,639 unit tests; each rule broken on purpose and
caught (22 of 22); a local production build against the real data behind a
proxy that refuses every write, driven in Chrome as an admin, as a team member
without the switch, with it, and with Client Portals alone; the access matrix
for all six tools in both directions. **No real portal was deleted in testing**
— the final request was sent and refused by the guard, and the database was
compared before and after.

---

## 0.6 SMS alerts for introductions, 13 October

When a lead is introduced, the client's team can get a text. The standalone
Master Inbox built this on 8 October (commits `06d8530`, `c4b6b77`, Akeesh);
the OS did not have it. **Before this change an Introduction made in the OS
never sent a text** — not even for a client with SMS on.

**The moving parts, and who owns each**

| Part | Where it lives | Changed here? |
|---|---|---|
| **LoopMessage notifier** — receives `lead.introduction`, asks each person for a YES once, then texts them; honours STOP; paces sends | Its own Railway service in "Masterinbox + Client Portals" (source: branch `loopmessage-notifier` of `brokerstaffer/Masterinbox`, `services/loopmessage-notifier`) | No. Both apps post to it |
| **Per-client switch** — is this client texted at all | `clients.feature_flags.team_sms_notifications` (Master Inbox database). Set from the **Client Portals** page, the **SMS** column, in either app | **Yes** — the OS page now has the column |
| **Per-member switch** — who on the team is texted | `client_team_members.receives_sms` (migration 0077, default true). Set on the **Team** page of the client's own portal | No. The portal is served by the standalone app |
| **The sender** — decides what is POSTed to the notifier | `webhooks/n8n-introduction.ts` + `portals/team-sms.ts`, one copy in each app | **Yes** — the OS copy now has the rules |

**The rule, identical in both apps.** The notifier is POSTed to only for a
client with SMS on, with only the members whose switch is on (and active, with
a phone), and the body carries `"sms_enabled": true`. The notifier texts
nothing without that mark. SMS off, nobody switched on, or the switches
unreadable: **no POST at all** — which also means a client's team names and
numbers no longer leave the OS unless that client has SMS on. Bison's payload
is never affected. `sms_enabled` and `team_sms_notifications` are the contract
between the two apps and the notifier; `portals/team-sms.test.ts` pins both.

**The OS files are the standalone's files.** `portals/team-sms.ts`,
`portals/feature-flags.ts` (`withFeatureFlag`) and `webhooks/n8n-introduction.ts`
differ from `brokerstaffer/Masterinbox` `main` only in import paths. Keep them
that way: `diff` them against the standalone before changing either.

**The switch on the OS Client Portals page.** `PATCH
/api/tools/master-inbox/clients/[id]` accepts `{ sms_alerts }`. It rewrites
`feature_flags` with that one key changed and writes no other column. Turning
it **on** asks first (it starts texting real people; a workspace dialog where
the standalone uses `confirm()`); turning it **off** does not. The "Unknown"
client is refused. The OS's other writers of `feature_flags`
(`withStandardFlags`, used by onboarding and add-portal) only ADD absent keys,
so they can neither drop the flag nor turn it on.

**The page is as wide as its table.** `.mi-portals-wrap` is a centred flex
item, so it takes the table's natural width (1235px before), not the stage's.
A tenth column would have pushed it past a 1512px laptop. It is paid for out of
the six middle columns' padding (50px) and a 360px cap on the Client column,
which shortens exactly one name ("The RE Home Group of Douglas Realty", full
text in its tooltip). The table is 4px narrower than before. Below ~1500px the
page scrolls sideways, as it did before — untouched here.

**What is NOT in the OS, on purpose.** The portal's Team page and its
per-member switch (`PATCH /api/portal/[token]/team/[id]`): client portals are
served by the standalone app at portal.brokerstaffer.com. **That app has to
keep running for the portals to work**, whatever staff use for the inbox.

**How it was verified (before deploying)**

- 28 tests ported or added (`n8n-introduction.test.ts`, `team-sms.test.ts`,
  `client-sms-switch.test.ts`); each safety rule was then broken on purpose
  and a test caught every one.
- The OS's sender and the standalone's sender were run on the same 18 real
  introductions (9 clients), both pointed at a local catcher: **45 of 45 POSTs
  identical, field for field.** The OS's old sender on the same input: 54
  unmarked POSTs, 45 of them for clients with SMS off.
- The notifier's own code (a local copy, dry run) ignored the old OS body as
  `sms_not_approved` and routed the new one to the same three people as the
  standalone's.
- The page in a real Chrome with every write refused: 21 checks.

---

## 0.7 Master Inbox parity, 12 October

Twelve things the standalone Master Inbox does that the OS inbox did not, from
the client's side-by-side list. One release. Nothing in the standalone app,
the portals or any database changed; no migration.

| # | What was wrong in the OS | Now | Where |
|---|---|---|---|
| 1 | No `● 28 ● 9 ● 17` client counts | Strip under the panel's search box, from the status route's `counts` (clients on the master record, not lists) | `mockup/client-lists.tsx` |
| 2 | Opened rows as white as unopened ones | Read rows are `--mi-read`; a row greys on the click (`opened`, the tool's `optimisticSeen`). Same grey in the conversation's side list | `mockup/list.tsx`, `mi-inbox.css`, `mi-conversation.css` |
| 3 | Refresh / Filters in a short strip, Filters a big bordered button | The band gives up its padding, the tool's bar its border; Filters is a quiet button | `mi-inbox.css` (`.mi-filterbar*`) |
| 4 | Filter box only closed from its own button | Outside click and Escape (`useDismiss`). The draft rows survive closing | `master-inbox/use-dismiss.ts`, `filter-bar.tsx` |
| 5 | A conversation in Archive or Trash drew the list again | `folderView()` renders `ThreadDetail` for `/inbox/archive|trash/<id>` | `app/[[...slug]]/page.tsx` |
| 6 | Back from a conversation landed at the top | `useScrollMemory`, keyed by the whole list address, on the shell's `.scroll` pane | `mockup/list.tsx` |
| 7 | The Clients panel vanished beside a conversation | It stays — see below | `thread-detail.tsx`, `mockup/clients-*.ts(x)` |
| 8 | No hover / pressed states (bulk buttons, Bold/Italic, search results, menus…) | `--color-accent`, `--color-muted`, `--color-destructive` were never mapped, so Tailwind emitted none of those classes | `globals.css`, `inbox-theme.css`, `mi-skin.css` |
| 9 | "3 selected 3 selected" | Once (BulkActionsBar already prints it) | `mockup/selection-bar.tsx` |
| 10 | Ticked box was a blue square; a near miss opened the conversation | Tick drawn from `aria-checked`; its `::before` target is the whole left end of the row; select-all shows a dash for "some" | `mi-inbox.css` |
| 11 | "Delete forever" grey, its confirm a plain button | Red; the skin now matches the kit's real class (`bg-destructive/10`) | `mi-skin.css` |
| 12 | "Unknown" looked like a client | Grey outline when `client_slug === "unknown"` | `mockup/list.tsx` |

**The Clients panel beside a conversation.** The OS has a 264px navigation
rail the standalone app does not, so four columns do not fit everywhere. By
the width of the stage (a container query on `.mi-split-conv`, because
collapsing the rail changes it and the viewport does not):

- **1200px and up** — a real column. Under 1420px the thread rail goes to
  256px and the prospect panel is capped at 320px to pay for it.
- **Under 1200px** — out of the flow; the **Clients** button in the filter bar
  opens it as a drawer (closes on outside click, Escape, or choosing a client).
- The same button hides the column at any width. That choice is the cookie
  `mi_clients_panel` (`hidden` / `shown`), read on the server so the first
  paint is already right. The drawer's open state is never stored.
- **While the reply box is open at 1200–1420px the column steps aside**
  (`:has()` on the composer), so the reply box is exactly as wide as it was
  before this release (it is `min(600px, 92%)` of the conversation pane, and
  beside the column its footer no longer fitted on one line).

**Three things that are not obvious from the code**

- **`--mi-accent`, `--mi-muted`, `--mi-destructive` are new names on `:root`.**
  They must not be pointed at `--accent` / `--muted`: workspace.css owns those
  (brand blue; a TEXT grey). `:root`, not `.mi-theme`, because menus and
  dialogs render in a portal on `<body>`.
- **The panel is rebuilt on every navigation** — one catch-all route, so every
  tab, page and conversation remounts the screen. `remembered` (module level in
  `client-lists.tsx`) carries the last status, counts, unread pills and scroll
  position across, or the panel flashes folder icons and jumps on every click.
  Written only from effects, so it is empty on the server and on first paint.
- **The conversation page does not await `loadListUnseenCounts`.** It was the
  slowest of its loaders (~715ms against ~465ms for the next), so it is handed
  to the panel as a promise (`listCountsLater`) and the pills fill in after the
  page. `data-unseen-counts` on the panel says `pending` / `ready`.

**Two CSS traps this cost time on**

- The build rewrites `(width >= 1200px) and (width < 1420px)` in a container
  query to `… and not (min-width: 1420px)`, which is not valid CSS; the browser
  drops the whole block silently. Use `min-width` / `max-width`.
- `mi-skin.css`'s message-card rule (`rounded` + `border` + `bg-background`)
  also matches every bordered control in the inbox and, being unlayered, pinned
  their background — about twenty buttons with no hover. The rule after it
  gives the hover back.

**How it was verified.** Real Chrome on a local production build reading the
production databases, behind a proxy that refuses every write, refuses
`/inbox/reminders` (rendering it fires reminders) and serves a conversation
only if it is already read (rendering one marks it read): 145 checks. 35 other
screens compared pixel-for-pixel with production. Then the same checks against
production after the deploy. Note `scripts/conversation-ui-test.mjs` WRITES
(labels, archive, mark unread) — never run it against production unguarded.

---

## 0.8 Navigation clean-up, 9 October

From the client's "OS Feedback — Navigation & Cleanup" list. Shipped in four
releases, each tested in a real Chrome as an admin and as each account
manager before the next.

**Release 1 — renames and removals (no data touched, no access changed)**

| Change | What it means | Old links |
|---|---|---|
| Client Health **Weekly → Overview**, **Bi-Weekly → Delivery** | Labels only; ids `weekly` / `biweekly` and the URLs are unchanged | `/clients`, `/clients/biweekly` as before |
| Client Health **Client Success removed** | The screen only. `successRows` (views.ts) stays: the Assistant's `client_success` and `client_report` use it | `/clients/success` → Overview |
| Agent Search **Master List removed** | The screen and rail entry. The `/search/[id]/master` API and `merge.ts` are left, unused | `/search/master` → Search |
| Master Inbox Settings **Members, Personal removed** | Members managed logins for the old standalone inbox (OS logins are Team access); Personal was a change-password form (the Account page has it) | `/inbox/settings/members` and `/personal` → Labels |
| **Copy & Offer removed, with offers** | The Analytics tab, the campaign page's Copy & Offer tab (offer picker), the offer and copy-performance APIs (`/offers*`, `/copy`, `/copy/suggest`, `/campaigns/[id]/offer`) and the Assistant's `offer_performance`. The `offers` / `campaign_offers` tables are untouched. `/copy/tags` and `CopyTagsPanel` stay — the sequence editor uses them | `/analytics/copy-offer` → Campaign |
| **Campaign Management** split from Campaign Analytics | Analytics: Campaign, Volume, Infrastructure, Attribution. Management: Campaigns, Schedule, Clients, Client view. ONE tool and grant (`analytics`) in two rail sections: `NavProduct.key` gives the second its own identity (`campaign-management`), `idForPath` searches every section of a tool, `sectionOf()` says which section holds a screen. Team access calls the grant "Campaign Analytics & Management" | every `/analytics/...` address unchanged |

The repo's audit scripts (ui-audit, link-audit, interaction-audit, popover,
filter, nav-timing, full-verify, ui-test, the per-tool UI/API tests) no longer
visit the removed screens.

**Release 2 — Performance › Overview and Billing Calendar; Paused; Pause date**

- **Performance has an arrow** with Overview (`/performance`, id `performance`)
  and Billing Calendar (`/performance/billing`, id `billing-calendar`). Both
  admin-only (`ADMIN_ONLY_PAGES`). `NavPage.children` models it; the rail
  draws it like a product (`PageGroup`), except that clicking the name from
  outside Performance OPENS Overview too — it was a plain link before, and a
  collapsed rail hides sub-lists. `idForPath` matches two-segment page
  addresses first. One fetch (`/api/workspace/performance`) feeds both pages.
- **Paused column** in Client movement: each client counted once in each
  month it was paused. Sources: every change to Paused in
  `os_client_status_history` (since 13 Sep 2026; seeded rows excluded) plus
  **`os_clients.pause_date`** (migration **0032**), a pause entered by hand on
  the client's record for one before the history began. Never set
  automatically; nothing was backfilled. `MasterClient.pauseDates` (all known
  pause days) feeds it; `MasterClient.pauseDate` (the record's "Pause date",
  now editable) is the later of the entered one and the history's last.
  Shown as "—", not 0, when the status history cannot be read.
  `pauseUndated` counts clients paused now with no known pause date.
- Before 0032 runs the OS reads the dates without `pause_date` (no field
  goes missing); saving a Pause date then says the migration is needed.

**Release 3 — inbox Settings → Clients and Reply Agents moved, then removed**

- **A client's Master Inbox rows** (one per portal) are on its record:
  Clients → the client → Campaigns → **In Master Inbox** — name, spellings
  (aliases), conversation count, portal link. Admins rename a row and add or
  remove spellings there (account managers see it read-only):
  `lib/clients/inbox-row-edit.ts` (pure rules, tested) and
  `lib/clients/inbox-rows.ts`, via `/api/workspace/clients/inbox-rows`
  (GET; POST with `dryRun` for the "Review changes" step). Rules: a rename
  keeps the old name as a spelling (replies keep routing); the new name is
  added to the client's OS and Client Health spellings when the client does
  not answer to it (that is how the record finds its portal — Add portal does
  the same); never another portal's or another client's name or spelling;
  never the Unknown row; never the portal token. **Portal on/off by status
  matches names** (standalone `lib/portals/status-sync.ts`), so the dialog says
  a rename leaves the portal's state alone until Client Health's name matches.
  The tool's own PATCH `/api/tools/master-inbox/clients/[id]` is untouched
  (it also carries Client Portals' on/off switch). Demo Portal belongs to no
  client and is edited in the standalone inbox only.
- **Reply agents** — create, delete, provider, model, API key, prompt, tone,
  length, on/off — are edited on **Admin → Reply agent** ("Agents — model,
  API key, prompt and tone"), the tool's own `ReplyAgentsManager` unchanged,
  loaded server-side by the page (`has_api_key` only, never a key). The
  messages that pointed at the tab now point here.
- Master Inbox → Settings keeps **Labels, Templates, AI Labeling** (the last
  admin-only). `/inbox/settings/clients` and `/reply-agents` open Labels.

**Release 4 — the Onboarding section removed; its jobs switched off**

- **Gone:** the rail section (Pipeline, Stages, Templates, Settings, Client
  view), the per-client page `/onboarding/clients/<id>`, `screens/onboarding/*`,
  `tool-onboarding.css`, the Home card (connector off the registry), the
  Team access option, the Clients page's Onboarding tool view, and the
  Assistant's `onboarding_pipeline` / `onboarding_client`. Every `/onboarding…`
  address opens Home, for everyone (the screen prefix is no longer gated).
- **Jobs off:** `ONBOARDING_CRON_ENABLED` and `ONBOARDING_CRON_SECRET` were
  deleted from the Railway `os` service, so the in-process scheduler never
  starts and the cron routes answer 503. No more Gmail-broken / ready-to-launch
  / lost-booking Slack posts. The "Exported" flag on Database records no longer
  updates by itself (the user accepted this).
- **Kept on purpose — still live:**
  - The webhook receivers under `/api/tools/onboarding/webhooks/*`. The OS's
    own inbox posts every introduction to `…/webhooks/masterinbox`
    (`MASTER_INBOX_BISON_INTRODUCTION_WEBHOOK_URL`), which records it and
    **pauses a client's EmailBison campaign when it reaches its weekly
    introduction target** (`connector-bison.ts maybePauseOnTarget`) — that
    does not depend on the scheduler or the automation switch.
  - `lib/tools/onboarding/*` and its API routes: Stripe billing and payment
    links, commissions, client delete, status sync, Clients → Onboard, the
    Database view and the master list all use it. `ONBOARDING_STRIPE_*` stays.
  - The `onboarding` tool id and existing grants (they open nothing).
- Payment links: the Assistant's `client_billing` now lists a client's open
  Stripe payment links (it was the Onboarding tool's job).
- The Database view's client names open the client's record
  (`/roster?client=<id>`) instead of the Onboarding page.

## 0.9 What changed on 6–7 October

The client's feedback list (sections 2–8), built and deployed. OS commits
`e5e27c4` (Home, Client Health links, start date, speed), `e97f8d8` (profile,
billing, intros) and `ed4f98b` (assistant); Master Inbox `20f6af9` (intros,
portal billing hold).

**Migration 0030 (`migrations/0030_billing_profile.sql`) was run on 7 October**
(verified: the bell filled with 6 notifications, 2 dry-run block rows, 0 portal
differences). It is in the Master Inbox Supabase. Additive only — four tables
(`os_client_stripe_links`, `os_notifications`, `os_portal_blocks`,
`os_client_saved_views`) and one column (`os_clients.intro_variants`). Every
reader tolerates it missing: before it runs, linking Stripe customers or saved
views, the bell and intro variants say "needs 0030", and nothing else changes.

| Item | What was built | Where |
|---|---|---|
| Profile completeness | 22 checks → %, on the list (column) and the record (chip + "Complete the profile" with Fix → buttons that open the field) | `lib/clients/completeness.ts` |
| Saved views and leads | Database `saved_lists` matched to clients by name or the view's Client filter; link / "Not this client" on Campaigns (0030) | `lib/clients/saved-views*.ts` |
| Billing across subscriptions | every customer and subscription a client has; current = latest; a shared customer is split by subscription; links/exclusions (0030) | `lib/clients/billing-model.ts`, `billing-account.ts` |
| Pause / Resume per subscription | on the record's Billing; pause, churn and delete pause every collecting subscription. **Delay 7 days: not built — waiting on the client.** | `client-record.tsx`, `status-propagate.ts`, `delete.ts` |
| Failed payments | every Stripe attempt → a notification in the bell (admins); after 4 attempts (first + 3 retries) a portal block row | `lib/clients/billing-watch.ts`, every 15 min on Railway |
| Portal block | **dry run** until `OS_PORTAL_BLOCK_ENABLED=1` on the os service; threshold `OS_PORTAL_BLOCK_AFTER_ATTEMPTS` (default 4). Master Inbox shows a "paused — pay the invoice" page for `mode='blocked'` rows only; fails open, remembered 60 s, 1.5 s timeout. Paying lifts it. | MI `lib/portals/billing-hold.ts` |
| Sign-up date | the first $1 charge (replacing a card does not move it); flagged when after onboarding (same day OK); read-only on the record when it comes from Stripe | `lib/clients/signup.ts` |
| Performance | Total billed, MRR, ARR, active/paused subscriptions, growth (same days last month) on Overview; billing calendar (30 days) on Billing Calendar (its own page since 9 Oct) | `performance.tsx` |
| Intro subject | "Intro: {lead first name} & {brokerage}" — button and agent handover; on EmailBison a changed subject is a new email (`/replies/new`) | `intro-macro.ts` (both apps, identical) |
| Missing phone / company | the sentence is rewritten, never left with a blank; covers the standard wording and the four phrasings in clients' own intros | `fitIntroToLead` |
| Wording by market or person | variants on the Introduce to tab, chosen by the lead's campaign name (or routed person) | `intro_variants`, `pickIntroVariant` |
| Opening line | opt-in "Line from their reply" after Introduce: one sentence from the lead's latest reply, refused for declines/removals and never a promise | `intro-opener.ts`, read-only route |
| Assistant | `profile_completeness`, `notifications`; record/billing/intro tools extended; prompt lists what exists (and that delaying a charge does not) | `tools-phase9.ts` |

**Verification.** 1,509 OS and 126 Master Inbox tests. Real Chrome (writes
blocked): record 17/17 and intros 22/22 on production. Every one of the 57
portal URLs answered identically before and after the Master Inbox deploy
(33 open → welcome 200 with the client's name; 24 off → 404). The assistant:
70/70 earlier questions and 16/16 new ones; 16/16 on production. The intro
rewrite was checked against all 54 clients' real intros (208 renderings).

**Found while checking, not changed:** Front Range Collective's custom intro has
a line holding only "." and Kelly + Co's a double space before the phone;
Rise Real Estate Tujunga has no saved view of its own (the only "Rise" view is
the churned Antelope client's) — link it on the record if it is theirs;
Chestnut Park West ($1,875) and DiGiulio Group ($1,545) have invoices still
open in Stripe after 9 attempts (the two dry-run blocks); 54 Realty's open $500 is
from May on its cancelled subscription and Stripe no longer retries it; Properties & Estates has no introduction
people on its record (its intro is a manual template to Jenn Tonucci, RE/MAX
Revolution) — add a person per market (territory "Boston" / "Florida").

## 0.10 What changed on 30 September

Deployed to `os` and verified on production (`69288cf` and after).

**Clients is the master client system (§23).** It is built from the document
line by line:
- `src/lib/clients/field-registry.ts` is the document as code:
  - every §6 field plus the §12 lifecycle dates, in the document's words and order;
  - for each field, the §7/§15 answers: definition, source of truth, who can
    edit, tools that use it, and sync;
  - the §8 tool views, as column lists in each tool's own order.

  The table, the record panel, the tool views and the data dictionary all
  render from it.
- `src/lib/clients/master-list.ts` reads every field for every client from the
  tool that owns it. Two values are derived here: the first billing date, and
  the pause / churn / reactivation dates. The list is cached, warmed at boot
  and every 4 minutes (`instrumentation.ts`), and served at
  `/api/workspace/clients/master`.
- The Clients page has:
  - a status overview;
  - **Master record** — all 40 fields, banded by §6 category;
  - **§8 views** for Client Health, Database, Client Portal, Onboarding and
    Analytics, plus a Commission Tracker placeholder;
  - the **§15 data dictionary**, with how many clients have each field filled;
  - CSV export.
- The record panel shows every field with the system that holds it, and edits
  in place through the existing edit route. Status asks before it changes.
- Each tool has a **Client view** in its own sidebar group: `/<tool>/client-view`.

**Status visuals (§10–§11).** There is one `StatusPill`: Onboarding blue,
Active green, **Paused orange**, Churned red. Every older status class is
restyled to the same four colours. Client Health's filters now use the
document's words: "Paused" and "Churned". Campaign filters no longer borrow
status words ("Campaigns running", "Campaigns paused").

**Look.** Geist is actually loaded now; the old `'Inter'` family never was, so
screens rendered in the system font. There is a grey canvas under white
surfaces, and every page header carries its mark.

**Verified on production:**
- 34/34 pages, plus the 5 Client views;
- 23/23 record-edit checks. Every save was intercepted in the browser, so no
  real data changed;
- Client Health still 0 differences against the standalone app.

**Second pass, same day (`fff8fa8`):**
- **Tool views open only their part.** A client opened from any tool's Client
  view shows only the fields §8 lists for that tool, under that tool's names.
  "Full record" opens the whole thing.
- **The record navigates.** ↑ / ↓ move through the list.
- **One platform.** `src/app/os.css` is loaded last and restyles every tool
  through the classes it already renders:
  - a mono kicker above each page title;
  - stat tiles as one hairline strip;
  - hairline panels and mono table headings;
  - tabs underlined in ink;
  - flat buttons and inputs;
  - colour only where it means status.
- **Verified on production:** 35/35 browser checks (writes intercepted), 34/34 pages.

**Third pass, same day:**
- **One Add Client button.** The one that creates a client is Onboard a
  client, on Clients. Campaign Analytics → Clients and Master Inbox →
  Settings → Clients lost their Add Client buttons; Client Health lost its
  link. Each points to Clients.
- **Account Manager = a Team access member.**
  - The client record offers a dropdown of the active Team access members.
  - `editClient` refuses any other name, and saves the member's exact name.
  - Onboarding's client page shows it read-only, with a link to the record.
    Its API refuses the field.
  - The Onboarding sync still mirrors the person into Onboarding's own row.
- **Commissions** (`/commissions`, Workspace). Built from the client's mockup:
  - The rep is the client's Account Manager.
  - Money is paid Stripe invoices on the linked subscription. A client with
    no Stripe link uses an admin-entered gross, estimated on its billing
    schedule and labelled Estimate.
  - Month 1 is the first 28 days of payments, at 70%. Later payments earn the
    rep's residual rate (15% or 25%). Nothing accrues from the cancellation
    date.
  - Each payment is paid out on the first run (the 1st or 15th) after it.
  - Scope is enforced server-side. Account managers see only their own
    clients; admins see everyone, can switch between people, assign clients
    and set rates.
  - **Migration `0019_commissions.sql` must be run in Supabase** before rates
    and manual grosses can be saved. Until then everyone is on 70% / 15% and
    only Stripe-linked clients count.

**Data gaps the page now makes visible.** These are data entry, not code:
Sender 0/50, Account Manager 0/50, Markets 0/50, Salesperson 2/50,
Onboarding date 0/50.

**Salespeople, several Account Managers, and the client's data sheet.**
- **Team access → Salespeople** (`os_salespeople`, migration 0020, which has
  been run). It is the client's list, "just for our records": add, rename,
  deactivate, an optional sign-in email, and a residual of 15% or 25%.
  - A rename is carried to every client that names the person and to
    Onboarding's person row.
  - Code: `lib/identity/salespeople.ts`, `/api/admin/salespeople` (admins
    only), and `/api/workspace/salespeople` (names only).
- **The client record's Salesperson** is a dropdown from that list, and a save
  is refused for anyone not on it. Onboarding shows the Salesperson read-only
  and links to the record; its API refuses `salespersonName`.
- **Account Manager takes one or more Team access members, in order.** They
  are stored as "Amy, Eddy" in the one column (`splitManagers` /
  `joinManagers` in `team-match.ts`). Onboarding's row holds one person: the
  first.
- **Commissions is still paid by Account Manager**, while the client confirms
  whether it should be Salesperson. Until then, a client with several managers
  is earned once, by the first one named, and the page says so. Switching to
  Salesperson means changing `earnerOf` in `lib/commissions/load.ts` and
  reading the rates from `os_salespeople`.
- **Cain Realty Group was paused** (the client's decision), through the
  status route:
  - Client Health, Analytics and the portal all changed. The portal is off.
  - All 5 campaigns were already stopped.
  - Billing was skipped, because Cain has no Stripe link.
- **The sheet ("Client Data – Sheet1", 40 clients) was imported** through the
  edit and markets routes. The before values are in the session's
  `import-plan.json`.
  - Sender Nicole ×40.
  - Salesperson ×39 (Ryan Jagdeo 24, Scott Craigue 10, Eddy 6).
  - Account Manager for the 10 clients managed by Eddy alone. **The 30 rows
    that name Amy wait until Amy is on Team access.**
  - Brokerage filled on 11 blanks. Douglas Elliman LA keeps "Douglas
    Elliman LA"; the sheet's "Los Angeles" is the same brokerage (confirmed).
  - 58 market rows. The sheet does not pair MLS codes with areas, so each
    client has one row per MLS code, with the sheet's area text as the market.
  - Onboarding's MLS now comes from those rows (34 clients). Five codes match
    no board and were not sent: ECOAR, realMLS, CHMLS, SEFMLS, REcolorado.
- **Adding a market rewrites Onboarding's MLS from the markets**
  (`markets-mls-sync.ts`). Each market's MLS must be ONE code: "BRIGHT, CVR"
  on a single row matches no board and would clear the codes.

**"The tools show different client counts" (30 Sep).** The client read 50 in
the Database, 54 with 35 active in Analytics, and 31 active in Health.

- Every number was true of its own table. Analytics counts rows: the 50
  clients, plus 2 second-portal rows (Properties & Estates Florida, SERHANT. PA
  15M+), plus 2 rows that are not clients (Demo Portal, Test FUB). All 4 are
  marked active, which turns 31 into 35.
- Every tool's client screen in the OS now opens with the same line: "50
  clients · 31 active · 9 paused · 10 churned".
  - Where that tool's table differs, the line names the rows that make the
    difference.
  - Analytics also tags those rows in place.
  - Code: `lib/reconcile/client-counts.ts`, `/api/workspace/clients/counts`,
    `components/clients/count-line.tsx`.
- The standalone Analytics app still says 35/54, because it counts rows. Only
  a data change would move it, and that data belongs to a live tool, so it
  needs the user's decision. The facts for that decision:
  - P&E Florida, Demo Portal and Test FUB have no campaigns.
  - SERHANT. PA 15M+ has one live EmailBison campaign.
- **The Database's status is now written in the same request.** A status
  change writes `orch_clients.health_status` at once, as its own "database"
  step. It used to follow Client Health on the Onboarding scheduler's daily
  pass.
- The record's status control now names any tool that did not take the change.
- Amy was added to Team access, and the sheet's remaining 30 Account Manager
  rows were imported.

**Counting rules and the last status gaps (30 Sep, the user's decisions).**
- The user's rules: Demo Portal is kept but is not counted as a client; a
  client with several portals counts once; Test FUB is deleted.
- **Test FUB was deleted** from Master Inbox and Analytics. It held no threads,
  campaigns or other data. Its test portal was switched off first, because
  Master Inbox refuses to delete a row whose portal is live.
- **Every status change now also writes Master Inbox's `clients.status`**
  (`lib/clients/mi-status-mirror.ts`). It writes only that column, never
  `portal_enabled` or a token.
  - It covers the client's own row and any second-portal row that carries its
    name or an alias.
  - Analytics' second-portal rows follow their client the same way.
  - The 16 stale Master Inbox values were brought in line once; no portal
    moved.
- **Result:** statuses agree 50/50 across every tool, with 0 conflicts, 0
  coverage gaps and 0 status ↔ portal mismatches. Client Health, the Database
  and Onboarding each hold exactly the 50 clients.
- **Closed the same day, on the user's instruction:**
  - **The standalone Analytics app now counts clients, not rows.** Its header
    reads "50 clients · 31 active · 19 paused/churned".
    - Demo Portal and the two second-portal rows are still listed. They are
      named in the header and tagged in the table.
    - The change is display only: no data, matching or attribution changes.
    - Code: `src/lib/clients/roster-count.ts` in `Corofy/Analytics
      Dashboard`, deployed with `railway up --service analytics-web`.
  - **The "Douglas Elliman LA" alias was synced to Analytics.** It was first
    checked by running the real matcher over all 595 campaigns with and
    without the alias: 0 changed.
  - **"New client portal" was deleted** from Master Inbox. It was an empty
    placeholder, and its placeholder portal was switched off first.
  - **The consistency check is clean:** statuses agree 50/50, with 0 gaps,
    0 link errors, 0 duplicates and 0 alias findings. All 34 open portals
    serve and match their status.

**Team roles, one account manager, commissions for both roles (30 Sep).**
- **Team access** now carries the roles. Every person can be Admin, Account
  manager and/or Salesperson. Roles are chosen when inviting and changed from
  the row's Edit dialog, which also edits name and email.
  - A rename is carried to their clients and to Onboarding.
  - A new email moves their access, salesperson record and rates, and signs
    them out.
  - The separate Salespeople section is gone. Salespeople with no sign-in yet
    are listed in the team table with an Invite link, which links their
    existing record (clients and rates) to the new sign-in.
  - Storage: Admin and Account manager are columns on `os_users` (migration
    0021). Salesperson is an active `os_salespeople` row carrying the
    person's email. Code: `lib/identity/team-roles.ts`.
- **Admins** are the owners in ADMIN_EMAILS (fixed, never editable) plus
  anyone marked Admin. Every admin check reads both
  (`lib/identity/admin-db.ts`). A marked admin holds every tool.
- **Account Manager is one person per client**, chosen from people with the
  role; saving two is refused. Older "Amy, Eddy" values still read, and
  Commissions pays the first named until the data is fixed.
- **Commissions:** a client's salesperson and its account manager each earn,
  at their own rates.
  - Everyone sees only their own earnings, as either role or both. Checked on
    production: Amy asking for everyone, or for Eddy, gets only her own.
  - Admins see everyone, set rates per person, and assign both people.
  - At the default rates both people get 70% of month 1 — confirm the rates
    with the client.
- **Open:**
  - **Migration 0021** must be run. Until then nobody has the Account manager
    role, so every active member can be picked, and only owners are admins.
  - **Markets:** done — see the next entry.

**Markets, MLS and Area as the client data sheet has them (30 Sep, `fa6e1da`).**
- They are three independent fields on `os_clients` (migration 0022, run):
  - `market_count` is a number.
  - `mls_codes` is a list of board codes.
  - `areas` is a list of area names.
- They replaced the paired (market, MLS, area) rows of 0017, which forced a
  symmetry the business does not have: ChuckTown has 6 markets, 5 boards and
  7 areas. `os_client_markets` is left in place, unread.
- Code: `lib/clients/coverage.ts` (pure, tested), `coverage-db.ts`, and
  `/api/workspace/clients/markets` (GET, PUT).
- Everything that reads markets now reads these fields: the Markets tab, the
  Clients table, Client Health (the OS screen and the standalone app), the
  Database and Onboarding location lines, and the MLS sync to Onboarding.
- All 40 sheet clients were imported as written and checked 40/40. Onboarding's
  MLS codes are unchanged; five clients' codes are now in the sheet's order.

**Client Health feedback (30 Sep).**
- A "+N ahead" badge now shows beside the intros when a client has delivered
  more than the current cycle requires. It is in both the OS and the
  standalone app, and is display only.
- The standalone app's market count now reads the new fields; it was
  counting the old paired rows. Only the `web` service was deployed, because
  sync code did not change.
- The client's questions were answered from `billing.ts`:
  - The anchor date still sets every billing date.
  - Monthly periods are 28-day blocks phased from each client's cycle that was
    in progress on 28 Sep.
  - At Risk means delivered is below `floor(carry + target × elapsed / 28)`.
- **Open:** should over-delivery bank credit toward the next cycle? That is a
  rule change, pending the client. Syncing billing dates from Stripe is also
  open; the client called it not a necessity.

**Analytics (OS + standalone), Client Health portals, intro visibility (1 Oct).**
- **Sending limits column** on Campaigns: "daily send limit / new leads per
  day", e.g. 1,000/500. EmailBison values come from `campaigns`; Instantly's
  (`daily_limit`/`daily_max_leads`) are read live for the page's campaigns.
- **Sequence: Delete / Turn off / Turn on** (`sequence-rules.ts`, tested;
  `sequence-live.ts`). Verified behaviour:
  - Delete is offered only for a step or variant that has NEVER sent.
    EmailBison refuses sent steps and the last step. A main step's
    variants must be deleted first.
  - Turn off / Turn on is for steps that HAVE sent. EmailBison allows it
    ONLY while the campaign is paused, and the screen says so.
  - Instantly edits the whole sequence and uses `v_disabled` for off.
  - Everything is re-read live and re-checked on the server.
- **Remove Unsupported Mail Servers** button on the campaign header
  (`mail-servers.ts`, `unsupported-servers.ts`):
  - EmailBison tags every lead with its mail server. The rule removes
    Proofpoint, Mimecast, Barracuda, Zoho and Custom Mail Server; Sophos
    and Outlook Gov stay (user decision).
  - Instantly gives 1 Google, 2 Microsoft, 3 Zoho and 999 for everything
    else, so 3 and 999 are removed.
  - Preview first, then confirm, then a recount. Leads are removed from
    the campaign only, never deleted.
  - Verified with one test lead per server on draft test campaigns in both
    platforms. The test campaigns and leads were then deleted.
  - An inbox-less test campaign is auto-archived by EmailBison within
    minutes of being paused.
- **Client Health counts every portal's introductions** (shaurs
  `scripts/sync.ts` + `lib/portal-aliases.ts`, and the OS copy). The
  portal → client map is built each run from `clients.campaign_aliases`.
  The old hard-coded Florida entry pointed at a name no client has. Result:
  P&E 30 → 40, SERHANT. PA 39 → 42, no other client changed (dry run, then
  confirmed live). Add portal now also adds the new portal's name to the
  client's Client Health aliases.
- **Eddy's asks:**
  - The record header links every portal (P&E: Boston ↗, Florida ↗).
  - "No intro template" is visible in three places: a tag in the Clients
    list (active/onboarding only), a warning on the record with "Add
    them", and a tag beside the composer's Introduce button.

**Which portal each campaign's leads go to (1 Oct).**
- Problem: Master Inbox sorted a reply into a portal by guessing from the
  campaign NAME. Properties & Estates has two portals (Boston, Florida), and
  the guess sent the Florida campaigns' replies to Boston — including the
  active "Rutenberg 1 + South Florida" (#295).
- Now, for a client with more than one portal, each campaign's portal is
  chosen automatically ONCE and saved in `os_campaign_portals` (migration
  0025). The rule (`lib/clients/campaign-portal-plan.ts`, tested), in order:
  1. a market word in the campaign name ("… South Florida …" → Florida);
  2. else the portal the campaign's replies already go to;
  3. else today's name guess, if it is one of the client's portals;
  4. else the main portal (the one `os_clients.mi_client_id` links).
- The OS saves the choice in a background pass every 10 minutes, on Railway
  only. It never changes a saved row.
- Change it on the client's record → Campaigns → "Leads go to". A choice
  made there is marked "chosen by <person>".
- Only NEW replies follow a choice. Leads already in a portal stay there
  (user decision). Move old ones by hand in the inbox if needed.
- Master Inbox's `derive.ts` reads the saved choice first, in BOTH the OS
  and the standalone app (which receives the webhooks today). With no row,
  or if the table can't be read, it guesses exactly as before. Single-portal
  clients have no rows, so they are unchanged.
- Preview before go-live: only P&E changed — its 5 Florida campaigns go to
  Florida. SERHANT. PA (its "BRIGHT 10M+" campaign feeds the 15M+ portal)
  and the 48 single-portal clients stay as they were.
- Deployed: OS `e6dae32`, standalone Master Inbox `fe2e342` (deployment
  ac34310a). Verified: 1,450 OS tests and 104 Master Inbox tests pass, and
  7/7 Chrome checks with writes blocked. 33/33 portals serve.
- **Add portal (1 Oct, `lib/clients/add-portal.ts`):** Clients → client →
  Campaigns → "+ Add portal" (admins only; Active/Onboarding clients).
  1. You type the market. A preview shows the name ("<client> <market>")
     and which campaigns would move. Refused if that portal already exists.
  2. On create, the name is added to the client's aliases first (undone if
     the next step fails).
  3. The portal is created through Master Inbox's own POST /api/clients,
     exactly as onboarding does, then given the nine standard features.
  4. AUTOMATIC campaign choices that mention the market move to the new
     portal (`relinkPlan`, tested). Manual choices never move.
- **Introduce and the reply-agent handover now find the client from ANY of
  its portals** (`roster-for-portal.ts`, in both apps): the linked portal,
  then a campaign → portal choice, then the portal name among the client's
  names. Before, a lead in P&E's Florida portal read as "not on the
  workspace roster". P&E still has no contact name/role filled in, so
  Introduce stays unavailable for it until those are added (Boston too).
- **The Assistant ("MCP") now covers the whole OS (5 Oct).** Ten read-only
  tools in `tools-phase7.ts`, keyed on the MASTER client (one client, several
  portals): client_record, list_clients, client_billing + billing_overview
  (Stripe MRR, spend, unpaid/past-due invoices; a shared Stripe customer names
  both clients), commissions, team, client_introduction, client_portals,
  portal_pipeline, find_lead. campaigns_for_client now carries daily send /
  new-lead limits. The prompt no longer says "no revenue is stored"; status
  lists come from list_clients, never onboarding_pipeline. find_client says
  when several portals are ONE client. MAX_ROUNDS 4→5. Before: 4/14 test
  questions right ("no paused clients" when there were 8); after: 24/24 plus
  7 harder mixed ones. Welcome screen: suggestions grouped Clients / Money /
  Performance / Pipeline & leads. Still admin-only.
- **More than three "Introduce to" people (5 Oct, client ask).** People 1–3
  keep their columns; 4+ live in `os_clients.more_contacts` (jsonb list,
  **migration 0028**), up to 10 in all. `moreContactsFrom` (intro-macro.ts,
  both apps) reads it; os-clients/edit/intro-override/roster-for-portal all
  tolerate the column being absent. The edit API takes `moreContacts` (whole
  list; each needs name + role). Introduce to tab: "+ Add a person" once the
  first three are filled, Remove per person. Everyone is named in the standard
  introduction and copied in; a client with a CUSTOM intro gets them in Cc
  only — its text is the client's own.
- **Client reports (6 Oct).** "How is X doing / full report" goes to
  `client_report` (tools-report.ts): one call reads the master record,
  Stripe, Campaign Analytics for the client (last 30 days vs the 30 before,
  and vs the business on the same platforms — `campaign_kpis` now takes a
  `client`), the portal pipeline, Client Health (cycle, weekly volume, health
  score), reply labels, the intro setup and scrapes, and computes the verdict
  (On track / Needs attention / At risk; Paused / Churned), attention items
  with concrete next steps naming the account manager, and strengths. The
  system prompt fixes the report's shape (heading + verdict, tables,
  Needs attention, Going well, sources). Paused/churned clients are checked
  for campaigns and Stripe stopped to match. It also flags a billing cycle
  that disagrees with Stripe (Jeff Cook: record 6 Oct vs Stripe 16 Oct).
  Facts must come from tools — a follow-up once answered "Amy" from an
  example in a tool description; examples now use placeholders.
- **Assistant full test (6 Oct).** All 44 tools run through the real engine
  on production data (scripted model, read-only), key figures checked against
  independent queries; 62 real questions on production, twice, 62/62 both
  times (median 4 s); access 33/33 (signed out 401; Amy, Gabriel, Sankalp 403
  on every route and redirected off /assistant; admins cannot read or delete
  each other's chats); the page in Chrome 13/13. Fixed on the way:
  recent_introductions counted only the newest 60 (said 60 for a fortnight of
  150; now counts every row, paged); campaign_detail now finds loosely named
  campaigns ("Jeff Cook Greenville"); list_clients returns the matching
  clients' own status counts (Amy's "30 active" was the business-wide count;
  22); reminders, find_lead and "Jeff Cook is a client, not a lead" wording;
  the **Ask button never sent** (Btn defaults to type="button" — only Enter
  worked since 21 Sep); 15 phase-8 tools had no display label.
- **Introduce by territory (6 Oct, Jeff Cook).** Each person may list the
  places they cover ("Charleston, Summerville"). A lead is introduced to the
  people whose place appears in its campaign name (whole words; case, accents
  and dashes ignored), plus anyone with no territory; a campaign naming no
  territory goes to everyone, and the composer warns. `routeIntro` in
  intro-macro.ts (both apps, identical tail) returns a client holding just
  those people, so the wording, the Cc and the reply agent's handover need no
  change of their own; the thread's `campaign_name` picks. Storage: people 1–3
  in `os_clients.contact_territories` ({"1": [...], "2": [...], "3": [...]},
  **migration 0029**), 4+ inside their `more_contacts` entry. Every reader
  tolerates 0029 being absent. Record → Introduce to: a Territory field per
  person and "Who each campaign's leads are introduced to" (from the client's
  conversations, newest first). The stored "Intro Macro" template still names
  everyone — it is what the Templates picker inserts by hand.
- **Assistant phase 8 — every OS screen (5 Oct).** Fifteen more read-only
  tools (`tools-phase8.ts`): workspace_home, business_performance,
  data_consistency (runReconcileCheck, send:false), billing_cycles and
  client_success (Client Health views), campaign_kpis, attribution,
  offer_performance (removed 9 Oct with Copy & Offer), send_schedule, campaign_detail (these call the Analytics
  routes' own GET handlers — no session check inside them, no copy),
  onboarding_client (+ open payment links), find_agent (scraped agents),
  search_conversations (message text), reply_templates, recent_introductions.
  45 tools in all. Setup screens (stage/template editors, Settings) are left
  out on purpose. Probe: 15/15 new + 24/24 earlier questions right.
- **Portal links open straight on Welcome (5 Oct), standalone Master Inbox.**
  `/portal/<token>` is still the Recruiting Pipeline. The first PAGE LOAD of it
  each browser session now redirects to `/welcome` on the server (before any
  pipeline data is read); `/welcome` sets a session cookie
  `portal_welcomed_<token>` scoped to that portal (proxy.ts), after which the
  base URL opens the pipeline. In-portal navigation (RSC requests) is never
  redirected, so the pipeline stays reachable even without cookies. The old
  client-side `WelcomeRedirect` (sessionStorage) is gone. Unknown portals still
  404 with "Portal not found". `lib/portals/welcome.ts`. No URL changed.
- **Introductions from Nicole; teammate permissions (5 Oct, Eddy), both inbox
  apps.** Introduce and the agent's handover switch From to
  nicole.c@brokerstaffer.com's live mailbox for the conversation's platform
  (`intro-sender.ts`; override `MASTER_INBOX_INTRO_SENDER_EMAIL`). Her live
  one is EmailBison sender 1873 = channel 148aacc2 (daily limit 0 in
  EmailBison — replies have gone out fine). Her Instantly mailbox (dead since
  26 Sep) and EmailBison #611 (deleted) were marked `status=disconnected`;
  disconnected channels are hidden from From and refused on send. The From
  button shows the address (hundreds of mailboxes are named "Nicole
  Collins"). Permissions (`canSeePage`): Performance, Consistency, Assistant,
  Team access, Reply agent admin-only; Clients = account managers;
  Commissions = AMs + salespeople; inbox Settings for teammates = Labels,
  Templates (Personal removed 9 Oct), with creating clients and AI labeling refused by the
  server. Known and left: the "sync-external-intros" cron 401s — its feed on
  Client Health was removed in June.
- **Campaign Leads: every column sorts (2 Oct), both apps.** Analytics
  migration 094 (run by the user; file in the Analytics repo) adds sort keys
  `name`, `domain`, `sender_email`, `replies`/`positive`/`bounces`,
  `attr:<name>` (text) and `attrn:<name>` (amounts as numbers) to
  `analytics_campaign_lead_rows`, and p_sort/p_dir to
  `analytics_instantly_lead_rows` (dropped + recreated, same grants). It also
  fixed an old bug: pages came back re-sorted by last_sent_at, so any other
  sort was out of order within a page. Instantly rows now carry `name`.
  Verified on both production apps, every column, both directions.
- **Security and roles (2 Oct, Eddy — someone was let go who knew the admin
  password).** admin@outreachify.io has a new generated password: its hash is
  in os_users (wins at sign-in) AND in the os service's AUTH_USERS (the
  fallback), so the old one works nowhere on the OS. Everyone was logged out:
  every os_users token_version was bumped, and `SSO_SESSIONS_NOT_BEFORE`
  (ISO time, os service) makes bs-auth refuse any session minted before it —
  instantly, not after 30 minutes. Standalone apps that read the cookie still
  honour old cookies until they expire (≤30 min); their refresh comes back to
  the OS and is refused. Analytics and Client Health keep their OWN sign-in
  lists — not checked (their Railway tokens were rejected on 2 Oct).
  Roles (nav.ts `canSeePage`, viewer-roles.ts): Consistency is admin-only and
  sits under Admin; account managers lose Performance; salespeople lose
  Performance and Clients (both roles keep Clients). Typed URLs redirect Home
  and the Performance/Consistency APIs answer 403 (`pageGuard`). Home greets
  by the Team access name. Team access has Delete (invited people only; not
  self, not an Owner, not AUTH_USERS; salesperson records are kept).
- **Client profile fields and Stripe figures (1 Oct, Eddy).** Clients now has
  Sign up date, Website, Zillow profile, POC name, POC email (os_clients,
  **migration 0027**; `client-profile.ts`, read on their own so the list
  works before 0027), and Total spend + MRR in Billing. Sign up date shows
  the Stripe customer's created day unless one is entered ("· Stripe"
  marks the fallback). Total spend = successful charges less refunds; MRR =
  live, unpaused subscriptions normalized Stripe's way (30.4375-day month:
  $750/14 days = $1,630.58) — both match Stripe exactly for The Rafeh Group.
  Read by `stripe-summary.ts` (10-min cache) through
  `/api/workspace/clients/stripe-summary`, fetched AFTER the list so Stripe
  never slows it. Commissions: every column sorts.
- **Commissions rules changed (1 Oct, Eddy, before that day's payroll).**
  No more 70% Month 1 or 15%/25% residual. Every payment earns a flat rate
  of the amount after Stripe's fee (2.9% + $0.30 per charge): the
  salesperson 20% or 10% (one setting per salesperson, on their card;
  stored in `os_salespeople.residual_rate`, the old 15%/25% read as 20%),
  the account manager a fixed 5% ONLY from Month 2 (nothing on the first
  28 days of billing; `os_commission_reps` is no longer read).
  ACTIVE clients only — paused/churned/onboarding are neither listed nor
  paid (user decision, even when a payment was due). Someone with both roles
  (Eddy) is one card, `p:<email>`. New "Monthly (net)" column; the
  "How payouts are calculated" section is gone. Rules in `schedule.ts`
  (`stripeFee`, `netPer28`, `salespersonRate`), tested. Five active clients
  still say "Amy, Eddy" as account manager; "Amy" alone matches nobody, so
  they pay no account-manager commission until one is chosen.
- **The introduction is shown, and can be replaced (1 Oct, Eddy's ask).**
  Clients → a client → Introduce to now opens with "The introduction": the
  exact text the Introduce button and the reply agent send, lead fields shown
  as labelled chips, a Copy button, and **Use a custom intro** — paste the
  client's own wording (fields can be inserted), Save, or **Back to standard**.
  Stored in `os_clients.intro_override` (**migration 0026**). When set it
  wins everywhere: the Introduce button in both apps, the agent handover
  (an agent's own handover message still wins over it), and the stored
  "Intro Macro - <client>" template. The contacts still set the Cc. Rules in
  `intro-macro.ts` (`customIntro`, `introText`, `introReady`, tested); a
  custom intro alone makes a client "ready", so the "No intro template" chip
  goes away. Before 0026 runs every read falls back without the column and
  the custom button is disabled with that reason.
- **Known gap, not fixed:** Client Health counts only the Boston portal's
  introductions for P&E (30 vs 34 Boston + 12 Florida). The live Client
  Health sync is a separate service whose code is not in any repo here. A
  portal added with Add portal is not counted by it either.
- Also 1 Oct: Master Inbox Back now returns to the client list the thread
  was opened from (the list links dropped ?list/?f/?page/?q).

**Create a subscription from the OS — payment links (1 Oct).**
- For a client with no subscription, or a cancelled one, the record's
  Billing section offers **Create subscription**. Admins only.
- Enter the amount, then choose every 14 days, every 28 days or every
  month. Continue shows the price in words; confirming creates a Stripe Price
  and a Payment Link. The link can be paid once, and nothing is charged until
  the client pays.
- The record then shows the open link, with Copy link, Open, Check payment
  and Cancel link.
- When the client pays, Stripe creates the subscription. The OS finds the
  paid session and writes the customer and subscription to the record
  through `editClient`. That happens on Check payment, when the record's
  billing is read, and every 180s in the background (`instrumentation.ts`).
  Commissions and Pause/Resume then work for that client.
- **Guards:**
  - It refuses a client whose subscription is still live.
  - A client has one open link at a time.
  - If the database insert fails, the link is switched off in Stripe, so no
    payable, untracked link is left behind.
- Code: `lib/clients/payment-link-plan.ts` (pure, tested),
  `payment-links-stripe.ts` and `payment-links.ts`. The billing route
  handles `create_link` and `cancel_link`. Table `os_payment_links` is
  migration 0024, run 1 Oct.
- **Verified:**
  - Stripe test mode, end to end: the link was created, paid with the 4242
    card, and settled with the right amount and interval. The test objects
    were then removed.
  - Production Chrome, writes blocked: 7/7. Cain and Toll show the button.
    The confirmation reads "$750 every 14 days". The create request carried
    the right body and was blocked. The Keyes (collecting) does not offer it.
    No link was created.
- This is separate from Onboarding's payment-link step, which stays switched
  off. The client chose this option (a link to send) over the OS charging a
  card directly.

**Billing button, admin pages, and a full audit (30 Sep night).**
- **Pause billing / Resume billing** is on the client's record, under
  Billing (`lib/clients/billing-control.ts`, `/api/workspace/clients/billing`).
  - Admins only, for reading as well as changing.
  - It shows Stripe's live state: collecting or paused, the amount, and the
    next charge.
  - There is a confirmation step. Pause uses "void" and never cancels.
    Resume is refused for a cancelled subscription.
  - The subscription is always the one on the record.
- **Admin-only pages:**
  - Team access and Reply agent: admins only. The menu and the command
    palette now hide them from everyone else.
  - Assistant: admins, or anyone holding every tool.
  - Everything else under Workspace is open to anyone signed in. Commissions
    shows each person only their own.
- **Audit results:**
  - API and security: 57/57, run as the admin, Amy (account manager), Eddy
    (both roles) and Sankalp (no role). Every refused billing call left Stripe
    unchanged.
  - Performance, recomputed independently from the raw rows and raw Stripe
    invoices: matches exactly. Spotlight's Sep churn comes from the status
    history.
  - Chrome as the admin: 14/14. All 50 client records opened cleanly. The
    Pause billing confirmation was blocked, so nothing was charged.
  - Chrome as Amy: menu, Commissions scope, no billing control, and Team
    access refused.
  - 34/34 pages; consistency 50/50.
- **Fixed during the audit:**
  - Someone with no role saw a $0 "Account manager" card in Commissions.
  - Team access opened by a non-admin said only "Forbidden".

**Stripe links, round 2 — the client's answers (30 Sep).**
- Douglas Elliman Las Vegas → $250; Douglas Elliman Los Angeles → $500. One
  customer, two clients.
- Raintown → $750; JPAR Iron Horse → $500. Same card.
- Kelly + Co → its most recent subscription ($1,500/month, cancelled).
- Military Veteran → its subscription from 29 Apr (cancelled 13 May). The
  client says this client is churned, but the OS says paused, pending
  confirmation.
- Commissions now reads Stripe for 38/40. Cain and Toll have no subscription
  yet; the client asked whether one can be created from the OS. The
  Onboarding payment-link step exists but is switched off.

**Stripe links from the client's "Subscriptions" sheet (30 Sep).**
- All 51 rows were checked against Stripe. Every subscription belongs to the
  customer the sheet names.
- 7 were linked through the edit route:
  - 54 Realty (the "54 Realty LLC" subscription, the one still collecting).
  - The Wurst Team ("A Better Way").
  - For history, all cancelled: RE Home Group, Spotlight, Karp, Maltos and
    Rise Antelope.
- Commissions now reads 32 clients from Stripe.
- **Open, needs the user:**
  - Raintown has 2 active subscriptions ($750, and $500 labelled "(JPAR)" —
    is that JPAR Iron Horse's?).
  - Douglas Elliman Las Vegas has 2 active ($250 + $500 — is one Los
    Angeles?).
  - Kelly + Co has 3, all cancelled.
  - Cain, Toll and Military Veteran are not on the sheet.
- **Stripe billing is paused while the client is Active in the OS:** Oz
  Group, BHGRE Base Camp, Discover Phx Team, and The Wurst Team.
- The sheet also lists 5 cancelled clients who are not in the OS: Anderson
  RE, Polzl ×2, DiGiulio and Orland.

**Onboarding / churn dates and Performance (30 Sep, `821e2aa`, `2fe5388`).**
- **Migration 0023** adds `os_clients.onboarding_date` and `churn_date`.
  - Both are editable on the client's record.
  - The churn date is stamped when a status CHANGES to Churned (not on a
    re-save).
  - The onboarding date is stamped when a client is added through Add Client.
  - They are read on their own (`lib/clients/client-dates.ts`), so the
    record still loads before the migration.
  - Onboarding's own `orch_clients.onboarding_date` is the Calendly CALL
    time, which its booking alerts rely on. It is deliberately not written.
- **Performance** is rebuilt from the master record
  (`lib/workspace/performance-model.ts`, pure and tested):
  - Added: onboarding date, with start date as the fallback.
  - Churned: churn date.
  - Net.
  - Active at month end.
  - Revenue: paid Stripe invoices by month, from the 30 linked clients.
  - It is cached and warmed in instrumentation.
- **Commissions** stops accrual at a churn date entered on the record.
- **Data to enter:** 9 of the 10 churned clients have no churn date, and 5
  clients have no onboarding or start date.
- **Deployed 30 Sep, 23:45** after Railway resumed, together with the
  Play/Pause fix, the Stripe throttle and hiding Date added (`2d96a9e`).
  Standalone Client Health `web` was also deployed.
- **Verified on production:**
  - Performance shows revenue of $38,850 this month, plus churn, net and
    active at month end.
  - Commissions reads Stripe for all 29 linked clients.
  - 54 Realty's ▶ previews both paused campaigns, in the OS and the
    standalone app.
  - The dates are editable, and Date added is hidden.
  - 34/34 pages pass.

**Audit, 30 Sep (evening).**
- **Clean:**
  - Statuses agree 50/50 across all tools.
  - 0 coverage gaps, 200/200 links, 0 duplicates, 0 alias drift.
  - Every tool holds all 50 clients; its extra rows are named second portals
    or non-clients.
  - 34/34 open portals serve and match their status.
  - The sheet matches the master for status, salesperson, markets / MLS /
    area and brokerage on all 40 sheet clients. The 10 clients not on the
    sheet are exactly the churned ones.
  - 1,419 tests pass; 77 read APIs with 0 server errors.
- **Fixed during the audit:**
  - Play/Pause could not resume campaigns paused outside the toggle — Eddy's
    54 Realty report. Now ▶ offers them, after the same live preview. Changed
    in the OS and in standalone Client Health (`cf2284a`, shaurs).
  - Stripe reads for Commissions were rate-limited when fired all at once.
    They are now 4 at a time, with retries.
  - Railway paused all deploys on 30 Sep evening. Both of these fixes are
    committed and waiting on a retrying deploy.
- **Open, for the user:**
  - 7 clients still name two Account Managers (the user is fixing the data).
  - Eddy is "Eddy" on Team access but "Eddy Boccara" as a salesperson and in
    Onboarding, which shares one person row for both roles.
  - Commissions:
    - 11 clients have no Stripe link, so they earn $0. Stripe search
      candidates: Raintown (2 active subs); Douglas Elliman Real Estate (2
      active subs — LV / LA?); cancelled subs for Kelly + Co, LPT Military and
      RE Home Group; nothing for 54 Realty, JPAR or Wurst.
    - Month 1 is "the first 28 days" versus the spec's "first gross payment".
    - Both roles take 70% of month 1 by default.
    - Ryan and Scott are not invited yet.
  - Onboarding's Gmail connection is still `invalid_grant` (Eddy must
    reconnect). The Slack alert channel is unchosen. Client emails and payment
    links are still off.
  - Before switching off Client Health, point Master Inbox's
    `CLIENT_STATUS_URL` at the OS status feed.

**Speed (`e06c255`, `a1bec34`).** Measured on production
before and after, from India (network floor ~255ms a request):

| | before | after |
|---|---|---|
| Home, time to first byte | 0.9–2.0s | 0.27s |
| Clients (`/roster`) after a quiet spell | 12.6s | 0.27s |
| Rail click whose hover preload has landed | full round trip | ~30ms |
| Analytics KPI / series, asked again | 1.1–1.5s | ~2ms |

What changed, and why:
- **One cache per process, not one per bundle.** Next builds a module
  separately for the page render, the route handlers and
  `instrumentation.ts`. Each copy had its own module-level cache, so the boot
  warm-up filled a master client list that no page read. It also meant a
  route's `invalidate()` cleared only its own copy: an Onboarding stage move
  or a Client Health edit could show stale on reload.

  `ttlCache` now takes `shared: "<name>"`, which keeps the store on
  `globalThis`. The caches that are warmed or invalidated across bundles use
  it, as do the tool status snapshots (`status/store.ts`). **Any new cache
  that is warmed in `instrumentation.ts` or invalidated from a route must be
  `shared`.**
- **Nothing on the rail blocks a click.** The badge counts took ~2s, and the
  first click after each quiet minute waited on them. They and Home's overview
  are now served stale-while-refresh, and are kept warm every four minutes
  together with the tool probes.
- **Analytics repeat reads** (`kpis`, `timeseries`, `filters`,
  `infrastructure`) go through `lib/tools/analytics/cached-get.ts`. The cache
  lasts 60s and is keyed by every query parameter, so a filter change still
  reaches the database. Errors are never cached. A finished sync marks the
  answers out of date (`ttlCache.expire()`), so the next reader still gets an
  immediate answer.
- **Hovering a rail item preloads the whole screen** (`kind: "full"`). The
  preload is kept for 30s (`staleTimes.static` in `next.config.ts`); a clicked
  screen is never replayed.
- **Left as they are, on purpose:**
  - The inbox's thread query (~0.85s). It is the tool's own, ported verbatim
    with its corrections.
  - The Consistency audit (~4.8s). It is a live check.
  - The single 1.5 MB client script (376 KB gzipped). Every screen is imported
    by the catch-all page. Pages still paint in ~0.35s because they are
    server-rendered. Splitting it per screen is the next speed step.

---

## 0.11 What changed on 29 September

All deployed to `os`, verified on production, pushed (`25c453c`, `a005c4e`).

**Client Health — billing cycles replace the weekly target** (the standalone
app's "Health Dash Major Changes", ported per `shaurs/docs/HEALTH-DASH-MAJOR-CHANGES-OS-PORT.md`):

- `billing.ts` is copied byte-for-byte from the standalone app (`lib/billing.ts`),
  with its 16 tests. Keep it identical — `diff -q` the two after any edit.
- One billing snapshot per client drives Monthly, Intros / Billing, Last / Next
  Billing, Days Until, Status, the cards, the filters and the sorts. It is taken
  as of now for the current week, and as of Sunday 12:00 UTC for a past week.
- New on Weekly: Weekly Emails Sent, the "+N carried" badge (its popover shows
  target, delivered, carry and total required), a red row edge while carried
  intros are owed, a markets line, and Play/Pause next to the portal arrow.
  Left This Week and the weekly target are gone everywhere, including the
  Onboard and Edit dialogs; a new client stores its plan's default in the NOT
  NULL `weekly_target` column.
- **Play/Pause** — `/api/tools/client-health/clients/campaigns`:
  - who can use it: signed-in people only; a machine token gets 403;
  - how it decides: previews from live Instantly and Bison statuses, then
    re-plans when applied;
  - what it records: `toggle_paused_campaigns`, shared with the standalone app,
    and one `campaign_toggle_log` row per attempt;
  - what it never touches: client status, portal or billing.
- The OS sync now writes `clients.intro_dates`, as its own update. It is still
  off (`CLIENT_HEALTH_SYNC_ENABLED=0`); without this write, every billing figure
  would freeze on switch-over day.
- Fixed: in browsers east of UTC, "previous week" skipped a week, because the
  week key was parsed as local midnight.

**Verified:** in a real Chrome with an IST timezone against the UTC production
server, every non-GET request was blocked. The OS matched clients.brokerstaffer.com
with **0 differences** across 32 clients × 11 columns plus all 11 Status and
Performance cards, for this week and last week:

- Keyes: 7/16 and 7 / 8 due.
- Discover PHX: 3 / 2 due.
- Wagner: 0 / 2 due, At Risk.
- The Keyes toggle preview is identical in both apps: 2 to pause, 7 left alone.
  Nothing was paused: the held list is empty, the log is empty, and both
  campaigns are still running.
- The carry badge was checked locally with `CARRY_FORWARD_START` moved back,
  then reverted: 36 badges, 15 red edges, and the popover stays on screen.
- There were no hydration errors.

**One look across the OS** (the client's review: "every page has its own UI"):

- Every screen opens with the same header: a title, one line of context, and
  actions on the right.
- Every screen uses the same stat tiles, panels, tables and tabs
  (`src/app/ds.css`, `src/components/ds`).
- Client Health and Client Success were rebuilt on these components.
- Analytics, Agent Search and Home keep their markup; their older classes are
  restyled to the same tokens (the "MOCKUP ALIGNMENT" block in `ds.css`).
- Analytics keeps its view tabs, now drawn as underline tabs under a page header.

**Checks:** 1,380 unit tests pass and 34/34 pages pass on production.

**Traps learned:**
- `position: fixed` inside an OS screen is relative to the screen container,
  which has a transform — not to the viewport. Portal popovers to `<body>`.
- Never build a date from `` `${key}T00:00:00` `` — that is local midnight.

---

## 0.12 What changed on 28 September

All deployed to `os`, verified on production, pushed (`1e66caa` … `b8cce7c`).

- **§8 views** — all five tool views carry the document's fields; new
  Database view; see §8.
- **One editor per field** — people, MLS, aliases, status, delete; see §13.
- **Stripe at onboarding** — optional field in the Onboard dialog, verified.
- **Analytics campaign owners** — the Database's answer offered in the
  unassigned queue; disagreements listed.
- **MLS boards** — the Markets MLS field offers the Database's 54 boards by code.
- **Daily check on Home** — see §16.

**Verification:** 1,306 unit tests; workflow tests on production with throwaway
clients, each deleted everywhere and swept (people 21/21, MLS 13/13, one-editor
16/16); 19 UI control checks; the five views; 34/34 pages; 77 read APIs with 0
server errors; 37/37 open customer portals serving their page.

**Found, not changed (needs a person):**
- Discover PHX — paused in Client Health since today, active in the OS and every
  other tool. Same client as the open billing question.
- `/inbox` (All Email) — an intermittent hydration error (~1 load in 3 on
  production, 0 in 12 locally); React recovers by re-rendering. In untouched
  Master Inbox code; not yet located.
- Master Inbox and Analytics Add Client buttons inside the OS — see §2.

---

## 0.13 Switching off Analytics, Client Health and Onboarding

**Stay live:** Master Inbox (its app serves every customer portal) and the
Database app. **To be switched off once the OS is complete:** Analytics, Client
Health, Onboarding. State on 28 September:

**Done — the OS no longer needs their servers** (`a6c75a6`). Every status
change, edit, delete, onboarding leg, campaign pause, overview figure and
consistency reader now works on the tools' databases directly. The OS mints no
session for any of the three apps. Home's status cards switch to a database
check and an OS link by themselves once a tool's `*_URL` variable is removed
(`Connector.inOs`), and nothing is embedded from a standalone app: every
destination is an OS screen.

**Done — the OS's copies of their background logic match theirs:**

| Tool | Parity | Runs in the OS today? |
|---|---|---|
| Analytics | sync jobs and routes swept line by line against Campaign-tool @ `68ed3cb`; ported confirm-gone, the Instantly 404 fix, the deleted-campaign queue filter, Instantly copy-sequence (`b8e7ec7`). Remaining differences are intentional OS fixes | **yes** — `ANALYTICS_ENABLE_SCHEDULER=1`, alongside the tool's own `analytics-cron` (same code, same database) |
| Client Health | sync brought level with shaurs `6837ce6` — per-source weekly columns, paged reads, skip-on-unreadable, aliases, Corofy retry (`8f97bfb`) | **no** — `CLIENT_HEALTH_SYNC_ENABLED=0`, and the manual Sync button now refuses while it is off. Two syncs interleaving caused the 17 Sep outage |
| Onboarding | orchestrator steps, webhooks and crons ported (15 Sep) | **no** since 9 Oct — `ONBOARDING_CRON_ENABLED` and `ONBOARDING_CRON_SECRET` deleted with the section (§0.8). Webhook receivers still live |

**Switch-off order, per tool — never run two copies of a sync at once:**

1. **Analytics:** stop the `analytics-cron` Railway service → confirm the OS's
   runs keep `sync_state` green for a day → remove `ANALYTICS_URL` from `os` →
   stop `analytics-web`.
2. **Client Health:** stop the Health Dashboard `sync-worker` **and** `web`
   (both run the sync) between cycles (`sync_runs` shows nothing in flight) →
   set `CLIENT_HEALTH_SYNC_ENABLED=1` on `os` → watch two cycles: every weekly
   row keeps total = instantly + bison → remove `CLIENT_HEALTH_URL`.
3. **Onboarding — needs people first:**
   - **Gmail is disconnected in the OS** (`invalid_grant` for
     eddy@brokerstaffer.com). Eddy reconnects at Onboarding → Settings →
     Connect; until then the OS cannot poll client replies.
   - **The seven client emails and the Stripe payment link are switched off in
     the OS** by decision (`step-run.ts`, 501). If the standalone orchestrator
     sends them today, switching it off stops them until someone enables them
     in the OS.
   - **Third-party webhooks still point at the old orchestrator** — Typeform,
     Stripe, Calendly, EmailBison and the Master Inbox intro hook. Re-point each
     to `https://os.brokerstaffer.com/api/tools/onboarding/webhooks/…` (the OS
     receivers are live and their secrets are set) and remove the old ones in
     the same sitting, or events arrive twice.
   - Then remove `ONBOARDING_URL` and stop `orchestrator`.

**Open, not blocking a switch-off:** an intermittent hydration error on the
OS's Master Inbox list screens (~1 load in 3 on production; React recovers by
re-rendering). Narrowed by diffing server HTML against the hydrated page: not a
date, not the folder icons (they change after load by design); the development
build shows the component tree above the tab bar differing between server and
client. Untouched Master Inbox code.

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
| Onboarding | `ONBOARDING_CRON_ENABLED` — **deleted 9 Oct (off)** |
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
| **Performance › Overview** | `/performance` | Client base, plans and movement (Added, Churned, **Paused**, Net, Active, Revenue by month). Greys out clients who are not contributing, by design. | `performance.tsx` |
| **Performance › Billing Calendar** | `/performance/billing` | Every live subscription's charges in the next 30 days (9 Oct: its own page) | `performance.tsx` (`BillingCalendarScreen`) |
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

### 4.2 Master Inbox — 5 rail destinations + 1 detail screen + settings tabs; Client Portals beside it

The tool's own navigation was an icon rail plus a sidebar plus a second settings
sidebar. It collapses into five rail entries. **Client Portals is its own
product since 13 Oct (§0.5)** — own menu section, own grant; it is listed here
because its screens and routes still live in the Master Inbox folders.

| Page | Path | What it does | File |
|---|---|---|---|
| All Email | `/inbox/all-email` | The conversation list, with unread badge | `master-inbox/full-inbox.tsx` |
| Reminders | `/reminders` | The tool's own page — **replaced a hand-written screen that listed reminders and could not dismiss them** | `master-inbox/reminders.tsx` |
| Archive | `/inbox/archive` | Archived conversations | (full-inbox view) |
| Trash | `/inbox/trash` | Third folder; without this entry a trashed conversation could only be found by typing the URL | (full-inbox view) |
| **Client Portals** (own product) | `/portals` | The admin table of portals: link, Live, SMS, and — for admins — delete (§0.5). The portals themselves live on `portal.brokerstaffer.com` and are deliberately outside the workspace | `master-inbox/portals.tsx` |
| Settings | `/settings/clients` | Eight pages behind the tool's own sub-navigation | `master-inbox/settings.tsx` |

Detail screens (no rail entry):

* **Thread detail** — one conversation, ported line-for-line. This is where the
  Introduce macro and the reply agent's drafts appear. `master-inbox/thread-detail.tsx`
* **Portal detail** — the staff drill-down for one client's portal, at
  `/portals/<id>`. `master-inbox/portal-detail.tsx`

Settings tabs (`master-inbox/settings-tabs/`): `labels`, `templates`,
`ai-labeling` (admin-only), plus `webhooks` (not offered). Members, Personal,
Clients and Reply Agents were removed on 9 Oct — §0.8 says where the last two
went.
**Webhooks is built but not offered in the strip, at the user's request** — the
component and its route still exist.

*Leads* was removed at the user's request: `/roster` is the roster now. Its
route still resolves, so an old bookmark degrades to All Email rather than 404s.

### 4.3 Client Health — 2 destinations

In the live tool these are states of one page with **no URL of their
own**. Here each is a real address, which is what lets the rail link straight to
Delivery and the back button work. (Renamed 9 Oct: Weekly → Overview,
Bi-Weekly → Delivery; Client Success removed — §0.8.)

| Page | Path | Question it answers | File |
|---|---|---|---|
| **Overview** (was Weekly) | `/clients` | Are clients on pace for their billing cycle? One billing snapshot per client (`billing.ts`): Monthly (28-day period), Intros / Billing (delivered / due, carry included), carry badge, Play/Pause; 24 summary cards | `client-health/weekly.tsx` |
| **Delivery** (was Bi-Weekly) | `/clients/biweekly` | **Who bills next, and are they owed introductions when it happens?** | `client-health/biweekly.tsx` |

Shared: `filter-bar.tsx` (one `visible` list feeds both, because the tool
shares it), `toolbar.tsx` (the page header: ← / This Week / →, + Add on Clients page, Sync now),
`billing-cells.tsx` (carry badge, Intros / Billing, Monthly — shared by Weekly and Bi-Weekly),
`campaign-toggle-dialog.tsx` (Play/Pause preview → confirm → per-campaign results),
`summary-cards.tsx`, `client-modal.tsx` (every field the tool's modal has, plus
a read-only **"Also known as"** showing campaign aliases), `campaigns-popup.tsx`
(every campaign linked to a client — the Weekly row only shows what is
*running*, which is the tool's spec), `sync-button.tsx`, `sync-scheduler.tsx`,
`frame.tsx`, `dialog.tsx`, `toast.tsx`.

### 4.4 Campaign Analytics and Campaign Management — 4 + 3 destinations + campaign detail

Two rail sections of ONE tool since 9 Oct (§0.8): Campaign, Volume,
Infrastructure and Attribution under **Campaign Analytics**; Campaigns,
Schedule and Clients (and its Client view) under **Campaign Management**.

| Page | Path | What it shows | File |
|---|---|---|---|
| Campaign | `/analytics/campaign` | KPI band over a segmented control | `analytics/campaign.tsx` |
| Volume | `/analytics/volume` | How much the estate can send, and where what goes | `analytics/volume.tsx` |
| Infrastructure | `/analytics/infrastructure` | The sending estate, lifetime | `analytics/infrastructure.tsx` |
| Attribution | `/analytics/attribution` | What the sending actually produced | `analytics/attribution.tsx` |
| Campaigns | `/analytics/campaigns` | Every campaign on both platforms | `analytics/campaigns.tsx` |
| Schedule | `/analytics/schedule` | What goes out next — a different question from "how did it do" | `analytics/schedule.tsx` |
| **Clients** | `/analytics/clients` | **The most consequential screen in the product to get wrong** — it is where campaigns are attributed to clients | `analytics/clients.tsx` |

**Campaign detail** (`analytics/campaign-detail.tsx`) has **no nav destination**
— it is the drill-down from Campaigns. It carries the write-heavy features:

`sequence-editor.tsx`, `copy-sequence-dialog.tsx`, `push-sequence-dialog.tsx`,
`bulk-deploy.tsx`, `fan-out-dialog.tsx` (one campaign per client),
`re-campaign-dialog.tsx` (duplicate and load with the people who never
answered), `assign-inboxes-dialog.tsx`, `remove-leads-dialog.tsx`,
`campaign-leads.tsx`, `email-panel.tsx`, `copy-tags-panel.tsx` (inside the
sequence editor; the campaign page's Copy & Offer tab was removed 9 Oct).

Two notes for whoever works here:

* `chart.tsx` draws the time series **as hand-written SVG** — the tool uses
  Recharts, the workspace has no charting library.
* `staleness-strip.tsx` exists because every number on these screens is a
  **cached copy** of EmailBison and Instantly. Always show how old it is.
* `filters.tsx` is the one place this port deliberately deviates from the tool.

### 4.5 Onboarding — removed 9 Oct

The section and its screens were removed (§0.8, Release 4). Its webhook
receivers and shared library stay and are live.

### 4.6 Agent Search — 4 destinations

| Page | What it does | File |
|---|---|---|
| Search | The tool's main card plus its three result panels | `agent-search/search.tsx` |
| Courted accounts | Add a login, choose what to import, start the sweep | `agent-search/accounts.tsx` |
| MLS monitor | Which MLSs each Courted account can see, and what changed | `agent-search/mls.tsx` |
| Import Profile URLs | The F1 enrichment flow — paste a Google Sheet or CSV of Zillow / Realtor profile URLs | `agent-search/import.tsx` |

### 4.7 Admin — 3 destinations

| Page | Route | What it does | File |
|---|---|---|---|
| **Assistant** | `/assistant` | Cross-product assistant with stored chats; can answer questions across all tools | `assistant.tsx`, `assistant-markdown.tsx` |
| **Team access** | `/admin/team` | Who may open which tool. Backed by `os_users` + `os_tool_grants`; invites show a one-time password and are never emailed | `team-access.tsx` |
| **Reply agent** | `/reply-agent` | What the agent knows, whether it is working, and its configuration — modes, clients, questions, handover, schedule — plus the agents themselves (create, delete, model, API key, prompt, tone; moved from inbox Settings on 9 Oct) | `reply-agent.tsx`, `reply-agent-config.tsx`, `master-inbox/settings/reply-agents-manager.tsx` |

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
| Client Health Dashboard | ✅ Overview, Delivery (Client Success removed 9 Oct) |
| Client Portals | ✅ managed from the OS — **38 open, 19 closed** |
| Analytics | ✅ seven views, in two sections: Campaign Analytics and Campaign Management (Copy & Offer removed 9 Oct) |
| Database / Agent Search | ✅ search, MLS monitor (master list removed 9 Oct) |
| Onboarding | ✗ section removed from the OS on 9 Oct (its webhooks and shared code stay) |
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
| Create the appropriate saved view | ✗ by choice | the Database developer's analysis (28 Sep): only 4 boilerplate filters are generatable; everything that makes a view a client's is hand-entered and nothing links a client to a brokerage yet. Manual until that relation exists |
| Connect the client's leads | ◐ matched by name | Database app |
| Connect their campaigns | ◐ | the Database records the link as an id (228 of 257). Analytics still matches by name, but since 28 Sep its unassigned queue shows **which client the Database files each campaign under**, one click to pin, and lists disagreements (`lib/tools/analytics/ownership/`) |
| Connect their Stripe subscription | ✅ | `os_clients.stripe_subscription_id` — 30 of 50 mapped. Since 28 Sep it can be entered **in the Onboard dialog** (optional), verified with Stripe through the same save as Edit |
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

**Inside the OS (28 Sep):** Client Health's Add Client now links to the Clients
page (onboarding already creates its row). Two OS buttons remain **pending a
decision**: Master Inbox → Settings → Clients (it is how a *second portal* for an
existing client, and demo portals, are made — there is no other path yet) and
Analytics → Clients (may be needed for the same second-portal case).

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
**Stripe Customer ID and Subscription ID ✅ now on the master record** (migration 0016) — 30 of 52 mapped. The onboarding table's seven Stripe columns were empty on all 43 rows and always had been.

**Campaign** — name ✅, aliases ✅ (owned by Client Health and treated as
identity), status ✅ live from the platforms, ID ◐ matched by name,
MLS/location ✗ 0 / 52 on the master record (1 of 44 rows in the Database app).

**Performance** — weekly and monthly targets ✅, introductions delivered,
replies, bounces, leads in review, leads exported ✅ all generated and fed back.

> The emptiness is the single biggest gap in the whole project, and it is data
> entry, not engineering. The edit dialog offers names already in use, so
> filling these in is mostly clicking. See §6.7 of this document.

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

### §8 Tool-Specific Views — ✅ (28 Sep)

Every view reads the shared fields — status, markets, salesperson, account
manager, sender — **from the master record** (`lib/clients/master-lookup.ts`),
not each tool's own copy, so a field set once shows everywhere. Before 28 Sep
each view read its own table, which is why so much looked "missing".

| Tool | Where in the OS | §8 fields |
|---|---|---|
| **Database** | Agent Search → **Clients (Database)** (`/search/clients`) | Client · Client status · MLS/location · Campaign · Campaign ID · Leads · Sequencers · Replies · Bounces · In Review · Exported · Onboarding status — all 12. Counts come from `os_client_campaign_stats()` (Database migration **0123**, applied 28 Sep): the same SQL as the Database app's Clients page, verified equal on raw rows. A campaign whose leads never synced is marked **not synced** (16 of 283) so a short count is not read as zero |
| Client Health | Weekly | Client · Plan · Status (lifecycle tag) · Weekly/Monthly target · Start date · Billing (interval + anchor) · Timezone · Campaign · Aliases · Performance · Health |
| Client Portal | Inbox → Portals | Client/team · Status · Team · Agents · DNC counts per portal |
| Onboarding | Onboarding → Pipeline | Client · Salesperson · Account Manager · Team · Agents · DNC · Sender · Date added · Status · Stage · progress · leads built |
| Analytics | Campaign → Clients | Campaigns · Introductions (all time) · Replies · Leads · Performance · Status |

EmailBison gives a campaign two ids — a UUID (`bison_campaigns.bison_campaign_id`)
and a number (`raw->>'id'`) that the leads carry. Always key by
`coalesce(raw->>'id', bison_campaign_id)` (`lib/tools/database/campaigns.ts`).

Empty columns are **data**, not missing views: MLS/location, Account Manager and
Sender 0 of 50; stage 15 of 50.

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
| **Billing** | ✅ **decided and live** — paused/churned pauses the subscription, active/onboarding resumes it, nothing is ever cancelled |
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

**Stripe → master client record: ✅ connected, 27 September.** `os_clients`
now carries `stripe_customer_id` and `stripe_subscription_id` (migration 0016),
mapped for 30 of 52 clients from the client's own subscription sheet. The chain
§12 asks for — Client → Billing → Subscription → Billing Dates — is now one
chain.

The subscription, not just the customer, because a Stripe customer is not a
client: "Discover Team" is one customer paying for both Discover Flag and
Discover Phx, and only the subscription says which.

Billing's reaction to a status change **is** now automated, and safely: it
**pauses**, never cancels. Pausing is reversible in exactly the way the rest of
the system is, which is what made it safe to automate at all — a wrong churn
flag pauses collection and flipping the flag back resumes it.

---

### §13 What We Do NOT Want — 13 of 14 addressed

**28 Sep — second editors removed inside the OS.** Four places could change a
shared field in one tool only, which is exactly "different client information
between platforms":

| Field | Second editor | Now |
|---|---|---|
| Status, delete | Client Health Weekly row buttons (Pause/Resume/Churn/Restore/Delete) | link to the Clients page, which does each everywhere |
| Aliases | Analytics → Clients form | saved through the client record → master + Analytics + Client Health |
| Salesperson, Account Manager, Sender | Onboarding page vs Edit | each writes the other (`lib/clients/people-link.ts`, `people-sync.ts`) |
| MLS | Onboarding page's MLS picker vs Markets | Markets are the one editor; `orch_clients.mls` (the lead builder's codes) is derived (`lib/clients/markets-mls.ts`) |


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
| 10 | Centralized billing information | ✅ one owner, and Stripe now linked to the master record |
| 11 | Centralized client/team/agent/DNC | ✅ Master Inbox owns it |
| 12 | Centralized campaign relationships | ◐ recorded as an id in the Database app; Analytics still matches by name |
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

**28 Sep: on, reporting inside the OS.** `OS_RECONCILE_ALERT_ENABLED=1` is set;
the latest result is kept (`lib/reconcile/last-result.ts`) and shown on **Home**
(`daily-check-notice.tsx`). It also runs report-only ~90 s after every start
(`bootCheck`), which never sends. **Slack stays off** (`OS_RECONCILE_ALERT_SEND`
unset, no channel) until one is chosen. Its first run found a real conflict:
Discover PHX paused in Client Health, active everywhere else.

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

### §19 The Core Architecture — 4 of 6 bands complete, 2 partly

| Band | State |
|---|---|
| **Client Identity** — name, ID, status, plan, dates | ✅ |
| **People & Relationships** — salesperson, AM, team, agents, DNC | ◐ Team/Agents/DNC resolve through the record; Salesperson and Account Manager have a home and almost no data |
| **Billing** — Stripe, anchor, interval, next date | ✅ Stripe on the master record; a status change pauses or resumes collection |
| **Campaigns** — ID, name, aliases, MLS, sender | ◐ the link is now RECORDED as an id (26 Sep, migration 0122) — 227 of 256 campaigns carry their client and no client-shaped campaign has unattributed leads; the matcher still *derives* the link from the name, which is the remaining half |
| **Operational Data** — leads, replies, bounces, sequencers, exports | ✅ |
| **Performance** — targets, introductions, analytics, health | ✅ |

---

### §20 The Simplest Way to Think About This — ✅ as a model

One client → one master record → all data → each tool displays the part it
needs. That is what the OS implements, and the tools are genuinely different
interfaces into the same client ecosystem.

---

### §21 The Ideal Workflow — 7 of 10 complete, 3 partly

| Step | State |
|---|---|
| 1 Create Client, once, from the master system | ✅ |
| 2 Master Record Created — unique Client ID | ✅ 52 / 52 |
| 3 Automatic Connections | ◐ Master Inbox, Portal, Client Health, Analytics and the Database record are automatic, and Stripe is now linked to the record; the **Commission Tracker** does not exist, and campaigns are matched by name |
| 4 Client Data Added | ✅ |
| 5 Tools Populate Automatically | ✅ |
| 6 Client Changes — the change is made once | ◐ status yes; other fields still tool-by-tool |
| 7 Automatic Propagation | ◐ status propagates; other centralized fields do not yet |
| 8 Client Pauses — every relevant system reflects it | ✅ portal, Client Health, Analytics, campaigns **and billing** all do |
| 9 Client Churns — every relevant system reflects it | ✅ the same five do, billing included |
| 10 Reactivation — the same record is reactivated | ✅ and the portal URL still works |

Steps 8 and 9 are now held back **only** by the billing decision.

---

### §22 Definition of Done — 19 of 25 (76%)

| Group | Met |
|---|---|
| Client Creation | 2 of 4 |
| Client Data | 2 of 3 |
| Client Status | 2 of 3 |
| **Billing** | **3 of 3** |
| Tool Synchronization | **5 of 5** |
| User Experience | 3 of 4 |
| Future Tools | 2 of 3 |

Billing completed on 27 September: *Stripe is connected to the correct client
record* moved from unmet to met when migration 0016 put the customer and
subscription on `os_clients` and 30 clients were mapped from the client's own
subscription sheet.

**The one unmet requirement:**

1. *We no longer need independent Add Client buttons across tools* — and it is
   deliberate. Those tools stay live and clients use them daily; removing the
   buttons is a decision about switching tools off, not missing engineering.

**The five partly met:** creating a client connects 5 of 7 systems (Stripe now
among them; the Commission Tracker does not exist); changes to centralized
fields propagate (status does, the rest wait on the fields being populated);
status colours are consistent in the OS but the standalone UIs were left alone
on instruction; team members do not re-enter the same information (true for
status, some fields still entered twice); the architecture scales without manual
sync work (enforced in code, unproven until a new tool connects).

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
| Their billing information | ✅ interval and next date on the record, and Stripe linked to it |
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

### 6.3 Three client names — fixed, 7,036 leads recovered

Recording campaign links as ids (migration 0122) made visible a problem that
name-matching had been hiding: four campaigns carrying **7,036 leads** were
credited to no client, purely because the same client was typed differently in
different tools. Confirmed as the same clients, and fixed on 26 September.

| Was | Now | Effect |
|---|---|---|
| Database row `Douglas Elliman LA` | `Douglas Elliman Los Angeles` | 3 campaigns, **5,105 leads** attributed |
| Database row `Momentum Lux Realty` | `Momentum Realty` | 6 campaigns attributed before they carried leads |
| Campaign `Indy Realty 4 + Nicole + MIBOR` | linked by hand to `LIV Indy Realty` | **1,931 leads** attributed |

The two renames move the Database **toward** the master record, which already
held both old spellings as aliases and links both rows by id — so nothing could
be orphaned, and `client_name` is only ever selected in that codebase, never
joined on. Both were done in a transaction that refused to run if the new name
already existed or if more than one row matched.

The third is different in kind and was NOT fixed by renaming: the client is
correctly `LIV Indy Realty`; the *campaign* omits "LIV". Renaming the client
would have broken its other eight campaigns. Its link is recorded by hand
instead, which is durable because the matcher only overwrites a link when it
positively identifies a different client — a name it cannot parse is not
evidence the existing link is wrong. The sync now reports it as
"1 kept despite no name match".

**Result: 227 of 256 campaigns carry their client, and no client-shaped
campaign has unattributed leads.** The 29 still unlinked are templates and
internal campaigns (`Template Zillow Flex`, `Not Interested - All Clients`, the
`OpsLabs Test` rows) plus two test clients and a campaign for a client that was
deleted — all correctly unattached, all with zero leads.

One knock-on, caught by the drift check and fixed: Client Health held
`Douglas Elliman Los Angeles` with only its own name as a campaign alias, so it
did not recognise "Douglas Elliman LA". The missing spelling was added,
union-only. All six checks are green again.

#### The one campaign-naming edge case worth knowing

`Kelly + Co + Nicole + BRIGHT` resolves to nobody because the client is
literally called **Kelly + Co** and the campaign convention splits on " + " —
so the prefix reads as "Kelly". It carries no leads today, so nothing is lost,
but a client whose name contains the separator will always defeat the parser.

### 6.4 Stripe — connected, and what it found

**Migration 0016 applied 27 September**, and 30 of 52 clients now carry their
Stripe customer and subscription on the master record. The mapping came from
the client's own sheet; the remaining 22 are set out below.

The design decision is vindicated by the data: **Discover Flag Team and
Discover Phx Team share one Stripe customer** (`cus_UlUNr2ybmnecR2`) and are
told apart only by their subscription. Storing the customer alone would have
made them indistinguishable.

**The rule, as given, and now LIVE** (27 Sep, deployment `5bb94e8c`,
`OS_STRIPE_BILLING_ENABLED=1`):

| Status set on the Clients screen | What happens to the subscription |
|---|---|
| paused · churned | **paused** — never cancelled, never deleted |
| active · onboarding · a new client | **resumed** |

It is the fifth leg of status propagation, and it runs **last** — the only one
that touches money, so every other system already reflects the new status by
the time it runs, and a Stripe outage costs the billing change alone rather
than stranding the propagation half-done.

`lib/clients/stripe-billing.ts` holds the rule and is pure; there is no code
path in it that can cancel anything, and a test asserts that as a property
rather than trusting it — every lifecycle against every subscription state,
checking that the only fields ever sent are `pause_collection` and
`pause_collection[behavior]`.

**NO BACKFILL, by instruction.** It fires on a status CHANGE and nothing sweeps
existing clients. Verified after enabling: zero subscriptions changed state.
The eight already-paused subscriptions — including the two on active clients —
are untouched and stay that way until someone moves that client's status.

It reads the subscription from Stripe before acting rather than trusting a
stored flag: it may have been paused or resumed in the dashboard since, and
acting on a stale idea of its state is how you resume something a person
deliberately stopped.

**To switch it off instantly:** set `OS_STRIPE_BILLING_ENABLED` to anything but
`1` on the `os` service. The leg then reports itself skipped and touches
nothing.

#### What the dry run found — two things worth acting on

Running the rule against all 52 clients would act on only **two**, and both
are resumes, not pauses. **No churned or paused client is currently being
billed**, which is better hygiene than expected.

But:

**1. Two ACTIVE clients are not being billed.**

| Client | Subscription | Amount |
|---|---|---|
| BHGRE Base Camp | `sub_1SmhS8…` | **$1,500** |
| Discover Phx Team | `sub_1Tsb2d…` | $500 |

Both are `active` in the OS with collection paused in Stripe. **Deliberately
not auto-resumed** — somebody may have paused them for a reason (a credit
period, a dispute), and starting to charge a customer is not a side effect a
status field should have.

**2. Five paused subscriptions are accruing invoices they will be billed for.**

Stripe offers three pause behaviours and this account uses all three, with no
consistent practice: `keep_as_draft` ×5, `void` ×2, `mark_uncollectible` ×1.

`keep_as_draft` **accrues a draft invoice for every period of the pause and
bills them all on resume.** So these clients return to a bill covering the
entire time they were paused:

| Client | Status | Paused since | Behaviour |
|---|---|---|---|
| Front Range Collective | paused | started Apr 2026 | `keep_as_draft` |
| Hunter Dehn Realty | paused | started Jun 2026 | `mark_uncollectible` |
| **JM Properties** | **churned** | started Jun 2026 | `keep_as_draft` |
| Simien Properties | paused | started Aug 2026 | `keep_as_draft` |
| Discover Flag Team | paused | started Jul 2026 | `keep_as_draft` |

JM Properties is the one to look at first: a **churned** client still accruing
draft invoices. New pauses this system makes use `void`, which issues nothing
for the paused period — but it does not retro-fix these.

#### The 22 clients with no subscription recorded

* **3 need your call** — more than one active subscription, so the sheet cannot
  decide: `54 Realty` (two active, two different customers), `Douglas Elliman
  Las Vegas` (the sheet lists both Elliman subscriptions as Las Vegas, and
  Douglas Elliman Los Angeles appears nowhere), `Raintown Realty` (two active,
  one labelled "(JPAR)" — and `JPAR Iron Horse Real Estate` is an active client
  with no subscription, so these may be two clients on one customer).
* **6 have only cancelled subscriptions** — Kelly + Co, Maltos Realty Group,
  Rise Real Estate Antelope, Spotlight - A Compass Team, The Karp Group,
  The RE Home Group of Douglas Realty.
* **13 are not in the sheet**, of which five are active: Cain Realty Group,
  Douglas Elliman Los Angeles, JPAR Iron Horse Real Estate, The Toll Group,
  The Wurst Team. Stripe customers exist by name for three of them, so the
  sheet is probably incomplete rather than those being unbilled.

One row in the sheet, **"A Better Way"**, has an active subscription and is not
a client on the roster at all.

### 6.5 Needs a decision from the client, then minutes of work

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

### 6.6 Needs the Database developer

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

### 6.7 Needs data entry, not engineering — the single biggest gap

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

### 6.8 Blocked on tools that do not exist

Commission Tracker (§1, §2, §8, §18) and future CRM / CSM. The architecture is
ready for them; §18's connection path is enforced in code.

### 6.9 Deliberately not done

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

### 7.6 Platform audit — 27 September

A full pass over the OS looking for gaps, dead ends and the class of bug a user
actually hits. Re-run these when something feels wrong.

| Check | Result |
|---|---|
| Nav destinations resolving to a real screen | **33 of 33** |
| Screens that exist but nothing imports | **none** |
| `fetch("/api/…")` calls resolving to a real route | **74 of 74** |
| §6 fields actually saved by the Edit dialog | **all six** |
| Dropdowns driven by a constant rather than a literal | all but one — see below |
| Env names referenced in code but unset in production | 8, **all deliberate or defaulted** |
| API routes | correct auth behaviour throughout |
| Typecheck · tests | clean · **1154 passing** |

**The one real bug, and its class.** The time zone field offered ten hard-coded
zones through a `<datalist>`, so typing "America/Toronto" showed nothing and
read as a broken filter — while SAVING that value worked, because the server
validates against the full IANA list. **UI offering less than the backend
accepts** is the class; it is worth grepping for `<datalist>` and `<option
value="` whenever a field "does not work". Every other dropdown in the client
dialogs maps over its exported constant (`PLANS`, `BILLING_INTERVALS`,
`CLIENT_STATUSES`) and therefore cannot drift.

**Two findings that are not bugs but are worth knowing:**

* **Two different `CanonicalClient` types** exist — `lib/clients/roster.ts` and
  `lib/clients/canonical.ts` — with different shapes. `overview.ts`, `links.ts`
  and `tool-index.ts` use the roster one. This is the duplicate-definition
  pattern that has caused real bugs here; worth collapsing.
* **`browserEnv` in `lib/tools/master-inbox/env.ts` is exported and consumed
  nowhere.** Its two non-null assertions are on variables that are unset in
  production, so it would throw if anything ever imported it. Dead today.

**Two lists that legitimately disagree.** The OS time zone field now offers
every IANA zone; Client Health's offers seven US zones with short labels (ET,
CT, MT…) because its timezone FILTER is bucketed by them. All 50 Client Health
rows use one of the seven, so the OS pins those seven to the top rather than
widening Client Health.

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

Four decisions. **Two are now answered and built**; two remain:

1. ~~What should pause and churn do to campaigns?~~ **Answered: pause, never
   delete.** Built.
2. ~~What should pause and churn do to billing?~~ **Answered and live**
   (27 Sep): pause the subscription, never cancel, so it can be reversed.
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
