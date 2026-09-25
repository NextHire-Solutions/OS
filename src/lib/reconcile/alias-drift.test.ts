import assert from "node:assert/strict";
import { test } from "node:test";

import { findAliasDrift, type AliasToolRow } from "./alias-drift";

const rows = (...list: AliasToolRow[]) => ({ rows: new Map(list.map((r) => [r.id, r])) });

/*
 * The rule this pins is the one that cost 96 pointless writes when I got it
 * wrong: a master alias that IS the tool's own name is already matched, and
 * reporting it buries the handful that genuinely break attribution.
 */

test("a spelling the tool does not know is drift", () => {
  const report = findAliasDrift(
    [{ name: "Douglas Elliman LA", aliases: ["Douglas Elliman Los Angeles"], links: { analytics: "a1" } }],
    { analytics: rows({ id: "a1", name: "Douglas Elliman LA", aliases: [] }) },
  );
  assert.equal(report.findings.length, 1);
  assert.deepEqual(report.findings[0].missing, ["Douglas Elliman Los Angeles"]);
  // The detail has to say what it costs, not just that it differs.
  assert.match(report.findings[0].detail, /counted against nobody/);
});

test("the master's own name matching the tool's name is NOT drift", () => {
  // The case that produced 96 findings changing no matching: the tool is
  // already called what the master calls it, so writing that name into its
  // alias list would change nothing.
  const report = findAliasDrift(
    [{ name: "Carolina Realty Advisors", aliases: [], links: { analytics: "a1" } }],
    { analytics: rows({ id: "a1", name: "Carolina Realty Advisors", aliases: [] }) },
  );
  assert.deepEqual(report.findings, []);
  assert.equal(report.sound, 1);
});

test("but a tool that does not know the master's NAME is drift", () => {
  // Analytics is called "Momentum Lux Realty" and has no alias, so a campaign
  // named "Momentum Realty + ..." matches nothing. The master's primary name
  // counts as a spelling like any other -- this is the half I first got wrong
  // by assuming a tool's own name always covers it.
  const report = findAliasDrift(
    [{ name: "Momentum Realty", aliases: ["Momentum Lux Realty"], links: { analytics: "a1" } }],
    { analytics: rows({ id: "a1", name: "Momentum Lux Realty", aliases: [] }) },
  );
  assert.equal(report.findings.length, 1);
  assert.deepEqual(report.findings[0].missing, ["Momentum Realty"]);
});

test("a tool holding an EXTRA alias is not drift either", () => {
  // Tools pick spellings up from their own campaign data. An extra one costs
  // nothing, and removing it could unattribute a campaign.
  const report = findAliasDrift(
    [{ name: "Alpha", aliases: [], links: { analytics: "a1" } }],
    { analytics: rows({ id: "a1", name: "Alpha", aliases: ["Alpha Group", "Alpha Team"] }) },
  );
  assert.deepEqual(report.findings, []);
  assert.equal(report.sound, 1);
});

test("matching ignores punctuation, case and spacing", () => {
  const report = findAliasDrift(
    [{ name: "C21 Results Elite Team", aliases: ["C21 Results - Elite Team"], links: { analytics: "a1" } }],
    { analytics: rows({ id: "a1", name: "c21 results  elite team", aliases: ["C21 RESULTS-ELITE TEAM"] }) },
  );
  assert.deepEqual(report.findings, [], "same names once normalised");
});

test("several missing spellings are reported together, not one per alias", () => {
  const report = findAliasDrift(
    [{
      name: "Properties & Estates",
      aliases: ["Properties & Estates Florida", "Properties & Estates Boston"],
      links: { client_health: "c1" },
    }],
    { client_health: rows({ id: "c1", name: "Properties & Estates Boston", aliases: [] }) },
  );
  assert.equal(report.findings.length, 1);
  assert.deepEqual(report.findings[0].missing, ["Properties & Estates", "Properties & Estates Florida"]);
});

test("duplicate spellings in the master are reported once", () => {
  const report = findAliasDrift(
    [{ name: "Alpha", aliases: ["ALPHA", "al-pha", "Alpha Group"], links: { analytics: "a1" } }],
    { analytics: rows({ id: "a1", name: "Zed", aliases: [] }) },
  );
  // Alpha / ALPHA / al-pha all normalise the same — one entry, plus the group.
  assert.equal(report.findings[0].missing.length, 2);
});

test("an unlinked client is not this check's business", () => {
  const report = findAliasDrift(
    [{ name: "Alpha", aliases: ["A"], links: { analytics: null } }],
    { analytics: rows({ id: "a1", name: "Alpha", aliases: [] }) },
  );
  assert.deepEqual(report.findings, []);
  assert.equal(report.sound, 0, "not sound either — it simply was not checked");
});

test("a stale link is skipped — the link checker reports that", () => {
  const report = findAliasDrift(
    [{ name: "Alpha", aliases: ["A"], links: { analytics: "gone" } }],
    { analytics: rows({ id: "a1", name: "Alpha", aliases: [] }) },
  );
  assert.deepEqual(report.findings, []);
});

test("an unreadable tool is reported as unchecked, never as agreement", () => {
  const report = findAliasDrift(
    [{ name: "Alpha", aliases: ["Missing One"], links: { analytics: "a1" } }],
    { analytics: { rows: new Map(), unreadable: true } },
  );
  assert.deepEqual(report.unchecked, ["analytics"]);
  assert.deepEqual(report.findings, []);
  assert.equal(report.sound, 0);
});

test("both tools are checked independently", () => {
  const report = findAliasDrift(
    [{ name: "Alpha", aliases: ["Alpha Group"], links: { analytics: "a1", client_health: "c1" } }],
    {
      analytics: rows({ id: "a1", name: "Alpha", aliases: ["Alpha Group"] }),
      client_health: rows({ id: "c1", name: "Alpha", aliases: [] }),
    },
  );
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].tool, "client_health");
  assert.equal(report.sound, 1, "Analytics knew it");
});

test("a clean roster reports nothing", () => {
  const report = findAliasDrift(
    [{ name: "Alpha", aliases: ["Alpha Group"], links: { analytics: "a1" } }],
    { analytics: rows({ id: "a1", name: "Alpha", aliases: ["Alpha Group"] }) },
  );
  assert.deepEqual(report.findings, []);
  assert.equal(report.sound, 1);
});

test("blank and whitespace spellings are ignored on both sides", () => {
  const report = findAliasDrift(
    [{ name: "Alpha", aliases: ["", "   "], links: { analytics: "a1" } }],
    { analytics: rows({ id: "a1", name: "Alpha", aliases: ["", "  "] }) },
  );
  assert.deepEqual(report.findings, []);
});
