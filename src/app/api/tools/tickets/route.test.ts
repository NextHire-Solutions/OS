import { test } from "node:test";
import assert from "node:assert/strict";

import { NextRequest } from "next/server";

import { configureFakeEnvironment, FakePostgrest } from "../../../../lib/tools/master-inbox/test/fake-postgrest.ts";
import { mintSso } from "../../../../lib/bs-auth.ts";
import { grantsForRequest } from "../../../../lib/workspace/tool-paths.ts";
import { canSeePage } from "../../../../lib/workspace/nav.ts";

/*
 * Tickets (20 Nov) — who can reach it. Its own switch, `tickets`: the proxy gates every screen and API path on it,
 * and each route checks again, so nobody without the switch reads a client's email.
 */

configureFakeEnvironment("MASTER_INBOX_");
process.env.AUTH_SECRET = "s".repeat(40);
process.env.ADMIN_EMAILS = "admin@outreachify.io";
const db = new FakePostgrest();
globalThis.fetch = db.fetch as typeof fetch;

const cookie = async (email: string, grants: string[]) => `bs_sso=${await mintSso(process.env.AUTH_SECRET!, { email, grants: grants as never, ver: 0 })}`;

test("the proxy gates every Tickets screen and API path on the tickets switch, and only that", () => {
  for (const p of ["/tickets", "/tickets/inboxes", "/api/tools/tickets", "/api/tools/tickets/1042", "/api/tools/tickets/attachment", "/api/tools/tickets/google/callback", "/api/tools/tickets/inboxes"]) {
    assert.deepEqual(grantsForRequest(p, "GET"), ["tickets"], p);
  }
  for (const m of ["PATCH", "DELETE", "POST"]) assert.deepEqual(grantsForRequest("/api/tools/tickets/1042", m), ["tickets"], m);
  assert.notDeepEqual(grantsForRequest("/inbox/all-email", "GET"), ["tickets"], "Master Inbox is not opened by it");
});

test("the route refuses a missing session and a teammate without the switch; an admin passes", async () => {
  const { GET } = await import("./route.ts");
  const req = (c?: string) => new NextRequest("https://os.example/api/tools/tickets", { headers: c ? { cookie: c } : {} });
  assert.equal((await GET(req())).status, 401);
  assert.equal((await GET(req(await cookie("amy@brokerstaffer.com", ["inbox", "portals"])))).status, 403);
  // Past the access check an admin reaches the data (here: the fake database has no Tickets tables → setup message).
  const admin = await GET(req(await cookie("admin@outreachify.io", [])));
  assert.notEqual(admin.status, 401);
  assert.notEqual(admin.status, 403);
});

test("Tickets is a product, not a workspace page: no role opens it", () => {
  assert.equal(canSeePage("tickets", false, [], [], {}), true, "workspace pages don't decide it; the proxy does");
});

test("replies (24 Nov): the reply route is behind the same switch; sending needs this OS's own Origin", async () => {
  for (const m of ["GET", "POST"]) assert.deepEqual(grantsForRequest("/api/tools/tickets/1042/reply", m), ["tickets"], m);
  const { GET, POST } = await import("./[id]/reply/route.ts");
  const params = { params: Promise.resolve({ id: "1042" }) };
  const post = (headers: Record<string, string>) => new NextRequest("https://os.example/api/tools/tickets/1042/reply", { method: "POST", headers: { "content-type": "application/json", host: "os.example", ...headers }, body: JSON.stringify({ from: "amy@brokerstaffer.com", text: "Hi", cc: [], nonce: "nonce-route-1" }) });
  assert.equal((await GET(new NextRequest("https://os.example/api/tools/tickets/1042/reply"), params)).status, 401);
  assert.equal((await POST(post({ cookie: await cookie("amy@brokerstaffer.com", ["inbox"]), origin: "https://os.example" }), params)).status, 403, "no Tickets switch");
  const gabe = await cookie("gabo075823532@gmail.com", ["tickets"]);
  assert.equal((await POST(post({ cookie: gabe }), params)).status, 403, "no Origin: refused (a form or a script elsewhere)");
  assert.equal((await POST(post({ cookie: gabe, origin: "https://evil.example" }), params)).status, 403, "another site: refused");
  const plain = new NextRequest("https://os.example/api/tools/tickets/1042/reply", { method: "POST", headers: { cookie: gabe, origin: "https://os.example", host: "os.example", "content-type": "text/plain" }, body: "{}" });
  assert.equal((await POST(plain, params)).status, 415, "only JSON");
  // Past every check, a teammate with the switch reaches the send (the fake database has no Tickets tables).
  const ok = await POST(post({ cookie: gabe, origin: "https://os.example" }), params);
  assert.ok(![401, 403, 415].includes(ok.status), String(ok.status));
});
