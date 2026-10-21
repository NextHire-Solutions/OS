/*
 * The portal's Billing page (22 Oct): our introductions in each billing period.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { introductionsByPeriod } from "./billing-periods.ts";

const s = (iso: string) => Date.parse(iso) / 1000;
const NOW = new Date("2026-10-22T16:00:00Z");

test("counts our introductions in each period — never the client's own entries; newest first; today's period marked", () => {
  const invoices = [
    { number: "INV-1", status: "paid", serviceStart: s("2026-09-01T04:00:00Z"), serviceEnd: s("2026-10-01T04:00:00Z") },
    { number: "INV-2", status: "paid", serviceStart: s("2026-10-01T04:00:00Z"), serviceEnd: s("2026-11-01T04:00:00Z") },
  ];
  const entries = [
    { source: "Interested Reply", introduced_at: "2026-09-15T12:00:00Z" },
    { source: null, introduced_at: "2026-09-30T23:00:00Z" },
    { source: "Client Entry", introduced_at: "2026-09-20T12:00:00Z" },
    { source: "Interested Reply", introduced_at: "2026-10-05T12:00:00Z" },
    { source: "Interested Reply", introduced_at: "2026-10-01T04:00:00Z" },
    { source: "Client Entry", introduced_at: "2026-10-06T12:00:00Z" },
    { source: "Interested Reply", introduced_at: null },
  ];
  assert.deepEqual(introductionsByPeriod(invoices, entries, NOW), [
    { start: "2026-10-01", end: "2026-10-31", invoice: "INV-2", status: "paid", introductions: 2, current: true },
    { start: "2026-09-01", end: "2026-09-30", invoice: "INV-1", status: "paid", introductions: 2, current: false },
  ]);
});

test("a client billed every 14 days sees 14-day periods; draft and void invoices are not periods; a retried invoice is one row", () => {
  const invoices = [
    { number: "A", status: "paid", serviceStart: s("2026-10-08T04:00:00Z"), serviceEnd: s("2026-10-22T04:00:00Z") },
    { number: "B", status: "open", serviceStart: s("2026-10-22T04:00:00Z"), serviceEnd: s("2026-11-05T05:00:00Z") },
    { number: "B2", status: "paid", serviceStart: s("2026-10-22T04:00:00Z"), serviceEnd: s("2026-11-05T05:00:00Z") },
    { number: "D", status: "draft", serviceStart: s("2026-11-05T05:00:00Z"), serviceEnd: s("2026-11-19T05:00:00Z") },
    { number: "V", status: "void", serviceStart: s("2026-09-24T04:00:00Z"), serviceEnd: s("2026-10-08T04:00:00Z") },
    { number: "X", status: "paid" },
  ];
  const out = introductionsByPeriod(invoices, [{ source: "Interested Reply", introduced_at: "2026-10-22T15:00:00Z" }], NOW);
  assert.deepEqual(out.map((p) => [p.start, p.end, p.invoice, p.status, p.introductions, p.current]), [
    ["2026-10-22", "2026-11-04", "B2", "paid", 1, true],
    ["2026-10-08", "2026-10-21", "A", "paid", 0, false],
  ]);
});

test("at most twelve periods; none without an invoice", () => {
  const invoices = Array.from({ length: 20 }, (_, i) => ({ number: `I${i}`, status: "paid", serviceStart: s("2025-01-01T00:00:00Z") + i * 30 * 86400, serviceEnd: s("2025-01-01T00:00:00Z") + (i + 1) * 30 * 86400 }));
  assert.equal(introductionsByPeriod(invoices, [], NOW).length, 12);
  assert.deepEqual(introductionsByPeriod([], [{ source: "Interested Reply", introduced_at: "2026-10-01T00:00:00Z" }], NOW), []);
});
