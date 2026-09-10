/*
 * The Weekly summary — the twenty-four headline numbers.
 *
 * These pin the arithmetic behind the four card bands. The failures they guard
 * against are all the same shape: a number that looks perfectly plausible and
 * is quietly answering a different question than its label.
 *
 *   node --test src/lib/tools/client-health/summarize.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { funnelRates, summarize, allTimeCorofy, type WeeklyRow } from "./summarize.ts";
import type { DashboardClient, WeeklyMetric } from "./types.ts";

const WEEK = "2026-09-07";

function metric(o: Partial<WeeklyMetric> = {}): WeeklyMetric {
  return {
    client_id: "c",
    week_key: WEEK,
    emails_sent: 0,
    replies: 0,
    intros_corofy: 0,
    last_corofy_intro_at: null,
    interested_corofy: 0,
    last_interested_at: null,
    hired_corofy: 0,
    last_hired_at: null,
    ...o,
  };
}

/** A row carrying only what `summarize` reads. */
function row(
  name: string,
  o: Partial<{
    hidden: boolean;
    client_paused: boolean;
    plan: string;
    weekly_target: number;
    monthly_target: number;
    intros_this_month: number;
    total_intros_corofy: number;
    total_interested_corofy: number;
    metricsByWeek: Record<string, WeeklyMetric>;
    campaigns: { emails_sent_total: number; reply_count: number }[];
    bisonCampaigns: { emails_sent_total: number; reply_count: number }[];
    status: "risk" | "ok" | "done" | "pending";
    metTarget: boolean;
    intros: number;
    emails: number;
  }> = {},
): WeeklyRow {
  return {
    client: {
      name,
      hidden: o.hidden ?? false,
      client_paused: o.client_paused ?? false,
      plan: o.plan ?? "production",
      weekly_target: o.weekly_target ?? 3,
      monthly_target: o.monthly_target ?? 0,
      intros_this_month: o.intros_this_month ?? 0,
      total_intros_corofy: o.total_intros_corofy ?? 0,
      total_interested_corofy: o.total_interested_corofy ?? 0,
      metricsByWeek: o.metricsByWeek ?? {},
      campaigns: o.campaigns ?? [],
      bisonCampaigns: o.bisonCampaigns ?? [],
    },
    derived: {
      status: o.status ?? "ok",
      metTarget: o.metTarget ?? false,
      intros: o.intros ?? 0,
      emails: o.emails ?? 0,
    },
  } as unknown as WeeklyRow;
}

// -- who is counted ----------------------------------------------------------

test("hidden clients are counted nowhere; paused ones only on their own card", () => {
  const s = summarize(
    [
      row("Live", { weekly_target: 3, intros: 2 }),
      row("Churned", { hidden: true, weekly_target: 99, intros: 99 }),
      row("Paused", { client_paused: true, weekly_target: 99, intros: 99 }),
    ],
    WEEK,
  );

  assert.equal(s.total, 1, "only the live client is on the roster");
  assert.equal(s.clientPaused, 1);
  assert.equal(s.target, 3, "a churned client's target must not inflate the target");
  assert.equal(s.intros, 2);
});

test("plans are counted per tier", () => {
  const s = summarize(
    [row("a", { plan: "minimum" }), row("b", { plan: "partner" }), row("c", { plan: "partner" })],
    WEEK,
  );
  assert.deepEqual(s.plans, { minimum: 1, production: 0, partner: 2 });
});

// -- the all-time counters ---------------------------------------------------

test("the all-time Corofy counters win over the 26-week sum", () => {
  // The whole point of migration 0016: metricsByWeek only holds 26 weeks, so
  // summing it answers "since March" rather than "all time".
  const c = row("Old", {
    total_intros_corofy: 400,
    total_interested_corofy: 100,
    metricsByWeek: { [WEEK]: metric({ intros_corofy: 3, interested_corofy: 1 }) },
  });

  const s = summarize([c], WEEK);
  assert.equal(s.lifetime.converted, 400);
  assert.equal(s.lifetime.interested, 100);
});

