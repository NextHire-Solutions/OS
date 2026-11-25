/*
 * CLIENT_HEALTH_DB=master-inbox (Nov 2026): every Client Health read and write goes to the Master Inbox project's
 * `client_health` schema — the Master Inbox URL and key, the schema named on every request — and never to Client
 * Health's own project. (merge-switch-off.test.ts proves the setting absent leaves everything as it was.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.CLIENT_HEALTH_DB = "master-inbox";
process.env.MASTER_INBOX_SUPABASE_URL = "https://mi-test.supabase.co";
process.env.MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY = "mi-key";
process.env.CLIENT_HEALTH_SUPABASE_URL = "https://ch-test.supabase.co";
process.env.CLIENT_HEALTH_SUPABASE_SERVICE_ROLE_KEY = "ch-key";

const seen: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const h = new Headers(init?.headers);
  seen.push({ url: String(input), method: init?.method ?? "GET", headers: Object.fromEntries(h.entries()) });
  return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { getSupabase, clientHealthInMasterInbox, clientHealthDbEnv, CLIENT_HEALTH_SCHEMA } = await import("./supabase.ts");

test("reads go to the Master Inbox project, client_health schema, Master Inbox key", async () => {
  assert.equal(clientHealthInMasterInbox(), true);
  await getSupabase().from("weekly_metrics").select("*").eq("week_key", "2026-11-24");
  const r = seen.at(-1)!;
  assert.ok(r.url.startsWith("https://mi-test.supabase.co/rest/v1/weekly_metrics"), r.url);
  assert.equal(r.headers["accept-profile"], CLIENT_HEALTH_SCHEMA);
  assert.equal(r.headers.apikey, "mi-key");
});

test("writes too: the schema rides on Content-Profile", async () => {
  await getSupabase().from("clients").update({ status: "paused" }).eq("id", "x");
  const r = seen.at(-1)!;
  assert.equal(r.method, "PATCH");
  assert.ok(r.url.startsWith("https://mi-test.supabase.co/rest/v1/clients"), r.url);
  assert.equal(r.headers["content-profile"], CLIENT_HEALTH_SCHEMA);
});

test("nothing ever reaches Client Health's own project", () => {
  assert.ok(seen.length >= 2);
  assert.ok(seen.every((r) => !r.url.includes("ch-test")));
});

test("the 'is it configured' checks name the Master Inbox settings", () => {
  assert.deepEqual(clientHealthDbEnv(), ["MASTER_INBOX_SUPABASE_URL", "MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY"]);
});

test("migration 0057 creates the six tables the code uses, closed to the browser roles", () => {
  const sql = fs.readFileSync(new URL("../../../../migrations/0057_client_health_schema.sql", import.meta.url), "utf8");
  for (const t of ["clients", "bison_campaigns", "instantly_campaigns", "weekly_metrics", "campaign_toggle_log", "sync_runs"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS client_health\\.${t} \\(`), t);
    assert.match(sql, new RegExp(`ALTER TABLE client_health\\.${t} ENABLE ROW LEVEL SECURITY`), `${t} RLS`);
  }
  assert.doesNotMatch(sql, /GRANT[^;]*\b(anon|authenticated)\b/i, "no grant to the browser roles");
  assert.match(sql, /REVOKE ALL ON SCHEMA client_health FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /START WITH 1000/, "the log's ids continue above the copied rows");
});
