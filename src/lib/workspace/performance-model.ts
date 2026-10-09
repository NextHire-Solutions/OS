/*
 * Performance, computed — pure, so every number is tested without a database.
 * See performance.ts for where each input comes from.
 */

export interface PlanBreakdown {
  plan: string;
  label: string;
  count: number;
  weeklyTarget: number | null;
  targetMin: number | null;
  targetMax: number | null;
}

export interface MonthRow {
  month: string;
  label: string;
  added: number;
  churned: number;
  /**
   * Clients paused that month (each counted once a month) — from the status
   * history and pause dates entered on records. Null when the status history
   * could not be read, so a gap never reads as "nobody paused".
   */
  paused: number | null;
  net: number;
  /** Clients onboarded by the month's end and not churned by then. */
  activeAtEnd: number;
  /** Paid Stripe invoices that month; null when Stripe could not be read. */
  revenue: number | null;
}

export interface Performance {
  totals: {
    clients: number | null;
    active: number | null;
    paused: number | null;
    churned: number | null;
    onboarding: number | null;
    addedLast90: number | null;
    churnedLast90: number | null;
    /** No onboarding date and no sign-up date: not placed in any month. */
    undated: number;
    /** Of those added, how many are placed by their sign-up date (no onboarding date recorded). */
    bySignupDate: number;
    /** Churned clients with no churn date: not placed in any month. */
    churnUndated: number;
    /** Clients paused now with no known pause: not placed in any month. */
    pauseUndated: number;
    /** Clients paused in the last 90 days; null when the status history is unreadable. */
    pausedLast90: number | null;
    /** Paid Stripe invoices this calendar month so far; null when unreadable. */
    revenueThisMonth: number | null;
    /** How many clients are linked to Stripe (the only ones revenue can see). */
    stripeLinked: number;
  };
  plans: PlanBreakdown[];
  months: MonthRow[];
  unavailable: string | null;
}

export interface PerfClient {
  status: string;
  plan: string | null;
  weeklyTarget: number | null;
  onboardingDate: string | null;
  /** The fallback when no onboarding date is recorded (was Start date until 6 Oct). */
  signupDate: string | null;
  churnDate: string | null;
  /** Every known pause, YYYY-MM-DD (master-list.ts pauseDays). */
  pauseDates?: string[];
}

const PLAN_LABEL: Record<string, string> = { production: "Production", minimum: "Minimum", partner: "Partner" };

const monthLabel = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

function nextMonth(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
}

export function performanceFrom(
  clients: PerfClient[],
  revenue: Map<string, number> | null,
  unavailable: string | null,
  stripeLinked = 0,
  today: Date = new Date(),
  /** False when the status history could not be read: pauses are then unknown, not zero. */
  pauseHistory = true,
): Performance {
  const count = (s: string) => clients.filter((c) => c.status === s).length;
  const addedOn = (c: PerfClient) => (c.onboardingDate ?? c.signupDate)?.slice(0, 10) ?? null;
  const churnedOn = (c: PerfClient) => (c.status === "churned" && c.churnDate ? c.churnDate.slice(0, 10) : null);

  const ninety = new Date(today);
  ninety.setUTCDate(ninety.getUTCDate() - 90);
  const cutoff = ninety.toISOString().slice(0, 10);
  const thisMonth = today.toISOString().slice(0, 7);

  const planCounts = new Map<string, { count: number; target: number | null; min: number | null; max: number | null; mixed: boolean }>();
  for (const c of clients) {
    const plan = c.plan ?? "unknown";
    const e = planCounts.get(plan) ?? { count: 0, target: c.weeklyTarget, min: null, max: null, mixed: false };
    e.count += 1;
    if (e.target !== c.weeklyTarget) e.mixed = true;
    if (typeof c.weeklyTarget === "number") {
      e.min = e.min === null ? c.weeklyTarget : Math.min(e.min, c.weeklyTarget);
      e.max = e.max === null ? c.weeklyTarget : Math.max(e.max, c.weeklyTarget);
    }
    planCounts.set(plan, e);
  }
  const plans: PlanBreakdown[] = [...planCounts.entries()]
    .map(([plan, e]) => ({ plan, label: PLAN_LABEL[plan] ?? plan, count: e.count, weeklyTarget: e.mixed ? null : e.target, targetMin: e.min, targetMax: e.max }))
    .sort((a, b) => b.count - a.count);

  // Months: from the first dated event to this month, with no gaps.
  const addedMonths = clients.map(addedOn).filter((d): d is string => !!d).map((d) => d.slice(0, 7));
  const churnMonths = clients.map(churnedOn).filter((d): d is string => !!d).map((d) => d.slice(0, 7));
  // Each client once per month it was paused in, however many times that month.
  const pauseMonths = clients.flatMap((c) => [...new Set((c.pauseDates ?? []).map((d) => d.slice(0, 7)))]);
  const first = [...addedMonths, ...churnMonths, ...pauseMonths, ...(revenue ? [...revenue.keys()] : [])].sort()[0];
  const months: MonthRow[] = [];
  if (first) {
    for (let m = first; m <= thisMonth; m = nextMonth(m)) {
      const end = `${m}-31`;
      const added = addedMonths.filter((x) => x === m).length;
      const churned = churnMonths.filter((x) => x === m).length;
      const paused = pauseHistory ? pauseMonths.filter((x) => x === m).length : null;
      const activeAtEnd = clients.filter((c) => {
        const a = addedOn(c);
        const ch = churnedOn(c);
        // This month: only clients that ARE active now (6 Oct — paused ones were counted).
        if (m === thisMonth) return c.status === "active";
        return a !== null && a <= end && !(ch !== null && ch <= end);
      }).length;
      months.push({ month: m, label: monthLabel(m), added, churned, paused, net: added - churned, activeAtEnd,
        revenue: revenue ? Math.round((revenue.get(m) ?? 0) * 100) / 100 : null });
    }
  }

  return {
    totals: {
      clients: clients.length,
      active: count("active"),
      paused: count("paused"),
      churned: count("churned"),
      onboarding: count("onboarding"),
      addedLast90: clients.filter((c) => (addedOn(c) ?? "") >= cutoff).length,
      churnedLast90: clients.filter((c) => (churnedOn(c) ?? "") >= cutoff).length,
      undated: clients.filter((c) => !addedOn(c)).length,
      bySignupDate: clients.filter((c) => !c.onboardingDate && c.signupDate).length,
      churnUndated: clients.filter((c) => c.status === "churned" && !c.churnDate).length,
      pauseUndated: clients.filter((c) => c.status === "paused" && !(c.pauseDates ?? []).length).length,
      pausedLast90: pauseHistory ? clients.filter((c) => (c.pauseDates ?? []).some((d) => d >= cutoff)).length : null,
      revenueThisMonth: revenue ? Math.round((revenue.get(thisMonth) ?? 0) * 100) / 100 : null,
      stripeLinked,
    },
    plans,
    months: months.reverse(),
    unavailable,
  };
}
