import { mock, test } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest, type Row } from "../../tools/master-inbox/test/fake-postgrest.ts";
import type { SyncAgent } from "./agents.ts";
import type { BisonLeadPayload, LeadAgent } from "./lead-map.ts";
import type { ShownCampaign } from "./queue.ts";

configureFakeEnvironment("MASTER_INBOX_");
const db = new FakePostgrest();
globalThis.fetch = db.fetch as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const { runProspectSync, MAX_ATTEMPTS, BACKOFF_MIN, WAIT_MS, YOUNG_MS, SETTLE_MS, SEQUENCE_WAIT_MS } = await import("./run.ts");
type Deps = NonNullable<Parameters<typeof runProspectSync>[0]>;

const PORTAL = "2944199b-bfbc-4e97-aeed-c38ba28f40b0";
const OTHER_PORTAL = "11111111-1111-4111-8111-111111111111";
const ENV = { OS_PROSPECT_SYNC: "1", OS_PROSPECT_SYNC_ONLY: `${PORTAL},${OTHER_PORTAL}` };
const START = new Date("2026-11-03T15:00:00.000Z");
let clock = START;

const agent = (id: string, email: string | null, extra: Partial<SyncAgent> = {}): SyncAgent => ({
  id, full_name: `Agent ${id.toUpperCase()}`, preferred_email: email, sources: ["courted"], source_ids: {}, office_name: "KW", mls_code: "REcolorado", mls_all: ["REcolorado"],
  sales_volume: 1_000_000, units: 4, closed_transactions: 4, enriched_email: null, enriched_email_status: null, ...extra,
} as SyncAgent);
type Found = { id: number; email: string; status?: string | null; campaigns: Array<{ campaignId: number; status: string | null }> };

interface World {
  agents: Map<string, SyncAgent>;
  /** The client's MLSs (one: a client with one market). */
  mlsCodes: string[];
  byMls: Record<string, { id: string; name: string }>;
  setupByMls: Map<string, { id: string; name: string }>;
  campaigns: Array<{ id: string; name: string; status: string }>;
  /** Campaigns the strict mapping leaves out (excluded, ambiguous, Instantly) — counted as the client's under any mapping. */
  extraAll: Array<{ platform: string; id: string; name: string; status: string }>;
  routes: Array<{ campaignId: string; portalId: string }>;
  orch: string | null;
  chosen: { id: string; name: string } | null;
  setup: { id: string; name: string } | null;
  setupFinished: boolean;
  setupOutcome: () => Promise<unknown>;
  listed: Set<string> | null;
  leads: Map<string, Found[]>;
  afterAttach: Map<string, Found[]> | null;
  attachSkips: number;
  refuse: Set<string>;
  upsertFails: boolean;
  removeFails: boolean;
  ctx: unknown;
}
let w: World;
const calls: Array<{ what: string; args: unknown[] }> = [];
const callsOf = (what: string) => calls.filter((c) => c.what === what);

function deps(extra: Partial<Deps> = {}): Deps {
  let nextLead = 5000;
  let attached = false;
  return {
    env: ENV,
    now: () => clock,
    // As the database function: portals with pending rows due now, the longest-waiting first.
    duePortals: async (now, limit) => {
      const due = db.rows("os_prospect_sync").filter((r) => r.status === "pending" && (!r.next_try_at || String(r.next_try_at) <= now.toISOString()));
      const first = new Map<string, number>();
      for (const r of due) first.set(String(r.portal_id), Math.min(first.get(String(r.portal_id)) ?? Infinity, Number(r.id)));
      return [...first].sort((a, b) => a[1] - b[1]).slice(0, limit).map(([p]) => p);
    },
    context: async (portalId) => (w.ctx === undefined ? { portalId, portalName: "Homebase", client: { id: `os-${portalId.slice(0, 4)}`, name: "Homebase" }, mlsIds: ["mls-denver"], mlsCodes: w.mlsCodes, orchClientId: "orch-homebase" } : (w.ctx as never)),
    clientRecord: async () => ({ name: "Homebase", aliases: [], areas: ["Greater Denver"], mls: ["REcolorado"], analyticsClientId: "an-homebase", healthClientId: "ch-homebase" }),
    timeZone: async () => "America/Denver",
    campaigns: async () => w.campaigns,
    allCampaigns: async () => [...w.campaigns.map((c) => ({ ...c, platform: "emailbison" })), ...w.extraAll],
    routes: async () => w.routes,
    orchCampaign: async () => w.orch,
    choices: async () => ({ single: w.chosen, byMls: w.byMls }),
    readySetupCampaigns: async () => new Map([...(w.setup ? [["", w.setup] as const] : []), ...w.setupByMls]),
    setupFinished: async () => w.setupFinished,
    setupCampaign: async (client, o) => { calls.push({ what: "setupCampaign", args: [client, o] }); return (await w.setupOutcome()) as never; },
    // The list as it is: by default every add's agent is on it and every removal's is off.
    onProspects: async (_p, ids) => new Set(w.listed ? ids.filter((id) => w.listed!.has(id)) : ids.filter((id) => db.rows("os_prospect_sync").some((r) => r.agent_id === id && r.action === "add" && r.status !== "skipped" && !db.rows("os_prospect_sync").some((x) => x.agent_id === id && x.action === "remove" && Number(x.id) > Number(r.id))))),
    loadAgents: async (ids, o) => { calls.push({ what: "loadAgents", args: [ids, o] }); return new Map([...w.agents].filter(([id]) => ids.includes(id))); },
    upsertLeads: async (leads: readonly BisonLeadPayload[]) => {
      calls.push({ what: "upsert", args: [leads] });
      if (w.upsertFails) throw new Error("EmailBison: 503 Service Unavailable");
      return leads.filter((l) => !w.refuse.has(l.email)).map((l) => ({ id: nextLead++, email: l.email }));
    },
    findLeads: async (email) => { calls.push({ what: "find", args: [email] }); return ((attached && w.afterAttach) ? w.afterAttach : w.leads).get(email) ?? []; },
    attach: async (campaignId, leadIds, actor) => { calls.push({ what: "attach", args: [campaignId, leadIds, actor] }); attached = true; return { ok: true, attempted: leadIds.length, applied: leadIds.length - w.attachSkips, skipped: w.attachSkips, chunks: [{ size: leadIds.length, ok: true }], batchId: "b" }; },
    remove: async (campaignId, leadIds, actor) => {
      calls.push({ what: "remove", args: [campaignId, leadIds, actor] });
      return w.removeFails ? { ok: false, attempted: leadIds.length, applied: 0, skipped: 0, chunks: [{ size: leadIds.length, ok: false, error: "EmailBison refused" }], batchId: "b" } : { ok: true, attempted: leadIds.length, applied: leadIds.length, skipped: 0, chunks: [{ size: leadIds.length, ok: true }], batchId: "b" };
    },
    forgetCampaignLeads: async (...args) => { calls.push({ what: "forget", args }); },
    slack: async (text) => { calls.push({ what: "slack", args: [text] }); },
    // The bell's table takes only these (migration 0030's CHECK) — any other is refused by the database (3 Nov audit).
    bell: async (row) => { assert.ok(["info", "warning", "critical"].includes(row.severity), `bell severity "${row.severity}" would be refused`); calls.push({ what: "bell", args: [row] }); },
    ...extra,
  };
}

const CAMPAIGN = "Homebase + Greater Denver + ZF NS1 (MST)";
const inOther = (id: number, email: string, status = "in_sequence", own: string | null = "unverified"): Found[] => [{ id, email, status: own, campaigns: [{ campaignId: 999, status }] }];
const refuseAll = () => ({ attach: async (_c: number, leadIds: number[]) => ({ ok: false, attempted: leadIds.length, applied: 0, skipped: 0, chunks: [{ size: leadIds.length, ok: false, error: "No leads were added because they are either in other sequences, have previously bounced, or unsubscribed" }], batchId: "b" }) });

let nextId = 1;
function queue(rows: Array<{ detail?: string; email?: string; agent: string; action: "add" | "remove"; portal?: string; status?: string; claimed_at?: string; attempts?: number; source?: string; next_try_at?: string; created_at?: string; in_campaigns?: ShownCampaign[] }>) {
  db.seed("os_prospect_sync", [...db.rows("os_prospect_sync"), ...rows.map((r) => ({
    id: nextId++, portal_id: r.portal ?? PORTAL, os_client_id: "os-homebase", agent_id: r.agent, action: r.action, source: r.source ?? "prospects",
    status: r.status ?? "pending", attempts: r.attempts ?? 0, requested_by: "amy@brokerstaffer.com", test: true, claim_token: null, claimed_at: r.claimed_at ?? null,
    next_try_at: r.next_try_at ?? null, campaign_id: null, campaign_name: null, eb_lead_id: null, email: r.email ?? null, detail: r.detail ?? null,
    created_at: r.created_at ?? START.toISOString(), updated_at: START.toISOString(), processed_at: null, in_campaigns: r.in_campaigns ?? null,
  }))]);
}
const rowOf = (agentId: string) => db.rows("os_prospect_sync").filter((r) => r.agent_id === agentId).sort((a, b) => Number(b.id) - Number(a.id))[0] as Row;

function seed() {
  db.reset();
  calls.length = 0;
  nextId = 1;
  clock = START;
  db.seed("os_prospect_sync", []);
  w = {
    agents: new Map(), mlsCodes: ["REcolorado"], byMls: {}, setupByMls: new Map(), campaigns: [{ id: "100", name: "Homebase + Greater Denver + ZF NS1 (MST)", status: "active" }, { id: "200", name: "Homebase + Old (MST)", status: "completed" }],
    extraAll: [], routes: [], orch: null, chosen: { id: "100", name: "Homebase + Greater Denver + ZF NS1 (MST)" }, setup: null, setupFinished: true,
    setupOutcome: async () => ({ kind: "waiting", reason: "Its first campaign is being made." }), listed: null, leads: new Map(), afterAttach: null, attachSkips: 0,
    refuse: new Set(), upsertFails: false, removeFails: false, ctx: undefined,
  };
}

test("off unless OS_PROSPECT_SYNC=1: nothing is claimed", async () => {
  seed();
  queue([{ agent: "a1", action: "add" }]);
  const r = await runProspectSync(deps({ env: {} }));
  assert.match(r.off ?? "", /OS_PROSPECT_SYNC is not 1/);
  assert.equal(rowOf("a1").status, "pending");
  assert.equal(calls.length, 0);
});

