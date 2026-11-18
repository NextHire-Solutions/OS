import { test, mock } from "node:test";
import assert from "node:assert/strict";

/*
 * The EmailBison inbox sync's own archive step, run for real (18 Nov) against
 * a database that stops every read at 1,000 rows, as PostgREST does.
 *
 * What it stands for: 3,482 inboxes held, EmailBison listing 2,998, and the
 * 484 it no longer has sitting where a single unpaged read never reached —
 * 419 of them "Not connected" on the Inboxes page while EmailBison showed all
 * connected. reconcile.test.ts tests the helper; this tests that the job uses
 * it the way it must (paged, in order, archiving the right rows).
 */
const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

const CAP = 1000;
type Row = Record<string, unknown>;
const db: { sender_emails: Row[] } = { sender_emails: [] };
const writes: Array<{ op: string; n: number }> = [];

function from(table: "sender_emails") {
  const q = { eq: [] as Array<[string, unknown]>, isNull: [] as string[], in: null as null | [string, unknown[]], order: null as null | string, range: null as null | [number, number], update: null as null | Row };
  const rows = () => db[table];
  const run = () => {
    if (q.update) {
      let n = 0;
      for (const r of rows()) {
        if (q.eq.every(([c, v]) => r[c] === v) && (!q.in || q.in[1].includes(r[q.in[0]]))) { Object.assign(r, q.update); n++; }
      }
      writes.push({ op: "archive", n });
      return { data: null, error: null };
    }
    // Storage order: the rows EmailBison still lists were rewritten by the upsert and sit at the END,
    // so an unpaged, unordered read sees only rows that are not stale. The real database did exactly this.
    let out = [...rows()].sort((a, b) => Number(a._stored) - Number(b._stored))
      .filter((r) => q.eq.every(([c, v]) => r[c] === v) && q.isNull.every((c) => r[c] === null || r[c] === undefined));
    // Without ORDER BY, Postgres promises no order, and two reads of the same table need not agree
    // (a synchronized scan starts wherever another scan is). Each unordered read here starts somewhere else.
    if (q.order) out = [...out].sort((a, b) => Number(a[q.order!]) - Number(b[q.order!]));
    else if (out.length) { const at = (++unorderedReads * 337) % out.length; out = [...out.slice(at), ...out.slice(0, at)]; }
    if (q.range) out = out.slice(q.range[0], q.range[1] + 1);
    out = out.slice(0, CAP);
    return { data: out.map((r) => ({ id: r.id })), error: null };
  };
  const b = {
    select: () => b,
    eq: (c: string, v: unknown) => (q.eq.push([c, v]), b),
    is: (c: string, v: unknown) => (assert.equal(v, null), q.isNull.push(c), b),
    in: (c: string, vs: unknown[]) => ((q.in = [c, vs]), b),
    order: (c: string) => ((q.order = c), b),
    range: (a: number, z: number) => ((q.range = [a, z]), b),
    update: (patch: Row) => ((q.update = patch), b),
    upsert: async (chunk: Row[]) => {
      // As Postgres: an upserted row is rewritten, so it moves to the end of storage.
      for (const row of chunk) {
        const at = rows().findIndex((r) => r.id === row.id);
        const next = { ...(at >= 0 ? rows()[at] : {}), ...row, _stored: ++stored };
        if (at >= 0) rows()[at] = next; else rows().push(next);
      }
      writes.push({ op: "upsert", n: chunk.length });
      return { error: null };
    },
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve().then(run).then(ok, bad),
  };
  return b;
}
let stored = 0;
let unorderedReads = 0;
let listed: Array<{ id: number; email: string; status: string; tags: Array<{ id: number; name: string; default: boolean }> }> = [];

let syncSenders: (ctx: { teamId: number }) => Promise<{ rowsWritten: number; detail?: Record<string, unknown> }>;
test("setup", { skip }, async () => {
  mock.module("@/lib/tools/analytics/supabase", {
    namedExports: { getAnalyticsSupabase: () => ({ from }), analyticsTeamId: () => 2, fetchAllRows: async () => [] },
  });
  mock.module("@/lib/tools/analytics/emailbison/client.ts", {
    namedExports: {
      createEmailBisonClient: () => ({ getAllSenderEmails: async () => listed }),
      EmailBisonApiError: class extends Error {},
    },
  });
  syncSenders = (await import("./jobs.ts")).syncSenders as typeof syncSenders;
});

const tag = (name: string) => ({ id: 1, name, default: false });

test("3,482 held, 2,998 listed: the 484 EmailBison no longer has are archived, wherever they sit", { skip }, async () => {
  db.sender_emails = [];
  stored = 0;
  writes.length = 0;
  // 3,482 inboxes as they were, in id order; every seventh (and a few at the end) since deleted in EmailBison.
  const gone = new Set<number>();
  for (let id = 1; id <= 3482 && gone.size < 484; id++) if (id % 7 === 0) gone.add(id);
  for (let id = 1; id <= 3482; id++) {
    db.sender_emails.push({ id, team_id: 2, archived_at: null, status: gone.has(id) ? "Not connected" : "Connected", _stored: ++stored });
  }
  listed = [];
  for (let id = 1; id <= 3482; id++) if (!gone.has(id)) listed.push({ id, email: `i${id}@d${id % 40}.com`, status: "Connected", tags: [tag("ALL")] });
  assert.equal(gone.size, 484);
  assert.equal(listed.length, 2998);

  const result = await syncSenders({ teamId: 2 });

  assert.equal(result.rowsWritten, 2998);
  assert.equal(result.detail?.archived, 484);
  const shown = db.sender_emails.filter((r) => r.archived_at === null);
  assert.equal(shown.length, 2998);
  assert.ok(shown.every((r) => !gone.has(Number(r.id))), "none of the deleted inboxes is still shown");
  assert.ok(shown.every((r) => r.status === "Connected"), "the ALL tag is all connected, as in EmailBison");
  // Archived in chunks, never one oversized request.
  assert.ok(writes.filter((w) => w.op === "archive").every((w) => w.n <= 200));
});

test("the next run finds nothing more to archive, and writes no archive at all", { skip }, async () => {
  writes.length = 0;
  const result = await syncSenders({ teamId: 2 });
  assert.equal(result.detail?.archived, 0);
  assert.equal(writes.filter((w) => w.op === "archive").length, 0);
});

test("EmailBison listing under half of what is shown (a cut-short walk) archives nothing", { skip }, async () => {
  writes.length = 0;
  listed = listed.slice(0, 1200);
  const result = await syncSenders({ teamId: 2 });
  assert.equal(result.detail?.archived, 0);
  assert.equal(db.sender_emails.filter((r) => r.archived_at === null).length, 2998);
});
