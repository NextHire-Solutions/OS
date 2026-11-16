import { test } from "node:test";
import assert from "node:assert/strict";

import { perLeadPeriods, startsToCount, type PeriodRecord } from "./billing-per-lead.ts";

/*
 * The portal's Billing page for a client billed per lead (16 Nov). Before it, both pay-per-lead portals read "No billing
 * periods yet" — Homebase had paid — because the page knew only subscription invoices.
 */

const rec = (period_start: string, status: PeriodRecord["status"], lead_count: number, invoice: string | null = null): PeriodRecord => ({ period_start, status, lead_count, stripe_invoice_number: invoice });

test("Homebase on 16 Nov: the period running now, and the one charged and paid — newest first", () => {
  const periods = perLeadPeriods({ anchor: "2026-10-28", everyDays: 14, today: "2026-11-16", records: [rec("2026-10-28", "paid", 2, "WEMAGCSG-0002")], counts: new Map([["2026-11-11", 0]]) });
  assert.deepEqual(periods, [
    { start: "2026-11-11", end: "2026-11-24", invoice: null, status: "current", leads: 0, current: true },
    { start: "2026-10-28", end: "2026-11-10", invoice: "WEMAGCSG-0002", status: "paid", leads: 2, current: false },
  ]);
});

test("Hetherington on 16 Nov: its first period, running, with Anne's lead so far", () => {
  const periods = perLeadPeriods({ anchor: "2026-11-05", everyDays: 14, today: "2026-11-16", records: [], counts: new Map([["2026-11-05", 1]]) });
  assert.deepEqual(periods, [{ start: "2026-11-05", end: "2026-11-18", invoice: null, status: "current", leads: 1, current: true }]);
});

test("a period that ended and wasn't charged yet says so, with its leads", () => {
  const periods = perLeadPeriods({ anchor: "2026-11-05", everyDays: 14, today: "2026-11-19", records: [], counts: new Map([["2026-11-05", 1], ["2026-11-19", 0]]) });
  assert.deepEqual(periods.map((p) => [p.start, p.status, p.leads, p.current]), [["2026-11-19", "current", 0, true], ["2026-11-05", "unbilled", 1, false]]);
});

test("a charged period shows what was charged — not a recount — in the client's words", () => {
  const at = (status: PeriodRecord["status"]) => perLeadPeriods({ anchor: "2026-10-28", everyDays: 14, today: "2026-11-16", records: [rec("2026-10-28", status, 3, "X-1")], counts: new Map([["2026-10-28", 9]]) })[1];
  assert.deepEqual([at("paid").status, at("paid").leads], ["paid", 3]);
  assert.equal(at("charged").status, "due");
  assert.equal(at("failed").status, "unpaid");
  assert.equal(at("draft").status, "billing");
  // Voided with leads in it: nothing charged, so it can be charged again — "not billed yet", no voided number quoted.
  assert.deepEqual([at("void").status, at("void").leads, at("void").invoice], ["unbilled", 3, null]);
  // A preview is only a look: still unbilled, with the leads the automatic run found then (no recount every load).
  assert.deepEqual([at("preview").status, at("preview").leads, at("preview").invoice], ["unbilled", 3, null]);
});

test("an ended period with no leads reads No charge, never Not billed yet forever", () => {
  const at = (records: PeriodRecord[], counts: Map<string, number | null>) => perLeadPeriods({ anchor: "2026-10-28", everyDays: 14, today: "2026-11-16", records, counts })[1];
  assert.equal(at([rec("2026-10-28", "preview", 0)], new Map()).status, "none", "previewed with 0");
  assert.equal(at([rec("2026-10-28", "void", 0, "X-1")], new Map()).status, "none", "voided with 0");
  assert.deepEqual([at([], new Map([["2026-10-28", 0]])).status, at([], new Map([["2026-10-28", 0]])).invoice], ["none", null], "counted 0, no record");
  // A charge beats a void or a preview for the same period.
  assert.equal(at([rec("2026-10-28", "void", 2, "X-1"), rec("2026-10-28", "paid", 2, "X-2"), rec("2026-10-28", "preview", 2)], new Map()).invoice, "X-2");
});

test("a period that couldn't be counted shows no number — not a 0, and not the page an error", () => {
  const periods = perLeadPeriods({ anchor: "2026-10-28", everyDays: 14, today: "2026-11-16", records: [], counts: new Map([["2026-11-11", null]]) });
  assert.deepEqual(periods.map((p) => [p.status, p.leads]), [["current", null], ["unbilled", null]]);
});

test("7-day periods end on their 7th day; a period starts on the anchor, never before", () => {
  const periods = perLeadPeriods({ anchor: "2026-11-02", everyDays: 7, today: "2026-11-16", records: [], counts: new Map() });
  assert.deepEqual(periods.map((p) => `${p.start}..${p.end}`), ["2026-11-16..2026-11-22", "2026-11-09..2026-11-15", "2026-11-02..2026-11-08"]);
  assert.deepEqual(perLeadPeriods({ anchor: "2026-11-20", everyDays: 14, today: "2026-11-16", records: [], counts: new Map() }), [], "not started yet");
  assert.deepEqual(perLeadPeriods({ anchor: "2026-11-02", everyDays: 0, today: "2026-11-16", records: [], counts: new Map() }), [], "no schedule, no periods");
});

test("at most `limit` periods, the newest", () => {
  const periods = perLeadPeriods({ anchor: "2026-01-05", everyDays: 7, today: "2026-11-16", records: [], counts: new Map(), limit: 12 });
  assert.equal(periods.length, 12);
  assert.equal(periods[0].current, true);
  assert.ok(periods.every((p, i) => i === 0 || p.start < periods[i - 1].start));
});

test("counted now: the period running, and an ended one with nothing on record", () => {
  const shape = { anchor: "2026-09-30", everyDays: 14, today: "2026-11-16" };
  assert.deepEqual(startsToCount({ ...shape, records: [rec("2026-10-28", "paid", 2), rec("2026-10-14", "preview", 0)] }), ["2026-11-11", "2026-09-30"]);
  // The running period is counted even when the automatic run previewed it already: more leads can still come.
  assert.deepEqual(startsToCount({ ...shape, records: [rec("2026-11-11", "preview", 0), rec("2026-10-28", "paid", 2), rec("2026-10-14", "void", 1), rec("2026-09-30", "preview", 0)] }), ["2026-11-11"]);
});
