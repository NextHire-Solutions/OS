import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MANUAL_JOBS,
  bearerAuthorised,
  bearerToken,
  detachedResponse,
  isManualJob,
  runResponseStatus,
} from "./manual.ts";
import { JOB_NAMES } from "./jobs.ts";

test("the seven manual jobs are all registered jobs", () => {
  assert.equal(MANUAL_JOBS.length, 7);
  for (const job of MANUAL_JOBS) assert.ok(JOB_NAMES.includes(job), job);
  assert.equal(isManualJob("sync-entities"), true);
  assert.equal(isManualJob("sync-replies-deep"), false);
});

test("bearer parsing and constant-time authorisation fail closed", () => {
  assert.equal(bearerToken("Bearer abc"), "abc");
  assert.equal(bearerToken("Basic abc"), "");
  assert.equal(bearerToken(null), "");

  assert.equal(bearerAuthorised("Bearer s3cret", "s3cret"), true);
  assert.equal(bearerAuthorised("Bearer wrong", "s3cret"), false);
  assert.equal(bearerAuthorised("Bearer ", "s3cret"), false);
  assert.equal(bearerAuthorised("Bearer s3cret", undefined), false, "unset secret authorises nobody");
  assert.equal(bearerAuthorised("Bearer ", ""), false, "empty never equals empty");
});

test("response status follows the tool: 500 only for error and circuit-open", () => {
  assert.equal(runResponseStatus({ status: "ok" }), 200);
  assert.equal(runResponseStatus({ status: "skipped" }), 200);
  assert.equal(runResponseStatus({ status: "error" }), 500);
  assert.equal(runResponseStatus({ status: "circuit-open" }), 500);
});

test("the detached body points at the OS status route", () => {
  assert.deepEqual(detachedResponse("sync-replies"), {
    job: "sync-replies",
    status: "started",
    detached: true,
    followUp: "/api/tools/analytics/sync/status",
  });
});
