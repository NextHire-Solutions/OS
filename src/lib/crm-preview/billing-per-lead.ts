/*
 * The portal's Billing page for a client billed per lead (16 Nov).
 *
 * The page was built for subscriptions (billing-periods.ts): a period is a Stripe subscription invoice's service period
 * and it counts the introductions in it. A pay-per-lead client's invoices are the OS's own — one line per lead, no
 * service period — so Homebase, who has paid, read "No billing periods yet", and it would have counted a lead the team
 * agreed not to bill. Here a period is the pay-per-lead period (every 7 or 14 days from the anchor, as the Billing tab
 * has it) and the number is the leads billed in it: what was charged for a charged period, the leads so far for the
 * one running, those waiting to be charged for one that ended. The same records the Billing tab reads.
 *
 * Pure: billing-page.ts reads the records and the counts.
 */

import { addDays, BILLED_STATUSES, type PeriodStatus } from "@/lib/clients/usage-billing/model";

export type PerLeadStatus = "paid" | "due" | "unpaid" | "billing" | "unbilled" | "current" | "none";

export interface PerLeadPeriod {
  /** yyyy-mm-dd, the first day. */
  start: string;
  /** yyyy-mm-dd, the last day. */
  end: string;
  invoice: string | null;
  status: PerLeadStatus;
  /** Leads billed (or, unbilled, to be billed) for the period; null when they couldn't be counted just now. */
  leads: number | null;
  current: boolean;
}

export interface PeriodRecord {
  period_start: string;
  status: PeriodStatus;
  lead_count: number;
  stripe_invoice_number: string | null;
}

/** What a charged period's record says to the client. */
function chargedStatus(s: PeriodStatus): PerLeadStatus {
  if (s === "paid") return "paid";
  if (s === "charged") return "due";
  if (s === "failed") return "unpaid";
  return "billing"; // draft: being charged right now
}

/** The periods from the anchor to the one running today, newest first, at most `limit`. */
export function periodStarts(anchor: string, everyDays: number, today: string, limit = 12): string[] {
  if (today < anchor || !(everyDays > 0)) return [];
  const starts: string[] = [];
  for (let s = anchor; s <= today; s = addDays(s, everyDays)) starts.push(s);
  return starts.reverse().slice(0, limit);
}

/** The record that speaks for a period: a charge before a void, a void before a preview. */
function recordFor(records: readonly PeriodRecord[], start: string): PeriodRecord | null {
  const mine = records.filter((r) => r.period_start === start);
  return mine.find((r) => BILLED_STATUSES.includes(r.status)) ?? mine.find((r) => r.status === "void") ?? mine.find((r) => r.status === "preview") ?? null;
}

/**
 * Which periods need their leads counted now: the one running (more can come), and one that ended with nothing on
 * record. A charged or voided period says its own; an ended one the automatic run previewed says what it found then.
 */
export function startsToCount(o: { anchor: string; everyDays: number; today: string; records: readonly PeriodRecord[]; limit?: number }): string[] {
  return periodStarts(o.anchor, o.everyDays, o.today, o.limit).filter((start) => {
    const end = addDays(start, o.everyDays - 1);
    if (start <= o.today && o.today <= end) return true;
    return !recordFor(o.records, start);
  });
}

/**
 * The periods as the client reads them, newest first.
 *
 * @param counts leads per period start, for the periods `startsToCount` named; null when one couldn't be counted
 */
export function perLeadPeriods(o: {
  anchor: string;
  everyDays: number;
  today: string;
  records: readonly PeriodRecord[];
  counts: ReadonlyMap<string, number | null>;
  limit?: number;
}): PerLeadPeriod[] {
  return periodStarts(o.anchor, o.everyDays, o.today, o.limit).map((start) => {
    const end = addDays(start, o.everyDays - 1);
    const current = start <= o.today && o.today <= end;
    const r = recordFor(o.records, start);
    if (r && BILLED_STATUSES.includes(r.status)) {
      return { start, end, invoice: r.stripe_invoice_number, status: chargedStatus(r.status), leads: r.lead_count, current };
    }
    // Voided in Stripe: nothing charged — but with leads in it, it can be charged again, so it is "not billed yet",
    // and the voided invoice's number is not one to quote.
    const leads = current || !r ? (o.counts.has(start) ? o.counts.get(start)! : null) : r.lead_count;
    if (current) return { start, end, invoice: null, status: "current", leads, current };
    return { start, end, invoice: null, status: leads === 0 ? "none" : "unbilled", leads, current };
  });
}
