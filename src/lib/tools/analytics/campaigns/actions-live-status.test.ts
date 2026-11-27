/*
 * applyCampaignAction's optional live status (27 Nov): it replaces the cached status for the eligibility check (the
 * Claude connector's pause); without it, exactly as before (the screens).
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";

const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";
const paused: number[] = [];
const audit: Array<Record<string, unknown>> = [];

function db() {
  return {
    from(table: string) {
      const c: Record<string, unknown> = {
        select: () => c, eq: () => c, in: () => Promise.resolve({ data: [{ id: "1422", platform: "emailbison", name: "ZZ TEST", status: "paused", total_leads: 1 }], error: null }),
        insert: async (rows: Array<Record<string, unknown>>) => { audit.push(...rows); return { error: null }; },
        update: () => ({ eq: () => ({ eq: async () => ({ error: null }), then: (r: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(r) }) }),
      };
      void table;
      return c;
    },
  };
}

let apply: typeof import("./actions.ts").applyCampaignAction;
let loaded = false;
async function load() {
  if (loaded) return;
  loaded = true;
  mock.module("@/lib/tools/analytics/supabase", { namedExports: { getAnalyticsSupabase: db, analyticsTeamId: () => 7 } });
  mock.module("@/lib/tools/analytics/emailbison/client.ts", { namedExports: { createEmailBisonClient: () => ({ pauseCampaign: async (id: number) => { paused.push(id); } }) } });
  mock.module("@/lib/tools/analytics/instantly/client.ts", { namedExports: { createInstantlyClient: () => ({}) } });
  mock.module("./client-fields-load", { namedExports: { unfilledClientFields: async () => [] } });
  ({ applyCampaignAction: apply } = await import("./actions.ts"));
}

test("the cache says paused, EmailBison says active: without a live status the pause is refused as before; with it, it pauses", { skip }, async () => {
  await load();
  paused.length = 0; audit.length = 0;
  const before = await apply("pause", [{ platform: "emailbison", id: "1422" }], "eddy@brokerstaffer.com", 7);
  assert.equal(before.results[0].ok, false);
  assert.match(String(before.results[0].error), /paused campaign is not sending/);
  assert.deepEqual(paused, [], "the screens' behaviour is unchanged");
  const live = await apply("pause", [{ platform: "emailbison", id: "1422" }], "eddy@brokerstaffer.com via Claude", 7, { liveStatus: new Map([["emailbison:1422", "active"]]) });
  assert.equal(live.results[0].ok, true);
  assert.deepEqual(paused, [1422]);
  assert.deepEqual((audit[0]?.before_state as { status?: string })?.status, "active", "the audit log records the status it acted on");
});
