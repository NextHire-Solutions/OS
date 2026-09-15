import "server-only";

import { getOnboardingDb } from "./db";
import { envNumber, onboardingEnv } from "./env";
import { hasDelivery, recordPendingEmail } from "./deliveries";
import { automationEnabled } from "./settings";
import { getTemplateByKey } from "./templates";
import { DEFAULT_BOOKING_URL, DEFAULT_FOLLOWUP_DAYS, FOLLOWUP_STATUSES, followupDue, type FollowupCandidate } from "./followup-pure";

/*
 * Step 27 — post-onboarding follow-up: ~3 weeks after the onboarding call,
 * email the client once to book a Touch Base check-in. The tool's
 * `lib/followup.ts` (`sendDueFollowups`), with one change: where it would SEND,
 * this records "due, pending enablement" — a pending delivery on
 * `email / followup_call` — and sends nothing.
 *
 * Anchor: onboarding_date (Calendly-booked); falls back to created_at when no
 * call was booked. Eligibility: campaign actually running. Dedupe: an ok
 * delivery means never again; a pending one means already recorded.
 */

const DAYS = () => envNumber("FOLLOWUP_DAYS", DEFAULT_FOLLOWUP_DAYS);
const BOOKING_URL = () => onboardingEnv("FOLLOWUP_BOOKING_URL") ?? DEFAULT_BOOKING_URL;

export async function recordDueFollowups(): Promise<{ due: number; recorded: number }> {
  if (!(await automationEnabled())) return { due: 0, recorded: 0 }; // manual mode: run it from the client page
  const tpl = await getTemplateByKey("followup_call");
  if (!tpl) return { due: 0, recorded: 0 }; // template deleted -> feature off (team's choice)

  const { data } = await getOnboardingDb().from("orch_clients")
    .select("id, client_name, primary_contact, portal_url, onboarding_date, created_at, status")
    .in("status", [...FOLLOWUP_STATUSES]);
  const clients = (data ?? []) as (FollowupCandidate & { id: string })[];
  if (!clients.length) return { due: 0, recorded: 0 };

  const now = Date.now();
  let due = 0, recorded = 0;
  for (const c of clients) {
    if (!followupDue(c, now, DAYS())) continue;
    // once per client, ever
    if (await hasDelivery(c.id, "email", ["followup_call"])) continue;
    due++;
    const r = await recordPendingEmail(c.id, "followup_call", {
      via: "follow-up scheduler",
      extra: { anchor: c.onboarding_date ?? c.created_at, days: DAYS(), bookingLink: BOOKING_URL() },
    });
    if (r.recorded) recorded++;
  }
  return { due, recorded };
}
