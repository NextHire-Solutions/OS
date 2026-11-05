import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { EmailBisonApiError } from "../emailbison/errors.ts";

import {
  ASK_INBOXES_UP_TO,
  checkSelection,
  inboxesInTargets,
  isOpenStatus,
  planRemoval,
  REMOVE_CHUNK,
  removeFromCampaign,
  runTargets,
  wouldStopSending,
  type OpenCampaign,
  type Overlaps,
  type RemovalDeps,
} from "./inbox-removal.ts";

/* ------------------------------------------------------------ the check --- */

const OPEN: OpenCampaign[] = [
  { id: 1, name: "Bravo", status: "paused", inboxes: 10 },
  { id: 2, name: "Alpha", status: "active", inboxes: 3 },
  { id: 3, name: "Empty draft", status: "draft", inboxes: 0 },
];

const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

test("a small selection asks the inboxes, a few at a time, and only open campaigns count", async () => {
  const asked: number[][] = [];
  const read: number[] = [];
  const BIG = OPEN.map((c) => (c.id === 1 ? { ...c, inboxes: 1630 } : c));
  const out = await checkSelection(ids(7), BIG, {
    byInbox: async (part) => {
      asked.push(part);
      // Inbox 2 is on an open campaign and a finished one; finished ones aren't in OPEN.
      return Object.fromEntries(part.map((id) => [String(id), id === 2 ? [1, 999] : id === 6 ? [2] : []]));
    },
    // Only a campaign left with few is read, for whether they can send. Campaign 1 keeps 9, and that's few here.
    overlap: async (c, list) => { read.push(c.id); assert.equal(c.id, 2); return { on: list, total: 3, leftConnected: 2 }; },
  });
  assert.deepEqual(asked, [[1, 2, 3, 4, 5], [6, 7]]);
  assert.deepEqual(read, [2], "a campaign keeping plenty isn't read");
  assert.deepEqual([...out!.entries()], [[1, { on: [2], total: 1630, leftConnected: null }], [2, { on: [6], total: 3, leftConnected: 2 }]]);
});

test("a large selection reads each campaign holding anything, and takes the total from that read", async () => {
  const read: number[] = [];
  const out = await checkSelection(ids(ASK_INBOXES_UP_TO + 1), OPEN, {
    byInbox: async () => { throw new Error("a large selection asks no inbox"); },
    overlap: async (c) => { read.push(c.id); return c.id === 1 ? { on: [4, 5], total: 12, leftConnected: 9 } : { on: [], total: 3, leftConnected: 3 }; },
  });
  assert.deepEqual(read.sort(), [1, 2], "an empty campaign isn't read");
  assert.deepEqual([...out!.entries()], [[1, { on: [4, 5], total: 12, leftConnected: 9 }]], "a campaign holding none of them isn't in it");
});

test("exactly the limit still asks the inboxes", async () => {
  let asks = 0;
  await checkSelection(ids(ASK_INBOXES_UP_TO), OPEN, { byInbox: async () => { asks++; return {}; }, overlap: async () => ({ on: [], total: 0, leftConnected: 0 }) });
  assert.equal(asks, Math.ceil(ASK_INBOXES_UP_TO / 5));
});

test("it says how far it has got, and stops as soon as it's cancelled", async () => {
  const seen: Array<[number, number, string]> = [];
  await checkSelection(ids(6), OPEN, { byInbox: async () => ({}), overlap: async () => ({ on: [], total: 0, leftConnected: 0 }) }, { onProgress: (p) => seen.push([p.done, p.total, p.unit]) });
  assert.deepEqual(seen, [[0, 6, "inbox"], [5, 6, "inbox"], [6, 6, "inbox"]]);

  let asks = 0;
  let cancel = false;
  const out = await checkSelection(ids(12), OPEN, { byInbox: async () => { asks++; cancel = true; return {}; }, overlap: async () => ({ on: [], total: 0, leftConnected: 0 }) }, { cancelled: () => cancel });
  assert.equal(out, null);
  assert.equal(asks, 1);

  let reads = 0;
  let stop = false;
  const large = await checkSelection(ids(40), OPEN, { byInbox: async () => ({}), overlap: async () => { reads++; stop = true; return { on: [1], total: 5, leftConnected: 4 }; } }, { cancelled: () => stop });
  assert.equal(large, null);
  assert.ok(reads <= 2);
});

