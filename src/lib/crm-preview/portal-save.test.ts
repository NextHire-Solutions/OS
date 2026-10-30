/*
 * A real client's save from the new portal (portal-save.ts, 28 Oct): the current portal's own save code runs — the
 * same rows, the same side effects — on that client's rows only, and nothing at all while the portal is switched off
 * or held for an unpaid invoice.
 *
 * The handlers are the real ones (the OS's copies of Master Inbox app/api/portal/[token]/*) against a fake database;
 * everything they set off outside (blocklists, the DNC stop, Slack, the Introduction webhook, Follow Up Boss) is
 * recorded here instead of sent.
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";

import { createClient } from "@supabase/supabase-js";

import { FakePostgrest } from "../tools/master-inbox/test/fake-postgrest.ts";
import type { DemoResult } from "./demo.ts";
import type { AgentRow } from "./demo-market.ts";

const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

const fake = new FakePostgrest();
/*
 * The DNC List's dedup_key is a generated column (Master Inbox migration 0042: a company's lower(domain), an agent's
 * lower(email), else null — and nulls never clash); the fake database has none, so it is worked out here, as the
 * database would, for what is written.
 */
const dedupKey = (r: Record<string, unknown>) => {
  const v = r.kind === "company" ? r.domain : r.email;
  return typeof v === "string" && v ? v.toLowerCase() : `null:${Math.random()}`;
};
const dbFetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.pathname.endsWith("/client_dnc_entries") && init?.method === "POST" && typeof init.body === "string") {
    const body = JSON.parse(init.body) as Record<string, unknown> | Array<Record<string, unknown>>;
    const rows = (Array.isArray(body) ? body : [body]).map((r) => ({ ...r, dedup_key: dedupKey(r) }));
    init = { ...init, body: JSON.stringify(Array.isArray(body) ? rows : rows[0]) };
  }
  return fake.fetch(input, init);
};
const db = createClient("https://supabase.test", "fake", { auth: { persistSession: false }, global: { fetch: dbFetch as typeof fetch } });

const PORTAL = "54322dcf-7392-4022-918c-990ebc8469b8";
const OTHER = "11111111-1111-4111-8111-111111111111";
const TOKEN = "bs-token-not-real";

/* Everything set off outside, in order. */
type Sent = { what: string; args: unknown[] };
const sent: Sent[] = [];
const record = (what: string, out?: unknown) => async (...args: unknown[]) => {
  sent.push({ what, args });
  return out;
};
const sentOf = (what: string) => sent.filter((s) => s.what === what);
let afters: Array<() => unknown> = [];
let hold: unknown = null;
let agentDb: AgentRow[] = [];
let matching: { ids: string[]; total: number } = { ids: [], total: 0 };
let fubOutcome: unknown = { ok: true, mode: "created", personId: "p1" };

let runPortalAction: (portalId: string, action: unknown, who: string, role?: "client" | "staff") => Promise<DemoResult>;

if (canMock) {
  for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});
  process.env.CLIENT_PORTALS_ENABLED = "true";
  const realNext = await import("next/server");
  mock.module("next/server", { namedExports: { ...realNext, after: (fn: () => unknown) => void afters.push(fn) } });
  mock.module("../supabase/admin", { namedExports: { createAdminSupabase: () => db } });
  const realBlock = await import("../tools/master-inbox/portals/enforce-blocklist.ts");
  const pushed = { pushedInstantly: true, pushedEmailBison: true, error: null };
  mock.module("../tools/master-inbox/portals/enforce-blocklist", {
    namedExports: { ...realBlock, enforceBlocklist: record("blockEmail", pushed), enforceDomainBlocklist: record("blockDomain", pushed) },
  });
  mock.module("../tools/master-inbox/portals/stop-person", { namedExports: { stopEntries: record("stop"), selectBrokerStafferWorkspace: async () => {} } });
  mock.module("../tools/master-inbox/webhooks/slack-portal", {
    namedExports: {
      notifyPortalStageChange: record("slack.stage"),
      notifyPortalNoteAdded: record("slack.note"),
      notifyPortalDncChange: record("slack.dnc"),
      notifyPortalDncBulkAdd: record("slack.dncBulk"),
      notifyPortalAgentChange: record("slack.agent"),
      notifyPortalTeamChange: record("slack.team"),
      notifyPortalIntroductionForThreads: record("slack.introThreads"),
    },
  });
  mock.module("../tools/master-inbox/webhooks/n8n-introduction", { namedExports: { notifyIntroduction: record("introduction"), notifyIntroductionForThreads: record("introductionThreads") } });
  mock.module("../tools/master-inbox/integrations/push-pipeline-entry", {
    namedExports: {
      pushPipelineEntryToFub: async (...args: unknown[]) => {
        sent.push({ what: "fub.push", args });
        return fubOutcome;
      },
      pushIntroPipelineEntriesForThreadsToFub: record("fub.pushThreads"),
    },
  });
  const realFub = await import("../tools/master-inbox/integrations/followup-boss.ts");
  mock.module("../tools/master-inbox/integrations/followup-boss", {
    namedExports: {
      ...realFub,
      verifyApiKey: async (key: string) => {
        sent.push({ what: "fub.verify", args: [key] });
        return key === "good-fub-key" ? { ok: true, account: { name: "Eddy's FUB", email: null } } : { ok: false, status: 401, error: "Unauthorized" };
      },
    },
  });
  mock.module("../tools/master-inbox/portals/billing-hold", { namedExports: { portalBillingHold: async () => hold } });
  mock.module("../portal-usage/usage", { namedExports: { recordUse: record("usage"), alertMarketMove: record("moveAlert") } });
  const realMarket = await import("./demo-market.ts");
  mock.module("./demo-market", { namedExports: { ...realMarket, agentsByIds: async (ids: readonly string[]) => agentDb.filter((a) => ids.includes(a.id)) } });
  mock.module("./market", {
    namedExports: {
      marketContext: async () => ({ portal: PORTAL }),
      matchingIds: async (_ctx: unknown, _q: unknown, max: number) => ({ ids: matching.ids.slice(0, max), total: matching.total }),
    },
  });
  ({ runPortalAction } = await import("./portal-save.ts"));
}

const agent = (id: string, full_name: string, emails: [string | null, string | null], phone: string | null = null): AgentRow => ({
  id, full_name, preferred_email: emails[0], enriched_email: emails[1], preferred_phone: phone, brand: "KW", office_name: "KW Center City", title: "Salesperson",
  office_city: null, office_county: null, home_city: null, home_county: null, most_transacted_city: null, most_transacted_county: null,
  office_state: null, home_state: null, transacted_state: null, sales_volume: null, units: null, est_time_in_industry_months: null,
});

