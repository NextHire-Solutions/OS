import assert from "node:assert/strict";
import { test } from "node:test";

import { buildBilling, emailSuggestions, type AccountSnapshot, type BillingClientRef, type StripeCharge, type StripeLinkRow, type StripeSubscription } from "./billing-model.ts";
import { paymentAlerts, SETTLE_MS, type PaidCheckout } from "./stripe-payment-alerts.ts";

const NOW = Date.parse("2026-11-06T15:00:00Z");
const HOUR = 3_600_000;
const ago = (days: number) => Math.floor((NOW - days * 86_400_000) / 1000);
const sub = (id: string, customer: string, createdDaysAgo: number, o: Partial<StripeSubscription> = {}): StripeSubscription => ({
  id, customer, status: "active", created: ago(createdDaysAgo), canceledAt: null, pause: null, periodEnd: ago(-14),
  items: [{ amount: 750, interval: "day", intervalCount: 14, quantity: 1 }], percentOff: 0, osClientId: null, ...o,
});
const charge = (customer: string, amount: number, daysAgo = 1): StripeCharge => ({
  id: `ch_${customer}_${amount}`, customer, status: "succeeded", amount, refunded: 0, created: ago(daysAgo), subscription: null, failureMessage: null,
});
const checkout = (id: string, o: Partial<PaidCheckout> = {}): PaidCheckout => ({
  id, created: ago(0.1), customer: null, email: "jane@acmerealty.com", name: "Jane Doe", amount: 750, mode: "subscription", subscription: null, answers: [], ...o,
});
type Client = BillingClientRef;
/* As the watch runs it: billing's own ownership and suggestions from one snapshot. */
const run = (o: { customers: AccountSnapshot["customers"]; subscriptions?: StripeSubscription[]; charges?: StripeCharge[]; checkouts?: PaidCheckout[]; clients: Client[]; links?: StripeLinkRow[]; said?: string[]; named?: string[]; readAt?: number }) => {
  const snap: AccountSnapshot = { customers: o.customers, subscriptions: o.subscriptions ?? [], charges: o.charges ?? [], invoices: [], readAt: o.readAt ?? NOW };
  const links = o.links ?? [];
  return paymentAlerts({
    checkouts: o.checkouts ?? [], clients: o.clients, byClient: buildBilling(o.clients, snap, links), snapshot: snap,
    suggestions: emailSuggestions(o.clients, snap, links), now: NOW, said: new Set(o.said ?? []), named: new Set(o.named ?? []),
  });
};
const client = (id: string, name: string, o: Partial<Client> = {}): Client => ({
  id, name, stripeCustomerId: null, stripeSubscriptionId: null, createdAt: NOW - 90 * 86_400_000, status: "active", emails: [], internal: false, ...o,
});
const acme = (o: Partial<Client> = {}) => client("acme", "Acme Realty", { emails: ["jane@acmerealty.com"], ...o });

/* --------------------------------------------------------- found by email --- */

test("found by email: one alert to confirm it, with who, what they paid, the ids, and that nothing counts until then", () => {
  const out = run({
    customers: [{ id: "cus_jane", name: "Jane Doe", email: "jane@acmerealty.com", created: ago(1) }],
    subscriptions: [sub("sub_jane", "cus_jane", 1)],
    charges: [charge("cus_jane", 750)],
    checkouts: [checkout("cs_1", { customer: "cus_jane", subscription: "sub_jane", created: ago(1) })],
    clients: [acme({ createdAt: NOW - HOUR })],
  });
  assert.deepEqual(out.map((a) => a.ref), ["stripe-found:acme:cus_jane"], "said as found, not also as 'no client yet' or a new subscription");
  const a = out[0];
  assert.equal(a.kind, "stripe_found");
  assert.equal(a.severity, "info");
  assert.equal(a.clientId, "acme");
  assert.equal(a.title, "Stripe customer found for Acme Realty: confirm it");
  assert.equal(a.body, "Jane Doe (jane@acmerealty.com), customer cus_jane, has an email that is on Acme Realty. Paid $750.00. Subscription: $750.00, sub_jane, collecting. It counts for no one until an admin presses Yes, it's theirs on their Billing tab (or Not theirs).");
});

