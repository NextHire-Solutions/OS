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
  const exceptions: ExceptionIndex = new Map([["c1", new Map([["analytics", "reason"]])]]);
  const r = buildCoverage(
    [client({ present: { master_inbox: true, client_health: true, analytics: false, onboarding: false } })],
    exceptions,
  );
  assert.deepEqual(r.rows[0].gaps, ["onboarding"]);
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
    client({ clientId: "c", name: "C", present: { ...client().present, onboarding: false } }),
  ]);
  const byTool = Object.fromEntries(r.gapsByTool.map((g) => [g.tool, g.gaps]));
  assert.equal(byTool.analytics, 2);
  assert.equal(byTool.onboarding, 1);
  assert.equal(byTool.master_inbox, 0);
});

test("every tool asked for gets a cell, in the order given", () => {
  const r = buildCoverage([client()], new Map(), [], [...TOOLS]);
  assert.deepEqual(r.rows[0].cells.map((c) => c.tool), [...TOOLS]);
});
