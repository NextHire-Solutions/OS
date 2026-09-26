import assert from "node:assert/strict";
import { test } from "node:test";

import { applyBillingAction, planBillingAction, type StripeCaller } from "./stripe-billing";

/*
 * The instruction was exact: pause, never cancel, so it can be reversed.
 *
 * The most important tests here are the two negative ones — that nothing this
 * module can be asked to do results in a cancellation, and that a subscription
 * Stripe has already ended is left alone. Everything else is a lookup table;
 * those two are the reason it is safe to let a status change touch money.
 */

const active = { status: "active", paused: false };
const paused = { status: "active", paused: true };

test("a paused client has collection paused", () => {
  const d = planBillingAction("paused", active);
  assert.equal(d.action, "pause");
  assert.match(d.reason, /never cancelled/);
});

test("a churned client has collection paused — not cancelled", () => {
  assert.equal(planBillingAction("churned", active).action, "pause");
});

test("an active client whose collection was paused is resumed", () => {
  const d = planBillingAction("active", paused);
  assert.equal(d.action, "resume");
});

test("nothing happens when the subscription is already in the right state", () => {
  assert.equal(planBillingAction("paused", paused).action, "none");
  assert.equal(planBillingAction("churned", paused).action, "none");
  assert.equal(planBillingAction("active", active).action, "none");
});

test("onboarding counts as 'should be collecting', same as active", () => {
  // The rule as given: "active/onboarding or added a new client -> active
  // subscription". In practice an onboarding client has no subscription yet,
  // so this is usually a no-op — but where one exists and is paused, it resumes.
  assert.equal(planBillingAction("onboarding", active).action, "none");
  assert.equal(planBillingAction("onboarding", paused).action, "resume");
  assert.equal(planBillingAction("onboarding", null).action, "none");
});

test("a client with no recorded subscription is a no-op, not an error", () => {
  const d = planBillingAction("churned", null);
  assert.equal(d.action, "none");
  assert.match(d.reason, /No subscription/);
});

test("an already-cancelled subscription is left alone in BOTH directions", () => {
  // Resuming is impossible and pausing is meaningless; attempting either turns
  // a perfectly good status change into a failure that reads like a bug.
  for (const lifecycle of ["active", "paused", "churned"] as const) {
    const d = planBillingAction(lifecycle, { status: "canceled", paused: false });
    assert.equal(d.action, "none", lifecycle);
    assert.match(d.reason, /canceled/);
  }
  assert.equal(planBillingAction("paused", { status: "incomplete_expired", paused: false }).action, "none");
});

test("pausing sends pause_collection, and voids rather than accruing a bill", () => {
  const calls: { path: string; body: unknown }[] = [];
  const call: StripeCaller = async (path, body) => { calls.push({ path, body }); return { ok: true }; };
  return applyBillingAction("sub_123", planBillingAction("churned", active), call).then(() => {
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/v1/subscriptions/sub_123");
    assert.deepEqual(calls[0].body, { "pause_collection[behavior]": "void" });
  });
});

test("resuming clears pause_collection", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const call: StripeCaller = async (path, body) => { calls.push({ path, body }); return { ok: true }; };
  await applyBillingAction("sub_9", planBillingAction("active", paused), call);
  assert.deepEqual(calls[0].body, { pause_collection: "" });
});

test("a no-op calls Stripe not at all", async () => {
  let n = 0;
  const call: StripeCaller = async () => { n += 1; return { ok: true }; };
  const r = await applyBillingAction("sub_1", planBillingAction("active", active), call);
  assert.equal(n, 0);
  assert.equal(r.changed, false);
  assert.equal(r.ok, true);
});

test("NOTHING this module sends can cancel a subscription", () => {
  // The guarantee, asserted rather than trusted: across every lifecycle and
  // every subscription state, the only paths and verbs used are the two that
  // set or clear pause_collection. No DELETE, no cancel_at, no cancel_at_period_end.
  const sent: { path: string; body: Record<string, string> | null }[] = [];
  const call: StripeCaller = async (path, body) => { sent.push({ path, body }); return { ok: true }; };
  const states = [active, paused, { status: "canceled", paused: false }, { status: "trialing", paused: false }];
  return (async () => {
    for (const lifecycle of ["onboarding", "active", "paused", "churned"] as const) {
      for (const st of states) {
        await applyBillingAction("sub_x", planBillingAction(lifecycle, st), call);
      }
    }
    for (const s of sent) {
      assert.match(s.path, /^\/v1\/subscriptions\/sub_x$/);
      const keys = Object.keys(s.body ?? {});
      assert.ok(
        keys.every((k) => k === "pause_collection" || k === "pause_collection[behavior]"),
        "unexpected field sent to Stripe: " + keys.join(","),
      );
      assert.ok(!JSON.stringify(s.body).includes("cancel"), "a cancel field reached Stripe");
    }
  })();
});

test("a Stripe failure is reported, not swallowed", async () => {
  const call: StripeCaller = async () => ({ ok: false, error: "No such subscription" });
  const r = await applyBillingAction("sub_bad", planBillingAction("churned", active), call);
  assert.equal(r.ok, false);
  assert.equal(r.error, "No such subscription");
});
