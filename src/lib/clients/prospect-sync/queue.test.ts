import { mock, test } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest } from "../../tools/master-inbox/test/fake-postgrest.ts";

configureFakeEnvironment("MASTER_INBOX_");
const db = new FakePostgrest();
globalThis.fetch = db.fetch as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const { recordProspectChanges } = await import("./queue.ts");

const P = "2944199b-bfbc-4e97-aeed-c38ba28f40b0";
const ON = { OS_PROSPECT_SYNC: "1", OS_PROSPECT_SYNC_ONLY: P };
const posts: string[] = [];
const slack = async (t: string) => { posts.push(t); };
const input = (action: "add" | "remove", ids: string[], extra = {}) => ({
  portalId: P, isDemo: false, osClientId: "os-homebase", clientName: "Homebase", action, source: "prospects" as const,
  agents: ids.map((id) => ({ id, name: `Agent ${id}` })), who: "amy@brokerstaffer.com", ...extra,
});
const rows = () => db.rows("os_prospect_sync");

function seed(existing: Array<Record<string, unknown>> = []) {
  db.reset();
  posts.length = 0;
  db.seed("os_prospect_sync", existing);
}

test("switched off: recorded all the same (applied once it is on) — Slack not told yet; the Demo never recorded", async () => {
  seed();
  assert.deepEqual(await recordProspectChanges(input("add", ["a1"]), { env: {}, slack }), { mode: "off", recorded: 1 });
  assert.deepEqual(rows().map((x) => [x.agent_id, x.status, x.test]), [["a1", "pending", false]]);
  assert.equal(posts.length, 0, "nothing announced that isn't happening yet");
  seed();
  assert.deepEqual(await recordProspectChanges(input("add", ["a1"], { isDemo: true }), { env: { OS_PROSPECT_SYNC: "1" }, slack }), { mode: "off", recorded: 0 });
  assert.equal(rows().length, 0);
  assert.equal(posts.length, 0);
});

test("one row per agent, marked test while fenced; Slack told once, naming them", async () => {
  seed();
  const r = await recordProspectChanges(input("add", ["a1", "a2", "a1"]), { env: ON, slack });
  assert.deepEqual(r, { mode: "test", recorded: 2 });
  assert.deepEqual(rows().map((x) => [x.agent_id, x.action, x.status, x.source, x.test, x.requested_by, x.os_client_id]), [
    ["a1", "add", "pending", "prospects", true, "amy@brokerstaffer.com", "os-homebase"],
    ["a2", "add", "pending", "prospects", true, "amy@brokerstaffer.com", "os-homebase"],
  ]);
  assert.equal(posts.length, 1);
  assert.match(posts[0], /^TEST — 🎯 {2}\*Prospects updated — Homebase\*\n {3}➕ 2 agents added: Agent a1, Agent a2/);
  // Live (no fence): not a test.
  seed();
  await recordProspectChanges(input("add", ["a3"]), { env: { OS_PROSPECT_SYNC: "1" }, slack });
  assert.equal(rows()[0].test, false);
  assert.doesNotMatch(posts[0], /TEST/);
});

test("every change its own row — nothing waiting is set aside or reused (the run weighs them against the list); a moment's grace before the run looks; a removal keeps the campaigns the portal showed", async () => {
  seed([
    { id: 1, portal_id: P, agent_id: "a1", action: "add", status: "pending" },
    { id: 2, portal_id: P, agent_id: "a2", action: "remove", status: "pending" },
    { id: 3, portal_id: P, agent_id: "a3", action: "add", status: "done" },
    { id: 4, portal_id: "other-portal", agent_id: "a1", action: "add", status: "pending" },
  ]);
  const now = new Date("2026-11-03T15:00:00.000Z");
  const shown = [{ provider: "emailbison", id: "292", name: "Homebase 1 + Boston (EST)" }];
  const r = await recordProspectChanges({ ...input("remove", ["a1", "a2", "a3"]), agents: [{ id: "a1", name: "Agent a1", inCampaigns: shown }, { id: "a2", name: "Agent a2" }, { id: "a3", name: "Agent a3" }] }, { env: ON, slack, now });
  assert.equal(r.recorded, 3, "a2's removal waiting already is no reason to skip this one");
  const byId = new Map(rows().map((x) => [x.id, x]));
  assert.deepEqual([1, 2, 3, 4].map((i) => byId.get(i)?.status), ["pending", "pending", "done", "pending"], "nothing that was there is changed");
  const fresh = rows().filter((x) => typeof x.id !== "number");
  assert.deepEqual(fresh.map((x) => [x.agent_id, x.action]).sort(), [["a1", "remove"], ["a2", "remove"], ["a3", "remove"]]);
  assert.ok(fresh.every((x) => x.next_try_at === new Date(now.getTime() + 90_000).toISOString()), "not looked at for 90 seconds");
  assert.deepEqual(fresh.find((x) => x.agent_id === "a1")?.in_campaigns, shown);
  assert.equal(fresh.find((x) => x.agent_id === "a2")?.in_campaigns, null);
  assert.match(posts[0], /➖ 3 agents removed/);
  // An add never carries campaigns.
  seed();
  await recordProspectChanges({ ...input("add", ["a1"]), agents: [{ id: "a1", name: "Agent a1", inCampaigns: shown }] }, { env: ON, slack, now });
  assert.equal(rows()[0].in_campaigns, null);
});
