/*
 * Migration 0043 (pay per lead), read from disk: what running it can change.
 * Two new, empty os_* tables (RLS on, no policy), idempotent, nothing else —
 * and the defaults that keep it off and in test mode.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { OS_TABLES } from "../os-tables.ts";

const FILE = path.join(process.cwd(), "migrations", "0043_usage_billing.sql");
const sql = fs.readFileSync(FILE, "utf8");
const statements = sql
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n")
  .split(";")
  .map((s) => s.replace(/\s+/g, " ").trim())
  .filter(Boolean);
const TABLES = ["os_usage_billing_settings", "os_usage_billing_periods"];

test("0043 says a person must run it, and that it switches nothing on", () => {
  assert.match(sql, /NOT RUN\. A PERSON MUST RUN THIS/);
  assert.match(sql, /MASTER INBOX\s+-- SUPABASE PROJECT|MASTER INBOX SUPABASE PROJECT/);
  assert.match(sql, /WHAT RUNNING IT SWITCHES ON\s+--\s+-- Nothing\./);
});

test("0043 only creates its two os_* tables and their indexes, IF NOT EXISTS, RLS on, no policy", () => {
  const allowed = [
    /^BEGIN$/i,
    /^COMMIT$/i,
    /^CREATE TABLE IF NOT EXISTS public\.(os_\w+) \(/i,
    /^CREATE INDEX IF NOT EXISTS \w+ ON public\.(os_\w+) /i,
    /^ALTER TABLE public\.(os_\w+) ENABLE ROW LEVEL SECURITY$/i,
  ];
  for (const stmt of statements) {
    const hit = allowed.find((re) => re.test(stmt));
    assert.ok(hit, `unexpected statement in 0043: ${stmt.slice(0, 120)}`);
    const table = hit.exec(stmt)?.[1];
    if (table) assert.ok(TABLES.includes(table), `0043 touches ${table}`);
  }
  const created = statements.map((x) => /^CREATE TABLE IF NOT EXISTS public\.(\w+)/i.exec(x)?.[1]).filter(Boolean);
  assert.deepEqual(created.sort(), [...TABLES].sort());
  for (const t of TABLES) {
    assert.ok((OS_TABLES as readonly string[]).includes(t), `${t} is reachable only through osTable()`);
    assert.ok(statements.some((x) => new RegExp(`^ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY$`, "i").test(x)), `${t}: RLS on`);
  }
  assert.doesNotMatch(statements.join(" "), /CREATE POLICY|\bUPDATE\b|\bDELETE FROM\b|\bDROP\b|\bINSERT\b|ALTER COLUMN|ADD COLUMN/i);
});

test("0043's defaults: off, test only, every 7 or 14 days, handoffs; one row per client per period", () => {
  assert.match(sql, /enabled\s+boolean\s+NOT NULL DEFAULT false/);
  assert.match(sql, /test_only\s+boolean\s+NOT NULL DEFAULT true/);
  assert.match(sql, /test_mode\s+boolean\s+NOT NULL DEFAULT true/);
  assert.match(sql, /every_days\s+integer\s+NOT NULL DEFAULT 7 CHECK \(every_days IN \(7, 14\)\)/);
  assert.match(sql, /lead_source\s+text\s+NOT NULL DEFAULT 'handoffs' CHECK \(lead_source IN \('handoffs', 'introductions'\)\)/);
  assert.match(sql, /status\s+text\s+NOT NULL DEFAULT 'preview' CHECK \(status IN \('preview', 'draft', 'charged', 'paid', 'failed', 'void'\)\)/);
  assert.match(sql, /UNIQUE \(os_client_id, period_start\)/, "the database's never-twice");
});

test("the scheduled run is registered only behind OS_USAGE_BILLING_ENABLED=1 on Railway (schedulerAllowed), re-checked on every tick", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src", "instrumentation.ts"), "utf8");
  const at = src.indexOf('import("./lib/clients/usage-billing/billing")');
  assert.ok(at > 0, "registered in instrumentation.ts");
  const gate = src.lastIndexOf("if (schedulerAllowed(process.env)) {", at);
  assert.ok(gate > 0 && gate < at, "inside the switch");
  const block = src.slice(gate, src.indexOf("\n  }\n", gate));
  assert.match(block, /if \(usageRunning \|\| !schedulerAllowed\(process\.env\)\) return;/);
  assert.match(block, /setInterval\(runUsageSafely, 60 \* 60_000\)/);
  assert.equal((src.match(/runUsageBilling/g) ?? []).length, 2, "one import, one call — nowhere else");
});
