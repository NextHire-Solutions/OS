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
| Plan | minimum / production / partner | ⚠️ `client_health.clients.plan` **and** `orch_clients.plan` | both | Client Health, Onboarding, OS | **No — can disagree** |
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
| Market / location | The market worked | ✅ `orch_clients.location` | Onboarding | Onboarding | No |
| MLS | MLS the leads come from | ✅ `orch_clients.mls` | Onboarding | Onboarding, Scraper | No |
| Area | Sub-area | ❌ not stored | — | — | — |
| Timezone | Client's timezone | ⚠️ `client_health.clients.time_zone` **and** `orch_clients.timezone` | both | Client Health, Onboarding | **No — can disagree** |

`client_mls` exists in the Database project and holds **0 rows** — it is not
the source of MLS despite its name.

---

## 5. People (spec §6, §21)

| Field | Definition | Source of truth | Who can edit | Tools that use it | Sync? |
|---|---|---|---|---|---|
| Salesperson | Who sold it | ✅ `orch_clients.salesperson_id` → `orch_salespeople` | Onboarding | Onboarding | No |
| Account Manager | Who runs it | ✅ `orch_clients.account_manager_id` | Onboarding | Onboarding | No |
| Sender | Sending identity | ✅ `orch_clients.sender_name` | Onboarding | Onboarding, campaigns | No |
| Team / Agents | The client's people | ✅ `orch_client_team` (11 rows) | Onboarding | Portal, Onboarding | No |
| **DNC list** | Who must not be contacted | ✅ `orch_client_team.is_dnc` | Onboarding | Portal, Database, campaigns | No |
| Introduction contacts | Who intros are addressed to (up to 3) | ✅ `os_clients.contact*` | OS | Master Inbox composer | No |
| Brokerage | Brokerage named in the intro | ✅ `os_clients.brokerage` | OS | Master Inbox composer | No |

**§5's worked example — *"change the Account Manager once → every tool
updates"* — is not possible today.** The Account Manager lives only in
`orch_clients`, and no other tool reads it.

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
| Campaign aliases | Name patterns that match | ⚠️ `client_health.campaign_aliases` **and** `analytics.clients.aliases` | both | matchers | No |
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

**Fields with a clear single owner:** 24
**Fields duplicated with no agreed winner:** 6 — `plan`, `timezone`,
`weekly_target`, Bison campaign ids, campaign aliases, client aliases
**Fields not stored anywhere:** 4 — area, first billing date, next billing
date, campaign→client mapping

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