test("a failed read stops the check rather than reporting a campaign as holding nothing", async () => {
  await assert.rejects(() => checkSelection(ids(2), OPEN, { byInbox: async () => { throw new Error("no answer"); }, overlap: async () => ({ on: [], total: 0, leftConnected: 0 }) }), /no answer/);
  await assert.rejects(() => checkSelection(ids(40), OPEN, { byInbox: async () => ({}), overlap: async () => { throw new Error("no answer"); } }), /no answer/);
});

/* ------------------------------------------------------------- the plan --- */

test("what can't be left empty is left alone; active waits for the tick; the rest changes", () => {
  const campaigns: OpenCampaign[] = [
    { id: 1, name: "Zed paused", status: "paused", inboxes: 10 },
    { id: 2, name: "Alpha draft", status: "draft", inboxes: 5 },
    { id: 3, name: "Running", status: "active", inboxes: 4 },
    { id: 4, name: "Starting", status: "queued", inboxes: 4 },
    { id: 5, name: "Last ones", status: "paused", inboxes: 2 },
    { id: 6, name: "Last on active", status: "active", inboxes: 1 },
    { id: 7, name: "Holds none", status: "paused", inboxes: 9 },
  ];
  const overlaps: Overlaps = new Map([
    [1, { on: [1, 2], total: 10, leftConnected: null }],
    [2, { on: [1], total: 5, leftConnected: 4 }],
    [3, { on: [2], total: 4, leftConnected: 0 }],
    [4, { on: [2], total: 4, leftConnected: 3 }],
    [5, { on: [1, 2], total: 2, leftConnected: 0 }],
    [6, { on: [3], total: 1, leftConnected: 0 }],
  ]);
  const plan = planRemoval([1, 2, 3, 4, 5], campaigns, overlaps);
  assert.deepEqual(plan.change.map((r) => [r.name, r.inboxIds.length, r.left]), [["Alpha draft", 1, 4], ["Zed paused", 2, 8]]);
  assert.deepEqual(plan.active.map((r) => [r.name, r.left]), [["Running", 3], ["Starting", 3]]);
  assert.deepEqual(plan.keep.map((r) => [r.name, r.left]), [["Last on active", 0], ["Last ones", 0]]);
  assert.equal(plan.onSomething, 3);
  assert.equal(plan.onNothing, 2);

  assert.deepEqual(runTargets(plan, false).map((r) => r.id), [2, 1], "without the tick, no active campaign and nothing being left empty");
  assert.deepEqual(runTargets(plan, true).map((r) => r.id), [2, 1, 3, 4], "with it, still nothing being left empty");
  assert.equal(inboxesInTargets(runTargets(plan, false)), 2, "an inbox on two campaigns is one inbox");
});

test("uses the count from the campaign's own read, not the list's: it may be fresher", () => {
  const plan = planRemoval([1], [{ id: 1, name: "A", status: "paused", inboxes: 1 }], new Map([[1, { on: [1], total: 5, leftConnected: null }]]));
  assert.equal(plan.change[0].left, 4);
  assert.equal(plan.keep.length, 0);
});

test("only open statuses: finished and archived campaigns aren't looked at", () => {
  for (const s of ["draft", "paused", "active", "queued", "launching", "PAUSED", " active "]) assert.equal(isOpenStatus(s), true, s);
  for (const s of ["completed", "archived", "", null, undefined, "pending"]) assert.equal(isOpenStatus(s), false, String(s));
});

/* -------------------------------------------------------------- the run --- */

