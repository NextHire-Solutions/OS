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

test("Eddy and Amy, by name — the reviewers the user chose (16 and 20 Oct) — and no one else by being an admin", () => {
  assert.deepEqual(PREVIEW_REVIEWERS, ["eddy@brokerstaffer.com", "amy@brokerstaffer.com"], "a reviewer is added here, deliberately (Amy 20 Oct)");
  assert.equal(canSeeCrmPreview("Amy@BrokerStaffer.com", OWNERS), true);
  assert.equal(canSeeCrmPreview("amy@brokerstaffer.com", []), true, "by name, whatever the Owners list");
  assert.equal(canSeeCrmPreview("eddy@brokerstaffer.com", OWNERS), true);
  assert.equal(canSeeCrmPreview(" Eddy@BrokerStaffer.com", OWNERS), true);
});

test("nobody else: not another admin, not an account manager, not a salesperson, not a client", () => {
  for (const email of ["amy@brokerstaffer.co", "amy.anderes@brokerstaffer.com", "gabriel@brokerstaffer.com", "client@brokerage.com", "eddy@brokerstaffer.co", "eddy@brokerstaffer.com.evil.io"]) {
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
// /api/crm-preview/demo only forwards to /save (28 Oct; pinned below and in demo.test.ts) — every other route is gated here.
const FORWARDER = "src/app/api/crm-preview/demo/route.ts";
const ROUTES = filesUnder("src/app/api/crm-preview").filter((r) => r !== FORWARDER);
const PREVIEW_FILES = [...filesUnder("src/app/crm-preview"), ...ROUTES, ...filesUnder("src/components/crm-preview"), ...filesUnder("src/lib/crm-preview")];

test("the preview's routes: the reviewers, or a signed-in client on their own open portal — checked first; anyone else a bare 404; GET, except the chat's POST", () => {
  assert.deepEqual(ROUTES.map((r) => path.relative("src/app/api/crm-preview", r)).sort(), ["billing-periods/route.ts", "billing/route.ts", "chat/route.ts", "conversation/route.ts", "market/route.ts", "report/route.ts", "save/route.ts"]);
  assert.match(read(FORWARDER), /^export \{ POST \} from "\.\.\/save\/route";$/m, "the old address only forwards to /save");
  assert.doesNotMatch(read(FORWARDER), /function|import /, "and has nothing of its own");
  for (const r of ROUTES) {
    const src = read(r);
    const methods = [...src.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]);
    assert.deepEqual(methods, [r.includes("/chat/") || r.includes("/save/") ? "POST" : "GET"], `${r}: ${methods.join(", ")}`);
    assert.doesNotMatch(src, /canSeeCrmPreview\(|verifySso\(/, `${r}: the one gate, not its own`);
    const gate = src.indexOf("crmViewerOf(request)");
    assert.ok(gate > 0, `${r} calls the gate`);
    assert.match(src.slice(gate, gate + 120), /if \(!viewer\) return new NextResponse\(null, \{ status: 404 \}\)/, `${r}: a bare 404 for anyone else`);
    // The portal asked for is one this viewer may open — a bare 404 otherwise — before anything about it is read.
    const own = src.indexOf("if (!mayOpenPortal(viewer, ");
    assert.ok(own > gate, `${r}: checks the portal is the viewer's`);
    assert.match(src.slice(own, own + 120), /\)\) return new NextResponse\(null, \{ status: 404 \}\)/, `${r}: a bare 404 for a portal not theirs`);
    const start = src.indexOf(`export async function ${methods[0]}`);
    for (const load of ["marketContext(", "marketPage(", "marketReport(", "marketOptions(", "portalClient(", "searchParams", "request.json(", "loadPortalChatData(", "answer(", "getAccountBilling(", "billingPortalUrl(", "runDemoAction(", "runPortalAction(", "createAdminSupabase(", "portalBillingPage("]) {
      const at = src.indexOf(load, start);
      assert.ok(at === -1 || at > gate, `${r}: ${load} only after the gate`);
    }
    for (const load of ["marketContext(", "marketPage(", "marketReport(", "marketOptions(", "portalClient(", "loadPortalChatData(", "answer(", "getAccountBilling(", "billingPortalUrl(", "runDemoAction(", "runPortalAction(", "portalBillingPage(", "admit("]) {
      const at = src.indexOf(load, start);
      assert.ok(at === -1 || at > own, `${r}: ${load} only after the portal check`);
    }
    // A client's portal switched off or held serves them nothing (28 Oct audit) — checked right after it is theirs; saves are refused in portal-save.ts.
    if (!r.includes("/save/")) {
      const closed = src.indexOf("if (await closedToClient(viewer, client as string)) return new NextResponse(null, { status: 404 });");
      assert.ok(closed > own, `${r}: a switched-off or held portal is closed to its client`);
      for (const load of ["marketContext(", "marketPage(", "marketReport(", "portalClient(", "loadPortalChatData(", "getAccountBilling(", "billingPortalUrl(", "portalBillingPage(", "admit("]) {
        const at = src.indexOf(load, start);
        assert.ok(at === -1 || at > closed, `${r}: ${load} only after the closed check`);
      }
    }
    // Clients are counted and guarded as clients, staff as staff — never a role written in.
    assert.doesNotMatch(src, /role: "(staff|client)"|admit\(who, "/, `${r}: the role comes from the viewer`);
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

test("the page checks who is looking before it reads anything, and the portal is theirs before it reads that portal", () => {
  const src = read("src/app/crm-preview/page.tsx");
  const gate = src.indexOf("const viewer = await crmViewer(");
  assert.ok(gate > 0, "the page calls the gate");
  assert.match(src.slice(gate, gate + 200), /if \(!viewer\) notFound\(\)/, "and shows Not found to anyone else");
  for (const load of ["loadPipelineEntries(", "loadAgentEntries(", "loadDncEntries(", "loadTeamMembers(", ".from(\"clients\")", "osTable(", "pipeline_outcome_events"]) {
    const at = src.indexOf(load);
    assert.ok(at === -1 || at > gate, `${load} only after the gate`);
  }
  const own = src.indexOf("if (!mayOpenPortal(viewer, clientId)) notFound();");
  assert.ok(own > gate, "the portal is checked");
  for (const load of ["loadPipelineEntries(", "loadAgentEntries(", "loadDncEntries(", "loadTeamMembers(", ".eq(\"id\", clientId)", "pipeline_outcome_events", "loadOffer("]) {
    assert.ok(src.indexOf(load, gate) > own, `${load} only after the portal check`);
  }
  // A client sees what their current portal would (28 Oct): Not found while portals are off or theirs is switched off,
  // the "paused" notice while it is held — both before any of its lists are read. Staff still see the portal.
  const held = src.indexOf("const hold = await portalBillingHold(client.id as string);");
  assert.ok(held > own, "the hold is checked for the portal asked for");
  // (Not the Demo Portal — the testers' sample, no client's.)
  assert.match(src.slice(src.lastIndexOf('if (audience === "client" && !isDemoPortal(client.id as string)) {', held), held), /if \(!CLIENT_PORTALS_ENABLED \|\| \(client as \{ portal_enabled\?: boolean \| null \}\)\.portal_enabled === false\) notFound\(\);/);
  assert.match(src.slice(held, held + 200), /if \(hold\) return <PortalBillingHold /);
  for (const load of ["loadPipelineEntries(", "loadAgentEntries(", "loadDncEntries(", "loadTeamMembers(", "loadOffer("]) assert.ok(src.indexOf(load, gate) > held, `${load} only after the hold check`);
  // A client's list of portals is only theirs; the staff session keeper never runs for a client (its 401 sends to the staff login).
  assert.match(src, /if \(viewer\.kind === "client"\) portalQuery = portalQuery\.in\("id", viewer\.portals\);/);
  assert.match(src, /\{audience === "staff" \? <SessionKeeper \/> : null\}/);
});

/*
 * The two files that write: the Demo Portal's saves (21 Oct), on the Demo Portal's rows only — demo.test.ts; and a
 * real client's own saves (28 Oct), through their current portal's own save code — portal-save.test.ts.
 */
const WRITER = "src/lib/crm-preview/demo.ts";
const PORTAL_WRITER = "src/lib/crm-preview/portal-save.ts";

test("read-only: nothing in the preview writes to a database or calls a server action — except the saves, in two files", () => {
  assert.ok(PREVIEW_FILES.length >= 4, PREVIEW_FILES.join(", "));
  assert.ok(PREVIEW_FILES.includes(WRITER) && PREVIEW_FILES.includes(PORTAL_WRITER));
  const WRITES = [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /["']use server["']/, /formAction/, /navigator\.sendBeacon/];
  for (const f of PREVIEW_FILES.filter((f) => f !== WRITER && f !== PORTAL_WRITER)) for (const w of WRITES) assert.doesNotMatch(read(f), w, `${f} matches ${w}`);
  assert.doesNotMatch(read(WRITER), /\.upsert\(|["']use server["']/);
  // Only the save route runs them (the old /demo address forwards to it).
  for (const f of PREVIEW_FILES.filter((f) => f !== WRITER && f !== "src/app/api/crm-preview/save/route.ts")) assert.doesNotMatch(read(f), /runDemoAction/, f);
  for (const f of PREVIEW_FILES.filter((f) => f !== PORTAL_WRITER && f !== "src/app/api/crm-preview/save/route.ts")) assert.doesNotMatch(read(f), /runPortalAction/, f);
});

/*
 * portal-save.ts writes through the current portal's own handlers. Its few writes of its own are Market's Move to
 * (adding to My Agents / the DNC List, and noting how each block went) and, after a bulk stage move, taking agents out
 * of a custom stage — nothing else, never a delete (a removal is the current portal's own), never the clients table.
 */
test("a real portal's own writes: exactly these tables, never a delete, never `clients`", () => {
  const src = read(PORTAL_WRITER);
  assert.doesNotMatch(src, /\.upsert\(|\.delete\(|["']use server["']|\.rpc\(/);
  const writes = [...src.matchAll(/\.from\(([^)]+)\)\s*\.(insert|update)\(/g)].map((m) => `${m[1]}.${m[2]}`).sort();
  assert.deepEqual(writes, ['"client_agents".insert', '"client_dnc_entries".insert', '"client_pipeline_entries".update', '"os_market_dnc_emails".insert', "table.update"]);
  // The custom-stage clear: only that column, only this portal's agents.
  assert.match(src, /\.from\("client_pipeline_entries"\)\.update\(\{ custom_stage_key: null \}\)\.eq\("client_id", client\.id\)/);
  // How a block went: only the push columns, by the row just added.
  assert.match(src, /\.update\(\{\s*pushed_to_instantly: [^}]+pushed_to_emailbison: [^}]+push_error: [^}]+\}\)\s*\.eq\("id", row\.id\)/);
  assert.match(src, /async function blockAll\(table: "client_agents" \| "client_dnc_entries"/);
  assert.doesNotMatch(src, /from\("clients"\)\.(update|insert)/);
});

/*
 * The one write the data routes make (21 Oct): a usage count, after serving,
 * through lib/portal-usage — outside the preview, so the rule above still
 * holds for every preview file. It never refuses anything (usage.test.ts).
 */
test("usage is counted after serving, in the background — on every data route, and never before the gate", () => {
  for (const [r, kind] of [["market", "market"], ["report", "report"], ["chat", "chat"], ["billing", "billing"], ["conversation", "conversation"]] as const) {
    const src = read(`src/app/api/crm-preview/${r}/route.ts`);
    assert.match(src, /^import \{ recordUse \} from "@\/lib\/portal-usage\/usage";$/m, r);
    const uses = [...src.matchAll(/after\(\(\) => recordUse\(createAdminSupabase\(\), \{ who, role, portalId: client, kind: "(\w+)"/g)];
    assert.ok(uses.length >= 1 && uses.every((u) => u[1] === kind), `${r}: counted as ${kind}`);
    assert.equal(uses.length, (src.match(/recordUse\(/g) ?? []).length, `${r}: only ever in after()`);
    for (const u of uses) {
      assert.ok(u.index! > src.indexOf("crmViewerOf(request)"), `${r}: after the gate`);
      assert.ok(u.index! > src.indexOf("admit("), `${r}: after the guard`);
    }
  }
  assert.doesNotMatch(read("src/app/api/crm-preview/demo/route.ts"), /recordUse/, "Demo saves are not reads");
});

/*
 * Every request the preview makes, by file. Reads, plus exactly the two the
 * user asked for on 19 Oct: the chat (the browser POSTs a question; the server
 * asks OpenAI — nothing is written anywhere) and the Billing link (one Stripe
 * customer-portal session, the client's own page).
 */
const BROWSER_REQUESTS = [
  /^\/api\/crm-preview\/conversation\?\$\{[^}]+\}$/,
  /^\/api\/crm-preview\/billing-periods\?client=\$\{[^}]+\}$/,
  /^\/api\/crm-preview\/market\?\$\{[^}]+\}$/,
  /^\/api\/crm-preview\/report\?\$\{[^}]+\}$/,
  /^\/api\/crm-preview\/chat$/,
  /^\/api\/crm-preview\/save$/,
  // A signed-in client's Sign out (27 Oct): ends this browser's session.
  /^\/api\/portal-signin\/signout$/,
];
const SERVER_REQUESTS: Record<string, RegExp[]> = {
  "src/lib/crm-preview/chat.ts": [/^https:\/\/api\.openai\.com\/v1\/chat\/completions$/],
  "src/lib/crm-preview/billing-portal.ts": [/^\$\{STRIPE\}\/billing_portal\/configurations\?limit=100&active=true$/, /^\$\{STRIPE\}\/billing_portal\/sessions$/],
};
const POSTS: Record<string, number> = { "src/components/crm-preview/crm-preview.tsx": 1, "src/components/crm-preview/chat.tsx": 1, "src/components/crm-preview/demo-save.ts": 1, "src/lib/crm-preview/chat.ts": 1, "src/lib/crm-preview/billing-portal.ts": 1 };

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

test("not a product: no menu item, no Team access switch, no grant — and the proxy opens it only to a client's sign-in, on its exact paths", () => {
  for (const f of ["src/lib/workspace/nav.ts", "src/lib/identity/admin.ts", "src/lib/bs-auth.ts", "src/lib/workspace/tool-paths.ts", "src/components/screens/team-access.tsx"]) {
    assert.doesNotMatch(read(f), /crm-preview|crmPreview/i, f);
  }
  // proxy.ts names it only in CLIENT_PORTAL_PATHS, used once, behind a client's cookie and no staff session (proxy-public.test.ts runs it).
  const proxy = read("src/proxy.ts");
  const list = proxy.slice(proxy.indexOf("export const CLIENT_PORTAL_PATHS"), proxy.indexOf("]);", proxy.indexOf("export const CLIENT_PORTAL_PATHS")));
  assert.equal((proxy.match(/crm-preview/g) ?? []).length, (list.match(/crm-preview/g) ?? []).length + (proxy.match(/lib\/crm-preview\/(viewer|viewer-rules)/g) ?? []).length, "named nowhere else");
  assert.match(proxy, /if \(!session && CLIENT_PORTAL_PATHS\.has\(pathname\) && request\.cookies\.has\(CLIENT_PORTAL_COOKIE\)\) \{\n    return NextResponse\.next\(\);/);
});

test("a portal's token never reaches the browser — it alone opens that client's live portal (21 Oct review)", () => {
  const page = read("src/app/crm-preview/page.tsx");
  const props = page.slice(page.indexOf("<CrmPreview"));
  assert.doesNotMatch(props, /portal_token|token:/, "no token passed to the page's components");
  for (const f of PREVIEW_FILES.filter((f) => f.startsWith("src/components/"))) {
    assert.doesNotMatch(read(f), /portal_token|\btoken\b|master-inbox\/portal\//, f);
  }
});

test("the Follow Up Boss key never reaches the browser — only whether one is set", () => {
  const page = read("src/app/crm-preview/page.tsx");
  assert.doesNotMatch(page, /fubApiKey=|fub_api_key=\{/, "no key passed as a prop");
  for (const f of PREVIEW_FILES.filter((f) => f.startsWith("src/components/"))) {
    assert.doesNotMatch(read(f), /fub_api_key/, f);
  }
});

test("an account that holds access by name (Eddy, Amy, the Billing people) cannot be taken over by an ordinary admin (21 Oct review)", () => {
  const src = read("src/app/api/admin/users/route.ts");
  assert.match(src, /const NAMED = new Set\(\[\.\.\.PREVIEW_REVIEWERS, \.\.\.BILLING_TAB_PEOPLE, \.\.\.Object\.values\(NAMED_PAGES\)\.flat\(\)\]/, "every by-name list, the pages' too (22 Oct)");
  assert.match(src, /NAMED\.has\(target\.trim\(\)\.toLowerCase\(\)\) && !isAdmin\(actor\) && !NAMED\.has\(actor/);
  // reset password / deactivate, change email (from and to), invite, delete
  assert.equal((src.match(/namedRefused\(/g) ?? []).length, 5, "reset/deactivate, email from + to, invite, delete");
  assert.match(src, /namedRefused\(email, session\.email\) \|\| namedRefused\(body\.newEmail as string, session\.email\)/);
  // Refused before anything else in the request is saved.
  assert.ok(src.indexOf("if (changingEmail) {") < src.indexOf("await setAdmin(email, body.admin)"), "the email check comes first");
});
