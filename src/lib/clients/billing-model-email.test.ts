import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildBilling, domainHint, emailKey, emailSuggestions, foundByEmail, matchEmailKey, unattributedByCustomer,
  type AccountSnapshot, type BillingClientRef, type StripeLinkRow, type StripeSubscription,
} from "./billing-model.ts";

/*
 * FOUND BY EMAIL, NOT COUNTED (6 Nov; the user, after three reviews: one click to confirm). A customer whose email is on
 * a client is SUGGESTED for that client and counts for no one until a person presses Yes, it's theirs (a link). Each case
 * here is a way a suggestion could name the wrong client, or a match could count without anyone confirming it.
 */

const T = (iso: string) => Math.floor(Date.parse(`${iso}T15:00:00Z`) / 1000);
const sub = (id: string, customer: string, created: string, o: Partial<StripeSubscription> = {}): StripeSubscription => ({
  id, customer, status: "active", created: T(created), canceledAt: null, pause: null, periodEnd: T("2026-11-20"),
  items: [{ amount: 750, interval: "day", intervalCount: 14, quantity: 1 }], percentOff: 0, osClientId: null, ...o,
});
const snap = (customers: AccountSnapshot["customers"], subscriptions: StripeSubscription[] = []): AccountSnapshot => ({
  customers, subscriptions,
  charges: subscriptions.map((s, i) => ({ id: `ch${i}`, customer: s.customer, status: "succeeded", amount: 750, refunded: 0, created: s.created, subscription: s.id, failureMessage: null })),
  invoices: [],
});
const client = (id: string, name: string, emails: string[], o: Partial<BillingClientRef> = {}): BillingClientRef =>
  ({ id, name, stripeCustomerId: null, stripeSubscriptionId: null, emails, ...o });
const found = (clients: BillingClientRef[], s: AccountSnapshot, links: StripeLinkRow[] = []) =>
  emailSuggestions(clients, s, links).map((x) => `${x.clientId}:${x.customerId}`);
const counted = (clients: BillingClientRef[], s: AccountSnapshot, links: StripeLinkRow[] = []) => {
  const b = buildBilling(clients, s, links);
  return Object.fromEntries(clients.map((c) => [c.id, b.get(c.id)!.customers.map((cu) => `${cu.id}:${cu.source}`)]));
};

test("a customer whose email is a client's contact is suggested for it, and counted for no one", () => {
  const s = snap([{ id: "cus_jane", name: "Jane Doe", email: "jane@acmerealty.com", created: T("2026-11-01") }], [sub("sub_jane", "cus_jane", "2026-11-01")]);
  const clients = [client("acme", "Acme Realty", ["jane@acmerealty.com"]), client("other", "Other Team", ["bob@other.com"])];
  assert.deepEqual(found(clients, s), ["acme:cus_jane"]);
  assert.deepEqual(counted(clients, s), { acme: [], other: [] }, "nothing counts until someone confirms it");
  const acme = buildBilling(clients, s, []).get("acme")!;
  assert.deepEqual([acme.subscriptions, acme.totalSpend, acme.mrr, acme.failedInvoices], [[], 0, 0, []], "no subscription, spend, MRR or failed invoice of it is the client's");
});

test("confirmed (a link): from then on it is the client's, and no longer suggested", () => {
  const s = snap([{ id: "cus_jane", name: "Jane Doe", email: "jane@acmerealty.com", created: T("2026-11-01") }], [sub("sub_jane", "cus_jane", "2026-11-01")]);
  const clients = [client("acme", "Acme Realty", ["jane@acmerealty.com"])];
  const links: StripeLinkRow[] = [{ clientId: "acme", customerId: "cus_jane", subscriptionId: null, excluded: false }];
  assert.deepEqual(found(clients, s, links), []);
  assert.deepEqual(counted(clients, s, links), { acme: ["cus_jane:linked"] });
  assert.deepEqual(buildBilling(clients, s, links).get("acme")!.subscriptions.map((x) => x.id), ["sub_jane"]);
});

