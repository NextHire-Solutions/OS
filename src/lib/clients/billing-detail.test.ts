import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { BILLING_TAB_PEOPLE, canSeeBillingTab } from "./billing-access.ts";
import { csvText } from "./billing-csv.ts";
import { buildBilling, clientBillingDetail, lineText, type AccountSnapshot, type StripeCharge, type StripeInvoice, type StripeSubscription } from "./billing-model.ts";

/*
 * The Billing tab (Eddy, 17 Oct): one client's current billing, total billed,
 * history with failed payments and refunds, and invoices — by the same
 * ownership rules as everything else that counts a client's money.
 */

const T = (iso: string) => Math.floor(Date.parse(`${iso}T15:00:00Z`) / 1000);
const sub = (id: string, customer: string, amount: number, created: string, o: Partial<StripeSubscription> = {}): StripeSubscription => ({
  id, customer, status: "active", created: T(created), canceledAt: null, pause: null, periodEnd: T("2026-10-24"),
  items: [{ amount, interval: "day", intervalCount: 14, quantity: 1, product: "prod_rs" }], percentOff: 0, osClientId: null, ...o,
});
const charge = (id: string, customer: string, amount: number, created: string, subscription: string | null = null, o: Partial<StripeCharge> = {}): StripeCharge =>
  ({ id, customer, status: "succeeded", amount, refunded: 0, created: T(created), subscription, failureMessage: null, card: "Visa •••• 4242", hasReceipt: true, ...o });
const invoice = (id: string, customer: string, subscription: string | null, amount: number, created: string, o: Partial<StripeInvoice> = {}): StripeInvoice => ({
  id, customer, subscription, status: "paid", attemptCount: 1, nextAttempt: null, amountDue: amount, amountRemaining: 0, created: T(created),
  number: id.toUpperCase(), url: `https://invoice.stripe.com/i/${id}`, total: amount, amountPaid: amount, pdf: `https://pay.stripe.com/invoice/${id}/pdf`,
  paidAt: T(created), periodStart: T(created), periodEnd: T(created) + 14 * 86_400,
  description: `1 × RECRUITING SERVICES (at $${amount}.00 / every 14 days)`, ...o,
});

