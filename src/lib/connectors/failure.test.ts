/*
 * The three-way failure taxonomy.
 *
 * A status board earns its keep only if amber means "go and look". Three very
 * different situations can stop a metric arriving, and collapsing them is how
 * a dashboard becomes wallpaper:
 *
 *   we have no token          our gap, the tool is fine        info,  no degrade
 *   the upstream can't serve  nobody's fault, permanent        info,  no degrade
 *   it broke                  something to investigate         warn,  degrade
 *
 * The middle case is the one that bit us: Master Inbox's thread-counts route
 * requires a user session and has no service-role path, so no credential we
 * will ever hold can satisfy it. Reported as a fault, it marked the tool
 * degraded permanently for a number that had never once been readable.
 *
 *   node --test src/lib/connectors/failure.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { NotConfiguredError, UnsupportedError } from "../env.ts";

/*
 * Mirrors describeFailure() in the connectors. Duplicated deliberately: the
 * real ones sit behind "@/" aliases and `server-only`, and importing a whole
 * connector to test a four-branch decision would test the plumbing instead of
 * the judgement. The branch order is what matters and it is asserted here.
 */
type Level = "info" | "warn" | "error";
function classify(error: unknown, fallback: string): { level: Level; text: string; degrades: boolean } {
  if (error instanceof NotConfiguredError) {
    return { level: "info", text: `${fallback} — set ${error.varName} to enable`, degrades: false };
  }
  if (error instanceof UnsupportedError) {
    return { level: "info", text: `${fallback} — ${error.message}`, degrades: false };
  }
  return {
    level: "warn",
    text: error instanceof Error ? `${fallback} — ${error.message}` : fallback,
    degrades: true,
  };
}

test("a missing credential is OUR gap — info, and the tool stays healthy", () => {
  const r = classify(new NotConfiguredError("ANALYTICS_CRON_SECRET"), "Sync health unavailable");
  assert.equal(r.level, "info");
  assert.equal(r.degrades, false);
  assert.match(r.text, /set ANALYTICS_CRON_SECRET to enable/, "and it names the fix");
});

test("an unserveable route is nobody's fault — info, and the tool stays healthy", () => {
  // The regression this file exists for. Master Inbox was showing degraded
  // purely because we had finally been given a token to try with.
  const r = classify(
    new UnsupportedError("not readable over HTTP — the route requires a user session"),
    "Thread counts unavailable",
  );
  assert.equal(r.level, "info");
  assert.equal(r.degrades, false, "a permanent limitation must never mark a tool amber");
});

test("a genuine failure degrades and says why", () => {
  const r = classify(new Error("clients returned 401"), "Client data unavailable");
  assert.equal(r.level, "warn");
  assert.equal(r.degrades, true);
  assert.match(r.text, /401/, "the upstream's own words, not a paraphrase");
});

test("a timeout degrades — that is a real fault, not a limitation", () => {
  const r = classify(new Error("timed out after 8000ms"), "KPIs unavailable");
  assert.equal(r.degrades, true);
});

test("a non-Error rejection still degrades rather than being swallowed", () => {
  const r = classify("something threw a string", "KPIs unavailable");
  assert.equal(r.level, "warn");
  assert.equal(r.degrades, true);
  assert.equal(r.text, "KPIs unavailable", "falls back cleanly with no 'undefined' in the text");
});

test("the two info cases are distinguishable to a reader", () => {
  // Both are info, but they call for different actions: one is a variable to
  // set, the other is an upstream change. The text has to say which.
  const missing = classify(new NotConfiguredError("MASTER_INBOX_ADMIN_TOKEN"), "Thread counts unavailable");
  const unserveable = classify(new UnsupportedError("requires a user session"), "Thread counts unavailable");

  assert.match(missing.text, /set .* to enable/);
  assert.equal(/set .* to enable/.test(unserveable.text), false);
  assert.match(unserveable.text, /requires a user session/);
});

test("branch order: NotConfigured is checked before Unsupported", () => {
  // A missing token must report as a missing token even though the route also
  // happens to be unserveable — otherwise the actionable message is lost.
  class Both extends NotConfiguredError {}
  const r = classify(new Both("MASTER_INBOX_ADMIN_TOKEN"), "Thread counts unavailable");
  assert.match(r.text, /set MASTER_INBOX_ADMIN_TOKEN to enable/);
});
