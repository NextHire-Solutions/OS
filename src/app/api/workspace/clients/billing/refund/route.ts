import { NextResponse } from "next/server";

import { getClientBillingDetail, getStripeSnapshot } from "@/lib/clients/billing-account";
import {
  checkRefundable, invoiceNow, issueRefund, liveRefundRefusal, previewRefund, recentTwin, RefundError, refundRequest, twinRefusal,
} from "@/lib/clients/billing-refund";
import { billingTabUser } from "@/lib/clients/billing-user";
import { publicOrigin } from "@/lib/mcp/oauth";
import { stripeKey } from "@/lib/tools/onboarding/stripe";

/*
 * Refund an invoice from the client's Billing tab (22 Oct; billing-refund.ts
 * has the plan Eddy approved).
 *
 *   POST { clientId, invoiceId, amount (cents), reason, note?, emailClient?, key, preview: true }
 *        Stripe's preview of the credit note — creates nothing (the confirm step)
 *   POST { …the same, preview: false }
 *        issues it: a credit note that refunds `amount` to the original payment
 *
 * The people named in billing-access.ts only — anyone else gets a bare 404, as
 * on the tab. Only from the OS's own page. Only an invoice that is this
 * client's by the tab's own rules, paid, with that much left to give back — as
 * Stripe has it now, not the tab's copy. `key` is made once per confirmation,
 * so a double click or a retry refunds once: a retry whose refund already went
 * through gets that refund back as its answer. Another refund of the same
 * amount on the invoice within ten minutes is refused (billing-refund.ts).
 * When Stripe's answer is lost, the person is told it may have gone through.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, private, max-age=0" };
const say = (status: number, error: string) => NextResponse.json({ error }, { status, headers: NO_STORE });
const UNCERTAIN = "Stripe didn't confirm the refund — it may still have gone through. Check the billing history before anything else. Pressing Refund again here is safe: it will not refund twice.";

/* The staff cookie travels with requests from other brokerstaffer.com sites too: a refund comes only from this page. */
function fromOwnPage(request: Request): boolean {
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  return request.headers.get("origin") === publicOrigin();
}

export async function POST(request: Request) {
  const who = await billingTabUser(request);
  if (who instanceof NextResponse) return who;
  if (!fromOwnPage(request)) return say(403, "Forbidden");
  const parsed = refundRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? "");
    return say(400, field === "amount" || field === "reason" ? "Choose an amount and a reason." : field === "note" ? "The note can be at most 500 characters." : "That request could not be read — reload the page and try again.");
  }
  const r = parsed.data;

  let key: string;
  try {
    key = stripeKey();
  } catch {
    return say(503, "Stripe is not set up here.");
  }
  if (!r.preview) {
    const refusal = liveRefundRefusal(key, process.env, request.headers.get("origin"), publicOrigin());
    if (refusal) return say(403, refusal);
  }

  // Set the moment the refund is sent: before it, a failure refunded nothing; after it, Stripe may have done it.
  let sent = false;
  try {
    const detail = await getClientBillingDetail(r.clientId);
    if (!detail) return say(404, "No such client.");
    // This client's by the tab's rules; paid and refundable as Stripe has it now.
    const row = detail.invoices.find((i) => i.id === r.invoiceId);
    if (!row) throw new RefundError("That invoice isn't one of this client's.", 404);
    if (!row.card) throw new RefundError("This invoice has no payment in Stripe to give back to.", 409);
    const chargeIds = detail.history.filter((h) => h.kind === "payment" && h.invoiceId === r.invoiceId).map((h) => h.id);
    const now = await invoiceNow(key, r.invoiceId, chargeIds);

    // A retry of a refund that already went through (its answer was lost): that refund is the answer.
    const done0 = r.preview ? undefined : now.notes.find((n) => n.key === r.key);
    if (done0) {
      getStripeSnapshot.invalidate();
      console.log(`[billing] ${who.email} retried refund ${r.key} of ${r.invoiceId}: already issued as ${done0.number ?? done0.id} — nothing new sent`);
      return NextResponse.json({ ok: true, refund: { creditNote: done0.number ?? done0.id, amount: done0.amount / 100 } }, { headers: NO_STORE });
    }
    const nowS = Math.floor(Date.now() / 1000);
    const twin = recentTwin(now.notes, r.amount, r.key, nowS);
    if (twin) throw twinRefusal(twin, nowS);
    checkRefundable(now, r.amount);

    if (r.preview) {
      const p = await previewRefund(key, r, who.email);
      return NextResponse.json({ ok: true, preview: { amount: p.amount / 100, card: row.card, invoice: row.number ?? row.id } }, { headers: NO_STORE });
    }
    sent = true;
    const done = await issueRefund(key, r, who.email);
    getStripeSnapshot.invalidate();
    console.log(`[billing] ${who.email} refunded $${(r.amount / 100).toFixed(2)} of ${row.number ?? r.invoiceId} (${r.invoiceId}) for client ${r.clientId}: credit note ${done.number ?? done.creditNote}, refund ${done.refund ?? "—"}, reason ${r.reason}, client emailed: ${r.emailClient ? "yes" : "no"}`);
    return NextResponse.json({ ok: true, refund: { creditNote: done.number ?? done.creditNote, amount: r.amount / 100 } }, { headers: NO_STORE });
  } catch (e) {
    // Stripe said no (the amount, the invoice…): nothing was refunded, in Stripe's words.
    if (e instanceof RefundError && e.status !== 502) {
      if (!r.preview) console.warn(`[billing] ${who.email} refund of ${r.invoiceId} refused: ${e.message}`);
      return say(e.status, e.message);
    }
    if (!sent) {
      console.error(`[billing] refund of ${r.invoiceId} (${r.preview ? "preview" : "before sending"}) failed:`, e);
      return say(502, "Stripe could not be reached. Nothing was refunded — try again in a minute.");
    }
    // Sent, but no clear answer — a timeout, a lost or unreadable reply. The refund may still have gone through.
    console.error(`[billing] refund of ${r.invoiceId} (key ${r.key}) sent, no clear answer:`, e);
    getStripeSnapshot.invalidate();
    return NextResponse.json({ error: UNCERTAIN, uncertain: true }, { status: 502, headers: NO_STORE });
  }
}
