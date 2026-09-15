# Client Portals — feature parity through the visual rebuild

Two screens were restyled from the Master Inbox tool's Tailwind markup into the
approved mockup's visual language (`src/app/workspace.css`):

- `/inbox/portals` — the admin list of every client's portal
- `/inbox/portals/<clientId>` — the staff drill-down into one client's Recruiting Pipeline

**The rule this file exists to enforce:** a restyle may not cost a control.
The portals list already shipped read-only for a day and nobody noticed, because
a read-only table looks finished. So every control was written down *before* the
work, and is ticked only after being driven in a real browser.

```
node scripts/portals-ui-test.mjs http://localhost:3380

  85 verified · 2 deliberately not run · 0 failed
```

Driver: `scripts/portals-ui-test.mjs` — real Chrome over the DevTools Protocol,
app on **3380**, Chrome on **9452**. Interactive controls are exercised against
**Demo Portal** (every feature flag on); three checks that Demo Portal cannot
answer are made **read-only** on other clients, with nothing clicked.

## The portal fingerprint

| | Clients | Live portals | Pipeline entries | Pipeline notes |
| --- | --- | --- | --- | --- |
| Before | 58 | 47 | 1,527 | 1,144 |
| After | 58 | 47 | 1,527 | 1,144 |

```
✅ every portal URL identical · no client removed · no table shrank
```

`threads`, `messages` and `label_assignments` grew (+9 / +29 / +10) — that is the
live Master Inbox ingesting real email while this work ran, not this work.

**No write reached the database.** Every mutating request is intercepted inside
the page: `window.fetch` is wrapped, and POST/PATCH/DELETE to the portal API are
recorded and answered locally instead of going out. That proves exactly what a
restyle can break — the control still fires the right method, at the right URL,
with the right body — while the tables are provably untouched, which the
unchanged entry and note counts above confirm independently.

---

## Legend

| Mark | Meaning |
| --- | --- |
| **PASS** | Driven in a real browser; the control did what it says. |
| **RENDER** | Control works and fires the correct request, verified body-and-all; the request is answered locally so nothing is written. Its server route does not exist in this repo — see below. |
| **VISUAL** | Non-interactive; verified present and correctly styled. |
| **NOT-RUN** | Deliberately not exercised — it would affect a real customer. |

---

## Pre-existing gap, found while inventorying (NOT caused by this work)

Every write on the drill-down posts to `/api/tools/master-inbox/portal/<token>/…`.
**No route under that path exists in this repository** — `src/app/api/tools/master-inbox/`
has `portals/` and `clients/portals/` and no `[token]` segment at all. So stage
moves, notes, lead edits, CSV import, Follow Up Boss push, the conversation
fetch, stage renaming and stage management all 404 today, before and after this
change. Sixteen endpoints are affected.

This is recorded, not fixed: building sixteen write routes into the live portal
tables is a different job from a restyle, and those tables serve 47 live customer
portals. **Flagged for the owner to schedule.**

---

## A. Portals list — `/inbox/portals`

| # | Control | Status | Evidence |
| --- | --- | --- | --- |
| A1 | Stat card — Clients | PASS | `Clients 57 · 47 with introductions` |
| A2 | Stat card — Live portals | PASS | `Live portals 47 · of 57 clients` |
| A3 | Stat card — Total introductions | PASS | `Total introductions 1,115 · across all clients` |
| A4 | Client search filters the list | PASS | 57 → 1 rows on "Demo" |
| A5 | Search empty state | PASS | `No clients match "…"` |
| A6 | Row links into the drill-down | PASS | `/inbox/portals/c370499d-…` |
| A6b | **Following that link lands on the drill-down** | PASS | pipeline header rendered — see "the broken link" below |
| A7 | Portal path readout / "No portal URL set" | VISUAL | |
| A8 | Intro-count pill | VISUAL | |
| A9 | Last-intro date | VISUAL | |
| A10 | Live toggle | **NOT-RUN** | 57 switches present and interactive; never clicked — it would disable a real customer's portal |
| A11 | Copy link → clipboard + toast | PASS | absolute portal URL copied |
| A12 | Edit URL opens the dialog | PASS | `Portal URL — 54 Realty` |
| A13 | Dialog — slug input, Cancel, Save URL | **NOT-RUN** | 1 input, buttons `Cancel / Save URL / Close`; **Save never clicked** — it would change a live portal URL |
| A14 | Open live portal (new tab) | VISUAL | `target=_blank`, href asserted, not followed |
| A15 | Footer link-secrecy warning | VISUAL | now the design's `.anno` ribbon |

