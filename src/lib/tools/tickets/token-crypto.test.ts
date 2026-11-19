import { test } from "node:test";
import assert from "node:assert/strict";

import { openToken, sealToken } from "./token-crypto.ts";

const K = "k".repeat(40);

test("a sealed token opens with the same key, and never shows the token", () => {
  const s = sealToken("1//refresh-token-value", K);
  assert.match(s, /^v1\.[A-Za-z0-9_-]+$/);
  assert.ok(!s.includes("refresh-token-value"));
  assert.equal(openToken(s, K), "1//refresh-token-value");
});

test("every seal is different (fresh IV)", () => {
  assert.notEqual(sealToken("same", K), sealToken("same", K));
});

test("another key, a tampered byte, junk or nothing gives null, never a throw", () => {
  const s = sealToken("secret", K);
  assert.equal(openToken(s, "other".repeat(8)), null);
  const raw = Buffer.from(s.slice(3), "base64url");
  raw[raw.length - 1] ^= 1;
  assert.equal(openToken("v1." + raw.toString("base64url"), K), null);
  for (const junk of ["", "v1.", "v1.abc", "plain-token", null, undefined]) assert.equal(openToken(junk as string, K), null);
});

test("refuses to work without a real key", () => {
  assert.throws(() => sealToken("x", "short"), /no key/);
});
