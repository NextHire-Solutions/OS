/*
 * Clients billed per lead, as Client Health measures them (12 Nov 2026 — per-lead.ts).
 *
 * Amy's two clients read 0 introductions, At Risk, with introductions "carried" they were never owed, while their
 * Billing tab had their leads right: Homebase 2 of its cap of 2 (Oct 28 – Nov 24), Hetherington 1 of 4 (Nov 5 –
 * Dec 2). These pin that Client Health now shows the Billing tab's numbers for them, and nothing moves for anyone else.
 *
 *   node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs --test src/lib/tools/client-health/per-lead.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { billingDueInWeek, billingSnapshot } from "./billing.ts";
import { clientScore, derive } from "./derive.ts";
import { applyFilters } from "./filters.ts";
import {
  completedLeadWindows, healthDueInWeek, healthSnapshot, leadCapOf, leadSnapshot, leadsOfWeek, perLeadPeriod, planName, type PerLead,
} from "./per-lead.ts";
import { deriveRows, summarize } from "./summarize.ts";
import { sortWeekly } from "./sorting.ts";
import type { DashboardClient } from "./types.ts";
import { biweeklyRows } from "./views.ts";

const day = (s: string) => s.slice(0, 10);
/** The moment a day's evening falls on, Eastern: what billing's lead `at` looks like. */
const lead = (d: string, hour = "18") => ({ day: d, at: `${d}T${hour}:00:00.000Z` });

function perLead(o: Partial<PerLead> = {}): PerLead {
  const p = { anchor: "2026-11-05", everyDays: 14 as const, priceCents: 25_000, spendCapCents: null, live: true, leads: [], error: null, ...o };
  // Counted from the first day unless a test says otherwise; nothing is counted when the leads couldn't be read.
  return { ...p, countedFrom: o.countedFrom !== undefined ? o.countedFrom : p.leads === null ? null : p.anchor };
}

function client(name: string, o: Record<string, unknown> = {}): DashboardClient {
  return {
    id: name, name,
    plan: "production", weekly_target: 3,
    hidden: false, client_paused: false,
    start_date: "2026-11-02",
    billing_anchor_date: "2026-11-06", billing_interval: "biweekly", billing_interval_days: null,
    intros_since_last_billing: 0,
    monthly_target: 4, intro_dates: [],
    time_zone: null, last_lead_activity_at: null,
    stagnant_intros_count: 0, dnc_count: 0, agents_count: 0,
    total_intros_corofy: 0, total_interested_corofy: 0,
    campaigns: [], bisonCampaigns: [], metricsByWeek: {},
    ...o,
  } as unknown as DashboardClient;
}

/** Thursday 12 Nov 2026, 1pm Eastern: the day Amy's question was looked into. */
const NOW = new Date("2026-11-12T18:00:00Z");

const HETHERINGTON = client("Hetherington Team, Compass", {
  monthly_target: 4,
  per_lead: perLead({ anchor: "2026-11-05", leads: [lead("2026-11-10", "17")] }),
});
const HOMEBASE = client("Homebase", {
  monthly_target: 2, billing_anchor_date: "2026-10-28", start_date: "2026-10-28",
  per_lead: perLead({ anchor: "2026-10-28", leads: [lead("2026-11-03", "00"), lead("2026-11-03", "04")] }),
});

// -- the two clients Amy asked about --------------------------------------------------------------------------

test("Hetherington: 1 of its cap of 4 for Nov 5 – Dec 2, on track, as its Billing tab says", () => {
  const s = leadSnapshot(HETHERINGTON, NOW)!;
  assert.equal(s.period.delivered, 1);
  assert.equal(s.period.target, 4, "the cap is its Monthly target");
  assert.equal(day(s.period.start.toISOString()), "2026-11-05", "the window counts from the Billing tab's first day, not Client Health's Nov 6");
  assert.equal(day(s.period.end.toISOString()), "2026-12-03");
  assert.equal(s.period.elapsedDays, 7, "whole days gone since Nov 5, as billing.ts counts them for everyone else");
  assert.equal(s.period.expected, 1);
  assert.equal(s.status, "ok");
  assert.equal(s.period.carryIn, 0);
});

test("Hetherington's billing period is the Billing tab's: Nov 5 – Nov 18, charged from Nov 19, 1 lead in it", () => {
  const s = leadSnapshot(HETHERINGTON, NOW)!;
  assert.equal(day(s.cycle.start.toISOString()), "2026-11-05");
  assert.equal(day(s.cycle.end.toISOString()), "2026-11-19");
  assert.equal(s.cycle.delivered, 1);
  assert.equal(s.cycle.target, 0, "no lead is due in a period");
  assert.equal(s.cycle.required, 0);
  assert.equal(s.cycle.remaining, 0);
  assert.equal(s.cycle.carryIn, 0, "nothing is ever carried");
});

