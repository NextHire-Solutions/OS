import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { NextRequest, NextResponse } from "next/server";

import { grantsForRequest } from "../../../../../../../../lib/workspace/tool-paths.ts";

/* The route that adds inboxes to a campaign (6 Nov). Its rules are tested in inbox-add.test.ts; this is who may, what is recorded, and what is left behind. */
const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

const BATCH = "11111111-1111-4111-8111-111111111111";
const session: { current: { email: string } | null } = { current: { email: "person@example.com" } };
const campaign = { status: "active", inboxes: new Set([1, 2]) };
const calls: string[] = [];
const audit: Array<Record<string, unknown>> = [];
const added: number[] = [];
let stale = 0;
/** The health verdict the fake gives: ids it passes, or an error as if it couldn't be read. */
const health: { pass: Set<number> | null; error: string | null; reads: number } = { pass: null, error: null, reads: 0 };

let POST: (r: NextRequest) => Promise<Response>;
test("setup", { skip }, async () => {
  mock.module("next/headers", { namedExports: { cookies: async () => ({ get: () => ({ value: "x" }) }) } });
  mock.module("@/lib/tools/analytics/session", { namedExports: { AUTH_COOKIE: "c", verifySessionToken: async () => session.current } });
  mock.module("@/lib/tools/analytics/supabase", {
    namedExports: {
      analyticsTeamId: () => 7,
      getAnalyticsSupabase: () => ({ from: (table: string) => ({ insert: async (row: Record<string, unknown>) => { audit.push({ ...row, table }); return { error: null }; } }) }),
    },
  });
  mock.module("@/lib/tools/analytics/emailbison/client.ts", {
    namedExports: {
      createEmailBisonClient: () => ({
        getCampaign: async () => { calls.push("status"); return { id: 5, name: "Real name", status: campaign.status }; },
        getCampaignSenderEmailCount: async () => campaign.inboxes.size,
        attachSenderEmails: async (_: number, ids: number[]) => {
          calls.push("attach");
          // As EmailBison: every one on it already is refused, in its own words.
          if (ids.every((id) => campaign.inboxes.has(id))) throw new Error("These emails already exist on this campaign (Real name)");
          for (const id of ids) campaign.inboxes.add(id);
        },
        pauseCampaign: async () => { calls.push("pause"); },
        resumeCampaign: async () => { calls.push("resume"); },
      }),
    },
  });
  mock.module("@/lib/tools/analytics/campaign-inboxes-load", { namedExports: { inboxesAdded: (id: number) => added.push(id) } });
  mock.module("@/lib/tools/analytics/inbox-extras-load", { namedExports: { markInboxExtrasStale: () => { stale++; } } });
  mock.module("@/lib/tools/analytics/campaigns/attach-health-io", {
    namedExports: {
      readAttachHealth: async (ids: number[]) => {
        health.reads++;
        if (health.error) return { ok: false, error: health.error };
        const healthy = ids.filter((id) => !health.pass || health.pass.has(id));
        const leftOut = ids.filter((id) => !healthy.includes(id)).map((id) => ({ id, email: `${id}@x.test`, reasons: ["Bounce rate 3.0%"], kinds: ["bounce"] }));
        return { ok: true, health: { healthy, leftOut, counts: { "not connected": 0, Dead: 0, bounce: leftOut.length, "warm-up": 0, "not found": 0 }, unjudged: 0 } };
      },
    },
  });
  mock.module("next/server", { namedExports: { NextResponse, NextRequest } });
  POST = (await import("./route.ts")).POST;
});

