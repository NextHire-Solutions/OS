import { NextResponse } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { osTable } from "@/lib/clients/os-db";
import { savedViewsByClient } from "@/lib/clients/saved-views";

/*
 * Each client's Database saved views (client feedback, 6 Oct).
 *
 *   GET                                              every client's views, and every view (for linking)
 *   POST { clientId, viewId, action: "link" | "unlink" | "exclude" }
 *        link    — this view is the client's (a view named otherwise)
 *        unlink  — undo a link or an exclusion
 *        exclude — a name match that is NOT the client's
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await savedViewsByClient());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The Database could not be read" }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const s = await verifySso(process.env.AUTH_SECRET ?? "", readSsoCookie(request.headers.get("cookie")));
  if (!s?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { clientId?: unknown; viewId?: unknown; action?: unknown } | null;
  const clientId = typeof body?.clientId === "string" ? body.clientId : "";
  const viewId = typeof body?.viewId === "string" ? body.viewId : "";
  const action = String(body?.action ?? "");
  if (!clientId || !viewId || !["link", "unlink", "exclude"].includes(action)) {
    return NextResponse.json({ error: "clientId, viewId and action (link, unlink or exclude) are required." }, { status: 400 });
  }
  const del = await osTable("os_client_saved_views").delete().eq("os_client_id", clientId).eq("saved_list_id", viewId);
  if (del.error) {
    return NextResponse.json({ error: /os_client_saved_views/.test(del.error.message) ? "Linking saved views needs migrations/0030_billing_profile.sql run first." : del.error.message }, { status: 400 });
  }
  if (action !== "unlink") {
    const ins = await osTable("os_client_saved_views").insert({ os_client_id: clientId, saved_list_id: viewId, excluded: action === "exclude", created_by: s.email.toLowerCase() });
    if (ins.error) return NextResponse.json({ error: ins.error.message }, { status: 400 });
  }
  console.log(`[saved-views] ${s.email} ${action} ${viewId} for ${clientId}`);
  const all = await savedViewsByClient();
  return NextResponse.json({ ok: true, views: all.byClient[clientId] ?? [], linksReady: all.linksReady });
}