function seed(opts: { flags?: Record<string, unknown>; fubKey?: string | null; enabled?: boolean } = {}) {
  fake.reset();
  sent.length = 0;
  afters = [];
  hold = null;
  agentDb = [];
  matching = { ids: [], total: 0 };
  fubOutcome = { ok: true, mode: "created", personId: "p1" };
  const [client] = fake.seed("clients", [
    { slug: "brokerstaffer", name: "BrokerStaffer", portal_token: TOKEN, portal_enabled: opts.enabled ?? true, stage_label_overrides: { phone_screen: "First Call" }, feature_flags: opts.flags ?? {}, fub_api_key: opts.fubKey ?? null, fub_connected_at: null, ideal_agent_profile: {} },
    { slug: "other-client", name: "Other Client", portal_token: "other-token-not-real", portal_enabled: true, stage_label_overrides: {}, feature_flags: {}, fub_api_key: null, fub_connected_at: null, ideal_agent_profile: {} },
  ]);
  // The fake gives seeded rows random ids; the portal's own is fixed, as the real one is.
  client.id = PORTAL;
  fake.rows("clients")[1].id = OTHER;
  const [mineEntry, intro, theirsEntry] = fake.seed("client_pipeline_entries", [
    { client_id: PORTAL, stage: "phone_screen", lead_name: "Mine", lead_email: "mine@x.test", custom_fields_overrides: { "Sales Volume": "$5M", Keep: "yes" }, fub_pushed_at: null },
    { client_id: PORTAL, stage: "introduction", lead_name: "Already Introduced", lead_email: null, custom_fields_overrides: null, fub_pushed_at: null },
    { client_id: OTHER, stage: "phone_screen", lead_name: "Theirs", lead_email: "theirs@x.test", custom_fields_overrides: null, fub_pushed_at: null },
  ]);
  const [member, otherMember] = fake.seed("client_team_members", [
    { client_id: PORTAL, name: "Ryan", email: "ryan@brokerstaffer.com", active: true },
    { client_id: OTHER, name: "Angela", email: "angela@other.test", active: true },
  ]);
  const [myAgent, theirAgent] = fake.seed("client_agents", [
    { client_id: PORTAL, name: "My Agent", email: "my.agent@x.test" },
    { client_id: OTHER, name: "Their Agent", email: "their.agent@x.test" },
  ]);
  const [myCompany, theirDnc] = fake.seed("client_dnc_entries", [
    { client_id: PORTAL, kind: "company", name: "Big Co", email: "keep@bigco.test", phone: "555-0100", domain: "bigco.test", notes: null, dedup_key: "bigco.test" },
    { client_id: OTHER, kind: "agent", name: "Their DNC", email: "their.dnc@x.test", domain: null, dedup_key: "their.dnc@x.test" },
  ]);
  for (const t of ["client_pipeline_notes", "client_pipeline_stages", "os_portal_offers", "os_demo_prospects"]) fake.seed(t, []);
  return { mineEntry, intro, theirsEntry, member, otherMember, myAgent, theirAgent, myCompany, theirDnc };
}

const run = (action: unknown) => runPortalAction(PORTAL, action, "admin@outreachify.io");
/* What the handlers left for after the answer — Slack, the stop, the Introduction, Follow Up Boss. */
async function settle() {
  while (afters.length) {
    const now = afters;
    afters = [];
    for (const fn of now) await fn();
  }
  // The imports' blocklist pushes run on their own, after the answer, as in the current portal.
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}
const rowOf = (table: string, id: string) => fake.rows(table).find((r) => r.id === id);
const okResult = (r: DemoResult) => assert.equal(r.ok, true, r.ok ? "" : r.error);

/* --------------------------------------------------------- gates --- */

test("a switched-off portal, an unknown one and one held for an unpaid invoice change nothing", { skip }, async () => {
  seed({ enabled: false });
  let r = await run({ type: "agent.add", name: "X", email: "x@x.test" });
  assert.deepEqual(r, { ok: false, status: 404, error: "This portal isn't available right now. Please contact BrokerStaffer." });

  seed();
  r = await runPortalAction("22222222-2222-4222-8222-222222222222", { type: "agent.add", name: "X", email: "x@x.test" }, "a@b.test");
  assert.equal(r.ok, false);

  seed();
  hold = { amount: 500, invoiceUrl: null, since: "2026-10-01" };
  r = await run({ type: "dnc.add", kind: "agent", name: "X", email: "x@x.test" });
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /paused while an invoice is unpaid/);
  await settle();
  assert.equal(fake.calls.filter((c) => c.method !== "GET").length, 0);
  assert.deepEqual(sent, []);
});

test("an action it doesn't know is refused before the portal is read", { skip }, async () => {
  seed();
  const r = await run({ type: "clients.update", portal_token: null });
  assert.equal(r.ok, false);
  assert.equal(fake.calls.length, 0);
});

/* ------------------------------------------------------ pipeline --- */

test("Add agent: the current portal's add — an Introduction, announced, and pushed to Follow Up Boss when connected", { skip }, async () => {
  seed({ fubKey: "fub-key" });
  const r = await run({ type: "entry.add", lead_name: "New Lead", lead_email: "New@X.test", lead_phone: null, current_brokerage: "KW", agent_profile_url: null });
  okResult(r);
  const row = rowOf("client_pipeline_entries", (r as { id: string }).id)!;
  assert.equal(row.client_id, PORTAL);
  assert.equal(row.stage, "introduction");
  assert.equal(row.lead_name, "New Lead");
  assert.equal(row.source, undefined, "no source without pipeline_source_split — the column default (BrokerStaffer)");
  await settle();
  assert.deepEqual(sentOf("introduction").map((s) => s.args), [[[row.id], "portal_add_lead"]]);
  assert.deepEqual(sentOf("fub.push").map((s) => s.args), [[PORTAL, row.id]]);
});

test("Stage moves: one agent by its own save, several at once; announced only when they change", { skip }, async () => {
  const s = seed();
  okResult(await run({ type: "entry.stage", ids: [s.mineEntry.id], stage: "interview" }));
  assert.equal(rowOf("client_pipeline_entries", s.mineEntry.id)!.stage, "interview");
  await settle();
  assert.equal(sentOf("slack.stage").length, 1);
  assert.deepEqual((sentOf("slack.stage")[0].args[0] as { fromStage: string; toStage: string }), { clientId: PORTAL, entryId: s.mineEntry.id, fromStage: "phone_screen", toStage: "interview" });
  assert.equal(sentOf("introduction").length, 0);

  // Several, one of them another client's: only this portal's move; the one already in Introduction is not announced again.
  sent.length = 0;
  okResult(await run({ type: "entry.stage", ids: [s.mineEntry.id, s.intro.id, s.theirsEntry.id], stage: "introduction" }));
  assert.equal(rowOf("client_pipeline_entries", s.theirsEntry.id)!.stage, "phone_screen");
  await settle();
  assert.deepEqual(sentOf("introduction").map((x) => x.args), [[[s.mineEntry.id], "portal_stage_change"]]);
  assert.equal(sentOf("slack.stage").length, 1);
});

