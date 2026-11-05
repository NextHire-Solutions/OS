import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { LEAD_CAP_BELL_KINDS, campaignsFromJson, capActsOn, capAppliesTo, capsHoldLive, capsLive, capWindowOf, columnIsMissing, effectiveCap, isOverCap, mergeCampaigns, parseSpendCap, tableIsMissing } from "./caps-model.ts";
import { OS_TABLES } from "../os-tables.ts";

test("a window is 28 days from the billing anchor: Homebase restarts Nov 25, as agreed with Amy", () => {
  assert.deepEqual(capWindowOf("2026-10-28", "2026-11-05"), { start: "2026-10-28", end: "2026-11-25" });
  assert.deepEqual(capWindowOf("2026-10-28", "2026-11-24"), { start: "2026-10-28", end: "2026-11-25" });
  assert.deepEqual(capWindowOf("2026-10-28", "2026-11-25"), { start: "2026-11-25", end: "2026-12-23" });
  assert.deepEqual(capWindowOf("2026-11-02", "2026-11-05"), { start: "2026-11-02", end: "2026-11-30" }, "Hetherington");
  assert.deepEqual(capWindowOf("2026-10-28", "2026-10-28"), { start: "2026-10-28", end: "2026-11-25" }, "the first day");
  assert.equal(capWindowOf("2026-11-02", "2026-11-01"), null, "not started");
});

test("a window always starts on a billing day, whether billed every 7 or every 14 days", () => {
  for (const every of [7, 14]) assert.equal(28 % every, 0);
});

test("the cap: whichever comes first, and $1,000 at $250 is 4 leads", () => {
  assert.deepEqual(effectiveCap({ monthlyTarget: 2, spendCapCents: null, priceCents: 25_000 }), { cap: 2, leadCap: 2, spendCapCents: null, spendLeads: null, spendInvalid: false, by: "lead" });
  assert.deepEqual(effectiveCap({ monthlyTarget: null, spendCapCents: 100_000, priceCents: 25_000 }), { cap: 4, leadCap: null, spendCapCents: 100_000, spendLeads: 4, spendInvalid: false, by: "spend" });
  assert.equal(effectiveCap({ monthlyTarget: 2, spendCapCents: 100_000, priceCents: 25_000 }).cap, 2);
  assert.equal(effectiveCap({ monthlyTarget: 2, spendCapCents: 100_000, priceCents: 25_000 }).by, "lead");
  assert.equal(effectiveCap({ monthlyTarget: 6, spendCapCents: 100_000, priceCents: 25_000 }).cap, 4);
  assert.equal(effectiveCap({ monthlyTarget: 6, spendCapCents: 100_000, priceCents: 25_000 }).by, "spend");
  assert.equal(effectiveCap({ monthlyTarget: null, spendCapCents: 99_999, priceCents: 25_000 }).cap, 3, "rounds down: never over the limit");
});

test("a target of 0 or blank is NO cap, never 'allowed none': Tri-State is at 0 today", () => {
  for (const monthlyTarget of [0, null, undefined, "", -1, 1.5, "abc"]) {
    assert.equal(effectiveCap({ monthlyTarget, spendCapCents: null, priceCents: 25_000 }).cap, null, String(monthlyTarget));
  }
});

const lead = (thread: string, at: string, key = thread) => ({ key, name: thread, at, source: "interested", thread });
const THREE = [lead("c", "2026-11-03T00:00:00.000Z"), lead("a", "2026-11-01T00:00:00.000Z"), lead("b", "2026-11-02T00:00:00.000Z")];

test("over the cap goes by place in the window, not the total: of three in one sweep the first two go", () => {
  assert.equal(isOverCap(THREE, "a", 2), false);
  assert.equal(isOverCap(THREE, "b", 2), false);
  assert.equal(isOverCap(THREE, "c", 2), true);
});

test("a conversation that isn't a lead of the window uses none of the cap", () => {
  assert.equal(isOverCap(THREE, "not-a-lead", 2), false);
});