/** A campaign as EmailBison behaves, recording every call. */
function fake(start: { status?: string; inboxes?: number[] } = {}) {
  const c = { status: start.status ?? "paused", inboxes: new Set(start.inboxes ?? ids(10)) };
  const calls: string[] = [];
  const faults: { remove?: unknown; pause?: unknown; resume?: unknown[]; status?: unknown; count?: unknown; countAfter?: unknown; silentRemove?: boolean; pauseNeverTakes?: boolean } = {};
  const deps: RemovalDeps = {
    status: async () => { calls.push("status"); if (faults.status) throw faults.status; return c.status; },
    count: async () => {
      calls.push("count");
      if (faults.count) throw faults.count;
      if (faults.countAfter && calls.includes("remove")) throw faults.countAfter;
      return c.inboxes.size;
    },
    remove: async (_id, list) => {
      calls.push("remove");
      if (faults.remove) throw faults.remove;
      if (c.status !== "draft" && c.status !== "paused") throw new EmailBisonApiError("The campaign must be in a draft or paused state to remove sender emails", 422, null);
      const bad = list.map((id, i) => (c.inboxes.has(id) ? -1 : i)).filter((i) => i >= 0);
      if (bad.length) throw new EmailBisonApiError("invalid", 422, { errors: Object.fromEntries(bad.map((i) => [`sender_email_ids.${i}`, [`The selected sender_email_ids.${i} is invalid.`]])) });
      if (!faults.silentRemove) for (const id of list) c.inboxes.delete(id);
    },
    pause: async () => { calls.push("pause"); if (faults.pause) throw faults.pause; if (!faults.pauseNeverTakes) c.status = "paused"; },
    resume: async () => {
      calls.push("resume");
      const next = faults.resume?.shift();
      if (next) throw next;
      c.status = "queued";
    },
    wait: async () => undefined,
  };
  return { c, calls, faults, deps };
}
const writes = (calls: string[]) => calls.filter((x) => ["remove", "pause", "resume"].includes(x));

for (const status of ["paused", "draft"]) {
  test(`a ${status} campaign: taken off, counted, and never paused or started`, async () => {
    const f = fake({ status });
    const r = await removeFromCampaign(f.deps, { campaignId: 7, inboxIds: [1, 2, 3], pauseActive: false });
    assert.deepEqual(writes(f.calls), ["remove"]);
    assert.deepEqual(
      { ok: r.ok, outcome: r.outcome, applied: r.applied, before: r.before, left: r.left, paused: r.paused, stillPaused: r.stillPaused, removedIds: r.removedIds },
      { ok: true, outcome: "removed", applied: 3, before: 10, left: 7, paused: false, stillPaused: false, removedIds: [1, 2, 3] },
    );
    assert.equal(f.c.status, status, "its status is what it was");
  });
}

for (const status of ["active", "queued", "launching", "ACTIVE"]) {
  test(`${status}, tick off: not touched at all`, async () => {
    const f = fake({ status });
    const r = await removeFromCampaign(f.deps, { campaignId: 7, inboxIds: [1], pauseActive: false });
    assert.deepEqual(writes(f.calls), []);
    assert.equal(r.outcome, "active");
    assert.equal(r.ok, true);
    assert.equal(f.c.inboxes.size, 10);
  });

  test(`${status}, tick on: paused, then taken off, then started again, in that order`, async () => {
    const f = fake({ status });
    const r = await removeFromCampaign(f.deps, { campaignId: 7, inboxIds: [1, 2], pauseActive: true });
    assert.deepEqual(writes(f.calls), ["pause", "remove", "resume"]);
    assert.equal(r.outcome, "removed");
    assert.equal(r.paused, true);
    assert.equal(r.stillPaused, false);
    assert.equal(r.applied, 2);
    assert.equal(f.c.status, "queued", "sending again");
  });
}

test("a paused campaign stays paused even with the tick on: only what this run paused is started again", async () => {
  const f = fake({ status: "paused" });
  const r = await removeFromCampaign(f.deps, { campaignId: 7, inboxIds: [1], pauseActive: true });
  assert.deepEqual(writes(f.calls), ["remove"]);
  assert.equal(r.paused, false);
  assert.equal(f.c.status, "paused");
});

for (const status of ["completed", "archived"]) {
  for (const pauseActive of [true, false]) {
    test(`${status} since the check, tick ${pauseActive ? "on" : "off"}: not touched, and said to be finished`, async () => {
      const f = fake({ status });
      const r = await removeFromCampaign(f.deps, { campaignId: 7, inboxIds: [1], pauseActive });
      assert.deepEqual(writes(f.calls), []);
      assert.equal(r.outcome, "finished");
    });
  }
}

test("NEVER EMPTY: a fresh count says these are all it holds, and nothing happens, tick or no tick", async () => {
  const paused = fake({ status: "paused", inboxes: [1, 2] });
  const r = await removeFromCampaign(paused.deps, { campaignId: 7, inboxIds: [1, 2], pauseActive: false });
  assert.equal(r.outcome, "last");
  assert.deepEqual(writes(paused.calls), []);
  assert.equal(paused.c.inboxes.size, 2);

  const active = fake({ status: "active", inboxes: [1, 2] });
  const a = await removeFromCampaign(active.deps, { campaignId: 7, inboxIds: [1, 2], pauseActive: true });
  assert.equal(a.outcome, "last");
  assert.deepEqual(writes(active.calls), [], "not even paused");
  assert.equal(active.c.status, "active");

  // One left is allowed.
  const one = fake({ status: "paused", inboxes: [1, 2, 3] });
  assert.equal((await removeFromCampaign(one.deps, { campaignId: 7, inboxIds: [1, 2], pauseActive: false })).outcome, "removed");
  assert.equal(one.c.inboxes.size, 1);
});

