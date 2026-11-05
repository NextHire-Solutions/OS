import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest, NextResponse } from "next/server";

import { grantsForRequest } from "../../../../../../../../lib/workspace/tool-paths.ts";

/* The route that changes campaigns (5 Nov). Its rules are tested in inbox-removal.test.ts; this is who may, what is recorded, and what is left behind. */
const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

const BATCH = "11111111-1111-4111-8111-111111111111";
const session: { current: { email: string } | null } = { current: { email: "person@example.com" } };
const campaign = { status: "paused", inboxes: new Set([1, 2, 3, 4]), pauseFails: false, resumeFails: false };
const calls: string[] = [];
const audit: Array<Record<string, unknown>> = [];
const statusWrites: unknown[] = [];
const takenOff: unknown[][] = [];
let stale = 0;

let POST: (r: NextRequest) => Promise<Response>;
test("setup", { skip }, async () => {
  mock.module("next/headers", { namedExports: { cookies: async () => ({ get: () => ({ value: "x" }) }) } });
  mock.module("@/lib/tools/analytics/session", { namedExports: { AUTH_COOKIE: "c", verifySessionToken: async () => session.current } });
  mock.module("@/lib/tools/analytics/supabase", {
    namedExports: {
      analyticsTeamId: () => 7,
      getAnalyticsSupabase: () => ({
        from: (table: string) => ({
          insert: async (rows: Array<Record<string, unknown>>) => { audit.push(...rows.map((r) => ({ ...r, table }))); return { error: null }; },
          update: (patch: unknown) => ({ eq: async (k: string, v: unknown) => { statusWrites.push({ table, patch, [k]: v }); return { error: null }; } }),
        }),
      }),
    },
  });
  mock.module("@/lib/tools/analytics/emailbison/client.ts", {
    namedExports: {
      createEmailBisonClient: () => ({
        getCampaign: async () => { calls.push("status"); return { id: 5, name: "Real name", status: campaign.status }; },
        getCampaignSenderEmailCount: async () => campaign.inboxes.size,
        removeSenderEmails: async (_: number, ids: number[]) => { calls.push("remove"); for (const id of ids) campaign.inboxes.delete(id); },
        pauseCampaign: async () => { calls.push("pause"); if (campaign.pauseFails) throw new Error("no pause"); campaign.status = "paused"; },
        resumeCampaign: async () => { calls.push("resume"); if (campaign.resumeFails) throw new Error("no resume"); campaign.status = "queued"; },
      }),
    },
  });
  mock.module("@/lib/tools/analytics/campaign-inboxes-load", { namedExports: { inboxesTakenOff: (...a: unknown[]) => takenOff.push(a) } });
  mock.module("@/lib/tools/analytics/inbox-extras-load", { namedExports: { markInboxExtrasStale: () => { stale++; } } });
  mock.module("next/server", { namedExports: { NextResponse, NextRequest } });
  POST = (await import("./route.ts")).POST;
});

