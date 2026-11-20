/*
 * The inbox health rules on every other way inboxes are copied onto a campaign (20 Nov, the team: "apply the same
 * inbox health requirements across all campaign operations"): Re-campaign and duplicating to other markets here (a new
 * client's first campaign: setup-campaign.test.ts). EmailBison, the database and the health check are fakes that
 * record what they were asked; nothing here can reach a real service.
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";

for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const attached: Array<{ campaign: number; ids: number[] }> = [];
let source = [1, 2, 3, 4];
let health: (ids: readonly number[]) => Promise<{ ids: number[]; leftOut: number; unchecked: boolean; note: string | null }>;
let nextId = 900;

mock.module("@/lib/tools/analytics/emailbison/client.ts", {
  namedExports: {
    createEmailBisonClient: () => ({
      duplicateCampaign: async () => ({ data: { id: ++nextId } }),
      updateCampaign: async () => ({ data: {} }),
      getCampaignSequenceSteps: async () => ({ data: { sequence_id: 1, sequence_steps: [] } }),
      getCampaignSenderEmails: async () => source.map((id) => ({ id })),
      attachSenderEmails: async (campaign: number, ids: number[]) => { attached.push({ campaign, ids }); return { data: {} }; },
      deleteCampaign: async () => ({}),
    }),
  },
});
const chain = (rows: unknown[]) => {
  const b: Record<string, unknown> = {};
  for (const k of ["select", "eq", "in", "order", "limit", "neq", "is"]) b[k] = () => b;
  b.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
  b.insert = async () => ({ error: null });
  b.upsert = async () => ({ error: null });
  b.update = () => b;
  b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(ok);
  return b;
};
mock.module("@/lib/tools/analytics/supabase", {
  namedExports: {
    analyticsTeamId: () => 7,
    getAnalyticsSupabase: () => ({
      from: (table: string) => chain(table === "clients" ? [{ id: "c1", name: "Carolina Realty Advisors" }, { id: "c2", name: "The Toll Group" }] : table === "campaigns" ? [{ name: "Source campaign" }] : []),
      rpc: async () => ({ data: [11, 12, 13], error: null }),
    }),
  },
});
mock.module("./attach-health-io.ts", { namedExports: { healthyOnly: (ids: readonly number[]) => health(ids) } });
mock.module("./lead-membership.ts", {
  namedExports: { attachLeads: async (_c: number, ids: number[]) => ({ applied: ids.length, skipped: 0 }), removeLeads: async () => ({ applied: 0 }) },
});
mock.module("./client-fields-load", {
  namedExports: { clientFieldValuesForClient: async () => ({}), fillCampaignSequence: async () => ({ steps: 1, filled: 0, missing: [] }) },
});

const { reCampaign } = await import("./re-campaign.ts");
const { fanOutToClients } = await import("./fan-out.ts");

const leaveOut = (bad: number[], why = "1 with a warm-up score under 90") => async (ids: readonly number[]) => {
  const healthy = ids.filter((id) => !bad.includes(id));
  return { ids: healthy, leftOut: ids.length - healthy.length, unchecked: false, note: ids.length - healthy.length ? `${ids.length - healthy.length} inbox left out by the health rules: ${why}.` : null };
};
const down = async (ids: readonly number[]) => ({ ids: [], leftOut: ids.length, unchecked: true, note: "No inboxes added: the check is down. Add them with Assign once it can." });

test("Re-campaign: only the source's healthy inboxes go on, and the result says what was left out", async () => {
  attached.length = 0; source = [1, 2, 3, 4]; health = leaveOut([3]);
  const r = await reCampaign(55, "LIV Indy Realty 8", { copyInboxes: true }, "person@example.com", 7);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(attached.map((a) => a.ids), [[1, 2, 4]], "inbox 3 never sent");
  assert.equal(r.inboxes, 3);
  assert.match(String(r.inboxNote), /1 inbox left out by the health rules/);
  assert.equal(r.leadsAttached, 3, "the leads still move");
});

test("Re-campaign: health that can't be read puts no inbox on, still moves the leads, and says to add them with Assign", async () => {
  attached.length = 0; health = down;
  const r = await reCampaign(55, "LIV Indy Realty 8", { copyInboxes: true }, "person@example.com", 7);
  assert.equal(r.ok, true);
  assert.deepEqual(attached, []);
  assert.equal(r.inboxes, 0);
  assert.match(String(r.inboxNote), /No inboxes added/);
  assert.equal(r.leadsAttached, 3);
});

test("Re-campaign without copying inboxes: the health check isn't even asked", async () => {
  attached.length = 0;
  let asked = false;
  health = async (ids) => { asked = true; return leaveOut([])(ids); };
  await reCampaign(55, "LIV Indy Realty 8", { copyInboxes: false }, "person@example.com", 7);
  assert.equal(asked, false);
  assert.deepEqual(attached, []);
});

test("Duplicate to other markets: judged once, every new campaign gets only the healthy inboxes, each row says what was left out", async () => {
  attached.length = 0; source = [1, 2, 3, 4];
  let asked = 0;
  health = async (ids) => { asked++; return leaveOut([2, 4], "2 with a bounce rate of 2% or more")(ids); };
  const s = await fanOutToClients(55, ["c1", "c2"], "{client} + Market", { copyInboxes: true }, "person@example.com", 7);
  assert.equal(asked, 1, "one check for the whole run");
  assert.equal(s.created, 2, JSON.stringify(s));
  assert.deepEqual(attached.map((a) => a.ids), [[1, 3], [1, 3]]);
  assert.ok(s.targets.every((t) => t.inboxes === 2 && /left out by the health rules/.test(String(t.note))), JSON.stringify(s.targets.map((t) => t.note)));
});

test("Duplicate to other markets: health unreadable — the campaigns are made with no inboxes, and each row says so", async () => {
  attached.length = 0; health = down;
  const s = await fanOutToClients(55, ["c1", "c2"], "{client} + Market", { copyInboxes: true }, "person@example.com", 7);
  assert.equal(s.created, 2);
  assert.deepEqual(attached, []);
  assert.ok(s.targets.every((t) => t.inboxes === 0 && /No inboxes added/.test(String(t.note))));
});
