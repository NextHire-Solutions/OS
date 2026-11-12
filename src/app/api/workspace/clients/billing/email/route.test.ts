/*
 * Changing where a customer's invoices go (12 Nov) — the route run for real: a real signed staff cookie (bs-auth
 * mintSso), the in-memory database (fake-postgrest.ts) and the fake Stripe (usage-billing/test/fake-stripe.ts) behind
 * `fetch`. Nothing leaves the process.
 *
 * What is pinned:
 *   - only the Billing tab's named people; everyone else gets a bare 404 and Stripe is never asked;
 *   - only from the OS's own page; only one real address;
 *   - only a customer counted for this client — never another client's, whatever the request names;
 *   - the address the page showed must still be Stripe's, or nothing is sent;
 *   - Stripe gets the address and who changed it from what; a second press sends nothing;
 *   - a live key changes nothing from a laptop;
 *   - Stripe failing before the change says nothing changed; after it, that it may have.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest } from "../../../../../../lib/tools/master-inbox/test/fake-postgrest.ts";
import { FakeStripe } from "../../../../../../lib/clients/usage-billing/test/fake-stripe.ts";
import { mintSso } from "../../../../../../lib/bs-auth.ts";

configureFakeEnvironment("MASTER_INBOX_");
process.env.AUTH_SECRET = "s".repeat(40);
process.env.OS_PUBLIC_URL = "https://os.test";
delete process.env.SSO_SESSIONS_NOT_BEFORE;
for (const v of ["ONBOARDING_STRIPE_SECRET_KEY", "ONBOARDING_STRIPE_SECRET_KEY_TEST", "ONBOARDING_STRIPE_MODE", "STRIPE_MODE", "RAILWAY_ENVIRONMENT_NAME", "RAILWAY_ENVIRONMENT"]) delete process.env[v];
const TEST_KEY = "sk_test_51FakeFakeFakeFake";
const LIVE_KEY = "sk_live_51FakeFakeFakeFake";

const db = new FakePostgrest();
const stripe = new FakeStripe();
const liveStripe = new FakeStripe({ live: true });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.host !== "api.stripe.com") return db.fetch(input, init);
  return /^Bearer (sk|rk)_live_/.test(new Headers(init?.headers).get("authorization") ?? "") ? liveStripe.fetch(input, init) : stripe.fetch(input, init);
}) as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const { POST } = await import("./route.ts");
const { getAccountBilling, getStripeSnapshot } = await import("../../../../../../lib/clients/billing-account.ts");

const JEFF = "30000000-0000-4000-8000-000000000001";
const OTHER = "30000000-0000-4000-8000-000000000002";
const AMY = "amy@brokerstaffer.com";
const OLD = "jeffcook@jeffcookrealestate.com";
const NEW = "alma.nowatzke@jeffcookrealestate.com";

/* Two clients, each with a Stripe customer named after it (counted by name, as the Billing tab counts them). */
function seed() {
  db.reset();
  stripe.reset();
  liveStripe.reset();
  getStripeSnapshot.invalidate();
  process.env.ONBOARDING_STRIPE_SECRET_KEY_TEST = TEST_KEY;
  process.env.ONBOARDING_STRIPE_MODE = "test";
  delete process.env.ONBOARDING_STRIPE_SECRET_KEY;
  for (const v of ["RAILWAY_ENVIRONMENT_NAME", "RAILWAY_ENVIRONMENT"]) delete process.env[v];
  db.seed("os_clients", [
    { id: JEFF, name: "Jeff Cook Real Estate", aliases: [], status: "paused", mi_client_id: null },
    { id: OTHER, name: "Beta Homes", aliases: [], status: "active", mi_client_id: null },
  ]);
  db.seed("os_client_stripe_links", []);
  db.seed("clients", []);
  const jeff = stripe.addCustomerWithCard({ name: "Jeff Cook Real Estate", email: OLD }).customerId;
  const beta = stripe.addCustomerWithCard({ name: "Beta Homes", email: "billing@betahomes.com" }).customerId;
  stripe.calls.length = 0;
  return { jeff, beta };
}

async function cookie(email: string) {
  return `bs_sso=${await mintSso(process.env.AUTH_SECRET!, { email, grants: ["clients", "inbox"], ver: 1 })}`;
}
async function post(who: string | null, body: Record<string, unknown>, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", "sec-fetch-site": "same-origin", ...extra };
  if (who) headers.cookie = await cookie(who);
  return POST(new Request("https://os.test/api/workspace/clients/billing/email", { method: "POST", headers, body: JSON.stringify(body) }));
}
const writes = (s: FakeStripe) => s.calls.filter((c) => c.method !== "GET");
const emailOf = (id: string) => stripe.customers.get(id)?.email;