test("Not theirs (an exclusion) is final: never suggested again", () => {
  const s = snap([{ id: "cus_jane", name: "Jane Doe", email: "jane@acmerealty.com", created: T("2026-11-01") }]);
  const links: StripeLinkRow[] = [{ clientId: "acme", customerId: "cus_jane", subscriptionId: null, excluded: true }];
  assert.deepEqual(found([client("acme", "Acme Realty", ["jane@acmerealty.com"])], s, links), []);
});

test("any of the client's people, case and spaces aside", () => {
  const s = snap([{ id: "cus_4", name: "Fourth", email: "  Fourth@Acme.COM ", created: T("2026-11-01") }]);
  assert.deepEqual(found([client("acme", "Acme Realty", ["first@acme.com", "second@acme.com", "third@acme.com", " FOURTH@acme.com"])], s), ["acme:cus_4"]);
});

test("an address on two clients suggests neither", () => {
  const s = snap([{ id: "cus_shared", name: "Pat", email: "pat@broker.com", created: T("2026-11-01") }]);
  assert.deepEqual(found([client("a", "Team A", ["pat@broker.com"]), client("b", "Team B", ["PAT@broker.com"])], s), []);
});

test("the same address twice on one client is still one client", () => {
  const s = snap([{ id: "cus_p", name: "Pat", email: "pat@broker.com", created: T("2026-11-01") }]);
  assert.deepEqual(found([client("a", "Team A", ["pat@broker.com", "Pat@Broker.com"])], s), ["a:cus_p"]);
});

test("a non-client is never suggested, and an address it shares with a real client suggests neither", () => {
  const s = snap([{ id: "cus_d", name: "Someone", email: "tester@gmail.com", created: T("2026-11-01") }]);
  assert.deepEqual(found([client("demo", "Demo Portal", ["tester@gmail.com"], { internal: true }), client("acme", "Acme Realty", ["jane@acme.com"])], s), []);
  assert.deepEqual(found([client("demo", "Demo Portal", ["tester@gmail.com"], { internal: true }), client("acme", "Acme Realty", ["tester@gmail.com"])], s), []);
});

test("our own addresses never suggest anyone, even on a real client's record or sign-in list", () => {
  const s = snap([
    { id: "cus_e", name: "Eddy", email: "eddy@brokerstaffer.com", created: T("2026-11-01") },
    { id: "cus_s", name: "Support", email: "support@leads.brokerstaffer.com", created: T("2026-11-01") },
    { id: "cus_a", name: "Admin", email: "admin@outreachify.io", created: T("2026-11-01") },
  ]);
  assert.deepEqual(found([client("acme", "Acme Realty", ["eddy@brokerstaffer.com", "support@leads.brokerstaffer.com", "admin@outreachify.io"])], s), []);
});

test("a customer someone already has (record, link, subscription or name match) is never suggested to another", () => {
  const s = snap([{ id: "cus_jane", name: "Jane Doe", email: "jane@acmerealty.com", created: T("2026-11-01") }], [sub("sub_jane", "cus_jane", "2026-11-01")]);
  const acme = client("acme", "Acme Realty", ["jane@acmerealty.com"]);
  assert.deepEqual(found([acme, client("rec", "Record Holder", [], { stripeCustomerId: "cus_jane" })], s), []);
  assert.deepEqual(found([acme, client("lnk", "Linker", [])], s, [{ clientId: "lnk", customerId: "cus_jane", subscriptionId: null, excluded: false }]), []);
  assert.deepEqual(found([acme, client("own", "Sub Owner", [], { stripeSubscriptionId: "sub_jane" })], s), []);
  const named = snap([{ id: "cus_x", name: "Beta Homes", email: "ann@alpha.com", created: T("2026-11-01") }]);
  const two = [client("alpha", "Alpha Group", ["ann@alpha.com"]), client("beta", "Beta Homes", [])];
  assert.deepEqual(found(two, named), [], "named after Beta: the name match's, as before");
  assert.deepEqual(counted(two, named), { alpha: [], beta: ["cus_x:name match"] });
});

