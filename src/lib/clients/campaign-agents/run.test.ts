/*
 * Agents into a campaign from the agent database (28 Nov): the every-minute run, over a stand-in database, with
 * prospect-sync's REAL addInto deciding each agent and stand-ins for EmailBison. Proves: every matching agent is
 * collected; each is added the way Prospects adds one (new lead made; one EmailBison has added as it is; already in it;
 * bounced; no email); a client's own lists are left out; the attach is named for the person; failures retry; the job
 * finishes with its totals and the bell; a campaign that can no longer send stops the job.
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest } from "../../tools/master-inbox/test/fake-postgrest.ts";
import type { SyncAgent } from "../prospect-sync/agents.ts";

const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

configureFakeEnvironment("MASTER_INBOX_");
const db = new FakePostgrest();
globalThis.fetch = db.fetch as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const attaches: Array<{ campaignId: number; leadIds: number[]; actor: string }> = [];
let attachFails = false;
let mod: typeof import("./run.ts");
async function load() {
  if (mod) return;
  mock.module("@/lib/tools/analytics/campaigns/lead-membership", {
    namedExports: {
      attachLeads: async (campaignId: number, leadIds: number[], actor: string) => {
        if (attachFails) throw new Error("EmailBison: 503 Service Unavailable");
        attaches.push({ campaignId, leadIds, actor });
        return { ok: true, attempted: leadIds.length, applied: leadIds.length, skipped: 0, chunks: [{ size: leadIds.length, ok: true }], batchId: "b" };
      },
      removeLeads: async () => ({ ok: true }),
    },
  });
  mock.module("@/lib/tools/analytics/supabase", { namedExports: { analyticsTeamId: () => 7, getAnalyticsSupabase: () => ({}) } });
  mod = await import("./run.ts");
}

const agent = (id: string, email: string | null, extra: Partial<SyncAgent> = {}): SyncAgent => ({
  id, full_name: `Agent ${id.toUpperCase()}`, preferred_email: email, sources: ["courted"], source_ids: {}, office_name: "KW", mls_code: "REcolorado", mls_all: ["REcolorado"],
  sales_volume: 1_000_000, units: 4, closed_transactions: 4, enriched_email: null, enriched_email_status: null, ...extra,
} as SyncAgent);
type Found = { id: number; email: string; status?: string | null; campaigns: Array<{ campaignId: number; status: string | null }> };

const JOB = "11111111-2222-4333-8444-555555555555";
const CAMPAIGN = "1500";
const world = {
  status: "draft" as string,
  agents: new Map<string, SyncAgent>(),
  leads: new Map<string, Found[]>(),
  ids: [] as string[],
  lists: { emails: new Set<string>(), names: new Set<string>(), domains: new Set<string>() },
  upserts: [] as string[][],
  bells: [] as Array<{ severity: string; title: string; body: string }>,
  client: undefined as undefined | null | { osClientId: string; name: string },
  idsFail: false,
  loadFail: false,
};
let nextLead = 9000;

function deps(): import("./run.ts").JobDeps {
  return {
    now: () => new Date("2026-11-28T12:00:00Z"),
    campaignStatus: async () => world.status,
    ids: async (_f, offset) => { if (world.idsFail) throw new Error("canceling statement due to statement timeout"); return world.ids.slice(offset); },
    loadAgents: async (ids) => { if (world.loadFail) throw new Error("agents: the agent database did not answer"); return new Map([...world.agents].filter(([id]) => ids.includes(id))); },
    // Unless a test says otherwise: the campaign's client as the job recorded it.
    campaignClient: async () => (world.client === undefined ? (job()?.os_client_id ? { osClientId: String(job().os_client_id), name: "Howe Realty Group" } : null) : world.client),
    clientLists: async () => world.lists,
    clientCampaigns: async () => [{ id: "1400", name: "Howe Realty 1 + Phoenix", status: "active" }],
    syncBase: {
      findLeads: async (email: string) => world.leads.get(email) ?? [],
      upsertLeads: async (leads) => { world.upserts.push(leads.map((l) => l.email)); return leads.map((l) => ({ id: nextLead++, email: l.email })); },
      onCampaign: async (campaignId: number, email: string) => ((world.leads.get(email) ?? []).some((f) => f.campaigns.some((c) => String(c.campaignId) === String(campaignId))) ? "on" : "off"),
    },
    bell: async (row) => { assert.ok(["info", "warning", "critical"].includes(row.severity)); world.bells.push(row); },
  };
}

function seedJob(o: { status?: string; client?: string | null; collected?: number } = {}) {
  db.seed("os_campaign_agent_jobs", [{
    id: JOB, campaign_id: CAMPAIGN, campaign_name: "ZZ Test campaign", os_client_id: o.client === undefined ? null : o.client, filters: { location: {} }, described: "in Phoenix",
    mls_scope: null, matched: 6, collected: o.collected ?? 0, status: o.status ?? "adding", detail: null, requested_by: "eddy@brokerstaffer.com",
    added: 0, already: 0, skipped: 0, failed: 0, created_at: "2026-11-28T11:59:00Z", finished_at: null,
  }]);
}
function seedItems(agentIds: string[]) {
  db.seed("os_campaign_agent_job_items", agentIds.map((agent_id, i) => ({ id: i + 1, job_id: JOB, agent_id, status: "pending", kind: null, detail: null, email: null, eb_lead_id: null, attempts: 0, claim_token: null, claimed_at: null, next_try_at: null })));
}
const item = (agentId: string) => db.rows("os_campaign_agent_job_items").find((r) => r.agent_id === agentId)!;
const job = () => db.rows("os_campaign_agent_jobs").find((r) => r.id === JOB)!;

function reset() {
  db.reset();
  attaches.length = 0;
  attachFails = false;
  Object.assign(world, { status: "draft", agents: new Map(), leads: new Map(), ids: [], lists: { emails: new Set(), names: new Set(), domains: new Set() }, upserts: [], bells: [], client: undefined, idsFail: false, loadFail: false });
}

test("collecting: every matching agent becomes an item; then adding. None at all: done, said", { skip }, async () => {
  await load(); reset();
  seedJob({ status: "collecting" });
  db.seed("os_campaign_agent_job_items", []);
  world.ids = ["a1", "a2", "a3"];
  const r = await mod.runCampaignAgentJobs(deps());
  assert.equal(r.collected, 3);
  assert.deepEqual(db.rows("os_campaign_agent_job_items").map((x) => x.agent_id).sort(), ["a1", "a2", "a3"]);
  assert.deepEqual([job().status, job().collected], ["adding", 3]);
  // Run again while collecting: the same agents are never collected twice.
  reset(); seedJob({ status: "collecting" }); db.seed("os_campaign_agent_job_items", [{ id: 1, job_id: JOB, agent_id: "a1", status: "pending" }]);
  world.ids = ["a1", "a2"];
  await mod.runCampaignAgentJobs(deps());
  assert.deepEqual(db.rows("os_campaign_agent_job_items").map((x) => x.agent_id).sort(), ["a1", "a2"]);
  reset(); seedJob({ status: "collecting" }); db.seed("os_campaign_agent_job_items", []);
  world.ids = [];
  await mod.runCampaignAgentJobs(deps());
  assert.deepEqual([job().status, job().detail], ["done", "No agent matches these filters now."]);
});

test("adding: each agent as Prospects adds one — new lead made, one EmailBison has added as it is, already in it, bounced, no email; attach named for the person", { skip }, async () => {
  await load(); reset();
  seedJob();
  world.agents = new Map([
    ["a1", agent("a1", "new@agent.test")],
    ["a2", agent("a2", "known@agent.test")],
    ["a3", agent("a3", "there@agent.test")],
    ["a4", agent("a4", "bounced@agent.test")],
    ["a5", agent("a5", null)],
  ]);
  world.leads = new Map([
    ["known@agent.test", [{ id: 501, email: "known@agent.test", status: "unverified", campaigns: [{ campaignId: 777, status: "completed" }] }]],
    ["there@agent.test", [{ id: 502, email: "there@agent.test", status: "unverified", campaigns: [{ campaignId: 1500, status: "in_sequence" }] }]],
    ["bounced@agent.test", [{ id: 503, email: "bounced@agent.test", status: "bounced", campaigns: [] }]],
  ]);
  seedItems(["a1", "a2", "a3", "a4", "a5"]);
  const r = await mod.runCampaignAgentJobs(deps());
  assert.equal(r.claimed, 5);
  assert.deepEqual(world.upserts, [["new@agent.test"]], "only the new address is made; a known lead is never rewritten");
  assert.equal(attaches.length, 1);
  assert.deepEqual([attaches[0].campaignId, attaches[0].leadIds.sort(), attaches[0].actor], [1500, [501, 9000].sort(), "eddy@brokerstaffer.com via Claude"]);
  assert.deepEqual([item("a1").status, item("a1").kind], ["done", "added"]);
  assert.deepEqual([item("a2").status, item("a2").kind], ["done", "added"]);
  assert.deepEqual([item("a3").status, item("a3").kind], ["done", "already"]);
  assert.deepEqual([item("a4").status, item("a4").kind], ["skipped", "skipped"]);
  assert.match(String(item("a4").detail), /bounced/);
  assert.deepEqual([item("a5").status, item("a5").kind], ["skipped", "skipped"]);
  assert.deepEqual([job().added, job().already, job().skipped, job().failed], [2, 1, 2, 0]);
  // Next minute: nothing left — done, totals, the bell.
  await mod.runCampaignAgentJobs(deps());
  assert.deepEqual([job().status, job().detail], ["done", "Added 2; already in it 1; not added 2."]);
  assert.equal(world.bells.length, 1);
  assert.match(world.bells[0].body, /Added 2; already in it 1; not added 2\. \(eddy@brokerstaffer\.com via Claude\)/);
});

test("a client's campaign: agents on its DNC List, My Agents or pipeline (by email, company domain or name) are left out; one already in another of its campaigns isn't added twice", { skip }, async () => {
  await load(); reset();
  seedJob({ client: "os-howe" });
  world.agents = new Map([
    ["b1", agent("b1", "dnc@agent.test")],
    ["b2", agent("b2", "someone@blocked.test")],
    ["b3", agent("b3", null, { full_name: "Pat Listed", enriched_email: "pat@agent.test" })],
    ["b4", agent("b4", "other@agent.test")],
    ["b5", agent("b5", "fine@agent.test")],
  ]);
  world.lists = { emails: new Set(["dnc@agent.test"]), names: new Set(["patlisted"]), domains: new Set(["blocked.test"]) };
  world.leads = new Map([["other@agent.test", [{ id: 610, email: "other@agent.test", status: "unverified", campaigns: [{ campaignId: 1400, status: "in_sequence" }] }]]]);
  seedItems(["b1", "b2", "b3", "b4", "b5"]);
  await mod.runCampaignAgentJobs(deps());
  for (const id of ["b1", "b2", "b3"]) assert.equal(item(id).status, "skipped", id);
  assert.match(String(item("b1").detail), /DNC List, My Agents or pipeline/);
  assert.match(String(item("b2").detail), /company on the client's DNC List/);
  assert.match(String(item("b3").detail), /has the name of someone/);
  assert.deepEqual([item("b4").status, item("b4").kind], ["done", "already"]);
  assert.match(String(item("b4").detail), /Already in Howe Realty 1 \+ Phoenix — not added twice/);
  assert.deepEqual([item("b5").status, item("b5").kind], ["done", "added"]);
  assert.deepEqual(world.upserts, [["fine@agent.test"]]);
});

test("EmailBison failing: the agents wait and are tried again, with the count of tries; never lost", { skip }, async () => {
  await load(); reset();
  seedJob();
  world.agents = new Map([["c1", agent("c1", "c1@agent.test")]]);
  seedItems(["c1"]);
  attachFails = true;
  await mod.runCampaignAgentJobs(deps());
  assert.deepEqual([item("c1").status, item("c1").attempts], ["pending", 1]);
  assert.equal(item("c1").next_try_at, "2026-11-28T12:01:00.000Z");
  assert.equal(job().status, "adding");
});

test("the campaign can no longer send (finished, archived, deleted): the job stops and says why; the bell rings", { skip }, async () => {
  await load(); reset();
  seedJob();
  seedItems(["d1"]);
  world.status = "completed";
  await mod.runCampaignAgentJobs(deps());
  assert.deepEqual([job().status, job().detail], ["failed", "ZZ Test campaign is completed now, so no more agents are added to it."]);
  assert.equal(world.bells[0].severity, "warning");
  assert.equal(item("d1").status, "pending", "nothing was touched");
});

test("onClientList: by either address, by the address's domain, by name only when the entry had none", { skip }, async () => {
  await load();
  const lists = { emails: new Set(["a@x.test"]), names: new Set(["janedoe"]), domains: new Set(["co.test"]) };
  assert.ok(mod.onClientList({ preferred_email: "A@x.test", enriched_email: null, full_name: "Z" } as never, lists));
  assert.ok(mod.onClientList({ preferred_email: null, enriched_email: "b@co.test", full_name: "Z" } as never, lists));
  assert.ok(mod.onClientList({ preferred_email: "c@y.test", enriched_email: null, full_name: "Jane Doe" } as never, lists));
  assert.equal(mod.onClientList({ preferred_email: "c@y.test", enriched_email: null, full_name: "Jo" } as never, { ...lists, names: new Set(["jo"]) }), null, "a name under 5 letters never matches");
  assert.equal(mod.onClientList({ preferred_email: "c@y.test", enriched_email: null, full_name: "Someone Else" } as never, lists), null);
});

test("missingTable: the database's own words for a table not made yet (migration 0059), and nothing broader", { skip }, async () => {
  await load();
  assert.equal(mod.missingTable({ message: "Could not find the table 'public.os_campaign_agent_jobs' in the schema cache", code: "PGRST205" }), true, "as seen live, 28 Nov");
  assert.equal(mod.missingTable({ message: 'relation "os_campaign_agent_jobs" does not exist', code: "42P01" }), true);
  assert.equal(mod.missingTable({ message: "permission denied for table os_campaign_agent_jobs", code: "42501" }), false);
  assert.equal(mod.missingTable(null), false);
});

test("review fixes: a batch that fails part-way counts a try (never forever); collecting failing 5 times stops the job with the bell", { skip }, async () => {
  await load(); reset();
  seedJob();
  world.agents = new Map([["e1", agent("e1", "e1@agent.test")]]);
  seedItems(["e1"]);
  world.loadFail = true;
  const r = await mod.runCampaignAgentJobs(deps());
  assert.deepEqual([item("e1").status, item("e1").attempts], ["pending", 1], "back in the queue, one try counted");
  assert.match(String(item("e1").detail), /Not added yet: agents: the agent database did not answer/);
  assert.ok(r.notes.some((x) => /did not answer/.test(x)));
  // Collecting: counted in the job's words; the fifth stops it.
  reset(); seedJob({ status: "collecting" }); db.seed("os_campaign_agent_job_items", []);
  world.idsFail = true;
  for (let i = 1; i <= 4; i++) {
    await mod.runCampaignAgentJobs(deps());
    assert.match(String(job().detail), new RegExp(`Collecting failed ${i} of 5 times so far`));
    assert.equal(job().status, "collecting");
  }
  await mod.runCampaignAgentJobs(deps());
  assert.equal(job().status, "failed");
  assert.match(String(job().detail), /Collecting the agents failed 5 times \(canceling statement due to statement timeout\)/);
  assert.equal(world.bells.at(-1)!.severity, "warning");
});

test("review fixes: a campaign tied to a client AFTER the job started gets that client's lists; the address actually emailed is checked against them", { skip }, async () => {
  await load(); reset();
  seedJob({ client: null });
  world.client = { osClientId: "os-howe", name: "Howe Realty Group" };
  world.agents = new Map([
    // Emailed at its Courted address (databaseEmail), not its main one: that is the address the DNC entry has.
    ["f1", agent("f1", "main@agent.test", { source_ids: { courted: { email: "src@agent.test" } } } as never)],
    ["f2", agent("f2", "ok@agent.test")],
  ]);
  world.lists = { emails: new Set(["src@agent.test"]), names: new Set(), domains: new Set() };
  seedItems(["f1", "f2"]);
  await mod.runCampaignAgentJobs(deps());
  assert.equal(job().os_client_id, "os-howe", "the job now knows its client");
  assert.deepEqual([item("f1").status, item("f2").kind], ["skipped", "added"]);
  assert.match(String(item("f1").detail), /DNC List, My Agents or pipeline/);
});

test("stopping a job: done stays done; the rest are not added; a stopped job is never written over by a batch finishing late", { skip }, async () => {
  await load(); reset();
  seedJob();
  db.seed("os_campaign_agent_job_items", [
    { id: 1, job_id: JOB, agent_id: "g1", status: "done", kind: "added", attempts: 0 },
    { id: 2, job_id: JOB, agent_id: "g2", status: "pending", kind: null, attempts: 0 },
    { id: 3, job_id: JOB, agent_id: "g3", status: "pending", kind: null, attempts: 0 },
  ]);
  const r = await mod.stopAgentJob(JOB, "eddy@brokerstaffer.com");
  assert.deepEqual(r, { stopped: true, notAdded: 2 });
  assert.equal(job().status, "failed");
  assert.match(String(job().detail), /^Stopped by eddy@brokerstaffer\.com via Claude\. Added 1; already in it 0; not added 2\./);
  assert.deepEqual([item("g1").status, item("g2").status, item("g3").status], ["done", "skipped", "skipped"]);
  assert.deepEqual(await mod.stopAgentJob(JOB, "eddy@brokerstaffer.com"), { stopped: false, notAdded: 0 }, "a second stop changes nothing");
  // The run never picks it up again.
  const after = await mod.runCampaignAgentJobs(deps());
  assert.equal(after.jobs, 0);
});
