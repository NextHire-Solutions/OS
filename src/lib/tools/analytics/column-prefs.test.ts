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

test("several steps: a choice two versions back gains both steps' columns; one version back only the last", () => {
  const steps = [
    { from: 1, add: ["miReplies", "positive", "positiveRate"] },
    { from: 2, add: ["bounceRate"] },
  ];
  assert.deepEqual(restoreColumns(saved(1, ["sent", "positive"]), 3, steps), {
    visible: ["sent", "positive", "miReplies", "positiveRate", "bounceRate"],
    upgraded: true,
  });
  assert.deepEqual(restoreColumns(saved(2, ["sent"]), 3, steps), { visible: ["sent", "bounceRate"], upgraded: true });
  // Unticked before the upgrade, unticked after: a column the choice already had is not added twice.
  assert.deepEqual(restoreColumns(saved(2, ["bounceRate", "sent"]), 3, steps), { visible: ["bounceRate", "sent"], upgraded: true });
  assert.deepEqual(restoreColumns(saved(3, ["sent"]), 3, steps), { visible: ["sent"], upgraded: false });
  for (const v of [0, 4]) assert.equal(restoreColumns(saved(v, ["sent"]), 3, steps), null, String(v));
  // Given out of order, the steps still apply oldest first.
  assert.deepEqual(restoreColumns(saved(1, ["sent"]), 3, [...steps].reverse()), {
    visible: ["sent", "miReplies", "positive", "positiveRate", "bounceRate"],
    upgraded: true,
  });
});

test("the Inboxes page: one step per version up to this one, each adding real columns that show by default", () => {
  const steps = [...INBOX_COLUMNS_ADDED].sort((a, b) => a.from - b.from);
  steps.forEach((step, i) => assert.equal(step.from, i + 1));
  assert.equal(INBOX_COLUMN_PREFS_VERSION, steps.at(-1)!.from + 1);
  for (const step of steps) {
    for (const key of step.add) {
      const col = INBOX_COLUMNS.find((c) => c.key === key);
      assert.ok(col, key);
      assert.equal(col!.defaultVisible, true, key);
    }
  }
  // Someone who picked columns before Bounce rate existed sees it now.
  assert.ok(restoreColumns(saved(2, ["sent"]), INBOX_COLUMN_PREFS_VERSION, INBOX_COLUMNS_ADDED)!.visible.includes("bounceRate"));
  assert.ok(restoreColumns(saved(1, ["sent"]), INBOX_COLUMN_PREFS_VERSION, INBOX_COLUMNS_ADDED)!.visible.includes("bounceRate"));
});
