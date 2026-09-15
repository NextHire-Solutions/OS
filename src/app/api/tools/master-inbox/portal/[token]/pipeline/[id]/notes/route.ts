import { NextResponse, after } from "next/server";
import { z } from "zod";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { resolvePortalClient } from "@/lib/tools/master-inbox/portals/token";
import { notifyPortalNoteAdded } from "@/lib/tools/master-inbox/webhooks/slack-portal";

// POST /api/portal/[token]/pipeline/[id]/notes  → append a note
// Body: { body: string }
//
// Notes per pipeline entry are append-only from the portal side; the
// individual note endpoint handles edit/delete.

export const dynamic = "force-dynamic";

const schema = z.object({ body: z.string().min(1).max(20_000) });

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string; id: string }> },
) {
  const { token, id } = await context.params;
  const client = await resolvePortalClient(token);
  if (!client) {
    return NextResponse.json({ error: "Portal not found" }, { status: 404 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const admin = createAdminSupabase();
  // Confirm the entry belongs to this portal's client before writing.
  const { data: entry } = await admin
    .from("client_pipeline_entries")
    .select("id")
    .eq("id", id)
    .eq("client_id", client.id)
    .maybeSingle();
  if (!entry) {
    return NextResponse.json({ error: "Entry not found" }, { status: 404 });
  }

  const noteBody = parsed.data.body.trim();
  const { data, error } = await admin
    .from("client_pipeline_notes")
    .insert({ entry_id: id, body: noteBody })
    .select("id, body, created_at, updated_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // Slack: announce the new note. The helper resolves lead name +
  // email from the entry. Runs inside after() — failure can't break
  // the operator-visible note add.
  const clientId = client.id;
  after(() =>
    notifyPortalNoteAdded({ clientId, entryId: id, noteBody }),
  );

  return NextResponse.json({ ok: true, note: data });
}
