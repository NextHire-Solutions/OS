import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/workspace";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { loadAgents, loadAgentWithKey, createDraftForAgent } from "@/lib/tools/master-inbox/ai/agent";

// On-demand draft generation: when the user clicks "AI Reply" in the
// composer we pick the first matching active agent (channel + filter)
// and generate a draft. Persists to reply_drafts AND returns the body
// so the composer can update its textarea immediately without waiting
// for the realtime refresh.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  _request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await context.params;
  const session = await requireSession();
  const admin = createAdminSupabase();

  const { data: thread } = await admin
    .from("threads")
    .select("id, workspace_id, subject, channel_id, lead_id")
    .eq("id", threadId)
    .eq("workspace_id", session.activeWorkspace.id)
    .maybeSingle();
  if (!thread) return NextResponse.json({ error: "Thread not found" }, { status: 404 });

  // Pull the FULL conversation (both directions), oldest → newest. The
  // last inbound entry is what we're replying to; everything before it
  // gives the model the context of prior exchanges.
  const { data: allMessages } = await admin
    .from("messages")
    .select("id, direction, sender, subject, body_text, body_html, sent_at, raw_payload")
    .eq("thread_id", threadId)
    .order("sent_at", { ascending: true });

  const lastInbound = [...(allMessages ?? [])].reverse().find((m) => m.direction === "inbound");
  if (!lastInbound) {
    return NextResponse.json(
      { error: "No inbound message on this thread to draft against." },
      { status: 400 },
    );
  }

  // Find the active agent that matches this thread's channel type.
  const channelType = "email" as const;
  const candidate = (await loadAgents(session.activeWorkspace.id))
    .filter((a) => a.active)
    .filter((a) => a.channel_filter === "both" || a.channel_filter === channelType)
    .filter((a) => {
      if (a.channel_ids.length === 0) return true;
      return thread.channel_id ? a.channel_ids.includes(thread.channel_id) : false;
    })
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))[0];

  if (!candidate) {
    return NextResponse.json(
      { error: "No active Reply Agent matches this thread. Create one in Settings → Reply Agents." },
      { status: 400 },
    );
  }

  const full = await loadAgentWithKey(candidate.id);
  if (!full || !full.api_key) {
    return NextResponse.json(
      { error: `Agent "${candidate.name}" has no API key configured.` },
      { status: 400 },
    );
  }

  // Lead context.
  const { data: lead } = await admin
    .from("leads")
    .select("full_name, email")
    .eq("id", thread.lead_id)
    .maybeSingle();

  const payload = (lastInbound.raw_payload ?? {}) as Record<string, unknown>;
  const data = (payload.data as Record<string, unknown> | undefined) ?? payload;
  const senderEmail =
    (data?.sender_email as { email?: string; name?: string } | undefined) ?? undefined;

  const stripHtml = (html: string) =>
    html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();

  // Build the conversation transcript for the agent. Strip HTML for any
  // turn that lacks a plain-text body. Empty turns are kept so numbering
  // stays consistent with what's visible in the thread view.
  const conversation = (allMessages ?? []).map((m) => ({
    direction: m.direction as "inbound" | "outbound",
    sentAt: (m.sent_at as string | null) ?? null,
    body: (m.body_text as string | null) ?? stripHtml((m.body_html as string | null) ?? ""),
  }));

  const result = await createDraftForAgent({
    workspaceId: session.activeWorkspace.id,
    threadId,
    agent: full,
    leadName: lead?.full_name ?? null,
    leadEmail: lead?.email ?? null,
    ourName: senderEmail?.name ?? null,
    ourEmail: senderEmail?.email ?? null,
    subject: lastInbound.subject ?? thread.subject,
    conversation,
  });

  switch (result.status) {
    case "ok":
      return NextResponse.json({
        draft_id: result.draftId,
        agent_id: candidate.id,
        agent_name: candidate.name,
        body: result.body,
      });
    case "no_key":
      return NextResponse.json(
        { error: `Agent "${candidate.name}" has no API key configured.` },
        { status: 400 },
      );
    case "insert_failed":
      return NextResponse.json(
        { error: `Could not save draft: ${result.error}` },
        { status: 500 },
      );
    case "ai_failed":
      return NextResponse.json(
        { error: `Provider error: ${result.error}` },
        { status: 502 },
      );
  }
}
