import { test, mock } from "node:test";
import assert from "node:assert/strict";

/* Which inboxes each campaign holds, kept in the process (5 Nov). EmailBison and the database are stand-ins here. */
const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

class EmailBisonApiError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) { super(message); this.statusCode = statusCode; }
}

const lists = new Map<number, Array<{ id: number; status: string; daily_limit: number }>>();
const reads: number[] = [];
let gate: Promise<void> | null = null;
const failing = new Set<number>();
let activeIds: number[] = [];
let statusesAsked: string[] = [];
const inbox = (id: number, status = "Connected", daily_limit = 10) => ({ id, status, daily_limit });

let load: typeof import("./campaign-inboxes-load");
test("setup", { skip }, async () => {
  mock.module("@/lib/tools/analytics/emailbison/client.ts", {
    namedExports: {
      EmailBisonApiError,
      createEmailBisonClient: () => ({
        getCampaignSenderEmails: async (id: number) => {
          reads.push(id);
          if (gate) await gate;
          if (failing.has(id)) throw new Error("EmailBison is down");
          if (!lists.has(id)) throw new EmailBisonApiError("gone", 404);
          return lists.get(id);
        },
      }),
    },
  });
  const chain = { select: () => chain, eq: () => chain, in: (_: string, list: string[]) => { statusesAsked = list; return chain; }, is: async () => ({ data: activeIds.map((id) => ({ id })), error: null }) };
  mock.module("./supabase", { namedExports: { analyticsTeamId: () => 1, getAnalyticsSupabase: () => ({ from: () => chain }) } });
  load = await import("./campaign-inboxes-load");
});

const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); };
const fresh = () => {
  reads.length = 0;
  failing.clear();
  gate = null;
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("os.analytics.campaignInboxes")];
};

test("which of these inboxes a campaign holds, read once and then kept", { skip }, async () => {
  fresh();
  lists.set(1, [inbox(10), inbox(11), inbox(12)]);
  assert.deepEqual(await load.campaignOverlap(1, 3, [11, 12, 99]), { on: [11, 12], total: 3, leftConnected: 1 });
  assert.deepEqual(reads, [1]);
  assert.deepEqual(await load.campaignOverlap(1, 3, [10]), { on: [10], total: 3, leftConnected: 2 });
  assert.deepEqual(reads, [1], "no second read");
});

test("a kept list of a different size has changed: it's read again, so a removal never rests on it", { skip }, async () => {
  fresh();
  lists.set(1, [inbox(10), inbox(11)]);
  await load.campaignOverlap(1, 2, [10]);
  lists.set(1, [inbox(10), inbox(11), inbox(12)]);
  assert.deepEqual(await load.campaignOverlap(1, 3, [12]), { on: [12], total: 3, leftConnected: 2 });
  assert.deepEqual(reads, [1, 1]);
});

test("two people asking at the same moment are one read", { skip }, async () => {
  fresh();
  lists.set(1, [inbox(10)]);
  let open!: () => void;
  gate = new Promise((r) => { open = r; });
  const a = load.campaignOverlap(1, 1, [10]);
  const b = load.campaignOverlap(1, 1, [10]);
  open();
  assert.deepEqual(await a, { on: [10], total: 1, leftConnected: 0 });
  assert.deepEqual(await b, { on: [10], total: 1, leftConnected: 0 });
  assert.deepEqual(reads, [1]);
});

test("a campaign deleted since is one holding nothing; any other failure is a failure", { skip }, async () => {
  fresh();
  lists.delete(404);
  assert.deepEqual(await load.campaignOverlap(404, 3, [1]), { on: [], total: 0, leftConnected: 0 });
  failing.add(5);
  lists.set(5, [inbox(1)]);
  await assert.rejects(() => load.campaignOverlap(5, 1, [1]), /EmailBison is down/);
});

test("inboxes just taken off leave the kept list right, with no new read", { skip }, async () => {
  fresh();
  lists.set(1, [inbox(10), inbox(11), inbox(12)]);
  await load.campaignOverlap(1, 3, [10]);
  load.inboxesTakenOff(1, [10, 11]);
  assert.deepEqual(await load.campaignOverlap(1, 1, [10, 11, 12]), { on: [12], total: 1, leftConnected: 0 });
  assert.deepEqual(reads, [1]);
  load.inboxesTakenOff(999, [1]);
});

test("active inboxes: says it's reading, then the figure, each inbox once, with no second read while kept", { skip }, async () => {
  fresh();
  activeIds = [1, 2];
  lists.set(1, [inbox(10), inbox(11, "Not connected")]);
  lists.set(2, [inbox(10), inbox(12, "Connected", 20)]);
  const now = Date.now();
  const first = await load.activeCapacity(now);
  assert.equal(first.status, "loading");
  assert.equal(first.active, null);
  assert.deepEqual(first.progress?.total, 2);
  await settle();
  const second = await load.activeCapacity(now + 1000);
  assert.equal(second.status, "ready");
  assert.deepEqual(second.active, { inboxes: 2, daily: 30, cannotConnect: 1, campaigns: 2 });
  assert.ok(second.asOf);
  assert.equal(reads.length, 2);
  await load.activeCapacity(now + 2000);
  await settle();
  assert.equal(reads.length, 2, "no second read while kept");
});

