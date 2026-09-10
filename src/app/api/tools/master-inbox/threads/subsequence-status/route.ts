import { NextResponse } from "next/server";
import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";
import { syncThreadSubsequence } from "@/lib/tools/master-inbox/inbox/subsequence-sync";

// GET /api/threads/[threadId]/subsequence-status
//
// Reports whether this thread's lead is currently in an Instantly
// subsequence. Reads the cached columns on the thread (migration 0021)
// so the panel is instant; refreshes from Instantly in the background
// when the cache is stale. Falls back to a live sync when never synced.

export const dynamic = "force-dynamic";

// How long a cached value is trusted before a background refresh.
const STALE_MS = 2 * 60 * 60 * 1000;

export async function GET(request: Request) {
  const threadId = new URL(request.url).searchParams.get("threadId") ?? "";
  if (!threadId) {
    return NextResponse.json({ error: "threadId is required" }, { status: 400 });
  }

  const userClient = getMasterInboxSupabase();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const { data: visible } = await userClient
    .from("threads")
    .select("id")
    .eq("id", threadId)
    .maybeSingle();
  if (!visible) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }

  const admin = getMasterInboxSupabase();
  // select("*") so this still works before migration 0021 lands.
  const { data: thread } = await admin
    .from("threads")
    .select("*")
    .eq("id", threadId)
    .maybeSingle();
  if (!thread) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }
  if (thread.source_provider !== "instantly") {
    return NextResponse.json({ ok: true, inSubsequence: false });
  }

  const syncedAt = thread.subsequence_synced_at as string | null | undefined;

  // Cached → return immediately; kick a background refresh if stale.
  if (syncedAt) {
    if (Date.now() - new Date(syncedAt).getTime() > STALE_MS) {
      void syncThreadSubsequence(threadId).catch(() => {});
    }
    return NextResponse.json({
      ok: true,
      inSubsequence: Boolean(thread.subsequence_id),
      subsequenceId: (thread.subsequence_id as string | null) ?? null,
      name: (thread.subsequence_name as string | null) ?? null,
      addedAt: (thread.subsequence_added_at as string | null) ?? null,
    });
  }

  // Never synced (or pre-migration) → do it live this once.
  try {
    const state = await syncThreadSubsequence(threadId);
    return NextResponse.json({
      ok: true,
      inSubsequence: state.inSubsequence,
      subsequenceId: state.subsequenceId,
      name: state.name,
      addedAt: state.addedAt,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "lookup failed" },
      { status: 502 },
    );
  }
}
