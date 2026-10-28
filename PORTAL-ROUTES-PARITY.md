# Portal write routes in the OS — what was built, and what it is allowed to touch

The staff drill-down at `/inbox/portals/<clientId>` renders the tool's own
`PipelineBoard`. Every control on that board posts to
`/api/tools/master-inbox/portal/<token>/…`. There was no `[token]` segment
anywhere under `src/app/api/tools/master-inbox/`, so every one of those writes
404'd: staff could read a client's pipeline and change nothing.

This adds the nine endpoint families the board actually calls.

## The constraint that shaped every decision

`portal.brokerstaffer.com` serves **47 live client portals** out of the same
tables these routes write to. Customers open them with no login. A bad write is
visible to a paying customer within seconds and there is no undo.

So the routes are **copied from the tool, not designed here**. Behaviour that
gets re-decided is behaviour that can diverge from what a customer already sees
on their screen.

## What was built

Source: `/Users/sankalpdutt/Desktop/Code/Corofy/Master Inbox/app/api/portal/[token]/**`
(read-only; proven against those 47 portals every day).

| family | verbs | source file | what it writes |
|---|---|---|---|
| `/pipeline` | POST, PATCH | `pipeline/route.ts` | creates an entry; bulk delete / stage / assign |
| `/pipeline/[id]` | PATCH, DELETE | `pipeline/[id]/route.ts` | one entry's columns + `custom_fields_overrides` |
| `/pipeline/[id]/notes` | POST | `pipeline/[id]/notes/route.ts` | appends a `client_pipeline_notes` row |
| `/pipeline/[id]/notes/[noteId]` | PATCH, DELETE | `…/notes/[noteId]/route.ts` | edits / removes one note |
| `/pipeline/[id]/push-fub` | POST | `…/push-fub/route.ts` | Follow Up Boss push (writes `fub_*` columns) |
| `/pipeline/csv` | POST | `pipeline/csv/route.ts` | bulk insert from a CSV |
| `/stages` | PATCH | `stages/route.ts` | the `client_pipeline_stages` overlay |
| `/stage-labels` | PATCH | `stage-labels/route.ts` | `clients.stage_label_overrides` |
| `/conversation/[entryId]` | GET | `conversation/[entryId]/route.ts` | nothing — read-only |

All nine are **byte-identical to the tool's files apart from import paths**,
verified mechanically:

```
diff <source> <copy> | grep -v '^[<>] import ' | grep -v '^[<>] } from '   →  empty
```

Import rewiring is the same mapping the rest of this port uses:

| the tool imports | it gets here |
|---|---|
| `@/lib/portals/*` | `@/lib/tools/master-inbox/portals/*` |
| `@/lib/webhooks/*` | `@/lib/tools/master-inbox/webhooks/*` |
| `@/lib/integrations/*` | `@/lib/tools/master-inbox/integrations/*` |
| `@/lib/db/*` | `@/lib/tools/master-inbox/db/*` |
| `@/lib/supabase/admin` | unchanged — the OS has the same module |

Every helper those files import already existed in the OS from the earlier port,
and each is itself identical to the tool's modulo imports (`token.ts`,
`feature-flags.ts`, `stage-config.ts`, `csv.ts`, `n8n-introduction.ts`,
`slack-portal.ts`, `push-pipeline-entry.ts`, `paginated-select.ts`). Nothing new
was written under `src/lib/`.

## The one deliberate deviation

`stage-labels/route.ts` is the only route of the nine that writes to `clients` —
the table all 47 portals resolve against. It writes
`{ stage_label_overrides, updated_at }`, which is correct and is what the tool
does. The patch is now built as a named object and passed through
`assertNoPortalColumns()` from `src/lib/tools/master-inbox/portal-guard.ts`
before the update.

