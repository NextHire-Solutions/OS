import { mock, test } from "node:test";
import assert from "node:assert/strict";

/*
 * One pass of the payment watch (6 Nov) against a stand-in Stripe and bell: what it reads, when it reads Stripe again,
 * and that each alert is written once. The rules themselves are stripe-payment-alerts.test.ts.
 */
const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

const NOW = Date.parse("2026-11-06T15:00:00Z");
const s = (msAgo: number) => Math.floor((NOW - msAgo) / 1000);

let sessions: Array<Record<string, unknown>> = [];
let stripeCalls: string[] = [];
let snapshot: { customers: Array<Record<string, unknown>>; subscriptions: Array<Record<string, unknown>>; charges: unknown[]; invoices: unknown[]; readAt: number };
let invalidated = 0;
let bell: Array<{ kind: string; ref: string; title: string; body: string; os_client_id: string | null; severity?: string }> = [];
let probeFails = false;
let clients: Array<Record<string, unknown>> = [];
let degraded = false;
let forgotten = 0;
let gate: Promise<void> | null = null;

function reset() {
  sessions = []; stripeCalls = []; invalidated = 0; bell = []; probeFails = false; degraded = false; forgotten = 0; gate = null;
  (globalThis as { __osPaymentWatchReread?: Set<string> }).__osPaymentWatchReread = undefined;
  snapshot = { customers: [], subscriptions: [], charges: [], invoices: [], readAt: NOW - 60_000 };
  clients = [{ id: "acme", name: "Acme Realty", stripeCustomerId: null, stripeSubscriptionId: null, emails: ["jane@acmerealty.com"], internal: false, createdAt: NOW - 90 * 86_400_000, status: "active" }];
}

const stripeGet = async (url: string) => {
  stripeCalls.push(url);
  if (gate) await gate;
  const after = new URL(url).searchParams.get("starting_after");
  const page = after ? sessions.slice(sessions.findIndex((x) => x.id === after) + 1) : sessions;
  return { ok: true, status: 200, json: async () => ({ data: page.slice(0, 2), has_more: page.length > 2 }) };
};

function osTable(table: string) {
  assert.equal(table, "os_notifications", "the watch writes nothing but the bell");
  let mode: "probe" | "refs" | "upsert" = "refs";
  let row: { kind: string; ref: string; title: string; body: string; os_client_id: string | null } | null = null;
  let kind = "";
  let severity = "";
  const b: Record<string, unknown> = {
    select: (_c: string, o?: { head?: boolean }) => { if (o?.head) mode = "probe"; return b; },
    // What the bell holds: by ref (saidAlready), or the clients a payment alert names (paymentAlertClients).
    eq: (col: string, v: string) => { if (col === "kind") kind = v; else { assert.equal(col, "severity"); severity = v; } return b; },
    in: (col: string, values: string[]) => {
      if (col === "ref") return Promise.resolve({ data: bell.filter((n) => values.includes(n.ref)).map((n) => ({ ref: n.ref, body: n.body })), error: null });
      assert.equal(col, "os_client_id");
      return Promise.resolve({ data: bell.filter((n) => n.kind === kind && (!severity || n.severity === severity) && n.os_client_id && values.includes(n.os_client_id)).map((n) => ({ os_client_id: n.os_client_id })), error: null });
    },
    order: () => b,
    limit: () => Promise.resolve({ error: probeFails ? { message: "relation does not exist" } : null }),
    upsert: (r: typeof row, o: { onConflict: string; ignoreDuplicates: boolean }) => {
      assert.deepEqual(o, { onConflict: "ref", ignoreDuplicates: true });
      mode = "upsert"; row = r; return b;
    },
  };
  b.select = (c: string, o?: { head?: boolean }) => {
    if (mode === "upsert") {
      const dupe = bell.some((n) => n.ref === row!.ref);
      if (!dupe) bell.push(row!);
      return Promise.resolve({ data: dupe ? [] : [{ id: row!.ref }], error: null });
    }
    if (o?.head) mode = "probe";
    void c;
    return b;
  };
  return b;
}

