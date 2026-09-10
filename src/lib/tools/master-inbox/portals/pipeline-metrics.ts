import type { PipelineEntry } from "@/lib/tools/master-inbox/portals/portal-data";

// Minimal stats for the unified Recruiting Pipeline page header.
// Computed server-side from PipelineEntry[] (introduced_at + stage) so
// the page stays hydration-safe.

export interface PipelineSummary {
  total: number;
  thisWeek: number;
  thisMonth: number;
  hired: number;
  inActiveStages: number; // not hired / rejected / no-show
  lastIntroAt: string | null;
}

function mondayOf(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = x.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  x.setUTCDate(x.getUTCDate() - diff);
  return x;
}

export function computePipelineSummary(entries: PipelineEntry[]): PipelineSummary {
  const now = new Date();
  const thisMonday = mondayOf(now);
  const thisMonthY = now.getUTCFullYear();
  const thisMonthM = now.getUTCMonth();

  let thisWeek = 0;
  let thisMonth = 0;
  let hired = 0;
  let inActive = 0;
  let lastIntroAt: string | null = null;

  const INACTIVE_STAGES = new Set([
    "hired",
    "we_they_rejected",
    "no_show",
  ]);

  for (const e of entries) {
    if (e.stage === "hired") hired += 1;
    if (!INACTIVE_STAGES.has(e.stage)) inActive += 1;
    if (!e.introduced_at) continue;
    const d = new Date(e.introduced_at);
    if (Number.isNaN(d.getTime())) continue;
    if (mondayOf(d).getTime() === thisMonday.getTime()) thisWeek += 1;
    if (d.getUTCFullYear() === thisMonthY && d.getUTCMonth() === thisMonthM) {
      thisMonth += 1;
    }
    if (!lastIntroAt || e.introduced_at > lastIntroAt) {
      lastIntroAt = e.introduced_at;
    }
  }

  return {
    total: entries.length,
    thisWeek,
    thisMonth,
    hired,
    inActiveStages: inActive,
    lastIntroAt,
  };
}
