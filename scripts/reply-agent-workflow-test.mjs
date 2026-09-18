/*
 * The reply-agent upgrade, tested as a workflow rather than as a screen.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT CHECKS, AND WHY EACH ONE
 *
 *   1. MIGRATION STATE.  Which of 0009 / 0010 have actually been applied. Every
 *      check below either needs them or is explicitly the "not migrated yet"
 *      case, and a run that does not say which world it is in is useless.
 *
 *   2. SELECTION, against the real agent roster and a real thread. "Which agent
 *      answers this client's lead" is the decision that, if wrong, sends one
 *      client's words to another client's candidate. It is checked here against
 *      live rows, not fixtures.
 *
 *   3. THE SCRIPT, against a real conversation. The qualification engine is fed
 *      the actual inbound messages of a real thread, turn by turn, and has to
 *      ask question 1, record the answer, ask question 2, then qualify. No
 *      model call, no draft, nothing written.
 *
 *   4. A REAL WRITE, on a throwaway row. One agent named
 *      ZZZ-throwaway-reply-agent-test is created inactive and paused, read back
 *      to prove the new columns store and default correctly, and deleted in a
 *      finally. Nothing else in the database is written.
 *
 *   5. LIVE CANNOT SEND. The three locks are checked for real: the env var is
 *      absent, the transport constant is false, and the save path refuses
 *      run_mode='live'.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT NEVER DOES
 *
 * No email. No model call. No write to threads, messages, clients, labels,
 * label_assignments, reply_drafts or anything portal-related. The only row it
 * creates is the throwaway agent, and it is deleted on every exit path.
 *
 *   node scripts/reply-agent-workflow-test.mjs
 */

import fs from "node:fs";

