/*
 * "make sure client can see only their data only" (5 Nov): the assistant's route run for real, with a signed-in client.
 * Their own portal loads and answers; anyone else's is a bare Not found, and nothing of that portal is read.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { NextRequest, NextResponse } from "next/server";

const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

const MINE = "11111111-1111-4111-8111-111111111111";
const THEIRS = "22222222-2222-4222-8222-222222222222";
const viewer: { current: unknown } = { current: null };
const loaded: string[] = [];
const closed = { current: false };

let POST: (r: NextRequest) => Promise<Response>;
test("setup", { skip }, async () => {
  process.env.OS_CLIENT_SIGNIN = "1";
  mock.module("next/server", { namedExports: { NextResponse, NextRequest, after: () => undefined } });
  mock.module("@/lib/crm-preview/viewer", { namedExports: { crmViewerOf: async () => viewer.current } });
  mock.module("@/lib/crm-preview/portal-open", { namedExports: { closedToClient: async () => closed.current } });
  mock.module("@/lib/crm-preview/chat", {
    namedExports: {
      loadPortalChatData: async (id: string) => { loaded.push(id); return { portal: { id, name: "Mine" } }; },
      answer: async (_t: unknown, data: { portal: { name: string } }) => ({ reply: `Contacts of ${data.portal.name}`, tools: ["interested_contacts"], tokens: 1 }),
    },
  });
  mock.module("@/lib/crm-preview/market", { namedExports: { marketContext: async () => null, marketReport: async () => ({ unavailable: "none" }) } });
  mock.module("@/lib/portal-usage/usage", { namedExports: { recordUse: async () => undefined } });
  mock.module("@/lib/supabase/admin", { namedExports: { createAdminSupabase: () => ({}) } });
  POST = (await import("../../app/api/crm-preview/chat/route.ts")).POST;
});

const ask = (client: string) =>
  POST(new NextRequest("https://os.example/api/crm-preview/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
    body: JSON.stringify({ client, messages: [{ role: "user", text: "Who gets my interested agents?" }] }),
  }));
const asClient = () => { viewer.current = { kind: "client", email: "me@mine.example", portals: [MINE] }; loaded.length = 0; closed.current = false; };

test("a client asking about their own portal gets that portal, and only that portal is read", { skip }, async () => {
  asClient();
  const r = await ask(MINE);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { reply: "Contacts of Mine" });
  assert.deepEqual(loaded, [MINE]);
});

test("a client naming another client's portal gets a bare Not found, and nothing of it is read", { skip }, async () => {
  asClient();
  const r = await ask(THEIRS);
  assert.equal(r.status, 404);
  assert.equal(await r.text(), "");
  assert.deepEqual(loaded, []);
});

test("nobody signed in gets a bare Not found, for any portal", { skip }, async () => {
  viewer.current = null; loaded.length = 0;
  for (const id of [MINE, THEIRS]) assert.equal((await ask(id)).status, 404);
  assert.deepEqual(loaded, []);
});

test("a client's own portal, switched off or held, serves them nothing", { skip }, async () => {
  asClient();
  closed.current = true;
  assert.equal((await ask(MINE)).status, 404);
  assert.deepEqual(loaded, []);
});
