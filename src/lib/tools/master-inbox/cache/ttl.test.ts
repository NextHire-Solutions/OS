import assert from "node:assert/strict";
import { test } from "node:test";
import { ttlCache } from "./ttl.ts";

const tick = () => new Promise((r) => setTimeout(r, 5));

test("within the TTL the value is served without calling through", async () => {
  let calls = 0;
  const f = ttlCache(async (x: number) => { calls++; return x * 2; }, { ttlMs: 1_000 });
  assert.equal(await f(2), 4);
  assert.equal(await f(2), 4);
  assert.equal(calls, 1);
});

test("stale-while-revalidate: after the TTL the OLD value is served at once and a refresh runs behind", async () => {
  let calls = 0;
  // Each call returns ITS OWN number: a shared counter read after the await
  // would report a later call's value and misdescribe the cache.
  // Generous timings: macOS timers drift by a few ms, and the point is the
  // ORDER of events, not their exact spacing.
  const f = ttlCache(async () => { const mine = ++calls; await tick(); return mine; }, { ttlMs: 100, staleMs: 10_000 });
  assert.equal(await f(), 1);
  await new Promise((r) => setTimeout(r, 130)); // past the TTL, inside the stale window
  const t0 = Date.now();
  assert.equal(await f(), 1, "stale value, immediately");
  assert.ok(Date.now() - t0 < 5, "did not wait for the refresh");
  await new Promise((r) => setTimeout(r, 40)); // the refresh has landed; its value is fresh for 100ms
  assert.equal(await f(), 2, "the refresh landed");
  assert.equal(calls, 2);
});

test("past the stale window a caller waits for a fresh value", async () => {
  let calls = 0;
  const f = ttlCache(async () => { calls++; return calls; }, { ttlMs: 5, staleMs: 5 });
  assert.equal(await f(), 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await f(), 2);
});

test("without staleMs, behaviour is unchanged: expiry means a real wait", async () => {
  let calls = 0;
  const f = ttlCache(async () => { const mine = ++calls; await tick(); return mine; }, { ttlMs: 5 });
  assert.equal(await f(), 1);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(await f(), 2);
});

test("a failed background refresh keeps the stale value servable", async () => {
  let calls = 0;
  const f = ttlCache(async () => { calls++; if (calls > 1) throw new Error("upstream down"); return "ok"; }, { ttlMs: 5, staleMs: 10_000 });
  assert.equal(await f(), "ok");
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(await f(), "ok"); // stale, refresh fires and fails
  await tick();
  assert.equal(await f(), "ok", "still served after the failed refresh");
});

test("invalidate drops the stale value too", async () => {
  let calls = 0;
  const f = ttlCache(async () => { calls++; return calls; }, { ttlMs: 5, staleMs: 10_000 });
  await f();
  f.invalidate();
  assert.equal(await f(), 2);
});

test("expire(): the next read still answers at once from the stale value, and refreshes behind it", async () => {
  let n = 0;
  const f = ttlCache(async () => ++n, { ttlMs: 60_000, staleMs: 60_000 });
  assert.equal(await f(), 1);
  assert.equal(await f(), 1, "fresh: served from memory");
  f.expire();
  assert.equal(await f(), 1, "expired but within the stale window: answered at once with the old value");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(await f(), 2, "the refresh it started behind that answer has landed");
});

test("expire() with no stale window behaves like a miss: the next read waits for a fresh value", async () => {
  let n = 0;
  const f = ttlCache(async () => ++n, { ttlMs: 60_000 });
  assert.equal(await f(), 1);
  f.expire();
  assert.equal(await f(), 2);
});

test("shared: two copies of a cache under one name are one cache — a warm, a read and an invalidate all meet", async () => {
  let a = 0, b = 0;
  const name = `test-${Math.random()}`;
  const warm = ttlCache(async () => `a${++a}`, { ttlMs: 60_000, shared: name });
  const page = ttlCache(async () => `b${++b}`, { ttlMs: 60_000, shared: name });
  assert.equal(await warm(), "a1");
  assert.equal(await page(), "a1", "the page reads what the warm-up fetched");
  assert.equal(b, 0);
  warm.invalidate();
  assert.equal(await page(), "b1", "an invalidate in one copy clears the other");
  const alone = ttlCache(async () => "own", { ttlMs: 60_000 });
  assert.equal(await alone(), "own", "without a name nothing is shared");
});