test("Homebase: 2 of its cap of 2 for Oct 28 – Nov 24 is Done, not At Risk with one carried", () => {
  const before = billingSnapshot({ ...HOMEBASE, per_lead: null } as never, NOW)!;
  assert.equal(before.status, "risk", "what it showed: by introductions, of which it gets none");
  assert.ok(before.cycle.carryIn > 0, "and a carried introduction it was never owed");

  const s = leadSnapshot(HOMEBASE, NOW)!;
  assert.equal(s.status, "done");
  assert.equal(s.period.delivered, 2);
  assert.equal(s.period.target, 2);
  assert.equal(day(s.period.start.toISOString()), "2026-10-28");
  assert.equal(day(s.period.end.toISOString()), "2026-11-25");
  // Its second billing period, Nov 11 – Nov 24: no lead yet (its campaigns paused at the cap).
  assert.equal(day(s.cycle.start.toISOString()), "2026-11-11");
  assert.equal(day(s.cycle.end.toISOString()), "2026-11-25");
  assert.equal(s.cycle.delivered, 0);
});

// -- the rules ------------------------------------------------------------------------------------------------

test("behind an even pace to the cap is At Risk; at the cap is Done", () => {
  const c = client("A", { monthly_target: 4, per_lead: perLead({ anchor: "2026-11-05", leads: [lead("2026-11-06")] }) });
  // 19 whole days have gone by Nov 24: 4 × 19 / 28 = 2.7, so 2 are expected by now.
  assert.equal(leadSnapshot(c, new Date("2026-11-24T18:00:00Z"))!.status, "risk");
  const full = client("B", { monthly_target: 2, per_lead: perLead({ anchor: "2026-11-05", leads: [lead("2026-11-06"), lead("2026-11-07")] }) });
  assert.equal(leadSnapshot(full, new Date("2026-11-08T18:00:00Z"))!.status, "done");
});

test("a new window starts empty: leads count in the window that holds their day", () => {
  const c = client("A", { monthly_target: 2, per_lead: perLead({ anchor: "2026-10-28", leads: [lead("2026-11-24"), lead("2026-11-25")] }) });
  const last = leadSnapshot(c, new Date("2026-11-24T18:00:00Z"))!;
  assert.equal(last.period.delivered, 1, "Nov 24 is the old window's last day");
  const next = leadSnapshot(c, new Date("2026-11-25T18:00:00Z"))!;
  assert.equal(day(next.period.start.toISOString()), "2026-11-25");
  assert.equal(next.period.delivered, 1, "Nov 25 opens the next");
  assert.equal(next.period.elapsedDays, 0, "its first day has only begun");
});

test("days are Eastern, as billing's are: 11pm Eastern on Nov 24 is still Nov 24", () => {
  const c = client("A", { monthly_target: 2, per_lead: perLead({ anchor: "2026-10-28", leads: [lead("2026-11-24")] }) });
  const lateEvening = new Date("2026-11-25T04:00:00Z"); // 11pm Eastern, Nov 24
  assert.equal(day(leadSnapshot(c, lateEvening)!.period.start.toISOString()), "2026-10-28");
});

test("a lead on a window's first day belongs to that window only, and a Monday's to its own week", () => {
  const c = client("A", { monthly_target: 2, per_lead: perLead({ anchor: "2026-10-28", leads: [lead("2026-11-24"), lead("2026-11-25")] }) });
  assert.deepEqual(completedLeadWindows(c, new Date("2026-12-30T18:00:00Z"), 4), [
    { target: 2, delivered: 1 },
    { target: 2, delivered: 1 },
  ], "Nov 24 closes the first window; Nov 25 opens the second");
  assert.equal(leadsOfWeek(perLead({ leads: [lead("2026-11-15"), lead("2026-11-16")] }), "2026-11-09").count, 1, "Monday Nov 16 starts the next week");
});

test("a past week is seen as it was: later leads don't count", () => {
  const sunday = new Date("2026-11-08T12:00:00Z");
  assert.equal(leadSnapshot(HETHERINGTON, sunday)!.period.delivered, 0, "its lead came on Nov 10");
});

test("before its first day: nothing counted, nothing expected", () => {
  const c = client("A", { monthly_target: 4, per_lead: perLead({ anchor: "2026-11-20" }) });
  const s = leadSnapshot(c, NOW)!;
  assert.equal(s.period.elapsedDays, 0);
  assert.equal(s.period.expected, 0);
  assert.equal(day(s.cycle.end.toISOString()), "2026-12-04", "its first charge: the end of its first period");
});

