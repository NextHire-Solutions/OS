import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { BILLING_REFUSAL, SHARED_BILLING_OPEN, invoiceScope, pickBillingCustomer } from "./billing-pick.ts";

/* The portal's Billing link opens only a Stripe customer that is the client's alone (19 Oct). */

const sub = (id: string, customer: string, current: boolean) => ({ id, customer, current } as never);
const cus = (id: string, shared = false) => ({ id, name: id, source: "record", shared } as never);

test("the current subscription's customer — even when the client has paid through other cards before", () => {
  assert.deepEqual(pickBillingCustomer({ clientId: "me", subscriptions: [sub("s_old", "cus_old", false), sub("s_now", "cus_now", true)], customers: [cus("cus_old"), cus("cus_now")] }), { ok: true, customer: "cus_now" });
});

test("a card another client also pays through is never opened (Raintown + JPAR)", () => {
  const r = pickBillingCustomer({ clientId: "me", subscriptions: [sub("s_rt", "cus_rj", true)], customers: [cus("cus_rj", true)] });
  assert.deepEqual(r, { ok: false, reason: "shared" });
  assert.match(BILLING_REFUSAL.shared, /handled by our team/);
});

test("no subscription: the one customer, if there is exactly one; else refused", () => {
  assert.deepEqual(pickBillingCustomer({ clientId: "me", subscriptions: [], customers: [cus("cus_1")] }), { ok: true, customer: "cus_1" });
  assert.deepEqual(pickBillingCustomer({ clientId: "me", subscriptions: [], customers: [cus("cus_1"), cus("cus_2")] }), { ok: false, reason: "ambiguous" });
  assert.deepEqual(pickBillingCustomer({ clientId: "me", subscriptions: [], customers: [] }), { ok: false, reason: "no-billing" });
  assert.deepEqual(pickBillingCustomer(undefined), { ok: false, reason: "no-billing" });
});

test("refused when ANY other client has a subscription on that customer, or claims it — even if it is not marked shared (21 Oct review)", () => {
  const me = { clientId: "rt", subscriptions: [sub("s_rt", "cus_rj", true)], customers: [cus("cus_rj")] };
  // JPAR's subscription linked by hand to JPAR, JPAR excluded from the customer: Raintown alone "claims" it.
  const jpar = { clientId: "jp", subscriptions: [sub("s_jp", "cus_rj", true)], customers: [] };
  assert.deepEqual(pickBillingCustomer(me, [me, jpar]), { ok: false, reason: "shared" });
  const claims = { clientId: "x", subscriptions: [], customers: [cus("cus_rj")] };
  assert.deepEqual(pickBillingCustomer(me, [me, claims]), { ok: false, reason: "shared" });
  const unrelated = { clientId: "u", subscriptions: [sub("s_u", "cus_other", true)], customers: [cus("cus_other")] };
  assert.deepEqual(pickBillingCustomer(me, [me, unrelated]), { ok: true, customer: "cus_rj" }, "another client on another customer changes nothing");
});

test("a current subscription whose customer is not counted as the client's is refused, not guessed", () => {
  assert.deepEqual(pickBillingCustomer({ clientId: "me", subscriptions: [sub("s", "cus_x", true)], customers: [cus("cus_y")] }), { ok: false, reason: "ambiguous" });
});