test("adds: into the team's chosen Prospects campaign as the worker's leads (only the fields sent change); each skip says why; one already in another of its campaigns — asked of EmailBison now — is left there", async () => {
  seed();
  w.agents = new Map([
    ["a1", agent("a1", "One@Agent.test")],
    ["a2", agent("a2", null)],
    ["a3", agent("a3", "bad@agent.test", { enriched_email_status: "not_found" })],
    ["a4", agent("a4", "four@agent.test")],
    ["a5", agent("a5", "five@gmail.test")],
    ["a6", agent("a6", "one@agent.test")],
    ["a8", agent("a8", "eight@agent.test")],
  ]);
  w.leads = new Map([
    ["four@agent.test", [{ id: 44, email: "four@agent.test", campaigns: [{ campaignId: 200, status: "completed" }] }]],
    // Finished in ANOTHER client's campaign (999): not this client's — still added here, as it is (never rewritten).
    ["eight@agent.test", [{ id: 88, email: "eight@agent.test", campaigns: [{ campaignId: 999, status: "sequence_finished" }] }]],
  ]);
  w.refuse = new Set(["five@gmail.test"]);
  queue(["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"].map((a) => ({ agent: a, action: "add" as const })));
  const r = await runProspectSync(deps());
  assert.equal(r.claimed, 8);
  assert.deepEqual(callsOf("loadAgents")[0].args[1], { mlsScope: ["mls-denver"] }, "the market's own numbers, as the team's MLS-scoped sends");
  const sent = callsOf("upsert").flatMap((c) => c.args[0] as BisonLeadPayload[]);
  assert.deepEqual(sent.map((l) => l.email), ["one@agent.test", "five@gmail.test"], "a lead EmailBison has in another client's campaign is never rewritten — its fields are what that client's emails show");
  assert.equal(sent[0].custom_variables.find((v) => v.name === "mls affiliation")?.value, "REcolorado");
  assert.equal(callsOf("attach").length, 1);
  assert.equal(callsOf("attach")[0].args[0], 100, "the chosen Prospects campaign");
  assert.ok((callsOf("attach")[0].args[1] as number[]).includes(88), "the existing lead attached by its id");
  assert.deepEqual({ s: rowOf("a1").status, c: rowOf("a1").campaign_id, d: rowOf("a1").detail, e: rowOf("a1").email }, { s: "done", c: "100", d: "Added to Homebase + Greater Denver + ZF NS1 (MST).", e: "one@agent.test" });
  assert.ok(rowOf("a1").eb_lead_id);
  assert.deepEqual([rowOf("a8").status, rowOf("a8").eb_lead_id], ["done", "88"]);
  assert.deepEqual([rowOf("a2").status, rowOf("a2").detail], ["skipped", "Not added: no email in the agent database."]);
  assert.deepEqual([rowOf("a3").status, rowOf("a3").detail], ["skipped", "Not added: its email already failed a check."]);
  assert.deepEqual([rowOf("a4").status, rowOf("a4").detail], ["done", "Already in Homebase + Old (MST) — not added twice."]);
  assert.deepEqual([rowOf("a5").status, rowOf("a5").detail], ["skipped", "EmailBison did not take this address (it refuses some personal-email domains)."]);
  assert.deepEqual([rowOf("a6").status, rowOf("a6").detail], ["skipped", "Another prospect has the same email — added once."]);
  assert.deepEqual([rowOf("a7").status, rowOf("a7").detail], ["skipped", "This agent is no longer in the agent database."]);
  for (const id of ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"]) assert.equal(rowOf(id).claim_token, null, `${id} released`);
});

test("where they go: the team's choice (while it is one of the client's own campaigns), else the setup campaign, else the newest sending one", async () => {
  seed();
  w.campaigns.push({ id: "555", name: "Homebase + Picked (MST)", status: "paused" });
  w.chosen = { id: "555", name: "Homebase + Picked (MST)" };
  w.agents = new Map([["a1", agent("a1", "one@agent.test")]]);
  queue([{ agent: "a1", action: "add" }]);
  await runProspectSync(deps());
  assert.equal(callsOf("attach")[0].args[0], 555, "the choice over the newest sending one");
  assert.equal(callsOf("setupCampaign").length, 0, "never a new campaign over the team's choice");
  // Its mapping excluded since (taken away from the client): no longer trusted.
  seed();
  w.campaigns = [];
  w.extraAll = [{ platform: "emailbison", id: "555", name: "Homebase + Picked (MST)", status: "active" }];
  w.chosen = { id: "555", name: "Homebase + Picked (MST)" };
  w.agents = new Map([["a1", agent("a1", "one@agent.test")]]);
  queue([{ agent: "a1", action: "add" }]);
  assert.equal((await runProspectSync(deps())).waiting, 1);
  assert.equal(callsOf("attach").length, 0);
  // The choice deleted in EmailBison, or given to another client: never trusted — waits, and our team is asked.
  seed();
  w.chosen = { id: "556", name: "Homebase + Gone (MST)" };
  w.agents = new Map([["a1", agent("a1", "one@agent.test")]]);
  queue([{ agent: "a1", action: "add" }]);
  const r0 = await runProspectSync(deps());
  assert.equal(r0.waiting, 1);
  assert.equal(callsOf("attach").length + callsOf("setupCampaign").length, 0);
  assert.match(JSON.stringify(callsOf("bell")[0].args[0]), /Homebase \+ Gone \(MST\)\) is no longer one of its campaigns/);
  seed();
  w.chosen = null;
  w.setup = { id: "777", name: "Homebase + Greater Denver + Prospects (MST)" };
  w.agents = new Map([["a1", agent("a1", "one@agent.test")]]);
  queue([{ agent: "a1", action: "add" }]);
  await runProspectSync(deps());
  assert.equal(callsOf("attach")[0].args[0], 777);
  seed();
  w.chosen = null;
  w.campaigns = [{ id: "300", name: "Homebase + A (MST)", status: "paused" }, { id: "301", name: "Homebase + B (MST)", status: "active" }, { id: "302", name: "Homebase + C (MST)", status: "completed" }];
  w.agents = new Map([["a1", agent("a1", "one@agent.test")]]);
  queue([{ agent: "a1", action: "add" }]);
  await runProspectSync(deps());
  assert.equal(callsOf("attach")[0].args[0], 301);
});

test("a client WITH campaigns but none that can take prospects (excluded, ambiguous, Instantly, finished): waits and our team is told — never a new campaign", async () => {
  seed();
  w.chosen = null;
  w.campaigns = [{ id: "302", name: "Homebase + C (MST)", status: "completed" }];
  w.agents = new Map([["a1", agent("a1", "one@agent.test")]]);
  queue([{ agent: "a1", action: "add" }]);
  let r = await runProspectSync(deps());
  assert.equal(r.waiting, 1);
  assert.equal(callsOf("setupCampaign").length, 0);
  assert.match(JSON.stringify(callsOf("bell")[0].args[0]), /pick its Prospects campaign on its Campaigns tab/);
  seed();
  w.chosen = null;
  w.campaigns = [];
  w.extraAll = [{ platform: "instantly", id: "i-1", name: "Homebase + Old", status: "archived" }]; // or an excluded mapping
  w.agents = new Map([["a1", agent("a1", "one@agent.test")]]);
  queue([{ agent: "a1", action: "add" }]);
  r = await runProspectSync(deps());
  assert.equal(r.waiting, 1);
  assert.equal(callsOf("setupCampaign").length, 0);
});

test("removes: out of THIS client's campaigns only — under the agent's own addresses and the one each campaign's record gives it, exactly; never a source's shared address; Prospects forgets it at once", async () => {
  seed();
  w.campaigns.push({ id: "150", name: "Homebase + North (MST)", status: "active" });
  // r1's Zillow record lists the team's address — another agent's own (still a prospect, in campaign 100).
  w.agents = new Map([["r1", agent("r1", "pref@agent.test", { enriched_email: "work@agent.test", source_ids: { zillow: { email: "team@agent.test" } } })], ["r2", agent("r2", "nobody@agent.test")]]);
  w.leads = new Map([
    ["pref@agent.test", [{ id: 11, email: "pref@agent.test", campaigns: [{ campaignId: 100, status: "in_sequence" }, { campaignId: 999, status: "in_sequence" }] }]],
    ["zil@agent.test", [{ id: 12, email: "zil@agent.test", campaigns: [{ campaignId: 150, status: "replied" }] }, { id: 13, email: "zilx@agent.test", campaigns: [{ campaignId: 100, status: null }] }]],
    ["team@agent.test", [{ id: 14, email: "team@agent.test", campaigns: [{ campaignId: 100, status: "in_sequence" }] }]],
  ]);
  w.listed = new Set();
  // The campaign's record: r1's lead in 150 is under zil@ (an address the database no longer lists for it).
  queue([{ agent: "r1", action: "remove", in_campaigns: [{ provider: "emailbison", id: "150", name: "Homebase + North (MST)", emails: ["zil@agent.test"] }] }, { agent: "r2", action: "remove" }]);
  const r = await runProspectSync(deps());
  assert.equal(r.done, 2);
  assert.deepEqual(callsOf("find").map((c) => c.args[0]).sort(), ["nobody@agent.test", "pref@agent.test", "work@agent.test", "zil@agent.test"], "never the shared team address");
  assert.deepEqual(callsOf("remove").map((c) => [c.args[0], c.args[1]]).sort(), [[100, [11]], [150, [12]]], "campaign 999 is another client's; a near-miss address is another person; the team's lead stays");
  assert.equal(rowOf("r1").detail, "Taken out of Homebase + Greater Denver + ZF NS1 (MST), Homebase + North (MST).");
  assert.equal(rowOf("r2").detail, "Was in none of Homebase's campaigns.");
  assert.deepEqual(callsOf("forget")[0].args, ["orch-homebase", ["r1"], ["100", "150"]]);
});

test("the list decides: a young change the list doesn't show yet waits (its save may still be writing); an old one is not done", async () => {
  seed();
  w.agents = new Map([["a1", agent("a1", "one@agent.test")], ["r1", agent("r1", "r@agent.test")]]);
  w.listed = new Set(["r1"]);
  queue([{ agent: "a1", action: "add" }, { agent: "r1", action: "remove" }]);
  await runProspectSync(deps());
  assert.deepEqual([rowOf("a1").status, rowOf("a1").next_try_at], ["pending", new Date(START.getTime() + SETTLE_MS).toISOString()], "young: waited for");
  assert.equal(rowOf("r1").status, "pending");
  assert.equal(callsOf("upsert").length + callsOf("remove").length, 0);
  clock = new Date(START.getTime() + YOUNG_MS + 1000);
  await runProspectSync(deps());
  assert.deepEqual([rowOf("a1").status, rowOf("a1").detail], ["skipped", "Not on Prospects — not added."]);
  assert.deepEqual([rowOf("r1").status, rowOf("r1").detail], ["skipped", "Back on Prospects — left in the campaign."]);
  assert.equal(callsOf("upsert").length + callsOf("remove").length, 0);
});

