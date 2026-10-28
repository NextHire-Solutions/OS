/*
 * The portal's usage alerts (21 Oct) — fake database only. The user: "we should
 * not pause any funtionality in the client portal. just alert in OS should work".
 * os_portal_usage_add is stood in for by the same arithmetic as its SQL (0038).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createClient } from "@supabase/supabase-js";

import { FakePostgrest } from "../tools/master-inbox/test/fake-postgrest.ts";
import { alertMarketMove, HEAVY_USE, PAGING_PAGES, recordUse, todayRows } from "./usage.ts";

const fake = new FakePostgrest();
globalThis.fetch = fake.fetch as typeof fetch;
const supa = createClient("https://supabase.test", "fake", { auth: { persistSession: false }, global: { fetch: fake.fetch as typeof fetch } });
type Row = Record<string, unknown>;
type Totals = { requests: number; rows: number };
const db = {
  from: (t: string) => supa.from(t),
  async rpc(fn: string, a: Record<string, unknown>) {
    assert.equal(fn, "os_portal_usage_add");
    const rows = fake.rows("os_portal_usage") as Row[];
    const key = (r: Row) => [r.day, r.who, r.portal_id, r.kind].join("|");
    const k = [a.p_day, String(a.p_who).toLowerCase(), a.p_portal, a.p_kind].join("|");
    const hit = rows.find((r) => key(r) === k);
    if (hit) { hit.requests = Number(hit.requests) + Number(a.p_requests); hit.rows = Number(hit.rows) + Number(a.p_rows); }
    else fake.seed("os_portal_usage", [...rows, { day: a.p_day, who: String(a.p_who).toLowerCase(), portal_id: a.p_portal, kind: a.p_kind, requests: a.p_requests, rows: a.p_rows }]);
    const all = fake.rows("os_portal_usage") as Row[];
    const sum = (f: (r: Row) => boolean): Totals => all.filter(f).reduce<Totals>((s, r) => ({ requests: s.requests + Number(r.requests), rows: s.rows + Number(r.rows) }), { requests: 0, rows: 0 });
    return {
      data: {
        person: sum((r) => r.day === a.p_day && r.who === String(a.p_who).toLowerCase() && r.kind === a.p_kind),
        portal: sum((r) => r.day === a.p_day && r.portal_id === a.p_portal && r.kind === a.p_kind),
      },
      error: null,
    };
  },
};

const P = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-22T15:00:00.000Z");
const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
function seed() {
  fake.reset();
  for (const t of ["os_portal_usage", "os_notifications"]) fake.seed(t, []);
  fake.seed("clients", [{ id: P, name: "C21 Results - Elite Team" }]);
}
const client = (who: string, now = NOW) => ({ who, role: "client" as const, portalId: P, now });
const titles = () => (fake.rows("os_notifications") as Row[]).map((n) => String(n.title));

test("nothing here refuses, pauses or slows a client — there is no such function", () => {
  const src = fs.readFileSync("src/lib/portal-usage/usage.ts", "utf8");
  // alertMarketMove (28 Oct) only tells our team — it refuses nothing either.
  assert.deepEqual([...src.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]), ["recordUse", "alertMarketMove", "todayRows"]);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(code, /os_portal_locks|status: 4\d\d|status: 5\d\d/);
  // What it writes: its own counts, and one bell notice — nothing else.
  assert.deepEqual([...code.matchAll(/\.rpc\("(\w+)"/g)].map((m) => m[1]), ["os_portal_usage_add"]);
  assert.equal((code.match(/\.(insert|update|upsert|delete)\(/g) ?? []).length, 1);
  assert.match(code, /db\.from\("os_notifications"\)\.upsert\(row, \{ onConflict: "ref", ignoreDuplicates: true \}\)/);
});

test("our team is counted, never alerted on", async () => {
  seed();
  for (let i = 0; i < 40; i++) await recordUse(db, { who: "eddy@brokerstaffer.com", role: "staff", portalId: P, kind: "market", rows: 100, page: i + 2, now: at(i * 0.1) });
  assert.equal(fake.rows("os_notifications").length, 0);
  assert.equal((await todayRows(db, P, NOW))["eddy@brokerstaffer.com"], 4_000);
});

test("heavy use: our team hears once a day — for a person, and for the whole client", async () => {
  seed();
  const cap = HEAVY_USE.market.person.rows!;
  await recordUse(db, { ...client("angela@brokerage.test"), kind: "market", rows: cap - 50 });
  assert.deepEqual(titles(), []);
  await recordUse(db, { ...client("angela@brokerage.test"), kind: "market", rows: 50 });
  await recordUse(db, { ...client("angela@brokerage.test"), kind: "market", rows: 500 });
  assert.deepEqual(titles(), ["Heavy use today: angela@brokerage.test — agents viewed"], "once");
  await recordUse(db, { ...client("sam@brokerage.test"), kind: "market", rows: 2_000 });
  await recordUse(db, { ...client("lee@brokerage.test"), kind: "market", rows: 1_000 });
  assert.ok(titles().includes("Heavy use today: C21 Results - Elite Team (everyone together) — agents viewed"));
  const n = (fake.rows("os_notifications") as Row[])[0];
  assert.match(String(n.body), /Nothing was stopped\./);
});

test("paging like a script: an alert — and the paging carries on", async () => {
  seed();
  for (let i = 0; i < PAGING_PAGES; i++) await recordUse(db, { ...client("bot@brokerage.test"), kind: "market", rows: 50, page: i + 2, now: at(i * 0.1) });
  assert.deepEqual(titles(), ["Looks automated: bot@brokerage.test on C21 Results - Elite Team"]);
  for (let i = 0; i < PAGING_PAGES; i++) await recordUse(db, { ...client("bot@brokerage.test"), kind: "market", rows: 50, page: i + 2, now: at(5 + i * 0.1) });
  assert.equal(titles().filter((t) => t.startsWith("Looks automated")).length, 1, "once a day");
  // A person reading — 30 pages over an hour — is not alerted on.
  seed();
  for (let i = 0; i < 30; i++) await recordUse(db, { ...client("reader@brokerage.test"), kind: "market", rows: 50, page: i + 2, now: at(i * 2.5) });
  assert.deepEqual(titles(), []);
});

test("a count that cannot be written is skipped, never in the client's way", async () => {
  seed();
  const broken = { from: db.from, rpc: async () => ({ data: null, error: { message: "relation does not exist" } }) };
  await recordUse(broken, { ...client("angela@brokerage.test"), kind: "market", rows: 50 });
  assert.equal(fake.rows("os_notifications").length, 0);
});

test("migration 0038 only adds — one new table and one new function, nothing existing changed", () => {
  const sql = fs.readFileSync("migrations/0038_portal_usage.sql", "utf8").replace(/--.*$/gm, "");
  assert.deepEqual([...sql.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+)/g)].map((x) => x[1]), ["os_portal_usage"]);
  assert.deepEqual([...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/g)].map((x) => x[1]), ["os_portal_usage_add"]);
  // The function's own upsert into its own table is the only UPDATE.
  assert.doesNotMatch(sql.replace(/DO UPDATE\s+SET requests = public\.os_portal_usage\.requests/, ""), /\b(DROP|DELETE|UPDATE|TRUNCATE|RENAME)\b/i);
  for (const a of sql.matchAll(/ALTER TABLE\s+public\.(\w+)/gi)) assert.equal(a[1], "os_portal_usage");
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.os_portal_usage_add[^;]+FROM PUBLIC, anon, authenticated;/, "not callable from a browser");
  assert.match(sql, /BEGIN;[\s\S]*COMMIT;/);
});

test("a client's Market move to My Agents or the DNC List: our team hears every time — and nothing is refused", async () => {
  seed();
  const now = new Date("2026-10-28T15:00:00.000Z");
  await alertMarketMove(db, { who: "Owner@Elite.test", portalId: P, to: "DNC List", agents: 25, now });
  await alertMarketMove(db, { who: "owner@elite.test", portalId: P, to: "My Agents", agents: 1, now: new Date(now.getTime() + 1000) });
  const rows = fake.rows("os_notifications") as Row[];
  assert.deepEqual(rows.map((r) => [r.kind, r.severity, r.title]), [
    ["portal_market_move", "warning", "Market move: 25 agents to DNC List — C21 Results - Elite Team"],
    ["portal_market_move", "warning", "Market move: 1 agent to My Agents — C21 Results - Elite Team"],
  ]);
  assert.match(String(rows[0].body), /owner@elite\.test moved 25 agents from Market onto C21 Results - Elite Team's DNC List\. Their preferred emails are now blocked in every campaign and their conversations stopped — a block can't be undone\./);
  assert.doesNotMatch(String(rows[1].body), /conversations stopped/);
  // A failure to tell us never reaches the client's move.
  fake.failWhen = ({ table }) => table === "os_notifications";
  await alertMarketMove(db, { who: "x@y.test", portalId: P, to: "DNC List", agents: 3, now: new Date(now.getTime() + 2000) });
  fake.failWhen = null;
});
