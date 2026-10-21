import { NextResponse, type NextRequest } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { adminEmails } from "@/lib/identity/admin";
import { canSeeCrmPreview } from "@/lib/crm-preview/access";
import { getAccountBilling } from "@/lib/clients/billing-account";
import { BILLING_REFUSAL, pickBillingCustomer } from "@/lib/crm-preview/billing-pick";
import { billingPortalUrl, portalConfiguration } from "@/lib/crm-preview/billing-portal";
import { portalClient } from "@/lib/crm-preview/market";
import { publicOrigin } from "@/lib/mcp/oauth";
import { admit, NO_STORE_HEADERS, served } from "@/lib/crm-preview/data-guard";

/*
 * The portal's Billing link (19 Oct): GET ?client=<portal id>, opened in a new
 * tab by the person's own click, answers with a redirect to that client's
 * Stripe billing page — or a short page saying why it cannot.
 *
 * Owners and Eddy only, as the preview page: anyone else gets a bare 404.
 * Then only a real click on the link (data-guard fromOwnClick — not a
 * prefetch, a link scanner, a script or a typed address) and a per-person cap.
 * The customer is the client's own (billing-pick.ts): never a card another
 * client shares.
 */
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function notice(status: number, text: string) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Billing</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f8fa;font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1f2124}
main{max-width:440px;margin:24px;padding:28px 28px 24px;background:#fff;border:1px solid #ebedf0;border-radius:14px}h1{margin:0 0 8px;font-size:18px;font-weight:600}p{margin:0;color:#4b5563}</style></head>
<body><main><h1>Billing</h1><p>${esc(text)}</p></main></body></html>`;
  return new NextResponse(html, { status, headers: { ...NO_STORE_HEADERS, "Content-Type": "text/html; charset=utf-8" } });
}

export async function GET(request: NextRequest) {
  const me = await verifySso(process.env.AUTH_SECRET ?? "", readSsoCookie(request.headers.get("cookie")));
  if (!canSeeCrmPreview(me?.email, adminEmails())) return new NextResponse(null, { status: 404 });
  const who = me!.email.toLowerCase();

  const client = request.nextUrl.searchParams.get("client") ?? "";
  if (!UUID.test(client)) return notice(400, "This link is not complete. Open Billing from the portal's sidebar.");

  const gate = admit(who, "staff", "billing", request.headers);
  if (!gate.ok) {
    console.warn(JSON.stringify({ at: "[crm-preview] refused", who, kind: "billing", client, reason: gate.reason }));
    return notice(gate.status, gate.reason === "not-own-page" ? "Open Billing from the portal's sidebar." : gate.message);
  }

  try {
    const record = await portalClient(client);
    if (record === undefined) return notice(404, "No such client portal.");
    if (record === null) return notice(409, BILLING_REFUSAL["no-billing"]);
    const { byClient } = await getAccountBilling();
    const pick = pickBillingCustomer(byClient.get(record.id), byClient.values());
    if (!pick.ok) {
      console.info(JSON.stringify({ at: "[crm-preview] billing refused", who, client, reason: pick.reason }));
      return notice(409, BILLING_REFUSAL[pick.reason]);
    }
    const configuration = await portalConfiguration();
    if (!configuration) return notice(503, "The billing page is not set up yet. Please contact us and we'll help.");
    // The public address: behind Railway's proxy a route sees the container's own address (localhost:8080) — see logout/route.ts.
    const back = `${publicOrigin()}/crm-preview?client=${encodeURIComponent(client)}`;
    const url = await billingPortalUrl(pick.customer, back, configuration);
    served(who, "billing", 0);
    console.info(JSON.stringify({ at: "[crm-preview] billing opened", who, client, customer: pick.customer }));
    return NextResponse.redirect(url, { status: 303, headers: NO_STORE_HEADERS });
  } catch (e) {
    console.error(JSON.stringify({ at: "[crm-preview] billing failed", who, client, error: e instanceof Error ? e.message.slice(0, 200) : "unknown" }));
    return notice(502, "We couldn't open the billing page just now. Please try again in a minute.");
  }
}
