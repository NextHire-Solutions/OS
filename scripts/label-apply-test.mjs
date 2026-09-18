/*
 * Applying a label through ONE guarded path — the route and the reply agent.
 *
 * The labels route's core is now `applyLabelToThread` (lib/.../inbox/
 * apply-label.ts), and the reply agent's live handover labels its own
 * introduction through it (ai/live.ts). Three things are worth proving with
 * real rows rather than asserting:
 *
 *   1. THE ROUTE STILL BEHAVES: 200, exactly one assignment, and a repeat call
 *      does NOT announce the introduction a second time.
 *   2. THE AGENT ACTOR: writes assigned_by='system' with no user, queues
 *      exactly one outbox job per kind, and honours the already-carries guard.
 *   3. THE POST-SEND HOOK (ai/live.ts): resolves the label and applies it; a
 *      workspace with no Introduction label is recorded on the thread state,
 *      not thrown.
 *
 * Announcements are observed through the outbox: `enqueueIntroduction` writes
 * one side_effect_outbox row per kind BEFORE running the notifiers, and the
 * unique index refuses a second row. So the rows are deleted between calls —
 * if a repeat call announced, they would come back.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT NEVER DOES
 *
 * Nothing real is labelled and nobody is told anything. Every thread here is a
 * throwaway with no client, no lead and no messages: the 0023 trigger opens no
 * pipeline entry for a client-less thread, and every notifier (n8n, Slack,
 * Follow Up Boss) loads pipeline entries by thread and returns when there are
 * none. No email, no model call. Every row this creates is deleted on every
 * exit path.
 *
 *   BASE=http://localhost:3215 node --import ./scripts/alias-hooks.mjs scripts/label-apply-test.mjs
 *
 * Without BASE the route section is skipped; the rest needs only .env.local.
 */
import fs from "node:fs";

const raw = fs.readFileSync(".env.local", "utf8");
for (const line of raw.split("\n")) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) {
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
const SB = process.env.MASTER_INBOX_SUPABASE_URL;
const SK = process.env.MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY;
const WS = process.env.MASTER_INBOX_WORKSPACE_ID;
const BASE = process.env.BASE || null;
if (!SB || !SK || !WS) {
  console.error("MASTER_INBOX_SUPABASE_URL / _SERVICE_ROLE_KEY / _WORKSPACE_ID missing from .env.local");
  process.exit(2);
}

const THROWAWAY = "ZZZ-throwaway-label-apply-test";
const FAKE_CHANNEL = "00000000-0000-4000-8000-00000000c0de";
const NO_SUCH_WORKSPACE = "00000000-0000-4000-8000-0000000000ff";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rest = async (path, init = {}) => {
  const res = await fetch(`${SB}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SK,
      Authorization: `Bearer ${SK}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, ok: res.ok, body };
};

let passed = 0, failed = 0, skipped = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  —  " + detail : ""}`);
  if (ok) passed++; else { failed++; fails.push(name); }
};
const skip = (name, why) => { console.log(`  SKIP  ${name}  —  ${why}`); skipped++; };

const { applyLabelToThread } = await import("../src/lib/tools/master-inbox/inbox/apply-label.ts");
const { createAdminSupabase } = await import("../src/lib/supabase/admin.ts");
const {
  markIntroduction,
  labelIntroductionAfterSend,
  recordIntroductionOutcome,
  INTRODUCTION_LABEL_MISSING,
} = await import("../src/lib/tools/master-inbox/ai/live.ts");
const { liveSendingEnabled, LIVE_SEND_ENV_VAR } = await import("../src/lib/tools/master-inbox/ai/live-gate.ts");
const { LIVE_TRANSPORT_WIRED, dispatch } = await import("../src/lib/tools/master-inbox/ai/send-transport.ts");

console.log(`\nAPPLYING A LABEL — ONE GUARDED PATH${BASE ? `  →  ${BASE}` : ""}\n${"=".repeat(74)}\n`);

/* --------------------------------------------------------------- helpers */
const assignments = async (threadId) =>
  (await rest(`label_assignments?select=id,label_id,assigned_by,assigned_user_id&target_type=eq.thread&target_id=eq.${threadId}`)).body ?? [];
