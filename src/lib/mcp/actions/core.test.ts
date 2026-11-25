import { test } from "node:test";
import assert from "node:assert/strict";

import { signToken, verifyToken } from "../tokens.ts";
import { canonical, mayUse, runAction, actionTool, type ActionDeps, type ActionSpec } from "./core.ts";

/*
 * Connector actions (25 Nov): preview → confirm → done once, and every way a confirmation can be wrong.
 */

const SECRET = "test-secret-0123456789";
const EDDY = { email: "eddy@brokerstaffer.com", admin: true, grants: [] as string[] };
const GABE = { email: "gabe@example.com", admin: false, grants: ["inbox"] };
const NOBODY = { email: "x@example.com", admin: false, grants: ["analytics"] };

function harness(now = Date.now()) {
  const claimed = new Map<string, { status: string; result?: unknown; error?: string }>();
  const deps: ActionDeps = {
    sign: (c) => signToken(SECRET, "action", c, now),
    verify: (t) => verifyToken(SECRET, "action", t, now),
    audit: {
      async used(n) { return claimed.has(n); },
      async claim(row) { if (claimed.has(row.nonce)) return false; claimed.set(row.nonce, { status: "running" }); return true; },
      async finish(n, o) { claimed.set(n, { status: o.ok ? "done" : "failed", result: o.result, error: o.error }); },
    },
    nonce: (() => { let i = 0; return () => `n${++i}`; })(),
  };
  return { deps, claimed };
}

