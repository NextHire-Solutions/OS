import { test } from "node:test";
import assert from "node:assert/strict";

import { openToken, sealToken } from "./token-crypto.ts";

const K = "k".repeat(40);
const EDDY = "eddy@brokerstaffer.com";

test("a sealed token opens with the same key and mailbox, and never shows the token", () => {
  const s = sealToken("1//refresh-token-value", EDDY, K);
  assert.match(s, /^v1\.[A-Za-z0-9_-]+$/);
  assert.ok(!s.includes("refresh-token-value"));
  assert.equal(openToken(s, EDDY, K), "1//refresh-token-value");
  assert.equal(openToken(s, "EDDY@BrokerStaffer.com ", K), "1//refresh-token-value", "the address is compared lower-case");
});

test("a token copied onto another mailbox's row opens nothing", () => {
  assert.equal(openToken(sealToken("tok", EDDY, K), "amy@brokerstaffer.com", K), null);
});

test("every seal is different (fresh IV)", () => {
  assert.notEqual(sealToken("same", EDDY, K), sealToken("same", EDDY, K));
});

test("another key, a tampered byte, junk or nothing gives null, never a throw", () => {
  const s = sealToken("secret", EDDY, K);
  assert.equal(openToken(s, EDDY, "other".repeat(8)), null);
  const raw = Buffer.from(s.slice(3), "base64url");
  raw[raw.length - 1] ^= 1;
  assert.equal(openToken("v1." + raw.toString("base64url"), EDDY, K), null);
  for (const junk of ["", "v1.", "v1.abc", "plain-token", null, undefined]) assert.equal(openToken(junk as string, EDDY, K), null);
});

test("refuses to work without its own key (32+ characters); the sign-in secret is never used", () => {
  const had = process.env.OS_TICKETS_TOKEN_KEY;
  delete process.env.OS_TICKETS_TOKEN_KEY;
  process.env.AUTH_SECRET = "a".repeat(64);
  try {
    assert.throws(() => sealToken("x", EDDY), /OS_TICKETS_TOKEN_KEY/);
    assert.throws(() => sealToken("x", EDDY, "short-key"), /OS_TICKETS_TOKEN_KEY/);
  } finally {
    if (had !== undefined) process.env.OS_TICKETS_TOKEN_KEY = had;
  }
});
