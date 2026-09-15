/*
 * The in-process scheduler's gate and its one-per-process guarantee.
 *
 * The due logic is tested in cron.test.ts; this checks the wiring around it:
 * that nothing starts unless MASTER_INBOX_CRON_ENABLED is exactly "1", and
 * that repeated calls — every webhook and every outbox sweep call it — never
 * stack a second ticker. Loads the module dynamically because it imports
 * through `@/` and `server-only`; skips under plain `node --test`.
 *
 *   node --import ./scripts/alias-hooks.mjs --test src/lib/tools/master-inbox/sync/scheduler.test.ts
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";

const KEY = Symbol.for("brokerstaffer-os.master-inbox.cron");
const state = () =>
  (globalThis as Record<symbol, unknown>)[KEY] as { timer: ReturnType<typeof setInterval> } | undefined;

async function load(): Promise<(() => "started" | "already-running" | "disabled") | null> {
  try {
    const m = await import("@/lib/tools/master-inbox/sync/scheduler");
    return m.ensureCronScheduler;
  } catch (err) {
    if ((err as { code?: string }).code === "ERR_MODULE_NOT_FOUND") return null;
    throw err;
  }
}

const ensureCronScheduler = await load();
const skip = ensureCronScheduler ? false : "needs the @/ alias hooks: node --import ./scripts/alias-hooks.mjs --test";

mock.method(console, "log", () => {});

test("unset, or anything but \"1\", starts nothing", { skip }, () => {
  for (const value of [undefined, "", "0", "true", "yes"]) {
    if (value === undefined) delete process.env.MASTER_INBOX_CRON_ENABLED;
    else process.env.MASTER_INBOX_CRON_ENABLED = value;
    assert.equal(ensureCronScheduler!(), "disabled", `${JSON.stringify(value)} started the scheduler`);
    assert.equal(state(), undefined);
  }
});

test("\"1\" starts exactly one ticker, however often it is asked", { skip }, () => {
  process.env.MASTER_INBOX_CRON_ENABLED = "1";
  assert.equal(ensureCronScheduler!(), "started");
  const first = state();
  assert.ok(first, "the ticker is kept on globalThis");
  assert.equal(ensureCronScheduler!(), "already-running");
  assert.equal(ensureCronScheduler!(), "already-running");
  assert.equal(state(), first, "a second call must not replace or stack the ticker");

  // Once running, flipping the flag off does not stop it — that is a restart's
  // job — but it must not start another either.
  delete process.env.MASTER_INBOX_CRON_ENABLED;
  assert.equal(ensureCronScheduler!(), "already-running");
  assert.equal(state(), first);

  clearInterval(first.timer);
  delete (globalThis as Record<symbol, unknown>)[KEY];
});
