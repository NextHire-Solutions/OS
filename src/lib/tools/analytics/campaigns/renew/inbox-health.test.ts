import { test } from "node:test";
import assert from "node:assert/strict";

import { BLOCK_AT, MIN_SENDS, WARN_ABOVE, formatRate, inboxesToAdd, isConnected, judgeInbox, judgeInboxes, type SourceInbox } from "./inbox-health.ts";

const inbox = (o: Partial<SourceInbox> = {}): SourceInbox => ({ id: 1, email: "a@x.com", status: "Connected", tags: [], dailyLimit: 25, ...o });
/** `attempts` emails in the window, `bounced` of them bounced (so sent rows = attempts − bounced). */
const recent = (attempts: number, bounced: number, id = 1) => ({ id, sent: attempts - bounced, bounced });

test("the team's thresholds as agreed: 2% healthy, over 2 to under 5 warning, 5 or more left out, 100 sends to judge", () => {
  assert.equal(WARN_ABOVE, 2);
  assert.equal(BLOCK_AT, 5);
  assert.equal(MIN_SENDS, 100);
});

test("healthy: connected, 0-2% over 100+ sends -> added, no reasons", () => {
  for (const [a, b] of [[100, 0], [100, 2], [1000, 20]] as const) {
    const v = judgeInbox(inbox(), recent(a, b));
    assert.equal(v.verdict, "add", `${b}/${a}`);
    assert.deepEqual(v.reasons, []);
    assert.equal(v.note, null);
  }
});

test("exactly 2% is healthy; just over 2% is a warning", () => {
  assert.equal(judgeInbox(inbox(), recent(200, 4)).verdict, "add");
  const v = judgeInbox(inbox(), recent(1000, 21));
  assert.equal(v.verdict, "warn");
  assert.match(v.reasons[0], /^Bounce rate 2\.1% over the last 30 days \(21 of 1000\): warning$/);
});

test("just under 5% is a warning, shown as 4.9% (never rounded up to 5.0%)", () => {
  const v = judgeInbox(inbox(), recent(10000, 499)); // 4.99%
  assert.equal(v.verdict, "warn");
  assert.match(v.reasons[0], /4\.9%/);
});

test("exactly 5% and above are left out, with the figures", () => {
  const v = judgeInbox(inbox(), recent(100, 5));
  assert.equal(v.verdict, "leave");
  assert.deepEqual(v.reasons, ["Bounce rate 5.0% over the last 30 days (5 of 100)"]);
  assert.equal(judgeInbox(inbox(), recent(162, 55)).verdict, "leave");
});

test("the rate divides by sends INCLUDING the bounced ones (a bounced send has no send row)", () => {
  // 95 send rows + 5 bounces = 100 emails, 5% -> left out. Dividing by the 95 rows would say 5.3%.
  const v = judgeInbox(inbox(), { id: 1, sent: 95, bounced: 5 });
  assert.equal(v.attempts, 100);
  assert.equal(v.rate, 5);
});

test("under 100 sends: added whatever its bounces, with a note (not a warning)", () => {
  const v = judgeInbox(inbox(), recent(99, 50));
  assert.equal(v.verdict, "add");
  assert.equal(v.rate, null);
  assert.match(v.note ?? "", /Too little sending to judge its bounce rate \(99 in the last 30 days\)/);
  assert.equal(judgeInbox(inbox(), undefined).verdict, "add", "no row at all = sent nothing");
});

test("not connected is left out whatever its bounce rate, saying EmailBison's own status", () => {
  const v = judgeInbox(inbox({ status: "Not connected" }), recent(1000, 0));
  assert.equal(v.verdict, "leave");
  assert.deepEqual(v.reasons, ["Not connected in EmailBison"]);
  assert.deepEqual(judgeInbox(inbox({ status: null }), undefined).reasons, ["No connection status from EmailBison"]);
  assert.equal(judgeInbox(inbox({ status: " connected " }), undefined).verdict, "add", "case and spaces aside");
  assert.equal(isConnected("Connected"), true);
  assert.equal(isConnected("Connecting"), false);
});

test("tagged Dead: added but warned (the agreed rule does not leave it out)", () => {
  const v = judgeInbox(inbox({ tags: ["Outlook", " dead "] }), recent(500, 1));
  assert.equal(v.verdict, "warn");
  assert.deepEqual(v.reasons, ['Tagged "Dead"']);
  const both = judgeInbox(inbox({ tags: ["Dead"] }), recent(100, 3));
  assert.equal(both.reasons.length, 2);
});

test("judgeInboxes: splits, sorts the worst first, ignores a repeated inbox, and the add list is healthy + warned", () => {
  const list: SourceInbox[] = [
    inbox({ id: 1, email: "b@x.com" }),
    inbox({ id: 2, email: "a@x.com" }),
    inbox({ id: 3, email: "c@x.com", status: "Not connected" }),
    inbox({ id: 4, email: "d@x.com" }),
    inbox({ id: 5, email: "e@x.com" }),
    inbox({ id: 1, email: "b@x.com" }),
  ];
  const j = judgeInboxes(list, [recent(100, 1, 1), recent(100, 3, 4), recent(200, 30, 5), recent(100, 4, 2)]);
  assert.deepEqual(j.add.map((v) => v.id), [1]);
  assert.deepEqual(j.warn.map((v) => v.id), [2, 4], "4% before 3%");
  assert.deepEqual(j.leave.map((v) => v.id), [5, 3], "15% first, then the unjudged not-connected one");
  assert.deepEqual(inboxesToAdd(j).sort(), [1, 2, 4]);
});

