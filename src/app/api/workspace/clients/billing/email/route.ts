import { NextResponse } from "next/server";

import { getAccountBilling, getStripeSnapshot } from "@/lib/clients/billing-account";
import { cleanEmail, customerNow, invoiceEmailRequest, InvoiceEmailError, liveEmailRefusal, planEmail, sameEmail, sendEmail } from "@/lib/clients/billing-email";
import { billingTabUser } from "@/lib/clients/billing-user";
import { osTable } from "@/lib/clients/os-db";
import { publicOrigin } from "@/lib/mcp/oauth";
import { stripeKey } from "@/lib/tools/onboarding/stripe";

/*
 * Change where Stripe sends a customer's invoices, receipts and payment reminders: the customer's email (12 Nov;
 * billing-email.ts has the plan).
 *
 *   POST { clientId, customerId, from, to }   from: the address the page showed (null: none); to: the new one
 *
 * Anyone not on the Billing tab gets a bare 404, as on the tab. Only from the OS's own page. Only a customer counted for
 * this client by the tab's own rules. Refused, with nothing sent, when Stripe has another address than the page showed.
 * When Stripe's answer is lost, the person is told it may have gone through.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, private, max-age=0" };
const say = (status: number, error: string) => NextResponse.json({ error }, { status, headers: NO_STORE });
const UNCERTAIN = "Stripe didn't confirm, so the change may still have gone through. Refresh the Billing tab to see the address Stripe has now.";

/* The staff cookie travels with requests from other brokerstaffer.com sites too: this comes only from this page. */
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
  const parsed = invoiceEmailRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return say(400, "That request could not be read. Reload the page and try again.");
  const r = parsed.data;
  const to = cleanEmail(r.to);
  if (!to) return say(400, "That isn't one email address. Check it and try again.");

  let key: string;
  try {
    key = stripeKey();
  } catch {
    return say(503, "Stripe is not set up here.");
  }
  const refusal = liveEmailRefusal(key, process.env, request.headers.get("origin"), publicOrigin());
  if (refusal) return say(403, refusal);

  // Set the moment the change is sent: before it, a failure changed nothing; after it, Stripe may have made it.
  let sent = false;
  try {
    const { data: row, error: dbError } = await osTable("os_clients").select("name").eq("id", r.clientId).maybeSingle();
    if (dbError) return say(502, "The client's record could not be read. Nothing was changed. Try again in a minute.");
    const name = (row as { name?: string } | null)?.name;
    if (!name) return say(404, "No such client.");
    // Only a customer this client's Billing shows as its own — never anyone else's, whatever the request names.
    const counted = (await getAccountBilling()).byClient.get(r.clientId)?.customers.find((c) => c.id === r.customerId);
    if (!counted) throw new InvoiceEmailError("That Stripe customer isn't counted for this client any more. Refresh the Billing tab. Nothing was changed.", 404);
    const now = await customerNow(key, r.customerId).catch((e: unknown) => {
      if (e instanceof InvoiceEmailError && e.status === 404) getStripeSnapshot.invalidate();
      throw e;
    });
    // The OS's copy of Stripe is behind (changed in Stripe's dashboard, say): the tab's next read takes Stripe's, or a refusal below would repeat.
    if (now.deleted || !sameEmail(now.email, counted.email)) getStripeSnapshot.invalidate();
    const plan = planEmail(now, r.from, to);
    if (plan.kind === "done") {
      return NextResponse.json({ ok: true, done: true, message: plan.message, email: now.email }, { headers: NO_STORE });
    }
    sent = true;
    const after = await sendEmail(key, r.customerId, to, now.email, who.email);
    getStripeSnapshot.invalidate();
    // Never "saved" unless Stripe now has it.
    if (!sameEmail(after.email, to)) {
      console.error(`[billing] ${who.email}: invoice email of ${r.customerId} (${name}) asked as ${to}, Stripe has ${after.email ?? "none"}`);
      return say(409, `Stripe answered, but has ${after.email ?? "no address"} for this customer, not ${to}. Refresh the Billing tab and check it in Stripe.`);
    }
    console.log(`[billing] ${who.email} changed the invoice email of ${r.customerId} (${name}) from ${now.email ?? "none"} to ${after.email}`);
    return NextResponse.json({ ok: true, email: after.email }, { headers: NO_STORE });
  } catch (e) {
    // Stripe or our checks said no: nothing was changed.
    if (e instanceof InvoiceEmailError && e.status !== 502) {
      console.warn(`[billing] ${who.email}: invoice email of ${r.customerId} refused: ${e.message}`);
      return say(e.status, e.message);
    }
    if (!sent) {
      console.error(`[billing] invoice email of ${r.customerId} (before sending) failed:`, e);
      return say(502, "Stripe could not be reached. Nothing was changed. Try again in a minute.");
    }
    console.error(`[billing] invoice email of ${r.customerId} sent, no clear answer:`, e);
    getStripeSnapshot.invalidate();
    return NextResponse.json({ error: UNCERTAIN, uncertain: true }, { status: 502, headers: NO_STORE });
  }
}
