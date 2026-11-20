/*
 * Onboarding's campaign build attaches the Nicole Pool: only its HEALTHY inboxes since 20 Nov (the team: "regardless
 * of how the campaign is created"). EmailBison is a fake fetch that records every call; the database, templates and
 * the health check are fakes. Nothing here can reach a real service.
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";

for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});
process.env.ONBOARDING_BISON_BASE_URL = "https://bison.test";
process.env.ONBOARDING_BISON_API_KEY = "test-key";

const calls: Array<{ method: string; path: string; body: unknown }> = [];
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = String(init?.method ?? "GET").toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  calls.push({ method, path: url.pathname + url.search, body });
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  if (url.pathname === "/api/campaigns" && method === "POST") return json({ data: { id: 5150, status: "draft" } });
  if (url.pathname === "/api/sender-emails") return json({ data: [{ id: 1 }, { id: 2 }, { id: 3 }] });
  if (url.pathname === "/api/tags" && method === "POST") return json({ data: { id: 77 } });
  return json({ data: {} });
}) as typeof fetch;

const logged: Array<{ action: string; status: string; request: unknown }> = [];
let health: (ids: readonly number[]) => Promise<{ ids: number[]; leftOut: number; unchecked: boolean; note: string | null }>;
const chain = () => { const b: Record<string, unknown> = {}; for (const k of ["update", "eq", "select"]) b[k] = () => b; b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok); return b; };
mock.module("./db", { namedExports: { getOnboardingDb: () => ({ from: () => chain() }) } });
mock.module("./templates", { namedExports: { listTemplates: async () => [] } });
mock.module("./deliveries", {
  namedExports: {
    hasDelivery: async () => false,
    recordPendingEmail: async () => {},
    logDelivery: async (_c: string, _t: string, action: string, status: string, request: unknown) => { logged.push({ action, status, request }); },
  },
});
mock.module("@/lib/clients/people-sync", { namedExports: { mirrorPeopleToMaster: async () => {} } });
mock.module("@/lib/tools/analytics/campaigns/attach-health-io", { namedExports: { healthyOnly: (ids: readonly number[]) => health(ids) } });

const { buildBisonCampaign } = await import("./connector-bison.ts");
const client = { id: "orch-1", client_name: "Test Realty", timezone: "America/New_York", sender_name: null } as never;
const attachCalls = () => calls.filter((c) => /attach-sender-emails$/.test(c.path));

test("onboarding attaches only the pool's healthy inboxes, and logs what was left out", async () => {
  calls.length = 0; logged.length = 0;
  health = async (ids) => ({ ids: ids.filter((id) => id !== 2), leftOut: 1, unchecked: false, note: "1 inbox left out by the health rules: 1 tagged Dead." });
  const r = await buildBisonCampaign(client);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(attachCalls().map((c) => (c.body as { sender_email_ids: number[] }).sender_email_ids), [[1, 3]], "inbox 2 never sent");
  const log = logged.find((l) => l.action === "build_campaign");
  assert.deepEqual((log?.request as Record<string, unknown>)?.senders, 2);
  assert.match(String((log?.request as Record<string, unknown>)?.inboxes_note), /left out by the health rules/);
});

test("health unreadable: the campaign is built with no inboxes, and the log says why", async () => {
  calls.length = 0; logged.length = 0;
  health = async (ids) => ({ ids: [], leftOut: ids.length, unchecked: true, note: "No inboxes added: the check is down. Add them with Assign once it can." });
  const r = await buildBisonCampaign(client);
  assert.equal(r.ok, true);
  assert.deepEqual(attachCalls(), []);
  assert.match(String((logged.find((l) => l.action === "build_campaign")?.request as Record<string, unknown>)?.inboxes_note), /No inboxes added/);
});
