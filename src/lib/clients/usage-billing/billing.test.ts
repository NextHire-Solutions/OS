/*
 * Pay per lead, end to end against the in-memory database
 * (tools/master-inbox/test/fake-postgrest.ts) and the fake Stripe
 * (test/fake-stripe.ts). The database refuses every host but its own and
 * lists it in `db.blocked`; Stripe is injected. Nothing leaves the process.
 *
 * What is pinned:
 *   - the lead sources: which hand-offs and which introductions are billable;
 *   - a preview writes nothing, anywhere;
 *   - a period is billed once — a second attempt, two at the same moment, a
 *     run after a person: one invoice, one charge;
 *   - a claim that died half way is resumed with the same lines, the missing
 *     ones only, and checked before it is charged;
 *   - a client is billed in its own mode only (test or live); the scheduled
 *     run is off without its switch, only previews without the second, and
 *     never charges a live client;
 *   - a retry is claimed once, even by two people at the same moment.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest, type Row } from "../../tools/master-inbox/test/fake-postgrest.ts";
import { FakeStripe } from "./test/fake-stripe.ts";

configureFakeEnvironment("MASTER_INBOX_");
const db = new FakePostgrest();
globalThis.fetch = db.fetch as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const billing = await import("./billing.ts");
const { usageStripe } = await import("./stripe.ts");
const { periodKey } = await import("./model.ts");

const fake = new FakeStripe();
const stripe = usageStripe("sk_test_51FakeFakeFakeFake", fake.fetch as typeof fetch);

const ACME = "20000000-0000-4000-8000-000000000001"; // the test client
const BETA = "20000000-0000-4000-8000-000000000002"; // a client NOT marked test
const BOSTON = "10000000-0000-4000-8000-000000000001"; // Acme's portal (linked)
const FLORIDA = "10000000-0000-4000-8000-000000000002"; // Acme's second portal (by alias)
const LIVE = "10000000-0000-4000-8000-000000000003"; // Beta's portal
const ANCHOR = "2026-10-05";
const NOW = new Date("2026-10-14T15:00:00.000Z"); // Wed: the last completed week is Oct 5–11
const WEEK = { start: "2026-10-05", end: "2026-10-12" };
const PK = periodKey(ACME, WEEK.start);
const ADMIN = "admin@outreachify.io";

function seed(o: { acmeSettings?: Row | null; betaSettings?: Row | null; periods?: Row[] } = {}) {
  db.reset();
  fake.reset();
  db.seed("os_clients", [
    { id: ACME, name: "Acme Realty", aliases: ["Acme Florida"], status: "active", mi_client_id: BOSTON },
    { id: BETA, name: "Beta Homes", aliases: [], status: "active", mi_client_id: LIVE },
  ]);
  db.seed("clients", [
    { id: BOSTON, name: "Acme Boston", slug: "acme-boston", aliases: [] },
    { id: FLORIDA, name: "Acme Florida", slug: "acme-florida", aliases: [] },
    { id: LIVE, name: "Beta Homes", slug: "beta-homes", aliases: [] },
  ]);
  db.seed("os_campaign_portals", []);
  const base = { enabled: true, test_only: true, price_cents: 10_000, every_days: 7, anchor_date: ANCHOR, lead_source: "handoffs", stripe_customer_id: null, default_payment_method_id: null, card_label: null, setup_session_id: null };
  db.seed("os_usage_billing_settings", [
    ...(o.acmeSettings === null ? [] : [{ os_client_id: ACME, ...base, ...o.acmeSettings }]),
    ...(o.betaSettings ? [{ os_client_id: BETA, ...base, test_only: false, ...o.betaSettings }] : []),
  ]);
  db.seed("os_usage_billing_periods", (o.periods ?? []).map((r) => ({ test_mode: true, ...r })));
  // A hand-off the brokerage relay sent is NOT a lead by itself (31 Oct): only a conversation marked Interested is.
  db.seed("os_brokerage_relays", [
    { workspace_id: "w", kind: "handoff", status: "sent", practice: false, os_client_id: ACME, thread_id: "relay-only", agent_email: "relay@x.test", agent_name: "Relay Only", sent_at: "2026-10-06T15:00:00.000Z" },
  ]);
  db.seed("client_pipeline_entries", [
    { client_id: BOSTON, thread_id: "t1", lead_name: "Ivy Intro", lead_email: "ivy@x.test", source: "Introduction", introduced_at: "2026-10-06T12:00:00.000Z" },
    { client_id: FLORIDA, thread_id: "t2", lead_name: "Nell Null", lead_email: "nell@x.test", source: null, introduced_at: "2026-10-08T12:00:00.000Z" },
    { client_id: BOSTON, thread_id: "t3", lead_name: "Own Candidate", lead_email: "own@x.test", source: "Client Entry", introduced_at: "2026-10-08T12:00:00.000Z" },
    { client_id: LIVE, thread_id: "t4", lead_name: "Beta Lead", lead_email: "b@x.test", source: "Introduction", introduced_at: "2026-10-08T12:00:00.000Z" },
    { client_id: BOSTON, thread_id: "t5", lead_name: "Too Late", lead_email: "late@x.test", source: "Introduction", introduced_at: "2026-10-13T12:00:00.000Z" },
  ]);
  // Booked calls: conversations marked "Meetings Booked".
  db.seed("labels", [{ id: "lab-mb", name: "Meetings Booked" }, { id: "lab-int", name: "Interested" }]);
  db.seed("leads", [
    { id: "l1", email: "Cal@Call.test", full_name: "Cal Caller" },
    { id: "l2", email: "dee@call.test", full_name: "Dee Dialer" },
    { id: "l3", email: "beta-call@x.test", full_name: "Beta's Call" },
    // Interested replies (the "per lead" products):
    { id: "l5", email: "Jordan@Coastal.test", full_name: "Jordan Ellis" },
    { id: "l6", email: "sam@harbor.test", full_name: "Sam Lee" },
    { id: "l7", email: "pat@bay.test", full_name: "Pat Kim" },
    { id: "l8", email: "jordan@coastal.test", full_name: "Jordan again" },
    { id: "l9", email: "beta@x.test", full_name: "Beta's" },
    { id: "l10", email: "early@x.test", full_name: "Before" },
    { id: "l11", email: "next@x.test", full_name: "Next week" },
  ]);
  db.seed("threads", [
    { id: "th1", client_id: BOSTON, lead_id: "l1" },
    { id: "th2", client_id: FLORIDA, lead_id: "l2" },
    { id: "th3", client_id: LIVE, lead_id: "l3" },
    { id: "th5", client_id: BOSTON, lead_id: "l1" },
    { id: "ti-jordan", client_id: BOSTON, lead_id: "l5" },
    { id: "ti-sam", client_id: FLORIDA, lead_id: "l6" }, // the alias portal
    { id: "ti-pat", client_id: BOSTON, lead_id: "l7" },
    { id: "ti-jordan2", client_id: BOSTON, lead_id: "l8" },
    { id: "ti-beta", client_id: LIVE, lead_id: "l9" },
    { id: "ti-early", client_id: BOSTON, lead_id: "l10" },
    { id: "ti-next", client_id: BOSTON, lead_id: "l11" },
  ]);
  db.seed("label_assignments", [
    { label_id: "lab-mb", target_type: "thread", target_id: "th1", assigned_at: "2026-10-06T15:00:00.000Z" },
    { label_id: "lab-mb", target_type: "thread", target_id: "th2", assigned_at: "2026-10-09T15:00:00.000Z" },
    { label_id: "lab-mb", target_type: "thread", target_id: "th3", assigned_at: "2026-10-09T15:00:00.000Z" }, // Beta's portal
    { label_id: "lab-int", target_type: "thread", target_id: "ti-jordan", assigned_at: "2026-10-06T14:00:00.000Z" },
    { label_id: "lab-int", target_type: "thread", target_id: "ti-sam", assigned_at: "2026-10-07T18:30:00.000Z" },
    // Sunday 10 p.m. Eastern = Monday in UTC: still the week of Oct 5.
    { label_id: "lab-int", target_type: "thread", target_id: "ti-pat", assigned_at: "2026-10-12T02:00:00.000Z" },
    // Never billable this week:
    { label_id: "lab-int", target_type: "thread", target_id: "ti-jordan2", assigned_at: "2026-10-09T10:00:00.000Z" }, // same agent, same week
    { label_id: "lab-int", target_type: "thread", target_id: "ti-beta", assigned_at: "2026-10-06T17:00:00.000Z" }, // Beta's portal
    { label_id: "lab-int", target_type: "thread", target_id: "ti-early", assigned_at: "2026-10-05T03:59:00.000Z" }, // Oct 4, Eastern
    { label_id: "lab-int", target_type: "thread", target_id: "ti-next", assigned_at: "2026-10-12T04:00:00.000Z" }, // Oct 12, Eastern
    { label_id: "lab-mb", target_type: "thread", target_id: "th5", assigned_at: "2026-10-10T15:00:00.000Z" }, // Cal again
    { label_id: "lab-mb", target_type: "thread", target_id: "th1", assigned_at: "2026-10-13T15:00:00.000Z" }, // next week
  ]);
}

async function withCard() {
  const { id } = await stripe.createCustomer({ osClientId: ACME, name: "ZZ Usage Test — Acme Realty", idempotencyKey: "seed" });
  const pm = await stripe.attachPaymentMethod("pm_card_visa", id);
  await stripe.setDefaultPaymentMethod(id, pm.id);
  await db.fetch(`http://supabase.test/rest/v1/os_usage_billing_settings?os_client_id=eq.${ACME}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ stripe_customer_id: id, default_payment_method_id: pm.id, card_label: pm.cardLabel }),
  });
  fake.calls.length = 0;
  db.calls.length = 0;
  return { customerId: id, pm: pm.id };
}

const settingsOf = async (id = ACME) => (await billing.loadSettings(id))!;
const rowsOf = () => db.rows("os_usage_billing_periods");
const writes = () => db.calls.filter((c) => c.method !== "GET" && c.method !== "HEAD");

/* ------------------------------------------------------------ lead sources --- */

