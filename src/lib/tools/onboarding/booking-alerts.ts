import "server-only";

import { getOnboardingDb } from "./db";
import { notifySlack, slackMention, esc } from "./slack";
import { cancelNeedsPing, type BookingEvent } from "./booking-alerts-pure";

/*
 * A client who cancelled their onboarding call and hasn't rebooked would
 * otherwise vanish silently (the date just clears). Ping the team once per
 * cancellation — running on the 10-min tick means an instant reschedule
 * (cancel+rebook pair) never pings. The tool's `pingLostBookings`
 * (lib/email-guard.ts); the guard's other half, which SENDS the welcome and
 * confirmations emails, is not ported — sending is switched off in the OS.
 */
export async function pingLostBookings(): Promise<{ pinged: number }> {
  const db = getOnboardingDb();
  const { data: clients } = await db.from("orch_clients")
    .select("id, client_name").is("onboarding_date", null)
    .not("status", "in", "(campaign_launched,live,paused)");
  let pinged = 0;
  for (const c of (clients ?? []) as { id: string; client_name: string | null }[]) {
    const { data: evs } = await db.from("orch_connector_deliveries")
      .select("action, created_at").eq("client_id", c.id)
      .in("action", ["onboarding_call_canceled", "booking_cancel_ping"])
      .order("created_at", { ascending: false }).limit(10);
    if (!cancelNeedsPing((evs ?? []) as BookingEvent[])) continue;
    await notifySlack({
      clientId: c.id, action: "booking_cancel_ping",
      text: `${slackMention()} :warning: *${esc(c.client_name ?? "A client")}* canceled their onboarding call and hasn't rebooked — worth a follow-up before their campaign moves ahead.`,
    }).catch((e) => console.error("cancel ping failed", e));
    pinged++;
  }
  return { pinged };
}
