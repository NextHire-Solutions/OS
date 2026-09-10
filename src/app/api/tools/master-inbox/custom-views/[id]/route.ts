import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/workspace";
import { createServerSupabase } from "@/lib/supabase/server";
import { invalidateViewsCache } from "@/lib/tools/master-inbox/inbox/views";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  icon: z.string().optional(),
  filter_json: z.record(z.string(), z.unknown()).optional(),
  sort_order: z.number().int().optional(),
  shared: z.boolean().optional(),
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
    .from("custom_views")
    .update(parsed.data)
    .eq("id", id)
    .eq("workspace_id", session.activeWorkspace.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  // Bust the views ttlCache for this workspace so the next page load
  // — triggered by the client's router.refresh() — picks up the new
  // sort_order / name / filter instead of serving the stale 30s
  // window. Without this, drag-reorder visibly snapped back after
  // ~1s as the cached list re-rendered with the old order.
  invalidateViewsCache(session.activeWorkspace.id);
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const session = await requireSession();

  const supabase = await createServerSupabase();
  // Allow deletion of any view, including seeded ones — users get to curate
  // the tab bar themselves.
  const { error } = await supabase
    .from("custom_views")
    .delete()
    .eq("id", id)
    .eq("workspace_id", session.activeWorkspace.id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  invalidateViewsCache(session.activeWorkspace.id);
  return NextResponse.json({ ok: true });
}
