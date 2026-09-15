/*
 * "Cancelled the onboarding call and has not rebooked" — the rule, on its own.
 *
 * A client who cancels would otherwise vanish silently (the date just clears).
 * The team is pinged once per cancellation: the newest cancel event must be
 * newer than the newest ping. Ported from the tool's `lib/email-guard.ts`
 * (`pingLostBookings`).
 */

export interface BookingEvent {
  action: string;
  created_at: string;
}

export function cancelNeedsPing(events: BookingEvent[]): boolean {
  const lastCancel = events.find((e) => e.action === "onboarding_call_canceled");
  if (!lastCancel) return false; // never had a booking to lose
  const lastPing = events.find((e) => e.action === "booking_cancel_ping");
  if (lastPing && lastPing.created_at > lastCancel.created_at) return false; // this cancel already pinged
  return true;
}
