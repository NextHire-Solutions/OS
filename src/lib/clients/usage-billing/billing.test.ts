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
 *     charges a live client only with a third, when every lead was delivered;
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
const { isReopened, periodKey, leadsHash } = await import("./model.ts");

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
    { id: BOSTON, name: "Acme Boston", slug: "acme-boston", aliases: [], feature_flags: { manage_stages: true }, stage_label_overrides: {} },
    { id: FLORIDA, name: "Acme Florida", slug: "acme-florida", aliases: [], feature_flags: { manage_stages: true }, stage_label_overrides: {} },
    { id: LIVE, name: "Beta Homes", slug: "beta-homes", aliases: [], feature_flags: { manage_stages: true }, stage_label_overrides: {} },
  ]);
  db.seed("client_pipeline_stages", []);
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
  // The label history (Master Inbox 0080) — what the Interested count reads: here, every label as given above.
  const threadOf = new Map(db.rows("threads").map((t) => [t.id, t]));
  db.seed("label_history", db.rows("label_assignments").map((a, i) => ({
    id: i + 1, thread_id: a.target_id, label_id: a.label_id, label_name: a.label_id === "lab-int" ? "Interested" : "Meetings Booked",
    assigned_at: a.assigned_at, client_id: threadOf.get(a.target_id)?.client_id ?? null, lead_id: threadOf.get(a.target_id)?.lead_id ?? null, source: "trigger",
  })));
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
  const ANCHOR = "2026-10-19"; // per lead starts on or after 14 Oct (Interested replies on record)
  const s = await billing.saveSettings(ACME, { priceCents: 20_000, everyDays: 14, anchorDate: ANCHOR, leadSource: "handoffs", enabled: false }, ADMIN);
  assert.equal(s.test_only, true);
  assert.equal(s.price_cents, 20_000);
  assert.equal(s.created_by, ADMIN);
  db.calls.length = 0;
  db.rows("os_usage_billing_settings")[0].test_only = false; // live, as connectCard leaves it
  // Live but never billed: a schedule set wrongly can still be put right.
  await billing.saveSettings(ACME, { priceCents: 20_000, everyDays: 7, anchorDate: ANCHOR, leadSource: "handoffs", enabled: false }, ADMIN);
  assert.equal(db.rows("os_usage_billing_settings")[0].every_days, 7);
  // Once a live period is billed, its schedule and what counts are fixed (they would move billed periods) — refused, nothing written.
  db.seed("os_usage_billing_periods", [{ os_client_id: ACME, period_start: ANCHOR, period_end: "2026-10-26", test_mode: false, status: "paid", leads: [], lead_count: 1, price_cents: 20_000, amount_cents: 20_000, lead_source: "handoffs" }]);
  db.calls.length = 0;
  await assert.rejects(billing.saveSettings(ACME, { priceCents: 10_000, everyDays: 14, anchorDate: ANCHOR, leadSource: "introductions", enabled: true }, ADMIN), (e: unknown) => e instanceof billing.UsageBillingError && e.status === 409 && /live and has been billed/.test(e.message));
  assert.deepEqual(writes(), []);
  // Its price and switch can change — and saving never touches test_only.
  await billing.saveSettings(ACME, { priceCents: 25_000, everyDays: 7, anchorDate: ANCHOR, leadSource: "handoffs", enabled: true }, ADMIN);
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
  db.seed("label_history", []);
  db.seed("label_assignments", db.rows("label_assignments").filter((a) => a.label_id !== "lab-int"));
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

/* ------------------------------ on pay per lead: the Interested column (4 Nov) --- */

const stageRows = (portal: string) => db.rows("client_pipeline_stages").filter((r) => r.client_id === portal);
const FORM = { priceCents: 25_000, everyDays: 14 as const, anchorDate: "2026-10-28", leadSource: "handoffs" as const, enabled: false };

test("turning pay per lead on: every portal of that client gets the Interested column, and no one else's changes", async () => {
  seed({ acmeSettings: null });
  await billing.saveSettings(ACME, FORM, ADMIN);
  for (const portal of [BOSTON, FLORIDA]) {
    const rows = stageRows(portal).sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
    assert.equal(rows[0].key, "custom_interested");
    assert.equal(rows[0].label, "Interested");
    assert.equal(rows[0].hidden, false);
    assert.equal(rows[1].key, "introduction");
    assert.equal(rows.filter((r) => r.kind === "canonical").length, 9, "its other stages come with it: any row replaces the defaults");
  }
  assert.deepEqual(stageRows(LIVE), [], "Beta isn't on pay per lead");
});

test("saving again adds nothing, and a column the client renamed or moved stays as it is", async () => {
  seed({ acmeSettings: null });
  await billing.saveSettings(ACME, FORM, ADMIN);
  const column = stageRows(BOSTON).find((r) => r.key === "custom_interested") as Row;
  column.label = "Hot Leads";
  const count = db.rows("client_pipeline_stages").length;
  db.calls.length = 0;
  await billing.saveSettings(ACME, { ...FORM, priceCents: 30_000 }, ADMIN);
  assert.equal(db.rows("client_pipeline_stages").length, count);
  assert.equal(column.label, "Hot Leads");
  assert.equal(db.writes("client_pipeline_stages", "POST").length, 0);
});

test("the column failing doesn't undo the save; the hourly run puts it right, for a test client not in the run too", async () => {
  seed({ acmeSettings: null });
  db.failWhen = (c) => c.table === "client_pipeline_stages";
  const saved = await billing.saveSettings(ACME, FORM, ADMIN);
  db.failWhen = null;
  assert.equal(saved.price_cents, 25_000);
  assert.deepEqual(stageRows(BOSTON), []);
  const r = await billing.runUsageBilling({ env: { ...RAILWAY, OS_USAGE_BILLING_ENABLED: "1" }, now: NOW, stripe });
  assert.deepEqual(r.errors, []);
  assert.equal(r.clients, 0, "not in the scheduled run");
  assert.ok(stageRows(BOSTON).some((r2) => r2.key === "custom_interested"));
  assert.ok(stageRows(FLORIDA).some((r2) => r2.key === "custom_interested"));
  assert.deepEqual(stageRows(LIVE), []);
});

test("a market added later gets the column on the next run; the portals that have it aren't written to", async () => {
  seed({ acmeSettings: null });
  await billing.saveSettings(ACME, FORM, ADMIN);
  db.seed("client_pipeline_stages", db.rows("client_pipeline_stages").filter((r) => r.client_id !== FLORIDA));
  db.calls.length = 0;
  await billing.runUsageBilling({ env: { ...RAILWAY, OS_USAGE_BILLING_ENABLED: "1" }, now: NOW, stripe });
  assert.ok(stageRows(FLORIDA).some((r) => r.key === "custom_interested"));
  const writes = db.writes("client_pipeline_stages", "POST");
  assert.equal(writes.length, 1, "Florida only");
});

