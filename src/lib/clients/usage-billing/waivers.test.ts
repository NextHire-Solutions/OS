/*
 * "Don't bill" (6 Nov, migrations/0050) against the in-memory database and the fake Stripe, as billing.test.ts.
 *
 * Amy: Homebase was sent one interested reply past its cap and must not be charged for it. What is pinned:
 *   - a lead not billed is off the preview, the amount and the charge, in every period; "Bill it" puts it back;
 *   - only with a reason, only for a lead billed in that period, only while the period isn't charged;
 *   - before 0050 runs, billing is exactly as before and the button says what's needed;
 *   - a waiver list that can't be read stops the charge rather than billing a lead someone took off;
 *   - a lead taken off at the moment a charge claims its period: let go, nothing charged.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest, type Row } from "../../tools/master-inbox/test/fake-postgrest.ts";
import { FakeStripe } from "./test/fake-stripe.ts";

configureFakeEnvironment("MASTER_INBOX_");
const db = new FakePostgrest();
// The waiver list can be made to fail, and something can happen just after a charge claims its period.
let waiversFail = false;
let afterClaim: (() => Promise<void>) | null = null;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (waiversFail && url.includes("os_usage_billing_waivers")) {
    return new Response(JSON.stringify({ code: "XX000", message: "the database is down" }), { status: 500, headers: { "content-type": "application/json" } });
  }
  const res = await db.fetch(input as never, init as never);
  const sent = String(init?.body ?? "");
  // A claim: the period taken to "draft" (or closed "void", nothing to charge) by someone, never the let-go back to "preview".
  if (afterClaim && init?.method === "PATCH" && url.includes("os_usage_billing_periods") && /"claimed_by":"/.test(sent) && /"status":"(draft|void)"/.test(sent)) {
    const hook = afterClaim;
    afterClaim = null;
    await hook();
  }
  return res;
}) as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const billing = await import("./billing.ts");
const { usageStripe } = await import("./stripe.ts");
const { periodKey, isReopened } = await import("./model.ts");

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
const waivers = () => db.rows("os_usage_billing_waivers");
const W = async (leadKey: unknown, reason: unknown = "sent over the cap", periodStart = WEEK.start) =>
  billing.waiveLead(ACME, await settingsOf(), { periodStart, leadKey, reason, by: ADMIN, now: NOW });
const fresh = () => { waiversFail = false; afterClaim = null; };

test("Don't bill: the lead comes off the preview and the amount, says why and who; Bill it puts it back", async () => {
  seed(); fresh();
  const before = await billing.previewPeriod(ACME, await settingsOf(), { now: NOW });
  assert.equal(before.count, 3);
  const pl = await W("  Sam@Harbor.test ", "  sent   over the cap ");
  assert.deepEqual(pl.leads.map((l) => l.key), ["jordan@coastal.test", "pat@bay.test"]);
  assert.deepEqual(pl.waived.map((w) => [w.key, w.name, w.reason, w.by]), [["sam@harbor.test", "Sam Lee", "sent over the cap", ADMIN]]);
  assert.equal(pl.locked, false);
  assert.deepEqual(waivers().map((r) => [r.os_client_id, r.test_mode, r.lead_key, r.lead_name, r.reason, r.waived_by]), [[ACME, true, "sam@harbor.test", "Sam Lee", "sent over the cap", ADMIN]]);
  const after = await billing.previewPeriod(ACME, await settingsOf(), { now: NOW });
  assert.equal(after.count, 2);
  assert.equal(after.amountCents, 20_000);
  assert.ok(!after.lines.some((l) => /Sam Lee/.test(l.description)), "not on the invoice");
  assert.ok(after.skipped.some((x) => x.reason === "waived" && x.lead.key === "sam@harbor.test"));
  const back = await billing.unwaiveLead(ACME, await settingsOf(), { periodStart: WEEK.start, leadKey: "sam@harbor.test", by: ADMIN, now: NOW });
  assert.equal(back.leads.length, 3);
  assert.deepEqual(back.waived, []);
  assert.deepEqual(waivers(), []);
  assert.equal((await billing.previewPeriod(ACME, await settingsOf(), { now: NOW })).count, 3);
});

/** Sam again, on a second conversation, first marked Interested in the week of Oct 12: a lead of that week too. */
function samAgainNextWeek() {
  db.rows("threads").push({ id: "ti-sam2", client_id: BOSTON, lead_id: "l6" });
  db.rows("label_assignments").push({ label_id: "lab-int", target_type: "thread", target_id: "ti-sam2", assigned_at: "2026-10-13T15:00:00.000Z" });
  db.rows("label_history").push({ id: 999, thread_id: "ti-sam2", label_id: "lab-int", label_name: "Interested", assigned_at: "2026-10-13T15:00:00.000Z", client_id: BOSTON, lead_id: "l6", source: "trigger" });
}
const NEXT_WEEK = new Date("2026-10-16T15:00:00.000Z");

