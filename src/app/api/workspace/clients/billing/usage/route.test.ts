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
 *
 * And the LIVE path (31 Oct, the user: "deploy and go" — against a second
 * fake Stripe that plays live mode): a client goes live only by a person
 * connecting its card on file, saying so; it is charged only the amount the
 * person approved, for a period that has ended, in live Stripe only; the test
 * tools and fake leads are refused for it; a refused card can be retried with
 * the card connected now; a missing or test-mode OS key bills nothing.
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
for (const v of ["OS_USAGE_BILLING_STRIPE_KEY", "OS_USAGE_BILLING_ENABLED", "OS_USAGE_BILLING_CHARGE", "ONBOARDING_STRIPE_SECRET_KEY", "ONBOARDING_STRIPE_SECRET_KEY_TEST", "ONBOARDING_STRIPE_MODE", "STRIPE_MODE"]) delete process.env[v];
const TEST_KEY = "sk_test_51FakeFakeFakeFake";
const LIVE_KEY = "sk_live_51FakeFakeFakeFake";

const db = new FakePostgrest();
const stripe = new FakeStripe();
const liveStripe = new FakeStripe({ live: true });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.host !== "api.stripe.com") return db.fetch(input, init);
  // A live key goes to the live fake; anything else to the test fake (which refuses, and records, a live key).
  return /^Bearer (sk|rk)_live_/.test(new Headers(init?.headers).get("authorization") ?? "") ? liveStripe.fetch(input, init) : stripe.fetch(input, init);
}) as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const { GET, POST } = await import("./route.ts");
const { getStripeSnapshot } = await import("../../../../../../lib/clients/billing-account.ts");

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
  liveStripe.reset();
  getStripeSnapshot.invalidate();
  for (const v of ["ONBOARDING_STRIPE_SECRET_KEY", "ONBOARDING_STRIPE_SECRET_KEY_TEST", "ONBOARDING_STRIPE_MODE", "STRIPE_MODE"]) delete process.env[v];
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