test("no cap at all is Pending, as a client with no target is", () => {
  const c = client("A", { monthly_target: 0, per_lead: perLead() });
  assert.equal(leadCapOf(c), null);
  assert.equal(leadSnapshot(c, NOW)!.status, "pending");
});

test("the cap is the Billing tab's: the Monthly target, or the spend limit when it buys fewer", () => {
  assert.equal(leadCapOf(client("A", { monthly_target: 6, per_lead: perLead({ spendCapCents: 100_000 }) })), 4, "$1,000 at $250 is 4");
  assert.equal(leadCapOf(client("B", { monthly_target: 3, per_lead: perLead({ spendCapCents: 100_000 }) })), 3);
  assert.equal(leadCapOf(client("C", { monthly_target: 0, per_lead: perLead({ spendCapCents: 50_000 }) })), 2);
  assert.equal(leadCapOf(client("D", { monthly_target: 4, per_lead: perLead({ spendCapCents: 10_000 }) })), 4, "a limit that buys none is ignored, never a cap of 0");
});

test("leads that couldn't be counted are unknown, never 0", () => {
  const c = client("A", { per_lead: perLead({ leads: null, error: "label history missing" }) });
  assert.equal(leadSnapshot(c, NOW), null);
  assert.equal(healthSnapshot(c, NOW), null);
});

// -- what can't be counted is never 0 ----------------------------------------------------------------------------

test("leads complete only from a later window: earlier weeks and windows are unknown, the current one is counted", () => {
  const p = perLead({ anchor: "2026-10-28", countedFrom: "2026-11-25", leads: [lead("2026-11-26")] });
  const c = client("A", { monthly_target: 2, per_lead: p });
  assert.equal(leadSnapshot(c, new Date("2026-11-30T18:00:00Z"))!.period.delivered, 1, "the window that was read");
  assert.equal(leadSnapshot(c, new Date("2026-11-08T12:00:00Z")), null, "a week in the window that couldn't be read");
  assert.deepEqual(leadsOfWeek(p, "2026-11-02"), { count: null, lastAt: null });
  assert.equal(leadsOfWeek(p, "2026-11-23").count, null, "a week that starts before it is only partly known");
  assert.equal(leadsOfWeek(p, "2026-11-30").count, 0);
  assert.deepEqual(completedLeadWindows(c, new Date("2027-01-30T18:00:00Z"), 4), [{ target: 2, delivered: 1 }, { target: 2, delivered: 0 }], "only the windows that were read");
});

test("leads that couldn't be read: the week is unknown, not 0, and its billing dates still show", () => {
  const c = client("A", {
    per_lead: perLead({ leads: null, error: "label history missing" }),
    metricsByWeek: { "2026-11-09": { emails_sent: 1072, intros_corofy: 0, last_corofy_intro_at: null } },
  });
  const d = derive(c, "2026-11-09");
  assert.equal(d.leadsUnknown, true);
  assert.equal(d.convPct, null, "no 0.0% from a count nobody has");
  assert.equal(d.daysSince, null);
  const [row] = biweeklyRows([c], NOW);
  assert.equal(day(new Date(row.billing!).toISOString()), "2026-11-19", "still its Billing tab's date, not 'no billing date'");
  assert.equal(row.required, null);
  const period = perLeadPeriod(c.per_lead!, NOW);
  assert.deepEqual([day(period.start.toISOString()), day(period.end.toISOString())], ["2026-11-05", "2026-11-19"]);
});

test("a week whose leads couldn't be counted sinks when sorted by Intros This Week, whichever way", () => {
  const unknown = client("Unknown", { per_lead: perLead({ leads: null, error: "x" }) });
  const known = client("Known", { per_lead: perLead({ leads: [lead("2026-11-10")] }) });
  const rows = deriveRows([unknown, known], "2026-11-09", NOW, new Date("2026-11-09T00:00:00Z"));
  for (const dir of ["desc", "asc"] as const) assert.deepEqual(sortWeekly(rows, { col: "intros", dir }, NOW).map((r) => r.client.name), ["Known", "Unknown"]);
});

// -- everyone else is untouched --------------------------------------------------------------------------------

test("a client not billed per lead gets billing.ts's snapshot and due, exactly", () => {
  const c = client("Old plan", { per_lead: null, monthly_target: 8, intro_dates: ["2026-11-07", "2026-11-09"] });
  const input = { ...c, monthly_target: 8, intro_dates: ["2026-11-07", "2026-11-09"] };
  assert.deepEqual(healthSnapshot(c, NOW), billingSnapshot(input, NOW));
  const monday = new Date("2026-11-16T00:00:00Z");
  assert.deepEqual(healthDueInWeek(c, monday, NOW), billingDueInWeek(input, monday, NOW));
  assert.equal(planName(c), "Production");
});

