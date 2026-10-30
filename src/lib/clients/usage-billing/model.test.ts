/*
 * Pay per lead — the pure rules (model.ts): periods in Eastern days, amounts,
 * line wording, dedupe, input checks and the switches.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addDays, amountCents, dedupeLeads, DEFAULT_LEAD_SOURCE, duePeriods, easternDay, easternMidnight, invoiceDescription, isDay, isPeriodStart,
  keysAlreadyBilled, lastCompletedPeriod, lineDescription, parseFakeLeads, parseSettingsInput, periodKey, periodLabel, periodOf, periodWindow,
  modeOf, scheduledChargeAllowed, schedulerAllowed, settingsRefusal, shortHash, testBillingRefusal, type BillableLead,
} from "./model.ts";

const lead = (key: string, at: string, name = key): BillableLead => ({ key, name, at, source: "handoff" });

test("weekly periods run from the anchor, [start, end); nothing before the anchor", () => {
  const A = "2026-10-05"; // a Monday
  assert.deepEqual(periodOf(A, 7, "2026-10-05"), { start: "2026-10-05", end: "2026-10-12" });
  assert.deepEqual(periodOf(A, 7, "2026-10-11"), { start: "2026-10-05", end: "2026-10-12" });
  assert.deepEqual(periodOf(A, 7, "2026-10-12"), { start: "2026-10-12", end: "2026-10-19" });
  assert.equal(periodOf(A, 7, "2026-10-04"), null, "before the anchor is never billed");
  assert.deepEqual(periodOf(A, 14, "2026-10-18"), { start: "2026-10-05", end: "2026-10-19" });
  assert.deepEqual(periodOf(A, 14, "2026-10-19"), { start: "2026-10-19", end: "2026-11-02" });
  assert.ok(isPeriodStart(A, 7, "2026-10-26"));
  assert.ok(!isPeriodStart(A, 7, "2026-10-27"));
  assert.ok(!isPeriodStart(A, 14, "2026-10-12"));
  assert.ok(!isPeriodStart(A, 7, "2026-09-28"), "before the anchor is not a period");
});

test("the last completed period, and what a scheduled run looks at (at most two back)", () => {
  const A = "2026-10-05";
  assert.equal(lastCompletedPeriod(A, 7, "2026-10-05"), null, "the first period has not ended");
  assert.equal(lastCompletedPeriod(A, 7, "2026-10-11"), null);
  assert.deepEqual(lastCompletedPeriod(A, 7, "2026-10-12"), { start: "2026-10-05", end: "2026-10-12" }, "billed the day after it ends");
  assert.deepEqual(lastCompletedPeriod(A, 7, "2026-10-15"), { start: "2026-10-05", end: "2026-10-12" });
  assert.deepEqual(lastCompletedPeriod(A, 14, "2026-10-26"), { start: "2026-10-05", end: "2026-10-19" });
  assert.deepEqual(duePeriods(A, 7, "2026-10-11"), []);
  assert.deepEqual(duePeriods(A, 7, "2026-10-12"), [{ start: "2026-10-05", end: "2026-10-12" }]);
  assert.deepEqual(duePeriods(A, 7, "2026-10-26"), [{ start: "2026-10-12", end: "2026-10-19" }, { start: "2026-10-19", end: "2026-10-26" }], "oldest first, two at most");
  assert.equal(duePeriods("2025-01-06", 7, "2026-10-26").length, 2, "an anchor a year back never bills a year at once");
  assert.equal(duePeriods("2025-01-06", 7, "2026-10-26", 6).length, 6);
});

test("Eastern days: midnight in summer, winter and on both clock-change days", () => {
  assert.equal(easternMidnight("2026-07-01").toISOString(), "2026-07-01T04:00:00.000Z");
  assert.equal(easternMidnight("2026-12-01").toISOString(), "2026-12-01T05:00:00.000Z");
  assert.equal(easternMidnight("2026-03-08").toISOString(), "2026-03-08T05:00:00.000Z", "clocks go forward at 2 a.m. — midnight is still EST");
  assert.equal(easternMidnight("2026-03-09").toISOString(), "2026-03-09T04:00:00.000Z");
  assert.equal(easternMidnight("2026-11-01").toISOString(), "2026-11-01T04:00:00.000Z", "clocks go back at 2 a.m. — midnight is still EDT");
  assert.equal(easternMidnight("2026-11-02").toISOString(), "2026-11-02T05:00:00.000Z");
  assert.equal(easternDay("2026-10-12T03:59:59Z"), "2026-10-11");
  assert.equal(easternDay("2026-10-12T04:00:00Z"), "2026-10-12");
  assert.deepEqual(periodWindow({ start: "2026-10-26", end: "2026-11-02" }), { from: "2026-10-26T04:00:00.000Z", to: "2026-11-02T05:00:00.000Z" });
  assert.ok(isDay("2026-02-28") && !isDay("2026-02-30") && !isDay("2026-2-3") && !isDay(null));
  assert.equal(addDays("2026-12-29", 7), "2027-01-05");
});

test("amount = leads × price: 5 leads at $100 is $500", () => {
  assert.equal(amountCents(5, 10_000), 50_000);
  assert.equal(amountCents(0, 20_000), 0);
  assert.equal(amountCents(3, 20_000), 60_000);
  assert.throws(() => amountCents(-1, 10_000));
  assert.throws(() => amountCents(1.5, 10_000));
  assert.throws(() => amountCents(1, 0), /price/);
  assert.throws(() => amountCents(1, 99));
  assert.throws(() => amountCents(1, 10_000.5));
});

test("one line per lead: 'Lead: <name> — <Eastern date>'; the invoice says the period and the price", () => {
  // 22:00 Eastern on Oct 7 is already Oct 8 in UTC — the line says the client's day.
  assert.equal(lineDescription(lead("j@x.com", "2026-10-08T02:00:00Z", "Jordan  Ellis ")), "Lead: Jordan Ellis — Oct 7, 2026");
  assert.equal(lineDescription(lead("j@x.com", "2026-10-08T02:00:00Z", "  ")), "Lead: j@x.com — Oct 7, 2026", "no name: the key");
  assert.equal(periodLabel({ start: "2026-10-05", end: "2026-10-12" }), "Oct 5 – Oct 11, 2026");
  assert.equal(periodLabel({ start: "2026-12-28", end: "2027-01-04" }), "Dec 28, 2026 – Jan 3, 2027");
  assert.equal(invoiceDescription({ start: "2026-10-05", end: "2026-10-12" }, 3, 10_000), "Pay per lead · Oct 5 – Oct 11, 2026 · 3 leads × $100.00");
  assert.equal(invoiceDescription({ start: "2026-10-05", end: "2026-10-19" }, 1, 20_000), "Pay per lead · Oct 5 – Oct 18, 2026 · 1 lead × $200.00");
});

test("dedupe: once per agent — the first in the period; never one billed before; no key, no line", () => {
  const d = dedupeLeads(
    [
      lead("B@x.com", "2026-10-06T15:00:00Z", "Bea later"),
      lead("a@x.com", "2026-10-06T12:00:00Z", "Al"),
      lead("b@x.com", "2026-10-06T13:00:00Z", "Bea first"),
      lead("old@x.com", "2026-10-07T12:00:00Z"),
      lead("  ", "2026-10-07T12:00:00Z"),
    ],
    new Set(["old@x.com"]),
  );
  assert.deepEqual(d.billable.map((l) => [l.key, l.name]), [["a@x.com", "Al"], ["b@x.com", "Bea first"]]);
  assert.deepEqual(d.skipped.map((s) => s.reason).sort(), ["billed_before", "duplicate", "no_key"]);
});

test("keys already billed: every billed period of the client but this one (not previews, not void)", () => {
  const rows = [
    { period_start: "2026-09-28", status: "paid", leads: [lead("A@x.com", "x")] },
    { period_start: "2026-09-28", status: "failed", leads: [lead("f@x.com", "x")] },
    { period_start: "2026-09-21", status: "draft", leads: [lead("d@x.com", "x")] },
    { period_start: "2026-09-21", status: "preview", leads: [lead("p@x.com", "x")] },
    { period_start: "2026-09-14", status: "void", leads: [lead("v@x.com", "x")] },
    { period_start: "2026-10-05", status: "paid", leads: [lead("same@x.com", "x")] },
    { period_start: "2026-10-12", status: "charged", leads: [lead("later@x.com", "x")] },
  ];
  assert.deepEqual([...keysAlreadyBilled(rows, "2026-10-05")].sort(), ["a@x.com", "d@x.com", "f@x.com", "later@x.com"]);
});

test("the period key and the per-lead digest are stable and distinct", () => {
  assert.equal(periodKey("c1", "2026-10-05"), "os-usage:c1:2026-10-05");
  assert.equal(shortHash("a@x.com"), shortHash("a@x.com"));
  const many = new Set(Array.from({ length: 500 }, (_, i) => shortHash(`agent${i}@brokerage.com`)));
  assert.equal(many.size, 500);
});

test("settings input: price $1–$10,000, every 7 or 14 days, a real first day; handoffs by default", () => {
  assert.equal(DEFAULT_LEAD_SOURCE, "handoffs");
  assert.deepEqual(parseSettingsInput({ price: "$100", everyDays: 7, anchorDate: "2026-10-05" }), { priceCents: 10_000, everyDays: 7, anchorDate: "2026-10-05", leadSource: "handoffs", enabled: false });
  assert.deepEqual(parseSettingsInput({ priceCents: 20_000, everyDays: "14", anchorDate: "2026-10-05", leadSource: "introductions", enabled: true }), { priceCents: 20_000, everyDays: 14, anchorDate: "2026-10-05", leadSource: "introductions", enabled: true });
  assert.ok("error" in parseSettingsInput({ price: "0.50", everyDays: 7, anchorDate: "2026-10-05" }));
  assert.ok("error" in parseSettingsInput({ price: "10001", everyDays: 7, anchorDate: "2026-10-05" }));
  assert.ok("error" in parseSettingsInput({ price: "abc", everyDays: 7, anchorDate: "2026-10-05" }));
  assert.ok("error" in parseSettingsInput({ price: "100", everyDays: 30, anchorDate: "2026-10-05" }));
  assert.ok("error" in parseSettingsInput({ price: "100", everyDays: 7, anchorDate: "2026-10-32" }));
  assert.ok("error" in parseSettingsInput({ price: "100", everyDays: 7, anchorDate: "2026-10-05", leadSource: "replies" }));
  assert.ok("error" in parseSettingsInput(null));
});

test("fake leads for a test: lines or a list, inside the period, each its own key unless given", () => {
  const P = { start: "2026-10-05", end: "2026-10-12" };
  const r = parseFakeLeads("Jordan Ellis, 2026-10-06\nSam Lee\n\nPat Kim, 2026-10-07, pat@x.com", P);
  assert.ok(Array.isArray(r));
  assert.deepEqual(r.map((l) => [l.name, easternDay(l.at), l.source]), [["Jordan Ellis", "2026-10-06", "test"], ["Sam Lee", "2026-10-05", "test"], ["Pat Kim", "2026-10-07", "test"]]);
  assert.equal(r[2].key, "pat@x.com");
  assert.equal(new Set(r.map((l) => l.key)).size, 3);
  assert.match((parseFakeLeads("Late Larry, 2026-10-12", P) as { error: string }).error, /outside/);
  assert.match((parseFakeLeads([{ name: "" }], P) as { error: string }).error, /no name/);
  assert.match((parseFakeLeads([{ name: "X", at: "soon" }], P) as { error: string }).error, /not a date/);
  assert.ok("error" in (parseFakeLeads(42, P) as object));
});

test("the switches: the scheduled run needs OS_USAGE_BILLING_ENABLED=1 AND Railway; charging needs OS_USAGE_BILLING_CHARGE=1", () => {
  const base = { MASTER_INBOX_SUPABASE_URL: "http://db" };
  assert.equal(schedulerAllowed({ ...base }), false, "off by default");
  assert.equal(schedulerAllowed({ ...base, OS_USAGE_BILLING_ENABLED: "1" }), false, "never on a laptop");
  assert.equal(schedulerAllowed({ ...base, OS_USAGE_BILLING_ENABLED: "true", RAILWAY_ENVIRONMENT_NAME: "production" }), false, "only exactly 1");
  assert.equal(schedulerAllowed({ ...base, OS_USAGE_BILLING_ENABLED: "1", RAILWAY_ENVIRONMENT_NAME: "production" }), true);
  assert.equal(scheduledChargeAllowed({}), false);
  assert.equal(scheduledChargeAllowed({ OS_USAGE_BILLING_CHARGE: "yes" }), false);
  assert.equal(scheduledChargeAllowed({ OS_USAGE_BILLING_CHARGE: "1" }), true);
});

test("test or live (31 Oct): only test_only = false is live; valid settings bill in either mode; the test tools are for test clients only", () => {
  const ok = { test_only: true, price_cents: 10_000, every_days: 7, anchor_date: "2026-10-05" };
  assert.equal(modeOf(ok), "test");
  assert.equal(modeOf({ test_only: false }), "live");
  assert.equal(modeOf({ test_only: null as unknown as boolean }), "test", "anything but false is a test row — never live by accident");
  assert.equal(settingsRefusal(ok), null);
  const liveRow: Parameters<typeof settingsRefusal>[0] & { test_only: boolean } = { ...ok, test_only: false };
  assert.equal(settingsRefusal(liveRow), null, "a live client can be billed");
  assert.match(settingsRefusal(null)!, /no pay-per-lead settings/);
  for (const bad of [{ every_days: 30 }, { price_cents: 0 }, { anchor_date: "" }]) {
    assert.ok(settingsRefusal({ ...ok, ...bad }), JSON.stringify(bad));
    assert.ok(testBillingRefusal({ ...ok, ...bad }), JSON.stringify(bad));
  }
  assert.equal(testBillingRefusal(ok), null);
  assert.match(testBillingRefusal({ ...ok, test_only: false })!, /live — the test tools are for test clients only/);
  assert.ok(testBillingRefusal({ ...ok, test_only: null as unknown as boolean }), "anything but true is refused the test tools");
  assert.match(testBillingRefusal(null)!, /no pay-per-lead settings/);
});

test("the onboarding products: a price and what is counted, and their own words", async () => {
  const { PAY_PER_LEAD_PRODUCTS, productLabel, parseSettingsInput } = await import("./model.ts");
  assert.deepEqual(PAY_PER_LEAD_PRODUCTS.map((p) => [p.label, p.leadSource, p.priceCents]), [
    ["$150 per lead", "handoffs", 15_000],
    ["$250 per lead", "handoffs", 25_000],
    ["$500 per call", "calls", 50_000],
    ["$1,000 per call", "calls", 100_000],
    ["$5,000 per introduction", "introductions", 500_000],
  ]);
  for (const p of PAY_PER_LEAD_PRODUCTS) assert.equal(productLabel(p.leadSource, p.priceCents), p.label);
  const { OFFERED_PRODUCTS } = await import("./model.ts");
  assert.deepEqual(OFFERED_PRODUCTS.map((p) => p.label), ["$150 per lead", "$250 per lead"], "per call and per introduction not offered for now (Eddy, 27 Oct)");
  assert.ok(OFFERED_PRODUCTS.every((p) => p.leadSource === "handoffs"), "a lead is each Interested reply handed over");
  assert.equal(productLabel("calls", 75_050), "$750.50 per call", "a custom price reads the same way");
  for (const p of PAY_PER_LEAD_PRODUCTS) {
    const r = parseSettingsInput({ priceCents: p.priceCents, leadSource: p.leadSource, everyDays: 14, anchorDate: "2026-10-26" });
    assert.ok(!("error" in r), `${p.label} saves`);
  }
  assert.ok("error" in parseSettingsInput({ priceCents: 15_000, leadSource: "meetings", everyDays: 7, anchorDate: "2026-10-26" }));
});
