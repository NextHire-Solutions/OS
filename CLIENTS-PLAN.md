# One Clients page — plan

## 0. Decisions taken (2026-09-12)

1. **The roster is exactly 36 names** — supplied by the business and verified
   character-for-character against `src/lib/clients/roster.ts`. It is already
   correct; nothing is added. The ~9 "apparently real" unmatched Master Inbox
   rows are therefore *not* active clients.
2. **Onboarding in the OS creates the portal immediately**, because that is what
   Master Inbox does today and the OS must behave identically.
3. **Nothing is ever deleted.** `status` is a mutable field — `active`,
   `paused`, `churned` — changeable at any time from the Clients page. No
   destructive path exists anywhere in this design.
4. **A new client does NOT enter the Onboarding pipeline.** The flow runs the
   other way: when a client is onboarded in the **Onboarding tool**, it must
   appear in the OS clients list.
5. **No live tool is modified.** Not its code, not its schema, not its
   deployment. The OS only ever calls each tool's *existing public API* — the
   same endpoints the Onboarding tool already calls today.

---

## 1. What each tool actually does when a client is onboarded

This is the whole point of the exercise: the OS must reproduce these exactly.
Every line below was read from the live tools' source.

### Master Inbox — `POST /api/clients`

Auth: `x-admin-token` equal to Master Inbox's `SUPABASE_SERVICE_ROLE_KEY`, or a
signed-in staff session. The OS already holds that key.

| Field | Required | Notes |
|---|---|---|
| `name` | **yes** | trimmed, 1–80 chars |
| `aliases[]` | no | max 20, each ≤120 |
| `intro_macro` | no | `{brokerage, client_full_name, client_first_name, client_role}` — all four required if present |

**Eight things happen automatically on insert:**

1. `slug` derived from the name (`&`→`and`, non-alphanumerics→`-`, ≤60 chars)
2. **`portal_token = "<slug>-<10 random hex>"` — the portal is live instantly**
3. `portal_enabled = true`
4. `feature_flags = { manage_stages, pipeline_kanban_view, pipeline_board_enhanced }`, all true
5. the derived-client cache is invalidated
6. **`retagUnknownThreads()`** — every thread currently tagged *Unknown* whose
   `campaign_name` matches the new name or any alias is re-tagged to this client
7. **`ensureListForClient()`** — a `lists` sidebar row (`shared: true`,
   `sort_order` = max+1). Idempotent via a partial unique index
8. if `intro_macro` was sent — a `reply_templates` row named
   `Intro Macro - <name>`, `category` = the client name, body rendered from a
   fixed template with `{{lead.*}}` / `{{sender.name}}` left for the composer

Duplicate → **409**. Steps 6–8 are wrapped so a template failure never rolls
back the committed client.

### Client Health — `POST /api/clients/onboard`

Auth: `x-admin-token` = `ONBOARDING_TOKEN`. This is a public path in Client
Health's middleware, gated by that token alone.

| Field | Required | Notes |
|---|---|---|
| `name` | **yes** | trimmed, non-empty |
| `plan` | **yes** | `minimum` \| `production` \| `partner` |
| `weekly_target` | **yes** | integer ≥ 0 |
| `start_date` | no | `YYYY-MM-DD` |
| `billing_anchor_date` | no | `YYYY-MM-DD` |
| `billing_interval` | no | `biweekly` (default) \| `28-days` \| `monthly` \| `custom` |
| `billing_interval_days` | conditional | **required** when interval is `custom` |

On insert it **auto-links Instantly and EmailBison campaigns** by normalised
name-substring (`&`→`and`, punctuation stripped), plus the `MANUAL_LINKS`
overrides — today only `Howe Realty Group → "howe realty"`. Case-insensitive
duplicate-name guard → **409** with `existing_id`.

> **Use `/onboard`, not the plain `POST /api/clients`.** The plain route has no
> validation and — critically — **does not auto-link campaigns**. A client
> created through it looks fine and silently reports zero sends.
> `CLIENT_HEALTH_READ_TOKEN` is refused for writes by design (403).

### Analytics — `POST /api/clients`

| Field | Required | Notes |
|---|---|---|
| `name` | **yes** | 1–200 |
| `aliases[]` | no | max 20 |
| `matchMode` | no | `contains` (default) \| `prefix` \| `exact` |

Writes `team_id` (from `ANALYTICS_TEAM_ID`), `name`, `slug`, `aliases`,
`match_mode`. **No side effects at create.** Campaign attribution is done by the
sync job, which writes `campaign_clients` / `instantly_campaign_clients` using
the token-run matcher (whole token runs, longest match wins, ties flagged
ambiguous rather than guessed). So a new client picks up its campaigns **at the
next sync**, not at create. Duplicate → 409.

