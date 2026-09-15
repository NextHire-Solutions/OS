import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/workspace";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { labelInboundMessage } from "@/lib/tools/master-inbox/ai/run";

// Force-re-runs AI labeling on a single thread's most recent inbound and
// returns the discriminated result so we can see WHY a thread isn't
// labeled (model returned NONE / mismatched label name / etc.).

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  _request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await context.params;
  const session = await requireSession();
  const admin = createAdminSupabase();

  // Verify the thread belongs to this workspace.
  const { data: thread } = await admin
    .from("threads")
    .select("id, subject")
    .eq("id", threadId)
    .eq("workspace_id", session.activeWorkspace.id)
    .maybeSingle();
  if (!thread) return NextResponse.json({ error: "Thread not found" }, { status: 404 });

  const { data: msg } = await admin
    .from("messages")
    .select("id, subject, body_text, body_html, sender")
    .eq("thread_id", threadId)
    .eq("direction", "inbound")
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!msg) return NextResponse.json({ error: "No inbound on thread" }, { status: 404 });

  const result = await labelInboundMessage({
    workspaceId: session.activeWorkspace.id,
    threadId,
    messageId: msg.id,
    subject: msg.subject ?? thread.subject,
    bodyText: msg.body_text,
    bodyHtml: msg.body_html,
    force: true,
  });

  return NextResponse.json({
    thread_id: threadId,
    inbound_message_id: msg.id,
    inbound_sender: msg.sender,
    result,
  });
}