test("per lead: conversations of the client's portals marked Interested, in the Eastern week, once per agent — nothing has to be sent; the preview writes nothing", async () => {
  seed();
  db.calls.length = 0;
  const p = await billing.previewPeriod(ACME, await settingsOf(), { now: NOW });
  assert.deepEqual(p.period, WEEK);
  assert.deepEqual(p.leads.map((l) => [l.key, l.name]), [["jordan@coastal.test", "Jordan Ellis"], ["sam@harbor.test", "Sam Lee"], ["pat@bay.test", "Pat Kim"]]);
  assert.equal(p.skipped.length, 1, "Jordan's second Interested reply");
  assert.ok(!p.leads.some((l) => l.key === "relay@x.test"), "a hand-off alone is not a lead");
  assert.equal(p.amountCents, 30_000);
  assert.deepEqual(p.lines.map((l) => l.description), ["Lead: Jordan Ellis — Oct 6, 2026", "Lead: Sam Lee — Oct 7, 2026", "Lead: Pat Kim — Oct 11, 2026"]);
  assert.equal(p.description, "Pay per lead · Oct 5 – Oct 11, 2026 · 3 leads × $100.00");
  assert.deepEqual(writes(), [], "a preview writes nothing");
  assert.deepEqual(fake.calls, [], "and never asks Stripe");
  assert.deepEqual(db.blocked, []);
});