test("a client whose counters are unbackfilled falls back to summing weeks", () => {
  const c = row("New", {
    total_intros_corofy: 0,
    total_interested_corofy: 0,
    metricsByWeek: {
      "2026-08-31": metric({ intros_corofy: 2, interested_corofy: 5 }),
      [WEEK]: metric({ intros_corofy: 3, interested_corofy: 1 }),
    },
  });

  assert.deepEqual(allTimeCorofy(c.client), { converted: 5, interested: 6 });
  const s = summarize([c], WEEK);
  assert.equal(s.lifetime.converted, 5);
  assert.equal(s.lifetime.interested, 6);
});

test("one counter being set is enough to stop the fallback", () => {
  // A client with introductions but nobody currently interested is normal, and
  // must not silently re-read the clipped window for the other half.
  const c = row("Converted everyone", {
    total_intros_corofy: 40,
    total_interested_corofy: 0,
    metricsByWeek: { [WEEK]: metric({ intros_corofy: 9, interested_corofy: 9 }) },
  });
  assert.deepEqual(allTimeCorofy(c.client), { converted: 40, interested: 0 });
});

// -- the lifetime funnel -----------------------------------------------------

test("lifetime emails and replies come from the campaign caches, not the weeks", () => {
  const s = summarize(
    [
      row("A", {
        campaigns: [{ emails_sent_total: 10_000, reply_count: 130 }],
        bisonCampaigns: [{ emails_sent_total: 5_000, reply_count: 70 }],
        // Deliberately different, so a regression that reads these is visible.
        metricsByWeek: { [WEEK]: metric({ emails_sent: 12, replies: 1 }) },
      }),
    ],
    WEEK,
  );

  assert.equal(s.lifetime.emails, 15_000);
  assert.equal(s.lifetime.replies, 200);
});

test("the lifetime rates are the tool's", () => {
  const s = summarize(
    [
      row("A", {
        campaigns: [{ emails_sent_total: 100_000, reply_count: 1_300 }],
        total_intros_corofy: 200,
        total_interested_corofy: 800,
      }),
    ],
    WEEK,
  );
  const r = funnelRates(s.lifetime);

  assert.equal(r.replyRate?.toFixed(1), "1.3", "replies over emails");
  // Positive Reply uses the FULL Corofy interested count, not the
  // campaign-attributed subset — which is why it moves off the reply rate.
  assert.equal(r.positiveReply?.toFixed(1), "61.5", "interested over replies");
  assert.equal(r.convPer1k?.toFixed(1), "2.0", "converted per 1,000 emails");
  assert.equal(r.intToIntro?.toFixed(1), "20.0", "converted over the whole funnel");
});

// -- the this-week funnel ----------------------------------------------------

test("the week funnel reads one weekly_metrics row, including replies", () => {
  const s = summarize(
    [
      row("A", {
        metricsByWeek: {
          "2026-08-31": metric({ emails_sent: 999, replies: 99 }),
          [WEEK]: metric({ emails_sent: 4_000, replies: 60, intros_corofy: 6, interested_corofy: 24 }),
        },
      }),
      row("B", {
        metricsByWeek: { [WEEK]: metric({ emails_sent: 1_000, replies: 20, intros_corofy: 2, interested_corofy: 6 }) },
      }),
    ],
    WEEK,
  );

  assert.deepEqual(s.week, { emails: 5_000, replies: 80, converted: 8, interested: 30 });
  const r = funnelRates(s.week);
  assert.equal(r.replyRate?.toFixed(1), "1.6");
  assert.equal(r.intToIntro?.toFixed(1), "21.1");
});

test("a client with no row for the visible week contributes nothing to it", () => {
  const s = summarize(
    [row("A", { metricsByWeek: { "2026-08-31": metric({ emails_sent: 5_000, replies: 50 }) } })],
    WEEK,
  );
  assert.deepEqual(s.week, { emails: 0, replies: 0, converted: 0, interested: 0 });
});

// -- monthly -----------------------------------------------------------------

