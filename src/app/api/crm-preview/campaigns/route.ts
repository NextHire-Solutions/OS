import { NextResponse, type NextRequest } from "next/server";

import { crmViewerOf } from "@/lib/crm-preview/viewer";
import { guardRole, mayOpenPortal } from "@/lib/crm-preview/viewer-rules";
import { closedToClient } from "@/lib/crm-preview/portal-open";
import { admit, NO_STORE_HEADERS } from "@/lib/crm-preview/data-guard";
import { campaignsFailure, campaignsOn, listCampaigns, readCampaign } from "@/lib/crm-preview/campaigns";

/*
 * The portal's Campaigns page (17 Nov 2026; rules: lib/crm-preview/campaign-copy.ts, reads and saves: campaigns.ts).
 *
 *   GET ?client=<portal>                  the client's campaigns
 *   GET ?client=<portal>&campaign=<id>    one campaign's emails, read live
 *
 * Saves are POST /api/crm-preview/campaign-save. WHO, as every portal route: anyone who may not open the portal gets a
 * bare 404 before anything is read; a client's portal that is switched off or held serves them nothing; only the
 * page's own fetch. A real portal answers only while OS_PORTAL_CAMPAIGNS has it on (campaignsOn); until then its page
 * says "Coming soon" and this route a bare 404.
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
  if (!campaignsOn(client)) return new NextResponse(null, { status: 404 });
  const gate = admit(who, role, "campaigns", request.headers);
  if (!gate.ok) {
    console.warn(JSON.stringify({ tag: "[crm-preview] refused", kind: "campaigns", who, client, reason: gate.reason }));
    return NextResponse.json({ error: gate.message }, { status: gate.status, headers: NO_STORE_HEADERS });
  }
  const campaign = request.nextUrl.searchParams.get("campaign");
  try {
    if (campaign) {
      // EmailBison's own name only for our team (campaigns.ts NAMES): a client gets the campaign's market.
      const r = await readCampaign(client, campaign, undefined, { staff: viewer.kind === "staff" });
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE_HEADERS });
      console.info(JSON.stringify({ tag: "[crm-preview] data", kind: "campaign", who, client, campaign, emails: r.value.emails.length }));
      return NextResponse.json({ campaign: r.value }, { headers: NO_STORE_HEADERS });
    }
    const r = await listCampaigns(client, undefined, { staff: viewer.kind === "staff" });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE_HEADERS });
    console.info(JSON.stringify({ tag: "[crm-preview] data", kind: "campaigns", who, client, campaigns: r.value.length }));
    return NextResponse.json({ campaigns: r.value }, { headers: NO_STORE_HEADERS });
  } catch (err) {
    const f = campaignsFailure(err, "read");
    console.error(JSON.stringify({ tag: "[crm-preview] campaigns failed", who, client, campaign, error: err instanceof Error ? err.message.slice(0, 300) : String(err) }));
    return NextResponse.json({ error: f.error }, { status: f.status, headers: NO_STORE_HEADERS });
  }
}
