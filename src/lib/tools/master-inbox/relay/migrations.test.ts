/*
 * The relay's two migrations, read from disk: what running them can change.
 *
 * Both run in the Master Inbox database, which the standalone inbox and the
 * client portals use live. The promise is that running them changes nothing
 * anyone sees: new os_* tables, two new os_clients columns with defaults that
 * mean "today's behaviour", nothing updated, dropped or re-defaulted. These
 * tests hold the files to that, statement by statement (comments ignored).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { OS_TABLES } from "../../../clients/os-tables.ts";

function statements(file: string): string[] {
  const sql = fs.readFileSync(path.join(process.cwd(), "migrations", file), "utf8");
  return sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const RELAY_TABLES = ["os_relay_settings", "os_brokerage_relays", "os_brokerage_relay_agents", "os_relay_campaigns"];

test("0036 adds pipeline_entry with today's behaviour for EVERY row — no default flip to 'interested' (review decision, 17 Oct)", () => {
  const s = statements("0036_client_pipeline_entry.sql");
  assert.equal(s.length, 1, s.join("\n"));
  assert.match(s[0], /^ALTER TABLE public\.os_clients ADD COLUMN IF NOT EXISTS pipeline_entry text NOT NULL DEFAULT 'introduction' CHECK \(pipeline_entry IN \('introduction', 'interested'\)\)$/i);
  const all = s.join(" ");
  assert.doesNotMatch(all, /SET DEFAULT/i, "a client created after 0036 must read 'introduction' too, until the portal side exists");
  assert.doesNotMatch(all, /\bUPDATE\b|\bDELETE\b|\bDROP\b|\bINSERT\b/i);
});

test("0035 only creates the relay's own os_* tables (RLS on, no policy) and one os_clients column defaulting to 'off'", () => {
  const s = statements("0035_brokerage_relay.sql");
  const allowed = [
    /^BEGIN$/i,
    /^COMMIT$/i,
    /^CREATE TABLE IF NOT EXISTS public\.(os_\w+) \(/i,
    /^CREATE INDEX IF NOT EXISTS \w+ ON public\.(os_\w+) /i,
    /^ALTER TABLE public\.(os_\w+) ENABLE ROW LEVEL SECURITY$/i,
    /^ALTER TABLE public\.os_clients ADD COLUMN IF NOT EXISTS relay_settings jsonb NOT NULL DEFAULT '\{\}'::jsonb$/i,
  ];
  for (const stmt of s) {
    const hit = allowed.find((re) => re.test(stmt));
    assert.ok(hit, `unexpected statement in 0035: ${stmt.slice(0, 120)}`);
    const table = hit.exec(stmt)?.[1];
    if (table) assert.ok(RELAY_TABLES.includes(table), `0035 touches ${table}`);
  }
  const created = s.map((x) => /^CREATE TABLE IF NOT EXISTS public\.(\w+)/i.exec(x)?.[1]).filter(Boolean);
  assert.deepEqual(created.sort(), [...RELAY_TABLES].sort());
  for (const t of RELAY_TABLES) {
    assert.ok((OS_TABLES as readonly string[]).includes(t), `${t} is reachable only through osTable()`);
    assert.ok(s.some((x) => new RegExp(`^ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY$`, "i").test(x)), `${t}: RLS on`);
  }
  assert.doesNotMatch(s.join(" "), /CREATE POLICY|\bUPDATE\b|\bDELETE FROM\b|\bDROP\b|\bINSERT\b|ALTER COLUMN/i);
});

test("0035's defaults are the cautious answers: off, practice, one click, nothing forwarded, not an introduction", () => {
  const sql = fs.readFileSync(path.join(process.cwd(), "migrations", "0035_brokerage_relay.sql"), "utf8");
  assert.match(sql, /enabled\s+boolean\s+NOT NULL DEFAULT false/);
  assert.match(sql, /practice_mode\s+boolean\s+NOT NULL DEFAULT true/);
  assert.match(sql, /mode\s+text\s+NOT NULL DEFAULT 'one_click'/);
  assert.match(sql, /forward_later_replies\s+boolean\s+NOT NULL DEFAULT false/);
  assert.match(sql, /counts_as_introduction\s+boolean\s+NOT NULL DEFAULT false/);
  assert.match(sql, /practice\s+boolean\s+NOT NULL DEFAULT true/);
  // The once-only guarantees are the database's.
  assert.match(sql, /dedupe_key\s+text\s+NOT NULL UNIQUE/);
  assert.match(sql, /PRIMARY KEY \(workspace_id, os_client_id, agent_email, mode\)/);
});
