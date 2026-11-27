/*
 * inbox_introduce and inbox_reply (27 Nov) through runAction, with their real previews against a stand-in database; the
 * OS functions that send and label are recorded, not run. Proves: the whole email is previewed, exactly that is sent,
 * the label follows a sent introduction only, and every refusal.
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";

const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

const T = "11111111-1111-4111-8111-111111111111";
const calls: string[] = [];
const state = { label: "Interested" as string | null, introducedBefore: false, inbound: "m1", handoff: null as string | null, plan: "ok" as "ok" | "stop", sendOk: true, provider: "emailbison", leadName: "Ann Lee" };

function from(table: string) {
  const q: Record<string, unknown> = {};
  const b: Record<string, unknown> = {};
  for (const m of ["select", "order", "limit", "neq", "in", "ilike"]) b[m] = () => b;
  b.eq = (c: string, v: unknown) => { q[c] = v; return b; };
  const data = () => {
    switch (table) {
      case "threads": return { id: T, subject: "Re: Ann?", status: "open", last_message_at: "2026-11-25T00:00:00Z", source_provider: state.provider, outbound_sender_email: "william@buildbuyerlists.com", client_id: "c1", leads: { full_name: "Ann Lee", email: "ann@example.com" }, clients: { name: "Howe Realty Group" } };
      case "label_assignments": return state.label ? [{ labels: { name: state.label } }] : [];
      case "reminders": return [];
      case "label_history": return q.label_name === "Introduction" ? (state.introducedBefore ? [{ id: 1 }] : []) : [];
      case "messages": return [{ id: state.inbound }];
      case "labels": return { id: "L-intro" };
      default: return null;
    }
  };
  b.maybeSingle = async () => ({ data: data(), error: null });
  b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: data(), error: null }).then(res);
  return b;
}

let core: typeof import("./core.ts");
let intro: unknown, reply: unknown;
const EDDY = { email: "eddy@brokerstaffer.com", admin: true, grants: [] as string[] };

async function load() {
  if (intro) return;
  mock.module("server-only", { namedExports: {} });
  mock.module("@/lib/supabase/admin", { namedExports: { createAdminSupabase: () => ({ from }) } });
  mock.module("@/lib/tools/master-inbox/supabase", { namedExports: { getMasterInboxSupabase: () => ({ from }), workspaceId: async () => "ws1" } });
  mock.module("@/lib/tools/master-inbox/ai/runtime", {
    namedExports: {
      assembleRunInput: async () => ({ clientId: "c1", leadName: state.leadName, leadEmail: "ann@example.com", introduction: { client: { name: "Howe Realty Group" }, unavailableReason: null } }),
      handoverVariables: () => ({}),
    },
  });
  mock.module("@/lib/tools/master-inbox/ai/qualification", {
    namedExports: {
      planHandover: () => (state.plan === "ok"
        ? { kind: "introduce", body: "Hi Ann, meet Mike at Howe Realty Group.", cc: ["mike@howe.com"], source: "macro", subject: "Intro: Ann & Howe Realty Group" }
        : { kind: "stop", reason: "no_introduction_details", detail: "Howe Realty Group has no introduction details" }),
    },
  });
  mock.module("@/lib/tools/master-inbox/ai/send-transport", { namedExports: { agentBodyHtml: (b: string) => `<p>${b}</p>`, agentSubject: (s: string | null) => (s ? (/^re:/i.test(s) ? s : `Re: ${s}`) : undefined) } });
  mock.module("@/lib/tools/master-inbox/inbox/send-reply", {
    namedExports: {
      sendOutboundReply: async (i: Record<string, unknown>) => {
        calls.push(`send to=${JSON.stringify(i.to)} cc=${JSON.stringify(i.cc)} subject=${i.subject} changed=${i.subjectChanged} from=${i.senderChannelId ?? "-"} html=${JSON.stringify(i.body)}`);
        return state.sendOk ? { ok: true } : { ok: false, status: 502, body: { error: "provider said no" } };
      },
    },
  });
  mock.module("@/lib/tools/master-inbox/inbox/intro-sender", { namedExports: { introSenderFor: async () => ({ email: "nicole.c@brokerstaffer.com", channelId: "ch-nicole", name: "Nicole Collins", problem: null }) } });
  mock.module("@/lib/tools/master-inbox/inbox/apply-label", { namedExports: { applyLabelToThread: async (i: { labelId: string; actor: unknown }) => { calls.push(`label ${i.labelId} ${JSON.stringify(i.actor)}`); return { ok: true }; } } });
  // The REAL hand-off check (relay/settings.ts directHandoffReason) decides, from the client record it reads.
  mock.module("@/lib/tools/master-inbox/clients/roster-for-portal", { namedExports: { rosterRowForPortal: async () => ({ row: state.handoff ? { pipeline_entry: "interested", relay_settings: { enabled: true } } : { pipeline_entry: "introduction", relay_settings: {} } }) } });
  core = await import("./core.ts");
  const o = await import("./outreach.ts");
  intro = o.inboxIntroduce; reply = o.inboxReply;
}

function deps() {
  const claimed = new Set<string>(); let i = 0;
  return {
    sign: async (c: Record<string, unknown>) => Buffer.from(JSON.stringify(c)).toString("base64url"),
    verify: async (t: string) => JSON.parse(Buffer.from(t, "base64url").toString()) as Record<string, unknown>,
    audit: { used: async (n: string) => claimed.has(n), claim: async (r: { nonce: string }) => (claimed.has(r.nonce) ? false : (claimed.add(r.nonce), true)), finish: async () => {} },
    nonce: () => `n${++i}`,
  };
}
const run = (spec: unknown, args: Record<string, unknown>, d = deps()) => core.runAction(spec as never, args, EDDY, d as never);
const reset = () => { calls.length = 0; Object.assign(state, { label: "Interested", introducedBefore: false, inbound: "m1", handoff: null, plan: "ok", sendOk: true, provider: "emailbison", leadName: "Ann Lee" }); };

test("introduce: the preview is the whole email; confirm sends exactly it (from the intro mailbox, new subject), then labels Introduction", { skip }, async () => {
  await load(); reset();
  const d = deps();
  const p = await run(intro, { thread_id: T }, d);
  const text = String(p.preview);
  assert.match(text, /From: Nicole Collins <nicole\.c@brokerstaffer\.com>/);
  assert.match(text, /To: Ann Lee <ann@example\.com>/);
  assert.match(text, /Cc: mike@howe\.com, nicole\.c@brokerstaffer\.com/, "client's people, then the always-Cc");
  assert.match(text, /Subject: "Intro: Ann & Howe Realty Group"/);
  assert.match(text, /Hi Ann, meet Mike/);
  assert.match(text, /portal gets the lead/);
  assert.deepEqual(calls, [], "the preview sent nothing");
  const done = await run(intro, { thread_id: T, confirm: p.confirm }, d);
  assert.equal(done.done, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /send to=\[\{"email_address":"ann@example\.com","name":"Ann Lee"\}\] cc=\[\{"email_address":"mike@howe\.com"\},\{"email_address":"nicole\.c@brokerstaffer\.com"\}\] subject=Intro: Ann & Howe Realty Group changed=true from=ch-nicole/);
  assert.match(calls[1], /^label L-intro \{"kind":"user","userId":null\}/);
});

test("introduce refusals: stop label, already introduced, direct hand-off client, no introduction details", { skip }, async () => {
  await load();
  reset(); state.label = "Unsubscribe";
  assert.match(String((await run(intro, { thread_id: T })).refused), /not to be contacted/);
  reset(); state.introducedBefore = true;
  assert.match(String((await run(intro, { thread_id: T })).refused), /already been introduced/);
  reset(); state.handoff = "yes";
  assert.match(String((await run(intro, { thread_id: T })).refused), /gets interested replies directly by email, so there's no introduction to send/);
  reset(); state.plan = "stop";
  assert.match(String((await run(intro, { thread_id: T })).refused), /no introduction details/);
  assert.deepEqual(calls, []);
});

test("introduce: a refused send labels nothing and says nothing was sent", { skip }, async () => {
  await load(); reset(); state.sendOk = false;
  const d = deps();
  const p = await run(intro, { thread_id: T }, d);
  const r = await run(intro, { thread_id: T, confirm: p.confirm }, d);
  assert.equal(r.done, false);
  assert.match(String(r.failed), /Nothing was sent: provider said no/);
  assert.ok(!calls.some((c) => c.startsWith("label")), "never labelled after a failed send");
});

test("reply: preview shows From/To/Subject/text; confirm sends in the conversation (Re:, not a new subject)", { skip }, async () => {
  await load(); reset(); state.label = "Keep Warm";
  const d = deps();
  const p = await run(reply, { thread_id: T, text: "Thanks Ann — does Tuesday work?", cc: ["eddy@brokerstaffer.com"] }, d);
  assert.match(String(p.preview), /From: william@buildbuyerlists\.com\. To: ann@example\.com\. Cc: eddy@brokerstaffer\.com\. Subject: "Re: Ann\?"\. Text:\nThanks Ann/);
  const done = await run(reply, { thread_id: T, text: "Thanks Ann — does Tuesday work?", cc: ["eddy@brokerstaffer.com"], confirm: p.confirm }, d);
  assert.equal(done.done, true);
  assert.match(calls[0], /to=\[\{"email_address":"ann@example\.com"\}\] cc=\[\{"email_address":"eddy@brokerstaffer\.com"\}\] subject=Re: Ann\? changed=false/);
});

test("reply: a new message from the lead after the preview → nothing sent, fresh preview; stop label and bad Cc refused", { skip }, async () => {
  await load(); reset(); state.label = "Keep Warm";
  const d = deps();
  const p = await run(reply, { thread_id: T, text: "Sounds good" }, d);
  state.inbound = "m2";
  const r = await run(reply, { thread_id: T, text: "Sounds good", confirm: p.confirm }, d);
  assert.match(String(r.refused), /changed since the preview/);
  assert.deepEqual(calls, []);
  reset(); state.label = "Do Not Contact";
  assert.match(String((await run(reply, { thread_id: T, text: "hi" })).refused), /not to be contacted/);
  assert.match(String((await run(reply, { thread_id: T, text: "hi", cc: ["not-an-email"] })).refused), /Not email addresses/);
});

test("an Instantly conversation: neither introduced nor replied to through Claude; a lead with no name is not introduced (it would open \"Hey ,\")", { skip }, async () => {
  await load();
  reset(); state.provider = "instantly";
  assert.match(String((await run(intro, { thread_id: T })).refused), /came through Instantly, which BrokerStaffer no longer uses/);
  assert.match(String((await run(reply, { thread_id: T, text: "hi" })).refused), /came through Instantly/);
  reset(); state.leadName = "";
  assert.match(String((await run(intro, { thread_id: T })).refused), /no name on record, so the introduction would open "Hey ,"/);
  // A reply needs no name.
  assert.ok((await run(reply, { thread_id: T, text: "hi" })).preview);
  assert.deepEqual(calls, []);
});