// Raintown + JPAR share one card: one subscription each, Raintown on it first.
// 54 Realty has paid through two cards. Discount Co is 20% off; Paused Co is paused; Gone Co cancelled.
const snap: AccountSnapshot = {
  customers: [
    { id: "cus_rj", name: "Raintown Realty + JPAR", email: null, created: T("2026-03-11") },
    { id: "cus_54a", name: "54 Realty LLC (1st Card)", email: null, created: T("2026-02-27") },
    { id: "cus_54b", name: "54 Realty LLC", email: null, created: T("2026-08-06") },
    { id: "cus_disc", name: "Discount Co", email: null, created: T("2026-06-01") },
    { id: "cus_pause", name: "Paused Co", email: null, created: T("2026-06-01") },
    { id: "cus_gone", name: "Gone Co", email: null, created: T("2026-06-01") },
  ],
  subscriptions: [
    sub("sub_rt", "cus_rj", 750, "2026-05-28"),
    sub("sub_jpar", "cus_rj", 500, "2026-09-14"),
    sub("sub_54", "cus_54b", 750, "2026-08-06"),
    sub("sub_disc", "cus_disc", 1000, "2026-06-01", { percentOff: 20, items: [{ amount: 1000, interval: "month", intervalCount: 1, quantity: 1, product: "prod_min" }] }),
    sub("sub_pause", "cus_pause", 500, "2026-06-01", { pause: { behavior: "void", resumesAt: T("2026-11-02") } }),
    sub("sub_gone", "cus_gone", 500, "2026-06-01", { status: "canceled", canceledAt: T("2026-09-01") }),
  ],
  charges: [
    charge("ch_rt1", "cus_rj", 1, "2026-03-11", null, { description: "Card Verification - Tier Production" }),  // one-off → Raintown (first on the card)
    charge("ch_rt2", "cus_rj", 750, "2026-06-11", "sub_rt", { invoice: "in_rt2", refunded: 100 }),
    charge("ch_rt3", "cus_rj", 750, "2026-06-25", "sub_rt", { invoice: "in_rt3" }),
    charge("ch_jp1", "cus_rj", 500, "2026-09-14", "sub_jpar", { invoice: "in_jp1" }),
    charge("ch_jp2", "cus_rj", 500, "2026-09-28", "sub_jpar", { invoice: "in_jpfail", status: "failed", failureMessage: "Your card has insufficient funds.", hasReceipt: false }),
    charge("ch_54a", "cus_54a", 750, "2026-04-14", null, { description: "Subscription creation" }),
    charge("ch_54b", "cus_54b", 750, "2026-08-06", "sub_54", { invoice: "in_54" }),
    charge("ch_pay", "cus_pause", 500, "2026-07-01", "sub_pause", { status: "pending", hasReceipt: false }),
  ],
  invoices: [
    invoice("in_rt2", "cus_rj", "sub_rt", 750, "2026-06-11"),
    invoice("in_rt3", "cus_rj", "sub_rt", 750, "2026-06-25"),
    invoice("in_jp1", "cus_rj", "sub_jpar", 500, "2026-09-14"),
    invoice("in_jpfail", "cus_rj", "sub_jpar", 500, "2026-09-28", { status: "open", attemptCount: 3, amountPaid: 0, amountRemaining: 500, paidAt: null }),
    invoice("in_rtoff", "cus_rj", null, 250, "2026-04-01"),                       // no subscription, shared card → Raintown
    invoice("in_54", "cus_54b", "sub_54", 750, "2026-08-06"),
    invoice("in_draft", "cus_54b", "sub_54", 750, "2026-10-20", { status: "draft", number: null, url: null, pdf: null, amountPaid: 0, paidAt: null }),
    invoice("in_disc", "cus_disc", "sub_disc", 800, "2026-10-01", { status: "open", attemptCount: 0, amountPaid: 0, amountRemaining: 800, paidAt: null }),
  ],
  refunds: [
    { id: "re_rt2", charge: "ch_rt2", amount: 100, created: T("2026-06-12"), status: "succeeded", reason: "duplicate" },
    { id: "re_other", charge: "ch_nobody", amount: 50, created: T("2026-06-12"), status: "succeeded", reason: null },
  ],
  products: [{ id: "prod_rs", name: "RECRUITING SERVICES" }, { id: "prod_min", name: "Recruiting Services - Minimum Tier" }],
  readAt: 1_792_000_000_000,
};
const clients = [
  { id: "rt", name: "Raintown Realty", stripeCustomerId: "cus_rj", stripeSubscriptionId: "sub_rt" },
  { id: "jp", name: "JPAR Iron Horse Real Estate", stripeCustomerId: "cus_rj", stripeSubscriptionId: "sub_jpar" },
  { id: "c54", name: "54 Realty", stripeCustomerId: "cus_54b", stripeSubscriptionId: "sub_54" },
  { id: "disc", name: "Discount Co", stripeCustomerId: "cus_disc", stripeSubscriptionId: "sub_disc" },
  { id: "pause", name: "Paused Co", stripeCustomerId: "cus_pause", stripeSubscriptionId: "sub_pause" },
  { id: "gone", name: "Gone Co", stripeCustomerId: "cus_gone", stripeSubscriptionId: "sub_gone" },
  { id: "none", name: "Brand New Client", stripeCustomerId: null, stripeSubscriptionId: null },
];
const detail = (id: string) => clientBillingDetail(clients, snap, [], id)!;

test("total billed is the client's Total spend to the cent, for every client", () => {
  const all = buildBilling(clients, snap, []);
  for (const c of clients) {
    const d = detail(c.id);
    assert.equal(d.totals.net, all.get(c.id)!.totalSpend, c.name);
    assert.equal(d.totals.payments, all.get(c.id)!.transactions, c.name);
  }
  const rt = detail("rt").totals;
  assert.deepEqual([rt.charged, rt.refunded, rt.net], [1501, 100, 1401]);
  assert.equal(rt.firstPayment, "2026-03-11");
  assert.deepEqual(rt.lastPayment, { date: "2026-06-25", amount: 750 });
});