test("Assign: only to someone on this portal's team", { skip }, async () => {
  const s = seed();
  const r = await run({ type: "entry.assign", ids: [s.mineEntry.id], member: s.otherMember.id });
  assert.deepEqual(r, { ok: false, status: 404, error: "That team member is not on this portal." });
  okResult(await run({ type: "entry.assign", ids: [s.mineEntry.id, s.intro.id], member: s.member.id }));
  assert.equal(rowOf("client_pipeline_entries", s.mineEntry.id)!.assigned_team_member_id, s.member.id);
  assert.equal(rowOf("client_pipeline_entries", s.intro.id)!.assigned_team_member_id, s.member.id);
  okResult(await run({ type: "entry.assign", ids: [s.mineEntry.id], member: null }));
  assert.equal(rowOf("client_pipeline_entries", s.mineEntry.id)!.assigned_team_member_id, null);
});

test("Edit and custom fields: merged into the client's own values; a cleared field comes off", { skip }, async () => {
  const s = seed();
  okResult(await run({ type: "entry.edit", id: s.mineEntry.id, lead_name: "Renamed", lead_email: "", lead_phone: "555", current_brokerage: null, agent_profile_url: null }));
  const row = rowOf("client_pipeline_entries", s.mineEntry.id)!;
  assert.equal(row.lead_name, "Renamed");
  assert.equal(row.lead_email, null);
  assert.equal(row.stage, "phone_screen");
  okResult(await run({ type: "entry.fields", id: s.mineEntry.id, fields: { "Sales Volume": "$9M", Keep: null, Added: "new" } }));
  assert.deepEqual(rowOf("client_pipeline_entries", s.mineEntry.id)!.custom_fields_overrides, { "Sales Volume": "$9M", Added: "new" });
  // An edit never re-announces (the OS's fix to the current portal: only a MOVE into Introduction does).
  okResult(await run({ type: "entry.edit", id: s.intro.id, lead_name: "Still Introduced", lead_email: null, lead_phone: null, current_brokerage: null, agent_profile_url: null }));
  await settle();
  assert.equal(sentOf("introduction").length, 0);
  // Another client's entry: not found, unchanged.
  const r = await run({ type: "entry.edit", id: s.theirsEntry.id, lead_name: "Hijack", lead_email: null, lead_phone: null, current_brokerage: null, agent_profile_url: null });
  assert.equal(r.ok, false);
  assert.equal(rowOf("client_pipeline_entries", s.theirsEntry.id)!.lead_name, "Theirs");
});

test("Custom stages are the manage_stages flag's — refused (not silently 'saved') without it", { skip }, async () => {
  const s = seed();
  const r = await run({ type: "entry.customStage", ids: [s.mineEntry.id], key: "phone_screen_no_show" });
  assert.deepEqual(r, { ok: false, status: 400, error: "Custom stages aren't turned on for your portal." });
  assert.equal(fake.writes("client_pipeline_entries", "PATCH").length, 0);
});

test("Delete: one or several, this portal's only", { skip }, async () => {
  const s = seed();
  okResult(await run({ type: "entry.delete", ids: [s.mineEntry.id] }));
  assert.equal(rowOf("client_pipeline_entries", s.mineEntry.id), undefined);
  okResult(await run({ type: "entry.delete", ids: [s.intro.id, s.theirsEntry.id] }));
  assert.equal(rowOf("client_pipeline_entries", s.intro.id), undefined);
  assert.ok(rowOf("client_pipeline_entries", s.theirsEntry.id));
});

test("Notes: on this portal's agents only, posted to Slack as the current portal does", { skip }, async () => {
  const s = seed();
  const r = await run({ type: "note.add", entry: s.mineEntry.id, body: "Called — interested." });
  okResult(r);
  assert.equal(fake.rows("client_pipeline_notes").length, 1);
  assert.equal(fake.rows("client_pipeline_notes")[0].entry_id, s.mineEntry.id);
  const bad = await run({ type: "note.add", entry: s.theirsEntry.id, body: "x" });
  assert.deepEqual(bad, { ok: false, status: 404, error: "That agent is not on this portal." });
  assert.equal(fake.rows("client_pipeline_notes").length, 1);
  await settle();
  assert.equal(sentOf("slack.note").length, 1);
});

/* ----------------------------------------------------- My Agents --- */

test("My Agents: an added email is blocked and posted; one removal is posted, several are not", { skip }, async () => {
  const s = seed();
  const r = await run({ type: "agent.add", name: "New Agent", email: "New.Agent@X.test", phone: null, license: null });
  okResult(r);
  const row = rowOf("client_agents", (r as { id: string }).id)!;
  assert.equal(row.client_id, PORTAL);
  assert.equal(row.pushed_to_instantly, true);
  assert.deepEqual(sentOf("blockEmail").map((x) => x.args[0]), ["new.agent@x.test"]);
  await settle();
  assert.equal((sentOf("slack.agent")[0].args[0] as { op: string }).op, "added");

  sent.length = 0;
  okResult(await run({ type: "agent.delete", ids: [s.myAgent.id] }));
  await settle();
  assert.equal((sentOf("slack.agent")[0].args[0] as { op: string }).op, "removed");

  sent.length = 0;
  okResult(await run({ type: "agent.delete", ids: [row.id as string, s.theirAgent.id] }));
  await settle();
  assert.equal(sentOf("slack.agent").length, 0);
  assert.ok(rowOf("client_agents", s.theirAgent.id), "another client's agent stays");
});

/* ------------------------------------------------------ DNC List --- */