test("the same id twice counts once, so a campaign isn't kept for a duplicate", async () => {
  const f = fake({ status: "paused", inboxes: [1, 2] });
  const r = await removeFromCampaign(f.deps, { campaignId: 7, inboxIds: [1, 1], pauseActive: false });
  assert.equal(r.outcome, "removed");
  assert.deepEqual(r.removedIds, [1]);
});

test("long lists go in chunks, and every one of them comes off", async () => {
  const all = ids(REMOVE_CHUNK * 2 + 10);
  const f = fake({ status: "paused", inboxes: [...all, 99_999] });
  const r = await removeFromCampaign(f.deps, { campaignId: 7, inboxIds: all, pauseActive: false });
  assert.equal(f.calls.filter((x) => x === "remove").length, 3);
  assert.equal(r.applied, all.length);
  assert.equal(r.left, 1);
});

test("an inbox no longer on it refuses the whole call: it's dropped, and the rest still come off", async () => {
  const f = fake({ status: "paused", inboxes: [1, 3, 5, 6] });
  const r = await removeFromCampaign(f.deps, { campaignId: 7, inboxIds: [1, 2, 3], pauseActive: false });
  assert.deepEqual(r.removedIds, [1, 3]);
  assert.equal(r.applied, 2);
  assert.equal(r.outcome, "removed");
  assert.deepEqual([...f.c.inboxes], [5, 6]);
});

test("none of them on it any more: what was asked for is already so, and it isn't a failure", async () => {
  const f = fake({ status: "paused", inboxes: [7, 8, 9] });
  const r = await removeFromCampaign(f.deps, { campaignId: 7, inboxIds: [1, 2], pauseActive: false });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "nothing");
  assert.equal(r.applied, 0);
});

test("EmailBison's refusal comes back in its own words, and an active campaign is still started again", async () => {
  const f = fake({ status: "active" });
  f.faults.remove = new EmailBisonApiError("Something upstream broke", 500, { message: "Something upstream broke" });
  const r = await removeFromCampaign(f.deps, { campaignId: 7, inboxIds: [1], pauseActive: true });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "failed");
  assert.match(String(r.error), /Something upstream broke/);
  assert.deepEqual(writes(f.calls), ["pause", "remove", "resume"]);
  assert.equal(f.c.status, "queued");
  assert.equal(r.stillPaused, false);
});

test("a failure part way: the next chunks aren't tried, and what did come off is counted from the campaign", async () => {
  const all = ids(REMOVE_CHUNK + 5);
  const f = fake({ status: "paused", inboxes: [...all, 99_999] });
  let n = 0;
  const remove = f.deps.remove;
  f.deps.remove = async (id, list) => {
    if (++n === 2) throw new EmailBisonApiError("Later chunk refused", 500, { message: "Later chunk refused" });
    return remove(id, list);
  };
  const r = await removeFromCampaign(f.deps, { campaignId: 7, inboxIds: all, pauseActive: false });
  assert.equal(r.ok, false);
  assert.equal(r.applied, REMOVE_CHUNK);
  assert.equal(r.left, 6);
  assert.equal(n, 2);
});

test("couldn't pause: nothing removed, nothing to start again", async () => {
  const f = fake({ status: "active" });
  f.faults.pause = new EmailBisonApiError("No pausing today", 500, { message: "No pausing today" });
  const r = await removeFromCampaign(f.deps, { campaignId: 7, inboxIds: [1], pauseActive: true });
  assert.equal(r.outcome, "failed");
  assert.match(String(r.error), /No pausing today/);
  assert.deepEqual(writes(f.calls), ["pause"]);
  assert.equal(r.paused, false);
  assert.equal(f.c.inboxes.size, 10);
});