test("a live client gets no test tools and no fake leads; with no OS live key nothing reaches Stripe; no settings, nothing at all", async () => {
  seed([testRow({ test_only: false, stripe_customer_id: "cus_x", default_payment_method_id: "pm_x" })]);
  process.env.OS_USAGE_BILLING_STRIPE_KEY = TEST_KEY;
  for (const action of ["setup_link", "confirm_setup"]) {
    const r = await post(ADMIN, { clientId: ACME, action });
    assert.equal(r.status, 403, action);
    assert.match((await r.json()).error, /live — the test tools are for test clients only/);
  }
  const pv = await post(ADMIN, { clientId: ACME, action: "preview", periodStart: ANCHOR, fakeLeads });
  assert.equal(pv.status, 403);
  assert.match((await pv.json()).error, /Fake leads are for test clients only/);
  for (const action of ["charge", "refresh", "retry", "find_cards"]) {
    const r = await post(ADMIN, { clientId: ACME, action, periodStart: ANCHOR, mode: "live" });
    assert.equal(r.status, 503, action);
    assert.match((await r.json()).error, /The OS has no Stripe key/);
  }
  const testCard = await post(ADMIN, { clientId: ACME, action: "connect_card", mode: "test", customerId: "cus_testtest", paymentMethodId: "pm_testtest" });
  assert.equal(testCard.status, 409, "a live client never takes a test card");
  // The OS switched to Stripe test mode (its live key still set): its key is then the test key — a live client is not billed in test mode.
  process.env.ONBOARDING_STRIPE_SECRET_KEY = LIVE_KEY;
  process.env.ONBOARDING_STRIPE_MODE = "test";
  process.env.ONBOARDING_STRIPE_SECRET_KEY_TEST = TEST_KEY;
  const r = await post(ADMIN, { clientId: ACME, action: "charge", periodStart: ANCHOR, approved: { periodStart: ANCHOR, count: 0, amountCents: 0 } });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /not a LIVE key/);
  seed([]);
  process.env.OS_USAGE_BILLING_STRIPE_KEY = TEST_KEY;
  for (const action of ["setup_link", "confirm_setup", "preview", "charge", "refresh", "retry", "find_cards", "connect_card"]) {
    const r = await post(ADMIN, { clientId: ACME, action, periodStart: ANCHOR, fakeLeads });
    assert.equal(r.status, 403, `${action} (no settings)`);
    assert.match((await r.json()).error, /no pay-per-lead settings/);
  }
  assert.deepEqual(stripe.calls, []);
  assert.deepEqual(liveStripe.calls, []);
  assert.equal(db.rows("os_usage_billing_periods").length, 0);
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

/* ------------------------------------------------------------------ live --- */

/** Retry as the screen sends it: the period's amount, and the client's mode and card as they are now. */
const retry = (o: Record<string, unknown> = {}) => {
  const st = db.rows("os_usage_billing_settings").find((r) => r.os_client_id === ACME)!;
  const row = db.rows("os_usage_billing_periods").find((r) => r.os_client_id === ACME && r.period_start === ANCHOR);
  return post(ADMIN, { clientId: ACME, action: "retry", periodStart: ANCHOR, approved: { amountCents: row?.amount_cents, mode: st.test_only === false ? "live" : "test", paymentMethodId: st.default_payment_method_id, ...o } });
};


const PORTAL = "10000000-0000-4000-8000-000000000001";

/** Acme's portal with two conversations marked Interested in the week that just ended (and one this week). */
function seedLeads() {
  db.rows("os_clients").find((c) => c.id === ACME)!.mi_client_id = PORTAL;
  db.seed("clients", [{ id: PORTAL, name: "Acme Realty", slug: "acme-realty", aliases: [] }]);
  db.seed("labels", [{ id: "lab-int", name: "Interested" }]);
  db.seed("leads", [
    { id: "l1", email: "jordan@coastal.test", full_name: "Jordan Ellis" },
    { id: "l2", email: "sam@harbor.test", full_name: "Sam Lee" },
    { id: "l3", email: "pat@bay.test", full_name: "Pat Kim" },
  ]);
  db.seed("threads", [{ id: "t1", client_id: PORTAL, lead_id: "l1" }, { id: "t2", client_id: PORTAL, lead_id: "l2" }, { id: "t3", client_id: PORTAL, lead_id: "l3" }]);
  db.seed("label_assignments", [
    { label_id: "lab-int", target_type: "thread", target_id: "t1", assigned_at: `${addDays(ANCHOR, 1)}T15:00:00.000Z` },
    { label_id: "lab-int", target_type: "thread", target_id: "t2", assigned_at: `${addDays(ANCHOR, 3)}T15:00:00.000Z` },
    { label_id: "lab-int", target_type: "thread", target_id: "t3", assigned_at: `${TODAY}T15:00:00.000Z` }, // this week: not yet
  ]);
}

test("the LIVE path: card on file → go live (said so) → preview (real leads only) → charge only what was approved → paid in live Stripe → never twice", async () => {
  seed([testRow({ price_cents: 25_000 })]);
  seedLeads();
  process.env.OS_USAGE_BILLING_STRIPE_KEY = TEST_KEY;
  process.env.ONBOARDING_STRIPE_SECRET_KEY = LIVE_KEY;
  const { customerId, paymentMethodId } = liveStripe.addCustomerWithCard({ name: "Acme Realty", email: "billing@acme.test", brand: "visa", last4: "1881", expMonth: 8, expYear: 2031 });
  liveStripe.addCard(customerId, { brand: "mastercard", last4: "4444", expMonth: 1, expYear: 2020 }); // expired

  // Find: the customer and its cards, the default first; reads only.
  const found = await (await post(ADMIN, { clientId: ACME, action: "find_cards", mode: "live", customerId })).json();
  assert.equal(found.customers.length, 1);
  assert.deepEqual(found.customers[0].cards.map((c: { label: string; expires: string; expired: boolean; isDefault: boolean }) => [c.label, c.expires, c.expired, c.isDefault]), [["Visa •••• 1881", "08/31", false, true], ["Mastercard •••• 4444", "01/20", true, false]]);
  assert.deepEqual(liveStripe.calls.filter((c) => c.method !== "GET"), [], "finding writes nothing in Stripe");

  // Connecting a live card makes the client live — only when it is said so.
  const unsaid = await post(ADMIN, { clientId: ACME, action: "connect_card", mode: "live", customerId, paymentMethodId });
  assert.equal(unsaid.status, 400);
  assert.equal(db.rows("os_usage_billing_settings")[0].test_only, true);
  const expiredCard = liveStripe.addCard(customerId, { last4: "0005", expMonth: 1, expYear: 2021 });
  const exp = await post(ADMIN, { clientId: ACME, action: "connect_card", mode: "live", customerId, paymentMethodId: expiredCard, goLive: true });
  assert.equal(exp.status, 409);
  assert.match((await exp.json()).error, /expired/);
  const connected = await post(ADMIN, { clientId: ACME, action: "connect_card", mode: "live", customerId, paymentMethodId, goLive: true });
  assert.equal(connected.status, 200);
  const cbody = await connected.json();
  assert.equal(cbody.mode, "live");
  assert.equal(cbody.settings.test_only, false);
  assert.equal(cbody.settings.card_label, "Visa •••• 1881 · exp 08/31");
  const g = await (await get(ADMIN)).json();
  assert.equal(g.mode, "live");
  assert.equal(g.liveKeyState, "live");

  // Preview: the real leads of the week that ended; fake leads refused; a period still running refused.
  const fake = await post(ADMIN, { clientId: ACME, action: "preview", fakeLeads });
  assert.equal(fake.status, 403);
  const running = await post(ADMIN, { clientId: ACME, action: "preview", periodStart: addDays(ANCHOR, 7) });
  assert.equal(running.status, 400);
  assert.match((await running.json()).error, /not ended yet/);
  const pv = (await (await post(ADMIN, { clientId: ACME, action: "preview" })).json()).preview;
  assert.deepEqual(pv.period, { start: ANCHOR, end: TODAY });
  assert.equal(pv.count, 2);
  assert.equal(pv.amountCents, 50_000);

  // Charge: never without the full approval (amount, mode, card, leads); never a different one — nothing written, nothing in Stripe.
  const good = { periodStart: ANCHOR, count: 2, amountCents: 50_000, mode: "live", paymentMethodId, leadsHash: pv.leadsHash };
  const before = liveStripe.calls.length;
  for (const approved of [undefined, { periodStart: ANCHOR, count: 2, amountCents: 50_000 }, { ...good, leadsHash: undefined }, { ...good, mode: undefined }]) {
    const r = await post(ADMIN, { clientId: ACME, action: "charge", approved });
    assert.equal(r.status, 400, JSON.stringify(approved));
  }
  for (const approved of [
    { ...good, amountCents: 25_000 }, { ...good, count: 1 }, { ...good, periodStart: addDays(ANCHOR, -7) }, { ...good, leadsHash: "0000000000" },
    { ...good, mode: "test" }, { ...good, paymentMethodId: "pm_LiveSomeOther1" },
  ]) {
    const r = await post(ADMIN, { clientId: ACME, action: "charge", approved });
    assert.ok(r.status === 409 || r.status === 400, JSON.stringify(approved));
    assert.match((await r.json()).error, /changed since you looked|does not begin|not started|has not ended/);
  }
  assert.equal(liveStripe.calls.length, before);
  assert.equal(db.rows("os_usage_billing_periods").length, 0);

  const ok = await post(ADMIN, { clientId: ACME, action: "charge", approved: good });
  assert.equal(ok.status, 200);
  const r = await ok.json();
  assert.equal(r.outcome, "paid");
  assert.equal(r.invoice.total, 50_000);
  assert.equal(r.invoice.test, false);
  const inv = [...liveStripe.invoices.values()][0];
  assert.equal(inv.customer, customerId);
  assert.equal(inv.default_payment_method, paymentMethodId);
  assert.deepEqual((inv.metadata as Record<string, string>).os_usage_mode, "live");
  assert.equal((inv.metadata as Record<string, string>).os_usage_test, undefined);
  assert.deepEqual(inv.lines.map((l) => l.description.replace(/ — .*/, "")), ["Lead: Jordan Ellis", "Lead: Sam Lee"]);
  const period = db.rows("os_usage_billing_periods")[0];
  assert.equal(period.test_mode, false, "a live period");
  assert.equal(period.status, "paid");

  assert.equal(liveStripe.creates(/^\/invoices$/)[0].params.discounts, "", "never the customer's own coupon");
  // Never twice; the test Stripe never touched; no live key ever reached the test fake.
  const again = await post(ADMIN, { clientId: ACME, action: "charge", approved: good });
  assert.equal(again.status, 409);
  assert.equal(liveStripe.creates(/\/pay$/).length, 1);
  assert.deepEqual(stripe.calls, []);
  assert.deepEqual(stripe.liveKeySeen, []);
  assert.deepEqual(liveStripe.liveKeySeen, []);
  // The tab's history: only the pay-per-lead invoices, from live Stripe.
  const h = await (await get(ADMIN)).json();
  assert.equal(h.invoices.length, 1);
  assert.equal(h.periods[0].status, "paid");
});

test("LIVE: a refused card — the period is failed; the client's new card connected; Retry charges it once; two Retries at once charge once", async () => {
  seed([testRow({ price_cents: 25_000 })]);
  seedLeads();
  process.env.ONBOARDING_STRIPE_SECRET_KEY = LIVE_KEY;
  const { customerId, paymentMethodId } = liveStripe.addCustomerWithCard({ name: "Acme Realty" });
  assert.equal((await post(ADMIN, { clientId: ACME, action: "connect_card", mode: "live", customerId, paymentMethodId, goLive: true })).status, 200);
  liveStripe.declineCards.add(paymentMethodId);
  const pv = (await (await post(ADMIN, { clientId: ACME, action: "preview" })).json()).preview;
  const r = await (await post(ADMIN, { clientId: ACME, action: "charge", approved: { periodStart: ANCHOR, count: 2, amountCents: 50_000, mode: "live", paymentMethodId, leadsHash: pv.leadsHash } })).json();
  assert.equal(r.outcome, "failed");
  assert.equal(db.rows("os_usage_billing_periods")[0].status, "failed");

  // Retrying the same refused card: refused again, still failed.
  const same = await (await retry()).json();
  assert.equal(same.outcome, "failed");
  // The client adds a new card in Stripe; it is connected (the client is live already — no goLive needed).
  const newCard = liveStripe.addCard(customerId, { brand: "amex", last4: "0005" });
  assert.equal((await post(ADMIN, { clientId: ACME, action: "connect_card", mode: "live", customerId, paymentMethodId: newCard })).status, 200);
  const [a, b] = await Promise.all([retry(), retry()]);
  const statuses = [a.status, b.status].sort();
  // (Run one after the other the second is also refused — the period is paid by then; billing.test pins the claim itself.)
  assert.deepEqual(statuses, [200, 409], "one retry charges; the other is refused");
  assert.equal(db.rows("os_usage_billing_periods")[0].status, "paid");
  const inv = [...liveStripe.invoices.values()][0];
  assert.equal(inv.status, "paid");
  assert.equal(inv.default_payment_method, newCard, "charged to the card connected now");
  assert.equal(liveStripe.calls.filter((c) => c.method === "POST" && /\/pay$/.test(c.path)).length, 3, "the first charge, the refused retry, the one that paid");
  // Nothing left to retry.
  assert.equal((await retry()).status, 409);
});

test("LIVE: another client's Stripe customer is never connected; a customer that doesn't exist, or a card not on it, is refused — nothing changes", async () => {
  seed([testRow(), testRow({ os_client_id: BETA, test_only: false, stripe_customer_id: "cus_LiveBeta01", default_payment_method_id: "pm_LiveBeta01" })]);
  process.env.ONBOARDING_STRIPE_SECRET_KEY = LIVE_KEY;
  const mine = liveStripe.addCustomerWithCard({ name: "Acme Realty" });
  const theirs = liveStripe.addCustomerWithCard({ name: "Beta Homes" });
  db.rows("os_usage_billing_settings").find((r) => r.os_client_id === BETA)!.stripe_customer_id = theirs.customerId;
  const t = await post(ADMIN, { clientId: ACME, action: "connect_card", mode: "live", customerId: theirs.customerId, paymentMethodId: theirs.paymentMethodId, goLive: true });
  assert.equal(t.status, 409);
  assert.match((await t.json()).error, /belongs to another client/);
  db.rows("os_clients").find((c) => c.id === BETA)!.stripe_customer_id = mine.customerId; // on Beta's record
  const rec = await post(ADMIN, { clientId: ACME, action: "connect_card", mode: "live", customerId: mine.customerId, paymentMethodId: mine.paymentMethodId, goLive: true });
  assert.equal(rec.status, 409);
  assert.match((await rec.json()).error, /belongs to Beta Homes/);
  db.rows("os_clients").find((c) => c.id === BETA)!.stripe_customer_id = null;
  const ghost = await post(ADMIN, { clientId: ACME, action: "connect_card", mode: "live", customerId: "cus_LiveNope0001", paymentMethodId: mine.paymentMethodId, goLive: true });
  assert.equal(ghost.status, 404);
  const notOn = await post(ADMIN, { clientId: ACME, action: "connect_card", mode: "live", customerId: mine.customerId, paymentMethodId: theirs.paymentMethodId, goLive: true });
  assert.equal(notOn.status, 409);
  assert.match((await notOn.json()).error, /not on this customer/);
  assert.equal(db.rows("os_usage_billing_settings").find((r) => r.os_client_id === ACME)!.test_only, true, "still a test client");
  assert.deepEqual(liveStripe.calls.filter((c) => c.method !== "GET"), []);
});

test("LIVE: a customer the Billing tab counts for another client (by its name) is flagged and never connected; nothing changes", async () => {
  seed([testRow({ price_cents: 25_000 })]);
  process.env.ONBOARDING_STRIPE_SECRET_KEY = LIVE_KEY;
  const theirs = liveStripe.addCustomerWithCard({ name: "Beta Homes" }); // counted for Beta by its name, nothing else
  const found = await (await post(ADMIN, { clientId: ACME, action: "find_cards", mode: "live", customerId: theirs.customerId })).json();
  assert.equal(found.claimsChecked, true);
  assert.deepEqual(found.customers[0].claimedBy, ["Beta Homes"]);
  const r = await post(ADMIN, { clientId: ACME, action: "connect_card", mode: "live", customerId: theirs.customerId, paymentMethodId: theirs.paymentMethodId, goLive: true });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /counted for Beta Homes on the Billing tab/);
  assert.equal(db.rows("os_usage_billing_settings")[0].test_only, true);
  // An id that isn't a customer: said so.
  const ghost = await (await post(ADMIN, { clientId: ACME, action: "find_cards", mode: "live", customerId: "cus_LiveNope0001" })).json();
  assert.equal(ghost.notFound, "cus_LiveNope0001");
  assert.deepEqual(liveStripe.calls.filter((c) => c.method !== "GET"), []);
});