test("hidden or removed from the old portal: the next run brings it back, and a rename stays", async () => {
  seed({ acmeSettings: null });
  await billing.saveSettings(ACME, FORM, ADMIN);
  const column = stageRows(BOSTON).find((r) => r.key === "custom_interested") as Row;
  Object.assign(column, { hidden: true, label: "Hot Leads" });
  db.seed("client_pipeline_stages", db.rows("client_pipeline_stages").filter((r) => !(r.client_id === FLORIDA && r.key === "custom_interested")));
  const r = await billing.runUsageBilling({ env: { ...RAILWAY, OS_USAGE_BILLING_ENABLED: "1" }, now: NOW, stripe });
  assert.deepEqual(r.errors, []);
  const back = stageRows(BOSTON).find((x) => x.key === "custom_interested")!;
  assert.deepEqual([back.hidden, back.label], [false, "Hot Leads"]);
  assert.equal(stageRows(FLORIDA).find((x) => x.key === "custom_interested")?.hidden, false);
});

test("one portal failing doesn't starve the client's other portals, and the bell says so once a day", async () => {
  seed({ acmeSettings: null });
  db.seed("os_notifications", []);
  db.seed("os_usage_billing_settings", [{ os_client_id: ACME, enabled: false, test_only: true, price_cents: 10_000, every_days: 7, anchor_date: ANCHOR, lead_source: "handoffs" }]);
  (db.rows("clients").find((c) => c.id === BOSTON) as Row).feature_flags = {};
  const env = { ...RAILWAY, OS_USAGE_BILLING_ENABLED: "1" };
  const r = await billing.runUsageBilling({ env, now: NOW, stripe });
  await billing.runUsageBilling({ env, now: NOW, stripe });
  assert.match(r.errors.join(" "), /manage_stages off/);
  assert.deepEqual(stageRows(BOSTON), []);
  assert.ok(stageRows(FLORIDA).some((x) => x.key === "custom_interested"), "Acme's other portal still got it");
  assert.equal(db.rows("os_notifications").filter((n) => n.kind === "usage_column_error").length, 1);
});

