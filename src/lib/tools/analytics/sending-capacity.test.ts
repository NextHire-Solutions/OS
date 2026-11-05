import { test } from "node:test";
import assert from "node:assert/strict";

import { activeInboxCapacity, capacityPicture, gapLabel, neededShare, type ActiveCampaignLimit } from "./sending-capacity.ts";

// The estate on 13 Oct 2026, as the database had it.
const ROWS = [
  { platform: "emailbison", inboxes: 1468, daily_capacity: 32600, unavailable: 10050 },
  { platform: "instantly", inboxes: 536, daily_capacity: 11065, unavailable: 0 },
];
const eb = (daily: number | null, newLeads: number | null = daily == null ? null : daily / 2): ActiveCampaignLimit => ({ platform: "emailbison", daily, newLeads });
const inst = (daily: number | null = null): ActiveCampaignLimit => ({ platform: "instantly", daily, newLeads: null });
// 24 active campaigns: 23 at 1,000 and one at 3,000… the real total was 33,000.
const ACTIVE = [...Array.from({ length: 15 }, () => eb(1000)), ...Array.from({ length: 9 }, () => eb(2000))];

test("the reported case: Instantly has no active campaign, so its inboxes are not counted", () => {
  const p = capacityPicture(ROWS, ACTIVE);
  assert.equal(p.daily, 32600, "not 43,665 — that was the number that seemed off");
  assert.equal(p.inboxes, 1468);
  assert.equal(p.idleDaily, 11065);
  assert.equal(p.idleInboxes, 536);
  assert.deepEqual(p.platforms.map((x) => [x.platform, x.counted]), [["emailbison", true], ["instantly", false]]);
});

test("needed is the active campaigns' daily limits added up; the gap is capacity minus that", () => {
  const p = capacityPicture(ROWS, ACTIVE);
  assert.equal(p.activeCampaigns, 24);
  assert.equal(p.needed, 33000);
  assert.equal(p.newLeads, 16500);
  assert.equal(p.gap, -400);
  assert.equal(gapLabel(p), "400 a day short");
  assert.equal(neededShare(p), 33000 / 32600);
});

test("unavailable capacity is reported, never added to what can send", () => {
  const p = capacityPicture(ROWS, ACTIVE);
  assert.equal(p.unavailable, 10050);
  assert.equal(p.daily + p.unavailable, 42650);
});

test("Instantly is counted again the moment it has an active campaign", () => {
  const p = capacityPicture(ROWS, [...ACTIVE, inst()]);
  assert.equal(p.daily, 43665);
  assert.equal(p.idleDaily, 0);
  assert.equal(p.activeCampaigns, 25);
  assert.equal(p.withoutLimit, 1, "Instantly stores no daily limit; said, not guessed");
  assert.equal(p.needed, 33000);
});

test("a platform named on its own by the filter is counted even when idle — it is what was asked for", () => {
  const p = capacityPicture(ROWS.filter((r) => r.platform === "instantly"), ACTIVE, ["instantly"]);
  assert.equal(p.daily, 11065);
  assert.equal(p.activeCampaigns, 0, "EmailBison's campaigns are out of scope");
  assert.equal(p.needed, 0);
  assert.equal(gapLabel(p), "no active campaign has a daily limit");
});

test("the Platform filter scopes the campaigns as well as the inboxes", () => {
  const p = capacityPicture(ROWS, [...ACTIVE, inst(500)], ["emailbison"]);
  assert.deepEqual(p.platforms.map((x) => x.platform), ["emailbison"]);
  assert.equal(p.needed, 33000);
  assert.equal(p.daily, 32600);
});

test("with no active campaign anywhere, everything is counted — never a made-up zero", () => {
  const p = capacityPicture(ROWS, []);
  assert.equal(p.daily, 43665);
  assert.equal(p.idleDaily, 0);
  assert.equal(p.needed, 0);
  assert.equal(neededShare(p), 0);
});

test("spare capacity, exactly enough, and no capacity at all", () => {
  assert.equal(gapLabel(capacityPicture(ROWS, [eb(1000)])), "31,600 a day to spare");
  assert.equal(gapLabel(capacityPicture([{ platform: "emailbison", inboxes: 1, daily_capacity: 1000, unavailable: 0 }], [eb(1000)])), "exactly enough");
  assert.equal(neededShare(capacityPicture([], [eb(1000)])), null);
});

test("a campaign with no daily limit is counted as a campaign and left out of needed", () => {
  const p = capacityPicture(ROWS, [eb(1000), eb(null)]);
  assert.equal(p.activeCampaigns, 2);
  assert.equal(p.withoutLimit, 1);
  assert.equal(p.needed, 1000);
});

test("numbers arriving as text (bigint sums) are read as numbers", () => {
  const p = capacityPicture([{ platform: "emailbison", inboxes: "10", daily_capacity: "250", unavailable: "5" }], [eb(100)]);
  assert.equal(p.daily, 250);
  assert.equal(p.inboxes, 10);
  assert.equal(p.unavailable, 5);
});

test("active inboxes: each once however many campaigns share it, Connected only, and the daily limits added up", () => {
  const pool = [
    { id: 1, status: "Connected", dailyLimit: 10 },
    { id: 2, status: "Connected", dailyLimit: 15 },
    { id: 3, status: "Not connected", dailyLimit: 15 },
    { id: 4, status: "Failed", dailyLimit: 15 },
  ];
  // Nine campaigns on one pool is one pool.
  assert.deepEqual(activeInboxCapacity([pool, pool, pool]), { inboxes: 2, daily: 25, cannotConnect: 2, campaigns: 3 });
  // A second campaign adds only what is new.
  assert.deepEqual(activeInboxCapacity([pool, [{ id: 2, status: "Connected", dailyLimit: 15 }, { id: 9, status: "Connected", dailyLimit: 5 }]]), { inboxes: 3, daily: 30, cannotConnect: 2, campaigns: 2 });
});

test("active inboxes: nothing known is never a number made up", () => {
  assert.deepEqual(activeInboxCapacity([]), { inboxes: 0, daily: 0, cannotConnect: 0, campaigns: 0 });
  assert.deepEqual(activeInboxCapacity([[]]), { inboxes: 0, daily: 0, cannotConnect: 0, campaigns: 1 });
  // No limit on record adds nothing, but it is still an inbox.
  assert.deepEqual(activeInboxCapacity([[{ id: 1, status: "Connected", dailyLimit: null }]]), { inboxes: 1, daily: 0, cannotConnect: 0, campaigns: 1 });
  // No status isn't Connected.
  assert.deepEqual(activeInboxCapacity([[{ id: 1, status: null, dailyLimit: 10 }]]), { inboxes: 0, daily: 0, cannotConnect: 1, campaigns: 1 });
});

test("the two figures are measured the same way against what the campaigns need", () => {
  assert.equal(gapLabel({ gap: 21_000 - 22_500, needed: 22_500 }), "1,500 a day short");
  assert.equal(gapLabel({ gap: 32_675 - 22_500, needed: 22_500 }), "10,175 a day to spare");
});
