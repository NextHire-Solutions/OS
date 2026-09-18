import "server-only";

import { createAdminSupabase } from "@/lib/supabase/admin";
import { osTable } from "@/lib/clients/os-db";
import { normaliseBody, verdictFor } from "./corpus-pure";

/*
 * The agent's record, computed for every draft it has ever written.
 *
 * ---------------------------------------------------------------------------
 * WHY BACKFILL AT ALL
 *
 * The verdict captured on send only measures sends from now on. A screen whose
 * headline metric reads "0 of 0" on the day it ships tells nobody anything, and
 * the question the user actually asked — is this getting better? — needs a
 * before to compare the after against.
 *
 * There are 12,451 drafts on record and 11,771 of them have a body. Judging all
 * of them gives the metric a history on day one, and it gives it honestly: the
 * baseline is computed from the same code that will judge tomorrow's sends,
 * not asserted.
 *
 * ---------------------------------------------------------------------------
 * HOW A DRAFT IS PAIRED WITH WHAT WENT OUT
 *
 * `reply_drafts.sent_message_id` is null on every row in the database — the
 * column exists and was never populated — so it cannot be used. What can be
 * used is time: the reply a draft became is the FIRST outbound message on that
 * thread at or after the draft was created. A draft with no outbound after it
 * was never sent, and `discarded` is the correct and most common verdict: 9,431
 * drafts are still sitting in 'pending'.
 *
 * A window caps the pairing. Without one, a draft abandoned in March pairs with
 * an unrelated reply sent in July and scores as "rewritten" — inventing an edit
 * that never happened and flattering the agent's send rate at the same time.
 *
 * ---------------------------------------------------------------------------
 * A JOB, NOT A REQUEST
 *
 * Same shape as corpus-job.ts: it reads every message in the workspace, which
 * is far longer than a browser will hold a connection. The route starts it and
 * the screen polls.
 */

/** A draft and a reply more than this far apart are not the same act. */
const PAIR_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export interface BackfillReport {
  drafts: number;
  paired: number;
  discarded: number;
  written: number;
  byVerdict: Record<string, number>;
}

interface JobState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  note: string;
  error: string | null;
  report: BackfillReport | null;
}

/* One job per process, on the global — the same guard the corpus job uses, so a
 * hot reload in development cannot start a second pass over 37,000 messages. */
const KEY = Symbol.for("brokerstaffer.ai.feedback.backfill");
type Holder = { [KEY]?: JobState };

function state(): JobState {
  const g = globalThis as unknown as Holder;
  if (!g[KEY]) {
    g[KEY] = { running: false, startedAt: null, finishedAt: null, note: "", error: null, report: null };
  }
  return g[KEY]!;
}

export function backfillStatus(): JobState {
  return { ...state() };
}

export type StartResult = { started: true } | { started: false; reason: "already-running" };

export function startFeedbackBackfill(workspaceId: string): StartResult {
  const s = state();
  if (s.running) return { started: false, reason: "already-running" };

  s.running = true;
  s.startedAt = new Date().toISOString();
  s.finishedAt = null;
  s.error = null;
  s.report = null;
  s.note = "starting";

  void (async () => {
    try {
      s.report = await runBackfill(workspaceId, (note) => {
        s.note = note;
        console.log("[ai:backfill]", note);
      });
      s.note = `done — ${s.report.written} verdicts`;
    } catch (err) {
      s.error = err instanceof Error ? err.message : String(err);
      s.note = "failed";
      console.error("[ai:backfill] failed", err);
    } finally {
      s.running = false;
      s.finishedAt = new Date().toISOString();
    }
  })();

  return { started: true };
}

