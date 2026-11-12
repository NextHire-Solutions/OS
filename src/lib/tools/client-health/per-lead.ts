import { capWindowOf, CAP_WINDOW_DAYS, effectiveCap } from "@/lib/clients/usage-billing/caps-model.ts";
import { addDays, daysBetween, easternDay, periodOf } from "@/lib/clients/usage-billing/model.ts";

import { billingDueInWeek, billingSnapshot, type BillingDueInWeek, type BillingSnapshot } from "./billing.ts";
import type { DashboardClient } from "./types.ts";

/*
 * Clients billed PER LEAD, as Client Health measures them (12 Nov 2026).
 *
 * Amy, 11 Nov (weekly call): "all of them are tracking well, except our two new clients … Hetherington and Homebase.
 * … They've already had one interested reply, and then three. And I'm not seeing those here on the client health
 * dashboard." The master record's Billing tab had them right.
 *
 * Why: Client Health measures every client by INTRODUCTIONS against its plan's monthly target (billing.ts). A
 * pay-per-lead client never gets an introduction: its Interested replies go straight to it, and each is a lead it pays
 * for. So it read 0, At Risk, with introductions "carried" it was never owed. The plan picked at onboarding (minimum,
 * production, partner) didn't cause that; it only gave the row a plan the client isn't on.
 *
 * So a client with pay per lead set on its Billing tab (os_usage_billing_settings, test or live: the same rule that
 * gives its portal the Interested column) is measured by its LEADS, with the Billing tab's own numbers:
 *   leads           each 28-day window's leads exactly as the cap panel counts them (usage-billing caps.ts
 *                   perLeadClients: once per agent, corrections, held and waived replies left out); the day of each
 *                   is Eastern, as billing's are;
 *   Monthly         leads in the 28-day lead-cap window from the Billing tab's first day, against the cap: the
 *                   Monthly target, or the spend limit if it buys fewer (caps-model.ts), as the cap panel shows;
 *   Intros/Billing  leads in the current billing period (every 7 or 14 days from the same day): what is charged next;
 *   status          Done at the cap, On Track at or ahead of an even pace to it, At Risk behind, the pace counted in
 *                   whole days as billing.ts counts it for everyone else; nothing is "owed" or carried, because
 *                   nothing is promised per period.
 * Everyone else is exactly as before: healthSnapshot() hands them to billing.ts untouched.
 */

/** The Billing tab's facts for a client billed per lead. Serialisable: the browser re-derives from it after an edit. */
export interface PerLead {
  /** The Billing tab's first period day (Eastern): its billing periods and 28-day windows count from here. */
  anchor: string;
  everyDays: 7 | 14;
  priceCents: number;
  spendCapCents: number | null;
  live: boolean;
  /** Every lead billing counts, earliest first: its Eastern day and the moment it was marked. Null: not counted. */
  leads: { day: string; at: string }[] | null;
  /** The first day `leads` is complete from: an earlier window couldn't be read. Null when `leads` is. */
  countedFrom: string | null;
  /** Why the leads couldn't be counted, in words, when they couldn't. */
  error: string | null;
}

type WithPerLead = Pick<DashboardClient, "monthly_target"> & { per_lead?: PerLead | null };

const asDate = (day: string) => new Date(`${day}T00:00:00Z`);
const countIn = (leads: readonly { day: string }[], from: string, to: string) => leads.filter((l) => l.day >= from && l.day < to).length;
/** The leads, when they are known from `from` on. */
const leadsFrom = (p: PerLead, from: string) => (p.leads && p.countedFrom !== null && from >= p.countedFrom ? p.leads : null);

/** Leads allowed per 28-day window, as the Billing tab's cap panel counts it; null for no cap. */
export function leadCapOf(c: WithPerLead): number | null {
  const p = c.per_lead;
  if (!p) return null;
  return effectiveCap({ monthlyTarget: c.monthly_target, spendCapCents: p.spendCapCents, priceCents: p.priceCents }).cap;
}

/** The billing period holding a moment: from its first day to the day it is charged. Needs no leads. */
export function perLeadPeriod(p: PerLead, asOf: Date): { start: Date; end: Date } {
  const today = easternDay(asOf);
  const billing = periodOf(p.anchor, p.everyDays, today < p.anchor ? p.anchor : today)!;
  return { start: asDate(billing.start), end: asDate(billing.end) };
}