test("a lead not billed stays off in every period: Sam on a second conversation the next week is still not billed", async () => {
  seed(); fresh();
  samAgainNextWeek();
  // Without a waiver he is a lead of that week too (not billed anywhere yet).
  const control = await billing.periodLeads(ACME, await settingsOf(), "2026-10-12", { now: NEXT_WEEK });
  assert.ok(control.leads.some((l) => l.key === "sam@harbor.test"), "control: Sam counts in the week of Oct 12");
  await W("sam@harbor.test");
  const next = await billing.periodLeads(ACME, await settingsOf(), "2026-10-12", { now: NEXT_WEEK });
  assert.ok(!next.leads.some((l) => l.key === "sam@harbor.test"));
  assert.deepEqual(next.waived.map((w) => w.key), ["sam@harbor.test"], "and shown there as not billed");
});

test("an earlier period being charged with them already: the later one doesn't list them, so there's nothing to change", async () => {
  seed({ periods: [{ os_client_id: ACME, period_start: WEEK.start, period_end: WEEK.end, status: "draft", leads: [{ key: "sam@harbor.test", name: "Sam Lee", at: "2026-10-07T18:30:00.000Z", source: "handoff" }], claimed_at: NOW.toISOString() }] }); fresh();
  samAgainNextWeek();
  const e = await billing.waiveLead(ACME, await settingsOf(), { periodStart: "2026-10-12", leadKey: "sam@harbor.test", reason: "x", by: ADMIN, now: NEXT_WEEK }).catch((x) => x);
  assert.equal(e.status, 409);
  assert.deepEqual(waivers(), []);
});

test("a waiver covers every period: an earlier period claimed with them as it is written takes it back, and says which", async () => {
  seed(); fresh();
  samAgainNextWeek();
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (init?.method === "POST" && url.includes("os_usage_billing_waivers")) {
      db.rows("os_usage_billing_periods").push({ id: "p-early", os_client_id: ACME, period_start: WEEK.start, period_end: WEEK.end, status: "draft", test_mode: true, leads: [{ key: "sam@harbor.test", name: "Sam Lee", at: "2026-10-07T18:30:00.000Z", source: "handoff" }] });
    }
    return real(input as never, init as never);
  }) as typeof fetch;
  try {
    const e = await billing.waiveLead(ACME, await settingsOf(), { periodStart: "2026-10-12", leadKey: "sam@harbor.test", reason: "x", by: ADMIN, now: NEXT_WEEK }).catch((x) => x);
    assert.equal(e.status, 409);
    assert.match(e.message, /being charged right now, in Oct 5 – Oct 11, 2026/);
    assert.deepEqual(waivers(), [], "taken back");
  } finally {
    globalThis.fetch = real;
  }
});

test("an earlier period voided in Stripe charged no one: the later week can keep them off its bill", async () => {
  seed({ periods: [{ os_client_id: ACME, period_start: WEEK.start, period_end: WEEK.end, status: "void", lead_count: 1, leads: [{ key: "sam@harbor.test", name: "Sam Lee", at: "2026-10-07T18:30:00.000Z", source: "handoff" }] }] }); fresh();
  samAgainNextWeek();
  const pl = await billing.waiveLead(ACME, await settingsOf(), { periodStart: "2026-10-12", leadKey: "sam@harbor.test", reason: "x", by: ADMIN, now: NEXT_WEEK });
  assert.deepEqual(pl.waived.map((w) => w.key), ["sam@harbor.test"]);
});

