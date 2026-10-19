import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { canSeeCrmPreview, PREVIEW_REVIEWERS } from "./access.ts";

/*
 * The CRM redesign preview is for Owners only (ADMIN_EMAILS) — "only we should
 * be able to see this" — and must not be anywhere a client, or the rest of the
 * team, could come across it.
 */

const OWNERS = ["admin@outreachify.io"];

test("an Owner sees it, whatever the address's case", () => {
  assert.equal(canSeeCrmPreview("admin@outreachify.io", OWNERS), true);
  assert.equal(canSeeCrmPreview(" Admin@Outreachify.io ", OWNERS), true);
});

test("Eddy, by name — the reviewer the user chose (16 Oct) — and no one else by being an admin", () => {
  assert.deepEqual(PREVIEW_REVIEWERS, ["eddy@brokerstaffer.com"], "a reviewer is added here, deliberately");
  assert.equal(canSeeCrmPreview("eddy@brokerstaffer.com", OWNERS), true);
  assert.equal(canSeeCrmPreview(" Eddy@BrokerStaffer.com", OWNERS), true);
});

test("nobody else: not another admin, not an account manager, not a salesperson, not a client", () => {
  for (const email of ["amy@brokerstaffer.com", "gabriel@brokerstaffer.com", "client@brokerage.com", "eddy@brokerstaffer.co", "eddy@brokerstaffer.com.evil.io"]) {
    assert.equal(canSeeCrmPreview(email, OWNERS), false, email);
  }
});

test("fails closed: no Owners list, no session, no address — nobody but the named reviewer", () => {
  assert.equal(canSeeCrmPreview("admin@outreachify.io", []), false);
  assert.equal(canSeeCrmPreview(null, OWNERS), false);
  assert.equal(canSeeCrmPreview("", OWNERS), false);
  assert.equal(canSeeCrmPreview("   ", OWNERS), false);
});

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(rel));
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".test.ts")) out.push(rel);
  }
  return out;
}
const ROUTES = filesUnder("src/app/api/crm-preview");
const PREVIEW_FILES = [...filesUnder("src/app/crm-preview"), ...ROUTES, ...filesUnder("src/components/crm-preview"), ...filesUnder("src/lib/crm-preview")];

test("the preview's routes: Owners and Eddy only, checked first; anyone else a bare 404; GET, except the chat's POST", () => {
  assert.deepEqual(ROUTES.map((r) => path.relative("src/app/api/crm-preview", r)).sort(), ["billing/route.ts", "chat/route.ts", "market/route.ts", "report/route.ts"]);
  for (const r of ROUTES) {
    const src = read(r);
    const methods = [...src.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]);
    assert.deepEqual(methods, [r.includes("/chat/") ? "POST" : "GET"], `${r}: ${methods.join(", ")}`);
    const gate = src.indexOf("canSeeCrmPreview(");
    assert.ok(gate > 0, `${r} calls the gate`);
    assert.match(src.slice(gate, gate + 160), /new NextResponse\(null, \{ status: 404 \}\)/, `${r}: a bare 404 for anyone else`);
    const start = src.indexOf(`export async function ${methods[0]}`);
    for (const load of ["marketContext(", "marketPage(", "marketReport(", "marketOptions(", "searchParams", "request.json(", "loadPortalChatData(", "answer(", "getAccountBilling(", "billingPortalUrl("]) {
      const at = src.indexOf(load, start);
      assert.ok(at === -1 || at > gate, `${r}: ${load} only after the gate`);
    }
  }
});