test("the route: the reviewers or the portal's own signed-in client only, a real click only, the client's own customer, Stripe's billing page only", () => {
  const route = readFileSync("src/app/api/crm-preview/billing/route.ts", "utf8");
  const gate = route.indexOf("crmViewerOf(request)");
  assert.ok(gate > 0 && gate < route.indexOf("mayOpenPortal(viewer, client)") && route.indexOf("mayOpenPortal(viewer, client)") < route.indexOf("admit("), "who first, then the portal is theirs");
  assert.match(route, /admit\(who, role, "billing", request\.headers\)/);
  assert.ok(route.indexOf("admit(") < route.indexOf("getAccountBilling("), "the click check before any Stripe read");
  assert.ok(route.indexOf("pickBillingCustomer(") < route.indexOf("billingPortalUrl("), "the customer is checked before a page is made");
  assert.match(route, /pickBillingCustomer\(byClient\.get\(record\.id\), byClient\.values\(\)\)/, "every other client is checked too");
  assert.doesNotMatch(route, /marketContext\(/, "Billing never waits on the agent database");
  assert.deepEqual([...route.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]), ["GET"]);
  assert.match(route, /const back = `\$\{publicOrigin\(\)\}\/crm-preview\?client=/, "Stripe's Return goes to the public site, not the container's localhost");
  assert.doesNotMatch(route, /request\.(url|nextUrl\.origin)/, "never the internal address");
  const lib = readFileSync("src/lib/crm-preview/billing-portal.ts", "utf8");
  assert.match(lib, /if \(!\/\^https:\\\/\\\/billing\\\.stripe\\\.com\\\/\/\.test\(body\.url\)\)/, "only a billing.stripe.com address is followed");
  assert.equal((lib.match(/method: "POST"/g) ?? []).length, 1, "one Stripe write: making the session");
  assert.match(lib, /`\$\{STRIPE\}\/billing_portal\/sessions`/);
});

/* The Billing PAGE (17 Nov, Douglas Elliman Las Vegas): on a shared card, only the client's own subscriptions' invoices. */
const own = (id: string, customer: string, current: boolean, source = "record") => ({ id, customer, current, source } as never);

test("the page: a customer of the client's alone lists all its invoices, and Manage billing opens it", () => {
  assert.deepEqual(invoiceScope({ clientId: "me", subscriptions: [own("s1", "cus_me", true)], customers: [cus("cus_me")] }), { ok: true, manage: true, customer: "cus_me" });
});

test("the page: a card shared with another client lists only this client's own subscriptions (Las Vegas, not Los Angeles)", () => {
  const lv = { clientId: "lv", subscriptions: [own("sub_lv", "cus_de", true)], customers: [cus("cus_de", true)] };
  const la = { clientId: "la", subscriptions: [own("sub_la", "cus_de", true)], customers: [cus("cus_de", true)] };
  assert.deepEqual(invoiceScope(lv, [lv, la]), { ok: true, manage: false, subscriptions: ["sub_lv"] });
  assert.deepEqual(invoiceScope(la, [lv, la]), { ok: true, manage: false, subscriptions: ["sub_la"] });
  // The Billing link still refuses the shared customer.
  assert.deepEqual(pickBillingCustomer(lv, [lv, la]), { ok: false, reason: "shared" });
});

test("the page: a subscription the client only got by guess (the card's first client), or that another client also lists, is never shown", () => {
  const guessed = { clientId: "a", subscriptions: [own("s_old", "cus_x", false, "subscription"), own("s_a", "cus_x", true)], customers: [cus("cus_x", true)] };
  const other = { clientId: "b", subscriptions: [own("s_b", "cus_x", true), own("s_a", "cus_x", false)], customers: [cus("cus_x", true)] };
  assert.deepEqual(invoiceScope(guessed, [guessed, other]), { ok: false, reason: "shared" }, "s_old is a guess, s_a is listed by b too");
  const onlyGuess = { clientId: "c", subscriptions: [own("s_c", "cus_y", true, "subscription")], customers: [cus("cus_y", true)] };
  assert.deepEqual(invoiceScope(onlyGuess, [onlyGuess]), { ok: false, reason: "shared" });
});

test("the page: the Billing link's other refusals stand (no billing, ambiguous)", () => {
  assert.deepEqual(invoiceScope(undefined), { ok: false, reason: "no-billing" });
  assert.deepEqual(invoiceScope({ clientId: "me", subscriptions: [], customers: [cus("c1"), cus("c2")] }), { ok: false, reason: "ambiguous" });
});

/* 19 Nov, the user: "Turn it on anyway, if one person manages billing for both offices" — Douglas Elliman Las Vegas. */
const LV = "7fb537e9-19ef-4ed5-853c-7333356cf424"; // os_clients id, as billing keys it

test("Douglas Elliman Las Vegas — and only it — may open the shared customer's Stripe page", () => {
  assert.deepEqual([...SHARED_BILLING_OPEN], [LV]);
  const lv = { clientId: LV, subscriptions: [own("sub_lv", "cus_de", true)], customers: [cus("cus_de", true)] };
  const la = { clientId: "la", subscriptions: [own("sub_la", "cus_de", true)], customers: [cus("cus_de", true)] };
  assert.deepEqual(pickBillingCustomer(lv, [lv, la]), { ok: true, customer: "cus_de" }, "Las Vegas: opened");
  assert.deepEqual(pickBillingCustomer(la, [lv, la]), { ok: false, reason: "shared" }, "Los Angeles: still refused");
  // Also when the customer is not marked shared but another client pays through it.
  const lv2 = { clientId: LV, subscriptions: [own("sub_lv", "cus_de", true)], customers: [cus("cus_de")] };
  assert.deepEqual(pickBillingCustomer(lv2, [lv2, la]), { ok: true, customer: "cus_de" });
  // Any other shared customer (Raintown + JPAR) is still refused.
  assert.deepEqual(pickBillingCustomer({ clientId: "rt", subscriptions: [sub("s_rt", "cus_rj", true)], customers: [cus("cus_rj", true)] }), { ok: false, reason: "shared" });
});

test("its Billing page shows Manage billing, but still lists only Las Vegas's own invoices (never Los Angeles's)", () => {
  const lv = { clientId: LV, subscriptions: [own("sub_lv", "cus_de", true)], customers: [cus("cus_de", true)] };
  const la = { clientId: "la", subscriptions: [own("sub_la", "cus_de", true)], customers: [cus("cus_de", true)] };
  assert.deepEqual(invoiceScope(lv, [lv, la]), { ok: true, manage: true, subscriptions: ["sub_lv"] });
  assert.deepEqual(invoiceScope(la, [lv, la]), { ok: true, manage: false, subscriptions: ["sub_la"] });
});

test("with no allow list the plain rule holds (what the list adds is only that one client)", () => {
  const lv = { clientId: LV, subscriptions: [own("sub_lv", "cus_de", true)], customers: [cus("cus_de", true)] };
  const la = { clientId: "la", subscriptions: [own("sub_la", "cus_de", true)], customers: [cus("cus_de", true)] };
  assert.deepEqual(pickBillingCustomer(lv, [lv, la], new Set()), { ok: false, reason: "shared" });
  assert.deepEqual(invoiceScope(lv, [lv, la], new Set()), { ok: true, manage: false, subscriptions: ["sub_lv"] });
});
