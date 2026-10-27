import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { BILLING_REFUSAL, pickBillingCustomer } from "./billing-pick.ts";

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
