import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/workspace";
import { createServerSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLORS = ["green", "red", "amber", "zinc", "stone", "pink", "blue"] as const;
const SENTIMENTS = ["positive", "negative", "neutral"] as const;
const PLATFORMS = ["email", "both"] as const;

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  color: z.enum(COLORS).optional(),
  sentiment: z.enum(SENTIMENTS).optional(),
  platform: z.enum(PLATFORMS).optional(),
  obligation: z.boolean().optional(),
  mirror_to_emailbison: z.boolean().optional(),
  sort_order: z.number().int().optional(),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const session = await requireSession();
  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const supabase = await createServerSupabase();
  const { error } = await supabase
    .from("labels")
    .update(parsed.data)
    .eq("id", id)
    .eq("workspace_id", session.activeWorkspace.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const session = await requireSession();

  const supabase = await createServerSupabase();
  // Block deletion of system labels — they're seeded per workspace and
  // referenced by AI labeling defaults.
  const { data: label } = await supabase
    .from("labels")
    .select("is_system")
    .eq("id", id)
    .eq("workspace_id", session.activeWorkspace.id)
    .maybeSingle();
  if (!label) {
    return NextResponse.json({ error: "Label not found" }, { status: 404 });
  }
  if (label.is_system) {
    return NextResponse.json(
      { error: "System labels cannot be deleted." },
      { status: 400 },
    );
  }

  const { error } = await supabase
    .from("labels")
    .delete()
    .eq("id", id)
    .eq("workspace_id", session.activeWorkspace.id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