test("monthly totals sum per client, and completion needs a target", () => {
  const s = summarize(
    [
      row("A", { monthly_target: 12, intros_this_month: 9 }),
      row("B", { monthly_target: 8, intros_this_month: 3 }),
      // No target: contributes its introductions but no denominator.
      row("C", { monthly_target: 0, intros_this_month: 4 }),
    ],
    WEEK,
  );

  assert.equal(s.monthlyIntros, 16);
  assert.equal(s.monthlyTarget, 20);
  assert.equal(s.monthlyCompletionPct, 80);
});

test("no monthly target anywhere gives 0%, not a division by zero", () => {
  const s = summarize([row("A", { intros_this_month: 5 })], WEEK);
  assert.equal(s.monthlyTarget, 0);
  assert.equal(s.monthlyCompletionPct, 0);
});

// -- rates with no denominator ----------------------------------------------

test("every rate is null rather than zero when its denominator is empty", () => {
  // "Nobody has replied" and "we have sent nothing" are opposite situations,
  // and a 0.0% that means the second is a lie somebody would act on.
  const r = funnelRates({ emails: 0, replies: 0, interested: 0, converted: 0 });
  assert.deepEqual(r, { replyRate: null, positiveReply: null, convPer1k: null, intToIntro: null });
});

test("avgConv only counts clients that actually sent email", () => {
  const s = summarize(
    [
      row("Sent", { emails: 1_000, intros: 3 }),
      // Contributes neither numerator nor denominator — otherwise a client who
      // sent nothing would drag the dashboard average toward zero.
      row("Silent", { emails: 0, intros: 0 }),
    ],
    WEEK,
  );
  assert.equal(s.avgConv, 3);
});

test("avgConv is null when nobody has sent anything", () => {
  assert.equal(summarize([row("Silent")], WEEK).avgConv, null);
});

test("completion is a whole percentage of the weekly target", () => {
  const s = summarize([row("A", { weekly_target: 3, intros: 2 })], WEEK);
  assert.equal(s.completionPct, 67);
});

test("summarising nothing yields zeroes and nulls, not NaN", () => {
  const s = summarize([] as WeeklyRow[], WEEK);
  assert.equal(s.total, 0);
  assert.equal(s.completionPct, 0);
  assert.equal(s.avgConv, null);
  assert.equal(s.intToIntroPct, null);
  assert.deepEqual(s.lifetime, { emails: 0, replies: 0, interested: 0, converted: 0 });
});

test("convertedTotal and interestedTotal mirror the lifetime funnel", () => {
  // Two names for one number; they must not drift apart.
  const s = summarize([row("A", { total_intros_corofy: 7, total_interested_corofy: 3 })], WEEK);
  assert.equal(s.convertedTotal, s.lifetime.converted);
  assert.equal(s.interestedTotal, s.lifetime.interested);
  assert.equal(s.intToIntroPct?.toFixed(0), "70");
});

test("statuses are counted from the derived rows", () => {
  const s = summarize(
    [
      row("r", { status: "risk" }),
      row("o", { status: "ok" }),
      row("d", { status: "done", metTarget: true }),
    ],
    WEEK,
  );
  assert.equal(s.risk, 1);
  assert.equal(s.ok, 1);
  assert.equal(s.done, 1);
});

test("a real DashboardClient shape flows through untouched", () => {
  // A guard against the fixtures above drifting from the actual type.
  const c: Partial<DashboardClient> = {
    name: "Real",
    hidden: false,
    client_paused: false,
    plan: "partner",
    weekly_target: 6,
    monthly_target: 24,
    intros_this_month: 11,
    total_intros_corofy: 90,
    total_interested_corofy: 10,
    campaigns: [],
    bisonCampaigns: [],
    metricsByWeek: {},
  };
  const s = summarize(
    [{ client: c as DashboardClient, derived: { status: "ok", metTarget: false, intros: 4, emails: 900 } } as WeeklyRow],
    WEEK,
  );
  assert.equal(s.total, 1);
  assert.equal(s.plans.partner, 1);
  assert.equal(s.monthlyCompletionPct, 46);
});
