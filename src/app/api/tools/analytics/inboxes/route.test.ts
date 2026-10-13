/*
 * The Inboxes route (13 Oct).
 *
 * What can go wrong here is quiet, and each case below is one of those:
 *
 *   · reading a table without paging. PostgREST stops at 1,000 rows and says
 *     nothing, so the page would list 1,000 inboxes and look finished. The
 *     database below enforces that cap on every read, exactly as the real one
 *     does — a read that forgets to page FAILS these tests.
 *   · "Assigned" quietly becoming "No" for inboxes nobody looked at.
 *   · one failing extra (the send history, Instantly) blanking the whole list.
 *
 * The route runs for real, and so does the paging helper it uses; only the
 * Supabase client is replaced, by a small in-memory database.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

type Row = Record<string, unknown>;
type Read = { table: string; in: Record<string, unknown[]>; range: [number, number] | null; limit: number | null; returned: number };

const CAP = 1000;
const tables: Record<string, Row[]> = {};
/** Tables or functions that answer with an error. */
const down = new Set<string>();
const reads: Read[] = [];

function from(table: string) {
  const q = {
    eq: [] as Array<[string, unknown]>,
    isNull: [] as string[],
    in: {} as Record<string, unknown[]>,
    order: [] as Array<[string, boolean]>,
    range: null as [number, number] | null,
    limit: null as number | null,
  };
  const run = () => {
    if (down.has(table)) return { data: null, error: { message: `${table} is down` } };
    let rows = (tables[table] ?? []).filter(
      (r) =>
        q.eq.every(([c, v]) => r[c] === v) &&
        q.isNull.every((c) => r[c] === null || r[c] === undefined) &&
        Object.entries(q.in).every(([c, vs]) => vs.includes(r[c])),
    );
    for (const [col, asc] of [...q.order].reverse()) {
      rows = [...rows].sort((a, b) => {
        const [x, y] = [a[col] as number | string, b[col] as number | string];
        return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1);
      });
    }
    if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1);
    if (q.limit !== null) rows = rows.slice(0, q.limit);
    // The cap. `.range()` and `.limit()` can only shrink it, never raise it.
    rows = rows.slice(0, CAP);
    reads.push({ table, in: q.in, range: q.range, limit: q.limit, returned: rows.length });
    return { data: rows, error: null };
  };
  const builder = {
    select: () => builder,
    eq: (c: string, v: unknown) => (q.eq.push([c, v]), builder),
    is: (c: string, v: unknown) => (assert.equal(v, null), q.isNull.push(c), builder),
    in: (c: string, vs: unknown[]) => ((q.in[c] = vs), builder),
    order: (c: string, o?: { ascending?: boolean }) => (q.order.push([c, o?.ascending !== false]), builder),
    range: (a: number, b: number) => ((q.range = [a, b]), builder),
    limit: (n: number) => ((q.limit = n), builder),
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve().then(run).then(ok, bad),
  };
  return builder;
}

async function rpc(fn: string, args: { p_limit: number; p_offset: number }) {
  if (down.has(fn)) return { data: null, error: { message: `${fn} is down` } };
  const rows = (tables[fn] ?? []).slice(args.p_offset, args.p_offset + Math.min(args.p_limit, CAP));
  reads.push({ table: fn, in: {}, range: [args.p_offset, args.p_offset + args.p_limit - 1], limit: null, returned: rows.length });
  return { data: rows, error: null };
}

const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

let GET: (() => Promise<Response>) | null = null;
if (canMock) {
  for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});
  // Placeholders: the client they would configure is the one replaced below.
  process.env.ANALYTICS_SUPABASE_URL = "http://analytics-db.test";
  process.env.ANALYTICS_SUPABASE_SERVICE_ROLE_KEY = "test";
  process.env.ANALYTICS_TEAM_ID = "2";
  mock.module("@supabase/supabase-js", { namedExports: { createClient: () => ({ from, rpc }) } });
  // The route's answers are cached for a minute; here every case asks afresh.
  mock.module("../../../../../lib/tools/analytics/cached-get.ts", {
    namedExports: { cachedGet: (handler: () => Promise<Response>) => handler },
  });
  ({ GET } = (await import("./route.ts")) as unknown as { GET: () => Promise<Response> });
}

/* ------------------------------------------------------------ fixtures --- */

const T1 = "2026-10-13T12:00:00+00:00";