### Onboarding — `orch_clients`

Created by the **Typeform webhook**, upserted on `typeform_response_id` so
Typeform's retries are idempotent. The row: `status: "new"`, `client_name`,
`brand` and `office_name` both defaulted to the client name (for DNC
exact-exclude), `primary_contact {name, email, phone, role}`, `mls` (stored as
the MLS *code*), `location`, `timezone: null`, `filters {sales_volume_min/max,
closed_transactions_min/max}`, `sender_name: null`, `raw_typeform`.

On first intake only: salesperson auto-assigned from the referral answer, and a
Slack post to `#corofy_onboarding`.

**Its downstream pushes are triggered by hand from its UI** — `lib/connectors/apps.ts`:

| Push | Target | Body |
|---|---|---|
| `pushToClientPortal` | Master Inbox `POST /api/clients` | `name`, `aliases: ["<Client> + <Salesperson> + <MLS or Location>"]`, `intro_macro` (role falls back to the intake contact's, then `"Team Leader"`); writes `portal_url`/`portal_token` back onto `orch_clients` |
| `pushToHealthDash` | Client Health `POST /api/clients/onboard` | `name`, `plan` default **`production`**, `weekly_target` default **3**, `start_date` = created_at |
| `pushTeamToPortal` | portal `/team`, `/agents`, `/dnc` | needs `portal_token` first; de-duplicates by name against past deliveries |
| `buildBisonCampaign` | EmailBison | campaign `"<Client> + Nicole + <MLS or Location>"` — **spends real money and emails real agents** |

Every push is logged to `orch_connector_deliveries` with request, response and
error, which is what makes re-runs safe.

### The gap this explains

**There is no Analytics connector in the Onboarding tool.** Analytics clients
are created by hand, which is a direct cause of the 50-vs-36 drift. The OS
closes that gap by making Analytics one of the four legs.

---

## 2. What the OS will do

**Onboarding a client in the OS runs exactly the four writes above, in this
order — cheapest to undo first:**

1. `os_clients` — local row, fully reversible
2. **Analytics** — a row and aliases, no side effects
3. **Client Health** — `/api/clients/onboard`, so campaign auto-linking happens
4. **Master Inbox last** — because it mints the live, login-free portal token

Master Inbox is last on purpose. If any earlier leg fails the client has no
customer-facing URL yet and the whole thing can be retried without a wrong link
ever reaching anyone.

**Defaults match the Onboarding tool's** so the OS and the existing push agree:
`plan = production`, `weekly_target = 3`, `billing_interval = biweekly`,
`matchMode = contains`, `start_date` = today.

**The form's mandatory set is the union of what the tools demand:** name, plan,
weekly target. Everything else — aliases, intro macro, billing anchor, MLS,
location — is optional and editable afterwards.

**Automations stay off.** No Bison campaign, no welcome email, no copy request.
Creating the record and running the playbook are different acts, and
`campaign:launch` emails hundreds of real agents.

**Onboarding is a resumable job, not a request.** A row in
`os_client_onboarding` records each leg as pending → done → failed with the
tool's returned id. A failed leg retries alone; a succeeded leg never repeats.
This is what makes partial failure across four databases survivable — no
transaction spans them.

**Identity lives in `os_clients`, in the Master Inbox project** — not a new
database, because Master Inbox already holds the portal tokens, the one piece of
client data that is externally visible and must never be regenerated. Columns:
canonical name, slug, aliases[], **status**, created_at, and one link column per
tool (`mi_client_id`, `ch_client_id`, `an_client_id`, `orch_client_id`). The
code roster seeds it once, then stays as a fallback.

**Inbound from Onboarding.** The Clients page reads `orch_clients` and shows any
client that exists there but not in `os_clients` as *Awaiting adoption*, with the
portal token it already has. Adopting it creates the `os_clients` row and fills
whichever legs are still missing. Read-only until you press the button.

---

## 3. What is needed before the write legs can run

Three credentials the OS does not yet hold. All are already set on the live
tools; they need copying into the OS service, exactly as the Analytics
integration vars were:

- `CLIENT_HEALTH_ONBOARDING_TOKEN` — from Client Health's Railway env
- `ANALYTICS_TEAM_ID` — already present ✓
- `MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY` — already present ✓

So in practice: **one token to copy.**

---

## 4. Phases

| Phase | What | Risk |
|---|---|---|
| 0 | Reconcile all four databases against the roster — report only | none — **done** |
| 1 | `os_clients` seeded from the roster; Clients page reads it; status editable | low |
| 2 | Link columns filled by matching; page shows which tools each client is in, and which are missing | low |
| 3 | Onboard flow **dry-run only** — shows the exact body it would POST to each tool | none |
| 4 | Onboard for real, one leg at a time behind a flag, Master Inbox last | medium |
| 5 | Adopt-from-Onboarding | low |
| 6 | Edits flow outward (rename, plan, aliases) | high — defer |

---

## 5. Phase 0 result (read-only, already run)

Every row in all four databases matched against the roster's names and aliases.
Nothing was written.

| Tool | Rows | Matched | Unmatched |
|---|---|---|---|
| Master Inbox | 58 | 38 | 20 |
| Client Health | 48 | 36 | 12 |
| Analytics | 50 | 37 | 13 |
| Onboarding | 39 | 24 | 15 |

The 20 unmatched Master Inbox rows: **2 deliberate fixtures** (`Test FUB`,
`Demo Portal` — the latter backs a live demo portal and is never touched),
**~9 churned** (`portal_enabled = false`, no recent threads), **~9 others** now
confirmed not to be active clients. All keep their rows; status is a field.

**Onboarding's 15 are mostly alias variants, not missing clients** — `Howe
Realty`, `Norvell & Co`, `Camelot Realty`, and a truncated `The RE Home Group of
Douglas Re`. That is a roster-aliases fix. Separately, **12 roster clients have
no `orch_clients` row at all**, which is the genuine gap.

One leftover test fixture (`ZZ Onboarding UI Audit …`) and its child rows were
removed. No other row was modified.

---

## 5b. Phase 2 result — the link matrix (read-only, verified 2026-09-12)

`scripts/client-links.mjs` resolves all 36 canonical clients against all four
databases and reports the row id in each. It writes nothing. This is exactly
what would be stored in the link columns on `os_clients`.

| Tool | Linked | Missing |
|---|---|---|
| Master Inbox | **36 / 36** | — |
| Client Health | **36 / 36** | — |
| Analytics | 35 / 36 | JPAR Iron Horse Real Estate |
| Onboarding | 28 / 36 | 8 |

**JPAR Iron Horse Real Estate is genuinely absent from Analytics** — a search of
that table for `jpar` or `iron` returns nothing at all. It is a real client
whose campaigns therefore have no client to attribute to. This is the first
concrete thing the unified onboarding fixes.

Five of the twelve originally "missing from Onboarding" turned out to be
spelling variants, and were added to the roster's aliases after being observed
in the tool's own data — the bar `roster.ts` sets:

| Onboarding spells it | Roster name |
|---|---|
| `Camelot Realty` | Camelot Realty Group |
| `Howe Realty` | Howe Realty Group |
| `Norvell & Co` | Norvell&Co Real Estate |
| `REMAX Pacific` | RE/MAX Pacific |
| `The RE Home Group of Douglas Re` | The RE Home Group of Douglas Realty |

`Howe Realty` is not a guess: Client Health's own `MANUAL_LINKS` already maps
`Howe Realty Group → "howe realty"`.

**One left for a human.** Onboarding has `Momentum Lux Realty`; the roster has
`Momentum Realty`. Those may be the same business or two different ones, and
the roster's own rule is that a guessed alias silently merges two clients —
worse than the mismatch it would fix. Flagged, not decided.

Matching is exact-on-normalised-name plus declared aliases, never fuzzy, and
**exact name beats alias**. That last rule is what keeps `SERHANT. PA` and
`SERHANT. PA 15M+` apart — both rows exist, the roster names the second as an
alias of the first, and a single-pass match found two rows and gave up.

Two Master Inbox rows are deliberately left unclaimed for the same reason:
`Properties & Estates Florida` and `SERHANT. PA 15M+` are separate rows with
their own portal tokens. Reporting them as unclaimed is honest; folding them
into another client's single link column would not be.

### A latent bug found on the way

`src/lib/clients/canonical.ts` filtered `clients` by `workspace_id`. Master
Inbox's `clients` is a **global catalog with no such column**, so every call
threw `42703` and the module reported the entire client list as unavailable. It
had no callers, which is the only reason nothing broke. Fixed rather than left
as a trap.

## 6. Safety rules, binding

- No live tool's code, schema or deployment is touched. The OS calls their
  existing public APIs only.
- No client row is ever deleted, in any database, by any code path here.
- No existing `portal_token` is read-modified or regenerated. Portal URLs for
  current clients stay byte-identical.
- `Demo Portal` is protected by name and never included in any bulk operation.
- Every write leg is idempotent and logged before it is retried.
- `scripts/portal-fingerprint.mjs` runs before and after every deploy that
  touches this code, and must report every portal URL identical, no client
  removed, no table shrunk.