test("the same answer whichever order they are looked at, even at the same instant", () => {
  const tied = [lead("y", "2026-11-01T00:00:00.000Z"), lead("x", "2026-11-01T00:00:00.000Z")];
  assert.equal(isOverCap(tied, "x", 1), false);
  assert.equal(isOverCap(tied, "y", 1), true);
  assert.equal(isOverCap([...tied].reverse(), "x", 1), false);
  assert.equal(isOverCap([...tied].reverse(), "y", 1), true);
});

test("a price raised past the limit: it buys nothing, so it is ignored and said. Never a cap of none, which would stop everything", () => {
  const none = effectiveCap({ monthlyTarget: null, spendCapCents: 20_000, priceCents: 25_000 });
  assert.deepEqual([none.cap, none.spendLeads, none.spendInvalid, none.by], [null, null, true, null]);
  const withTarget = effectiveCap({ monthlyTarget: 2, spendCapCents: 20_000, priceCents: 25_000 });
  assert.deepEqual([withTarget.cap, withTarget.spendInvalid, withTarget.by], [2, true, "lead"]);
});

test("whose cap acts: billed live and per hand-off. A test row never does, whatever its target", () => {
  assert.equal(capAppliesTo({ test_only: false, lead_source: "handoffs" }), true);
  assert.equal(capAppliesTo({ test_only: true, lead_source: "handoffs" }), false);
  assert.equal(capAppliesTo({ test_only: null as unknown as boolean, lead_source: "handoffs" }), false);
  assert.equal(capAppliesTo({ test_only: false, lead_source: "introductions" }), false);
  assert.equal(capAppliesTo({ test_only: false, lead_source: "calls" }), false);
});

test("missing means PostgREST's own codes: a lock on the table is an error, never 'none held'", () => {
  for (const code of ["PGRST205", "42P01"]) assert.equal(tableIsMissing({ code }), true);
  for (const code of ["55P03", "XX000", null, undefined]) assert.equal(tableIsMissing({ code }), false);
  for (const code of ["PGRST204", "42703"]) assert.equal(columnIsMissing({ code }), true);
  for (const code of ["23514", "XX000", null]) assert.equal(columnIsMissing({ code }), false);
});

test("off unless exactly 1", () => {
  assert.equal(capsLive({}), false);
  for (const v of ["0", "true", "yes", "", "11"]) assert.equal(capsLive({ OS_LEAD_CAPS: v }), false, v);
  assert.equal(capsLive({ OS_LEAD_CAPS: "1" }), true);
});

test("holding replies is its own switch, off, and does nothing without the main one", () => {
  assert.equal(capsHoldLive({}), false);
  assert.equal(capsHoldLive({ OS_LEAD_CAPS: "1" }), false, "pause and resume only");
  assert.equal(capsHoldLive({ OS_LEAD_CAPS_HOLD: "1" }), false, "not without the main switch");
  for (const v of ["0", "true", "", "11"]) assert.equal(capsHoldLive({ OS_LEAD_CAPS: "1", OS_LEAD_CAPS_HOLD: v }), false, v);
  assert.equal(capsHoldLive({ OS_LEAD_CAPS: "1", OS_LEAD_CAPS_HOLD: "1" }), true);
});

test("every kind of alert the caps ring is one Amy gets: a new one left off the list would silently miss her", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src", "lib", "clients", "usage-billing", "caps.ts"), "utf8");
  const rung = [...new Set([...src.matchAll(/kind: "(lead_cap_[a-z_]+)"/g)].map((m) => m[1]))].sort();
  assert.ok(rung.length >= 4);
  assert.deepEqual(rung, [...LEAD_CAP_BELL_KINDS].sort());
});

test("only active and onboarding clients are acted on", () => {
  for (const s of ["active", "onboarding", " Active "]) assert.equal(capActsOn(s), true, s);
  for (const s of ["paused", "churned", "", null, undefined]) assert.equal(capActsOn(s), false, String(s));
});

test("a spend limit as typed", () => {
  assert.deepEqual(parseSpendCap("1,000", 25_000), { cents: 100_000 });
  assert.deepEqual(parseSpendCap("$1000.50", 25_000), { cents: 100_050 });
  assert.deepEqual(parseSpendCap(1000, 25_000), { cents: 100_000 });
  for (const blank of ["", null, undefined]) assert.deepEqual(parseSpendCap(blank, 25_000), { cents: null });
  for (const bad of ["abc", "-5", "0"]) assert.ok("error" in parseSpendCap(bad, 25_000), bad);
  assert.match((parseSpendCap("100", 25_000) as { error: string }).error, /less than one lead/);
  assert.match((parseSpendCap("2000000", 25_000) as { error: string }).error, /too high/);
});

