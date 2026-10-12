/*
 * The SMS rules the OS shares with the standalone Master Inbox.
 *
 * Ported from the standalone's lib/portals/team-sms.test.ts (c4b6b77). That
 * file also drives the portal's own PATCH /api/portal/[token]/team/[id] route
 * — the per-member switch on the client portal's Team page. The portal is
 * served by the standalone app, so that route and its six tests stay there;
 * the three below are the ones about code the OS runs. What the notifier is
 * sent, switch by switch, is in ../webhooks/n8n-introduction.test.ts.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest } from "../test/fake-postgrest.ts";

configureFakeEnvironment("MASTER_INBOX_");

const db = new FakePostgrest();
let rejectQuery: ((url: URL) => boolean) | null = null;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (rejectQuery?.(url)) {
    return new Response(
      JSON.stringify({ code: "42703", message: "column does not exist", details: null, hint: null }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  return db.fetch(input, init);
}) as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const { TEAM_SMS_FLAG, SMS_APPROVED_FIELD, loadTeamSmsSettings, loadSmsRecipients, smsBodyFor } = await import("./team-sms.ts");
const { createAdminSupabase } = await import("@/lib/supabase/admin");

const DEMO = "00ef116c-646d-43b4-a323-680548ea7126";
const OTHER = "11111111-1111-4111-8111-111111111111";

function seed() {
  db.reset();
  rejectQuery = null;
  db.seed("clients", [
    { id: DEMO, name: "Demo Portal", feature_flags: { [TEAM_SMS_FLAG]: true } },
    { id: OTHER, name: "Other Client", feature_flags: { manage_stages: true } },
  ]);
  const [eddy, ryan] = db.seed("client_team_members", [
    { client_id: DEMO, name: "Eddy", phone: "7184150537", active: true, receives_sms: true },
    { client_id: DEMO, name: "Ryan", phone: "+16475720433", active: true, receives_sms: false },
    { client_id: OTHER, name: "Olivia", phone: "3105550111", active: true, receives_sms: true },
  ]);
  return { eddy, ryan };
}

test("the names are the contract with the standalone app and the notifier", () => {
  // Both apps write this flag to the same column and the notifier requires this
  // field; a rename on one side would silently stop every text.
  assert.equal(TEAM_SMS_FLAG, "team_sms_notifications");
  assert.equal(SMS_APPROVED_FIELD, "sms_enabled");
});

test("the Team page reads each member's switch for its own client", async () => {
  const { eddy, ryan } = seed();
  assert.deepEqual(await loadTeamSmsSettings(DEMO), { [eddy.id]: true, [ryan.id]: false });
});

test("if the switches can't be read, the page gets null (SMS column hidden)", async () => {
  seed();
  rejectQuery = (u) => u.pathname.endsWith("/client_team_members");
  assert.equal(await loadTeamSmsSettings(DEMO), null);
});

test("recipients: only clients with SMS on appear, with only the members switched on", async () => {
  seed();
  const r = await loadSmsRecipients(createAdminSupabase(), [DEMO, OTHER]);
  assert.deepEqual(r?.get(DEMO), { ok: true, team: [{ name: "Eddy", mobile: "7184150537" }] });
  assert.equal(r?.has(OTHER), false, "SMS off: absent, so nothing is sent for that client");
});

test("recipients: flags unreadable means nobody; switches unreadable means not that client", async () => {
  seed();
  rejectQuery = (u) => u.pathname.endsWith("/clients");
  assert.equal(await loadSmsRecipients(createAdminSupabase(), [DEMO, OTHER]), null);
  rejectQuery = (u) => u.pathname.endsWith("/client_team_members");
  const r = await loadSmsRecipients(createAdminSupabase(), [DEMO, OTHER]);
  assert.deepEqual(r?.get(DEMO), { ok: false });
  assert.equal(r?.has(OTHER), false);
});

test("smsBodyFor: SMS off, nobody on, or unreadable sends nothing; on sends the team, marked approved", () => {
  const A = { name: "A", mobile: "1" };
  const B = { name: "B", mobile: "2" };
  const payload = { event: "lead.introduction", team: [A, B] };
  assert.equal(smsBodyFor(payload, "x", null), null, "settings unreadable");
  assert.equal(smsBodyFor(payload, "x", new Map()), null, "SMS alerts off");
  const only = smsBodyFor(payload, "x", new Map([["x", { ok: true as const, team: [A] }]]));
  assert.deepEqual(only, { event: "lead.introduction", team: [A], sms_enabled: true });
  assert.notEqual(only, payload, "a copy, never the shared object");
  assert.deepEqual(payload.team, [A, B], "the shared payload (Bison's base) is untouched");
  assert.equal(smsBodyFor(payload, "x", new Map([["x", { ok: true as const, team: [] }]])), null);
  assert.equal(smsBodyFor(payload, "x", new Map([["x", { ok: false as const }]])), null);
});