test("LIVE: Stripe not answering the payment leaves the period 'card refused' — never stuck — and Retry first asks Stripe, then charges once", async () => {
  seed([testRow({ price_cents: 25_000 })]);
  seedLeads();
  process.env.ONBOARDING_STRIPE_SECRET_KEY = LIVE_KEY;
  const { customerId, paymentMethodId } = liveStripe.addCustomerWithCard({ name: "Acme Realty", percentOff: 20 }); // a coupon on the customer
  assert.equal((await post(ADMIN, { clientId: ACME, action: "connect_card", mode: "live", customerId, paymentMethodId, goLive: true })).status, 200);
  const pv = (await (await post(ADMIN, { clientId: ACME, action: "preview" })).json()).preview;
  liveStripe.failWhen = (c) => c.method === "POST" && /\/pay$/.test(c.path);
  const r = await (await post(ADMIN, { clientId: ACME, action: "charge", approved: { periodStart: ANCHOR, count: 2, amountCents: 50_000, mode: "live", paymentMethodId, leadsHash: pv.leadsHash } })).json();
  assert.equal(r.outcome, "failed");
  assert.match(r.message, /Stripe did not answer the charge/);
  assert.equal(db.rows("os_usage_billing_periods")[0].status, "failed");
  liveStripe.failWhen = null;
  const retried = await (await retry()).json();
  assert.equal(retried.outcome, "paid");
  const inv = [...liveStripe.invoices.values()][0];
  assert.equal(inv.total, 50_000, "the customer's 20% coupon is not on it — exactly the leads approved");
  assert.equal(liveStripe.invoices.size, 1);
});

