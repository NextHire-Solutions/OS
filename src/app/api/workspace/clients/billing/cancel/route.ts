import { NextResponse } from "next/server";

import { canCancelSubscriptions } from "@/lib/clients/billing-access";
import { getClientBillingDetail, getStripeSnapshot } from "@/lib/clients/billing-account";
import { cancelRequest, CancelError, isEnded, landed, liveCancelRefusal, planCancel, sendCancel, subscriptionNow } from "@/lib/clients/billing-cancel";
import { billingTabUser } from "@/lib/clients/billing-user";
import { publicOrigin } from "@/lib/mcp/oauth";
import { stripeKey } from "@/lib/tools/onboarding/stripe";

/*
 * Cancel a client's subscription, or take back a cancellation set for the end
 * of the period, from the Billing tab (27 Oct; billing-cancel.ts has the plan).
 *
 *   POST { clientId, subscriptionId, action: "cancel", when: "end" | "now", key, preview: true }
 *        reads the subscription from Stripe and checks it — sends nothing (the review)
 *   POST { …the same, preview: false }
 *        does it
 *   POST { clientId, subscriptionId, action: "keep", key, preview }
 *        takes back a cancellation set for the end of the period
 *
 * Anyone not on the Billing tab gets a bare 404, as on the tab; of the tab's
 * people, only Eddy and Amy may cancel (403 for the rest). Only from the OS's
 * own page. Only the client's CURRENT subscription by the tab's own rules.
 * A subscription already cancelled, or already set to, is answered as done.
 * When Stripe's answer is lost, the person is told it may have gone through.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, private, max-age=0" };
const say = (status: number, error: string) => NextResponse.json({ error }, { status, headers: NO_STORE });
const UNCERTAIN = "Stripe didn't confirm — it may still have gone through. Refresh the Billing tab to see the subscription as it is now. Pressing the button again here is safe: it will not do it twice.";

/* The staff cookie travels with requests from other brokerstaffer.com sites too: this comes only from this page. */
function fromOwnPage(request: Request): boolean {
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  return request.headers.get("origin") === publicOrigin();
}

const day = (s: number | null) => (s ? new Date(s * 1000).toISOString() : null);

export async function POST(request: Request) {
  const who = await billingTabUser(request);
  if (who instanceof NextResponse) return who;
  if (!canCancelSubscriptions(who.email)) return say(403, "Only Eddy and Amy can cancel a subscription.");
  if (!fromOwnPage(request)) return say(403, "Forbidden");
  const parsed = cancelRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return say(400, "That request could not be read — reload the page and try again.");
  const r = parsed.data;

  let key: string;
  try {
    key = stripeKey();
  } catch {
    return say(503, "Stripe is not set up here.");
  }
  if (!r.preview) {
    const refusal = liveCancelRefusal(key, process.env, request.headers.get("origin"), publicOrigin());
    if (refusal) return say(403, refusal);
  }

  const what = r.action === "keep" ? "keep" : `cancel (${r.when === "end" ? "end of period" : "immediately"})`;
  // Set the moment the change is sent: before it, a failure changed nothing; after it, Stripe may have made it.
  let sent = false;
  try {
    const detail = await getClientBillingDetail(r.clientId);
    if (!detail) return say(404, "No such client.");
    // Only the subscription the tab shows as this client's current one — anything else is never changed.
    if (detail.now?.subscriptionId !== r.subscriptionId) {
      /*
       * A retry after a lost answer: the first one went through and the tab
       * has moved on to another subscription. Answered (it has ended), never
       * acted on — this request names the old one, and it stays the only one.
       */
      const other = r.action === "cancel" ? await subscriptionNow(key, r.subscriptionId).catch(() => null) : null;
      if (other && isEnded(other)) {
        return NextResponse.json({ ok: true, done: true, message: "This subscription has already ended.", status: other.status, endsAt: day(other.canceledAt) }, { headers: NO_STORE });
      }
      throw new CancelError("That isn't this client's current subscription any more — close this and refresh the Billing tab.", 404);
    }
    const sub = await subscriptionNow(key, r.subscriptionId);
    const plan = planCancel(sub, r.action, r.when);

    if (plan.kind === "done") {
      if (!r.preview) getStripeSnapshot.invalidate();
      return NextResponse.json({ ok: true, done: true, message: plan.message, status: sub.status, endsAt: day(plan.endsAt) }, { headers: NO_STORE });
    }
    if (r.preview) {
      return NextResponse.json({ ok: true, preview: { status: sub.status, endsAt: day(plan.endsAt), periodEnd: day(sub.periodEnd) } }, { headers: NO_STORE });
    }
    sent = true;
    const after = await sendCancel(key, r, who.email);
    getStripeSnapshot.invalidate();
    // Never "done" unless Stripe now has it that way.
    if (!landed(after, r)) {
      console.error(`[billing] ${who.email} — ${what} of ${r.subscriptionId}: Stripe answered but has it as ${after.status}${after.cancelAtPeriodEnd || after.cancelAt ? ", set to cancel" : ""}`);
      return say(409, `Stripe answered, but the subscription is ${after.status.replace(/_/g, " ")}${after.cancelAtPeriodEnd || after.cancelAt ? " and set to cancel" : ""} — not what was asked. Refresh the Billing tab and check it in Stripe.`);
    }
    console.log(`[billing] ${who.email} — ${what} — subscription ${r.subscriptionId} of client ${r.clientId}: now ${after.status}${after.cancelAtPeriodEnd ? `, cancels ${day(after.cancelAt ?? after.periodEnd)}` : ""}`);
    return NextResponse.json({
      ok: true,
      result: { status: after.status, cancelAtPeriodEnd: after.cancelAtPeriodEnd, endsAt: day(after.cancelAt ?? (after.cancelAtPeriodEnd ? after.periodEnd : after.canceledAt)) },
    }, { headers: NO_STORE });
  } catch (e) {
    // Stripe or our checks said no: nothing was changed.
    if (e instanceof CancelError && e.status !== 502) {
      if (!r.preview) console.warn(`[billing] ${who.email} — ${what} of ${r.subscriptionId} refused: ${e.message}`);
      return say(e.status, e.message);
    }
    if (!sent) {
      console.error(`[billing] ${what} of ${r.subscriptionId} (${r.preview ? "review" : "before sending"}) failed:`, e);
      return say(502, "Stripe could not be reached. Nothing was changed — try again in a minute.");
    }
    console.error(`[billing] ${what} of ${r.subscriptionId} (key ${r.key}) sent, no clear answer:`, e);
    getStripeSnapshot.invalidate();
    return NextResponse.json({ error: UNCERTAIN, uncertain: true }, { status: 502, headers: NO_STORE });
  }
}
