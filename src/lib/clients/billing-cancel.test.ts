import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { BILLING_TAB_PEOPLE, CANCEL_SUBSCRIPTION_PEOPLE, canCancelSubscriptions } from "./billing-access.ts";
import {
  cancelCall, cancelComment, CancelError, cancelRequest, landed, liveCancelRefusal, planCancel, sendCancel, stripeRefusal, subscriptionFrom, subscriptionNow,
  type CancelRequest, type SubscriptionNow,
} from "./billing-cancel.ts";
import { billingTotals, buildBilling, clientBillingDetail, upcomingCharges, type AccountSnapshot } from "./billing-model.ts";

/*
 * Cancelling a subscription from the Billing tab (27 Oct). Stripe is never
 * called here — a fake fetch stands in. The real calls were proven in Stripe's
 * TEST mode only — never on a real subscription.
 */

const KEY = "11111111-2222-4333-8444-555555555555";
const CLIENT = "00ef116c-646d-43b4-a323-680548ea7126";
const SUB = "sub_1TestAbCdEfGh";
const ask = (o: Partial<CancelRequest> = {}): CancelRequest =>
  cancelRequest.parse({ clientId: CLIENT, subscriptionId: SUB, action: "cancel", when: "end", key: KEY, preview: false, ...o });
const sub = (o: Partial<SubscriptionNow> = {}): SubscriptionNow =>
  ({ id: SUB, status: "active", cancelAtPeriodEnd: false, cancelAt: null, canceledAt: null, periodEnd: 1_800_000_000, cancelledBy: null, ...o });

test("Eddy and Amy only — not the rest of the Billing tab, not anyone else", () => {
  assert.deepEqual([...CANCEL_SUBSCRIPTION_PEOPLE], ["eddy@brokerstaffer.com", "amy@brokerstaffer.com"], "exactly these two (the user, 27 Oct)");
  for (const who of CANCEL_SUBSCRIPTION_PEOPLE) assert.ok(BILLING_TAB_PEOPLE.includes(who), `${who} is also on the Billing tab, so its by-name account protection covers them`);
  assert.equal(canCancelSubscriptions("Eddy@BrokerStaffer.com "), true);
  assert.equal(canCancelSubscriptions("amy@brokerstaffer.com"), true);
  for (const who of ["admin@outreachify.io", "automation@outreachify.io", "ryan@brokerstaffer.com", "eddy@brokerstaffer.com.evil.com", "", null, undefined]) {
    assert.equal(canCancelSubscriptions(who), false, String(who));
  }
});

