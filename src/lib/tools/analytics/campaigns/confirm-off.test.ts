import assert from "node:assert/strict";
import { test } from "node:test";

import { confirmOff } from "./confirm-off.ts";

const off = { ok: true as const, total: 0, leadIds: [] };

test("gone only when the lead record AND the campaign search both say so", () => {
  assert.equal(confirmOff(298, 7, { status: "found", campaignIds: [], email: "a@b.com" }, off), "off");
  assert.equal(confirmOff(298, 7, { status: "found", campaignIds: [301, 15], email: "a@b.com" }, off), "off");
});

test("a lead deleted in EmailBison is gone — the search proves the campaign was reachable", () => {
  assert.equal(confirmOff(298, 7, { status: "deleted" }, off), "off");
});

test("the lead record says it is on the campaign: never hidden", () => {
  assert.equal(confirmOff(298, 7, { status: "found", campaignIds: [298], email: "a@b.com" }, off), "on");
});

test("the campaign search finds it: never hidden, whatever the lead record says", () => {
  const hit = { ok: true as const, total: 1, leadIds: [7] };
  assert.equal(confirmOff(298, 7, { status: "found", campaignIds: [], email: "a@b.com" }, hit), "on");
  assert.equal(confirmOff(298, 7, { status: "deleted" }, hit), "on");
});

test("anything unclear leaves the lead listed", () => {
  // the lead could not be read
  assert.equal(confirmOff(298, 7, { status: "error" }, off), "unsure");
  // no search (no email to search by) or the search failed
  assert.equal(confirmOff(298, 7, { status: "found", campaignIds: [], email: null }, null), "unsure");
  assert.equal(confirmOff(298, 7, { status: "deleted" }, { ok: false }), "unsure");
  // a search that did not narrow to one person proves nothing
  assert.equal(confirmOff(298, 7, { status: "found", campaignIds: [], email: "a@b.com" }, { ok: true, total: 1740, leadIds: [1, 2, 3] }), "unsure");
});
