# Campaign Analytics — parity checklist

Source: `github.com/NextHire-Solutions/Campaign-tool` @ `6d7ebb8`, read at
`/Users/sankalpdutt/Desktop/Code/_os-sources/analytics`.

Every screen, section and control the tool has, and what happened to it here.
`✅` built and tested · `⚠️` built with a deliberate difference · `❌` not built,
with the reason.

---

## 0. The mapping

The workspace nav declares seven Analytics destinations. All seven have a real
screen.

| Nav id | Label | The tool's screen | Status |
|---|---|---|---|
| `analytics:campaign` | Campaign | `/analytics/campaign` | ✅ |
| `analytics:infrastructure` | Infrastructure | `/analytics/infrastructure` | ✅ |
| `analytics:attribution` | Attribution | `/analytics/attribution` | ✅ |
| `analytics:copy` | Copy & Offer | `/analytics/copy-offer` | ✅ |
| `analytics:campaigns` | Campaigns | `/campaigns` | ⚠️ list ✅, drill-down partial — §6 |
| `analytics:schedule` | Schedule | `/schedule` | ✅ |
| `analytics:clients` | Clients | `/clients` | ✅ |

**Real screens with no nav destination — three, all accounted for:**

| Screen | What it is | What happened |
|---|---|---|
| `/` and `/analytics` | `redirect("/analytics/campaign")`, three lines each | Nothing to port. `pathForId("analytics:campaign")` already returns `/analytics`, so the bare address lands on the same screen. |
| `/analytics/volume` | A real fifth analytics tab: sending capacity and where the volume went | **Built**, as a fifth segment on the Campaign screen beside Charts / Clients / Campaigns / Replies. `nav.ts`'s own rule is that a control switching "how one dataset is drawn" stays inside the tool. Owner's call — one leaf makes it a rail item instead, see `ANALYTICS-WIRING.md` §2b. |
| `/campaigns/[id]` | One campaign, six tabs | **Built** at `/analytics/campaigns/<id>`, reached from the list. Needs no leaf: a campaign is a row you open. Five of six tabs — §6. |

**Nav destinations with no counterpart: none.** All seven map cleanly.

---

## 1. The library — 58 files

The OS already had 15 files under `src/lib/tools/analytics/`. **Four were stale
copies from before the Instantly work landed** and would have produced wrong
numbers rather than missing ones:

| File | What the stale copy was missing |
|---|---|
| `kpis.ts` | The whole Instantly branch: `analytics_instantly_kpis`, the platform scope, and the rule that Positive and Bounces go **null** rather than 0 when Instantly is in scope. The stale copy typed them `number` and coerced with `?? 0`, which would have printed "0 positive" beside 884 replies. |
| `columns.ts` | Same nullability across ten columns, plus `campaignId: number \| string` — Instantly keys campaigns with a uuid, and the stale copy typed it `number`. |
| `query-params.ts` | `emailbisonCampaignIds` / `instantlyCampaignIds`. The stale copy parsed a campaign id as an integer and threw on a uuid, so an Instantly campaign could not be selected at all. |
| `lead-columns.ts` | Four nullable lead counters. |
| `platform-scope.ts` | **Absent entirely.** This is the file that stops "one EmailBison campaign + the Instantly chip" reporting 43,283 sends for a campaign that sent 2. |

All five were refreshed verbatim from `6d7ebb8`. The **only** edit to any of them
is the Supabase import in `kpis.ts` and two namespaced environment reads —
`ANALYTICS_EMAILBISON_*` in `kpis.ts`, `ANALYTICS_PORTAL_*` in `follow-up.ts` —
each carrying a comment saying why. The workspace talks to four Supabase
projects and two EmailBison-shaped tools in one process; an unprefixed name
collides with Master Inbox's.

Seven of the tool's own test files came across with them and run in
`npm test`: **86 assertions, 20 suites, 0 failures.**

Also copied verbatim, with the same namespacing: `campaigns/` (13 files),
`clients/match.ts`, `emailbison/` (8), `instantly/` (2), `sync/health.ts` and
`sync/schedule.ts`.

**Written for this port, not copied — five files:**