test("DNC: an agent is blocked, stopped and posted; a company blocks its domain; a bad domain is refused", { skip }, async () => {
  const s = seed();
  okResult(await run({ type: "dnc.add", kind: "agent", name: "Do Not", email: "do.not@x.test", phone: null, brokerage: "RE/MAX", domain: null, notes: null }));
  await settle();
  assert.deepEqual(sentOf("blockEmail").map((x) => x.args[0]), ["do.not@x.test"]);
  assert.deepEqual(sentOf("stop").map((x) => x.args[0]), [[{ email: "do.not@x.test", name: "Do Not" }]]);
  assert.equal(sentOf("slack.dnc").length, 1);
  assert.equal(fake.rows("client_dnc_entries").at(-1)!.added_by, "client");

  sent.length = 0;
  const bad = await run({ type: "dnc.add", kind: "company", name: "Nowhere", email: null, phone: null, brokerage: null, domain: "not a domain", notes: null });
  assert.equal(bad.ok, false);
  okResult(await run({ type: "dnc.add", kind: "company", name: "Compass", email: null, phone: null, brokerage: null, domain: "https://www.Compass.com/agents", notes: null }));
  assert.deepEqual(sentOf("blockDomain").map((x) => x.args[0]), ["compass.com"]);

  // A company's edit: name, domain and notes — its email and phone stay as they are.
  okResult(await run({ type: "dnc.edit", id: s.myCompany.id, name: "Big Co Inc", email: null, phone: null, brokerage: null, domain: "bigco.test", notes: "edited" }));
  const co = rowOf("client_dnc_entries", s.myCompany.id)!;
  assert.equal(co.name, "Big Co Inc");
  assert.equal(co.email, "keep@bigco.test");
  assert.equal(co.phone, "555-0100");
  assert.equal(co.notes, "edited");
  // Another client's entry: not found.
  const theirs = await run({ type: "dnc.edit", id: s.theirDnc.id, name: "X", email: null, phone: null, brokerage: null, domain: null, notes: null });
  assert.deepEqual(theirs, { ok: false, status: 404, error: "That entry is not on this portal." });
});

/* ---------------------------------------------------------- Team --- */

test("Team: add, the exact repeat refused, edit, off and on, delete — posted as the current portal posts", { skip }, async () => {
  const s = seed();
  const r = await run({ type: "team.add", name: "Amy", email: "amy@brokerstaffer.com", title: "Manager", phone: null });
  okResult(r);
  const again = await run({ type: "team.add", name: "Amy", email: "amy@brokerstaffer.com", title: null, phone: null });
  assert.deepEqual(again, { ok: false, status: 409, error: "This person is already on the team." });
  okResult(await run({ type: "team.edit", id: s.member.id, name: "Ryan B", email: "ryan@brokerstaffer.com", title: "Owner", phone: null }));
  assert.equal(rowOf("client_team_members", s.member.id)!.title, "Owner");
  okResult(await run({ type: "team.active", id: s.member.id, active: false }));
  assert.equal(rowOf("client_team_members", s.member.id)!.active, false);
  const theirs = await run({ type: "team.active", id: s.otherMember.id, active: false });
  assert.equal(theirs.ok, false);
  assert.equal(rowOf("client_team_members", s.otherMember.id)!.active, true);
  okResult(await run({ type: "team.delete", ids: [s.member.id] }));
  await settle();
  assert.deepEqual(sentOf("slack.team").map((x) => (x.args[0] as { op: string }).op), ["added", "removed"]);
});

/* ------------------------------------------------------- imports --- */

test("Imports: a row the current import would refuse is skipped and named; the rest go through it, side effects and all", { skip }, async () => {
  seed();
  let r = await run({ type: "agent.import", rows: [{ name: "A One", email: "a1@x.test" }, { name: "Bad", email: "not-an-email" }, null, { name: "Dup", email: "my.agent@x.test" }], lines: [2, 3, 5, 6] });
  okResult(r);
  assert.equal((r as { message: string }).message, 'Imported 1 agent. 1 duplicate skipped. 2 rows skipped — row 3: "not-an-email" is not a valid email; row 5: no name.');
  await settle();
  assert.deepEqual(sentOf("blockEmail").map((x) => x.args[0]), ["a1@x.test"]);

  sent.length = 0;
  r = await run({ type: "dnc.import", rows: [{ kind: "company", name: "Co", domain: "co.test" }, { kind: "agent", name: "Person", email: "p@x.test" }] });
  okResult(r);
  await settle();
  assert.equal(sentOf("slack.dncBulk").length, 1);
  assert.deepEqual(sentOf("blockDomain").map((x) => x.args[0]), ["co.test"]);
  assert.deepEqual(sentOf("stop").map((x) => x.args[0]), [[{ email: "p@x.test", name: "Person" }]]);

  sent.length = 0;
  r = await run({ type: "team.import", rows: [{ name: "T One", email: "t1@x.test" }, { name: "No Email" }] });
  okResult(r);
  assert.match((r as { message: string }).message, /^Imported 1 team member\. 1 row skipped/);
});

test("Pipeline import: the pipeline_csv_upload flag's; stages by key or this portal's own names; Introductions announced", { skip }, async () => {
  seed();
  let r = await run({ type: "entry.import", rows: [{ lead_name: "X" }] });
  assert.deepEqual(r, { ok: false, status: 400, error: "Importing a file into the pipeline isn't turned on for your portal. Please contact BrokerStaffer." });

  seed({ flags: { pipeline_csv_upload: true }, fubKey: "fub-key" });
  r = await run({ type: "entry.import", rows: [
    { lead_name: "Intro One", lead_email: "i1@x.test" },
    { lead_name: "Called", stage: "First Call" },
    { lead_name: "Keyed", stage: "interview_scheduled", introduced_at: "2026-09-01" },
    { lead_name: "Nope", stage: "Somewhere Else" },
    { lead_name: "Excel", introduced_at: "45212" },
  ], lines: [2, 3, 4, 5, 6] });
  okResult(r);
  assert.equal((r as { message: string }).message, 'Imported 3 agents. 2 rows skipped — row 5: "Somewhere Else" is not one of your pipeline stages; row 6: "45212" is not a date (use a date like 2026-10-01).');
  const rows = fake.rows("client_pipeline_entries").filter((x) => ["Intro One", "Called", "Keyed"].includes(String(x.lead_name)));
  assert.deepEqual(rows.map((x) => [x.lead_name, x.stage, x.client_id]), [["Intro One", "introduction", PORTAL], ["Called", "phone_screen", PORTAL], ["Keyed", "interview_scheduled", PORTAL]]);
  await settle();
  const introId = rows[0].id;
  assert.deepEqual(sentOf("introduction").map((x) => x.args), [[[introId], "portal_csv_upload"]]);
  assert.deepEqual(sentOf("fub.push").map((x) => x.args), [[PORTAL, introId]]);
});

/* ------------------------------------------------ Follow Up Boss --- */

