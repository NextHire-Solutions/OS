/*
 * The bot check on the client sign-in (Cloudflare Turnstile, 22 Oct) — a fake
 * Cloudflare only; no request leaves.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { CHECK_REFUSED, SITEVERIFY, turnstileSiteKey, verifyTurnstile } from "./turnstile.ts";

const ON = { TURNSTILE_SITE_KEY: "site-key", TURNSTILE_SECRET_KEY: "secret-key" };
function cloudflare(answer: unknown, status = 200) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(typeof answer === "string" ? answer : JSON.stringify(answer), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

test("off until BOTH keys are set — then the page draws no widget and the routes check nothing", async () => {
  assert.equal(turnstileSiteKey({}), null);
  assert.equal(turnstileSiteKey({ TURNSTILE_SITE_KEY: "s" }), null, "a site key alone is not enough");
  assert.equal(turnstileSiteKey(ON), "site-key");
  const { f, calls } = cloudflare({ success: false });
  assert.deepEqual(await verifyTurnstile(undefined, null, "signin-request", { fetch: f, env: {} }), { ok: true, skipped: true });
  assert.equal(calls.length, 0);
});

test("on: no token, an odd one, or a refused one — refused; a passed one — through", async () => {
  const pass = cloudflare({ success: true, action: "signin-request" });
  for (const t of [undefined, "", 12, "x".repeat(2049)]) assert.deepEqual(await verifyTurnstile(t, null, "signin-request", { fetch: pass.f, env: ON }), { ok: false, reason: "missing" });
  assert.equal(pass.calls.length, 0, "nothing asked of Cloudflare without a token");
  assert.deepEqual(await verifyTurnstile("tok", "198.51.100.7", "signin-request", { fetch: pass.f, env: ON }), { ok: true });
  assert.equal(pass.calls[0].url, SITEVERIFY);
  assert.deepEqual(pass.calls[0].body, { secret: "secret-key", response: "tok", remoteip: "198.51.100.7" }, "the secret goes in the body, the caller's address with it");
  const no = cloudflare({ success: false, "error-codes": ["invalid-input-response"] });
  assert.deepEqual(await verifyTurnstile("tok", null, "signin-request", { fetch: no.f, env: ON }), { ok: false, reason: "failed" });
});

test("a token made for the other form is refused (Cloudflare's own test secret, whose action is always 'test', excepted)", async () => {
  const other = cloudflare({ success: true, action: "signin-request" });
  assert.deepEqual(await verifyTurnstile("tok", null, "signin-code", { fetch: other.f, env: ON }), { ok: false, reason: "failed" });
  const dummy = cloudflare({ success: true, action: "test" });
  assert.deepEqual(await verifyTurnstile("tok", null, "signin-code", { fetch: dummy.f, env: { TURNSTILE_SITE_KEY: "1x00000000000000000000AA", TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA" } }), { ok: true });
  assert.deepEqual(await verifyTurnstile("tok", null, "signin-code", { fetch: dummy.f, env: ON }), { ok: false, reason: "failed" }, "a real secret with action 'test' is refused");
});

test("Cloudflare unreachable, slow, or answering nonsense: refused (fail closed)", async () => {
  const down = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
  assert.deepEqual(await verifyTurnstile("tok", null, "signin-request", { fetch: down, env: ON }), { ok: false, reason: "unreachable" });
  assert.deepEqual(await verifyTurnstile("tok", null, "signin-request", { fetch: cloudflare("not json").f, env: ON }), { ok: false, reason: "unreachable" });
  assert.deepEqual(await verifyTurnstile("tok", null, "signin-request", { fetch: cloudflare({ success: true }, 500).f, env: ON }), { ok: false, reason: "unreachable" });
});

test("the routes check before they do anything, with one answer for every address; the secret is never in the code", () => {
  const req = fs.readFileSync("src/app/api/portal-signin/request/route.ts", "utf8");
  const check = req.indexOf('const human = await verifyTurnstile(body?.token, ip, "signin-request");');
  assert.ok(check > 0 && check < req.indexOf("after(async () => {"), "the request route checks before the work is queued");
  assert.match(req, /if \(!human\.ok\) return NextResponse\.json\(\{ error: CHECK_REFUSED \}, \{ status: 400, headers: NO_STORE \}\);/);
  const code = fs.readFileSync("src/app/api/portal-signin/code/route.ts", "utf8");
  assert.ok(code.indexOf('verifyTurnstile(body?.token, clientIp(request.headers), "signin-code")') < code.indexOf("signInWithCode("), "the code route checks before a code is looked at");
  assert.equal(CHECK_REFUSED, "Please complete the security check, then try again.");
  for (const f of ["src/lib/portal-login/turnstile.ts", "src/app/portal-signin/forms.tsx", "src/app/portal-signin/page.tsx"]) assert.doesNotMatch(fs.readFileSync(f, "utf8"), /0x4AAAAAAF/, `${f}: keys come from settings, never the code`);
});