test("found for an old client and an old customer alike: every one is said once, whenever it is first found", () => {
  const base = { customers: [{ id: "cus_jane", name: "Jane Doe", email: "jane@acmerealty.com", created: ago(300) }], clients: [acme()] };
  assert.deepEqual(run(base).map((a) => a.ref), ["stripe-found:acme:cus_jane"]);
  assert.match(run(base)[0].body, /Nothing paid yet\. No subscription\./);
});

test("once confirmed, or said Not theirs, nothing more is said about it", () => {
  const base = { customers: [{ id: "cus_jane", name: "Jane Doe", email: "jane@acmerealty.com", created: ago(1) }], subscriptions: [sub("sub_jane", "cus_jane", 5)], clients: [acme()] };
  assert.deepEqual(run({ ...base, links: [{ clientId: "acme", customerId: "cus_jane", subscriptionId: null, excluded: false }] }), [], "confirmed: a link, old subscription");
  assert.deepEqual(run({ ...base, links: [{ clientId: "acme", customerId: "cus_jane", subscriptionId: null, excluded: true }] }), [], "Not theirs");
});

test("a subscription the found alert named isn't said again as new once it is confirmed", () => {
  const base = { customers: [{ id: "cus_jane", name: "Jane Doe", email: "jane@acmerealty.com", created: ago(0.5) }], subscriptions: [sub("sub_jane", "cus_jane", 0.5)], clients: [acme()] };
  const confirmed = { ...base, links: [{ clientId: "acme", customerId: "cus_jane", subscriptionId: null, excluded: false }] };
  assert.deepEqual(run(confirmed).map((a) => a.ref), ["stripe-newsub:sub_jane"], "without the found alert in the bell");
  assert.deepEqual(run({ ...confirmed, named: ["sub_jane"] }), [], "with it: named already");
});

test("never found for a non-client, an address on two clients, or our own address", () => {
  const cust = (email: string) => [{ id: "cus_x", name: "X", email, created: ago(1) }];
  assert.deepEqual(run({ customers: cust("bs@gmail.com"), clients: [acme(), client("bs", "BrokerStaffer", { internal: true, emails: ["bs@gmail.com"] })] }), []);
  assert.deepEqual(run({ customers: cust("pat@shared.com"), clients: [client("a", "A", { emails: ["pat@shared.com"] }), client("b", "B", { emails: ["pat@shared.com"] })] }), []);
  assert.deepEqual(run({ customers: cust("eddy@brokerstaffer.com"), clients: [acme({ emails: ["eddy@brokerstaffer.com"] })] }), []);
});

/* ------------------------------------------------------------ no client yet --- */

test("a payment no client has and no email finds: a warning naming the payer, what they paid, their answers, the ids and how to tie it", () => {
  const out = run({
    customers: [{ id: "cus_new", name: "Sam Smith", email: "sam@newteam.com", created: ago(0.1) }],
    subscriptions: [sub("sub_new", "cus_new", 0.1)],
    checkouts: [checkout("cs_1", { customer: "cus_new", subscription: "sub_new", email: "sam@newteam.com", name: "Sam Smith", answers: [{ label: "Are you a brokerage or a team?", value: "Team" }, { label: "Your market or MLS", value: "Austin" }] })],
    clients: [acme()],
  });
  assert.equal(out.length, 1);
  const a = out[0];
  assert.deepEqual([a.kind, a.severity, a.ref, a.clientId, a.title], ["stripe_payment_unmatched", "warning", "stripe-unmatched:cs_1", null, "New payment, no client yet: Sam Smith"]);
  assert.equal(a.body, "$750.00 every 14 days, paid Nov 6 by Sam Smith (sam@newteam.com). Answered: Team · Austin. Customer cus_new, subscription sub_new. If they're new, paste sub_new into Stripe subscription in Onboard client; if not, an admin can link it on their Billing tab.");
});

test("a one-time payment no client has: there is no subscription to paste", () => {
  const out = run({
    customers: [{ id: "cus_one", name: "Sam Smith", email: "sam@newteam.com", created: ago(0.1) }],
    checkouts: [checkout("cs_one", { customer: "cus_one", mode: "payment", amount: 1, email: "sam@newteam.com", name: "Sam Smith" })],
    clients: [acme()],
  });
  assert.equal(out[0].body, "$1.00 one-time, paid Nov 6 by Sam Smith (sam@newteam.com). Customer cus_one. Once they're onboarded the OS looks for it by email and asks to confirm it; or an admin can link cus_one on their Billing tab.");
});

