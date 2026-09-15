import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/workspace";
import { createAdminSupabase } from "@/lib/supabase/admin";

// Dump every outbound row with sender=null along with its raw_payload,
// thread + channel info. Used to figure out why a row can't be resolved.

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await requireSession();
  const admin = createAdminSupabase();

  const { data: rows, error } = await admin
    .from("messages")
    .select(
      `id, external_message_id, thread_id, raw_payload,
       threads:thread_id(
         channel_id, outbound_sender_email,
         channels:channel_id(emailbison_sender_email_id, display_name)
       )`,
    )
    .eq("workspace_id", session.activeWorkspace.id)
    .eq("direction", "outbound")
    .is("sender", null)
    .limit(30);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Sibling inbound check per thread.
  const threadIds = Array.from(new Set((rows ?? []).map((r) => r.thread_id as string)));
  const siblingMap = new Map<string, string | null>();
  if (threadIds.length > 0) {
    const { data: siblings } = await admin
      .from("messages")
      .select("thread_id, raw_payload")
      .in("thread_id", threadIds)
      .eq("direction", "inbound")
      .limit(threadIds.length * 2);
    for (const s of siblings ?? []) {
      const tid = s.thread_id as string;
      if (siblingMap.has(tid)) continue;
      const payload = (s.raw_payload ?? {}) as Record<string, unknown>;
      siblingMap.set(tid, (payload.primary_to_email_address as string) ?? null);
    }
  }

  return NextResponse.json({
    count: rows?.length ?? 0,
    rows: (rows ?? []).map((r) => {
      const thread = Array.isArray(r.threads) ? r.threads[0] : r.threads;
      const channel = Array.isArray(thread?.channels) ? thread.channels[0] : thread?.channels;
      return {
        message_id: r.id,
        external_message_id: r.external_message_id,
        thread_id: r.thread_id,
        thread_outbound_sender_email: thread?.outbound_sender_email ?? null,
        channel_display_name: channel?.display_name ?? null,
        channel_emailbison_sender_email_id: channel?.emailbison_sender_email_id ?? null,
        sibling_inbound_primary_to: siblingMap.get(r.thread_id as string) ?? null,
        raw_payload: r.raw_payload,
      };
    }),
  });
}
