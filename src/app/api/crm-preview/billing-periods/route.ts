import { NextResponse, type NextRequest } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { adminEmails } from "@/lib/identity/admin";
import { canSeeCrmPreview } from "@/lib/crm-preview/access";
import { admit, NO_STORE_HEADERS } from "@/lib/crm-preview/data-guard";
import { portalBillingPage } from "@/lib/crm-preview/billing-page";

/*
 * GET ?client=<portal id> — the portal's Billing page (22 Oct): introductions
 * from our side in each billing period. Owners and the named reviewers only,
 * as the page (anyone else a bare 404); only the page's own fetch; read-only.
 */
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  const me = await verifySso(process.env.AUTH_SECRET ?? "", readSsoCookie(request.headers.get("cookie")));
  if (!canSeeCrmPreview(me?.email, adminEmails())) return new NextResponse(null, { status: 404 });
  const who = (me?.email ?? "").toLowerCase();

  const client = request.nextUrl.searchParams.get("client") ?? "";
  if (!UUID.test(client)) return NextResponse.json({ error: "No such client." }, { status: 400, headers: NO_STORE_HEADERS });
  const gate = admit(who, "staff", "periods", request.headers);
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
