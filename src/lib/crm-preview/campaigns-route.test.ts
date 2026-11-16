/*
 * The Campaigns routes run for real (17 Nov): who reads and who saves a campaign's emails. A client gets their own
 * portal's campaigns and nobody else's (a bare Not found, nothing read); a portal not switched on for Campaigns is a
 * bare Not found; a save needs the write rule and a portal its own save code would accept; only the page's own fetch.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { NextRequest, NextResponse } from "next/server";

const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

const MINE = "11111111-1111-4111-8111-111111111111";
const THEIRS = "22222222-2222-4222-8222-222222222222";
const viewer: { current: unknown } = { current: null };
const closed = { current: false };
const on = { current: true };
const lock = { current: null as string | null };
const calls: string[] = [];

let GET: (r: NextRequest) => Promise<Response>;
let POST: (r: NextRequest) => Promise<Response>;
test("setup", { skip }, async () => {
  process.env.OS_CLIENT_SIGNIN = "1";
  mock.module("next/server", { namedExports: { NextResponse, NextRequest, after: () => undefined } });
  mock.module("@/lib/crm-preview/viewer", { namedExports: { crmViewerOf: async () => viewer.current } });
  mock.module("@/lib/crm-preview/portal-open", { namedExports: { closedToClient: async () => closed.current } });
  mock.module("@/lib/crm-preview/campaigns", {
    namedExports: {
      campaignsOn: () => on.current,
      campaignSaveLock: async () => lock.current,
      campaignsFailure: () => ({ status: 502, error: "failed" }),
      listCampaigns: async (p: string) => { calls.push(`list ${p}`); return { ok: true, value: [{ id: "7", name: "Mine", state: "sending" }] }; },
      readCampaign: async (p: string, c: string) => { calls.push(`read ${p} ${c}`); return { ok: true, value: { id: c, name: "Mine", emails: [] } }; },
      saveCampaign: async (p: string, c: string, _s: unknown, who: string) => { calls.push(`save ${p} ${c} ${who}`); return { ok: true, value: { view: { id: c }, summary: ["Email 1: wording changed"] } }; },
    },
  });
  GET = (await import("../../app/api/crm-preview/campaigns/route.ts")).GET;
  POST = (await import("../../app/api/crm-preview/campaign-save/route.ts")).POST;
});

const OWN_PAGE = { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" };
const get = (q: string, headers: Record<string, string> = OWN_PAGE) => GET(new NextRequest(`https://os.example/api/crm-preview/campaigns?${q}`, { headers }));
const save = (body: unknown, headers: Record<string, string> = OWN_PAGE) =>
  POST(new NextRequest("https://os.example/api/crm-preview/campaign-save", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
const SAVE = { version: "v1", emails: [{ id: 1, waitBefore: null, threadReply: false, versions: [{ id: 1, subject: "Hi", text: "Hello" }] }] };
const reset = () => { viewer.current = { kind: "client", email: "me@mine.example", portals: [MINE] }; closed.current = false; on.current = true; lock.current = null; calls.length = 0; };

test("a client reads their own portal's campaigns and one campaign's emails", { skip }, async () => {
  reset();
  const r = await get(`client=${MINE}`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { campaigns: [{ id: "7", name: "Mine", state: "sending" }] });
  const one = await get(`client=${MINE}&campaign=7`);
  assert.equal(one.status, 200);
  assert.deepEqual(calls, [`list ${MINE}`, `read ${MINE} 7`]);
  assert.equal(r.headers.get("cache-control"), "no-store, private, max-age=0");
});

test("another client's portal, nobody signed in, a closed portal, or Campaigns not on: a bare Not found, nothing read", { skip }, async () => {
  reset();
  assert.equal((await get(`client=${THEIRS}`)).status, 404);
  assert.equal((await save({ client: THEIRS, campaign: "7", save: SAVE })).status, 404);
  viewer.current = null;
  assert.equal((await get(`client=${MINE}`)).status, 404);
  assert.equal((await save({ client: MINE, campaign: "7", save: SAVE })).status, 404);
  reset();
  closed.current = true;
  assert.equal((await get(`client=${MINE}`)).status, 404);
  assert.equal((await save({ client: MINE, campaign: "7", save: SAVE })).status, 404);
  reset();
  on.current = false;
  const r = await get(`client=${MINE}`);
  assert.equal(r.status, 404);
  assert.equal(await r.text(), "");
  assert.equal((await save({ client: MINE, campaign: "7", save: SAVE })).status, 404);
  assert.deepEqual(calls, []);
});

test("only the page's own fetch: a script, a typed address or another site is refused", { skip }, async () => {
  reset();
  assert.equal((await get(`client=${MINE}`, {})).status, 403);
  assert.equal((await save({ client: MINE, campaign: "7", save: SAVE }, { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" })).status, 403);
  assert.deepEqual(calls, []);
});

test("a client saves their own campaign, as themselves", { skip }, async () => {
  reset();
  const r = await save({ client: MINE, campaign: "7", save: SAVE });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, campaign: { id: "7" }, summary: ["Email 1: wording changed"] });
  assert.deepEqual(calls, [`save ${MINE} 7 me@mine.example`]);
});

test("a portal its own save code would refuse (switched off, held) refuses the save, for staff too", { skip }, async () => {
  reset();
  viewer.current = { kind: "staff", email: "admin@outreachify.io" };
  lock.current = "This portal is paused for an unpaid invoice, so nothing can be saved.";
  const r = await save({ client: MINE, campaign: "7", save: SAVE });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /unpaid invoice/);
  assert.deepEqual(calls, []);
});

test("a save that can't be read is refused before anything is written", { skip }, async () => {
  reset();
  for (const bad of [{ client: MINE, campaign: "abc", save: SAVE }, { client: MINE, campaign: "7", save: { version: "v", emails: [] } }, { client: MINE, campaign: "7", save: { ...SAVE, emails: [{ ...SAVE.emails[0], versions: [{ id: 1, subject: "x", text: "y".repeat(20001) }] }] } }]) {
    assert.equal((await save(bad)).status, 400);
  }
  assert.deepEqual(calls, []);
});
