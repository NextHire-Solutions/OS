import { NextResponse } from "next/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { resolvePortalClient } from "@/lib/tools/master-inbox/portals/token";
import { fetchAllRows } from "@/lib/tools/master-inbox/db/paginated-select";

// GET /api/portal/[token]/conversation/[entryId]
//
// Read-only conversation feed for one pipeline candidate. Returns the
// email back-and-forth on the entry's thread so the brokerage can
// see what was said without exposing the staff MasterInbox.
//
// Token-in-path IS the credential (same model as every other
// /api/portal/<token>/* route). The entry id is then validated to
// belong to the resolved client; otherwise we 404 so cross-client
// id-guessing surfaces nothing.

export const dynamic = "force-dynamic";

type ConversationMessage = {
  id: string;
  direction: "inbound" | "outbound";
  sender: string | null;
  sender_name: string | null;
  recipients: Record<string, unknown>;
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
  sent_at: string | null;
};

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string; entryId: string }> },
) {
  const { token, entryId } = await context.params;
  const client = await resolvePortalClient(token);
  if (!client) {
    return NextResponse.json({ error: "Portal not found" }, { status: 404 });
  }

  const admin = createAdminSupabase();

  // Resolve the pipeline entry, scoped to this client. A row that
  // belongs to a different client surfaces as 404 — never leak
  // entry existence cross-client.
  const { data: entry } = await admin
    .from("client_pipeline_entries")
    .select("id, thread_id, lead_name, lead_email")
    .eq("id", entryId)
    .eq("client_id", client.id)
    .maybeSingle();
  if (!entry) {
    return NextResponse.json({ error: "Entry not found" }, { status: 404 });
  }
  if (!entry.thread_id) {
    return NextResponse.json({
      ok: true,
      messages: [],
      lead_name: (entry.lead_name as string | null) ?? null,
      lead_email: (entry.lead_email as string | null) ?? null,
      reason: "no_thread",
    });
  }

  // Load every message on this thread, oldest first — reading the
  // conversation chronologically is what most operators want, and
  // it matches how the lead saw it land in their inbox.
  const messages = await fetchAllRows<ConversationMessage>(({ from, to }) =>
    admin
      .from("messages")
      .select(
        "id, direction, sender, sender_name, recipients, subject, body_html, body_text, sent_at",
      )
      .eq("thread_id", entry.thread_id as string)
      .order("sent_at", { ascending: true })
      .range(from, to),
  );

  return NextResponse.json({
    ok: true,
    messages,
    lead_name: (entry.lead_name as string | null) ?? null,
    lead_email: (entry.lead_email as string | null) ?? null,
  });
}
