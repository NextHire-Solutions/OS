import { NextResponse } from "next/server";

import { getOnboardingDb } from "@/lib/tools/onboarding/db";
import { logDelivery } from "@/lib/tools/onboarding/deliveries";
import { onboardingEnv } from "@/lib/tools/onboarding/env";
import { ensureOnboardingScheduler } from "@/lib/tools/onboarding/scheduler";
import { getCheckoutSession } from "@/lib/tools/onboarding/stripe";
import { isPaidSession } from "@/lib/tools/onboarding/stripe-pure";
import { queryTokenAccepted } from "@/lib/tools/onboarding/webhook-auth";

/*
 * Stripe posts payment events here. The tool's `app/api/webhooks/stripe/route.ts`.
 *
 *   PUBLIC URL  https://os.brokerstaffer.com/api/tools/onboarding/webhooks/stripe[?token=<ONBOARDING_STRIPE_WEBHOOK_TOKEN>]
 *   EVENT       checkout.session.completed, in the mode of the key held (test/live)
 *
 * Verification is the tool's: no signing secret — the Checkout Session is
 * re-fetched from Stripe with our own key and must actually be paid. A READ of
 * Stripe; nothing here creates a charge or a link.
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  ensureOnboardingScheduler();
  if (!queryTokenAccepted(req.url, onboardingEnv("STRIPE_WEBHOOK_TOKEN"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let event: { type?: string; data?: { object?: { id?: string } } };
  try { event = await req.json(); } catch { return NextResponse.json({ error: "invalid json" }, { status: 400 }); }
  if (event?.type !== "checkout.session.completed") {
    return NextResponse.json({ ok: true, ignored: event?.type ?? "unknown" });
  }

  const sessionId = event?.data?.object?.id;
  if (!sessionId) return NextResponse.json({ error: "no session id" }, { status: 400 });

  // Verify against Stripe directly (defends against spoofed events).
  let session: Record<string, unknown> | null;
  try { session = await getCheckoutSession(sessionId); }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 }); }
  if (!isPaidSession(session)) return NextResponse.json({ ok: true, ignored: "not paid" });

  // Map to a client: metadata.client_id first, else the payment link we stored on send.
  const clientId = (session?.metadata as { client_id?: string } | undefined)?.client_id;
  const paymentLink = session?.payment_link as string | undefined;
  const patch: Record<string, unknown> = {
    stripe_paid: true, stripe_paid_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  if (session?.amount_total != null) patch.stripe_amount = session.amount_total;
  if (session?.customer != null) patch.stripe_customer_id = session.customer;
  // Scoped to ONE client, always: by id when Stripe carries it, else by the
  // stored link id. Neither present means nothing to match — never a bare update.
  if (!clientId && !paymentLink) return NextResponse.json({ ok: true, ignored: "no matching client" });
  const { data, error } = await getOnboardingDb().from("orch_clients").update(patch)
    .eq(clientId ? "id" : "stripe_payment_link_id", clientId ?? paymentLink!)
    .select("id").maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ ok: true, ignored: "no matching client" });

  const id = (data as { id: string }).id;
  await logDelivery(id, "stripe", "payment_succeeded", "ok",
    { session_id: sessionId }, { amount_total: session?.amount_total ?? null }, null);
  return NextResponse.json({ ok: true, clientId: id, paid: true });
}
