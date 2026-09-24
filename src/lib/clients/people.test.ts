import assert from "node:assert/strict";
import { test } from "node:test";

import { portalsFor, totalOf, type MiPortalRow } from "./people";

/*
 * The matching rule is the part worth pinning. Counting is arithmetic; deciding
 * WHICH portals belong to a client is where the one-client-many-portals model
 * either holds or quietly loses a market's agents.
 */

const rows: MiPortalRow[] = [
  { id: "pe-b", name: "Properties & Estates Boston", portal_enabled: true },
  { id: "pe-f", name: "Properties & Estates Florida", portal_enabled: true },
  { id: "ser", name: "SERHANT. PA", portal_enabled: true },
  { id: "ser15", name: "SERHANT. PA 15M+", portal_enabled: true },
  { id: "howe", name: "Howe Realty", portal_enabled: false },
  { id: "unk", name: "Unknown", portal_enabled: true },
];

test("a client with two portals resolves to BOTH", () => {
  const found = portalsFor(
    {
      name: "Properties & Estates",
      aliases: ["Properties & Estates Florida", "Properties & Estates Boston"],
    },
    rows,
  );
  assert.deepEqual(found.map((p) => p.id).sort(), ["pe-b", "pe-f"]);
});

test("counting only the linked portal would lose a market — the total sums both", () => {
  const none = { team: [], agents: [], dnc: [] };
  const total = totalOf([
    { portalId: "pe-b", portalName: "Boston", portalEnabled: true, team: 2, agents: 40, dnc: 100, recent: none },
    { portalId: "pe-f", portalName: "Florida", portalEnabled: true, team: 1, agents: 12, dnc: 30, recent: none },
  ]);
  assert.deepEqual(total, { team: 3, agents: 52, dnc: 130 });
});

test("a single-portal client resolves to exactly one", () => {
  const found = portalsFor({ name: "Howe Realty" }, rows);
  assert.deepEqual(found.map((p) => p.id), ["howe"]);
});

test("an alias finds a portal the primary name does not", () => {
  const found = portalsFor({ name: "SERHANT. PA", aliases: ["SERHANT. PA 15M+"] }, rows);
  assert.deepEqual(found.map((p) => p.id).sort(), ["ser", "ser15"]);
});

test("without the alias, the second portal is missed — the bug this prevents", () => {
  const found = portalsFor({ name: "SERHANT. PA" }, rows);
  assert.deepEqual(found.map((p) => p.id), ["ser"]);
});

test("matching uses the roster's key, so a leading 'the' does not matter", () => {
  const withThe: MiPortalRow[] = [
    { id: "1", name: "The Discover Phx Team", portal_enabled: true },
  ];
  assert.deepEqual(portalsFor({ name: "Discover Phx Team" }, withThe).map((p) => p.id), ["1"]);
});

test("but keyOf does NOT collapse RE/MAX to REMAX — which is why that alias exists", () => {
  // keyOf turns punctuation into a SPACE, so "RE/MAX Pacific" keys as
  // "re max pacific" and "REMAX Pacific" as "remax pacific". They are
  // different, and the roster carries an explicit alias for exactly this.
  // Asserting the real behaviour rather than the behaviour I assumed: a test
  // that agreed with my guess would have hidden why the alias is needed.
  const remax: MiPortalRow[] = [{ id: "2", name: "REMAX Pacific", portal_enabled: true }];
  assert.deepEqual(portalsFor({ name: "RE/MAX Pacific" }, remax), []);
  assert.deepEqual(
    portalsFor({ name: "RE/MAX Pacific", aliases: ["REMAX Pacific"] }, remax).map((p) => p.id),
    ["2"],
    "with the alias it resolves, which is how production is configured",
  );
});

test("a client with no portal resolves to nothing rather than guessing", () => {
  assert.deepEqual(portalsFor({ name: "Nobody At All" }, rows), []);
});

test("a blank name matches nothing — it must never match every blank row", () => {
  const blanks: MiPortalRow[] = [{ id: "x", name: "   ", portal_enabled: true }];
  assert.deepEqual(portalsFor({ name: "" }, blanks), []);
  assert.deepEqual(portalsFor({ name: "   " }, blanks), []);
  assert.deepEqual(portalsFor({ name: "Real Client" }, blanks), []);
});

test("a portal is never counted twice, even if two aliases point at it", () => {
  const found = portalsFor(
    { name: "Howe Realty", aliases: ["howe realty", "HOWE  REALTY"] },
    rows,
  );
  assert.equal(found.length, 1);
});

test("the disabled state of each portal is carried through", () => {
  const found = portalsFor({ name: "Howe Realty" }, rows);
  assert.equal(found[0].portal_enabled, false);
});

test("an empty portal list totals zero without dividing by anything", () => {
  assert.deepEqual(totalOf([]), { team: 0, agents: 0, dnc: 0 });
});
