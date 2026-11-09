import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { draftIntroColumnMissing } from "./draft-intro.ts";

/*
 * A reopened introduction still tags the thread (10 Nov; Amy: Isaac Hernandez, FAST). The saved draft keeps what the
 * Introduce button put in; before migration 0051 adds that column, drafts save and load exactly as before.
 */

test("the column missing is told apart from every other failure: only that is worked around", () => {
  for (const e of [
    { code: "PGRST204", message: "Could not find the 'intro_inserted' column of 'composer_drafts' in the schema cache" },
    { code: "42703", message: "column composer_drafts.intro_inserted does not exist" },
    { message: "column composer_drafts.intro_inserted does not exist" },
  ]) assert.equal(draftIntroColumnMissing(e), true, e.message);
  for (const e of [null, undefined, { code: "42703", message: "column composer_drafts.subject does not exist" }, { code: "23514", message: "new row violates check constraint composer_drafts_intro_inserted_check" }, { code: "42501", message: "permission denied for table composer_drafts" }, { message: "fetch failed" }]) {
    assert.equal(draftIntroColumnMissing(e), false, JSON.stringify(e));
  }
});

// The loader's read, against a stand-in for the table: with the column, and before it exists.
const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";
const ROW = { subject: "Re: hi", body_html: "<p>Hey Isaac!</p>", body_text: "Hey Isaac!", to_addresses: "isaac@example.com", cc_addresses: "elias@example.com", bcc_addresses: null, selected_channel_id: null, add_signature: true, updated_at: "2026-11-09T18:39:05Z" };
function fakeDb(o: { column: boolean; intro: string | null; fail?: { code: string; message: string } }) {
  const asked: string[] = [];
  const from = () => {
    let cols = "";
    const b = {
      select: (c: string) => { cols = c; asked.push(c); return b; },
      eq: () => b,
      maybeSingle: async () => {
        if (o.fail) return { data: null, error: o.fail };
        if (!o.column && cols.includes("intro_inserted")) return { data: null, error: { code: "42703", message: "column composer_drafts.intro_inserted does not exist" } };
        return { data: o.column ? { ...ROW, intro_inserted: o.intro } : { ...ROW }, error: null };
      },
    };
    return b;
  };
  return { db: { from } as never, asked };
}

test("the saved draft comes back with what Introduce put in", { skip }, async () => {
  mock.module("../../../supabase/server", { namedExports: { createServerSupabase: async () => ({}) } });
  const { readComposerDraft } = await import("./thread-detail.ts");
  const { db, asked } = fakeDb({ column: true, intro: "Hey Isaac!\n\nGreat connecting with you!" });
  const r = await readComposerDraft(db, "ws1", "t1");
  assert.equal(r.data?.intro_inserted, "Hey Isaac!\n\nGreat connecting with you!");
  assert.equal(r.data?.body_text, "Hey Isaac!");
  assert.equal(asked.length, 1, "one read");
});

test("before migration 0051 the draft still comes back, exactly as before — never lost to the missing column", { skip }, async () => {
  const { readComposerDraft } = await import("./thread-detail.ts");
  const { db, asked } = fakeDb({ column: false, intro: null });
  const r = await readComposerDraft(db, "ws1", "t1");
  assert.deepEqual(r.data, ROW);
  assert.equal(r.error, null);
  assert.equal(asked.length, 2);
  assert.ok(!asked[1].includes("intro_inserted"), "asked again without it");
});

test("any other failure is not retried and is no draft, as before (the thread view still opens)", { skip }, async () => {
  const { readComposerDraft } = await import("./thread-detail.ts");
  const { db, asked } = fakeDb({ column: true, intro: null, fail: { code: "42501", message: "permission denied" } });
  const r = await readComposerDraft(db, "ws1", "t1");
  assert.equal(r.data, null);
  assert.equal(asked.length, 1);
});
