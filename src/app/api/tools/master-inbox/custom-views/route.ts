import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/workspace";
import { createServerSupabase } from "@/lib/supabase/server";
import { invalidateViewsCache } from "@/lib/tools/master-inbox/inbox/views";

export const dynamic = "force-dynamic";

// filter_json shape is intentionally open-ended — the filter builder
// emits richer payloads (preset='custom_filter', `rows: [...]`) that
// don't fit the original 7-preset enum, and PATCH already accepts any
// JSON via z.record. Match that here so creating a non-preset view
// (e.g. a campaign-name filter) doesn't fail at the boundary.
//
// Validation of individual fields happens downstream when the view
// is read back (lib/inbox/views.ts) so it can ignore malformed
// presets gracefully instead of 400ing on save.
const createSchema = z.object({
  name: z.string().min(1).max(80),
  icon: z.string().optional(),
  filter_json: z.record(z.string(), z.unknown()),
});

export async function POST(request: Request) {
  const session = await requireSession();
  const body = await request.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const supabase = await createServerSupabase();
  const { data: maxRow } = await supabase
    .from("custom_views")
    .select("sort_order")
    .eq("workspace_id", session.activeWorkspace.id)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextOrder = (maxRow?.sort_order ?? -1) + 1;

  const { data, error } = await supabase
    .from("custom_views")
    .insert({
      workspace_id: session.activeWorkspace.id,
      owner_user_id: session.user.id,
      name: parsed.data.name,
      icon: parsed.data.icon ?? null,
      filter_json: parsed.data.filter_json,
      sort_order: nextOrder,
      shared: true,
      is_system: false,
    })
    .select("id")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  invalidateViewsCache(session.activeWorkspace.id);
  return NextResponse.json({ id: data.id });
}