test("LIVE: a card whose bank wants 3-D Secure — said plainly, the pay link kept, nothing charged twice", async () => {
  seed([testRow({ price_cents: 25_000 })]);
  seedLeads();
  process.env.ONBOARDING_STRIPE_SECRET_KEY = LIVE_KEY;
  const { customerId, paymentMethodId } = liveStripe.addCustomerWithCard({ name: "Acme Realty" });
  liveStripe.actionCards.add(paymentMethodId);
  assert.equal((await post(ADMIN, { clientId: ACME, action: "connect_card", mode: "live", customerId, paymentMethodId, goLive: true })).status, 200);
  const pv = (await (await post(ADMIN, { clientId: ACME, action: "preview" })).json()).preview;
  const r = await (await post(ADMIN, { clientId: ACME, action: "charge", approved: { periodStart: ANCHOR, count: 2, amountCents: 50_000, mode: "live", paymentMethodId, leadsHash: pv.leadsHash } })).json();
  assert.equal(r.outcome, "failed");
  assert.match(r.message, /3-D Secure/);
  const row = db.rows("os_usage_billing_periods")[0];
  assert.match(String(row.error), /3-D Secure/);
  assert.ok(row.hosted_invoice_url);
});

test("LIVE: a new Stripe customer connected later — an earlier period's invoice (on the old customer) is not retried with the new card", async () => {
  seed([testRow({ price_cents: 25_000 })]);
  seedLeads();
  process.env.ONBOARDING_STRIPE_SECRET_KEY = LIVE_KEY;
  const first = liveStripe.addCustomerWithCard({ name: "Acme Realty" });
  liveStripe.declineCards.add(first.paymentMethodId);
  assert.equal((await post(ADMIN, { clientId: ACME, action: "connect_card", mode: "live", customerId: first.customerId, paymentMethodId: first.paymentMethodId, goLive: true })).status, 200);
  const pv = (await (await post(ADMIN, { clientId: ACME, action: "preview" })).json()).preview;
  await post(ADMIN, { clientId: ACME, action: "charge", approved: { periodStart: ANCHOR, count: 2, amountCents: 50_000, mode: "live", paymentMethodId: first.paymentMethodId, leadsHash: pv.leadsHash } });
  const second = liveStripe.addCustomerWithCard({ name: "Acme Realty LLC" });
  assert.equal((await post(ADMIN, { clientId: ACME, action: "connect_card", mode: "live", customerId: second.customerId, paymentMethodId: second.paymentMethodId })).status, 200);
  const r = await retry();
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /earlier Stripe customer/);
  assert.equal(db.rows("os_usage_billing_periods")[0].status, "failed", "left as it was");
});