const sender = (id: number, over: Row = {}): Row => ({
  id, team_id: 2, email: `inbox${String(id).padStart(5, "0")}@one.com`, name: `Inbox ${id}`,
  provider: "google_workspace_oauth", status: "Connected", vendor: "Zapmail",
  tags: ["Google", "Nicole Pool", "p.Zapmail Google"], archived_at: null, daily_limit: 10,
  warmup_enabled: true, lifetime_sent: id, lifetime_bounced: 1, unique_replied: 2, synced_at: T1,
  ...over,
});
const campaign = (id: number, status: string, over: Row = {}): Row => ({ id, team_id: 2, status, deleted_at: null, ...over });
let sendId = 0;
const send = (sender_email_id: number | null, campaign_id: number, minute: number): Row => ({
  id: ++sendId, team_id: 2, sender_email_id, campaign_id,
  sent_at: new Date(Date.UTC(2026, 9, 1) + minute * 60_000).toISOString(),
});

type Inbox = {
  id: number | string; platform: string; email: string; name: string | null; type: string | null; status: string | null;
  dailyLimit: number | null; sentAllTime: number | null; repliedAllTime: number | null; bouncedAllTime: number | null;
  warmupEnabled: boolean | null; warmup3d: number | null; warmup7d: number | null; vendor: string | null;
  tags: string[]; assignedToCampaign: boolean | null;
};
type Body = { rows: Inbox[]; total: number; asOf: string | null; notes: string[]; error?: string };

async function get(db: Record<string, Row[]>, failing: string[] = []) {
  for (const k of Object.keys(tables)) delete tables[k];
  Object.assign(tables, db);
  down.clear();
  for (const f of failing) down.add(f);
  reads.length = 0;
  const res = await GET!();
  return { status: res.status, body: (await res.json()) as Body };
}
const readsOf = (table: string) => reads.filter((r) => r.table === table);
const byId = (body: Body, id: number | string) => body.rows.find((r) => r.id === id)!;

/* ---------------------------------------------------------------- cases --- */

test("every inbox comes back — the list does not stop at 1,000", { skip }, async () => {
  const live = Array.from({ length: 2300 }, (_, i) => sender(i + 1));
  const r = await get({
    sender_emails: [
      ...live,
      // Deleted upstream, and another team's: neither belongs on the page.
      sender(9001, { archived_at: "2026-08-27T00:00:00Z" }),
      sender(9002, { team_id: 3 }),
    ],
  });

  assert.equal(r.status, 200);
  assert.equal(r.body.total, 2300);
  assert.equal(r.body.rows.length, 2300);
  assert.equal(new Set(r.body.rows.map((x) => x.id)).size, 2300, "no inbox twice, none missing");
  assert.equal(byId(r.body, 9001), undefined);
  assert.equal(byId(r.body, 9002), undefined);
  // Three pages, each asked for by range.
  assert.deepEqual(readsOf("sender_emails").map((x) => x.range), [[0, 999], [1000, 1999], [2000, 2999]]);
});

test("a row carries every field the page shows", { skip }, async () => {
  const r = await get({ sender_emails: [sender(7, { name: "Nicole Collins", email: "nicole@one.com", lifetime_sent: 420, lifetime_bounced: 6, unique_replied: 9 })] });
  assert.deepEqual(r.body.rows, [{
    id: 7, platform: "emailbison", email: "nicole@one.com", name: "Nicole Collins", type: "Google", status: "Connected",
    dailyLimit: 10, sentAllTime: 420, repliedAllTime: 9, bouncedAllTime: 6, warmupEnabled: true, warmup3d: null, warmup7d: null,
    vendor: "Zapmail", tags: ["Google", "Nicole Pool", "p.Zapmail Google"], assignedToCampaign: false,
  }]);
  assert.equal(r.body.asOf, T1);
});

test("the list is A to Z by email", { skip }, async () => {
  const r = await get({
    sender_emails: [sender(1, { email: "Zed@one.com" }), sender(2, { email: "amy@one.com" }), sender(3, { email: "ben@one.com" })],
  });
  assert.deepEqual(r.body.rows.map((x) => x.email), ["amy@one.com", "ben@one.com", "Zed@one.com"]);
});

test("warmup scores are null for everyone, and the note names what would supply them", { skip }, async () => {
  const r = await get({ sender_emails: [sender(1), sender(2)] });
  for (const row of r.body.rows) {
    assert.equal(row.warmup3d, null);
    assert.equal(row.warmup7d, null);
  }
  const note = r.body.notes.find((n) => n.startsWith("Warmup 3d / 7d"));
  assert.ok(note, "there is a warmup note");
  assert.match(note!, /GET \/api\/warmup\/sender-emails/);
});

