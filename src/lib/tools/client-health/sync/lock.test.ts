/*
 * One sync at a time.
 *
 *   node --import ./scripts/alias-hooks.mjs --test src/lib/tools/client-health/sync/lock.test.ts
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { _resetSyncLockForTests, syncLockState, withSyncLock } from "./lock.ts";

beforeEach(() => _resetSyncLockForTests());

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("a second trigger while one runs is refused, not queued", async () => {
  const first = deferred<string>();
  let secondRan = false;

  const a = withSyncLock("manual", () => first.promise, () => new Date("2026-09-15T14:00:00Z"));
  assert.ok(a, "first acquires");
  assert.deepEqual(syncLockState(), { running: true, startedAt: new Date("2026-09-15T14:00:00Z"), reason: "manual" });

  const b = withSyncLock("scheduled", async () => { secondRan = true; return "b"; });
  assert.equal(b, null, "second is refused");
  assert.equal(secondRan, false, "and its work never started");

  first.resolve("a");
  assert.equal(await a, "a");
  assert.equal(syncLockState().running, false, "released when the run settles");
});

test("the lock is released when the run THROWS, so one failure cannot wedge every later sync", async () => {
  const a = withSyncLock("manual", async () => { throw new Error("upstream down"); });
  await assert.rejects(a!, /upstream down/);
  assert.equal(syncLockState().running, false);
  assert.ok(withSyncLock("manual", async () => 1), "acquirable again");
});

test("idle state is empty", () => {
  assert.deepEqual(syncLockState(), { running: false, startedAt: null, reason: null });
});
