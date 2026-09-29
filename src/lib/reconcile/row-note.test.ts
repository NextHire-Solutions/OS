import assert from "node:assert/strict";
import { test } from "node:test";

import { rowNote } from "./row-note.ts";

const counts = {
  total: 50, byStatus: { onboarding: 0, active: 31, paused: 9, churned: 10 }, unreadable: [],
  tools: { analytics: { rows: 54, present: 50, absent: [],
    secondRows: [{ name: "SERHANT. PA 15M+", of: "SERHANT. PA" }],
    extras: [{ name: "Demo Portal", reason: "backs the live demo client portal — keep" }, { name: "Test FUB", reason: "" }] } },
};

test("a second portal and a non-client row say why they are not one more client; a client says nothing", () => {
  assert.equal(rowNote(counts, "analytics", "SERHANT. PA 15M+"), "second portal of SERHANT. PA — counted once");
  assert.equal(rowNote(counts, "analytics", "Demo Portal"), "not a client — backs the live demo client portal — keep");
  assert.equal(rowNote(counts, "analytics", "Test FUB"), "not a client");
  assert.equal(rowNote(counts, "analytics", "SERHANT. PA"), null);
  assert.equal(rowNote(counts, "client_health", "Demo Portal"), null, "a tool without counts marks nothing");
  assert.equal(rowNote(null, "analytics", "Demo Portal"), null);
});