test("an agent billed in another period is never billed again", async () => {
  seed({ periods: [{ os_client_id: ACME, period_start: "2026-09-28", period_end: "2026-10-05", status: "paid", leads: [{ key: "sam@harbor.test", name: "Sam Lee", at: "2026-09-30T12:00:00.000Z", source: "handoff" }] }] });
  const p = await billing.previewPeriod(ACME, await settingsOf(), { now: NOW });
  assert.deepEqual(p.leads.map((l) => l.key), ["jordan@coastal.test", "pat@bay.test"]);
  assert.ok(p.skipped.some((s) => s.reason === "billed_before" && s.lead.key === "sam@harbor.test"));
});

test("calls (the per-call products): conversations of the client's portals marked Meetings Booked, once per agent", async () => {
  seed({ acmeSettings: { lead_source: "calls", price_cents: 50_000 } });
  const p = await billing.previewPeriod(ACME, await settingsOf(), { now: NOW });
  assert.deepEqual(p.leads.map((l) => [l.name, l.source]), [["Cal Caller", "call"], ["Dee Dialer", "call"]], "the alias portal counts; Beta's portal, Interested-only and next week do not; Cal once");
  assert.equal(p.amountCents, 100_000);
  assert.match(p.description, /2 calls × \$500\.00/);
  assert.match(p.lines[0].description, /^Call: Cal Caller — /);
  assert.deepEqual(writes(), []);
});