test("an earlier period whose charge the card refused: refused, said as still owed, nothing written", async () => {
  seed({ periods: [{ os_client_id: ACME, period_start: "2026-09-28", period_end: "2026-10-05", status: "failed", lead_count: 1, leads: [{ key: "pat@bay.test", name: "Pat Kim", at: "2026-09-30T12:00:00.000Z", source: "handoff" }] }] }); fresh();
  // Pat is billed in that failed period, so this week doesn't list him: there's nothing to change here.
  const e = await W("pat@bay.test").catch((x) => x);
  assert.equal(e.status, 409);
  assert.deepEqual(waivers(), []);
});

test("the list read back after a change can fail: the change is still said as made", async () => {
  seed(); fresh();
  const s = await settingsOf();
  let reads = 0;
  const failing = (async (osClientId: string, a: string, b: string, ctx?: { startDate?: string }) => {
    reads++;
    const { billableLeads } = await import("./leads.ts");
    if (reads > 1) throw new Error("label_history: injected failure");
    return billableLeads(osClientId, a, b, "handoffs", ctx);
  }) as never;
  const pl = await billing.waiveLead(ACME, s, { periodStart: WEEK.start, leadKey: "sam@harbor.test", reason: "over the cap", by: ADMIN, now: NOW, source: failing });
  assert.deepEqual(pl.waived.map((w) => [w.key, w.reason]), [["sam@harbor.test", "over the cap"]]);
  assert.ok(!pl.leads.some((l) => l.key === "sam@harbor.test"));
  assert.equal(waivers().length, 1);
});

test("an unfinished charge with a lead since marked not to bill: refused before it is taken over, so Remove stays possible", async () => {
  const claimedAt = new Date(NOW.getTime() - 20 * 60_000).toISOString();
  seed({ periods: [{ id: "p-dead", os_client_id: ACME, period_start: WEEK.start, period_end: WEEK.end, status: "draft", lead_count: 3, amount_cents: 30_000, claimed_at: claimedAt, claimed_by: ADMIN, leads: [{ key: "sam@harbor.test", name: "Sam Lee", at: "2026-10-07T18:30:00.000Z", source: "handoff" }] }] }); fresh();
  await withCard();
  db.seed("os_usage_billing_waivers", [{ os_client_id: ACME, test_mode: true, lead_key: "sam@harbor.test", lead_name: "Sam Lee", reason: "x", waived_by: ADMIN, waived_at: NOW.toISOString() }]);
  const e = await billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW }).catch((x) => x);
  assert.equal(e.status, 409);
  assert.match(e.message, /press Remove on it/);
  assert.equal(db.rows("os_usage_billing_periods").find((r) => r.id === "p-dead")!.claimed_at, claimedAt, "the claim wasn't taken over: still stale, so Remove is offered");
  assert.deepEqual(fake.calls.filter((x) => x.method === "POST"), []);
});

test("test and live are kept apart: a lead marked not to bill in live mode is still on this test client's bill", async () => {
  seed(); fresh();
  db.seed("os_usage_billing_waivers", [{ os_client_id: ACME, test_mode: false, lead_key: "sam@harbor.test", lead_name: "Sam Lee", reason: "live only", waived_by: ADMIN, waived_at: NOW.toISOString() }]);
  assert.equal((await billing.previewPeriod(ACME, await settingsOf(), { now: NOW })).count, 3);
});

