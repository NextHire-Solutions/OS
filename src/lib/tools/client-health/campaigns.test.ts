/*
 * Campaign arithmetic — the progress cell and the campaigns popup.
 *
 * The two failures worth a test here are both invisible on screen:
 *
 *   an UNWEIGHTED roll-up. A mean of per-campaign percentages lets a 40-lead
 *   campaign at 100% cancel a 4,000-lead one at 10%, and the cell shows a
 *   healthy 55% for a client whose real progress is 11%.
 *
 *   counting campaigns that are not running. The row would say "3 active
 *   campaigns" for a client who stopped two of them last month.
 *
 *   node --test src/lib/tools/client-health/campaigns.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  activeCampaigns,
  campaignDetail,
  campaignGroups,
  campaignProgress,
  campaignsLabel,
  clientFunnel,
  hasLaunched,
  type PopupCampaign,
} from "./campaigns.ts";
import type { DashboardClient, InstantlyCampaign, WeeklyMetric } from "./types.ts";

function camp(o: Partial<InstantlyCampaign> & { id: string }): InstantlyCampaign {
  return {
    name: o.id,
    status: "running",
    emails_sent_total: 0,
    campaign_size: 0,
    progress_pct: 0,
    status_changed_at: null,
    reply_count: 0,
    interested_count: 0,
    ...o,
  } as InstantlyCampaign;
}

function client(o: Partial<DashboardClient> = {}): DashboardClient {
  return { campaigns: [], bisonCampaigns: [], metricsByWeek: {}, ...o } as DashboardClient;
}

function metric(o: Partial<WeeklyMetric>): WeeklyMetric {
  return { intros_corofy: 0, interested_corofy: 0, ...o } as WeeklyMetric;
}

// -- which campaigns count ---------------------------------------------------

test("only running campaigns are active, across both sources", () => {
  const c = client({
    campaigns: [camp({ id: "i1" }), camp({ id: "i2", status: "paused" })],
    bisonCampaigns: [camp({ id: "b1" }), camp({ id: "b2", status: "finished" })] as never,
  });
  assert.deepEqual(activeCampaigns(c).map((x) => x.id), ["i1", "b1"]);
});

test("the label distinguishes never-launched from stopped", () => {
  // Different conversations. "Not Active" means nobody has started; "Campaign
  // Paused" means somebody stopped one, which is a question for them.
  assert.equal(campaignsLabel(client()), "Not Active");
  assert.equal(campaignsLabel(client({ campaigns: [camp({ id: "a", status: null })] })), "Not Active");
  assert.equal(campaignsLabel(client({ campaigns: [camp({ id: "a", status: "paused" })] })), "Campaign Paused");
  assert.equal(campaignsLabel(client({ campaigns: [camp({ id: "a", status: "finished" })] })), "Campaign Paused");
  assert.equal(campaignsLabel(client({ campaigns: [camp({ id: "a" })] })), "1 active campaign");
  assert.equal(
    campaignsLabel(client({ campaigns: [camp({ id: "a" }), camp({ id: "b" })] })),
    "2 active campaigns",
  );
});

test("a running campaign wins over a paused one for the label", () => {
  const c = client({ campaigns: [camp({ id: "a" }), camp({ id: "b", status: "paused" })] });
  assert.equal(campaignsLabel(c), "1 active campaign");
  assert.equal(hasLaunched(c), true);
});

// -- progress ----------------------------------------------------------------

test("the roll-up is weighted by leads, not a mean of percentages", () => {
  const small = camp({ id: "small", campaign_size: 40, progress_pct: 100, emails_sent_total: 120 });
  const big = camp({ id: "big", campaign_size: 4_000, progress_pct: 10, emails_sent_total: 1_200 });

  const p = campaignProgress([small, big]);

  assert.equal(p.totalLeads, 4_040);
  assert.equal(p.completedLeads, 440, "40 + 400");
  assert.equal(p.pct.toFixed(1), "10.9", "a mean would have said 55.0");
  assert.equal(p.sent, 1_320);
});

test("picking one campaign shows only that campaign", () => {
  const a = camp({ id: "a", campaign_size: 100, progress_pct: 50, emails_sent_total: 500 });
  const b = camp({ id: "b", campaign_size: 900, progress_pct: 10, emails_sent_total: 90 });

  const p = campaignProgress([a, b], "a");
  assert.deepEqual(
    { sent: p.sent, totalLeads: p.totalLeads, completedLeads: p.completedLeads, pct: p.pct },
    { sent: 500, totalLeads: 100, completedLeads: 50, pct: 50 },
  );
});

test("the roll-up sentinel and a stale id both fall back to every campaign", () => {
  // A campaign selected in the dropdown can stop running before the next
  // render. Falling back is right; throwing or showing zeroes is not.
  const list = [camp({ id: "a", campaign_size: 10, progress_pct: 100, emails_sent_total: 7 })];
  for (const selection of ["__avg__", "gone", null, undefined]) {
    assert.equal(campaignProgress(list, selection).completedLeads, 10, `selection ${selection}`);
  }
});

test("no leads anywhere is 0%, not a division by zero", () => {
  const p = campaignProgress([camp({ id: "a", campaign_size: 0, progress_pct: 0 })]);
  assert.equal(p.pct, 0);
  assert.ok(Number.isFinite(p.pct));
});

test("progress over an empty list is all zeroes", () => {
  assert.deepEqual(campaignProgress([]), { sent: 0, totalLeads: 0, completedLeads: 0, pct: 0 });
});

// -- the popup ---------------------------------------------------------------

test("campaigns group by vendor and sort running, paused, finished", () => {
  const c = client({
    campaigns: [
      camp({ id: "i-finished", status: "finished" }),
      camp({ id: "i-running", status: "running" }),
      camp({ id: "i-paused", status: "paused" }),
    ],
    bisonCampaigns: [camp({ id: "b-running" })] as never,
  });

  const g = campaignGroups(c);
  assert.deepEqual(g.instantly.map((x) => x.id), ["i-running", "i-paused", "i-finished"]);
  assert.deepEqual(g.all.map((x) => x.id), ["i-running", "i-paused", "i-finished", "b-running"]);
  assert.deepEqual(g.running.map((x) => x.id), ["i-running", "b-running"]);
});

test("within one status, the most recently changed comes first", () => {
  const c = client({
    campaigns: [
      camp({ id: "old", status: "paused", status_changed_at: "2026-01-01T00:00:00Z" }),
      camp({ id: "new", status: "paused", status_changed_at: "2026-09-01T00:00:00Z" }),
    ],
  });
  assert.deepEqual(campaignGroups(c).instantly.map((x) => x.id), ["new", "old"]);
});

test("vendor headings appear only when both vendors have campaigns", () => {
  assert.equal(campaignGroups(client({ campaigns: [camp({ id: "a" })] })).showHeaders, false);
  assert.equal(
    campaignGroups(client({ campaigns: [camp({ id: "a" })], bisonCampaigns: [camp({ id: "b" })] as never }))
      .showHeaders,
    true,
  );
});

test("the header's email figure counts only running campaigns", () => {
  const c = client({
    campaigns: [
      camp({ id: "on", emails_sent_total: 1_000 }),
      camp({ id: "off", status: "paused", emails_sent_total: 9_000 }),
    ],
  });
  assert.equal(campaignGroups(c).totalSent, 1_000);
});

test("each source is tagged, so a merged list can be keyed without collisions", () => {
  const c = client({ campaigns: [camp({ id: "x" })], bisonCampaigns: [camp({ id: "x" })] as never });
  const g = campaignGroups(c);
  assert.deepEqual(g.all.map((x) => `${x.source}:${x.id}`), ["instantly:x", "bison:x"]);
});

// -- one popup row -----------------------------------------------------------

const popup = (o: Partial<PopupCampaign>): PopupCampaign =>
  ({ id: "c", name: "c", status: "running", emails_sent_total: 0, campaign_size: 0,
     progress_pct: 0, source: "instantly", reply_count: 0, interested_count: 0, ...o }) as PopupCampaign;

test("a campaign row computes its own reply and positive rates", () => {
  const d = campaignDetail(popup({
    emails_sent_total: 10_000, reply_count: 200, interested_count: 50,
    campaign_size: 500, progress_pct: 40,
  }));

  assert.equal(d.replyPct?.toFixed(1), "2.0");
  assert.equal(d.positivePct?.toFixed(1), "25.0");
  assert.equal(d.completed, 200, "40% of 500 leads");
  assert.equal(d.label, "Running");
});

test("a campaign that has sent nothing has no reply rate", () => {
  const d = campaignDetail(popup({ emails_sent_total: 0, reply_count: 0 }));
  assert.equal(d.replyPct, null);
  assert.equal(d.positivePct, null);
});

test("progress over 100 is clamped, and a null status reads as Draft", () => {
  // Vendors do occasionally report 100.4%; a bar wider than its track is worse
  // than a rounded one.
  const d = campaignDetail(popup({ progress_pct: 140, campaign_size: 100, status: null }));
  assert.equal(d.pct, 100);
  assert.equal(d.completed, 100);
  assert.equal(d.label, "Draft");
});

test("the status labels are the tool's own words", () => {
  assert.equal(campaignDetail(popup({ status: "paused" })).label, "Campaign Paused");
  assert.equal(campaignDetail(popup({ status: "finished" })).label, "Finished");
});

// -- the per-client funnel ---------------------------------------------------

test("a row's funnel sums the loaded weeks, matching the column that sorts it", () => {
  // Deliberately NOT the all-time counters. The tool's row cells and its
  // Interested / Converted sorts both sum metricsByWeek, and a cell that
  // disagreed with the sort ordering it would be its own bug.
  const c = client({
    total_intros_corofy: 999,
    total_interested_corofy: 999,
    metricsByWeek: {
      w1: metric({ intros_corofy: 3, interested_corofy: 7 }),
      w2: metric({ intros_corofy: 2, interested_corofy: 8 }),
    },
  });

  const f = clientFunnel(c);
  assert.equal(f.converted, 5);
  assert.equal(f.interested, 15);
  assert.equal(f.ratePct?.toFixed(1), "25.0");
});

test("a client nobody has replied to has no conversion rate", () => {
  assert.equal(clientFunnel(client()).ratePct, null);
});
