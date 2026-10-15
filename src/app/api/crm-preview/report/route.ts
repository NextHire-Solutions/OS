import { NextResponse, type NextRequest } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { adminEmails } from "@/lib/identity/admin";
import { canSeeCrmPreview } from "@/lib/crm-preview/access";
import { marketContext, marketReport } from "@/lib/crm-preview/market";

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
  if (!UUID.test(client)) return NextResponse.json({ error: "No such client." }, { status: 400 });
  try {
    const ctx = await marketContext(client);
    if (!ctx) return NextResponse.json({ error: "No such client portal." }, { status: 404 });
    return NextResponse.json({ ...(await marketReport(ctx)), mls: ctx.mls, client: ctx.client?.name ?? null });
  } catch (err) {
    console.error("[crm-preview] report", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "The agent database could not be read." }, { status: 500 });
  }
}
