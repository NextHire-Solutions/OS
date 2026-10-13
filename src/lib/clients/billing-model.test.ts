import assert from "node:assert/strict";
import { test } from "node:test";

import { billingTotals, buildBilling, customerKey, monthsPaidByClient, revenueByDay, subscriptionRows, unattributedByCustomer, upcomingCharges, type AccountSnapshot, type StripeSubscription } from "./billing-model.ts";

const T = (iso: string) => Math.floor(Date.parse(`${iso}T15:00:00Z`) / 1000);
const sub = (id: string, customer: string, amount: number, created: string, o: Partial<StripeSubscription> = {}): StripeSubscription => ({
  id, customer, status: "active", created: T(created), canceledAt: null, pause: null, periodEnd: T("2026-10-15"),
  items: [{ amount, interval: "day", intervalCount: 14, quantity: 1 }], percentOff: 0, osClientId: null, ...o,
});
const charge = (id: string, customer: string, amount: number, created: string, subscription: string | null = null, refunded = 0) =>
  ({ id, customer, status: "succeeded", amount, refunded, created: T(created), subscription, failureMessage: null });

// 54 Realty: four customers as cards were replaced, two live subscriptions.
// Raintown + JPAR: one shared customer, one subscription each, Raintown first.
const snap: AccountSnapshot = {
  customers: [
    { id: "cus_54a", name: "54 Realty LLC (1st Card)", email: null, created: T("2026-02-27") },
    { id: "cus_54b", name: "54 Realty LLC (1st card)", email: "invoice@54realty.com", created: T("2026-04-14") },
    { id: "cus_54c", name: "54 Realty", email: "bob@54Realty.com", created: T("2026-05-13") },
    { id: "cus_54d", name: "54 Realty LLC", email: "invoice@54realty.com", created: T("2026-08-06") },
    { id: "cus_rj", name: "Raintown Realty + JPAR", email: null, created: T("2026-03-11") },
    { id: "cus_other", name: "Someone Else Realty", email: null, created: T("2026-01-01") },
  ],
  subscriptions: [
    sub("sub_54old", "cus_54b", 750, "2026-04-14", { status: "canceled", canceledAt: T("2026-08-01") }),
    sub("sub_54c", "cus_54c", 500, "2026-05-13"),
    sub("sub_54d", "cus_54d", 750, "2026-08-06"),
    sub("sub_rt", "cus_rj", 750, "2026-05-28"),
    sub("sub_rt_old", "cus_rj", 750, "2026-04-30", { status: "canceled", canceledAt: T("2026-05-01") }),
    sub("sub_jpar", "cus_rj", 500, "2026-09-14"),
    sub("sub_paused", "cus_other", 500, "2026-07-01", { pause: { behavior: "void", resumesAt: null } }),
  ],
  charges: [
    charge("ch1", "cus_54a", 1, "2026-02-27"),
    charge("ch2", "cus_54b", 750, "2026-04-14", "sub_54old"),
    charge("ch3", "cus_54d", 1, "2026-08-06"),            // the card replaced: a second $1 — must not move sign-up
    charge("ch4", "cus_54d", 750, "2026-08-06", "sub_54d"),
    charge("ch5", "cus_54c", 500, "2026-05-13", "sub_54c"),
    charge("ch6", "cus_rj", 1, "2026-03-11"),             // shared customer, no subscription → its first client (Raintown)
    charge("ch7", "cus_rj", 250, "2026-04-01"),           // one-off → Raintown
    charge("ch8", "cus_rj", 750, "2026-05-01", "sub_rt_old"),
    charge("ch9", "cus_rj", 750, "2026-06-11", "sub_rt", 100),
    charge("ch10", "cus_rj", 500, "2026-09-14", "sub_jpar"),
    { ...charge("ch11", "cus_rj", 500, "2026-09-28", "sub_jpar"), status: "failed", failureMessage: "card declined" },
  ],
  invoices: [
    { id: "in_fail", customer: "cus_rj", subscription: "sub_jpar", status: "open", attemptCount: 3, nextAttempt: null, amountDue: 500, amountRemaining: 500, created: T("2026-09-28"), number: "J-1", url: null },
    { id: "in_ok", customer: "cus_54d", subscription: "sub_54d", status: "paid", attemptCount: 1, nextAttempt: null, amountDue: 750, amountRemaining: 0, created: T("2026-09-17"), number: "54-1", url: null },
  ],
};
const clients = [
  { id: "c54", name: "54 Realty", stripeCustomerId: "cus_54d", stripeSubscriptionId: "sub_54d", signupDate: "2026-02-27" },
  { id: "rt", name: "Raintown Realty", stripeCustomerId: "cus_rj", stripeSubscriptionId: "sub_rt" },
  { id: "jp", name: "JPAR Iron Horse Real Estate", stripeCustomerId: "cus_rj", stripeSubscriptionId: "sub_jpar", signupDate: "2026-09-10" },
];