| File | Why it exists |
|---|---|
| `supabase.ts` | Namespaced client. Pre-existing. |
| `overview.ts` | The workspace's own KPI adapter. Pre-existing, still unused by these screens. |
| `session.ts` | The tool's fourteen write routes read `bsa_session` for the **audit actor** — "worthless if it can't name who acted". This exports the same two names with the same signatures against `bs_sso`, so those fourteen files stay byte-identical. |
| `campaigns/spintax-signal.ts` | `hasSpintax` / `spintaxOf`, lifted out of the tool's `sequence-view.tsx`. Two screens ask the question; importing a Tailwind component to reach a regex would drag shadcn in. |
| `sync/schedule.ts` (edit) | `JobName` is derived from the schedule rather than from `jobs.ts`. See §7. |

---

## 2. Shared chrome

| Control | Status | Note |
|---|---|---|
| Tab bar across the five analytics tabs | ⚠️ | The workspace rail IS this. That is the design's stated architectural decision — each tool's navigation lifts out into one rail. |
| Filters carried across tab switches | ⚠️ | The tool appends the query string to every tab link. Here each screen owns its own filter state; moving between rail items starts from the default window. See §3. |
| Quick range pills 7d / 30d / 90d | ✅ | `.qr` |
| Custom range picker, committed on Apply | ✅ | Two date inputs, not a two-month calendar — the tool's rule (nothing refetches until Apply) is what mattered and is kept. An inverted range is swapped by `resolveFilters`, so backwards is a working range rather than an empty screen. |
| Campaigns multi-select, both platforms, searchable | ✅ | Instantly campaigns labelled `· Instantly`, merged and re-sorted by volume. |
| Clients multi-select | ✅ | |
| Platform multi-select | ✅ | Shown on Campaign / Volume / Attribution, exactly as the tool gates it. |
| Compare previous + `vs Jun 1 – Jun 30` | ✅ | Campaign only. |
| Filter bar hidden on Infrastructure | ✅ | After the hooks, so the hook order cannot change between tabs — the tool's own note. |
| Chips with `+N more` that clears all | ✅ | |
| Reply facet filters (company / location / sales volume) | ❌ | The three facet selects on the Replies sub-view. The route (`/replies/facets`) is ported and returns all three facets; the control is not built. The tool's own facets query drops all client and campaign scoping, so the values offered are workspace-wide even when the page is filtered to one client. |
| Staleness strip | ⚠️ | The tool polls `/api/sync/status` every 5 min and shows an amber bar. Here the same data is one API call away and unrendered; the workspace's own status rail already carries Analytics' health through `lib/connectors/analytics.ts`. |
| Credits meter | ❌ | The tool's sidebar fetches `/api/workspace/credits`, **a route that does not exist**, renders null and 404s once per mount. Not ported. Nothing was lost. |
| Sign out, sidebar collapse | ⚠️ | The workspace's own. |

---

## 3. The one architectural difference, stated plainly

**The tool keeps filter state in the URL and changes it with `router.push`.
This port keeps it in React and mirrors it with `history.replaceState`.**

Why: the workspace shell renders exactly one screen per server request and moves
between warm panes with `pushState`, specifically so a screen is not torn down.
A `router.push` from inside a screen asks Next for a fresh RSC payload and
**remounts it** — losing the open accordion, the scroll position and the
sub-view on every filter click.

What survives: a pasted link still opens the view it names (read once, on
mount), and the query string handed to every API route is the tool's own
`filtersToSearchParams`, so client and server cannot disagree about what "7d"
means. CLAUDE.md rule 4 — one zod schema, shared — is intact, which is the
load-bearing half.

**What is lost: Back no longer steps through filter changes.** That is a real
cost. It is here rather than buried.

---

## 4. Campaign (`analytics:campaign`)