test("LIVE retry from a page left open: another card, the test mode, another amount — refused, nothing charged; no approval at all — refused", async () => {
  seed([testRow({ price_cents: 25_000 })]);
  seedLeads();
  process.env.ONBOARDING_STRIPE_SECRET_KEY = LIVE_KEY;
  const { customerId, paymentMethodId } = liveStripe.addCustomerWithCard({ name: "Acme Realty" });
  liveStripe.declineCards.add(paymentMethodId);
  await post(ADMIN, { clientId: ACME, action: "connect_card", mode: "live", customerId, paymentMethodId, goLive: true });
  const pv = (await (await post(ADMIN, { clientId: ACME, action: "preview" })).json()).preview;
  await post(ADMIN, { clientId: ACME, action: "charge", approved: { periodStart: ANCHOR, count: 2, amountCents: 50_000, mode: "live", paymentMethodId, leadsHash: pv.leadsHash } });
  const pays = liveStripe.creates(/\/pay$/).length;
  assert.equal((await post(ADMIN, { clientId: ACME, action: "retry", periodStart: ANCHOR })).status, 400);
  for (const o of [{ paymentMethodId: "pm_LiveOldCard01" }, { mode: "test" }, { amountCents: 25_000 }]) {
    const r = await retry(o);
    assert.equal(r.status, 409, JSON.stringify(o));
    assert.match((await r.json()).error, /changed since you looked/);
  }
  assert.equal(liveStripe.creates(/\/pay$/).length, pays, "no retry reached Stripe's pay");
  assert.equal(db.rows("os_usage_billing_periods")[0].status, "failed");
});