test("an alias equal to another client's portal name never bills that client's leads, calls or introductions", async () => {
  for (const source of ["handoffs", "calls", "introductions"]) {
    seed({ acmeSettings: { lead_source: source } });
    // Acme's alias is the NAME of Beta's linked portal: by name alone it would look like Acme's.
    db.rows("os_clients").find((c) => c.id === ACME)!.aliases = ["Acme Florida", "Beta Homes"];
    const p = await billing.previewPeriod(ACME, await settingsOf(), { now: NOW });
    assert.ok(!p.leads.some((l) => /beta/i.test(l.name) || /beta/i.test(l.key)), `${source}: Beta's portal is Beta's`);
    assert.ok(p.leads.length > 0, `${source}: Acme's own still count`);
  }
});

test("test and live periods are kept apart: a period billed in the other mode never counts as billed here", async () => {
  seed({ periods: [{ os_client_id: ACME, period_start: "2026-09-28", period_end: "2026-10-05", status: "paid", test_mode: false, leads: [{ key: "sam@harbor.test", name: "Sam Lee", at: "2026-09-30T12:00:00.000Z", source: "handoff" }] }] });
  const p = await billing.previewPeriod(ACME, await settingsOf(), { now: NOW });
  assert.ok(p.leads.some((l) => l.key === "sam@harbor.test"), "Sam was billed only in the other mode");
  assert.deepEqual(writes(), []);
});

test("introductions (the other definition): our entries in any of the client's portals, never the client's own", async () => {
  seed({ acmeSettings: { lead_source: "introductions" } });
  const p = await billing.previewPeriod(ACME, await settingsOf(), { now: NOW });
  assert.deepEqual(p.leads.map((l) => [l.name, l.source]), [["Ivy Intro", "introduction"], ["Nell Null", "introduction"]], "the alias portal counts; a NULL source is ours; Client Entry, other clients and other weeks are not");
  assert.deepEqual(writes(), []);
});

/* ------------------------------------------------------------- settings --- */

test("saving: a new client is written test_only = true, and test_only is never written again", async () => {
  seed({ acmeSettings: null });
  const s = await billing.saveSettings(ACME, { priceCents: 20_000, everyDays: 14, anchorDate: ANCHOR, leadSource: "handoffs", enabled: false }, ADMIN);
  assert.equal(s.test_only, true);
  assert.equal(s.price_cents, 20_000);
  assert.equal(s.created_by, ADMIN);
  db.calls.length = 0;
  db.rows("os_usage_billing_settings")[0].test_only = false; // live, as connectCard leaves it
  // A live client's schedule and what counts are fixed (they would move billed periods) — refused, nothing written.
  await assert.rejects(billing.saveSettings(ACME, { priceCents: 10_000, everyDays: 7, anchorDate: ANCHOR, leadSource: "introductions", enabled: true }, ADMIN), (e: unknown) => e instanceof billing.UsageBillingError && e.status === 409 && /live: its billing schedule/.test(e.message));
  assert.deepEqual(writes(), []);
  // Its price and switch can change — and saving never touches test_only.
  await billing.saveSettings(ACME, { priceCents: 25_000, everyDays: 14, anchorDate: ANCHOR, leadSource: "handoffs", enabled: true }, ADMIN);
  for (const w of writes()) assert.ok(!("test_only" in (w.body as Row)), "an update never touches test_only");
  assert.equal(db.rows("os_usage_billing_settings")[0].test_only, false);
  assert.equal(db.rows("os_usage_billing_settings")[0].price_cents, 25_000);
  await assert.rejects(billing.saveSettings("20000000-0000-4000-8000-00000000000f", { priceCents: 10_000, everyDays: 7, anchorDate: ANCHOR, leadSource: "handoffs", enabled: false }, ADMIN), /No such client/);
});