| Section | Status | Note |
|---|---|---|
| KPI band, 12 cells in two rows of six | ✅ | The design's `.kpi`, which was written for this screen and had never been used. |
| All twelve tiles, in the tool's order | ✅ | Sent, Prospects, Replies, Human, Positive, Bounces / Median Reply, Median Follow-up, Reply %, Human %, Positive %, Lead:Email |
| Deltas coloured by `upIsGood`, not by sign | ✅ | Bounces rising is not green. |
| `DASH` as the only path for a nullish metric | ✅ | `format.ts`, verbatim. |
| Per-tile coverage note ("EmailBison only") | ✅ | |
| Band-wide scope said once, not twelve times | ✅ | |
| `instantlyExcludedBy: "campaign-filter"` explained in words | ✅ | |
| Prospects from the live EmailBison call | ✅ | 193,743 over 90 days. Needs `ANALYTICS_EMAILBISON_API_KEY`; a dash without it. |
| Median Follow-up from the portal, content-type checked | ✅ | 932s. |
| **Charts** sub-view | | |
| Volume / Rates segmented | ✅ | |
| Series chips, colour by entity, never empty | ✅ | `series.ts` verbatim; the six hexes moved to `palette.ts` because the tool names them as CSS variables that do not exist in this stylesheet. |
| `sent` / `prospects` disabled in Rates mode | ✅ | |
| Positive's rate denominator is Replies, not Sent | ✅ | `toRate`, quoted. |
| Normalize | ✅ | |
| Exclude weekends | ❌ | The route honours `exclude_weekends` and the parser parses it; the checkbox is not built. |
| The chart | ⚠️ | Hand-drawn SVG on the design's unused `.lchart` / `.lc-grid` / `.lc-line` / `.lc-dot` / `.lc-cross` / `.lc-tip` vocabulary, rather than Recharts. A gap is a gap (the path restarts on a null), the comparison line is dashed, drawn under, and paired by index after the route tail-aligns the arrays. |
| Crosshair tooltip listing every active series + the comparison | ✅ | Keyboard-driveable with ← → and Escape. |
| Gradient area fill | ❌ | The hatch pattern is defined and the lines are drawn; the filled area under them is not. |
| **Clients** sub-view | ✅ | Search, nine sortable columns, `Unassigned` highlighted amber and never hidden, ambiguity warning per client, totals band summed from the rendered rows. |
| **Campaigns** sub-view | ✅ | Search, full `COLUMNS` set (24 columns, six groups) behind a column picker persisted to the tool's own `localStorage` key and version. |
| Row expands into sequence steps, lazily | ✅ | Instantly rows deliberately do not expand — `analytics_campaign_steps` keys on a bigint. |
| Step expands again into the email body | ⚠️ | The step table shows subject and per-step figures; the body is on the campaign drill-down instead, as text rather than `dangerouslySetInnerHTML`. |
| Variant medals 🥇🥈🥉 with a 200-send floor | ❌ | Variants are counted in `variantCount` but not nested under their step here. |
| **Replies** sub-view | ✅ | All-replies / Positive-only, breakdown cards per configured dimension, click a bar to drill the list, coverage caveat when Unknown ≥ 20% or the list is truncated. |
| `Unknown` / `Unassigned` bars greyed | ✅ | Real rows — dropping them would stop the bars summing to the reply count. |
| Reply list, 50/page, debounced search | ✅ | |
| **Log outcome / remove outcome** | ✅ | Six stages; the id is `manual:<replyId>:<type>`, so pressing twice is a no-op. Removal is a two-click arm and the route refuses anything the feed owns. |
| The Instantly reply-list crash | ⚠️ **fixed** | The tool renders `reply.logged.map(...)` on Instantly rows, which have no `logged` — a TypeError its own `RowsResponse` type hides. Here `logged` is defaulted and the `platform: "mixed"` refusal is rendered as a sentence rather than an unexplained empty list. |
| **Volume** sub-view | ✅ | Capacity tile with the per-platform split and the red "cannot connect" line; utilisation meter; by-client / by-campaign ranked bars with the "shares will not sum to 100%" footnote. |

---

## 5. Infrastructure (`analytics:infrastructure`)

| Section | Status | Note |
|---|---|---|
| Estate toggle EmailBison / Instantly | ✅ | |
| Degraded banner naming which cards failed | ✅ | The route degrades six cards by name and 500s only on totals/rows. |
| Bounce rate, banded colour, danger line stated | ✅ | |
| Reply rate | ✅ | |
| Domains by bounce band, stacked + share of volume | ✅ | |
| By provider | ✅ | |
| Needs attention, worst bounce first | ✅ | |
| Where bounces land, Provider / Domain toggle | ✅ | |
| Disconnected inboxes | ✅ | |
| Domain / Provider / Vendor / Inbox views | ✅ | |
| Search, band chips, min volume, status, vendor, Clear | ✅ | |
| **Inbox table pages** | ⚠️ **fixed** | The tool renders the route's default 100 rows under a header reading "1,796 inboxes" **with no pager anywhere** — the exact "looks complete at the point it stopped being complete" failure this repo keeps re-learning. This pages. Verified: 100 rows, `1–100 of 1,796`, Next advances. |
| **Instantly's inert controls** | ⚠️ **fixed** | `analytics_instantly_account_rows` takes no sort and no band/provider/status/vendor filter. The tool leaves every control interactive and shows sorted state for an order that did not change; here they are absent on that estate. |
| Provider dropdown data-driven | ❌ | The tool hardcodes two of four providers. Kept as-is — the API accepts a list, the UI offers the two that exist in this workspace. |
| `Clear` also clearing the search box | ⚠️ | Matches the tool: it does not. |
| Lifetime footnote | ✅ | |