test("the run off: no column written; a portal without manage_stages is told, not half-done, and the other clients still run", async () => {
  seed({ acmeSettings: null });
  db.seed("os_usage_billing_settings", [{ os_client_id: ACME, enabled: false, test_only: true, price_cents: 10_000, every_days: 7, anchor_date: ANCHOR, lead_source: "handoffs" }, { os_client_id: BETA, enabled: false, test_only: true, price_cents: 10_000, every_days: 7, anchor_date: ANCHOR, lead_source: "handoffs" }]);
  await billing.runUsageBilling({ env: {}, now: NOW, stripe });
  assert.deepEqual(db.rows("client_pipeline_stages"), []);
  (db.rows("clients").find((c) => c.id === BOSTON) as Row).feature_flags = {};
  const r = await billing.runUsageBilling({ env: { ...RAILWAY, OS_USAGE_BILLING_ENABLED: "1" }, now: NOW, stripe });
  assert.match(r.errors.join(" "), /manage_stages off/);
  assert.deepEqual(stageRows(BOSTON), []);
  assert.ok(stageRows(LIVE).some((x) => x.key === "custom_interested"), "Beta, the next client, still got its column");
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

/* ------------------------------- a LIVE client, charged by the run (4 Nov) --- */

const liveFake = new FakeStripe({ live: true });
const liveStripe = usageStripe("sk_live_51FakeFakeFakeFake", liveFake.fetch as typeof fetch, "live");
const LIVE_ENV = { ...RAILWAY, OS_USAGE_BILLING_ENABLED: "1", OS_USAGE_BILLING_LIVE_AUTO: "1" };
const liveRun = (o: { env?: Record<string, string>; now?: Date } = {}) => billing.runUsageBilling({ env: o.env ?? LIVE_ENV, now: o.now ?? NOW, stripe, liveStripe: () => liveStripe });

/** Beta is live, in the scheduled run, with its real card; one lead (ti-beta) in the ended week. Acme, the test client, is out of it. */
function seedLive(o: { settings?: Row; delivered?: Row | null } = {}) {
  liveFake.reset();
  const card = liveFake.addCustomerWithCard({ name: "Beta Homes" });
  seed({ acmeSettings: { enabled: false }, betaSettings: { stripe_customer_id: card.customerId, default_payment_method_id: card.paymentMethodId, card_label: "Visa •••• 4242", ...o.settings } });
  db.seed("os_notifications", []);
  if (o.delivered !== null) db.rows("os_brokerage_relays").push({ workspace_id: "w", kind: "handoff", status: "sent", practice: false, os_client_id: BETA, thread_id: "ti-beta", agent_email: "Beta@X.test", agent_name: "Beta's", ...o.delivered });
  fake.calls.length = 0;
  db.calls.length = 0;
  return card;
}
const betaRow = () => rowsOf().find((x) => x.os_client_id === BETA);
const bell = (kind?: string) => db.rows("os_notifications").filter((n) => !kind || n.kind === kind);
const livePays = () => liveFake.creates(/\/pay$/).length;

test("a live client whose lead reached its inbox is charged by the run, once, on its own card and in live Stripe", async () => {
  seedLive();
  const r = await liveRun();
  assert.deepEqual(r.errors, []);
  assert.equal(r.charged, 1);
  const row = betaRow()!;
  assert.equal(row.status, "paid");
  assert.equal(row.test_mode, false);
  assert.equal(row.lead_count, 1);
  assert.equal(row.amount_cents, 10_000);
  assert.equal(row.claimed_by, "automatic run");
  assert.equal(livePays(), 1);
  assert.deepEqual(fake.calls, [], "test Stripe is never touched");
  assert.equal(bell("usage_charged").length, 1);
  assert.match(String(bell("usage_charged")[0].title), /Beta Homes paid \$100/);
  const again = await liveRun();
  assert.equal(again.charged, 0);
  assert.equal(livePays(), 1, "the next hour charges nothing");
  assert.equal(liveFake.creates(/^\/invoices$/).length, 1);
  assert.equal(bell().length, 1, "and says nothing new");
});

test("two runs at the same moment charge once", async () => {
  seedLive();
  await Promise.all([liveRun(), liveRun()]);
  assert.equal(betaRow()!.status, "paid");
  assert.equal(livePays(), 1);
  assert.equal(liveFake.creates(/^\/invoices$/).length, 1);
  assert.equal(bell("usage_charged").length, 1);
});

test("without OS_USAGE_BILLING_LIVE_AUTO=1 a live client is only previewed, whoever hands the run live Stripe", async () => {
  seedLive();
  for (const env of [{ ...RAILWAY, OS_USAGE_BILLING_ENABLED: "1" }, { ...RAILWAY, OS_USAGE_BILLING_ENABLED: "1", OS_USAGE_BILLING_CHARGE: "1" }]) {
    const r = await liveRun({ env });
    assert.equal(r.charged, 0);
  }
  assert.equal(betaRow()!.status, "preview");
  assert.deepEqual(liveFake.calls, []);
  assert.deepEqual(bell(), []);
});

test("a live client not in the scheduled run is left alone; the off switch stops it the next hour", async () => {
  seedLive({ settings: { enabled: false } });
  const r = await liveRun();
  assert.equal(r.clients, 0);
  assert.deepEqual(liveFake.calls, []);
  assert.equal(betaRow(), undefined);
});

test("not before 9am Eastern: at 8:30 nothing is written or charged, at 9:00 it goes", async () => {
  seedLive();
  const early = await liveRun({ now: new Date("2026-10-14T12:30:00.000Z") });
  assert.equal(early.charged, 0);
  assert.equal(betaRow(), undefined);
  assert.deepEqual(liveFake.calls, []);
  const nine = await liveRun({ now: new Date("2026-10-14T13:00:00.000Z") });
  assert.equal(nine.charged, 1);
  assert.equal(betaRow()!.status, "paid");
});

for (const [name, delivered] of [
  ["no hand-off at all", null],
  ["a hand-off that bounced", { status: "bounced" }],
  ["a practice hand-off", { practice: true }],
  ["one still waiting for a press", { status: "ready" }],
  ["a hand-off skipped by the rules", { status: "skipped" }],
  ["another client's hand-off", { os_client_id: ACME }],
] as Array<[string, Row | null]>) {
  test(`held, never charged, when the lead has ${name}: the bell says so once, and a person can still charge it`, async () => {
    seedLive({ delivered });
    const r = await liveRun();
    assert.deepEqual(r.errors, []);
    assert.equal(r.held, 1);
    assert.equal(r.charged, 0);
    const row = betaRow()!;
    assert.equal(row.status, "preview");
    assert.match(String(row.note), /Not charged automatically.*no delivery to the client's inbox/);
    assert.deepEqual(liveFake.creates(/./), [], "nothing was created in Stripe");
    assert.equal(bell("usage_charge_held").length, 1);
    await liveRun();
    assert.equal(bell("usage_charge_held").length, 1, "once, not every hour");
    assert.deepEqual(liveFake.creates(/./), []);
    const p = await billing.previewPeriod(BETA, (await billing.loadSettings(BETA))!, { periodStart: WEEK.start, now: NOW });
    const byHand = await billing.chargePeriod(BETA, { stripe: liveStripe, by: ADMIN, periodStart: WEEK.start, now: NOW, approved: { periodStart: WEEK.start, count: p.count, amountCents: p.amountCents, mode: "live", paymentMethodId: (await billing.loadSettings(BETA))!.default_payment_method_id ?? undefined, leadsHash: p.leadsHash } });
    assert.equal(byHand.outcome, "paid");
    assert.equal(livePays(), 1);
  });
}

test("a delivery by the agent's address (another conversation of theirs) counts; once a held lead is delivered the next hour charges it", async () => {
  seedLive({ delivered: { thread_id: "another-conversation" } });
  assert.equal((await liveRun()).charged, 1, "same agent, other conversation");
  seedLive({ delivered: null });
  assert.equal((await liveRun()).held, 1);
  db.rows("os_brokerage_relays").push({ workspace_id: "w", kind: "handoff", status: "sent", practice: false, os_client_id: BETA, thread_id: "ti-beta", agent_email: "someone-else@x.test" });
  assert.equal((await liveRun()).charged, 1, "same conversation, reply from another address");
  assert.equal(livePays(), 1);
});

test("no limit on the leads or the amount of an automatic charge (the user, 4 Nov): 30 delivered leads at $250 go, $7,500 at once", async () => {
  seedLive({ settings: { price_cents: 25_000 } });
  for (let i = 1; i <= 29; i++) {
    addInterested({ thread: `many-${i}`, lead: `l-many-${i}`, email: `many${i}@x.test`, name: `Agent ${i}`, at: "2026-10-07T12:00:00.000Z", portal: LIVE });
    db.rows("os_brokerage_relays").push({ workspace_id: "w", kind: "handoff", status: "sent", practice: false, os_client_id: BETA, thread_id: `many-${i}`, agent_email: `many${i}@x.test` });
  }
  const r = await liveRun();
  assert.deepEqual(r.errors, []);
  assert.equal(r.held, 0);
  assert.equal(r.charged, 1);
  assert.equal(betaRow()!.status, "paid");
  assert.equal(betaRow()!.lead_count, 30);
  assert.equal(betaRow()!.amount_cents, 750_000);
  assert.equal(livePays(), 1);
});

test("Stripe's own ceiling, 250 lines on an invoice: nothing is half-built, and the bell says why", async () => {
  seedLive({ settings: { price_cents: 25_000 } });
  for (let i = 1; i <= 250; i++) {
    addInterested({ thread: `many-${i}`, lead: `l-many-${i}`, email: `many${i}@x.test`, name: `Agent ${i}`, at: "2026-10-07T12:00:00.000Z", portal: LIVE });
    db.rows("os_brokerage_relays").push({ workspace_id: "w", kind: "handoff", status: "sent", practice: false, os_client_id: BETA, thread_id: `many-${i}`, agent_email: `many${i}@x.test` });
  }
  const r = await liveRun();
  assert.equal(r.charged, 0);
  assert.deepEqual(liveFake.creates(/./), []);
  assert.equal(bell("usage_charge_error").length, 1);
  assert.match(String(bell("usage_charge_error")[0].body), /more than the 250 allowed/);
});

test("held when the client isn't active, or isn't billed on Interested replies", async () => {
  seedLive();
  (db.rows("os_clients").find((c) => c.id === BETA) as Row).status = "churned";
  assert.equal((await liveRun()).held, 1);
  assert.match(String(bell("usage_charge_held")[0].body), /the client is churned/);
  assert.deepEqual(liveFake.creates(/./), []);
  seedLive({ settings: { lead_source: "calls" } });
  assert.equal((await liveRun()).held, 1);
  assert.match(String(betaRow()!.note), /only Interested replies/);
  assert.deepEqual(liveFake.creates(/./), []);
});

test("a refused card: one try, the invoice stays open, a critical bell once, and no second charge by itself", async () => {
  seedLive();
  liveFake.declineNextPay = true;
  const r = await liveRun();
  assert.equal(r.refused, 1);
  assert.equal(r.charged, 0);
  assert.equal(betaRow()!.status, "failed");
  assert.equal(bell("usage_charge_failed").length, 1);
  assert.equal(bell("usage_charge_failed")[0].severity, "critical");
  assert.match(String(bell("usage_charge_failed")[0].body), /press Retry/);
  const pays = livePays();
  const again = await liveRun();
  assert.equal(again.charged, 0);
  assert.equal(livePays(), pays, "never tried again by itself");
  assert.equal(bell("usage_charge_failed").length, 1);
});

test("a period with no leads is left open, not closed for good: nothing to Stripe, nothing on the bell, and a lead put right charges next hour", async () => {
  seedLive();
  const history = db.rows("label_history").filter((h) => h.thread_id === "ti-beta");
  const labelled = db.rows("label_assignments").filter((a) => a.target_id === "ti-beta");
  db.seed("label_history", db.rows("label_history").filter((h) => h.thread_id !== "ti-beta"));
  db.seed("label_assignments", db.rows("label_assignments").filter((a) => a.target_id !== "ti-beta"));
  const r = await liveRun();
  assert.deepEqual(r.errors, []);
  assert.equal(betaRow()!.status, "preview");
  assert.match(String(betaRow()!.note), /No leads/);
  assert.deepEqual(liveFake.creates(/./), []);
  assert.deepEqual(bell(), []);
  db.rows("label_history").push(...history);
  db.rows("label_assignments").push(...labelled);
  assert.equal((await liveRun()).charged, 1);
  assert.equal(betaRow()!.status, "paid");
});

test("no usable live key: nothing is charged, the period is previewed, and the bell says so once a day", async () => {
  for (const make of [() => { throw new Error("That is not a live Stripe key"); }, () => stripe]) {
    seedLive();
    const r = await billing.runUsageBilling({ env: LIVE_ENV, now: NOW, stripe, liveStripe: make as () => typeof liveStripe });
    await billing.runUsageBilling({ env: LIVE_ENV, now: NOW, stripe, liveStripe: make as () => typeof liveStripe });
    assert.match(r.errors.join(" "), /live charging off/);
    assert.equal(r.charged, 0);
    assert.equal(betaRow()!.status, "preview");
    assert.deepEqual(liveFake.calls, []);
    assert.deepEqual(fake.calls, []);
    assert.equal(bell("usage_auto_off").length, 1);
  }
});

test("a test client is never charged with live Stripe, and stays a preview without the test switch", async () => {
  liveFake.reset();
  seed();
  await withCard();
  db.seed("os_notifications", []);
  const r = await liveRun();
  assert.equal(r.charged, 0);
  assert.equal(rowsOf().find((x) => x.os_client_id === ACME)!.status, "preview");
  assert.deepEqual(liveFake.calls, []);
  assert.deepEqual(fake.calls, []);
});

test("a charge that died half way is never finished unattended: a person is told, and nothing reaches Stripe", async () => {
  const card = seedLive();
  db.rows("os_usage_billing_periods").push({ id: "d1", os_client_id: BETA, period_start: WEEK.start, period_end: WEEK.end, test_mode: false, status: "draft", claimed_by: "automatic run", claimed_at: "2026-10-14T01:00:00.000Z", leads: [], lead_count: 1, amount_cents: 10_000, price_cents: 10_000, lead_source: "handoffs" });
  const r = await liveRun();
  assert.equal(r.charged, 0);
  assert.equal(r.skipped, 1);
  assert.equal(bell("usage_charge_stuck").length, 1);
  assert.deepEqual(liveFake.creates(/./), []);
  assert.ok(card.customerId);
});

test("the Billing tab's switch writes only the switch: on, off, and a page left open from before is told", async () => {
  seedLive({ settings: { enabled: false } });
  const before = (await billing.loadSettings(BETA))!;
  assert.equal((await billing.setAutoCharge(BETA, true, ADMIN)).enabled, true);
  assert.equal((await liveRun()).charged, 1);
  const off = await billing.setAutoCharge(BETA, false, ADMIN);
  assert.equal(off.enabled, false);
  assert.equal(off.test_only, false, "still live");
  for (const k of ["price_cents", "every_days", "anchor_date", "lead_source", "stripe_customer_id", "default_payment_method_id"] as const) assert.equal(off[k], before[k], k);
  await assert.rejects(billing.setAutoCharge(BETA, false, ADMIN), /changed since you looked/);
  assert.equal((await billing.loadSettings(BETA))!.enabled, false);
  const calls = liveFake.creates(/./).length;
  assert.equal((await liveRun()).clients, 0);
  assert.equal(liveFake.creates(/./).length, calls);
  await assert.rejects(billing.setAutoCharge(ACME, true, ADMIN), /for live clients/);
});

test("a price saved from an older page can't turn automatic back on, or off", async () => {
  seedLive({ settings: { enabled: false } });
  const s = (await billing.loadSettings(BETA))!;
  const form = { priceCents: 15_000, everyDays: s.every_days as 7 | 14, anchorDate: s.anchor_date, leadSource: s.lead_source as "handoffs" };
  const saved = await billing.saveSettings(BETA, { ...form, enabled: true }, ADMIN);
  assert.equal(saved.enabled, false, "Stop stays stopped");
  assert.equal(saved.price_cents, 15_000);
  await billing.setAutoCharge(BETA, true, ADMIN);
  assert.equal((await billing.saveSettings(BETA, { ...form, enabled: false }, ADMIN)).enabled, true, "On stays on");
  // A test client's box still saves.
  assert.equal((await billing.saveSettings(ACME, { ...form, anchorDate: ANCHOR, enabled: false }, ADMIN)).enabled, false);
});

test("going live never carries 'In the scheduled run' into automatic charging", async () => {
  liveFake.reset();
  const card = liveFake.addCustomerWithCard({ name: "Acme Realty" });
  seed();
  db.seed("os_notifications", []);
  assert.equal((await billing.loadSettings(ACME))!.enabled, true);
  const live = await billing.connectCard(ACME, { customerId: card.customerId, paymentMethodId: card.paymentMethodId }, liveStripe, ADMIN);
  assert.equal(live.test_only, false);
  assert.equal(live.enabled, false);
  assert.equal((await liveRun()).clients, 0);
  assert.deepEqual(liveFake.creates(/./), [], "the first run charges nothing");
  // Changing the card later leaves the switch alone.
  await billing.setAutoCharge(ACME, true, ADMIN);
  assert.equal((await billing.connectCard(ACME, { customerId: card.customerId, paymentMethodId: card.paymentMethodId }, liveStripe, ADMIN)).enabled, true);
});

test("turning automatic on never sweeps up old periods: the one in the last two days goes, older ones ring once and wait", async () => {
  seedLive();
  // Oct 28: the week of the lead (Oct 5-12) ended 16 days ago.
  const later = new Date("2026-10-28T15:00:00.000Z");
  const r = await liveRun({ now: later });
  await liveRun({ now: later });
  assert.deepEqual(r.errors, []);
  assert.equal(r.charged, 0);
  assert.deepEqual(liveFake.creates(/./), []);
  assert.equal(bell("usage_charge_missed").length, 1);
  assert.match(String(bell("usage_charge_missed")[0].title), /\$100\.00 from Oct 5/);
  assert.equal(rowsOf().find((x) => x.os_client_id === BETA && x.period_start === WEEK.start), undefined, "no row written for it");
  // Two days after it ended it still goes; three days after it doesn't.
  seedLive();
  assert.equal((await liveRun({ now: new Date("2026-10-15T15:00:00.000Z") })).charged, 0, "Oct 15: 3 days after");
  assert.equal(bell("usage_charge_missed").length, 1);
  seedLive();
  assert.equal((await liveRun({ now: new Date("2026-10-14T15:00:00.000Z") })).charged, 1, "Oct 14: 2 days after");
});

test("a held period that leaves the window rings again, so it can't go quiet", async () => {
  seedLive({ delivered: null });
  assert.equal((await liveRun()).held, 1);
  await liveRun({ now: new Date("2026-10-20T15:00:00.000Z") });
  assert.equal(bell("usage_charge_held").length, 1);
  assert.equal(bell("usage_charge_missed").length, 1);
});

test("a period opened again is a person's: the run doesn't charge it, and a second refusal rings again", async () => {
  seedLive();
  liveFake.declineNextPay = true;
  await liveRun();
  const first = { ...betaRow()! };
  assert.equal(first.status, "failed");
  // The invoice is voided in Stripe; Retry says "opened again ... preview and charge it again".
  const inv = liveFake.invoices.get(String(first.stripe_invoice_id))!;
  Object.assign(inv, { status: "void" });
  const settings = (await billing.loadSettings(BETA))!;
  const reopened = await billing.retryPeriod(BETA, WEEK.start, liveStripe, ADMIN, { amountCents: first.amount_cents as number, mode: "live", paymentMethodId: settings.default_payment_method_id ?? undefined, count: first.lead_count as number, leadsHash: leadsHash(first.leads as Array<{ key: string }>) }, NOW);
  assert.equal(reopened.row?.status, "preview");
  const pays = livePays();
  assert.equal((await liveRun()).charged, 0);
  assert.equal(livePays(), pays, "the run waits for the person");
  assert.equal(liveFake.creates(/^\/invoices$/).length, 1, "no new invoice");
  // The person charges it; refused again: news again.
  const p = await billing.previewPeriod(BETA, settings, { periodStart: WEEK.start, now: NOW });
  liveFake.declineNextPay = true;
  // A minute later: a new claim, so a new invoice (the voided one is never reused).
  await billing.chargePeriod(BETA, { stripe: liveStripe, by: ADMIN, periodStart: WEEK.start, now: new Date(NOW.getTime() + 60_000), approved: { periodStart: WEEK.start, count: p.count, amountCents: p.amountCents, mode: "live", paymentMethodId: settings.default_payment_method_id ?? undefined, leadsHash: p.leadsHash } });
  assert.equal(betaRow()!.status, "failed");
  assert.notEqual(betaRow()!.stripe_invoice_id, first.stripe_invoice_id);
  await liveRun();
  assert.equal(bell("usage_charge_failed").length, 2);
});

test("a recorded preview keeps 'opened again', so turning automatic off and on can't lose it", async () => {
  seedLive();
  db.rows("os_usage_billing_periods").push({ id: "r1", os_client_id: BETA, period_start: WEEK.start, period_end: WEEK.end, test_mode: false, status: "preview", leads: [], lead_count: 0, amount_cents: 0, price_cents: 10_000, lead_source: "handoffs", note: "Its invoice was voided in Stripe (nothing collected) — opened again by admin; preview and charge it again." });
  await liveRun({ env: { ...RAILWAY, OS_USAGE_BILLING_ENABLED: "1" } });
  assert.match(String(betaRow()!.note), /opened again by/);
  assert.equal((await liveRun()).charged, 0);
  assert.deepEqual(liveFake.creates(/./), []);
});

test("the next period waits for a person while an earlier refused charge is unpaid; paid, it goes", async () => {
  seedLive();
  liveFake.declineNextPay = true;
  await liveRun();
  addInterested({ thread: "ti-beta2", lead: "l-beta2", email: "second@x.test", name: "Second Agent", at: "2026-10-14T15:00:00.000Z", portal: LIVE });
  db.rows("os_brokerage_relays").push({ workspace_id: "w", kind: "handoff", status: "sent", practice: false, os_client_id: BETA, thread_id: "ti-beta2", agent_email: "second@x.test" });
  const nextWeek = new Date("2026-10-20T15:00:00.000Z");
  const pays = livePays();
  const r = await liveRun({ now: nextWeek });
  assert.equal(r.held, 1);
  assert.equal(r.charged, 0);
  assert.equal(livePays(), pays);
  assert.match(String(bell("usage_charge_held")[0].body), /earlier charge was refused/);
  liveFake.payByLink(String(rowsOf().find((x) => x.os_client_id === BETA && x.period_start === WEEK.start)!.stripe_invoice_id));
  assert.equal((await liveRun({ now: nextWeek })).charged, 1);
});

test("the refused-card hold: stays when Stripe can't be asked, and doesn't lift after eight newer rows", async () => {
  seedLive();
  liveFake.declineNextPay = true;
  await liveRun();
  const refusedInvoice = String(betaRow()!.stripe_invoice_id);
  addInterested({ thread: "ti-beta2", lead: "l-beta2", email: "second@x.test", name: "Second Agent", at: "2026-10-14T15:00:00.000Z", portal: LIVE });
  db.rows("os_brokerage_relays").push({ workspace_id: "w", kind: "handoff", status: "sent", practice: false, os_client_id: BETA, thread_id: "ti-beta2", agent_email: "second@x.test" });
  const pays = livePays();
  liveFake.failWhen = (c) => c.method === "GET" && c.path === `/invoices/${refusedInvoice}`;
  const r = await liveRun({ now: new Date("2026-10-20T15:00:00.000Z") });
  liveFake.failWhen = null;
  assert.equal(r.charged, 0);
  assert.equal(r.held, 1);
  assert.equal(livePays(), pays);
  // Nine newer preview rows don't push the refused one out of sight.
  for (let i = 1; i <= 9; i++) db.rows("os_usage_billing_periods").push({ id: `n${i}`, os_client_id: BETA, period_start: `2027-01-0${i}`, period_end: `2027-01-1${i}`, test_mode: false, status: "preview", leads: [], lead_count: 0, amount_cents: 0, price_cents: 10_000, lead_source: "handoffs" });
  assert.equal((await liveRun({ now: new Date("2026-10-20T15:00:00.000Z") })).held, 1);
  assert.equal(livePays(), pays);
});

test("an invoice deleted in Stripe opens the period again, and the run stays off it", async () => {
  seedLive();
  const settings = (await billing.loadSettings(BETA))!;
  const p = await billing.previewPeriod(BETA, settings, { periodStart: WEEK.start, now: NOW });
  const approved = { periodStart: WEEK.start, count: p.count, amountCents: p.amountCents, mode: "live" as const, paymentMethodId: settings.default_payment_method_id ?? undefined, leadsHash: p.leadsHash };
  // A person's charge dies half way, leaving its draft; the draft is then deleted in Stripe, and their next press finds it gone.
  liveFake.failWhen = (c) => c.method === "POST" && /\/finalize$/.test(c.path);
  await billing.chargePeriod(BETA, { stripe: liveStripe, by: ADMIN, periodStart: WEEK.start, now: NOW, approved }).catch(() => null);
  liveFake.failWhen = null;
  assert.equal(betaRow()!.status, "draft");
  liveFake.invoices.delete(String(betaRow()!.stripe_invoice_id));
  await billing.chargePeriod(BETA, { stripe: liveStripe, by: ADMIN, periodStart: WEEK.start, now: new Date(NOW.getTime() + 60 * 60_000), approved });
  assert.equal(betaRow()!.status, "preview");
  assert.equal(isReopened(betaRow()!.note as string), true);
  const r = await liveRun({ now: new Date(NOW.getTime() + 2 * 60 * 60_000) });
  assert.equal(r.charged, 0);
  assert.equal(livePays(), 0);
});

test("an agent billed in another period at the same moment: the claim lets go, nothing reaches Stripe, and the run stays off it", async () => {
  seedLive();
  db.failWhen = (c) => {
    if (c.table === "os_usage_billing_periods" && c.method === "PATCH") {
      db.failWhen = null;
      db.rows("os_usage_billing_periods").push({ id: "o1", os_client_id: BETA, period_start: "2026-09-28", period_end: "2026-10-05", test_mode: false, status: "paid", leads: [{ key: "beta@x.test", name: "Beta's", at: "2026-09-29T00:00:00.000Z", source: "interested" }], lead_count: 1, amount_cents: 10_000, price_cents: 10_000, lead_source: "handoffs" });
    }
    return false;
  };
  const r = await liveRun();
  assert.equal(r.charged, 0);
  assert.match(r.errors.join(" "), /just billed in another period/);
  assert.equal(bell("usage_charge_error").length, 1);
  const row = rowsOf().find((x) => x.os_client_id === BETA && x.period_start === WEEK.start)!;
  assert.equal(row.status, "preview");
  assert.equal(isReopened(row.note as string), true);
  assert.deepEqual(liveFake.creates(/./), []);
});

test("a period billed only in test mode, before going live, doesn't ring 'hasn't been charged'", async () => {
  seedLive();
  db.rows("os_usage_billing_periods").push({ id: "t1", os_client_id: BETA, period_start: WEEK.start, period_end: WEEK.end, test_mode: true, status: "paid", leads: [], lead_count: 1, amount_cents: 10_000, price_cents: 10_000, lead_source: "handoffs" });
  const r = await liveRun({ now: new Date("2026-10-28T15:00:00.000Z") });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(bell("usage_charge_missed"), []);
});

test("a read failing on an old period is logged, and doesn't ring as a charge that couldn't run", async () => {
  seedLive();
  const r = await billing.runUsageBilling({ env: LIVE_ENV, now: new Date("2026-10-28T15:00:00.000Z"), stripe, liveStripe: () => liveStripe, source: async (_id, from) => { if (from === WEEK.start) throw new Error("no portal"); return []; } });
  assert.match(r.errors.join(" "), /older: no portal/);
  assert.deepEqual(bell(), []);
});

test("a test client's form saved while someone takes it live: told, and the new live client stays off", async () => {
  seedLive();
  const acme = () => db.rows("os_usage_billing_settings").find((x) => x.os_client_id === ACME) as Row;
  // Goes live after the save read the row, just before its write lands.
  db.failWhen = (c) => {
    if (c.table === "os_usage_billing_settings" && c.method === "PATCH") { acme().test_only = false; db.failWhen = null; }
    return false;
  };
  await assert.rejects(billing.saveSettings(ACME, { priceCents: 10_000, everyDays: 7, anchorDate: ANCHOR, leadSource: "handoffs", enabled: true }, ADMIN), /changed while you were saving/);
  assert.equal(acme().enabled, false);
});

test("Stop pressed while the run is counting: the switch as it is now decides", async () => {
  seedLive();
  const counted = await billing.runUsageBilling({
    env: LIVE_ENV, now: NOW, stripe, liveStripe: () => liveStripe,
    source: async (_id, _from, _to) => {
      (db.rows("os_usage_billing_settings").find((x) => x.os_client_id === BETA) as Row).enabled = false;
      return [{ key: "beta@x.test", name: "Beta's", at: "2026-10-06T17:00:00.000Z", source: "interested", thread: "ti-beta" }];
    },
  });
  assert.equal(counted.charged, 0);
  assert.deepEqual(liveFake.creates(/./), []);
});

test("the client's status can't be read: nothing is charged, the run and the bell say why, and it goes next hour", async () => {
  seedLive();
  db.failWhen = (c) => c.table === "os_clients" && c.method === "GET";
  const r = await liveRun();
  db.failWhen = null;
  assert.equal(r.charged, 0);
  assert.equal(r.held, 0, "not 'the client isn't active': it wasn't read");
  assert.match(r.errors.join(" "), /os_clients/);
  assert.deepEqual(liveFake.creates(/./), []);
  assert.equal(bell("usage_charge_error").length, 1);
  assert.equal((await liveRun()).charged, 1);
});

test("the count can't be read: nothing is charged, the bell tells the truth about what happens next", async () => {
  seedLive();
  await billing.runUsageBilling({ env: LIVE_ENV, now: NOW, stripe, liveStripe: () => liveStripe, source: async () => { throw new Error("the label history can't be read"); } });
  assert.deepEqual(liveFake.creates(/./), []);
  assert.equal(bell("usage_charge_error").length, 1);
  assert.match(String(bell("usage_charge_error")[0].body), /label history can't be read.*looks again next hour/);
});

test("with the test switch on too, a live client still goes through live Stripe and a test client through test Stripe", async () => {
  const card = liveFake.addCustomerWithCard({ name: "unused" });
  assert.ok(card);
  seedLive({ settings: {} });
  await withCard();
  (db.rows("os_usage_billing_settings").find((x) => x.os_client_id === ACME) as Row).enabled = true;
  const r = await liveRun({ env: { ...LIVE_ENV, OS_USAGE_BILLING_CHARGE: "1" } });
  assert.deepEqual(r.errors, []);
  assert.equal(r.charged, 2);
  assert.equal(rowsOf().find((x) => x.os_client_id === ACME)!.test_mode, true);
  assert.equal(betaRow()!.test_mode, false);
  assert.equal(livePays(), 1);
  assert.equal(fake.creates(/\/pay$/).length, 1);
  assert.ok(liveFake.calls.every((c) => !JSON.stringify(c.params).includes("cus_test")));
});

test("Homebase's shape: every 14 days from Oct 28, two delivered leads. Nothing at 8:59am on Nov 11, $500 once at 9:00", async () => {
  seedLive({ settings: { anchor_date: "2026-10-28", every_days: 14, price_cents: 25_000 } });
  db.rows("os_brokerage_relays").length = 0;
  for (const [thread, lead, email, name, at] of [["th-john", "l-john", "john@x.test", "John Kaye", "2026-11-04T00:29:42.000Z"], ["th-ram", "l-ram", "ram@x.test", "Ram Ethirajan", "2026-11-04T04:07:21.000Z"]] as const) {
    addInterested({ thread, lead, email, name, at, portal: LIVE, now: "lab-int" });
    db.rows("os_brokerage_relays").push({ workspace_id: "w", kind: "handoff", status: "sent", practice: false, os_client_id: BETA, thread_id: thread, agent_email: email });
  }
  const start = "2026-10-28";
  const row = () => rowsOf().find((x) => x.os_client_id === BETA && x.period_start === start);
  await liveRun({ now: new Date("2026-11-11T04:30:00.000Z") });
  await liveRun({ now: new Date("2026-11-11T13:59:00.000Z") });
  assert.equal(row(), undefined);
  assert.deepEqual(liveFake.creates(/./), []);
  const r = await liveRun({ now: new Date("2026-11-11T14:00:00.000Z") });
  assert.deepEqual(r.errors, []);
  assert.equal(r.charged, 1);
  assert.equal(row()!.status, "paid");
  assert.equal(row()!.lead_count, 2);
  assert.equal(row()!.amount_cents, 50_000);
  assert.equal(livePays(), 1);
  assert.match(String(bell("usage_charged")[0].title), /\$500/);
  assert.equal((await liveRun({ now: new Date("2026-11-11T15:00:00.000Z") })).charged, 0);
  assert.equal(livePays(), 1);
});

test("an open invoice the client paid by its link settles on the next run, and the bell says it was paid", async () => {
  seedLive();
  liveFake.declineNextPay = true;
  await liveRun();
  assert.equal(betaRow()!.status, "failed");
  liveFake.payByLink(String(betaRow()!.stripe_invoice_id));
  await liveRun();
  assert.equal(betaRow()!.status, "paid");
  assert.equal(bell("usage_charged").length, 1);
  assert.match(String(bell("usage_charged")[0].title), /Beta Homes paid \$100/);
  assert.equal(livePays(), 1, "the run itself paid nothing more");
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

/* ------------------------------------ the Interested count's rules (the user, 2 Nov) --- */

/** One more conversation on a portal: its agent, the thread, and its Interested in the history (and its label now). */
function addInterested(o: { thread: string; lead: string; email: string; name: string; at: string; portal?: string; now?: string; status?: string; noThread?: boolean }) {
  db.rows("leads").push({ id: o.lead, email: o.email, full_name: o.name });
  if (!o.noThread) db.rows("threads").push({ id: o.thread, client_id: o.portal ?? BOSTON, lead_id: o.lead, status: o.status ?? "open" });
  db.rows("label_history").push({ id: db.rows("label_history").length + 100, thread_id: o.thread, label_id: "lab-int", label_name: "Interested", assigned_at: o.at, client_id: o.portal ?? BOSTON, lead_id: o.lead, source: "trigger" });
  if (o.now) db.rows("label_assignments").push({ label_id: o.now, target_type: "thread", target_id: o.thread, assigned_at: o.at });
}

test("per lead: EVER marked Interested counts after it moves on (Introduction, No Show); a correction to a 'no' label, Trash and a deleted conversation do not", async () => {
  seed();
  db.rows("labels").push({ id: "lab-intro", name: "Introduction" }, { id: "lab-noshow", name: "No Show / No Response" }, { id: "lab-no", name: "Not Interested" }, { id: "lab-nq", name: "Not Qualified" });
  // Jordan was introduced since: the label he carries now is Introduction — the history still has his Interested.
  for (const a of db.rows("label_assignments")) if (a.target_id === "ti-jordan") a.label_id = "lab-intro";
  // Sam was corrected by a person to Not Interested; Pat's conversation is in Trash.
  for (const a of db.rows("label_assignments")) if (a.target_id === "ti-sam") a.label_id = "lab-no";
  for (const t of db.rows("threads")) if (t.id === "ti-pat") t.status = "trash";
  addInterested({ thread: "ti-noshow", lead: "l20", email: "noshow@x.test", name: "No Show Agent", at: "2026-10-08T12:00:00.000Z", now: "lab-noshow" });
  addInterested({ thread: "ti-nq", lead: "l21", email: "nq@x.test", name: "Not Qualified Agent", at: "2026-10-08T13:00:00.000Z", now: "lab-nq" });
  addInterested({ thread: "ti-gone", lead: "l22", email: "gone@x.test", name: "Deleted Conversation", at: "2026-10-08T14:00:00.000Z", noThread: true });
  const p = await billing.previewPeriod(ACME, await settingsOf(), { now: NOW });
  assert.deepEqual(p.leads.map((l) => l.key).sort(), ["jordan@coastal.test", "noshow@x.test"].sort(), "introduced and no-show still count; corrected, Trash and deleted do not");
  assert.deepEqual(writes(), []);
});

test("per lead: counted in the period of its FIRST Interested — marked again later bills nothing new; an agent the client had before its start is not billed", async () => {
  seed({ acmeSettings: { anchor_date: "2026-09-21" } }); // first period Sep 21; the week asked for is Oct 5 – 11
  // Marked Interested in an earlier period (Sep 30) and again this week: it belonged to the earlier period.
  addInterested({ thread: "ti-again", lead: "l30", email: "again@x.test", name: "Marked Twice", at: "2026-09-30T12:00:00.000Z" });
  db.rows("label_history").push({ id: 900, thread_id: "ti-again", label_id: "lab-int", label_name: "Interested", assigned_at: "2026-10-08T12:00:00.000Z", client_id: BOSTON, lead_id: "l30", source: "trigger" });
  // Before the client's start (Sep 21): introduced (history), and introduced in the portal — then Interested again this week.
  db.rows("leads").push({ id: "l31", email: "before@x.test", full_name: "Introduced Before" }, { id: "l32", email: "portal@x.test", full_name: "Portal Intro Before" });
  db.rows("label_history").push({ id: 901, thread_id: "ti-old1", label_id: "lab-intro", label_name: "Introduction", assigned_at: "2026-09-10T12:00:00.000Z", client_id: BOSTON, lead_id: "l31", source: "backfill:current" });
  addInterested({ thread: "ti-before", lead: "l31", email: "before@x.test", name: "Introduced Before", at: "2026-10-08T15:00:00.000Z" });
  db.rows("client_pipeline_entries").push({ id: "pe-old", client_id: FLORIDA, thread_id: "t-old", lead_name: "Portal Intro Before", lead_email: "Portal@x.test", source: "Introduction", introduced_at: "2026-09-15T12:00:00.000Z" });
  addInterested({ thread: "ti-portal", lead: "l32", email: "portal@x.test", name: "Portal Intro Before", at: "2026-10-09T15:00:00.000Z" });
  addInterested({ thread: "ti-fresh", lead: "l33", email: "fresh@x.test", name: "New Agent", at: "2026-10-10T15:00:00.000Z" });
  const p = await billing.previewPeriod(ACME, await settingsOf(), { now: NOW, periodStart: "2026-10-05" });
  const keys = p.leads.map((l) => l.key);
  assert.ok(keys.includes("fresh@x.test"), "a new agent counts");
  for (const k of ["again@x.test", "before@x.test", "portal@x.test"]) assert.ok(!keys.includes(k), k);
});

test("per lead: before Master Inbox migration 0080 nothing is counted — said plainly (503), never a guess", async () => {
  seed();
  db.missingTables.add("label_history");
  await assert.rejects(billing.previewPeriod(ACME, await settingsOf(), { now: NOW }), (e: unknown) => e instanceof billing.UsageBillingError && e.status === 503 && /0080_label_history/.test(e.message));
});

test("two periods charged at the same moment cannot both bill the same agent: the second lets go and says so", async () => {
  seed();
  await withCard();
  // At the very moment this period is claimed, another period (Sep 28) is claimed with Jordan on it — as a second tab
  // would, after this one's preview had seen it unbilled.
  db.failWhen = (c) => {
    if (c.method === "PATCH" && c.table === "os_usage_billing_periods" && c.query.get("status") === "eq.preview") {
      db.rows("os_usage_billing_periods").push({ id: "other", os_client_id: ACME, period_start: "2026-09-28", period_end: "2026-10-05", test_mode: true, status: "draft", leads: [{ key: "jordan@coastal.test", name: "Jordan", at: "2026-10-01T12:00:00.000Z", source: "interested" }], lead_count: 1, price_cents: 10_000, amount_cents: 10_000, claimed_at: new Date().toISOString() });
      db.failWhen = null;
    }
    return false;
  };
  await assert.rejects(billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW }), (e: unknown) => e instanceof billing.UsageBillingError && e.status === 409 && /just billed in another period/.test(e.message));
  assert.equal(rowsOf().find((r) => r.period_start === WEEK.start)!.status, "preview", "let go — free to preview and charge again");
  assert.equal(fake.creates(/^\/invoices$/).length, 0, "nothing sent to Stripe");
});

test("a charge whose claim was taken over (a resume after it went stale) stops: it never finalizes or pays a second invoice", async () => {
  seed();
  await withCard();
  // As this charge creates its invoice, someone else takes the claim over (a resume): it must stop.
  fake.failWhen = (c) => {
    if (c.method === "POST" && c.path === "/invoices") { const r = rowsOf().find((x) => x.period_start === WEEK.start)!; r.claimed_at = "2099-01-01T00:00:00.000Z"; fake.failWhen = null; }
    return false;
  };
  const r = await billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW });
  assert.equal(r.outcome, "in_progress");
  assert.match(r.message, /took over/);
  assert.equal(fake.creates(/\/finalize$/).length, 0);
  assert.equal(fake.creates(/\/pay$/).length, 0);
});

/* ---------------------------------------------------- re-audit fixes (2 Nov) --- */

test("a charge Stripe refuses the same way every time is never stuck: once stale it can be removed (nothing taken) and the period charged again", async () => {
  seed();
  await withCard();
  // Every invoice line is refused (a deleted customer, a currency mismatch…): the draft invoice exists, the period is 'draft'.
  fake.failWhen = (c) => c.method === "POST" && c.path === "/invoiceitems";
  await assert.rejects(billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW }), /remove the unfinished charge/);
  assert.equal(rowsOf()[0].status, "draft");
  assert.equal(fake.invoices.size, 1);
  const row = rowsOf()[0] as { amount_cents: number; lead_count: number; leads: { key: string }[] };
  const seen = { amountCents: row.amount_cents, count: row.lead_count, leadsHash: leadsHash(row.leads) };
  // Not while it may still be running.
  await assert.rejects(billing.retryPeriod(ACME, WEEK.start, stripe, ADMIN, seen, new Date(NOW.getTime() + 60_000)), /being billed right now/);
  // From a page that saw other leads: refused.
  await assert.rejects(billing.retryPeriod(ACME, WEEK.start, stripe, ADMIN, { ...seen, leadsHash: "other" }, new Date(NOW.getTime() + 60 * 60_000)), /changed since you looked/);
  const r = await billing.retryPeriod(ACME, WEEK.start, stripe, ADMIN, seen, new Date(NOW.getTime() + 60 * 60_000));
  assert.equal(r.outcome, "nothing");
  assert.match(r.message, /nothing was taken/);
  assert.equal(fake.invoices.size, 0, "its draft invoice deleted in Stripe");
  assert.equal(fake.creates(/\/finalize$|\/pay$/).length, 0, "nothing charged");
  assert.equal(rowsOf()[0].status, "preview");
  assert.equal(rowsOf()[0].lead_count, 0, "its agents are free again");
  // The cause fixed: charged on a new invoice, once.
  fake.failWhen = null;
  const again = await billing.chargePeriod(ACME, { stripe, by: ADMIN, now: new Date(NOW.getTime() + 2 * 60 * 60_000) });
  assert.equal(again.outcome, "paid");
  assert.equal(fake.creates(/\/pay$/).length, 1);
});

