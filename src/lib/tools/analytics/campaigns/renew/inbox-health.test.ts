import { test } from "node:test";
import assert from "node:assert/strict";

import { BLOCK_AT, MIN_SENDS, MIN_WARMUP_SCORE, MIN_WARMUP_SENT, WARMUP_WINDOW_DAYS, formatRate, inboxesToAdd, isConnected, judgeInbox, judgeInboxes, type SourceInbox } from "./inbox-health.ts";

const inbox = (o: Partial<SourceInbox> = {}): SourceInbox => ({ id: 1, email: "a@x.com", status: "Connected", tags: [], dailyLimit: 25, ...o });
/** `attempts` emails in the window, `bounced` of them bounced (so sent rows = attempts − bounced); a healthy warm-up. */
const recent = (attempts: number, bounced: number, id = 1, warmupScore: number | null = 97, warmupSent = 80) => ({ id, sent: attempts - bounced, bounced, warmupScore, warmupSent });

test("the team's rules (20 Nov): under 2% bounce, judged after 100 sends; warm-up at least 90 over 14 days, judged after 20", () => {
  assert.equal(BLOCK_AT, 2);
  assert.equal(MIN_SENDS, 100);
  assert.equal(MIN_WARMUP_SCORE, 90);
  assert.equal(WARMUP_WINDOW_DAYS, 14);
  assert.equal(MIN_WARMUP_SENT, 20);
});

test("healthy: connected, under 2% over 100+ sends, warm-up 90+ -> added, no reasons, no note", () => {
  for (const [a, b] of [[100, 0], [100, 1], [1000, 19]] as const) {
    const v = judgeInbox(inbox(), recent(a, b));
    assert.equal(v.verdict, "add", `${b}/${a}`);
    assert.deepEqual(v.reasons, []);
    assert.equal(v.note, null);
  }
  assert.equal(judgeInbox(inbox(), recent(500, 0, 1, 90)).verdict, "add", "exactly 90 passes");
});

test("THE TEAM, 20 Nov: 2% or more is LEFT OUT (no more 'added with a warning'), with the figures", () => {
  const two = judgeInbox(inbox(), recent(200, 4)); // exactly 2%
  assert.equal(two.verdict, "leave");
  assert.deepEqual(two.reasons, ["Bounce rate 2.0% over the last 30 days (4 of 200); must be under 2%"]);
  assert.equal(judgeInbox(inbox(), recent(1000, 21)).verdict, "leave", "2.1%");
  assert.equal(judgeInbox(inbox(), recent(100, 5)).verdict, "leave", "5%");
  assert.equal(judgeInbox(inbox(), recent(10000, 199)).verdict, "add", "1.99% is under 2%");
});

test("THE TEAM, 20 Nov: tagged Dead is always left out, the old campaign's own inboxes too", () => {
  const v = judgeInbox(inbox({ tags: ["Outlook", " dead "] }), recent(500, 1));
  assert.equal(v.verdict, "leave");
  assert.deepEqual(v.reasons, ['Tagged "Dead"']);
});

test("THE TEAM, 20 Nov: a warm-up score under 90 is left out, once there was enough warm-up mail to judge", () => {
  const v = judgeInbox(inbox(), recent(500, 0, 1, 89.6));
  assert.equal(v.verdict, "leave");
  assert.deepEqual(v.reasons, ["Warm-up score 89 over the last 14 days; must be at least 90"]);
  assert.equal(judgeInbox(inbox(), recent(500, 0, 1, 0)).verdict, "leave", "warm-up landing in spam (score 0)");
  const few = judgeInbox(inbox(), recent(500, 0, 1, 10, 19));
  assert.equal(few.verdict, "add", "19 warm-up emails: too little to judge");
  assert.match(few.note ?? "", /too little warm-up mail to judge its warm-up score \(19 in the last 14 days\)/i);
  assert.equal(judgeInbox(inbox(), recent(500, 0, 1, null, 0)).verdict, "add", "no warm-up stats at all: not judged");
});

test("every failing rule is named at once", () => {
  const v = judgeInbox(inbox({ tags: ["Dead"] }), recent(100, 3, 1, 40));
  assert.equal(v.verdict, "leave");
  assert.equal(v.reasons.length, 3);
});

