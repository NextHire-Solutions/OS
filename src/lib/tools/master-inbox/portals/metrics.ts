import type { IntroLead, TrendBucket } from "@/lib/tools/master-inbox/portals/intro-leads";
import { weeklyTrend } from "@/lib/tools/master-inbox/portals/intro-leads";

// Pure analytics layer for the client portal. Takes the flat IntroLead[]
// and derives every metric + chart series the dashboard renders. Computed
// once server-side and passed down as plain data so the portal stays
// hydration-safe (no Date.now() drift between server render and client).

export interface SourceSlice {
  key: string; // "instantly" | "emailbison" | "other"
  label: string;
  count: number;
}

export interface CampaignSlice {
  name: string;
  count: number;
}

export interface WeekdaySlice {
  day: string; // "Mon" … "Sun"
  count: number;
}

export interface CumulativePoint {
  label: string;
  total: number; // running total of all intros through this week
}

export interface MonthSlice {
  key: string; // "2026-05"
  label: string; // "May"
  count: number;
}

export interface PortalMetrics {
  total: number;
  thisWeek: number;
  lastWeek: number;
  weekDelta: number;
  thisMonth: number;
  lastMonth: number;
  monthDelta: number;
  bestWeek: { label: string; count: number };
  weeklyAverage: number;
  activeWeeks: number; // distinct weeks that had at least one intro
  lastIntroAt: string | null;
  firstIntroAt: string | null;
  weekly: TrendBucket[];
  monthly: MonthSlice[]; // trailing 6 months, oldest → newest
  cumulative: CumulativePoint[];
  bySource: SourceSlice[];
  topCampaigns: CampaignSlice[];
  byWeekday: WeekdaySlice[];
}

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function computePortalMetrics(leads: IntroLead[], weeks = 12): PortalMetrics {
  const weekly = weeklyTrend(leads, weeks);

  const thisWeek = weekly.length > 0 ? weekly[weekly.length - 1].count : 0;
  const lastWeek = weekly.length > 1 ? weekly[weekly.length - 2].count : 0;

  // Month buckets
  const now = new Date();
  const thisMonthKey = monthKey(now);
  const lastMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const lastMonthKey = monthKey(lastMonthDate);

  let thisMonth = 0;
  let lastMonth = 0;
  const weekdayCounts = new Array(7).fill(0);
  const sourceCounts = new Map<string, number>();
  const campaignCounts = new Map<string, number>();

  // Trailing 6-month buckets (oldest → newest), pre-seeded to zero so the
  // chart shape is stable even when a month had no intros.
  const monthly: MonthSlice[] = [];
  const monthIndex = new Map<string, number>();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = monthKey(d);
    monthIndex.set(key, monthly.length);
    monthly.push({
      key,
      label: d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }),
      count: 0,
    });
  }

  for (const lead of leads) {
    const d = new Date(lead.assigned_at);
    if (Number.isNaN(d.getTime())) continue;

    const mk = monthKey(d);
    if (mk === thisMonthKey) thisMonth += 1;
    else if (mk === lastMonthKey) lastMonth += 1;
    const mi = monthIndex.get(mk);
    if (mi !== undefined) monthly[mi].count += 1;

    // getUTCDay: 0 Sun … 6 Sat → remap to Mon-first index
    const wd = (d.getUTCDay() + 6) % 7;
    weekdayCounts[wd] += 1;

    const src = (lead.source_provider ?? "other").toLowerCase();
    sourceCounts.set(src, (sourceCounts.get(src) ?? 0) + 1);

    const campaign = (lead.campaign_name ?? "Uncategorised").trim() || "Uncategorised";
    campaignCounts.set(campaign, (campaignCounts.get(campaign) ?? 0) + 1);
  }

  // Cumulative: running total aligned to the weekly buckets, including any
  // intros that pre-date the visible window (the curve starts at that
  // baseline so growth reads honestly).
  const windowStart = weekly.length > 0 ? new Date(`${weekly[0].weekStart}T00:00:00Z`) : null;
  let baseline = 0;
  if (windowStart) {
    for (const lead of leads) {
      const d = new Date(lead.assigned_at);
      if (!Number.isNaN(d.getTime()) && d < windowStart) baseline += 1;
    }
  }
  let running = baseline;
  const cumulative: CumulativePoint[] = weekly.map((w) => {
    running += w.count;
    return { label: w.label, total: running };
  });

  const bestWeek = weekly.reduce(
    (best, w) => (w.count > best.count ? { label: w.label, count: w.count } : best),
    { label: "—", count: 0 },
  );

  const activeWeeks = weekly.filter((w) => w.count > 0).length;
  const weeklyAverage =
    activeWeeks > 0
      ? Math.round((weekly.reduce((s, w) => s + w.count, 0) / weekly.length) * 10) / 10
      : 0;

  // leads come in newest-first from the loader.
  const lastIntroAt = leads[0]?.assigned_at ?? null;
  const firstIntroAt = leads.length > 0 ? leads[leads.length - 1].assigned_at : null;

  const sourceLabel = (key: string): string =>
    key === "instantly" ? "Instantly" : key === "emailbison" ? "EmailBison" : "Other";
  const bySource: SourceSlice[] = Array.from(sourceCounts.entries())
    .map(([key, count]) => ({ key, label: sourceLabel(key), count }))
    .sort((a, b) => b.count - a.count);

  const topCampaigns: CampaignSlice[] = Array.from(campaignCounts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const byWeekday: WeekdaySlice[] = WEEKDAYS.map((day, i) => ({
    day,
    count: weekdayCounts[i],
  }));

  return {
    total: leads.length,
    thisWeek,
    lastWeek,
    weekDelta: thisWeek - lastWeek,
    thisMonth,
    lastMonth,
    monthDelta: thisMonth - lastMonth,
    bestWeek,
    weeklyAverage,
    activeWeeks,
    lastIntroAt,
    firstIntroAt,
    weekly,
    monthly,
    cumulative,
    bySource,
    topCampaigns,
    byWeekday,
  };
}