test("a client billed per lead is never due introductions", () => {
  assert.equal(healthDueInWeek(HETHERINGTON, new Date("2026-11-16T00:00:00Z"), NOW), null);
  assert.equal(planName(HETHERINGTON), "Pay per lead");
});

// -- every screen reads the same numbers ----------------------------------------------------------------------

test("its week counts its leads, and its last lead is the last up to that week", () => {
  const p = perLead({ leads: [lead("2026-11-03"), lead("2026-11-10"), lead("2026-11-11")] });
  assert.deepEqual(leadsOfWeek(p, "2026-11-09"), { count: 2, lastAt: "2026-11-11T18:00:00.000Z" });
  assert.deepEqual(leadsOfWeek(p, "2026-11-02"), { count: 1, lastAt: "2026-11-03T18:00:00.000Z" });

  const c = client("A", { per_lead: p, metricsByWeek: { "2026-11-09": { emails_sent: 1000, intros_corofy: 0, last_corofy_intro_at: null } } });
  const d = derive(c, "2026-11-09");
  assert.equal(d.intros, 2, "Intros This Week shows its leads");
  assert.equal(d.convPct, 2, "2 leads per 1,000 emails");
  assert.notEqual(d.daysSince, null, "Last Intro is its last lead, not 'No data'");
});

test("Overview and Delivery rows use the lead numbers", () => {
  const [het, hb] = deriveRows([HETHERINGTON, HOMEBASE], "2026-11-09", NOW, new Date("2026-11-09T00:00:00Z"));
  assert.equal(het.snap?.status, "ok");
  assert.equal(hb.snap?.status, "done");
  assert.equal(hb.due, null);

  const [bh, bb] = biweeklyRows([HETHERINGTON, HOMEBASE], NOW);
  assert.equal(bh.intros, 1, "leads this billing period");
  assert.equal(bh.required, null, "none required");
  assert.equal(bh.leftCycle, null, "none left, so not counted as short");
  assert.equal(day(new Date(bh.billing!).toISOString()), "2026-11-19");
  assert.equal(bb.intros, 0);
});

test("the summary counts their status and plan, but keeps leads out of the introduction totals", () => {
  const old = client("Old plan", {
    monthly_target: 8, billing_anchor_date: "2026-11-05", intro_dates: ["2026-11-07", "2026-11-09"],
    metricsByWeek: { "2026-11-09": { emails_sent: 500, intros_corofy: 1, last_corofy_intro_at: "2026-11-09T15:00:00Z" } },
  });
  const het = { ...HETHERINGTON, metricsByWeek: { "2026-11-09": { emails_sent: 1072, intros_corofy: 0, last_corofy_intro_at: null } } } as unknown as DashboardClient;
  const rows = deriveRows([old, het, HOMEBASE], "2026-11-09", NOW, new Date("2026-11-09T00:00:00Z"));
  const s = summarize(rows, "2026-11-09");
  assert.deepEqual(s.plans, { minimum: 0, production: 1, partner: 0, perLead: 2 });
  assert.equal(s.done, 1, "Homebase at its cap");
  assert.equal(s.intros, 1, "only the old-plan client's introduction");
  assert.equal(s.monthlyTarget, 8, "a lead cap isn't an introduction target");
  assert.equal(s.avgConv, 2, "introductions per 1,000 of that client's emails only");
  assert.equal(s.emails, 1572, "emails are emails, whoever sent them");
});

test("the Pay per lead filter, and the plan filters leave them out", () => {
  const old = client("Old plan");
  const rows = deriveRows([old, HETHERINGTON, HOMEBASE], "2026-11-09", NOW, new Date("2026-11-09T00:00:00Z"));
  const pick = (plan: string) => applyFilters(rows, { search: "", filter: "all", plan }, NOW).map((r) => r.client.name);
  assert.deepEqual(pick("per-lead"), ["Hetherington Team, Compass", "Homebase"]);
  assert.deepEqual(pick("production"), ["Old plan"]);
  assert.equal(pick("all").length, 3);
});

test("its Client Score is its finished 28-day windows against its cap", () => {
  const c = client("A", {
    monthly_target: 2,
    per_lead: perLead({ anchor: "2026-10-28", leads: [lead("2026-11-03"), lead("2026-11-04"), lead("2026-11-30")] }),
  });
  assert.deepEqual(completedLeadWindows(c, new Date("2026-12-30T18:00:00Z"), 4), [
    { target: 2, delivered: 2 },
    { target: 2, delivered: 1 },
  ]);
  assert.equal(clientScore(c, new Date("2026-11-12T18:00:00Z")).score, null, "no window has finished yet");
  assert.equal(clientScore(c, new Date("2026-12-30T18:00:00Z")).cyclesUsed, 2);
});
