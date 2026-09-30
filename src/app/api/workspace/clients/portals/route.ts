import { NextResponse } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { AddPortalError, addPortal, previewPortal } from "@/lib/clients/add-portal";
import { campaignPortalView } from "@/lib/clients/campaign-portals";

/*
 * Add a portal to a client (1 Oct).
 *
 * GET  ?clientId=&market=  → what would be created and which campaigns would
 *                            send new leads to it. Reads only.
 * POST { clientId, market } → creates it (admins only: a live client-facing link).
 */
export const dynamic = "force-dynamic";

const fail = (e: unknown) =>
  e instanceof AddPortalError
    ? NextResponse.json({ error: e.message }, { status: e.status })
    : NextResponse.json({ error: e instanceof Error ? e.message : "Could not add the portal" }, { status: 502 });

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const clientId = q.get("clientId") ?? "";
  if (!clientId) return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  try {
    return NextResponse.json(await previewPortal(clientId, q.get("market")));
  } catch (e) {
    return fail(e);
  }
}

export async function POST(request: Request) {
  const session = await verifySso(process.env.AUTH_SECRET ?? "", readSsoCookie(request.headers.get("cookie")));
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { clientId?: unknown; market?: unknown } | null;
  const clientId = typeof body?.clientId === "string" ? body.clientId : "";
  if (!clientId) return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  try {
    const out = await addPortal(clientId, body?.market, session.email);
    return NextResponse.json({ ok: true, ...out, view: await campaignPortalView(clientId) });
  } catch (e) {
    return fail(e);
  }
}
