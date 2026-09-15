import { test } from "node:test";
import assert from "node:assert/strict";
import { tickOnce, type TickDeps } from "./scheduler.ts";

const at = (iso: string) => new Date(iso);
const deps = (o: Partial<TickDeps> & { running?: boolean; last?: string | null; started?: boolean }): TickDeps => ({
  enabled: o.enabled ?? (() => true),
  health: o.health ?? (async () => ({ running: o.running ?? false, lastStartedAt: o.last ?? null })),
  trigger: o.trigger ?? (() => ({ started: o.started ?? true })),
});

test("disabled by env → never touches health or the trigger", async () => {
  let touched = false;
  const d = deps({ enabled: () => false, health: async () => { touched = true; return { running: false, lastStartedAt: null }; } });
  assert.equal(await tickOnce(at("2026-09-15T06:00:30Z"), d), "disabled");
  assert.equal(touched, false);
});

test("a run in flight → running, and nothing new is started", async () => {
  let fired = 0;
  const d = deps({ running: true, trigger: () => { fired++; return { started: true }; } });
  assert.equal(await tickOnce(at("2026-09-15T06:00:30Z"), d), "running");
  assert.equal(fired, 0);
});

test("same quarter-hour slot as the last run → not-due", async () => {
  assert.equal(await tickOnce(at("2026-09-15T06:07:00Z"), deps({ last: "2026-09-15T06:01:00Z" })), "not-due");
});

test("next slot → started (the *​/15 cadence)", async () => {
  assert.equal(await tickOnce(at("2026-09-15T06:15:05Z"), deps({ last: "2026-09-15T06:01:00Z" })), "started");
});

test("fresh install (no runs yet) → due immediately", async () => {
  assert.equal(await tickOnce(at("2026-09-15T06:07:00Z"), deps({ last: null })), "started");
});

test("lock refuses → refused (the browser tick beat us to it)", async () => {
  assert.equal(await tickOnce(at("2026-09-15T06:15:05Z"), deps({ last: "2026-09-15T06:01:00Z", started: false })), "refused");
});

test("health read fails → error, no run started", async () => {
  let fired = 0;
  const d = deps({ health: async () => { throw new Error("db down"); }, trigger: () => { fired++; return { started: true }; } });
  assert.equal(await tickOnce(at("2026-09-15T06:15:05Z"), d), "error");
  assert.equal(fired, 0);
});