test("card setup: a TEST customer named 'ZZ Usage Test — …', a setup Checkout, and its card stored once complete", async () => {
  seed();
  const link = await billing.createSetupLink(ACME, stripe, "https://os.example");
  assert.match(link.url, /^https:\/\/checkout\.stripe\.com\//);
  const [cus] = fake.creates(/^\/customers$/);
  assert.equal(cus.params.name, "ZZ Usage Test — Acme Realty");
  assert.equal(cus.idempotencyKey, `os-usage:${ACME}:customer`);
  const sess = fake.creates(/^\/checkout\/sessions$/)[0];
  assert.equal(sess.params.success_url, `https://os.example/roster?client=${ACME}&usage_setup=done`);
  // Not finished yet: nothing stored.
  assert.deepEqual(await billing.confirmSetup(ACME, stripe), { saved: false, cardLabel: null, status: "open" });
  fake.completeSetup(link.sessionId);
  const r = await billing.confirmSetup(ACME, stripe);
  assert.equal(r.saved, true);
  assert.equal(r.cardLabel, "Visa •••• 4242");
  const s = await settingsOf();
  assert.match(s.default_payment_method_id ?? "", /^pm_/);
  const c = fake.customers.get(s.stripe_customer_id!)!;
  assert.equal((c.invoice_settings as Row).default_payment_method, s.default_payment_method_id, "the customer's default card");
  // A second link reuses the customer.
  await billing.createSetupLink(ACME, stripe, "https://os.example");
  assert.equal(fake.customers.size, 1);
});

/* --------------------------------------------------------------- charging --- */

test("a TEST charge: claimed, one line per lead, checked, finalized and paid — then never again", async () => {
  seed();
  await withCard();
  const r = await billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW });
  assert.equal(r.outcome, "paid");
  assert.equal(r.invoice?.total, 30_000);
  assert.equal(fake.invoices.size, 1);
  const inv = [...fake.invoices.values()][0];
  assert.equal(inv.lines.length, 3);
  assert.equal(inv.status, "paid");
  assert.equal(inv.collection_method, "charge_automatically");
  // Every create / finalize / pay carried its key.
  for (const c of fake.calls.filter((c) => c.method === "POST")) assert.match(c.idempotencyKey ?? "", new RegExp(`^${PK}:`), c.path);
  const [row] = rowsOf();
  assert.equal(row.status, "paid");
  assert.equal(row.lead_count, 3);
  assert.equal(row.amount_cents, 30_000);
  assert.equal(row.stripe_invoice_id, inv.id);
  assert.equal(row.claimed_by, ADMIN);
  assert.equal((row.leads as unknown[]).length, 3);

  const before = fake.calls.length;
  const again = await billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW });
  assert.equal(again.outcome, "already");
  assert.equal(fake.calls.length, before, "Stripe is not asked again");
  assert.equal(fake.invoices.size, 1);
  assert.deepEqual(db.blocked, []);
});

