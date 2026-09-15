/*
 * Step 27 — the due-date rule for the post-onboarding follow-up, on its own.
 *
 * Ported from the tool's `lib/followup.ts`: ~FOLLOWUP_DAYS after the onboarding
 * call (falling back to created_at when no call was booked), for clients whose
 * campaign is actually running.
 */

export const FOLLOWUP_STATUSES = ["campaign_launched", "live", "paused"] as const;
export const DEFAULT_FOLLOWUP_DAYS = 21;
export const DEFAULT_BOOKING_URL = "https://calendly.com/brokerstaffer/touchbase";

export interface FollowupCandidate {
  onboarding_date?: string | null;
  created_at: string;
  primary_contact?: { email?: string | null } | null;
}

/** The moment the follow-up clock started for a client. NaN when unparseable. */
export function followupAnchor(c: FollowupCandidate): number {
  return new Date(c.onboarding_date ?? c.created_at).getTime();
}

/**
 * Is the follow-up due? The anchor must be at or before `now - days`, and the
 * client must have an address to send to. Everything else (status, dedupe) is
 * the caller's — this is only the arithmetic.
 */
export function followupDue(c: FollowupCandidate, nowMs: number, days: number): boolean {
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
  const anchor = followupAnchor(c);
  if (Number.isNaN(anchor) || anchor > cutoff) return false;
  return !!c.primary_contact?.email;
}