test("LIVE 'Try the charge again' (a charge that stopped half way): the card connected NOW, and never the earlier customer's invoice", async () => {
  seed([testRow({ price_cents: 25_000 })]);
  seedLeads();
  process.env.ONBOARDING_STRIPE_SECRET_KEY = LIVE_KEY;
  const first = liveStripe.addCustomerWithCard({ name: "Acme Realty" });
  await post(ADMIN, { clientId: ACME, action: "connect_card", mode: "live", customerId: first.customerId, paymentMethodId: first.paymentMethodId, goLive: true });
  const pv = (await (await post(ADMIN, { clientId: ACME, action: "preview" })).json()).preview;
  // The charge dies at finalize: the row stays 'draft' with its invoice.
  liveStripe.failWhen = (c) => c.method === "POST" && /\/finalize$/.test(c.path);
  const died = await post(ADMIN, { clientId: ACME, action: "charge", approved: { periodStart: ANCHOR, count: 2, amountCents: 50_000, mode: "live", paymentMethodId: first.paymentMethodId, leadsHash: pv.leadsHash } });
  assert.equal(died.status, 502);
  liveStripe.failWhen = null;
  const row = db.rows("os_usage_billing_periods")[0];
  assert.equal(row.status, "draft");
  row.claimed_at = new Date(Date.now() - 60 * 60_000).toISOString(); // stale: resumable
  // A new card on the same customer, then "Try the charge again" with it: charged to the NEW card.
  const newCard = liveStripe.addCard(first.customerId, { last4: "5555" });
  await post(ADMIN, { clientId: ACME, action: "connect_card", mode: "live", customerId: first.customerId, paymentMethodId: newCard });
  const again = await (await post(ADMIN, { clientId: ACME, action: "charge", periodStart: ANCHOR, approved: { periodStart: ANCHOR, count: 2, amountCents: 50_000, mode: "live", paymentMethodId: newCard, leadsHash: pv.leadsHash } })).json();
  assert.equal(again.outcome, "paid");
  assert.equal([...liveStripe.invoices.values()][0].default_payment_method, newCard, "paid with the card approved, not the one the invoice was made with");
  assert.equal(liveStripe.invoices.size, 1);

  // Another period that stopped half way, then a DIFFERENT customer connected: the earlier customer's invoice is never charged.
  seed([testRow({ price_cents: 25_000 })]);
  seedLeads();
  process.env.ONBOARDING_STRIPE_SECRET_KEY = LIVE_KEY;
  const a = liveStripe.addCustomerWithCard({ name: "Acme Realty" });
  await post(ADMIN, { clientId: ACME, action: "connect_card", mode: "live", customerId: a.customerId, paymentMethodId: a.paymentMethodId, goLive: true });
  const pv2 = (await (await post(ADMIN, { clientId: ACME, action: "preview" })).json()).preview;
  liveStripe.failWhen = (c) => c.method === "POST" && /\/finalize$/.test(c.path);
  await post(ADMIN, { clientId: ACME, action: "charge", approved: { periodStart: ANCHOR, count: 2, amountCents: 50_000, mode: "live", paymentMethodId: a.paymentMethodId, leadsHash: pv2.leadsHash } });
  liveStripe.failWhen = null;
  db.rows("os_usage_billing_periods")[0].claimed_at = new Date(Date.now() - 60 * 60_000).toISOString();
  const b = liveStripe.addCustomerWithCard({ name: "Acme Realty LLC" });
  await post(ADMIN, { clientId: ACME, action: "connect_card", mode: "live", customerId: b.customerId, paymentMethodId: b.paymentMethodId });
  const r = await (await post(ADMIN, { clientId: ACME, action: "charge", periodStart: ANCHOR, approved: { periodStart: ANCHOR, count: 2, amountCents: 50_000, mode: "live", paymentMethodId: b.paymentMethodId, leadsHash: pv2.leadsHash } })).json();
  assert.equal(r.outcome, "failed");
  assert.match(r.message, /earlier Stripe customer — not charged/);
  assert.equal(liveStripe.creates(/\/pay$/).length, 0, "nothing paid");
  // Retry then removes that never-finished draft (never charged) and opens the period again.
  const reopened = await (await retry()).json();
  assert.equal(reopened.outcome, "nothing");
  assert.match(reopened.message, /never finished, so it was removed/);
  assert.equal(db.rows("os_usage_billing_periods")[0].status, "preview");
  assert.equal(liveStripe.invoices.size, 0);
  // …and it charges cleanly, on the customer connected now.
  const pv3 = (await (await post(ADMIN, { clientId: ACME, action: "preview" })).json()).preview;
  const ok = await (await post(ADMIN, { clientId: ACME, action: "charge", approved: { periodStart: ANCHOR, count: 2, amountCents: 50_000, mode: "live", paymentMethodId: b.paymentMethodId, leadsHash: pv3.leadsHash } })).json();
  assert.equal(ok.outcome, "paid", JSON.stringify(ok).slice(0, 400));
  assert.equal([...liveStripe.invoices.values()][0].customer, b.customerId);
});