export async function runBackfill(
  workspaceId: string,
  note: (s: string) => void = () => {},
): Promise<BackfillReport> {
  const admin = createAdminSupabase();
  const report: BackfillReport = {
    drafts: 0, paired: 0, discarded: 0, written: 0,
    byVerdict: { as_written: 0, light_edit: 0, rewritten: 0, discarded: 0 },
  };

  /* ------------------------------------------------- every draft with a body */
  type Draft = { id: string; thread_id: string; agent_id: string | null; generated_body: string; created_at: string };
  const byThread = new Map<string, Draft[]>();

  for (let off = 0; off < 100_000; off += 1000) {
    const { data, error } = await admin
      .from("reply_drafts")
      .select("id, thread_id, agent_id, generated_body, created_at")
      .eq("workspace_id", workspaceId)
      .not("generated_body", "is", null)
      .order("created_at", { ascending: true })
      .range(off, off + 999);
    if (error) throw new Error(`drafts read failed: ${error.message}`);
    const rows = (data ?? []) as Draft[];
    for (const d of rows) {
      if (!d.thread_id || !d.generated_body?.trim()) continue;
      const list = byThread.get(d.thread_id) ?? [];
      list.push(d);
      byThread.set(d.thread_id, list);
      report.drafts++;
    }
    if (rows.length < 1000) break;
  }
  note(`${report.drafts} drafts with a body, across ${byThread.size} threads`);

  /* ----------------------------------------- one pass over outbound messages
   *
   * Ordered by (thread_id, sent_at) and flushed when the thread changes, so
   * memory holds one thread rather than 24,000 message bodies — the same walk
   * the corpus builder makes, for the same reason.
   */
  type Msg = { id: string; thread_id: string; body_text: string | null; body_html: string | null; sent_at: string | null };
  const pending: Array<Record<string, unknown>> = [];
  const decided = new Set<string>();

  const judge = (drafts: Draft[], outbound: Msg[]) => {
    for (const d of drafts) {
      const createdAt = new Date(d.created_at).getTime();
      const match = outbound.find((m) => {
        if (!m.sent_at) return false;
        const t = new Date(m.sent_at).getTime();
        return t >= createdAt && t - createdAt <= PAIR_WINDOW_MS;
      });
      const drafted = normaliseBody(d.generated_body, null);
      if (!match) {
        report.discarded++;
        report.byVerdict.discarded++;
        pending.push({
          workspace_id: workspaceId, thread_id: d.thread_id, draft_id: d.id,
          agent_id: d.agent_id, draft_body: drafted.slice(0, 8000), sent_body: null,
          verdict: "discarded", similarity: null,
        });
        decided.add(d.id);
        continue;
      }
      const sent = normaliseBody(match.body_text, match.body_html);
      const { verdict, similarity } = verdictFor(drafted, sent);
      report.paired++;
      report.byVerdict[verdict]++;
      pending.push({
        workspace_id: workspaceId, thread_id: d.thread_id, draft_id: d.id,
        agent_id: d.agent_id, draft_body: drafted.slice(0, 8000), sent_body: sent.slice(0, 8000),
        verdict, similarity,
      });
      decided.add(d.id);
    }
  };

  let buffer: Msg[] = [];
  let bufferThread: string | null = null;
  const flush = () => {
    if (bufferThread) {
      const drafts = byThread.get(bufferThread);
      if (drafts) judge(drafts, buffer);
    }
    buffer = [];
  };

  let read = 0;
  for (let off = 0; off < 500_000; off += 1000) {
    const { data, error } = await admin
      .from("messages")
      .select("id, thread_id, body_text, body_html, sent_at")
      .eq("workspace_id", workspaceId)
      .eq("direction", "outbound")
      .order("thread_id", { ascending: true })
      .order("sent_at", { ascending: true })
      .range(off, off + 999);
    if (error) throw new Error(`messages read failed: ${error.message}`);
    const rows = (data ?? []) as Msg[];
    if (rows.length === 0) break;
    for (const m of rows) {
      if (m.thread_id !== bufferThread) { flush(); bufferThread = m.thread_id; }
      buffer.push(m);
    }
    read += rows.length;
    if (read % 5000 === 0) note(`${read} outbound messages read, ${pending.length} verdicts so far`);
    if (rows.length < 1000) break;
  }
  flush();

  /*
   * Threads whose drafts never met an outbound message at all — the agent
   * drafted, nobody ever replied on that thread. They are discarded too, and
   * the message walk never reaches them because it only visits threads that
   * HAVE outbound mail.
   */
  for (const [threadId, drafts] of byThread) {
    for (const d of drafts) {
      if (decided.has(d.id)) continue;
      report.discarded++;
      report.byVerdict.discarded++;
      pending.push({
        workspace_id: workspaceId, thread_id: threadId, draft_id: d.id,
        agent_id: d.agent_id, draft_body: normaliseBody(d.generated_body, null).slice(0, 8000),
        sent_body: null, verdict: "discarded", similarity: null,
      });
    }
  }

  note(`judged ${pending.length} drafts — writing`);

  /* Upsert on draft_id: the migration's unique index makes a re-run idempotent
   * rather than a second set of 12,000 rows. */
  const WRITE = 200;
  for (let i = 0; i < pending.length; i += WRITE) {
    const slice = pending.slice(i, i + WRITE);
    const { error } = await osTable("os_reply_feedback").upsert(slice, { onConflict: "draft_id" });
    if (error) throw new Error(`feedback write failed: ${error.message}`);
    report.written += slice.length;
    if (report.written % 2000 === 0) note(`${report.written}/${pending.length} written`);
  }

  return report;
}
