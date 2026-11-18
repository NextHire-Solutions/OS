import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";

import { cachedGet } from "./cached-get.ts";
import { analyticsDataChanged } from "./read-cache-bus.ts";

const req = (q: string) => new NextRequest(`http://os.internal/api/analytics/kpis${q}`);

test("an identical question is answered from memory; any different parameter reaches the handler", async () => {
  const seen: string[] = [];
  const GET = cachedGet(async (r) => { seen.push(r.nextUrl.search); return Response.json({ n: seen.length }); });
  assert.deepEqual(await (await GET(req("?preset=7d&client=a"))).json(), { n: 1 });
  assert.deepEqual(await (await GET(req("?client=a&preset=7d"))).json(), { n: 1 }, "parameter order does not matter");
  assert.deepEqual(await (await GET(req("?preset=7d&client=b"))).json(), { n: 2 }, "a filter change is a new question");
  assert.equal(seen.length, 2);
});

test("errors are passed through and never cached", async () => {
  let calls = 0;
  const GET = cachedGet(async () => { calls++; return Response.json({ error: "boom" }, { status: 500 }); });
  const a = await GET(req("?x=1"));
  assert.equal(a.status, 500);
  assert.deepEqual(await a.json(), { error: "boom" });
  await GET(req("?x=1"));
  assert.equal(calls, 2, "the second ask tried again");
});

test("headers that matter survive the cache", async () => {
  const GET = cachedGet(async () => Response.json({ ok: 1 }, { headers: { "Cache-Control": "private, max-age=300" } }));
  await GET(req("?h=1"));
  const r = await GET(req("?h=1"));
  assert.equal(r.headers.get("cache-control"), "private, max-age=300");
  assert.match(r.headers.get("content-type") ?? "", /json/);
});

test("a finished sync marks answers out of date: the next ask is answered at once, the one after is fresh", async () => {
  let n = 0;
  const GET = cachedGet(async () => Response.json({ n: ++n }));
  assert.deepEqual(await (await GET(req("?s=1"))).json(), { n: 1 });
  analyticsDataChanged();
  assert.deepEqual(await (await GET(req("?s=1"))).json(), { n: 1 }, "stale answer, served without waiting");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(await (await GET(req("?s=1"))).json(), { n: 2 });
});

test("fresh=1 waits for a new answer, which then serves the plain question; fresh is never passed on", async () => {
  let n = 0;
  const seen: string[] = [];
  const GET = cachedGet(async (r) => { seen.push(r.nextUrl.search); return Response.json({ n: ++n }); });
  assert.deepEqual(await (await GET(req("?f=1"))).json(), { n: 1 });
  analyticsDataChanged();
  assert.deepEqual(await (await GET(req("?f=1&fresh=1"))).json(), { n: 2 }, "not the answer from before the sync");
  assert.deepEqual(await (await GET(req("?f=1"))).json(), { n: 2 }, "the plain question now gets the new answer");
  assert.deepEqual(await (await GET(req("?fresh=1&f=1"))).json(), { n: 3 }, "asked again, fresh again");
  assert.ok(seen.every((q) => !q.includes("fresh")), seen.join(" "));
  assert.equal(n, 3);
});
