import { NextResponse, type NextRequest } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { isAdminUser } from "@/lib/identity/admin-db";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { addLogin, listLogins, removeLogin } from "@/lib/portal-login/login";

/*
 * A portal's sign-in list — who may sign in to the new client portal (21 Oct).
 * The user: kept by "people who have access to client portals section in OS".
 *
 * GET ?portal=<id> · POST { portal, email, name } · DELETE { portal, id }
 *
 * The proxy already lets only Client Portals switch holders reach
 * /api/tools/master-inbox/portals/*; this checks the switch again itself.
 * Removing an address ends its sessions when it is on no other portal.
 */
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function who(request: NextRequest): Promise<string | null> {
  const s = await verifySso(process.env.AUTH_SECRET ?? "", readSsoCookie(request.headers.get("cookie")));
  if (!s) return null;
  if (s.grants.includes("portals") || (await isAdminUser(s.email))) return s.email.toLowerCase();
  return null;
}

async function portalOk(id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const { data } = await createAdminSupabase().from("clients").select("id, slug").eq("id", id).maybeSingle();
  return !!data && (data as { slug: string | null }).slug !== "unknown";
}

const failed = (e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  if (/os_portal_logins|does not exist|schema cache|PGRST205/i.test(msg)) return NextResponse.json({ error: "Run migration 0037 first — the sign-in tables are not there yet." }, { status: 409 });
  console.error("[portal-logins]", msg.slice(0, 200));
  return NextResponse.json({ error: "That could not be saved just now." }, { status: 502 });
};

export async function GET(request: NextRequest) {
  if (!(await who(request))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const portal = request.nextUrl.searchParams.get("portal") ?? "";
  if (!(await portalOk(portal))) return NextResponse.json({ error: "No such portal." }, { status: 404 });
  try {
    return NextResponse.json({ logins: await listLogins(createAdminSupabase(), portal) });
  } catch (e) {
    return failed(e);
  }
}

export async function POST(request: NextRequest) {
  const by = await who(request);
  if (!by) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { portal?: unknown; email?: unknown; name?: unknown } | null;
  const portal = typeof body?.portal === "string" ? body.portal : "";
  if (!(await portalOk(portal))) return NextResponse.json({ error: "No such portal." }, { status: 404 });
  try {
    const r = await addLogin(createAdminSupabase(), { portalId: portal, email: typeof body?.email === "string" ? body.email : "", name: typeof body?.name === "string" ? body.name : null, by, now: new Date() });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    console.info(JSON.stringify({ tag: "[portal-logins] added", by, portal }));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return failed(e);
  }
}

export async function DELETE(request: NextRequest) {
  const by = await who(request);
  if (!by) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { portal?: unknown; id?: unknown } | null;
  const portal = typeof body?.portal === "string" ? body.portal : "";
  const id = typeof body?.id === "string" && UUID.test(body.id) ? body.id : "";
  if (!(await portalOk(portal)) || !id) return NextResponse.json({ error: "No such portal." }, { status: 404 });
  try {
    const r = await removeLogin(createAdminSupabase(), { portalId: portal, id, by, now: new Date() });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    console.info(JSON.stringify({ tag: "[portal-logins] removed", by, portal }));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return failed(e);
  }
}
