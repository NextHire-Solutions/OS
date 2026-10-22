import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  checkRefundable, creditNoteForm, dollarsToCents, givenBack, invoiceNow, issueRefund, liveRefundRefusal, previewRefund, recentTwin, REFUND_REASONS, RefundError,
  refundRequest, twinRefusal, TWIN_WINDOW_S, type IssuedNote, type RefundRequest,
} from "./billing-refund.ts";
import { clientBillingDetail, type AccountSnapshot, type StripeCharge, type StripeInvoice } from "./billing-model.ts";

/*
 * Refunds from the Billing tab (Eddy's plan, approved 22 Oct). Stripe is never
 * called here — a fake fetch stands in. The real calls were proven in Stripe's
 * TEST mode only (a paid test invoice, partial then remaining refunds, a
 * repeated request, an over-refund) — never on a real invoice.
 */

const KEY = "11111111-2222-4333-8444-555555555555";
const CLIENT = "00ef116c-646d-43b4-a323-680548ea7126";
const ask = (o: Partial<RefundRequest> = {}): RefundRequest =>
  refundRequest.parse({ clientId: CLIENT, invoiceId: "in_1AbCdEfGhIjK", amount: 25_000, reason: "product_unsatisfactory", key: KEY, ...o });

type Call = { url: string; init?: RequestInit };
function fakeStripe(reply: (c: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const c = { url: String(url), init };
    calls.push(c);
    const r = reply(c);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
}

/* ------------------------------------------------------------- the ask --- */

test("the request: an invoice id, whole cents, one of the four reasons, a key per confirmation", () => {
  const r = ask();
  assert.deepEqual([r.note, r.emailClient, r.preview], ["", false, false], "no note, no email, not a preview — unless asked");
  for (const bad of [
    { invoiceId: "ch_1AbCdEfGhIjK" }, { invoiceId: "in_../../customers" }, { invoiceId: "in_short" },
    { amount: 0 }, { amount: -500 }, { amount: 250.5 }, { amount: 100_000_001 },
    { reason: "other" }, { key: "not-a-uuid" }, { clientId: "rt" }, { clientId: "00ef116c-646d-43b4-a323-680548ea712" }, { note: "x".repeat(501) },
  ]) {
    assert.equal(refundRequest.safeParse({ clientId: CLIENT, invoiceId: "in_1AbCdEfGhIjK", amount: 25_000, reason: "duplicate", key: KEY, ...bad }).success, false, JSON.stringify(bad).slice(0, 60));
  }
  assert.deepEqual(Object.keys(REFUND_REASONS), ["product_unsatisfactory", "order_change", "duplicate", "fraudulent"], "Stripe's own reason codes");
});

test("amounts typed in dollars: commas and $ allowed, at most two decimals, anything else refused", () => {
  assert.equal(dollarsToCents("250"), 25_000);
  assert.equal(dollarsToCents("$1,250.50"), 125_050);
  assert.equal(dollarsToCents(" 0.1 "), 10);
  assert.equal(dollarsToCents("19.99"), 1_999, "no float drift");
  assert.equal(dollarsToCents("12,345,678.9"), 1_234_567_890);
  for (const bad of ["", "abc", "1.234", "-5", "1e3", "12.", ".5x"]) assert.equal(dollarsToCents(bad), null, bad);
  // A comma only between thousands — "1,50" (meant as $1.50) is refused, never read as $150 (23 Oct review).
  for (const bad of ["1,50", "1,5", "12,34.00", ",250", "250,", "1,2345"]) assert.equal(dollarsToCents(bad), null, bad);
});

/* ------------------------------------------------------------ the checks --- */

test("before Stripe is asked: only this client's invoice, paid, and no more than is left", () => {
  const paid = { id: "in_1", status: "paid", refundable: 750 };
  assert.doesNotThrow(() => checkRefundable(paid, 75_000), "the full amount");
  assert.doesNotThrow(() => checkRefundable(paid, 1), "one cent");
  const fails: Array<[Parameters<typeof checkRefundable>[0], number, number, RegExp]> = [
    [undefined, 100, 404, /isn't one of this client's/],
    [{ ...paid, status: "open" }, 100, 409, /Only a paid invoice/],
    [{ ...paid, status: "void" }, 100, 409, /Only a paid invoice/],
    [{ ...paid, refundable: 0 }, 100, 409, /refunded in full already/],
    [paid, 75_001, 409, /At most \$750\.00/],
    [{ ...paid, refundable: 249.99 }, 25_000, 409, /At most \$249\.99/],
  ];
  for (const [inv, cents, status, msg] of fails) {
    assert.throws(() => checkRefundable(inv, cents), (e: unknown) => e instanceof RefundError && e.status === status && msg.test(e.message));
  }
});

test("a real refund (a live key) is issued only from the deployed OS, asked on os.brokerstaffer.com — never from a copy running locally", () => {
  const SITE = "https://os.brokerstaffer.com";
  const RW = { RAILWAY_ENVIRONMENT_NAME: "production" };
  assert.equal(liveRefundRefusal("sk_live_abc", RW, SITE, SITE), null);
  assert.equal(liveRefundRefusal("rk_live_abc", { RAILWAY_ENVIRONMENT: "production" }, SITE, SITE), null);
  for (const [env, origin] of [
    [{}, SITE], // not on Railway
    [RW, "http://127.0.0.1:4010"], // `railway run` on a laptop sets Railway's variables — the page is still local
    [RW, null], // no Origin
    [RW, "https://os.brokerstaffer.com.evil.com"],
  ] as const) {
    assert.match(liveRefundRefusal("sk_live_abc", env, origin, SITE) ?? "", /only from os\.brokerstaffer\.com/, `${JSON.stringify(env)} ${origin}`);
  }
  assert.equal(liveRefundRefusal("sk_test_abc", {}, null, SITE), null, "test mode is where testing happens");
  assert.equal(liveRefundRefusal("rk_test_abc", {}, "http://127.0.0.1:4010", SITE), null);
  const route = readFileSync("src/app/api/workspace/clients/billing/refund/route.ts", "utf8");
  assert.match(route, /liveRefundRefusal\(key, process\.env, request\.headers\.get\("origin"\), publicOrigin\(\)\)/);
});

/* -------------------------------------------------------- Stripe's form --- */

test("the credit note: on that invoice, refunding the amount, with the reason, the note, who did it and the client", () => {
  const f = creditNoteForm(ask({ note: "Service gap in week 3" }), "eddy@brokerstaffer.com");
  assert.deepEqual(Object.fromEntries(f), {
    invoice: "in_1AbCdEfGhIjK", amount: "25000", refund_amount: "25000", reason: "product_unsatisfactory", memo: "Service gap in week 3",
    email_type: "none", "metadata[os_refund_by]": "eddy@brokerstaffer.com", "metadata[os_client_id]": CLIENT, "metadata[os_refund_key]": KEY,
  });
  assert.equal(creditNoteForm(ask(), "x@y.z").has("memo"), false, "no note, no memo");
  assert.equal(creditNoteForm(ask({ emailClient: true }), "x@y.z").get("email_type"), "credit_note", "emailed only when ticked");
});

test("issuing: one POST to credit_notes, with an idempotency key from the confirmation — a double click refunds once", async () => {
  const { f, calls } = fakeStripe(() => ({ body: { id: "cn_1", number: "ABC-0001-CN-01", pdf: "https://pay.stripe.com/cn", refunds: [{ refund: "re_1", amount_refunded: 25_000 }] } }));
  const out = await issueRefund("sk_test_x", ask(), "amy@brokerstaffer.com", f);
  assert.deepEqual(out, { creditNote: "cn_1", number: "ABC-0001-CN-01", pdf: "https://pay.stripe.com/cn", refund: "re_1" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.stripe.com/v1/credit_notes");
  assert.equal(calls[0].init?.method, "POST");
  const h = new Headers(calls[0].init?.headers);
  assert.equal(h.get("Idempotency-Key"), `os-refund-${KEY}`);
  assert.equal(h.get("Authorization"), "Bearer sk_test_x");
  assert.equal(new URLSearchParams(String(calls[0].init?.body)).get("refund_amount"), "25000");
  // The older API's shape names the refund directly.
  const old = fakeStripe(() => ({ body: { id: "cn_2", number: null, refund: "re_2" } }));
  assert.equal((await issueRefund("sk_test_x", ask(), "a@b.c", old.f)).refund, "re_2");
});

test("Stripe's refusals come back in Stripe's words; a bad request is the person's (409), anything else Stripe's (502)", async () => {
  const over = fakeStripe(() => ({ status: 400, body: { error: { message: "The credit note amount ($600.00) must not exceed the remaining creditable amount ($500.00)." } } }));
  await assert.rejects(issueRefund("sk_test_x", ask(), "a@b.c", over.f), (e: unknown) => e instanceof RefundError && e.status === 409 && /must not exceed/.test(e.message));
  const down = fakeStripe(() => ({ status: 500, body: {} }));
  await assert.rejects(issueRefund("sk_test_x", ask(), "a@b.c", down.f), (e: unknown) => e instanceof RefundError && e.status === 502);
  await assert.rejects(previewRefund("sk_test_x", ask(), "a@b.c", over.f), (e: unknown) => e instanceof RefundError && e.status === 409);
});

test("the preview is a GET of Stripe's preview — it creates nothing", async () => {
  const { f, calls } = fakeStripe(() => ({ body: { amount: 25_000, total: 25_000 } }));
  assert.deepEqual(await previewRefund("sk_test_x", ask(), "a@b.c", f), { amount: 25_000, total: 25_000 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.method ?? "GET", "GET");
  const u = new URL(calls[0].url);
  assert.equal(u.pathname, "/v1/credit_notes/preview");
  assert.equal(u.searchParams.get("refund_amount"), "25000");
  assert.equal(u.searchParams.has("email_type"), false, "the preview takes no email setting");
});

function stripeNow(o: { paid?: number; credited?: number; chargeRefunded?: number[]; notes?: unknown[] } = {}) {
  return fakeStripe(({ url }) => {
    const p = new URL(url).pathname;
    if (p.startsWith("/v1/invoices/")) return { body: { id: "in_1AbCdEfGhIjK", status: "paid", amount_paid: o.paid ?? 75_000, post_payment_credit_notes_amount: o.credited ?? 0 } };
    if (p.startsWith("/v1/charges/")) return { body: { id: p.split("/").pop(), amount_refunded: (o.chargeRefunded ?? [0])[Number(p.slice(-1)) - 1] ?? 0 } };
    if (p === "/v1/credit_notes") return { body: { data: o.notes ?? [] } };
    return { status: 404, body: { error: { message: `unexpected ${p}` } } };
  });
}

test("the invoice as Stripe has it now: paid, less the larger of its payments' refunds and its credit notes — a refund made in Stripe counts", async () => {
  const a = stripeNow({ credited: 25_000 });
  assert.equal((await invoiceNow("sk_test_x", "in_1AbCdEfGhIjK", ["ch_1"], a.f)).refundable, 500);
  assert.ok(a.calls.every((c) => (c.init?.method ?? "GET") === "GET"), "reads only");
  assert.deepEqual(a.calls.map((c) => new URL(c.url).pathname).sort(), ["/v1/charges/ch_1", "/v1/credit_notes", "/v1/invoices/in_1AbCdEfGhIjK"]);
  // Refunded in the Stripe Dashboard: no credit note, but the payment says so.
  assert.equal((await invoiceNow("sk_test_x", "in_1AbCdEfGhIjK", ["ch_1"], stripeNow({ chargeRefunded: [75_000] }).f)).refundable, 0);
  assert.equal((await invoiceNow("sk_test_x", "in_1AbCdEfGhIjK", ["ch_1", "ch_2"], stripeNow({ chargeRefunded: [10_000, 20_000], credited: 25_000 }).f)).refundable, 450);
  const notes = (await invoiceNow("sk_test_x", "in_1AbCdEfGhIjK", [], stripeNow({ notes: [
    { id: "cn_1", number: "X-CN-01", created: 100, amount: 25_000, metadata: { os_refund_key: KEY }, refunds: [{ refund: "re_1" }] },
    { id: "cn_2", number: null, created: 200, amount: 500, metadata: {}, refund: { id: "re_2" } },
  ] }).f)).notes;
  assert.deepEqual(notes, [
    { id: "cn_1", number: "X-CN-01", created: 100, amount: 25_000, key: KEY, refund: "re_1" },
    { id: "cn_2", number: null, created: 200, amount: 500, key: null, refund: "re_2" },
  ]);
  const missing = fakeStripe(() => ({ status: 404, body: { error: { message: "No such invoice" } } }));
  await assert.rejects(invoiceNow("sk_test_x", "in_x", [], missing.f), /No such invoice/);
});

/* ------------------------------------------------- never twice (23 Oct) --- */

test("the same amount on the same invoice within ten minutes, under another confirmation, is taken for a repeat", () => {
  const now = 1_800_000_000;
  const note = (o: Partial<IssuedNote>): IssuedNote => ({ id: "cn_1", number: "X-CN-01", created: now - 120, amount: 25_000, key: "other-key", refund: "re_1", ...o });
  assert.ok(recentTwin([note({})], 25_000, KEY, now), "2 min ago, same amount, another key");
  assert.equal(recentTwin([note({ key: KEY })], 25_000, KEY, now), null, "the same confirmation is a retry, not a repeat (the route answers with it)");
  assert.equal(recentTwin([note({ amount: 10_000 })], 25_000, KEY, now), null, "another amount");
  assert.equal(recentTwin([note({ created: now - TWIN_WINDOW_S })], 25_000, KEY, now), null, "ten minutes on");
  assert.equal(recentTwin([note({ key: null })], 25_000, KEY, now)?.id, "cn_1", "one made in Stripe counts too");
  const e = twinRefusal(note({}), now);
  assert.equal(e.status, 409);
  assert.match(e.message, /A refund of \$250\.00 was issued on this invoice 2 min ago \(credit note X-CN-01\)\. Check the billing history — if a second one is really meant, it can be made in 8 min\./);
});

test("the route: a retry of a refund already made answers with it and sends nothing; a lost answer says it may have gone through", () => {
  const src = readFileSync("src/app/api/workspace/clients/billing/refund/route.ts", "utf8");
  const at = (x: string) => { const i = src.indexOf(x); assert.ok(i > 0, x); return i; };
  assert.ok(at("now.notes.find((n) => n.key === r.key)") < at("recentTwin(") && at("recentTwin(") < at("checkRefundable(now") && at("checkRefundable(now") < at("issueRefund("), "already made → repeat → room left → only then Stripe");
  assert.match(src, /const done0 = r\.preview \? undefined : now\.notes\.find/, "only a real request is answered with an earlier refund");
  assert.ok(at("sent = true;") < at("const done = await issueRefund("), "marked sent just before");
  assert.match(src, /if \(!sent\) \{[\s\S]*?Nothing was refunded/, "a failure before sending says nothing was refunded");
  assert.match(src, /\{ error: UNCERTAIN, uncertain: true \}/, "after sending, an unclear answer says it may have gone through");
  const dlg = readFileSync("src/components/screens/client-billing-refund.tsx", "utf8");
  assert.match(dlg, /else if \(!out \|\| out\.body\.uncertain\) \{\s*setLost\(true\);\s*setError\(LOST\);\s*onRefunded\(\);/, "lost: told, and the tab re-reads Stripe");
  const lostAt = dlg.indexOf("{lost\n");
  assert.ok(lostAt > 0 && lostAt < dlg.indexOf(">Close and check the history</button>") && dlg.indexOf(">Close and check the history</button>") < dlg.indexOf(">Back</button>"), "no Back to a new amount after a lost answer: Close in its place");
  assert.match(dlg, /step\.stripeCents === step\.cents \? \(\s*<button[^>]*rb-danger/, "Refund only when Stripe's preview matches the amount");
});

test("refunded or credited: what went back to the card, or only a credit note", () => {
  assert.equal(givenBack({ paid: 750, refundable: 750, refunded: 0 }), null);
  assert.equal(givenBack({ paid: 750, refundable: 500, refunded: 250 }), "$250.00 refunded");
  assert.equal(givenBack({ paid: 750, refundable: 650, refunded: 0 }), "$100.00 credited", "a credit note that gave a balance credit, not money");
  assert.equal(givenBack({ paid: 750, refundable: 0, refunded: 750 }), "$750.00 refunded");
});

/* ---------------------------------------------------- the Billing tab --- */

const T = (iso: string) => Math.floor(Date.parse(`${iso}T15:00:00Z`) / 1000);
const inv = (id: string, o: Partial<StripeInvoice> = {}): StripeInvoice => ({
  id, customer: "cus_a", subscription: "sub_a", status: "paid", attemptCount: 1, nextAttempt: null, amountDue: 750, amountRemaining: 0, created: T("2026-09-01"),
  number: id.toUpperCase(), url: "https://invoice.stripe.com/i/x", total: 750, amountPaid: 750, pdf: "https://pay.stripe.com/x", paidAt: T("2026-09-01"),
  periodStart: null, periodEnd: null, ...o,
});
const ch = (id: string, invoice: string, o: Partial<StripeCharge> = {}): StripeCharge => ({
  id, customer: "cus_a", status: "succeeded", amount: 750, refunded: 0, created: T("2026-09-01"), subscription: "sub_a", failureMessage: null,
  card: "Visa •••• 4242", hasReceipt: true, invoice, ...o,
});
const snap: AccountSnapshot = {
  customers: [{ id: "cus_a", name: "Acme Realty", email: null, created: T("2026-01-01") }],
  subscriptions: [{ id: "sub_a", customer: "cus_a", status: "active", created: T("2026-01-01"), canceledAt: null, pause: null, periodEnd: T("2026-10-30"), items: [{ amount: 750, interval: "day", intervalCount: 14, quantity: 1, product: null }], percentOff: 0, osClientId: null }],
  charges: [
    ch("ch_full", "in_full"),
    ch("ch_part", "in_part", { refunded: 250 }),
    ch("ch_cn", "in_cn"),
    ch("ch_done", "in_done", { refunded: 750 }),
  ],
  invoices: [
    inv("in_full"),
    inv("in_part"),
    inv("in_cn", { creditedAfterPayment: 100 }),
    inv("in_done"),
    inv("in_open", { status: "open", amountPaid: 0, amountRemaining: 750, paidAt: null }),
    inv("in_oob", { status: "paid" }), // paid outside Stripe: no charge to give back to
    inv("in_zero", { total: 0, amountDue: 0, amountPaid: 0 }),
  ],
  refunds: [
    { id: "re_part", charge: "ch_part", amount: 250, created: T("2026-09-05"), status: "succeeded", reason: "requested_by_customer" },
    { id: "re_done", charge: "ch_done", amount: 750, created: T("2026-09-06"), status: "succeeded", reason: null },
  ],
  creditNotes: [
    { id: "cn_part", number: "IN_PART-CN-01", invoice: "in_part", created: T("2026-09-05"), amount: 250, pdf: null, refunds: ["re_part"], by: "eddy@brokerstaffer.com", reason: "product_unsatisfactory" },
  ],
};
const d = clientBillingDetail([{ id: "a", name: "Acme Realty", stripeCustomerId: "cus_a", stripeSubscriptionId: "sub_a" }], snap, [], "a")!;
const row = (id: string) => d.invoices.find((i) => i.id === id)!;

test("what each invoice can still give back — a Refund button only where there is a payment and money left", () => {
  assert.deepEqual(
    ["in_full", "in_part", "in_cn", "in_done", "in_open", "in_oob", "in_zero"].map((id) => [id, row(id).refundable]),
    [["in_full", 750], ["in_part", 500], ["in_cn", 650], ["in_done", 0], ["in_open", 0], ["in_oob", 0], ["in_zero", 0]],
  );
  assert.equal(row("in_full").card, "Visa •••• 4242", "where the money goes back to");
  assert.equal(row("in_oob").card, null);
  assert.deepEqual([givenBack(row("in_part")), givenBack(row("in_cn")), givenBack(row("in_done"))], ["$250.00 refunded", "$100.00 credited", "$750.00 refunded"]);
});

test("the history says who refunded from the OS and the credit note's number; a refund made in Stripe says neither", () => {
  const part = d.history.find((h) => h.id === "re_part")!;
  assert.deepEqual([part.by, part.creditNote], ["eddy@brokerstaffer.com", "IN_PART-CN-01"]);
  assert.equal(part.note, "Service issue", "the reason picked in the OS — not Stripe's 'requested by customer' for the refund");
  const done = d.history.find((h) => h.id === "re_done")!;
  assert.deepEqual([done.by, done.creditNote], [null, null]);
  assert.equal(done.note, null, "a refund made in Stripe without a reason says none");
});

test("a snapshot read before credit notes were fetched still works", () => {
  const { creditNotes: _c, ...old } = snap;
  const o = clientBillingDetail([{ id: "a", name: "Acme Realty", stripeCustomerId: "cus_a", stripeSubscriptionId: "sub_a" }], old, [], "a")!;
  assert.equal(o.history.find((h) => h.id === "re_part")!.by, null);
  assert.equal(o.invoices.find((i) => i.id === "in_part")!.refundable, 500, "the charge's refunds still count");
});

/* ------------------------------------------------------------ the route --- */

test("the route: the Billing tab's people only (a bare 404), own page only, the client's own paid invoice as Stripe has it now, then Stripe", () => {
  const src = readFileSync("src/app/api/workspace/clients/billing/refund/route.ts", "utf8");
  assert.doesNotMatch(src, /export async function (GET|PUT|PATCH|DELETE)/, "POST only");
  const at = (s: string) => { const i = src.indexOf(s); assert.ok(i > 0, s); return i; };
  const order = [
    "await billingTabUser(request)", "fromOwnPage(request)", "refundRequest.safeParse(", "stripeKey()", "liveRefundRefusal(key,",
    "getClientBillingDetail(r.clientId)", "detail.invoices.find(", "await invoiceNow(", "checkRefundable(now", "previewRefund(", "issueRefund(", "getStripeSnapshot.invalidate();\n    console.log(`[billing] ${who.email} refunded",
  ];
  for (let i = 1; i < order.length; i++) assert.ok(at(order[i - 1]) < at(order[i]), `${order[i - 1]} before ${order[i]}`);
  assert.match(src, /if \(!r\.preview\) \{\s*const refusal = liveRefundRefusal\(key, /, "a live refund only on Railway, asked on the site");
  assert.match(src, /if \(!row\.card\) throw new RefundError/, "only an invoice with a payment to give back to");
  assert.doesNotMatch(src, /billingUser\(/, "not the wider Clients-page gate");
  assert.match(src, /console\.log\(`\[billing\] \$\{who\.email\} refunded/, "every refund is logged with who did it");
  // The tab's one write goes only here.
  const dlg = readFileSync("src/components/screens/client-billing-refund.tsx", "utf8");
  assert.equal((dlg.match(/fetch\(/g) ?? []).length, 1);
  assert.match(dlg, /fetch\("\/api\/workspace\/clients\/billing\/refund"/);
  assert.match(dlg, /const \[emailClient, setEmailClient\] = useState\(false\)/, "the email box starts unticked");
  assert.match(dlg, /const key = crypto\.randomUUID\(\);[\s\S]*setStep\(\{ at: "confirm", key, cents, stripeCents: /, "one key per confirmation, made at Review");
});
