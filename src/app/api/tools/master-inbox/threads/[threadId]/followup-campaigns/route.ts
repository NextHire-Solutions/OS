import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { createEmailBisonClient, EmailBisonError } from "@/lib/tools/master-inbox/emailbison/client";

// GET /api/threads/[threadId]/followup-campaigns
//
// Returns every campaign of type "reply_followup" the EmailBison team this
// thread belongs to can see. Walks ALL pages of the /campaigns endpoint up
// front so the picker doesn't have to deal with pagination — the catalog
// is small (low dozens today, hundreds at most), so a one-shot walk is
// cheaper than streaming.
//
// Only available for threads sourced from EmailBison — Instantly threads
// have a separate "Add to subsequence" picker.

export const dynamic = "force-dynamic";

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

  // RLS check — only members of the thread's workspace can see it.
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

  // Resolve the EmailBison team this thread's channel is pinned to —
  // brokerstaffer.com runs multiple teams under one workspace, so we can't
  // just default to the API key's home team.
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
      {
        error:
          "This thread's channel isn't linked to an EmailBison team yet. Wait for the next inbound reply on this sender, or re-register the webhook.",
      },
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
    const all = await client.listAllCampaigns();
    // Filter to reply_followup only — these are the campaigns this picker
    // is for. EmailBison's `type` enum is "outbound" | "reply_followup".
    const followups = all
      .filter((c) => c.type === "reply_followup")
      .map((c) => ({ id: c.id, name: c.name, status: c.status ?? null }));
    return NextResponse.json({ ok: true, items: followups });
  } catch (err) {
    if (err instanceof EmailBisonError) {
      return NextResponse.json(
        { error: err.message, status: err.status, body: err.body },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "listAllCampaigns failed" },
      { status: 502 },
    );
  }
}
