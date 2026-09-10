import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { syncThreadFollowup } from "@/lib/tools/master-inbox/inbox/followup-sync";

// GET /api/threads/[threadId]/followup-status
//
// Reports whether this thread's lead is currently in (or was previously
// in) an EmailBison reply_followup campaign. Reads the cached columns on
// the thread (migration 0029) so the panel is instant; refreshes from
// EmailBison in the background when stale. Falls back to a live sync
// when never synced.
//
// Parallel to /api/threads/[threadId]/subsequence-status for the
// Instantly side.

export const dynamic = "force-dynamic";

// How long a cached value is trusted before a background refresh.
const STALE_MS = 2 * 60 * 60 * 1000;

export async function GET(
  _request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await context.params;

  const userClient = await createServerSupabase();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  // RLS-scoped visibility check — only workspace members can see this
  // thread, so we can safely return the cached follow-up state.
  const { data: visible } = await userClient
    .from("threads")
    .select("id")
    .eq("id", threadId)
    .maybeSingle();
  if (!visible) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }

  const admin = createAdminSupabase();
  // select("*") so this still works before migration 0029 lands.
  const { data: thread } = await admin
    .from("threads")
    .select("*")
    .eq("id", threadId)
    .maybeSingle();
  if (!thread) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }
  if (thread.source_provider !== "emailbison") {
    return NextResponse.json({ ok: true, status: "none" });
  }

  const syncedAt = thread.followup_synced_at as string | null | undefined;

  // Cached → return immediately; kick a background refresh if stale.
  if (syncedAt) {
    if (Date.now() - new Date(syncedAt).getTime() > STALE_MS) {
      void syncThreadFollowup(threadId).catch(() => {});
    }
    return NextResponse.json({
      ok: true,
      status: ((thread.followup_status as string | null) ?? "none") as
        | "active"
        | "past"
        | "none",
      campaignId: (thread.followup_campaign_id as number | null) ?? null,
      campaignName: (thread.followup_campaign_name as string | null) ?? null,
      nextScheduledAt: (thread.followup_next_scheduled as string | null) ?? null,
    });
  }

  // Never synced (or pre-migration) → do it live this once.
  try {
    const state = await syncThreadFollowup(threadId);
    return NextResponse.json({
      ok: true,
      status: state.status,
      campaignId: state.campaignId,
      campaignName: state.campaignName,
      nextScheduledAt: state.nextScheduledAt,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "lookup failed" },
      { status: 502 },
    );
  }
}