test("the Jeff Cook case: Amy changes it, Stripe has the new address and who changed it from what", async () => {
  const { jeff } = seed();
  const counted = (await getAccountBilling()).byClient.get(JEFF)?.customers.map((c) => [c.id, c.email]);
  assert.deepEqual(counted, [[jeff, OLD]], "the customer is counted for the client, at the old address (the page shows this)");
  const res = await post(AMY, { clientId: JEFF, customerId: jeff, from: OLD, to: `  ${NEW.toUpperCase()} ` });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual(body, { ok: true, email: NEW }, "typed with capitals and spaces, kept as one plain address");
  assert.equal(emailOf(jeff), NEW);
  const meta = stripe.customers.get(jeff)?.metadata as Record<string, string>;
  assert.equal(meta.os_email_by, AMY);
  assert.equal(meta.os_email_before, OLD);
  const sent = writes(stripe);
  assert.equal(sent.length, 1, "one change sent");
  assert.equal(sent[0].path, `/customers/${jeff}`);
  assert.deepEqual(Object.keys(sent[0].params).sort(), ["email", "metadata[os_email_before]", "metadata[os_email_by]"], "nothing else about the customer is touched");
  // The Billing tab reads Stripe again: the new address shows.
  assert.equal((await getAccountBilling()).byClient.get(JEFF)?.customers.find((c) => c.id === jeff)?.email, NEW);
});

test("a second press (or a retry after a lost answer) sends nothing more", async () => {
  const { jeff } = seed();
  assert.equal((await post(AMY, { clientId: JEFF, customerId: jeff, from: OLD, to: NEW })).status, 200);
  stripe.calls.length = 0;
  const again = await post(AMY, { clientId: JEFF, customerId: jeff, from: OLD, to: NEW });
  const body = await again.json();
  assert.equal(again.status, 200);
  assert.equal(body.done, true);
  assert.match(body.message, /already sends this customer's emails to alma\.nowatzke@/);
  assert.equal(writes(stripe).length, 0);
});

test("changed in Stripe after the page was opened: refused, nothing sent, Stripe's address kept", async () => {
  const { jeff } = seed();
  await getAccountBilling(); // the page opened: the OS's copy has the old address
  (stripe.customers.get(jeff) as Record<string, unknown>).email = "someone.else@jeffcookrealestate.com";
  const res = await post(AMY, { clientId: JEFF, customerId: jeff, from: OLD, to: NEW });
  const body = await res.json();
  assert.equal(res.status, 409);
  assert.match(body.error, /a different address for this customer than the page showed: it is now someone\.else@jeffcookrealestate\.com\. Nothing was changed/);
  assert.equal(writes(stripe).length, 0);
  assert.equal(emailOf(jeff), "someone.else@jeffcookrealestate.com");
  // The tab, read again, shows Stripe's address at once (not the OS's older copy), so the person sees what changed.
  assert.equal((await getAccountBilling()).byClient.get(JEFF)?.customers.find((c) => c.id === jeff)?.email, "someone.else@jeffcookrealestate.com");
});

test("deleted in Stripe since: refused, and the tab's next read no longer counts it", async () => {
  const { jeff } = seed();
  assert.ok((await getAccountBilling()).byClient.get(JEFF)?.customers.some((c) => c.id === jeff), "counted when the page opened");
  stripe.customers.delete(jeff);
  const res = await post(AMY, { clientId: JEFF, customerId: jeff, from: OLD, to: NEW });
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /Stripe has no such customer\. Nothing was changed/);
  assert.equal(writes(stripe).length, 0);
  assert.equal((await getAccountBilling()).byClient.get(JEFF)?.customers.some((c) => c.id === jeff), false);
});

test("a customer with no address yet: added", async () => {
  const { jeff } = seed();
  (stripe.customers.get(jeff) as Record<string, unknown>).email = null;
  const res = await post(AMY, { clientId: JEFF, customerId: jeff, from: null, to: NEW });
  assert.equal(res.status, 200);
  assert.equal(emailOf(jeff), NEW);
  assert.equal((stripe.customers.get(jeff)?.metadata as Record<string, string>).os_email_before, undefined, "no address before: nothing recorded as one");
});

test("only a customer counted for THIS client: another client's is refused, nothing sent", async () => {
  const { beta } = seed();
  const res = await post(AMY, { clientId: JEFF, customerId: beta, from: "billing@betahomes.com", to: NEW });
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /isn't counted for this client/);
  assert.equal(writes(stripe).length, 0);
  assert.equal(emailOf(beta), "billing@betahomes.com");
  // An id Stripe has never seen, likewise.
  assert.equal((await post(AMY, { clientId: JEFF, customerId: "cus_NoSuchCustomer1", from: OLD, to: NEW })).status, 404);
  assert.equal(writes(stripe).length, 0);
});

test("only the Billing tab's named people: everyone else gets a bare 404 and Stripe is never asked", async () => {
  const { jeff } = seed();
  for (const who of ["ryan@brokerstaffer.com", "automation@outreachify.io", "gabriel@brokerstaffer.com", null]) {
    const res = await post(who, { clientId: JEFF, customerId: jeff, from: OLD, to: NEW });
    assert.equal(res.status, 404, String(who));
    assert.equal(await res.text(), "", "a bare 404: the route does not say it exists");
  }
  assert.equal(stripe.calls.length, 0);
  for (const who of ["admin@outreachify.io", "eddy@brokerstaffer.com", AMY]) {
    const { jeff: id } = seed();
    assert.equal((await post(who, { clientId: JEFF, customerId: id, from: OLD, to: NEW })).status, 200, who);
  }
});