test("54 Realty: every card's customer and both live subscriptions count; the newest is current", () => {
  const b = buildBilling(clients, snap, []).get("c54")!;
  assert.deepEqual(b.subscriptions.map((s) => s.id), ["sub_54d", "sub_54c", "sub_54old"]);
  assert.equal(b.current, "sub_54d");
  assert.equal(b.mrr, 2717.63, "$750 + $500 every 14 days");
  assert.equal(b.totalSpend, 2002, "1 + 750 + 1 + 750 + 500");
  assert.deepEqual(b.customers.map((c) => [c.id, c.source]).sort(), [["cus_54a", "name match"], ["cus_54b", "name match"], ["cus_54c", "name match"], ["cus_54d", "record"]].sort());
});

test("sign-up is the FIRST $1 charge across every card — replacing a card does not move it", () => {
  const b = buildBilling(clients, snap, []).get("c54")!;
  assert.equal(b.signupDate, "2026-02-27");
  assert.equal(b.signupSource, "first $1 charge");
});

test("a shared customer: each subscription to its owner, the rest to whoever was on it first", () => {
  const all = buildBilling(clients, snap, []);
  const rt = all.get("rt")!, jp = all.get("jp")!;
  assert.deepEqual(rt.subscriptions.map((s) => s.id), ["sub_rt", "sub_rt_old"]);
  assert.deepEqual(jp.subscriptions.map((s) => s.id), ["sub_jpar"]);
  assert.equal(rt.mrr, 1630.58, "Raintown's own $750 only — not JPAR's $500 as well");
  assert.equal(jp.mrr, 1087.05);
  assert.equal(rt.totalSpend, 1 + 250 + 750 + 650);
  assert.equal(jp.totalSpend, 500);
  assert.equal(rt.signupDate, "2026-03-11");
  assert.equal(jp.signupDate, "2026-09-10", "no $1 of its own: the entered date");
  assert.equal(jp.signupSource, "entered");
  assert.ok(rt.customers[0].shared && jp.customers[0].shared);
});

test("failed invoices belong to the subscription's client", () => {
  const all = buildBilling(clients, snap, []);
  assert.deepEqual(all.get("jp")!.failedInvoices.map((i) => i.id), ["in_fail"]);
  assert.equal(all.get("rt")!.failedInvoices.length, 0);
});

test("links: an explicit subscription link wins, and an excluded name match is not claimed", () => {
  const all = buildBilling(clients, snap, [
    { clientId: "rt", customerId: "cus_rj", subscriptionId: "sub_jpar", excluded: false },
    { clientId: "c54", customerId: "cus_54a", subscriptionId: null, excluded: true },
  ]);
  assert.ok(all.get("rt")!.subscriptions.some((s) => s.id === "sub_jpar"));
  assert.equal(all.get("jp")!.subscriptions.length, 0);
  assert.ok(!all.get("c54")!.customers.some((c) => c.id === "cus_54a"));
  assert.equal(all.get("c54")!.signupDate, "2026-08-06", "without that card, its first $1 is the later one");
});