const getStripeSnapshot = Object.assign(async () => snapshot, { invalidate: () => { invalidated++; snapshot = { ...snapshot, readAt: Date.now() }; } });

let runPaymentWatch: (o?: { now?: number; fresh?: boolean }) => Promise<{ ready: boolean; notified: number; checkouts: number }>;

test("setup", { skip }, async () => {
  const { buildBilling, emailSuggestions } = await import("./billing-model.ts");
  mock.module("../commissions/stripe-payments", { namedExports: { stripeGet } });
  mock.module("./os-db", { namedExports: { osTable } });
  mock.module("./billing-account", {
    namedExports: {
      getStripeSnapshot,
      getAccountBilling: async () => ({
        byClient: buildBilling(clients as never, snapshot as never, []), snapshot, refs: clients, linksReady: !degraded, suggestionsReady: !degraded,
        suggestions: degraded ? [] : emailSuggestions(clients as never, snapshot as never, []),
      }),
      forgetSignIns: () => { forgotten++; },
    },
  });
  ({ runPaymentWatch } = await import("./stripe-payment-watch.ts"));
});

const paid = (id: string, o: Record<string, unknown> = {}) => ({
  id, created: s(3_600_000), customer: "cus_new", customer_details: { email: "sam@newteam.com", name: "Sam Smith" }, amount_total: 75000,
  mode: "subscription", subscription: "sub_new", payment_status: "paid", custom_fields: [], ...o,
});

test("a new payment: one alert in the bell, and the next pass writes it again never", { skip }, async () => {
  reset();
  sessions = [paid("cs_1")];
  snapshot.customers = [{ id: "cus_new", name: "Sam Smith", email: "sam@newteam.com", created: s(3_600_000) }];
  snapshot.subscriptions = [{ id: "sub_new", customer: "cus_new", status: "active", created: s(3_600_000), canceledAt: null, pause: null, periodEnd: null, items: [{ amount: 750, interval: "day", intervalCount: 14, quantity: 1 }], percentOff: 0, osClientId: null }];
  const first = await runPaymentWatch({ now: NOW });
  assert.deepEqual(first, { ready: true, notified: 1, checkouts: 1 });
  assert.deepEqual(bell.map((n) => [n.kind, n.ref]), [["stripe_payment_unmatched", "stripe-unmatched:cs_1"]]);
  const second = await runPaymentWatch({ now: NOW + 300_000 });
  assert.equal(second.notified, 0);
  assert.equal(bell.length, 1);
  assert.equal(invalidated, 0, "everything was in the snapshot already: Stripe is not read again");
});

test("only paid Checkouts, every page of them, from the last two days", { skip }, async () => {
  reset();
  sessions = [paid("cs_a", { customer: null, subscription: null, mode: "payment" }), paid("cs_b", { payment_status: "no_payment_required" }), paid("cs_c", { customer: null, subscription: null, mode: "payment" }), paid("cs_d", { customer: null, subscription: null, mode: "payment" })];
  const r = await runPaymentWatch({ now: NOW });
  assert.equal(r.checkouts, 3, "a free trial or setup isn't a payment");
  assert.equal(stripeCalls.length, 2, "two pages");
  const since = Number(new URL(stripeCalls[0]).searchParams.get("created[gte]"));
  assert.equal(since, Math.floor((NOW - 2 * 86_400_000) / 1000));
  assert.equal(new URL(stripeCalls[0]).searchParams.get("status"), "complete");
});

test("a payment for a customer the snapshot hasn't seen: Stripe is read again before anything is said", { skip }, async () => {
  reset();
  sessions = [paid("cs_1", { created: s(60_000) })];
  snapshot.readAt = Date.now() - 10 * 60_000;
  await runPaymentWatch({ now: NOW });
  assert.equal(invalidated, 1);
});

