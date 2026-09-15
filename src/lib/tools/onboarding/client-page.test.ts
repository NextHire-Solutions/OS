/*
 * The client detail screen's pure logic.
 *
 *   node --test src/lib/tools/onboarding/client-page.test.ts
 *
 * A separate file from onboarding.test.ts so the two can be edited without
 * colliding. Only modules with no server imports are tested here — a
 * `server-only` import throws under `node --test`, which is exactly why
 * `step-effects.ts` was split out of `step-run.ts` and `client-field-types.ts`
 * out of `client-fields.ts`.
 *
 * THE FIRST TEST IS THE IMPORTANT ONE. Every step in the catalogue must carry a
 * description of what firing it does. A step with no entry is rejected by the
 * route as unknown, which is safe — but a step ADDED to the catalogue later
 * with no entry would give the reader a button whose blast radius nobody wrote
 * down, and that is how this ends up sending three hundred emails by surprise.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { STEPS } from "./steps.ts";
import { RUNNABLE_KEYS, STEP_EFFECTS } from "./step-effects.ts";
import {
  FIELD_TYPES,
  formatFieldHref,
  isFieldType,
  mlsCodes,
  validateField,
} from "./client-field-types.ts";

/* ------------------------- the step catalogue ---------------------------- */

test("every one of the fourteen steps says what firing it would do", () => {
  const missing = STEPS.filter((s) => !STEP_EFFECTS[s.key]).map((s) => s.key);
  assert.deepEqual(
    missing,
    [],
    `A step with no entry in STEP_EFFECTS is a button whose blast radius nobody wrote down.\n` +
      `Add one to src/lib/tools/onboarding/step-effects.ts for: ${missing.join(", ")}`,
  );
});

test("each effect names a service, an outcome and the credential we lack", () => {
  for (const [key, e] of Object.entries(STEP_EFFECTS)) {
    assert.ok(e.target.length > 3, `${key}: no target service named`);
    assert.ok(e.effect.length > 20, `${key}: the effect is not described`);
    assert.ok(e.credential.length > 3, `${key}: no missing credential named`);
    assert.equal(typeof e.reversible, "boolean", `${key}: reversibility not stated`);
  }
});

test("the three off-catalogue actions are covered too", () => {
  // The Stripe send, the campaign pause and the "run everything" chain sit on
  // the same panel and reach just as far, so they go through the same route.
  for (const key of ["payment:link", "campaign:pause", "setup:remaining"]) {
    assert.ok(STEP_EFFECTS[key], `${key} must have an effect entry`);
    assert.ok(RUNNABLE_KEYS.includes(key), `${key} must be a runnable key`);
  }
});

test("only the pause is reversible — everything else is one-way", () => {
  const reversible = Object.entries(STEP_EFFECTS)
    .filter(([, e]) => e.reversible)
    .map(([k]) => k);
  assert.deepEqual(reversible, ["campaign:pause"]);
});

test("the launch step's description says it starts sending", () => {
  // If this ever softens, the reader loses the one warning that matters.
  const e = STEP_EFFECTS["campaign:launch"];
  assert.match(e.effect, /STARTS SENDING/);
  assert.match(e.effect, /no unsend/i);
  assert.equal(e.reversible, false);
});

test("the two rebuild steps admit that they DELETE first", () => {
  // build:team and build:leads both wipe the client's list before rebuilding.
  // A caption that only said "rebuilds" would be a lie by omission.
  assert.match(STEP_EFFECTS["build:team"].effect, /DELETES/);
  assert.match(STEP_EFFECTS["build:leads"].effect, /DELETES/);
});

test("no key can reach the runner without an entry", () => {
  assert.deepEqual([...RUNNABLE_KEYS].sort(), Object.keys(STEP_EFFECTS).sort());
});

/* ---------------------------- custom fields ------------------------------ */

test("an empty value always passes, whatever the type", () => {
  // A field can be added before its value is known — the tool's own rule.
  for (const t of FIELD_TYPES) {
    assert.equal(validateField(t, ""), null, t);
    assert.equal(validateField(t, "   "), null, t);
  }
});

test("the obvious typo is caught, per type", () => {
  assert.equal(validateField("email", "someone@example.com"), null);
  assert.ok(validateField("email", "someone-at-example"));
  assert.equal(validateField("url", "example.com/x"), null);
  assert.ok(validateField("url", "not a link"));
  assert.equal(validateField("number", "-12.5"), null);
  assert.ok(validateField("number", "twelve"));
  assert.equal(validateField("date", "2026-09-11"), null);
  assert.ok(validateField("date", "11/09/2026"));
  assert.equal(validateField("phone", "+1 (555) 010-9999"), null);
  assert.ok(validateField("phone", "call me"));
});

test("free text is never rejected", () => {
  assert.equal(validateField("text", "anything at all !@#"), null);
});

test("links, emails and phones become clickable; text does not", () => {
  assert.equal(formatFieldHref("url", "example.com"), "https://example.com");
  assert.equal(formatFieldHref("url", "https://example.com"), "https://example.com");
  assert.equal(formatFieldHref("email", "a@b.co"), "mailto:a@b.co");
  assert.equal(formatFieldHref("phone", "+1 (555) 010-9999"), "tel:+15550109999");
  assert.equal(formatFieldHref("text", "hello"), null);
  assert.equal(formatFieldHref("url", "  "), null);
});

test("a type off the wire is narrowed, not trusted", () => {
  assert.equal(isFieldType("email"), true);
  assert.equal(isFieldType("password"), false);
  assert.equal(isFieldType(""), false);
});

/* -------------------------------- the MLS -------------------------------- */

test("the MLS column splits into codes, trimmed and without blanks", () => {
  assert.deepEqual(mlsCodes("SOCAL, CRMLS"), ["SOCAL", "CRMLS"]);
  assert.deepEqual(mlsCodes("  SOCAL ,, CRMLS ,"), ["SOCAL", "CRMLS"]);
  assert.deepEqual(mlsCodes(null), []);
  assert.deepEqual(mlsCodes(""), []);
  assert.deepEqual(mlsCodes("SOCAL"), ["SOCAL"]);
});
