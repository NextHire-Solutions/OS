/*
 * campaign_create and campaign_add_agents (28 Nov) through runAction, against stand-ins (recorded, not run): the preview
 * changes nothing and says what will happen; confirm does exactly that; every refusal says why; adding agents is
 * admins only.
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";

const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

const calls: string[] = [];
const world = {
  campaigns: [] as Array<{ id: string; name: string; status: string; platform: string; team_id: number }>,
  live: new Map<number, string>(),
  template: { campaignId: "251", campaignName: "ZF NS1 SEPT-2026 MASTER" } as null | { campaignId: string; campaignName: string },
  steps: [] as Array<{ email_subject: string; email_body: string; variant?: boolean }>,
  senders: [] as number[],
  healthy: [] as number[],
  clients: [] as Array<{ id: string; name: string; aliases: string[] | null; areas: string[] | null; an_client_id: string | null; status: string }>,
  failAt: null as null | "duplicate" | "rename",
  // add agents
  resolve: { ok: true, q: { place: { level: "city", value: "Phoenix, AZ" } }, resolved: {}, otherPlaces: [] } as Record<string, unknown>,
  count: 1234,
  before: 200,
  running: null as null | Record<string, unknown>,
  client: null as null | { osClientId: string; name: string },
};

function likeToRegex(p: string): RegExp {
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "\\" && i + 1 < p.length) { out += p[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue; }
    out += ch === "%" ? ".*" : ch === "_" ? "." : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}
function analyticsDb() {
  return {
    from(table: string) {
      if (table !== "campaigns_unified") {
        return {
          upsert: async (row: Record<string, unknown>) => { calls.push(`analytics ${table} upsert ${JSON.stringify(row).slice(0, 200)}`); return { error: null }; },
          insert: async (row: Record<string, unknown>) => { calls.push(`analytics ${table} insert ${String(row.action)} by ${String(row.actor)}`); return { error: null }; },
        };
      }
      const eqs: Record<string, unknown> = {};
      const likes: RegExp[] = [];
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (c: string, v: unknown) => { eqs[c] = v; return b; },
        ilike: (_c: string, p: string) => { likes.push(likeToRegex(p)); return b; },
        limit: () => b,
        then: (res: (v: unknown) => unknown) => Promise.resolve({ data: world.campaigns.filter((r) => Object.entries(eqs).every(([k, v]) => String((r as Record<string, unknown>)[k]) === String(v)) && likes.every((re) => re.test(r.name))), error: null }).then(res),
      };
      return b;
    },
  };
}

let create: typeof import("./campaign-create.ts");
let add: typeof import("./campaign-agents.ts");
let core: typeof import("./core.ts");
const EDDY = { email: "eddy@brokerstaffer.com", admin: true, grants: [] as string[] };

async function load() {
  if (create) return;
  mock.module("server-only", { namedExports: {} });
  mock.module("@/lib/tools/analytics/supabase", { namedExports: { getAnalyticsSupabase: analyticsDb, analyticsTeamId: () => 7 } });
  mock.module("@/lib/clients/os-db", {
    namedExports: {
      osTable: () => {
        const c: Record<string, unknown> = { eq: () => c, maybeSingle: async () => ({ data: world.clients[0] ?? null, error: null }), then: (res: (v: unknown) => unknown) => Promise.resolve({ data: world.clients, error: null }).then(res) };
        return { select: () => c };
      },
    },
  });
  mock.module("@/lib/tools/analytics/emailbison/client.ts", {
    namedExports: {
      createEmailBisonClient: () => ({
        getCampaign: async (id: number) => ({ id, status: world.live.get(id) ?? "draft" }),
        getCampaignSequenceSteps: async () => ({ data: { sequence_id: 1, sequence_steps: world.steps } }),
        getCampaignSenderEmails: async () => world.senders.map((id) => ({ id })),
        duplicateCampaign: async (id: number) => { calls.push(`duplicate ${id}`); if (world.failAt === "duplicate") throw new Error("EmailBison 500"); return { data: { id: 1600 } }; },
        createCampaign: async (name: string) => { calls.push(`create "${name}"`); return { data: { id: 1601 } }; },
        updateCampaign: async (id: number, patch: Record<string, unknown>) => { calls.push(`update ${id} ${JSON.stringify(patch)}`); if (world.failAt === "rename") throw new Error("EmailBison 422"); },
        attachSenderEmails: async (id: number, ids: number[]) => { calls.push(`attach inboxes ${id} ${JSON.stringify(ids)}`); },
      }),
    },
  });
  mock.module("@/lib/clients/prospect-sync/setup-campaign", { namedExports: { loadTemplate: async () => world.template } });
  mock.module("@/lib/tools/analytics/campaigns/attach-health-io", { namedExports: { healthyOnly: async () => ({ ids: world.healthy, note: world.healthy.length < world.senders.length ? `${world.senders.length - world.healthy.length} left out by the health rules.` : null }) } });
  mock.module("@/lib/tools/analytics/campaigns/client-fields-load", { namedExports: { fillCampaignSequence: async (_eb: unknown, id: number, _t: string, values: Record<string, unknown>) => { calls.push(`fill ${id} area=${String(values.area)} alias=${String(values.alias)}`); return { steps: 2, filled: values.area ? 1 : 0, missing: values.area ? [] : ["area"] }; } } });
  mock.module("@/lib/clients/campaign-agents/run", {
    namedExports: {
      PER_RUN: 200,
      campaignClient: async () => world.client,
      runningJobFor: async () => { if ((world.running as unknown) === "missing") throw new Error("needs migrations/0059_campaign_agent_jobs.sql"); return world.running; },
      createAgentJob: async (o: Record<string, unknown>) => { calls.push(`job ${JSON.stringify(o)}`); return { id: "job-1" }; },
    },
  });
  mock.module("@/lib/tools/assistant/tools-phase10", {
    namedExports: {
      resolveAgentQuery: async () => world.resolve,
      agentCount: async (f: Record<string, unknown>) => (f.contactedOnly ? world.before : world.count),
    },
  });
  // A contacted-before count is asked with contacted: true — the stand-in tells the two apart by that.
  mock.module("@/lib/tools/assistant/agent-query", {
    namedExports: {
      buildFilters: (q: Record<string, unknown>) => ({ ...q, ...(q.contacted === true ? { contactedOnly: true } : {}) }),
      describeQuery: () => ["in Phoenix, AZ", "with an email"],
    },
  });
  // campaign-one.ts's own imports (resolveEbCampaign is used here).
  mock.module("@/lib/tools/analytics/campaigns/actions.ts", { namedExports: { applyCampaignAction: async () => ({ results: [] }) } });
  mock.module("@/lib/tools/analytics/campaigns/launch-load", { namedExports: { launchFacts: async () => null, launchCampaign: async () => ({ ok: false }) } });
  mock.module("@/lib/tools/analytics/campaigns/settings-update.ts", { namedExports: { readSettings: async () => null, applySettings: async () => ({ ok: false, error: "x" }) } });
  core = await import("./core.ts");
  create = await import("./campaign-create.ts");
  add = await import("./campaign-agents.ts");
}

function deps() {
  const claimed = new Set<string>(); let i = 0;
  return {
    sign: async (c: Record<string, unknown>) => Buffer.from(JSON.stringify(c)).toString("base64url"),
    verify: async (t: string) => JSON.parse(Buffer.from(t, "base64url").toString()) as Record<string, unknown>,
    audit: { used: async (n: string) => claimed.has(n), claim: async (r: { nonce: string }) => (claimed.has(r.nonce) ? false : (claimed.add(r.nonce), true)), finish: async () => {} },
    nonce: () => `n${++i}`,
  };
}
const run = (spec: unknown, args: Record<string, unknown>, d = deps(), v = EDDY) => core.runAction(spec as never, args, v, d as never);
function reset() {
  calls.length = 0;
  Object.assign(world, {
    campaigns: [
      { id: "251", name: "ZF NS1 SEPT-2026 MASTER", status: "draft", platform: "emailbison", team_id: 7 },
      { id: "1500", name: "Howe Realty 9 + Phoenix", status: "draft", platform: "emailbison", team_id: 7 },
    ],
    live: new Map([[251, "draft"], [1500, "draft"]]),
    template: { campaignId: "251", campaignName: "ZF NS1 SEPT-2026 MASTER" },
    steps: [{ email_subject: "{FIRST_NAME}?", email_body: "<p>Hi from {CLIENT_AREA}</p>" }, { email_subject: "Re:", email_body: "<p>Following up</p>" }, { email_subject: "B", email_body: "<p>v</p>", variant: true }],
    senders: [11, 12, 13, 14], healthy: [11, 12, 13],
    clients: [{ id: "os-howe", name: "Howe Realty Group", aliases: ["Howe"], areas: ["Phoenix"], an_client_id: "an-howe", status: "active" }],
    failAt: null,
    resolve: { ok: true, q: { place: { level: "city", value: "Phoenix, AZ" } }, resolved: {}, otherPlaces: [] },
    count: 1234, before: 200, running: null, client: null,
  });
}

/* ------------------------------------------------------------------------------------------- campaign_create --- */