This changes nothing today: `cleaned` is whitelisted against `STAGE_ORDER` a few
lines above, so the patch can only ever hold those two keys and the guard always
passes. It is there for the edit that has not happened yet — the
`{ ...client, ...patch }` spread that carries `portal_token: undefined` into an
update and blanks a live portal's URL. That is the exact failure the guard file
was written for, and this was the one write site in the new code that could
reach it.

Everything else is verbatim.

## The security model — two gates, both kept

1. **`resolvePortalClient(token)`** (`portals/token.ts`) — returns null when the
   feature flag is off, the token does not match, the client is the `unknown`
   fallback, or `portal_enabled` is false. Untouched, unweakened, and called
   first in all nine handlers.
2. **`proxy.ts`** — everything under `/api/tools/*` requires a valid workspace
   session. The public portal has no equivalent, so these routes are strictly
   harder to reach than the ones serving customers today.

Both were tested, not assumed: a request with no session cookie gets 401 from
the proxy, and a valid token belonging to a client whose `portal_enabled` is
false gets 404 with nothing written to that client's row.

**Tokens are credentials.** None is logged, echoed, committed, or written to any
file by this work. The test script reads them from the database at runtime and
holds them in memory only.

## What was NOT built, and why

**The other 15 of the tool's 24 portal route files.** The drill-down calls nine
families; the rest (`agents/**`, `dnc/**`, `team/**`, `followup-boss`,
`ideal-agent-profile`) are called only by the public portal's own tab
components, which are not part of this port. Confirmed by enumerating every
`master-inbox/portal/` call site in `src/` — there are four files
(`pipeline-board`, `stage-manager`, `stage-label-editor`, `conversation-sheet`)
and between them they call exactly the nine above. Building the rest would add
write surface onto customer data with nothing calling it.

**`app/portal/**` — the customer-facing portal pages.** Deliberately absent. The
OS must never serve a portal page; `portal.brokerstaffer.com` is the only thing
that should. A second deployment rendering the same pages is a second writer and
a second URL for a page customers are already bookmarked to.

## Two things the tests could not honestly prove

**A successful Follow Up Boss push.** Neither Demo Portal nor Test FUB has a FUB
API key, so `push-fub` was proved as far as the helper's real verdict
(`400 / reason:"no_key"`, and no `fub_*` column written) rather than a completed
push. Proving the success path means pushing with a real customer's key, which
creates a real person in that customer's CRM. Not worth it for a route that is
verbatim and whose helper the inbox already exercises on every labelled intro.

**The `flag off → 404` branch on `/stages` and `/pipeline/csv`.** All 47 live
clients have `manage_stages` and `pipeline_csv_upload` on, so the only way to
reach that branch is to flip a real customer's `feature_flags` — a write to
`clients`, on a live portal, to test a gate. The gate is one copied
`clientHasFeature()` line shared by both routes.

Both are stated here rather than papered over, because a checklist that claims
more coverage than it has is worse than one that admits the gap.

## Triggers these routes fire

Two of the three inbox ↔ portal connections run through this code, and neither
is application code — both are database triggers (see `MASTER-INBOX-PORT.md`).

- **0070** — `PATCH /pipeline/<id>` with `stage: "no_show"` fires
  `pipeline_apply_no_show_label`, which writes a "No Show / No Response" label
  onto the thread in the staff inbox. **Verified end-to-end through the new
  route**, on Test FUB. It cannot be tested on Demo Portal: 0070 hardcodes an
  exclusion for the demo client id, so a demo test would pass by doing nothing.
- **0033** — the deferred constraint trigger that cascades pipeline-entry
  deletes when a thread loses all labels. Not driven by these routes, but it is
  why the delete paths stay scoped by `client_id` rather than by `id` alone.

Side effects that cannot be undone: a stage transition posts to Slack, and a move
to `introduction` fires the n8n webhook. The test therefore creates entries at
`keep_warm` and performs only the transitions it genuinely needs.

## How it was proved

`node scripts/portal-routes-write-test.mjs` — **80 checks, 0 failures.**

