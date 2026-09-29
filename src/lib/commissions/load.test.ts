import assert from "node:assert/strict";
import { test } from "node:test";

import type { MasterClient } from "../clients/master-list.ts";
import type { TeamMember } from "../identity/team-match.ts";
import type { Salesperson } from "../identity/salesperson-match.ts";
import { buildCommissionsView, type BuildInputs } from "./load.ts";
import type { Payment } from "./schedule.ts";

const client = (id: string, name: string, sp: string | null, am: string | null, extra: Partial<MasterClient> = {}): MasterClient => ({
  id, name, aliases: [], status: "active", statusSince: null, plan: "production", startDate: "2026-06-01", onboardingDate: null,
  dateAdded: null, markets: { markets: null, mls: [], areas: [] }, timezone: null, team: null, agents: null, dnc: null, sender: null, salesperson: sp,
  accountManager: am, firstBillingDate: null, billingAnchorDate: "2026-06-03", billingInterval: "biweekly", billingIntervalDays: null,
  nextBillingDate: null, stripeCustomerId: null, stripeSubscriptionId: null, campaigns: [], campaignAliases: [], campaignLocation: null,
  assignedLeads: null, weeklyTarget: null, monthlyTarget: null, introductions: null, lastIntroAt: null, replies: null, bounces: null,
  sequencers: null, inReview: null, exported: null, pauseDate: null, churnDate: null, reactivationDate: null,
  contact: { name: null, role: null, email: null, brokerage: null, extra: [] },
  health: { present: true, period: null, cycle: null, pace: null }, onboarding: { present: false, stage: null, progress: null },
  portal: { count: 0, url: null, enabled: null }, analytics: { present: false, campaigns: null, sent: null }, database: { present: false },
  ...extra,
});
const member = (name: string, email: string, admin = false): TeamMember => ({ name, email, active: true, admin, accountManager: !admin });
const seller = (id: string, name: string, email: string | null, residual = 0.15): Salesperson => ({ id, name, email, active: true, rates: { monthOne: 0.7, residual } });
const pay = (date: string, amount: number): Payment => ({ date, amount, source: "stripe" });

const team = [member("Amy", "amy@x.com"), member("Eddy", "eddy@x.com"), member("admin", "admin@x.com", true)];
const salespeople = [seller("r", "Ryan Jagdeo", "ryan@x.com", 0.15), seller("s", "Scott Craigue", null, 0.25), seller("e", "Eddy", "eddy@x.com", 0.15)];
const clients = [
  client("k", "Keyes Company", "Scott Craigue", "Amy", { stripeSubscriptionId: "sub_k" }),
  client("c", "Coastal Realty", "Ryan Jagdeo", "Eddy", { stripeSubscriptionId: "sub_c" }),
  client("n", "NYC Co", "Eddy", "Amy", { stripeSubscriptionId: "sub_n" }),
  client("u", "Unassigned Co", null, null),
];
const base = (over: Partial<BuildInputs>): BuildInputs => ({
  clients, team, salespeople, history: new Map(), unavailable: [], today: "2026-09-30", run: "2026-10-01",
  settings: { rates: new Map([["amy@x.com", { monthOne: 0.7, residual: 0.25 }]]), gross: new Map(), available: true },
  stripe: new Map([
    ["k", { payments: [pay("2026-06-24", 1500), pay("2026-07-08", 1500), pay("2026-09-16", 1500)], gross: 3000 }],
    ["c", { payments: [pay("2026-09-20", 600)], gross: 1200 }],
    ["n", { payments: [pay("2026-08-01", 1000), pay("2026-09-26", 1000)], gross: 1000 }],
  ]),
  viewerEmail: "amy@x.com", admin: false, ...over,
});

test("a person sees ONLY their own earnings — even when asking for someone else", () => {
  const v = buildCommissionsView(base({ as: "am:eddy@x.com" }));
  assert.equal(v.scope, "mine");
  assert.deepEqual(v.rows.map((r) => r.name).sort(), ["Keyes Company", "NYC Co"], "Amy's two clients as account manager");
  assert.ok(v.rows.every((r) => r.earnings.every((e) => e.key === "am:amy@x.com")), "no one else's earnings on her rows");
  assert.deepEqual(v.reps.map((r) => r.key), ["am:amy@x.com"]);
  assert.deepEqual(v.unassigned, []);
  assert.deepEqual(v.people, []);
  assert.equal(JSON.stringify(v).includes("Coastal Realty"), false, "nothing about a client she does not earn on");
});