---

## 6. Campaigns (`analytics:campaigns`) and the drill-down

### The list

| Control | Status | Note |
|---|---|---|
| Status tabs with counts, `More` for the rest | ✅ | |
| Search | ✅ | |
| Platform filter, clearing the selection on change | ✅ | The rows about to be listed are not the rows that were ticked. |
| Client filter, with Unassigned and Excluded | ✅ | |
| Tag filter, only when tags exist | ✅ | |
| Sortable columns | ✅ | |
| Progress bar, `DASH` and no track for null | ✅ | An empty track claims 0%. |
| Reply-rate chip | ✅ | |
| Unknown status renders red | ✅ | An unknown status is drift. |
| List / Grid toggle | ❌ | List only. |
| Per-row action menu | ❌ | Actions are on the selection bar; ticking one row is one click. |
| **Bulk actions with eligibility counts** | ✅ | `canApply` and `platformSupports` imported from the tool, never restated. |
| **Resume double-armed, naming the lead count** | ✅ | The tool uses a dialog; `window.confirm` elsewhere in it. Resume queues a campaign to SEND — it is not an undo. |
| Result panel, failures first, verbatim platform errors | ✅ | |
| Pagination | ✅ | 200/page. |
| Bulk `Inboxes` and `Re-campaign` buttons | ❌ | See below. |

### The drill-down at `/analytics/campaigns/<id>`

| Tab | Status | Note |
|---|---|---|
| Overview | ✅ | Progress, funnel (no bar at all for a null), ten lifetime figures, the "cumulative counters" caveat. |
| Sequence | ✅ | Per-step accordion, the wait shown is the **previous** step's `wait_in_days`, spintax chip, orphaned-variant marker, variants nested and individually expandable, the "no copy variation" banner. |
| Copy & Offer | ✅ | Offer picker (writes `campaign_offers`); the seven copy dimensions as inputs with a `datalist` of values already in use — which is what stops "Question / question / Questions" becoming three dimensions. First email only, and the screen says why. |
| Settings | ✅ | Name, both caps with the cross-field guard, four toggles, read-only unsubscribe wording. Save is gated on a real change and sends **only the changed keys** — EmailBison defaults an omitted boolean to false. |
| Activity | ✅ | |
| Leads | ❌ | The 431-line leads table with 27 columns, facet chips, select-all-matching and lead removal. Its route is ported and returns 6,390 leads for campaign 55. |
| Email preview | ⚠️ | Rendered as **text**, not `dangerouslySetInnerHTML`. The tool's justification ("the same trust boundary as the sequence editor") is true there and false here — these bodies would be injected into a shell holding four other tools' sessions. Text is also more useful on this screen: spintax and merge tags are what you came to read. |

### Deliberately not built — the irreversible five

Every one of these mutates EmailBison or Instantly in a way no test can undo,
and none can be exercised without doing it for real to a client's campaign.
**Their API routes are ported, compile and are covered by the blast-radius
guard; what is absent is the button.**

| Feature | What firing it does |
|---|---|
| Sequence editor (602 lines) | Replaces a live sequence. `PUT .../sequence` refuses to delete a step with `sent > 0`, runs updates → additions → deletes in that order so the sequence is never briefly empty, and still leaves a window where a campaign can end up with three of four steps. |
| Copy sequence from… | Deletes the target's steps. Its own audit row is the only surviving copy of the previous emails. |
| Push sequence to… | The same, times N targets, serially. |
| Fan-out for multiple clients | Creates one real campaign per client. |
| Re-campaign | Creates a campaign and moves thousands of leads into it. |
| Remove leads | Up to 20,000 leads, "there is no undo". |
| Assign / remove inboxes | Detaches sending inboxes; on Instantly it is a read-modify-write of the whole `email_list`. |

---

## 7. Schedule (`analytics:schedule`)