test("Follow Up Boss: the key is checked with Follow Up Boss first; a rejected one is said so; disconnect clears it", { skip }, async () => {
  seed();
  const bad = await run({ type: "fub.connect", api_key: "wrong-fub-key" });
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.error, /rejected by Follow Up Boss/);
  assert.equal(fake.rows("clients")[0].fub_api_key, null);
  const r = await run({ type: "fub.connect", api_key: "good-fub-key" });
  assert.deepEqual(r, { ok: true, message: "Connected to Follow Up Boss (Eddy's FUB)." });
  assert.equal(fake.rows("clients")[0].fub_api_key, "good-fub-key");
  assert.equal(fake.rows("clients")[1].fub_api_key, null, "another client's key stays");
  // Only those columns of the client's row (portal_token, portal_enabled, slug are what every live portal resolves by).
  for (const w of fake.writes("clients", "PATCH")) assert.deepEqual(Object.keys(w.body as object).sort(), ["fub_api_key", "fub_connected_at", "updated_at"]);
  okResult(await run({ type: "fub.disconnect" }));
  assert.equal(fake.rows("clients")[0].fub_api_key, null);
  assert.equal(fake.rows("clients")[0].portal_token, TOKEN);
});

/* --------------------------------------------- the Setup wizard's offer --- */

test("The offer: this portal's row, with who saved it — nothing outside", { skip }, async () => {
  seed();
  okResult(await run({ type: "offer.save", offers: ["Competitive commission split"], why_join: "Great culture", never_say: null }));
  const [row] = fake.rows("os_portal_offers");
  assert.equal(row.portal_id, PORTAL);
  assert.equal(row.updated_by, "admin@outreachify.io");
  await settle();
  assert.deepEqual(sent, []);
});

/* ------------------------------------------------ Market's Move to --- */

test("Market → DNC List: saved by name and brokerage — never the database email or phone; each email blocked and stopped; one Slack post; counted as Market use", { skip }, async () => {
  seed();
  agentDb = [agent("a1", "Jane Agent", ["jane@kw.test", "jane.alt@gmail.test"], "215-555-0101"), agent("a2", "Joe Agent", [null, null])];
  const r = await run({ type: "market.move", ids: ["a1", "a2"], to: "DNC List" });
  assert.deepEqual(r, { ok: true, message: "2 agents moved to DNC List." });
  const added = fake.rows("client_dnc_entries").filter((x) => x.notes === "From Market");
  assert.deepEqual(added.map((x) => [x.client_id, x.kind, x.name, x.email, x.phone, x.brokerage, x.added_by]), [[PORTAL, "agent", "Jane Agent", null, null, "KW", "client"], [PORTAL, "agent", "Joe Agent", null, null, "KW", "client"]]);
  await settle();
  assert.deepEqual(sentOf("slack.dncBulk").map((x) => x.args[0]), [{ clientId: PORTAL, entries: [{ name: "Jane Agent", handle: null }, { name: "Joe Agent", handle: null }] }]);
  assert.deepEqual(sentOf("usage").map((x) => { const u = x.args[1] as Record<string, unknown>; return [u.who, u.role, u.portalId, u.kind, u.rows]; }), [["admin@outreachify.io", "client", PORTAL, "market", 2]]);
  // Our team hears of every move onto a list (the user, 28 Oct).
  assert.deepEqual(sentOf("moveAlert").map((x) => { const u = x.args[1] as Record<string, unknown>; return [u.who, u.portalId, u.to, u.agents]; }), [["admin@outreachify.io", PORTAL, "DNC List", 2]]);
  // The preferred address only (the user, 28 Oct) — never the enriched guess.
  assert.deepEqual(sentOf("blockEmail").map((x) => x.args[0]), ["jane@kw.test"]);
  assert.deepEqual(sentOf("stop").map((x) => x.args[0]), [[{ email: "jane@kw.test", name: "Jane Agent" }]]);
  // …and kept apart, against its entry, where the reply agent and the relay look (0044) — never on the list.
  const jane = added.find((x) => x.name === "Jane Agent")!;
  assert.deepEqual(fake.rows("os_market_dnc_emails").map((x) => [x.entry_id, x.client_id, x.email, x.added_by]), [[jane.id, PORTAL, "jane@kw.test", "admin@outreachify.io"]]);
  assert.equal(added[0].pushed_to_emailbison, true);
  // Nobody's email or phone in any post.
  assert.doesNotMatch(JSON.stringify(sentOf("slack.dncBulk")), /@|555/);
});

test("Market → My Agents takes them off the DNC List (by name where it has no email) and blocks their emails; no Slack", { skip }, async () => {
  seed();
  agentDb = [agent("a1", "Jane Agent", ["jane@kw.test", null])];
  fake.seed("client_dnc_entries", [{ client_id: PORTAL, kind: "agent", name: "Jane Agent", email: null, notes: "From Market" }, { client_id: OTHER, kind: "agent", name: "Jane Agent", email: null }]);
  okResult(await run({ type: "market.move", ids: ["a1"], to: "My Agents" }));
  assert.deepEqual(fake.rows("client_dnc_entries").map((x) => x.client_id), [OTHER]);
  const mine = fake.rows("client_agents").filter((x) => x.client_id === PORTAL);
  assert.deepEqual(mine.map((x) => [x.name, x.email, x.notes]), [["My Agent", "my.agent@x.test", undefined], ["Jane Agent", null, "From Market"]]);
  await settle();
  assert.deepEqual(sentOf("blockEmail").map((x) => x.args[0]), ["jane@kw.test"]);
  assert.equal(sent.filter((x) => x.what.startsWith("slack")).length, 0);
  assert.equal(sentOf("stop").length, 0);
});

