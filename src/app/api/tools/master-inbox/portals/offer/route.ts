import { NextResponse, type NextRequest } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { isAdminUser } from "@/lib/identity/admin-db";
import { createAdminSupabase } from "@/lib/supabase/admin";

/*
 * GET ?portal=<id> — the client's offer, as they gave it in the new portal's
 * Setup wizard ("Tell us your offer", migration 0039, 22 Oct). Read-only; the
 * OS shows it on the portal's page so the team writing the client's emails
 * has it. Behind the Client Portals switch (the proxy checks it for
 * /api/tools/master-inbox/portals/*), checked again here.
 */
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  const s = await verifySso(process.env.AUTH_SECRET ?? "", readSsoCookie(request.headers.get("cookie")));
  if (!s || !(s.grants.includes("portals") || (await isAdminUser(s.email)))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const portal = request.nextUrl.searchParams.get("portal") ?? "";
  if (!UUID.test(portal)) return NextResponse.json({ error: "No such portal." }, { status: 404 });
  const { data, error } = await createAdminSupabase().from("os_portal_offers").select("offers, why_join, never_say, updated_by, updated_at").eq("portal_id", portal).maybeSingle();
  if (error) {
    console.error("[portal-offer]", error.message.slice(0, 200));
    if (/does not exist|schema cache|PGRST205|42P01/i.test(error.message)) return NextResponse.json({ offer: null, note: "Run migration 0039 first — the offer table is not there yet." });
    return NextResponse.json({ error: "The offer could not be read just now." }, { status: 502 });
  }
  const r = data as { offers: string[] | null; why_join: string; never_say: string | null; updated_by: string | null; updated_at: string | null } | null;
  return NextResponse.json({ offer: r ? { offers: r.offers ?? [], whyJoin: r.why_join, neverSay: r.never_say, updatedBy: r.updated_by, updatedAt: r.updated_at } : null });
}
