/*
 * Signing Claude in (15 Oct): the token rules and the OAuth steps, without a
 * server. The routes only wire these up.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { mintSso, verifySso } from "@/lib/bs-auth";

import { sha256B64url, signToken, verifyToken } from "./tokens.ts";
import {
  approve,
  authenticate,
  checkAuthorizeRequest,
  deny,
  exchange,
  isAllowedRedirect,
  pkceMatches,
  registerClient,
  resourceUrl,
  wwwAuthenticate,
  type UserCheck,
} from "./oauth.ts";

const SECRET = "test-secret-that-is-long-enough-for-hmac";
const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "a".repeat(20) + "B".repeat(20) + "-._~0123";

delete process.env.OS_PUBLIC_URL;
delete process.env.MCP_EXTRA_REDIRECT_URIS;
delete process.env.SSO_SESSIONS_NOT_BEFORE;

/** An admin at token version 3; anyone else is refused. */
let ver = 3;
const userCheck: UserCheck = async (email) =>
  email === "eddy@brokerstaffer.com" ? { ok: true, ver } : { ok: false, reason: "Only workspace admins can connect Claude." };

const form = (fields: Record<string, string>) => (name: string) => fields[name] ?? null;

async function clientId(uris = [CLAUDE]) {
  const r = await registerClient(SECRET, { redirect_uris: uris, client_name: "Claude" }, NOW);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return String(r.body.client_id);
}

/** The whole dance up to an access token, as Claude performs it. */
async function signIn(email = "eddy@brokerstaffer.com") {
  const cid = await clientId();
  const challenge = await sha256B64url(VERIFIER);
  const checked = await checkAuthorizeRequest(SECRET, form({
    response_type: "code", client_id: cid, redirect_uri: CLAUDE, code_challenge: challenge,
    code_challenge_method: "S256", state: "xyz", resource: resourceUrl(),
  }));
  assert.ok(checked.ok, JSON.stringify(checked));
  if (!checked.ok) throw new Error();
  const back = new URL(await approve(SECRET, checked.request, email, NOW));
  const tokens = await exchange(SECRET, form({
    grant_type: "authorization_code", code: back.searchParams.get("code")!, client_id: cid,
    redirect_uri: CLAUDE, code_verifier: VERIFIER,
  }), userCheck, NOW + 1000);
  return { cid, back, tokens };
}

/* ------------------------------------------------------------------ tokens --- */

test("a token is tied to its kind: an access token is not a refresh token, a code or a client id", async () => {
  const access = await signToken(SECRET, "access", { email: "e" }, NOW);
  assert.ok(await verifyToken(SECRET, "access", access, NOW));
  for (const other of ["refresh", "code", "client"] as const) {
    assert.equal(await verifyToken(SECRET, other, access, NOW), null, other);
  }
});

test("a connector token can never be used as an OS browser session, nor a session as a connector token", async () => {
  const access = await signToken(SECRET, "access", { email: "eddy@brokerstaffer.com", grants: ["inbox"], ver: 3, exp: NOW + 1e6 }, NOW);
  assert.equal(await verifySso(SECRET, access, NOW), null);
  const cookie = await mintSso(SECRET, { email: "eddy@brokerstaffer.com", grants: ["inbox"], ver: 3, now: NOW });
  assert.equal(await verifyToken(SECRET, "access", cookie, NOW), null);
});

test("tampered, expired, or signed with another secret: refused", async () => {
  const t = await signToken(SECRET, "access", { email: "eddy@brokerstaffer.com" }, NOW);
  const [body, sig] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ email: "someone@else.com", typ: "access", iat: NOW, exp: NOW + 1e9 })).toString("base64url");
  assert.equal(await verifyToken(SECRET, "access", `${forged}.${sig}`, NOW), null);
  assert.equal(await verifyToken(SECRET, "access", `${body}.${sig.slice(0, -2)}xx`, NOW), null);
  assert.equal(await verifyToken(SECRET, "access", t, NOW + 61 * 60 * 1000), null, "access lives an hour");
  assert.equal(await verifyToken("another-secret", "access", t, NOW), null);
  assert.equal(await verifyToken(SECRET, "access", "", NOW), null);
});

/* ----------------------------------------------------------- registration --- */

