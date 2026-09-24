# Master Client Data Dictionary

What the architecture spec asks for in §15, and the gate it sets:

> Before this architecture is considered complete, we should create a master
> data dictionary. For every field, we should document: **Field · Definition ·
> Source of Truth · Who Can Edit · Tools That Use It · Sync Required?**
>
> This will force us to answer the most important question: **Who owns this
> piece of data?** If we cannot answer that question, we should not have the
> same field independently editable in multiple systems.

Every row below was read from the live schema on **2026-09-24**, not from
memory or from the spec's wish-list. Where a field is held in two places, it
says so — that is the finding, not an oversight.

**Source of truth** means where the value is *decided*. A tool that holds a
copy is a consumer, however authoritative its table looks.

Legend: **✅ single owner** · **⚠️ duplicated, no agreed winner** · **❌ not
stored anywhere**

---

## The four systems

| Short name | Supabase project | Holds |
|---|---|---|
| **OS** | `dukbece…` (Optimised Master Inbox) | `os_clients`, `os_client_status_history`, `os_client_tool_exceptions` |
| **Master Inbox** | `dukbece…` (same project) | `clients` — one row per **portal** |
| **Client Health** | `fjmxbhc…` | `clients` — the billed roster |
| **Analytics** | `eiecpee…` | `clients` — campaign attribution |
| **Onboarding / Scraper / Database** | `wiybrte…` | `orch_clients`, `orch_client_team`, `agents` (1.18M), lead tables, `saved_lists` |

---

## 1. Identity

| Field | Definition | Source of truth | Who can edit | Tools that use it | Sync? |
|---|---|---|---|---|---|
| Client ID | The canonical id for a client | ✅ `os_clients.id` | OS only | None yet — **every tool still joins by name** | n/a |
| Client name | The name the business uses | ✅ `os_clients.name` | OS | All | **Yes** — the join key |
| Slug | URL-safe name | ✅ `os_clients.slug` | OS | Master Inbox (prefixes the portal token at creation) | No |
| Aliases | Other spellings a tool uses | ⚠️ `os_clients.aliases`, `analytics.clients.aliases`, `client_health.campaign_aliases` | each tool | matchers in all three | Not synced |
| Status | onboarding / active / paused / churned | ✅ `os_clients.status` | **OS** | Client Health, Analytics, Master Inbox, portal | **Yes — live** |
| Tool links | Which row is this client in each tool | ✅ `os_clients.{mi,ch,an,orch}_client_id` | OS | Consistency screen | No |

**The gap that matters:** §14.2 asks for *"one unique Client ID"*. It exists —
but no tool references it. They all still match on normalised name, which is
why `Douglas Elliman LA` and `Douglas Elliman Los Angeles` silently failed to
join for months.

---

## 2. Lifecycle dates (spec §12)

| Field | Definition | Source of truth | Who can edit | Tools that use it | Sync? |
|---|---|---|---|---|---|
| Date added | When the client record was created | ✅ `os_clients.created_at` | system | OS | No |
| Onboarding date | When onboarding began | ✅ `orch_clients.onboarding_date` | Onboarding | Onboarding | No |
| Start date | When service began | ✅ `client_health.clients.start_date` | Client Health, OS | Client Health | No |
| **Pause date** | When it was paused | ✅ `os_client_status_history` | trigger — nobody | **nothing reads it yet** | n/a |
| **Churn date** | When it churned | ✅ `os_client_status_history` | trigger | **nothing reads it yet** | n/a |
| **Reactivation date** | When it came back | ✅ `os_client_status_history` | trigger | **nothing reads it yet** | n/a |

The last three were impossible before migration 0012 — a churn was a flag with
no date. They are now recorded automatically for every change. **Nothing
displays them**, which is the smallest remaining piece of §12.

---

## 3. Billing (spec §12)

| Field | Definition | Source of truth | Who can edit | Tools that use it | Sync? |
|---|---|---|---|---|---|
| Plan | minimum / production / partner | ✅ **`client_health.clients.plan`** — settled by measurement, see below | Client Health, OS | Client Health, OS | No |
| Billing anchor date | Cycle start | ✅ `client_health.clients.billing_anchor_date` | Client Health, OS | Client Health | No |
| Billing interval | biweekly / 28-days / monthly / custom | ✅ `client_health.clients.billing_interval` | Client Health, OS | Client Health | No |
| Interval days | Custom cycle length | ✅ `client_health.clients.billing_interval_days` | Client Health, OS | Client Health | No |
| First billing date | First charge | ❌ not stored | — | — | — |
| Next billing date | Next charge | ❌ derived at render, never stored | — | Client Health | — |
| Stripe customer | Stripe link | ✅ `orch_clients.stripe_customer_id` | Onboarding | Onboarding | No |
| Stripe payment | Amount, paid, paid-at, link | ✅ `orch_clients.stripe_*` | Onboarding | Onboarding | No |

