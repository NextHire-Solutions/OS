import { NextResponse } from "next/server";
import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";
import { createInstantlyClient, InstantlyError } from "@/lib/tools/master-inbox/instantly/client";

// GET /api/threads/[threadId]/subsequences
//
// Lists the Instantly subsequences for this thread's campaign. Only works
// for threads sourced from Instantly — returns 400 otherwise. The dropdown
// in the ProspectPanel calls this lazily when the user clicks the
// "Add to subsequence" button.

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const threadId = new URL(request.url).searchParams.get("threadId") ?? "";
  if (!threadId) {
    return NextResponse.json({ error: "threadId is required" }, { status: 400 });
  }

  // RLS check: only members of the thread's workspace can see it.
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
  const { data: thread } = await admin
    .from("threads")
    .select("id, source_provider, campaign_id")
    .eq("id", threadId)
    .maybeSingle();
  if (!thread) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }
  if (thread.source_provider !== "instantly") {
    return NextResponse.json(
      { error: "Subsequences are only available for Instantly threads." },
      { status: 400 },
    );
  }
  if (!thread.campaign_id) {
    return NextResponse.json(
      { error: "This thread has no campaign — cannot list subsequences." },
      { status: 400 },
    );
  }

  try {
    const client = createInstantlyClient();
    const res = await client.listSubsequences(thread.campaign_id);
    const items = (res.items ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status ?? null,
    }));
    return NextResponse.json({ ok: true, items });
  } catch (err) {
    if (err instanceof InstantlyError) {
      return NextResponse.json(
        { error: err.message, status: err.status, body: err.body },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "listSubsequences failed" },
      { status: 502 },
    );
  }
}
