/*
 * The EmailBison client against a stubbed fetch: page-based pagination, the
 * retry rule (network errors yes, HTTP errors no), and the two-series merge
 * behind the daily stats.
 *
 *   node --import ./scripts/alias-hooks.mjs --test src/lib/tools/client-health/sync/bison.test.ts
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { bisonDailyStats, bisonProgressPct, listBisonCampaigns, mapBisonStatus } from "./bison.ts";

const realFetch = globalThis.fetch;
const SAVED = {
  key: process.env.CLIENT_HEALTH_BISON_API_KEY,
  base: process.env.CLIENT_HEALTH_BISON_BASE_URL,
};

beforeEach(() => {
  process.env.CLIENT_HEALTH_BISON_API_KEY = "22|test";
  process.env.CLIENT_HEALTH_BISON_BASE_URL = "https://bison.example/";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (SAVED.key === undefined) delete process.env.CLIENT_HEALTH_BISON_API_KEY; else process.env.CLIENT_HEALTH_BISON_API_KEY = SAVED.key;
  if (SAVED.base === undefined) delete process.env.CLIENT_HEALTH_BISON_BASE_URL; else process.env.CLIENT_HEALTH_BISON_BASE_URL = SAVED.base;
});

function stub(handler: (url: URL, attempt: number) => { status?: number; body: unknown } | Error) {
  const calls: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
    const r = handler(url, calls.length);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

test("listBisonCampaigns walks pages up to meta.last_page, trimming the trailing slash", async () => {
  const calls = stub((url) => {
    const page = Number(url.searchParams.get("page"));
    return { body: { data: [{ id: page, uuid: `u${page}`, name: `P${page}` }], meta: { current_page: page, last_page: 3 } } };
  });
  const all = await listBisonCampaigns();
  assert.deepEqual(all.map((c) => c.uuid), ["u1", "u2", "u3"]);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].href, "https://bison.example/api/campaigns?page=1");
});

test("a page with no meta ends the walk", async () => {
  const calls = stub(() => ({ body: { data: [{ id: 1, uuid: "u1", name: "P1" }] } }));
  await listBisonCampaigns();
  assert.equal(calls.length, 1);
});

test("network errors are retried up to three times; the third failure is thrown", async () => {
  const calls = stub(() => new TypeError("fetch failed"));
  await assert.rejects(listBisonCampaigns(), /fetch failed/);
  assert.equal(calls.length, 3);
});

test("a network error followed by success recovers", async () => {
  const calls = stub((_url, attempt) =>
    attempt === 1 ? new TypeError("fetch failed") : { body: { data: [{ id: 1, uuid: "u1", name: "P1" }] } },
  );
  const all = await listBisonCampaigns();
  assert.equal(all.length, 1);
  assert.equal(calls.length, 2);
});

test("HTTP errors are NOT retried and carry the path and status", async () => {
  const calls = stub(() => ({ status: 500, body: { error: "boom" } }));
  await assert.rejects(listBisonCampaigns(), /^Error: Bison \/api\/campaigns 500: .*boom/);
  assert.equal(calls.length, 1);
});

test("bisonDailyStats merges the Sent and Replied series by date, using the INTEGER id", async () => {
  const calls = stub(() => ({
    body: {
      data: [
        { label: "Sent", dates: [["2026-09-14", 10], ["2026-09-15", "7"]] },
        { label: "Replied", dates: [["2026-09-15", 2], ["2026-09-16", 1]] },
        { label: "Opened", dates: [["2026-09-14", 99]] },
      ],
    },
  }));
  const days = await bisonDailyStats(55, "2026-09-14", "2026-09-20");
  assert.equal(calls[0].pathname, "/api/campaigns/55/line-area-chart-stats");
  assert.equal(calls[0].searchParams.get("start_date"), "2026-09-14");
  assert.deepEqual(days, [
    { date: "2026-09-14", sent: 10, replied: 0 },
    { date: "2026-09-15", sent: 7, replied: 2 },
    { date: "2026-09-16", sent: 0, replied: 1 },
  ]);
});

test("Bison status strings map to the shared discriminator", () => {
  assert.equal(mapBisonStatus("Active"), "running");
  assert.equal(mapBisonStatus("Launching"), "running");
  assert.equal(mapBisonStatus(" paused "), "paused");
  assert.equal(mapBisonStatus("Completed"), "finished");
  assert.equal(mapBisonStatus("Stopped"), "finished");
  assert.equal(mapBisonStatus("Draft"), null);
  assert.equal(mapBisonStatus(null), null);
});

test("progress prefers the vendor's completion_percentage, clamped", () => {
  assert.equal(bisonProgressPct({ id: 1, uuid: "u", name: "n", completion_percentage: 140 }), 100);
  assert.equal(bisonProgressPct({ id: 1, uuid: "u", name: "n", completion_percentage: -3 }), 0);
  assert.equal(bisonProgressPct({ id: 1, uuid: "u", name: "n", total_leads: 4, total_leads_contacted: 1 }), 25);
  assert.equal(bisonProgressPct({ id: 1, uuid: "u", name: "n" }), 0);
});