## B. Drill-down chrome

| # | Control | Status | Evidence |
| --- | --- | --- | --- |
| B1 | "All client portals" back link | PASS | now `/inbox/portals` |
| B2 | Counts strip — pipeline / agents / DNC / team | VISUAL | recessed metric group |
| B3 | "Open live portal" | VISUAL | href asserted, not followed |
| B4 | Pipeline header + Nicole Collins card | VISUAL | |
| B5 | "Best practices" disclosure | PASS | expands |
| B6 | "What each stage means" + stage legend | PASS | expands |

## C. Board toolbar and filters

| # | Control | Status | Evidence |
| --- | --- | --- | --- |
| C1 | Search candidates | PASS | |
| C2 | "Replacements only" | PASS | |
| C3 | "Add candidate" | PASS | |
| C4 | "Upload CSV" (`pipeline_csv_upload`) | PASS | **was not rendering before this work** |
| C5 | View toggle List / Board (`pipeline_kanban_view`) | PASS | **was not rendering before this work** |
| C6 | Result counter | VISUAL | `15 of 15 candidates` |
| C7 | Stage filter chips with counts | PASS | 12 chips (9 canonical + 3 custom) |
| C8 | "Clear filter" | PASS | 15 → 2 rows, clear appears |
| C9 | Empty state + "Add a candidate" | — | only when a client has zero entries |

## D. Bulk action bar

| # | Control | Status | Evidence |
| --- | --- | --- | --- |
| D1 | Bar label / live count | PASS | label → `1 selected` |
| D2 | "Move to…" menu | PASS | 9 stages |
| D2b | Bulk stage move fires its PATCH | RENDER | `PATCH …/pipeline {"action":"stage","ids":[…]}` |
| D3 | "Assign to…" roster menu | PASS | `Unassigned / Avery Park / Sasha Coleman / Jordan Riley` |
| D4 | "Copy names" | PASS | clipboard written |
| D5 | "Copy phones" | PASS | clipboard written |
| D6 | "Export CSV" | PASS | `pipeline-2026-09-10.csv` (410 bytes) |
| D7 | "Delete" is confirm-gated | PASS | `confirm()` called 1×; declined → **0 writes** |
| D8 | "Clear" selection | PASS | |
| D9 | Disabled-when-empty semantics | PASS | all six disabled with nothing ticked |

## E. Table rows

| # | Control | Status | Evidence |
| --- | --- | --- | --- |
| E0 | Table renders rows | PASS | 15 rows |
| E1 | "Select all" (page-scoped) | PASS | |
| E2 | Row checkbox | PASS | |
| E3 | Candidate cell expands inline detail | PASS | `aria-expanded=true` |
| E4 | Copy name, without expanding the row | PASS | copied; expansion count unchanged |
| E6 | "Agent profile" external link | VISUAL | |
| E8 | Push-to-Follow Up Boss chip | RENDER | `In Follow Up Boss / Push again` — **read-only on a FUB-connected client**; neither safe client has a key, so its absence on Demo Portal is correct |
| E9 | Source badge (`pipeline_source_split`) | VISUAL | **was not rendering before this work** |
| E10 | "Call" / "Text" (`tel:` / `sms:`) | VISUAL | |
| E11 | Copy phone | PASS | |
| E12 | Stage pill moves a lead's stage | RENDER | picked `Phone Screen Scheduled` (was `interview`) → `PATCH …/pipeline/<id>` |
| E13 | Assigned pill roster | PASS | `Unassigned / Avery Park / Sasha Coleman` |
| E14 | Row "Edit" | PASS | opens `Edit lead` |
| E15 | Notes pill | PASS | covered by G1 |
| E16 | Table empty state | VISUAL | |

## F. Mobile card list

| # | Control | Status | Evidence |
| --- | --- | --- | --- |
| F1–F3 | Card list, "Show details", hidden in Board view | — | markup and handlers untouched by this work; the restyle changed the desktop grid's rhythm only. Not driven at mobile width. |