Every write is followed by a direct PostgREST read of the row it claimed to
change, and the assertion is on what the database says. A 200 proves nothing;
this repo has already shipped 23 routes that returned 401 to everybody and a
settings page whose every field was read-only.

Highlights, all asserted in the DB rather than in a status code:

- a created entry lands scoped to the right client, at the stage asked for, with
  `source='Client Entry'` because `pipeline_source_split` is on for that client
- a second `custom_fields` patch **merges** rather than replaces, and
  `custom_fields_remove` deletes only the named key
- a CSV of 4 rows inserts 2 and skips 2, with the blank-name and bad-stage rows
  provably absent from the table
- bulk stage / assign / delete each change exactly the rows named
- deleting a custom stage first clears `custom_stage_key` on its entries, so no
  entry is left pointing at a stage that no longer exists
- a whitespace-only stage label is dropped rather than stored
- **cross-client**: PATCH, DELETE, bulk-delete, push-fub and conversation, all
  aimed at another client's entry id through this client's token, are refused —
  and the other client's row is re-read afterwards and is byte-identical

### Fixture, and the proof it is gone

Everything ran against **Test FUB**, which began the run with **0 pipeline
entries, 0 stage-overlay rows and `stage_label_overrides = {}`** — so "my test
data is gone" is demonstrated by the fixture returning to empty, not asserted.

Three entries were created (`ZZ Portal Route Test` Alpha / Bravo / Charlie, plus
a thread-backed one for the 0070 check), used, and deleted. Afterwards:

```
entries with lead_name like '%Portal Route Test%'   0
notes  with body      like '%Portal Route Test%'    0
client_pipeline_stages key = 'zz_route_test_stage'  0
Test FUB entries / stage rows / overrides           0 / 0 / {}
test thread returned to its original client         yes
no-show label removed from the test thread          yes
```

Demo Portal was read only, as the far side of the cross-client checks; its entry
count (15) and its own 10 stage-overlay rows are unchanged.

## Fingerprint

```
node scripts/portal-fingerprint.mjs save    # before
node scripts/portal-fingerprint.mjs check   # after
```

| table | before | after | |
|---|---|---|---|
| `client_pipeline_entries` | 1527 | 1527 | unchanged |
| `client_agents` | 11306 | 11306 | unchanged |
| `client_team_members` | 97 | 97 | unchanged |
| `client_dnc_entries` | 14278 | 14278 | unchanged |
| `client_pipeline_notes` | 1144 | 1147 | +3 — live customers |
| `label_assignments` | 10630 | 10636 | +6 — AI labeller + one user |
| `threads` | 10217 | 10223 | +6 — inbound mail |
| `messages` | 36287 | 36307 | +20 — inbound mail |

**47 live portals, every URL identical, no client removed, no table shrank.**

The four increases are not test residue and were attributed row by row: the 3
notes were written by Momentum Realty and Properties & Estates Florida through
their own live portals while the test was running, 5 of the 6 labels were
assigned by the AI classifier and 1 by a user, and the thread/message growth is
inbound email. None of them is on the test client or the test thread. That the
live system carried on working normally throughout is itself part of the result.

## The acceptance test

The question is not whether a route returns 200 — it is whether the customer's
page still works. Fetched after all write testing, read-only:

| portal | HTTP | pipeline rendered | entries |
|---|---|---|---|
| Test FUB (the client written to) | 200 | yes | 0 |
| 54 Realty | 200 | yes | 42 |
| Bastion Realty South | 200 | yes | 27 |
| BHGRE Basecamp | 200 | yes | 92 |
| Brandolino Group | 200 | yes | 3 |
| Brooklyn Group | 200 | yes | 28 |
| C21 Results - Elite Team | 200 | yes | 99 |

No page contains any test data.

## Standing checks

```
npx tsc --noEmit -p tsconfig.json              # 0 errors under src/
node --test src/lib/guards/blast-radius.test.ts # 6/6 — no unscoped write
node --test src/lib/tools/master-inbox/portal-guard.test.ts  # 6/6
node scripts/portal-routes-write-test.mjs      # 80/80
node scripts/portal-fingerprint.mjs check      # 47 URLs identical
```