test("customer names: card notes and company suffixes are ignored when matching", () => {
  assert.equal(customerKey("54 Realty LLC (1st Card)"), "54realty");
  assert.equal(customerKey("MattC Group Old"), "mattcgroup");
});

test("business totals: billed, MRR, ARR, active and paused subscriptions", () => {
  const all = buildBilling(clients, snap, []);
  const t = billingTotals(snap, all, Date.parse("2026-10-06T15:00:00Z"));
  assert.equal(t.totalBilled, 1 + 750 + 1 + 750 + 500 + 1 + 250 + 750 + 650 + 500);
  assert.equal(t.unattributed, 0);
  assert.equal(t.activeSubscriptions, 4);
  assert.equal(t.pausedSubscriptions, 1);
  assert.equal(t.mrr, Math.round((750 + 500 + 750 + 500) / 14 * 30.4375 * 100) / 100);
  assert.equal(t.arr, Math.round(t.mrr * 12 * 100) / 100);
});

test("billing calendar: each live subscription's next charges in the window, cycles repeated", () => {
  const all = buildBilling(clients, snap, []);
  const cal = upcomingCharges(snap, all, 30, Date.parse("2026-10-06T15:00:00Z"));
  const rt = cal.filter((c) => c.clientId === "rt");
  assert.deepEqual(rt.map((c) => c.date), ["2026-10-15", "2026-10-29"]);
  assert.ok(!cal.some((c) => c.subscription === "sub_paused"), "paused collection is not upcoming");
});

/* ------------------------------------------------ the Performance page (13 Oct) --- */

test("the subscriptions list has exactly the rows the Active and Paused tiles count", () => {
  const rows = subscriptionRows(clients, snap, []);
  const totals = billingTotals(snap, buildBilling(clients, snap, []), Date.parse("2026-10-01T15:00:00Z"));
  assert.equal(rows.filter((r) => r.state === "active").length, totals.activeSubscriptions);
  assert.equal(rows.filter((r) => r.state === "paused").length, totals.pausedSubscriptions);
  assert.deepEqual(rows.map((r) => r.id).sort(), ["sub_54c", "sub_54d", "sub_jpar", "sub_paused", "sub_rt"]);
  // Cancelled subscriptions are in neither list.
  assert.equal(rows.some((r) => r.id === "sub_54old" || r.id === "sub_rt_old"), false);
  // The active rows' MRR adds up to the MRR tile — to the cent or two that
  // rounding each row separately can differ by.
  const listed = rows.filter((r) => r.state === "active").reduce((t, r) => t + r.mrr, 0);
  assert.ok(Math.abs(listed - totals.mrr) < 0.01 * rows.length, `${listed} vs ${totals.mrr}`);
});

test("each subscription names its client by the same rules as the per-client totals; one tied to nobody says whose card it is", () => {
  const by = Object.fromEntries(subscriptionRows(clients, snap, []).map((r) => [r.id, r]));
  assert.equal(by.sub_54c.clientId, "c54", "a second subscription on another card is still 54 Realty's");
  assert.equal(by.sub_rt.clientId, "rt");
  assert.equal(by.sub_jpar.clientId, "jp", "a shared customer: each subscription to its owner");
  assert.equal(by.sub_paused.clientId, null);
  assert.equal(by.sub_paused.customerName, "Someone Else Realty");
  assert.equal(by.sub_paused.state, "paused");
  assert.equal(by.sub_paused.nextCharge, null, "a paused subscription has no next charge");
  assert.equal(by.sub_54d.nextCharge, "2026-10-15");
  assert.equal(by.sub_54d.every, "every 14 days");
  assert.equal(by.sub_54d.amount, 750);
});

test("a paused subscription shows when collection resumes, if a date is set", () => {
  const withResume: AccountSnapshot = { ...snap, subscriptions: snap.subscriptions.map((s) => (s.id === "sub_paused" ? { ...s, pause: { behavior: "void", resumesAt: T("2026-11-03") } } : s)) };
  assert.equal(subscriptionRows(clients, withResume, []).find((r) => r.id === "sub_paused")!.resumes, "2026-11-03");
});

