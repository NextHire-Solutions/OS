/*
 * The portal's Billing page (22 Oct): introductions in each billing period.
 * Eddy (21 Oct) asked for "leads received in each billing cycle"; the user,
 * 22 Oct: "it should count the introductions that came from masterinbox (our
 * side)" — every entry WE put in the client's portal, never the client's own
 * "Client Entry" candidates (intro-counts.ts). A period is what an invoice
 * pays for (its service period, billing-account.ts servicePeriod), so a
 * client billed every 14 days sees 14-day periods.
 */

import { CLIENT_ENTRY_SOURCE } from "@/lib/tools/master-inbox/portals/intro-counts";

export interface BillingPeriod {
  /** yyyy-mm-dd, the first day paid for. */
  start: string;
  /** yyyy-mm-dd, the last day paid for. */
  end: string;
  /** The invoice's number, as Stripe shows it. */
  invoice: string | null;
  status: "paid" | "open" | "uncollectible";
  /** Introductions from our side in the period. */
  introductions: number;
  /** Today falls in it. */
  current: boolean;
}

type Invoice = { number: string | null; status: string; serviceStart?: number; serviceEnd?: number };
type Entry = { source: string | null; introduced_at: string | null };

const SHOWN = new Set(["paid", "open", "uncollectible"]);
/* The day in Eastern time, as the rest of the OS writes billing dates. */
const etDay = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

/** Newest first, at most `limit`. Draft and void invoices are not billing periods. */
export function introductionsByPeriod(invoices: readonly Invoice[], entries: readonly Entry[], now: Date, limit = 12): BillingPeriod[] {
  const ours = entries
    .filter((e) => e.source !== CLIENT_ENTRY_SOURCE && e.introduced_at)
    .map((e) => Date.parse(e.introduced_at as string))
    .filter((t) => Number.isFinite(t));
  const byPeriod = new Map<string, { startMs: number; endMs: number; invoice: string | null; status: BillingPeriod["status"] }>();
  for (const inv of invoices) {
    if (!SHOWN.has(inv.status) || typeof inv.serviceStart !== "number" || typeof inv.serviceEnd !== "number" || inv.serviceEnd <= inv.serviceStart) continue;
    const key = `${inv.serviceStart}:${inv.serviceEnd}`;
    // Two invoices for one period (a retry, a correction): one row, the paid one's number.
    const had = byPeriod.get(key);
    if (had && had.status === "paid") continue;
    byPeriod.set(key, { startMs: inv.serviceStart * 1000, endMs: inv.serviceEnd * 1000, invoice: inv.number, status: inv.status as BillingPeriod["status"] });
  }
  return [...byPeriod.values()]
    .sort((a, b) => b.startMs - a.startMs)
    .slice(0, limit)
    .map((p) => ({
      start: etDay(p.startMs),
      // Stripe's end is the moment the next period starts: the last day paid for is the day before.
      end: etDay(p.endMs - 1),
      invoice: p.invoice,
      status: p.status,
      introductions: ours.filter((t) => t >= p.startMs && t < p.endMs).length,
      current: now.getTime() >= p.startMs && now.getTime() < p.endMs,
    }));
}