test("Claude's callbacks and loopback may register; any other address may not", async () => {
  assert.ok(isAllowedRedirect(CLAUDE));
  assert.ok(isAllowedRedirect("https://claude.com/api/mcp/auth_callback"));
  assert.ok(isAllowedRedirect("http://localhost:33418/callback"));
  assert.ok(isAllowedRedirect("http://127.0.0.1:6274/oauth/callback"));
  for (const bad of ["https://evil.example/cb", "https://claude.ai.evil.example/api/mcp/auth_callback", "https://claude.ai/other", "http://claude.ai/api/mcp/auth_callback", "https://localhost/cb", "javascript:alert(1)", "not a url"]) {
    assert.equal(isAllowedRedirect(bad), false, bad);
  }
  const r = await registerClient(SECRET, { redirect_uris: [CLAUDE, "https://evil.example/cb"] }, NOW);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "invalid_redirect_uri");
  assert.equal((await registerClient(SECRET, {}, NOW)).status, 400);
});

test("a registration issues a public client (PKCE, no secret) whose id carries its own redirect list", async () => {
  const r = await registerClient(SECRET, { redirect_uris: [CLAUDE], client_name: "Claude", token_endpoint_auth_method: "client_secret_post" }, NOW);
  assert.equal(r.status, 201);
  assert.equal(r.body.token_endpoint_auth_method, "none");
  assert.equal("client_secret" in r.body, false);
  assert.deepEqual(r.body.redirect_uris, [CLAUDE]);
});

/* ---------------------------------------------------------- authorization --- */

test("the full sign-in: register, authorize, exchange — an access token for the MCP endpoint and a refresh token", async () => {
  const { back, tokens } = await signIn();
  assert.equal(back.origin + back.pathname, CLAUDE);
  assert.equal(back.searchParams.get("state"), "xyz");
  assert.equal(back.searchParams.get("iss"), "https://os.brokerstaffer.com");
  assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
  assert.equal(tokens.body.token_type, "Bearer");
  assert.equal(tokens.body.expires_in, 3600);
  assert.equal(tokens.body.scope, "os.read");
  const auth = await authenticate(SECRET, `Bearer ${tokens.body.access_token}`, userCheck, NOW + 2000);
  assert.deepEqual(auth, { ok: true, email: "eddy@brokerstaffer.com" });
});

test("a bad client or redirect is SHOWN, never redirected; once both are good, errors go back to the client", async () => {
  const cid = await clientId();
  const ch = await sha256B64url(VERIFIER);
  const base = { response_type: "code", client_id: cid, redirect_uri: CLAUDE, code_challenge: ch, code_challenge_method: "S256" };

  const forged = await checkAuthorizeRequest(SECRET, form({ ...base, client_id: "made-up" }));
  assert.equal(forged.ok, false);
  assert.equal(!forged.ok && forged.redirect, null);

  const otherAddress = await checkAuthorizeRequest(SECRET, form({ ...base, redirect_uri: "http://localhost:9999/cb" }));
  assert.equal(!otherAddress.ok && otherAddress.redirect, null, "not one of the client's registered addresses");

  const plain = await checkAuthorizeRequest(SECRET, form({ ...base, code_challenge_method: "plain" }));
  assert.ok(!plain.ok && plain.redirect?.startsWith(CLAUDE) && plain.redirect.includes("error=invalid_request"));

  const noPkce = await checkAuthorizeRequest(SECRET, form({ ...base, code_challenge: "" }));
  assert.ok(!noPkce.ok && noPkce.redirect?.includes("error=invalid_request"));

  const elsewhere = await checkAuthorizeRequest(SECRET, form({ ...base, resource: "https://other.example/mcp" }));
  assert.ok(!elsewhere.ok && elsewhere.redirect?.includes("error=invalid_target"));
});

test("Cancel sends access_denied back with the state", async () => {
  const cid = await clientId();
  const checked = await checkAuthorizeRequest(SECRET, form({ response_type: "code", client_id: cid, redirect_uri: CLAUDE, code_challenge: await sha256B64url(VERIFIER), code_challenge_method: "S256", state: "s1" }));
  assert.ok(checked.ok);
  if (!checked.ok) return;
  const u = new URL(deny(checked.request));
  assert.equal(u.searchParams.get("error"), "access_denied");
  assert.equal(u.searchParams.get("state"), "s1");
  assert.equal(u.searchParams.get("code"), null);
});

/* ------------------------------------------------------------------ tokens --- */

