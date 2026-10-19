import { NextResponse } from "next/server";

import { stripeGet } from "@/lib/commissions/stripe-payments";
import { getClientBillingDetail } from "@/lib/clients/billing-account";
import { billingTabUser } from "@/lib/clients/billing-user";

/*
 * Open one of a client's invoices or receipts in Stripe (the Billing tab, 19 Oct).
 *
 *   GET ?clientId=…&id=in_…&as=page    Stripe's page for the invoice
 *   GET ?clientId=…&id=in_…&as=pdf     the invoice PDF, to download
 *   GET ?clientId=…&id=ch_…            the payment's receipt
 *
 * the people named in billing-access.ts only, as the tab: anyone else gets a
 * bare 404. Only a document that is the client's by the tab's own rules, so a changed
 * id cannot open another client's invoice. The link is read from Stripe at the
 * moment of the click (a GET — nothing is written), so it is never a stale
 * one, and only a stripe.com address is ever followed.
 */
export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store, private, max-age=0" };
const say = (status: number, text: string) =>
  new NextResponse(text, { status, headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" } });

export async function GET(request: Request) {
  const who = await billingTabUser(request);
  if (who instanceof NextResponse) return who;
  const u = new URL(request.url);
  const clientId = u.searchParams.get("clientId") ?? "";
  const id = u.searchParams.get("id") ?? "";
  if (!clientId || !/^(in|ch)_[A-Za-z0-9]{6,}$/.test(id)) return say(400, "clientId and an invoice (in_…) or payment (ch_…) id are required.");
  const invoice = id.startsWith("in_");
  const as = invoice ? (u.searchParams.get("as") === "pdf" ? "pdf" : "page") : "receipt";

  let detail;
  try {
    detail = await getClientBillingDetail(clientId);
  } catch (e) {
    return say(502, `Stripe could not be read: ${e instanceof Error ? e.message : "unknown error"}`);
  }
  if (!detail) return say(404, "No such client.");
  const owned = invoice ? detail.invoices.some((i) => i.id === id) : detail.history.some((h) => h.id === id && h.receipt);
  if (!owned) return say(404, "That invoice or payment is not this client's.");

  const res = await stripeGet(`https://api.stripe.com/v1/${invoice ? "invoices" : "charges"}/${id}`);
  const body = (await res.json().catch(() => null)) as
    | { invoice_pdf?: string | null; hosted_invoice_url?: string | null; receipt_url?: string | null; error?: { message?: string } }
    | null;
  if (!res.ok || !body) return say(502, `Stripe: ${body?.error?.message ?? res.status}`);
  const url = as === "pdf" ? body.invoice_pdf : as === "page" ? body.hosted_invoice_url : body.receipt_url;
  if (!url || !/^https:\/\/([a-z0-9-]+\.)*stripe\.com\//.test(url)) {
    return say(404, as === "receipt" ? "Stripe has no receipt for this payment." : `Stripe has no ${as === "pdf" ? "PDF" : "page"} for this invoice (a draft has neither).`);
  }
  console.log(`[billing] ${who.email} opened the ${as} of ${id}`);
  return NextResponse.redirect(url, { status: 302, headers: HEADERS });
}
