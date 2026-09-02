/*
 * bs-auth tests.
 *
 * This module is the security boundary for every app, so the tests are
 * adversarial first and happy-path second: forgery, tampering, expiry,
 * confused payloads, and the specific mistakes that would silently widen
 * access rather than break loudly.
 *
 *   node --test packages/bs-auth/index.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALL_TOOLS,
  hasGrant,
  mintSso,
  msUntilExpiry,
  readSsoCookie,
  safeEqual,
  shouldRefresh,
  ssoCookieOptions,
  SSO_COOKIE,
  SSO_TTL_MS,
  verifySso,
  verifySsoDetailed,
  type ToolId,
} from "./index.ts";

const SECRET = "test-secret-do-not-use-in-production";
const OTHER = "a-different-secret";
const NOW = 1_800_000_000_000;

const mint = (over: Partial<Parameters<typeof mintSso>[1]> = {}) =>
  mintSso(SECRET, { email: "sam@brokerstaffer.com", grants: ["inbox"], ver: 1, now: NOW, ...over });

// --- round trip --------------------------------------------------------------

test("round-trips a session", async () => {
  const token = await mint({ grants: ["inbox", "analytics"] });
  const session = await verifySso(SECRET, token, NOW);

  assert.ok(session);
  assert.equal(session.email, "sam@brokerstaffer.com");
  assert.deepEqual(session.grants, ["inbox", "analytics"]);
  assert.equal(session.ver, 1);
  assert.equal(session.iat, NOW);
  assert.equal(session.exp, NOW + SSO_TTL_MS);
});

test("lower-cases and trims the email on both mint and verify", async () => {
  const token = await mint({ email: "  SAM@BrokerStaffer.com " });
  const session = await verifySso(SECRET, token, NOW);
  assert.equal(session?.email, "sam@brokerstaffer.com");
});

// --- forgery -----------------------------------------------------------------

test("rejects a token signed with a different secret", async () => {
  const token = await mintSso(OTHER, {
    email: "attacker@evil.com", grants: [...ALL_TOOLS], ver: 1, now: NOW,
  });
  assert.equal(await verifySso(SECRET, token, NOW), null);
});

test("rejects a tampered payload — the classic privilege escalation", async () => {
  // Take a real token for a user with ONE grant, rewrite the payload to claim
  // all four, keep the original signature. This must fail.
  const token = await mint({ grants: ["clients"] });
  const [body, sig] = token.split(".");

  const decoded = JSON.parse(Buffer.from(body, "base64url").toString());
  decoded.grants = [...ALL_TOOLS];
  const forgedBody = Buffer.from(JSON.stringify(decoded)).toString("base64url");

  const result = await verifySsoDetailed(SECRET, `${forgedBody}.${sig}`, NOW);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "bad-signature");
});

test("rejects a signature truncated or padded", async () => {
  const token = await mint();
  const [body, sig] = token.split(".");
  assert.equal(await verifySso(SECRET, `${body}.${sig.slice(0, -1)}`, NOW), null);
  assert.equal(await verifySso(SECRET, `${body}.${sig}0`, NOW), null);
});

test("rejects structurally malformed tokens", async () => {
  for (const bad of ["", ".", "nodot", "a.", ".b", "..", "a.b.c.d"]) {
    const result = await verifySsoDetailed(SECRET, bad, NOW);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
  }
});

test("rejects a missing token and a missing secret", async () => {
  assert.equal(await verifySso(SECRET, undefined, NOW), null);
  assert.equal(await verifySso(SECRET, null, NOW), null);
  assert.equal(await verifySso("", await mint(), NOW), null);
});

// --- expiry ------------------------------------------------------------------

test("rejects an expired token, allowing 60s of clock skew", async () => {
  const token = await mint();
  const exp = NOW + SSO_TTL_MS;

  assert.ok(await verifySso(SECRET, token, exp - 1), "valid just before expiry");
  assert.ok(await verifySso(SECRET, token, exp + 30_000), "tolerates 30s skew");
  assert.equal(await verifySso(SECRET, token, exp + 61_000), null, "rejects past the skew window");
});

test("reports expiry distinctly from forgery", async () => {
  const token = await mint();
  const result = await verifySsoDetailed(SECRET, token, NOW + SSO_TTL_MS + 120_000);
  assert.equal(result.ok === false && result.reason, "expired");
});

// --- payload hardening -------------------------------------------------------

test("drops unknown tools rather than trusting them", async () => {
  // A signed token from a future issuer that knows about a tool we do not.
  const token = await mintSso(SECRET, {
    email: "sam@brokerstaffer.com",
    grants: ["inbox", "database" as ToolId, "billing" as ToolId],
    ver: 1, now: NOW,
  });
  const session = await verifySso(SECRET, token, NOW);
  assert.deepEqual(session?.grants, ["inbox"]);
});

test("normalises grant order and removes duplicates", async () => {
  const a = await mintSso(SECRET, {
    email: "s@x.com", grants: ["analytics", "inbox", "inbox"], ver: 1, now: NOW,
  });
  const b = await mintSso(SECRET, {
    email: "s@x.com", grants: ["inbox", "analytics"], ver: 1, now: NOW,
  });
  assert.equal(a, b, "same grant set must produce a byte-identical token");
});

test("rejects a signed payload that is not a session", async () => {
  // Correctly signed, but the payload is junk. Signature alone is not enough.
  const junk = Buffer.from(JSON.stringify({ hello: "world" })).toString("base64url");
  const { createHmac } = await import("node:crypto");
  const sig = createHmac("sha256", SECRET).update(junk).digest("hex");

  const result = await verifySsoDetailed(SECRET, `${junk}.${sig}`, NOW);
  assert.equal(result.ok === false && result.reason, "bad-payload");
});

test("an empty grant list authorises nothing", async () => {
  const token = await mint({ grants: [] });
  const session = await verifySso(SECRET, token, NOW);
  assert.ok(session, "the session itself is still valid");
  for (const tool of ALL_TOOLS) assert.equal(hasGrant(session, tool), false);
});

// --- authorisation -----------------------------------------------------------

test("hasGrant permits only what was granted", async () => {
  const session = await verifySso(SECRET, await mint({ grants: ["inbox", "search"] }), NOW);
  assert.equal(hasGrant(session, "inbox"), true);
  assert.equal(hasGrant(session, "search"), true);
  assert.equal(hasGrant(session, "analytics"), false);
  assert.equal(hasGrant(session, "clients"), false);
});

test("hasGrant is false for a null session", () => {
  for (const tool of ALL_TOOLS) assert.equal(hasGrant(null, tool), false);
});

// --- refresh scheduling ------------------------------------------------------

test("shouldRefresh flips at the halfway point, not at expiry", async () => {
  const session = await verifySso(SECRET, await mint(), NOW);
  assert.ok(session);
  const half = SSO_TTL_MS / 2;

  assert.equal(shouldRefresh(session, NOW + half - 1000), false);
  assert.equal(shouldRefresh(session, NOW + half + 1000), true);
  assert.equal(msUntilExpiry(session, NOW), SSO_TTL_MS);
});

// --- cookie ------------------------------------------------------------------

test("cookie stays SameSite=Lax — the shared-apex design depends on it", () => {
  const opts = ssoCookieOptions({ secure: true, domain: ".brokerstaffer.com" });
  assert.equal(opts.sameSite, "lax");
  assert.equal(opts.httpOnly, true);
  assert.equal(opts.secure, true);
  assert.equal(opts.domain, ".brokerstaffer.com");
  assert.equal(opts.maxAge, SSO_TTL_MS / 1000);
});

test("cookie omits domain when none is given, for localhost", () => {
  assert.equal("domain" in ssoCookieOptions({ secure: false }), false);
});

test("reads the cookie out of a raw header, ignoring lookalikes", () => {
  assert.equal(readSsoCookie(`${SSO_COOKIE}=abc`), "abc");
  assert.equal(readSsoCookie(`other=1; ${SSO_COOKIE}=abc; x=2`), "abc");
  assert.equal(readSsoCookie(`  ${SSO_COOKIE} = abc `), "abc");
  // A cookie whose name merely ends with ours must not match.
  assert.equal(readSsoCookie(`not_${SSO_COOKIE}=nope`), undefined);
  assert.equal(readSsoCookie("other=1"), undefined);
  assert.equal(readSsoCookie(undefined), undefined);
});

// --- primitives --------------------------------------------------------------

test("safeEqual is correct (constant-time behaviour is by construction)", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "ab"), false);
  assert.equal(safeEqual("", ""), true);
});
