import { NextResponse, type NextRequest } from "next/server";

import { crmViewerOf } from "@/lib/crm-preview/viewer";
import { guardRole, mayOpenPortal } from "@/lib/crm-preview/viewer-rules";
import { closedToClient } from "@/lib/crm-preview/portal-open";
import { admit, NO_STORE_HEADERS } from "@/lib/crm-preview/data-guard";
import { portalBillingPage } from "@/lib/crm-preview/billing-page";

/*
 * GET ?client=<portal id> — the portal's Billing page (22 Oct): introductions
 * from our side in each billing period. The reviewers, or the portal's own
 * signed-in client (27 Oct), as the page (anyone else a bare 404); only the
 * page's own fetch; read-only.
 */
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  const viewer = await crmViewerOf(request);
  if (!viewer) return new NextResponse(null, { status: 404 });
  const who = viewer.email;
  const role = guardRole(viewer);

  const client = request.nextUrl.searchParams.get("client") ?? "";
  if (!UUID.test(client)) return NextResponse.json({ error: "No such client." }, { status: 400, headers: NO_STORE_HEADERS });
  // A client opens only their own portals, and only those open to clients (viewer-rules.ts); staff any.
  if (!mayOpenPortal(viewer, client)) return new NextResponse(null, { status: 404 });
  // A client's portal that is switched off or held serves them nothing, as their current portal (portal-open.ts).
  if (await closedToClient(viewer, client as string)) return new NextResponse(null, { status: 404 });
  const gate = admit(who, role, "periods", request.headers);
  if (!gate.ok) {
    console.warn(JSON.stringify({ tag: "[crm-preview] refused", kind: "periods", who, client, reason: gate.reason }));
    return NextResponse.json({ error: gate.message }, { status: gate.status, headers: NO_STORE_HEADERS });
  }
  try {
    const page = await portalBillingPage(client, new Date());
    if (!page) return NextResponse.json({ error: "No such client portal." }, { status: 404, headers: NO_STORE_HEADERS });
    console.info(JSON.stringify({ tag: "[crm-preview] data", kind: "periods", who, client, periods: page.ok ? page.periods.length : 0 }));
    return NextResponse.json(page, { headers: NO_STORE_HEADERS });
  } catch (err) {
    console.error("[crm-preview] billing periods", err);
    return NextResponse.json({ error: "Billing could not be read just now. Please try again." }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