/**
 * The client's numbers as of a moment, in billing.ts's shape so every cell reads them alike. Null when its leads
 * couldn't be counted for that moment's window: an unknown count is shown as unknown, never as 0.
 *
 *   cycle   the billing period [start, end): start = its first day, end = the day it is charged. target 0: no lead is
 *           due in a period, so nothing is "left" or carried.
 *   period  the 28-day window; target = the cap.
 */
export function leadSnapshot(c: WithPerLead, asOf: Date): BillingSnapshot | null {
  const p = c.per_lead;
  if (!p) return null;
  const today = easternDay(asOf);
  const started = today >= p.anchor;
  const day = started ? today : p.anchor;
  const window = capWindowOf(p.anchor, day)!;
  const known = leadsFrom(p, window.start);
  if (!known) return null;
  const leads = known.filter((l) => l.day <= today);
  const billing = periodOf(p.anchor, p.everyDays, day)!;
  const cap = leadCapOf(c) ?? 0;
  const delivered = countIn(leads, window.start, window.end);
  const elapsedDays = started ? Math.min(CAP_WINDOW_DAYS, daysBetween(window.start, today)) : 0;
  const expected = Math.floor((cap * elapsedDays) / CAP_WINDOW_DAYS + 1e-9);
  return {
    cycle: {
      index: Math.floor(daysBetween(p.anchor, billing.start) / p.everyDays),
      start: asDate(billing.start),
      end: asDate(billing.end),
      target: 0, carryIn: 0, required: 0,
      delivered: countIn(leads, billing.start, billing.end),
      remaining: 0,
    },
    period: {
      start: asDate(window.start), end: asDate(window.end),
      target: cap, carryIn: 0, delivered, elapsedDays, totalDays: CAP_WINDOW_DAYS, expected,
    },
    status: cap <= 0 ? "pending" : delivered >= cap ? "done" : delivered >= expected ? "ok" : "risk",
  };
}

/** Every client's snapshot: by leads when billed per lead, otherwise billing.ts exactly as before. */
export function healthSnapshot(c: DashboardClient, asOf: Date): BillingSnapshot | null {
  if (c.per_lead) return leadSnapshot(c, asOf);
  return billingSnapshot({ ...c, monthly_target: c.monthly_target ?? 0, intro_dates: c.intro_dates ?? [] }, asOf);
}

/** Introductions due in a week (Performance). A client billed per lead is never due any. */
export function healthDueInWeek(c: DashboardClient, monday: Date, asOf: Date): BillingDueInWeek | null {
  if (c.per_lead) return null;
  return billingDueInWeek({ ...c, monthly_target: c.monthly_target ?? 0, intro_dates: c.intro_dates ?? [] }, monday, asOf);
}

/**
 * Leads in the Monday-to-Sunday week starting `monday` (YYYY-MM-DD), and the last lead up to its end. `count` is null
 * when that week's leads aren't known (not counted, or before `countedFrom`): shown as "—", never 0.
 */
export function leadsOfWeek(p: PerLead, monday: string): { count: number | null; lastAt: string | null } {
  const end = addDays(monday, 7);
  const leads = leadsFrom(p, monday < p.anchor ? p.anchor : monday);
  if (!leads) return { count: null, lastAt: null };
  const upTo = leads.filter((l) => l.day < end);
  return { count: countIn(leads, monday, end), lastAt: upTo.length ? upTo[upTo.length - 1].at : null };
}

/** The last `n` 28-day windows that have ended by `today`, newest last, against the cap: the Client Score's input. */
export function completedLeadWindows(c: WithPerLead, today: Date, n: number): { target: number; delivered: number }[] {
  const p = c.per_lead;
  const cap = leadCapOf(c);
  if (!p?.leads || p.countedFrom === null || !cap) return [];
  const current = capWindowOf(p.anchor, easternDay(today));
  if (!current) return [];
  const out: { target: number; delivered: number }[] = [];
  for (let start = addDays(current.start, -CAP_WINDOW_DAYS); start >= p.countedFrom && start >= p.anchor && out.length < n; start = addDays(start, -CAP_WINDOW_DAYS)) {
    out.unshift({ target: cap, delivered: countIn(p.leads, start, addDays(start, CAP_WINDOW_DAYS)) });
  }
  return out;
}

/** "Pay per lead" where the plan would be: the plan in the database is only what onboarding had to pick. */
export function planName(c: Pick<DashboardClient, "plan"> & { per_lead?: PerLead | null }): string {
  if (c.per_lead) return "Pay per lead";
  return c.plan.charAt(0).toUpperCase() + c.plan.slice(1);
}
