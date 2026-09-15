/*
 * The secret checks in front of the session-less endpoints.
 *
 * The one behaviour that matters most is the 503: an unset secret must refuse
 * everything, because these paths are opened in the proxy by name. The tool
 * accepted everything in that state; the port must never.
 *
 *   node --test src/lib/tools/master-inbox/webhooks/verify.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { suppliedToken, verifyBearer, verifySharedSecret } from "./verify.ts";
import {
  ADMIN_PATHS,
  CRON_PATHS,
  OS_PUBLIC_URL,
  PROXY_ALLOWLIST,
  WEBHOOK_PATHS,
  pointsAtReceiver,
  receiverUrl,
} from "./public-paths.ts";

const RECEIVER = `${OS_PUBLIC_URL}${WEBHOOK_PATHS.instantly}`;
const OPTS = { header: "x-webhook-token", varName: "MASTER_INBOX_INSTANTLY_WEBHOOK_SECRET" };

const post = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, { method: "POST", headers, body: "{}" });

test("an UNSET secret is a 503 that names the variable — never fail open", () => {
  for (const unset of [undefined, ""]) {
    const verdict = verifySharedSecret(post(`${RECEIVER}?token=anything`), unset, OPTS);
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.status, 503);
    assert.match(verdict.error, /MASTER_INBOX_INSTANTLY_WEBHOOK_SECRET/);
  }
});

test("the right token in ?token= passes", () => {
  assert.deepEqual(verifySharedSecret(post(`${RECEIVER}?token=s3cret`), "s3cret", OPTS), { ok: true });
});

test("the right token in the header passes, matching the tool's fallback", () => {
  assert.deepEqual(
    verifySharedSecret(post(RECEIVER, { "x-webhook-token": "s3cret" }), "s3cret", OPTS),
    { ok: true },
  );
});

test("?token= wins over the header, as it did in the tool", () => {
  // Precedence is what a registration relies on; flipping it would make a
  // stale header override the URL the provider was told to use.
  assert.equal(suppliedToken(post(`${RECEIVER}?token=a`, { "x-webhook-token": "b" }), "x-webhook-token"), "a");
});

test("a wrong or missing token is 401, not 503", () => {
  for (const req of [
    post(`${RECEIVER}?token=wrong`),
    post(RECEIVER),
    post(RECEIVER, { "x-webhook-token": "" }),
    post(`${RECEIVER}?token=s3cre`), // prefix of the secret
    post(`${RECEIVER}?token=s3cretx`), // secret plus a byte
  ]) {
    const verdict = verifySharedSecret(req, "s3cret", OPTS);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.status, 401);
  }
});

test("the URL-encoded form of the secret decodes to a match", () => {
  // receiverUrl() encodes the secret; the receiver must see it decoded.
  const secret = "a+b/c=d&e";
  const url = receiverUrl(OS_PUBLIC_URL, WEBHOOK_PATHS.emailbison, secret);
  assert.deepEqual(verifySharedSecret(post(url), secret, OPTS), { ok: true });
});

test("bearer: unset is 503, wrong is 401, right passes", () => {
  const cron = `${OS_PUBLIC_URL}${CRON_PATHS.syncExternalIntros}`;
  const varName = "MASTER_INBOX_CRON_SECRET";

  const unset = verifyBearer(post(cron, { authorization: "Bearer x" }), undefined, { varName });
  assert.equal(unset.ok, false);
  if (!unset.ok) {
    assert.equal(unset.status, 503);
    assert.match(unset.error, /MASTER_INBOX_CRON_SECRET/);
  }

  const wrong: Record<string, string>[] = [
    {},
    { authorization: "Bearer wrong" },
    { authorization: "cron-secret" }, // no scheme
    { authorization: "Basic cron-secret" },
  ];
  for (const headers of wrong) {
    const v = verifyBearer(post(cron, headers), "cron-secret", { varName });
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.status, 401);
  }

  assert.deepEqual(verifyBearer(post(cron, { authorization: "Bearer cron-secret" }), "cron-secret", { varName }), { ok: true });
  assert.deepEqual(verifyBearer(post(cron, { authorization: "bearer cron-secret" }), "cron-secret", { varName }), { ok: true });
});

test("bearer does NOT accept ?token= — the cron contract is the header only", () => {
  const v = verifyBearer(post(`${OS_PUBLIC_URL}${CRON_PATHS.syncExternalIntros}?token=cron-secret`), "cron-secret", {
    varName: "MASTER_INBOX_CRON_SECRET",
  });
  assert.equal(v.ok, false);
});

test("the public URLs are the ones the report promises", () => {
  assert.equal(`${OS_PUBLIC_URL}${WEBHOOK_PATHS.instantly}`, "https://os.brokerstaffer.com/api/tools/master-inbox/webhooks/instantly");
  assert.equal(`${OS_PUBLIC_URL}${WEBHOOK_PATHS.emailbison}`, "https://os.brokerstaffer.com/api/tools/master-inbox/webhooks/emailbison");
  assert.equal(`${OS_PUBLIC_URL}${WEBHOOK_PATHS.register}`, "https://os.brokerstaffer.com/api/tools/master-inbox/webhooks/register");
});

test("the proxy allowlist covers every session-less path, exactly, once", () => {
  const expected = [
    WEBHOOK_PATHS.instantly,
    WEBHOOK_PATHS.emailbison,
    WEBHOOK_PATHS.register,
    CRON_PATHS.syncExternalIntros,
    ADMIN_PATHS.instantlyRegisterWebhook,
  ];
  assert.deepEqual([...PROXY_ALLOWLIST].sort(), [...expected].sort());
  assert.equal(new Set(PROXY_ALLOWLIST).size, PROXY_ALLOWLIST.length);
  for (const p of PROXY_ALLOWLIST) {
    assert.ok(p.startsWith("/api/tools/master-inbox/"), `${p} is outside the tool prefix`);
    assert.ok(!p.endsWith("/"), `${p} must be an exact path`);
  }
});

test("a registered URL is recognised by its path, whatever secret it carries", () => {
  const withSecret = receiverUrl(OS_PUBLIC_URL, WEBHOOK_PATHS.instantly, "old-secret");
  assert.ok(pointsAtReceiver(withSecret, OS_PUBLIC_URL, WEBHOOK_PATHS.instantly));
  assert.ok(pointsAtReceiver(withSecret, `${OS_PUBLIC_URL}/`, WEBHOOK_PATHS.instantly), "trailing slash on base");
  // Not the other provider's receiver, and not the tool's old host.
  assert.ok(!pointsAtReceiver(withSecret, OS_PUBLIC_URL, WEBHOOK_PATHS.emailbison));
  assert.ok(!pointsAtReceiver("https://inbox.brokerstaffer.com/api/webhooks/instantly?token=x", OS_PUBLIC_URL, WEBHOOK_PATHS.instantly));
});