test("a client with two portals: a portal's adds go only to — and its removals come only out of — campaigns routed to it", async () => {
  seed();
  w.chosen = null;
  w.campaigns = [{ id: "100", name: "P&E + South Florida (EST)", status: "active" }, { id: "101", name: "P&E + Boston (EST)", status: "active" }];
  w.routes = [{ campaignId: "100", portalId: OTHER_PORTAL }, { campaignId: "101", portalId: PORTAL }];
  w.agents = new Map([["a1", agent("a1", "one@agent.test")], ["r1", agent("r1", "r@agent.test")]]);
  w.leads = new Map([["r@agent.test", [{ id: 21, email: "r@agent.test", campaigns: [{ campaignId: 100, status: null }, { campaignId: 101, status: null }] }]]]);
  w.listed = new Set(["a1"]);
  queue([{ agent: "a1", action: "add" }, { agent: "r1", action: "remove" }]);
  await runProspectSync(deps());
  assert.equal(callsOf("attach")[0].args[0], 101, "Boston's portal → Boston's campaign");
  assert.deepEqual(callsOf("remove").map((c) => c.args[0]), [101], "out of Boston's only — Florida's portal may still have it");
  // The client's chosen campaign routed to the OTHER portal: not used here — and our team is asked.
  seed();
  w.campaigns = [{ id: "100", name: "P&E + South Florida (EST)", status: "active" }];
  w.chosen = { id: "100", name: "P&E + South Florida (EST)" };
  w.routes = [{ campaignId: "100", portalId: OTHER_PORTAL }];
  w.agents = new Map([["a1", agent("a1", "one@agent.test")]]);
  queue([{ agent: "a1", action: "add" }]);
  const r = await runProspectSync(deps());
  assert.equal(r.waiting, 1);
  assert.equal(callsOf("attach").length, 0);
});

test("a campaign the onboarding app built counts as one — no draft is made over it", async () => {
  seed();
  w.chosen = null;
  w.campaigns = [];
  w.orch = "7a0e9d1c-built-by-onboarding";
  w.agents = new Map([["a1", agent("a1", "one@agent.test")]]);
  queue([{ agent: "a1", action: "add" }]);
  const r = await runProspectSync(deps());
  assert.equal(r.waiting, 1);
  assert.equal(callsOf("setupCampaign").length, 0);
});

test("the latest wish per agent: added then removed before the run — only the removal stands", async () => {
  seed();
  w.agents = new Map([["a1", agent("a1", "one@agent.test")]]);
  w.listed = new Set();
  queue([{ agent: "a1", action: "add" }, { agent: "a1", action: "remove" }]);
  await runProspectSync(deps());
  const rows = db.rows("os_prospect_sync").sort((a, b) => Number(a.id) - Number(b.id));
  assert.deepEqual(rows.map((r) => [r.action, r.status]), [["add", "skipped"], ["remove", "done"]]);
  assert.equal(rows[0].detail, "Replaced by a later change — the agent is off Prospects now.");
  assert.equal(callsOf("upsert").length, 0);
});

test("the list decides when a save failed: an add waiting (made while off), then a removal whose list change failed — the add stands", async () => {
  seed();
  w.agents = new Map([["a1", agent("a1", "one@agent.test")]]);
  w.listed = new Set(["a1"]); // the removal's delete never happened: still on Prospects
  queue([{ agent: "a1", action: "add" }, { agent: "a1", action: "remove" }]);
  clock = new Date(START.getTime() + YOUNG_MS + 1000); // long enough for its save to have landed
  await runProspectSync(deps());
  const rows = db.rows("os_prospect_sync").sort((a, b) => Number(a.id) - Number(b.id));
  assert.deepEqual(rows.map((r) => [r.action, r.status]), [["add", "done"], ["remove", "skipped"]]);
  assert.equal(callsOf("attach").length, 1);
});

test("a failure is tried again with growing waits (about a day), then failed — and our team's bell rings; a failed removal says the agent may still be emailed", async () => {
  seed();
  w.upsertFails = true;
  w.agents = new Map([["a1", agent("a1", "one@agent.test")]]);
  queue([{ agent: "a1", action: "add" }]);
  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    await runProspectSync(deps());
    assert.deepEqual([rowOf("a1").status, rowOf("a1").attempts], ["pending", i]);
    assert.equal(rowOf("a1").next_try_at, new Date(clock.getTime() + BACKOFF_MIN[i - 1] * 60_000).toISOString(), "steps aside");
    // Not tried again before its time.
    const before = callsOf("upsert").length;
    await runProspectSync(deps());
    assert.equal(callsOf("upsert").length, before);
    clock = new Date(String(rowOf("a1").next_try_at));
  }
  await runProspectSync(deps());
  assert.deepEqual([rowOf("a1").status, rowOf("a1").attempts], ["failed", MAX_ATTEMPTS]);
  assert.match(String(rowOf("a1").detail), /gave up after 8 tries/);
  assert.match(JSON.stringify(callsOf("bell").at(-1)!.args[0]), /could not be added to the campaign/);
  assert.match((callsOf("bell").at(-1)!.args[0] as { ref: string }).ref, /^prospect_sync:failed:add:/);
  seed();
  w.removeFails = true;
  w.listed = new Set();
  w.agents = new Map([["r1", agent("r1", "pref@agent.test")]]);
  w.leads = new Map([["pref@agent.test", [{ id: 11, email: "pref@agent.test", campaigns: [{ campaignId: 100, status: null }] }]]]);
  queue([{ agent: "r1", action: "remove", attempts: MAX_ATTEMPTS - 1 }]);
  await runProspectSync(deps());
  assert.equal(rowOf("r1").status, "failed");
  assert.equal(callsOf("forget").length, 0, "not forgotten while it is still in the campaign");
  const bell = callsOf("bell")[0].args[0] as { severity: string; body: string; ref: string };
  assert.equal(bell.severity, "critical");
  assert.match(bell.body, /could not be taken out of the campaign — they may still be emailed/);
  assert.match(bell.ref, /^prospect_sync:failed:remove:/, "its own notice — never hidden behind an add's");
});

test("fairness: a client with 1,200 picks waiting (setup not finished) never holds up another client — all of its waiting steps aside together", async () => {
  seed();
  w.chosen = null;
  w.campaigns = [];
  w.setupFinished = false;
  queue(Array.from({ length: 1200 }, (_, i) => ({ agent: `w${i}`, action: "add" as const, source: "setup" })));
  queue([{ agent: "b1", action: "add", portal: OTHER_PORTAL }]);
  w.agents = new Map([["b1", agent("b1", "b@agent.test")]]);
  const r = await runProspectSync(deps({
    context: async (portalId) => ({ portalId, portalName: portalId, client: { id: `os-${portalId}`, name: portalId === PORTAL ? "Waiting Co" : "Busy Co" }, mlsIds: [], mlsCodes: [], orchClientId: null }),
    clientRecord: async (osClientId) => ({ name: osClientId === `os-${OTHER_PORTAL}` ? "Busy Co" : "Waiting Co", aliases: [], areas: [], mls: [], analyticsClientId: null, healthClientId: null }),
    campaigns: async (client) => (client.name === "Busy Co" ? [{ id: "100", name: "Busy Co + X (EST)", status: "active" }] : []),
    allCampaigns: async (client) => (client.name === "Busy Co" ? [{ platform: "emailbison", id: "100", name: "Busy Co + X (EST)", status: "active" }] : []),
    choices: async (osClientId) => ({ single: osClientId === `os-${OTHER_PORTAL}` ? { id: "100", name: "Busy Co + X (EST)" } : null, byMls: {} }),
  }));
  assert.equal(r.claimed, 501, "a share of the waiting client (500) and the other client's change");
  assert.equal(rowOf("b1").status, "done", "the other client's change is done in the same run");
  const waiting = db.rows("os_prospect_sync").filter((x) => x.portal_id === PORTAL);
  assert.ok(waiting.every((x) => x.status === "pending" && x.next_try_at === new Date(START.getTime() + WAIT_MS).toISOString()), "every one of the 1,200 steps aside — not only the 500 looked at");
  calls.length = 0;
  const again = await runProspectSync(deps());
  assert.equal(again.claimed, 0, "nothing due until the wait is over");
});

