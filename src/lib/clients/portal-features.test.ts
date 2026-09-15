import { test } from "node:test";
import assert from "node:assert/strict";
import { withStandardFlags, missingFlags, STANDARD_PORTAL_FLAGS } from "./portal-features.ts";

test("a client created by Master Inbox's route gains the six missing flags", () => {
  // Exactly what POST /api/clients seeds today.
  const seeded = { manage_stages: true, pipeline_kanban_view: true, pipeline_board_enhanced: true };
  const out = withStandardFlags(seeded);
  for (const k of Object.keys(STANDARD_PORTAL_FLAGS)) assert.equal(out[k], true, `${k} should be on`);
  assert.equal(Object.keys(out).length, 9);
});

test("portal_tour is part of the standard set — the flag that gates the tour", () => {
  assert.equal(withStandardFlags({}).portal_tour, true);
});

test("ideal_agent_profile is NOT seeded — one client has it, so it is a trial", () => {
  assert.equal("ideal_agent_profile" in withStandardFlags({}), false);
});

test("a flag deliberately turned off stays off", () => {
  // Onboarding the same client twice must not silently re-enable something
  // someone switched off on purpose.
  assert.equal(withStandardFlags({ portal_tour: false }).portal_tour, false);
});

test("unrelated flags are preserved", () => {
  assert.equal(withStandardFlags({ ideal_agent_profile: true }).ideal_agent_profile, true);
});

test("null / garbage feature_flags does not throw", () => {
  assert.equal(withStandardFlags(null).portal_tour, true);
  assert.equal(withStandardFlags("nonsense").portal_tour, true);
  assert.equal(withStandardFlags([]).portal_tour, true);
});

test("missingFlags names exactly what a three-flag client lacks", () => {
  const seeded = { manage_stages: true, pipeline_kanban_view: true, pipeline_board_enhanced: true };
  assert.deepEqual(missingFlags(seeded).sort(), [
    "interview_scheduled_stage", "nav_integrations_label", "pipeline_csv_upload",
    "pipeline_source_split", "portal_tour", "show_client_plan",
  ]);
});

test("a fully-flagged client is missing nothing", () => {
  assert.deepEqual(missingFlags(STANDARD_PORTAL_FLAGS), []);
});
