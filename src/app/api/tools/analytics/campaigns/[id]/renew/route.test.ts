import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { NextRequest, NextResponse } from "next/server";

import { grantsForRequest } from "../../../../../../../lib/workspace/tool-paths.ts";

/* The Duplicate & Renew route (19 Nov). The work is tested in renew/renew.test.ts; this is who may, the confirm, and the job. */
const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

const session: { current: { email: string } | null } = { current: { email: "amy@example.com" } };
const started: Array<{ id: number; token: string; actor: string; poolIds: number[] }> = [];
const jobs = new Map<string, { id: string; sourceId: number; finishedAt: number | null }>();
let running: { id: string } | null = null;
let preview: unknown = { token: "t".repeat(32), blockers: [] };

let GET: (r: NextRequest, c: { params: Promise<{ id: string }> }) => Promise<Response>;
let POST: (r: NextRequest, c: { params: Promise<{ id: string }> }) => Promise<Response>;
test("setup", { skip }, async () => {
  mock.module("next/headers", { namedExports: { cookies: async () => ({ get: () => ({ value: "x" }) }) } });
  mock.module("@/lib/tools/analytics/session", { namedExports: { AUTH_COOKIE: "c", verifySessionToken: async () => session.current } });
  mock.module("@/lib/tools/analytics/campaigns/renew/io.ts", { namedExports: { realRenewIO: () => ({}) } });
  mock.module("@/lib/tools/analytics/campaigns/renew/renew.ts", { namedExports: { previewRenew: async () => preview } });
  mock.module("@/lib/tools/analytics/campaigns/renew/jobs.ts", {
    namedExports: {
      getJob: (id: string) => jobs.get(id) ?? null,
      runningFor: () => running,
      startRenewJob: (id: number, token: string, poolIds: number[], actor: string) => {
        if (running) return { job: running, started: false };
        started.push({ id, token, actor, poolIds });
        const job = { id: `job-${started.length}`, sourceId: id, finishedAt: null };
        jobs.set(job.id, job);
        return { job, started: true };
      },
    },
  });
  mock.module("next/server", { namedExports: { NextResponse, NextRequest } });
  const mod = await import("./route.ts");
  GET = mod.GET;
  POST = mod.POST;
});

const url = (id: string, qs = "") => `https://os.example/api/tools/analytics/campaigns/${id}/renew${qs}`;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (id: string, b: unknown) => POST(new NextRequest(url(id), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }), ctx(id));
const get = (id: string, qs = "") => GET(new NextRequest(url(id, qs)), ctx(id));
const reset = () => { session.current = { email: "amy@example.com" }; started.length = 0; jobs.clear(); running = null; preview = { token: "t".repeat(32), blockers: [] }; };

test("starting a renewal is Campaign Management's; the review is readable with Campaign Analytics too", () => {
  assert.deepEqual(grantsForRequest("/api/tools/analytics/campaigns/1277/renew", "POST"), ["campaigns"]);
  assert.deepEqual(grantsForRequest("/api/tools/analytics/campaigns/1277/renew", "GET"), ["analytics", "campaigns"]);
});

test("GET: the review, signed in only, a numeric EmailBison id only", { skip }, async () => {
  reset();
  let r = await get("1277");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { preview: { token: "t".repeat(32), blockers: [] }, runningJobId: null });
  assert.equal((await get("abc")).status, 400);
  assert.equal((await get("12.5")).status, 400);
  assert.equal((await get("0")).status, 400);
  session.current = null;
  assert.equal((await get("1277")).status, 401);
  reset();
  preview = { error: "This campaign was not found in EmailBison." };
  r = await get("1277");
  assert.equal(r.status, 404);
});

test("GET: says a renewal is already running for the campaign", { skip }, async () => {
  reset();
  running = { id: "job-9" };
  const r = await get("1277");
  assert.equal((await r.json()).runningJobId, "job-9");
});

test("POST: must be confirmed, with the review's token; starts one job as the signed-in person", { skip }, async () => {
  reset();
  assert.equal((await post("1277", { token: "t".repeat(32) })).status, 428);
  assert.equal((await post("1277", { confirm: true })).status, 400);
  assert.equal(started.length, 0, "nothing started without confirm + token");
  const r = await post("1277", { token: "t".repeat(32), confirm: true });
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { jobId: "job-1" });
  assert.deepEqual(started, [{ id: 1277, token: "t".repeat(32), actor: "amy@example.com", poolIds: [] }], "no pool picks sent: none");
  const withPool = await post("1278", { token: "t".repeat(32), poolIds: [61, 62], confirm: true });
  assert.equal(withPool.status, 202);
  assert.deepEqual(started[1].poolIds, [61, 62], "the review's pool picks are passed on");
  assert.equal((await post("1279", { token: "t".repeat(32), poolIds: [0], confirm: true })).status, 400, "a bad inbox id is refused");
  started.length = 1;
  session.current = null;
  assert.equal((await post("1277", { token: "t".repeat(32), confirm: true })).status, 401);
});

test("POST twice: the second is told it is already running, with the running job", { skip }, async () => {
  reset();
  running = { id: "job-1" };
  const r = await post("1277", { token: "t".repeat(32), confirm: true });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).jobId, "job-1");
  assert.equal(started.length, 0);
});

test("GET ?job=: the job for this campaign only", { skip }, async () => {
  reset();
  await post("1277", { token: "t".repeat(32), confirm: true });
  const ok = await get("1277", "?job=job-1");
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).job.id, "job-1");
  assert.equal((await get("999", "?job=job-1")).status, 404, "another campaign's id never shows this job");
  assert.equal((await get("1277", "?job=nope")).status, 404);
});