Every `.update()` and `.delete()` in the new routes carries a scope — most of
them two (`.eq("id", …)` **and** `.eq("client_id", client.id)`), which is what
makes the cross-client checks above come out refused rather than merely
unauthorised.

## Portal write handlers as library modules (28 Oct)

The new client portal needs the writes the live portal's own tabs make (Your
Agents, DNC, Team, Follow Up Boss). Those were the 13 handlers left out above
because nothing in the OS called them. They are now copied, as **library
modules, not routes**.

### What was copied, and where

Source (read-only): `Master Inbox/app/api/portal/[token]/**` at `beba2ed`.
Destination: `src/lib/tools/master-inbox/portal-routes/`, keeping the same
layout. The only renaming is the folder `[id]` → `id`, and every file keeps the
name `route.ts` so the diff stays mechanical.

| source | copy | exports |
|---|---|---|
| `agents/route.ts` | `portal-routes/agents/route.ts` | POST |
| `agents/bulk-delete/route.ts` | `portal-routes/agents/bulk-delete/route.ts` | POST |
| `agents/csv/route.ts` | `portal-routes/agents/csv/route.ts` | POST |
| `agents/[id]/route.ts` | `portal-routes/agents/id/route.ts` | PATCH, DELETE |
| `dnc/route.ts` | `portal-routes/dnc/route.ts` | POST |
| `dnc/bulk-delete/route.ts` | `portal-routes/dnc/bulk-delete/route.ts` | POST |
| `dnc/csv/route.ts` | `portal-routes/dnc/csv/route.ts` | POST |
| `dnc/[id]/route.ts` | `portal-routes/dnc/id/route.ts` | PATCH, DELETE |
| `team/route.ts` | `portal-routes/team/route.ts` | POST |
| `team/bulk-delete/route.ts` | `portal-routes/team/bulk-delete/route.ts` | POST |
| `team/csv/route.ts` | `portal-routes/team/csv/route.ts` | POST |
| `team/[id]/route.ts` | `portal-routes/team/id/route.ts` | PATCH, DELETE |
| `followup-boss/route.ts` | `portal-routes/followup-boss/route.ts` | PATCH, DELETE |

Not copied: `team/[id]/avatar` and `ideal-agent-profile`.

The import mapping is the one in the table above. Every helper these files
import was already in the OS and is identical to the tool's apart from import
paths and comments: `enforce-blocklist.ts`, `stop-person.ts`
(`stop-person-plan.ts` is byte-identical), `slack-portal.ts`,
`feature-flags.ts`, `team-sms.ts` (only a header comment differs; the
`TEAM_SMS_FLAG` value is the same), `integrations/followup-boss.ts`
(byte-identical), and `supabase/admin`. Nothing new was written under
`src/lib/` apart from these 13 files.

### Why they are not routes

Nothing was created under `src/app/`. These files add **no HTTP surface**.
Only the new client portal's own save route will import them, and it will call
the handler functions in-process, after its own sign-in and per-portal checks,
passing the token it resolved on the server. A token from a browser never
reaches them through a URL.

Copying them as routes would put a second, token-only door onto customer data
next to the one `portal.brokerstaffer.com` already runs. That is the
"second writer" this document refuses for `app/portal/**`.

The `dynamic` and `maxDuration` exports in each file have no effect outside
`src/app/`. They are kept so the files stay the same as the tool's. The calling
route must set its own segment config. The handlers call `after()` from
`next/server`, so they must run inside a request (a route handler or server
action), never from a script or a unit test.

### The proof

For each of the 13 files:

```
diff <source> <copy> | grep '^[<>]' | grep -v '^[<>] import ' | grep -v '^[<>] } from '   →  empty (0 lines) for all 13
```