test("the name match is exactly as it was: emails on records change nothing it does", () => {
  const s = snap([{ id: "cus_m", name: "MattC Group Old", email: "matt@mattc.com", created: T("2026-11-01") }]);
  assert.deepEqual(counted([client("m", "MattC Group", ["matt@mattc.com"])], s), { m: ["cus_m:name match"] });
  assert.deepEqual(counted([{ id: "m", name: "MattC Group", stripeCustomerId: null, stripeSubscriptionId: null }], s), { m: ["cus_m:name match"] });
});

test("a customer with no email, or a record with junk in an email field, suggests nothing", () => {
  const s = snap([
    { id: "cus_none", name: "Somebody", email: null, created: T("2026-11-01") },
    { id: "cus_blank", name: "Somebody Else", email: "", created: T("2026-11-01") },
    { id: "cus_word", name: "A Third", email: "n/a", created: T("2026-11-01") },
  ]);
  assert.deepEqual(found([client("a", "Team A", ["", "n/a", "   "])], s), []);
});

test("the Billing tab's found list: who, what they paid, their subscriptions, since when", () => {
  const s = snap([{ id: "cus_jane", name: "Jane Doe", email: "jane@acmerealty.com", created: T("2026-11-01") }], [sub("sub_jane", "cus_jane", "2026-11-01"), sub("sub_old", "cus_jane", "2026-10-01", { status: "canceled", canceledAt: T("2026-10-20") })]);
  const clients = [client("acme", "Acme Realty", ["jane@acmerealty.com"])];
  assert.deepEqual(foundByEmail(s, emailSuggestions(clients, s, []), "acme"), [{
    id: "cus_jane", name: "Jane Doe", email: "jane@acmerealty.com", since: "2026-11-01", paid: 1500, payments: 2,
    subscriptions: [{ id: "sub_jane", amount: 750, every: "every 14 days", status: "collecting" }, { id: "sub_old", amount: 750, every: "every 14 days", status: "cancelled" }],
  }]);
  assert.deepEqual(foundByEmail(s, emailSuggestions(clients, s, []), "someone-else"), []);
});

test("the Billing tab's counted customers carry their email, to tell two apart", () => {
  const s = snap([{ id: "cus_jane", name: "Jane Doe", email: "jane@acmerealty.com", created: T("2026-11-01") }]);
  const b = buildBilling([client("acme", "Acme Realty", [], { stripeCustomerId: "cus_jane" })], s, []).get("acme")!;
  assert.deepEqual(b.customers, [{ id: "cus_jane", name: "Jane Doe", email: "jane@acmerealty.com", source: "record", shared: false }]);
});

test("money tied to nobody: found by email first, else the company-domain hint, never one someone said Not this client to", () => {
  const s: AccountSnapshot = {
    customers: [
      { id: "cus_rc", name: "Ricky Cain", email: "ops@cainrealtygroup.com", created: T("2026-09-11") },
      { id: "cus_f", name: "Found Person", email: "owner@found-co.com", created: T("2026-09-11") },
      { id: "cus_g", name: "Gina", email: "gina@gmail.com", created: T("2026-09-11") },
      { id: "cus_e", name: "living new york", email: "eddy@brokerstaffer.com", created: T("2026-02-07") },
      { id: "cus_x", name: "Excluded", email: "ex@cainrealtygroup.com", created: T("2026-09-11") },
    ],
    subscriptions: [],
    charges: ["cus_rc", "cus_f", "cus_g", "cus_e", "cus_x"].map((c, i) => ({ id: `ch${i}`, customer: c, status: "succeeded", amount: 100 + i, refunded: 0, created: T("2026-10-01"), subscription: null, failureMessage: null })),
    invoices: [],
  };
  const clients = [client("cain", "Cain Realty Group", ["office@cainrealtygroup.com"]), client("f", "Found Co", ["owner@found-co.com"]), client("g", "Gmail Team", ["owner@gmail.com"]), client("bs", "BrokerStaffer", ["eddy@brokerstaffer.com"], { internal: true })];
  const links: StripeLinkRow[] = [{ clientId: "cain", customerId: "cus_x", subscriptionId: null, excluded: true }];
  const rows = Object.fromEntries(unattributedByCustomer(clients, s, links).map((r) => [r.customerId, r.likely ?? null]));
  assert.deepEqual(rows, {
    cus_rc: { clientId: "cain", name: "Cain Realty Group", by: "domain" },
    cus_f: { clientId: "f", name: "Found Co", by: "email" },
    cus_g: null, cus_e: null, cus_x: null,
  });
});