test("a new client with no campaign at all: waits until setup is finished; then its first campaign is made once (a draft), Slack told, the prospects go in", async () => {
  seed();
  w.campaigns = [];
  w.chosen = null;
  w.setupFinished = false;
  w.agents = new Map([["a1", agent("a1", "one@agent.test")], ["a2", agent("a2", "two@agent.test")]]);
  queue([{ agent: "a1", action: "add", source: "setup" }, { agent: "a2", action: "add", source: "setup" }]);
  let r = await runProspectSync(deps());
  assert.equal(r.waiting, 2);
  assert.deepEqual([rowOf("a1").status, rowOf("a1").attempts], ["pending", 0], "waiting is not a failure");
  assert.match(String(rowOf("a1").detail), /hasn't finished setting up its portal/);
  assert.equal(callsOf("setupCampaign").length, 0);
  // Setup finished, but another run is making it: still waiting — and our team hears why.
  w.setupFinished = true;
  clock = new Date(START.getTime() + WAIT_MS);
  r = await runProspectSync(deps());
  assert.equal(r.waiting, 2);
  assert.equal(callsOf("setupCampaign").length, 1);
  assert.match(JSON.stringify(callsOf("bell")[0].args[0]), /Its first campaign is being made/);
  // The campaign is made, Slack told (TEST while fenced), the prospects attached to it.
  w.setupOutcome = async () => ({ kind: "ready", campaignId: "888", campaignName: "Homebase + Greater Denver + Prospects (MST)", created: true, note: null });
  calls.length = 0;
  clock = new Date(START.getTime() + 2 * WAIT_MS);
  r = await runProspectSync(deps());
  const made = callsOf("setupCampaign")[0].args;
  assert.deepEqual({ name: (made[0] as { name: string }).name, tz: (made[0] as { timeZone: string }).timeZone, an: (made[0] as { analyticsClientId: string }).analyticsClientId, test: (made[1] as { test: boolean }).test }, { name: "Homebase", tz: "America/Denver", an: "an-homebase", test: true });
  assert.match(String(callsOf("slack")[0].args[0]), /^\[TEST\] \*First campaign created · Homebase\*/);
  assert.equal(callsOf("attach")[0].args[0], 888);
  assert.equal(r.done, 2);
  // Making it failed: the prospects fail with the reason, and our team hears.
  seed();
  w.campaigns = [];
  w.chosen = null;
  w.setupOutcome = async () => ({ kind: "failed", reason: "EmailBison didn't answer when asked to copy the template — it may still have made the copy." });
  w.agents = new Map([["a1", agent("a1", "one@agent.test")]]);
  queue([{ agent: "a1", action: "add" }]);
  await runProspectSync(deps());
  assert.deepEqual([rowOf("a1").status, rowOf("a1").attempts], ["pending", 0], "waits for a person to sort it out — never lost");
  assert.match(JSON.stringify(callsOf("bell")[0].args[0]), /First campaign not made — Homebase/);
});

test("EmailBison quietly leaving a lead out: looked up — only the ones really in the campaign are 'added'; nothing to go on is tried again, never final", async () => {
  seed();
  w.agents = new Map([["a1", agent("a1", "one@agent.test")], ["a2", agent("a2", "two@agent.test")]]);
  w.attachSkips = 1;
  w.afterAttach = new Map([["one@agent.test", [{ id: 5000, email: "one@agent.test", campaigns: [{ campaignId: 100, status: "in_sequence" }] }]], ["two@agent.test", [{ id: 5001, email: "two@agent.test", campaigns: [] }]]]);
  queue([{ agent: "a1", action: "add" }, { agent: "a2", action: "add" }]);
  await runProspectSync(deps());
  assert.deepEqual([rowOf("a1").status, rowOf("a1").detail], ["done", "Added to Homebase + Greater Denver + ZF NS1 (MST)."]);
  assert.deepEqual([rowOf("a2").status, rowOf("a2").attempts, rowOf("a2").detail], ["pending", 1, "EmailBison didn't add it to Homebase + Greater Denver + ZF NS1 (MST) and gave no reason — trying again."]);
  assert.equal(rowOf("a2").email, null, "not marked as held");
  // It never comes right: given up on in about a day, and the team's bell rings — not quietly dropped.
  seed();
  w.agents = new Map([["a2", agent("a2", "two@agent.test")]]);
  w.attachSkips = 1;
  w.afterAttach = new Map();
  queue([{ agent: "a2", action: "add", attempts: MAX_ATTEMPTS - 1 }]);
  await runProspectSync(deps());
  assert.equal(rowOf("a2").status, "failed");
  assert.equal(callsOf("bell").length, 1);
});

test("the fence: a portal outside it steps aside; a portal not linked to a client fails plainly", async () => {
  seed();
  queue([{ agent: "a1", action: "add", portal: "22222222-2222-4222-8222-222222222222" }]);
  const r = await runProspectSync(deps());
  assert.equal(r.claimed, 0);
  assert.deepEqual([rowOf("a1").status, rowOf("a1").next_try_at], ["pending", new Date(START.getTime() + WAIT_MS).toISOString()]);
  seed();
  w.ctx = { portalId: PORTAL, portalName: "X", client: null, mlsIds: [], mlsCodes: [], orchClientId: null };
  queue([{ agent: "a1", action: "add" }]);
  await runProspectSync(deps());
  assert.deepEqual([rowOf("a1").status, rowOf("a1").detail], ["failed", "This portal is not linked to a client record."]);
});

test("claims: a row another run holds is left alone; one whose run died (15 minutes) is taken back and done; one claimed in between is not done here", async () => {
  seed();
  w.agents = new Map([["a1", agent("a1", "one@agent.test")], ["a2", agent("a2", "two@agent.test")]]);
  queue([{ agent: "a1", action: "add", status: "working", claimed_at: new Date(START.getTime() - 60_000).toISOString() }, { agent: "a2", action: "add", status: "working", claimed_at: new Date(START.getTime() - 20 * 60_000).toISOString() }]);
  await runProspectSync(deps());
  assert.equal(rowOf("a1").status, "working", "still another run's");
  assert.equal(rowOf("a2").status, "done", "taken back");
  seed();
  w.agents = new Map([["a1", agent("a1", "one@agent.test")]]);
  queue([{ agent: "a1", action: "add" }]);
  db.failWhen = (c) => {
    if (c.method === "PATCH" && c.table === "os_prospect_sync" && c.query.get("status") === "eq.pending" && c.query.has("id")) {
      for (const r of db.rows("os_prospect_sync")) Object.assign(r, { status: "working", claim_token: "someone-else" });
      db.failWhen = null;
    }
    return false;
  };
  const r = await runProspectSync(deps());
  assert.equal(r.claimed, 0);
  assert.equal(callsOf("upsert").length, 0);
});

test("a client with several MLSs: each agent into the campaign picked for its MLS; an MLS with none picked waits (only its own agents) and the bell asks — never the wrong market's campaign", async () => {
  seed();
  w.mlsCodes = ["MLSPIN", "SOCAL"];
  w.chosen = { id: "100", name: "Homebase + Greater Denver + ZF NS1 (MST)" }; // a one-campaign pick: not used for a client with several markets
  w.campaigns = [{ id: "1104", name: "Homebase + Boston + ZF NS1 (EST)", status: "draft" }, { id: "1103", name: "Homebase + Southern California + ZF NS1 (PST)", status: "draft" }, { id: "100", name: "Homebase + Greater Denver + ZF NS1 (MST)", status: "active" }];
  w.byMls = { MLSPIN: { id: "1104", name: "Homebase + Boston + ZF NS1 (EST)" } };
  w.agents = new Map([
    ["b1", agent("b1", "boston1@agent.test", { mls_all: ["MLSPIN"] })],
    ["b2", agent("b2", "boston2@agent.test", { mls_all: ["NEREN", "MLSPIN"] })],
    ["s1", agent("s1", "socal1@agent.test", { mls_all: ["SOCAL"] })],
    ["x1", agent("x1", "x@agent.test", { mls_all: ["NEREN"] })],
  ]);
  queue(["b1", "b2", "s1", "x1"].map((a) => ({ agent: a, action: "add" as const })));
  const r = await runProspectSync(deps());
  assert.deepEqual(callsOf("attach").map((c) => [c.args[0], (c.args[1] as number[]).length]), [[1104, 2]], "Boston's agents into Boston's campaign — nothing else anywhere");
  assert.equal(rowOf("b1").detail, "Added to Homebase + Boston + ZF NS1 (EST).");
  assert.deepEqual([rowOf("s1").status, rowOf("s1").next_try_at], ["pending", new Date(START.getTime() + WAIT_MS).toISOString()]);
  assert.match(String(rowOf("s1").detail), /none picked for its SOCAL agents/);
  assert.deepEqual([rowOf("x1").status, rowOf("x1").detail], ["skipped", "Not in any of Homebase's MLSs (MLSPIN, SOCAL) — not added."]);
  assert.equal(r.waiting, 1);
  const bell = callsOf("bell")[0].args[0] as { body: string; ref: string };
  assert.match(bell.body, /^1 SOCAL prospects can't go into a campaign yet/);
  assert.match(bell.ref, /^prospect_sync:pick:[^:]+:SOCAL:/);
  assert.equal(callsOf("setupCampaign").length, 0, "a client with campaigns never gets a draft");
  // A later SOCAL add, while the first waits: SOCAL's wait never holds Boston's agents up.
  calls.length = 0;
  w.agents.set("b3", agent("b3", "boston3@agent.test", { mls_all: ["MLSPIN"] }));
  queue([{ agent: "b3", action: "add" }]);
  clock = new Date(START.getTime() + 60_000);
  await runProspectSync(deps());
  assert.equal(rowOf("b3").status, "done");
  assert.equal(rowOf("s1").status, "pending");
  // The pick made: SOCAL's go in at their next turn. A pick no longer the client's: waits, and the bell asks again.
  w.byMls.SOCAL = { id: "1103", name: "Homebase + Southern California + ZF NS1 (PST)" };
  clock = new Date(START.getTime() + WAIT_MS);
  calls.length = 0;
  await runProspectSync(deps());
  assert.deepEqual(callsOf("attach").map((c) => c.args[0]), [1103]);
  assert.equal(rowOf("s1").status, "done");
  seed();
  w.mlsCodes = ["MLSPIN", "SOCAL"];
  w.byMls = { SOCAL: { id: "4040", name: "Homebase + Gone (PST)" } };
  w.agents = new Map([["s1", agent("s1", "socal1@agent.test", { mls_all: ["SOCAL"] })]]);
  queue([{ agent: "s1", action: "add" }]);
  await runProspectSync(deps());
  assert.equal(rowOf("s1").status, "pending");
  assert.match(JSON.stringify(callsOf("bell")[0].args[0]), /picked for Homebase's SOCAL agents \(Homebase \+ Gone \(PST\)\) is no longer one of its campaigns/);
  // A client with two portals (P&E: Boston and Florida, every MLS on both): an MLS's pick goes to the other portal —
  // the agent's market decides; a removal here still never touches a campaign routed there that this portal didn't fill.
  seed();
  w.mlsCodes = ["MLSPIN", "FTL"];
  w.chosen = null;
  w.campaigns = [{ id: "101", name: "P&E + Boston (EST)", status: "active" }, { id: "100", name: "P&E + South Florida (EST)", status: "active" }];
  w.routes = [{ campaignId: "101", portalId: PORTAL }, { campaignId: "100", portalId: OTHER_PORTAL }];
  w.byMls = { MLSPIN: { id: "101", name: "P&E + Boston (EST)" }, FTL: { id: "100", name: "P&E + South Florida (EST)" } };
  w.agents = new Map([["f1", agent("f1", "florida@agent.test", { mls_all: ["FTL"] })], ["r1", agent("r1", "r@agent.test", { mls_all: ["FTL"] })]]);
  w.leads = new Map([["r@agent.test", [{ id: 21, email: "r@agent.test", campaigns: [{ campaignId: 100, status: null }] }]]]);
  w.listed = new Set(["f1"]);
  queue([{ agent: "f1", action: "add" }, { agent: "r1", action: "remove" }]);
  await runProspectSync(deps());
  assert.deepEqual(callsOf("attach").map((c) => c.args[0]), [100], "FTL's agent into FTL's campaign");
  assert.equal(callsOf("remove").length, 0, "the Florida portal's campaign is never emptied from Boston's");
});

test("a new client with several MLSs and no campaign: a draft for each MLS its agents are in, each made once — the right agents in each", async () => {
  seed();
  w.mlsCodes = ["MLSPIN", "SOCAL"];
  w.campaigns = [];
  w.chosen = null;
  const made: string[] = [];
  w.agents = new Map([["b1", agent("b1", "boston1@agent.test", { mls_all: ["MLSPIN"] })], ["s1", agent("s1", "socal1@agent.test", { mls_all: ["SOCAL"] })], ["s2", agent("s2", "socal2@agent.test", { mls_all: ["SOCAL"] })]]);
  queue(["b1", "s1", "s2"].map((a) => ({ agent: a, action: "add" as const, source: "setup" })));
  await runProspectSync(deps({
    setupCampaign: async (client) => {
      calls.push({ what: "setupCampaign", args: [client] });
      made.push(String(client.mlsCode));
      const id = client.mlsCode === "MLSPIN" ? "901" : "902";
      return { kind: "ready", campaignId: id, campaignName: `Homebase + ${client.mlsCode} + Prospects (EST)`, created: true, note: "Client fields not filled: {CLIENT_AREA}" };
    },
  }));
  assert.deepEqual(made, ["MLSPIN", "SOCAL"]);
  assert.deepEqual(callsOf("attach").map((c) => [c.args[0], (c.args[1] as number[]).length]).sort(), [[901, 1], [902, 2]]);
  assert.equal(callsOf("slack").filter((c) => /First campaign created/.test(String(c.args[0]))).length, 2, "one post per campaign made");
  assert.match(String(callsOf("slack").at(-1)!.args[0]), /Campaign updated · Homebase\*\n• 1 added to Homebase \+ MLSPIN \+ Prospects \(EST\): Agent B1\n• 2 added to Homebase \+ SOCAL \+ Prospects \(EST\): Agent S1, Agent S2/);
  assert.ok(callsOf("bell").some((c) => /First campaign needs a look/.test(JSON.stringify(c.args[0]))), "its area left for the team — said so");
});

test("removes look where this sync put the agent too — found in a campaign no longer the client's (given away, re-routed): never touched, failed, the bell rings", async () => {
  seed();
  w.campaigns = [{ id: "300", name: "Homebase + New Pick (MST)", status: "active" }];
  w.chosen = { id: "300", name: "Homebase + New Pick (MST)" };
  w.agents = new Map([["r1", agent("r1", "now@agent.test")]]);
  // Added by this sync to 100 (under an address the database has since changed); 100 has dropped out of the mapping.
  db.seed("os_prospect_sync", [{ id: 900, portal_id: PORTAL, agent_id: "r1", action: "add", status: "done", email: "then@agent.test", campaign_id: "100", campaign_name: "Homebase + Greater Denver + ZF NS1 (MST)", created_at: START.toISOString() }]);
  nextId = 901;
  w.leads = new Map([["then@agent.test", [{ id: 31, email: "then@agent.test", campaigns: [{ campaignId: 100, status: "in_sequence" }] }]]]);
  w.listed = new Set();
  queue([{ agent: "r1", action: "remove" }]);
  await runProspectSync(deps());
  assert.deepEqual(callsOf("remove"), [], "an old add never makes a campaign removable — it may be another client's now");
  assert.deepEqual([rowOf("r1").status, rowOf("r1").detail], ["failed", "Was in none of Homebase's campaigns. Still in Homebase + Greater Denver + ZF NS1 (MST) — not one of Homebase's campaigns for this portal now, so not touched: check who it belongs to."]);
  assert.equal((callsOf("bell")[0].args[0] as { severity: string }).severity, "critical");
});

test("a removal finds the lead in a campaign the portal showed it in that is NOT mapped to the client now: never touched, the row fails and the bell rings; Instantly and another portal's campaigns are said", async () => {
  seed();
  w.agents = new Map([["r1", agent("r1", "pref@agent.test")]]);
  w.leads = new Map([["pref@agent.test", [{ id: 11, email: "pref@agent.test", campaigns: [{ campaignId: 100, status: "in_sequence" }, { campaignId: 640, status: "in_sequence" }] }]]]);
  w.listed = new Set();
  queue([{ agent: "r1", action: "remove", in_campaigns: [
    { provider: "emailbison", id: "100", name: "Homebase + Greater Denver + ZF NS1 (MST)" },
    { provider: "emailbison", id: "640", name: "Homebase 2 + Old Mapping (MST)" },
    { provider: "instantly", id: "9f1c-uuid", name: "Homebase + Nicole + Denver" },
  ] }]);
  await runProspectSync(deps());
  assert.deepEqual(callsOf("remove").map((c) => c.args[0]), [100], "its own campaign only");
  assert.equal(rowOf("r1").status, "failed");
  assert.equal(rowOf("r1").detail, "Taken out of Homebase + Greater Denver + ZF NS1 (MST). Still in Homebase 2 + Old Mapping (MST) — not one of Homebase's campaigns for this portal now, so not touched: check who it belongs to. Also listed in Homebase + Nicole + Denver (Instantly — not reached from here).");
  const bell = callsOf("bell")[0].args[0] as { severity: string; ref: string };
  assert.deepEqual([bell.severity, bell.ref.startsWith("prospect_sync:failed:remove:")], ["critical", true]);
  // Another portal's campaign (a client with two portals): said, left there — not a failure.
  seed();
  w.routes = [{ campaignId: "100", portalId: PORTAL }, { campaignId: "101", portalId: OTHER_PORTAL }];
  w.agents = new Map([["r1", agent("r1", "pref@agent.test")]]);
  w.leads = new Map([["pref@agent.test", [{ id: 11, email: "pref@agent.test", campaigns: [{ campaignId: 101, status: "in_sequence" }] }]]]);
  w.listed = new Set();
  queue([{ agent: "r1", action: "remove", in_campaigns: [{ provider: "emailbison", id: "101", name: "Homebase + Florida (EST)" }] }]);
  await runProspectSync(deps());
  assert.equal(callsOf("remove").length, 0);
  assert.deepEqual([rowOf("r1").status, rowOf("r1").detail], ["done", "Was in none of Homebase's campaigns. Also in Homebase + Florida (EST), which goes to another of Homebase's portals — left there."]);
});

test("the list decides with nothing landing late: a newer change still waiting holds the agent's older ones until it is due; a young newest change the list doesn't show yet holds an older one that matches", async () => {
  seed();
  w.agents = new Map([["a1", agent("a1", "one@agent.test")]]);
  w.listed = new Set(["a1"]); // the add's insert is in; the removal's delete may not be yet
  const old = new Date(START.getTime() - 20 * 60_000).toISOString();
  queue([{ agent: "a1", action: "add", created_at: old }, { agent: "a1", action: "remove", next_try_at: new Date(START.getTime() + 90_000).toISOString() }]);
  await runProspectSync(deps());
  assert.equal(callsOf("attach").length, 0, "not added a moment before it is removed");
  const rows = db.rows("os_prospect_sync").sort((a, b) => Number(a.id) - Number(b.id));
  assert.deepEqual(rows.map((r) => [r.status, r.next_try_at]), [["pending", new Date(START.getTime() + SETTLE_MS).toISOString()], ["pending", new Date(START.getTime() + 90_000).toISOString()]]);
  // Both due, the removal young and its delete not in yet: still held — never "add done, removal replaced".
  clock = new Date(START.getTime() + SETTLE_MS);
  await runProspectSync(deps());
  assert.equal(callsOf("attach").length, 0);
  assert.deepEqual(db.rows("os_prospect_sync").map((r) => r.status), ["pending", "pending"]);
  // The delete lands: the removal is done, the add set aside.
  w.listed = new Set();
  clock = new Date(START.getTime() + 2 * SETTLE_MS);
  await runProspectSync(deps());
  assert.deepEqual(db.rows("os_prospect_sync").sort((a, b) => Number(a.id) - Number(b.id)).map((r) => r.status), ["skipped", "done"]);
  assert.equal(callsOf("attach").length, 0);
});

test("the onboarding app's campaign can't be read: stopped and tried again — never taken as 'no campaign' (which could make a second)", async () => {
  seed();
  w.chosen = null;
  w.campaigns = [];
  w.agents = new Map([["a1", agent("a1", "one@agent.test")]]);
  queue([{ agent: "a1", action: "add" }]);
  const r = await runProspectSync(deps({ orchCampaign: async () => { throw new Error("orch_clients: timeout"); } }));
  assert.deepEqual([rowOf("a1").status, rowOf("a1").attempts], ["pending", 1]);
  assert.match(r.notes[0], /orch_clients: timeout/);
  assert.equal(callsOf("setupCampaign").length, 0);
});

test("removals never share what is removable: a campaign this sync put one agent in is never one another agent is taken out of", async () => {
  seed();
  w.agents = new Map([["r1", agent("r1", "one@agent.test")], ["r2", agent("r2", "two@agent.test")]]);
  // The sync put r1 into 777 — since re-mapped to another client. r2 is in 777 through that other client's own lists.
  db.seed("os_prospect_sync", [{ id: 900, portal_id: PORTAL, agent_id: "r1", action: "add", status: "done", email: "one@agent.test", campaign_id: "777", campaign_name: "Other Client + X", created_at: START.toISOString() }]);
  nextId = 901;
  w.leads = new Map([
    ["one@agent.test", [{ id: 31, email: "one@agent.test", campaigns: [{ campaignId: 777, status: "in_sequence" }, { campaignId: 100, status: "in_sequence" }] }]],
    ["two@agent.test", [{ id: 32, email: "two@agent.test", campaigns: [{ campaignId: 777, status: "in_sequence" }, { campaignId: 100, status: "in_sequence" }] }]],
  ]);
  w.listed = new Set();
  queue([{ agent: "r1", action: "remove" }, { agent: "r2", action: "remove" }]);
  await runProspectSync(deps());
  assert.deepEqual(callsOf("remove").map((c) => [c.args[0], c.args[1]]), [[100, [31, 32]]], "777 touched for no one");
  assert.equal(rowOf("r1").status, "failed", "r1 is still in 777 (the sync put it there; it is another client's now): said, and the bell");
  assert.deepEqual([rowOf("r2").status, rowOf("r2").detail], ["done", "Taken out of Homebase + Greater Denver + ZF NS1 (MST)."]);
  // Each agent's record dropped for exactly the campaigns it left.
  assert.deepEqual(callsOf("forget").map((c) => [c.args[1], c.args[2]]), [[["r1", "r2"], ["100"]]]);
});

test("first due, first done: a market's backlog of 5,600 waiting for a pick never keeps the portal's later removal and other market from their turn", async () => {
  seed();
  w.mlsCodes = ["MLSPIN", "SOCAL"];
  w.chosen = null;
  w.campaigns = [{ id: "1104", name: "Homebase + Boston (EST)", status: "active" }];
  w.byMls = { MLSPIN: { id: "1104", name: "Homebase + Boston (EST)" } };
  const N = 5600;
  for (let i = 0; i < N; i++) w.agents.set(`s${i}`, agent(`s${i}`, `s${i}@agent.test`, { mls_all: ["SOCAL"] }));
  w.agents.set("b1", agent("b1", "b1@agent.test", { mls_all: ["MLSPIN"] }));
  w.agents.set("r1", agent("r1", "r1@agent.test", { mls_all: ["MLSPIN"] }));
  w.leads = new Map([["r1@agent.test", [{ id: 77, email: "r1@agent.test", campaigns: [{ campaignId: 1104, status: "in_sequence" }] }]]]);
  w.listed = new Set([...Array.from({ length: N }, (_, i) => `s${i}`), "b1"]);
  queue(Array.from({ length: N }, (_, i) => ({ agent: `s${i}`, action: "add" as const, next_try_at: START.toISOString() })));
  await runProspectSync(deps());
  // A minute later the client takes one off and adds a Boston agent (recorded with the usual 90 seconds' grace).
  const later = new Date(START.getTime() + 60_000);
  queue([
    { agent: "r1", action: "remove", created_at: later.toISOString(), next_try_at: new Date(later.getTime() + 90_000).toISOString() },
    { agent: "b1", action: "add", created_at: later.toISOString(), next_try_at: new Date(later.getTime() + 90_000).toISOString() },
  ]);
  let m = 1;
  for (; m <= 20 && (rowOf("r1").status !== "done" || rowOf("b1").status !== "done"); m++) {
    clock = new Date(START.getTime() + m * 60_000);
    await runProspectSync(deps());
  }
  assert.deepEqual([rowOf("r1").status, rowOf("b1").status], ["done", "done"]);
  assert.ok(m <= 14, `done within the backlog's own turn (${m} minutes)`);
  assert.deepEqual(callsOf("remove").map((c) => c.args[0]), [1104]);
});

test("a removal shown in one of the client's campaigns: looked for under the address that campaign's lead has; not found there — out of date, said; with no address known — failed, and the bell rings", async () => {
  seed();
  w.agents = new Map([["r1", agent("r1", "new@agent.test")]]);
  w.leads = new Map([["old@agent.test", [{ id: 41, email: "old@agent.test", campaigns: [{ campaignId: 100, status: "in_sequence" }] }]]]);
  w.listed = new Set();
  queue([{ agent: "r1", action: "remove", in_campaigns: [{ provider: "emailbison", id: "100", name: "Homebase + Greater Denver + ZF NS1 (MST)", emails: ["old@agent.test"] }] }]);
  await runProspectSync(deps());
  assert.deepEqual(callsOf("remove").map((c) => [c.args[0], c.args[1]]), [[100, [41]]], "the agent's email changed since — found under the campaign's own");
  // The lead already gone from that campaign: an out-of-date record — dropped, said, no alarm.
  seed();
  w.agents = new Map([["r1", agent("r1", "new@agent.test")]]);
  w.listed = new Set();
  queue([{ agent: "r1", action: "remove", in_campaigns: [{ provider: "emailbison", id: "100", name: "Homebase + Greater Denver + ZF NS1 (MST)", emails: ["old@agent.test"] }] }]);
  await runProspectSync(deps());
  assert.deepEqual([rowOf("r1").status, rowOf("r1").detail], ["done", "Was in none of Homebase's campaigns. Listed in Homebase + Greater Denver + ZF NS1 (MST), but EmailBison has no lead of it there now."]);
  assert.deepEqual(callsOf("forget").map((c) => c.args[2]), [["100"]], "the stale record dropped, so Prospects stops listing it");
  assert.equal(callsOf("bell").length, 0);
  // No address known for it there: can't be told from a lead under an address we don't have — failed, bell.
  seed();
  w.agents = new Map([["r1", agent("r1", "new@agent.test")]]);
  w.listed = new Set();
  queue([{ agent: "r1", action: "remove", in_campaigns: [{ provider: "emailbison", id: "100", name: "Homebase + Greater Denver + ZF NS1 (MST)" }] }]);
  await runProspectSync(deps());
  assert.equal(rowOf("r1").status, "failed");
  assert.match(String(rowOf("r1").detail), /no lead of it was found there under any address we have — check it there/);
  assert.equal((callsOf("bell")[0].args[0] as { severity: string }).severity, "critical");
});

test("a client whose MLSs changed: the campaign made for its old layout (or its one pick) counts — never a second draft beside it; the team is asked to pick per MLS", async () => {
  seed();
  w.mlsCodes = ["MLSPIN", "SOCAL"];
  w.setup = { id: "901", name: "Homebase + Boston + Prospects (EST)" };
  w.chosen = { id: "901", name: "Homebase + Boston + Prospects (EST)" };
  w.campaigns = [];
  w.agents = new Map([["b1", agent("b1", "b1@agent.test", { mls_all: ["MLSPIN"] })]]);
  queue([{ agent: "b1", action: "add" }]);
  await runProspectSync(deps({ setupCampaign: async (client) => { calls.push({ what: "setupCampaign", args: [client] }); return { kind: "ready", campaignId: "902", campaignName: "x", created: true, note: null }; } }));
  assert.equal(callsOf("setupCampaign").length, 0);
  assert.equal(rowOf("b1").status, "pending");
  assert.match(JSON.stringify(callsOf("bell")[0].args[0]), /none picked for its MLSPIN agents/);
  // And back to one MLS with per-MLS drafts: no '' draft beside them.
  seed();
  w.mlsCodes = ["MLSPIN"];
  w.chosen = null;
  w.campaigns = [];
  w.setupByMls = new Map([["MLSPIN", { id: "950", name: "Homebase + MLSPIN + Prospects (EST)" }], ["SOCAL", { id: "951", name: "Homebase + SOCAL + Prospects (PST)" }]]);
  w.agents = new Map([["b1", agent("b1", "b1@agent.test")]]);
  queue([{ agent: "b1", action: "add" }]);
  await runProspectSync(deps());
  assert.equal(callsOf("setupCampaign").length, 0);
  assert.equal(rowOf("b1").status, "pending");
});

test("a portal that can't be read just now: its changes are tried again — never failed for good", async () => {
  seed();
  w.ctx = null;
  queue([{ agent: "a1", action: "add" }, { agent: "r1", action: "remove" }]);
  await runProspectSync(deps());
  assert.deepEqual(db.rows("os_prospect_sync").map((r) => [r.status, r.attempts]), [["pending", 1], ["pending", 1]]);
});

test("BrokerStaffer's own portal, with many MLSs: ONE campaign for all its prospects — one draft, never one per MLS (3 Nov)", async () => {
  seed();
  const BS = "54322dcf-7392-4022-918c-990ebc8469b8";
  w.mlsCodes = ["BRIGHT", "ABOR", "ARMLS", "FMLS", "CANOPY"];
  w.campaigns = [];
  w.chosen = null;
  w.agents = new Map([["t1", agent("t1", "t1@agent.test", { mls_all: ["BRIGHT"] })], ["t2", agent("t2", "t2@agent.test", { mls_all: ["ARMLS"] })], ["t3", agent("t3", "t3@agent.test", { mls_all: ["FMLS"] })]]);
  queue(["t1", "t2", "t3"].map((a) => ({ agent: a, action: "add" as const, portal: BS })));
  w.setupOutcome = async () => ({ kind: "ready", campaignId: "960", campaignName: "BrokerStaffer + Prospects (EST)", created: true, note: null });
  await runProspectSync(deps({ env: { OS_PROSPECT_SYNC: "1", OS_PROSPECT_SYNC_ONLY: BS } }));
  assert.equal(callsOf("setupCampaign").length, 1, "one draft");
  assert.equal((callsOf("setupCampaign")[0].args[0] as { mlsCode: string | null }).mlsCode, null, "not for an MLS");
  assert.deepEqual(callsOf("attach").map((c) => [c.args[0], (c.args[1] as number[]).length]), [[960, 3]], "every MLS's agents in it");
});

test("after the run: one 'Campaign updated' post for the client — who went into which campaign, who came out, who couldn't be added and why; a list reconciling never posts", async () => {
  seed();
  w.agents = new Map([
    ["a1", agent("a1", "one@agent.test")],
    ["a2", agent("a2", null)],
    ["a3", agent("a3", "three@agent.test")],
    ["r1", agent("r1", "pref@agent.test")],
  ]);
  w.leads = new Map([
    ["three@agent.test", [{ id: 33, email: "three@agent.test", campaigns: [{ campaignId: 200, status: "completed" }] }]],
    ["pref@agent.test", [{ id: 11, email: "pref@agent.test", campaigns: [{ campaignId: 100, status: "in_sequence" }] }]],
  ]);
  w.listed = new Set(["a1", "a2", "a3"]);
  queue([{ agent: "a1", action: "add" }, { agent: "a2", action: "add" }, { agent: "a3", action: "add" }, { agent: "r1", action: "remove" }]);
  await runProspectSync(deps());
  const posts = callsOf("slack").map((c) => String(c.args[0]));
  assert.equal(posts.length, 1);
  assert.equal(posts[0], [
    "[TEST] *Campaign updated · Homebase*",
    "• 1 added to Homebase + Greater Denver + ZF NS1 (MST): Agent A1",
    "• 1 removed from Homebase + Greater Denver + ZF NS1 (MST): Agent R1",
    "• 1 already in Homebase + Old (MST): Agent A3",
    "• 1 not added (no email on file): Agent A2",
  ].join("\n"));
  // Nothing changed in a campaign (the list reconciled, or a removal of someone in none): no post.
  seed();
  w.agents = new Map([["r2", agent("r2", "nobody@agent.test")]]);
  w.listed = new Set();
  queue([{ agent: "r2", action: "remove" }]);
  await runProspectSync(deps());
  assert.equal(callsOf("slack").length, 0);
});

test("a client waiting for its first campaign: the bell counts every add waiting — not only the run's share", async () => {
  seed();
  w.campaigns = [];
  w.chosen = null;
  queue(Array.from({ length: 1200 }, (_, i) => ({ agent: `w${i}`, action: "add" as const })));
  await runProspectSync(deps());
  assert.match(JSON.stringify(callsOf("bell")[0].args[0]), /1,200 prospects can't go into a campaign yet: Its first campaign is being made/);
});

test("EmailBison failing a lookup: the rest of the batch isn't looked up (each would wait out its retries) — all of it tried again later", async () => {
  seed();
  w.agents = new Map(["a1", "a2", "a3"].map((a) => [a, agent(a, `${a}@agent.test`)]));
  queue(["a1", "a2", "a3"].map((a) => ({ agent: a, action: "add" as const })));
  let looked = 0;
  await runProspectSync(deps({ findLeads: async () => { looked++; throw new Error("EmailBison: 503"); } }));
  assert.equal(looked, 1, "one failed lookup stops the batch's lookups");
  assert.deepEqual(db.rows("os_prospect_sync").map((r) => [r.status, r.attempts]), [["pending", 1], ["pending", 1], ["pending", 1]]);
  assert.equal(callsOf("upsert").length + callsOf("attach").length, 0);
  // Removals the same.
  seed();
  w.agents = new Map(["r1", "r2"].map((a) => [a, agent(a, `${a}@agent.test`)]));
  w.listed = new Set();
  queue(["r1", "r2"].map((a) => ({ agent: a, action: "remove" as const })));
  looked = 0;
  await runProspectSync(deps({ findLeads: async () => { looked++; throw new Error("EmailBison: 503"); } }));
  assert.equal(looked, 1);
  assert.deepEqual(db.rows("os_prospect_sync").map((r) => r.status), ["pending", "pending"]);
  assert.equal(callsOf("remove").length, 0);
});

test("after an attach, EmailBison's search lagging (it doesn't show the new leads yet): none is called added or left out on no evidence — tried again, and then found there, nothing done twice", async () => {
  seed();
  w.agents = new Map(["a1", "a2", "a3"].map((a) => [a, agent(a, `${a}@agent.test`)]));
  w.attachSkips = 1; // EmailBison left one out…
  w.afterAttach = new Map(); // …but its search shows none of the three in the campaign yet
  queue(["a1", "a2", "a3"].map((a) => ({ agent: a, action: "add" as const })));
  await runProspectSync(deps());
  assert.deepEqual(db.rows("os_prospect_sync").map((r) => [r.status, r.attempts]), [["pending", 1], ["pending", 1], ["pending", 1]]);
  // A minute on the search has caught up: two went in. The third was really left out: EmailBison's lead shows why.
  calls.length = 0;
  clock = new Date(START.getTime() + BACKOFF_MIN[0] * 60_000);
  w.afterAttach = null;
  w.leads = new Map([
    ["a1@agent.test", [{ id: 11, email: "a1@agent.test", campaigns: [{ campaignId: 100, status: "in_sequence" }] }]],
    ["a2@agent.test", [{ id: 12, email: "a2@agent.test", campaigns: [{ campaignId: 100, status: "in_sequence" }] }]],
    ["a3@agent.test", inOther(13, "a3@agent.test", "bounced", "bounced")],
  ]);
  await runProspectSync(deps());
  assert.equal(callsOf("attach").length, 0, "nothing asked for twice");
  assert.deepEqual(["a1", "a2", "a3"].map((a) => rowOf(a).status), ["done", "done", "skipped"]);
  // On record as added, and said so: a later removal looks where it was put.
  assert.deepEqual([rowOf("a1").detail, rowOf("a1").campaign_id, rowOf("a1").eb_lead_id], [`Added to ${CAMPAIGN}.`, "100", "11"]);
  assert.match(String(callsOf("slack").at(-1)!.args[0]), /• 2 added to Homebase \+ Greater Denver \+ ZF NS1 \(MST\): Agent A1, Agent A2/);
});

test("EmailBison refusing every lead with nothing else to go on: tried again, bounded — never a day of blind retries once it can tell, never final on no evidence; any other refusal is a passing trouble", async () => {
  seed();
  w.agents = new Map([["a1", agent("a1", "one@agent.test")]]);
  queue([{ agent: "a1", action: "add" }]);
  const refuse = (error: string) => deps({ attach: async (_c, leadIds) => ({ ok: false, attempted: leadIds.length, applied: 0, skipped: 0, chunks: [{ size: leadIds.length, ok: false, error }], batchId: "b" }) });
  await runProspectSync(refuse("No leads were added because they are either in other sequences, have previously bounced, or unsubscribed"));
  assert.deepEqual([rowOf("a1").status, rowOf("a1").attempts], ["pending", 1]);
  assert.match(String(rowOf("a1").detail), /and gave no reason — trying again\.$/);
  assert.equal(callsOf("slack").length, 0, "nothing decided: nothing to say");
  seed();
  w.agents = new Map([["a1", agent("a1", "one@agent.test")]]);
  queue([{ agent: "a1", action: "add" }]);
  await runProspectSync(refuse("EmailBison: 502 Bad Gateway"));
  assert.deepEqual([rowOf("a1").status, rowOf("a1").attempts], ["pending", 1], "a passing trouble: tried again");
  assert.match(String(rowOf("a1").detail), /^Not added to .* yet: EmailBison: 502/);
});

test("a blank first campaign (no template set): the prospects go in, Slack says it's blank and what's next, the bell says what it still needs — counted across the whole backlog", async () => {
  seed();
  w.campaigns = [];
  w.chosen = null;
  w.setupOutcome = async () => ({ kind: "ready", campaignId: "902", campaignName: "Premier Home Team + Prospects (EST)", created: true, note: "Created blank (no template is set): add its emails, schedule and sending inboxes before launching it.", blank: true });
  w.agents = new Map(Array.from({ length: 600 }, (_, i) => [`p${i}`, agent(`p${i}`, `p${i}@agent.test`)]));
  queue(Array.from({ length: 600 }, (_, i) => ({ agent: `p${i}`, action: "add" as const })));
  await runProspectSync(deps());
  assert.deepEqual(callsOf("attach").map((c) => [c.args[0], (c.args[1] as number[]).length]), [[902, 500]]);
  const first = String(callsOf("slack")[0].args[0]);
  assert.match(first, /First campaign created · Homebase\*\n• Premier Home Team \+ Prospects \(EST\): a blank draft, not launched\n• 600 agents from their Prospects going in\n_Next: add its emails, schedule and inboxes/);
  assert.match(JSON.stringify(callsOf("bell")[0].args[0]), /First campaign needs a look[\s\S]*add its emails, schedule and sending inboxes/);
  assert.equal((callsOf("bell")[0].args[0] as { severity: string }).severity, "warning");
});

/* ---------------------------------- what EmailBison won't take: told apart, and the ones it holds looked at weekly --- */

test("what EmailBison won't take is settled before asking: bounced and unsubscribed are final; another campaign's sequence comes back in a week; a paused campaign holds nothing; the post tells them apart", async () => {
  seed();
  w.agents = new Map(["a1", "a2", "a3", "a4", "a5"].map((a) => [a, agent(a, `${a}@agent.test`)]));
  w.leads = new Map([
    ["a2@agent.test", inOther(22, "a2@agent.test", "bounced", "bounced")],
    ["a3@agent.test", inOther(33, "a3@agent.test", "stopped", "unsubscribed")],
    ["a4@agent.test", inOther(44, "a4@agent.test")],
    ["a5@agent.test", inOther(55, "a5@agent.test", "sending_paused")],
  ]);
  queue(["a1", "a2", "a3", "a4", "a5"].map((a) => ({ agent: a, action: "add" as const })));
  const r = await runProspectSync(deps());
  assert.equal(callsOf("attach").length, 1);
  assert.deepEqual(callsOf("attach")[0].args[1], [55, 5000], "asked only for the two it can take: the paused one as it is, the new one made");
  assert.deepEqual(callsOf("upsert").flatMap((c) => (c.args[0] as BisonLeadPayload[]).map((l) => l.email)), ["a1@agent.test"], "no lead it won't take is touched");
  assert.deepEqual([rowOf("a1").status, rowOf("a1").detail], ["done", `Added to ${CAMPAIGN}.`]);
  assert.deepEqual([rowOf("a5").status, rowOf("a5").eb_lead_id], ["done", "55"]);
  assert.deepEqual([rowOf("a2").status, rowOf("a2").detail, rowOf("a2").next_try_at], ["skipped", `Not added to ${CAMPAIGN}: the address has bounced.`, null]);
  assert.deepEqual([rowOf("a3").status, rowOf("a3").detail, rowOf("a3").next_try_at], ["skipped", `Not added to ${CAMPAIGN}: the address has unsubscribed.`, null]);
  assert.equal(rowOf("a4").status, "pending");
  assert.equal(rowOf("a4").detail, `In another campaign's sequence (campaign 999): EmailBison won't add it to ${CAMPAIGN} until that ends. Trying again every week.`);
  assert.equal(rowOf("a4").next_try_at, new Date(START.getTime() + SEQUENCE_WAIT_MS).toISOString());
  assert.deepEqual([rowOf("a4").attempts, rowOf("a4").claim_token, rowOf("a4").email, rowOf("a4").eb_lead_id], [0, null, "a4@agent.test", "44"]);
  assert.deepEqual([r.done, r.skipped, r.waiting, r.failed], [2, 2, 1, 0]);
  assert.equal(callsOf("slack").at(-1)!.args[0], [
    "[TEST] *Campaign updated · Homebase*",
    `• 2 added to ${CAMPAIGN}: Agent A5, Agent A1`,
    "• 2 not added (bounced or unsubscribed): Agent A2, Agent A3",
    "• 1 not added (in another campaign's sequence, trying again weekly): Agent A4",
  ].join("\n"));
});

test("EmailBison leaving some out after all (a lead's state changed since the look): each judged on its own — a held lead is never 'added' because another's search lagged", async () => {
  seed();
  w.agents = new Map(["a1", "a2", "a3", "a4"].map((a) => [a, agent(a, `${a}@agent.test`)]));
  w.attachSkips = 1; // EmailBison's count says one was left out; the looks below don't add up to that
  w.afterAttach = new Map([
    ["a1@agent.test", [{ id: 11, email: "a1@agent.test", status: "unverified", campaigns: [{ campaignId: 100, status: "in_sequence" }] }]],
    ["a2@agent.test", inOther(22, "a2@agent.test", "bounced", "bounced")],
    ["a3@agent.test", inOther(33, "a3@agent.test")],
  ]);
  queue(["a1", "a2", "a3", "a4"].map((a) => ({ agent: a, action: "add" as const })));
  await runProspectSync(deps());
  assert.equal(rowOf("a1").status, "done");
  assert.deepEqual([rowOf("a2").status, rowOf("a2").detail], ["skipped", `Not added to ${CAMPAIGN}: the address has bounced.`]);
  assert.match(String(rowOf("a3").detail), /^In another campaign's sequence/);
  assert.equal(rowOf("a3").status, "pending");
  assert.deepEqual([rowOf("a4").status, rowOf("a4").attempts], ["pending", 1], "its search hasn't caught up: not called added, not called left out");
});

test("a search failing after an attach decides nothing: what was already judged stands, the rest are tried again and not looked up, each waiting out a timeout — and none is called added", async () => {
  seed();
  w.agents = new Map(["a1", "a2", "a3", "a4"].map((a) => [a, agent(a, `${a}@agent.test`)]));
  queue(["a1", "a2", "a3", "a4"].map((a) => ({ agent: a, action: "add" as const })));
  let attached = false;
  let looks = 0;
  await runProspectSync(deps({
    attach: async (_c, ids) => { attached = true; return { ok: true, attempted: ids.length, applied: 1, skipped: ids.length - 1, chunks: [{ size: ids.length, ok: true }], batchId: "b" }; },
    findLeads: async (email) => { if (!attached) return []; if (++looks === 2) throw new Error("EmailBison: 503"); return inOther(11, email); },
  }));
  assert.equal(looks, 2);
  assert.equal(rowOf("a1").status, "pending");
  assert.match(String(rowOf("a1").detail), /^In another campaign's sequence/);
  for (const a of ["a2", "a3", "a4"]) {
    assert.deepEqual([rowOf(a).status, rowOf(a).attempts], ["pending", 1]);
    assert.match(String(rowOf(a).detail), /could not be searched just now/);
  }
  assert.equal(db.rows("os_prospect_sync").filter((r) => r.status === "done").length, 0);
});

test("EmailBison refusing every lead in a request (their state changed since the look): each judged — not all taken as one reason; a lead that turns out to be in the campaign is in it", async () => {
  seed();
  w.agents = new Map(["a1", "a2", "a3"].map((a) => [a, agent(a, `${a}@agent.test`)]));
  queue(["a1", "a2", "a3"].map((a) => ({ agent: a, action: "add" as const })));
  let attached = false;
  const refuse = refuseAll();
  const after = new Map<string, Found[]>([
    ["a1@agent.test", inOther(11, "a1@agent.test")],
    ["a2@agent.test", inOther(22, "a2@agent.test", "bounced", "bounced")],
    ["a3@agent.test", [{ id: 33, email: "a3@agent.test", status: "unverified", campaigns: [{ campaignId: 100, status: "in_sequence" }] }]],
  ]);
  await runProspectSync(deps({
    attach: async (c, ids) => { attached = true; return refuse.attach(c, ids); },
    findLeads: async (email) => (attached ? after.get(email) ?? [] : []),
  }));
  assert.equal(rowOf("a1").status, "pending");
  assert.match(String(rowOf("a1").detail), /^In another campaign's sequence/);
  assert.deepEqual([rowOf("a2").status, rowOf("a2").detail], ["skipped", `Not added to ${CAMPAIGN}: the address has bounced.`]);
  assert.deepEqual([rowOf("a3").status, rowOf("a3").detail, rowOf("a3").campaign_id], ["done", `Added to ${CAMPAIGN}.`, "100"]);
});

test("EmailBison refusing every lead, and its search down: nothing is decided on no evidence — tried again, an attempt counted, the rest not looked up", async () => {
  seed();
  w.agents = new Map(["a1", "a2", "a3"].map((a) => [a, agent(a, `${a}@agent.test`)]));
  queue(["a1", "a2", "a3"].map((a) => ({ agent: a, action: "add" as const })));
  let attached = false;
  let looks = 0;
  const refuse = refuseAll();
  await runProspectSync(deps({
    attach: async (c, ids) => { attached = true; return refuse.attach(c, ids); },
    findLeads: async () => { if (!attached) return []; looks++; throw new Error("EmailBison: 503"); },
  }));
  assert.equal(looks, 1, "one failed look stops the rest");
  for (const a of ["a1", "a2", "a3"]) {
    assert.deepEqual([rowOf(a).status, rowOf(a).attempts], ["pending", 1]);
    assert.match(String(rowOf(a).detail), /could not be searched just now/);
  }
  assert.equal(callsOf("slack").length, 0);
});

test("the weekly look: untouched until it's due; still held — back in a week, not asked for, no post, no attempts piling up; free at last — added, and said", async () => {
  seed();
  w.agents = new Map([["a1", agent("a1", "a1@agent.test")]]);
  w.leads = new Map([["a1@agent.test", inOther(11, "a1@agent.test")]]);
  queue([{ agent: "a1", action: "add" }]);
  await runProspectSync(deps());
  assert.equal(callsOf("attach").length, 0, "held: not asked for");
  assert.equal(callsOf("slack").length, 1, "said the first time");
  const firstWeek = rowOf("a1").next_try_at;

  // A day later: not due, not touched.
  calls.length = 0;
  clock = new Date(START.getTime() + 24 * 3600_000);
  const quiet = await runProspectSync(deps());
  assert.equal(quiet.claimed, 0);
  assert.equal(callsOf("find").length, 0);
  assert.equal(rowOf("a1").next_try_at, firstWeek);

  // A week on, still held: looked at again; nothing to say.
  calls.length = 0;
  clock = new Date(START.getTime() + SEQUENCE_WAIT_MS);
  await runProspectSync(deps());
  assert.equal(callsOf("find").length, 1, "looked at again");
  assert.equal(callsOf("attach").length, 0);
  assert.equal(callsOf("slack").length, 0, "nothing new: no post");
  assert.deepEqual([rowOf("a1").status, rowOf("a1").attempts], ["pending", 0]);
  assert.equal(rowOf("a1").next_try_at, new Date(clock.getTime() + SEQUENCE_WAIT_MS).toISOString());

  // Another week: the other sequence ended. EmailBison takes it, as it is.
  calls.length = 0;
  clock = new Date(clock.getTime() + SEQUENCE_WAIT_MS);
  w.leads = new Map([["a1@agent.test", inOther(11, "a1@agent.test", "sequence_finished")]]);
  await runProspectSync(deps());
  assert.deepEqual(callsOf("attach")[0].args[1], [11]);
  assert.deepEqual(callsOf("upsert"), [], "never rewritten");
  assert.deepEqual([rowOf("a1").status, rowOf("a1").campaign_id, rowOf("a1").next_try_at, rowOf("a1").detail], ["done", "100", null, `Added to ${CAMPAIGN}.`]);
  assert.equal(callsOf("slack").at(-1)!.args[0], ["[TEST] *Campaign updated · Homebase*", `• 1 added to ${CAMPAIGN}: Agent A1`].join("\n"));
});

const held = `In another campaign's sequence (campaign 999): EmailBison won't add it to ${CAMPAIGN} until that ends. Trying again every week.`;

test("a failed look on the weekly try, then held again: its attempts start afresh and it isn't said twice — the failure wrote over its detail, not what marks it", async () => {
  seed();
  w.agents = new Map([["a1", agent("a1", "a1@agent.test")]]);
  w.leads = new Map([["a1@agent.test", inOther(11, "a1@agent.test")]]);
  queue([{ agent: "a1", action: "add", detail: held, email: "a1@agent.test" }]);
  await runProspectSync(deps({ findLeads: async () => { throw new Error("EmailBison: 503"); } }));
  assert.deepEqual([rowOf("a1").status, rowOf("a1").attempts, rowOf("a1").email], ["pending", 1, "a1@agent.test"]);
  assert.match(String(rowOf("a1").detail), /could not be searched/);
  clock = new Date(START.getTime() + BACKOFF_MIN[0] * 60_000);
  await runProspectSync(deps());
  assert.deepEqual([rowOf("a1").status, rowOf("a1").attempts, rowOf("a1").detail], ["pending", 0, held]);
  assert.equal(callsOf("slack").length, 0, "said once, the first time");
});

test("waiting a week, then taken off Prospects: not added when it comes due — the list decides, nothing attached, no post; its removal was done meanwhile", async () => {
  seed();
  w.agents = new Map([["a1", agent("a1", "a1@agent.test")]]);
  w.listed = new Set();
  const week = new Date(START.getTime() + SEQUENCE_WAIT_MS).toISOString();
  queue([{ agent: "a1", action: "add", detail: held, email: "a1@agent.test", next_try_at: week, created_at: new Date(START.getTime() - SEQUENCE_WAIT_MS).toISOString() }, { agent: "a1", action: "remove" }]);
  const [waiting, removal] = db.rows("os_prospect_sync");
  await runProspectSync(deps());
  const after = (id: unknown) => db.rows("os_prospect_sync").find((r) => r.id === id) as Row;
  assert.equal(after(removal.id).status, "done", "the removal isn't held up by the older add");
  assert.equal(after(waiting.id).status, "pending");
  assert.equal(after(waiting.id).next_try_at, week, "not due");
  calls.length = 0;
  clock = new Date(week);
  await runProspectSync(deps());
  assert.deepEqual([after(waiting.id).status, after(waiting.id).detail], ["skipped", "Not on Prospects — not added."]);
  assert.equal(callsOf("attach").length, 0);
  assert.equal(callsOf("slack").length, 0);
});

test("waiting a week, and it bounced meanwhile: final, and said", async () => {
  seed();
  w.agents = new Map([["a1", agent("a1", "a1@agent.test")]]);
  w.leads = new Map([["a1@agent.test", inOther(11, "a1@agent.test", "bounced", "bounced")]]);
  queue([{ agent: "a1", action: "add", detail: held, email: "a1@agent.test" }]);
  await runProspectSync(deps());
  assert.deepEqual([rowOf("a1").status, rowOf("a1").next_try_at], ["skipped", null]);
  assert.match(String(callsOf("slack").at(-1)!.args[0]), /• 1 not added \(bounced or unsubscribed\): Agent A1/);
});

test("a client that has churned: what was waiting on another campaign's sequence is not added, even if a failure wrote over its detail — nothing goes into its campaign months later; a paused client keeps waiting", async () => {
  const record = (status: string) => ({ clientRecord: async () => ({ name: "Homebase", aliases: [], areas: [], mls: [], analyticsClientId: null, healthClientId: null, status }) });
  seed();
  w.agents = new Map([["a1", agent("a1", "a1@agent.test")]]);
  w.leads = new Map([["a1@agent.test", inOther(11, "a1@agent.test", "sequence_finished")]]);
  queue([{ agent: "a1", action: "add", detail: "EmailBison could not be searched just now (503) — trying again.", email: "a1@agent.test" }]);
  await runProspectSync(deps(record("churned")));
  assert.deepEqual([rowOf("a1").status, rowOf("a1").detail], ["skipped", "Not added: Homebase is no longer a client."]);
  assert.equal(callsOf("attach").length, 0);
  assert.equal(callsOf("slack").length, 0);

  seed();
  w.agents = new Map([["a1", agent("a1", "a1@agent.test")]]);
  w.leads = new Map([["a1@agent.test", inOther(11, "a1@agent.test")]]);
  queue([{ agent: "a1", action: "add", detail: held, email: "a1@agent.test" }]);
  await runProspectSync(deps(record("paused")));
  assert.equal(rowOf("a1").status, "pending");
});

test("a new client's first-campaign count: an agent waiting on another campaign's sequence isn't waiting for a campaign, however near its next look", async () => {
  seed();
  w.campaigns = [];
  w.chosen = null;
  w.setupOutcome = async () => ({ kind: "waiting", reason: "Its first campaign is being made." });
  w.agents = new Map([["a1", agent("a1", "a1@agent.test")], ["a2", agent("a2", "a2@agent.test")], ["a3", agent("a3", "a3@agent.test")]]);
  const soon = new Date(START.getTime() + WAIT_MS).toISOString();
  queue([{ agent: "a1", action: "add" }, { agent: "a2", action: "add", next_try_at: soon }, { agent: "a3", action: "add", detail: held, email: "a3@agent.test", next_try_at: soon }]);
  await runProspectSync(deps());
  const body = String((callsOf("bell").at(-1)!.args[0] as { body: string }).body);
  assert.match(body, /^2 prospects can't go into a campaign yet/);
});

test("a market's pick that goes to another of the client's portals (so not one of its campaigns here): a lead already in it is in it — never held every week or called left out because of what else it's in", async () => {
  seed();
  w.mlsCodes = ["REcolorado", "IRES"];
  w.byMls = { REcolorado: { id: "100", name: CAMPAIGN } };
  w.routes = [{ campaignId: "100", portalId: OTHER_PORTAL }];
  w.chosen = null;
  w.agents = new Map([["a1", agent("a1", "a1@agent.test")], ["a2", agent("a2", "a2@agent.test")]]);
  w.leads = new Map([
    ["a1@agent.test", [{ id: 11, email: "a1@agent.test", status: "unverified", campaigns: [{ campaignId: 100, status: "in_sequence" }, { campaignId: 999, status: "in_sequence" }] }]],
    ["a2@agent.test", [{ id: 22, email: "a2@agent.test", status: "bounced", campaigns: [{ campaignId: 100, status: "bounced" }] }]],
  ]);
  queue([{ agent: "a1", action: "add" }, { agent: "a2", action: "add" }]);
  await runProspectSync(deps());
  assert.deepEqual([rowOf("a1").status, rowOf("a1").detail, rowOf("a1").next_try_at], ["done", `Already in ${CAMPAIGN}.`, null]);
  assert.deepEqual([rowOf("a2").status, rowOf("a2").detail], ["done", `Already in ${CAMPAIGN}.`]);
  assert.equal(callsOf("attach").length, 0);
});

test("a churned client: an agent's older change isn't let through when its held one is set aside", async () => {
  seed();
  w.agents = new Map([["a1", agent("a1", "a1@agent.test")]]);
  queue([{ agent: "a1", action: "add" }, { agent: "a1", action: "add", detail: held, email: "a1@agent.test" }]);
  await runProspectSync(deps({ clientRecord: async () => ({ name: "Homebase", aliases: [], areas: [], mls: [], analyticsClientId: null, healthClientId: null, status: "churned" }) }));
  assert.equal(callsOf("attach").length, 0);
  assert.deepEqual(db.rows("os_prospect_sync").map((r) => [r.status, r.detail]), [["skipped", "Not added: Homebase is no longer a client."], ["skipped", "Not added: Homebase is no longer a client."]]);
});