test("an unseen customer though the snapshot began after the page was opened: still read again (a Checkout is dated when opened, not paid)", { skip }, async () => {
  reset();
  // Opened ten minutes ago, read a minute ago: by the dates the snapshot is newer.
  sessions = [paid("cs_1", { created: Math.floor((Date.now() - 10 * 60_000) / 1000) })];
  snapshot.readAt = Date.now() - 60_000;
  await runPaymentWatch({ now: NOW });
  assert.equal(invalidated, 1);
});

test("an unseen customer, Stripe read in the last 30 seconds: not read again", { skip }, async () => {
  reset();
  sessions = [paid("cs_1")];
  snapshot.readAt = Date.now() - 5_000;
  await runPaymentWatch({ now: NOW });
  assert.equal(invalidated, 0);
});

test("links or sign-in lists unreadable: nothing is said from a picture that may be wrong", { skip }, async () => {
  reset();
  degraded = true;
  sessions = [paid("cs_1", { customer: null, subscription: null, mode: "payment" })];
  const r = await runPaymentWatch({ now: NOW });
  assert.equal(r.ready, false);
  assert.deepEqual(bell, []);
});

test("asked by an onboarding while a pass runs: it runs again once that one is done, reading the sign-in lists again", { skip }, async () => {
  reset();
  let open!: () => void;
  gate = new Promise<void>((r) => { open = r; });
  const first = runPaymentWatch({ now: NOW });
  const fresh = runPaymentWatch({ now: NOW, fresh: true });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(stripeCalls.length, 1, "one pass at a time");
  gate = null; open();
  await first; await fresh;
  assert.equal(stripeCalls.length, 2, "then the onboarding's own pass");
  assert.equal(forgotten, 1);
});

test("asked by an onboarding (fresh): Stripe is read again, unless it was read in the last 30 seconds", { skip }, async () => {
  reset();
  snapshot.readAt = Date.now() - 5 * 60_000;
  await runPaymentWatch({ now: NOW, fresh: true });
  assert.equal(invalidated, 1);
  reset();
  snapshot.readAt = Date.now() - 5_000;
  await runPaymentWatch({ now: NOW, fresh: true });
  assert.equal(invalidated, 0);
});

test("two passes asked for at once are one pass", { skip }, async () => {
  reset();
  sessions = [paid("cs_1", { customer: null, subscription: null, mode: "payment" })];
  const [a, b] = await Promise.all([runPaymentWatch({ now: NOW }), runPaymentWatch({ now: NOW })]);
  assert.equal(a, b);
  assert.equal(stripeCalls.length, 1);
  assert.equal(bell.length, 1);
});

test("before the bell's table exists: nothing is read from Stripe and nothing is written", { skip }, async () => {
  reset();
  probeFails = true;
  sessions = [paid("cs_1")];
  const r = await runPaymentWatch({ now: NOW });
  assert.equal(r.ready, false);
  assert.deepEqual(stripeCalls, []);
  assert.deepEqual(bell, []);
});

test("a customer Stripe never lists (deleted since): read again once, not on every pass for two days", { skip }, async () => {
  reset();
  sessions = [paid("cs_gone", { customer: "cus_gone", subscription: null, mode: "payment" })];
  snapshot.readAt = Date.now() - 10 * 60_000;
  await runPaymentWatch({ now: NOW });
  assert.equal(invalidated, 1);
  snapshot.readAt = Date.now() - 10 * 60_000;
  await runPaymentWatch({ now: NOW + 300_000 });
  assert.equal(invalidated, 1, "not again for the same id");
  assert.deepEqual(bell, [], "and nothing is said about a payment whose customer can't be seen");
});