test("assigned means: has sent for a campaign that can still send", { skip }, async () => {
  const r = await get({
    sender_emails: [1, 2, 3, 4, 5, 6].map((id) => sender(id)),
    campaigns: [
      campaign(10, "active"),
      campaign(11, "paused"),
      campaign(12, "active", { deleted_at: "2026-09-01T00:00:00Z" }),
      campaign(13, "queued"),
      campaign(14, "completed"),
      campaign(15, "active", { team_id: 3 }),
    ],
    campaign_lead_sends: [
      send(1, 10, 1), // an active campaign
      send(2, 11, 2), // only a paused one
      send(3, 12, 3), // only a deleted one
      send(4, 13, 4), // just resumed: queued
      send(5, 14, 5), // only a completed one
      send(5, 15, 6), // …and another team's
      // 6 has never sent.
    ],
  });

  const assigned = Object.fromEntries(r.body.rows.map((x) => [x.id, x.assignedToCampaign]));
  assert.deepEqual(assigned, { 1: true, 2: false, 3: false, 4: true, 5: false, 6: false });
  // The campaign filter is in the query itself, and holds only the live ones.
  for (const read of readsOf("campaign_lead_sends")) assert.deepEqual(read.in.campaign_id, [10, 13]);
  assert.match(r.body.notes[0], /^Assigned: Yes when the inbox has sent at least one email for a campaign that is active now/);
  assert.match(r.body.notes[0], /not synced/);
});

test("a busy inbox does not hide a quiet one: history is read past 1,000 rows", { skip }, async () => {
  const r = await get({
    sender_emails: [sender(1), sender(2), sender(3)],
    campaigns: [campaign(10, "active")],
    campaign_lead_sends: [
      // Inbox 2 sent once, long ago; inbox 1 has 2,500 newer sends.
      send(2, 10, 0),
      ...Array.from({ length: 2500 }, (_, i) => send(1, 10, 100 + i)),
    ],
  });
  assert.equal(byId(r.body, 1).assignedToCampaign, true);
  assert.equal(byId(r.body, 2).assignedToCampaign, true);
  assert.equal(byId(r.body, 3).assignedToCampaign, false);
  // Newest first, then again for only the inboxes not yet seen.
  const walks = readsOf("campaign_lead_sends");
  assert.deepEqual(walks.map((w) => w.in.sender_email_id), [[1, 2, 3], [2, 3]]);
  assert.deepEqual(walks.map((w) => w.returned), [1000, 1]);
});

test("with no campaign sending, nobody is assigned and the history is not read", { skip }, async () => {
  const r = await get({
    sender_emails: [sender(1)],
    campaigns: [campaign(11, "paused")],
    campaign_lead_sends: [send(1, 11, 1)],
  });
  assert.equal(byId(r.body, 1).assignedToCampaign, false);
  assert.equal(readsOf("campaign_lead_sends").length, 0);
});

test("a send history that cannot be read leaves Assigned unknown — never No", { skip }, async () => {
  for (const failing of ["campaign_lead_sends", "campaigns"]) {
    const r = await get(
      { sender_emails: [sender(1), sender(2)], campaigns: [campaign(10, "active")], campaign_lead_sends: [send(1, 10, 1)] },
      [failing],
    );
    assert.equal(r.status, 200, failing);
    assert.equal(r.body.total, 2, "the inboxes are still listed");
    for (const row of r.body.rows) assert.equal(row.assignedToCampaign, null, failing);
    assert.match(r.body.notes[0], /^Assigned could not be worked out just now/);
    assert.match(r.body.notes[0], new RegExp(`${failing} is down`));
  }
});

test("without Instantly accounts, the page is EmailBison alone and says nothing about Instantly", { skip }, async () => {
  const r = await get({ sender_emails: [sender(1)] });
  assert.ok(r.body.rows.every((x) => x.platform === "emailbison"));
  assert.ok(!r.body.notes.some((n) => /Instantly inboxes/.test(n)));
  // Nothing to total, so the totals are not asked for.
  assert.equal(readsOf("analytics_instantly_account_rows").length, 0);
});

