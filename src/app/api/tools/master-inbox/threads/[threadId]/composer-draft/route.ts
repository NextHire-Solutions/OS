import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/workspace";
import { createServerSupabase } from "@/lib/supabase/server";

// Composer auto-save endpoint.
//
// PUT    — upsert the current composer state (subject, body, cc/bcc,
//          channel choice, signature toggle). Called every ~1.2s by
//          the composer's debounced save effect, AND on component
//          unmount via navigator.sendBeacon so leaving the thread
//          mid-typing still persists.
// DELETE — discard the draft on this thread. Used by the explicit
//          "Discard draft" button and (separately) by the reply
//          route after a successful send so the draft doesn't
//          linger.
//
// Both handlers are workspace-scoped via requireSession() — the
// upsert/delete WHERE clauses additionally pin workspace_id so a
// crafted threadId can't reach into another workspace's drafts.
//
// Failures here are intentionally non-fatal at the client level:
// the composer surfaces them as a silent "Save failed" indicator
// rather than blocking the user from continuing to type.

export const dynamic = "force-dynamic";

// Subset of composer fields we persist. Everything is optional —
// the table allows nulls — but we cap each text field defensively
// so a runaway editor state can't try to write a 50MB row. body_html
// gets the largest cap because rich-text HTML balloons quickly with
// embedded images / nested blockquotes (~5MB is comfortably above
// "normal" while still being a hard wall).
const putSchema = z.object({
  subject: z.string().max(2_000).nullable().optional(),
  body_html: z.string().max(5_000_000).nullable().optional(),
  body_text: z.string().max(1_000_000).nullable().optional(),
  to_addresses: z.string().max(8_000).nullable().optional(),
  cc_addresses: z.string().max(8_000).nullable().optional(),
  bcc_addresses: z.string().max(8_000).nullable().optional(),
  selected_channel_id: z.string().uuid().nullable().optional(),
  add_signature: z.boolean().optional(),
});

export async function PUT(
  request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await context.params;
  // sendBeacon ships application/json bodies as Blobs — both fetch
  // and beacon serialise the same way, so request.json() handles
  // either source transparently.
  const session = await requireSession();
  const body = await request.json().catch(() => null);
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const supabase = await createServerSupabase();
  const row = {
    workspace_id: session.activeWorkspace.id,
    thread_id: threadId,
    subject: parsed.data.subject ?? null,
    body_html: parsed.data.body_html ?? null,
    body_text: parsed.data.body_text ?? null,
    to_addresses: parsed.data.to_addresses ?? null,
    cc_addresses: parsed.data.cc_addresses ?? null,
    bcc_addresses: parsed.data.bcc_addresses ?? null,
    selected_channel_id: parsed.data.selected_channel_id ?? null,
    add_signature: parsed.data.add_signature ?? true,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase
    .from("composer_drafts")
    .upsert(row, { onConflict: "workspace_id,thread_id" });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, saved_at: row.updated_at });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await context.params;
  const session = await requireSession();
  const supabase = await createServerSupabase();
  const { error } = await supabase
    .from("composer_drafts")
    .delete()
    .eq("workspace_id", session.activeWorkspace.id)
    .eq("thread_id", threadId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