test("it never shows as paused: nothing removed, nothing started, and someone is told to check it", async () => {
  const f = fake({ status: "active" });
  f.faults.pauseNeverTakes = true;
  const r = await removeFromCampaign(f.deps, { campaignId: 7, inboxIds: [1], pauseActive: true });
  assert.equal(r.outcome, "failed");
  assert.equal(r.unsure, true);
  assert.equal(r.paused, false);
  assert.match(String(r.error), /didn't pause in time.*check it/);
  assert.deepEqual(writes(f.calls), ["pause"], "RESUME IS NOT AN UNDO: only what was seen paused is started");
  assert.equal(f.c.inboxes.size, 10);
});

test("a pause whose answer was lost, that did go through: carried on, and started again, not left paused unmentioned", async () => {
  const f = fake({ status: "active" });
  f.deps.pause = async () => { f.calls.push("pause"); f.c.status = "paused"; throw new Error("socket hang up"); };
  const r = await removeFromCampaign(f.deps, { campaignId: 7, inboxIds: [1, 2], pauseActive: true });
  assert.deepEqual(writes(f.calls), ["pause", "remove", "resume"]);
  assert.equal(r.ok, true);
  assert.equal(r.paused, true);
  assert.equal(f.c.status, "queued");
});

test("a pause with a lost answer and no way to read it: it may be paused, and it's said so", async () => {
  const f = fake({ status: "active" });
  let reads = 0;
  const status = f.deps.status;
  f.deps.status = async (id) => { if (++reads > 1) throw new Error("no answer"); return status(id); };
  f.deps.pause = async () => { f.calls.push("pause"); throw new Error("socket hang up"); };
  const r = await removeFromCampaign(f.deps, { campaignId: 7, inboxIds: [1], pauseActive: true });
  assert.equal(r.unsure, true);
  assert.equal(r.ok, false);
  assert.match(String(r.error), /may still pause: check it/);
  assert.deepEqual(writes(f.calls), ["pause"]);
});

test("a finished campaign can't be started by this: read as finished right before the pause, it's never paused", async () => {
  const f = fake({ status: "active" });
  // It finishes after the count, and the status is read after the count.
  const count = f.deps.count;
  f.deps.count = async (id) => { const n = await count(id); f.c.status = "completed"; return n; };
  const r = await removeFromCampaign(f.deps, { campaignId: 7, inboxIds: [1], pauseActive: true });
  assert.equal(r.outcome, "finished");
  assert.deepEqual(writes(f.calls), []);
});

test("it finishes between the pause and the check: nothing removed and it is NOT started", async () => {
  const f = fake({ status: "active" });
  f.deps.pause = async () => { f.calls.push("pause"); f.c.status = "completed"; };
  const r = await removeFromCampaign(f.deps, { campaignId: 7, inboxIds: [1], pauseActive: true });
  assert.deepEqual(writes(f.calls), ["pause"]);
  assert.equal(r.unsure, true);
});

test("start again answered yes, but it still reads paused: reported as still paused", async () => {
  const f = fake({ status: "active" });
  f.deps.resume = async () => { f.calls.push("resume"); };
  const r = await removeFromCampaign(f.deps, { campaignId: 7, inboxIds: [1], pauseActive: true });
  assert.equal(r.stillPaused, true);
  assert.equal(r.ok, false);
  assert.match(String(r.error), /still paused/);
});

test("just before pausing there's a chance to put it on the record, with the status it had", async () => {
  const f = fake({ status: "active" });
  const seen: string[] = [];
  f.deps.beforePause = async (_id, status) => { seen.push(`${status}/${f.calls.includes("pause") ? "after" : "before"}`); };
  await removeFromCampaign(f.deps, { campaignId: 7, inboxIds: [1], pauseActive: true });
  assert.deepEqual(seen, ["active/before"]);
  const g = fake({ status: "paused" });
  let called = 0;
  g.deps.beforePause = async () => { called++; };
  await removeFromCampaign(g.deps, { campaignId: 7, inboxIds: [1], pauseActive: true });
  assert.equal(called, 0);
});

/* What EmailBison really does on a paused campaign (measured 5 Nov): "sent for deletion", and the list changes seconds later. */
function later(f: ReturnType<typeof fake>, reads: number) {
  const remove = f.deps.remove;
  const pending: Array<{ due: number; ids: number[] }> = [];
  let clock = 0;
  const count = f.deps.count;
  f.deps.remove = async (id, list) => {
    f.calls.push("remove");
    if (f.c.status !== "draft" && f.c.status !== "paused") return remove(id, list);
    pending.push({ due: clock + reads, ids: list });
  };
  f.deps.count = async (id) => {
    clock++;
    for (const p of pending.splice(0)) {
      if (p.due <= clock) for (const i of p.ids) f.c.inboxes.delete(i);
      else pending.push(p);
    }
    return count(id);
  };
  return () => f.c.inboxes.size;
}

test("a paused campaign's removal lands a moment later: waited for, and not called a failure", async () => {
  const f = fake({ status: "paused" });
  later(f, 3);
  const r = await removeFromCampaign(f.deps, { campaignId: 7, inboxIds: [1, 2], pauseActive: false });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "removed");
  assert.equal(r.applied, 2);
  assert.equal(r.left, 8);
});