test("Market: to Prospects only lists the agent — no block, no campaign, nothing sent; anyone on a list stays there", { skip }, async () => {
  seed();
  agentDb = [agent("a1", "My Agent", ["my.agent@x.test", null]), agent("a2", "New Prospect", ["new.prospect@x.test", null]), agent("a3", "Big Co Agent", ["sam@bigco.test", null])];
  const r = await run({ type: "market.move", ids: ["a1", "a2", "a3"], to: "Prospects" });
  okResult(r);
  assert.match(r.ok ? r.message ?? "" : "", /^New Prospect moved to Prospects\. 2 on My Agents, your DNC List or your pipeline stayed there\.$/);
  const mine = () => fake.rows("os_demo_prospects").filter((x) => x.portal_id === PORTAL).map((x) => x.agent_id);
  assert.deepEqual(mine(), ["a2"], "only the agent on no list; My Agent and the DNC'd company's agent stay where they are");
  assert.equal(fake.rows("client_agents").filter((x) => x.client_id === PORTAL).length, 1, "My Agents untouched");
  assert.equal(fake.rows("client_dnc_entries").filter((x) => x.client_id === PORTAL).length, 1, "the DNC List untouched");
  // Again: already there, not added twice.
  okResult(await run({ type: "market.move", ids: ["a2"], to: "Prospects" }));
  assert.deepEqual(mine(), ["a2"]);
  await settle();
  assert.deepEqual(sent.map((x) => x.what), ["usage", "usage"], "nothing blocked, stopped, posted or alerted — only counted as Market use");
  // Moved on to another list, or off every list: off Prospects too. Another portal's prospects are never touched.
  // (seed replaces the whole table, so this portal's rows are seeded with the other's.)
  const both = (ids: string[]) => fake.seed("os_demo_prospects", [...ids.map((id) => ({ portal_id: PORTAL, agent_id: id, added_by: "x" })), { portal_id: OTHER, agent_id: "a2", added_by: "someone" }, { portal_id: OTHER, agent_id: "a4", added_by: "someone" }]);
  both(["a2", "a4"]);
  assert.deepEqual(mine().sort(), ["a2", "a4"]);
  okResult(await run({ type: "market.move", ids: ["a2"], to: "Not on a list" }));
  assert.deepEqual(mine(), ["a4"], "only the agent moved");
  agentDb.push(agent("a4", "Fourth Agent", ["fourth@x.test", null]));
  okResult(await run({ type: "market.move", ids: ["a4"], to: "My Agents" }));
  assert.deepEqual(mine(), [], "on to My Agents: off Prospects");
  assert.equal(fake.rows("client_agents").filter((x) => x.client_id === PORTAL && x.name === "Fourth Agent").length, 1);
  assert.equal(fake.rows("os_demo_prospects").filter((x) => x.portal_id === OTHER).length, 2, "the other portal's prospects untouched");
});

test("Market: at most 500 a move; Not on a list only takes off", { skip }, async () => {
  seed();
  agentDb = [agent("a1", "My Agent", ["my.agent@x.test", null])];
  let r = await run({ type: "market.move", ids: Array.from({ length: 501 }, (_, i) => `a${i}`), to: "DNC List" });
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /500 or fewer/);
  matching = { ids: ["a1"], total: 501 };
  r = await run({ type: "market.moveAll", list: "market", query: "", to: "My Agents" });
  assert.match(r.ok ? "" : r.error, /narrow the filters to 500 or fewer/);
  okResult(await run({ type: "market.move", ids: ["a1"], to: "Not on a list" }));
  assert.equal(fake.rows("client_agents").filter((x) => x.client_id === PORTAL).length, 0);
  assert.equal(fake.rows("client_agents").filter((x) => x.client_id === OTHER).length, 1);
  await settle();
  assert.deepEqual(sent.filter((x) => x.what !== "usage").map((x) => x.what), [], "taking off sends nothing outside, and alerts no one (only counted as Market use)");
});

/* ------------------------------------------------ never another client --- */

test("Nothing here ever writes another client's rows", { skip }, async () => {
  const s = seed();
  const before = JSON.stringify(["client_pipeline_entries", "client_agents", "client_dnc_entries", "client_team_members"].map((t) => fake.rows(t).filter((x) => x.client_id === OTHER)));
  for (const a of [
    { type: "entry.stage", ids: [s.theirsEntry.id], stage: "hired" },
    { type: "entry.delete", ids: [s.theirsEntry.id, s.mineEntry.id] },
    { type: "agent.delete", ids: [s.theirAgent.id] },
    { type: "dnc.delete", ids: [s.theirDnc.id] },
    { type: "team.delete", ids: [s.otherMember.id] },
    { type: "agent.edit", id: s.theirAgent.id, name: "X", email: null, phone: null, license: null },
  ]) await run(a);
  await settle();
  const after = JSON.stringify(["client_pipeline_entries", "client_agents", "client_dnc_entries", "client_team_members"].map((t) => fake.rows(t).filter((x) => x.client_id === OTHER)));
  assert.equal(after, before);
});

/* ------------------------------------------- the current portal's extras (28 Oct) --- */

test("Add and Edit: the chosen day at noon UTC, the replacement mark, a Client Entry with the source split; an edit re-sends neither unless changed", { skip }, async () => {
  const s = seed({ flags: { pipeline_source_split: true } });
  const r = await run({ type: "entry.add", lead_name: "Dana", introduced_at: "2026-09-15", needs_replacement: true });
  okResult(r);
  const row = rowOf("client_pipeline_entries", (r as { id: string }).id)!;
  assert.deepEqual([row.introduced_at, row.needs_replacement, row.source], ["2026-09-15T12:00:00.000Z", true, "Client Entry"]);
  const before = rowOf("client_pipeline_entries", s.mineEntry.id)!.introduced_at;
  okResult(await run({ type: "entry.edit", id: s.mineEntry.id, lead_name: "Mine", lead_email: "mine@x.test", lead_phone: null, current_brokerage: null, agent_profile_url: null, needs_replacement: true }));
  const edited = rowOf("client_pipeline_entries", s.mineEntry.id)!;
  assert.equal(edited.introduced_at, before);
  assert.equal(edited.needs_replacement, true);
  const body = fake.writes("client_pipeline_entries", "PATCH").at(-1)!.body as Record<string, unknown>;
  assert.equal("introduced_at" in body, false, "the date is not re-sent");
});

test("Custom fields: a blank value blanks the campaign's field; null takes the client's own off", { skip }, async () => {
  const s = seed();
  okResult(await run({ type: "entry.fields", id: s.mineEntry.id, fields: { "Sales Volume": "", Keep: null } }));
  assert.deepEqual(rowOf("client_pipeline_entries", s.mineEntry.id)!.custom_fields_overrides, { "Sales Volume": "" });
});

test("A bulk move takes this portal's agents out of a custom stage (Manage stages), as a single move does", { skip }, async () => {
  const s = seed({ flags: { manage_stages: true } });
  rowOf("client_pipeline_entries", s.mineEntry.id)!.custom_stage_key = "custom_abc12345";
  rowOf("client_pipeline_entries", s.theirsEntry.id)!.custom_stage_key = "custom_theirs01";
  okResult(await run({ type: "entry.stage", ids: [s.mineEntry.id, s.intro.id, s.theirsEntry.id], stage: "interview" }));
  assert.equal(rowOf("client_pipeline_entries", s.mineEntry.id)!.custom_stage_key, null);
  assert.equal(rowOf("client_pipeline_entries", s.mineEntry.id)!.stage, "interview");
  assert.equal(rowOf("client_pipeline_entries", s.theirsEntry.id)!.custom_stage_key, "custom_theirs01", "another client's is untouched");
  assert.equal(rowOf("client_pipeline_entries", s.theirsEntry.id)!.stage, "phone_screen");
});