const outbox = async (threadId) =>
  (await rest(`side_effect_outbox?select=id,kind,status&subject_id=eq.${threadId}&order=kind`)).body ?? [];
const clearOutbox = (threadId) => rest(`side_effect_outbox?subject_id=eq.${threadId}`, { method: "DELETE" });
const threadState = async (threadId, agentId) =>
  ((await rest(`agent_thread_state?select=status,stop_reason,hold_reason&thread_id=eq.${threadId}&agent_id=eq.${agentId}`)).body ?? [])[0] ?? null;

const threads = [];
async function newThread(tag) {
  const ins = await rest("threads", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    // No client, no lead, no channel: nothing downstream has anything to act on.
    body: JSON.stringify({ workspace_id: WS, subject: `${THROWAWAY} ${tag}`, status: "archived", folder: "spam" }),
  });
  const id = (Array.isArray(ins.body) ? ins.body[0] : ins.body)?.id ?? null;
  if (id) threads.push(id);
  return id;
}

const intro = ((await rest(`labels?select=id,name&workspace_id=eq.${WS}&name=ilike.introduction&limit=1`)).body ?? [])[0];
check("the workspace has an Introduction label", Boolean(intro?.id), intro?.name ?? "missing");
if (!intro?.id) { console.log("\n  nothing to test without it\n"); process.exit(1); }
const LABEL = intro.id;

