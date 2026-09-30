import "server-only";

import { stripeKey } from "@/lib/tools/onboarding/stripe";

import { editClient } from "./edit";
import { osTable } from "./os-db";
import { canCreate, describe, type Every } from "./payment-link-plan";
import { createStripeLink, deactivateStripeLink, paidSubscription } from "./payment-links-stripe";

/*
 * CREATE A SUBSCRIPTION FROM THE OS (30 Sep).
 *
 * An admin enters an amount and a frequency on the client's record; the OS
 * creates a Stripe Payment Link for exactly that (payable once) and shows it
 * to copy and send. When the client pays, Stripe creates the subscription and
 * `settle` links it to the client — through the record's own edit, which
 * confirms the subscription belongs to that customer. Nothing is charged by
 * the OS; the client pays through Stripe's own checkout.
 *
 * Settled on every read of the client's billing and every few minutes in the
 * background (instrumentation.ts) — no webhook needed, because Stripe's
 * webhooks still point at the original Onboarding app.
 */

export interface PaymentLink {
  id: string;
  url: string;
  amountCents: number;
  every: Every;
  status: "open" | "paid" | "cancelled";
  createdAt: string;
  createdBy: string | null;
  label: string;
}

export class PaymentLinkError extends Error {
  constructor(message: string) { super(message); this.name = "PaymentLinkError"; }
}

const MIGRATION = "Creating subscriptions needs migrations/0024_payment_links.sql run in the Master Inbox Supabase project.";
const missing = (m: string) => /relation .* does not exist|schema cache|os_payment_links/i.test(m);

type Row = { id: string; client_id: string; stripe_payment_link_id: string; url: string; amount_cents: number; every: Every; status: PaymentLink["status"]; created_at: string; created_by: string | null };
const toLink = (r: Row): PaymentLink => ({ id: r.id, url: r.url, amountCents: r.amount_cents, every: r.every, status: r.status, createdAt: r.created_at, createdBy: r.created_by, label: describe(r.amount_cents, r.every) });

export async function openLinks(clientId: string): Promise<PaymentLink[] | null> {
  const { data, error } = await osTable("os_payment_links").select("*").eq("client_id", clientId).eq("status", "open").order("created_at", { ascending: false });
  if (error) return null; // before 0024
  return ((data ?? []) as unknown as Row[]).map(toLink);
}

export async function createLink(clientId: string, cents: number, every: Every, by: string, currentSub: { status: string } | null): Promise<PaymentLink> {
  if (!canCreate(currentSub)) throw new PaymentLinkError("This client already has a live subscription. Pause or change it in Stripe instead.");
  const open = await openLinks(clientId);
  if (open === null) throw new PaymentLinkError(MIGRATION);
  if (open.length) throw new PaymentLinkError("This client already has a payment link waiting to be paid. Cancel it first to make a new one.");
  const { data: c } = await osTable("os_clients").select("name").eq("id", clientId).maybeSingle();
  if (!c) throw new PaymentLinkError("No such client.");
  const link = await createStripeLink(stripeKey(), { clientId, clientName: (c as { name: string }).name, cents, every });
  const { data, error } = await osTable("os_payment_links").insert({
    client_id: clientId, stripe_payment_link_id: link.linkId, url: link.url, amount_cents: cents, every, created_by: by,
  }).select("*").single();
  if (error) {
    // The link exists in Stripe but could not be remembered: switch it off rather than leave it payable and untracked.
    const off = await deactivateStripeLink(stripeKey(), link.linkId).then(() => true, () => false);
    const base = missing(error.message) ? MIGRATION : error.message;
    throw new PaymentLinkError(off ? base : `${base} The Stripe link ${link.linkId} could NOT be switched off — deactivate it in Stripe.`);
  }
  /*
   * One open link per client. The check above is read-then-write, so two
   * clicks (or two admins) at once can both pass it. Whoever finds another
   * open link created before theirs backs out: switches their own link off
   * in Stripe and cancels the row, so exactly one link stays payable.
   */
  const now = await openLinks(clientId);
  const mine = data as unknown as Row;
  const earlier = (now ?? []).filter((l) => l.id !== mine.id && (l.createdAt < mine.created_at || (l.createdAt === mine.created_at && l.id < mine.id)));
  if (earlier.length) {
    await deactivateStripeLink(stripeKey(), mine.stripe_payment_link_id).catch(() => {});
    await osTable("os_payment_links").update({ status: "cancelled" }).eq("id", mine.id).eq("status", "open");
    throw new PaymentLinkError("A payment link for this client was just created by another request. Use that one.");
  }
  return toLink(mine);
}