test("Notes: edited and deleted through the current portal's own route — on this portal's agents only", { skip }, async () => {
  const s = seed();
  // The route checks the note's agent belongs to the portal by the database's join; the fake carries that join on the row.
  const [mine, theirs] = fake.seed("client_pipeline_notes", [
    { entry_id: s.mineEntry.id, body: "first", client_pipeline_entries: { client_id: PORTAL } },
    { entry_id: s.theirsEntry.id, body: "theirs", client_pipeline_entries: { client_id: OTHER } },
  ]);
  okResult(await run({ type: "note.edit", entry: s.mineEntry.id, note: mine.id, body: "second" }));
  assert.equal(rowOf("client_pipeline_notes", mine.id)!.body, "second");
  assert.deepEqual(await run({ type: "note.edit", entry: s.theirsEntry.id, note: theirs.id, body: "x" }), { ok: false, status: 404, error: "That note is no longer there." });
  assert.deepEqual(await run({ type: "note.delete", entry: s.mineEntry.id, note: theirs.id }), { ok: false, status: 404, error: "That note is no longer there." });
  assert.equal(rowOf("client_pipeline_notes", theirs.id)!.body, "theirs");
  okResult(await run({ type: "note.delete", entry: s.mineEntry.id, note: mine.id }));
  assert.equal(rowOf("client_pipeline_notes", mine.id), undefined);
});

test("Push to Follow Up Boss: the current portal's push, its own words either way", { skip }, async () => {
  const s = seed({ fubKey: "fub-key" });
  assert.deepEqual(await run({ type: "entry.push", id: s.mineEntry.id }), { ok: true, message: "Sent to Follow Up Boss." });
  assert.deepEqual(sentOf("fub.push").map((x) => x.args), [[PORTAL, s.mineEntry.id]]);
  fubOutcome = { ok: true, mode: "updated", personId: "p1" };
  assert.deepEqual(await run({ type: "entry.push", id: s.mineEntry.id }), { ok: true, message: "Updated in Follow Up Boss." });
  fubOutcome = { ok: false, reason: "no_contact", message: "Lead has no email or phone — nothing to push to Follow Up Boss" };
  assert.deepEqual(await run({ type: "entry.push", id: s.intro.id }), { ok: false, status: 400, error: "Lead has no email or phone — nothing to push to Follow Up Boss" });
});

test("Adds say what the current portal says", { skip }, async () => {
  seed();
  assert.equal(((await run({ type: "agent.add", name: "A", email: "a@x.test", phone: null, license: null })) as { message: string }).message, "Agent added");
  assert.equal(((await run({ type: "dnc.add", kind: "company", name: "C", email: null, phone: null, brokerage: null, domain: "c.test", notes: null })) as { message: string }).message, "Added · pushed to provider blocklists");
  assert.equal(((await run({ type: "dnc.add", kind: "agent", name: "D", email: null, phone: "555", brokerage: null, domain: null, notes: null })) as { message: string }).message, "Added");
});

test("Market (28 Oct audit): agents already on the list are blocked too; a client's own same-name entry is never taken off; added before anything is taken off", { skip }, async () => {
  seed();
  agentDb = [agent("a1", "Jane Agent", ["jane@kw.test", null]), agent("a2", "Sam Other", ["sam@kw.test", null])];
  // Jane is already on the DNC List by name (the client typed her, no email); Sam is on My Agents as a Market entry.
  fake.seed("client_dnc_entries", [{ client_id: PORTAL, kind: "agent", name: "Jane Agent", email: null, notes: null, dedup_key: "x1" }]);
  fake.seed("client_agents", [{ client_id: PORTAL, name: "Sam Other", email: null, notes: "From Market" }]);
  okResult(await run({ type: "market.move", ids: ["a1", "a2"], to: "DNC List" }));
  const dnc = fake.rows("client_dnc_entries").filter((x) => x.client_id === PORTAL);
  assert.deepEqual(dnc.map((x) => x.name).sort(), ["Jane Agent", "Sam Other"], "Jane not added twice; Sam added");
  assert.equal(fake.rows("client_agents").filter((x) => x.client_id === PORTAL).length, 0, "Sam's Market entry came off My Agents");
  await settle();
  assert.deepEqual(sentOf("blockEmail").map((x) => x.args[0]).sort(), ["jane@kw.test", "sam@kw.test"], "both blocked — Jane too, though already listed");
  assert.deepEqual((sentOf("stop")[0].args[0] as Array<{ email: string }>).map((x) => x.email).sort(), ["jane@kw.test", "sam@kw.test"]);
  // A client's own name-only DNC entry for a different "Jane Agent" stays when Jane is taken off every list.
  sent.length = 0;
  okResult(await run({ type: "market.move", ids: ["a1"], to: "Not on a list" }));
  assert.ok(fake.rows("client_dnc_entries").some((x) => x.client_id === PORTAL && x.name === "Jane Agent" && x.notes === null), "the client's own entry stays");
  // Added first: when the add fails, nothing has been taken off.
  seed();
  agentDb = [agent("a2", "Sam Other", ["sam@kw.test", null])];
  fake.seed("client_agents", [{ client_id: PORTAL, name: "Sam Other", email: null, notes: "From Market" }]);
  fake.failWhen = ({ method, table }) => method === "POST" && table === "client_dnc_entries";
  const r = await run({ type: "market.move", ids: ["a2"], to: "DNC List" });
  assert.equal(r.ok, false);
  assert.equal(fake.rows("client_agents").filter((x) => x.client_id === PORTAL).length, 1, "still on My Agents");
  fake.failWhen = null;
});

test("Market → DNC: an agent already on the list by name gets its address kept against that entry; none twice; before migration 0044 the move still goes through", { skip }, async () => {
  seed();
  fake.seed("os_market_dnc_emails", []);
  agentDb = [agent("a1", "Jane Agent", ["jane@kw.test", "jane.alt@gmail.test"])];
  const [typed] = fake.seed("client_dnc_entries", [{ client_id: PORTAL, kind: "agent", name: "Jane Agent", email: null, notes: null, dedup_key: "t1" }]);
  okResult(await run({ type: "market.move", ids: ["a1"], to: "DNC List" }));
  okResult(await run({ type: "market.move", ids: ["a1"], to: "DNC List" }));
  assert.deepEqual(fake.rows("os_market_dnc_emails").map((x) => [x.entry_id, x.email]), [[typed.id, "jane@kw.test"]]);
  assert.equal(fake.rows("client_dnc_entries").filter((x) => x.client_id === PORTAL).length, 1, "not added twice");
  // The table not there yet: still moved, blocked and stopped.
  seed();
  fake.missingTables.add("os_market_dnc_emails");
  agentDb = [agent("a1", "Jane Agent", ["jane@kw.test", null])];
  okResult(await run({ type: "market.move", ids: ["a1"], to: "DNC List" }));
  await settle();
  assert.deepEqual(sentOf("blockEmail").map((x) => x.args[0]), ["jane@kw.test"]);
  assert.equal(sentOf("stop").length, 1);
});