test("a shared card: each client sees only its own payments, failed payments and invoices", () => {
  const rt = detail("rt"), jp = detail("jp");
  assert.deepEqual(rt.history.filter((h) => h.kind !== "refund").map((h) => h.id), ["ch_rt3", "ch_rt2", "ch_rt1"]);
  assert.deepEqual(jp.history.map((h) => h.id), ["ch_jp2", "ch_jp1"]);
  assert.deepEqual(rt.invoices.map((i) => i.id), ["in_rt3", "in_rt2", "in_rtoff"], "the card's invoice without a subscription is the first client's");
  assert.deepEqual(jp.invoices.map((i) => i.id), ["in_jpfail", "in_jp1"]);
  assert.equal(jp.totals.failed, 1);
  assert.equal(rt.totals.failed, 0);
});

test("54 Realty: payments through every card it has used", () => {
  const d = detail("c54");
  assert.deepEqual(d.history.map((h) => h.id), ["ch_54b", "ch_54a"]);
  assert.equal(d.totals.net, 1500);
});

test("a failed payment says why, has no receipt, and makes the payment status Payment failed", () => {
  const jp = detail("jp");
  const failed = jp.history.find((h) => h.id === "ch_jp2")!;
  assert.equal(failed.kind, "failed");
  assert.equal(failed.note, "Your card has insufficient funds.");
  assert.equal(failed.receipt, false);
  assert.equal(failed.invoiceNumber, "IN_JPFAIL");
  assert.equal(jp.now!.state, "failed");
  assert.equal(jp.now!.tone, "bad");
  assert.equal(jp.now!.unpaid, 500);
  assert.equal(jp.totals.unpaid, 500);
  const inv = jp.invoices[0];
  assert.deepEqual([inv.label, inv.tone, inv.paid, inv.remaining, inv.attempts], ["Payment failed", "bad", 0, 500, 3]);
});

test("refunds: their own row on the refund's date with the reason; the payment says it was refunded; another client's refund is not shown", () => {
  const rt = detail("rt");
  const r = rt.history.find((h) => h.kind === "refund")!;
  assert.deepEqual([r.id, r.date, r.amount, r.note, r.chargeId, r.receipt], ["re_rt2", "2026-06-12", 100, "Duplicate payment", "ch_rt2", false]);
  assert.equal(rt.history.find((h) => h.id === "ch_rt2")!.note, "$100.00 refunded");
  assert.equal(rt.history.filter((h) => h.kind === "refund").length, 1);
  assert.ok(!clients.some((c) => detail(c.id).history.some((h) => h.id === "re_other")));
});

test("a snapshot read before refunds were fetched still works: no refund rows, the payment still says refunded", () => {
  const { refunds: _r, products: _p, readAt: _t, ...old } = snap;
  const d = clientBillingDetail(clients, old, [], "rt")!;
  assert.equal(d.history.filter((h) => h.kind === "refund").length, 0);
  assert.equal(d.history.find((h) => h.id === "ch_rt2")!.note, "$100.00 refunded");
  assert.equal(d.now!.product, null);
  assert.equal(d.readAt, null);
  assert.equal(d.totals.net, 1401);
});

test("current billing: plan product, amount after discount, frequency, next billing date, payment status", () => {
  const rt = detail("rt").now!;
  assert.deepEqual([rt.subscriptionId, rt.product, rt.amount, rt.listAmount, rt.every, rt.nextBilling, rt.state, rt.tone],
    ["sub_rt", "RECRUITING SERVICES", 750, null, "every 14 days", "2026-10-24", "paid", "good"]);
  const disc = detail("disc").now!;
  assert.deepEqual([disc.product, disc.amount, disc.listAmount, disc.percentOff, disc.every, disc.state, disc.due],
    ["Recruiting Services - Minimum Tier", 800, 1000, 20, "every month", "open", 800]);
  assert.equal(detail("disc").invoices[0].label, "Open");
});