function spec(state: { label: string; runs: number; fail?: boolean }): ActionSpec<{ thread_id: string; label: string }, { current: string }> {
  return {
    name: "inbox_set_label", title: "t", description: "d",
    inputSchema: { type: "object", properties: { thread_id: { type: "string" }, label: { type: "string" } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    needs: ["inbox"],
    parse: (a) => (a.thread_id ? { thread_id: String(a.thread_id), label: String(a.label) } : { error: "thread_id needed" }),
    async preview(a) { return a.label === "Interested" ? { ok: false, refusal: "not here" } : { ok: true, preview: `${state.label} → ${a.label}`, bind: { current: state.label } }; },
    async execute(a) { if (state.fail) throw new Error("boom"); state.runs++; state.label = a.label; return { label: a.label }; },
  } as ActionSpec<{ thread_id: string; label: string }, { current: string }>;
}

test("a preview changes nothing and gives a code; the code does it once", async () => {
  const { deps, claimed } = harness();
  const st = { label: "OOO", runs: 0 };
  const s = spec(st) as unknown as ActionSpec;
  const p = await runAction(s, { thread_id: "t1", label: "Keep Warm" }, EDDY, deps);
  assert.equal(p.done, false);
  assert.equal(p.preview, "OOO → Keep Warm");
  assert.equal(st.runs, 0, "nothing changed");
  const code = String(p.confirm);
  const d = await runAction(s, { thread_id: "t1", label: "Keep Warm", confirm: code }, EDDY, deps);
  assert.equal(d.done, true);
  assert.equal(st.runs, 1);
  assert.deepEqual([...claimed.values()].map((r) => r.status), ["done"]);
  // The same code again — the label is now Keep Warm, so the preview differs too: still "already used", not "changed".
  const again = await runAction(s, { thread_id: "t1", label: "Keep Warm", confirm: code }, EDDY, deps);
  assert.equal(again.done, false);
  assert.match(String(again.refused), /already used/);
  assert.equal(st.runs, 1);
});

test("a code is refused for other arguments, another person, or another action", async () => {
  const { deps } = harness();
  const st = { label: "OOO", runs: 0 };
  const s = spec(st) as unknown as ActionSpec;
  const code = String((await runAction(s, { thread_id: "t1", label: "Keep Warm" }, EDDY, deps)).confirm);
  for (const [args, who] of [
    [{ thread_id: "t1", label: "Not Interested", confirm: code }, EDDY],
    [{ thread_id: "t2", label: "Keep Warm", confirm: code }, EDDY],
    [{ thread_id: "t1", label: "Keep Warm", confirm: code }, GABE],
  ] as const) {
    const r = await runAction(s, args as Record<string, unknown>, who, deps);
    assert.equal(r.done, false);
    assert.match(String(r.refused), /isn't valid/);
  }
  const other = { ...(spec(st) as unknown as ActionSpec), name: "inbox_snooze" };
  assert.match(String((await runAction(other, { thread_id: "t1", label: "Keep Warm", confirm: code }, EDDY, deps)).refused), /isn't valid/);
  assert.match(String((await runAction(s, { thread_id: "t1", label: "Keep Warm", confirm: "forged.code" }, EDDY, deps)).refused), /isn't valid/);
  assert.equal(st.runs, 0);
});

test("an expired code is refused", async () => {
  const st = { label: "OOO", runs: 0 };
  const s = spec(st) as unknown as ActionSpec;
  const t0 = Date.now();
  const code = String((await runAction(s, { thread_id: "t1", label: "Keep Warm" }, EDDY, harness(t0).deps)).confirm);
  const late = await runAction(s, { thread_id: "t1", label: "Keep Warm", confirm: code }, EDDY, harness(t0 + 11 * 60_000).deps);
  assert.match(String(late.refused), /isn't valid/);
  assert.equal(st.runs, 0);
});

test("if things changed since the preview, nothing is done and a new preview + code come back", async () => {
  const { deps } = harness();
  const st = { label: "OOO", runs: 0 };
  const s = spec(st) as unknown as ActionSpec;
  const code = String((await runAction(s, { thread_id: "t1", label: "Keep Warm" }, EDDY, deps)).confirm);
  st.label = "Not Right Now"; // a teammate relabelled it meanwhile
  const r = await runAction(s, { thread_id: "t1", label: "Keep Warm", confirm: code }, EDDY, deps);
  assert.equal(r.done, false);
  assert.match(String(r.refused), /changed since the preview/);
  assert.equal(r.preview, "Not Right Now → Keep Warm");
  assert.ok(r.confirm && r.confirm !== code);
  assert.equal(st.runs, 0);
});

test("a refused preview never gives a code; bad arguments are refused", async () => {
  const { deps } = harness();
  const s = spec({ label: "OOO", runs: 0 }) as unknown as ActionSpec;
  const r = await runAction(s, { thread_id: "t1", label: "Interested" }, EDDY, deps);
  assert.deepEqual([r.done, r.refused, r.confirm], [false, "not here", undefined]);
  assert.equal((await runAction(s, { label: "x" }, EDDY, deps)).refused, "thread_id needed");
});

test("a failure is recorded and said; it is not retried", async () => {
  const { deps, claimed } = harness();
  const st = { label: "OOO", runs: 0, fail: true };
  const s = spec(st) as unknown as ActionSpec;
  const code = String((await runAction(s, { thread_id: "t1", label: "Keep Warm" }, EDDY, deps)).confirm);
  const r = await runAction(s, { thread_id: "t1", label: "Keep Warm", confirm: code }, EDDY, deps);
  assert.deepEqual([r.done, r.failed], [false, "boom"]);
  assert.deepEqual([...claimed.values()].map((x) => [x.status, x.error]), [["failed", "boom"]]);
});

test("who may: admins always; others only with the screen's switch", async () => {
  const s = spec({ label: "OOO", runs: 0 }) as unknown as ActionSpec;
  assert.equal(mayUse(s, EDDY), true);
  assert.equal(mayUse(s, GABE), true);
  assert.equal(mayUse(s, NOBODY), false);
  const r = await runAction(s, { thread_id: "t1", label: "Keep Warm" }, NOBODY, harness().deps);
  assert.match(String(r.refused), /isn't switched on for you/);
});

test("arguments match whatever the key order; the tool Claude sees has `confirm` and a non-read-only annotation", () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 3, c: 4 }] }), canonical({ a: [2, { c: 4, d: 3 }], b: 1 }));
  const t = actionTool(spec({ label: "OOO", runs: 0 }) as unknown as ActionSpec);
  assert.ok("confirm" in (t.inputSchema.properties as Record<string, unknown>));
  assert.equal(t.annotations.readOnlyHint, false);
  assert.match(t.description, /preview/);
});
