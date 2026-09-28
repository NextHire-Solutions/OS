import assert from "node:assert/strict";
import { test } from "node:test";

import type { MasterClient } from "../clients/master-list.ts";
import type { TeamMember } from "../identity/team-match.ts";
import { buildCommissionsView, type BuildInputs } from "./load.ts";
import type { Payment } from "./schedule.ts";

const client = (id: string, name: string, am: string | null, extra: Partial<MasterClient> = {}): MasterClient => ({
  id, name, aliases: [], status: "active", statusSince: null, plan: "production", startDate: "2026-06-01", onboardingDate: null,
  dateAdded: null, markets: [], timezone: null, team: null, agents: null, dnc: null, sender: null, salesperson: null,
  accountManager: am, firstBillingDate: null, billingAnchorDate: "2026-06-03", billingInterval: "biweekly", billingIntervalDays: null,
  nextBillingDate: null, stripeCustomerId: null, stripeSubscriptionId: null, campaigns: [], campaignAliases: [], campaignLocation: null,
  assignedLeads: null, weeklyTarget: null, monthlyTarget: null, introductions: null, lastIntroAt: null, replies: null, bounces: null,
  sequencers: null, inReview: null, exported: null, pauseDate: null, churnDate: null, reactivationDate: null,
  contact: { name: null, role: null, email: null, brokerage: null, extra: [] },
  health: { present: true, period: null, cycle: null, pace: null }, onboarding: { present: false, stage: null, progress: null },
  portal: { count: 0, url: null, enabled: null }, analytics: { present: false, campaigns: null, sent: null }, database: { present: false },
  ...extra,
});
const member = (name: string, email: string, admin = false): TeamMember => ({ name, email, active: true, admin });
const pay = (date: string, amount: number): Payment => ({ date, amount, source: "stripe" });

const team = [member("Ryan Jagdeo", "ryan@x.com"), member("Scott Craigue", "scott@x.com"), member("admin", "admin@x.com", true)];
const clients = [
  client("k", "Keyes Company", "Ryan Jagdeo", { stripeSubscriptionId: "sub_k" }),
  client("c", "Coastal Realty", "ryan jagdeo", { stripeSubscriptionId: "sub_c" }),
  client("s", "Scott's client", "Scott Craigue", { stripeSubscriptionId: "sub_s" }),
  client("u", "Unassigned Co", null),
];
const base = (over: Partial<BuildInputs>): BuildInputs => ({
  clients, team, history: new Map(), unavailable: [], today: "2026-09-30", run: "2026-10-01",
  settings: { rates: new Map([["scott@x.com", { monthOne: 0.7, residual: 0.25 }]]), gross: new Map(), available: true },
  stripe: new Map([
    ["k", { payments: [pay("2026-06-24", 1500), pay("2026-07-08", 1500), pay("2026-09-16", 1500)], gross: 3000 }],
    ["c", { payments: [pay("2026-09-20", 600)], gross: 1200 }],
    ["s", { payments: [pay("2026-08-01", 1000), pay("2026-09-26", 1000)], gross: 1000 }],
  ]),
  viewerEmail: "ryan@x.com", admin: false, ...over,
});

test("an account manager sees ONLY their own clients — even when asking for someone else", () => {
  const v = buildCommissionsView(base({ as: "scott@x.com" }));
  assert.deepEqual(v.rows.map((r) => r.name).sort(), ["Coastal Realty", "Keyes Company"]);
  assert.equal(v.scope, "ryan@x.com");
  assert.deepEqual(v.reps.map((r) => r.email), ["ryan@x.com"]);
  assert.deepEqual(v.unassigned, [], "no roster leaks to a non-admin");
  assert.deepEqual(v.team, []);
  assert.deepEqual(v.people, []);
  assert.equal(JSON.stringify(v).includes("Scott's client"), false, "nothing about another rep's clients in the response");
});

test("an admin sees everyone, can view one person, and gets the unassigned list", () => {
  const all = buildCommissionsView(base({ viewerEmail: "admin@x.com", admin: true }));
  assert.equal(all.scope, "all");
  assert.equal(all.rows.length, 3);
  assert.deepEqual(all.unassigned.map((u) => u.name), ["Unassigned Co"]);
  assert.deepEqual(all.reps.map((r) => r.name).sort(), ["Ryan Jagdeo", "Scott Craigue"], "cards only for people holding clients");
  const one = buildCommissionsView(base({ viewerEmail: "admin@x.com", admin: true, as: "scott@x.com" }));
  assert.deepEqual(one.rows.map((r) => r.name), ["Scott's client"]);
  assert.ok(one.people.length >= 2, "the switcher still lists everyone");
});

test("sums: Oct 1 pays payments billed Sep 15–30, at each rep's own rates", () => {
  const v = buildCommissionsView(base({ viewerEmail: "admin@x.com", admin: true }));
  const by = Object.fromEntries(v.rows.map((r) => [r.name, r]));
  assert.equal(by["Keyes Company"].due, 225, "residual 15% of $1,500 (Sep 16)");
  assert.equal(by["Coastal Realty"].due, 420, "Month 1: 70% of $600 (first payment Sep 20)");
  assert.equal(by["Scott's client"].due, 250, "Scott's residual is 25%");
  assert.equal(by["Coastal Realty"].statusLabel, "Month 1");
  assert.equal(by["Keyes Company"].statusLabel, "Active · residual");
  const ryan = v.reps.find((r) => r.email === "ryan@x.com")!;
  assert.equal(ryan.due, 645);
  assert.equal(ryan.month1, 1);
  assert.equal(ryan.residual, 1);
});

test("a client with no Stripe link and no gross is shown, owes nothing, and says why", () => {
  const v = buildCommissionsView(base({ viewerEmail: "admin@x.com", admin: true, clients: [client("n", "No billing", "Ryan Jagdeo")] }));
  assert.equal(v.rows[0].due, 0);
  assert.equal(v.rows[0].grossSource, null);
  assert.equal(v.rows[0].statusLabel, "No billing data");
});

test("a manual gross is estimated on the billing schedule and labelled as an estimate", () => {
  const v = buildCommissionsView(base({
    viewerEmail: "admin@x.com", admin: true, clients: [client("m", "Manual Co", "Ryan Jagdeo")],
    settings: { rates: new Map(), gross: new Map([["m", 2000]]), available: true },
  }));
  const r = v.rows[0];
  assert.equal(r.grossSource, "manual");
  assert.ok(r.lines.every((l) => l.source === "estimate" && l.amount === 1000), "per 28 days, split over 14-day payments");
  assert.ok(r.lines.length >= 1);
});

test("a churned client earns nothing after its cancellation", () => {
  const churned = client("k", "Keyes Company", "Ryan Jagdeo", { stripeSubscriptionId: "sub_k", status: "churned" });
  const v = buildCommissionsView(base({
    clients: [churned],
    history: new Map([["k", [{ from: "active", to: "churned", at: "2026-09-10T15:00:00Z" }]]]),
  }));
  assert.equal(v.rows[0].due, 0);
  assert.match(v.rows[0].statusLabel, /^Cancelled Sep 10/);
});
