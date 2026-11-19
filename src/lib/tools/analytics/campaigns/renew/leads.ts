/*
 * DUPLICATE & RENEW — which of the old campaign's leads go to the new one, and how.
 *
 * The spec: every lead that is "In Sequence" or "Sequence Finished" on the old
 * campaign starts the sequence again on the new one; no duplicates; the old
 * campaign's history stays.
 *
 *   In Sequence        → MOVED (EmailBison's own Move): the lead stops on the
 *                        old campaign and starts on the new one — what the team
 *                        does by hand today (LIV Indy 5: 1,634 leads "moved to
 *                        another campaign"). Copying instead would leave it being
 *                        emailed by both.
 *   Sequence Finished  → COPIED (attach): the old campaign keeps it as finished.
 *   anything else      → left where it is (replied, stopped, never contacted,
 *                        bounced, unsubscribed).
 *
 * EACH LEAD'S OWN STATUS, NOT EMAILBISON'S STATUS FILTER. Measured 19 Nov: on a
 * PAUSED campaign every In Sequence lead reads "sending_paused" and the filter
 * files them under never_contacted — the filter would lose them all. So the
 * status is read from the lead's own row for this campaign.
 *
 * A LEAD ANOTHER CAMPAIGN IS ALSO EMAILING GOES TOO (the user, 19 Nov: "I want
 * 'in sequence' and 'sequence finished' leads added to this new campaign
 * whether they are present in any other campaign or not"). EmailBison refuses
 * such a lead unless the call says allow_parallel_sending (a draft counts as
 * emailing it; a paused campaign does not), and a MOVE without it stops the lead
 * on the old campaign and never adds it to the new one — so renew always sends
 * that option (io.ts). Those leads get both sequences until one ends; the
 * review counts and names them ("busy").
 *
 * Pure: no I/O, so these rules are pinned by leads.test.ts.
 */

/** One lead as EmailBison's campaign leads list returns it. */
export interface CampaignLeadRow {
  id: number;
  email?: string | null;
  /** The LEAD's status (verified, unverified, bounced, unsubscribed, …). */
  status?: string | null;
  lead_campaign_data?: Array<{ campaign_id: number | string; status?: string | null; status_reason?: string | null }> | null;
}

/** On the old campaign: still being sent the sequence (running, or paused part-way). */
const IN_SEQUENCE = new Set(["in_sequence", "sending_paused"]);
const FINISHED = "sequence_finished";
/** On ANOTHER campaign: EmailBison refuses to add the lead anywhere else (a draft counts; paused does not). */
const BUSY_ELSEWHERE = new Set(["in_sequence"]);
/** The lead itself can never be emailed again. */
const DEAD_LEAD = new Set(["bounced", "unsubscribed"]);

export interface BusyExample {
  id: number;
  email: string | null;
  /** The other campaigns emailing it. */
  campaignIds: number[];
}

export interface LeadPlan {
  /** In Sequence here: to be moved. */
  move: number[];
  /** Sequence Finished here: to be copied. */
  copy: number[];
  /** Of `move` and `copy`, the leads another campaign is also emailing right now: added anyway (both sequences). */
  busy: { move: number; copy: number; examples: BusyExample[] };
  /** Left where they are, by what they are here (replied, stopped, never_contacted, bounced, unsubscribed, …). */
  left: Record<string, number>;
  /** Every distinct lead looked at. */
  total: number;
}

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

export function planLeads(campaignId: number, rows: readonly CampaignLeadRow[]): LeadPlan {
  const plan: LeadPlan = { move: [], copy: [], busy: { move: 0, copy: 0, examples: [] }, left: {}, total: 0 };
  const seen = new Set<number>();
  const leave = (why: string) => { plan.left[why] = (plan.left[why] ?? 0) + 1; };

  for (const row of rows) {
    const id = Number(row.id);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    plan.total++;

    const data = row.lead_campaign_data ?? [];
    const here = data.find((d) => Number(d.campaign_id) === campaignId);
    const status = norm(here?.status);
    const leadStatus = norm(row.status);

    if (DEAD_LEAD.has(leadStatus)) { leave(leadStatus); continue; }
    const want = IN_SEQUENCE.has(status) ? "move" : status === FINISHED ? "copy" : null;
    if (!want) { leave(status || "unknown"); continue; }

    const busyIn = data
      .filter((d) => Number(d.campaign_id) !== campaignId && BUSY_ELSEWHERE.has(norm(d.status)))
      .map((d) => Number(d.campaign_id));
    if (busyIn.length) {
      plan.busy[want]++;
      if (plan.busy.examples.length < 5) plan.busy.examples.push({ id, email: row.email ?? null, campaignIds: busyIn });
    }
    plan[want].push(id);
  }
  return plan;
}

/** How many leads the new campaign will be given. */
export function leadsToTransfer(plan: LeadPlan): number {
  return plan.move.length + plan.copy.length;
}

/** "replied" → "Replied", "never_contacted" → "Never contacted": the label a status is shown with. */
export function statusLabel(status: string): string {
  const s = status.replace(/_/g, " ").trim();
  if (s === "stopped") return "Sequence stopped";
  return s ? s[0].toUpperCase() + s.slice(1) : "Unknown";
}