| Section | Status | Note |
|---|---|---|
| Three days fetched at once, each showing its own total | ✅ | The comparison IS the picker. |
| Client cards with share-of-day bar | ✅ | |
| Campaign rows, status chip only when not `active` | ✅ | A row of identical "active" chips carries no information. |
| Unassigned sorts last | ✅ | |
| Error banner | ✅ | |
| Sync schedule button | ✅ | |
| **"EmailBison only" said out loud** | ⚠️ **added** | The forecast joins EmailBison's sending schedules; Instantly's ~318 campaigns are absent from it. The tool says nothing. |

---

## 8. Clients (`analytics:clients`)

| Section | Status | Note |
|---|---|---|
| Unassigned queue first, collapsible, amber | ✅ | `campaign_clients` is what every analytics RPC joins through: a campaign with no client lands in the KPI band and in nobody's row, and nothing else would look broken. |
| Excluded campaigns left out of the queue | ✅ | A settled decision, not outstanding work — otherwise the queue never reaches zero. |
| `matched 2+ clients` chip | ✅ | |
| Assign to client, per row | ✅ | |
| Roster: name, aliases, match mode, campaign count, pinned count | ✅ | Plus the Instantly split, which the API returns and the tool's own types drop. |
| Create / rename / re-alias / change match mode | ✅ | |
| **Delete, arming twice, naming the consequence** | ✅ | `campaign_clients.client_id` is ON DELETE SET NULL, so its campaigns return to the queue. The armed button says so. |
| Reply groupings per client, copy-on-write | ✅ | Turning one off writes a client-specific row; the shared default is never edited, because deleting it removes the card for every client. Proved in the write test. |
| **Instantly campaigns assignable** | ⚠️ **added — the tool cannot do this at all** | `PUT /campaigns/<uuid>/client` opens with `Number(id)` and 400s, and there is no `instantly_campaign_clients` write path anywhere in the tool — while its own Clients page lists Instantly campaigns in the queue with an Assign dropdown beside them. **84 of the 93 unassigned campaigns are Instantly**, the first carrying 13,023 lifetime sends, and their volume reaches the KPI band and nobody's client row with no way to fix it. The two tables are the same shape, so the branch is the table name and the id type and nothing else. |
| **A pin that touches no row is a 404** | ⚠️ **fixed** | The tool returns `{ok: true}` whether or not the update matched, so pinning a campaign the matcher has never seen reports success and changes nothing. `count: "exact"` turns that into something the screen can say. |

---

## 9. Copy & Offer (`analytics:copy`)

| Section | Status | Note |
|---|---|---|
| Offer cards with the four-stat block | ✅ | |
| By-client breakdown when an offer spans more than one | ✅ | |
| Create offer | ✅ | |
| Edit offer (name, niche) | ✅ | |
| **Delete offer, arming twice** | ✅ | The tool uses `window.confirm`; the consequence text moves to the armed button's title. |
| Suggested groups, with a pre-filled name | ✅ | |
| Create offer from N campaigns | ✅ | |
| Sequence viewer per offer | ❌ | The tool opens a dialog showing the source campaign's sequence. The same sequence is on the campaign drill-down. |
| Copy sequence to a campaign / bulk deploy | ❌ | §6, the irreversible five. |
| "Copy that never changes" | ✅ | Both platforms, with the share of range volume. |
| The dimension table, N dimensions + 8 metrics | ✅ | |
| Add / remove dimension, last one not removable | ✅ | |
| Medals with a 500-send floor | ✅ | `awardMedals`, verbatim. |
| Untagged pinned to the bottom under every sort | ✅ | It is the absence of an answer; letting it win a sort puts "we didn't label this" at the top of a ranking of what works. |
| Row expands into its member emails | ✅ | |
| **The `colSpan` off-by-one** | ⚠️ **fixed** | The tool writes `dimensions.length + 7` in three places against a table of `+ 8` columns, so the expanded row — the payoff of the whole screen — is a column short. |
| **The false footnote** | ⚠️ **fixed** | The tool says "Variants of the first email are included"; `analytics_copy_steps` ends `AND NOT st.is_variant`. This says so, and names the predicate. |
| **"Suggest subject types" visible below 50% coverage** | ⚠️ **fixed** | The tool renders it only when coverage is exactly zero, so it vanishes at 3% — with hundreds of first emails still untagged — which is when it is still worth pressing. It writes only where no tag exists, so showing it more often is safe. |
| Coverage line, amber below half | ✅ | |
| Sync campaigns | ✅ | |

