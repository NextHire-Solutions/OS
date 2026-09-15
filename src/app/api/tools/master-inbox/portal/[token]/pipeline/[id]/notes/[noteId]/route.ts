import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { resolvePortalClient } from "@/lib/tools/master-inbox/portals/token";

// PATCH /api/portal/[token]/pipeline/[id]/notes/[noteId]  → edit body
// DELETE /api/portal/[token]/pipeline/[id]/notes/[noteId] → remove
//
// Both verify the note → entry → client linkage to keep portal access
// strictly scoped.

export const dynamic = "force-dynamic";

const editSchema = z.object({ body: z.string().min(1).max(20_000) });

async function authorize(token: string, entryId: string, noteId: string) {
  const client = await resolvePortalClient(token);
  if (!client) return { error: NextResponse.json({ error: "Portal not found" }, { status: 404 }) };
  const admin = createAdminSupabase();
  const { data: note } = await admin
    .from("client_pipeline_notes")
    .select("id, entry_id, client_pipeline_entries!inner(client_id)")
    .eq("id", noteId)
    .eq("entry_id", entryId)
    .maybeSingle();
  const entryClient = (note as {
    client_pipeline_entries?: { client_id: string } | { client_id: string }[] | null;
  } | null)?.client_pipeline_entries;
  const clientId = Array.isArray(entryClient) ? entryClient[0]?.client_id : entryClient?.client_id;
  if (!note || clientId !== client.id) {
    return { error: NextResponse.json({ error: "Note not found" }, { status: 404 }) };
  }
  return { admin };
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ token: string; id: string; noteId: string }> },
) {
  const { token, id, noteId } = await context.params;
  const auth = await authorize(token, id, noteId);
  if ("error" in auth) return auth.error;

  const parsed = editSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  const { error } = await auth.admin
    .from("client_pipeline_notes")
    .update({ body: parsed.data.body.trim(), updated_at: new Date().toISOString() })
    .eq("id", noteId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ token: string; id: string; noteId: string }> },
) {
  const { token, id, noteId } = await context.params;
  const auth = await authorize(token, id, noteId);
  if ("error" in auth) return auth.error;

  const { error } = await auth.admin
    .from("client_pipeline_notes")
    .delete()
    .eq("id", noteId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
