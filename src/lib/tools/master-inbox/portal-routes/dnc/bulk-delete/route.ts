import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { resolvePortalClient } from "@/lib/tools/master-inbox/portals/token";

// POST /api/portal/[token]/dnc/bulk-delete
// Body: { ids: string[] }
//
// Removes multiple DNC entries in one request. Provider blocklist
// entries (email or domain pushed earlier) stay in place — same
// one-directional rule as the single-row DELETE.

export const dynamic = "force-dynamic";

const schema = z.object({
  // 5000 ceiling — UI also chunks client-side to keep individual
  // requests well under any infrastructure timeout.
  ids: z.array(z.string().uuid()).min(1).max(5000),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
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
  const { error, count } = await admin
    .from("client_dnc_entries")
    .delete({ count: "exact" })
    .eq("client_id", client.id)
    .in("id", parsed.data.ids);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, deleted: count ?? 0 });
}