test("the rate divides by sends INCLUDING the bounced ones (a bounced send has no send row)", () => {
  // 98 send rows + 2 bounces = 100 emails, 2% -> left out. Dividing by the 98 rows would say 2.04%.
  const v = judgeInbox(inbox(), { id: 1, sent: 98, bounced: 2, warmupScore: 97, warmupSent: 80 });
  assert.equal(v.attempts, 100);
  assert.equal(v.rate, 2);
});

test("under 100 sends: added whatever its bounces, with a note", () => {
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

test("judgeInboxes: add or leave (nothing warned), worst first, a repeated inbox once", () => {
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
  assert.deepEqual(j.warn, []);
  assert.deepEqual(j.leave.map((v) => v.id), [5, 2, 4, 3], "15%, 4%, 3%, then the unjudged not-connected one");
  assert.deepEqual(inboxesToAdd(j), [1]);
});

test("formatRate never shows more than the true value", () => {
  assert.equal(formatRate(4.999), "4.9%");
  assert.equal(formatRate(1.999), "1.9%", "a passing rate never reads as 2.0%");
  assert.equal(formatRate(2.05), "2.05%");
  assert.equal(formatRate(2), "2.0%");
  assert.equal(formatRate(33.94), "33.9%");
});

/* ------------------------------------------------------------------------------------------- the wider pool --- */
import { capacityKept, capacityLeftOut, pickFromPool, poolNeeded, poolRefusal } from "./inbox-health.ts";

const pool = (id: number, o: Partial<SourceInbox> = {}): SourceInbox => ({ id, email: `p${id}@x.com`, status: "Connected", tags: [], dailyLimit: 25, ...o });
const used = (id: number, attempts: number, bounced: number, sent24h: number) => ({ id, sent: attempts - bounced, bounced, sent24h });

test("pool: only healthy, connected, untagged inboxes with capacity to spare", () => {
  assert.equal(poolRefusal(pool(1), used(1, 500, 2, 0)), null);
  assert.equal(poolRefusal(pool(1), undefined), null, "never sent: healthy, all capacity spare");
  assert.equal(poolRefusal(pool(1, { status: "Not connected" }), undefined), "not connected");
  assert.equal(poolRefusal(pool(1, { tags: ["Dead"] }), undefined), "tagged");
  assert.equal(poolRefusal(pool(1, { tags: ["Warm up"] }), undefined), "tagged", "still warming up: never picked automatically");
  assert.equal(poolRefusal(pool(1), used(1, 1000, 21, 0)), "bounce rate", "2% or more is never picked");
  assert.equal(poolRefusal(pool(1), used(1, 1000, 20, 0)), "bounce rate", "exactly 2% is never picked");
  assert.equal(poolRefusal(pool(1), { ...used(1, 500, 0, 0), warmupScore: 85, warmupSent: 60 }), "warm-up score", "warm-up under 90 is never picked");
  assert.equal(poolRefusal(pool(1), { ...used(1, 500, 0, 0), warmupScore: 85, warmupSent: 5 }), null, "too little warm-up to judge: may be picked");
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

test("poolNeeded (the user, 19 Nov): what the kept inboxes fall short of the campaign's own daily limit", () => {
  const j = judgeInboxes(
    [inbox({ id: 1, status: "Not connected", dailyLimit: 25 }), inbox({ id: 2, dailyLimit: 1 }), inbox({ id: 3, dailyLimit: 30 }), inbox({ id: 4, dailyLimit: 20 })],
    [recent(200, 50, 2), recent(200, 0, 3), recent(1000, 10, 4)],
  );
  assert.equal(capacityKept(j), 50, "30 + 20 healthy; the left-out ones never count");
  assert.equal(poolNeeded(j, 40), 0, "kept 50 covers 40");
  assert.equal(poolNeeded(j, 50), 0);
  assert.equal(poolNeeded(j, 120), 70);
  assert.equal(poolNeeded(j, null), 26, "no limit set: the left-out capacity, as before");
  assert.equal(poolNeeded(j, 0), 26);
});
