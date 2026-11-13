import { test } from "node:test";
import assert from "node:assert/strict";

import { restoreColumns } from "./column-prefs.ts";
import { INBOX_COLUMNS, INBOX_COLUMNS_ADDED, INBOX_COLUMN_PREFS_VERSION } from "./inboxes.ts";

/*
 * A saved column choice (14 Nov). The new Inboxes columns must reach the people
 * who had already picked their columns, without losing what they picked.
 */

const saved = (version: unknown, visible: unknown) => JSON.stringify({ version, visible });

test("a choice saved at this version is used as it is", () => {
  assert.deepEqual(restoreColumns(saved(2, ["sent", "vendor"]), 2), { visible: ["sent", "vendor"], upgraded: false });
});

test("a choice from before the new columns keeps everything and gains them, once", () => {
  const carry = { from: 1, add: ["miReplies", "positive", "positiveRate"] };
  assert.deepEqual(restoreColumns(saved(1, ["sent", "positive"]), 2, carry), {
    visible: ["sent", "positive", "miReplies", "positiveRate"],
    upgraded: true,
  });
});

test("any other version, or nothing readable, is nothing: the table's defaults", () => {
  const carry = { from: 1, add: ["positive"] };
  for (const raw of [null, "", "{", "null", saved(0, ["sent"]), saved(3, ["sent"]), saved(2, []), saved(2, "sent"), JSON.stringify({ visible: ["sent"] })]) {
    assert.equal(restoreColumns(raw, 2, carry), null, String(raw));
  }
  assert.equal(restoreColumns(saved(1, ["sent"]), 2), null, "an older choice with no carry named is the defaults, as before");
});

test("names that are not text are dropped", () => {
  assert.deepEqual(restoreColumns(saved(2, ["sent", 4, null, "vendor"]), 2), { visible: ["sent", "vendor"], upgraded: false });
});

test("the Inboxes page: the version moved on, and what it adds is real columns that show by default", () => {
  assert.equal(INBOX_COLUMN_PREFS_VERSION, INBOX_COLUMNS_ADDED.from + 1);
  for (const key of INBOX_COLUMNS_ADDED.add) {
    const col = INBOX_COLUMNS.find((c) => c.key === key);
    assert.ok(col, key);
    assert.equal(col!.defaultVisible, true, key);
  }
});