**§22 requires "Stripe is connected to the correct client record".** Today
Stripe is connected to `orch_clients`, not to the master record, and only for
clients that came through Typeform intake.

---

## 4. Market

| Field | Definition | Source of truth | Who can edit | Tools that use it | Sync? |
|---|---|---|---|---|---|
| Market / location | The market worked | ❌ **effectively unstored** — `orch_clients.location` is set on **2 of 46** | Onboarding | Onboarding | No |
| MLS | MLS the leads come from | ❌ **effectively unstored** — `orch_clients.mls` is set on **2 of 46** | Onboarding | Onboarding, Scraper | No |
| Area | Sub-area | ❌ not stored | — | — | — |
| Timezone | Client's timezone | ✅ **`client_health.clients.time_zone`** (47 of 50 set; `orch_clients.timezone` is set on **0** of 46) | Client Health | Client Health | No |

`client_mls` exists in the Database project and holds **0 rows** — it is not
the source of MLS despite its name.

---

## 5. People (spec §6, §21)

| Field | Definition | Source of truth | Who can edit | Tools that use it | Sync? |
|---|---|---|---|---|---|
| Team | The client's people | ✅ **`master_inbox.client_team_members`** — 97 rows across **48 clients** | Master Inbox | Portal | No |
| Agents | The client's agents | ✅ **`master_inbox.client_agents`** — 11,324 rows across **47 clients** | Master Inbox | Portal | No |
| **DNC list** | Who must not be contacted | ✅ **`master_inbox.client_dnc_entries`** — 14,994 rows across **36 clients**, and it pushes to EmailBison and Instantly | Master Inbox | Portal, campaigns | Yes — pushed to both senders |
| Salesperson | Who sold it | ⚠️ `orch_clients.salesperson_id` — set on **4 of 46** | Onboarding | Onboarding | No |
| Account Manager | Who runs it | ❌ **`orch_clients.account_manager_id` is set on 0 of 46** | — | — | — |
| Sender | Sending identity | ⚠️ `orch_clients.sender_name` — set on **1 of 46** | Onboarding | Onboarding, campaigns | No |
| Introduction contacts | Who intros are addressed to (up to 3) | ✅ `os_clients.contact*` | OS | Master Inbox composer | No |
| Brokerage | Brokerage named in the intro | ✅ `os_clients.brokerage` | OS | Master Inbox composer | No |

### Corrected 2026-09-24 — Team, Agents and DNC are Master Inbox's

The first version of this file put all three in `orch_client_team`, on the
strength of that table existing and having the right column names. Counting
the rows settles it: `orch_client_team` holds **11 rows across 1 client**,
while Master Inbox holds **14,994 DNC entries, 11,324 agents and 97 team
members across 36–48 clients each**.

That is the right home, not an accident of history: the Client Portal is
served by Master Inbox and §8 says the portal should focus on "Client/team,
Agents, DNC list". The data sits where the screen that shows it lives. The DNC
table also pushes each entry to EmailBison and Instantly, so it is operational
rather than a record.

**§5's worked example cannot be built, and not for the reason assumed.**
*"Change the Account Manager once → every tool updates"* is not blocked by
architecture — **no client has an Account Manager at all** (0 of 46).
Salesperson is set for 4 of 46 and Sender for 1 of 46. There is nothing to
centralise until somebody records it, and a master column for an empty field
would be a pipe with no water.

---

## 6. Portal

| Field | Definition | Source of truth | Who can edit | Tools that use it | Sync? |
|---|---|---|---|---|---|
| Portal token | The live, login-free URL | ✅ **`master_inbox.clients.portal_token`** | minted once at creation, never edited | Portal | Copy in `orch_clients.portal_token` (1 row, verified identical) |
| Portal on/off | Whether it opens | ✅ `master_inbox.clients.portal_enabled` | reconcile job, from status | Portal | **Yes — follows status** |
| `portal_active` | A second Client Health flag | ⚠️ `client_health.clients.portal_active` | Client Health | unclear | **Not connected to the above** |

Two independent portal flags exist. `portal_enabled` is the real kill switch;
what `portal_active` is for needs settling.

---

## 7. Campaigns

| Field | Definition | Source of truth | Who can edit | Tools that use it | Sync? |
|---|---|---|---|---|---|
| Campaign ids (Instantly) | Linked campaigns | ✅ `client_health.clients.instantly_campaign_ids` | Client Health | Client Health, Analytics | No |
| Campaign ids (Bison) | Linked campaigns | ⚠️ `client_health.clients.bison_campaign_ids` **and** `orch_clients.bison_campaign_id` | both | both | **No** |
| Campaign aliases | Name patterns that match | ✅ **`analytics.clients.aliases`** (15 of 54 set; `client_health.campaign_aliases` is set on **1** of 50) | Analytics | matchers | No |
| Campaign → client | Which client a campaign belongs to | ❌ **inferred from the campaign NAME** | — | Master Inbox, Analytics | — |

