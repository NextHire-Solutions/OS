/*
 * Classifier tests.
 *
 * The behaviour under test is judgement, not arithmetic: which disagreements
 * are worth a person's attention. Two failure modes matter and both are pinned
 * here —
 *
 *   crying wolf   flagging an expected difference, after which people stop
 *                 reading the screen and we are back to tickets;
 *   false calm    reporting agreement when we simply could not check.
 *
 *   node --test src/lib/reconcile/classify.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { compare, summarise } from "./classify.ts";
import type { Concept, Reading, SourceSpec } from "./types.ts";

const spec = (over: Partial<SourceSpec> = {}): SourceSpec => ({
  tool: "analytics",
  key: "a",
  label: "Source A",
  definition: "…",
  origin: "X",
  window: "30d",
  platforms: ["emailbison"],
  ...over,
});

const reading = (over: Partial<Reading> = {}): Reading => ({
  tool: "analytics",
  key: "a",
  label: "Source A",
  definition: "…",
  origin: "X",
  value: 100,
  fetchedAt: "2026-09-02T00:00:00.000Z",
  ...over,
});

const concept = (over: Partial<Concept> = {}): Concept => ({
  id: "emails-sent",
  label: "Emails sent",
  question: "How many?",
  tolerance: 0.02,
  sources: [],
  ...over,
});

// --- agreement ---------------------------------------------------------------

test("identical numbers agree", () => {
  const specs = [spec(), spec({ key: "b", label: "Source B" })];
  const result = compare(
    concept(),
    [reading(), reading({ key: "b", label: "Source B" })],
    specs,
  );
  assert.equal(result.divergence, "agree");
  assert.equal(result.spread?.delta, 0);
});

test("a difference inside tolerance still agrees", () => {
  const specs = [spec(), spec({ key: "b" })];
  const result = compare(
    concept({ tolerance: 0.05 }),
    [reading({ value: 100 }), reading({ key: "b", value: 97 })],
    specs,
  );
  assert.equal(result.divergence, "agree", "3% under a 5% tolerance");
});

test("a difference just outside tolerance does not agree", () => {
  const specs = [spec(), spec({ key: "b" })];
  const result = compare(
    concept({ tolerance: 0.02 }),
    [reading({ value: 100 }), reading({ key: "b", value: 97 })],
    specs,
  );
  assert.notEqual(result.divergence, "agree");
});

// --- expected differences, which must NOT look alarming ----------------------

test("different windows are explained, not flagged", () => {
  const specs = [
    spec({ key: "a", window: "30d" }),
    spec({ key: "b", label: "Source B", window: "iso-week" }),
  ];
  const result = compare(
    concept(),
    [reading({ value: 272000 }), reading({ key: "b", label: "Source B", value: 6800 })],
    specs,
  );
  assert.equal(result.divergence, "window");
  assert.match(result.verdict, /^Expected/);
  assert.match(result.verdict, /different periods/);
});

test("different platform coverage is explained, and names the wider source", () => {
  const specs = [
    spec({ key: "a", platforms: ["emailbison"] }),
    spec({ key: "b", label: "Client Health", platforms: ["instantly", "emailbison"] }),
  ];
  const result = compare(
    concept(),
    [reading({ value: 200 }), reading({ key: "b", label: "Client Health", value: 340 })],
    specs,
  );
  assert.equal(result.divergence, "definition");
  assert.match(result.verdict, /^Expected/);
  assert.match(result.verdict, /Client Health sees more/);
});

test("window is decided before platforms — the coarser explanation wins", () => {
  // Both differ. Reporting the platform mismatch would be true but useless:
  // if the periods differ, comparing coverage tells you nothing.
  const specs = [
    spec({ key: "a", window: "30d", platforms: ["emailbison"] }),
    spec({ key: "b", window: "all-time", platforms: ["instantly", "emailbison"] }),
  ];
  const result = compare(
    concept(),
    [reading({ value: 100 }), reading({ key: "b", value: 9000 })],
    specs,
  );
  assert.equal(result.divergence, "window");
});

// --- the one case that should look alarming ----------------------------------

test("same window, same platforms, still apart → unexplained", () => {
  const specs = [
    spec({ key: "a", window: "current", platforms: ["emailbison"] }),
    spec({ key: "b", label: "Source B", window: "current", platforms: ["emailbison"] }),
  ];
  const result = compare(
    concept({ tolerance: 0.02 }),
    [reading({ value: 41 }), reading({ key: "b", label: "Source B", value: 33 })],
    specs,
  );
  assert.equal(result.divergence, "unexplained");
  assert.match(result.verdict, /Worth a look/);
  assert.match(result.verdict, /8 apart/);
});

// --- never report false calm -------------------------------------------------

test("one reading is 'insufficient', never 'agree'", () => {
  // The important one. A green tick here would mean "we could not check",
  // which is the most misleading thing this module could say.
  const specs = [spec(), spec({ key: "b", label: "Source B" })];
  const result = compare(
    concept(),
    [
      reading({ value: 100 }),
      reading({ key: "b", label: "Source B", value: null, unavailable: "token not set" }),
    ],
    specs,
  );
  assert.equal(result.divergence, "insufficient");
  assert.equal(result.spread, null);
  assert.match(result.verdict, /Only one source answered/);
  assert.match(result.verdict, /token not set/, "and says why the other could not");
});

test("no readings at all is also insufficient", () => {
  const result = compare(
    concept(),
    [reading({ value: null, unavailable: "401" })],
    [spec()],
  );
  assert.equal(result.divergence, "insufficient");
  assert.match(result.verdict, /No source could answer/);
});

// --- edge cases --------------------------------------------------------------

test("all zeroes agree rather than dividing by zero", () => {
  const specs = [spec(), spec({ key: "b" })];
  const result = compare(
    concept(),
    [reading({ value: 0 }), reading({ key: "b", value: 0 })],
    specs,
  );
  assert.equal(result.divergence, "agree");
  assert.equal(result.spread?.relative, 0);
});

test("a source with no matching spec does not crash the comparison", () => {
  const result = compare(
    concept(),
    [reading({ value: 10 }), reading({ key: "orphan", value: 90 })],
    [spec()],
  );
  assert.ok(["unexplained", "definition", "window"].includes(result.divergence));
});

test("the summary counts every kind, including zeroes", () => {
  const s = summarise([
    { divergence: "agree" } as never,
    { divergence: "agree" } as never,
    { divergence: "unexplained" } as never,
  ]);
  assert.deepEqual(s, {
    agree: 2, window: 0, definition: 0, unexplained: 1, insufficient: 0,
  });
});
