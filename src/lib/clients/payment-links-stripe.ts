/*
 * The Stripe calls for a subscription created from the OS. Plain fetch, and
 * the key passed in — so the whole flow can be exercised against Stripe's
 * test mode with the test key, without touching the live account.
 */
import { recurringParams, type Every } from "./payment-link-plan.ts";

const STRIPE = "https://api.stripe.com/v1";

async function call(key: string, method: "GET" | "POST", path: string, params?: Record<string, string>) {
  const res = await fetch(`${STRIPE}${path}${method === "GET" && params ? "?" + new URLSearchParams(params) : ""}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: method === "POST" && params ? new URLSearchParams(params).toString() : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) throw new Error((json?.error as { message?: string } | undefined)?.message ?? `Stripe ${res.status}`);
  return json ?? {};
}

/**
 * A price for exactly this amount and frequency, and a Payment Link for it
 * that can be paid ONCE (no accidental second subscription). The OS client
 * id rides on both the link and the subscription it creates.
 */
export async function createStripeLink(key: string, o: { clientId: string; clientName: string; cents: number; every: Every }) {
  const price = await call(key, "POST", "/prices", {
    currency: "usd",
    unit_amount: String(o.cents),
    "product_data[name]": `BrokerStaffer — ${o.clientName || "Client"}`,
    ...recurringParams(o.every),
  });
  const link = await call(key, "POST", "/payment_links", {
    "line_items[0][price]": String(price.id),
    "line_items[0][quantity]": "1",
    "metadata[os_client_id]": o.clientId,
    "subscription_data[metadata][os_client_id]": o.clientId,
    "restrictions[completed_sessions][limit]": "1",
  });
  return { linkId: String(link.id), url: String(link.url), priceId: String(price.id) };
}

/** The subscription a paid link created, or null while it is unpaid. */
export async function paidSubscription(key: string, linkId: string): Promise<{ subscriptionId: string; customerId: string } | null> {
  const r = await call(key, "GET", "/checkout/sessions", { payment_link: linkId, limit: "10" });
  for (const s of ((r.data as Record<string, unknown>[] | undefined) ?? [])) {
    if (s.status === "complete" && typeof s.subscription === "string" && typeof s.customer === "string") {
      return { subscriptionId: s.subscription, customerId: s.customer };
    }
  }
  return null;
}

/** Switch a link off so it can no longer be paid. */
export async function deactivateStripeLink(key: string, linkId: string): Promise<void> {
  await call(key, "POST", `/payment_links/${encodeURIComponent(linkId)}`, { active: "false" });
}
