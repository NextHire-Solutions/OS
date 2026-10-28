/*
 * The reply agent's do-not-contact check (28 Oct): a client's DNC List by address, as before — and an agent a client
 * moved to their DNC List from the new portal's Market, whose address is kept apart (os_market_dnc_emails, migration
 * 0044). Before that migration the table is not there: nothing else is held for it. Fake database only.
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";

import { createClient } from "@supabase/supabase-js";

import { FakePostgrest } from "../test/fake-postgrest.ts";

const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

const fake = new FakePostgrest();
const db = createClient("https://supabase.test", "fake", { auth: { persistSession: false }, global: { fetch: fake.fetch as typeof fetch } });

let gather: typeof import("./safety-facts.ts").gatherSafetyFacts;
let DEFAULT_SCHEDULE: typeof import("./agent-config.ts").DEFAULT_SCHEDULE;
if (canMock) {
  for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});
  mock.module("../../../supabase/admin", { namedExports: { createAdminSupabase: () => db } });
  ({ gatherSafetyFacts: gather } = await import("./safety-facts.ts"));
  ({ DEFAULT_SCHEDULE } = await import("./agent-config.ts"));
}

function seed(): string {
  fake.reset();
  const [lead] = fake.seed("leads", [{ email: "Jane.Doe@KW.test" }]);
  const [thread] = fake.seed("threads", [{ lead_id: lead.id, client_id: "c1" }]);
  for (const t of ["label_assignments", "agent_thread_state", "messages", "client_dnc_entries", "os_market_dnc_emails"]) fake.seed(t, []);
  return thread.id;
}
const facts = (threadId: string) =>
  gather({ workspaceId: "w1", threadId, agentId: "a1", runMode: "shadow", schedule: DEFAULT_SCHEDULE, lastInboundText: "Sounds good", hasRecipient: true, now: new Date("2026-10-28T15:00:00Z") });

test("not on any DNC list: may be contacted", { skip }, async () => {
  const t = seed();
  assert.equal((await facts(t)).doNotContact, false);
});

test("on a client's DNC List by address (any case): do not contact — as before", { skip }, async () => {
  const t = seed();
  fake.seed("client_dnc_entries", [{ client_id: "c2", kind: "agent", name: "Jane", email: "jane.doe@kw.test" }]);
  assert.equal((await facts(t)).doNotContact, true);
});

test("moved to a client's DNC List from Market (by name; the address kept apart): do not contact", { skip }, async () => {
  const t = seed();
  const [entry] = fake.seed("client_dnc_entries", [{ client_id: "c2", kind: "agent", name: "Jane Doe", email: null, notes: "From Market" }]);
  fake.seed("os_market_dnc_emails", [{ entry_id: entry.id, client_id: "c2", email: "jane.doe@kw.test" }]);
  assert.equal((await facts(t)).doNotContact, true);
});

test("before migration 0044 (no such table): read as not on it — nothing else is held", { skip }, async () => {
  const t = seed();
  fake.missingTables.add("os_market_dnc_emails");
  assert.equal((await facts(t)).doNotContact, false);
});

test("any other failure reading it holds, as the DNC List's own does", { skip }, async () => {
  const t = seed();
  fake.failWhen = ({ table }) => table === "os_market_dnc_emails";
  assert.equal((await facts(t)).doNotContact, true);
});

test("a refused permission (or any error but 'no such table') holds — even one that names the table (28 Oct audit)", { skip }, async () => {
  const t = seed();
  fake.failWhen = ({ table }) => (table === "os_market_dnc_emails" ? { code: "42501", message: "permission denied for table os_market_dnc_emails", status: 403 } : false);
  assert.equal((await facts(t)).doNotContact, true);
  const t2 = seed();
  fake.failWhen = ({ table }) => (table === "os_market_dnc_emails" ? { code: "PGRST204", message: "Could not find the 'email' column of 'os_market_dnc_emails' in the schema cache", status: 400 } : false);
  assert.equal((await facts(t2)).doNotContact, true);
  // PostgreSQL's own "no such table" (42P01) is read as not there yet.
  const t3 = seed();
  fake.failWhen = ({ table }) => (table === "os_market_dnc_emails" ? { code: "42P01", message: 'relation "public.os_market_dnc_emails" does not exist', status: 404 } : false);
  assert.equal((await facts(t3)).doNotContact, false);
});