test("two at the same moment (two servers, a double click): one invoice, one charge", async () => {
  seed();
  await withCard();
  const [a, b] = await Promise.all([
    billing.chargePeriod(ACME, { stripe, by: "server-1", now: NOW }),
    billing.chargePeriod(ACME, { stripe, by: "server-2", now: NOW }),
  ]);
  assert.deepEqual([a.outcome, b.outcome].sort(), ["in_progress", "paid"]);
  assert.equal(fake.creates(/^\/invoices$/).length, 1);
  assert.equal(fake.creates(/\/pay$/).length, 1);
  assert.equal(rowsOf().length, 1);
});

test("a claim that died half way is resumed once stale: the period's invoice is found, only missing lines added, then charged", async () => {
  seed();
  const { customerId, pm } = await withCard();
  const leads = [
    { key: "jordan@coastal.test", name: "Jordan Ellis", at: "2026-10-06T14:00:00.000Z", source: "handoff" },
    { key: "sam@harbor.test", name: "Sam Lee", at: "2026-10-07T18:30:00.000Z", source: "handoff" },
  ];
  // The first attempt made the invoice and one line, then the process died before saving the invoice id.
  const { invoiceId } = await stripe.createDraftInvoice({ customerId, paymentMethodId: pm, osClientId: ACME, period: WEEK, periodKey: PK, description: "x", leadCount: 2 });
  await stripe.addLeadLine({ customerId, invoiceId, periodKey: PK, lead: leads[0], priceCents: 10_000 });
  fake.forgetIdempotencyKeys(); // a day later
  const claimedAt = new Date(NOW.getTime() - 60 * 60_000).toISOString();
  db.seed("os_usage_billing_periods", [{ os_client_id: ACME, period_start: WEEK.start, period_end: WEEK.end, test_mode: true, status: "draft", leads, lead_count: 2, price_cents: 10_000, amount_cents: 20_000, lead_source: "handoffs", claimed_by: "server-1", claimed_at: claimedAt, stripe_invoice_id: null }]);
  fake.calls.length = 0;

  // Not yet stale: left alone, Stripe not asked.
  const early = await billing.chargePeriod(ACME, { stripe, by: "server-2", now: new Date(Date.parse(claimedAt) + 60_000) });
  assert.equal(early.outcome, "in_progress");
  assert.deepEqual(fake.calls, []);

  const r = await billing.chargePeriod(ACME, { stripe, by: "server-2", now: NOW });
  assert.equal(r.outcome, "paid");
  assert.equal(fake.invoices.size, 1, "no second invoice");
  assert.equal(fake.creates(/^\/invoices$/).length, 0);
  assert.equal(fake.creates(/^\/invoiceitems$/).length, 1, "only Sam's line was missing");
  assert.equal(fake.invoices.get(invoiceId)!.lines.length, 2);
  assert.equal(rowsOf()[0].status, "paid");
  assert.equal(rowsOf()[0].stripe_invoice_id, invoiceId);
  assert.equal(rowsOf()[0].claimed_by, "server-2");
});

test("an invoice that does not match what was previewed is not charged", async () => {
  seed();
  const { customerId, pm } = await withCard();
  const leads = [{ key: "jordan@coastal.test", name: "Jordan Ellis", at: "2026-10-06T14:00:00.000Z", source: "handoff" }];
  const { invoiceId } = await stripe.createDraftInvoice({ customerId, paymentMethodId: pm, osClientId: ACME, period: WEEK, periodKey: PK, description: "x", leadCount: 1 });
  await stripe.addLeadLine({ customerId, invoiceId, periodKey: PK, lead: leads[0], priceCents: 10_000 });
  await stripe.addLeadLine({ customerId, invoiceId, periodKey: PK, lead: { ...leads[0], key: "stray@x.test", name: "Stray" }, priceCents: 10_000 });
  db.seed("os_usage_billing_periods", [{ os_client_id: ACME, period_start: WEEK.start, period_end: WEEK.end, test_mode: true, status: "draft", leads, lead_count: 1, price_cents: 10_000, amount_cents: 10_000, lead_source: "handoffs", claimed_at: "2026-10-13T00:00:00.000Z", stripe_invoice_id: invoiceId }]);
  fake.calls.length = 0;
  const r = await billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW });
  assert.equal(r.outcome, "failed");
  assert.match(r.message, /does not match/);
  assert.equal(fake.creates(/\/finalize$|\/pay$/).length, 0);
  assert.equal(fake.invoices.get(invoiceId)!.status, "draft");
  assert.equal(rowsOf()[0].status, "failed");
});

