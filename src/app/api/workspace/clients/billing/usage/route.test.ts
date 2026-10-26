/*
 * Pay per lead — the TEST path's route, run for real: a real signed staff
 * cookie (bs-auth mintSso), the in-memory database (fake-postgrest.ts) and
 * the fake Stripe (usage-billing/test/fake-stripe.ts) behind `fetch`. Nothing
 * leaves the process.
 *
 * What is pinned, in the user's words ("we do not want to make this live for
 * any of the client right now … make a way to test this"):
 *   - only the Billing tab's named people; everyone else gets a bare 404 and
 *     nothing is read;
 *   - a key that is not a Stripe TEST key is refused before Stripe is asked;
 *   - a client not marked test_only is refused before Stripe is asked;
 *   - the whole test path works: save → card-setup link → card stored →
 *     preview (writes nothing) → charge (paid, one line per lead) → never twice.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest } from "../../../../../../lib/tools/master-inbox/test/fake-postgrest.ts";
import { FakeStripe } from "../../../../../../lib/clients/usage-billing/test/fake-stripe.ts";
import { mintSso } from "../../../../../../lib/bs-auth.ts";
import { addDays, easternDay } from "../../../../../../lib/clients/usage-billing/model.ts";

configureFakeEnvironment("MASTER_INBOX_");
process.env.AUTH_SECRET = "s".repeat(40);
process.env.OS_PUBLIC_URL = "https://os.test";
delete process.env.SSO_SESSIONS_NOT_BEFORE;
for (const v of ["OS_USAGE_BILLING_STRIPE_KEY", "OS_USAGE_BILLING_ENABLED", "OS_USAGE_BILLING_CHARGE"]) delete process.env[v];
const TEST_KEY = "sk_test_51FakeFakeFakeFake";

const db = new FakePostgrest();
const stripe = new FakeStripe();
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  return url.host === "api.stripe.com" ? stripe.fetch(input, init) : db.fetch(input, init);
}) as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const { GET, POST } = await import("./route.ts");

const ACME = "20000000-0000-4000-8000-000000000001";
const BETA = "20000000-0000-4000-8000-000000000002";
const TODAY = easternDay(new Date());
const ANCHOR = addDays(TODAY, -7); // the first week ended yesterday

async function cookie(email: string) {
  return `bs_sso=${await mintSso(process.env.AUTH_SECRET!, { email, grants: ["clients", "inbox"], ver: 1 })}`;
}

function seed(settings: Array<Record<string, unknown>> = []) {
  db.reset();
  stripe.reset();
  db.seed("os_clients", [
    { id: ACME, name: "Acme Realty", aliases: [], status: "active", mi_client_id: null },
    { id: BETA, name: "Beta Homes", aliases: [], status: "active", mi_client_id: null },
  ]);
  db.seed("os_usage_billing_settings", settings);
  db.seed("os_usage_billing_periods", []);
  db.seed("os_brokerage_relays", []);
  db.seed("os_campaign_portals", []);
  db.seed("clients", []);
  delete process.env.OS_USAGE_BILLING_STRIPE_KEY;
}

const testRow = (o: Record<string, unknown> = {}) => ({
  os_client_id: ACME, enabled: false, test_only: true, price_cents: 10_000, every_days: 7, anchor_date: ANCHOR, lead_source: "handoffs",
  stripe_customer_id: null, default_payment_method_id: null, card_label: null, setup_session_id: null, ...o,
});

async function get(who: string | null, clientId = ACME) {
  const headers: Record<string, string> = {};
  if (who) headers.cookie = await cookie(who);
  return GET(new Request(`https://os.test/api/workspace/clients/billing/usage?clientId=${clientId}`, { headers }));
}

async function post(who: string | null, body: Record<string, unknown>, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", "sec-fetch-site": "same-origin", ...extra };
  if (who) headers.cookie = await cookie(who);
  return POST(new Request("https://os.test/api/workspace/clients/billing/usage", { method: "POST", headers, body: JSON.stringify(body) }));
}

const ADMIN = "admin@outreachify.io";
const fakeLeads = [1, 2, 3].map((d) => `Test Lead ${d}, ${addDays(ANCHOR, d)}`).join("\n");

test("only the Billing tab's named people: everyone else gets a bare 404 and nothing is read", async () => {
  seed([testRow()]);
  process.env.OS_USAGE_BILLING_STRIPE_KEY = TEST_KEY;
  for (const who of [null, "staff@brokerstaffer.com", "someone@outreachify.io"]) {
    const g = await get(who);
    assert.equal(g.status, 404, `GET ${who}`);
    assert.equal(await g.text(), "", "not even an error that says the route exists");
    for (const action of ["save", "setup_link", "preview", "charge"]) {
      const p = await post(who, { clientId: ACME, action, price: "100", everyDays: 7, anchorDate: ANCHOR });
      assert.equal(p.status, 404, `POST ${action} ${who}`);
    }
  }
  assert.deepEqual(db.calls, []);
  assert.deepEqual(stripe.calls, []);
});

test("a write comes only from the OS's own page", async () => {
  seed([testRow()]);
  process.env.OS_USAGE_BILLING_STRIPE_KEY = TEST_KEY;
  assert.equal((await post(ADMIN, { clientId: ACME, action: "charge" }, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post(ADMIN, { clientId: ACME, action: "charge" }, { "content-type": "text/plain" })).status, 403);
  assert.deepEqual(stripe.calls, []);
});

test("saving makes the client a TEST client (test_only = true) and touches no Stripe", async () => {
  seed();
  const r = await post(ADMIN, { clientId: ACME, action: "save", price: "$150", everyDays: 14, anchorDate: ANCHOR, leadSource: "introductions" });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.settings.test_only, true);
  assert.equal(body.settings.price_cents, 15_000);
  assert.equal(body.settings.every_days, 14);
  assert.equal((await post(ADMIN, { clientId: ACME, action: "save", price: "0", everyDays: 7, anchorDate: ANCHOR })).status, 400);
  assert.equal((await post(ADMIN, { clientId: ACME, action: "save", price: "100", everyDays: 30, anchorDate: ANCHOR })).status, 400);
  assert.equal((await post(ADMIN, { clientId: "20000000-0000-4000-8000-00000000000f", action: "save", price: "100", everyDays: 7, anchorDate: ANCHOR })).status, 404);
  const g = await (await get(ADMIN)).json();
  assert.equal(g.settings.test_only, true);
  assert.equal(g.keyState, "missing");
  assert.equal(g.refusal, null);
  assert.deepEqual(g.flags, { scheduler: false, charge: false });
  assert.deepEqual(stripe.calls, []);
});

test("a key that is not a Stripe TEST key is refused before Stripe is asked; no key, no Stripe", async () => {
  seed([testRow({ stripe_customer_id: "cus_x", default_payment_method_id: "pm_x", setup_session_id: "cs_x" })]);
  for (const [key, status] of [["sk_live_51FakeFakeFakeFake", 403], ["rk_live_51FakeFakeFakeFake", 403], ["pk_test_51FakeFakeFakeFake", 403], [undefined, 503]] as const) {
    if (key) process.env.OS_USAGE_BILLING_STRIPE_KEY = key; else delete process.env.OS_USAGE_BILLING_STRIPE_KEY;
    for (const action of ["setup_link", "confirm_setup", "charge", "refresh"]) {
      const r = await post(ADMIN, { clientId: ACME, action, periodStart: ANCHOR, fakeLeads });
      assert.equal(r.status, status, `${action} with ${key ?? "no key"}`);
      assert.match((await r.json()).error, key ? /not a Stripe TEST key/ : /not set/);
    }
    const g = await (await get(ADMIN)).json();
    assert.equal(g.invoices, null, "the GET does not read Stripe with it either");
    assert.equal(g.keyState, key ? "refused" : "missing");
  }
  assert.deepEqual(stripe.calls, []);
  assert.deepEqual(stripe.liveKeySeen, []);
  assert.equal(db.rows("os_usage_billing_periods").length, 0);
});

test("a client not marked test_only — or with no settings — is refused before Stripe is asked", async () => {
  process.env.OS_USAGE_BILLING_STRIPE_KEY = TEST_KEY;
  for (const rows of [[testRow({ test_only: false, stripe_customer_id: "cus_x", default_payment_method_id: "pm_x" })], []]) {
    seed(rows);
    process.env.OS_USAGE_BILLING_STRIPE_KEY = TEST_KEY;
    for (const action of ["setup_link", "confirm_setup", "preview", "charge", "refresh"]) {
      const r = await post(ADMIN, { clientId: ACME, action, periodStart: ANCHOR, fakeLeads });
      assert.equal(r.status, 403, `${action} (${rows.length ? "not test" : "no settings"})`);
      assert.match((await r.json()).error, rows.length ? /not marked as a test client/ : /no pay-per-lead settings/);
    }
  }
  assert.deepEqual(stripe.calls, []);
});

test("the whole test path: save → card-setup link → card stored → preview → charge (paid, one line per lead) → never twice", async () => {
  seed();
  process.env.OS_USAGE_BILLING_STRIPE_KEY = TEST_KEY;
  assert.equal((await post(ADMIN, { clientId: ACME, action: "save", price: "100", everyDays: 7, anchorDate: ANCHOR })).status, 200);

  // The card: a Checkout page in setup mode; the person pays nothing, saves 4242.
  const link = await (await post(ADMIN, { clientId: ACME, action: "setup_link" })).json();
  assert.match(link.url, /^https:\/\/checkout\.stripe\.com\//);
  const before = await (await post(ADMIN, { clientId: ACME, action: "confirm_setup" })).json();
  assert.equal(before.saved, false, "not completed yet");
  stripe.completeSetup([...stripe.sessions.keys()][0]);
  const card = await (await post(ADMIN, { clientId: ACME, action: "confirm_setup" })).json();
  assert.equal(card.saved, true);
  assert.equal(card.cardLabel, "Visa •••• 4242");

  // Preview: three typed-in leads at $100 — nothing written, nothing in Stripe.
  const stripeBefore = stripe.calls.length;
  db.calls.length = 0;
  const pv = await (await post(ADMIN, { clientId: ACME, action: "preview", fakeLeads })).json();
  assert.equal(pv.preview.count, 3);
  assert.equal(pv.preview.amountCents, 30_000);
  assert.deepEqual(pv.preview.period, { start: ANCHOR, end: TODAY });
  assert.equal(pv.preview.lines.length, 3);
  assert.deepEqual(db.calls.filter((c) => c.method !== "GET"), []);
  assert.equal(stripe.calls.length, stripeBefore);

  // Charge.
  const ch = await post(ADMIN, { clientId: ACME, action: "charge", fakeLeads });
  assert.equal(ch.status, 200);
  const r = await ch.json();
  assert.equal(r.outcome, "paid");
  assert.equal(r.invoice.total, 30_000);
  assert.equal(r.invoice.status, "paid");
  assert.equal(r.invoice.test, true);
  const inv = [...stripe.invoices.values()][0];
  assert.deepEqual(inv.lines.map((l) => l.description), [1, 2, 3].map((d) => `Lead: Test Lead ${d} — ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${addDays(ANCHOR, d)}T00:00:00Z`))}`));
  assert.equal(r.periods[0].status, "paid");
  assert.equal(r.periods[0].claimed_by, ADMIN);

  // Never twice.
  const again = await post(ADMIN, { clientId: ACME, action: "charge", fakeLeads });
  assert.equal(again.status, 409);
  assert.match((await again.json()).error, /billed and paid already/);
  assert.equal(stripe.creates(/^\/invoices$/).length, 1);
  assert.equal(stripe.creates(/\/pay$/).length, 1);

  // The history: the customer's test-mode invoices.
  const g = await (await get(ADMIN)).json();
  assert.equal(g.invoices.length, 1);
  assert.equal(g.invoices[0].status, "paid");
  assert.equal(g.periods.length, 1);
  assert.deepEqual(stripe.liveKeySeen, []);
  assert.deepEqual(db.blocked, []);
});
