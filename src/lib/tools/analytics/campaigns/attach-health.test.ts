import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { attachHealth, healthRows, healthView, kindOf, leftOutWords, NO_COUNTS } from "./attach-health.ts";
import { readAttachHealth, type AttachHealthReads } from "./attach-health-io.ts";
import type { SourceInbox } from "./renew/inbox-health.ts";

const inbox = (id: number, o: Partial<SourceInbox> = {}): SourceInbox => ({ id, email: `i${id}@example.test`, status: "Connected", tags: [], dailyLimit: 30, ...o });
const warm = (entries: Array<[number, number, number]>) => new Map(entries.map(([id, score, sent]) => [id, { score, sent }]));

describe("attach health: the rules on a list of ids", () => {
  const inboxes = [
    inbox(1),                                   // healthy
    inbox(2, { tags: ["Dead"] }),               // Dead
    inbox(3),                                   // bounce 2%
    inbox(4),                                   // warm-up 89
    inbox(5, { status: "Not connected" }),      // not connected
    inbox(6),                                   // too little sending: goes on, unjudged
    inbox(7, { tags: ["dead"] }),               // Dead and bouncing: two reasons
  ];
  const bounces = [
    { id: 1, sent: 990, bounced: 10 },  // 1%
    { id: 3, sent: 980, bounced: 20 },  // 2.0%: out
    { id: 4, sent: 500, bounced: 0 },
    { id: 6, sent: 40, bounced: 2 },
    { id: 7, sent: 90, bounced: 10 },   // 10%
  ];
  const w = warm([[1, 97, 60], [2, 99, 60], [3, 95, 60], [4, 89, 60], [6, 100, 5], [7, 92, 60]]);
  const h = attachHealth([1, 2, 3, 4, 5, 6, 7, 8, 1], inboxes, healthRows([1, 2, 3, 4, 5, 6, 7, 8], bounces, w));

  it("passes the healthy ones and the ones too new to judge, in the order asked, each once", () => {
    assert.deepEqual(h.healthy, [1, 6]);
    assert.equal(h.unjudged, 1);
  });

  it("leaves out Dead, 2% bounce or more, warm-up under 90, not connected, and ids EmailBison no longer has", () => {
    const why = new Map(h.leftOut.map((x) => [x.id, x.kinds]));
    assert.deepEqual(why.get(2), ["Dead"]);
    assert.deepEqual(why.get(3), ["bounce"]);
    assert.deepEqual(why.get(4), ["warm-up"]);
    assert.deepEqual(why.get(5), ["not connected"]);
    assert.deepEqual(why.get(7), ["Dead", "bounce"]);
    assert.deepEqual(why.get(8), ["not found"]);
    assert.deepEqual(h.counts, { "not connected": 1, Dead: 2, bounce: 2, "warm-up": 1, "not found": 1 });
  });

  it("says it in words", () => {
    assert.equal(leftOutWords(h.counts), "2 with a bounce rate of 2% or more, 1 with a warm-up score under 90, 2 tagged Dead, 1 not connected, 1 EmailBison no longer has");
    assert.equal(leftOutWords(NO_COUNTS()), "");
  });

  it("the screens get counts and a few examples, not every row", () => {
    const v = healthView(h, 2);
    assert.equal(v.leftOut, 6);
    assert.equal(v.examples.length, 2);
    assert.deepEqual(v.healthy, [1, 6]);
  });

  it("an inbox with no recent sends or warm-up rows goes on, unjudged", () => {
    const r = attachHealth([9], [inbox(9)], healthRows([9], [], new Map()));
    assert.deepEqual([r.healthy, r.unjudged, r.leftOut.length], [[9], 1, 0]);
  });

  it("reads judgeInbox's reasons as the right rule", () => {
    assert.equal(kindOf('Tagged "Dead"'), "Dead");
    assert.equal(kindOf("Bounce rate 2.4% over the last 30 days (24 of 1000); must be under 2%"), "bounce");
    assert.equal(kindOf("Warm-up score 85 over the last 14 days; must be at least 90"), "warm-up");
    assert.equal(kindOf("Not connected in EmailBison"), "not connected");
  });
});

describe("attach health: reading it", () => {
  const reads = (o: Partial<AttachHealthReads> = {}): AttachHealthReads => ({
    inboxes: async (ids) => ids.map((id) => inbox(id)),
    bounces: async () => [{ id: 2, sent: 900, bounced: 100 }],
    warmup: async () => warm([[1, 95, 50], [2, 95, 50]]),
    ...o,
  });

  it("judges what it reads", async () => {
    const r = await readAttachHealth([1, 2], reads());
    assert.ok(r.ok);
    assert.deepEqual(r.ok && r.health.healthy, [1]);
  });

  it("refuses without the bounce check (analytics 098): nothing is judged healthy", async () => {
    const r = await readAttachHealth([1], reads({ bounces: async () => "missing" }));
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /098/);
  });

  it("refuses when the warm-up scores or the inboxes can't be read", async () => {
    for (const bad of [{ warmup: async () => { throw new Error("EmailBison 503"); } }, { inboxes: async () => { throw new Error("Inboxes: timeout"); } }]) {
      const r = await readAttachHealth([1], reads(bad as Partial<AttachHealthReads>));
      assert.equal(r.ok, false);
      assert.match(!r.ok ? r.error : "", /nothing was added/);
    }
  });

  it("nothing asked: nothing read", async () => {
    let read = false;
    const r = await readAttachHealth([], reads({ inboxes: async () => { read = true; return []; } }));
    assert.deepEqual([r.ok, read], [true, false]);
  });
});
