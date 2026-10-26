/*
 * Pay per lead uses a Stripe TEST key or nothing (the user, 26 Oct: "we do not
 * want to make this live for any of the client right now").
 *
 * A live-looking key is refused BEFORE any request is built: the injected
 * fetch is never called. And the feature never reaches for the OS's shared
 * key picker, which defaults to live.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { assertTestKey, isTestKey, usageBillingKeyState, usageBillingStripeKey, UsageBillingKeyError, USAGE_BILLING_KEY_ENV } from "./stripe-key.ts";
import { usageStripe } from "./stripe.ts";

const TEST = "sk_test_51FakeFakeFakeFake";
const LIVE = ["sk_live_51FakeFakeFakeFake", "rk_live_51FakeFakeFakeFake", "pk_test_51FakeFakeFakeFake", "pk_live_51FakeFakeFakeFake", "whsec_FakeFakeFakeFake", "sk_test_", " sk_test_51FakeFakeFakeFake", "sk_test_51Fake Fake", ""];

test("only sk_test_ / rk_test_ keys pass", () => {
  assert.equal(assertTestKey(TEST), TEST);
  assert.equal(assertTestKey("rk_test_51FakeFakeFakeFake"), "rk_test_51FakeFakeFakeFake");
  for (const k of LIVE) {
    assert.equal(isTestKey(k), false, k);
    assert.throws(() => assertTestKey(k), UsageBillingKeyError, k);
  }
  assert.throws(() => assertTestKey(undefined), (e: unknown) => e instanceof UsageBillingKeyError && e.reason === "missing");
  assert.throws(() => assertTestKey(null), UsageBillingKeyError);
  assert.throws(() => assertTestKey(42), UsageBillingKeyError);
});

test("the refusal never repeats the key", () => {
  try {
    assertTestKey("sk_live_51SecretSecretSecret");
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof UsageBillingKeyError);
    assert.equal(e.reason, "not_test");
    assert.doesNotMatch(e.message, /Secret/);
    assert.match(e.message, /TEST key/);
  }
});

test("the key comes from OS_USAGE_BILLING_STRIPE_KEY only — never the shared live/test keys", () => {
  assert.equal(USAGE_BILLING_KEY_ENV, "OS_USAGE_BILLING_STRIPE_KEY");
  const shared = { STRIPE_SECRET_KEY: "sk_live_51FakeFakeFakeFake", STRIPE_SECRET_KEY_TEST: TEST, ONBOARDING_STRIPE_SECRET_KEY_TEST: TEST, STRIPE_MODE: "test" };
  assert.throws(() => usageBillingStripeKey(shared), (e: unknown) => e instanceof UsageBillingKeyError && e.reason === "missing", "the shared test key is not borrowed either");
  assert.equal(usageBillingStripeKey({ ...shared, OS_USAGE_BILLING_STRIPE_KEY: TEST }), TEST);
  assert.throws(() => usageBillingStripeKey({ OS_USAGE_BILLING_STRIPE_KEY: "sk_live_51FakeFakeFakeFake" }), (e: unknown) => e instanceof UsageBillingKeyError && e.reason === "not_test");
  assert.equal(usageBillingKeyState({}), "missing");
  assert.equal(usageBillingKeyState({ OS_USAGE_BILLING_STRIPE_KEY: TEST }), "test");
  assert.equal(usageBillingKeyState({ OS_USAGE_BILLING_STRIPE_KEY: "sk_live_51FakeFakeFakeFake" }), "refused");
});

test("a live key is refused before any request is built: the injected fetch is never called", () => {
  let calls = 0;
  const f = (async () => { calls += 1; return new Response("{}"); }) as typeof fetch;
  for (const k of LIVE) assert.throws(() => usageStripe(k, f), UsageBillingKeyError, k);
  assert.equal(calls, 0);
});

test("a test key builds the client and every request carries it — and a LIVE answer is refused", async () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify({ id: "in_1", object: "invoice", livemode: true, status: "paid" }), { status: 200 });
  }) as typeof fetch;
  const stripe = usageStripe(TEST, f);
  await assert.rejects(stripe.getInvoice("in_1"), /LIVE mode/);
  assert.deepEqual(seen, [{ url: "https://api.stripe.com/v1/invoices/in_1", auth: `Bearer ${TEST}` }]);
});

test("nothing in pay per lead uses the OS's shared Stripe key picker (it defaults to live)", () => {
  const dirs = ["src/lib/clients/usage-billing", "src/app/api/workspace/clients/billing/usage"];
  for (const dir of dirs) {
    if (!fs.existsSync(path.join(process.cwd(), dir))) continue;
    for (const f of fs.readdirSync(path.join(process.cwd(), dir))) {
      if (!/\.tsx?$/.test(f) || f.endsWith(".test.ts")) continue;
      // The code, not the comments that explain why.
      const src = fs.readFileSync(path.join(process.cwd(), dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      assert.doesNotMatch(src, /tools\/onboarding\/stripe|pickStripeKey|\bstripeKey\(|STRIPE_SECRET_KEY|STRIPE_MODE/, `${dir}/${f}`);
    }
  }
});