test("Bill it at the moment a charge claims its period: the charge lets go, nothing charged, and the next charge bills them", async () => {
  seed(); fresh();
  await withCard();
  await W("sam@harbor.test");
  afterClaim = async () => { await db.fetch(`http://supabase.test/rest/v1/os_usage_billing_waivers?os_client_id=eq.${ACME}&lead_key=eq.sam@harbor.test`, { method: "DELETE" } as never); };
  const e = await billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW }).catch((x) => x);
  assert.equal(e.status, 409);
  assert.match(e.message, /marked not to bill, or billed again/);
  assert.deepEqual(fake.calls.filter((x) => x.method === "POST"), [], "no invoice, no charge");
  const row = db.rows("os_usage_billing_periods").find((r) => r.period_start === WEEK.start)!;
  assert.equal(row.status, "preview");
  assert.equal(isReopened(String(row.note)), false, "the automatic run charges it afresh; it doesn't wait for a person");
  const again = await billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW });
  assert.equal(again.row?.lead_count, 3, "Sam billed");
});

test("Bill it as the period is claimed without them: they stay not billed, and it says so", async () => {
  seed(); fresh();
  await W("sam@harbor.test");
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const res = await real(input as never, init as never);
    if (init?.method === "DELETE" && url.includes("os_usage_billing_waivers")) {
      db.rows("os_usage_billing_periods").push({ id: "p-claim2", os_client_id: ACME, period_start: WEEK.start, period_end: WEEK.end, status: "draft", test_mode: true, leads: [{ key: "jordan@coastal.test", name: "Jordan Ellis", at: "2026-10-06T14:00:00.000Z", source: "handoff" }] });
    }
    return res;
  }) as typeof fetch;
  try {
    const e = await billing.unwaiveLead(ACME, await settingsOf(), { periodStart: WEEK.start, leadKey: "sam@harbor.test", by: ADMIN, now: NOW }).catch((x) => x);
    assert.equal(e.status, 409);
    assert.match(e.message, /stay not billed/);
    assert.deepEqual(waivers().map((r) => [r.lead_key, r.reason]), [["sam@harbor.test", "sent over the cap"]], "put back as it was");
  } finally {
    globalThis.fetch = real;
  }
});

test("stopped as it started, and it can't be opened again: nothing charged, and the bell says not to carry it on", async () => {
  seed(); fresh();
  await withCard();
  await W("sam@harbor.test");
  db.seed("os_notifications", []);
  const real = globalThis.fetch;
  let releaseFails = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (releaseFails && init?.method === "PATCH" && url.includes("os_usage_billing_periods") && String(init.body ?? "").includes('"status":"preview"')) {
      return new Response(JSON.stringify({ code: "XX000", message: "the database is down" }), { status: 500, headers: { "content-type": "application/json" } });
    }
    return real(input as never, init as never);
  }) as typeof fetch;
  afterClaim = async () => {
    await db.fetch(`http://supabase.test/rest/v1/os_usage_billing_waivers?os_client_id=eq.${ACME}&lead_key=eq.sam@harbor.test`, { method: "DELETE" } as never);
    releaseFails = true;
  };
  try {
    const e = await billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW }).catch((x) => x);
    assert.equal(e.status, 502);
    assert.match(e.message, /couldn't be opened again/);
    assert.deepEqual(fake.calls.filter((x) => x.method === "POST"), [], "nothing sent to Stripe");
    const bell = db.rows("os_notifications").find((n) => String(n.ref).startsWith("usage_letgo_failed:"));
    assert.ok(bell, "a bell");
    assert.equal(bell!.severity, "critical");
    assert.match(String(bell!.title), /Don't carry on the Oct 5 – Oct 11, 2026 charge/);
    assert.match(String(bell!.body), /press Remove on it/);
  } finally {
    globalThis.fetch = real;
    afterClaim = null;
  }
});

test("the waiver list can't be read just after the claim: let go, nothing charged, never a stuck claim", async () => {
  seed(); fresh();
  await withCard();
  afterClaim = async () => { waiversFail = true; };
  const e = await billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW }).catch((x) => x);
  assert.match(String(e.message), /os_usage_billing_waivers/);
  assert.deepEqual(fake.calls.filter((x) => x.method === "POST"), []);
  const row = db.rows("os_usage_billing_periods").find((r) => r.period_start === WEEK.start)!;
  assert.equal(row.status, "preview", "not left as an unfinished draft");
  assert.equal(isReopened(String(row.note)), false);
  waiversFail = false;
  const again = await billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW });
  assert.equal(again.outcome, "paid");
});

