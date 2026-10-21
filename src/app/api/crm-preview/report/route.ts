import { after, NextResponse, type NextRequest } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { adminEmails } from "@/lib/identity/admin";
import { canSeeCrmPreview } from "@/lib/crm-preview/access";
import { marketContext, marketReport } from "@/lib/crm-preview/market";
import { admit, NO_STORE_HEADERS, served } from "@/lib/crm-preview/data-guard";
import { recordUse } from "@/lib/portal-usage/usage";
import { createAdminSupabase } from "@/lib/supabase/admin";

/*
 * GET /api/crm-preview/report?client=<portal id>
 *
 * Reports › All market for the redesign preview: the client's market by
 * brokerage, office city, sales volume and deals closed. Owners only (a bare
 * 404 for anyone else); GET only; read through the read-only guard. Kept for
 * 30 minutes per market — a large market's counts take ~20 seconds cold.
 */

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  const me = await verifySso(process.env.AUTH_SECRET ?? "", readSsoCookie(request.headers.get("cookie")));
  if (!canSeeCrmPreview(me?.email, adminEmails())) return new NextResponse(null, { status: 404 });

  const client = request.nextUrl.searchParams.get("client") ?? "";
  if (!UUID.test(client)) return NextResponse.json({ error: "No such client." }, { status: 400, headers: NO_STORE_HEADERS });
  // Bulk extraction is refused (lib/crm-preview/data-guard.ts), as on the market route.
  const who = (me?.email ?? "").toLowerCase();
  const gate = admit(who, "staff", "report", request.headers);
  if (!gate.ok) {
    console.warn(JSON.stringify({ tag: "[crm-preview] refused", kind: "report", who, client, reason: gate.reason }));
    return NextResponse.json({ error: gate.message }, { status: gate.status, headers: NO_STORE_HEADERS });
  }
  try {
    const ctx = await marketContext(client);
    if (!ctx) return NextResponse.json({ error: "No such client portal." }, { status: 404, headers: NO_STORE_HEADERS });
    const report = await marketReport(ctx);
    // A report that could not be counted ("unavailable") is not a report served (22 Oct audit).
    if ("unavailable" in report) return NextResponse.json({ ...report, mls: ctx.mls, client: ctx.client?.name ?? null }, { headers: NO_STORE_HEADERS });
    served(who, "report", 0);
    // Counted in the database; heavy or automated-looking CLIENT use rings the OS bell. Never refuses (usage.ts). Everyone here is our own team.
    after(() => recordUse(createAdminSupabase(), { who, role: "staff", portalId: client, kind: "report", rows: 0, now: new Date() }));
    console.info(JSON.stringify({ tag: "[crm-preview] data", kind: "report", who, client }));
    return NextResponse.json({ ...report, mls: ctx.mls, client: ctx.client?.name ?? null }, { headers: NO_STORE_HEADERS });
  } catch (err) {
    console.error("[crm-preview] report", err);
    // The reason is logged above; the browser gets the plain words, never a database message.
    return NextResponse.json({ error: "The agent database could not be read just now. Please try again." }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
