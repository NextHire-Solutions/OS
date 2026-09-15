import { test } from "node:test";
import assert from "node:assert/strict";

import { planOnboarding, LEGS, DEFAULTS } from "./onboard-plan.ts";

/*
 * The plan is checked here because it cannot be checked by running it.
 *
 * The Master Inbox leg mints a live portal URL, so every mistake this file
 * catches is one that would otherwise be caught by a customer. The rules below
 * were read from each tool's own route handler; if a tool changes its
 * validation, this is where the disagreement should surface.
 */

/** Fetches one leg and fails clearly if the plan did not produce it. */
function leg(plan: ReturnType<typeof planOnboarding>, name: string) {
  const call = plan.calls.find((c) => c.leg === name);
  assert.ok(call, `plan is missing the ${name} leg`);
  return call;
}

const valid = {
  name: "Test Brokerage",
  plan: "production" as const,
  weeklyTarget: 3,
};

test("a minimal valid input produces three legs in the safe order", () => {
  const p = planOnboarding(valid);
  assert.equal(p.ok, true);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.calls.map((c) => c.leg), [...LEGS]);
});

test("Master Inbox runs LAST, because it is the only irreversible leg", () => {
  const p = planOnboarding(valid);
  assert.equal(p.calls.at(-1)?.leg, "master_inbox");
  const irreversible = p.calls.filter((c) => c.irreversible);
  assert.equal(irreversible.length, 1, "only one leg should be irreversible");
  assert.equal(irreversible[0].leg, "master_inbox");
});

test("the Onboarding tool is never written to", () => {
  const p = planOnboarding(valid);
  assert.equal(p.calls.some((c) => c.tool.toLowerCase().includes("onboarding")), false);
  assert.equal((LEGS as readonly string[]).includes("onboarding"), false);
});

test("Client Health gets /onboard, never the plain create route", () => {
  // The plain route skips validation AND campaign auto-linking; a client made
  // through it silently reports zero sends. The path is the workspace's own
  // port of the tool's /api/clients/onboard — the live tool is not called.
  const ch = leg(planOnboarding(valid), "client_health");
  assert.equal(ch?.path, "/api/tools/client-health/clients/onboard");
  assert.equal(ch?.path.endsWith("/onboard"), true);
});

test("no secret value ever appears in a plan", () => {
  const p = planOnboarding({ ...valid, introMacro: {
    brokerage: "B", clientFullName: "A B", clientFirstName: "A", clientRole: "Owner",
  } });
  const text = JSON.stringify(p);
  // Auth is described by the NAME of the variable, so a plan is safe to render
  // on screen and safe to store in os_client_onboarding.request.
  for (const c of p.calls) assert.match(c.auth, /[A-Z_]{6,}/);
  assert.equal(/eyJ|service_role|Bearer /.test(text), false);
});

test("name is required, and capped at Master Inbox's 80 rather than Analytics' 200", () => {
  assert.equal(planOnboarding({ ...valid, name: "  " }).ok, false);
  const long = planOnboarding({ ...valid, name: "x".repeat(81) });
  assert.equal(long.ok, false);
  assert.match(long.errors.join(" "), /80/);
  assert.equal(planOnboarding({ ...valid, name: "x".repeat(80) }).ok, true);
});

test("plan must be one Client Health accepts", () => {
  for (const plan of ["minimum", "production", "partner"] as const) {
    assert.equal(planOnboarding({ ...valid, plan }).ok, true, plan);
  }
  // @ts-expect-error deliberately invalid
  assert.equal(planOnboarding({ ...valid, plan: "enterprise" }).ok, false);
});

test("weekly target must be a whole number of 0 or more", () => {
  assert.equal(planOnboarding({ ...valid, weeklyTarget: 0 }).ok, true);
  assert.equal(planOnboarding({ ...valid, weeklyTarget: -1 }).ok, false);
  assert.equal(planOnboarding({ ...valid, weeklyTarget: 2.5 }).ok, false);
});