test("a period with nothing to charge isn't closed for good if a lead was billed again as it closed", async () => {
  seed(); fresh();
  await withCard();
  for (const k of ["jordan@coastal.test", "sam@harbor.test", "pat@bay.test"]) await W(k);
  afterClaim = async () => { await db.fetch(`http://supabase.test/rest/v1/os_usage_billing_waivers?os_client_id=eq.${ACME}&lead_key=eq.pat@bay.test`, { method: "DELETE" } as never); };
  const e = await billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW }).catch((x) => x);
  assert.equal(e.status, 409);
  const row = db.rows("os_usage_billing_periods").find((r) => r.period_start === WEEK.start)!;
  assert.equal(row.status, "preview", "not void");
  const again = await billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW });
  assert.equal(again.row?.lead_count, 1, "Pat billed");
});

test("a reason is required; the lead must be billed in that period; twice is once", async () => {
  seed(); fresh();
  const s = await settingsOf();
  for (const r of [undefined, "", "   ", "x".repeat(301)]) {
    const e = await billing.waiveLead(ACME, s, { periodStart: WEEK.start, leadKey: "sam@harbor.test", reason: r, by: ADMIN, now: NOW }).catch((x) => x);
    assert.equal(e.status, 400, String(r).slice(0, 10));
    assert.match(e.message, /Say why/);
  }
  const none = await billing.waiveLead(ACME, s, { periodStart: WEEK.start, leadKey: "nobody@x.test", reason: "x", by: ADMIN, now: NOW }).catch((x) => x);
  assert.equal(none.status, 409);
  const blank = await billing.waiveLead(ACME, s, { periodStart: WEEK.start, leadKey: "  ", reason: "x", by: ADMIN, now: NOW }).catch((x) => x);
  assert.equal(blank.status, 400);
  await W("sam@harbor.test");
  await W("sam@harbor.test", "again");
  assert.equal(waivers().length, 1);
  assert.equal(waivers()[0].reason, "sent over the cap", "the first reason stands");
  assert.deepEqual(db.blocked, []);
});

test("nothing changes in a period that is charged or being charged", async () => {
  for (const [status, words] of [["paid", /charged already/], ["charged", /charged already/], ["failed", /refused by the card and is still owed/], ["draft", /being charged right now/], ["void", /closed/]] as const) {
    seed({ periods: [{ os_client_id: ACME, period_start: WEEK.start, period_end: WEEK.end, status, leads: [] }] }); fresh();
    const e = await W("sam@harbor.test").catch((x) => x);
    assert.equal(e.status, 409, status);
    assert.match(e.message, words);
    const u = await billing.unwaiveLead(ACME, await settingsOf(), { periodStart: WEEK.start, leadKey: "sam@harbor.test", by: ADMIN, now: NOW }).catch((x) => x);
    assert.equal(u.status, 409, status);
    assert.deepEqual(waivers(), []);
  }
});

test("before 0050 runs: billing as before, and not billing a lead says the file is needed", async () => {
  seed(); fresh();
  db.missingTables.add("os_usage_billing_waivers");
  const p = await billing.previewPeriod(ACME, await settingsOf(), { now: NOW });
  assert.equal(p.count, 3);
  const pl = await billing.periodLeads(ACME, await settingsOf(), WEEK.start, { now: NOW });
  assert.equal(pl.ready, false);
  assert.equal(pl.leads.length, 3);
  const e = await W("sam@harbor.test").catch((x) => x);
  assert.equal(e.status, 503);
  assert.match(e.message, /0050_usage_billing_waivers\.sql/);
});

test("a waiver list that can't be read stops the preview and the charge: never a lead someone took off", async () => {
  seed(); fresh();
  await withCard();
  waiversFail = true;
  const e = await billing.previewPeriod(ACME, await settingsOf(), { now: NOW }).catch((x) => x);
  assert.match(String(e.message), /os_usage_billing_waivers/);
  const c = await billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW }).catch((x) => x);
  assert.match(String(c.message), /os_usage_billing_waivers/);
  assert.deepEqual(fake.calls.filter((x) => x.method === "POST"), [], "Stripe never asked to charge");
  fresh();
});