test("what the bell already holds is asked by ref: a found alert said before is not said again, and the subscription it named isn't new", { skip }, async () => {
  reset();
  snapshot.customers = [{ id: "cus_jane", name: "Jane Doe", email: "jane@acmerealty.com", created: s(3_600_000) }];
  snapshot.subscriptions = [{ id: "sub_jane", customer: "cus_jane", status: "active", created: s(3_600_000), canceledAt: null, pause: null, periodEnd: null, items: [{ amount: 750, interval: "day", intervalCount: 14, quantity: 1 }], percentOff: 0, osClientId: null }];
  const first = await runPaymentWatch({ now: NOW });
  assert.deepEqual(bell.map((n) => n.ref), ["stripe-found:acme:cus_jane"]);
  assert.equal(first.notified, 1);
  const second = await runPaymentWatch({ now: NOW + 300_000 });
  assert.equal(second.notified, 0);
  assert.deepEqual(bell.map((n) => n.ref), ["stripe-found:acme:cus_jane"], "said once");
  // Confirmed: a link. Its subscription, named by the found alert, isn't said again as new.
  clients = [{ ...clients[0], stripeCustomerId: "cus_jane" }];
  const third = await runPaymentWatch({ now: NOW + 600_000 });
  assert.equal(third.notified, 0);
  assert.deepEqual(bell.map((n) => n.ref), ["stripe-found:acme:cus_jane"], "no stripe-newsub:sub_jane");
});

test("a second subscription after the customer's find was written: said as new (the find in the bell named only the first)", { skip }, async () => {
  reset();
  const subOf = (id: string) => ({ id, customer: "cus_jane", status: "active", created: s(3_600_000), canceledAt: null, pause: null, periodEnd: null, items: [{ amount: 750, interval: "day", intervalCount: 14, quantity: 1 }], percentOff: 0, osClientId: null });
  // A new card by name: counted automatically, as it always was.
  snapshot.customers = [{ id: "cus_jane", name: "Acme Realty (2nd Card)", email: null, created: s(3_600_000) }];
  snapshot.subscriptions = [subOf("sub_a")];
  await runPaymentWatch({ now: NOW });
  assert.deepEqual(bell.map((n) => n.ref), ["stripe-counted:acme:cus_jane"]);
  snapshot.subscriptions = [subOf("sub_b"), subOf("sub_a")];
  await runPaymentWatch({ now: NOW + 300_000 });
  assert.deepEqual(bell.map((n) => n.ref), ["stripe-counted:acme:cus_jane", "stripe-newsub:sub_b"]);
});

test("a client a payment alert in the bell already names gets no 'no Stripe payment found', however long after", { skip }, async () => {
  reset();
  clients = [{ id: "nt", name: "New Team", stripeCustomerId: null, stripeSubscriptionId: null, emails: ["owner@newteam.com"], internal: false, createdAt: Date.now() - 3 * 86_400_000, status: "onboarding" }];
  snapshot.readAt = Date.now();
  snapshot.customers = [{ id: "cus_w", name: "Pat Lee", email: "pat@otherco.com", created: Math.floor(Date.now() / 1000) - 86_400 }];
  snapshot.charges = [{ id: "ch_w", customer: "cus_w", status: "succeeded", amount: 500, refunded: 0, created: Math.floor(Date.now() / 1000) - 86_400, subscription: null, failureMessage: null }];
  bell.push({ kind: "stripe_payment_unmatched", ref: "stripe-unmatched:cs_old", title: "Payment from New Team, not on their Billing tab", body: "", os_client_id: "nt", severity: "info" });
  await runPaymentWatch({ now: Date.now() });
  assert.ok(!bell.some((n) => n.kind === "stripe_no_customer"), JSON.stringify(bell.map((n) => n.ref)));
  // A "Likely New Team" hint (a warning) doesn't count: its payment may since be someone else's.
  bell.length = 0;
  bell.push({ kind: "stripe_payment_unmatched", ref: "stripe-unmatched:cs_hint", title: "New payment, no client yet: X", body: "", os_client_id: "nt", severity: "warning" });
  await runPaymentWatch({ now: Date.now() });
  assert.ok(bell.some((n) => n.ref === "stripe-nocustomer:nt"), "a hint alone doesn't silence it");
  bell.length = 0;
  await runPaymentWatch({ now: Date.now() });
  assert.ok(bell.some((n) => n.ref === "stripe-nocustomer:nt"), "without it, said");
});
