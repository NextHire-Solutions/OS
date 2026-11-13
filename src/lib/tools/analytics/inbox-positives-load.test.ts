import { test, mock } from "node:test";
import assert from "node:assert/strict";

/*
 * Reading Master Inbox for the Inboxes page (14 Nov). The rules are tested in
 * inbox-positives.test.ts; this is the reading, against an in-memory database
 * that stops every answer at 1,000 rows exactly as PostgREST does — a read that
 * forgets to page FAILS here.
 */

type Row = Record<string, unknown>;
const CAP = 1000;
const tables: Record<string, Row[]> = {};
const down = new Set<string>();
const reads: Array<{ table: string; filters: string[]; returned: number }> = [];

function from(table: string) {
  const f: Array<(r: Row) => boolean> = [];
  const named: string[] = [];
  let order: string | null = null;
  let range: [number, number] | null = null;
  let limit: number | null = null;
  const run = () => {
    if (down.has(table)) return { data: null, error: { message: `${table} is down` } };
    let rows = (tables[table] ?? []).filter((r) => f.every((p) => p(r)));
    if (order) rows = [...rows].sort((a, b) => String(a[order!]).localeCompare(String(b[order!])));
    if (range) rows = rows.slice(range[0], range[1] + 1);
    if (limit !== null) rows = rows.slice(0, limit);
    rows = rows.slice(0, CAP);
    reads.push({ table, filters: named, returned: rows.length });
    return { data: rows, error: null };
  };
  const b = {
    select: () => b,
    eq: (c: string, v: unknown) => (f.push((r) => r[c] === v), named.push(`${c}=${v}`), b),
    in: (c: string, vs: unknown[]) => (f.push((r) => vs.includes(r[c])), named.push(`${c} in ${vs.length}`), b),
    gt: (c: string, v: string) => (f.push((r) => String(r[c]) > v), named.push(`${c}>`), b),
    order: (c: string) => ((order = c), b),
    range: (a: number, z: number) => ((range = [a, z]), b),
    limit: (n: number) => ((limit = n), b),
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve().then(run).then(ok, bad),
  };
  return b;
}

const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

let loadReplies: () => Promise<{ conversations: Array<{ threadId: string; platform: string | null; candidates: string[]; positive: boolean }>; asOf: string }>;
test("setup", { skip }, async () => {
  mock.module("@/lib/tools/master-inbox/supabase", { namedExports: { getMasterInboxSupabase: () => ({ from }) } });
  // Every case reads afresh; the cache itself is ttl.ts's, tested there.
  mock.module("@/lib/cache/ttl", { namedExports: { ttlCache: (fn: () => unknown) => fn } });
  ({ loadReplies } = (await import("./inbox-positives-load.ts")) as unknown as { loadReplies: typeof loadReplies });
});

const pad = (n: number) => String(n).padStart(6, "0");
const id = (prefix: string, n: number) => `${prefix}-${pad(n)}`;
function fill(o: { threads: number; positive: number[]; trash?: number[]; labels?: Record<number, string> }) {
  for (const k of Object.keys(tables)) delete tables[k];
  down.clear();
  reads.length = 0;
  tables.labels = ["Interested", "Introduction", "OOO", "Not Interested"].map((name, i) => ({ id: `L${i}`, name }));
  const labelId = (name: string) => (tables.labels.find((l) => l.name === name)!.id as string);
  tables.threads = Array.from({ length: o.threads }, (_, i) => ({
    id: id("t", i), status: o.trash?.includes(i) ? "trash" : "open", source_provider: i % 2 ? "instantly" : "emailbison",
    outbound_sender_email: i === 3 ? "nicole@brokerstaffer.com" : `cold${i % 40}@one.com`,
  }));
  tables.label_history = o.positive.flatMap((i, k) => [
    { id: id("h", k * 2), thread_id: id("t", i), label_name: "Interested" },
    // Introduced afterwards: a second history row for the same conversation.
    { id: id("h", k * 2 + 1), thread_id: id("t", i), label_name: "Introduction" },
  ]);
  tables.label_assignments = Object.entries(o.labels ?? {}).map(([i, name], k) => ({ id: id("a", k), target_type: "thread", target_id: id("t", Number(i)), label_id: labelId(name) }));
  tables.messages = tables.threads.flatMap((t, i) => [
    { id: id("m", i * 3), thread_id: t.id, direction: "outbound", sender: `Cold${i % 40}@One.com`, recipients: { to: ["lead@x.com"] }, sent_at: "2026-11-01T09:00:00Z" },
    { id: id("m", i * 3 + 1), thread_id: t.id, direction: "inbound", sender: "lead@x.com", recipients: { to: [`cold${i % 40}@one.com`] }, sent_at: "2026-11-02T09:00:00Z" },
    { id: id("m", i * 3 + 2), thread_id: t.id, direction: "inbound", sender: "lead@x.com", recipients: { to: ["nicole@brokerstaffer.com"] }, sent_at: "2026-11-03T09:00:00Z" },
  ]);
}

