import assert from "node:assert/strict";
import { test } from "node:test";

import { tickOnce, type ReconcileTickDeps } from "./scheduler";

/*
 * The decision table for the drift check's clock.
 *
 * The properties worth pinning are the ones that decide whether this is an
 * improvement or a nuisance: it runs once a day and not once per tick, an
 * unturned switch does nothing at all, and a run that throws does not turn into
 * a five-minute retry loop against four production databases.
 */

const at = (iso: string): Date => new Date(iso);

function spy(overrides: Partial<ReconcileTickDeps> = {}) {
  const calls: Array<{ send: boolean; always: boolean }> = [];
  const deps: ReconcileTickDeps = {
    enabled: () => true,
    hour: () => 13,
    send: () => false,
    run: async (options) => {
      calls.push(options);
      return {};
    },
    ...overrides,
  };
  return { deps, calls };
}

const fresh = () => ({ lastRanAt: null as Date | null, running: false });

test("an unturned switch does nothing and never reads a database", async () => {
  const { deps, calls } = spy({ enabled: () => false });
  const decision = await tickOnce(at("2026-09-25T13:00:00Z"), deps, fresh());
  assert.equal(decision, "disabled");
  assert.equal(calls.length, 0);
});

test("before the hour it does not run", async () => {
  const { deps, calls } = spy();
  assert.equal(await tickOnce(at("2026-09-25T12:59:00Z"), deps, fresh()), "not-due");
  assert.equal(calls.length, 0);
});

test("at the hour it runs once, and later ticks that day do not run again", async () => {
  const { deps, calls } = spy();
  const state = fresh();
  assert.equal(await tickOnce(at("2026-09-25T13:00:00Z"), deps, state), "ran");
  assert.equal(await tickOnce(at("2026-09-25T13:05:00Z"), deps, state), "not-due");
  assert.equal(await tickOnce(at("2026-09-25T23:55:00Z"), deps, state), "not-due");
  assert.equal(calls.length, 1, "a day of five-minute ticks must produce ONE run");
});

test("it runs again the next day", async () => {
  const { deps, calls } = spy();
  const state = fresh();
  await tickOnce(at("2026-09-25T13:00:00Z"), deps, state);
  assert.equal(await tickOnce(at("2026-09-26T13:00:00Z"), deps, state), "ran");
  assert.equal(calls.length, 2);
});

test("a tick that lands while a run is still going is refused", async () => {
  const { deps } = spy();
  const state = { lastRanAt: null as Date | null, running: true };
  assert.equal(await tickOnce(at("2026-09-25T13:00:00Z"), deps, state), "running");
});

test("a run that throws is not retried until tomorrow", async () => {
  // The important half of this: `error` must not leave the day unstamped, or
  // every tick for the rest of the day re-reads four databases.
  let attempts = 0;
  const { deps } = spy({
    run: async () => {
      attempts += 1;
      throw new Error("status reader exploded");
    },
  });
  const state = fresh();
  assert.equal(await tickOnce(at("2026-09-25T13:00:00Z"), deps, state), "error");
  assert.equal(await tickOnce(at("2026-09-25T13:05:00Z"), deps, state), "not-due");
  assert.equal(attempts, 1);
  assert.equal(state.running, false, "the running flag must be released on failure");
});

test("the send switch is passed through, and is off by default", async () => {
  const quiet = spy({ send: () => false });
  await tickOnce(at("2026-09-25T13:00:00Z"), quiet.deps, fresh());
  assert.deepEqual(quiet.calls, [{ send: false, always: false }]);

  const loud = spy({ send: () => true });
  await tickOnce(at("2026-09-25T13:00:00Z"), loud.deps, fresh());
  assert.deepEqual(loud.calls, [{ send: true, always: false }]);
});

test("a scheduled run never asks for the all-clear message", async () => {
  // `always=1` is a thing a person asks for on the route. A daily "everything
  // agrees" from the scheduler is how a channel gets muted.
  const { deps, calls } = spy({ send: () => true });
  await tickOnce(at("2026-09-25T13:00:00Z"), deps, fresh());
  assert.equal(calls[0].always, false);
});

test("the configured hour is respected, not the default", async () => {
  const { deps, calls } = spy({ hour: () => 6 });
  const state = fresh();
  assert.equal(await tickOnce(at("2026-09-25T05:59:00Z"), deps, state), "not-due");
  assert.equal(await tickOnce(at("2026-09-25T06:00:00Z"), deps, state), "ran");
  assert.equal(calls.length, 1);
});
