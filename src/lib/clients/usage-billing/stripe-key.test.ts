/*
 * Pay per lead's keys (26 Oct; live clients 31 Oct). A test client uses a
 * Stripe TEST key of its own or nothing; a live client uses the OS's key and
 * only when it is a LIVE key. A key of the wrong mode is refused BEFORE any
 * request is built: the injected fetch is never called. The OS's shared key
 * picker (which defaults to live) is read in one file only, live-key.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { assertKeyFor, assertLiveKey, assertTestKey, isLiveKey, isTestKey, usageBillingKeyState, usageBillingStripeKey, UsageBillingKeyError, USAGE_BILLING_KEY_ENV } from "./stripe-key.ts";
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

test("the OS's shared Stripe key (it defaults to live) is read in ONE pay-per-lead file — live-key.ts, through assertLiveKey", () => {
  const dirs = ["src/lib/clients/usage-billing", "src/app/api/workspace/clients/billing/usage"];
  let readers = 0;
  for (const dir of dirs) {
    if (!fs.existsSync(path.join(process.cwd(), dir))) continue;
    for (const f of fs.readdirSync(path.join(process.cwd(), dir))) {
      if (!/\.tsx?$/.test(f) || f.endsWith(".test.ts")) continue;
      // The code, not the comments that explain why.
      const src = fs.readFileSync(path.join(process.cwd(), dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (dir === "src/lib/clients/usage-billing" && f === "live-key.ts") {
        readers += 1;
        assert.match(src, /^import \{ stripeKey \} from "@\/lib\/tools\/onboarding\/stripe";$/m);
        assert.match(src, /return assertLiveKey\(key\);/, "only ever handed out as a LIVE key");
        assert.doesNotMatch(src, /pickStripeKey|STRIPE_SECRET_KEY|STRIPE_MODE|process\.env/);
        continue;
      }
      assert.doesNotMatch(src, /tools\/onboarding\/stripe|pickStripeKey|\bstripeKey\(|STRIPE_SECRET_KEY|STRIPE_MODE/, `${dir}/${f}`);
    }
  }
  assert.equal(readers, 1);
});

test("live keys: only sk_live_ / rk_live_ pass assertLiveKey; a test key is refused for a live client and a live key for a test client", () => {
  assert.equal(assertLiveKey("sk_live_51FakeFakeFakeFake"), "sk_live_51FakeFakeFakeFake");
  assert.equal(assertLiveKey("rk_live_51FakeFakeFakeFake"), "rk_live_51FakeFakeFakeFake");
  for (const k of [TEST, "rk_test_51FakeFakeFakeFake", "pk_live_51FakeFakeFakeFake", "sk_live_", " sk_live_51FakeFakeFakeFake", "whsec_x"]) {
    assert.equal(isLiveKey(k), false, k);
    assert.throws(() => assertLiveKey(k), (e: unknown) => e instanceof UsageBillingKeyError && e.reason === "not_live", k);
  }
  assert.throws(() => assertLiveKey(undefined), (e: unknown) => e instanceof UsageBillingKeyError && e.reason === "missing" && /no Stripe key/.test(e.message));
  assert.equal(assertKeyFor("test", TEST), TEST);
  assert.throws(() => assertKeyFor("test", "sk_live_51FakeFakeFakeFake"), UsageBillingKeyError);
  assert.throws(() => assertKeyFor("live", TEST), UsageBillingKeyError);
  try {
    assertLiveKey("sk_test_51SecretSecretSecret");
    assert.fail("should have thrown");
  } catch (e) {
    assert.doesNotMatch((e as Error).message, /Secret/, "never repeats the key");
  }
});

test("a LIVE client: a test key is refused before any request; a TEST answer is refused; the test-only calls never leave", async () => {
  let calls = 0;
  const none = (async () => { calls += 1; return new Response("{}"); }) as typeof fetch;
  for (const k of [TEST, "rk_test_51FakeFakeFakeFake", ""]) assert.throws(() => usageStripe(k, none, "live"), UsageBillingKeyError, k);
  assert.equal(calls, 0);
  const LIVE_KEY = "sk_live_51FakeFakeFakeFake";
  const seen: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(`${new Headers(init?.headers).get("authorization")} ${String(input)}`);
    return new Response(JSON.stringify({ id: "in_1", object: "invoice", livemode: false, status: "paid" }), { status: 200 });
  }) as typeof fetch;
  const live = usageStripe(LIVE_KEY, f, "live");
  assert.equal(live.mode, "live");
  await assert.rejects(live.getInvoice("in_1"), /TEST mode for a live client/);
  assert.deepEqual(seen, [`Bearer ${LIVE_KEY} https://api.stripe.com/v1/invoices/in_1`]);
  for (const call of [
    () => live.createCustomer({ osClientId: "c", name: "x", idempotencyKey: "k" }), () => live.deleteCustomer("cus_x"),
    () => live.setupCheckout({ customerId: "cus_x", osClientId: "c", successUrl: "https://a", cancelUrl: "https://b" }), () => live.readSetupSession("cs_x"),
    () => live.attachPaymentMethod("pm_x", "cus_x"), () => live.setDefaultPaymentMethod("cus_x", "pm_x"), () => live.testCustomersOf("c"),
  ]) await assert.rejects(call(), /test clients only/);
  assert.equal(seen.length, 1, "none of them reached Stripe");
});