test("from a company domain one client has: named as likely, with that client's Billing tab, never counted or found", () => {
  const out = run({
    customers: [{ id: "cus_rc", name: "Ricky Cain", email: "ops@cainrealtygroup.com", created: ago(0.1) }],
    subscriptions: [sub("sub_rc", "cus_rc", 0.1)],
    checkouts: [checkout("cs_rc", { customer: "cus_rc", subscription: "sub_rc", email: "ops@cainrealtygroup.com", name: "Ricky Cain" })],
    clients: [acme(), client("cain", "Cain Realty Group", { emails: ["office@cainrealtygroup.com"] })],
  });
  assert.deepEqual(out.map((a) => [a.kind, a.clientId]), [["stripe_payment_unmatched", "cain"]]);
  assert.match(out[0].body, /Customer cus_rc, subscription sub_rc\. Likely Cain Realty Group \(same email domain\): if so, an admin can link sub_rc on their Billing tab\. If they're new, paste sub_rc into Stripe subscription in Onboard client\.$/);
});

test("a free mail domain, or a domain two clients have, is no hint", () => {
  for (const [email, clients] of [
    ["sam@gmail.com", [acme(), client("b", "B Team", { emails: ["bob@gmail.com"] })]],
    ["sam@shared.com", [client("a", "A Team", { emails: ["a@shared.com"] }), client("b", "B Team", { emails: ["b@shared.com"] })]],
  ] as const) {
    const out = run({ customers: [{ id: "cus_x", name: "Sam", email, created: ago(0.1) }], checkouts: [checkout("cs_x", { customer: "cus_x", email, name: "Sam", mode: "payment" })], clients: [...clients] });
    assert.equal(out[0].clientId, null, email);
    assert.doesNotMatch(out[0].body, /Likely/, email);
  }
});

test("a payment a client has is not 'no client yet'", () => {
  const out = run({
    customers: [{ id: "cus_jane", name: "Jane Doe", email: "jane@acmerealty.com", created: ago(400) }],
    subscriptions: [sub("sub_old", "cus_jane", 400)],
    checkouts: [checkout("cs_2", { customer: "cus_jane", subscription: null, mode: "payment", amount: 250 })],
    clients: [acme({ stripeCustomerId: "cus_jane" })],
  });
  assert.deepEqual(out, []);
});

test("a payment whose customer the copy of Stripe hasn't seen yet waits for a later pass", () => {
  const ch = checkout("cs_new", { customer: "cus_unseen", subscription: "sub_unseen", email: "owner@newco.com", name: "New Owner" });
  assert.deepEqual(run({ customers: [], checkouts: [ch], clients: [acme()] }), []);
  const later = run({ customers: [{ id: "cus_unseen", name: "New Owner", email: "owner@newco.com", created: ago(0.1) }], subscriptions: [sub("sub_unseen", "cus_unseen", 0.1)], checkouts: [ch], clients: [acme()] });
  assert.deepEqual(later.map((a) => a.ref), ["stripe-unmatched:cs_new"]);
});

test("Stripe kept no customer, but the payer is on a client: said as that client's", () => {
  const out = run({ customers: [], checkouts: [checkout("cs_3", { customer: null, mode: "payment", amount: 500 })], clients: [acme()] });
  assert.deepEqual([out[0].title, out[0].clientId, out[0].severity], ["Payment from Acme Realty, not on their Billing tab", "acme", "info"]);
  assert.equal(out[0].body, "$500.00 one-time, paid Nov 6 by Jane Doe (jane@acmerealty.com), who is on Acme Realty. Stripe kept no customer, so it can't be counted on their Billing tab.");
});

test("Stripe kept no customer, and the address is on a real client and a non-client: two clients, so neither", () => {
  const out = run({ customers: [], checkouts: [checkout("cs_two", { customer: null, mode: "payment", amount: 50 })], clients: [acme(), client("demo", "Demo Portal", { internal: true, emails: ["jane@acmerealty.com"] })] });
  assert.deepEqual([out[0].title, out[0].clientId], ["New payment, no client yet: Jane Doe", null]);
});

test("Stripe kept no customer and nobody knows the payer", () => {
  const out = run({ customers: [], checkouts: [checkout("cs_4", { customer: null, email: "x@y.com", name: null, mode: "payment", amount: 100 })], clients: [acme()] });
  assert.equal(out[0].title, "New payment, no client yet: x@y.com");
  assert.equal(out[0].body, "$100.00 one-time, paid Nov 6 by x@y.com. Stripe kept no customer, so it can't be linked to a client.");
});

test("our own address on a client never makes a payment that client's", () => {
  const out = run({ customers: [], checkouts: [checkout("cs_own", { customer: null, email: "eddy@brokerstaffer.com", name: "Eddy", mode: "payment", amount: 1 })], clients: [acme({ emails: ["eddy@brokerstaffer.com"] })] });
  assert.deepEqual([out[0].title, out[0].clientId], ["New payment, no client yet: Eddy", null]);
});

test("a payment older than two days is not said", () => {
  assert.deepEqual(run({ customers: [], checkouts: [checkout("cs_old", { created: ago(2.1), email: "x@y.com" })], clients: [acme()] }), []);
});

/* ------------------------------------------------------------ name matches --- */

test("a new customer counted by name (a client paying with a new card): said, with what pausing does", () => {
  const out = run({ customers: [{ id: "cus_card2", name: "Acme Realty (2nd Card)", email: null, created: ago(1) }], subscriptions: [sub("sub_c2", "cus_card2", 20)], clients: [acme({ emails: [] })] });
  assert.deepEqual(out.map((a) => a.ref), ["stripe-counted:acme:cus_card2"]);
  assert.equal(out[0].title, "Stripe customer counted for Acme Realty");
  assert.equal(out[0].body, "Acme Realty (2nd Card), customer cus_card2, matched by name. Subscription: $750.00 every 14 days, sub_c2, collecting. Pausing or churning Acme Realty pauses it too. If it isn't theirs, an admin can press Not this client on their Billing tab.");
});

test("counted by name for a client already churned: says what is still collecting, not what a pause would do", () => {
  const out = run({ customers: [{ id: "cus_n", name: "Acme Realty Old", email: null, created: ago(1) }], subscriptions: [sub("sub_n", "cus_n", 20)], clients: [acme({ status: "churned", emails: [] })] });
  assert.match(out[0].body, /Acme Realty is churned, but this subscription is still collecting\. If it isn't theirs/);
});

test("an old name match on an old client says nothing", () => {
  assert.deepEqual(run({ customers: [{ id: "cus_n", name: "Acme Realty Old", email: null, created: ago(300) }], clients: [acme()] }), []);
});

test("a match on BrokerStaffer or the Demo Portal is never said", () => {
  assert.deepEqual(run({ customers: [{ id: "cus_bs", name: "BrokerStaffer", email: null, created: ago(1) }], clients: [acme(), client("bs", "BrokerStaffer", { createdAt: NOW, internal: true })] }), []);
});

/* ------------------------------------------------------- new subscriptions --- */

test("a new subscription on a client's own customer: said with its ids, and its day in Eastern time", () => {
  const out = run({ customers: [{ id: "cus_jane", name: "Jane Doe", email: "jane@acmerealty.com", created: ago(400) }], subscriptions: [sub("sub_new", "cus_jane", 0.2)], clients: [acme({ stripeCustomerId: "cus_jane" })] });
  assert.deepEqual(out.map((a) => [a.ref, a.title, a.body]), [["stripe-newsub:sub_new", "New subscription: Acme Realty", "$750.00 every 14 days, started Nov 6. Subscription sub_new, customer cus_jane."]]);
});

test("a new subscription the OS created for a client is said the same way", () => {
  const out = run({ customers: [{ id: "cus_os", name: "Acme Realty", email: null, created: ago(400) }], subscriptions: [sub("sub_os", "cus_os", 0.2, { osClientId: "acme" })], clients: [acme({ stripeCustomerId: "cus_os" })] });
  assert.deepEqual(out.map((a) => a.ref), ["stripe-newsub:sub_os"]);
});

test("a name-matched customer and its new subscription, found together: one alert, which names the subscription", () => {
  const out = run({ customers: [{ id: "cus_n", name: "Acme Realty Old", email: null, created: ago(0.5) }], subscriptions: [sub("sub_n", "cus_n", 0.5)], clients: [acme()] });
  assert.deepEqual(out.map((a) => a.ref), ["stripe-counted:acme:cus_n"]);
  assert.match(out[0].body, /sub_n/);
});

test("a later subscription on a name-matched customer: said, with how it is counted; one the counted alert named isn't", () => {
  const base = { customers: [{ id: "cus_n", name: "Acme Realty Old", email: null, created: ago(300) }], subscriptions: [sub("sub_up", "cus_n", 0.3)], clients: [acme()] };
  const out = run(base);
  assert.deepEqual(out.map((a) => a.ref), ["stripe-newsub:sub_up"]);
  assert.match(out[0].body, /Counted for Acme Realty because the customer's name matches; if it isn't theirs, an admin can press Not this client on their Billing tab\.$/);
  assert.deepEqual(run({ ...base, named: ["sub_up"] }), []);
  const fresh = { ...base, customers: [{ id: "cus_n", name: "Acme Realty Old", email: null, created: ago(5) }], subscriptions: [sub("sub_first", "cus_n", 5), sub("sub_second", "cus_n", 0.2)] };
  assert.ok(!run(fresh).some((a) => a.ref === "stripe-newsub:sub_second"), "counted in this pass: its alert names both");
  assert.ok(run({ ...fresh, said: ["stripe-counted:acme:cus_n"], named: ["sub_first"] }).some((a) => a.ref === "stripe-newsub:sub_second"), "said before, naming only the first");
});

/* --------------------------------------------------- onboarded, nothing found --- */

const onboarded = (o: Partial<Client> = {}) => client("nt", "New Team", { createdAt: NOW - 2 * HOUR, status: "onboarding", emails: ["owner@newteam.com"], ...o });
const waiting = [
  { id: "cus_w1", name: "Pat Lee", email: "pat@otherco.com", created: ago(3) },
  { id: "cus_w2", name: "Sam Smith", email: "billing@newteam.com", created: ago(10) },
];
const waitingPaid = [charge("cus_w1", 500), charge("cus_w2", 750)];
const noCustomer = (o: Parameters<typeof run>[0]) => run(o).find((a) => a.kind === "stripe_no_customer");

test("onboarded and nothing in Stripe matches or is found, with payments waiting: those payments, the likely one first", () => {
  const a = noCustomer({ customers: waiting, charges: waitingPaid, clients: [acme(), onboarded()] });
  assert.ok(a);
  assert.deepEqual([a.ref, a.clientId, a.severity, a.title], ["stripe-nocustomer:nt", "nt", "warning", "No Stripe payment found for New Team"]);
  assert.equal(a.body, "Onboarded Nov 6. No Stripe customer has New Team's emails or name. Paid lately with no client: Sam Smith (billing@newteam.com), $750.00, cus_w2 (same email domain); Pat Lee (pat@otherco.com), $500.00, cus_w1. If one is theirs, an admin can link it on their Billing tab.");
});

test("not said when something is found by email for it: the found alert says that", () => {
  const out = run({ customers: [...waiting, { id: "cus_own", name: "Owner", email: "owner@newteam.com", created: ago(1) }], charges: waitingPaid, clients: [onboarded()] });
  assert.deepEqual(out.map((a) => a.kind), ["stripe_found"]);
});

test("not while onboarding is settling, before Stripe was read after it, when counted, nothing waits, old, churned or ours", () => {
  assert.equal(noCustomer({ customers: waiting, charges: waitingPaid, clients: [onboarded({ createdAt: NOW - SETTLE_MS + 60_000 })], readAt: NOW + 2 * HOUR }), undefined, "too new");
  assert.equal(noCustomer({ customers: waiting, charges: waitingPaid, clients: [onboarded()], readAt: NOW - 2 * HOUR + 60_000 }), undefined, "Stripe read before it settled");
  assert.equal(noCustomer({ customers: [...waiting, { id: "cus_rec", name: "R", email: null, created: ago(1) }], charges: waitingPaid, clients: [onboarded({ stripeCustomerId: "cus_rec" })] }), undefined, "counted");
  assert.equal(noCustomer({ customers: waiting, charges: [], clients: [onboarded()] }), undefined, "nothing paid");
  assert.equal(noCustomer({ customers: waiting, charges: waitingPaid, clients: [onboarded({ createdAt: NOW - 8 * 86_400_000 })] }), undefined, "over a week ago");
  assert.equal(noCustomer({ customers: waiting, charges: waitingPaid, clients: [onboarded({ status: "churned" })] }), undefined, "churned");
  assert.equal(noCustomer({ customers: waiting, charges: waitingPaid, clients: [onboarded({ internal: true })] }), undefined, "ours");
});

test("never offered: our own test payments, refunded ones, or one found for another client; four or more say how many more", () => {
  const many = [
    ...waiting,
    { id: "cus_w3", name: "C", email: "c@c-co.com", created: ago(1) },
    { id: "cus_w4", name: "D", email: "d@d-co.com", created: ago(2) },
    { id: "cus_ours", name: "Eddy", email: "eddy@brokerstaffer.com", created: ago(1) },
    { id: "cus_refunded", name: "R", email: "r@r-co.com", created: ago(1) },
    { id: "cus_theirs", name: "Jane", email: "jane@acmerealty.com", created: ago(1) },
  ];
  const charges = [...waitingPaid, charge("cus_w3", 1), charge("cus_w4", 1), charge("cus_ours", 1), { ...charge("cus_refunded", 250), refunded: 250 }, charge("cus_theirs", 900)];
  const a = noCustomer({ customers: many, charges, clients: [acme(), onboarded()] })!;
  assert.doesNotMatch(a.body, /cus_ours|cus_refunded|cus_theirs/);
  assert.match(a.body, /^Onboarded Nov 6\. .*Sam Smith .*cus_w2 \(same email domain\); C \(c@c-co\.com\), \$1\.00, cus_w3; D .*cus_w4; and 1 more\./);
});

/* ------------------------------------------------------------------ the whole --- */

test("paid before the client existed, then onboarded: 'no client yet' first, then 'found, confirm it', each once", () => {
  const customers = [{ id: "cus_sam", name: "Sam Smith", email: "sam@newteam.com", created: ago(1) }];
  const subscriptions = [sub("sub_sam", "cus_sam", 1)];
  const checkouts = [checkout("cs_6", { customer: "cus_sam", subscription: "sub_sam", email: "sam@newteam.com", name: "Sam Smith", created: ago(1) })];
  assert.deepEqual(run({ customers, subscriptions, checkouts, clients: [acme()] }).map((a) => a.ref), ["stripe-unmatched:cs_6"]);
  const after = run({ customers, subscriptions, checkouts, clients: [acme(), client("nt", "New Team", { createdAt: NOW - 60_000, status: "onboarding", emails: ["sam@newteam.com"] })] });
  assert.deepEqual(after.map((a) => a.ref), ["stripe-found:nt:cus_sam"]);
});

test("every ref is unique within a pass", () => {
  const out = run({
    customers: [{ id: "cus_a", name: "A", email: "a@a.com", created: ago(0.5) }, { id: "cus_b", name: "B", email: "b@b.com", created: ago(0.5) }],
    subscriptions: [sub("sub_a", "cus_a", 0.5), sub("sub_b", "cus_b", 0.5)],
    checkouts: [checkout("cs_a", { customer: "cus_a", subscription: "sub_a" }), checkout("cs_b", { customer: "cus_b", subscription: "sub_b" })],
    clients: [client("x", "X Team", { createdAt: NOW, emails: ["a@a.com"] })],
  });
  const refs = out.map((a) => a.ref);
  assert.equal(new Set(refs).size, refs.length);
  assert.deepEqual(refs.sort(), ["stripe-found:x:cus_a", "stripe-unmatched:cs_b"]);
});

test("handed a suggestion for a non-client anyway, the bell still says nothing (the second guard)", () => {
  const snap: AccountSnapshot = { customers: [{ id: "cus_bs", name: "Test", email: "t@gmail.com", created: ago(1) }], subscriptions: [], charges: [], invoices: [], readAt: NOW };
  const clients = [client("bs", "BrokerStaffer", { internal: true, emails: ["t@gmail.com"] })];
  const out = paymentAlerts({ checkouts: [], clients, byClient: buildBilling(clients, snap, []), snapshot: snap, suggestions: [{ clientId: "bs", customerId: "cus_bs" }], now: NOW });
  assert.deepEqual(out, []);
});

test("after Not theirs, no hint names that client again: not in 'no client yet', not in 'no Stripe payment found'", () => {
  const customers = [{ id: "cus_jane", name: "Jane Doe", email: "jane@acmerealty.com", created: ago(0.5) }];
  const subscriptions = [sub("sub_jane", "cus_jane", 0.5)];
  const checkouts = [checkout("cs_j", { customer: "cus_jane", subscription: "sub_jane", created: ago(0.5) })];
  const links: StripeLinkRow[] = [{ clientId: "acme", customerId: "cus_jane", subscriptionId: null, excluded: true }];
  const clients = [acme({ createdAt: NOW - 2 * HOUR, status: "onboarding", emails: ["office@acmerealty.com"] })];
  const snap: AccountSnapshot = { customers, subscriptions, charges: [charge("cus_jane", 750)], invoices: [], readAt: NOW };
  const out = paymentAlerts({ checkouts, clients, byClient: buildBilling(clients, snap, links), snapshot: snap, suggestions: emailSuggestions(clients, snap, links), excluded: new Set(["acme|cus_jane"]), now: NOW });
  const unmatched = out.find((a) => a.kind === "stripe_payment_unmatched")!;
  assert.equal(unmatched.clientId, null);
  assert.doesNotMatch(unmatched.body, /Likely/);
  assert.equal(out.find((a) => a.kind === "stripe_no_customer"), undefined, "the only waiting payment is one Acme ruled out");
});

test("a payment Stripe kept no customer for, from a just-onboarded client: said as theirs, not also 'no Stripe payment found'", () => {
  const out = run({
    customers: [{ id: "cus_w1", name: "Pat Lee", email: "pat@otherco.com", created: ago(3) }],
    charges: [charge("cus_w1", 500)],
    checkouts: [checkout("cs_nc", { customer: null, mode: "payment", amount: 500, email: "owner@newteam.com", name: "Owner" })],
    clients: [client("nt", "New Team", { createdAt: NOW - 2 * HOUR, status: "onboarding", emails: ["owner@newteam.com"] })],
  });
  assert.deepEqual(out.map((a) => a.kind), ["stripe_payment_unmatched"]);
  assert.equal(out[0].title, "Payment from New Team, not on their Billing tab");
});

test("never offered to a new client: a customer whose subscription another client owns", () => {
  const out = run({
    customers: [...waiting, { id: "cus_sub", name: "Owned", email: "x@owned-co.com", created: ago(2) }],
    subscriptions: [sub("sub_b", "cus_sub", 2)],
    charges: [...waitingPaid, charge("cus_sub", 900)],
    // B's subscription linked by hand; someone said Not this client to the customer for B, so B keeps only the subscription.
    clients: [onboarded(), client("b", "B Team")],
    links: [{ clientId: "b", customerId: "cus_sub", subscriptionId: "sub_b", excluded: false }, { clientId: "b", customerId: "cus_sub", subscriptionId: null, excluded: true }],
  });
  const a = out.find((x) => x.kind === "stripe_no_customer")!;
  assert.doesNotMatch(a.body, /cus_sub/);
});

test("a payment that names a client by domain also stands for 'no Stripe payment found' for it", () => {
  const out = run({
    customers: [{ id: "cus_rc", name: "Ricky", email: "ops@newteam.com", created: ago(0.1) }, ...waiting],
    subscriptions: [sub("sub_rc", "cus_rc", 0.1)],
    charges: waitingPaid,
    checkouts: [checkout("cs_rc", { customer: "cus_rc", subscription: "sub_rc", email: "ops@newteam.com", name: "Ricky" })],
    clients: [onboarded({ emails: ["owner@newteam.com"] })],
  });
  assert.deepEqual(out.map((a) => [a.kind, a.clientId]), [["stripe_payment_unmatched", "nt"]]);
});

test("a payment Stripe kept no customer for names no client by domain: nothing can be linked, and nothing is hinted", () => {
  const out = run({
    customers: waiting,
    charges: waitingPaid,
    checkouts: [checkout("cs_dom", { customer: null, mode: "payment", amount: 300, email: "someone@newteam.com", name: "Someone" })],
    clients: [onboarded({ emails: ["owner@newteam.com"] })],
  });
  const unmatched = out.find((a) => a.kind === "stripe_payment_unmatched")!;
  assert.equal(unmatched.clientId, null);
  assert.ok(out.some((a) => a.kind === "stripe_no_customer"), "and it doesn't stand for the client's payment");
});
