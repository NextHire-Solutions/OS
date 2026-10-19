import "server-only";

import { ttlCache } from "@/lib/cache/ttl";
import { stripeKey } from "@/lib/tools/onboarding/stripe";

/*
 * The portal's Billing link (19 Oct): a Stripe customer-portal session for
 * the client's own Stripe customer (billing-pick.ts decides which), with the
 * customer-portal settings made for the client portal — invoices, update the
 * card, cancel at the end of the paid period — found by their label
 * (metadata os_purpose), so no setting has to be copied anywhere.
 *
 * Creating a session moves no money and tells no one; it is a link, valid
 * for a few minutes, to that customer's Stripe page. What the person then
 * does there (a new card, a cancellation) is real — the user chose that for
 * the preview on 19 Oct ("Full Stripe page now").
 */

const STRIPE = "https://api.stripe.com/v1";
export const PORTAL_CONFIG_PURPOSE = "crm-client-portal";

/** The customer-portal settings labelled for the client portal, or null when none is set up yet. */
export const portalConfiguration = ttlCache(async (): Promise<string | null> => {
  const res = await fetch(`${STRIPE}/billing_portal/configurations?limit=100&active=true`, {
    headers: { Authorization: `Bearer ${stripeKey()}` }, cache: "no-store", signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => null)) as { data?: Array<{ id: string; metadata?: Record<string, string> }>; error?: { message?: string } } | null;
  if (!res.ok) throw new Error(`Stripe: ${body?.error?.message ?? res.status}`);
  return (body?.data ?? []).find((c) => c.metadata?.os_purpose === PORTAL_CONFIG_PURPOSE)?.id ?? null;
}, { ttlMs: 5 * 60_000, key: () => "config", shared: "crm-billing-portal-config" });

/** A short-lived link to one customer's Stripe billing page. */
export async function billingPortalUrl(customer: string, returnUrl: string, configuration: string): Promise<string> {
  const res = await fetch(`${STRIPE}/billing_portal/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${stripeKey()}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ customer, return_url: returnUrl, configuration }).toString(),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => null)) as { url?: string; error?: { message?: string } } | null;
  if (!res.ok || !body?.url) throw new Error(`Stripe: ${body?.error?.message ?? res.status}`);
  if (!/^https:\/\/billing\.stripe\.com\//.test(body.url)) throw new Error("Stripe returned an unexpected address.");
  return body.url;
}