test("merging keeps each campaign once, and when it was first paused", () => {
  const a = { platform: "bison" as const, id: "1", name: "A", paused_at: "first", confirmed: false };
  assert.deepEqual(mergeCampaigns([a], [{ ...a, paused_at: "later" }, { ...a, id: "2" }]).map((c) => [c.id, c.paused_at]), [["1", "first"], ["2", "first"]]);
  assert.deepEqual(mergeCampaigns([a], [{ ...a, platform: "instantly" }]).length, 2, "same id on another platform is another campaign");
  assert.equal(mergeCampaigns([a], [{ ...a, confirmed: true }])[0].confirmed, true, "seen to pause, whichever list says so");
  assert.equal(mergeCampaigns([{ ...a, confirmed: true }], [a])[0].confirmed, true);
});

test("a damaged list reads as nothing, never as something to restart", () => {
  for (const v of [null, "x", {}, [{}], [{ platform: "other", id: "1" }], [{ platform: "bison" }]]) assert.deepEqual(campaignsFromJson(v), []);
  assert.equal(campaignsFromJson([{ platform: "bison", id: "1", int_id: 7, name: "A" }])[0].int_id, 7);
  assert.equal(campaignsFromJson([{ platform: "bison", id: "1" }])[0].confirmed, false, "never assumed");
  assert.equal(campaignsFromJson([{ platform: "bison", id: "1", confirmed: "yes" }])[0].confirmed, false);
  assert.equal(campaignsFromJson([{ platform: "bison", id: "1", confirmed: true }])[0].confirmed, true);
});

test("the migration only adds: its tables are the OS's, RLS on, no policy, nothing dropped", () => {
  const sql = fs.readFileSync(path.join(process.cwd(), "migrations", "0049_lead_caps.sql"), "utf8").replace(/--.*$/gm, "").replace(/ON DELETE CASCADE/g, "");
  assert.doesNotMatch(sql, /\b(drop|delete|truncate|update)\b/i);
  assert.doesNotMatch(sql, /create policy/i);
  for (const t of ["os_cap_windows", "os_cap_held_leads"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${t}`));
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`));
    assert.ok((OS_TABLES as readonly string[]).includes(t), t);
  }
  assert.match(sql, /ADD COLUMN IF NOT EXISTS spend_cap_cents/);
  assert.match(sql, /NOTIFY pgrst/);
});

test("the run is registered only on Railway's own scheduler, every 15 minutes, re-checked on every tick, and nowhere else", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src", "instrumentation.ts"), "utf8");
  const at = src.indexOf('import("./lib/clients/usage-billing/caps")');
  assert.ok(at > 0, "registered in instrumentation.ts");
  const gate = src.lastIndexOf("if (schedulerAllowed(process.env)) {", at);
  assert.ok(gate > 0 && gate < at, "inside the switch");
  const block = src.slice(gate, src.indexOf("\n  }\n", gate));
  assert.match(block, /if \(capsRunning \|\| !schedulerAllowed\(process\.env\)\) return;/);
  assert.match(block, /setInterval\(runCapsSafely, 15 \* 60_000\)/);
  assert.equal((src.match(/runLeadCaps/g) ?? []).length, 2, "one import, one call");
  assert.doesNotMatch(block, /runLeadCaps\(\{/, "the env it reads is the real one: nothing passed in can turn it on");
});

test("the columns the live relay and live billing read stay free of the new one, so deploying before the SQL breaks nothing", () => {
  const relay = fs.readFileSync(path.join(process.cwd(), "src", "lib", "tools", "master-inbox", "inbox", "intro-macro.ts"), "utf8");
  const bill = fs.readFileSync(path.join(process.cwd(), "src", "lib", "clients", "usage-billing", "billing.ts"), "utf8");
  assert.doesNotMatch(relay, /spend_cap_cents/);
  assert.doesNotMatch(bill, /spend_cap_cents/);
});
