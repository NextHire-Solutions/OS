# Onboarding — parity checklist

**Source of truth:** `github.com/Outreachify/corofy-onboarding` @ `015a560`
("Stage colours everywhere; profile completion %; editable MLS", 2026-09-03),
cloned to `/Users/sankalpdutt/Desktop/Code/_os-sources/onboarding`. The Next.js
app is `orchestrator/`.

Note the org: **Outreachify**, not NextHire-Solutions. There is no onboarding
repo under NextHire-Solutions, which is why the earlier search found nothing.

The copy at `BrokerStaffer-SSO/apps/onboarding` is **not** stale — it is one
commit *ahead* of `015a560`, and that commit is a pure design-token swap. Every
logic file was diffed between the two trees: all of `lib/`, all of `app/` and
all 21 components are **byte-identical**; only `app/globals.css`,
`app/layout.tsx` and an added `lib/bs-auth.ts` shim differ.

**Database:** the `orch_*` half of the Supabase project Onboarding shares with
Agent Search. Live at the time of writing: 38 clients, 8 stages, 16 templates,
6 people, 356 introductions, 36,896 built leads.

Legend: ✅ ported and tested · 🔸 partial · ⬜️ not ported · ⛔️ stays on the
orchestrator by design

---

## The four screens the OS nav names

All four exist in the real product. **Nothing in the mockup is invented, so
there is nothing to propose for removal.** The gap runs the other way — see
"The client detail page" below.

### 1. Pipeline — `/onboarding` ✅ wired already

| Feature | Status | Note |
|---|---|---|
| Clients by stage, live from `orch_clients` | ✅ | pre-existing |
| Stage tiles / counts | ✅ | as clickable filter chips |
| Exception counts (stale, paid-not-live, live-unpaid, off-roster) | ✅ | the workspace's own framing, not the tool's |
| Search across name / office / contact / location | ✅ | |
| Sort (waiting, stage, name, created) | ✅ | tool uses click-to-sort headers |
| **Move a client between stages** | ✅ | **added this pass** — `PATCH /clients/:id` |
| Per-column filter boxes | ⬜️ | tool has one per column; workspace has a single search |
| Recent client replies panel (hide/show, remembered) | ⬜️ | reads `orch_email_replies`, 2 rows live |
| Per-client step progress ("7/14 done") | ⬜️ | needs `lib/step-state.ts`; only meaningful with the client page |
| Client and salesperson photos in the row | ⬜️ | stored in `photo_url`, editable on Settings, not yet shown here |

### 2. Stages — `/onboarding/stages` ✅ built this pass

| Feature | Status |
|---|---|
| List stages in board order, with client counts | ✅ |
| Add a stage (placed at the end, neutral colour) | ✅ |
| Rename in place (commit on blur) | ✅ |
| Recolour — the tool's five: neutral / blue / green / amber / red | ✅ |
| Reorder ↑ ↓ (sort-value swap with the neighbour) | ✅ |
| Delete, with the count of clients that will be unplaced | ✅ |
| Refuse to delete the last remaining stage | ✅ |
| Deleting never deletes clients (FK is ON DELETE SET NULL) | ✅ |
| Surfaces clients standing on **no** stage | ✅ *(added — the tool does not; 2 live)* |

### 3. Templates — `/onboarding/templates` ✅ built this pass

| Feature | Status |
|---|---|
| Three categories: automated emails, campaign copy, intro macro | ✅ |
| Expand / collapse an editor per template | ✅ |
| Edit name, subject (emails only) and body | ✅ |
| Add a template to a category | ✅ |
| Delete a template | ✅ |
| **Refuse to delete the 9 templates the automation sends by key** | ✅ both in the UI and server-side |
| Merge-field help | ✅ *(improved — lists the fields each template actually uses)* |
| Unsaved-changes indicator and cancel | ✅ *(added)* |

### 4. Settings — `/onboarding/settings` 🔸 built this pass, one panel read-only

| Panel | Status | Note |
|---|---|---|
| **Pipeline mode** — the automation master switch | ✅ | writes the real `orch_settings` row; turning it off really does stop the orchestrator |
| **Button names** — rename all 14 step buttons | ✅ | saves; blank restores the default |
| **Salespeople** — add / rename / email / photo / hide / restore / remove | ✅ | |
| **Account managers** — same, second role | ✅ | 0 on the roster today, so the empty state is what renders |
| Removing someone still assigned hides rather than deletes | ✅ | past assignments keep their name |
| **Health Dashboard** — stored counts, last sync, unmatched list | ✅ | |
| Health Dashboard — "Refresh now" | ✅ | runs the tool's own daily sync on demand; matched 33 of 38, 5 unmatched |
| **Email account** — mailbox, sends-as, reply tracking, connected-at | 🔸 | **read-only, and says so** |
| Email account — Connect / Disconnect / Poll replies | ⬜️ | see below |

**Why the mailbox is read-only.** Connecting is an OAuth round trip that ends at
a redirect URI registered with Google for the orchestrator's own domain. The
workspace is a different origin and holds no `GOOGLE_OAUTH_CLIENT_ID`, so a
Connect button here would open a consent screen Google then refuses. The panel
shows the live status and links out. Adding it properly needs a second OAuth
client and redirect URI registered for the workspace's domain — a decision, not
an oversight.

---

## The client detail page — the real gap

`/clients/[id]` and its three sub-pages exist in the product and appear nowhere
in the OS nav. This is the largest single piece of the tool that is not ported,
and it is where the day-to-day work happens.

