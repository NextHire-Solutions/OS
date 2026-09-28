import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { decideStripeLink, stripeIdErrors } from "./stripe-link.ts";

const CUS = "cus_UlUNr2ybmnecR2";
const OTHER = "cus_ZZZZZZZZZZZZZZ";
const SUB = "sub_1Tsb2dAbcdef";

describe("stripeIdErrors — format, before anything is read", () => {
  test("well-formed ids pass", () => {
    assert.deepEqual(stripeIdErrors(CUS, SUB), []);
  });

  test("blank means clear, and is fine", () => {
    assert.deepEqual(stripeIdErrors("", ""), []);
    assert.deepEqual(stripeIdErrors(null, undefined), []);
  });

  test("the two ids cannot be swapped", () => {
    // The easiest mistake to make when pasting two similar-looking strings.
    assert.equal(stripeIdErrors(SUB, null).length, 1);
    assert.equal(stripeIdErrors(null, CUS).length, 1);
  });

  test("a price or invoice id is refused", () => {
    assert.equal(stripeIdErrors(null, "price_1Abcdef").length, 1);
    assert.equal(stripeIdErrors("in_1Abcdef", null).length, 1);
  });

  test("surrounding whitespace is tolerated", () => {
    assert.deepEqual(stripeIdErrors(`  ${CUS}  `, ` ${SUB} `), []);
  });
});

describe("decideStripeLink — whether Stripe agrees", () => {
  test("clearing the subscription needs no Stripe call", () => {
    const d = decideStripeLink(CUS, null, null);
    assert.deepEqual(d, { ok: true, customer: CUS, subscription: null, filledCustomer: false });
  });

  test("a customer on its own needs no Stripe call — it cannot move money", () => {
    assert.equal(decideStripeLink(CUS, "", null).ok, true);
  });

  test("a matching pair is accepted", () => {
    const d = decideStripeLink(CUS, SUB, { found: true, customer: CUS });
    assert.deepEqual(d, { ok: true, customer: CUS, subscription: SUB, filledCustomer: false });
  });

  test("a subscription belonging to ANOTHER customer is refused, naming both", () => {
    // The dangerous case: saved, this client's churn would pause someone
    // else's billing.
    const d = decideStripeLink(CUS, SUB, { found: true, customer: OTHER });
    assert.equal(d.ok, false);
    assert.match((d as { error: string }).error, new RegExp(OTHER));
    assert.match((d as { error: string }).error, new RegExp(CUS));
  });

  test("a subscription Stripe does not know is refused", () => {
    const d = decideStripeLink(CUS, SUB, { found: false });
    assert.equal(d.ok, false);
    assert.match((d as { error: string }).error, /no subscription/);
  });

  test("a blank customer is filled in FROM Stripe, not guessed", () => {
    const d = decideStripeLink(null, SUB, { found: true, customer: CUS });
    assert.deepEqual(d, { ok: true, customer: CUS, subscription: SUB, filledCustomer: true });
  });

  test("an unreachable Stripe FAILS CLOSED — nothing unchecked is saved", () => {
    const d = decideStripeLink(CUS, SUB, { unreachable: true, reason: "HTTP 503" });
    assert.equal(d.ok, false);
    assert.match((d as { error: string }).error, /Nothing was saved/);
  });

  test("unreachable is distinguished from not-found", () => {
    // Collapsing them would tell someone their correct ID is wrong during an
    // outage — and they would go looking for a typo that is not there.
    const outage = decideStripeLink(CUS, SUB, { unreachable: true, reason: "timeout" });
    const missing = decideStripeLink(CUS, SUB, { found: false });
    assert.notEqual((outage as { error: string }).error, (missing as { error: string }).error);
  });

  test("a subscription with no lookup at all is refused rather than trusted", () => {
    assert.equal(decideStripeLink(CUS, SUB, null).ok, false);
  });
});
