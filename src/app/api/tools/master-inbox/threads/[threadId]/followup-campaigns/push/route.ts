import { NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { createEmailBisonClient, EmailBisonError } from "@/lib/tools/master-inbox/emailbison/client";
import { syncThreadFollowup } from "@/lib/tools/master-inbox/inbox/followup-sync";

// POST /api/threads/[threadId]/followup-campaigns/push
// Body: { campaign_id: number }
//
// Pushes the thread's most recent inbound reply (and its lead) into the
// chosen reply_followup campaign. Mirrors the docs at
//   POST /api/replies/{reply_id}/followup-campaign/push
//
// Only valid for EmailBison threads. The reply_id used is the latest
// inbound's emailbison_reply_id — that matches the doc's caveat that
// EmailBison resumes the conversation "from the last sent reply".

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  campaign_id: z.number().int().positive(),
  force_add_reply: z.boolean().optional(),
});

export async function POST(
  request: Request,
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

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  // RLS gate.
  const { data: visible } = await userClient
    .from("threads")
    .select("id")
    .eq("id", threadId)
    .maybeSingle();
  if (!visible) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }

  const admin = createAdminSupabase();
  const { data: thread } = await admin
    .from("threads")
    .select("id, source_provider, channel_id")
    .eq("id", threadId)
    .maybeSingle();
  if (!thread) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }
  if (thread.source_provider !== "emailbison") {
    return NextResponse.json(
      { error: "Follow-up campaigns are only available for EmailBison threads." },
      { status: 400 },
    );
  }

  // Latest inbound reply id — EmailBison resumes from this point.
  const { data: lastInbound } = await admin
    .from("messages")
    .select("id, emailbison_reply_id")
    .eq("thread_id", threadId)
    .eq("direction", "inbound")
    .not("emailbison_reply_id", "is", null)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!lastInbound?.emailbison_reply_id) {
    return NextResponse.json(
      { error: "No inbound EmailBison reply found to push." },
      { status: 400 },
    );
  }

  // Resolve the EmailBison team to call against.
  let ebTeamId: number | null = null;
  if (thread.channel_id) {
    const { data: ch } = await admin
      .from("channels")
      .select("emailbison_team_id")
      .eq("id", thread.channel_id)
      .maybeSingle();
    ebTeamId = (ch?.emailbison_team_id as number | null) ?? null;
  }
  if (ebTeamId === null) {
    return NextResponse.json(
      { error: "This thread's channel isn't linked to an EmailBison team yet." },
      { status: 400 },
    );
  }

  let client;
  try {
    client = createEmailBisonClient();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "EmailBison not configured" },
      { status: 400 },
    );
  }

  try {
    await client.switchWorkspace(ebTeamId);
    const res = await client.pushReplyToFollowupCampaign(
      Number(lastInbound.emailbison_reply_id),
      {
        campaign_id: parsed.data.campaign_id,
        force_add_reply: parsed.data.force_add_reply,
      },
    );
    // Refresh the thread's cached followup state in the background so the
    // picker disables itself on the next render without waiting for the
    // 2h stale window.
    void syncThreadFollowup(threadId).catch(() => {});
    return NextResponse.json({
      ok: true,
      success: res.data?.success ?? false,
      message: res.data?.message ?? null,
    });
  } catch (err) {
    if (err instanceof EmailBisonError) {
      return NextResponse.json(
        { error: err.message, status: err.status, body: err.body },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "push failed" },
      { status: 502 },
    );
  }
}
