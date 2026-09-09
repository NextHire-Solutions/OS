import "server-only";

import { getMasterInboxSupabase, workspaceId } from "./supabase";
import { notifyIntroductionForThreads } from "./webhooks/n8n-introduction";
import { notifyPortalIntroductionForThreads } from "./webhooks/slack-portal";
import { pushIntroPipelineEntriesForThreadsToFub } from "./integrations/push-pipeline-entry";

/*
 * A durable queue for introduction side effects.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM
 *
 * Labelling a thread "Introduction" must reach n8n, Slack and Follow Up Boss.
 * The tool fires all three with Next's `after()` — after the response, in the
 * same process, with no queue and no retry. A deploy or a container move in
 * that split second loses them, silently: the introduction is in the database
 * and visible in the client's portal, but nobody was told.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE OF THE FIX
 *
 * Record the intent BEFORE attempting it, then attempt it. If the attempt is
 * lost, the record survives and the next sweep retries it.
 *
 *   enqueue()  writes three rows, then tries them immediately — so the common
 *              case is exactly as fast as before
 *   drain()    picks up whatever was left behind
 *
 * Two properties worth naming:
 *
 *   ENQUEUEING NEVER FAILS THE LABEL. If the outbox table is missing or the
 *   insert fails, the side effects still fire the old way. A reliability
 *   mechanism that can break the thing it protects is worse than none.
 *
 *   ONE JOB PER KIND PER SUBJECT, enforced by a unique index rather than by
 *   this code. Re-labelling a thread should not queue a second Slack notice
 *   for the same introduction.
 */

export type SideEffectKind = "n8n_introduction" | "slack_introduction" | "fub_push";

const KINDS: SideEffectKind[] = ["n8n_introduction", "slack_introduction", "fub_push"];

/** Attempts before a job is parked as failed rather than retried forever. */
const MAX_ATTEMPTS = 5;

/** A claim older than this is treated as abandoned — the worker died mid-flight. */
const CLAIM_STALE_MS = 5 * 60 * 1000;

/**
 * Queues the three introduction side effects for a thread, then runs them.
 *
 * Returns without throwing whatever happens: the caller has already applied
 * the label, and failing here would report an error for work that succeeded.
 */
export async function enqueueIntroduction(threadId: string): Promise<void> {
  try {
    const ws = await workspaceId();
    const sb = getMasterInboxSupabase();

    // `ignoreDuplicates` leans on the unique index: a re-label finds its rows
    // already present and adds nothing.
    await sb.from("side_effect_outbox").upsert(
      KINDS.map((kind) => ({
        workspace_id: ws,
        kind,
        subject_id: threadId,
        payload: { thread_id: threadId, source: "inbox_label" },
        status: "pending",
      })),
      { onConflict: "workspace_id,kind,subject_id", ignoreDuplicates: true },
    );
  } catch (error) {
    // The queue is the safety net, not the mechanism. If it is unavailable
    // the side effects below still run — they simply lose their retry.
    console.error("[outbox] could not enqueue; falling back to fire-and-forget", error);
  }

  // Attempt immediately, so behaviour matches the tool in the normal case.
  await runFor(threadId);
}

/**
 * Runs every pending job for one thread.
 *
 * Each kind is attempted independently: Slack being down must not stop the
 * Follow Up Boss push, which is the one with a client-visible consequence.
 */
async function runFor(threadId: string): Promise<void> {
  for (const kind of KINDS) {
    try {
      await attempt(kind, threadId);
      await markDone(kind, threadId);
    } catch (error) {
      await markFailed(kind, threadId, error);
    }
  }
}

/** The actual side effect. The tool's own functions, unchanged. */
async function attempt(kind: SideEffectKind, threadId: string): Promise<void> {
  switch (kind) {
    case "n8n_introduction":
      await notifyIntroductionForThreads([threadId], "inbox_label");
      return;
    case "slack_introduction":
      await notifyPortalIntroductionForThreads([threadId]);
      return;
    case "fub_push":
      // Already idempotent in the tool: it skips entries with fub_pushed_at
      // set, so a retry after a partial success is a no-op.
      await pushIntroPipelineEntriesForThreadsToFub([threadId]);
      return;
  }
}

async function markDone(kind: SideEffectKind, threadId: string): Promise<void> {
  try {
    const ws = await workspaceId();
    await getMasterInboxSupabase()
      .from("side_effect_outbox")
      .update({ status: "done", completed_at: new Date().toISOString(), last_error: null })
      .eq("workspace_id", ws)
      .eq("kind", kind)
      .eq("subject_id", threadId);
  } catch {
    /*
     * The work succeeded; only the bookkeeping failed. Swallowed on purpose —
     * the worst case is one duplicate retry later, and for all three of these
     * a duplicate is harmless: FUB is gated on fub_pushed_at, and a repeated
     * Slack or n8n notice is noise rather than damage.
     */
  }
}

