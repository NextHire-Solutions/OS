/*
 * The Inboxes route with Instantly SWITCHED OFF in Campaign Analytics (instantly-switch.ts, 19 Nov 2026 —
 * the real switch, not mocked). route.test.ts pins it on and keeps guarding the Instantly half; the fake
 * database, the cap and the fixtures below are that file's, copied so both sides run against the same rules.
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

type Conversation = { threadId: string; platform: "emailbison" | "instantly" | null; candidates: string[]; positive: boolean };
/** What Master Inbox answers (inbox-positives-load.ts), set per case. */
let masterInbox: () => Promise<{ conversations: Conversation[]; asOf: string }> = async () => ({ conversations: [], asOf: "2026-11-14T10:00:00.000Z" });

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
  // Master Inbox is read by its own loader, tested on its own; here it says what each case needs.
  mock.module("../../../../../lib/tools/analytics/inbox-positives-load.ts", {
    namedExports: { loadReplies: () => masterInbox() },
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
  masterInboxReplies: number | null; positiveAllTime: number | null;
  warmupEnabled: boolean | null; warmup3d: number | null; warmup7d: number | null; vendor: string | null;
  tags: string[]; assignedToCampaign: boolean | null;
};
type Body = { rows: Inbox[]; total: number; asOf: string | null; notes: string[]; positivesAsOf: string | null; error?: string };

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
const account = (email: string) => ({
  email, team_id: 2, first_name: null, last_name: null, provider_code: 2, daily_limit: 30, tags: [], synced_at: T1, archived_at: null,
});
const conv = (threadId: string, candidates: string[], over: Partial<Conversation> = {}): Conversation => ({
  threadId, platform: "emailbison", candidates, positive: false, ...over,
});
const answering = (conversations: Conversation[]) => {
  masterInbox = async () => ({ conversations, asOf: "2026-11-14T10:00:00.000Z" });
};


test("switched off: only EmailBison inboxes, and Instantly is never read", { skip }, async () => {
  const r = await get({
    sender_emails: [sender(1), sender(2)],
    instantly_accounts: [account("acct1@two.com"), account("acct2@two.com")],
    analytics_instantly_account_rows: [{ email: "acct1@two.com", sent: 5, bounced: 0, replied: 1 }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 2);
  assert.ok(r.body.rows.every((x) => x.platform === "emailbison"));
  assert.equal(readsOf("instantly_accounts").length, 0, "no Instantly table read");
  assert.equal(readsOf("analytics_instantly_account_rows").length, 0, "no Instantly totals read");
  assert.ok(!r.body.notes.some((n) => /Instantly/.test(n)), r.body.notes.join(" | "));
});

test("switched off: a reply through Instantly is set aside quietly, never counted as a stray or on the EmailBison inbox with its address", { skip }, async () => {
  answering([
    conv("1", ["shared@one.com"], { platform: "instantly", positive: true }),
    conv("2", ["shared@one.com"], { platform: "emailbison" }),
    conv("3", ["inbox00001@one.com"], { positive: true }),
  ]);
  try {
    const r = await get({
      sender_emails: [sender(1), sender(2, { email: "shared@one.com" })],
      instantly_accounts: [account("shared@one.com")],
    });
    assert.deepEqual([byId(r.body, 1).masterInboxReplies, byId(r.body, 1).positiveAllTime], [1, 1]);
    // The EmailBison inbox with the same address keeps only its own reply.
    assert.deepEqual([byId(r.body, 2).masterInboxReplies, byId(r.body, 2).positiveAllTime], [1, 0]);
    assert.ok(!r.body.notes.some((n) => /not an inbox on either platform/.test(n)), "not reported as a stray");
    assert.ok(!r.body.notes.some((n) => /Instantly/.test(n)), r.body.notes.join(" | "));
  } finally {
    answering([]);
  }
});
