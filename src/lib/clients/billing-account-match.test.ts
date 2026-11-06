/*
 * Found by email, as billing reads it (6 Nov): the record's addresses and the portals' sign-in lists, read from the
 * in-memory database (fake-postgrest.ts), the account from the fake Stripe. Nothing leaves the process.
 *
 * Pinned: a customer found by email counts for no one (one click confirms it); the sign-in lists count, every page of
 * them; and when anything the suggestions need can't be read — the sign-in lists, or the links and exclusions — there
 * are none, rather than partial ones that could make an address on two clients look like one's. Ownership never waits
 * on them: a pause, churn or delete reads exactly as before.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest } from "../tools/master-inbox/test/fake-postgrest.ts";
import { FakeStripe } from "./usage-billing/test/fake-stripe.ts";

configureFakeEnvironment("MASTER_INBOX_");
for (const v of ["ONBOARDING_STRIPE_SECRET_KEY_TEST", "ONBOARDING_STRIPE_MODE", "STRIPE_MODE"]) delete process.env[v];
process.env.ONBOARDING_STRIPE_SECRET_KEY = "sk_live_51FakeFakeFakeFake";

const db = new FakePostgrest();
const stripe = new FakeStripe({ live: true });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  return url.host === "api.stripe.com" ? stripe.fetch(input, init) : db.fetch(input, init);
}) as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const { forgetSignIns, getAccountBilling, getClientBillingDetail, getStripeSnapshot } = await import("./billing-account.ts");

const ACME = "30000000-0000-4000-8000-000000000001";
const BETA = "30000000-0000-4000-8000-000000000002";

function seed(o: { acme?: Record<string, unknown>; portals?: Array<Record<string, unknown>>; signIns?: Array<Record<string, unknown>> } = {}) {
  db.reset();
  stripe.reset();
  getStripeSnapshot.invalidate();
  forgetSignIns();
  db.seed("os_clients", [
    { id: ACME, name: "Acme Realty", aliases: [], status: "active", mi_client_id: "p-acme", stripe_customer_id: null, stripe_subscription_id: null, ...o.acme },
    { id: BETA, name: "Beta Homes", aliases: [], status: "active", mi_client_id: "p-beta", stripe_customer_id: null, stripe_subscription_id: null },
  ]);
  db.seed("os_client_stripe_links", []);
  db.seed("clients", o.portals ?? [{ id: "p-acme", name: "Acme Realty" }, { id: "p-beta", name: "Beta Homes" }]);
  db.seed("os_portal_logins", o.signIns ?? []);
}
const login = (portal: string, email: string, o: Record<string, unknown> = {}) => ({ portal_id: portal, email, name: null, removed_at: null, ...o });
const read = async () => {
  const a = await getAccountBilling();
  return {
    a,
    counted: (id: string) => (a.byClient.get(id)?.customers ?? []).map((c) => `${c.name}:${c.source}`),
    found: () => a.suggestions.map((x) => `${x.clientId === ACME ? "acme" : x.clientId === BETA ? "beta" : x.clientId}:${a.snapshot.customers.find((c) => c.id === x.customerId)?.name}`),
  };
};

test("someone on a client's portal sign-in list: their Stripe customer is found for it, and counted for no one", async () => {
  seed({ signIns: [login("p-acme", "Owner@AcmeCo.com")] });
  stripe.addCustomerWithCard({ name: "Pat Owner", email: "owner@acmeco.com" });
  const { a, counted, found } = await read();
  assert.equal(a.suggestionsReady, true);
  assert.deepEqual(found(), ["acme:Pat Owner"]);
  assert.deepEqual([counted(ACME), counted(BETA)], [[], []]);
});

test("the record's point of contact finds them too", async () => {
  seed({ acme: { poc_email: "Boss@AcmeCo.com" } });
  stripe.addCustomerWithCard({ name: "The Boss", email: "boss@acmeco.com" });
  assert.deepEqual((await read()).found(), ["acme:The Boss"]);
});

test("someone taken off the list no longer does", async () => {
  seed({ signIns: [login("p-acme", "owner@acmeco.com", { removed_at: "2026-11-01T00:00:00Z" })] });
  stripe.addCustomerWithCard({ name: "Pat Owner", email: "owner@acmeco.com" });
  assert.deepEqual((await read()).found(), []);
});

test("an address on one client's record and another's sign-in list finds neither", async () => {
  seed({ acme: { contact_email: "pat@shared-co.com" }, signIns: [login("p-beta", "pat@shared-co.com")] });
  stripe.addCustomerWithCard({ name: "Pat", email: "pat@shared-co.com" });
  assert.deepEqual((await read()).found(), []);
});

test("every page of the sign-in lists is read: an address on a late page still makes it two clients", async () => {
  // Ids in order, so Beta's sign-in is the very last row whichever way the pages are cut.
  const filler = Array.from({ length: 1500 }, (_, i) => login("p-other", `agent${i}@elsewhere.com`, { id: `l-${String(i).padStart(5, "0")}` }));
  seed({ acme: { contact_email: "pat@shared-co.com" }, portals: [{ id: "p-acme", name: "Acme Realty" }, { id: "p-beta", name: "Beta Homes" }, { id: "p-other", name: "Other" }], signIns: [...filler, login("p-beta", "pat@shared-co.com", { id: "l-99999" })] });
  db.pageLimit = 1000; // PostgREST's own cap: a single read would stop here
  stripe.addCustomerWithCard({ name: "Pat", email: "pat@shared-co.com" });
  const { a, found } = await read();
  assert.equal(a.suggestionsReady, true);
  assert.deepEqual(found(), [], "Beta's sign-in on row 1501 was read");
});

test("sign-in lists or links unreadable: no suggestions at all, and billing reads exactly as before", async () => {
  for (const table of ["os_portal_logins", "clients", "os_client_stripe_links"]) {
    seed({ acme: { contact_email: "jane@acme-co.com" } });
    db.missingTables.add(table);
    stripe.addCustomerWithCard({ name: "Jane", email: "jane@acme-co.com" });
    stripe.addCustomerWithCard({ name: "Acme Realty Old", email: null });
    const { a, counted } = await read();
    assert.equal(a.suggestionsReady, false, table);
    assert.deepEqual(a.suggestions, [], table);
    assert.deepEqual(counted(ACME), ["Acme Realty Old:name match"], `${table}: the name match goes on`);
    const { otherCollectingSubscriptions } = await import("./billing-account.ts");
    assert.deepEqual(await otherCollectingSubscriptions(ACME, null), [], `${table}: a pause or churn reads as it always has`);
    assert.ok(await getClientBillingDetail(ACME), table);
  }
});

test("Not theirs holds: an excluded customer is never found again", async () => {
  seed({ acme: { contact_email: "jane@acme-co.com" } });
  const { customerId } = stripe.addCustomerWithCard({ name: "Jane", email: "jane@acme-co.com" });
  db.seed("os_client_stripe_links", [{ os_client_id: ACME, stripe_customer_id: customerId, stripe_subscription_id: null, excluded: true }]);
  const { a, found } = await read();
  assert.equal(a.suggestionsReady, true);
  assert.deepEqual(found(), []);
});

test("Yes, it's theirs (a link) counts it, and it is found no longer", async () => {
  seed({ acme: { contact_email: "jane@acme-co.com" } });
  const { customerId } = stripe.addCustomerWithCard({ name: "Jane", email: "jane@acme-co.com" });
  db.seed("os_client_stripe_links", [{ os_client_id: ACME, stripe_customer_id: customerId, stripe_subscription_id: null, excluded: false }]);
  const { counted, found } = await read();
  assert.deepEqual([counted(ACME), found()], [["Jane:linked"], []]);
});