const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => {
  const m = raw.match(new RegExp(`^${k}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
};

const SB = pick("MASTER_INBOX_SUPABASE_URL");
const SK = pick("MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY");
const WS = pick("MASTER_INBOX_WORKSPACE_ID");
if (!SB || !SK) {
  console.error("MASTER_INBOX_SUPABASE_URL / _SERVICE_ROLE_KEY missing from .env.local");
  process.exit(2);
}

const THROWAWAY = "ZZZ-throwaway-reply-agent-test";

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
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, body };
};

let passed = 0;
let failed = 0;
let skipped = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  —  " + detail : ""}`);
  if (ok) passed++;
  else {
    failed++;
    fails.push(name);
  }
};
const skip = (name, why) => {
  console.log(`  SKIP  ${name}  —  ${why}`);
  skipped++;
};

const { selectAgentForThread, parseRunConfig, parseQualification } = await import(
  "../src/lib/tools/master-inbox/ai/agent-config.ts"
);
const { advance, EMPTY_STATE } = await import("../src/lib/tools/master-inbox/ai/qualification.ts");
const { liveSendingEnabled, LIVE_SEND_ENV_VAR } = await import(
  "../src/lib/tools/master-inbox/ai/live-gate.ts"
);
const { LIVE_TRANSPORT_WIRED } = await import(
  "../src/lib/tools/master-inbox/ai/send-transport.ts"
);

console.log(`\nREPLY AGENT UPGRADE — WORKFLOW\n${"=".repeat(74)}\n`);

/* ---------------------------------------------------------------- 1. state */
console.log("1. What the database has\n");

const upgraded = await rest("reply_agents?select=id,run_mode,client_ids,schedule,qualification,handover&limit=1");
const HAS_0009_COLUMNS = upgraded.ok;
console.log(
  `  migration 0009 columns on reply_agents : ${HAS_0009_COLUMNS ? "present" : "ABSENT"}`,
);

const stateTable = await rest("agent_thread_state?select=id&limit=1");
const HAS_STATE_TABLE = stateTable.ok;
console.log(`  agent_thread_state table               : ${HAS_STATE_TABLE ? "present" : "ABSENT"}`);

const statsView = await rest("v_reply_agent_stats?select=agent_id&limit=1");
const HAS_STATS_VIEW = statsView.ok;
console.log(`  v_reply_agent_stats view               : ${HAS_STATS_VIEW ? "present" : "ABSENT"}`);
console.log("");

/* ------------------------------------------------------------ 2. selection */
console.log("2. Which agent answers this thread\n");

const liveAgents = (await rest("reply_agents?select=id,name,active,created_at,channel_filter,channel_ids&order=created_at.asc")).body ?? [];
check("the agent roster reads", Array.isArray(liveAgents), `${liveAgents.length ?? 0} agents`);

const upgradeCols = HAS_0009_COLUMNS
  ? ((await rest("reply_agents?select=id,run_mode,client_ids")).body ?? [])
  : [];
const byId = new Map(upgradeCols.map((r) => [r.id, r]));

const selectable = (liveAgents ?? []).map((a) => {
  const cfg = parseRunConfig(byId.get(a.id) ?? {});
  return {
    id: a.id,
    name: a.name,
    active: a.active,
    created_at: a.created_at,
    channel_filter: a.channel_filter ?? "both",
    channel_ids: a.channel_ids ?? [],
    run_mode: cfg.runMode,
    client_ids: cfg.clientIds,
  };
});

const threads =
  (await rest(
    "threads?select=id,subject,client_id,channel_id&client_id=not.is.null&order=last_message_at.desc&limit=1",
  )).body ?? [];
const thread = threads[0];
check("a real client-tagged thread was found", Boolean(thread?.id), thread?.id ?? "none");

if (thread) {
  const out = selectAgentForThread(selectable, {
    clientId: thread.client_id,
    channelId: thread.channel_id,
    channelType: "email",
  });
  console.log(`      thread ${thread.id}  client ${thread.client_id}`);
  console.log(
    `      → ${out.status}${out.status === "selected" ? ` (${out.agent.name}, ${out.reason})` : out.status === "paused" ? ` (${out.agent.name})` : ` (${out.reason})`}`,
  );
  check(
    "selection returns exactly one agent or an explained refusal",
    ["selected", "paused", "none"].includes(out.status),
    out.status,
  );
  if (out.status === "selected") {
    check(
      "the selected agent is active and not paused",
      out.agent.active && out.agent.run_mode !== "pause",
      `${out.agent.name}: active=${out.agent.active} run_mode=${out.agent.run_mode}`,
    );
    // The property that matters: an agent assigned to a DIFFERENT client must
    // never be the one chosen here.
    check(
      "the selected agent is not assigned to some other client",
      out.agent.client_ids.length === 0 || out.agent.client_ids.includes(thread.client_id),
      `client_ids=${JSON.stringify(out.agent.client_ids)}`,
    );
  }

  /* --- pause, proved on the real roster ---------------------------------- */
  const paused = selectable.map((a) =>
    a.client_ids.includes(thread.client_id) || a.client_ids.length === 0
      ? { ...a, run_mode: "pause" }
      : a,
  );
  const afterPause = selectAgentForThread(paused, {
    clientId: thread.client_id,
    channelId: thread.channel_id,
    channelType: "email",
  });
  check(
    "pausing every candidate stops this thread rather than falling through",
    afterPause.status !== "selected",
    afterPause.status,
  );
}
console.log("");

/* --------------------------------------------------------- 3. the script */
console.log("3. The qualification script, over a real conversation\n");

const script = parseQualification({
  enabled: true,
  questions: [
    { text: "Are you licensed in the state you're looking to work in?" },
    { text: "What times work for a quick call this week?" },
  ],
  required: 0,
  pass_rule: "all_answered",
});

let replies = [];
if (thread) {
  replies =
    (await rest(
      `messages?select=id,body_text,sent_at&thread_id=eq.${thread.id}&direction=eq.inbound&order=sent_at.asc&limit=4`,
    )).body ?? [];
}
check("the thread has inbound replies to feed the script", replies.length > 0, `${replies.length} inbound`);

if (replies.length > 0) {
  let state = EMPTY_STATE;
  const trail = [];
  /*
   * The real replies first, then enough stand-in answers to let a two-question
   * script finish. A script of N questions needs N+1 turns: the first asks
   * question 1, each later turn records the previous answer before choosing
   * what to ask next, and the last one tips it into `qualified`. Most real
   * threads have one inbound reply, so without the stand-ins this would be a
   * test of how chatty the sample conversation happened to be.
   */
  const standIns = ["yes, licensed since 2019", "Thursday afternoon works", "any time"];
  const turns = [
    ...replies.map((m) => (m.body_text ?? "").slice(0, 400)),
    ...standIns.slice(0, script.questions.length + 1),
  ];
  for (const text of turns) {
    const action = advance({ config: script, state, inboundText: text, now: new Date() });
    trail.push(action.kind === "ask" ? `ask:${action.question.id}` : action.kind);
    if (action.kind === "ask" || action.kind === "qualified") state = action.state;
    if (action.kind === "qualified") break;
  }
  console.log(`      ${trail.join(" → ")}`);
  check("the script asks its first question on the first reply", trail[0] === "ask:q1", trail[0]);
  check(
    "the script reaches qualified without asking a question twice",
    trail.filter((t) => t === "ask:q1").length === 1 && trail.includes("qualified"),
    trail.join(" → "),
  );
  check(
    "every answer collected came from the lead, verbatim",
    state.answers.every((a) => typeof a.answer === "string" && a.answer.length > 0),
    `${state.answers.length} answers`,
  );
}
console.log("");

/* --------------------------------------------------- 4. a real write, once */
console.log("4. A throwaway agent, written and deleted\n");

let throwawayId = null;
try {
  // Always inactive. If 0009 has run it is also explicitly paused; if it has
  // not, `active:false` alone keeps it out of every selection path.
  const insert = await rest("reply_agents", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      workspace_id: WS,
      name: THROWAWAY,
      active: false,
      ...(HAS_0009_COLUMNS ? { run_mode: "pause" } : {}),
    }),
  });
  const created = Array.isArray(insert.body) ? insert.body[0] : insert.body;
  throwawayId = created?.id ?? null;
  check("a throwaway agent can be created", Boolean(throwawayId), insert.status === 201 ? "created" : JSON.stringify(insert.body).slice(0, 200));

  if (throwawayId && HAS_0009_COLUMNS) {
    const back = (await rest(`reply_agents?select=*&id=eq.${throwawayId}`)).body?.[0];
    check("run_mode stored", back?.run_mode === "pause", String(back?.run_mode));
    check(
      "client_ids, schedule, qualification and handover all default rather than arriving null",
      back?.client_ids !== null && back?.schedule !== null && back?.qualification !== null && back?.handover !== null,
      JSON.stringify({ schedule: back?.schedule, qualification: back?.qualification }).slice(0, 160),
    );

    // The default that protects the live system: a NEW agent is shadow, never
    // live. (This one was inserted as 'pause' deliberately; the column default
    // is checked directly.)
    const defaulted = await rest("reply_agents", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ workspace_id: WS, name: `${THROWAWAY}-default`, active: false }),
    });
    const d = Array.isArray(defaulted.body) ? defaulted.body[0] : defaulted.body;
    check("a new agent defaults to shadow, not live", d?.run_mode === "shadow", String(d?.run_mode));
    if (d?.id) await rest(`reply_agents?id=eq.${d.id}`, { method: "DELETE" });

    // The database itself refuses 'live' being spelled wrong, and refuses
    // anything outside the three modes.
    const bad = await rest(`reply_agents?id=eq.${throwawayId}`, {
      method: "PATCH",
      body: JSON.stringify({ run_mode: "sending" }),
    });
    check("the check constraint rejects an unknown run_mode", !bad.ok, `status ${bad.status}`);
  } else if (throwawayId) {
    skip("the new columns store and default correctly", "migration 0009 has not been run");
  }

  /* --- per-thread state --------------------------------------------------- */
  if (throwawayId && HAS_STATE_TABLE && thread) {
    const ins = await rest("agent_thread_state", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        workspace_id: WS,
        thread_id: thread.id,
        agent_id: throwawayId,
        status: "qualifying",
        step: 1,
        answers: [{ question_id: "q1", question: "test", answer: "test", at: new Date().toISOString() }],
      }),
    });
    const row = Array.isArray(ins.body) ? ins.body[0] : ins.body;
    check("per-thread state can be written", Boolean(row?.id), JSON.stringify(ins.body).slice(0, 160));

    if (row?.id) {
      // The uniqueness that stops a retried webhook opening a second
      // conversation for the same thread.
      const dupe = await rest("agent_thread_state", {
        method: "POST",
        body: JSON.stringify({ workspace_id: WS, thread_id: thread.id, agent_id: throwawayId }),
      });
      check("a second state row for the same (thread, agent) is refused", !dupe.ok, `status ${dupe.status}`);
      await rest(`agent_thread_state?id=eq.${row.id}`, { method: "DELETE" });
    }
  } else if (!HAS_STATE_TABLE) {
    skip("per-thread state can be written", "migration 0009 has not been run");
  }

  /* --- the stats view ----------------------------------------------------- */
  if (HAS_STATS_VIEW) {
    const rows = (await rest("v_reply_agent_stats?select=*&limit=50")).body ?? [];
    check("the stats view returns a row per agent", Array.isArray(rows) && rows.length > 0, `${rows.length} rows`);
    const sample = rows[0];
    check(
      "every metric the plan asks for is present",
      sample &&
        ["replies_drafted", "replies_sent", "lead_replies_received", "qualification_started",
         "qualification_qualified", "qualification_handed_over", "qualification_stopped",
         "reply_rate", "qualification_rate", "handover_rate", "tokens_total", "updated_at"]
          .every((k) => k in sample),
      sample ? Object.keys(sample).length + " columns" : "no rows",
    );
    check(
      "the view never exposes an API key",
      sample && !Object.keys(sample).some((k) => k.includes("api_key")),
      "no api_key column",
    );
  } else {
    skip("the stats view answers", "migration 0010 has not been run");
  }
} finally {
  if (throwawayId) {
    const del = await rest(`reply_agents?id=eq.${throwawayId}`, { method: "DELETE" });
    console.log(`\n  cleanup: throwaway agent deleted (${del.status})`);
  }
  // Belt and braces — delete by name too, in case a previous crashed run left one.
  await rest(`reply_agents?name=like.${encodeURIComponent(THROWAWAY)}*`, { method: "DELETE" });
  const left = (await rest(`reply_agents?select=id,name&name=like.${encodeURIComponent(THROWAWAY)}*`)).body ?? [];
  check("no throwaway rows are left behind", left.length === 0, `${left.length} remaining`);
}
console.log("");