**This is the one Eddy asked to be fixed.** `lib/clients/derive.ts` scores a
campaign name against every client name and alias. It is why 92 Florida
threads sit in the Boston portal.

---

## 8. Operational data

| Field | Source of truth | Note |
|---|---|---|
| Leads | ✅ `bison_client_leads` (374k), `instantly_client_leads` (40k), `orch_client_leads` (37k) | all keyed by **`orch_clients.id`**, not the master id |
| Agent database | ✅ `agents` (1,180,788) | the scraper's |
| Saved views | ✅ `saved_lists` (50) | roughly one per client, by name |
| Replies / bounces | ✅ the lead tables + Analytics | |
| Introductions | ✅ Master Inbox | Client Health holds counters |

---

## 9. Performance counters

Every one of these is **derived and written by a sync job**, not edited by a
person: `intros_this_month`, `intros_since_last_billing`,
`total_intros_corofy`, `total_interested_corofy`, `emails_today`,
`agents_count`, `dnc_count`, `stagnant_intros_count`,
`last_lead_activity_at`, `campaign_size` — all in `client_health.clients`.

They need no source-of-truth debate: the job owns them. They are listed so
nobody adds them to the master record by mistake.

---

## What this dictionary establishes

**Fields with a clear single owner:** 30
**Fields genuinely contested:** 1 — Bison campaign ids
**Fields not stored anywhere, or barely:** 9 — area, first billing date, next
billing date, campaign→client mapping, **market/location** (2 of 46), **MLS**
(2 of 46), **Account Manager** (0 of 46), **Salesperson** (4 of 46), **Sender**
(1 of 46)

### The pattern this exercise kept finding

Three times, a field the spec treats as "duplicated across tools and needing a
single owner" turned out not to be contested at all. Each time the answer came
from counting rows rather than from deciding:

| Assumed | Actually |
|---|---|
| plan, weekly_target, timezone duplicated | the Onboarding copies are frozen intake defaults — `production`, `3`, and empty — never updated |
| campaign aliases duplicated | Client Health has 1 of 50, Analytics 15 of 54 |
| Team / Agents / DNC live in Onboarding | Master Inbox holds 26,000+ rows of them; Onboarding holds 11 across 1 client |

The general lesson for the rest of this work: **a column existing is not
evidence that it is used.** Before centralising any field, count how many
clients actually have a value. Twice now the answer has been "almost none",
and building a master record around an empty column would have moved nothing
while looking like progress.

### The duplication was mostly an illusion — measured 2026-09-24

The first version of this file listed six fields as "duplicated with no agreed
winner". Comparing the actual values settled four of them, and the answer was
not a judgement call:

| Field | What the data says |
|---|---|
| **plan** | `orch_clients.plan` is `'production'` for **all 46 rows**. Client Health has real variation (29 production / 7 partner / 14 minimum). The Onboarding column is an intake default nobody ever updates — **Client Health owns it.** |
| **weekly_target** | `orch_clients.weekly_target` is `3` for **all 46 rows**. Client Health ranges 1–4. Same story — **Client Health owns it.** |
| **timezone** | `orch_clients.timezone` is set on **0 of 46**. Client Health has 47 of 50. Never contested — **Client Health owns it.** |
| **campaign aliases** | `client_health.campaign_aliases` is set on **1 of 50**; Analytics has 15 of 54. **Analytics owns it.** |

That is §15 doing exactly what it was written to do: the question "who owns
this?" had an answer in the data, and four of the six needed no decision at
all. What looked like six conflicting fields was two systems, one of which
stopped writing four of them years ago.

**But the measurement found something worse.** `plan` and `weekly_target`
appear to disagree for 20 and 38 clients respectively — and anyone comparing
those two tables without knowing the Onboarding side is a frozen default would
conclude the business has 38 clients on the wrong target. The columns are not
merely redundant; they are actively misleading, and the right fix is to stop
writing them rather than to reconcile them.

**And MLS and market are essentially not recorded.** §6 lists both as master
client data and §8 puts MLS at the centre of the Database view, but
`orch_clients` carries them for **2 of 46** clients. This is not a
synchronisation problem to solve — it is data the business believes it has and
does not.

The spec's rule in §15 is that *"if we cannot answer who owns this, we should
not have the same field independently editable in multiple systems."* Six
fields fail that test today, and every one of them is editable in two places.

**Suggested owners, for the six:**

| Field | Proposed owner | Why |
|---|---|---|
| Plan | Client Health | it bills on it |
| Weekly / monthly target | Client Health | it measures against it |
| Timezone | **Master record (OS)** | Health, campaigns and Analytics all need it |
| Bison campaign ids | Client Health | already the fuller list |
| Campaign aliases | **Master record (OS)** | the matchers in three tools read it |
| Client aliases | **Master record (OS)** | already there; the copies should follow |

These are proposals, not decisions. §15 exists to force the decision, and the
decision is the business's.