export async function cancelLink(clientId: string, id: string): Promise<void> {
  const { data } = await osTable("os_payment_links").select("*").eq("id", id).eq("client_id", clientId).eq("status", "open").maybeSingle();
  if (!data) throw new PaymentLinkError("That payment link is not open.");
  const row = data as unknown as Row;
  // Paid a moment ago? Link it rather than cancel it.
  if (await settleRow(row)) throw new PaymentLinkError("That link was just paid — the subscription is now linked to the client.");
  await deactivateStripeLink(stripeKey(), row.stripe_payment_link_id);
  await osTable("os_payment_links").update({ status: "cancelled" }).eq("id", id).eq("status", "open");
}

/**
 * If this link has been paid, link the subscription to the client. True when it did.
 *
 * The client record is written FIRST and the row is marked paid only once
 * that write is confirmed. The other order lost payments: the row left
 * `open` before the link existed, so a failed or thrown `editClient` (a
 * Stripe timeout while it checks the subscription, a database error it
 * reports in `failed`) was never retried — the client paid, and the OS could
 * neither see the revenue nor pause the subscription. Linking the same
 * subscription twice is harmless, so a concurrent settle doing it too is fine.
 */
async function settleRow(row: Row): Promise<boolean> {
  const paid = await paidSubscription(stripeKey(), row.stripe_payment_link_id);
  if (!paid) return false;
  const result = await editClient(row.client_id, { stripeCustomerId: paid.customerId, stripeSubscriptionId: paid.subscriptionId });
  const osFailed = result.failed.find((f) => f.what === "the OS record");
  if (osFailed) throw new Error(`paid, but the client record could not be linked: ${osFailed.error}`);
  const { data: claimed } = await osTable("os_payment_links")
    .update({ status: "paid", subscription_id: paid.subscriptionId, customer_id: paid.customerId, paid_at: new Date().toISOString() })
    .eq("id", row.id).eq("status", "open").select("id");
  if (claimed?.length) console.log(`[payment-links] ${row.client_id} paid ${row.stripe_payment_link_id} → ${paid.subscriptionId}`);
  return true;
}

/** Switch off every open link of a client in Stripe (used before the client is deleted). */
export async function cancelOpenLinks(clientId: string): Promise<{ cancelled: number; failed: string[] }> {
  const open = await openLinks(clientId);
  const failed: string[] = [];
  let cancelled = 0;
  for (const l of open ?? []) {
    const { data } = await osTable("os_payment_links").select("stripe_payment_link_id").eq("id", l.id).maybeSingle();
    const sid = (data as { stripe_payment_link_id?: string } | null)?.stripe_payment_link_id;
    if (!sid) continue;
    try {
      await deactivateStripeLink(stripeKey(), sid);
      await osTable("os_payment_links").update({ status: "cancelled" }).eq("id", l.id).eq("status", "open");
      cancelled++;
    } catch (e) {
      failed.push(`${sid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { cancelled, failed };
}

/** Settle one client's open links, or every open link. Never throws. */
export async function settle(clientId?: string): Promise<number> {
  let q = osTable("os_payment_links").select("*").eq("status", "open");
  if (clientId) q = q.eq("client_id", clientId);
  const { data, error } = await q;
  if (error) return 0;
  let n = 0;
  for (const row of (data ?? []) as unknown as Row[]) {
    try { if (await settleRow(row)) n++; } catch (e) { console.error("[payment-links] settle failed:", e instanceof Error ? e.message : e); }
  }
  return n;
}