test("an unfinished charge whose invoice was already finalized is never removed — it is resumed instead", async () => {
  seed();
  const { customerId, pm } = await withCard();
  const leads = [{ key: "jordan@coastal.test", name: "Jordan Ellis", at: "2026-10-06T14:00:00.000Z", source: "interested" }];
  const { invoiceId } = await stripe.createDraftInvoice({ customerId, paymentMethodId: pm, osClientId: ACME, period: WEEK, periodKey: PK, description: "x", leadCount: 1 });
  await stripe.addLeadLine({ customerId, invoiceId, periodKey: PK, lead: leads[0], priceCents: 10_000 });
  await stripe.finalizeInvoice(invoiceId, "k");
  db.seed("os_usage_billing_periods", [{ os_client_id: ACME, period_start: WEEK.start, period_end: WEEK.end, test_mode: true, status: "draft", leads, lead_count: 1, price_cents: 10_000, amount_cents: 10_000, lead_source: "handoffs", claimed_at: "2026-10-13T00:00:00.000Z", stripe_invoice_id: invoiceId }]);
  await assert.rejects(billing.retryPeriod(ACME, WEEK.start, stripe, ADMIN, null, NOW), /already open in Stripe — press "Try the charge again"/);
  assert.equal(rowsOf()[0].status, "draft");
  assert.equal(fake.invoices.get(invoiceId)!.status, "open");
});

