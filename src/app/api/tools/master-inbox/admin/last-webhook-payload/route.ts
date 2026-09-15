import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/workspace";
import { createAdminSupabase } from "@/lib/supabase/admin";

// Returns the raw_payload + stored sender of the most recent inbound message
// in the active workspace. Used for debugging sender-resolution: see exactly
// what shape the EmailBison webhook delivered.

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await requireSession();
  const admin = createAdminSupabase();

  const wsId = session.activeWorkspace.id;
  const [inbound, outbound] = await Promise.all([
    admin
      .from("messages")
      .select("id, direction, sender, recipients, subject, sent_at, raw_payload, thread_id, external_message_id")
      .eq("workspace_id", wsId)
      .eq("direction", "inbound")
      .order("sent_at", { ascending: false })
      .limit(2),
    admin
      .from("messages")
      .select("id, direction, sender, recipients, subject, sent_at, raw_payload, thread_id, external_message_id")
      .eq("workspace_id", wsId)
      .eq("direction", "outbound")
      .order("sent_at", { ascending: false })
      .limit(3),
  ]);

  // Aggregate sender-null counts so we can quickly see how widespread the
  // problem is.
  const { count: outboundTotal } = await admin
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", wsId)
    .eq("direction", "outbound");
  const { count: outboundWithSender } = await admin
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", wsId)
    .eq("direction", "outbound")
    .not("sender", "is", null);

  return NextResponse.json({
    counts: {
      outbound_total: outboundTotal ?? 0,
      outbound_with_sender: outboundWithSender ?? 0,
      outbound_missing_sender: (outboundTotal ?? 0) - (outboundWithSender ?? 0),
    },
    inbound: inbound.data,
    outbound: outbound.data,
  });
}
