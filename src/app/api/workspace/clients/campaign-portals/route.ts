import { NextResponse } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { isAdminUser } from "@/lib/identity/admin-db";
import { clientsChanged } from "@/lib/clients/after-change";
import {
  CampaignPortalError,
  campaignPortalView,
  setCampaignPortal,
  type Platform,
} from "@/lib/clients/campaign-portals";

/*
 * Which portal each of a client's campaigns sends its leads to (1 Oct).
 *
 * GET  ?clientId=  → the client's portals and campaigns with their portal.
 *                    Reads only; the automatic choice is saved by the
 *                    background pass (instrumentation.ts), not by a read.
 * POST { clientId, platform, campaignId, portalId } → a person's choice.
 *
 * Only new replies follow a choice; leads already delivered stay where they
 * are (user decision, 1 Oct).
 */
export const dynamic = "force-dynamic";

const fail = (e: unknown) =>
  e instanceof CampaignPortalError
    ? NextResponse.json({ error: e.message }, { status: 400 })
    : NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the campaign portals" }, { status: 502 });

export async function GET(request: Request) {
  const clientId = new URL(request.url).searchParams.get("clientId") ?? "";
  if (!clientId) return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  try {
    // Whether this viewer may add a portal (admins only) — the screen shows the button only then.
    const session = await verifySso(process.env.AUTH_SECRET ?? "", readSsoCookie(request.headers.get("cookie")));
    const canAddPortal = session ? await isAdminUser(session.email) : false;
    return NextResponse.json({ ...(await campaignPortalView(clientId)), canAddPortal });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(request: Request) {
  const session = await verifySso(process.env.AUTH_SECRET ?? "", readSsoCookie(request.headers.get("cookie")));
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const clientId = typeof body?.clientId === "string" ? body.clientId : "";
  const platform = body?.platform === "emailbison" || body?.platform === "instantly" ? (body.platform as Platform) : null;
  const campaignId = typeof body?.campaignId === "string" || typeof body?.campaignId === "number" ? String(body.campaignId) : "";
  const portalId = typeof body?.portalId === "string" ? body.portalId : "";
  if (!clientId || !platform || !campaignId || !portalId) {
    return NextResponse.json({ error: "clientId, platform, campaignId and portalId are required." }, { status: 400 });
  }
  try {
    await setCampaignPortal(clientId, platform, campaignId, portalId, session.email);
    console.log(`[campaign-portals] ${session.email} sent ${platform} campaign ${campaignId} of ${clientId} to portal ${portalId}`);
    clientsChanged();
    return NextResponse.json({ ok: true, view: await campaignPortalView(clientId) });
  } catch (e) {
    return fail(e);
  }
}