The brief's form of this command, without `grep '^[<>]'`, prints only diff's
own hunk headers (`4,6c4,6`) and `---` separators. Every hunk is a `c`
(change), and source and copy have the same line count, so no line was added
or removed.

A stricter check was also run. Mapping the four import prefixes back to the
tool's spelling and running `cmp` against the source gives **byte-identical**
for all 13.

`npx tsc --noEmit -p .` reports 0 errors in these files. On this worktree it
also prints 5 `TS2307 Cannot find module './logo.png'` errors elsewhere. They
come from the worktree having no `next-env.d.ts` (gitignored, written by
`next dev`/`next build`), which supplies the image module types. With
`next/image-types/global.d.ts` added, the whole project checks clean.

`npm test` passes 2510/2510. That includes `blast-radius.test.ts`, which now
scans this folder: every `.update()` and `.delete()` in the 13 files is scoped.

### Two differences found while checking, not fixed here

1. **`resolvePortalClient` no longer matches the tool's.** Since `20f6af9`,
   the tool's version also returns null for a portal held for an unpaid invoice
   (`portalBillingHold`, which reads `os_portal_blocks` rows with mode
   `'blocked'` and `lifted_at` null, and fails open). The tool also gained
   `resolvePortalRow` and `currentTokenFor` (0079 old-link forwarding). The OS's
   `portals/token.ts` has none of these, so these handlers and the nine routes
   above **accept writes for a held portal** that the live portal would refuse.
   No portal is held today, because blocking is a dry run behind
   `OS_PORTAL_BLOCK_ENABLED`. This changes the moment blocking is switched on.
2. **Two of the nine earlier routes are no longer byte-identical to the tool.**
   They carry an OS fix the tool does not have, so they are ahead of it, not
   behind:
   - `pipeline/route.ts` (bulk stage move): only entries that moved into
     Introduction are sent to n8n.
   - `pipeline/[id]/route.ts`: the n8n and Follow Up Boss Introduction hooks
     fire only on a real move into Introduction.

   `stage-labels` differs only by the guard described above. The other six are
   still identical modulo imports.

`followup-boss/route.ts` writes to `clients` (`fub_api_key`, `fub_connected_at`,
`updated_at`, scoped `.eq("id", client.id)`). Unlike `stage-labels`, it is kept
verbatim and does **not** go through `assertNoPortalColumns()`. Its patch is a
literal with three fixed keys, so the guard could never fire there.

## The new client portal's saves (28 Oct)

`src/lib/crm-preview/portal-save.ts`, called only by `src/app/api/crm-preview/save/route.ts`
(the old `/api/crm-preview/demo` address only re-exports it). The user: "exact same
functionality of the old client portals for the features that are present in new client
portal".

**Who.** The route checks the viewer (staff reviewer or a signed-in client), that the portal is
theirs to open (`viewer-rules.ts` `mayOpenPortal` — a bare 404 otherwise), and that they may
change it (`mayWritePortal`: the Demo's own viewers; a real portal only its own signed-in client —
a staff preview of a real client stays read-only, 403). Then the usage guard. Then the save.

**The Demo** keeps its own writer (`demo.ts`): its rows only, nothing outside.

**A real portal** goes through `runPortalAction`:

1. The portal's token is read from `clients` on the server, then `resolvePortalClient(token)` —
   the same answer the current portal gives (portals switched on, not the Unknown bucket,
   `portal_enabled` not false). The token never reaches the browser.
2. **Held for an unpaid invoice** (`portals/billing-hold.ts`, byte-identical to the tool's): the
   save is refused before any handler runs. This closes difference 1 above for the new portal;
   the staff drill-down's routes are unchanged. The page (`app/crm-preview/page.tsx`) shows a
   client the tool's own "Your portal is paused" screen (`portals-ui/billing-hold.tsx`,
   byte-identical) and Not found for a switched-off portal, as the current portal does.
