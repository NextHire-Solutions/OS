import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { resolvePortalClient } from "@/lib/tools/master-inbox/portals/token";

// POST /api/portal/[token]/agents/bulk-delete
// Body: { ids: string[] }
//
// Removes multiple agents from the portal's roster in one request.
// Each id is scoped to the portal's client_id — sending an id from a
// different client_id is a no-op (the row simply isn't matched).
// Provider blocklist entries (if pushed earlier) stay in place; same
// one-directional rule as the single-row DELETE.

export const dynamic = "force-dynamic";

const schema = z.object({
  // Cap at 5000 to absorb a typical "remove every duplicate" sweep.
  // UI chunks anyway so this is just a server-side ceiling.
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
    .from("client_agents")
    .delete({ count: "exact" })
    .eq("client_id", client.id)
    .in("id", parsed.data.ids);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, deleted: count ?? 0 });
}
