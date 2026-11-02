import { after, NextResponse, type NextRequest } from "next/server";

import { crmViewerOf } from "@/lib/crm-preview/viewer";
import { guardRole, mayOpenPortal } from "@/lib/crm-preview/viewer-rules";
import { closedToClient } from "@/lib/crm-preview/portal-open";
import { marketContext } from "@/lib/crm-preview/market";
import { parseMarketQuery } from "@/lib/crm-preview/market-model";
import { admit, NO_STORE_HEADERS, served } from "@/lib/crm-preview/data-guard";
import { EXPORT_MAX, exportFileName, exportRows, mayExport, toCsv } from "@/lib/crm-preview/export";
import { recordUse } from "@/lib/portal-usage/usage";
import { alertExport } from "@/lib/portal-usage/usage";
import { createAdminSupabase } from "@/lib/supabase/admin";

/*
 * GET /api/crm-preview/export?client=<portal id>&list=prospects|market&<the page's filters and sort>
 *
 * The list on screen as a CSV file (lib/crm-preview/export.ts, 2 Nov): a client its own Prospects; our staff,
 * Prospects or Market. The same gate as the market route — the reviewers or the portal's own signed-in client, the
 * page's own request only — then counted, and a client's export rings the OS bell. No email or phone is ever in it.
 */

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  const viewer = await crmViewerOf(request);
  if (!viewer) return new NextResponse(null, { status: 404 });

  const params = request.nextUrl.searchParams;
  const client = params.get("client") ?? "";
  if (!UUID.test(client)) return NextResponse.json({ error: "No such client." }, { status: 400, headers: NO_STORE_HEADERS });
  if (!mayOpenPortal(viewer, client)) return new NextResponse(null, { status: 404 });
  if (await closedToClient(viewer, client as string)) return new NextResponse(null, { status: 404 });
  const who = viewer.email;
  const role = guardRole(viewer);
  const gate = admit(who, role, "market", request.headers);
  if (!gate.ok) {
    console.warn(JSON.stringify({ tag: "[crm-preview] refused", kind: "export", who, client, reason: gate.reason }));
    return NextResponse.json({ error: gate.message }, { status: gate.status, headers: NO_STORE_HEADERS });
  }
  const q = parseMarketQuery(params);
  if (!mayExport(role, q.list)) {
    return NextResponse.json({ error: "Market can't be exported: agent details from the agent database stay in the portal. Your Prospects can be exported." }, { status: 403, headers: NO_STORE_HEADERS });
  }
  try {
    const ctx = await marketContext(client);
    if (!ctx) return NextResponse.json({ error: "No such client portal." }, { status: 404, headers: NO_STORE_HEADERS });
    const found = await exportRows(ctx, q);
    if ("unavailable" in found) return NextResponse.json({ error: found.unavailable }, { status: 409, headers: NO_STORE_HEADERS });
    if ("tooMany" in found) {
      return NextResponse.json({ error: `That's ${found.tooMany.toLocaleString("en-US")} agents — narrow the filters to ${EXPORT_MAX.toLocaleString("en-US")} or fewer to export them.` }, { status: 409, headers: NO_STORE_HEADERS });
    }
    const rows = found.rows.length;
    served(who, "market", rows);
    // Counted like the pages it holds; a client's export is also its own notice in the OS bell. Never refuses (usage.ts).
    after(() => recordUse(createAdminSupabase(), { who, role, portalId: client, kind: "market", rows, now: new Date() }));
    if (role === "client") after(() => alertExport(createAdminSupabase(), { who, portalId: client, agents: rows, now: new Date() }));
    console.info(JSON.stringify({ tag: "[crm-preview] data", kind: "export", who, role, client, list: q.list, rows }));
    const name = exportFileName(ctx.client?.name ?? null, q.list, new Date().toISOString().slice(0, 10));
    return new NextResponse(toCsv(found.rows), {
      headers: { ...NO_STORE_HEADERS, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` },
    });
  } catch (err) {
    console.error("[crm-preview] export", err);
    return NextResponse.json({ error: "The agent database could not be read just now. Please try again." }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