let agentId = null;
try {
  /* -------------------------------------------------- 1. the route, as a user */
  console.log("\n1. The route, signed in as a person\n");
  if (!BASE) {
    skip("the route", "set BASE=http://localhost:<port> to a dev server running this tree");
  } else {
    const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
    const cookie = `bs_sso=${await mintSso(process.env.BS_SSO_SECRET || process.env.AUTH_SECRET, { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 })}`;
    const call = (threadId, body) =>
      fetch(`${BASE}/api/tools/master-inbox/threads/${threadId}/labels`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "manual",
      });

    const t = await newThread("route");
    check("a throwaway thread exists", Boolean(t), t ?? "insert failed");
    if (t) {
      const bad = await call(t, { label_id: "not-a-uuid" });
      check("invalid input is still a 400", bad.status === 400, `status ${bad.status} ${(await bad.text()).slice(0, 60)}`);

      const r1 = await call(t, { label_id: LABEL });
      const b1 = await r1.text();
      check("POST answers 200 { ok: true }", r1.status === 200 && b1 === '{"ok":true}', `${r1.status} ${b1.slice(0, 60)}`);
      await sleep(2500); // after() runs once the response has gone
      const a1 = await assignments(t);
      check("exactly one assignment, by the user", a1.length === 1 && a1[0].assigned_by === "user" && a1[0].label_id === LABEL, JSON.stringify(a1));
      check("assigned_user_id is null — OS users have no auth.users row", a1[0]?.assigned_user_id === null, String(a1[0]?.assigned_user_id));
      const o1 = await outbox(t);
      check("the introduction was announced once: one outbox job per kind", o1.length === 3 && new Set(o1.map((r) => r.kind)).size === 3, o1.map((r) => `${r.kind}:${r.status}`).join(", ") || "none");

      await clearOutbox(t);
      const r2 = await call(t, { label_id: LABEL });
      const b2 = await r2.text();
      check("a repeat POST still answers 200 { ok: true }", r2.status === 200 && b2 === '{"ok":true}', `${r2.status} ${b2.slice(0, 60)}`);
      await sleep(2500);
      const a2 = await assignments(t);
      check("still exactly one assignment", a2.length === 1, `${a2.length}`);
      const o2 = await outbox(t);
      check("and NO second announcement — the already-carries guard held", o2.length === 0, o2.length ? o2.map((r) => r.kind).join(", ") : "no outbox rows");
    }
  }

  /* ---------------------------------------- 2. the shared function, as the agent */
  console.log("\n2. The shared function with the agent actor (dry: no request, no session)\n");
  const admin = createAdminSupabase();
  const t2 = await newThread("agent");
  check("a throwaway thread exists", Boolean(t2), t2 ?? "insert failed");
  if (t2) {
    const first = await applyLabelToThread({
      supabase: admin, workspaceId: WS, threadId: t2, labelId: LABEL,
      actor: { kind: "agent", agentId: "00000000-0000-4000-8000-00000000a6e7" },
    });
    check("it applies", first.ok === true, JSON.stringify(first));
    check("it recognised the label as Introduction and announced it", first.ok && first.isIntroduction && first.announced && !first.alreadyCarriedThisLabel, JSON.stringify(first));
    const a = await assignments(t2);
    check("one assignment, assigned_by='system', no user", a.length === 1 && a[0].assigned_by === "system" && a[0].assigned_user_id === null, JSON.stringify(a));
    const o = await outbox(t2);
    check("exactly one outbox job per kind (the side effects ran inline, not via after())", o.length === 3 && new Set(o.map((r) => r.kind)).size === 3, o.map((r) => `${r.kind}:${r.status}`).join(", ") || "none");
    check("every job completed or was parked with its own error — none is still claimed", o.every((r) => r.status === "done" || r.status === "failed" || r.status === "pending"), o.map((r) => r.status).join(", "));

    await clearOutbox(t2);
    const again = await applyLabelToThread({
      supabase: admin, workspaceId: WS, threadId: t2, labelId: LABEL,
      actor: { kind: "agent", agentId: "00000000-0000-4000-8000-00000000a6e7" },
    });
    check("a repeat call succeeds silently", again.ok === true && again.alreadyCarriedThisLabel === true && again.announced === false, JSON.stringify(again));
    check("no second announcement", (await outbox(t2)).length === 0, "no outbox rows");
    check("still one assignment", (await assignments(t2)).length === 1, "1");

    // A user re-applying over the agent's label: the row becomes theirs, still one.
    const user = await applyLabelToThread({ supabase: admin, workspaceId: WS, threadId: t2, labelId: LABEL, actor: { kind: "user", userId: null } });
    const au = await assignments(t2);
    check("a person re-applying takes the row over without announcing", user.ok && !user.announced && au.length === 1 && au[0].assigned_by === "user", JSON.stringify(au));
  }

  /* --------------------------------------------- 3. the post-send hook, ai/live.ts */
  console.log("\n3. ai/live.ts — the post-send hook\n");
  const src = fs.readFileSync("src/lib/tools/master-inbox/ai/live.ts", "utf8");
  const sentBranch = src.slice(src.indexOf('if (result.status === "sent")'), src.indexOf("// gated / not_wired"));
  check("the sent branch labels every handover — no switch, no config read", sentBranch.includes("if (input.isHandover) {") && sentBranch.includes("labelIntroductionAfterSend(") && !sentBranch.includes("markIntroduction"), "attemptLiveSend");
  check("the hook is unreachable today: the transport is not wired and the gate is closed", !liveSendingEnabled() && LIVE_TRANSPORT_WIRED === false, `${LIVE_SEND_ENV_VAR} unset, LIVE_TRANSPORT_WIRED=false`);
  const d = await dispatch({ workspaceId: WS, threadId: "x", agentId: "x", draftId: "x", to: ["nobody@example.invalid"], cc: [], subject: null, body: "x", isHandover: true });
  check("dispatch() sends nothing", d.status === "gated", d.status);

  const ins = await rest("reply_agents", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      workspace_id: WS, name: THROWAWAY, active: false, run_mode: "pause",
      client_ids: [], channel_ids: [FAKE_CHANNEL], channel_filter: "both",
      qualification: { enabled: false, questions: [], required: 0, pass_rule: "all_answered" },
      handover: { cc_emails: [], message: "" },
    }),
  });
  agentId = (Array.isArray(ins.body) ? ins.body[0] : ins.body)?.id ?? null;
  check("a throwaway agent exists (pause, inactive, on a channel that does not exist)", Boolean(agentId), ins.ok ? "created" : JSON.stringify(ins.body).slice(0, 160));

  const t3 = await newThread("live");
  if (agentId && t3) {
    const m1 = await markIntroduction(WS, t3, agentId);
    check("markIntroduction resolves the workspace's label and applies it", m1.status === "applied" && m1.labelId === LABEL, JSON.stringify(m1));
    const a3 = await assignments(t3);
    check("the row is the agent's: assigned_by='system'", a3.length === 1 && a3[0].assigned_by === "system", JSON.stringify(a3));
    check("announced once", (await outbox(t3)).length === 3, "3 outbox rows");
    await clearOutbox(t3);
    const m2 = await markIntroduction(WS, t3, agentId);
    check("a second call is already_introduced, and announces nothing", m2.status === "already_introduced" && (await outbox(t3)).length === 0, JSON.stringify(m2));

    const none = await markIntroduction(NO_SUCH_WORKSPACE, t3, agentId);
    check("a workspace with no Introduction label → no_label, nothing thrown, nothing invented", none.status === "no_label", JSON.stringify(none));
    const labelsNow = (await rest(`labels?select=id&workspace_id=eq.${NO_SUCH_WORKSPACE}`)).body ?? [];
    check("no label was created for it", labelsNow.length === 0, `${labelsNow.length}`);

    // The hook end to end on a fresh thread: applied, and nothing recorded.
    const t4 = await newThread("hook");
    const h = await labelIntroductionAfterSend({ workspaceId: WS, threadId: t4, agentId });
    check("labelIntroductionAfterSend applies the label", h.status === "applied", JSON.stringify(h));
    check("a success leaves no stop_reason behind", (await threadState(t4, agentId)) === null, "no state row written");

    // The record, when the label could not be applied.
    await recordIntroductionOutcome({ workspaceId: WS, threadId: t3, agentId }, { status: "no_label" });
    const st = await threadState(t3, agentId);
    check("a missing label is recorded on the thread state as stop_reason", st?.stop_reason === INTRODUCTION_LABEL_MISSING, JSON.stringify(st));
    check("and NOT as hold_reason — the release job must not re-send", st?.hold_reason === null, String(st?.hold_reason));
    await recordIntroductionOutcome({ workspaceId: WS, threadId: t3, agentId }, { status: "failed", labelId: LABEL, error: "boom" });
    const st2 = await threadState(t3, agentId);
    check("a failed write is recorded with its error", st2?.stop_reason === "introduction_label_failed: boom", String(st2?.stop_reason));
  } else {
    skip("the hook", "no throwaway agent or thread");
  }
} catch (e) {
  check("the run completed", false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  console.log("\n  cleaning up…");
  for (const id of threads) {
    await rest(`side_effect_outbox?subject_id=eq.${id}`, { method: "DELETE" });
    await rest(`agent_thread_state?thread_id=eq.${id}`, { method: "DELETE" });
    await rest(`label_assignments?target_type=eq.thread&target_id=eq.${id}`, { method: "DELETE" });
    await rest(`thread_reply_label_touch?thread_id=eq.${id}`, { method: "DELETE" });
    await rest(`deleted_reply_label_tombstone?thread_id=eq.${id}`, { method: "DELETE" });
    await rest(`threads?id=eq.${id}`, { method: "DELETE" });
  }
  if (agentId) {
    await rest(`agent_thread_state?agent_id=eq.${agentId}`, { method: "DELETE" });
    await rest(`reply_agents?id=eq.${agentId}`, { method: "DELETE" });
  }
  await rest(`reply_agents?name=eq.${encodeURIComponent(THROWAWAY)}`, { method: "DELETE" });
  await rest(`threads?subject=like.${encodeURIComponent(THROWAWAY)}*`, { method: "DELETE" });
  const leftT = (await rest(`threads?select=id&subject=like.${encodeURIComponent(THROWAWAY)}*`)).body ?? [];
  const leftA = (await rest(`reply_agents?select=id&name=eq.${encodeURIComponent(THROWAWAY)}`)).body ?? [];
  const leftO = threads.length ? (await rest(`side_effect_outbox?select=id&subject_id=in.(${threads.join(",")})`)).body ?? [] : [];
  check("no throwaway rows are left behind", leftT.length === 0 && leftA.length === 0 && leftO.length === 0, `${leftT.length} threads, ${leftA.length} agents, ${leftO.length} outbox rows`);
}

console.log(`\n${"=".repeat(74)}\n  ${passed} passed · ${failed} failed · ${skipped} skipped`);
if (fails.length > 0) console.log(`  failed: ${fails.join(", ")}`);
console.log("");
process.exit(failed > 0 ? 1 : 0);