test("an active campaign is started again only once the inboxes have really come off", async () => {
  const f = fake({ status: "active" });
  const size = later(f, 3);
  const atResume: number[] = [];
  const resume = f.deps.resume;
  f.deps.resume = async (id) => { atResume.push(size()); return resume(id); };
  const r = await removeFromCampaign(f.deps, { campaignId: 7, inboxIds: [1, 2], pauseActive: true });
  assert.deepEqual(atResume, [8], "2 off before it starts again");
  assert.equal(r.ok, true);
  assert.equal(r.applied, 2);
  assert.equal(f.c.status, "queued");
});

test("each call is waited for before the next, so the never-empty count is a true one", async () => {
  const all = ids(REMOVE_CHUNK + 5);
  const f = fake({ status: "paused", inboxes: [...all, 99_999] });
  later(f, 2);
  const sizes: number[] = [];
  const remove = f.deps.remove;
  f.deps.remove = async (id, list) => { sizes.push(f.c.inboxes.size); return remove(id, list); };
  const r = await removeFromCampaign(f.deps, { campaignId: 7, inboxIds: all, pauseActive: false });
  assert.deepEqual(sizes, [REMOVE_CHUNK + 6, 6], "the second call only after the first has landed");
  assert.equal(r.applied, all.length);
  assert.equal(r.left, 1);
});

test("it never shows: not held paused for ever, and said plainly, with what did come off", async () => {
  const f = fake({ status: "active" });
  later(f, 10_000);
  const r = await removeFromCampaign(f.deps, { campaignId: 7, inboxIds: [1, 2], pauseActive: true });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /still holds every one/);
  assert.equal(f.c.status, "queued", "it was sending, so it goes back to sending");
  assert.equal(r.stillPaused, false);

  // Part of it landed.
  const g = fake({ status: "paused" });
  const count = g.deps.count;
  let n = 0;
  g.deps.remove = async () => { g.calls.push("remove"); g.c.inboxes.delete(1); };
  g.deps.count = async (id) => { n++; return count(id); };
  const part = await removeFromCampaign(g.deps, { campaignId: 7, inboxIds: [1, 2], pauseActive: false });
  assert.equal(part.ok, false);
  assert.match(String(part.error), /hadn't finished taking them off/);
  assert.equal(part.applied, 1);
  assert.ok(n > 5, "it did wait");
});

test("NEVER EMPTY, again before every call: someone else takes inboxes off meanwhile, and it stops", async () => {
  // Before anything is sent.
  const first = fake({ status: "active", inboxes: [1, 2, 3, 4] });
  const pause = first.deps.pause;
  first.deps.pause = async (id) => { await pause(id); first.c.inboxes.delete(3); first.c.inboxes.delete(4); };
  const a = await removeFromCampaign(first.deps, { campaignId: 7, inboxIds: [1, 2], pauseActive: true });
  assert.equal(a.outcome, "last");
  assert.deepEqual(writes(first.calls), ["pause", "resume"], "it was paused, so it is started again; nothing came off");
  assert.equal(first.c.inboxes.size, 2);

  // Part way through.
  const all = ids(REMOVE_CHUNK + 5);
  const second = fake({ status: "paused", inboxes: [...all, 99_998, 99_999] });
  const remove = second.deps.remove;
  second.deps.remove = async (id, list) => { await remove(id, list); second.c.inboxes.delete(99_998); second.c.inboxes.delete(99_999); };
  const b = await removeFromCampaign(second.deps, { campaignId: 7, inboxIds: all, pauseActive: false });
  assert.equal(b.ok, false);
  assert.match(String(b.error), /Stopped part way/);
  assert.equal(second.c.inboxes.size, 5, "the rest stay on it");
});

