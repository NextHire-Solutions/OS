/*
 * Pay per lead — the Stripe requests (stripe.ts), against the fake Stripe
 * (test/fake-stripe.ts). Nothing here reaches Stripe.
 *
 * What is pinned: the invoice is charge_automatically with auto_advance off
 * and takes no stray pending items; it gets exactly one line per lead, ON it;
 * every create / finalize / pay carries an Idempotency-Key from the client and
 * the period, so a repeat returns the first answer instead of a second object.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { periodKey, type BillableLead } from "./model.ts";
import { usageStripe } from "./stripe.ts";
import { FakeStripe } from "./test/fake-stripe.ts";

const KEY = "sk_test_51FakeFakeFakeFake";
const fake = new FakeStripe();
const stripe = usageStripe(KEY, fake.fetch as typeof fetch);
const CLIENT = "20000000-0000-4000-8000-000000000001";
const P = { start: "2026-10-05", end: "2026-10-12" };
const PK = periodKey(CLIENT, P.start);
const leads: BillableLead[] = [
  { key: "jordan@coastal.test", name: "Jordan Ellis", at: "2026-10-06T14:00:00.000Z", source: "handoff" },
  { key: "sam@harbor.test", name: "Sam Lee", at: "2026-10-07T18:30:00.000Z", source: "handoff" },
  { key: "pat@bay.test", name: "Pat Kim", at: "2026-10-12T02:00:00.000Z", source: "handoff" },
];

async function customerWithCard() {
  const { id } = await stripe.createCustomer({ osClientId: CLIENT, name: "ZZ Usage Test — Acme", idempotencyKey: `os-usage:${CLIENT}:customer` });
  const pm = await stripe.attachPaymentMethod("pm_card_visa", id);
  await stripe.setDefaultPaymentMethod(id, pm.id);
  return { customerId: id, pm: pm.id };
}

test("the period invoice: a draft, charge_automatically, auto_advance off, no stray items — then one line per lead ON it", async () => {
  fake.reset();
  const { customerId, pm } = await customerWithCard();
  const { invoiceId } = await stripe.createPeriodInvoice({ customerId, paymentMethodId: pm, osClientId: CLIENT, period: P, periodKey: PK, description: "Pay per lead", leads, priceCents: 10_000 });

  const [inv] = fake.creates(/^\/invoices$/);
  assert.equal(inv.params.collection_method, "charge_automatically");
  assert.equal(inv.params.auto_advance, "false");
  assert.equal(inv.params.pending_invoice_items_behavior, "exclude");
  assert.equal(inv.params.default_payment_method, pm);
  assert.equal(inv.params.currency, "usd");
  assert.equal(inv.params["metadata[os_usage_period]"], PK);
  assert.equal(inv.params["metadata[os_client_id]"], CLIENT);
  assert.equal(inv.idempotencyKey, `${PK}:invoice`);

  const items = fake.creates(/^\/invoiceitems$/);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((i) => i.params.description), ["Lead: Jordan Ellis — Oct 6, 2026", "Lead: Sam Lee — Oct 7, 2026", "Lead: Pat Kim — Oct 11, 2026"]);
  for (const i of items) {
    assert.equal(i.params.invoice, invoiceId, "on THIS invoice, never a pending item");
    assert.equal(i.params.amount, "10000");
    assert.equal(i.params.currency, "usd");
    assert.match(i.idempotencyKey ?? "", new RegExp(`^${PK}:item:`));
  }
  assert.equal(new Set(items.map((i) => i.idempotencyKey)).size, 3, "one key per lead");

  const now = await stripe.getInvoice(invoiceId);
  assert.equal(now.total, 30_000);
  assert.equal(now.status, "draft");
  assert.equal(now.payUrl, null);
  const lines = await stripe.invoiceLines(invoiceId);
  assert.deepEqual(lines.map((l) => l.leadKey), leads.map((l) => l.key));
  assert.deepEqual(fake.liveKeySeen, []);
});

test("a repeat with the same keys returns the first invoice and lines — never a second", async () => {
  fake.reset();
  const { customerId, pm } = await customerWithCard();
  const o = { customerId, paymentMethodId: pm, osClientId: CLIENT, period: P, periodKey: PK, description: "Pay per lead", leads, priceCents: 10_000 };
  const a = await stripe.createPeriodInvoice(o);
  const b = await stripe.createPeriodInvoice(o);
  assert.equal(a.invoiceId, b.invoiceId);
  assert.equal(fake.invoices.size, 1);
  assert.equal(fake.invoices.get(a.invoiceId)!.lines.length, 3);
  // The same key with a DIFFERENT request is Stripe's error, not a new invoice.
  await assert.rejects(stripe.createDraftInvoice({ ...o, description: "changed", leadCount: 3 }), /same parameters/);
  assert.equal(fake.invoices.size, 1);
});

test("finalize and pay carry their keys; paid; a declined card is an answer with the invoice left open and payable by link", async () => {
  fake.reset();
  const { customerId, pm } = await customerWithCard();
  const { invoiceId } = await stripe.createPeriodInvoice({ customerId, paymentMethodId: pm, osClientId: CLIENT, period: P, periodKey: PK, description: "x", leads, priceCents: 10_000 });
  const fin = await stripe.finalizeInvoice(invoiceId, `${PK}:finalize`);
  assert.equal(fin.status, "open");
  assert.ok(fin.payUrl, "an open invoice has its pay link");
  const finCall = fake.creates(/\/finalize$/)[0];
  assert.equal(finCall.idempotencyKey, `${PK}:finalize`);
  assert.equal(finCall.params.auto_advance, "false");

  fake.declineNextPay = true;
  const refused = await stripe.payInvoice(invoiceId, `${PK}:pay:declined`);
  assert.deepEqual(refused, { ok: false, error: "Stripe: Your card was declined.", code: "card_declined" });
  assert.equal((await stripe.getInvoice(invoiceId)).status, "open");

  const paid = await stripe.payInvoice(invoiceId, `${PK}:pay`);
  assert.ok(paid.ok);
  assert.equal(paid.invoice.status, "paid");
  assert.equal(paid.invoice.amountPaid, 30_000);
  assert.equal(paid.invoice.payUrl, null, "nothing left to pay");
  assert.equal(fake.creates(/\/pay$/).at(-1)!.idempotencyKey, `${PK}:pay`);
});

test("history: the customer's invoices, newest first, with a pay link only on the unpaid ones; the period invoice found by its key", async () => {
  fake.reset();
  const { customerId, pm } = await customerWithCard();
  const one = await stripe.createPeriodInvoice({ customerId, paymentMethodId: pm, osClientId: CLIENT, period: P, periodKey: PK, description: "a", leads: leads.slice(0, 1), priceCents: 10_000 });
  await stripe.finalizeInvoice(one.invoiceId, "k1");
  await stripe.payInvoice(one.invoiceId, "k2");
  const PK2 = periodKey(CLIENT, "2026-10-12");
  const two = await stripe.createPeriodInvoice({ customerId, paymentMethodId: pm, osClientId: CLIENT, period: { start: "2026-10-12", end: "2026-10-19" }, periodKey: PK2, description: "b", leads: leads.slice(1, 2), priceCents: 10_000 });
  await stripe.finalizeInvoice(two.invoiceId, "k3");
  const list = await stripe.listInvoices(customerId);
  assert.deepEqual(list.map((i) => [i.id, i.status, !!i.payUrl, i.periodKey, i.test]), [[two.invoiceId, "open", true, PK2, true], [one.invoiceId, "paid", false, PK, true]]);
  assert.equal((await stripe.findPeriodInvoice(customerId, PK2))?.id, two.invoiceId);
  assert.equal(await stripe.findPeriodInvoice(customerId, periodKey(CLIENT, "2026-10-19")), null);
});

test("card setup: a Checkout in setup mode for the customer, read back with its card", async () => {
  fake.reset();
  const { id: customerId } = await stripe.createCustomer({ osClientId: CLIENT, name: "ZZ Usage Test — Acme", idempotencyKey: "c" });
  const s = await stripe.setupCheckout({ customerId, osClientId: CLIENT, successUrl: "https://os.test/roster?client=x&usage_setup=done", cancelUrl: "https://os.test/roster?client=x" });
  const call = fake.creates(/^\/checkout\/sessions$/)[0];
  assert.equal(call.params.mode, "setup");
  assert.equal(call.params.customer, customerId);
  assert.equal(call.params["payment_method_types[0]"], "card");
  assert.match(s.url, /^https:\/\/checkout\.stripe\.com\//);
  assert.deepEqual(await stripe.readSetupSession(s.id), { id: s.id, status: "open", customerId, paymentMethodId: null, cardLabel: null });
  fake.completeSetup(s.id);
  const done = await stripe.readSetupSession(s.id);
  assert.equal(done.status, "complete");
  assert.match(done.paymentMethodId ?? "", /^pm_/);
  assert.equal(done.cardLabel, "Visa •••• 4242");
  assert.equal(fake.calls.at(-1)!.params["expand[0]"], "setup_intent.payment_method");
});