test("a refused card: the period is 'failed', the invoice open with its pay link; paid later by the link, a refresh records it", async () => {
  seed();
  await withCard();
  fake.declineNextPay = true;
  const r = await billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW });
  assert.equal(r.outcome, "failed");
  assert.match(r.message, /declined/);
  const [row] = rowsOf();
  assert.equal(row.status, "failed");
  assert.match(String(row.hosted_invoice_url), /^https:\/\/invoice\.stripe\.com\//);
  assert.equal(r.invoice?.payUrl, row.hosted_invoice_url);
  // Its leads count as billed: next week does not bill them again.
  assert.equal((await billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW })).outcome, "already");
  fake.payByLink(String(row.stripe_invoice_id));
  const after = await billing.refreshPeriod(ACME, WEEK.start, stripe);
  assert.equal(after?.status, "paid");
});

test("no billable leads: the period is closed with nothing charged and Stripe is not asked", async () => {
  seed();
  await withCard();
  db.seed("label_assignments", []);
  const r = await billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW });
  assert.equal(r.outcome, "nothing");
  assert.equal(rowsOf()[0].status, "void");
  assert.deepEqual(fake.calls, []);
});

test("fake leads (the test path) bill exactly what was typed, in the period", async () => {
  seed();
  await withCard();
  const r = await billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW, fakeLeads: "Test Lead One, 2026-10-06\nTest Lead Two, 2026-10-07" });
  assert.equal(r.outcome, "paid");
  assert.deepEqual([...fake.invoices.values()][0].lines.map((l) => l.description), ["Lead: Test Lead One — Oct 6, 2026", "Lead: Test Lead Two — Oct 7, 2026"]);
  assert.equal(rowsOf()[0].lead_source, "test");
});

test("a live client is never billed with the TEST Stripe nor given the test tools; no settings, nothing — before Stripe is asked", async () => {
  seed({ acmeSettings: { test_only: false } });
  await withCard();
  await assert.rejects(billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW, approved: { periodStart: WEEK.start, count: 3, amountCents: 30_000 } }), (e: unknown) => e instanceof billing.UsageBillingError && e.status === 500 && /This client is live; refused to use test Stripe/.test(e.message));
  await assert.rejects(billing.refreshPeriod(ACME, WEEK.start, stripe), /This client is live; refused to use test Stripe/);
  await assert.rejects(billing.createSetupLink(ACME, stripe, "https://os.example"), /live — the test tools are for test clients only/);
  seed({ acmeSettings: null });
  await assert.rejects(billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW }), /no pay-per-lead settings/);
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(rowsOf(), []);
});

test("no saved card: refused before Stripe is asked", async () => {
  seed();
  await assert.rejects(billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW }), /No card is saved/);
  assert.deepEqual(fake.calls, []);
});

test("a period that has not started, or does not begin on the schedule, is refused", async () => {
  seed();
  await withCard();
  await assert.rejects(billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW, periodStart: "2026-10-19" }), /not started/);
  await assert.rejects(billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW, periodStart: "2026-10-06" }), /does not begin a billing period/);
  assert.deepEqual(fake.calls, []);
});

/* ---------------------------------------------------------- scheduled run --- */

const RAILWAY = { MASTER_INBOX_SUPABASE_URL: "http://supabase.test", RAILWAY_ENVIRONMENT_NAME: "production" };

test("the scheduled run does nothing without OS_USAGE_BILLING_ENABLED=1 on Railway", async () => {
  seed();
  await withCard();
  for (const env of [{}, { ...RAILWAY }, { OS_USAGE_BILLING_ENABLED: "1", OS_USAGE_BILLING_CHARGE: "1", MASTER_INBOX_SUPABASE_URL: "x" }]) {
    const r = await billing.runUsageBilling({ env, now: NOW, stripe });
    assert.ok(r.off, JSON.stringify(env));
  }
  assert.deepEqual(db.calls, []);
  assert.deepEqual(fake.calls, []);
});

