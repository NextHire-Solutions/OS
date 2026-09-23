/*
 * Status-conflict tests.
 *
 * Like the membership classifier, the behaviour under test is judgement. The
 * two failure modes are pinned directly:
 *
 *   crying wolf   flagging a difference that is expected;
 *   false calm    counting a source's silence as agreement.
 *
 *   node --test src/lib/reconcile/status-conflicts.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { findStatusConflicts, normaliseStatus } from "./status-conflicts.ts";

test("the live case: active in master, churned in Client Health, portal off", () => {
  const r = findStatusConflicts([
    {
      name: "Spotlight - A Compass Team",
      statuses: { os: "active", client_health: "churned", analytics: "active" },
    },
  ]);
  assert.equal(r.conflicts.length, 1);
  const c = r.conflicts[0];
  assert.equal(c.severity, "act");
  assert.equal(c.crossesActive, true);
  assert.deepEqual(c.disagreeing, ["client_health"]);
  assert.match(c.why, /Master says active/);
});

test("a source with no row is NOT a status conflict — that is membership", () => {
  const r = findStatusConflicts([
    { name: "Churned Co", statuses: { os: "churned", client_health: "churned", analytics: null } },
  ]);
  assert.equal(r.conflicts.length, 0, "absent from Analytics is not a disagreement");
  assert.equal(r.agreed, 1);
});

test("an unreadable source never counts as agreement", () => {
  const r = findStatusConflicts(
    [{ name: "A", statuses: { os: "active", client_health: "active" } }],
    ["client_health"],
  );
  // Client Health was unreadable, so nothing answered; not counted as agreed.
  assert.equal(r.agreed, 0);
  assert.equal(r.conflicts.length, 0);
  assert.deepEqual(r.unreadable.map((u) => u.source), ["client_health"]);
});

test("onboarding in master against active in a tool is expected, not actionable", () => {
  const r = findStatusConflicts([
    { name: "New Co", statuses: { os: "onboarding", client_health: "active", analytics: "active" } },
  ]);
  assert.equal(r.conflicts[0].severity, "expected");
  assert.equal(r.conflicts[0].crossesActive, false);
  assert.match(r.conflicts[0].why, /Expected/);
});

test("onboarding in master against churned in a tool IS actionable", () => {
  const r = findStatusConflicts([
    { name: "Odd Co", statuses: { os: "onboarding", client_health: "churned" } },
  ]);
  assert.equal(r.conflicts[0].severity, "act");
});

test("paused vs churned is flagged, but ranked below an active crossing", () => {
  const r = findStatusConflicts([
    { name: "Tidy Me", statuses: { os: "paused", client_health: "churned" } },
    { name: "Urgent", statuses: { os: "churned", client_health: "active" } },
  ]);
  assert.equal(r.conflicts[0].name, "Urgent", "active crossings sort first");
  assert.equal(r.conflicts[0].crossesActive, true);
  assert.equal(r.conflicts[1].crossesActive, false);
  assert.match(r.conflicts[1].why, /not urgent/);
});

test("'prospect' is the same state as 'onboarding' and must not read as a conflict", () => {
  const r = findStatusConflicts([
    { name: "Old Spelling", statuses: { os: "prospect", client_health: "onboarding" } },
  ]);
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.agreed, 1);
});

test("normalisation covers the spellings the tools actually store", () => {
  assert.equal(normaliseStatus("Active"), "active");
  assert.equal(normaliseStatus("  CHURNED "), "churned");
  assert.equal(normaliseStatus("prospect"), "onboarding");
  assert.equal(normaliseStatus("hidden"), "churned");
  assert.equal(normaliseStatus(""), null);
  assert.equal(normaliseStatus(null), null);
  assert.equal(normaliseStatus(42), null);
});

test("a client the master does not know about is skipped, not blamed on a tool", () => {
  const r = findStatusConflicts([
    { name: "Orphan", statuses: { os: null, client_health: "active" } },
  ]);
  assert.equal(r.conflicts.length, 0, "membership diff owns this case");
  assert.equal(r.agreed, 0);
});

test("full agreement across every source is silent", () => {
  const r = findStatusConflicts([
    { name: "A", statuses: { os: "active", client_health: "active", analytics: "active", master_inbox: "active" } },
    { name: "B", statuses: { os: "paused", client_health: "paused" } },
  ]);
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.agreed, 2);
});

test("several sources disagreeing are all named, not just the first", () => {
  const r = findStatusConflicts([
    { name: "Messy", statuses: { os: "active", client_health: "churned", analytics: "paused" } },
  ]);
  assert.deepEqual(r.conflicts[0].disagreeing, ["client_health", "analytics"]);
  assert.match(r.conflicts[0].why, /Client Health says churned.*Analytics says paused/);
});

test("only Master Inbox's mirror differing is explained, not actionable", () => {
  const r = findStatusConflicts([
    {
      name: "Mirror Lag",
      statuses: { os: "churned", client_health: "churned", analytics: "churned", master_inbox: "active" },
    },
  ]);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].severity, "expected");
  assert.equal(r.conflicts[0].crossesActive, false, "must not draw the eye");
  assert.match(r.conflicts[0].why, /known lag/);
});

test("but Master Inbox differing ALONGSIDE a real tool is still actionable", () => {
  const r = findStatusConflicts([
    {
      name: "Real Problem",
      statuses: { os: "churned", client_health: "active", master_inbox: "active" },
    },
  ]);
  assert.equal(r.conflicts[0].severity, "act");
  assert.equal(r.conflicts[0].crossesActive, true);
});