test("only from the OS's own page", async () => {
  const { jeff } = seed();
  assert.equal((await post(AMY, { clientId: JEFF, customerId: jeff, from: OLD, to: NEW }, { "sec-fetch-site": "same-site" })).status, 403);
  assert.equal((await post(AMY, { clientId: JEFF, customerId: jeff, from: OLD, to: NEW }, { "content-type": "text/plain" })).status, 403);
  assert.equal(stripe.calls.length, 0);
  assert.equal(emailOf(jeff), OLD);
});

test("one real address only: anything else is refused before Stripe is asked", async () => {
  const { jeff } = seed();
  for (const to of ["", "alma", "alma@", "alma@jeffcookrealestate", "alma@jeffcookrealestate.c", "alma nowatzke@jeffcookrealestate.com",
    `${NEW}, ${OLD}`, `${NEW};${OLD}`, `Alma <${NEW}>`, "alma@@jeffcookrealestate.com", "alma..n@jeffcookrealestate.com", `${"a".repeat(250)}@x.com`]) {
    const res = await post(AMY, { clientId: JEFF, customerId: jeff, from: OLD, to });
    assert.equal(res.status, 400, to);
    assert.match((await res.json()).error, /isn't one email address/, to);
  }
  for (const bad of [{ clientId: "jeff", customerId: jeff, from: OLD, to: NEW }, { clientId: JEFF, customerId: "sub_123456789", from: OLD, to: NEW }, { clientId: JEFF, customerId: jeff, to: NEW }]) {
    assert.equal((await post(AMY, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(stripe.calls.length, 0);
});

test("a live key changes nothing from a laptop — only on Railway, asked from the OS's own address", async () => {
  const { jeff } = seed();
  process.env.ONBOARDING_STRIPE_SECRET_KEY = LIVE_KEY;
  process.env.ONBOARDING_STRIPE_MODE = "live";
  const res = await post(AMY, { clientId: JEFF, customerId: jeff, from: OLD, to: NEW }, { origin: "https://os.test" });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /only from os\.brokerstaffer\.com/);
  assert.equal(liveStripe.calls.length, 0);
  process.env.RAILWAY_ENVIRONMENT_NAME = "production";
  const elsewhere = await post(AMY, { clientId: JEFF, customerId: jeff, from: OLD, to: NEW }, { origin: "http://localhost:3000" });
  assert.equal(elsewhere.status, 403, "on Railway, but not asked from the site");
  assert.equal(liveStripe.calls.length, 0);
});

test("Stripe failing before the change: nothing changed; after it: it may have", async () => {
  let { jeff } = seed();
  stripe.failWhen = (c) => c.method === "GET" && c.path === `/customers/${jeff}`;
  let res = await post(AMY, { clientId: JEFF, customerId: jeff, from: OLD, to: NEW });
  let body = await res.json();
  assert.equal(res.status, 502);
  assert.match(body.error, /Nothing was changed/);
  assert.equal(body.uncertain, undefined);
  assert.equal(writes(stripe).length, 0);

  ({ jeff } = seed());
  stripe.failWhen = (c) => c.method === "POST" && c.path === `/customers/${jeff}`;
  res = await post(AMY, { clientId: JEFF, customerId: jeff, from: OLD, to: NEW });
  body = await res.json();
  assert.equal(res.status, 502);
  assert.equal(body.uncertain, true);
  assert.match(body.error, /may still have gone through/);
  // Pressing again once Stripe answers: the change is made, once.
  stripe.failWhen = null;
  stripe.calls.length = 0;
  res = await post(AMY, { clientId: JEFF, customerId: jeff, from: OLD, to: NEW });
  assert.equal(res.status, 200);
  assert.equal(writes(stripe).length, 1);
  assert.equal(emailOf(jeff), NEW);
});

test("Stripe answers but does not have the new address: never reported as saved", async () => {
  const { jeff } = seed();
  const plain = globalThis.fetch;
  // Stripe's answer to the change carries another address (as if something else changed it in between).
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await plain(input, init);
    if (String(input).endsWith(`/customers/${jeff}`) && init?.method === "POST") {
      const j = await res.json();
      return new Response(JSON.stringify({ ...j, email: "someone.else@jeffcookrealestate.com" }), { status: 200 });
    }
    return res;
  }) as typeof fetch;
  try {
    const res = await post(AMY, { clientId: JEFF, customerId: jeff, from: OLD, to: NEW });
    const body = await res.json();
    assert.equal(res.status, 409);
    assert.match(body.error, /Stripe answered, but has someone\.else@jeffcookrealestate\.com for this customer, not alma\.nowatzke@/);
    assert.equal(body.ok, undefined);
  } finally {
    globalThis.fetch = plain;
  }
});
