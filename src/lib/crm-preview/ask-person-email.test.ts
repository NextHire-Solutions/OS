/*
 * The switch, for real, through the route: only sign-in, the portal-closed check and Slack are mocked here. A reply is
 * never emailed to a client unless OS_PORTAL_CHAT_EMAIL is exactly "1" — the rule a deploy alone must never get past.
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest } from "../tools/master-inbox/test/fake-postgrest.ts";

configureFakeEnvironment("MASTER_INBOX_");
process.env.OS_CLIENT_SIGNIN = "1";
process.env.POSTMARK_SERVER_TOKEN = "test-token";
process.env.OS_PORTAL_CHAT_REPLY_TO = "team@brokerstaffer.test";
const db = new FakePostgrest();
const sent: Array<{ To: string; From: string; ReplyTo: string; TextBody: string }> = [];
let nextMessage = 1000;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith("https://api.postmarkapp.com/")) {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ErrorCode: 0 }), { status: 200 });
  }
  if (url.includes("os_portal_chat_messages") && init?.method === "POST" && typeof init.body === "string") {
    const rows = JSON.parse(init.body) as Record<string, unknown> | Array<Record<string, unknown>>;
    return db.fetch(input as never, { ...init, body: JSON.stringify(Array.isArray(rows) ? rows.map((r) => ({ id: nextMessage++, ...r })) : { id: nextMessage++, ...rows }) });
  }
  return db.fetch(input as never, init);
}) as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";
const PORTAL = "10000000-0000-4000-8000-000000000001";
type Viewer = { kind: "staff"; email: string } | { kind: "client"; email: string; portals: string[] };
let viewer: Viewer = { kind: "client", email: "jane@acme.test", portals: [PORTAL] };

let POST: ((request: never) => Promise<Response>) | null = null;
if (canMock) {
  mock.module("./viewer", { namedExports: { crmViewerOf: async () => viewer, crmViewer: async () => viewer } });
  mock.module("./portal-open", { namedExports: { closedToClient: async () => null } });
  mock.module("../clients/prospect-sync/queue", { namedExports: { postToPortalChannel: async () => true } });
  ({ POST } = (await import("../../app/api/crm-preview/ask-person/route")) as unknown as { POST: typeof POST });
}
const { NextRequest } = await import("next/server");
const post = async (body: unknown) => {
  const r = await POST!(new NextRequest("https://os.brokerstaffer.com/api/crm-preview/ask-person", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" } }) as never);
  return (await r.json()) as { reply?: string; thread: { id: string; messages: Array<{ text: string; emailed: boolean }> } };
};
function seed(email: string) {
  db.reset();
  sent.length = 0;
  db.seed("clients", [{ id: PORTAL, name: "Premier Home Team" }]);
  db.seed("client_team_members", []);
  db.seed("os_portal_logins", [{ portal_id: PORTAL, email, name: "Jane Smith", removed_at: null }]);
  db.seed("os_users", [{ email: "amy@brokerstaffer.com", name: "Amy Anderes" }]);
  db.seed("os_portal_chat_threads", []);
  db.seed("os_portal_chat_messages", []);
  viewer = { kind: "client", email, portals: [PORTAL] };
}
const amy = () => { viewer = { kind: "staff", email: "amy@brokerstaffer.com" }; };

test("the switch off (as a deploy leaves it): nothing goes to a client, the chat doesn't promise an email, and our team is shown it didn't go", { skip }, async () => {
  for (const off of [undefined, "", "0", "true"]) {
    if (off === undefined) delete process.env.OS_PORTAL_CHAT_EMAIL; else process.env.OS_PORTAL_CHAT_EMAIL = off;
    seed("jane@acme.test");
    const asked = await post({ client: PORTAL, action: "ask" });
    assert.doesNotMatch(String(asked.reply), /by email/);
    amy();
    const r = await post({ client: PORTAL, action: "reply", thread: asked.thread.id, text: "Hello Jane" });
    assert.equal(sent.length, 0, `OS_PORTAL_CHAT_EMAIL=${off}`);
    assert.equal(r.thread.messages.at(-1)!.emailed, false);
    assert.equal(r.thread.messages.at(-1)!.text, "Hello Jane", "the reply is in the chat regardless");
  }
});

test("the switch off: our own test address still gets it, to try it end to end", { skip }, async () => {
  delete process.env.OS_PORTAL_CHAT_EMAIL;
  seed("admin@outreachify.io");
  const asked = await post({ client: PORTAL, action: "ask" });
  amy();
  const r = await post({ client: PORTAL, action: "reply", thread: asked.thread.id, text: "Hello" });
  assert.deepEqual(sent.map((m) => m.To), ["admin@outreachify.io"]);
  assert.equal(r.thread.messages.at(-1)!.emailed, true);
});

test("the switch on: the reply goes to that client, and only them, and the chat says it will", { skip }, async () => {
  process.env.OS_PORTAL_CHAT_EMAIL = "1";
  seed("jane@acme.test");
  const asked = await post({ client: PORTAL, action: "ask" });
  assert.match(String(asked.reply), /here and by email/);
  amy();
  const r = await post({ client: PORTAL, action: "reply", thread: asked.thread.id, text: "Import a CSV." });
  assert.deepEqual(sent.map((m) => m.To), ["jane@acme.test"]);
  assert.equal(sent[0].ReplyTo, "team@brokerstaffer.test", "the client's answer goes to the team inbox");
  assert.match(sent[0].TextBody, /Import a CSV\./);
  assert.match(sent[0].TextBody, /Amy, BrokerStaffer/);
  assert.equal(r.thread.messages.at(-1)!.emailed, true);
  delete process.env.OS_PORTAL_CHAT_EMAIL;
});

test("no team inbox set, or the retired one: nothing is emailed even with the switch on, and the chat doesn't promise it", { skip }, async () => {
  process.env.OS_PORTAL_CHAT_EMAIL = "1";
  for (const replyTo of [undefined, "", "nicole.c@brokerstaffer.com", "Nicole.C@BrokerStaffer.com", "support@leads.brokerstaffer.com", "not an address"]) {
    if (replyTo === undefined) delete process.env.OS_PORTAL_CHAT_REPLY_TO; else process.env.OS_PORTAL_CHAT_REPLY_TO = replyTo;
    for (const email of ["jane@acme.test", "admin@outreachify.io"]) {
      seed(email);
      const asked = await post({ client: PORTAL, action: "ask" });
      assert.doesNotMatch(String(asked.reply), /by email/, `${replyTo} ${email}`);
      amy();
      const r = await post({ client: PORTAL, action: "reply", thread: asked.thread.id, text: "Hello" });
      assert.equal(sent.length, 0, `${replyTo} ${email}`);
      assert.equal(r.thread.messages.at(-1)!.emailed, false);
      assert.equal(r.thread.messages.at(-1)!.text, "Hello", "the reply is in the chat regardless");
    }
  }
  process.env.OS_PORTAL_CHAT_REPLY_TO = "team@brokerstaffer.test";
  delete process.env.OS_PORTAL_CHAT_EMAIL;
});
