/* The Tickets list, newest first in every view (23 Nov, the team: new incoming ones were at the bottom). */
import { test } from "node:test";
import assert from "node:assert/strict";

const { order } = await import("./service.ts");
const fake = () => { const calls: Array<[string, Record<string, unknown>]> = []; const q: Record<string, unknown> = { order: (col: string, o: Record<string, unknown>) => { calls.push([col, o]); return q; } }; return { q, calls }; };

test("Open, Mine and Unassigned: the newest waiting client email first", () => {
  for (const view of ["open", "mine", "unassigned"] as const) {
    const { q, calls } = fake();
    order(q as never, view);
    assert.deepEqual(calls[0], ["waiting_since", { ascending: false, nullsFirst: false }], view);
  }
});

test("All and Done newest first too; Snoozed soonest to wake first", () => {
  let f = fake(); order(f.q as never, "all"); assert.deepEqual(f.calls[0], ["last_activity_at", { ascending: false }]);
  f = fake(); order(f.q as never, "done"); assert.deepEqual(f.calls[0][1], { ascending: false, nullsFirst: false });
  f = fake(); order(f.q as never, "snoozed"); assert.deepEqual(f.calls[0], ["snoozed_until", { ascending: true }]);
});
