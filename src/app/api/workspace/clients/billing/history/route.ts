import { NextResponse } from "next/server";

import { canCancelSubscriptions } from "@/lib/clients/billing-access";
import { getClientBillingDetail } from "@/lib/clients/billing-account";
import { billingTabUser } from "@/lib/clients/billing-user";

/*
 * A client's Billing tab (Eddy, 17 Oct): what they are on now, the total
 * billed, every payment, failed payment and refund, and every invoice — from
 * Stripe, by billing-model.ts's ownership rules. Read-only: nothing here
 * writes to Stripe or to any database.
 *
 *   GET ?clientId=…            the shared Stripe snapshot (ten minutes old at most)
 *   GET ?clientId=…&fresh=1    re-read Stripe first ("Refresh from Stripe")
 *
 * the people named in billing-access.ts only — anyone else gets a bare 404.
 * Having the Clients page is not enough.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, private, max-age=0" };

export async function GET(request: Request) {
  const who = await billingTabUser(request);
  if (who instanceof NextResponse) return who;
  const u = new URL(request.url);
  const clientId = u.searchParams.get("clientId") ?? "";
  if (!clientId) return NextResponse.json({ error: "clientId is required." }, { status: 400, headers: NO_STORE });
  try {
    const detail = await getClientBillingDetail(clientId, u.searchParams.get("fresh") === "1");
    if (!detail) return NextResponse.json({ error: "No such client" }, { status: 404, headers: NO_STORE });
    // Whether this person gets Cancel subscription (Eddy and Amy only) — decided here, never in the browser.
    return NextResponse.json({ detail, canCancel: canCancelSubscriptions(who.email) }, { headers: NO_STORE });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Stripe could not be read" }, { status: 502, headers: NO_STORE });
  }
}
