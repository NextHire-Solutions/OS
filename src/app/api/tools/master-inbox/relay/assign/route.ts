import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/tools/master-inbox/auth/require-admin";
import { assignCampaign, RelayActionError } from "@/lib/tools/master-inbox/relay/relay";

/*
 * The held list (plan §4: "If a campaign doesn't match a brokerage, nothing is
 * sent; it waits on a short list for the team to assign"). Admins answer for a
 * CAMPAIGN — which brokerage it belongs to, or that it is not a brokerage
 * campaign — and the conversations held on it are checked again at once.
 *
 * Saved in os_relay_campaigns, read only by the relay: which portal a reply is
 * filed in (os_campaign_portals) is never changed from here.
 *
 * POST { platform, campaignId, campaignName?, osClientId | null, ignore }
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await requireAdminSession();
  if (session instanceof NextResponse) return session;
  const b = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const s = (k: string) => (typeof b?.[k] === "string" && (b[k] as string).trim()) || null;
  try {
    const result = await assignCampaign(
      {
        platform: s("platform") ?? "",
        campaignId: s("campaignId") ?? "",
        campaignName: s("campaignName"),
        osClientId: s("osClientId"),
        ignore: b?.ignore === true,
      },
      session.user.email ?? "unknown",
    );
    console.log(`[brokerage-relay] ${session.user.email} answered campaign ${s("platform")}/${s("campaignId")}: ${b?.ignore === true ? "not a brokerage campaign" : s("osClientId")}`);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof RelayActionError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not save" }, { status: 502 });
  }
}
