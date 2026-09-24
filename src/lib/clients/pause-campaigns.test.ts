import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PAUSABLE_STATUSES,
  instantlyStatusWord,
  planCampaignPause,
  type CampaignRow,
} from "./pause-campaigns";

const c = (over: Partial<CampaignRow>): CampaignRow => ({
  platform: "emailbison",
  id: "1",
  name: "A campaign",
  status: "active",
  ...over,
});

/*
 * The decision being tested is "which campaigns can still send". Getting it
 * wrong in one direction leaves a churned client emailing; in the other it
 * fires pointless requests at EmailBison that it may reject, turning a clean
 * status change into a page full of failures.
 */

test("PAUSABLE mirrors Analytics' canApply('pause', ...) exactly", () => {
  // THIS IS THE CONTRACT with
  //   Corofy/Analytics Dashboard/src/lib/campaigns/status.ts
  // where canApply returns ["active","queued","launching"] for pause. If that
  // changes, this is what should fail.
  assert.deepEqual([...PAUSABLE_STATUSES], ["active", "queued", "launching"]);
});

test("a campaign that can still send is paused", () => {
  for (const status of ["active", "queued", "launching"]) {
    const plan = planCampaignPause([c({ status })]);
    assert.equal(plan.pausable.length, 1, status);
    assert.equal(plan.skipped.length, 0, status);
  }
});

test("an already-paused campaign is skipped, not re-paused", () => {
  const plan = planCampaignPause([c({ status: "paused" })]);
  assert.equal(plan.pausable.length, 0);
  assert.equal(plan.skipped[0].reason, "already paused");
});

test("completed, archived and draft campaigns are skipped with their reason", () => {
  const plan = planCampaignPause([
    c({ id: "1", status: "completed" }),
    c({ id: "2", status: "archived" }),
    c({ id: "3", status: "draft" }),
  ]);
  assert.equal(plan.pausable.length, 0);
  assert.match(plan.skipped[0].reason, /cannot send/);
  assert.match(plan.skipped[1].reason, /cannot send/);
  assert.match(plan.skipped[2].reason, /never sent/);
});

test("an unknown or empty status is skipped rather than sent hopefully", () => {
  const plan = planCampaignPause([c({ status: "error" }), c({ status: "" })]);
  assert.equal(plan.pausable.length, 0);
  assert.match(plan.skipped[0].reason, /"error" cannot be paused/);
  assert.match(plan.skipped[1].reason, /"unknown" cannot be paused/);
});

test("status is compared case-insensitively", () => {
  assert.equal(planCampaignPause([c({ status: "ACTIVE" })]).pausable.length, 1);
  assert.equal(planCampaignPause([c({ status: "Active" })]).pausable.length, 1);
});

test("a mixed set is split, and every campaign lands in exactly one bucket", () => {
  const rows = [
    c({ id: "1", status: "active" }),
    c({ id: "2", status: "paused" }),
    c({ id: "3", status: "completed" }),
    c({ id: "4", platform: "instantly", status: "active" }),
    c({ id: "5", platform: "instantly", status: "draft" }),
  ];
  const plan = planCampaignPause(rows);
  assert.deepEqual(plan.pausable.map((x) => x.id), ["1", "4"]);
  assert.equal(plan.pausable.length + plan.skipped.length, rows.length);
});

test("both platforms are handled by the same rule", () => {
  const plan = planCampaignPause([
    c({ platform: "emailbison", status: "active" }),
    c({ platform: "instantly", status: "active" }),
  ]);
  assert.deepEqual(plan.pausable.map((x) => x.platform), ["emailbison", "instantly"]);
});

test("no campaigns is not an error", () => {
  assert.deepEqual(planCampaignPause([]), { pausable: [], skipped: [] });
});

/* ---- Instantly's integer status, mapped Analytics' way ---- */

test("Instantly's integer status maps to the same words Analytics uses", () => {
  assert.equal(instantlyStatusWord(0), "draft");
  assert.equal(instantlyStatusWord(1), "active");
  assert.equal(instantlyStatusWord(2), "paused");
  assert.equal(instantlyStatusWord(3), "completed");
});

test("an unrecognised Instantly status is 'error', never silently 'active'", () => {
  // Guessing "active" here would pause campaigns on a code we do not
  // understand; guessing "paused" would skip ones that are sending.
  for (const v of [9, -1, null, undefined, "x", {}]) {
    assert.equal(instantlyStatusWord(v), "error", String(v));
  }
  assert.equal(planCampaignPause([c({ status: instantlyStatusWord(9) })]).pausable.length, 0);
});

test("only status 1 is pausable on Instantly", () => {
  const rows = [0, 1, 2, 3].map((s, i) =>
    c({ id: String(i), platform: "instantly", status: instantlyStatusWord(s) }),
  );
  assert.deepEqual(planCampaignPause(rows).pausable.map((x) => x.id), ["1"]);
});

/* ---- the safety property ---- */

test("the plan never contains anything that is not pausable", () => {
  // A property rather than an example: whatever goes in, nothing leaves in
  // `pausable` unless its status is one the platform accepts a pause for.
  const statuses = ["active", "queued", "launching", "paused", "completed", "archived",
    "draft", "error", "", "pending deletion", "ACTIVE", "Completed"];
  const plan = planCampaignPause(statuses.map((s, i) => c({ id: String(i), status: s })));
  for (const p of plan.pausable) {
    assert.ok(
      (PAUSABLE_STATUSES as readonly string[]).includes(p.status.toLowerCase()),
      `${p.status} must not be pausable`,
    );
  }
  assert.equal(plan.pausable.length, 4, "active, queued, launching, ACTIVE");
});
