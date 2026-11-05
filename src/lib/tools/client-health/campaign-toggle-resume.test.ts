/*
 * resumeListed and pauseListed: the lead cap's restart and pause. Unlike Play and Pause they never reach beyond the
 * list, and never touch a campaign that has since moved to another client. The real module, with the platforms and the
 * database faked.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const status = new Map<number, string>();
const calls: string[] = [];
const held: Array<{ platform: string; id: string; int_id: number; name: string; paused_at: string }> = [];
const updates: Array<{ table: string; patch: Record<string, unknown> }> = [];
let bisonLinked = ["a", "b"];
let others: Array<Record<string, unknown>> = [];

const table = (name: string) => {
  const b = {
    select: () => b,
    in: () => b,
    eq: () => b,
    neq: async () => ({ data: others, error: null }),
    maybeSingle: async () => ({
      data: { id: "ch1", name: "Homebase", instantly_campaign_ids: [], bison_campaign_ids: bisonLinked, toggle_paused_campaigns: held },
      error: null,
    }),
    update: (patch: Record<string, unknown>) => { updates.push({ table: name, patch }); return { eq: async () => ({ error: null }) }; },
    insert: async () => ({ error: null }),
    then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [{ id: "a", int_id: 1, name: "A" }, { id: "b", int_id: 2, name: "B" }].filter((c) => bisonLinked.includes(c.id)), error: null }).then(res),
  };
  return b;
};
mock.module("./supabase", { namedExports: { getSupabase: () => ({ from: table }) } });
mock.module("./sync/instantly", { namedExports: { activateCampaign: async () => {}, getCampaignStatus: async () => 1, pauseCampaign: async () => {} } });
mock.module("./sync/bison", {
  namedExports: {
    getBisonCampaignStatus: async (id: number) => status.get(id) ?? "paused",
    pauseBisonCampaign: async (id: number) => { calls.push(`pause ${id}`); status.set(id, "paused"); },
    resumeBisonCampaign: async (id: number) => { calls.push(`resume ${id}`); status.set(id, "active"); },
  },
});
const toggle = await import("./campaign-toggle");

const listed = [{ platform: "bison" as const, id: "a", int_id: 1, name: "A" }];
const reset = () => { status.clear(); calls.length = 0; updates.length = 0; held.length = 0; bisonLinked = ["a", "b"]; others = []; };

test("resume: only what is listed, even with another linked campaign paused: Play would have taken both", async () => {
  reset();
  status.set(1, "paused"); status.set(2, "paused");
  const r = await toggle.resumeListed("ch1", listed, "lead cap");
  assert.deepEqual(calls, ["resume 1"]);
  assert.deepEqual(r.outcomes.map((o) => [o.campaign.id, o.ok]), [["a", true]]);
  assert.equal(status.get(2), "paused");

  // Play, for comparison: nothing held, so every linked campaign that is paused.
  status.set(1, "paused"); calls.length = 0;
  await toggle.applyToggle("ch1", "resume", "a person");
  assert.deepEqual(calls.sort(), ["resume 1", "resume 2"]);
});

test("resume: a listed campaign that isn't paused now is left alone", async () => {
  for (const s of ["active", "completed", "draft"]) {
    reset();
    status.set(1, s);
    const r = await toggle.resumeListed("ch1", listed, "lead cap");
    assert.deepEqual(calls, [], s);
    assert.equal(r.outcomes.length, 0);
  }
});

test("resume: a campaign moved to another client since is never restarted from this client's list", async () => {
  reset();
  bisonLinked = ["b"];
  status.set(1, "paused");
  const r = await toggle.resumeListed("ch1", listed, "lead cap");
  assert.deepEqual(calls, []);
  assert.equal(r.outcomes.length, 0);
  assert.deepEqual(r.plan.skipped.map((x) => [x.campaign.id, x.reason]), [["a", "no longer linked to this client"]]);
});

test("pause: only what is listed and sending; a shared one left out of the list stays running", async () => {
  reset();
  status.set(1, "active"); status.set(2, "active");
  const r = await toggle.pauseListed("ch1", listed, "lead cap");
  assert.deepEqual(calls, ["pause 1"]);
  assert.deepEqual(r.outcomes.map((o) => o.campaign.id), ["a"]);
  assert.equal(status.get(2), "active");
  assert.deepEqual((r.held as Array<{ id: string }>).map((h) => h.id), ["a"], "recorded for Play, as the button's own pause is");
  assert.ok(updates.some((u) => u.table === "clients" && "toggle_paused_campaigns" in u.patch));
});

test("pause: one a person paused meanwhile isn't reported as this having paused it", async () => {
  reset();
  status.set(1, "paused");
  const r = await toggle.pauseListed("ch1", listed, "lead cap");
  assert.deepEqual(calls, []);
  assert.deepEqual(r.outcomes, []);
});

test("sharedWithOthers: names the other clients on a campaign, by platform, and only others", async () => {
  reset();
  others = [
    { id: "x", name: "Wagner Realty", instantly_campaign_ids: ["a"], bison_campaign_ids: ["a"] },
    { id: "y", name: "Elliman LA", instantly_campaign_ids: null, bison_campaign_ids: ["a", "z"] },
    { id: "w", name: "Unrelated", instantly_campaign_ids: ["b"], bison_campaign_ids: [] },
  ];
  const out = await toggle.sharedWithOthers("ch1", [{ platform: "bison", id: "a" }, { platform: "bison", id: "b" }, { platform: "instantly", id: "b" }]);
  assert.deepEqual([...out], [["bison:a", ["Wagner Realty", "Elliman LA"]], ["instantly:b", ["Unrelated"]]]);
});

test("liveCampaigns reads every linked campaign and changes nothing", async () => {
  reset();
  status.set(1, "active"); status.set(2, "paused");
  const all = await toggle.liveCampaigns("ch1");
  assert.deepEqual(all.map((c) => [c.id, c.status]), [["a", "active"], ["b", "paused"]]);
  assert.deepEqual(calls, []);
});

test("the button's own Pause is unchanged by all this: it pauses what is sending and records it", async () => {
  reset();
  status.set(1, "active"); status.set(2, "paused");
  const r = await toggle.applyToggle("ch1", "pause", "a person");
  assert.deepEqual(calls, ["pause 1"]);
  assert.deepEqual(r.outcomes.map((o) => o.campaign.id), ["a"]);
  assert.deepEqual((r.held as Array<{ id: string }>).map((h) => h.id), ["a"]);
  assert.ok(updates.some((u) => u.table === "clients" && "toggle_paused_campaigns" in u.patch));
});