test("Edits keep a stored address whose case alone differs — nothing blocked or stopped again (28 Oct audit)", { skip }, async () => {
  seed();
  const [row] = fake.seed("client_dnc_entries", [{ client_id: PORTAL, kind: "agent", name: "Jane", email: "Jane.Doe@Gmail.com", dedup_key: "jane.doe@gmail.com" }]);
  okResult(await run({ type: "dnc.edit", id: row.id, name: "Jane", email: "jane.doe@gmail.com", phone: null, brokerage: null, domain: null, notes: "only the notes" }));
  await settle();
  assert.equal(sentOf("blockEmail").length, 0);
  assert.equal(sentOf("stop").length, 0);
  assert.equal(rowOf("client_dnc_entries", row.id)!.email, "Jane.Doe@Gmail.com");
  assert.equal(rowOf("client_dnc_entries", row.id)!.notes, "only the notes");
  // A real change still blocks and stops, as the current portal.
  okResult(await run({ type: "dnc.edit", id: row.id, name: "Jane", email: "jane.new@x.test", phone: null, brokerage: null, domain: null, notes: null }));
  await settle();
  assert.deepEqual(sentOf("blockEmail").map((x) => x.args[0]), ["jane.new@x.test"]);
  assert.equal(sentOf("stop").length, 1);
});

/* ---------------------------------------------- the second audit (28 Oct) --- */

test("Market → DNC of 450 agents: the kept addresses are looked up 200 entries at a time, and every one is kept", { skip }, async () => {
  seed();
  fake.seed("os_market_dnc_emails", []);
  agentDb = Array.from({ length: 450 }, (_, i) => agent(`b${i}`, `Bulk Agent ${String(i).padStart(3, "0")}`, [`bulk${i}@kw.test`, null]));
  okResult(await run({ type: "market.move", ids: agentDb.map((x) => x.id), to: "DNC List" }));
  const lookups = fake.calls.filter((c) => c.table === "os_market_dnc_emails" && c.method === "GET").map((c) => (c.query.get("entry_id") ?? "").split(",").length);
  assert.ok(lookups.length >= 3 && lookups.every((n) => n <= 200), JSON.stringify(lookups));
  assert.equal(fake.rows("os_market_dnc_emails").length, 450);
  await settle();
  assert.equal(sentOf("blockEmail").length, 450);
});

test("Market: a step after the add failing still blocks, stops and posts — and says so; trying again finishes it", { skip }, async () => {
  seed();
  agentDb = [agent("a1", "Jane Agent", ["jane@kw.test", null])];
  fake.seed("client_agents", [{ client_id: PORTAL, name: "Jane Agent", email: null, notes: "From Market" }]);
  fake.failWhen = ({ method, table }) => method === "DELETE" && table === "client_agents";
  const r = await run({ type: "market.move", ids: ["a1"], to: "DNC List" });
  assert.deepEqual(r, { ok: false, status: 409, error: "Jane Agent is on DNC List now, but the rest didn't finish — please try again." });
  await settle();
  assert.deepEqual(sentOf("blockEmail").map((x) => x.args[0]), ["jane@kw.test"]);
  assert.equal(sentOf("stop").length, 1);
  assert.equal(sentOf("slack.dncBulk").length, 1);
  fake.failWhen = null;
  sent.length = 0;
  okResult(await run({ type: "market.move", ids: ["a1"], to: "DNC List" }));
  assert.equal(fake.rows("client_agents").filter((x) => x.client_id === PORTAL).length, 0, "off My Agents on the retry");
  assert.equal(fake.rows("client_dnc_entries").filter((x) => x.client_id === PORTAL && x.name === "Jane Agent").length, 1, "not added twice");
  await settle();
  assert.equal(sentOf("slack.dncBulk").length, 0, "nothing added on the retry, so no second post");
});

test("Market: the enriched (guessed) address never matches — a different person's own entry with that address stays", { skip }, async () => {
  seed();
  agentDb = [agent("a1", "Jane Agent", ["jane@kw.test", "shared@guess.test"])];
  // The client's own entry for someone else, whose real address is Jane's guessed one.
  fake.seed("client_agents", [{ client_id: PORTAL, name: "Other Person", email: "shared@guess.test", notes: null }]);
  okResult(await run({ type: "market.move", ids: ["a1"], to: "DNC List" }));
  assert.ok(fake.rows("client_agents").some((x) => x.client_id === PORTAL && x.email === "shared@guess.test"), "the other person's entry stays");
  await settle();
  assert.deepEqual(sentOf("blockEmail").map((x) => x.args[0]), ["jane@kw.test"]);
});

test("'Delete selected' is the current portal's bulk delete even for one row (no Slack); a row's own delete posts", { skip }, async () => {
  const s = seed();
  okResult(await run({ type: "agent.delete", ids: [s.myAgent.id], bulk: true }));
  await settle();
  assert.equal(sentOf("slack.agent").length, 0);
  const [another] = fake.seed("client_agents", [...fake.rows("client_agents"), { client_id: PORTAL, name: "Row Delete", email: "row@x.test" }]).slice(-1);
  okResult(await run({ type: "agent.delete", ids: [another.id] }));
  await settle();
  assert.equal((sentOf("slack.agent")[0]?.args[0] as { op: string } | undefined)?.op, "removed");
});

test("Staff on a real portal (29 Oct): the same save, in their own name — their Market use counted as staff's, never a client's", { skip }, async () => {
  seed();
  agentDb = [agent("a1", "Jane Agent", ["jane@kw.test", null])];
  okResult(await runPortalAction(PORTAL, { type: "market.move", ids: ["a1"], to: "My Agents" }, "eddy@brokerstaffer.com", "staff"));
  await settle();
  const u = sentOf("usage")[0]?.args[1] as Record<string, unknown> | undefined;
  assert.deepEqual([u?.who, u?.role, u?.kind, u?.rows], ["eddy@brokerstaffer.com", "staff", "market", 1]);
  assert.equal((sentOf("moveAlert")[0]?.args[1] as { who?: string } | undefined)?.who, "eddy@brokerstaffer.com", "the bell names who moved them");
  // Any other save: the current portal's own, exactly as the client's.
  okResult(await runPortalAction(PORTAL, { type: "agent.add", name: "Staff Added", email: "staff.added@x.test", phone: null, license: null }, "eddy@brokerstaffer.com", "staff"));
  assert.ok(fake.rows("client_agents").some((x) => x.client_id === PORTAL && x.name === "Staff Added"));
});
