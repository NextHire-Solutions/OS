import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/workspace";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { _invalidateClientCache } from "@/lib/tools/master-inbox/clients/derive";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  icon: z.string().nullable().optional(),
  sort_order: z.number().int().optional(),
});

// Slug rule kept in sync with PATCH /api/clients/[id] so a rename
// reaches the same slug regardless of which surface initiated it.
// Preserves the "or 'client'" fallback for names that collapse to
// nothing after normalisation.
function toSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/&/g, "and")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "client"
  );
}

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

  // Bidirectional rename sync — the reverse of what PATCH
  // /api/clients/[id] already does (client rename → list rename).
  // If the list is client-backed AND the caller is renaming it,
  // look up client_id BEFORE the list write so we can propagate
  // the same name back to the parent client afterwards. Custom
  // user-created lists (client_id IS NULL) skip this entirely
  // and stay list-only, as they always have.
  let clientIdToPropagate: string | null = null;
  if (parsed.data.name !== undefined) {
    const { data: row } = await supabase
      .from("lists")
      .select("client_id")
      .eq("id", id)
      .eq("workspace_id", session.activeWorkspace.id)
      .maybeSingle();
    if (row && row.client_id) {
      clientIdToPropagate = row.client_id as string;
    }
  }

  const { error } = await supabase
    .from("lists")
    .update(parsed.data)
    .eq("id", id)
    .eq("workspace_id", session.activeWorkspace.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // Propagate the rename to the backing client so the sidebar list
  // and the Clients section never drift. Uses the admin client
  // because RLS on `clients` doesn't grant write to session users
  // by default; caller was already gated by requireSession +
  // workspace membership on the list update above, so this is safe.
  // Non-fatal — a failure here logs and returns success on the list
  // update anyway, matching the "always green on list write" contract
  // the endpoint has today.
  if (clientIdToPropagate && parsed.data.name) {
    try {
      const admin = createAdminSupabase();
      const newName = parsed.data.name;
      const { error: clientErr } = await admin
        .from("clients")
        .update({
          name: newName,
          slug: toSlug(newName),
          updated_at: new Date().toISOString(),
        })
        .eq("id", clientIdToPropagate);
      if (clientErr) {
        console.error(
          "[lists/rename] client propagation failed",
          clientErr,
        );
      } else {
        // Bust the campaign → client derive cache so incoming
        // webhooks route via the new name immediately, not after
        // the 5-min TTL. Matches PATCH /api/clients/[id].
        _invalidateClientCache();
      }
    } catch (err) {
      console.error("[lists/rename] client propagation threw", err);
    }
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
  const { error } = await supabase
    .from("lists")
    .delete()
    .eq("id", id)
    .eq("workspace_id", session.activeWorkspace.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
