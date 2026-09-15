# Wiring Campaign Analytics into the workspace

Everything the seven Analytics destinations need is built, tested and compiling.
None of it is reachable from the rail yet, because the file that would connect it
— `src/app/[[...slug]]/page.tsx` — is shared by every agent working in this repo
and a simultaneous edit there is how two people's work destroys each other.

This is the change, in full. It is additive: nine imports and nine entries.

---

## 1. The edit to `src/app/[[...slug]]/page.tsx`

**Add these imports** beside the other screen imports:

```ts
import { AnalyticsCampaignScreen } from "@/components/screens/analytics/campaign";
import { AnalyticsInfrastructureScreen } from "@/components/screens/analytics/infrastructure";
import { AnalyticsAttributionScreen } from "@/components/screens/analytics/attribution";
import { AnalyticsCopyScreen } from "@/components/screens/analytics/copy";
import { AnalyticsCampaignsScreen } from "@/components/screens/analytics/campaigns";
import { CampaignDetailScreen } from "@/components/screens/analytics/campaign-detail";
import { AnalyticsScheduleScreen } from "@/components/screens/analytics/schedule";
import { AnalyticsClientsScreen } from "@/components/screens/analytics/clients";
```

**Add these entries** inside `screens={pick(initialId, { … })}`:

```tsx
/*
 * Campaign Analytics, read and written against the tool's own database
 * through the tool's own route handlers. The live app keeps running; its
 * Railway cron service is still what drives the sync jobs (see §4).
 *
 * No loader and no `initial` prop, deliberately — the same choice Agent
 * Search makes and for a sharper reason: every one of these screens is
 * driven by a filter bar, so a server-rendered snapshot taken with the
 * default window would be thrown away by the first chip a person clicks.
 * They fetch `/api/tools/analytics/*` on mount and stay mounted.
 */
"analytics:campaign": <AnalyticsCampaignScreen />,
"analytics:infrastructure": <AnalyticsInfrastructureScreen />,
"analytics:attribution": <AnalyticsAttributionScreen />,
"analytics:copy": <AnalyticsCopyScreen />,
/*
 * /analytics/campaigns is the list; /analytics/campaigns/<id> is one
 * campaign. Same shape as `inbox:portals` above, and the same lesson
 * applies — this screen renders on every request, so it must ask whether
 * the URL really belongs to it rather than whether a segment exists.
 */
"analytics:campaigns": (() => {
  const parts = slug ?? [];
  const id =
    parts[0] === "analytics" && parts[1] === "campaigns" ? parts[2] : undefined;
  return id ? <CampaignDetailScreen id={id} /> : <AnalyticsCampaignsScreen />;
})(),
"analytics:schedule": <AnalyticsScheduleScreen />,
"analytics:clients": <AnalyticsClientsScreen />,
```

Nothing else in that file changes. No loader belongs in the `Promise.all`.

**Then delete `src/app/analytics-preview/` and
`src/components/screens/analytics/preview.tsx`**, and point the two test scripts
at the real addresses:

```
scripts/analytics-ui-test.mjs       const P = "/analytics"   (was "/analytics-preview")
scripts/analytics-layout-test.mjs   const P = "/analytics"
```

The preview exists only because this port could not make the edit above. It
renders the same components inside the same `.app` / `.stage` / `.scroll` /
`section.screen.on` frame, so every measurement taken through it holds.

---

## 2. Navigation the port could not add

`src/lib/workspace/nav.ts` is also off-limits to this port. Two decisions are
the owner's, and neither blocks anything:

**a. The campaign drill-down has no `path`.** The Campaigns list links to
`/analytics/campaigns/<id>`, which `idForPath` already resolves to
`analytics:campaigns` (an unrecognised third segment falls through to the leaf,
which is the behaviour the entry above relies on). It needs no nav leaf — a
campaign is a row you open, not a place you go. Nothing to change.

**b. `/analytics/volume` has no destination and is currently folded into the
Campaign screen** as a fifth segment beside Charts / Clients / Campaigns /
Replies. That follows `nav.ts`'s own stated rule — a segmented control that
"switches how one dataset is drawn" stays inside the tool — and Volume answers
"where did the sending go" over the same filters and the same window.

If you would rather it were a rail item, add one leaf:

```ts
{ id: "volume", label: "Volume", path: "/analytics/volume", verified: true },
```

and split `VolumeView` out of `campaign.tsx` into its own screen. It is already
a self-contained component taking one `qs` prop.

---

## 3. Environment

Six variables were added to `.env.local` during this port. All six are
**namespaced copies of credentials this workspace already held** — nothing new
was issued, and nothing was written into a committed file.

| Variable | What it is | Why |
|---|---|---|
| `ANALYTICS_EMAILBISON_BASE_URL` | `https://send.brokerstaffer.com` | Prospects on the KPI band is a live EmailBison call — `campaign_day_stats` sums per-day distinct counts and overcounts a range, so the number has to come from upstream |
| `ANALYTICS_EMAILBISON_API_KEY` | same value as `MASTER_INBOX_EMAILBISON_API_KEY` | verified to be the same workspace: August reads 224,708 sent in the analytics database against 224,709 from this endpoint, and bounces match exactly at 2,583 |
| `ANALYTICS_INSTANTLY_BASE_URL` | `https://api.instantly.ai` | the Instantly client's default host |
| `ANALYTICS_INSTANTLY_API_KEY` | same value as `MASTER_INBOX_INSTANTLY_API_KEY` | needed by the Instantly campaign actions |
| `ANALYTICS_PORTAL_BASE_URL` | `https://inbox.brokerstaffer.com` | Median Follow-up Time comes from the Master Inbox's public `/api/metrics/follow-up-time`. The tool calls it `PORTAL_BASE_URL` because the portal is served by that app |
| `ANALYTICS_PORTAL_TOKEN` | a placeholder | the endpoint accepts a `token` parameter and ignores it; the variable exists so the tool's own `fetchPortal` is unmodified |

