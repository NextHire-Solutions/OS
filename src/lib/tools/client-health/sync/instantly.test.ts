/*
 * The Instantly client against a stubbed fetch: pagination, the error shape,
 * and the status/progress arithmetic the campaign rows depend on.
 *
 *   node --import ./scripts/alias-hooks.mjs --test src/lib/tools/client-health/sync/instantly.test.ts
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { dailyAnalytics, listCampaigns, mapStatus, progressPct } from "./instantly.ts";

const realFetch = globalThis.fetch;
const savedKey = process.env.CLIENT_HEALTH_INSTANTLY_API_KEY;

beforeEach(() => { process.env.CLIENT_HEALTH_INSTANTLY_API_KEY = "test-key"; });
afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedKey === undefined) delete process.env.CLIENT_HEALTH_INSTANTLY_API_KEY;
  else process.env.CLIENT_HEALTH_INSTANTLY_API_KEY = savedKey;
});

function stub(handler: (url: URL, init: RequestInit | undefined) => { status?: number; body: unknown }) {
  const calls: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
    const { status = 200, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

test("listCampaigns follows next_starting_after until it is absent", async () => {
  const calls = stub((url) => {
    const after = url.searchParams.get("starting_after");
    if (!after) return { body: { items: [{ id: "a", name: "A" }], next_starting_after: "a" } };
    if (after === "a") return { body: { items: [{ id: "b", name: "B" }], next_starting_after: "b" } };
    return { body: { items: [{ id: "c", name: "C" }] } };
  });
  const all = await listCampaigns();
  assert.deepEqual(all.map((c) => c.id), ["a", "b", "c"]);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].searchParams.get("limit"), "100");
  assert.equal(calls[0].pathname, "/api/v2/campaigns");
});

test("the bearer key is sent and a non-2xx becomes a named error", async () => {
  let auth: string | null = null;
  stub((_url, init) => {
    auth = new Headers(init?.headers).get("authorization");
    return { status: 429, body: { message: "slow down" } };
  });
  await assert.rejects(listCampaigns(), /Instantly \/api\/v2\/campaigns 429: .*slow down/);
  assert.equal(auth, "Bearer test-key");
});

test("a missing key throws before any request is made", async () => {
  delete process.env.CLIENT_HEALTH_INSTANTLY_API_KEY;
  const calls = stub(() => ({ body: [] }));
  await assert.rejects(listCampaigns(), /CLIENT_HEALTH_INSTANTLY_API_KEY is not set/);
  assert.equal(calls.length, 0);
});

test("dailyAnalytics passes the campaign and the range as query params", async () => {
  const calls = stub(() => ({ body: [{ date: "2026-09-14", sent: 3, replies: 1 }] }));
  const days = await dailyAnalytics("c1", "2026-03-16", "2026-09-20");
  assert.equal(days[0].sent, 3);
  const q = calls[0].searchParams;
  assert.equal(calls[0].pathname, "/api/v2/campaigns/analytics/daily");
  assert.equal(q.get("campaign_id"), "c1");
  assert.equal(q.get("start_date"), "2026-03-16");
  assert.equal(q.get("end_date"), "2026-09-20");
});

test("status codes and strings map the way the tool observed them", () => {
  assert.equal(mapStatus(1), "running");
  assert.equal(mapStatus(2), "paused");
  assert.equal(mapStatus(3), "finished");
  assert.equal(mapStatus(9), null);
  assert.equal(mapStatus("Active"), "running");
  assert.equal(mapStatus("PAUSED"), "paused");
  assert.equal(mapStatus("completed"), "finished");
  assert.equal(mapStatus(undefined), null);
});

test("progress is completed / leads, capped at 100, zero when there are no leads", () => {
  const base = {
    campaign_id: "x", campaign_name: "x", campaign_status: 1, contacted_count: 0, emails_sent_count: 0,
    new_leads_contacted_count: 0, reply_count: 0, bounced_count: 0, total_opportunities: 0, total_opportunity_value: 0,
  };
  assert.equal(progressPct({ ...base, leads_count: 199, completed_count: 183 }), (183 / 199) * 100);
  assert.equal(progressPct({ ...base, leads_count: 10, completed_count: 12 }), 100);
  assert.equal(progressPct({ ...base, leads_count: 0, completed_count: 5 }), 0);
});
