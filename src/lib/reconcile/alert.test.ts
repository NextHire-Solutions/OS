import assert from "node:assert/strict";
import { test } from "node:test";

import { alertText, buildReconcileAlert, type ReconcileAlertInput } from "./alert";

const clean: ReconcileAlertInput = {
  statusConflicts: 0,
  unexplainedOneSided: 0,
  duplicates: 0,
  brokenLinks: 0,
  aliasDrift: 0,
  unreadable: [],
  failedChecks: [],
  clientsChecked: 52,
};

/*
 * The policy under test is mostly about SILENCE. An alerter that fires on a
 * state nobody can act on gets muted, and then the real one is muted with it —
 * which is worse than having no alerter, because everyone believes they are
 * covered.
 */

test("the current production state sends nothing", () => {
  const a = buildReconcileAlert(clean);
  assert.equal(a.actionable, false);
  assert.equal(a.severity, "clear");
  assert.equal(alertText(a), null, "nothing is posted when there is nothing to say");
});

test("the clear message still proves it looked, and at what", () => {
  const a = buildReconcileAlert(clean);
  assert.match(a.lines[0], /52 clients checked/);
});

test("a status conflict is worth waking someone for", () => {
  const a = buildReconcileAlert({ ...clean, statusConflicts: 2 });
  assert.equal(a.actionable, true);
  assert.equal(a.severity, "attention");
  assert.match(a.lines[0], /2 clients/);
  // The line has to say why it matters, or it is just a number.
  assert.match(a.lines[0], /billed while paused|live portal while churned/);
});

test("an unexplained gap is reported and an explained one is not", () => {
  // Explained absences are filtered out before this function sees them; the
  // contract is that it counts only what it is given.
  assert.equal(buildReconcileAlert({ ...clean, unexplainedOneSided: 3 }).actionable, true);
  assert.equal(buildReconcileAlert({ ...clean, unexplainedOneSided: 0 }).actionable, false);
});

test("duplicates are reported with the consequence, not just the count", () => {
  const a = buildReconcileAlert({ ...clean, duplicates: 1 });
  assert.match(a.lines[0], /1 duplicate\b/);
  assert.match(a.lines[0], /campaign matcher abandons both/);
});

test("broken links are reported; not-yet-recorded links are not this function's business", () => {
  const a = buildReconcileAlert({ ...clean, brokenLinks: 4 });
  assert.match(a.lines[0], /4 stored links/);
  assert.match(a.lines[0], /not yet recorded are not counted/);
});

/* ---- the failure cases, which matter most ---- */

test("an unreadable source is URGENT, because silence would look like agreement", () => {
  const a = buildReconcileAlert({ ...clean, unreadable: ["Analytics", "Client Health"] });
  assert.equal(a.actionable, true);
  assert.equal(a.severity, "urgent");
  assert.match(a.lines[0], /Analytics, Client Health/);
  assert.match(a.lines[0], /not all of them/);
});

test("a check that threw is urgent and names the error", () => {
  const a = buildReconcileAlert({
    ...clean,
    failedChecks: [{ check: "duplicate", error: "connection reset" }],
  });
  assert.equal(a.severity, "urgent");
  assert.match(a.lines[0], /duplicate check failed/);
  assert.match(a.lines[0], /connection reset/);
});

test("an unreadable source outranks the findings, and is listed first", () => {
  // Otherwise someone reads "1 conflict" off a comparison that could only see
  // half the platform and believes that is the whole story.
  const a = buildReconcileAlert({ ...clean, statusConflicts: 1, unreadable: ["Analytics"] });
  assert.equal(a.severity, "urgent");
  assert.match(a.lines[0], /Could not read Analytics/);
  assert.equal(a.lines.length, 2);
});

test("a failed check outranks an unreadable source", () => {
  const a = buildReconcileAlert({
    ...clean,
    unreadable: ["Analytics"],
    failedChecks: [{ check: "coverage", error: "boom" }],
  });
  assert.match(a.lines[0], /coverage check failed/);
  assert.match(a.lines[1], /Could not read Analytics/);
});

test("everything at once is reported in full, not truncated to the first problem", () => {
  const a = buildReconcileAlert({
    statusConflicts: 1,
    unexplainedOneSided: 2,
    duplicates: 1,
    brokenLinks: 1,
    aliasDrift: 1,
    unreadable: ["Analytics"],
    failedChecks: [{ check: "links", error: "x" }],
    clientsChecked: 52,
  });
  assert.equal(a.lines.length, 7);
  assert.equal(a.severity, "urgent");
});

test("a tool not knowing a client's name is worth an alert", () => {
  const a = buildReconcileAlert({ ...clean, aliasDrift: 2 });
  assert.equal(a.actionable, true);
  assert.match(a.lines[0], /2 clients/);
  // It has to say what it costs, or it is just another count.
  assert.match(a.lines[0], /attributed to nobody/);
});

test("singular and plural both read correctly", () => {
  assert.match(buildReconcileAlert({ ...clean, statusConflicts: 1 }).lines[0], /1 client\b/);
  assert.match(buildReconcileAlert({ ...clean, statusConflicts: 2 }).lines[0], /2 clients\b/);
  assert.match(buildReconcileAlert({ ...clean, duplicates: 1 }).lines[0], /1 duplicate\b/);
  assert.match(buildReconcileAlert({ ...clean, duplicates: 3 }).lines[0], /3 duplicates\b/);
});

test("the posted text carries every line and the link to the screen", () => {
  const a = buildReconcileAlert({ ...clean, duplicates: 1, statusConflicts: 1 });
  const text = alertText(a, "https://os.brokerstaffer.com/consistency")!;
  assert.match(text, /Client data needs attention/);
  assert.equal((text.match(/^• /gm) ?? []).length, 2);
  assert.match(text, /os\.brokerstaffer\.com\/consistency/);
});

test("the text omits the link when none is configured", () => {
  const a = buildReconcileAlert({ ...clean, duplicates: 1 });
  const text = alertText(a)!;
  assert.ok(!text.includes("Open the Consistency screen"));
});