Without the first two, Prospects renders as a dash. Without the last two, Median
Follow-up Time does. Both degrade exactly as the tool degrades — `format.ts`
turns null into `DASH` — so neither is load-bearing for the rest of the screen.

`.env.example` should gain the names (values blank) when this ships. It is a
committed file, so this port did not touch it.

`ANALYTICS_SUPABASE_URL`, `ANALYTICS_SUPABASE_SERVICE_ROLE_KEY` and
`ANALYTICS_TEAM_ID` were already present and already undocumented in
`.env.example`. Worth adding at the same time.

---

## 4. What must move before the tool can be switched off

The screens are done. Two things are not code, and both are deployment moves:

**a. The sync engine.** `src/lib/sync/jobs.ts` and `instantly-jobs.ts` in the
tool are ~3,000 lines of cursor-walking, rate-limited work against EmailBison
and Instantly, driven by a **Railway cron service** that runs
`scripts/cron-dispatch.mjs` every ten minutes and fires whatever
`schedule.ts` says is due. That container is what keeps every table on these
screens current.

This port deliberately did not copy it. Two schedulers on the same tables would
be safe — `runJob` holds a `sync_state.running_since` lock — and pointless: the
same work from two processes, and every future job written twice or drifting.
What it did copy is `sync/schedule.ts` (the cadences, which are the staleness
thresholds) and `sync/health.ts`, so `/api/tools/analytics/sync/status` reads
the same answer the tool publishes.

`POST /api/tools/analytics/sync/run` therefore calls the tool's own
`/api/cron/<job>` with `ANALYTICS_CRON_SECRET` — the credential the workspace
already holds and already uses for `/api/cron/status`. **That is the one thing
that breaks when the tool is switched off.** The fix is to keep the cron service
and the worker it points at alive, or to move `jobs.ts` into a worker of its own.
It is not a UI decision and it should not be made by whoever wires the screens.

**b. `ENABLE_RECONCILE` and the tool's login.** Neither is used here.

---

## 5. What this port did NOT build

Written out so nothing is quietly missing. Full detail, control by control, is
in `ANALYTICS-PARITY.md`.

The campaign drill-down has six tabs in the tool. Overview, Sequence, Copy &
Offer, Settings and Activity are built and write where the tool writes. **Leads,
the sequence EDITOR and the five bulk dialogs are not** — copy-sequence, push,
fan-out, re-campaign, remove-leads and assign-inboxes. Every one of them mutates
EmailBison or Instantly irreversibly: replacing a live sequence, creating
campaigns, detaching inboxes, removing thousands of leads from a client's
campaign. Their **API routes are ported and compile**; what is absent is the
surface that fires them, because none can be proved without doing it for real
to a client's campaign.

The four campaign actions (pause / resume / archive / duplicate) ARE built and
wired on the Campaigns screen, with the tool's own eligibility rules imported
rather than restated. They were tested at their guards — the 428 that resume
requires, the eligibility filter, the platform refusal — and the EmailBison
write path was proved end to end through the settings route on a campaign the
test created and deleted. No action was fired at a client's campaign.

---

## 6. Files added by this port

```
src/lib/tools/analytics/            58 files (the tool's own lib, namespaced)
src/app/api/tools/analytics/        41 route handlers
src/components/screens/analytics/   16 files (13 screens and shared parts, 1 harness)
src/app/analytics-preview/          1 harness route — DELETE after §1
scripts/analytics-fingerprint.mjs   before/after proof, hashes what it must not print
scripts/analytics-api-test.mjs      27 routes, asserted on their data not their status
scripts/analytics-ui-test.mjs       8 screens driven over CDP, 27 interactions
scripts/analytics-layout-test.mjs   8 screens × 2 widths
scripts/analytics-write-test.mjs    40 assertions, every row created and deleted
```

No existing file was modified except `.env.local` (§3) and the four stale
library files under `src/lib/tools/analytics/`, which were refreshed from the
source at `6d7ebb8` — see `ANALYTICS-PARITY.md` §1.