test("the route: a bare 404 off the Billing tab, 403 for its other people, only from the OS's own page, live only from os.brokerstaffer.com", () => {
  const src = readFileSync("src/app/api/workspace/clients/billing/cancel/route.ts", "utf8");
  const order = ["billingTabUser(request)", "canCancelSubscriptions(who.email)", "fromOwnPage(request)", "cancelRequest.safeParse", "liveCancelRefusal(", "getClientBillingDetail(", "subscriptionNow(", "planCancel(", "sendCancel("];
  let at = -1;
  for (const s of order) {
    const i = src.indexOf(s);
    assert.ok(i > at, `${s} comes after the checks before it`);
    at = i;
  }
  assert.match(src, /if \(!canCancelSubscriptions\(who\.email\)\) return say\(403,/);
  assert.match(src, /detail\.now\?\.subscriptionId !== r\.subscriptionId/, "only the client's current subscription");
  assert.match(src, /if \(!r\.preview\) \{\s*const refusal = liveCancelRefusal/, "the live guard runs before any real change");
  // The tab learns whether to show the buttons from the server, never from the browser.
  const history = readFileSync("src/app/api/workspace/clients/billing/history/route.ts", "utf8");
  assert.match(history, /canCancel: canCancelSubscriptions\(who\.email\)/);
});

test("a live key changes a subscription only on Railway and only when asked from os.brokerstaffer.com", () => {
  const site = "https://os.brokerstaffer.com";
  assert.equal(liveCancelRefusal("sk_test_x", {}, null, site), null, "test mode anywhere");
  assert.match(liveCancelRefusal("sk_live_x", {}, site, site)!, /only from os\.brokerstaffer\.com/, "a laptop, even asked from the site's origin");
  assert.match(liveCancelRefusal("rk_live_x", { RAILWAY_ENVIRONMENT_NAME: "production" }, "http://localhost:3000", site)!, /only from/);
  assert.equal(liveCancelRefusal("sk_live_x", { RAILWAY_ENVIRONMENT_NAME: "production" }, site, site), null);
});

test("the request is read strictly", () => {
  assert.equal(cancelRequest.safeParse({ ...ask(), subscriptionId: "sub_1; DROP" }).success, false);
  assert.equal(cancelRequest.safeParse({ ...ask(), subscriptionId: "in_1TestAbCdEfGh" }).success, false, "a subscription id, nothing else");
  assert.equal(cancelRequest.safeParse({ ...ask(), when: "tomorrow" }).success, false);
  assert.equal(cancelRequest.safeParse({ ...ask(), action: "delete" }).success, false);
  assert.equal(cancelRequest.safeParse({ ...ask(), key: "x" }).success, false);
  assert.equal(cancelRequest.parse({ clientId: CLIENT, subscriptionId: SUB, action: "cancel", key: KEY, preview: true }).when, "end", "the end of the period unless asked otherwise");
  assert.equal(cancelRequest.safeParse({ clientId: CLIENT, subscriptionId: SUB, action: "cancel", key: KEY }).success, false, "preview must be said — a request that does not say is refused, never taken as 'do it'");
});

test("what happens, as Stripe has the subscription now", () => {
  assert.deepEqual(planCancel(sub(), "cancel", "end"), { kind: "send", endsAt: 1_800_000_000 });
  assert.deepEqual(planCancel(sub(), "cancel", "now"), { kind: "send", endsAt: null });
  assert.equal(planCancel(sub({ cancelAtPeriodEnd: true, cancelAt: 1_800_000_000 }), "cancel", "end").kind, "done", "already set: answered, not asked again");
  assert.equal(planCancel(sub({ cancelAt: 1_790_000_000 }), "cancel", "end").kind, "done", "a cancel date set in Stripe's dashboard counts too");
  assert.equal(planCancel(sub({ cancelAtPeriodEnd: true }), "cancel", "now").kind, "send", "set for later, stopped now on purpose");
  assert.equal(planCancel(sub({ status: "canceled", canceledAt: 1_700_000_000 }), "cancel", "now").kind, "done");
  assert.equal(planCancel(sub({ status: "incomplete_expired" }), "cancel", "end").kind, "done");
  assert.throws(() => planCancel(sub({ status: "incomplete", periodEnd: null }), "cancel", "end"), (e: unknown) => e instanceof CancelError && e.status === 409 && /immediately instead/.test(e.message));
  assert.throws(() => planCancel(sub({ status: "paused" }), "cancel", "end"), /no paid period/);
  assert.equal(planCancel(sub({ status: "past_due" }), "cancel", "end").kind, "send", "past due still has a period");
  // Keep
  assert.deepEqual(planCancel(sub({ cancelAtPeriodEnd: true, cancelAt: 1_800_000_000 }), "keep", "end"), { kind: "send", endsAt: null });
  assert.equal(planCancel(sub(), "keep", "end").kind, "done", "nothing set: nothing to take back");
  assert.throws(() => planCancel(sub({ status: "canceled" }), "keep", "end"), /already ended/);
});

test("what Stripe is sent: who did it on the subscription; immediately stops with no invoice and no proration", () => {
  const end = cancelCall(ask(), "eddy@brokerstaffer.com");
  assert.equal(end.method, "POST");
  assert.equal(end.path, `subscriptions/${SUB}`);
  assert.equal(end.form.get("cancel_at_period_end"), "true");
  assert.equal(end.form.get("metadata[os_cancel_by]"), "eddy@brokerstaffer.com");
  assert.equal(end.form.get("metadata[os_cancel_key]"), KEY);
  assert.equal(end.form.get("metadata[os_cancel_client]"), CLIENT);
  assert.equal(end.form.get("metadata[os_client_id]"), null, "never os_client_id — that key moves the subscription's ownership (audit, 27 Oct)");
  assert.equal(end.form.get("cancellation_details[comment]"), cancelComment("eddy@brokerstaffer.com", "end"));
  assert.match(cancelComment("amy@brokerstaffer.com", "now"), /immediately from the BrokerStaffer OS by amy@brokerstaffer\.com/);

  const now = cancelCall(ask({ when: "now" }), "amy@brokerstaffer.com");
  assert.equal(now.method, "DELETE");
  assert.equal(now.form.get("invoice_now"), "false");
  assert.equal(now.form.get("prorate"), "false");
  assert.equal(now.form.get("cancel_at_period_end"), null);

  const keep = cancelCall(ask({ action: "keep" }), "amy@brokerstaffer.com");
  assert.equal(keep.method, "POST");
  assert.equal(keep.form.get("cancel_at_period_end"), "false");
  assert.equal(keep.form.get("metadata[os_cancel_by]"), "", "the scheduled cancellation's marks are cleared");
  assert.equal(keep.form.get("metadata[os_kept_by]"), "amy@brokerstaffer.com");
  assert.equal(keep.form.get("metadata[os_cancel_client]"), "");
  assert.equal(keep.form.get("cancel_at"), null, "Stripe refuses cancel_at beside cancel_at_period_end; the latter clears a custom date too (TEST mode)");
});

test("one key per confirmation goes to Stripe as the Idempotency-Key; Stripe's own errors come back in its words", async () => {
  const seen: Array<{ url: string; method: string; idem: string | null; body: string }> = [];
  const f = (async (url: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    seen.push({ url, method: init?.method ?? "GET", idem: h.get("Idempotency-Key"), body: String(init?.body ?? "") });
    if (String(init?.body).includes("cancel_at_period_end=true")) {
      return new Response(JSON.stringify({ id: SUB, status: "active", cancel_at_period_end: true, cancel_at: 1_800_000_000, items: { data: [{ current_period_end: 1_800_000_000 }] }, metadata: { os_cancel_by: "eddy@brokerstaffer.com" } }));
    }
    return new Response(JSON.stringify({ error: { message: "No such subscription: 'sub_x'" } }), { status: 400 });
  }) as typeof fetch;
  const after = await sendCancel("sk_test_x", ask(), "eddy@brokerstaffer.com", f);
  assert.equal(after.cancelAtPeriodEnd, true);
  assert.equal(after.cancelAt, 1_800_000_000);
  assert.equal(after.cancelledBy, "eddy@brokerstaffer.com");
  assert.equal(seen[0].idem, `os-sub-cancel-end-${KEY}`);
  assert.equal(seen[0].method, "POST");
  await assert.rejects(sendCancel("sk_test_x", ask({ when: "now" }), "eddy@brokerstaffer.com", f), (e: unknown) => e instanceof CancelError && e.status === 409 && /No such subscription/.test(e.message));
  assert.equal(seen[1].idem, `os-sub-cancel-now-${KEY}`, "a different choice is a different request");
  assert.equal(seen[1].method, "DELETE");
});

test("reading a subscription: the period end from its item (Stripe's newer shape) or the subscription; a 404 says so", async () => {
  assert.equal(subscriptionFrom({ id: SUB, status: "active", items: { data: [{ current_period_end: 5 }] }, current_period_end: 9 }).periodEnd, 5);
  assert.equal(subscriptionFrom({ id: SUB, status: "active", current_period_end: 9 }).periodEnd, 9);
  assert.equal(subscriptionFrom({ id: SUB, status: "trialing", trial_end: 7 }).periodEnd, 7);
  const f = (async () => new Response(JSON.stringify({ error: { message: "No such subscription" } }), { status: 404 })) as typeof fetch;
  await assert.rejects(subscriptionNow("sk_test_x", SUB, f), (e: unknown) => e instanceof CancelError && e.status === 404);
});

test("the Billing tab shows a set cancellation: the day it stops (Eastern), and nothing after", () => {
  // 1_800_000_000 = 2027-01-15 08:00 UTC — 03:00 in New York, the same day.
  const snap: AccountSnapshot = {
    customers: [{ id: "cus_1", name: "Test Realty", email: null, created: 1_700_000_000 }],
    subscriptions: [{
      id: SUB, customer: "cus_1", status: "active", created: 1_700_000_000, canceledAt: null, pause: null, periodEnd: 1_800_000_000,
      cancelAt: 1_800_000_000, items: [{ amount: 750, interval: "day", intervalCount: 14, quantity: 1 }], percentOff: 0, osClientId: CLIENT,
    }],
    charges: [], invoices: [], products: [],
  };
  const clients = [{ id: CLIENT, name: "Test Realty", stripeCustomerId: "cus_1", stripeSubscriptionId: SUB }];
  const d = clientBillingDetail(clients, snap, [], CLIENT);
  assert.equal(d?.now?.cancelsOn, "2027-01-15");
  const plain = clientBillingDetail(clients, { ...snap, subscriptions: [{ ...snap.subscriptions[0], cancelAt: null }] }, [], CLIENT);
  assert.equal(plain?.now?.cancelsOn, null);
  const gone = clientBillingDetail(clients, { ...snap, subscriptions: [{ ...snap.subscriptions[0], status: "canceled", canceledAt: 1_790_000_000 }] }, [], CLIENT);
  assert.equal(gone?.now?.cancelsOn ?? null, null, "an ended subscription is cancelled, not set to cancel");
});

test("two confirmations racing: the second DELETE finds it ended — answered as cancelled, not as an error", async () => {
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (init?.method === "DELETE") return new Response(JSON.stringify({ error: { message: `No such subscription: '${SUB}'` } }), { status: 404 });
    return new Response(JSON.stringify({ id: SUB, status: "canceled", canceled_at: 1_790_000_000 }));
  }) as typeof fetch;
  const s = await sendCancel("sk_test_x", ask({ when: "now" }), "amy@brokerstaffer.com", f);
  assert.equal(s.status, "canceled");
  assert.deepEqual(calls.map((c) => c.split(" ")[0]), ["DELETE", "GET"], "re-read once, nothing else sent");
  // Still active after a failed DELETE: a real error.
  const g = (async (_url: string, init?: RequestInit) => init?.method === "DELETE"
    ? new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 })
    : new Response(JSON.stringify({ id: SUB, status: "active" }))) as typeof fetch;
  await assert.rejects(sendCancel("sk_test_x", ask({ when: "now" }), "amy@brokerstaffer.com", g), (e: unknown) => e instanceof CancelError && e.status === 502);
});

