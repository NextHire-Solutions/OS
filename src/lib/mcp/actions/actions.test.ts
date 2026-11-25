/*
 * The three real connector actions (25 Nov), end to end through runAction with their real previews, against a stand-in
 * database; the OS functions they call (set-label, snooze, campaign toggle) are recorded, not run — they are the
 * screen's own, unchanged. Proves: what each preview says, what is refused, and exactly what is called on confirm.
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";

const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

const T1 = "11111111-1111-4111-8111-111111111111";
const T_INTRO = "22222222-2222-4222-8222-222222222222";
const T_WAS_INT = "33333333-3333-4333-8333-333333333333";
const calls: string[] = [];
const db: Record<string, (q: Record<string, unknown>) => unknown> = {
  threads: (q) => (q.id === T1 ? { id: T1, subject: "Re: Ann?", status: "open", last_message_at: "2026-11-22T03:11:37Z", leads: { full_name: "Ann Lee", email: "ann@example.com" }, clients: { name: "Howe Realty Group" } }
    : q.id === T_INTRO ? { id: T_INTRO, subject: "Re: Bo", status: "open", last_message_at: "2026-11-20T00:00:00Z", leads: { full_name: "Bo", email: "bo@example.com" }, clients: { name: "LIV Indy Realty" } }
    : q.id === T_WAS_INT ? { id: T_WAS_INT, subject: "Re: Cy", status: "open", last_message_at: "2026-11-21T00:00:00Z", leads: { full_name: "Cy", email: "cy@example.com" }, clients: { name: "Homebase Real Estate at eXp" } } : null),
  label_assignments: (q) => [{ labels: { name: q.target_id === T_INTRO ? "Introduction" : q.target_id === T_WAS_INT ? "Not Interested" : "OOO" } }],
  label_history: (q) => (q.thread_id === T_WAS_INT ? [{ label_name: "Interested" }] : []),
  reminders: () => [],
  labels: () => [{ id: "L-kw", name: "Keep Warm" }, { id: "L-ni", name: "Not Interested" }, { id: "L-int", name: "Interested" }, { id: "L-ooo", name: "OOO" }, { id: "L-unsub", name: "Unsubscribe" }, { id: "L-mb", name: "Meetings Booked" }],
};
function from(table: string) {
  const q: Record<string, unknown> = {};
  const b: Record<string, unknown> = {};
  for (const m of ["select", "order", "limit", "neq", "in"]) b[m] = () => b;
  b.eq = (c: string, v: unknown) => { q[c] = v; return b; };
  b.maybeSingle = async () => ({ data: db[table](q), error: null });
  b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: db[table](q), error: null }).then(res);
  return b;
}

let harness: typeof import("./core.ts");
let specs: { label: unknown; snooze: unknown; campaigns: unknown };
const EDDY = { email: "eddy@brokerstaffer.com", admin: true, grants: [] as string[] };

async function load() {
  if (specs) return;
  mock.module("server-only", { namedExports: {} });
  mock.module("@/lib/tools/master-inbox/supabase", { namedExports: { getMasterInboxSupabase: () => ({ from }), workspaceId: async () => "ws1" } });
  mock.module("@/lib/tools/master-inbox/inbox/set-label", { namedExports: { setThreadLabel: async (t: string, l: string) => { calls.push(`setThreadLabel ${t} ${l}`); return { ok: true }; } } });
  mock.module("@/lib/tools/master-inbox/inbox/snooze", {
    namedExports: {
      snoozeThread: async (t: string, at: string, note: string | null) => { calls.push(`snooze ${t} ${at} ${note}`); return { ok: true }; },
      unsnoozeThread: async (t: string) => { calls.push(`unsnooze ${t}`); return { ok: true }; },
    },
  });
  const plan = (action: string) => ({ clientId: "c-howe", clientName: "Howe Realty Group", action,
    willChange: [{ platform: "bison", id: "u1", int_id: 1, name: "Howe Phoenix", status: "active" }, { platform: "bison", id: "u2", int_id: 2, name: "Howe Mesa", status: "active" }],
    skipped: [{ campaign: { platform: "bison", id: "u3", int_id: 3, name: "Howe Old", status: "completed" }, reason: "not sending" }] });
  mock.module("@/lib/tools/client-health/campaign-toggle", {
    namedExports: {
      planToggle: async (_id: string, action: string) => plan(action),
      applyToggle: async (id: string, action: string, actor: string) => { calls.push(`applyToggle ${id} ${action} ${actor}`); const p = plan(action); return { plan: p, outcomes: p.willChange.map((c) => ({ campaign: c, ok: true })), heldPaused: 2, held: [] }; },
    },
  });
  mock.module("@/lib/tools/client-health/supabase", { namedExports: { getSupabase: () => ({ from: () => ({ select: () => ({ order: async () => ({ data: [{ id: "c-howe", name: "Howe Realty Group" }, { id: "c-liv", name: "LIV Indy Realty" }, { id: "c-de1", name: "Douglas Elliman NYC" }, { id: "c-de2", name: "Douglas Elliman Las Vegas" }], error: null }) }) }) }) } });
  mock.module("@/lib/tools/client-health/weekly", { namedExports: { getWeekly: { invalidate: () => calls.push("weekly invalidated") } } });
  harness = await import("./core.ts");
  const inbox = await import("./inbox.ts");
  const camp = await import("./campaigns.ts");
  specs = { label: inbox.inboxSetLabel, snooze: inbox.inboxSnooze, campaigns: camp.clientCampaigns };
}

function deps() {
  const claimed = new Set<string>();
  let i = 0;
  return {
    sign: async (c: Record<string, unknown>) => Buffer.from(JSON.stringify(c)).toString("base64url"),
    verify: async (t: string) => JSON.parse(Buffer.from(t, "base64url").toString()) as Record<string, unknown>,
    audit: { claim: async (r: { nonce: string }) => (claimed.has(r.nonce) ? false : (claimed.add(r.nonce), true)), finish: async () => {} },
    nonce: () => `n${++i}`,
  };
}
const run = async (spec: unknown, args: Record<string, unknown>, d = deps()) => harness.runAction(spec as never, args, EDDY, d as never);
async function confirmFlow(spec: unknown, args: Record<string, unknown>) {
  const d = deps();
  const p = await run(spec, args, d);
  assert.ok(p.confirm, `no code: ${JSON.stringify(p)}`);
  return { preview: String(p.preview), done: await run(spec, { ...args, confirm: p.confirm }, d) };
}

test("inbox_set_label: the preview names the conversation and the change; confirm calls the inbox's own setThreadLabel", { skip }, async () => {
  await load(); calls.length = 0;
  const { preview, done } = await confirmFlow(specs.label, { thread_id: T1, label: "keep warm" });
  assert.match(preview, /Ann Lee <ann@example.com> \(Howe Realty Group\), "Re: Ann\?".*label now: OOO → Keep Warm/);
  assert.equal(done.done, true);
  assert.deepEqual(calls, [`setThreadLabel ${T1} L-kw`]);
});

test("inbox_set_label: Not Interested says it clears EmailBison's flag", { skip }, async () => {
  await load();
  const p = await run(specs.label, { thread_id: T1, label: "Not Interested" });
  assert.match(String(p.preview), /EmailBison's Interested flag/);
});

test("inbox_set_label refuses: Interested, a stop label, an unknown label (listing the usable ones), an Introduction, a bad id", { skip }, async () => {
  await load(); calls.length = 0;
  assert.match(String((await run(specs.label, { thread_id: T1, label: "Interested" })).refused), /hand-off/);
  assert.match(String((await run(specs.label, { thread_id: T1, label: "Unsubscribe" })).refused), /every campaign/);
  const unknown = String((await run(specs.label, { thread_id: T1, label: "Maybe" })).refused);
  assert.match(unknown, /no label called "Maybe"/);
  assert.match(unknown, /Keep Warm/);
  assert.doesNotMatch(unknown, /Interested,|Unsubscribe/, "only usable labels are listed");
  assert.match(String((await run(specs.label, { thread_id: T_INTRO, label: "Keep Warm" })).refused), /portal entry/);
  assert.match(String((await run(specs.label, { thread_id: "nope", label: "Keep Warm" })).refused), /thread_id/);
  // Once Interested (here on a per-lead client, now corrected to Not Interested): relabelling would put it back on the bill.
  assert.match(String((await run(specs.label, { thread_id: T_WAS_INT, label: "Keep Warm" })).refused), /billed/);
  assert.match(String((await run(specs.label, { thread_id: T1, label: "Meetings Booked" })).refused), /hand-off/);
  assert.deepEqual(calls, [], "nothing was changed");
});

test("inbox_snooze: preview in Eastern time with the note; confirm snoozes; cancel needs a snoozed conversation", { skip }, async () => {
  await load(); calls.length = 0;
  const until = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const { preview, done } = await confirmFlow(specs.snooze, { thread_id: T1, until, note: "call back after the holiday" });
  assert.match(preview, /Snooze Ann Lee.*Eastern.*"call back after the holiday"/);
  assert.equal(done.done, true);
  assert.deepEqual(calls, [`snooze ${T1} ${until} call back after the holiday`]);
  assert.match(String((await run(specs.snooze, { thread_id: T1, until: "2020-01-01T00:00:00Z" })).refused), /future/);
  assert.match(String((await run(specs.snooze, { thread_id: T1, until: "next tuesday" })).refused), /time zone/);
  assert.match(String((await run(specs.snooze, { thread_id: T1, cancel: true })).refused), /isn't snoozed/);
});

test("client_campaigns: the preview lists what changes and what is skipped; confirm calls applyToggle as '<email> via Claude'", { skip }, async () => {
  await load(); calls.length = 0;
  const { preview, done } = await confirmFlow(specs.campaigns, { client: "howe realty", action: "pause" });
  assert.match(preview, /Pause 2 campaigns of Howe Realty Group: Howe Phoenix \(EmailBison, active\); Howe Mesa/);
  assert.match(preview, /Left as they are: Howe Old .*not sending/);
  assert.match(preview, /emails stop going out/);
  assert.equal(done.done, true);
  assert.deepEqual(calls, ["applyToggle c-howe pause eddy@brokerstaffer.com via Claude", "weekly invalidated"]);
  assert.match(String((await run(specs.campaigns, { client: "Douglas Elliman", action: "pause" })).refused), /matches several clients/);
  assert.match(String((await run(specs.campaigns, { client: "Nobody Realty", action: "pause" })).refused), /No client called/);
  assert.match(String((await run(specs.campaigns, { client: "Howe", action: "delete" })).refused), /pause or resume/);
});