test("Refresh: charged but still unpaid in Stripe becomes 'card refused', so it can be retried — never stuck", async () => {
  seed([testRow({ price_cents: 25_000 })]);
  seedLeads();
  process.env.ONBOARDING_STRIPE_SECRET_KEY = LIVE_KEY;
  const { customerId, paymentMethodId } = liveStripe.addCustomerWithCard({ name: "Acme Realty" });
  await post(ADMIN, { clientId: ACME, action: "connect_card", mode: "live", customerId, paymentMethodId, goLive: true });
  const pv = (await (await post(ADMIN, { clientId: ACME, action: "preview" })).json()).preview;
  liveStripe.declineCards.add(paymentMethodId);
  await post(ADMIN, { clientId: ACME, action: "charge", approved: { periodStart: ANCHOR, count: 2, amountCents: 50_000, mode: "live", paymentMethodId, leadsHash: pv.leadsHash } });
  const row = db.rows("os_usage_billing_periods")[0];
  row.status = "charged"; // as if the answer to /pay was lost after the row was marked charged
  row.charged_at = new Date().toISOString();
  const soon = await (await post(ADMIN, { clientId: ACME, action: "refresh", periodStart: ANCHOR })).json();
  assert.equal(soon.row.status, "charged", "within two minutes it may still be going through — left as it is");
  row.charged_at = new Date(Date.now() - 5 * 60_000).toISOString();
  const r = await (await post(ADMIN, { clientId: ACME, action: "refresh", periodStart: ANCHOR })).json();
  assert.equal(r.row.status, "failed");
  assert.match(r.row.error, /still unpaid/);
});
