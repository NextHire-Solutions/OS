import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/workspace";
import { createAdminSupabase } from "@/lib/supabase/admin";

// Returns the most recent inbound message on a thread along with its
// raw_payload so we can see exactly which fields are present and where
// sender_email_id actually lives.

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await context.params;
  await requireSession();
  const admin = createAdminSupabase();

  const { data: row, error } = await admin
    .from("messages")
    .select("id, sent_at, sender, recipients, raw_payload, emailbison_reply_id")
    .eq("thread_id", threadId)
    .eq("direction", "inbound")
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "No inbound found" }, { status: 404 });

  // Walk the raw_payload and surface every place sender_email_id could
  // legitimately live, so the caller can confirm exactly which key path
  // EmailBison uses for this delivery.
  const p = (row.raw_payload ?? {}) as Record<string, unknown>;
  const data = (p.data as Record<string, unknown> | undefined) ?? p;
  const reply = (data.reply as Record<string, unknown> | undefined) ?? data;
  const dataSenderEmail = data.sender_email as { id?: number; email?: string } | undefined;
  const replySenderEmail = reply.sender_email as { id?: number; email?: string } | undefined;

  return NextResponse.json({
    message_id: row.id,
    emailbison_reply_id: row.emailbison_reply_id,
    payload_kind: p.event ? "envelope" : "bare_reply",
    payload_top_level_keys: Object.keys(p),
    candidates: {
      "reply.sender_email_id (top)":
        typeof p.sender_email_id === "number" ? p.sender_email_id : null,
      "reply.sender_email.id (top)": (p.sender_email as { id?: number } | undefined)?.id ?? null,
      "data.reply.sender_email_id":
        typeof reply.sender_email_id === "number" ? reply.sender_email_id : null,
      "data.reply.sender_email.id": replySenderEmail?.id ?? null,
      "data.sender_email.id": dataSenderEmail?.id ?? null,
    },
    raw_payload: row.raw_payload,
  });
}