async function markFailed(kind: SideEffectKind, threadId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[outbox] ${kind} failed for ${threadId}`, message);
  try {
    const ws = await workspaceId();
    const sb = getMasterInboxSupabase();
    const { data } = await sb
      .from("side_effect_outbox")
      .select("attempts")
      .eq("workspace_id", ws)
      .eq("kind", kind)
      .eq("subject_id", threadId)
      .maybeSingle();

    const attempts = Number((data as { attempts?: number } | null)?.attempts ?? 0) + 1;
    await sb
      .from("side_effect_outbox")
      .update({
        attempts,
        last_error: message.slice(0, 500),
        // Parked rather than retried forever: a job that has failed five times
        // is broken, and hammering a dead webhook helps nobody.
        status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
        claimed_at: null,
      })
      .eq("workspace_id", ws)
      .eq("kind", kind)
      .eq("subject_id", threadId);
  } catch {
    /* Nothing more to do — the console line above is the record. */
  }
}

export interface DrainResult {
  claimed: number;
  done: number;
  failed: number;
  error: string | null;
}

/**
 * Retries whatever was left behind.
 *
 * Called on a schedule. Claims a batch first so two overlapping runs do not
 * both send the same Slack notice, and treats a stale claim as abandoned —
 * the process that took it is gone.
 */
export async function drain(limit = 25): Promise<DrainResult> {
  const result: DrainResult = { claimed: 0, done: 0, failed: 0, error: null };

  try {
    const ws = await workspaceId();
    const sb = getMasterInboxSupabase();
    const staleBefore = new Date(Date.now() - CLAIM_STALE_MS).toISOString();

    const { data, error } = await sb
      .from("side_effect_outbox")
      .select("id, kind, subject_id, claimed_at")
      .eq("workspace_id", ws)
      .eq("status", "pending")
      .or(`claimed_at.is.null,claimed_at.lt.${staleBefore}`)
      .order("created_at")
      .limit(limit);

    if (error) throw new Error(error.message);

    const rows = (Array.isArray(data) ? data : []) as {
      id: string;
      kind: SideEffectKind;
      subject_id: string;
    }[];
    result.claimed = rows.length;
    if (rows.length === 0) return result;

    await sb
      .from("side_effect_outbox")
      .update({ claimed_at: new Date().toISOString() })
      .in("id", rows.map((r) => r.id));

    for (const row of rows) {
      try {
        await attempt(row.kind, row.subject_id);
        await markDone(row.kind, row.subject_id);
        result.done += 1;
      } catch (e) {
        await markFailed(row.kind, row.subject_id, e);
        result.failed += 1;
      }
    }

    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : "The outbox could not be drained";
    return result;
  }
}

export interface OutboxHealth {
  pending: number;
  failed: number;
  oldestPending: string | null;
  available: boolean;
  error: string | null;
}

/**
 * What is waiting, and what has given up.
 *
 * `available: false` means the table is not there yet — the workspace still
 * works, it simply has no retry, which is exactly the tool's behaviour.
 */
export async function outboxHealth(): Promise<OutboxHealth> {
  const empty: OutboxHealth = {
    pending: 0, failed: 0, oldestPending: null, available: false, error: null,
  };

  try {
    const ws = await workspaceId();
    const sb = getMasterInboxSupabase();

    const [pending, failed, oldest] = await Promise.all([
      sb.from("side_effect_outbox").select("id", { count: "exact", head: true })
        .eq("workspace_id", ws).eq("status", "pending"),
      sb.from("side_effect_outbox").select("id", { count: "exact", head: true })
        .eq("workspace_id", ws).eq("status", "failed"),
      sb.from("side_effect_outbox").select("created_at")
        .eq("workspace_id", ws).eq("status", "pending")
        .order("created_at").limit(1).maybeSingle(),
    ]);

    if (pending.error) throw new Error(pending.error.message);

    return {
      pending: pending.count ?? 0,
      failed: failed.count ?? 0,
      oldestPending: (oldest.data as { created_at?: string } | null)?.created_at ?? null,
      available: true,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The outbox could not be read";
    // A missing table is not a fault — it is the un-migrated state.
    if (/side_effect_outbox|schema cache|does not exist/i.test(message)) return empty;
    return { ...empty, error: message };
  }
}
