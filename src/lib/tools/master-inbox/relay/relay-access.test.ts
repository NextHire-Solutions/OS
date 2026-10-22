/*
 * Who may do what with the brokerage hand-off (review decision, 17 Oct).
 *
 * The OS convention (Team access, 15 Oct): every product is its own switch,
 * a write follows the switch of the product it belongs to, and nobody is
 * switched on to anything new by default. No new grant is invented here.
 *
 *   "Send to brokerage" / "Check again" / "Try again" on a conversation
 *     → the Master Inbox switch (`inbox`), enforced by the proxy for every
 *       /api/tools/master-inbox/* request — the same switch that lets a person
 *       send a reply or press Introduce on that conversation, which already
 *       emails the same brokerage people. The route also needs a signed-in
 *       address, which every hand-off records.
 *   The switches, the brokerages' settings, the held-campaign answers
 *     → admins only (requireAdminSession), like AI labelling: they decide
 *       what reaches clients automatically.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { ALL_TOOLS } from "../../../bs-auth.ts";
import { grantsForRequest } from "../../../workspace/tool-paths.ts";

const API = "src/app/api/tools/master-inbox";
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const THREAD = "0b6f1c2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";

test("the conversation's button follows the Master Inbox switch — not Client Portals, not a new grant", () => {
  for (const method of ["GET", "POST"]) {
    assert.deepEqual(grantsForRequest(`/api/tools/master-inbox/threads/${THREAD}/relay`, method), ["inbox"], method);
  }
  // The same switch as the conversation's other sends.
  assert.deepEqual(grantsForRequest(`/api/tools/master-inbox/threads/${THREAD}/reply`, "POST"), ["inbox"]);
  assert.deepEqual(grantsForRequest(`/api/tools/master-inbox/threads/${THREAD}/intro-macro`, "GET"), ["inbox"]);
  assert.equal(ALL_TOOLS.some((t) => /relay|postmark|brokerage/i.test(t)), false, "no grant was added for this");
});

test("pressing it needs a signed-in address, which the hand-off records", () => {
  const src = read(`${API}/threads/[threadId]/relay/route.ts`);
  assert.match(src, /export async function POST[\s\S]*?const session = await requireSession\(\);[\s\S]*?if \(!who\) return NextResponse\.json\([^)]*\{ status: 401 \}\)/);
  assert.match(src, /sendToBrokerage\(relayId, threadId, who\)/);
});

test("every Settings route of the hand-off is admins only, in every method", () => {
  for (const file of ["relay/route.ts", "relay/assign/route.ts", "relay/brokerage/route.ts", "relay/email/route.ts", "relay/test/route.ts"]) {
    const src = read(`${API}/${file}`);
    const handlers = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b[^{]*\{([\s\S]*?)\n\}/g)];
    assert.ok(handlers.length > 0, file);
    for (const [, method, body] of handlers) {
      assert.match(body, /const session = await requireAdminSession\(\);\s*if \(session instanceof NextResponse\) return session;/, `${method} ${file}`);
    }
  }
  const settings = read("src/components/screens/master-inbox/settings.tsx");
  assert.match(settings, /const ADMIN_TABS = new Set<SettingsTab>\(\[[^\]]*"brokerage-relay"[^\]]*\]\)/, "the tab is hidden from non-admins too");
});

test("View email (23 Oct) only reads: a GET, admins only, and relayEmailView never sends or writes", () => {
  const route = read(`${API}/relay/email/route.ts`);
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/);
  assert.ok(route.indexOf("requireAdminSession()") < route.indexOf("relayEmailView("), "admins first");
  const src = read("src/lib/tools/master-inbox/relay/relay.ts");
  const start = src.indexOf("export async function relayEmailView(");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  for (const w of [".send(", "sendTest(", ".update(", ".insert(", ".upsert(", ".delete(", "transport", "takeTestSend"]) assert.ok(!body.includes(w), `relayEmailView must not use ${w}`);
  // The screen renders the email in a frame that can run nothing and load nothing.
  const ui = read("src/components/master-inbox/settings/relay-email-view.tsx");
  assert.match(ui, /<iframe[^>]*sandbox=""/);
  assert.match(ui, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"/);
  assert.equal((ui.match(/fetch\(/g) ?? []).length, 1);
  assert.match(ui, /fetch\(`\/api\/tools\/master-inbox\/relay\/email\?id=/, "its one request is the read");
});
