import { z } from "zod";

/*
 * The Settings tab's rules, pure (27 Nov): what may be changed, what is sent, and when EmailBison would refuse it.
 * The writes are settings-update.ts; the route and the Claude connector's sending-limits action share both.
 */

/*
 * Exactly the fields PATCH /api/campaigns/{id}/update accepts, and no others.
 * Status is deliberately absent: it is changed only through the pause/resume/
 * archive endpoints, which have their own eligibility rules and confirmation.
 */
export const Settings = z
  .object({
    name: z.string().min(1).max(255),
    max_emails_per_day: z.number().int().min(0).max(100_000),
    max_new_leads_per_day: z.number().int().min(0).max(100_000),
    plain_text: z.boolean(),
    open_tracking: z.boolean(),
    can_unsubscribe: z.boolean(),
    include_auto_replies_in_stats: z.boolean(),
    sequence_prioritization: z.enum(["followups", "new_leads"]),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "No settings supplied" });

export type SettingsPatch = z.infer<typeof Settings>;

/*
 * EmailBison enforces max_emails_per_day >= max_new_leads_per_day and rejects
 * the whole update with a 422 otherwise. Checking it here too is not
 * duplication for its own sake: the form usually sends only the field that
 * changed, so lowering the send limit alone would be rejected for a reason that
 * mentions a field the user never touched.
 */
export function crossFieldError(
  merged: { max_emails_per_day?: number | null; max_new_leads_per_day?: number | null },
): string | null {
  const emails = merged.max_emails_per_day;
  const leads = merged.max_new_leads_per_day;
  if (emails == null || leads == null) return null;
  return emails >= leads
    ? null
    : `Daily send limit (${emails}) must be at least the new-leads-per-day limit (${leads}). ` +
        `Lower new leads per day first, or raise the send limit.`;
}

/** Only the columns that exist locally, named as they are in our schema. */
export const COLUMN_OF: Record<string, string> = {
  name: "name",
  max_emails_per_day: "max_emails_per_day",
  max_new_leads_per_day: "max_new_leads_per_day",
  plain_text: "plain_text",
  open_tracking: "open_tracking",
  can_unsubscribe: "can_unsubscribe",
  include_auto_replies_in_stats: "include_auto_replies_in_stats",
  sequence_prioritization: "sequence_prioritization",
};

export type SettingsBefore = Record<string, unknown> & { id: number; name: string };

/** What would be sent to EmailBison for this patch — only what changed, the limit pair together — or why not. */
export function planSettings(before: SettingsBefore, patch: Record<string, unknown>): { changed: Record<string, unknown>; conflict: string | null } {
  /*
   * Only send what actually changed. EmailBison's update endpoint documents
   * that omitted booleans default to false — so echoing the full form back
   * would silently switch off any flag the user never touched.
   */
  const changed = Object.fromEntries(
    Object.entries(patch).filter(([key, value]) => value !== (before as Record<string, unknown>)[key]),
  );

  /*
   * THE TWO SENDING LIMITS MUST TRAVEL TOGETHER.
   *
   * EmailBison validates `max_emails_per_day >= max_new_leads_per_day` across
   * the REQUEST, not against the campaign as stored. Laravel's `gte:` rule
   * compares one submitted field with another submitted field — so when only
   * one of the pair is sent, the other is missing and the rule fails outright.
   *
   * Measured against a real draft campaign whose two limits are both 1000,
   * by sending it its own values back:
   *
   *   { max_emails_per_day: 1000 }                        → 422
   *   { max_new_leads_per_day: 1000 }                     → 422
   *   { max_emails_per_day: 1000, max_new_leads_per_day: 1000 } → 200
   *
   * That is what someone hit changing the daily send limit to 2000 with new
   * leads at 1000: a perfectly valid pair, refused, with an error naming a
   * field they had not touched.
   *
   * So whenever either limit is in the patch, send both, filling the untouched
   * one from the campaign as it stands. These are numbers, not the booleans the
   * "only send what changed" rule above exists to protect, so nothing is
   * clobbered by naming them.
   */
  const LIMIT_PAIR = ["max_emails_per_day", "max_new_leads_per_day"] as const;
  if (LIMIT_PAIR.some((key) => key in changed)) {
    for (const key of LIMIT_PAIR) {
      if (key in changed) continue;
      const current = (before as Record<string, unknown>)[key];
      // If we do not hold the partner value there is nothing honest to send;
      // EmailBison's own error is then the right thing for the user to see.
      if (current != null) changed[key] = current;
    }
  }
  if (Object.keys(changed).length === 0) return { changed, conflict: null };
  // Validate against the campaign as it WOULD be, not against the patch alone.
  return { changed, conflict: crossFieldError({ ...before, ...changed } as Record<string, number | null>) };
}

