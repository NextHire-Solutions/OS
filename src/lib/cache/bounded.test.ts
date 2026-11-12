/*
 * The size-limited cache (bounded.ts): kept for its time, the newest kept, one read at a time, failures and turned-down
 * answers never kept, and a prefix forgotten at once.
 *
 *   node --test src/lib/cache/bounded.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { boundedCache } from "./bounded.ts";

let clock = 0;
let n = 0;
const fresh = (o: { max?: number; keep?: (v: string) => boolean } = {}) =>
  boundedCache<string>(`test-${++n}`, { ttlMs: 1_000, max: o.max ?? 3, keep: o.keep, now: () => clock });

test("an answer is kept for its time, then read again", async () => {
  const c = fresh();
  let reads = 0;
  const read = async () => `v${++reads}`;
  assert.equal(await c.get("a", read), "v1");
  clock += 999;
  assert.equal(await c.get("a", read), "v1");
  clock += 1;
  assert.equal(await c.get("a", read), "v2");
});

test("two callers at once share one read", async () => {
  const c = fresh();
  let reads = 0;
  let release!: (v: string) => void;
  const read = () => { reads++; return new Promise<string>((r) => { release = r; }); };
  const [a, b] = [c.get("k", read), c.get("k", read)];
  release("x");
  assert.deepEqual(await Promise.all([a, b]), ["x", "x"]);
  assert.equal(reads, 1);
});

test("only the newest `max` are kept: the oldest goes first", async () => {
  const c = fresh({ max: 2 });
  let reads = 0;
  const read = async () => `v${++reads}`;
  await c.get("a", read);
  await c.get("b", read);
  await c.get("c", read);
  assert.equal(c.size(), 2);
  assert.equal(await c.get("a", read), "v4", "a was dropped, so it is read again");
  assert.equal(await c.get("c", read), "v3", "c is still kept");
});

test("a failure is never kept; nor an answer `keep` turns down", async () => {
  const c = fresh({ keep: (v) => v !== "not yet" });
  await assert.rejects(c.get("f", async () => { throw new Error("down"); }));
  assert.equal(await c.get("f", async () => "ok"), "ok");
  assert.equal(await c.get("p", async () => "not yet"), "not yet");
  await Promise.resolve();
  assert.equal(await c.get("p", async () => "ready"), "ready", "turned down, so asked again");
});

test("forget(prefix) drops every key it starts", async () => {
  const c = fresh({ max: 10 });
  let reads = 0;
  const read = async () => `v${++reads}`;
  await c.get("p1:x", read);
  await c.get("p1:y", read);
  await c.get("p2:x", read);
  c.forget("p1:");
  assert.equal(c.size(), 1);
  assert.equal(await c.get("p2:x", read), "v3");
  assert.equal(await c.get("p1:x", read), "v4");
});