---

## 10. Attribution (`analytics:attribution`)

| Section | Status | Note |
|---|---|---|
| Sync outcomes / Resolve campaigns | ✅ | Both report `skipped` as "a scheduled sync is already running" rather than as a failure. |
| Coverage strip, stacked by platform | ✅ | "Another platform" is a first-class bucket — crediting an Instantly result to an EmailBison campaign is the one failure this tab exists to prevent, and it fails upward. |
| The four counts with their explanations | ✅ | |
| **`byMethod` rendered** | ⚠️ **added** | The tool computes the resolution histogram in SQL, ships it, and renders it nowhere. It is the answer to "how was this decided", which is the question the strip raises. |
| Conversion measures, `1 : N` | ✅ | |
| **The platform mismatch named** | ⚠️ **added** | `emailsSent` comes from `analytics_kpis`, which has no platform parameter, while the outcome counts beside it do. Filter to Instantly and the tool divides EmailBison sends by Instantly outcomes and prints a ratio with no caveat. This says so on the card. |
| Weekly timeline, stacked, last bar dimmed | ✅ | |
| Funnel measured against the FIRST stage | ✅ | These events are logged independently; step-through rates rendered "Interview 288.9%". |
| Where people stopped | ✅ | |
| Campaign table with Show-more | ✅ | |
| Every outcome: search, type facet, source facet, sort, pager | ✅ | |

**Two defects reproduced, not fixed** — both are in SQL this port does not own:

- `analytics_outcome_coverage` takes no client, campaign or platform argument,
  so the coverage strip describes the whole workspace even when the page is
  filtered. Fixing it means changing an RPC in the tool's database.
- `analytics_outcome_campaigns` has no `p_campaign_ids`, so the campaign filter
  is inert on that one table while the funnel and measures beside it narrow.

---

## 11. Safety

| Requirement | Evidence |
|---|---|
| Every `.update()` / `.delete()` scoped | `node --test src/lib/guards/blast-radius.test.ts` — 6/6, including the `analytics` case, which now scans 81 real files instead of an empty directory. 10 updates and 8 deletes across the port, every one carrying `.eq` / `.in` / `.is`. |
| Fingerprint before and after | `.analytics-fingerprint.json`, gitignored by `.*-fingerprint.json`. Slugs hashed; no email, token or key reaches the file. |
| Test on records created and deleted | `scripts/analytics-write-test.mjs` — 40 assertions. Everything it makes is named `ZZ_OS_PORT_TEST_<stamp>`, including a real EmailBison campaign, and the last five assertions prove none of them survives. |
| No `window.confirm` | `grep -rn "confirm(" src/components/screens/analytics` → nothing. Four destructive controls use `ConfirmButton`, which arms for four seconds and carries the consequence in `title` and `aria-label`. |
| No bare `toLocaleString()` on a date | Dates go through `lib/workspace/dates.ts` — `fullStamp`, `dateStamp`, `dayStamp`, `shortStamp`. Numbers use `.toLocaleString("en-US")`, pinned. |
| Nothing overflows the viewport | `scripts/analytics-layout-test.mjs` — 16/16 across 8 screens × 1440px and 1180px, 0px document overflow everywhere. |
| No Tailwind component imported from the tool | `grep -rn "components/ui\|shadcn\|className=\"flex " src/components/screens/analytics` → nothing. The screens use `.an-tabs`, `.an-filter`, `.kpi`, `.seg`, `.segfull`, `.abox`, `.atbl`, `.schip`, `.qr`, `.gh`, `.bar-h`, `.stack`, `.lchart`, `.badge`, `.btn`, `.inp`, `.sel`, `.anno`, `.wrap`, `.cards`, `.tbl-scroll`, `.tnum`. |
| 0 TypeScript errors under `src/` | `npx tsc --noEmit -p tsconfig.json` |

---

## 12. What a reviewer should look at first

1. **`filters.tsx`** — the one architectural difference (§3), and the only place
   this port diverges from the tool by design rather than by omission.
2. **`session.ts`** — the audit actor. If this is wrong, `campaign_audit_log`
   fills with the wrong name and nobody notices until someone needs it.
3. **The five irreversible features in §6.** They are the gap, they are the
   dangerous ones, and the decision not to build a button for them without a
   way to test it is the judgement most worth challenging.
