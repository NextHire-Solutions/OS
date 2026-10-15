import "server-only";

import { pushIntroPipelineEntriesForThreadsToFub } from "./integrations/push-pipeline-entry";
import { getMasterInboxSupabase, workspaceId } from "./supabase";
import { notifyIntroductionForThreads } from "./webhooks/n8n-introduction";
import { notifyPortalIntroductionForThreads } from "./webhooks/slack-portal";

/*
 * The notices for an introduction that reached its portal late (15 Oct).
 *
 * Labelling a conversation Introduction sends three notices — the team's text
 * and Bison's webhook (notifyIntroductionForThreads), the Slack introduction
 * post, and the Follow Up Boss push. All three read the client's portal entry
 * and send NOTHING when there is none. An introduction labelled while its
 * conversation had no client got no entry then, so nobody was told.
 *
 * Master Inbox migration 0078 now creates that entry when the client is set.
 * This sweep (every minute, instrumentation.ts) finds those entries and sends
 * the three notices once — what the label would have sent, had the client
 * been known.
 *
 * WHICH ENTRIES. 0078 writes introduced_at = when the label was applied, so an
 * entry it created is one whose introduced_at equals the conversation's
 * Introduction label time but which was created minutes or days after it.
 * An entry the label trigger made at labelling time was created in the same
 * moment, and the client's own candidates are "Client Entry". Only entries
 * created since 0078 went live are looked at — nothing older is ever notified
 * (no backfill, user decision 15 Oct).
 *
 * ONCE. Each is claimed in side_effect_outbox (kind 'late_introduction',
 * subject = the conversation) before anything is sent; the unique index lets
 * exactly one claim succeed. Each notice is tried once and a failure is
 * logged, not retried, so a partial success is never sent twice. Until
 * migration 0034 lets the outbox hold the kind, nothing is sent.
 */

const KIND = "late_introduction";
/** Entries created since then only (0078's own cut-off). */
export const LATE_INTRO_FROM = "2026-10-15T00:00:00.000Z";
/** Created this long after the label = made later, by 0078 — not at labelling. */
export const LATE_AFTER_MS = 2 * 60 * 1000;
const WINDOW_MS = 30 * 60 * 1000;

type Supabase = ReturnType<typeof getMasterInboxSupabase>;
type Row = Record<string, unknown>;

export interface Notices {
  notify: (threadIds: string[]) => Promise<unknown>;
  slack: (threadIds: string[]) => Promise<unknown>;
  fub: (threadIds: string[]) => Promise<unknown>;
}

const realNotices: Notices = {
  notify: (ids) => notifyIntroductionForThreads(ids, "inbox_label"),
  slack: (ids) => notifyPortalIntroductionForThreads(ids),
  fub: (ids) => pushIntroPipelineEntriesForThreadsToFub(ids),
};

/** Pure: is this entry one 0078 created after the fact? */
export function isLateEntry(e: { created_at: string | null; introduced_at: string | null }, labelledAt: string | null): boolean {
  if (!e.created_at || !e.introduced_at || !labelledAt) return false;
  if (Date.parse(e.introduced_at) !== Date.parse(labelledAt)) return false;
  if (Date.parse(e.created_at) < Date.parse(LATE_INTRO_FROM)) return false;
  return Date.parse(e.created_at) - Date.parse(e.introduced_at) > LATE_AFTER_MS;
}

export interface LateSweepResult {
  seen: number;
  notified: number;
  failed: string[];
  off: string | null;
}

export async function sweepLateIntroductions(
  now: Date = new Date(),
  deps: { sb?: Supabase; ws?: string; notices?: Notices } = {},
): Promise<LateSweepResult> {
  const result: LateSweepResult = { seen: 0, notified: 0, failed: [], off: null };
  if (process.env.OS_LATE_INTRO_NOTICES === "0") return { ...result, off: "OS_LATE_INTRO_NOTICES=0" };
  const notices = deps.notices ?? realNotices;
  try {
    const sb = deps.sb ?? getMasterInboxSupabase();
    const ws = deps.ws ?? (await workspaceId());
    const since = new Date(Math.max(now.getTime() - WINDOW_MS, Date.parse(LATE_INTRO_FROM))).toISOString();

    const { data: entries, error } = await sb
      .from("client_pipeline_entries")
      .select("thread_id, source, created_at, introduced_at")
      .gte("created_at", since)
      .not("thread_id", "is", null)
      .limit(500);
    if (error) throw new Error(`client_pipeline_entries: ${error.message}`);
    const candidates = ((entries ?? []) as Row[]).filter((e) => e.source !== "Client Entry" && e.thread_id);
    if (!candidates.length) return result;

    const { data: labels } = await sb.from("labels").select("id, name").eq("workspace_id", ws);
    const introIds = ((labels ?? []) as Row[]).filter((l) => String(l.name ?? "").trim().toLowerCase() === "introduction").map((l) => String(l.id));
    if (!introIds.length) return { ...result, off: "no Introduction label" };

    const threadIds = [...new Set(candidates.map((e) => String(e.thread_id)))];
    const { data: assigns, error: aErr } = await sb
      .from("label_assignments")
      .select("target_id, assigned_at")
      .eq("target_type", "thread")
      .in("label_id", introIds)
      .in("target_id", threadIds);
    if (aErr) throw new Error(`label_assignments: ${aErr.message}`);
    const labelledAt = new Map(((assigns ?? []) as Row[]).map((a) => [String(a.target_id), String(a.assigned_at)]));

    const late = candidates.filter((e) =>
      isLateEntry({ created_at: e.created_at as string | null, introduced_at: e.introduced_at as string | null }, labelledAt.get(String(e.thread_id)) ?? null),
    );
    result.seen = late.length;

    for (const e of late) {
      const threadId = String(e.thread_id);
      const { data: claimed, error: cErr } = await sb
        .from("side_effect_outbox")
        .upsert(
          { workspace_id: ws, kind: KIND, subject_id: threadId, payload: { thread_id: threadId, source: "late_introduction" }, status: "pending", claimed_at: now.toISOString() },
          { onConflict: "workspace_id,kind,subject_id", ignoreDuplicates: true },
        )
        .select("id");
      if (cErr) {
        // Before migration 0034 the outbox refuses the kind: send nothing at all.
        return { ...result, off: /check constraint|kind_check|violates/i.test(cErr.message) ? "migration 0034 has not been run" : `outbox: ${cErr.message}` };
      }
      if (!((claimed ?? []) as Row[]).length) continue; // already sent, by this or another sweep

      const errors: string[] = [];
      for (const [name, send] of [["text and Bison", notices.notify], ["Slack", notices.slack], ["Follow Up Boss", notices.fub]] as const) {
        try {
          await send([threadId]);
        } catch (err) {
          errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      result.notified++;
      if (errors.length) result.failed.push(`${threadId}: ${errors.join("; ")}`);
      await sb
        .from("side_effect_outbox")
        .update({ status: "done", completed_at: new Date().toISOString(), last_error: errors.length ? errors.join("; ").slice(0, 500) : null })
        .eq("workspace_id", ws).eq("kind", KIND).eq("subject_id", threadId);
    }
  } catch (err) {
    result.failed.push(err instanceof Error ? err.message : String(err));
  }
  return result;
}