## G. Notes sheet

| # | Control | Status | Evidence |
| --- | --- | --- | --- |
| G1 | Opens with a Close button | PASS | composer, Add note, Details, Close all present |
| G2 | Details block | VISUAL | |
| G5 | Composer textarea | PASS | |
| G6 | "Add note" | RENDER | `POST …/pipeline/<id>/notes` |
| G7 | Per-note Edit → Cancel / Save | — | Demo Portal's entry has no note to edit |
| G8 | Per-note Delete (confirm-gated) | — | as above |

## H. Conversation sheet

| # | Control | Status | Evidence |
| --- | --- | --- | --- |
| H1 | Opens and fetches | RENDER | header renders, `GET …/conversation/<id>` fires |
| H2 | Drag-to-resize handle | PASS | `aria-label="Drag to resize conversation"` |
| H4 | Loading / error / empty states | VISUAL | `Loading conversation…` observed |

## I. Edit / Create lead dialog

| # | Control | Status | Evidence |
| --- | --- | --- | --- |
| I1 | Title | PASS | `Edit lead` |
| I2 | Six lead fields | PASS | Name / Email / Phone / Company / Agent profile / Introduction date |
| I3 | "Mark as needing replacement" | PASS | |
| I4 | Custom fields | PASS | Buy-side, List-side, Office city, Sales volume, Estimated gci |
| I5 | "Add field" | PASS | |
| I6 | Validation toasts | — | not driven; logic untouched |
| I7 | Save | RENDER | `PATCH …/pipeline/<id>` |

## J. CSV upload dialog (`pipeline_csv_upload`)

| # | Control | Status | Evidence |
| --- | --- | --- | --- |
| J1 | Dialog opens | PASS | `Import candidates from CSV` |
| J2 | Drop-zone + file input | PASS | |
| J3–J6 | Preview, re-choose, Cancel, Import | — | not driven (no file picked); markup untouched |

## K. Board (Kanban) view (`pipeline_kanban_view`)

| # | Control | Status | Evidence |
| --- | --- | --- | --- |
| K1 | One column per stage | PASS | 12 columns, 15 cards |
| K2 | Cards draggable | PASS | 15 of 15 |
| K3 | Drop on a column → stage move | RENDER | `PATCH …/pipeline/<id>` |
| K4 | Card click → detail sheet | PASS | |
| K5 | Per-column sales volume (`pipeline_board_enhanced`) | VISUAL | |
| K7 | Empty column / board empty state | VISUAL | |

## L. Detail sheet and inline detail

| # | Control | Status | Evidence |
| --- | --- | --- | --- |
| L2 | Sheet "Edit" hands off to the dialog | PASS | |
| L1, L3–L7 | Open, close, field stack, countdown, notes, empty state | VISUAL | rendered in the sheet body |

## M. Stage management

| # | Control | Status | Evidence |
| --- | --- | --- | --- |
| M5 | "Manage stages" card expands (`manage_stages`) | PASS | **was not rendering before this work** |
| M6 | Move up / Move down | PASS | 12 each |
| M8 | Per-stage rename inputs | PASS | 12 inputs |
| M9 | Hide / show toggle | PASS | 13 toggles |
| M11 | "Add stage" | PASS | |
| M12 | "Save changes" | RENDER | `PATCH …/stages` |
| M1–M4 | "Stage names" editor (clients without `manage_stages`) | — | the other branch of the same card; unchanged, and it is what every real client still sees |

## N. Pagination and cross-page selection

Checked **read-only** on a 220-row client — the footer returns null below 50 rows
and Demo Portal has 15. Nothing was clicked.

| # | Control | Status | Evidence |
| --- | --- | --- | --- |
| N1 | Range readout | VISUAL | 50 rows on page 1 |
| N2 | Prev / Next | VISUAL | present |
| N3 | "Page n / m" | VISUAL | |
| N4 | Cross-page select-all banner | VISUAL | page size 50 = `PORTAL_PAGE_SIZE` |

## O. Custom stages get filter bubbles — the upstream change

Folded in from `UPSTREAM-pipeline-board.patch`. `stageFilter` now holds display
keys, matching and counting use `custom_stage_key ?? stage`, and the bubble list
comes from the full `manage_stages` set when a client has it.