test("matchEmailKey: an address, and not ours", () => {
  assert.equal(matchEmailKey(" Jane@Acme.COM "), "jane@acme.com");
  for (const ours of ["eddy@brokerstaffer.com", "x@leads.brokerstaffer.com", "admin@outreachify.io", "a@opslabs.ai", "s@ascense.io"]) assert.equal(matchEmailKey(ours), "", ours);
  assert.equal(matchEmailKey("x@notbrokerstaffer.com"), "x@notbrokerstaffer.com", "a domain that merely ends in the same letters is someone else's");
});

test("domainHint: the one client on the same company domain — never a free mail domain, a shared one, ours, or a non-client", () => {
  const cain = client("cain", "Cain Realty Group", ["office@cainrealtygroup.com"]);
  assert.equal(domainHint("ops@cainrealtygroup.com", [cain, client("acme", "Acme", ["jane@acme.com"])]), "cain");
  assert.equal(domainHint("OPS@CainRealtyGroup.com", [cain]), "cain", "case doesn't matter");
  assert.equal(domainHint("someone@gmail.com", [client("g", "G", ["owner@gmail.com"])]), null, "free mail");
  assert.equal(domainHint("x@compass.com", [client("a", "A", ["a@compass.com"]), client("b", "B", ["b@compass.com"])]), null, "two clients");
  assert.equal(domainHint("x@brokerstaffer.com", [client("a", "A", ["eddy@brokerstaffer.com"])]), null, "ours");
  assert.equal(domainHint("x@demo-co.com", [client("d", "Demo Portal", ["d@demo-co.com"], { internal: true })]), null, "a non-client");
  assert.equal(domainHint(null, [cain]), null);
  assert.equal(domainHint("not an address", [cain]), null);
});

test("emailKey: only something shaped like an address", () => {
  assert.equal(emailKey(" Jane@Acme.COM "), "jane@acme.com");
  for (const bad of [null, undefined, "", "n/a", "jane@", "@acme.com", "jane acme@x.com", "jane@acme"]) assert.equal(emailKey(bad), "", String(bad));
});

test("a customer one of whose subscriptions a client owns is that client's business: never found for another", () => {
  // B's subscription is linked to B by hand; someone said Not this client to the customer for B, so B claims only the subscription.
  const s = snap([{ id: "cus_p", name: "Pat", email: "pat@acme.com", created: T("2026-11-01") }], [sub("sub_b", "cus_p", "2026-11-01")]);
  const links: StripeLinkRow[] = [
    { clientId: "b", customerId: "cus_p", subscriptionId: "sub_b", excluded: false },
    { clientId: "b", customerId: "cus_p", subscriptionId: null, excluded: true },
  ];
  assert.deepEqual(found([client("acme", "Acme Realty", ["pat@acme.com"]), client("b", "B Team", [])], s, links), []);
});

test("the found list never fails on a customer without a creation date", () => {
  const s = snap([{ id: "cus_x", name: "X", email: "x@acme.com", created: undefined as unknown as number }]);
  const clients = [client("acme", "Acme Realty", ["x@acme.com"])];
  assert.equal(foundByEmail(s, emailSuggestions(clients, s, []), "acme")[0].since, "");
});
