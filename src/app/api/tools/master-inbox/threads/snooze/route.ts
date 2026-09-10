import { NextResponse } from "next/server";
import { z } from "zod";
import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";

// Snoozes (or un-snoozes) a thread. POST body:
//   { remind_at: ISO-8601 string }   -> create reminder + thread.status='reminder'
//   { dismiss: true }                -> drop active reminder + thread.status='open'

export const dynamic = "force-dynamic";

const snoozeSchema = z.object({
  remind_at: z.string().datetime(),
  note: z.string().max(500).optional(),
});

const dismissSchema = z.object({ dismiss: z.literal(true) });

export async function POST(request: Request) {
  const threadId = new URL(request.url).searchParams.get("threadId") ?? "";
  if (!threadId) {
    return NextResponse.json({ error: "threadId is required" }, { status: 400 });
  }

  // Membership check via user-scoped client.
  const supabase = getMasterInboxSupabase();
  const { data: thread } = await supabase
    .from("threads")
    .select("id, workspace_id")
    .eq("id", threadId)
    .maybeSingle();
  if (!thread) return NextResponse.json({ error: "Thread not found" }, { status: 404 });

  const body = await request.json().catch(() => null);
  const admin = getMasterInboxSupabase();

  // Dismiss path: cancel any active reminder and put the thread back in inbox.
  const dismissParse = dismissSchema.safeParse(body);
  if (dismissParse.success) {
    await admin
      .from("reminders")
      .update({ status: "dismissed" })
      .eq("thread_id", threadId)
      .eq("status", "pending");
    await admin.from("threads").update({ status: "open" }).eq("id", threadId);
    return NextResponse.json({ ok: true, dismissed: true });
  }

  // Snooze path: insert a pending reminder + flip thread status.
  const parsed = snoozeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  // Cancel any prior pending reminder so the new one is the only active.
  await admin
    .from("reminders")
    .update({ status: "dismissed" })
    .eq("thread_id", threadId)
    .eq("status", "pending");
  await admin.from("reminders").insert({
    workspace_id: thread.workspace_id,
    thread_id: threadId,
    user_id: null,
    remind_at: parsed.data.remind_at,
    note: parsed.data.note ?? null,
    status: "pending",
  });
  await admin.from("threads").update({ status: "reminder" }).eq("id", threadId);

  return NextResponse.json({ ok: true, remind_at: parsed.data.remind_at });
}
