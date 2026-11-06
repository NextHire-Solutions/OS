import { test } from "node:test";
import assert from "node:assert/strict";

import { EmailBisonApiError } from "../emailbison/errors.ts";

import { ADD_CHUNK, addSelection, addToCampaign, isAlreadyOn, type AddDeps } from "./inbox-add.ts";

/*
 * A campaign as EmailBison behaved on 6 Nov: an attach lands at once, adds whatever isn't on it yet, is refused with
 * "These emails already exist" when every one already is, and one unknown id refuses the whole call.
 */
function fakeCampaign(o: { status?: string; holds?: number[]; known?: number[] } = {}) {
  const c = { status: o.status ?? "active", holds: new Set(o.holds ?? []), calls: [] as number[][], failNext: null as unknown, countFails: false };
  const known = new Set(o.known ?? Array.from({ length: 2000 }, (_, i) => i + 1));
  const deps: AddDeps = {
    status: async () => c.status,
    count: async () => { if (c.countFails) throw new Error("count down"); return c.holds.size; },
    attach: async (_id, ids) => {
      c.calls.push([...ids]);
      if (c.failNext) { const e = c.failNext; c.failNext = null; throw e; }
      const bad = ids.map((id, i) => (known.has(id) ? -1 : i)).filter((i) => i >= 0);
      if (bad.length) throw new EmailBisonApiError("invalid", 422, { errors: Object.fromEntries(bad.map((i) => [`sender_email_ids.${i}`, [`The selected sender_email_ids.${i} is invalid.`]])) });
      if (ids.every((id) => c.holds.has(id))) throw new EmailBisonApiError("These emails already exist on this campaign (Test 1)", 200, { data: { success: false, message: "These emails already exist on this campaign (Test 1)" } });
      for (const id of ids) c.holds.add(id);
      return { data: { success: true, message: "Sender emails successfully added to Test 1" } };
    },
  };
  return { c, deps };
}

test("adds to an active campaign without pausing it, and reports by the campaign's own count", async () => {
  const { c, deps } = fakeCampaign({ status: "active", holds: [1, 2, 3] });
  const r = await addToCampaign(deps, { campaignId: 7, inboxIds: [10, 11, 12] });
  assert.deepEqual([r.ok, r.outcome, r.before, r.after, r.added, r.alreadyOn, r.dropped], [true, "added", 3, 6, 3, 0, 0]);
  assert.equal(c.status, "active", "never paused");
  assert.deepEqual(c.calls, [[10, 11, 12]]);
});

test("draft and paused campaigns are added to the same way", async () => {
  for (const status of ["draft", "paused", "queued", "launching"]) {
    const { deps } = fakeCampaign({ status });
    const r = await addToCampaign(deps, { campaignId: 7, inboxIds: [5] });
    assert.equal(r.outcome, "added", status);
    assert.equal(r.added, 1, status);
  }
});

test("some already on it: the rest go on, and the ones it had are counted as already on", async () => {
  const { deps } = fakeCampaign({ holds: [10, 11] });
  const r = await addToCampaign(deps, { campaignId: 7, inboxIds: [10, 11, 12, 13] });
  assert.deepEqual([r.outcome, r.added, r.alreadyOn, r.after], ["added", 2, 2, 4]);
});

test("all already on it: nothing to do, not a failure", async () => {
  const { deps } = fakeCampaign({ holds: [10, 11] });
  const r = await addToCampaign(deps, { campaignId: 7, inboxIds: [10, 11] });
  assert.deepEqual([r.ok, r.outcome, r.added, r.alreadyOn], [true, "nothing", 0, 2]);
});

test("one id EmailBison doesn't know: dropped, the rest added, and said", async () => {
  const { c, deps } = fakeCampaign({ known: [10, 12] });
  const r = await addToCampaign(deps, { campaignId: 7, inboxIds: [10, 11, 12] });
  assert.deepEqual([r.ok, r.outcome, r.added, r.dropped], [true, "added", 2, 1]);
  assert.deepEqual(c.calls, [[10, 11, 12], [10, 12]]);
});

test("a finished or archived campaign is left alone", async () => {
  for (const status of ["completed", "archived", "stopped", "failed"]) {
    const { c, deps } = fakeCampaign({ status });
    const r = await addToCampaign(deps, { campaignId: 7, inboxIds: [5] });
    assert.equal(r.outcome, "finished", status);
    assert.deepEqual(c.calls, [], status);
  }
});

test("any other refusal is a failure, in EmailBison's words, and what did go on is counted", async () => {
  const { c, deps } = fakeCampaign();
  const ids = Array.from({ length: ADD_CHUNK + 10 }, (_, i) => i + 1);
  // The first chunk goes on; the second is refused.
  let n = 0;
  const attach = deps.attach;
  deps.attach = async (id, part) => { n++; if (n === 2) throw new EmailBisonApiError("Something upstream broke", 500, { message: "Something upstream broke" }); return attach(id, part); };
  const r = await addToCampaign(deps, { campaignId: 7, inboxIds: ids });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "failed");
  assert.match(r.error ?? "", /Something upstream broke/);
  assert.equal(r.added, ADD_CHUNK);
  assert.equal(c.holds.size, ADD_CHUNK);
});

test("an answer that says it worked but the count didn't move is a failure, not 'nothing to do'", async () => {
  const { deps } = fakeCampaign();
  deps.attach = async () => ({ data: { success: true } });
  const r = await addToCampaign(deps, { campaignId: 7, inboxIds: [1, 2] });
  assert.equal(r.added, 0);
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "failed");
  assert.match(r.error ?? "", /count didn't move/);
});

test("a count that can't be read afterwards is a failure to check, never a silent success", async () => {
  const { c, deps } = fakeCampaign();
  let reads = 0;
  deps.count = async () => { reads++; if (reads > 1) throw new Error("down"); return c.holds.size; };
  const r = await addToCampaign(deps, { campaignId: 7, inboxIds: [1] });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /couldn't be read/);
});

test("the status can't be read: nothing is sent", async () => {
  const { c, deps } = fakeCampaign();
  deps.status = async () => { throw new EmailBisonApiError("Record not found.", 404, { message: "Record not found." }); };
  const r = await addToCampaign(deps, { campaignId: 7, inboxIds: [1] });
  assert.equal(r.outcome, "failed");
  assert.deepEqual(c.calls, []);
});

test("in chunks of 250, each id once", async () => {
  const { c, deps } = fakeCampaign();
  const ids = Array.from({ length: 600 }, (_, i) => i + 1);
  const r = await addToCampaign(deps, { campaignId: 7, inboxIds: [...ids, ...ids.slice(0, 50)] });
  assert.deepEqual(c.calls.map((x) => x.length), [250, 250, 100]);
  assert.equal(r.added, 600);
});

test("isAlreadyOn: EmailBison's own wording only", () => {
  assert.equal(isAlreadyOn(new EmailBisonApiError("These emails already exist on this campaign (X)", 200)), true);
  assert.equal(isAlreadyOn(new EmailBisonApiError("The campaign already exists", 422)), false);
  assert.equal(isAlreadyOn(new Error("nope")), false);
});

test("addSelection: Connected EmailBison inboxes are sent; not connected and Instantly ones are counted, left out", () => {
  const r = addSelection([
    { id: 1, status: "Connected" }, { id: 2, status: "Not connected" }, { id: 3, status: "connected" },
    { id: "inst-1", status: "Connected" }, { id: 4, status: null },
  ]);
  assert.deepEqual(r, { send: [1, 3], notConnected: 2, instantly: 1 });
});