test("a code is useless without the verifier, to another client, at another address, or after five minutes", async () => {
  const cid = await clientId();
  const checked = await checkAuthorizeRequest(SECRET, form({ response_type: "code", client_id: cid, redirect_uri: CLAUDE, code_challenge: await sha256B64url(VERIFIER), code_challenge_method: "S256" }));
  assert.ok(checked.ok);
  if (!checked.ok) return;
  const code = new URL(await approve(SECRET, checked.request, "eddy@brokerstaffer.com", NOW)).searchParams.get("code")!;
  const good = { grant_type: "authorization_code", code, client_id: cid, redirect_uri: CLAUDE, code_verifier: VERIFIER };
  const other = await clientId(["http://localhost:1234/cb"]);

  assert.equal((await exchange(SECRET, form({ ...good, code_verifier: "x".repeat(43) }), userCheck, NOW)).body.error, "invalid_grant");
  assert.equal((await exchange(SECRET, form({ ...good, client_id: other }), userCheck, NOW)).body.error, "invalid_grant");
  assert.equal((await exchange(SECRET, form({ ...good, client_id: "" }), userCheck, NOW)).body.error, "invalid_grant");
  assert.equal((await exchange(SECRET, form({ ...good, redirect_uri: "http://localhost:1/x" }), userCheck, NOW)).body.error, "invalid_grant");
  assert.equal((await exchange(SECRET, form(good), userCheck, NOW + 6 * 60 * 1000)).body.error, "invalid_grant");
  assert.equal((await exchange(SECRET, form({ ...good, grant_type: "password" }), userCheck, NOW)).body.error, "unsupported_grant_type");
  assert.equal((await exchange(SECRET, form(good), userCheck, NOW)).status, 200);
  assert.equal(await pkceMatches("short", await sha256B64url("short")), false, "a verifier must be 43–128 characters");
});

test("only someone who may connect gets a token — a non-admin is refused at the exchange", async () => {
  const { tokens } = await signIn("teammate@brokerstaffer.com");
  assert.equal(tokens.status, 400);
  assert.match(String(tokens.body.error_description), /admins/);
});

test("refresh: a new pair while the person may still connect; refused once their sign-in changed", async () => {
  const { cid, tokens } = await signIn();
  const refresh = String(tokens.body.refresh_token);
  const again = await exchange(SECRET, form({ grant_type: "refresh_token", refresh_token: refresh, client_id: cid }), userCheck, NOW + 10 * 24 * 3600 * 1000);
  assert.equal(again.status, 200);
  assert.ok(again.body.access_token && again.body.refresh_token);

  ver = 4; // a password change, or a sign-out everywhere
  try {
    const refused = await exchange(SECRET, form({ grant_type: "refresh_token", refresh_token: refresh }), userCheck, NOW + 1000);
    assert.equal(refused.body.error, "invalid_grant");
    const auth = await authenticate(SECRET, `Bearer ${tokens.body.access_token}`, userCheck, NOW + 1000);
    assert.equal(auth.ok, false, "and the access token stops working at once");
  } finally {
    ver = 3;
  }
  assert.equal((await exchange(SECRET, form({ grant_type: "refresh_token", refresh_token: refresh }), userCheck, NOW + 31 * 24 * 3600 * 1000)).body.error, "invalid_grant", "refresh lives 30 days");
});

test("every MCP request: no token, a refresh token, an expired token, a removed admin, or 'log everyone out' — refused", async () => {
  const { tokens } = await signIn();
  const access = String(tokens.body.access_token);
  assert.equal((await authenticate(SECRET, null, userCheck, NOW)).ok, false);
  assert.equal((await authenticate(SECRET, `Bearer ${tokens.body.refresh_token}`, userCheck, NOW)).ok, false);
  assert.equal((await authenticate(SECRET, `Bearer ${access}`, userCheck, NOW + 2 * 3600 * 1000)).ok, false);
  const otherAudience = await signToken(SECRET, "access", { email: "eddy@brokerstaffer.com", ver: 3, cid: "x", scope: "os.read", aud: "https://other.example/mcp" }, NOW);
  assert.equal((await authenticate(SECRET, `Bearer ${otherAudience}`, userCheck, NOW)).ok, false, "a token for another resource");
  const removed = await authenticate(SECRET, `Bearer ${access}`, async () => ({ ok: false, reason: "Only workspace admins can connect Claude." }), NOW);
  assert.deepEqual(removed.ok ? null : [removed.status, removed.error], [403, "insufficient_scope"]);

  process.env.SSO_SESSIONS_NOT_BEFORE = new Date(NOW + 5000).toISOString();
  try {
    assert.equal((await authenticate(SECRET, `Bearer ${access}`, userCheck, NOW + 6000)).ok, false);
    assert.equal((await exchange(SECRET, form({ grant_type: "refresh_token", refresh_token: String(tokens.body.refresh_token) }), userCheck, NOW + 6000)).body.error, "invalid_grant");
  } finally {
    delete process.env.SSO_SESSIONS_NOT_BEFORE;
  }
});

test("a 401 points Claude at the sign-in documents", () => {
  assert.equal(wwwAuthenticate(null), 'Bearer resource_metadata="https://os.brokerstaffer.com/.well-known/oauth-protected-resource/api/mcp"');
  assert.match(wwwAuthenticate("invalid_token", 'expired "now"'), /error="invalid_token", error_description="expired 'now'"/);
});