`custom_stage_key` is a **display overlay**: the lead keeps its canonical
`pipeline_stage`, and the funnel and reporting keep reading that. Only grouping,
counting and filtering use the overlay. The two are never collapsed — O4 proves
it at the wire.

Demo Portal has one operator-made stage, "Invited to sales meeting", and no entry
parked in it. Parking one for real would be a write; instead the test parks one
through the real board drag, whose PATCH is intercepted — the page behaves
exactly as a real drag, the database never hears about it.

| # | Control | Status | Evidence |
| --- | --- | --- | --- |
| O1 | Custom stage gets a filter bubble | PASS | "Invited to sales meeting" among 12 bubbles |
| O2 | Parking a lead moves it into that bubble's count | PASS | count `0 → 1` |
| O3 | Filtering by it returns only the parked entry | PASS | 1 row — "Sienna Brooks", the one parked |
| O4 | The overlay is sent, never the enum stage | RENDER | `PATCH body {"custom_stage_key":"custom_apw2pau5"}` — no `stage` key |

---

## Two features that were dark before this work

The drill-down is the only place in the OS that mounts `PipelineBoard`, and it
passed **none** of the five per-client feature-flag props. All five default to
`false`, so Upload CSV, the List/Board switch, the Source column, the board's
sales-volume totals and Manage Stages were unreachable on the staff view no
matter which client you opened — while the same client's own portal showed them.
Staff and client seeing different things is the one thing this screen exists to
prevent. `StageDefsProvider` was not mounted either, so `useStageDefs()` returned
null and custom stages could not resolve at all.

They are now wired from `clients.feature_flags`, so the safety contract is
unchanged: a client without a flag renders exactly what it rendered before, and
no gated string enters their SSR payload.

## The broken link

Rows linked at `/portals/<id>` — the tool's own path. `idForPath` does not
recognise it, so all 47 rows fell through to Home; the back link had the same
problem. Both now use `/inbox/portals`. A6b follows the link rather than reading
its `href`, because reading the href would have passed the whole time.

---

## The write surface, unchanged

| Method | Route |
| --- | --- |
| PATCH | `…/portal/<token>/pipeline/<id>` — stage, assignment, lead edit |
| PATCH | `…/portal/<token>/pipeline` — bulk stage / assign / delete |
| POST | `…/portal/<token>/pipeline` — create lead |
| POST | `…/portal/<token>/pipeline/csv` — CSV import |
| POST | `…/portal/<token>/pipeline/<id>/notes` — add note |
| PATCH | `…/portal/<token>/pipeline/<id>/notes/<noteId>` — edit note |
| DELETE | `…/portal/<token>/pipeline/<id>/notes/<noteId>` — delete note |
| POST | `…/portal/<token>/pipeline/<id>/push-fub` — Follow Up Boss |
| GET | `…/portal/<token>/conversation/<id>` — conversation |
| PATCH | `…/portal/<token>/stage-labels` — rename / reset stage labels |
| PATCH | `…/portal/<token>/stages` — manage stages |
| PATCH | `/api/tools/master-inbox/clients/<id>` — portal toggle and portal URL |

Non-fetch behaviour that also survives: `router.refresh()` after every write,
clipboard writes, the CSV Blob download, both `localStorage` keys
(`portal:<token>:pipeline-view`, `portal-conversation-sheet-width`), the three
native `confirm()` gates, and the drag-and-drop MIME type
`application/x-pipeline-entry-id`.

## Layout

```
CDP_URL=… SCREENS=/inbox/portals,/inbox/portals/<id> node scripts/layout-test.mjs http://localhost:3380 1440
  ✓ /inbox/portals      viewport 1440  doc overflow 0px  0 element(s) genuinely past the edge
  ✓ /inbox/portals/<id> viewport 1440  doc overflow 0px  0 element(s) genuinely past the edge
  2/2 screens fit the viewport

… 1280
  ✓ /inbox/portals      viewport 1280  doc overflow 0px  0 element(s) genuinely past the edge
  ✓ /inbox/portals/<id> viewport 1280  doc overflow 0px  0 element(s) genuinely past the edge
  2/2 screens fit the viewport
```

The default screen set still passes 5/5, so nothing else regressed.

`npx tsc --noEmit -p tsconfig.json` — **0 errors under `src/`**.