test("paused shows the day collection resumes; cancelled shows no next billing; a client with nothing in Stripe has nothing", () => {
  const p = detail("pause").now!;
  assert.deepEqual([p.state, p.tone, p.nextBilling], ["paused", "warn", "2026-11-02"]);
  assert.equal(detail("pause").history[0].kind, "pending");
  assert.equal(detail("pause").history[0].note, "Processing");
  const g = detail("gone").now!;
  assert.deepEqual([g.state, g.nextBilling, g.canceled], ["cancelled", null, "2026-09-01"]);
  const n = detail("none");
  assert.equal(n.now, null);
  assert.deepEqual([n.history.length, n.invoices.length, n.totals.net, n.subscriptions], [0, 0, 0, 0]);
  assert.equal(clientBillingDetail(clients, snap, [], "not-a-client"), null);
});

test("invoices: number, period, paid on, view and PDF — a draft can be neither viewed nor downloaded", () => {
  const d = detail("c54");
  const [draft, paid] = d.invoices;
  assert.deepEqual([draft.id, draft.label, draft.page, draft.pdf], ["in_draft", "Draft", false, false]);
  assert.deepEqual([paid.number, paid.label, paid.total, paid.paid, paid.paidOn, paid.periodStart, paid.page, paid.pdf],
    ["IN_54", "Paid", 750, 750, "2026-08-06", "2026-08-06", true, true]);
  assert.equal(paid.description, "RECRUITING SERVICES (at $750.00 / every 14 days)");
});

test("descriptions: the invoice's line without '1 × ', else the charge's own words", () => {
  const rt = detail("rt");
  assert.equal(rt.history.find((h) => h.id === "ch_rt3")!.description, "RECRUITING SERVICES (at $750.00 / every 14 days)");
  assert.equal(rt.history.find((h) => h.id === "ch_rt1")!.description, "Card Verification - Tier Production");
  assert.equal(lineText("2 × Seats"), "2 × Seats");
  assert.equal(lineText("  "), null);
});

test("the CSV: numbers stay numbers, text a spreadsheet would run is made text, quotes and commas are escaped", () => {
  const out = csvText(["Date", "Note", "Amount"], [["2026-10-01", '=HYPERLINK("x")', -750], ["2026-10-02", "a, b", 12.5], ["2026-10-03", null, 0]]);
  assert.equal(out, 'Date,Note,Amount\r\n2026-10-01,"\'=HYPERLINK(""x"")",-750\r\n2026-10-02,"a, b",12.5\r\n2026-10-03,,0');
  assert.equal(csvText(["x"], [["-1 refund"], ["@me"], ["+1"]]), "x\r\n'-1 refund\r\n'@me\r\n'+1");
});

/* ------------------------------------------------------------ the routes --- */

