import assert from "node:assert/strict";
import { test } from "node:test";

import { findDuplicates } from "./duplicates";

/*
 * §16 asks for duplicate records to be detectable and §22 makes it a condition
 * of done. The two failure modes these tests pin are the ones that actually
 * cost data: a name collision makes every tool's join arbitrary and makes the
 * campaign matcher abandon BOTH clients, and a shared link means a status
 * written through one master fights the other.
 *
 * The most important test is the first: this must stay silent on a clean
 * roster, because it shipped into a platform that had zero duplicates and a
 * check that cries wolf on day one is a check nobody reads on day two.
 */

test("a clean roster reports nothing at all", () => {
  const report = findDuplicates([
    { id: "1", name: "Alpha Realty" },
    { id: "2", name: "Beta Group", aliases: ["The Beta Group Team"] },
    { id: "3", name: "Gamma Homes", links: { analytics: "an-3", master_inbox: "mi-3" } },
  ]);
  assert.deepEqual(report.findings, []);
  // `checked` exists so "no findings" cannot be confused with "no rows read".
  assert.equal(report.checked, 3);
});

test("an empty roster is not a duplicate", () => {
  assert.deepEqual(findDuplicates([]), { findings: [], checked: 0 });
});

/* ---------------- name collisions ---------------- */

test("two master clients resolving to the same name are reported", () => {
  const report = findDuplicates([
    { id: "1", name: "The Keyes Company" },
    { id: "2", name: "Keyes Company" },
  ]);
  assert.equal(report.findings.length, 1);
  const f = report.findings[0];
  assert.equal(f.kind, "name");
  assert.deepEqual(f.clients.map((c) => c.id), ["1", "2"]);
  // The detail has to say why it matters, not just that it happened.
  assert.match(f.detail, /refuses to guess on a tie/);
});

test("a name colliding with another client's ALIAS is just as ambiguous", () => {
  const report = findDuplicates([
    { id: "1", name: "Spotlight" },
    { id: "2", name: "Spotlight - A Compass Team", aliases: ["Spotlight"] },
  ]);
  assert.equal(report.findings.length, 1);
  const f = report.findings[0];
  assert.deepEqual(f.clients.map((c) => c.name), ["Spotlight", "Spotlight - A Compass Team"]);
  // It names the spelling that collided, so the fix is obvious: drop that alias.
  assert.match(f.detail, /as "Spotlight"/);
});

test("a client's own alias matching its own name is NOT a duplicate", () => {
  // "Norvell&Co Real Estate" / "Norvell & Co" is a real production pair: the
  // ampersand normalises the same either way, and it is one client.
  const report = findDuplicates([
    { id: "1", name: "RE/MAX Pacific", aliases: ["REMAX Pacific", "RE MAX Pacific"] },
  ]);
  assert.deepEqual(report.findings, []);
});

test("the roster's own normalisation is used — accents, ampersands, a leading 'the'", () => {
  for (const [a, b] of [
    ["The Wurst Team", "Wurst Team"],
    ["Norvell & Co", "Norvell and Co"],
    ["Cafe Realty", "Café Realty"],
  ]) {
    const report = findDuplicates([
      { id: "1", name: a },
      { id: "2", name: b },
    ]);
    assert.equal(report.findings.length, 1, `${a} vs ${b} should collide`);
  }
});

test("three clients on one name are reported once, naming all three", () => {
  const report = findDuplicates([
    { id: "1", name: "Summit Realty" },
    { id: "2", name: "summit realty" },
    { id: "3", name: "The Summit Realty" },
  ]);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].clients.length, 3);
});

test("genuinely different names that merely look alike are left alone", () => {
  const report = findDuplicates([
    { id: "1", name: "Douglas Elliman LA" },
    { id: "2", name: "Douglas Elliman Las Vegas" },
  ]);
  // The prefix trap that twice tried to merge two real clients. Distinct keys,
  // so nothing is reported.
  assert.deepEqual(report.findings, []);
});

/* ---------------- shared links ---------------- */

test("two master clients pointing at the same tool row are reported", () => {
  const report = findDuplicates([
    { id: "1", name: "Alpha", links: { analytics: "an-shared" } },
    { id: "2", name: "Beta", links: { analytics: "an-shared" } },
  ]);
  assert.equal(report.findings.length, 1);
  const f = report.findings[0];
  assert.equal(f.kind, "link");
  assert.equal(f.tool, "analytics");
  assert.equal(f.key, "an-shared");
  assert.match(f.detail, /Analytics row/);
  assert.match(f.detail, /one of these links is wrong/);
});

test("each tool is checked separately", () => {
  const report = findDuplicates([
    { id: "1", name: "Alpha", links: { analytics: "x", master_inbox: "y" } },
    { id: "2", name: "Beta", links: { analytics: "x", master_inbox: "y" } },
  ]);
  assert.equal(report.findings.length, 2);
  assert.deepEqual(report.findings.map((f) => f.tool).sort(), ["analytics", "master_inbox"]);
});

test("null, empty and absent links are not duplicates of each other", () => {
  const report = findDuplicates([
    { id: "1", name: "Alpha", links: { analytics: null, client_health: "" } },
    { id: "2", name: "Beta", links: { analytics: null } },
    { id: "3", name: "Gamma" },
  ]);
  // Three clients with no Analytics link are three unlinked clients, which the
  // link checker already reports. Calling them duplicates of each other would
  // be noise on every unlinked client in the roster.
  assert.deepEqual(report.findings, []);
});

test("the same client listed once cannot duplicate itself through its links", () => {
  const report = findDuplicates([
    { id: "1", name: "Alpha", aliases: ["Alpha Team"], links: { analytics: "a", master_inbox: "a" } },
  ]);
  // The same id used in two different tools is normal, not a collision.
  assert.deepEqual(report.findings, []);
});

test("a name collision and a shared link on the same pair are reported separately", () => {
  const report = findDuplicates([
    { id: "1", name: "Same Name", links: { analytics: "shared" } },
    { id: "2", name: "same  name", links: { analytics: "shared" } },
  ]);
  assert.equal(report.findings.length, 2);
  assert.deepEqual(report.findings.map((f) => f.kind).sort(), ["link", "name"]);
});

test("blank and whitespace-only names are ignored rather than colliding", () => {
  const report = findDuplicates([
    { id: "1", name: "   ", aliases: ["", "  "] },
    { id: "2", name: "", aliases: [] },
  ]);
  // Two nameless rows are a different problem, and reporting them as duplicates
  // of one another would point at the wrong fix.
  assert.deepEqual(report.findings, []);
});
