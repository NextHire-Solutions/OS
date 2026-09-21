import assert from "node:assert/strict";
import { test } from "node:test";

import { readOnly, AssistantWriteAttemptError, isForbiddenRpc } from "./read-only.ts";

/*
 * The guard that stops a chat message from writing to a live product.
 *
 * These are not tests of a clever implementation — they are the statement of
 * the policy. Master Inbox serves 47 login-free customer portals from the same
 * database the assistant reads, so "a tool cannot write" has to be a property
 * that fails loudly, not a convention.
 */

/** A stand-in with the shape that matters: a client whose from() chains. */
function fakeClient() {
  const builder: Record<string, unknown> = {};
  for (const verb of ["select", "eq", "order", "limit", "in", "gte"]) {
    builder[verb] = () => builder;
  }
  for (const verb of ["insert", "update", "upsert", "delete"]) {
    builder[verb] = () => builder;
  }
  return {
    from: () => builder,
    rpc: (name: string) => ({ name }),
    insert: () => "client-level insert",
  };
}

test("the write verbs are refused on the client itself", () => {
  const db = readOnly(fakeClient());
  assert.throws(() => (db as unknown as { insert: () => void }).insert(), AssistantWriteAttemptError);
});

test("the write verbs are refused on a builder returned by from()", () => {
  const db = readOnly(fakeClient());
  const table = db.from() as unknown as Record<string, () => unknown>;
  for (const verb of ["insert", "update", "upsert", "delete"]) {
    assert.throws(() => table[verb](), AssistantWriteAttemptError, `${verb} must be refused`);
  }
});

/*
 * The one that would actually have been missed. Every chained call hands back
 * a builder, so guarding only the object from() returned would leave
 * .select().eq().delete() wide open — one hop further than the obvious test.
 */
test("the guard survives chaining", () => {
  const db = readOnly(fakeClient());
  const chained = (db.from() as unknown as Record<string, () => unknown>)
    .select() as Record<string, () => unknown>;
  const deeper = chained.eq() as Record<string, () => unknown>;
  assert.throws(() => deeper.delete(), AssistantWriteAttemptError);
  assert.throws(() => deeper.update(), AssistantWriteAttemptError);
});

test("reads still work", () => {
  const db = readOnly(fakeClient());
  const table = db.from() as unknown as Record<string, () => unknown>;
  assert.doesNotThrow(() => table.select());
  assert.doesNotThrow(() => (table.select() as Record<string, () => unknown>).eq());
});

test("a read function is allowed through rpc, a writing one is not", () => {
  const db = readOnly(fakeClient());
  assert.doesNotThrow(() => db.rpc("analytics_campaign_rows"));
  assert.throws(() => db.rpc("reply_agent_set_key"), AssistantWriteAttemptError);
  assert.throws(() => db.rpc("ai_labeling_set_key"), AssistantWriteAttemptError);
  assert.throws(() => db.rpc("fn_undo_agent_contact"), AssistantWriteAttemptError);
});

test("the refused-function patterns match the real writing functions", () => {
  // Names taken from the live estate's function lists.
  for (const fn of ["reply_agent_set_key", "ai_labeling_set_key", "ai_labeling_touch_run",
                    "fn_undo_agent_contact", "fn_refresh_perf_views", "fn_export_rows"]) {
    assert.equal(isForbiddenRpc(fn), true, `${fn} writes and must be refused`);
  }
  for (const fn of ["analytics_campaign_rows", "analytics_inbox_tags", "portal_counts",
                    "sender_ids_by_tag", "business_seconds"]) {
    assert.equal(isForbiddenRpc(fn), false, `${fn} only reads and must be allowed`);
  }
});
