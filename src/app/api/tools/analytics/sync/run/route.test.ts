import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { NextResponse } from "next/server";

/*
 * The manual / dispatcher run route with Instantly switched off in Campaign Analytics (instantly-switch.ts,
 * 19 Nov 2026): asking for an Instantly job by name — a person, or an outside cron with the secret — gets
 * a reason and a 409, and nothing runs. Every other job runs as before.
 */
const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

const runs: string[] = [];
let POST: (req: unknown) => Promise<Response>;
test("setup", { skip }, async () => {
  mock.module("next/headers", { namedExports: { cookies: async () => ({ get: () => ({ value: "x" }) }) } });
  mock.module("@/lib/tools/analytics/session", { namedExports: { AUTH_COOKIE: "c", verifySessionToken: async () => ({ email: "person@example.com" }) } });
  mock.module("@/lib/tools/analytics/sync/jobs", {
    namedExports: { JOB_NAMES: ["sync-senders", "sync-instantly-accounts"], getJob: () => async () => ({ rowsWritten: 0 }) },
  });
  mock.module("@/lib/tools/analytics/sync/runner", {
    namedExports: { runJob: async (job: string) => { runs.push(job); return { job, status: "ok", durationMs: 1 }; } },
  });
  mock.module("@/lib/tools/analytics/sync/scheduler", { namedExports: { ensureScheduler: () => {} } });
  mock.module("@/lib/tools/analytics/supabase", { namedExports: { analyticsTeamId: () => 2 } });
  mock.module("@/lib/env", { namedExports: { optionalEnv: (k: string) => (k === "ANALYTICS_CRON_SECRET" ? "cron-secret" : undefined) } });
  mock.module("next/server", { namedExports: { NextResponse } });
  POST = (await import("./route.ts")).POST as never;
});

const request = (job: string, auth?: string) => ({
  headers: new Headers(auth ? { authorization: auth } : {}),
  nextUrl: new URL(`http://os.test/api/tools/analytics/sync/run?job=${job}`),
});

test("an Instantly job asked for by the cron dispatcher: 409, the reason, nothing runs", { skip }, async () => {
  runs.length = 0;
  const res = await POST(request("sync-instantly-accounts", "Bearer cron-secret"));
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /Instantly is switched off in Campaign Analytics/);
  assert.equal(body.job, "sync-instantly-accounts");
  assert.deepEqual(runs, []);
});

test("an EmailBison job still runs", { skip }, async () => {
  runs.length = 0;
  const res = await POST(request("sync-senders", "Bearer cron-secret"));
  assert.equal(res.status, 200);
  assert.deepEqual(runs, ["sync-senders"]);
});
