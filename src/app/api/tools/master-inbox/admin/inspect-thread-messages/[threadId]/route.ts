import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/workspace";
import { createAdminSupabase } from "@/lib/supabase/admin";

// Dump every message on a thread along with the dedupe keys we use, so we
// can see why two rows for the same email aren't collapsing.

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await context.params;
  await requireSession();
  const admin = createAdminSupabase();

  const { data: rows, error } = await admin
    .from("messages")
    .select(
      "id, direction, sender, sent_at, external_message_id, emailbison_reply_id, body_text, raw_payload",
    )
    .eq("thread_id", threadId)
    .order("sent_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    count: rows?.length ?? 0,
    messages: (rows ?? []).map((m) => {
      const p = (m.raw_payload ?? {}) as Record<string, unknown>;
      const data = (p.data as Record<string, unknown> | undefined) ?? p;
      const reply = (data?.reply as Record<string, unknown> | undefined) ?? data;
      const replyId =
        typeof reply?.id === "number" ? (reply.id as number) : null;
      const rawMessageId =
        typeof reply?.raw_message_id === "string"
          ? (reply.raw_message_id as string)
          : null;
      return {
        id: m.id,
        direction: m.direction,
        sender: m.sender,
        sent_at: m.sent_at,
        external_message_id: m.external_message_id,
        emailbison_reply_id: m.emailbison_reply_id,
        body_preview: (m.body_text ?? "").trim().slice(0, 80),
        payload_reply_id: replyId,
        payload_raw_message_id: rawMessageId,
      };
    }),
  });
}