test("a campaign left with inboxes that can't connect is picked out: not empty, but it stops sending", () => {
  const row = (id: number, left: number, leftConnected: number | null) => ({ id, name: `C${id}`, status: "paused", inboxIds: [1], total: left + 1, left, leftConnected });
  assert.deepEqual(wouldStopSending([row(1, 2, 0), row(2, 2, 1), row(3, 900, null), row(4, 0, 0)]).map((r) => r.id), [1]);
});

test("one failed read ends the check: the others stop too, and say nothing more", async () => {
  const seen: number[] = [];
  let reads = 0;
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const many: OpenCampaign[] = ids(20).map((id) => ({ id, name: `C${id}`, status: "paused", inboxes: 50 }));
  const running = checkSelection(ids(40), many, {
    byInbox: async () => ({}),
    overlap: async (c) => {
      reads++;
      if (c.id === 1) { release(); throw new Error("no answer"); }
      await held;
      await new Promise((r) => setTimeout(r, 5));
      return { on: [], total: 50, leftConnected: 50 };
    },
  }, { onProgress: (p) => seen.push(p.done) });
  await assert.rejects(running, /no answer/);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(seen.filter((n) => n > 0), [], "no progress after the failure, which would cover it up");
  assert.ok(reads <= 6, `only those in flight: ${reads}`);
});

test("starting again is tried more than once, and it's enough for one to work", async () => {
  const f = fake({ status: "active" });
  f.faults.resume = [new Error("blip")];
  const r = await removeFromCampaign(f.deps, { campaignId: 7, inboxIds: [1], pauseActive: true });
  assert.equal(r.stillPaused, false);
  assert.equal(r.ok, true);
  assert.equal(f.calls.filter((x) => x === "resume").length, 2);
});

test("it can't be started again: said plainly, as a failure, though the inboxes did come off", async () => {
  const f = fake({ status: "active" });
  f.faults.resume = [new Error("down"), new Error("down"), new Error("down")];
  const r = await removeFromCampaign(f.deps, { campaignId: 7, inboxIds: [1, 2], pauseActive: true });
  assert.equal(r.stillPaused, true);
  assert.equal(r.ok, false);
  assert.equal(r.applied, 2);
  assert.match(String(r.error), /still paused/);
  assert.equal(f.calls.filter((x) => x === "resume").length, 3);
});

test("a 200 that changed nothing isn't reported as done", async () => {
  const f = fake({ status: "paused" });
  f.faults.silentRemove = true;
  const r = await removeFromCampaign(f.deps, { campaignId: 7, inboxIds: [1, 2], pauseActive: false });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "failed");
  assert.equal(r.applied, 0);
  assert.match(String(r.error), /still holds every one/);
});

test("the count afterwards can't be read: the work stands, and left is unknown rather than guessed", async () => {
  const f = fake({ status: "paused" });
  f.faults.countAfter = new Error("blip");
  const r = await removeFromCampaign(f.deps, { campaignId: 7, inboxIds: [1, 2], pauseActive: false });
  assert.equal(r.ok, true);
  assert.equal(r.applied, 2);
  assert.equal(r.left, null);
});

test("nothing is touched if its status or its count can't be read first", async () => {
  const noStatus = fake({ status: "paused" });
  noStatus.faults.status = new Error("no status");
  const a = await removeFromCampaign(noStatus.deps, { campaignId: 7, inboxIds: [1], pauseActive: true });
  assert.equal(a.outcome, "failed");
  assert.deepEqual(writes(noStatus.calls), []);

  const noCount = fake({ status: "active" });
  noCount.faults.count = new Error("no count");
  const b = await removeFromCampaign(noCount.deps, { campaignId: 7, inboxIds: [1], pauseActive: true });
  assert.equal(b.outcome, "failed");
  assert.deepEqual(writes(noCount.calls), [], "not even paused");
});

test("the dialog holds on to the selection it opened with: the page behind re-renders, and a new array mustn't restart it", () => {
  const dialog = readFileSync("src/components/screens/analytics/remove-inboxes-dialog.tsx", "utf8");
  assert.match(dialog, /const \[inboxIds\] = useState\(selected\);/);
  assert.match(dialog, /\}, \[inboxIds\]\);/, "the check depends on that, not on the prop");
});
