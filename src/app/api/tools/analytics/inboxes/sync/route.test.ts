import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { NextResponse } from "next/server";

import { grantsForRequest } from "../../../../../../lib/workspace/tool-paths.ts";

/* The Inboxes page's Sync button (18 Nov): who may press it, what it runs, and when warmup is read again. */
const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

const session: { current: { email: string } | null } = { current: { email: "person@example.com" } };
const runs: Array<{ job: string; team: number }> = [];
let next: Record<string, unknown> = { status: "ok" };
let extrasAnswer = true;
const extrasAsked: number[] = [];

let POST: () => Promise<Response>;
test("setup", { skip }, async () => {
  mock.module("next/headers", { namedExports: { cookies: async () => ({ get: () => ({ value: "x" }) }) } });
  mock.module("@/lib/tools/analytics/session", { namedExports: { AUTH_COOKIE: "c", verifySessionToken: async () => session.current } });
  mock.module("@/lib/tools/analytics/supabase", { namedExports: { analyticsTeamId: () => 2 } });
  const job = async () => ({ rowsWritten: 0 });
  mock.module("@/lib/tools/analytics/sync/jobs", { namedExports: { getJob: (name: string) => (name === "sync-senders" ? job : undefined) } });
  mock.module("@/lib/tools/analytics/sync/runner", {
    namedExports: {
      runJob: async (name: string, team: number, fn: unknown) => {
        assert.equal(fn, job, "the registered job itself");
        runs.push({ job: name, team });
        return { job: name, durationMs: 1, ...next };
      },
    },
  });
  mock.module("@/lib/tools/analytics/inbox-extras-load", {
    namedExports: { refreshInboxExtras: (minAge: number) => { extrasAsked.push(minAge); return extrasAnswer; } },
  });
  mock.module("next/server", { namedExports: { NextResponse } });
  POST = (await import("./route.ts")).POST;
});

const reset = (outcome: Record<string, unknown>, extras = true) => {
  next = outcome;
  extrasAnswer = extras;
  runs.length = 0;
  extrasAsked.length = 0;
  session.current = { email: "person@example.com" };
};

test("the Inboxes switch opens it, as it opens the page; not Campaign Analytics or Management alone", () => {
  assert.deepEqual(grantsForRequest("/api/tools/analytics/inboxes/sync", "POST"), ["inboxes"]);
});

test("nobody signed in: 401, and nothing runs", { skip }, async () => {
  reset({ status: "ok" });
  session.current = null;
  const res = await POST();
  assert.equal(res.status, 401);
  assert.deepEqual(runs, []);
  assert.deepEqual(extrasAsked, []);
});

test("a sync that works: sync-senders for this team, its counts handed back, warmup asked again (10 minutes apart)", { skip }, async () => {
  reset({ status: "ok", rowsWritten: 2998, detail: { senders: 2998, disconnected: 177, archived: 484 } });
  const res = await POST();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(runs, [{ job: "sync-senders", team: 2 }]);
  assert.equal(body.status, "ok");
  assert.deepEqual(body.detail, { senders: 2998, disconnected: 177, archived: 484 });
  assert.equal(body.extrasRefreshing, true);
  assert.deepEqual(extrasAsked, [10 * 60 * 1000]);
});

test("warmup read recently: the sync still runs, warmup is left alone and says so", { skip }, async () => {
  reset({ status: "ok", detail: { senders: 2998 } }, false);
  const body = await (await POST()).json();
  assert.equal(runs.length, 1);
  assert.equal(body.extrasRefreshing, false);
});

test("already running (the schedule, or a colleague): 200, skipped, warmup not asked", { skip }, async () => {
  reset({ status: "skipped", error: "already running" });
  const res = await POST();
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "skipped");
  assert.deepEqual(extrasAsked, []);
});

test("a failed sync: 502 with the reason, warmup not asked", { skip }, async () => {
  for (const status of ["error", "circuit-open"]) {
    reset({ status, error: "EmailBison 503" });
    const res = await POST();
    assert.equal(res.status, 502, status);
    const body = await res.json();
    assert.equal(body.status, status);
    assert.equal(body.error, "EmailBison 503");
    assert.deepEqual(extrasAsked, [], status);
  }
});
