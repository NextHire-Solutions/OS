/*
 * Is a lead REALLY not on a campaign? (9 Oct)
 *
 * EmailBison refuses a removal for an id that is not on the campaign ("The
 * selected lead_ids.N is invalid"). The Leads tab is built from send history,
 * so it can still list a lead EmailBison already took off — removed in
 * EmailBison directly, or dropped by EmailBison itself (bounced leads) — and
 * until now such a lead stayed on screen, was selected again, and failed again.
 *
 * Hiding it is only right if it is truly gone, so a refusal is never taken on
 * its own word. Two more independent answers from EmailBison must agree:
 *
 *   1. the lead's own record does not list this campaign (lead_campaign_data);
 *   2. searching THIS campaign's leads for the lead's email finds no such lead.
 *
 * The search also proves the campaign is reachable with this key — so a lead
 * that 404s really was deleted, not hidden in another workspace. Anything
 * unclear — an error, no email to search by, a search that did not narrow, or
 * the two answers disagreeing — is "unsure", and the lead stays listed.
 */

export type LeadLookup =
  | { status: "found"; campaignIds: number[]; email: string | null }
  | { status: "deleted" }
  | { status: "error" };

export type CampaignSearch = { ok: true; total: number; leadIds: number[] } | { ok: false };

/** A search that returns more than this did not narrow to one person; it proves nothing. */
export const MAX_SEARCH_HITS = 25;

export function confirmOff(
  campaignId: number,
  leadId: number,
  lead: LeadLookup,
  search: CampaignSearch | null,
): "off" | "on" | "unsure" {
  if (lead.status === "found" && lead.campaignIds.includes(campaignId)) return "on";
  if (search?.ok && search.leadIds.includes(leadId)) return "on";
  if (lead.status === "error") return "unsure";
  if (!search || !search.ok) return "unsure";
  if (search.total > MAX_SEARCH_HITS) return "unsure";
  return "off";
}