test("the agent database is asked only through its two read-only search functions, behind the read-only guard", () => {
  const market = read("src/lib/crm-preview/market.ts");
  assert.match(market, /async function rpc\(fn: "fn_filter_search" \| "fn_facet_options", args:/, "exactly these two functions, nothing added");
  assert.equal((market.match(/\.rpc\(/g) ?? []).length, 1, "and through that one helper");
  assert.match(market, /const agentDb = \(\) => readOnly\(getCorofySupabase\(\)\)/);
  assert.match(market, /const mi = \(\) => readOnly\(createAdminSupabase\(\)\)/);
  for (const f of PREVIEW_FILES.filter((f) => f !== "src/lib/crm-preview/market.ts")) {
    assert.doesNotMatch(read(f), /\.rpc\(/, `${f}: no database functions outside market.ts`);
  }
});

test("the page checks the Owner before it reads anything", () => {
  const src = read("src/app/crm-preview/page.tsx");
  const gate = src.indexOf("canSeeCrmPreview(");
  assert.ok(gate > 0, "the page calls the gate");
  assert.match(src.slice(gate, gate + 200), /notFound\(\)/, "and shows Not found to anyone else");
  for (const load of ["loadPipelineEntries(", "loadAgentEntries(", "loadDncEntries(", "loadTeamMembers(", ".from(\"clients\")", "osTable(", "pipeline_outcome_events"]) {
    const at = src.indexOf(load);
    assert.ok(at === -1 || at > gate, `${load} only after the gate`);
  }
});

test("read-only: nothing in the preview writes to a database or calls a server action", () => {
  assert.ok(PREVIEW_FILES.length >= 4, PREVIEW_FILES.join(", "));
  const WRITES = [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /["']use server["']/, /formAction/, /navigator\.sendBeacon/];
  for (const f of PREVIEW_FILES) for (const w of WRITES) assert.doesNotMatch(read(f), w, `${f} matches ${w}`);
});

/*
 * Every request the preview makes, by file. Reads, plus exactly the two the
 * user asked for on 19 Oct: the chat (the browser POSTs a question; the server
 * asks OpenAI — nothing is written anywhere) and the Billing link (one Stripe
 * customer-portal session, the client's own page).
 */
const BROWSER_REQUESTS = [
  /^\/api\/tools\/master-inbox\/portal\/\$\{[^}]+\}\/conversation\/\$\{[^}]+\}$/,
  /^\/api\/crm-preview\/market\?\$\{[^}]+\}$/,
  /^\/api\/crm-preview\/report\?\$\{[^}]+\}$/,
  /^\/api\/crm-preview\/chat$/,
];
const SERVER_REQUESTS: Record<string, RegExp[]> = {
  "src/lib/crm-preview/chat.ts": [/^https:\/\/api\.openai\.com\/v1\/chat\/completions$/],
  "src/lib/crm-preview/billing-portal.ts": [/^\$\{STRIPE\}\/billing_portal\/configurations\?limit=100&active=true$/, /^\$\{STRIPE\}\/billing_portal\/sessions$/],
};
const POSTS: Record<string, number> = { "src/components/crm-preview/chat.tsx": 1, "src/lib/crm-preview/chat.ts": 1, "src/lib/crm-preview/billing-portal.ts": 1 };

test("requests: the preview's reads, the chat's one POST, OpenAI from the server, and Stripe's billing page — nothing else", () => {
  for (const f of PREVIEW_FILES) {
    const src = read(f);
    const allowed = SERVER_REQUESTS[f] ?? BROWSER_REQUESTS;
    const urls = [...src.matchAll(/fetch\(\s*[`"']([^`"']*)[`"']/g)].map((m) => m[1]);
    for (const u of urls) assert.ok(allowed.some((r) => r.test(u)), `${f}: fetch ${u} is not one of its requests`);
    const posts = (src.match(/method\s*:\s*"POST"/g) ?? []).length;
    assert.equal(posts, POSTS[f] ?? 0, `${f}: ${posts} POST(s)`);
    assert.doesNotMatch(src, /method\s*:\s*["'](PUT|PATCH|DELETE)["']/, f);
  }
  const chatUi = read("src/components/crm-preview/chat.tsx");
  assert.match(chatUi, /fetch\(`\/api\/crm-preview\/chat`, \{\s*method: "POST"/, "the chat window POSTs only to the chat route");
});

test("not a product: no menu item, no Team access switch, no grant, nothing opened in the proxy", () => {
  for (const f of ["src/lib/workspace/nav.ts", "src/lib/identity/admin.ts", "src/lib/bs-auth.ts", "src/lib/workspace/tool-paths.ts", "src/proxy.ts", "src/components/screens/team-access.tsx"]) {
    assert.doesNotMatch(read(f), /crm-preview|crmPreview/i, f);
  }
});

test("the Follow Up Boss key never reaches the browser — only whether one is set", () => {
  const page = read("src/app/crm-preview/page.tsx");
  assert.doesNotMatch(page, /fubApiKey=|fub_api_key=\{/, "no key passed as a prop");
  for (const f of PREVIEW_FILES.filter((f) => f.startsWith("src/components/"))) {
    assert.doesNotMatch(read(f), /fub_api_key/, f);
  }
});
