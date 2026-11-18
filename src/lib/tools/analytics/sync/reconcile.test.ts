import assert from "node:assert/strict";
import test from "node:test";

import { reconcileArchive } from "./reconcile.ts";

/*
 * A table that answers the way PostgREST does: never more than 1,000 rows a
 * read, whatever range was asked for. Rows the platform still lists sit AFTER
 * the stale ones in storage order — the arrangement that hid the 484 — but
 * the reconcile must find them whatever the order.
 */
function table(ids: number[], cap = 1000) {
  const archived = new Set<number>();
  const calls: number[][] = [];
  return {
    archived,
    calls,
    readLive: async (from: number, to: number) => {
      const live = ids.filter((id) => !archived.has(id)).sort((a, b) => a - b);
      return { data: live.slice(from, Math.min(to + 1, from + cap)), error: null };
    },
    archive: async (keys: number[]) => {
      calls.push(keys);
      for (const k of keys) archived.add(k);
      return { error: null };
    },
  };
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

test("archives every row the platform stopped listing, past the first 1,000", async () => {
  // 3,482 shown; the platform lists 2,998 of them; the 484 gone are spread through the id range.
  const all = range(1, 3482);
  const gone = new Set(all.filter((id) => id % 7 === 0 || id > 3400).slice(0, 484));
  assert.equal(gone.size, 484);
  const t = table(all);
  const seen = new Set(all.filter((id) => !gone.has(id)));

  const r = await reconcileArchive({ seen, readLive: t.readLive, archive: t.archive });

  assert.deepEqual(r, { live: 3482, stale: 484, archived: 484, suspicious: false });
  assert.deepEqual([...t.archived].sort((a, b) => a - b), [...gone].sort((a, b) => a - b));
  // Chunks of 200, so no single request carries the whole list.
  assert.deepEqual(t.calls.map((c) => c.length), [200, 200, 84]);
});

test("a stale row that sits beyond row 1,000 is found (the case that hid them)", async () => {
  const all = range(1, 2500);
  const t = table(all);
  const seen = new Set(all.filter((id) => id !== 2400));
  const r = await reconcileArchive({ seen, readLive: t.readLive, archive: t.archive });
  assert.equal(r.archived, 1);
  assert.ok(t.archived.has(2400));
});

test("a walk listing under half of what is shown archives nothing", async () => {
  const all = range(1, 3482);
  const t = table(all);
  // 1,700 listed of 3,482 — fewer than half. Measured against all 3,482, not the first 1,000.
  const r = await reconcileArchive({ seen: new Set(range(1, 1700)), readLive: t.readLive, archive: t.archive });
  assert.equal(r.suspicious, true);
  assert.equal(r.archived, 0);
  assert.equal(t.calls.length, 0);
});

test("nothing stale: nothing archived, no write at all", async () => {
  const all = range(1, 1500);
  const t = table(all);
  const r = await reconcileArchive({ seen: new Set(all), readLive: t.readLive, archive: t.archive });
  assert.deepEqual(r, { live: 1500, stale: 0, archived: 0, suspicious: false });
  assert.equal(t.calls.length, 0);
});

test("an exact multiple of the page size still ends", async () => {
  const all = range(1, 2000);
  const t = table(all);
  const r = await reconcileArchive({ seen: new Set(range(1, 1999)), readLive: t.readLive, archive: t.archive });
  assert.equal(r.live, 2000);
  assert.equal(r.archived, 1);
});

test("a failed read archives nothing and says why", async () => {
  let wrote = false;
  await assert.rejects(
    reconcileArchive({
      seen: new Set([1]),
      readLive: async (from) => (from === 0 ? { data: range(1, 1000), error: null } : { data: null, error: new Error("timeout") }),
      archive: async () => { wrote = true; return { error: null }; },
    }),
    /timeout/,
  );
  assert.equal(wrote, false);
});

test("a failed archive is reported, not swallowed", async () => {
  await assert.rejects(
    reconcileArchive({
      seen: new Set(range(1, 9)),
      readLive: async () => ({ data: range(1, 10), error: null }),
      archive: async () => ({ error: new Error("permission denied") }),
    }),
    /permission denied/,
  );
});

test("works for keys that are addresses (Instantly)", async () => {
  const live = ["a@x.com", "b@x.com", "c@x.com"];
  const archived: string[] = [];
  const r = await reconcileArchive({
    seen: new Set(["a@x.com", "c@x.com"]),
    readLive: async (from, to) => ({ data: live.slice(from, to + 1), error: null }),
    archive: async (keys) => { archived.push(...keys); return { error: null }; },
  });
  assert.equal(r.archived, 1);
  assert.deepEqual(archived, ["b@x.com"]);
});