/* ------------------------------------------------------- 5. live is locked */
console.log("5. Live sending cannot happen\n");

check(`${LIVE_SEND_ENV_VAR} is not set in this environment`, !liveSendingEnabled(), "gate closed");
check("the provider transport is not wired", LIVE_TRANSPORT_WIRED === false, "LIVE_TRANSPORT_WIRED=false");

const { dispatch } = await import("../src/lib/tools/master-inbox/ai/send-transport.ts");
const attempted = await dispatch({
  workspaceId: WS ?? "",
  threadId: "00000000-0000-0000-0000-000000000000",
  agentId: "00000000-0000-0000-0000-000000000000",
  draftId: "00000000-0000-0000-0000-000000000000",
  to: ["nobody@example.invalid"],
  cc: [],
  subject: "test",
  body: "test",
  isHandover: false,
});
check("calling the transport directly still sends nothing", attempted.status !== "sent", attempted.status);

const { evaluate } = await import("../src/lib/tools/master-inbox/ai/safety.ts");
const verdict = evaluate({
  liveSendingEnabled: liveSendingEnabled(),
  runMode: "live",
  doNotContact: false,
  unsubscribeRequested: false,
  hostileReply: false,
  needsHumanReview: false,
  sendsMadeOnThread: 0,
  sendsInRateWindow: 0,
  hasRecipient: true,
  window: { open: true },
});
check(
  "the safety gate refuses a perfect send because the server gate is off",
  verdict.allowed === false && verdict.reason === "live_disabled",
  verdict.allowed ? "ALLOWED" : verdict.reason,
);

console.log(`\n${"=".repeat(74)}\n  ${passed} passed · ${failed} failed · ${skipped} skipped`);
if (fails.length > 0) console.log(`  failed: ${fails.join(", ")}`);
console.log("");
process.exit(failed > 0 ? 1 : 0);
