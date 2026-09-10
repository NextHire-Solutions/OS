import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/workspace";
import { createServerSupabase } from "@/lib/supabase/server";

// PATCH  /api/reply-templates/[id]  → rename / edit body / reorder
// DELETE /api/reply-templates/[id]

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  body: z.string().max(20_000).optional(),
  body_html: z.string().max(40_000).nullable().optional(),
  subject: z.string().trim().max(200).nullable().optional(),
  cc: z.string().trim().max(400).nullable().optional(),
  bcc: z.string().trim().max(400).nullable().optional(),
  category: z.string().trim().max(60).nullable().optional(),
  sort_order: z.number().int().optional(),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const session = await requireSession();
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const supabase = await createServerSupabase();
  const { error } = await supabase
    .from("reply_templates")
    .update(parsed.data)
    .eq("id", id)
    .eq("workspace_id", session.activeWorkspace.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const session = await requireSession();
  const supabase = await createServerSupabase();
  const { error } = await supabase
    .from("reply_templates")
    .delete()
    .eq("id", id)
    .eq("workspace_id", session.activeWorkspace.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
