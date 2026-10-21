/*
 * Client sign-in, around the logic (21 Oct): the email's gate, the public
 * paths, the routes' own checks, and the migration.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { mayEmail, sendSignInEmail, signInMessage, signInOpen, SIGNIN_FROM } from "./mail.ts";
import { clientIp, CODE_REFUSED, fromSignInPage } from "./http.ts";

const read = (p: string) => fs.readFileSync(p, "utf8");
const MAIL = { to: "angela@brokerage.test", link: "https://os.test/portal-signin/confirm?t=abc", code: "123456", minutes: 15 };

test("until sign-in is opened, the email can only go to our own test address — whatever a caller passes", async () => {
  assert.equal(signInOpen({}), false);
  assert.equal(signInOpen({ OS_CLIENT_SIGNIN: "true" }), false, "exactly 1");
  assert.equal(mayEmail("angela@brokerage.test", {}), false);
  assert.equal(mayEmail(" Admin@Outreachify.io ", {}), true);
  assert.equal(mayEmail("angela@brokerage.test", { OS_CLIENT_SIGNIN: "1" }), true);
  assert.equal(mayEmail("not an email", { OS_CLIENT_SIGNIN: "1" }), false);
  const calls: unknown[] = [];
  const f = (async (_u: unknown, init: RequestInit) => { calls.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ ErrorCode: 0, MessageID: "x" }), { status: 200 }); }) as unknown as typeof fetch;
  await assert.rejects(sendSignInEmail(MAIL, { fetch: f, env: { POSTMARK_SERVER_TOKEN: "t" } }), /not open/);
  assert.equal(calls.length, 0, "nothing reached Postmark");
  await sendSignInEmail({ ...MAIL, to: "admin@outreachify.io" }, { fetch: f, env: { POSTMARK_SERVER_TOKEN: "t" } });
  const sent = calls[0] as Record<string, unknown>;
  assert.equal(sent.To, "admin@outreachify.io");
  assert.equal(sent.From, `"BrokerStaffer" <${SIGNIN_FROM}>`);
  assert.equal(sent.MessageStream, "outbound");
  assert.equal(sent.TrackLinks, "None", "no tracking rewrites the link");
  await assert.rejects(sendSignInEmail({ ...MAIL, to: "admin@outreachify.io" }, { fetch: f, env: {} }), /POSTMARK_SERVER_TOKEN/);
});

test("the email: the link, the code, how long it works — and escaped", () => {
  const m = signInMessage({ ...MAIL, link: 'https://os.test/c?t=a"><script>' });
  assert.match(m.text, /https:\/\/os\.test\/c\?t=a"><script>/);
  assert.match(m.text, /123 456/);
  assert.match(m.text, /next 15 minutes/);
  assert.doesNotMatch(m.html, /<script>/);
  assert.match(m.html, /123 456/);
});

test("only the sign-in paths are public — exact paths, never the staff pages", () => {
  const proxy = read("src/proxy.ts");
  assert.match(proxy, /function isPublic\(pathname: string\): boolean \{\n  return PUBLIC_PATHS\.has\(pathname\);\n\}/, "exact paths only — nothing below them (22 Oct audit; proxy-public.test.ts)");
  for (const p of ["/portal-signin", "/portal-signin/check", "/portal-signin/confirm", "/portal-signin/done", "/api/portal-signin/request", "/api/portal-signin/code", "/api/portal-signin/confirm", "/api/portal-signin/signout"]) assert.ok(proxy.includes(`"${p}",`), p);
});

test("each public route checks for itself, and the request answers the same for every address", () => {
  const routes = ["request", "code", "confirm", "signout"].map((r) => [r, read(`src/app/api/portal-signin/${r}/route.ts`)] as const);
  for (const [name, src] of routes) {
    assert.match(src, /if \(!fromSignInPage\(request\.headers\)\) return/, `${name}: only the sign-in pages' own requests`);
    assert.deepEqual([...src.matchAll(/export (?:async )?function (\w+)/g)].map((x) => x[1]), ["POST"], name);
  }
  const req = routes[0][1];
  assert.match(req, /after\(async \(\) => \{/, "the work happens after the answer");
  assert.equal((req.match(/NextResponse\.json\(/g) ?? []).length, 2, "one refusal (not the page) and one answer for every address");
  assert.match(req, /if \(!mayEmail\(email\)\) return;/);
  for (const [name, src] of routes.slice(1, 3)) assert.match(src, /res\.cookies\.set\(sessionCookie\(r\.session\)\)/, name);
  const http = read("src/lib/portal-login/http.ts");
  assert.match(http, /httpOnly: true/);
  assert.match(http, /sameSite: "lax"/);
  assert.match(http, /export const PORTAL_COOKIE = "bs_portal";/, "never the staff cookie");
});

test("the staff list is behind the Client Portals switch, checked again in the route", () => {
  const src = read("src/app/api/tools/master-inbox/portals/logins/route.ts");
  assert.match(src, /s\.grants\.includes\("portals"\) \|\| \(await isAdminUser\(s\.email\)\)/);
  for (const m of ["GET", "POST", "DELETE"]) {
    const at = src.indexOf(`export async function ${m}`);
    assert.ok(at > 0, m);
    assert.match(src.slice(at, at + 200), /await who\(request\)/, `${m} checks who first`);
  }
});

test("migration 0037 only adds — three new tables, nothing existing changed", () => {
  const sql = read("migrations/0037_portal_logins.sql").replace(/--.*$/gm, "");
  assert.deepEqual([...sql.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+)/g)].map((x) => x[1]), ["os_portal_logins", "os_portal_login_tokens", "os_portal_sessions"]);
  // "ON DELETE CASCADE" is part of a new table's definition (a deleted portal takes its sign-in list with it), not a statement.
  assert.doesNotMatch(sql.replace(/ON DELETE CASCADE/g, ""), /\b(DROP|DELETE|UPDATE|TRUNCATE|RENAME)\b/i);
  for (const a of sql.matchAll(/ALTER TABLE\s+public\.(\w+)/gi)) assert.match(a[1], /^os_portal_/, "only its own tables");
  assert.match(sql, /BEGIN;[\s\S]*COMMIT;/);
});

test("22 Oct audit: one answer for every failed code; older Safari can sign in; the IP is the edge's own hop", () => {
  const code = read("src/app/api/portal-signin/code/route.ts");
  assert.match(code, /if \(!r\.ok\) return NextResponse\.json\(\{ error: CODE_REFUSED \}/);
  assert.doesNotMatch(code, /REASON\[/);
  assert.match(CODE_REFUSED, /didn't work/);
  const h = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null });
  const O = "https://os.brokerstaffer.com";
  assert.equal(fromSignInPage(h({ "sec-fetch-site": "same-origin", "content-type": "application/json" }), O), true);
  assert.equal(fromSignInPage(h({ "sec-fetch-site": "cross-site", "content-type": "application/json", origin: O }), O), false, "a browser that says cross-site is believed");
  assert.equal(fromSignInPage(h({ "content-type": "application/json", origin: O }), O), true, "no Sec-Fetch-Site: judged by Origin");
  assert.equal(fromSignInPage(h({ "content-type": "application/json", origin: "https://evil.test" }), O), false);
  assert.equal(fromSignInPage(h({ "content-type": "application/json" }), O), false, "neither: refused");
  assert.equal(fromSignInPage(h({ "sec-fetch-site": "same-origin", "content-type": "text/plain" }), O), false);
  assert.equal(clientIp(h({ "x-forwarded-for": "1.2.3.4, 198.51.100.7" })), "198.51.100.7", "what the caller wrote first is ignored");
  assert.equal(clientIp(h({ "x-forwarded-for": "198.51.100.7" })), "198.51.100.7");
  assert.equal(clientIp(h({})), null);
});

test("22 Oct audit: the staff list changes only from the OS's own page; only a missing table asks for the migration", () => {
  const src = read("src/app/api/tools/master-inbox/portals/logins/route.ts");
  for (const m of ["POST", "DELETE"]) {
    const at = src.indexOf(`export async function ${m}`);
    assert.match(src.slice(at, at + 300), /if \(!fromOwnPage\(request\)\) return NextResponse\.json\(\{ error: "Forbidden" \}, \{ status: 403 \}\);/, m);
  }
  assert.doesNotMatch(src, /\/os_portal_logins\|/, "the table's name in an error is not a missing table");
});
