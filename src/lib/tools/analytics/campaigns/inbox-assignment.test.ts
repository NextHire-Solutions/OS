/*
 * Assign (Campaigns page) and the inbox health rules (20 Nov — attach-health.ts): an attach sends only the healthy
 * inboxes of the ticked pools; a remove is never checked; without the check, no EmailBison campaign is given anything.
 * EmailBison and the database are fakes that record what they were asked.
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";

for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

/** Pools by tag: [connected ids, every id]. */
const pools = new Map<string, { connected: number[]; all: number[] }>([
  ["Nicole Pool", { connected: [1, 2, 3, 4], all: [1, 2, 3, 4, 9] }],
  ["Zapmail", { connected: [3, 5], all: [3, 5] }],
]);
const attached: Array<{ campaign: number; ids: number[] }> = [];
const removed: Array<{ campaign: number; ids: number[] }> = [];
const audit: Array<Record<string, unknown>> = [];
const onCampaign = new Map<number, Set<number>>();

mock.module("@/lib/tools/analytics/supabase", {
  namedExports: {
    analyticsTeamId: () => 7,
    getAnalyticsSupabase: () => ({
      rpc: async (fn: string, args: { p_tag: string; p_connected_only: boolean }) => {
        if (fn !== "sender_ids_by_tag") return { data: [], error: null };
        const p = pools.get(args.p_tag);
        return { data: p ? (args.p_connected_only ? p.connected : p.all) : [], error: null };
      },
      from: (table: string) => {
        const b = {
          select: () => b, eq: () => b,
          in: async () => ({ data: [{ id: "100", name: "Camp 100" }, { id: "200", name: "Camp 200" }], error: null }),
          insert: async (rows: Record<string, unknown>[]) => { audit.push(...rows.map((r) => ({ ...r, table }))); return { error: null }; },
        };
        return b;
      },
    }),
  },
});
mock.module("@/lib/tools/analytics/emailbison/client.ts", {
  namedExports: {
    createEmailBisonClient: () => ({
      attachSenderEmails: async (campaign: number, ids: number[]) => { attached.push({ campaign, ids }); for (const id of ids) (onCampaign.get(campaign) ?? onCampaign.set(campaign, new Set()).get(campaign)!).add(id); },
      removeSenderEmails: async (campaign: number, ids: number[]) => { removed.push({ campaign, ids }); },
      getCampaignSenderEmails: async (campaign: number) => [...(onCampaign.get(campaign) ?? [])].map((id) => ({ id })),
    }),
  },
});

const { assignInboxesByTags } = await import("./inbox-assignment.ts");

const EB = [{ platform: "emailbison" as const, id: "100" }, { platform: "emailbison" as const, id: "200" }];
let asked: number[][] = [];
const healthSays = (bad: number[]) => async (ids: number[]) => {
  asked.push([...ids].sort((a, b) => a - b));
  const healthy = ids.filter((id) => !bad.includes(id));
  const leftOut = bad.filter((id) => ids.includes(id)).map((id) => ({ id, email: `i${id}@x.test`, reasons: ["Warm-up score 80"], kinds: ["warm-up" as const] }));
  return { ok: true as const, health: { healthy, leftOut, counts: { "not connected": 0, Dead: 0, bounce: 0, "warm-up": leftOut.length, "not found": 0 }, unjudged: 0 } };
};
const reset = () => { attached.length = 0; removed.length = 0; audit.length = 0; onCampaign.clear(); asked = []; };

test("an attach sends only the healthy connected inboxes, judged once over every ticked pool", async () => {
  reset();
  const s = await assignInboxesByTags(EB, ["Nicole Pool", "Zapmail"], "attach", "person@example.com", 7, healthSays([2, 5]));
  assert.deepEqual(asked, [[1, 2, 3, 4, 5]], "one check over the union of connected ids");
  for (const a of attached) assert.ok(!a.ids.includes(2) && !a.ids.includes(5) && !a.ids.includes(9), JSON.stringify(a));
  assert.deepEqual([...onCampaign.get(100)!].sort(), [1, 3, 4]);
  assert.deepEqual([...onCampaign.get(200)!].sort(), [1, 3, 4]);
  assert.equal(s.skippedUnhealthy, 2);
  assert.equal(s.health?.counts["warm-up"], 2);
  assert.equal(s.inboxes, 3, "distinct healthy inboxes");
  assert.equal(s.results.every((r) => r.ok), true);
  assert.ok(audit.some((r) => (r.before_state as Record<string, unknown>).left_out_by_health === 1));
});

test("health that can't be checked: no EmailBison campaign is given anything, each says why", async () => {
  reset();
  const s = await assignInboxesByTags(EB, ["Nicole Pool"], "attach", "person@example.com", 7, async () => ({ ok: false, error: "The inbox health check isn't switched on (analytics 098)" }));
  assert.deepEqual(attached, []);
  assert.equal(s.results.length, 2);
  assert.ok(s.results.every((r) => !r.ok && /098/.test(r.error ?? "")));
});

test("a remove is never checked and takes off what is asked", async () => {
  reset();
  onCampaign.set(100, new Set([1, 2, 9]));
  let checked = false;
  await assignInboxesByTags([EB[0]], ["Nicole Pool"], "remove", "person@example.com", 7, async () => { checked = true; return healthSays([])([]); });
  assert.equal(checked, false);
  // Every tagged inbox the campaign holds comes off, the unhealthy and the unconnected (9) included.
  assert.deepEqual(removed, [{ campaign: 100, ids: [1, 2, 9] }]);
});

test("nothing can attach unchecked by calling one pool directly", async () => {
  reset();
  const { assignInboxesByTag } = await import("./inbox-assignment.ts");
  await assert.rejects(assignInboxesByTag(EB, "Nicole Pool", "attach", "person@example.com", 7), /health wasn't checked/);
  assert.deepEqual(attached, []);
});