| Page | Lines | What it holds |
|---|---|---|
| `/clients/[id]` | 253 | profile, custom fields, MLS picker, salesperson / account-manager / TAC assignment, **the 14 step buttons**, Stripe payment box, stage picker, team, agents, lead list, replies, delivery log |
| `/clients/[id]/team` | 50 | the people named on the intake form |
| `/clients/[id]/agents` | 75 | their agents from the database, with DNC |
| `/clients/[id]/leads` | 85 | the built lead list for human review |

**My recommendation: yes, add it — as `onboarding:client`, a detail route under
the pipeline rather than a fifth nav item.** Three reasons:

1. **Settings already depends on it.** The "Button names" panel renames buttons
   that exist nowhere in the workspace. It saves correctly and the live tool
   reads it, but until this page exists the panel edits something you cannot
   see. The screen says so, in an `.anno` ribbon.
2. **The pipeline dead-ends.** Every row is a client you can now move between
   stages but cannot open. Master Inbox already set the pattern for a detail
   route under a list (`/inbox/portals/:id`).
3. **It is what "switch the tool off" requires.** Onboarding cannot be retired
   while the only way to send a welcome email or build a lead list is the old
   app.

**But it is a much bigger job than these three screens, and not a safe one.**
The 14 step actions call EmailBison, Stripe, Gmail and the Client Portal with
hub tokens the workspace does not hold, and several are irreversible in a way
nothing here has been — `campaign:launch` starts sending real email to real
agents. `lib/tools/onboarding/steps.ts` is ported and tested so the catalogue is
ready, but I have deliberately built **no route that can fire one**. That wants
its own task, its own credentials in `.env.local`, and a decision about whether
the workspace fires them itself or calls the orchestrator's endpoint the way the
Client Health sync button does.

---

## Stays on the orchestrator — do not move ⛔️

The tool's 10 API routes are all inbound or scheduled, and every one must keep
answering on its current URL:

| Route | Why |
|---|---|
| `/api/webhooks/typeform` | new client intake |
| `/api/webhooks/stripe` | payment confirmation |
| `/api/webhooks/bison` | campaign + lead import status |
| `/api/webhooks/calendly` | onboarding call booking |
| `/api/webhooks/masterinbox` | introduction events |
| `/api/cron/poll-replies` | Gmail reply polling |
| `/api/cron/health-status` | the daily Health Dashboard pull |
| `/api/cron/check-bison-imports` | lead import watcher |
| `/api/auth/google` + `/callback` | the OAuth pair above |

The workspace adds screens over the rows these produce. It takes over no
delivery.

---

## What was built, file by file

**Logic** — `src/lib/tools/onboarding/`

| File | From | Notes |
|---|---|---|
| `db.ts` | `lib/supabase.ts` | the tool's read-only guard, ported: writes outside `orch_*` throw before the network call |
| `write-guard.ts` | ″ | the guard's pure half, so it can be tested |
| `stages.ts` | `lib/stages.ts` + `app/stage-actions.ts` | |
| `stage-types.ts` | `lib/stage-types.ts` | tints remapped to workspace tokens |
| `templates.ts` | `lib/templates.ts` + 3 actions | |
| `template-types.ts` | ″ | merge-field renderer, verbatim |
| `settings.ts` | `lib/settings.ts` | including its 10s cache, which writes invalidate |
| `settings-pure.ts` | ″ | the blank-caption rule, testable |
| `settings-view.ts` | `app/settings/page.tsx` | the five panels as one JSON read |
| `people.ts` / `people-types.ts` | `lib/people.ts` + `app/people-actions.ts` | |
| `steps.ts` | `lib/steps.ts` | verbatim; not yet rendered anywhere |
| `health.ts` / `health-match.ts` | `lib/health-status.ts` | reads the dashboard through the workspace's own `CLIENT_HEALTH_*` credentials |
| `pipeline.ts` | — | pre-existing, unchanged |

**API** — `src/app/api/tools/onboarding/` — 8 new route files, 17 handlers:
`stages` (GET, POST), `stages/[id]` (PATCH, DELETE), `templates` (GET, POST),
`templates/[id]` (PATCH, DELETE), `settings` (GET, PATCH), `people` (POST),
`people/[id]` (PATCH, DELETE), `health` (POST), `clients/[id]` (PATCH).

None gates on a session the workspace does not have. Everything under
`/api/tools/*` is already behind the HMAC cookie checked in `src/proxy.ts`;
these routes add zod validation and nothing else.

**Screens** — `src/components/screens/onboarding/`: `stages.tsx`,
`templates.tsx`, `settings.tsx` (new), `pipeline.tsx` (stage column made a
control), plus `actions.ts`, `toast.tsx`, `photo-input.tsx`.

Built from `src/app/workspace.css`'s own classes — `.wrap`, `.cards`/`.card`,
`.tbl-wrap`/`.tbl-head`/`.tbl-scroll`, `.inp`, `.btn`/`.btn-pri`, `.badge` with
`.s-done`/`.s-pending`/`.s-risk`/`.s-ok`, `.anno`, `.tg`, `.tnum`, `.cname`,
`.csince`, `.api-none`, `.mut`. No Tailwind component was imported from the
tool.

---

## Two things worth changing that are not mine to change

**1. `.portal-fingerprint.json` is committed and contains 57 live portal
tokens.** This repository is public. `…/portal/<slug>-<token>` is the credential
for a client's portal, not just its address. `scripts/onboarding-fingerprint.mjs`
therefore stores a SHA-256 prefix of `portal_url` instead of the URL; the
existing file has no such protection.

**2. `window.confirm` does not survive into the workspace.** The tool guards
every destructive action with it. A native dialog suspends the page in a way no
CDP-driven check can answer, so a `confirm()`-guarded button is a button no test
can prove works. These screens use a two-click arm-then-fire button that carries
the tool's own warning text in `title` and in the armed caption. Same
protection, and the test drives it.