test("someone who is both a salesperson and an account manager sees both, and only those", () => {
  const v = buildCommissionsView(base({ viewerEmail: "eddy@x.com" }));
  assert.deepEqual(v.reps.map((r) => `${r.name}/${r.role}`).sort(), ["Eddy/account_manager", "Eddy/salesperson"]);
  assert.deepEqual(v.rows.map((r) => r.name).sort(), ["Coastal Realty", "NYC Co"]);
  assert.deepEqual(v.rows.find((r) => r.name === "NYC Co")!.earnings.map((e) => e.role), ["salesperson"], "Amy's share of NYC Co is not shown to Eddy");
});

test("a salesperson with no sign-in has no view; a stranger sees nothing at all", () => {
  const v = buildCommissionsView(base({ viewerEmail: "nobody@x.com" }));
  assert.deepEqual([v.rows, v.reps], [[], []]);
});

test("an admin sees everyone, can view one person, and gets what is missing on each client", () => {
  const all = buildCommissionsView(base({ viewerEmail: "admin@x.com", admin: true }));
  assert.equal(all.scope, "all");
  assert.equal(all.rows.length, 3);
  assert.deepEqual(all.unassigned.map((u) => [u.name, u.missing.join("+")]), [["Unassigned Co", "salesperson+account_manager"]]);
  const one = buildCommissionsView(base({ viewerEmail: "admin@x.com", admin: true, as: "sp:s" }));
  assert.deepEqual(one.rows.map((r) => r.name), ["Keyes Company"]);
  assert.ok(one.people.length >= 4, "the switcher still lists everyone");
});

test("both people on a client earn, each at their own rates", () => {
  const v = buildCommissionsView(base({ viewerEmail: "admin@x.com", admin: true }));
  const keyes = v.rows.find((r) => r.name === "Keyes Company")!;
  const by = Object.fromEntries(keyes.earnings.map((e) => [e.name, e.due]));
  assert.equal(by["Scott Craigue"], 375, "Scott's residual is 25% of $1,500 (Sep 16)");
  assert.equal(by["Amy"], 375, "Amy's residual is 25% too");
  assert.equal(keyes.due, 750);
  const coastal = v.rows.find((r) => r.name === "Coastal Realty")!;
  assert.deepEqual(coastal.earnings.map((e) => e.due), [420, 420], "Month 1: 70% of $600 each");
  assert.equal(coastal.statusLabel, "Month 1");
  const ryan = v.reps.find((r) => r.key === "sp:r")!;
  assert.equal(ryan.due, 420);
  assert.equal(ryan.month1, 1);
});

test("a client with no Stripe link and no gross is shown, owes nothing, and says why", () => {
  const v = buildCommissionsView(base({ viewerEmail: "admin@x.com", admin: true, clients: [client("n", "No billing", "Ryan Jagdeo", null)] }));
  assert.equal(v.rows[0].due, 0);
  assert.equal(v.rows[0].grossSource, null);
  assert.equal(v.rows[0].statusLabel, "No billing data");
});

test("a manual gross is estimated on the billing schedule and labelled as an estimate", () => {
  const v = buildCommissionsView(base({
    viewerEmail: "admin@x.com", admin: true, clients: [client("m", "Manual Co", "Ryan Jagdeo", null)],
    settings: { rates: new Map(), gross: new Map([["m", 2000]]), available: true },
  }));
  const lines = v.rows[0].earnings[0].lines;
  assert.equal(v.rows[0].grossSource, "manual");
  assert.ok(lines.every((l) => l.source === "estimate" && l.amount === 1000), "per 28 days, split over 14-day payments");
  assert.ok(lines.length >= 1);
});

test("a churned client earns nothing after its cancellation", () => {
  const churned = client("k", "Keyes Company", "Scott Craigue", "Amy", { stripeSubscriptionId: "sub_k", status: "churned" });
  const v = buildCommissionsView(base({
    clients: [churned],
    history: new Map([["k", [{ from: "active", to: "churned", at: "2026-09-10T15:00:00Z" }]]]),
  }));
  assert.equal(v.rows[0].due, 0);
  assert.match(v.rows[0].statusLabel, /^Cancelled Sep 10/);
});

test("older data naming two account managers pays the first only — never twice", () => {
  const two = [client("k", "Keyes Company", null, "Eddy, Amy", { stripeSubscriptionId: "sub_k" })];
  const all = buildCommissionsView(base({ viewerEmail: "admin@x.com", admin: true, clients: two }));
  assert.deepEqual(all.rows[0].earnings.map((e) => e.name), ["Eddy"]);
  assert.deepEqual(buildCommissionsView(base({ clients: two })).rows, [], "Amy does not also earn on it");
});