test("Instantly accounts are listed too — all of them, past 1,000", { skip }, async () => {
  const accounts = Array.from({ length: 1200 }, (_, i) => ({
    email: `acct${String(i).padStart(4, "0")}@two.com`, team_id: 2, first_name: "Eve", last_name: `Lane ${i}`,
    provider_code: 2, daily_limit: 30, tags: ["Nicole Pool"], synced_at: "2026-10-13T09:00:00+00:00", archived_at: null,
  }));
  const r = await get({
    sender_emails: [sender(1)],
    instantly_accounts: [...accounts, { ...accounts[0], email: "gone@two.com", archived_at: "2026-09-01T00:00:00Z" }],
    // Totals for all but the last account — which has nothing synced.
    analytics_instantly_account_rows: accounts.slice(0, 1199).map((a, i) => ({ email: a.email, sent: 100 + i, bounced: 1, replied: 2 })),
  });

  const instantly = r.body.rows.filter((x) => x.platform === "instantly");
  assert.equal(instantly.length, 1200);
  assert.equal(r.body.total, 1201);
  assert.equal(byId(r.body, "gone@two.com"), undefined);
  assert.deepEqual(byId(r.body, "acct0000@two.com"), {
    id: "acct0000@two.com", platform: "instantly", email: "acct0000@two.com", name: "Eve Lane 0", type: "Google", status: null,
    dailyLimit: 30, sentAllTime: 100, repliedAllTime: 2, bouncedAllTime: 1, warmupEnabled: null, warmup3d: null, warmup7d: null,
    vendor: null, tags: ["Nicole Pool"], assignedToCampaign: null,
  });
  // The 1,150th account's totals are on the second page of the function.
  assert.equal(byId(r.body, "acct1150@two.com").sentAllTime, 1250);
  // Nothing synced for the last one: unknown, not zero.
  assert.equal(byId(r.body, "acct1199@two.com").sentAllTime, null);
  assert.deepEqual(readsOf("instantly_accounts").map((x) => x.range), [[0, 999], [1000, 1999]]);
  assert.deepEqual(readsOf("analytics_instantly_account_rows").map((x) => x.range), [[0, 999], [1000, 1999]]);
  assert.ok(r.body.notes.some((n) => n.startsWith("Instantly inboxes: Sent, Replied and Bounced are the totals of what has been synced")));
});

test("the sync time is the older platform's, so the list is never called fresher than it is", { skip }, async () => {
  const account = (synced_at: string) => ({
    email: "eve@two.com", team_id: 2, first_name: null, last_name: null, provider_code: 2, daily_limit: 30, tags: [], synced_at, archived_at: null,
  });
  const older = await get({
    sender_emails: [sender(1, { synced_at: "2026-10-13T12:00:00+00:00" }), sender(2, { synced_at: "2026-10-13T12:00:04+00:00" })],
    instantly_accounts: [account("2026-10-13T09:00:00+00:00")],
  });
  assert.equal(older.body.asOf, "2026-10-13T09:00:00+00:00");

  const newer = await get({
    sender_emails: [sender(1, { synced_at: "2026-10-13T12:00:00+00:00" }), sender(2, { synced_at: "2026-10-13T12:00:04+00:00" })],
    instantly_accounts: [account("2026-10-13T15:00:00+00:00")],
  });
  // Within a platform it is the newest row; across platforms, the older of those.
  assert.equal(newer.body.asOf, "2026-10-13T12:00:04+00:00");
});

test("Instantly failing leaves the EmailBison inboxes on the page, and says what is missing", { skip }, async () => {
  for (const failing of ["instantly_accounts", "analytics_instantly_account_rows"]) {
    const r = await get(
      {
        sender_emails: [sender(1), sender(2)],
        instantly_accounts: [{ email: "eve@two.com", team_id: 2, first_name: null, last_name: null, provider_code: 2, daily_limit: 30, tags: [], synced_at: T1, archived_at: null }],
      },
      [failing],
    );
    assert.equal(r.status, 200, failing);
    assert.equal(r.body.total, 2);
    assert.ok(r.body.rows.every((x) => x.platform === "emailbison"));
    assert.ok(r.body.notes.some((n) => /^Instantly inboxes could not be loaded just now and are missing from this list/.test(n)), failing);
  }
});

test("if the inbox list itself cannot be read, that is an error — not an empty page", { skip }, async () => {
  const r = await get({ sender_emails: [sender(1)] }, ["sender_emails"]);
  assert.equal(r.status, 500);
  assert.equal(r.body.error, "sender_emails is down");
  assert.equal(r.body.rows, undefined);
});

test("no inboxes at all is an honest empty list", { skip }, async () => {
  const r = await get({});
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.rows, []);
  assert.equal(r.body.total, 0);
  assert.equal(r.body.asOf, null);
});
