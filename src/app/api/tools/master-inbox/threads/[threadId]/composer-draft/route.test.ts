import { test, mock } from "node:test";
import assert from "node:assert/strict";

/*
 * The composer's autosave, through the real route, against a stand-in for the table (10 Nov): what the Introduce button
 * put in is saved with the draft, so a reopened introduction still tags the thread on send; before migration 0051 the
 * draft saves exactly as it always has.
 */
const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

let column = true;
let otherFailure: { code: string; message: string } | null = null;
const saved: Array<Record<string, unknown>> = [];
const from = (table: string) => ({
  upsert: async (row: Record<string, unknown>, opts: { onConflict: string }) => {
    assert.equal(table, "composer_drafts");
    assert.equal(opts.onConflict, "workspace_id,thread_id");
    if (otherFailure) return { error: otherFailure };
    if (!column && "intro_inserted" in row) return { error: { code: "PGRST204", message: "Could not find the 'intro_inserted' column of 'composer_drafts' in the schema cache" } };
    saved.push(row);
    return { error: null };
  },
});

let PUT: (r: Request, c: { params: Promise<{ threadId: string }> }) => Promise<Response>;
let POST: typeof PUT;
const send = (body: unknown, how: "PUT" | "POST" = "PUT") =>
  (how === "PUT" ? PUT : POST)(new Request("http://x/", { method: how, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), { params: Promise.resolve({ threadId: "t1" }) });
const DRAFT = { subject: "Connecting you with #TEAMFAST | Isaac Hernandez", body_html: "<p>Hey Isaac!</p>", body_text: "Hey Isaac!", to_addresses: "isaac@example.com", cc_addresses: "elias@example.com", bcc_addresses: null, selected_channel_id: null, add_signature: false };
const INTRO = "Hey Isaac!\n\nGreat connecting with you! I'd love to introduce you to Elias Astuto, our Director of Sales.";

test("setup", { skip }, async () => {
  const up = "../../../../../../../lib";
  mock.module(`${up}/auth/workspace`, { namedExports: { requireSession: async () => ({ activeWorkspace: { id: "ws1" } }) } });
  mock.module(`${up}/supabase/server`, { namedExports: { createServerSupabase: async () => ({ from }) } });
  ({ PUT, POST } = await import("./route"));
});

test("what Introduce put in is saved with the draft, on the autosave and on the beacon when leaving", { skip }, async () => {
  for (const how of ["PUT", "POST"] as const) {
    saved.length = 0;
    column = true;
    const r = await send({ ...DRAFT, intro_inserted: INTRO }, how);
    assert.equal(r.status, 200, how);
    assert.equal(saved[0].intro_inserted, INTRO, how);
    assert.equal(saved[0].workspace_id, "ws1");
    assert.equal(saved[0].thread_id, "t1");
  }
});

test("a draft written by hand, or from a composer opened before this change, carries none", { skip }, async () => {
  saved.length = 0;
  for (const body of [DRAFT, { ...DRAFT, intro_inserted: null }]) assert.equal((await send(body)).status, 200);
  assert.deepEqual(saved.map((r) => r.intro_inserted), [null, null]);
});

test("before migration 0051: the draft saves exactly as it always has, without the mark", { skip }, async () => {
  saved.length = 0;
  column = false;
  const r = await send({ ...DRAFT, intro_inserted: INTRO });
  assert.equal(r.status, 200);
  assert.equal(saved.length, 1);
  assert.ok(!("intro_inserted" in saved[0]));
  assert.equal(saved[0].body_text, "Hey Isaac!");
  column = true;
});

test("any other failure is a failure, as before: not retried, not hidden", { skip }, async () => {
  saved.length = 0;
  otherFailure = { code: "42501", message: "permission denied for table composer_drafts" };
  const r = await send({ ...DRAFT, intro_inserted: INTRO });
  assert.equal(r.status, 500);
  assert.equal(saved.length, 0);
  otherFailure = null;
});

test("an introduction past the column's limit is refused, never cut", { skip }, async () => {
  assert.equal((await send({ ...DRAFT, intro_inserted: "x".repeat(20_001) })).status, 400);
  assert.equal((await send({ ...DRAFT, intro_inserted: 42 })).status, 400);
  assert.equal((await send({ ...DRAFT, intro_inserted: "x".repeat(20_000) })).status, 200);
});