test("formatRate never shows more than the true value", () => {
  assert.equal(formatRate(4.999), "4.9%");
  assert.equal(formatRate(2.05), "2.05%", "a warning never reads as 2.0%");
  assert.equal(formatRate(2), "2.0%");
  assert.equal(formatRate(33.94), "33.9%");
});

/* ------------------------------------------------------------------------------------------- the wider pool --- */
import { capacityLeftOut, pickFromPool, poolRefusal } from "./inbox-health.ts";

const pool = (id: number, o: Partial<SourceInbox> = {}): SourceInbox => ({ id, email: `p${id}@x.com`, status: "Connected", tags: [], dailyLimit: 25, ...o });
const used = (id: number, attempts: number, bounced: number, sent24h: number) => ({ id, sent: attempts - bounced, bounced, sent24h });

test("pool: only healthy, connected, untagged inboxes with capacity to spare", () => {
  assert.equal(poolRefusal(pool(1), used(1, 500, 2, 0)), null);
  assert.equal(poolRefusal(pool(1), undefined), null, "never sent: healthy, all capacity spare");
  assert.equal(poolRefusal(pool(1, { status: "Not connected" }), undefined), "not connected");
  assert.equal(poolRefusal(pool(1, { tags: ["Dead"] }), undefined), "tagged");
  assert.equal(poolRefusal(pool(1, { tags: ["Warm up"] }), undefined), "tagged", "still warming up: never picked automatically");
  assert.equal(poolRefusal(pool(1), used(1, 1000, 21, 0)), "bounce rate", "a 2-5% warning is never picked fresh from the pool");
  assert.equal(poolRefusal(pool(1), used(1, 50, 20, 0)), null, "too little sending to judge: may be picked");
  assert.equal(poolRefusal(pool(1), used(1, 500, 0, 25)), "no capacity to spare", "sent its whole daily limit in the last 24 hours");
  assert.equal(poolRefusal(pool(1, { dailyLimit: 0 }), undefined), "no daily limit");
  assert.equal(poolRefusal(pool(1, { dailyLimit: null }), undefined), "no daily limit");
});

test("pool: picks until the left-out capacity is covered, most spare first, judged-healthy before unjudged", () => {
  const inboxes = [pool(1), pool(2), pool(3), pool(4), pool(5, { dailyLimit: 10 })];
  const recent = [used(1, 500, 1, 20), used(2, 50, 0, 0), used(3, 500, 2, 0), used(4, 500, 0, 0), used(5, 0, 0, 0)];
  // spare: 1→5, 2→25 (unjudged), 3→25 (0.4%), 4→25 (0%), 5→10
  const plan = pickFromPool(inboxes, recent, 40, new Set());
  assert.deepEqual(plan.picks.map((p) => p.id), [4, 3], "25+25 covers 40: the two judged-healthy, lowest rate first");
  assert.equal(plan.added, 50);
  assert.equal(plan.shortfall, 0);
  assert.equal(plan.moreAvailable, 3);
});

test("pool: the old campaign's own inboxes are never picked; nothing needed, nothing picked", () => {
  const plan = pickFromPool([pool(1), pool(2)], [], 100, new Set([1]));
  assert.deepEqual(plan.picks.map((p) => p.id), [2]);
  assert.equal(plan.shortfall, 75);
  assert.deepEqual(pickFromPool([pool(1)], [], 0, new Set()).picks, []);
});

test("capacityLeftOut: the left-out inboxes' daily limits", () => {
  const j = judgeInboxes(
    [inbox({ id: 1, status: "Not connected", dailyLimit: 25 }), inbox({ id: 2, dailyLimit: 1 }), inbox({ id: 3, dailyLimit: 30 })],
    [recent(200, 50, 2), recent(200, 0, 3)],
  );
  assert.equal(capacityLeftOut(j), 26);
});

test("pool (review 19 Nov): the old campaign's own groups first; the intro sender never", () => {
  const inboxes = [pool(1, { tags: ["ALL", "Outlook"] }), pool(2, { tags: ["Nicole Pool"], dailyLimit: 10 }), pool(3, { email: "Nicole.C@BrokerStaffer.com" })];
  const plan = pickFromPool(inboxes, [], 30, new Set(), { groupTags: new Set(["nicole pool"]), reservedEmails: new Set(["nicole.c@brokerstaffer.com"]) });
  assert.deepEqual(plan.picks.map((p) => [p.id, p.sameGroup]), [[2, true], [1, false]], "same group first even with less to spare; the reserved address never");
  assert.equal(poolRefusal(inboxes[2], undefined, { reservedEmails: new Set(["nicole.c@brokerstaffer.com"]) }), "reserved");
});
