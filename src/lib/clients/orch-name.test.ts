import assert from "node:assert/strict";
import { test } from "node:test";

import { findOrchCollision, isMatchableOrchName, orchKey } from "./orch-name";

/*
 * THIS TEST IS THE CONTRACT with the Database app's `normClientName`.
 *
 * The OS creates the Database record, and that row is matched to campaigns by
 * that function every six hours. If the two rules drift, a client created here
 * can collide with one already there — and the matcher answers a tie by
 * abandoning BOTH clients, so the existing one silently loses its attribution.
 * If the Database app's rule changes, these cases are what should fail.
 */

test("the four steps of the Database app's normalisation", () => {
  assert.equal(orchKey("Acme Realty"), "acmerealty", "lowercase + strip punctuation");
  assert.equal(orchKey("RE/MAX Pacific"), "remaxpacific", "slashes go");
  assert.equal(orchKey("Copy of Acme Realty"), "acmerealty", "'copy of' is dropped");
  assert.equal(orchKey("The Keyes Company"), "keyescompany", "a leading 'the' is dropped");
  assert.equal(orchKey("Norvell & Co"), "norvellco", "ampersand is punctuation here, NOT ' and '");
});

test("orchKey is NOT the roster's keyOf — the difference is the whole point", () => {
  // roster keyOf maps "&" to " and " and keeps word spacing; this one strips
  // everything. Mirroring the wrong rule is how the original bug happened.
  assert.equal(orchKey("Norvell & Co"), "norvellco");
  assert.equal(orchKey("Norvell and Co"), "norvellandco");
  assert.notEqual(orchKey("Norvell & Co"), orchKey("Norvell and Co"));
});

test("the collision that broke The Keyes Company is caught", () => {
  const rows = [{ id: "keyes", client_name: "The Keyes Company" }];
  const hit = findOrchCollision("Keyes Company", rows);
  assert.equal(hit?.id, "keyes");
});

test("'Copy of X' collides with X", () => {
  const rows = [{ id: "1", client_name: "Momentum Lux Realty" }];
  assert.equal(findOrchCollision("Copy of Momentum Lux Realty", rows)?.id, "1");
});

test("an exact repeat collides, whatever the spacing or case", () => {
  const rows = [{ id: "1", client_name: "Jeff Cook Real Estate" }];
  for (const v of ["jeff cook real estate", "JEFF  COOK  REAL ESTATE", "Jeff-Cook-Real-Estate"]) {
    assert.equal(findOrchCollision(v, rows)?.id, "1", v);
  }
});

test("genuinely different clients do not collide", () => {
  const rows = [
    { id: "1", client_name: "Douglas Elliman LA" },
    { id: "2", client_name: "Howe Realty" },
  ];
  assert.equal(findOrchCollision("Douglas Elliman Las Vegas", rows), null);
  assert.equal(findOrchCollision("Howe Realty Group", rows), null);
  assert.equal(findOrchCollision("Brand New Brokerage", rows), null);
});

test("blank names and blank rows collide with nothing", () => {
  assert.equal(findOrchCollision("", [{ id: "1", client_name: "Acme" }]), null);
  assert.equal(findOrchCollision("   ", [{ id: "1", client_name: "Acme" }]), null);
  assert.equal(findOrchCollision("Acme", [{ id: "1", client_name: null }]), null);
  assert.equal(findOrchCollision("Acme", [{ id: "1", client_name: "  " }]), null);
});

test("a name that normalises to nothing collides with nothing", () => {
  // "---" reduces to "" and must not match every blank-ish row.
  assert.equal(findOrchCollision("---", [{ id: "1", client_name: "###" }]), null);
});

test("the first colliding row is returned, so linking is deterministic", () => {
  const rows = [
    { id: "a", client_name: "The Summit Group" },
    { id: "b", client_name: "Summit Group" },
  ];
  assert.equal(findOrchCollision("summit group", rows)?.id, "a");
});

test("a name the matcher could never match is flagged", () => {
  // makeCampaignMatcher skips normalised names shorter than 3 characters.
  assert.equal(isMatchableOrchName("Oz Group"), true);
  assert.equal(isMatchableOrchName("Oz"), false);
  assert.equal(isMatchableOrchName("The Oz"), false, "'the' is dropped first, leaving 'oz'");
  assert.equal(isMatchableOrchName("---"), false);
  assert.equal(isMatchableOrchName(""), false);
});