test("active inboxes: a campaign paused since just stops counting, at once and with no read", { skip }, async () => {
  fresh();
  activeIds = [1, 2];
  lists.set(1, [inbox(10)]);
  lists.set(2, [inbox(12, "Connected", 20)]);
  const now = Date.now();
  await load.activeCapacity(now);
  await settle();
  const before = reads.length;
  activeIds = [1];
  const after = await load.activeCapacity(now + 1000);
  assert.deepEqual(after.active, { inboxes: 1, daily: 10, cannotConnect: 0, campaigns: 1 });
  assert.equal(reads.length, before);
});

test("active inboxes: an old figure stays on screen while a new read runs", { skip }, async () => {
  fresh();
  activeIds = [1];
  lists.set(1, [inbox(10)]);
  const now = Date.now();
  await load.activeCapacity(now);
  await settle();
  lists.set(1, [inbox(10), inbox(11)]);
  let open!: () => void;
  gate = new Promise((r) => { open = r; });
  const later = now + 2 * 60 * 60 * 1000;
  const during = await load.activeCapacity(later);
  assert.equal(during.status, "refreshing");
  assert.deepEqual(during.active, { inboxes: 1, daily: 10, cannotConnect: 0, campaigns: 1 });
  open();
  await settle();
  const done = await load.activeCapacity(later + 1000);
  assert.deepEqual(done.active, { inboxes: 2, daily: 20, cannotConnect: 0, campaigns: 1 });
});

test("active inboxes: a failed read says so, makes up no number, and waits before trying again", { skip }, async () => {
  fresh();
  activeIds = [7];
  lists.set(7, [inbox(10)]);
  failing.add(7);
  const now = Date.now();
  await load.activeCapacity(now);
  await settle();
  const failed = await load.activeCapacity(Date.now());
  assert.equal(failed.status, "error");
  assert.equal(failed.active, null);
  assert.match(String(failed.error), /EmailBison is down/);
  const count = reads.length;
  await load.activeCapacity(Date.now() + 1000);
  await settle();
  assert.equal(reads.length, count, "not tried again straight away");
  failing.clear();
  await load.activeCapacity(Date.now() + 6 * 60 * 1000);
  await settle();
  assert.equal((await load.activeCapacity(Date.now() + 6 * 60 * 1000)).status, "ready");
});

test("no campaign is active: zero, and ready, not a wait for a read that won't come", { skip }, async () => {
  fresh();
  activeIds = [];
  const r = await load.activeCapacity();
  assert.equal(r.status, "ready");
  assert.deepEqual(r.active, { inboxes: 0, daily: 0, cannotConnect: 0, campaigns: 0 });
  assert.equal(reads.length, 0);
});

test("a removal doesn't rest on a list over five minutes old, even at the same size: a swap keeps the size", { skip }, async (t) => {
  fresh();
  lists.set(1, [inbox(10), inbox(11)]);
  await load.campaignOverlap(1, 2, [10]);
  lists.set(1, [inbox(10), inbox(99)]);
  const real = Date.now;
  t.mock.method(Date, "now", () => real() + 6 * 60 * 1000);
  assert.deepEqual((await load.campaignOverlap(1, 2, [99])).on, [99]);
  assert.deepEqual(reads, [1, 1]);
});

test("inboxes taken off while a read is running don't come back with it", { skip }, async () => {
  fresh();
  lists.set(1, [inbox(10), inbox(11), inbox(12)]);
  let open!: () => void;
  gate = new Promise((r) => { open = r; });
  const walking = load.campaignOverlap(1, 3, [10]);
  load.inboxesTakenOff(1, [10]);
  open();
  assert.deepEqual(await walking, { on: [], total: 2, leftConnected: 2 });
  assert.deepEqual(await load.campaignOverlap(1, 2, [10, 11]), { on: [11], total: 2, leftConnected: 1 });
  assert.deepEqual(reads, [1]);
});

test("what would be left, and how many of those can send", { skip }, async () => {
  fresh();
  lists.set(1, [inbox(10), inbox(11, "Not connected"), inbox(12, "Failed")]);
  assert.deepEqual(await load.campaignOverlap(1, 3, [10]), { on: [10], total: 3, leftConnected: 0 });
});

test("a campaign resumed a moment ago is queued: it stays in the Active inboxes figure", { skip }, async () => {
  fresh();
  activeIds = [];
  await load.activeCapacity();
  assert.deepEqual([...statusesAsked].sort(), ["active", "launching", "queued"]);
});