test('custom billing interval requires a day count', () => {
  assert.equal(planOnboarding({ ...valid, billingInterval: "custom" }).ok, false);
  assert.equal(
    planOnboarding({ ...valid, billingInterval: "custom", billingIntervalDays: 21 }).ok,
    true,
  );
  assert.equal(
    planOnboarding({ ...valid, billingInterval: "custom", billingIntervalDays: 0 }).ok,
    false,
  );
});

test("dates must be YYYY-MM-DD, because Client Health rejects anything else", () => {
  assert.equal(planOnboarding({ ...valid, startDate: "01/02/2026" }).ok, false);
  assert.equal(planOnboarding({ ...valid, startDate: "2026-02-01" }).ok, true);
});

test("a half-filled intro macro is an error, not a silent drop", () => {
  const p = planOnboarding({
    ...valid,
    introMacro: { brokerage: "B", clientFullName: "", clientFirstName: "A", clientRole: "" },
  });
  assert.equal(p.ok, false);
  assert.match(p.errors.join(" "), /clientFullName/);
  assert.match(p.errors.join(" "), /clientRole/);
});

test("omitting the intro macro warns rather than failing", () => {
  const p = planOnboarding(valid);
  assert.equal(p.ok, true);
  assert.match(p.warnings.join(" "), /Intro Macro/i);
  const mi = leg(p, "master_inbox");
  assert.equal("intro_macro" in mi.body, false);
});

test("aliases are trimmed, emptied out, and capped at 20", () => {
  const p = planOnboarding({ ...valid, aliases: ["  One  ", "", "   ", "Two"] });
  const mi = leg(p, "master_inbox");
  assert.deepEqual(mi.body.aliases, ["One", "Two"]);
  assert.equal(planOnboarding({ ...valid, aliases: Array(21).fill("a") }).ok, false);
});

test("defaults match the Onboarding tool's own connector fallbacks", () => {
  // lib/connectors/apps.ts uses plan "production" and weekly_target 3.
  assert.equal(DEFAULTS.plan, "production");
  assert.equal(DEFAULTS.weeklyTarget, 3);
  const ch = leg(planOnboarding(valid), "client_health");
  assert.equal(ch.body.billing_interval, "biweekly");
});

test("optional fields are omitted, not sent as null", () => {
  // Client Health coerces a present-but-null differently from an absent key in
  // places; sending only what was filled in keeps its defaults in charge.
  const ch = leg(planOnboarding(valid), "client_health");
  assert.equal("start_date" in ch.body, false);
  assert.equal("billing_anchor_date" in ch.body, false);
  assert.equal("billing_interval_days" in ch.body, false);
});

test("the slug matches the slugs Master Inbox actually stored", () => {
  /*
   * These are not derived from reading the rule — they were read back out of
   * Master Inbox's `clients` table on 2026-09-14. That matters because the slug
   * PREFIXES the portal token, so a slug computed even slightly differently
   * here would produce a different customer-facing URL than the tool would.
   *
   * `norvellandco` is the one that catches a plausible misreading: the rule
   * substitutes "&" → "and" with no spaces around it, so it does NOT become
   * "norvell-and-co". The stored slug settles it.
   */
  const stored: Array<[string, string]> = [
    ["Norvell&Co Real Estate", "norvellandco-real-estate"],
    ["RE/MAX Pacific", "re-max-pacific"],
    ["SERHANT. PA", "serhant-pa"],
    ["SERHANT. PA 15M+", "serhant-pa-15m"],
    ["SERHANT. NJ", "serhant-nj"],
  ];
  for (const [name, slug] of stored) {
    assert.equal(planOnboarding({ ...valid, name }).slug, slug, name);
  }
});

test("an invalid plan still returns every error, not just the first", () => {
  const p = planOnboarding({
    name: "", // @ts-expect-error deliberately invalid
    plan: "nope", weeklyTarget: -3,
  });
  assert.equal(p.ok, false);
  assert.ok(p.errors.length >= 3, `expected several errors, got ${p.errors.length}`);
});