test("every conversation, label and reply is read — far past 1,000 of each", { skip }, async () => {
  fill({ threads: 2500, positive: Array.from({ length: 700 }, (_, i) => i * 3), labels: Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [i, "Not Interested"])) });
  const r = await loadReplies();
  assert.equal(r.conversations.length, 2500, "every conversation is a reply");
  assert.equal(r.conversations.filter((c) => c.positive).length, 700 - Math.ceil(1500 / 3), "positives corrected to Not Interested are not positive");
  // 1,400 history rows, 2,500 conversations, 1,500 labels, 5,000 replies: all of them, in pages.
  const sum = (t: string) => reads.filter((x) => x.table === t).reduce((n, x) => n + x.returned, 0);
  assert.equal(sum("label_history"), 1400);
  assert.equal(sum("threads"), 2500);
  assert.equal(sum("label_assignments"), 1500);
  const inbound = reads.filter((x) => x.table === "messages" && x.filters.includes("direction=inbound"));
  assert.equal(inbound.reduce((n, x) => n + x.returned, 0), 5000);
  assert.ok(inbound.slice(1).every((x) => x.filters.includes("id>")), "each page of replies starts after the last");
});

test("the inbox is the first reply's, not the one the conversation shows now", { skip }, async () => {
  fill({ threads: 5, positive: [3], labels: { 3: "Introduction" } });
  const r = await loadReplies();
  const t3 = r.conversations.find((c) => c.threadId === id("t", 3))!;
  assert.equal(t3.positive, true);
  assert.equal(t3.platform, "instantly");
  assert.deepEqual(t3.candidates, ["cold3@one.com", "nicole@brokerstaffer.com"]);
});

test("our first email is read for positive conversations only — and not for one in Trash", { skip }, async () => {
  fill({ threads: 400, positive: [1, 2, 5], trash: [5] });
  await loadReplies();
  const outbound = reads.filter((x) => x.table === "messages" && x.filters.includes("direction=outbound"));
  assert.deepEqual(outbound.map((x) => x.filters.find((f) => f.startsWith("thread_id in"))), ["thread_id in 2"]);
});

test("an out-of-office is no reply, and Trash is nothing", { skip }, async () => {
  fill({ threads: 6, positive: [], trash: [1], labels: { 2: "OOO" } });
  const r = await loadReplies();
  assert.deepEqual(r.conversations.map((c) => c.threadId), [0, 3, 4, 5].map((i) => id("t", i)));
});

test("a read that fails says which, in words; nothing half-read is answered", { skip }, async () => {
  for (const [table, what] of [["label_history", "label history"], ["threads", "conversations"], ["label_assignments", "labels now"], ["messages", "replies"]] as const) {
    fill({ threads: 3, positive: [1] });
    down.add(table);
    await assert.rejects(loadReplies(), new RegExp(`^Error: Master Inbox ${what}: ${table} is down$`), table);
  }
});

test("nothing marked positive yet: every reply, none positive, and no sent email read", { skip }, async () => {
  fill({ threads: 3, positive: [] });
  const r = await loadReplies();
  assert.equal(r.conversations.length, 3);
  assert.ok(r.conversations.every((c) => !c.positive));
  assert.equal(reads.filter((x) => x.filters.includes("direction=outbound")).length, 0);
});

test("every large read pages by id, never by offset — a label changed mid-read cannot shift a row", { skip }, async () => {
  fill({ threads: 2500, positive: Array.from({ length: 700 }, (_, i) => i * 3), labels: Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [i, "Not Interested"])) });
  await loadReplies();
  for (const table of ["label_history", "threads", "label_assignments"]) {
    const pages = reads.filter((x) => x.table === table);
    assert.ok(pages.length > 1, `${table} needed more than one page`);
    assert.ok(pages.slice(1).every((x) => x.filters.includes("id>")), `${table}: each page after the last id`);
  }
});

test("every label a conversation carries is read: any 'no' among them corrects a positive", { skip }, async () => {
  fill({ threads: 4, positive: [1, 2, 3] });
  const L = (name: string) => tables.labels.find((l) => l.name === name)!.id;
  tables.label_assignments = [
    { id: "a-1", target_type: "thread", target_id: id("t", 1), label_id: L("Introduction") },
    // The "no" label first and last, so keeping either one label alone is caught.
    { id: "a-2", target_type: "thread", target_id: id("t", 2), label_id: L("Not Interested") },
    { id: "a-3", target_type: "thread", target_id: id("t", 2), label_id: L("Introduction") },
    { id: "a-4", target_type: "thread", target_id: id("t", 3), label_id: L("Introduction") },
    { id: "a-5", target_type: "thread", target_id: id("t", 3), label_id: L("Not Interested") },
  ];
  const r = await loadReplies();
  const positive = Object.fromEntries(r.conversations.map((c) => [c.threadId, c.positive]));
  assert.equal(positive[id("t", 1)], true);
  assert.equal(positive[id("t", 2)], false);
  assert.equal(positive[id("t", 3)], false);
});
