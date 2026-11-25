import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";

/*
 * Snooze / un-snooze one inbox thread — the inbox's Snooze (threads/snooze POST), moved here unchanged on 25 Nov so the
 * Claude connector's inbox_snooze runs exactly the same code. Snooze: any earlier pending reminder is dismissed, one new
 * pending reminder (with its optional note) is added, and the thread's status becomes "reminder". Un-snooze: the pending
 * reminder is dismissed and the thread goes back to "open". Nothing leaves the OS.
 */
export type SnoozeResult = { ok: true; remind_at?: string; dismissed?: true } | { ok: false; status: number; error: string };

async function threadOf(threadId: string): Promise<{ id: string; workspace_id: string } | null> {
  const { data: thread } = await getMasterInboxSupabase().from("threads").select("id, workspace_id").eq("id", threadId).maybeSingle();
  return (thread as { id: string; workspace_id: string } | null) ?? null;
}

export async function unsnoozeThread(threadId: string): Promise<SnoozeResult> {
  const thread = await threadOf(threadId);
  if (!thread) return { ok: false, status: 404, error: "Thread not found" };
  const admin = getMasterInboxSupabase();
  await admin.from("reminders").update({ status: "dismissed" }).eq("thread_id", threadId).eq("status", "pending");
  await admin.from("threads").update({ status: "open" }).eq("id", threadId);
  return { ok: true, dismissed: true };
}

export async function snoozeThread(threadId: string, remindAt: string, note: string | null): Promise<SnoozeResult> {
  const thread = await threadOf(threadId);
  if (!thread) return { ok: false, status: 404, error: "Thread not found" };
  const admin = getMasterInboxSupabase();
  // Cancel any prior pending reminder so the new one is the only active.
  await admin.from("reminders").update({ status: "dismissed" }).eq("thread_id", threadId).eq("status", "pending");
  await admin.from("reminders").insert({
    workspace_id: thread.workspace_id,
    thread_id: threadId,
    user_id: null,
    remind_at: remindAt,
    note,
    status: "pending",
  });
  await admin.from("threads").update({ status: "reminder" }).eq("id", threadId);
  return { ok: true, remind_at: remindAt };
}
