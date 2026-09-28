import { test } from "node:test";
import assert from "node:assert/strict";

import { statusByListName } from "./list-status";
import { normalizeClientName } from "./lists-shared";

const k = normalizeClientName;

test("the master's status, not Client Health's booleans", () => {
  const { byName } = statusByListName([{ name: "Discover Phx Team", aliases: [], status: "active", inboxNames: ["Discover Phx Team"] }]);
  assert.equal(byName[k("Discover Phx Team")], "active");
});

test("a second portal's list finds its client through the inbox row name", () => {
  const { byName } = statusByListName([
    { name: "Properties & Estates", aliases: [], status: "paused", inboxNames: ["Properties & Estates Boston", "Properties & Estates Florida"] },
  ]);
  assert.equal(byName[k("Properties & Estates Florida")], "paused");
  assert.equal(byName[k("Properties & Estates Boston")], "paused");
});

test("aliases are keys too", () => {
  const { byName } = statusByListName([{ name: "LIV Indy Realty", aliases: ["Indy Realty"], status: "churned", inboxNames: [] }]);
  assert.equal(byName[k("Indy Realty")], "churned");
});

test("onboarding clients get no dot and are not counted", () => {
  const r = statusByListName([{ name: "New Co", aliases: [], status: "onboarding", inboxNames: ["New Co"] }]);
  assert.equal(r.byName[k("New Co")], undefined);
  assert.deepEqual(r.counts, { active: 0, paused: 0, churned: 0 });
});

test("a name two clients claim with different statuses is dropped, not guessed", () => {
  const { byName } = statusByListName([
    { name: "A", aliases: ["Shared"], status: "active", inboxNames: [] },
    { name: "B", aliases: ["Shared"], status: "paused", inboxNames: [] },
  ]);
  assert.equal(byName[k("Shared")], undefined);
  assert.equal(byName[k("A")], "active");
});

test("counts are per client, not per name", () => {
  const r = statusByListName([{ name: "A", aliases: ["A2", "A3"], status: "active", inboxNames: ["A"] }]);
  assert.deepEqual(r.counts, { active: 1, paused: 0, churned: 0 });
});
