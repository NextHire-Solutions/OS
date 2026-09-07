/*
 * The two-vocabulary bridge.
 *
 * A lookup keyed on grant ids was handed connector ids and three of four tool
 * icons silently disappeared from the home screen. Nothing threw — the glyphs
 * just did not render, which is the worst kind of bug: invisible in tests,
 * obvious only to whoever looks at the page.
 *
 * These assert the map is total and reversible in both directions, so a fifth
 * tool cannot be added to one vocabulary and forgotten in the other.
 *
 *   node --test src/lib/workspace/tool-ids.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { CONNECTOR_BY_GRANT, GRANT_BY_CONNECTOR, toConnectorId, toGrantId } from "./tool-ids.ts";
import { ALL_TOOLS } from "../bs-auth.ts";

test("every grant id maps to a connector id and back", () => {
  for (const grant of ALL_TOOLS) {
    const connector = toConnectorId(grant);
    assert.ok(connector, `${grant} has no connector id`);
    assert.equal(toGrantId(connector), grant, `${grant} did not survive the round trip`);
  }
});

test("every connector id maps to a grant id and back", () => {
  for (const connector of Object.keys(GRANT_BY_CONNECTOR) as (keyof typeof GRANT_BY_CONNECTOR)[]) {
    const grant = toGrantId(connector);
    assert.ok(grant, `${connector} has no grant id`);
    assert.equal(toConnectorId(grant), connector, `${connector} did not survive the round trip`);
  }
});

test("the two maps are the same size — neither has an orphan", () => {
  assert.equal(
    Object.keys(GRANT_BY_CONNECTOR).length,
    Object.keys(CONNECTOR_BY_GRANT).length,
  );
  assert.equal(Object.keys(CONNECTOR_BY_GRANT).length, ALL_TOOLS.length);
});

test("the ids that actually differ are mapped, not passed through", () => {
  // The three that bit us. `analytics` is the same in both, which is exactly
  // why the bug looked like "one card works, three do not".
  assert.equal(toGrantId("master-inbox"), "inbox");
  assert.equal(toGrantId("client-health"), "clients");
  assert.equal(toGrantId("scraper"), "search");
  assert.equal(toGrantId("analytics"), "analytics");
});

test("no grant id accidentally equals a different connector id", () => {
  // Would make a mis-keyed lookup work by luck in one direction and fail in
  // the other, which is harder to spot than failing outright.
  for (const grant of ALL_TOOLS) {
    const connector = toConnectorId(grant);
    if (grant === connector) continue;
    assert.equal(
      (GRANT_BY_CONNECTOR as Record<string, string>)[grant],
      undefined,
      `grant id "${grant}" is also a connector id`,
    );
  }
});
