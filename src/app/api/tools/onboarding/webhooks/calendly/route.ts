import { NextResponse } from "next/server";

import { getOnboardingDb } from "@/lib/tools/onboarding/db";
import { hasDelivery, logDelivery, recordPendingEmail } from "@/lib/tools/onboarding/deliveries";
import { onboardingEnv } from "@/lib/tools/onboarding/env";
import { calendlyDecision } from "@/lib/tools/onboarding/calendly-pure";
import { ensureOnboardingScheduler } from "@/lib/tools/onboarding/scheduler";
import { automationEnabled } from "@/lib/tools/onboarding/settings";
import { queryTokenAccepted } from "@/lib/tools/onboarding/webhook-auth";

/*
 * Calendly posts here when a client books (or cancels) the setup call. The
 * tool's `app/api/webhooks/calendly/route.ts`.
 *
 *   PUBLIC URL  https://os.brokerstaffer.com/api/tools/onboarding/webhooks/calendly?token=<ONBOARDING_CALENDLY_WEBHOOK_TOKEN>
 *   AUTH        shared token in the query string; skipped only while unset
 *
 * invitee.created  -> match invitee email to the client -> save onboarding_date.
 *                     With automation ON the tool then sends Welcome and
 *                     Confirmations; the OS records both as pending enablement.
 * invitee.canceled -> clear onboarding_date so a rebooking can land cleanly.
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  ensureOnboardingScheduler();
  if (!queryTokenAccepted(req.url, onboardingEnv("CALENDLY_WEBHOOK_TOKEN"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid json" }, { status: 400 }); }

  const d = calendlyDecision(body, onboardingEnv("CALENDLY_EVENT_TYPE_URI"));
  if ("ignored" in d) return NextResponse.json({ ok: true, ignored: d.ignored });

  const db = getOnboardingDb();
  // Match the client by contact email (newest first if several).
  const { data: matches } = await db.from("orch_clients")
    .select("id, client_name")
    .ilike("primary_contact->>email", d.email)
    .order("created_at", { ascending: false }).limit(1);
  const client = (matches as { id: string; client_name: string | null }[] | null)?.[0];
  if (!client) return NextResponse.json({ ok: true, ignored: "no matching client", email: d.email });

  const onboarding_date = d.event === "invitee.created" ? d.startTime : null;
  await db.from("orch_clients")
    .update({ onboarding_date, updated_at: new Date().toISOString() }).eq("id", client.id);

  await logDelivery(client.id, "calendly",
    d.event === "invitee.created" ? "onboarding_call_booked" : "onboarding_call_canceled",
    "ok", { email: d.email, start_time: d.startTime, event_name: d.eventName }, null, null);

  // With automation ON the tool sends both client emails here — Welcome first
  // (date never blank), then Confirmations — once per client, the delivery log
  // being the dedupe. The OS records each unsent one as pending enablement.
  const pending: string[] = [];
  if (d.event === "invitee.created" && (await automationEnabled())) {
    if (!(await hasDelivery(client.id, "email", ["welcome", "welcome_nobooking"]))) {
      pending.push((await recordPendingEmail(client.id, "welcome", { via: "calendly booking" })).action);
    }
    if (!(await hasDelivery(client.id, "email", ["confirmations"]))) {
      pending.push((await recordPendingEmail(client.id, "confirmations", { via: "calendly booking" })).action);
    }
  }

  return NextResponse.json({ ok: true, clientId: client.id, onboarding_date, welcomed: false, confirmations: false, pending });
}