const withStrays: AccountSnapshot = {
  ...snap,
  charges: [
    ...snap.charges,
    charge("s1", "cus_other", 300, "2026-01-05"),
    charge("s2", "cus_other", 200, "2026-03-09", null, 50),
    { ...charge("s3", "cus_other", 999, "2026-03-10"), status: "failed" },
    { ...charge("s4", "cus_x", 75, "2026-02-02"), customer: null },
  ],
};

test("money tied to no client is listed by the Stripe customer it came from, and adds up to the tile", () => {
  const list = unattributedByCustomer(clients, withStrays, []);
  assert.deepEqual(list, [
    { customerId: "cus_other", name: "Someone Else Realty", email: null, amount: 450, charges: 2, first: "2026-01-05", last: "2026-03-09" },
    { customerId: null, name: null, email: null, amount: 75, charges: 1, first: "2026-02-02", last: "2026-02-02" },
  ]);
  const totals = billingTotals(withStrays, buildBilling(clients, withStrays, []));
  assert.equal(list.reduce((t, c) => t + c.amount, 0), totals.unattributed);
  assert.equal(totals.unattributed, 525);
  // Nothing stray: nothing listed.
  assert.deepEqual(unattributedByCustomer(clients, snap, []), []);
});

test("an explicit link moves a stray customer's money to its client — and off the list", () => {
  const linked = unattributedByCustomer(clients, withStrays, [{ clientId: "rt", customerId: "cus_other", subscriptionId: null, excluded: false }]);
  assert.deepEqual(linked.map((c) => c.customerId), [null]);
});

test("customer lifespan: each paid subscription charge counts for the period it paid for", () => {
  const months = monthsPaidByClient(clients, snap, []);
  const fortnight = 14 / 30.4375;
  // 54 Realty: three paid fortnights across three subscriptions; the two $1 card checks are not service.
  assert.equal(months.get("c54"), Math.round(3 * fortnight * 100) / 100);
  // Raintown: two (one partly refunded still paid for its period); its one-off $250 and $1 are not counted.
  assert.equal(months.get("rt"), Math.round(2 * fortnight * 100) / 100);
  // JPAR: one paid, one FAILED.
  assert.equal(months.get("jp"), Math.round(fortnight * 100) / 100);
});

test("…a monthly invoice is one month, a charge refunded in full is none, and a client who never paid is absent", () => {
  const s: AccountSnapshot = {
    customers: [{ id: "cus_m", name: "Monthly Co", email: null, created: T("2026-01-01") }],
    subscriptions: [sub("sub_m", "cus_m", 2000, "2026-01-01", { items: [{ amount: 2000, interval: "month", intervalCount: 1, quantity: 1 }] })],
    charges: [charge("m1", "cus_m", 2000, "2026-01-01", "sub_m"), charge("m2", "cus_m", 2000, "2026-02-01", "sub_m"), charge("m3", "cus_m", 2000, "2026-03-01", "sub_m", 2000)],
    invoices: [],
  };
  const cs = [{ id: "m", name: "Monthly Co", stripeCustomerId: "cus_m", stripeSubscriptionId: "sub_m" }, { id: "n", name: "Never Paid Realty", stripeCustomerId: null, stripeSubscriptionId: null }];
  const months = monthsPaidByClient(cs, s, []);
  assert.equal(months.get("m"), 2);
  assert.equal(months.has("n"), false);
});

test("revenue per day adds up to everything ever collected, less refunds", () => {
  const byDay = revenueByDay(snap);
  const totals = billingTotals(snap, buildBilling(clients, snap, []));
  assert.equal(Math.round([...byDay.values()].reduce((a, b) => a + b, 0) * 100) / 100, totals.totalBilled);
  assert.equal(byDay.get("2026-06-11"), 650, "a partly refunded charge counts for what was kept");
  assert.equal(byDay.has("2026-09-28"), false, "a failed charge collected nothing");
});