test("enabled without OS_USAGE_BILLING_CHARGE: it records previews and charges nothing", async () => {
  seed({ betaSettings: {} });
  await withCard();
  const r = await billing.runUsageBilling({ env: { ...RAILWAY, OS_USAGE_BILLING_ENABLED: "1" }, now: NOW, stripe });
  assert.equal(r.previews, 2);
  assert.equal(r.charged, 0);
  assert.deepEqual(fake.calls, []);
  const acme = rowsOf().find((x) => x.os_client_id === ACME)!;
  assert.equal(acme.status, "preview");
  assert.equal(acme.lead_count, 3);
  assert.equal(acme.amount_cents, 30_000);
  // Still billable afterwards: a preview claims nothing.
  assert.equal((await billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW })).outcome, "paid");
});

test("with OS_USAGE_BILLING_CHARGE=1: a TEST client is charged once; a LIVE client is only previewed — a live period, never charged by the run", async () => {
  seed({ betaSettings: { stripe_customer_id: "cus_beta", default_payment_method_id: "pm_beta" } });
  await withCard();
  const env = { ...RAILWAY, OS_USAGE_BILLING_ENABLED: "1", OS_USAGE_BILLING_CHARGE: "1" };
  const r = await billing.runUsageBilling({ env, now: NOW, stripe });
  assert.deepEqual(r.errors, []);
  assert.equal(r.charged, 1);
  assert.equal(r.previews, 1);
  assert.equal(rowsOf().find((x) => x.os_client_id === ACME)!.status, "paid");
  const beta = rowsOf().find((x) => x.os_client_id === BETA)!;
  assert.equal(beta.status, "preview");
  assert.equal(beta.test_mode, false, "Beta is live: its preview is a live period");
  assert.ok(fake.calls.every((c) => c.params.customer !== "cus_beta" && !c.path.includes("cus_beta")), "Beta never reaches Stripe");
  const calls = fake.calls.length;
  const again = await billing.runUsageBilling({ env, now: NOW, stripe });
  assert.equal(again.charged, 0);
  assert.equal(fake.creates(/^\/invoices$/).length, 1, "the next run bills nothing twice");
  assert.ok(fake.calls.length >= calls);
});

test("the scheduled run without a usable TEST key charges nothing (and says why)", async () => {
  seed();
  await withCard();
  const r = await billing.runUsageBilling({ env: { ...RAILWAY, OS_USAGE_BILLING_ENABLED: "1", OS_USAGE_BILLING_CHARGE: "1", OS_USAGE_BILLING_STRIPE_KEY: "sk_live_51FakeFakeFakeFake" }, now: NOW });
  assert.equal(r.charged, 0);
  assert.equal(r.previews, 1);
  assert.match(r.errors.join(" "), /not a Stripe TEST key/);
  assert.deepEqual(db.blocked, [], "no request to Stripe was even attempted");
});

test("retry: the claim is conditional — a retry that read 'failed' just before someone else claimed it is told someone is retrying, and never pays", async () => {
  seed();
  await withCard();
  fake.declineNextPay = true;
  await billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW });
  assert.equal(rowsOf()[0].status, "failed");
  // While this retry asks Stripe about the invoice — after it read the row, before it claims it — someone else claims it.
  fake.failWhen = (c) => {
    if (c.method === "GET" && /^\/invoices\/[^/]+$/.test(c.path)) { rowsOf()[0].status = "charged"; fake.failWhen = null; }
    return false;
  };
  await assert.rejects(billing.retryPeriod(ACME, WEEK.start, stripe, ADMIN), /Someone is retrying/);
  assert.equal(fake.creates(/\/pay$/).length, 1, "only the first charge asked Stripe to pay — the retry never did");
});