test("Stripe's refusals say nothing changed; only a server error or no answer is 'may have gone through'", () => {
  for (const st of [400, 402, 404]) assert.equal(stripeRefusal(st, "nope").status, 409);
  assert.match(stripeRefusal(429, undefined).message, /busy.*Nothing was changed/);
  assert.equal(stripeRefusal(429, undefined).status, 503);
  assert.equal(stripeRefusal(401, undefined).status, 503);
  assert.equal(stripeRefusal(500, "x").status, 502);
});

test("never 'done' unless Stripe now has it that way", () => {
  assert.equal(landed(sub({ cancelAtPeriodEnd: true, cancelAt: 1 }), { action: "cancel", when: "end" }), true);
  assert.equal(landed(sub(), { action: "cancel", when: "end" }), false);
  assert.equal(landed(sub({ status: "canceled" }), { action: "cancel", when: "now" }), true);
  assert.equal(landed(sub({ cancelAtPeriodEnd: true }), { action: "cancel", when: "now" }), false);
  assert.equal(landed(sub(), { action: "keep", when: "end" }), true);
  assert.equal(landed(sub({ cancelAt: 5 }), { action: "keep", when: "end" }), false, "a custom date still set is not kept");
});

test("forecasts stop at a set cancellation; lost MRR counts a subscription when it ENDS", () => {
  const T = (d: string) => Math.floor(Date.parse(`${d}T15:00:00Z`) / 1000);
  const base = { customer: "cus_1", created: T("2026-01-01"), pause: null, items: [{ amount: 1000, interval: "month", intervalCount: 1, quantity: 1 }], percentOff: 0, osClientId: CLIENT };
  const snap: AccountSnapshot = {
    customers: [{ id: "cus_1", name: "Test Realty", email: null, created: T("2026-01-01") }],
    subscriptions: [
      // set to cancel at its period end (Stripe stamped canceled_at when it was set)
      { ...base, id: "sub_setAAAAAAAA", status: "active", canceledAt: T("2026-10-27"), periodEnd: T("2026-11-10"), cancelAt: T("2026-11-10") },
      // ended within the window, though the cancellation was set long before
      { ...base, id: "sub_endedBBBBBB", status: "canceled", canceledAt: T("2026-08-01"), endedAt: T("2026-10-20"), periodEnd: T("2026-10-20") },
    ],
    charges: [], invoices: [], products: [],
  } as AccountSnapshot;
  const clients = [{ id: CLIENT, name: "Test Realty", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_setAAAAAAAA" }];
  const per = buildBilling(clients, snap, []);
  const now = Date.parse("2026-10-27T16:00:00Z");
  assert.deepEqual(upcomingCharges(snap, per, 60, now).filter((u) => u.subscription === "sub_setAAAAAAAA"), [], "no charge on or after the day it stops");
  const view = per.get(CLIENT)!.subscriptions.find((x) => x.id === "sub_setAAAAAAAA")!;
  assert.equal(view.nextCharge, null);
  assert.equal(view.canceled, null, "still running: not 'Cancelled'");
  assert.equal(per.get(CLIENT)!.subscriptions.find((x) => x.id === "sub_endedBBBBBB")!.canceled, "2026-10-20", "Cancelled on the day it ended");
  const totals = billingTotals(snap, per, now);
  assert.equal(totals.lostMrr30, 1000, "the ended one only — by when it ended; the one set to cancel is still paying");
});
