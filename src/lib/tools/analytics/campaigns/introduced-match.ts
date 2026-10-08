/*
 * Which of a campaign's leads have been introduced — the "Introduced" status
 * on a campaign's Leads tab (asked for by Amy, 8 Oct).
 *
 * Pure, so the rule is tested without a database. The rows are Master Inbox's
 * portal-pipeline introductions (v_pipeline_outcomes, event "introduction"),
 * read live by introduced.ts — not Analytics' hourly copy of them — so a lead
 * shows Introduced the moment the Introduction label is applied.
 *
 * THE RULE
 *   - An introduction recorded for THIS campaign counts: its EmailBison lead id
 *     (EmailBison campaigns) and its email.
 *   - An introduction recorded with NO campaign counts by email, but only for
 *     the campaign's own client — a person introduced to Jeff Cook is not
 *     "introduced" on another client's campaign.
 *   - An introduction recorded for a DIFFERENT campaign does not count here:
 *     each campaign shows what came from it.
 *   - Cancelled (voided) introductions never count.
 * The Analytics functions (095) then mark a lead Introduced when its id or its
 * email is in the set — and only leads of the campaign being viewed.
 */

export interface IntroRow {
  email: string | null;
  emailbison_lead_id: string | number | null;
  campaign_id: string | number | null;
  client_id: string | null;
  voided?: boolean | null;
}

export interface IntroducedSet {
  /** EmailBison lead ids (empty for Instantly campaigns). */
  leadIds: number[];
  /** Lower-cased emails. */
  emails: string[];
}

const normEmail = (e: string | null | undefined) => (e ?? "").trim().toLowerCase();
const hasCampaign = (c: string | number | null | undefined) => c !== null && c !== undefined && String(c).trim() !== "";

export function introducedFor(
  rows: IntroRow[],
  campaignId: string | number,
  clientIds: Iterable<string>,
  platform: "emailbison" | "instantly",
): IntroducedSet {
  const want = String(campaignId).trim().toLowerCase();
  const clients = new Set(clientIds);
  const ids = new Set<number>();
  const emails = new Set<string>();
  for (const r of rows) {
    if (r.voided) continue;
    const email = normEmail(r.email);
    if (hasCampaign(r.campaign_id)) {
      if (String(r.campaign_id).trim().toLowerCase() !== want) continue;
      if (email) emails.add(email);
      if (platform === "emailbison" && r.emailbison_lead_id !== null && r.emailbison_lead_id !== undefined) {
        const n = Number(r.emailbison_lead_id);
        if (Number.isSafeInteger(n) && n > 0) ids.add(n);
      }
    } else if (r.client_id && clients.has(r.client_id) && email) {
      emails.add(email);
    }
  }
  return { leadIds: [...ids].sort((a, b) => a - b), emails: [...emails].sort() };
}