test("the charge leaves out a lead not billed: an invoice for the rest", async () => {
  seed(); fresh();
  await withCard();
  await W("sam@harbor.test");
  const p = await billing.previewPeriod(ACME, await settingsOf(), { now: NOW });
  const r = await billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW, approved: { periodStart: p.period.start, count: p.count, amountCents: p.amountCents, leadsHash: p.leadsHash } });
  assert.equal(r.outcome, "paid");
  assert.equal(r.row?.lead_count, 2);
  assert.equal(r.row?.amount_cents, 20_000);
  assert.ok(!(r.row?.leads ?? []).some((l) => l.key === "sam@harbor.test"));
  // And once charged, the waiver can't be taken back for that period.
  const u = await billing.unwaiveLead(ACME, await settingsOf(), { periodStart: WEEK.start, leadKey: "sam@harbor.test", by: ADMIN, now: NOW }).catch((x) => x);
  assert.equal(u.status, 409);
});

test("an approval from before a lead was taken off is refused: nothing charged", async () => {
  seed(); fresh();
  await withCard();
  const p = await billing.previewPeriod(ACME, await settingsOf(), { now: NOW });
  await W("sam@harbor.test");
  const e = await billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW, approved: { periodStart: p.period.start, count: p.count, amountCents: p.amountCents, leadsHash: p.leadsHash } }).catch((x) => x);
  assert.equal(e.status, 409);
  assert.match(e.message, /changed since you looked/);
  assert.deepEqual(fake.calls.filter((x) => x.method === "POST"), []);
});

test("a lead taken off at the moment a charge claims its period: let go, nothing charged, and it can be charged again without them", async () => {
  seed(); fresh();
  await withCard();
  afterClaim = async () => {
    await db.fetch("http://supabase.test/rest/v1/os_usage_billing_waivers", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ os_client_id: ACME, test_mode: true, lead_key: "sam@harbor.test", lead_name: "Sam Lee", reason: "at the same moment", waived_by: "amy@brokerstaffer.com", waived_at: NOW.toISOString() }),
    } as never);
  };
  const e = await billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW }).catch((x) => x);
  assert.equal(e.status, 409);
  assert.match(e.message, /just marked not to bill/);
  assert.deepEqual(fake.calls.filter((x) => x.method === "POST"), [], "no invoice, no charge");
  const row = db.rows("os_usage_billing_periods").find((r) => r.period_start === WEEK.start)!;
  assert.equal(row.status, "preview", "let go");
  const again = await billing.chargePeriod(ACME, { stripe, by: ADMIN, now: NOW });
  assert.equal(again.outcome, "paid");
  assert.equal(again.row?.lead_count, 2);
});

test("a charge claiming the period just as a lead is taken off: the waiver comes off again and says so", async () => {
  seed({ periods: [] }); fresh();
  const s = await settingsOf();
  // The period is claimed with Sam in it after the check and before the write.
  const realUpsert = db.fetch.bind(db);
  let claimed = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!claimed && init?.method === "POST" && url.includes("os_usage_billing_waivers")) {
      claimed = true;
      db.rows("os_usage_billing_periods").push({ id: "p-claim", os_client_id: ACME, period_start: WEEK.start, period_end: WEEK.end, status: "draft", test_mode: true, leads: [{ key: "sam@harbor.test", name: "Sam Lee", at: "2026-10-07T18:30:00.000Z", source: "handoff" }] });
    }
    return realUpsert(input as never, init as never);
  }) as typeof fetch;
  const e = await billing.waiveLead(ACME, s, { periodStart: WEEK.start, leadKey: "sam@harbor.test", reason: "late", by: ADMIN, now: NOW }).catch((x) => x);
  assert.equal(e.status, 409);
  assert.match(e.message, /being charged right now, in Oct 5 – Oct 11, 2026, so nothing was changed/);
  assert.deepEqual(waivers(), [], "the waiver came off again");
});