test("the Billing tab's read routes are read-only, the named people only, and open only the client's own documents on stripe.com", () => {
  const history = readFileSync("src/app/api/workspace/clients/billing/history/route.ts", "utf8");
  const doc = readFileSync("src/app/api/workspace/clients/billing/document/route.ts", "utf8");
  for (const [name, src] of [["history", history], ["document", doc]] as const) {
    assert.doesNotMatch(src, /export async function (POST|PUT|PATCH|DELETE)/, `${name} only reads`);
    assert.ok(src.indexOf("billingTabUser(") > 0 && src.indexOf("billingTabUser(") < src.indexOf("getClientBillingDetail("), `${name} checks who first`);
    assert.doesNotMatch(src, /billingUser\(/, `${name} does not use the wider Clients-page gate`);
  }
  // The document route: the client's own document, checked BEFORE Stripe is asked, and only a stripe.com link is followed.
  assert.ok(doc.indexOf("const owned") < doc.indexOf("stripeGet("), "ownership before the Stripe read");
  assert.match(doc, /if \(!owned\) return say\(404/);
  assert.match(doc, /\^https:\\\/\\\/\(\[a-z0-9-\]\+\\\.\)\*stripe\\\.com\\\//);
  assert.match(doc, /\^\(in\|ch\)_\[A-Za-z0-9\]\{6,\}\$/, "the id is checked before it is put in a Stripe URL");
  // The Stripe control's route uses the same gate (moved, not changed).
  const control = readFileSync("src/app/api/workspace/clients/billing/route.ts", "utf8");
  assert.equal((control.match(/await billingUser\(request\)/g) ?? []).length, 2, "GET and POST both gated");
  const gate = readFileSync("src/lib/clients/billing-user.ts", "utf8");
  assert.match(gate, /!v\.admin && !sessionPageGrants\(s, v\)\.includes\("roster"\)/);
  // The tab itself never writes; its one write is the Refund dialog (22 Oct, billing-refund.test.ts).
  const tab = readFileSync("src/components/screens/client-billing.tsx", "utf8");
  assert.doesNotMatch(tab, /method:\s*"(POST|PUT|PATCH|DELETE)"/);
});

test("the snapshot's Stripe reads are all GETs, and the new lists cannot take billing down", () => {
  const src = readFileSync("src/lib/clients/billing-account.ts", "utf8");
  assert.match(src, /all<RawRefund>\("refunds"\)\.catch\(\(\) => null\)/);
  assert.match(src, /all<\{ id: string; name: string \}>\("products"\)\.catch\(\(\) => null\)/);
  assert.doesNotMatch(src, /method:\s*"POST"/);
});

/* ------------------------------------------- who sees the tab (19 Oct) --- */

test("the Billing tab: admin@outreachify.io, Eddy and Amy, by name — nobody else, not even another Owner", () => {
  assert.deepEqual([...BILLING_TAB_PEOPLE], ["admin@outreachify.io", "eddy@brokerstaffer.com", "amy@brokerstaffer.com"], "exactly these people, changed only on the user's word (Amy added 20 Oct)");
  assert.equal(canSeeBillingTab("Amy@BrokerStaffer.com"), true);
  assert.equal(canSeeBillingTab("admin@outreachify.io"), true);
  assert.equal(canSeeBillingTab("  Admin@Outreachify.io "), true, "case and spaces do not matter");
  assert.equal(canSeeBillingTab("eddy@brokerstaffer.com"), true);
  assert.equal(canSeeBillingTab("Eddy@BrokerStaffer.com"), true);
  for (const who of ["amy@brokerstaffer.co", "amy.anderes@brokerstaffer.com", "bharati@outreachify.io", "owner2@outreachify.io", "admin@outreachify.io.evil.com", "xadmin@outreachify.io", "eddy@brokerstaffer.co", "", null, undefined]) {
    assert.equal(canSeeBillingTab(who), false, String(who));
  }
  const src = readFileSync("src/lib/clients/billing-access.ts", "utf8");
  assert.doesNotMatch(src, /adminEmails|ADMIN_EMAILS\)|isAdmin|is_admin|grants|roster/, "no list, role or switch can widen it");
});

test("the gate is decided on the server: the route answers a bare 404, the page passes the flag, the record draws the tab only with it", () => {
  const gate = readFileSync("src/lib/clients/billing-user.ts", "utf8");
  assert.match(gate, /if \(!s\?\.email \|\| !canSeeBillingTab\(s\.email\)\) return new NextResponse\(null, \{ status: 404 \}\);/);
  const page = readFileSync("src/app/[[...slug]]/page.tsx", "utf8");
  assert.match(page, /<ClientsScreen initial=\{clientsOverview\} billingTab=\{canSeeBillingTab\(email\)\} \/>/);
  const rec = readFileSync("src/components/screens/client-record.tsx", "utf8");
  assert.match(rec, /TABS\.filter\(\(t\) => t\.id !== "billing" \|\| billingTab\)/, "the tab button only with the flag");
  assert.match(rec, /\{tab === "billing" && billingTab \? \(/, "the tab's content only with the flag");
  assert.equal((rec.match(/<ClientBillingTab /g) ?? []).length, 1, "drawn in one place");
  assert.match(rec, /cat === "billing" && billingTab \? \(/, "the Record tab's pointer only with the flag");
  assert.match(rec, /\{cat === "billing" \? <BillingControl clientId=\{c\.id\}/, "without the flag the Stripe control stays on the Record tab");
  assert.match(rec, /setTab\(k\.tab === "billing" && !billingTab \? "record" : k\.tab\)/, "Fix → never opens a tab the viewer does not have");
  const list = readFileSync("src/components/screens/clients.tsx", "utf8");
  assert.match(list, /billingTab = false/, "off unless the page says so");
});