test("a retry goes with the leads the person saw: another lead set at the same amount is refused", async () => {
  seed();
  await withCard();
  fake.declineNextPay = true;
  await billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW });
  const row = rowsOf()[0] as { amount_cents: number; lead_count: number; leads: { key: string }[] };
  await assert.rejects(billing.retryPeriod(ACME, WEEK.start, stripe, ADMIN, { amountCents: row.amount_cents, count: row.lead_count, leadsHash: "seen-before" }), /changed since you looked/);
  await assert.rejects(billing.retryPeriod(ACME, WEEK.start, stripe, ADMIN, { amountCents: row.amount_cents, count: row.lead_count + 1, leadsHash: leadsHash(row.leads) }), /changed since you looked/);
  const r = await billing.retryPeriod(ACME, WEEK.start, stripe, ADMIN, { amountCents: row.amount_cents, count: row.lead_count, leadsHash: leadsHash(row.leads) });
  assert.equal(r.outcome, "paid");
});

test("an invoice marked uncollectible in Stripe: Refresh shows the period unpaid, and Retry charges it", async () => {
  seed();
  await withCard();
  fake.declineNextPay = true;
  await billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW });
  const row = rowsOf()[0];
  Object.assign(row, { status: "charged", charged_at: "2026-10-14T15:00:00.000Z", error: null });
  fake.markUncollectible(String(row.stripe_invoice_id));
  const refreshed = await billing.refreshPeriod(ACME, WEEK.start, stripe);
  assert.equal(refreshed?.status, "failed");
  assert.match(String(refreshed?.error), /uncollectible/);
  const r = await billing.retryPeriod(ACME, WEEK.start, stripe, ADMIN);
  assert.equal(r.outcome, "paid");
});