const body = (o: Record<string, unknown> = {}) => ({ campaignId: 5, inboxIds: [3, 4], batchId: BATCH, confirm: true, ...o });
const send = (b: unknown) => POST(new NextRequest("https://os.example/api/tools/analytics/campaigns/inboxes/add/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
const reset = (status: string, inboxes = [1, 2]) => {
  Object.assign(campaign, { status, inboxes: new Set(inboxes) });
  calls.length = 0; audit.length = 0; added.length = 0; stale = 0;
  Object.assign(health, { pass: null, error: null, reads: 0 });
  session.current = { email: "person@example.com" };
};

test("Campaign Management's, not Campaign Analytics'", () => {
  assert.deepEqual(grantsForRequest("/api/tools/analytics/campaigns/inboxes/add/run", "POST"), ["campaigns"]);
});

test("nobody signed in changes nothing", { skip }, async () => {
  reset("active");
  session.current = null;
  assert.equal((await send(body())).status, 401);
  assert.deepEqual(calls, []);
});

test("it must be confirmed, and well formed, before anything is read", { skip }, async () => {
  reset("active");
  assert.equal((await send(body({ confirm: false }))).status, 428);
  assert.equal((await send({ campaignId: 5, inboxIds: [3], batchId: BATCH })).status, 428);
  assert.equal((await send(body({ inboxIds: [] }))).status, 400);
  assert.equal((await send(body({ campaignId: "5" }))).status, 400);
  assert.equal((await send(body({ batchId: "x" }))).status, 400);
  assert.deepEqual(calls, []);
});

test("an active campaign: added without pausing, written to the audit log with who, and the kept lists dropped", { skip }, async () => {
  reset("active");
  const r = await send(body());
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual([j.ok, j.outcome, j.added, j.before, j.after, j.name], [true, "added", 2, 2, 4, "Real name"]);
  assert.deepEqual(calls, ["status", "attach"], "never paused or resumed");
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].table, audit[0].action, audit[0].actor, audit[0].status, audit[0].campaign_id, audit[0].batch_id], ["campaign_audit_log", "attach-inboxes", "person@example.com", "ok", 5, BATCH]);
  assert.deepEqual(audit[0].before_state, { from: "inboxes page", inbox_ids: [3, 4], left_out_by_health: [], inboxes: 2, status: "active" });
  assert.deepEqual(audit[0].after_state, { applied: 2, already_on: 0, inboxes: 4, dropped: 0 });
  assert.deepEqual(added, [5]);
  assert.equal(stale, 1);
});

test("a finished campaign: nothing sent, nothing recorded", { skip }, async () => {
  reset("completed");
  const j = await (await send(body())).json();
  assert.equal(j.outcome, "finished");
  assert.deepEqual(calls, ["status"]);
  assert.deepEqual(audit, []);
  assert.deepEqual(added, []);
});

test("all already on it: said as nothing to do, recorded, the kept lists left alone", { skip }, async () => {
  reset("paused", [1, 2, 3, 4]);
  const j = await (await send(body())).json();
  assert.equal(j.outcome, "nothing");
  assert.equal(audit.length, 1);
  assert.deepEqual(added, []);
});

/* The inbox health rules (20 Nov — attach-health.ts): judged here, whatever the window showed. */

test("only healthy inboxes go on; the ones left out are recorded with why", { skip }, async () => {
  reset("active");
  health.pass = new Set([3]);
  const j = await (await send(body({ batchId: "22222222-2222-4222-8222-222222222222" }))).json();
  assert.deepEqual([j.ok, j.outcome, j.added, j.leftOutUnhealthy], [true, "added", 1, 1]);
  assert.ok(campaign.inboxes.has(3) && !campaign.inboxes.has(4), "4 never sent");
  assert.deepEqual((audit[0].before_state as Record<string, unknown>).inbox_ids, [3]);
  assert.deepEqual((audit[0].before_state as Record<string, unknown>).left_out_by_health, [{ id: 4, reasons: ["bounce"] }]);
});

test("none healthy: nothing sent to EmailBison, nothing recorded", { skip }, async () => {
  reset("active");
  health.pass = new Set();
  const j = await (await send(body({ batchId: "33333333-3333-4333-8333-333333333333" }))).json();
  assert.deepEqual([j.ok, j.outcome, j.added, j.leftOutUnhealthy], [true, "unhealthy", 0, 2]);
  assert.deepEqual(calls, []);
  assert.deepEqual(audit, []);
});

test("health that can't be read: nothing sent, the reason given", { skip }, async () => {
  reset("active");
  health.error = "The inbox health check isn't switched on (analytics 098)";
  const j = await (await send(body({ batchId: "44444444-4444-4444-8444-444444444444" }))).json();
  assert.deepEqual([j.ok, j.outcome], [false, "failed"]);
  assert.match(j.error, /098/);
  assert.deepEqual(calls, []);
});

test("one run of the window is judged once for all its campaigns; a failed read is tried again", { skip }, async () => {
  reset("active");
  const b = "55555555-5555-4555-8555-555555555555";
  await send(body({ batchId: b }));
  await send(body({ batchId: b, campaignId: 6 }));
  assert.equal(health.reads, 1);
  health.error = "down";
  const c = "66666666-6666-4666-8666-666666666666";
  await send(body({ batchId: c }));
  await new Promise((r) => setTimeout(r, 0));
  health.error = null;
  await send(body({ batchId: c }));
  assert.equal(health.reads, 3);
});