test("create: a copy of the team's template for a client — the preview says everything; confirm copies, renames, fills, attaches, records; never starts it", { skip }, async () => {
  await load(); reset();
  const d = deps();
  const p = await run(create.campaignCreate, { name: "Howe Realty Group + Phoenix + Prospects (MST)", client: "Howe Realty Group" }, d);
  assert.equal(p.preview, `Create a draft campaign "Howe Realty Group + Phoenix + Prospects (MST)": a copy of "ZF NS1 SEPT-2026 MASTER" (#251): its 2 emails (with 1 A/B version), settings and schedule; 3 of its 4 inboxes attached (healthy only). 1 left out by the health rules. Its client fields are filled for Howe Realty Group: {CLIENT_AREA} → "Phoenix". Tied to Howe Realty Group in Campaign Analytics. It is not started.`);
  assert.deepEqual(calls, [], "the preview made nothing");
  const done = await run(create.campaignCreate, { name: "Howe Realty Group + Phoenix + Prospects (MST)", client: "Howe Realty Group", confirm: p.confirm }, d);
  assert.equal(done.done, true);
  assert.deepEqual(calls.slice(0, 4), [
    "duplicate 251",
    `update 1600 {"name":"Howe Realty Group + Phoenix + Prospects (MST)"}`,
    "fill 1600 area=Phoenix alias=Howe",
    "attach inboxes 1600 [11,12,13]",
  ]);
  assert.match(calls[4], /^analytics campaigns upsert \{"id":1600,"team_id":7,"name":"Howe Realty Group \+ Phoenix \+ Prospects \(MST\)","status":"draft"/);
  assert.match(calls[5], /^analytics campaign_clients upsert \{"campaign_id":1600,"client_id":"an-howe"/);
  assert.equal(calls[6], "analytics campaign_audit_log insert create by eddy@brokerstaffer.com via Claude");
  assert.ok(!calls.some((c) => /resume|launch|start/.test(c)), "never started");
  assert.equal((done.result as { number: number }).number, 1600);
});

test("create: BrokerStaffer's own (no client) — client fields left and said; a blank one; a name in use, an unknown or ambiguous client, refused", { skip }, async () => {
  await load(); reset();
  const own = await run(create.campaignCreate, { name: "ZF Recruit Dallas Dec-2026" });
  assert.match(String(own.preview), /Its emails use client fields \(\{CLIENT_AREA\} \/ \{CLIENT_ALIAS\}\); with no client they stay as they are, and the campaign can't be started until they're filled or taken out\. Not tied to a client \(BrokerStaffer's own\)\. It is not started\.$/);
  const d = deps();
  const blank = await run(create.campaignCreate, { name: "ZF Blank", copy_of: "blank" }, d);
  assert.match(String(blank.preview), /^Create a draft campaign "ZF Blank": a blank campaign \(no emails, schedule or inboxes yet/);
  await run(create.campaignCreate, { name: "ZF Blank", copy_of: "blank", confirm: blank.confirm }, d);
  assert.deepEqual(calls.slice(0, 1), [`create "ZF Blank"`]);
  assert.ok(!calls.some((c) => c.startsWith("attach inboxes") || c.startsWith("fill")), "a blank one: no inboxes, no fields");
  reset();
  assert.match(String((await run(create.campaignCreate, { name: "howe realty 9 + phoenix" })).refused), /already exists \(#1500, draft\)/);
  assert.match(String((await run(create.campaignCreate, { name: "New one", client: "Nobody Realty" })).refused), /No client called "Nobody Realty"/);
  world.clients.push({ id: "os-h2", name: "Howe Partners", aliases: null, areas: null, an_client_id: null, status: "active" });
  assert.match(String((await run(create.campaignCreate, { name: "New one", client: "Ho" })).refused), /"Ho" matches several clients: Howe Realty Group, Howe Partners\. Which one\?/);
  assert.ok((await run(create.campaignCreate, { name: "New one", client: "Howe" })).preview, "an exact alias picks its client");
  assert.deepEqual(calls, []);
});

test("create: a client with no Area while the copy uses {CLIENT_AREA} — said before; EmailBison failing part-way says what was made", { skip }, async () => {
  await load(); reset();
  world.clients = [{ id: "os-x", name: "Xavier Homes", aliases: null, areas: [], an_client_id: "an-x", status: "active" }];
  assert.match(String((await run(create.campaignCreate, { name: "Xavier + Prospects", client: "Xavier Homes" })).preview), /Xavier Homes has nothing on record for \{CLIENT_AREA\} \(client area\)\..*The campaign can't be started until that's filled\./);
  reset(); world.failAt = "duplicate";
  const d = deps();
  const p = await run(create.campaignCreate, { name: "Fails" }, d);
  const r = await run(create.campaignCreate, { name: "Fails", confirm: p.confirm }, d);
  assert.match(String(r.failed), /^The campaign wasn't made: .*Look in EmailBison for "Copy of ZF NS1 SEPT-2026 MASTER" before trying again\./);
  reset(); world.failAt = "rename";
  const d2 = deps();
  const p2 = await run(create.campaignCreate, { name: "Half" }, d2);
  const r2 = await run(create.campaignCreate, { name: "Half", confirm: p2.confirm }, d2);
  assert.match(String(r2.failed), /^Campaign #1600 "Half" was made, but renaming it failed/);
});

/* -------------------------------------------------------------------------------------- campaign_add_agents --- */

test("add agents: the preview counts them and says what happens; confirm records the job exactly as previewed", { skip }, async () => {
  await load(); reset();
  world.client = { osClientId: "os-howe", name: "Howe Realty Group" };
  const d = deps();
  const args = { campaign: "#1500", place: "Phoenix, AZ" };
  const p = await run(add.campaignAddAgents, args, d);
  assert.equal(p.preview, `Add 1,234 agents with an email from the agent database to "Howe Realty 9 + Phoenix" (#1500, draft): in Phoenix, AZ; with an email. 200 of them have been in one of our campaigns before. This campaign is Howe Realty Group's: agents on Howe Realty Group's DNC List, My Agents or pipeline are left out, and anyone already in another of Howe Realty Group's campaigns isn't added twice. Each goes in the way Prospects adds agents: the database's own email; a lead EmailBison already has goes in as it is; bounced or unsubscribed addresses are left out. It runs in the background, up to 200 agents a minute (at least 8 minutes; EmailBison's answers set the pace). Nothing is sent until the campaign is started.`);
  assert.deepEqual(calls, []);
  const done = await run(add.campaignAddAgents, { ...args, confirm: p.confirm }, d);
  assert.equal(done.done, true);
  const job = JSON.parse(String(calls[0]).slice(4)) as Record<string, unknown>;
  assert.deepEqual([job.campaignId, job.campaignName, job.osClientId, job.matched, job.requestedBy, job.described], ["1500", "Howe Realty 9 + Phoenix", "os-howe", 1234, "eddy@brokerstaffer.com", "in Phoenix, AZ; with an email"]);
  assert.deepEqual(job.filters, { place: { level: "city", value: "Phoenix, AZ" } }, "the filters exactly as counted");
  assert.equal((done.result as { job: string }).job, "job-1");
});

test("add agents: refusals — no filter, a finished campaign, one already being filled, an unknown place, none match; the count changed since the preview; a sending campaign said; admins only", { skip }, async () => {
  await load(); reset();
  assert.match(String((await run(add.campaignAddAgents, { campaign: "#1500" })).refused), /Which agents\? Give at least one filter/);
  assert.match(String((await run(add.campaignAddAgents, { campaign: "#1500", located_by: "home" })).refused), /at least one filter/, "how a place is matched is not itself a filter");
  world.live.set(1500, "completed");
  assert.match(String((await run(add.campaignAddAgents, { campaign: "#1500", mls: "ARMLS" })).refused), /is completed: agents go only into a campaign that can still send/);
  reset(); world.running = { status: "adding", detail: "Added 10; 90 still to go." };
  assert.match(String((await run(add.campaignAddAgents, { campaign: "#1500", mls: "ARMLS" })).refused), /already being added .*Added 10; 90 still to go/);
  reset(); world.running = "missing" as never;
  assert.match(String((await run(add.campaignAddAgents, { campaign: "#1500", mls: "ARMLS" })).refused), /isn't set up yet: migration 0059/);
  reset(); world.resolve = { ok: false, answer: { note: `No city called "Phoenx" in the agent database.`, didYouMean: ["Phoenix, AZ (31,000 agents)"] } };
  assert.match(String((await run(add.campaignAddAgents, { campaign: "#1500", place: "Phoenx" })).refused), /No city called "Phoenx".*Did you mean: Phoenix, AZ/);
  reset(); world.count = 0;
  assert.match(String((await run(add.campaignAddAgents, { campaign: "#1500", place: "Phoenix" })).refused), /No agent with an email matches/);
  reset();
  const d = deps();
  const p = await run(add.campaignAddAgents, { campaign: "#1500", place: "Phoenix" }, d);
  world.count = 1300;
  assert.match(String((await run(add.campaignAddAgents, { campaign: "#1500", place: "Phoenix", confirm: p.confirm }, d)).refused), /Things changed/);
  reset(); world.live.set(1500, "active");
  assert.match(String((await run(add.campaignAddAgents, { campaign: "#1500", place: "Phoenix" })).preview), /The campaign is sending: they start getting its emails on its schedule\.$/);
  const notAdmin = { email: "gabriel@example.com", admin: false, grants: ["campaigns", "analytics", "inbox"] };
  assert.match(String((await run(add.campaignAddAgents, { campaign: "#1500", place: "Phoenix" }, deps(), notAdmin)).refused), /can't do this in the OS/);
  assert.ok(!calls.some((c) => c.startsWith("job")));
});
