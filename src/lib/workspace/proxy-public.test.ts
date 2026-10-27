/*
 * What anyone may reach without a session (22 Oct audit). Two holes were found:
 * the proxy skipped every address ending in an image extension (/portals/x.png
 * rendered the Client Portals admin page, every portal link in it, to anyone),
 * and the public sign-in paths were prefixes (/portal-signin/x rendered Home).
 * The page also trusted identity headers a caller could send. These tests pin
 * all three shut.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

process.env.AUTH_SECRET = "test-secret-for-the-proxy-public-tests";

const { mintSso } = await import("@/lib/bs-auth");
const { proxy, PUBLIC_PATHS, config, CLIENT_PORTAL_PATHS, CLIENT_PORTAL_COOKIE } = await import("@/proxy");
const { NextRequest } = await import("next/server");

async function ask(p: string, opts: { method?: string; cookie?: string; headers?: Record<string, string> } = {}) {
  const req = new NextRequest(new URL(p, "https://os.brokerstaffer.com"), { method: opts.method ?? "GET", headers: { ...(opts.headers ?? {}), ...(opts.cookie ? { cookie: opts.cookie } : {}) } });
  const res = await proxy(req);
  if (res.headers.get("x-middleware-next") === "1") return "open";
  if (res.status === 401) return "401";
  const loc = res.headers.get("location") ?? "";
  return loc.includes("/login") ? "to login" : `status ${res.status} ${loc}`;
}

/* Every page and route file under the public folders, as the address it serves. */
function routesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === "page.tsx" || e.name === "route.ts") out.push("/" + path.relative("src/app", path.dirname(full)).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return out;
}

test("the public list is exactly the real public pages and routes — both ways", () => {
  const real = ["src/app/login", "src/app/api/auth", "src/app/api/health", "src/app/portal-signin", "src/app/api/portal-signin"].flatMap(routesUnder).sort();
  assert.deepEqual([...PUBLIC_PATHS].sort(), real);
});

test("without a session: the public pages open; anything below or beside them does not", async () => {
  for (const p of PUBLIC_PATHS) assert.equal(await ask(p, { method: p.startsWith("/api/") && p !== "/api/health" ? "POST" : "GET" }), "open", p);
  for (const p of ["/portal-signin/x", "/portal-signin/check/x", "/login/x", "/loginx", "/portal-signinx"]) assert.equal(await ask(p), "to login", p);
  for (const p of ["/api/portal-signin/x", "/api/auth/x", "/api/healthx", "/api/health/x"]) assert.equal(await ask(p), "401", p);
});

test("an address ending in an image extension is checked like any other (it was skipped)", async () => {
  for (const p of ["/portals/x.png", "/inbox/all-email/x.png", "/clients/weekly/x.svg", "/x.jpg", "/portals/a.webp", "/icon.png/x", "/favicon.icox"]) {
    assert.equal(await ask(p), "to login", p);
  }
  for (const p of ["/api/tools/master-inbox/portals/x.png", "/api/tools/client-health/x.svg"]) assert.equal(await ask(p), "401", p);
  // A caller's own identity headers change nothing.
  assert.equal(await ask("/portals/x.png", { headers: { "x-bs-user": "admin@outreachify.io", "x-bs-grants": "inbox,portals,clients" } }), "to login");
});

test("the matcher runs the proxy on everything but Next's build files and the three real static files", () => {
  assert.deepEqual(config.matcher, ["/((?!_next/static/|_next/image$|favicon\\.ico$|icon\\.png$|brokerstaffer-logo\\.webp$).*)"]);
  // Those three are the only static files: a new one must be added to the matcher on purpose.
  assert.deepEqual(fs.readdirSync("public").sort(), ["brokerstaffer-logo.webp"]);
  assert.deepEqual(fs.readdirSync("src/app").filter((f) => /\.(ico|png|svg|jpg|jpeg|webp|gif)$/.test(f)).sort(), ["favicon.ico", "icon.png"]);
});

test("the staff page verifies the signed cookie itself, before it loads anything — never a header", () => {
  const page = fs.readFileSync("src/app/[[...slug]]/page.tsx", "utf8");
  const verify = page.indexOf("const session = await verifySso(");
  assert.ok(verify > 0, "the page verifies the cookie");
  assert.match(page.slice(verify, verify + 400), /if \(!session\) redirect\(`\/login\?next=/);
  assert.match(page, /const needed = grantsForRequest\(path, "GET"\);\n  if \(needed && !needed\.some\(\(g\) => tokenGrants\.includes\(g\)\)\) redirect\(/, "the switch check, again");
  for (const load of ["getAllSnapshots()", "getOverview()", "getPortals()", "getWeekly()", "getInbox(", "viewerRoles("]) assert.ok(page.indexOf(load) > verify, `${load} only after the check`);
  assert.match(page, /\["login", "portal-signin", "api", "\.well-known", "_next"\]\.includes\(s\[0\] \?\? ""\)\) notFound\(\)/);
  // Nothing anywhere reads identity from a request header any more.
  const offenders: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".test.ts")) {
        const code = fs.readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
        if (/["']x-bs-(user|grants|pre-split)["']/.test(code)) offenders.push(full);
      }
    }
  };
  walk("src");
  assert.deepEqual(offenders, []);
});

test("a signed-in teammate still gets in as before", async () => {
  const token = await mintSso(process.env.AUTH_SECRET!, { email: "teammate@brokerstaffer.com", grants: ["portals"] as never, ver: 1, ttlMs: 3600_000 });
  assert.equal(await ask("/portals", { cookie: `bs_sso=${token}` }), "open");
  assert.equal(await ask("/login", { cookie: `bs_sso=${token}` }), "status 307 https://os.brokerstaffer.com/");
  assert.equal(await ask("/inbox/all-email", { cookie: `bs_sso=${token}` }), "status 307 https://os.brokerstaffer.com/?denied=inbox");
});

test("a client's sign-in reaches the new portal's page and its seven routes — those exact paths, nothing else (27 Oct)", async () => {
  const { PORTAL_COOKIE } = await import("@/lib/portal-login/http");
  assert.equal(CLIENT_PORTAL_COOKIE, PORTAL_COOKIE, "the same cookie the sign-in sets");
  // Each is a real page or route.
  const real = new Set(["src/app/crm-preview", "src/app/api/crm-preview"].flatMap(routesUnder));
  for (const p of CLIENT_PORTAL_PATHS) assert.ok(real.has(p), `${p} is a real page or route`);
  assert.equal(CLIENT_PORTAL_PATHS.size, 8);
  const client = { cookie: `${CLIENT_PORTAL_COOKIE}=anything` };
  // Through to their own checks (lib/crm-preview/viewer.ts), which read the session against the list.
  for (const p of CLIENT_PORTAL_PATHS) assert.equal(await ask(p, { ...client, method: /chat|demo/.test(p) ? "POST" : "GET" }), "open", p);
  // Without it, exactly as before: the staff sign-in.
  assert.equal(await ask("/crm-preview"), "to login");
  for (const p of CLIENT_PORTAL_PATHS) if (p.startsWith("/api/")) assert.equal(await ask(p), "401", p);
  // The cookie opens nothing else: not below, not beside, not the staff app, not another route.
  for (const p of ["/crm-preview/x", "/crm-previewx", "/", "/clients", "/portals", "/inbox/all-email", "/billing"]) assert.equal(await ask(p, client), "to login", p);
  for (const p of ["/api/crm-preview/market/x", "/api/crm-preview/x", "/api/workspace/clients/billing/history", "/api/tools/master-inbox/portals/logins"]) assert.equal(await ask(p, client), "401", p);
});