3. Each action calls the handler the current portal's UI calls for it, in-process, with the
   body that UI sends: one agent's stage/assign/delete → the single-entry route; several → the
   bulk route, 200 ids a request; notes add/edit/delete; push to Follow Up Boss; My Agents,
   DNC and Team add/edit/active/delete (a row's own delete → the `id` route, which posts to
   Slack; "Delete selected" → `bulk-delete` whatever the count, as the current portal — for
   My Agents and DNC that posts nothing, for Team it posts each member when five or fewer,
   else one summary); CSV imports → each list's `csv` handler; Manage stages → `stages`;
   Follow Up Boss connect/disconnect → `followup-boss`. Every side effect is the handler's own.

Where it deliberately does more than the current portal (each is a known gap there; none adds
a side effect):

| | current portal | new portal |
|---|---|---|
| Edit lead | re-sends the date (rewriting it to noon UTC) and the replacement mark on every save | sends each only when changed |
| Assign | does not check the team member is the portal's | refused with a sentence if not |
| Bulk move with Manage stages | leaves `custom_stage_key`, so the agent stays in a custom column | then clears it for this portal's agents, as the single move does |
| Custom stage without the flag | silently ignored and answered "ok" | refused with a sentence |
| DNC company with an unreadable domain | saved with no domain (blocks nothing) | refused with a sentence |
| CSV imports (Agents, DNC, Team) | one bad row fails the whole file | bad rows skipped and named by line; the rest go through the same handler |
| Pipeline CSV stage column | raw keys only (`phone_screen`) | also the portal's own stage names ("First Call"), mapped to the key the handler takes |

Inherited, not new: the Introduction announcement fires only on a real move into Introduction
(difference 2 above).

What the new portal adds with no current-portal equivalent: the Setup wizard's offer
(`os_portal_offers`, nothing outside), and Market's **Move to** on a real portal (and the
wizard's "Add to My Agents") — My Agents, the DNC List or off every list, at most 500 a move,
asked first ("This can't be undone"), each counted as Market use (the OS heavy-use alert), and
each move onto My Agents or the DNC List puts its own notice in the OS bell (the user, 28 Oct:
"Market move: N agents to DNC List — <client>", `portal-usage/usage.ts alertMarketMove` —
it never refuses or pauses the client):

- saved by **name** (and brokerage, on the DNC List) only — never the agent database's email or
  phone (the no-scraping rule: no exportable list carries what Market itself never shows);
- the agent's **preferred** email only (the user's choice, 28 Oct — the enriched one is a guess)
  is blocked (`enforceBlocklist`, as an added address is) — for every agent moved onto the list,
  those already on it by name too; on the DNC List it is also stopped (`stopEntries`), one Slack
  summary names those added (names only), and the address is kept in `os_market_dnc_emails`
  (migration 0044) against the entry, where the OS reply agent (`ai/safety-facts.ts`) and the
  Postmark relay (`relay/relay.ts`) look — both hold if that read fails for any reason but "no
  such table" (before 0044 is run);
- the entry is added first, the side effects set off as soon as it is, then the agent is taken
  off the lists it leaves (the current portal's `bulk-delete`): a later step failing says so and a
  retry finishes it — never an agent on no list, never a block lost;
- an agent is recognised on a list by its preferred address, or by name where an entry has none —
  and only an entry Market made is taken off by name: a client's own same-name entry stays.

Prospects are never added on a real portal. Master Inbox's own reply agent (the one its sync
webhooks trigger) gets the same `os_market_dnc_emails` lookup in its `lib/ai/safety-facts.ts`
(the user, 28 Oct: "Port the check to Master Inbox"; with `lib/ai/safety-facts-dnc.test.ts`) —
that app's change ships only with its own deploy.

`portal-save.test.ts` runs every one of these through the real handlers against a fake
database, with every outside call recorded; `access.test.ts` pins the only tables portal-save
writes itself (`client_agents` / `client_dnc_entries` inserts for Market, their push columns,
and the custom-stage clear) — never a delete, never `clients`.
