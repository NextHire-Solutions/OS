/*
 * Coverage tests — §17, intentional exception vs system failure.
 *
 * The failure modes are the same two as the other classifiers, and both are
 * pinned here: reporting an absence that is expected (after which nobody
 * reads the screen), and hiding one that is not.
 *
 *   node --test src/lib/reconcile/coverage.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCoverage, type CoverageInput, type ExceptionIndex } from "./coverage.ts";

const TOOLS = ["master_inbox", "client_health", "analytics", "onboarding"] as const;

const client = (over: Partial<CoverageInput> = {}): CoverageInput => ({
  clientId: "c1",
  name: "A Client",
  status: "active",
  present: { master_inbox: true, client_health: true, analytics: true, onboarding: true },
  ...over,
});

const verdictFor = (report: ReturnType<typeof buildCoverage>, tool: string) =>
  report.rows[0].cells.find((c) => c.tool === tool)!;

test("a fully covered active client has no gaps", () => {
  const r = buildCoverage([client()]);
  assert.equal(r.withGaps, 0);
  assert.ok(r.rows[0].cells.every((c) => c.verdict === "present"));
});

test("an ACTIVE client missing from a tool is a gap — no standing rule covers it", () => {
  const r = buildCoverage([client({ present: { ...client().present, analytics: false } })]);
  assert.deepEqual(r.rows[0].gaps, ["analytics"]);
  assert.equal(r.withGaps, 1);
  assert.equal(verdictFor(r, "analytics").verdict, "gap");
});

test("a PAUSED client is still a client — its absence is a gap too", () => {
  const r = buildCoverage([
    client({ status: "paused", present: { ...client().present, analytics: false } }),
  ]);
  assert.equal(verdictFor(r, "analytics").verdict, "gap");
});

test("a CHURNED client's absence is expected, and the rule is shown", () => {
  const r = buildCoverage([
    client({ status: "churned", present: { ...client().present, analytics: false, onboarding: false } }),
  ]);
  assert.equal(r.withGaps, 0);
  assert.equal(verdictFor(r, "analytics").verdict, "expected");
  assert.match(verdictFor(r, "analytics").reason!, /what churn means/);
  assert.equal(r.expected, 2);
});

test("an ONBOARDING client's absence is expected — setup is still running", () => {
  const r = buildCoverage([
    client({ status: "onboarding", present: { ...client().present, analytics: false } }),
  ]);
  assert.equal(verdictFor(r, "analytics").verdict, "expected");
  assert.match(verdictFor(r, "analytics").reason!, /Still onboarding/);
});

test("a written reason turns a gap into an explained absence", () => {
  const exceptions: ExceptionIndex = new Map([
    ["c1", new Map([["analytics", "Runs their own reporting; never set up for attribution."]])],
  ]);
  const r = buildCoverage(
    [client({ present: { ...client().present, analytics: false } })],
    exceptions,
  );
  assert.equal(r.withGaps, 0);
  assert.equal(verdictFor(r, "analytics").verdict, "explained");
  assert.match(verdictFor(r, "analytics").reason!, /own reporting/);
  assert.equal(r.explained, 1);
});

test("a written reason beats a standing rule — somebody actually looked", () => {
  const exceptions: ExceptionIndex = new Map([
    ["c1", new Map([["analytics", "Deliberately removed after churn, data archived."]])],
  ]);
  const r = buildCoverage(
    [client({ status: "churned", present: { ...client().present, analytics: false } })],
    exceptions,
  );
  assert.equal(verdictFor(r, "analytics").verdict, "explained");
  assert.equal(r.explained, 1);
  assert.equal(r.expected, 0);
});

test("an exception for one tool does not excuse another", () => {
  // Client Health rather than Onboarding: absence from Onboarding is covered
  // by a tool-level rule, so it could never be the gap this asserts.
  const exceptions: ExceptionIndex = new Map([["c1", new Map([["analytics", "reason"]])]]);
  const r = buildCoverage(
    [client({ present: { master_inbox: true, client_health: false, analytics: false, onboarding: true } })],
    exceptions,
  );
  assert.deepEqual(r.rows[0].gaps, ["client_health"]);
});

test("an unreadable tool invents no gaps", () => {
  const r = buildCoverage(
    [client({ present: { master_inbox: true, client_health: true, analytics: false, onboarding: false } })],
    new Map(),
    ["analytics", "onboarding"],
  );
  assert.equal(r.withGaps, 0, "a failed read must not look like missing clients");
  assert.match(verdictFor(r, "analytics").reason!, /could not be read/);
  assert.deepEqual(r.unreadable, ["analytics", "onboarding"]);
});

test("a tool that was not checked is distinguished from one that says no", () => {
  const r = buildCoverage([client({ present: { master_inbox: true } })]);
  assert.equal(verdictFor(r, "analytics").verdict, "expected");
  assert.match(verdictFor(r, "analytics").reason!, /not checked/);
  assert.equal(r.withGaps, 0);
});

test("worst-covered clients lead the list", () => {
  const r = buildCoverage([
    client({ clientId: "a", name: "One Gap", present: { ...client().present, analytics: false } }),
    client({
      clientId: "b",
      name: "Three Gaps",
      present: { master_inbox: true, client_health: false, analytics: false, onboarding: false },
    }),
  ]);
  assert.equal(r.rows[0].name, "Three Gaps");
  assert.equal(r.rows[1].name, "One Gap");
});

test("gaps are counted per tool, so the worst-covered TOOL is visible too", () => {
  const r = buildCoverage([
    client({ clientId: "a", name: "A", present: { ...client().present, analytics: false } }),
    client({ clientId: "b", name: "B", present: { ...client().present, analytics: false } }),
    client({ clientId: "c", name: "C", present: { ...client().present, client_health: false } }),
  ]);
  const byTool = Object.fromEntries(r.gapsByTool.map((g) => [g.tool, g.gaps]));
  assert.equal(byTool.analytics, 2);
  assert.equal(byTool.client_health, 1);
  assert.equal(byTool.master_inbox, 0);
  // Onboarding can never accumulate gaps — nothing writes to that tool.
  assert.equal(byTool.onboarding, 0);
});

test("every tool asked for gets a cell, in the order given", () => {
  const r = buildCoverage([client()], new Map(), [], [...TOOLS]);
  assert.deepEqual(r.rows[0].cells.map((c) => c.tool), [...TOOLS]);
});

test("byStatus gives the like-for-like comparison, per status per tool", () => {
  const r = buildCoverage([
    client({ clientId: "a", name: "A", status: "active" }),
    client({ clientId: "b", name: "B", status: "active",
             present: { master_inbox: true, client_health: true, analytics: false, onboarding: true } }),
    client({ clientId: "c", name: "C", status: "churned",
             present: { master_inbox: true, client_health: true, analytics: false, onboarding: false } }),
  ]);
  const active = r.byStatus.find((s) => s.status === "active")!;
  assert.equal(active.total, 2);
  assert.equal(active.present.master_inbox, 2, "both active clients are in Master Inbox");
  assert.equal(active.present.analytics, 1, "one active client is missing from Analytics");
  const churned = r.byStatus.find((s) => s.status === "churned")!;
  assert.equal(churned.total, 1);
  assert.equal(churned.present.onboarding, 0);
});

test("an unreadable tool reports -1, never 0 — 0 would read as 'none of them'", () => {
  const r = buildCoverage(
    [client({ status: "active" })],
    new Map(),
    ["analytics"],
  );
  assert.equal(r.byStatus[0].present.analytics, -1);
  assert.equal(r.byStatus[0].present.master_inbox, 1);
});

test("byStatus counts presence, not whether the absence was excused", () => {
  // A churned client absent from Analytics is an EXPECTED verdict, but it is
  // still absent — the table must say so.
  const r = buildCoverage([
    client({ status: "churned", present: { ...client().present, analytics: false } }),
  ]);
  assert.equal(r.withGaps, 0, "expected, so not a gap");
  assert.equal(r.byStatus[0].present.analytics, 0, "but still not present");
});

test("absence from the Onboarding tool is expected for ANY status — nothing writes to it", () => {
  for (const status of ["active", "paused", "churned", "onboarding"]) {
    const r = buildCoverage([
      client({ status, present: { ...client().present, onboarding: false } }),
    ]);
    assert.equal(r.withGaps, 0, `${status}: Onboarding absence must not be a gap`);
    assert.equal(verdictFor(r, "onboarding").verdict, "expected");
    assert.match(verdictFor(r, "onboarding").reason!, /intake pipeline/);
  }
});

test("the tool rule does not excuse the other tools", () => {
  const r = buildCoverage([
    client({ status: "active",
             present: { master_inbox: true, client_health: true, analytics: false, onboarding: false } }),
  ]);
  assert.deepEqual(r.rows[0].gaps, ["analytics"], "Analytics is still a gap");
});

test("a written reason still beats the tool rule", () => {
  const exceptions: ExceptionIndex = new Map([
    ["c1", new Map([["onboarding", "Migrated from the old intake sheet in 2025."]])],
  ]);
  const r = buildCoverage(
    [client({ present: { ...client().present, onboarding: false } })],
    exceptions,
  );
  assert.equal(verdictFor(r, "onboarding").verdict, "explained");
  assert.equal(r.explained, 1);
});
