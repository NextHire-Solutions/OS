import assert from "node:assert/strict";
import { test } from "node:test";

import { listed, rowNote } from "./row-note.ts";

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

test("a screen that leaves a non-client row out counts and names only what it lists (Client Portals, 13 Oct)", () => {
  // Master Inbox's table on 13 Oct: 58 rows = 54 clients + 2 second portals +
  // Unknown + Demo Portal. The Client Portals page does not list Unknown.
  const mi = {
    rows: 58,
    extras: [
      { name: "Unknown", reason: "Master Inbox bucket for unattributed replies" },
      { name: "Demo Portal", reason: "backs the live demo client portal — keep" },
    ],
  };
  assert.deepEqual(listed(mi, ["Unknown"]), { rows: 57, extras: [mi.extras[1]] });
  // Nothing omitted: the table as it is.
  assert.deepEqual(listed(mi), { rows: 58, extras: mi.extras });
  // A name that is not one of the non-client rows takes nothing off — a
  // client's row can never be argued out of the count this way.
  assert.deepEqual(listed(mi, ["54 Realty"]), { rows: 58, extras: mi.extras });
});