const body = (o: Record<string, unknown> = {}) => ({ campaignId: 5, inboxIds: [1, 2], pauseActive: false, batchId: BATCH, confirm: true, ...o });
const send = (b: unknown) => POST(new NextRequest("https://os.example/api/tools/analytics/campaigns/inboxes/removal/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
const reset = (status: string, inboxes = [1, 2, 3, 4]) => {
  Object.assign(campaign, { status, inboxes: new Set(inboxes), pauseFails: false, resumeFails: false });
  calls.length = 0; audit.length = 0; statusWrites.length = 0; takenOff.length = 0; stale = 0;
  session.current = { email: "person@example.com" };
};

test("nobody signed in changes nothing", { skip }, async () => {
  reset("paused");
  session.current = null;
  const r = await send(body());
  assert.equal(r.status, 401);
  assert.deepEqual(calls, []);
});

test("it must be confirmed, and well formed, before anything is read", { skip }, async () => {
  reset("paused");
  assert.equal((await send(body({ confirm: undefined }))).status, 428);
  assert.equal((await send(body({ confirm: false }))).status, 428);
  for (const bad of [{ campaignId: "5" }, { campaignId: -1 }, { inboxIds: [] }, { inboxIds: ["a"] }, { pauseActive: "yes" }, { batchId: "nope" }]) {
    assert.equal((await send(body(bad))).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(calls, []);
});

test("a paused campaign: changed, recorded by name and person with the ids, and the kept figures told", { skip }, async () => {
  reset("paused");
  const r = await send(body());
  assert.equal(r.status, 200);
  const j = (await r.json()) as Record<string, unknown>;
  assert.equal(j.outcome, "removed");
  assert.equal(j.name, "Real name");
  assert.equal(j.applied, 2);
  assert.equal(audit.length, 1);
  const row = audit[0] as Record<string, any>;
  assert.equal(row.table, "campaign_audit_log");
  assert.equal(row.action, "remove-inboxes");
  assert.equal(row.actor, "person@example.com");
  assert.equal(row.campaign_name, "Real name");
  assert.equal(row.batch_id, BATCH);
  assert.equal(row.status, "ok");
  assert.deepEqual(row.before_state.inbox_ids, [1, 2], "enough to put them back");
  assert.deepEqual(row.after_state, { applied: 2, left: 2, removed_ids: [1, 2] }, "the ids that really came off");
  assert.deepEqual(takenOff, [[5, [1, 2]]]);
  assert.equal(stale, 1);
  assert.deepEqual(statusWrites, []);
});

test("left alone means no history and nothing to refresh", { skip }, async () => {
  reset("active");
  const j = (await (await send(body())).json()) as Record<string, unknown>;
  assert.equal(j.outcome, "active");
  assert.deepEqual(audit, []);
  assert.deepEqual(takenOff, []);
  assert.equal(stale, 0);

  reset("paused", [1, 2]);
  const last = (await (await send(body())).json()) as Record<string, unknown>;
  assert.equal(last.outcome, "last");
  assert.deepEqual(audit, []);
  assert.deepEqual(calls.filter((c) => c === "remove"), []);
});

test("an active campaign, ticked: pause and restart are recorded too, and its status in the list stays active", { skip }, async () => {
  reset("active");
  const j = (await (await send(body({ pauseActive: true }))).json()) as Record<string, unknown>;
  assert.equal(j.outcome, "removed");
  assert.equal(j.stillPaused, false);
  assert.deepEqual(calls.filter((c) => c !== "status"), ["pause", "remove", "resume"]);
  assert.deepEqual(audit.map((a) => [a.action, a.status]), [["pause", "ok"], ["remove-inboxes", "ok"], ["resume", "ok"]], "the pause on record first");
  assert.equal((audit[0] as Record<string, any>).before_state.status, "active");
  assert.deepEqual(statusWrites, [], "seconds later it's sending again, so the figures don't lose it until the next sync");
});

test("it couldn't be started again: the list says paused, the record says so, and the answer says so", { skip }, async () => {
  reset("active");
  campaign.resumeFails = true;
  const r = await send(body({ pauseActive: true }));
  assert.equal(r.status, 200);
  const j = (await r.json()) as Record<string, unknown>;
  assert.equal(j.stillPaused, true);
  assert.equal(j.ok, false);
  assert.deepEqual(statusWrites, [{ table: "campaigns", patch: { status: "paused" }, id: 5 }]);
  assert.deepEqual(audit.map((a) => [a.action, a.status]), [["pause", "ok"], ["remove-inboxes", "error"], ["resume", "error"]]);
});

test("two people on one campaign: the second is told to wait, and nothing of theirs reaches EmailBison", { skip }, async () => {
  reset("paused");
  (globalThis as unknown as Record<symbol, Set<number>>)[Symbol.for("os.analytics.inboxRemovalRunning")] = new Set([5]);
  const j = (await (await send(body())).json()) as Record<string, unknown>;
  assert.equal(j.outcome, "failed");
  assert.match(String(j.error), /Someone else is changing this campaign/);
  assert.deepEqual(calls, []);
  (globalThis as unknown as Record<symbol, Set<number>>)[Symbol.for("os.analytics.inboxRemovalRunning")] = new Set();
  assert.equal(((await (await send(body())).json()) as Record<string, unknown>).outcome, "removed");
  assert.equal((globalThis as unknown as Record<symbol, Set<number>>)[Symbol.for("os.analytics.inboxRemovalRunning")].size, 0, "and it's let go afterwards");
});

test("a pause EmailBison refused is recorded as the failed attempt it was, and nothing else happens", { skip }, async () => {
  reset("active");
  campaign.pauseFails = true;
  const j = (await (await send(body({ pauseActive: true }))).json()) as Record<string, unknown>;
  assert.equal(j.outcome, "failed");
  assert.deepEqual(audit.map((a) => [a.action, a.status]), [["pause", "ok"], ["remove-inboxes", "error"], ["pause", "error"]], "tried, and then refused");
  assert.deepEqual(calls.filter((c) => c === "remove" || c === "resume"), []);
  assert.equal(stale, 0);
});

test("only someone with Campaign Management may change a campaign, even from the Inboxes page", () => {
  const R = "/api/tools/analytics/campaigns/inboxes/removal";
  for (const path of [R, `${R}/run`, `${R}/overlap`, `${R}/by-inbox`]) assert.deepEqual(grantsForRequest(path, "POST"), ["campaigns"], path);
  assert.deepEqual(grantsForRequest("/api/tools/analytics/campaigns/active-capacity", "GET"), ["analytics", "campaigns"]);
});

test("the page offers it only to someone who has Campaign Management", () => {
  const page = readFileSync("src/app/[[...slug]]/page.tsx", "utf8");
  assert.match(page, /<InboxesScreen canChangeCampaigns=\{grants\.includes\("campaigns"\)\} \/>/);
  const screen = readFileSync("src/components/screens/analytics/inboxes.tsx", "utf8");
  assert.match(screen, /\{canChangeCampaigns \? \(\s*<button[\s\S]{0,120}data-inbox-remove/);
  assert.match(screen, /canChangeCampaigns = false/, "off unless told otherwise");
});