test("the Interested count refuses rather than undercount: history missing a label, or no portal linked", async () => {
  seed();
  // Jordan carries Interested now, given this week — but the history has no row for it: the history stopped.
  db.seed("label_history", db.rows("label_history").filter((h) => h.thread_id !== "ti-jordan"));
  await assert.rejects(billing.previewPeriod(ACME, await settingsOf(), { now: NOW }), (e: unknown) => e instanceof billing.UsageBillingError && e.status === 503 && /missing 1 conversation marked Interested/.test(e.message));
  seed();
  const acme = db.rows("os_clients").find((c) => c.id === ACME)!;
  Object.assign(acme, { mi_client_id: null, aliases: [] });
  await assert.rejects(billing.previewPeriod(ACME, await settingsOf(), { now: NOW }), (e: unknown) => e instanceof billing.UsageBillingError && e.status === 503 && /no Master Inbox portal linked/.test(e.message));
});

test("a per-lead schedule can't start before Interested replies are on record (14 Oct 2026)", async () => {
  seed({ acmeSettings: null });
  const input = { enabled: false, priceCents: 25_000, everyDays: 14 as const, leadSource: "handoffs" as const };
  await assert.rejects(billing.saveSettings(ACME, { ...input, anchorDate: "2026-10-13" }, ADMIN), (e: unknown) => e instanceof billing.UsageBillingError && e.status === 400 && /on record from Oct 14, 2026/.test(e.message));
  assert.equal(db.rows("os_usage_billing_settings").length, 0);
  await billing.saveSettings(ACME, { ...input, anchorDate: "2026-10-14" }, ADMIN);
  assert.equal(db.rows("os_usage_billing_settings")[0].anchor_date, "2026-10-14");
});

