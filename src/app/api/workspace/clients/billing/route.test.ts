/*
 * The record's Stripe control, for what is found by email (6 Nov): run for real with a signed cookie, the in-memory
 * database (fake-postgrest.ts) and the fake Stripe. Nothing leaves the process.
 *
 * Pinned: the tab is told what is found and counts none of it; "Yes, it's theirs" links it only while it is still found
 * for this client; "Not theirs", and "Not this client" on a confirmed customer, are final; only admins may press them.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest } from "../../../../../lib/tools/master-inbox/test/fake-postgrest.ts";
import { FakeStripe } from "../../../../../lib/clients/usage-billing/test/fake-stripe.ts";
import { mintSso } from "../../../../../lib/bs-auth.ts";

configureFakeEnvironment("MASTER_INBOX_");
process.env.AUTH_SECRET = "s".repeat(40);
process.env.ADMIN_EMAILS = "admin@outreachify.io";
delete process.env.SSO_SESSIONS_NOT_BEFORE;
for (const v of ["ONBOARDING_STRIPE_SECRET_KEY_TEST", "ONBOARDING_STRIPE_MODE", "STRIPE_MODE"]) delete process.env[v];
process.env.ONBOARDING_STRIPE_SECRET_KEY = "sk_live_51FakeFakeFakeFake";

const db = new FakePostgrest();
const stripe = new FakeStripe({ live: true });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  return url.host === "api.stripe.com" ? stripe.fetch(input, init) : db.fetch(input, init);
}) as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const { GET, POST } = await import("./route.ts");
const { forgetSignIns, getStripeSnapshot } = await import("../../../../../lib/clients/billing-account.ts");

const ADMIN = "admin@outreachify.io";
const MANAGER = "manager@brokerstaffer.com";
const ACME = "40000000-0000-4000-8000-000000000001";
const BETA = "40000000-0000-4000-8000-000000000002";

const cookie = async (email: string) => `bs_sso=${await mintSso(process.env.AUTH_SECRET!, { email, grants: ["roster", "clients"], ver: 0 })}`;
const get = async (email = ADMIN) => GET(new Request(`http://os.test/api/workspace/clients/billing?clientId=${ACME}`, { headers: { cookie: await cookie(email) } }));
const post = async (body: Record<string, unknown>, email = ADMIN) =>
  POST(new Request("http://os.test/api/workspace/clients/billing", { method: "POST", headers: { cookie: await cookie(email), "content-type": "application/json" }, body: JSON.stringify({ clientId: ACME, ...body }) }));

let jane = "";
function seed() {
  db.reset();
  stripe.reset();
  getStripeSnapshot.invalidate();
  forgetSignIns();
  db.seed("os_users", []);
  db.seed("os_clients", [
    { id: ACME, name: "Acme Realty", aliases: [], status: "active", mi_client_id: null, stripe_customer_id: null, stripe_subscription_id: null, contact_email: "jane@acme-co.com" },
    { id: BETA, name: "Beta Homes", aliases: [], status: "active", mi_client_id: null, stripe_customer_id: null, stripe_subscription_id: null },
  ]);
  db.seed("os_client_stripe_links", []);
  db.seed("clients", []);
  db.seed("os_portal_logins", []);
  jane = stripe.addCustomerWithCard({ name: "Jane Doe", email: "jane@acme-co.com" }).customerId;
}
const links = () => db.rows("os_client_stripe_links").map((l) => `${l.os_client_id === ACME ? "acme" : "beta"}:${l.stripe_customer_id === jane ? "jane" : l.stripe_customer_id}:${l.excluded ? "excluded" : "linked"}`);

test("the tab is told what is found by email, and it counts for no one", async () => {
  seed();
  const b = await (await get()).json();
  assert.deepEqual(b.found.map((f: { id: string; name: string; email: string }) => [f.id, f.name, f.email]), [[jane, "Jane Doe", "jane@acme-co.com"]]);
  assert.deepEqual(b.account.customers, []);
});

test("Yes, it's theirs links it: it counts for the client and is found no longer", async () => {
  seed();
  const r = await post({ action: "link", stripeId: jane, confirmFound: true });
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.deepEqual(links(), ["acme:jane:linked"]);
  assert.deepEqual(b.account.customers.map((c: { id: string; source: string }) => [c.id, c.source]), [[jane, "linked"]]);
  assert.deepEqual(b.found, []);
});

test("Yes, it's theirs from a tab left open: refused when someone has since linked it elsewhere or ruled it out", async () => {
  seed();
  db.seed("os_client_stripe_links", [{ os_client_id: BETA, stripe_customer_id: jane, stripe_subscription_id: null, excluded: false }]);
  const r = await post({ action: "link", stripeId: jane, confirmFound: true });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /changed since the page was opened/);
  assert.deepEqual(links(), ["beta:jane:linked"], "nothing linked");
  seed();
  db.seed("os_client_stripe_links", [{ os_client_id: ACME, stripe_customer_id: jane, stripe_subscription_id: null, excluded: true }]);
  assert.equal((await post({ action: "link", stripeId: jane, confirmFound: true })).status, 409, "said Not theirs in another tab");
  assert.deepEqual(links(), ["acme:jane:excluded"]);
});

test("the Link box (no confirmFound) works as before", async () => {
  seed();
  db.seed("os_client_stripe_links", [{ os_client_id: BETA, stripe_customer_id: jane, stripe_subscription_id: null, excluded: false }]);
  assert.equal((await post({ action: "link", stripeId: jane })).status, 200);
  assert.deepEqual(links().sort(), ["acme:jane:linked", "beta:jane:linked"]);
});

test("Not theirs is final: an exclusion, and it is never found for this client again", async () => {
  seed();
  const b = await (await post({ action: "exclude", customerId: jane })).json();
  assert.deepEqual(links(), ["acme:jane:excluded"]);
  assert.deepEqual(b.found, []);
  assert.deepEqual((await (await get()).json()).found, []);
});

test("Not this client on a confirmed customer: the link goes and an exclusion stays, so it isn't found again", async () => {
  seed();
  await post({ action: "link", stripeId: jane, confirmFound: true });
  const b = await (await post({ action: "exclude", customerId: jane })).json();
  assert.deepEqual(links(), ["acme:jane:excluded"]);
  assert.deepEqual([b.account.customers, b.found], [[], []]);
});

test("only admins confirm or rule out: someone with the Clients page sees what is found, and can't press", async () => {
  seed();
  const seen = await (await get(MANAGER)).json();
  assert.equal(seen.canManage, false);
  assert.equal(seen.found.length, 1);
  for (const body of [{ action: "link", stripeId: jane, confirmFound: true }, { action: "exclude", customerId: jane }]) {
    assert.equal((await post(body, MANAGER)).status, 403, body.action);
  }
  assert.deepEqual(links(), []);
});

test("Not this client on the record's own customer (also linked): refused, nothing changed — it is the record's", async () => {
  seed();
  db.seed("os_clients", db.rows("os_clients").map((r) => (r.id === ACME ? { ...r, stripe_customer_id: jane } : r)));
  db.seed("os_client_stripe_links", [{ os_client_id: ACME, stripe_customer_id: jane, stripe_subscription_id: null, excluded: false }]);
  const r = await post({ action: "exclude", customerId: jane });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /on Acme Realty's record .* change those fields on the Record\. Nothing was changed\./);
  assert.deepEqual(links(), ["acme:jane:linked"]);
});

test("Yes, it's theirs while the sign-in lists can't be read: can't be checked, so nothing is linked (503, not 'changed')", async () => {
  seed();
  db.missingTables.add("os_portal_logins");
  forgetSignIns();
  const r = await post({ action: "link", stripeId: jane, confirmFound: true });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /Couldn't check this customer just now/);
  assert.deepEqual(links(), []);
});

test("Not this client on the customer of the record's subscription, when the record names another customer too: refused as well", async () => {
  seed();
  const other = stripe.addCustomerWithCard({ name: "Old Card", email: null }).customerId;
  stripe.listedSubscriptions.push({ id: "sub_rec", customer: jane, status: "active", created: 1_760_000_000, canceled_at: null, pause_collection: null, items: { data: [{ quantity: 1, current_period_end: 1_800_000_000, price: { unit_amount: 75000, recurring: { interval: "day", interval_count: 14 } } }] } });
  db.seed("os_clients", db.rows("os_clients").map((r) => (r.id === ACME ? { ...r, stripe_customer_id: other, stripe_subscription_id: "sub_rec" } : r)));
  getStripeSnapshot.invalidate();
  const r = await post({ action: "exclude", customerId: jane });
  assert.equal(r.status, 409);
  assert.deepEqual(links(), []);
  const b = await (await get()).json();
  assert.ok(b.account.subscriptions.some((s: { id: string }) => s.id === "sub_rec"), "the record's subscription is still the client's");
});
