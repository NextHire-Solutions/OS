/*
 * The Stripe facts behind "one billing date" must never hold a page up: past
 * the cap the answer is null (the record's own dates), and the read carries on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const canRun = await import("./billing-align-load.ts").then(() => true, () => false);
const skip = canRun ? false : "needs node --import ./scripts/alias-hooks.mjs";
const mod = canRun ? await import("./billing-align-load.ts") : null;

const sub = (clientId: string | null, nextCharge: string | null, stepDays: number | null = 14, state: "active" | "paused" = "active") =>
  ({ id: "sub", state, customerId: "cus", clientId, customerName: null, mrr: 0, amount: 0, every: "", stepDays, nextCharge, resumes: null });
const answer = (subs: ReturnType<typeof sub>[]) => ({ subscriptions: subs }) as never;
const after = <T,>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));

test("a quick answer: each client's subscriptions, the ones tied to nobody left out", { skip }, async () => {
  const out = await mod!.stripeFactsByClient(500, async () => answer([sub("a", "2026-10-23"), sub("a", null, 14, "paused"), sub(null, "2026-10-20"), sub("b", "2026-10-19", null)]));
  assert.deepEqual([...out!.keys()].sort(), ["a", "b"]);
  assert.deepEqual(out!.get("a"), [{ state: "active", stepDays: 14, nextCharge: "2026-10-23" }, { state: "paused", stepDays: 14, nextCharge: null }]);
  assert.deepEqual(out!.get("b"), [{ state: "active", stepDays: null, nextCharge: "2026-10-19" }]);
});

test("a slow Stripe: null at the cap, so the page uses the record's dates — and is not held up", { skip }, async () => {
  let finished = false;
  const t0 = Date.now();
  const out = await mod!.stripeFactsByClient(60, () => after(400, answer([sub("a", "2026-10-23")])).then((v) => { finished = true; return v; }));
  assert.equal(out, null);
  assert.ok(Date.now() - t0 < 300, `returned after ${Date.now() - t0}ms`);
  assert.equal(finished, false, "returned before Stripe answered");
  await after(450, null);
  assert.equal(finished, true, "the read carried on — it fills the shared cache for the next load");
});

test("Stripe failing: null, never a throw", { skip }, async () => {
  assert.equal(await mod!.stripeFactsByClient(500, async () => { throw new Error("Stripe 500"); }), null);
});
