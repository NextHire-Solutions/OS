"use client";

import { Stat, Stats } from "@/components/ds";
import type { FunnelTotals, WeeklySummary } from "@/lib/tools/client-health/summarize";
import { funnelRates } from "@/lib/tools/client-health/summarize";

import { weekLabel } from "./toolbar";

/*
 * The 24 summary cards — Status, Performance, Funnel Lifetime, Funnel Week.
 *
 * In the tool these sit above the table on EVERY view, so all three screens
 * render this one block from the same numbers.
 *
 * Status and Performance follow the billing-cycle rules (port document §6.5,
 * §6.6): status is the 28-day pace; the weekly target is gone; "Due This Week"
 * is what the clients billing this week owe, carry included; "Delivered" caps
 * each client at their own due, so one client's surplus cannot hide another's
 * shortfall.
 */
export function SummaryCards({
  s, lifetime, week, isCurrent, weekKey,
}: {
  s: WeeklySummary;
  lifetime: ReturnType<typeof funnelRates>;
  week: ReturnType<typeof funnelRates>;
  isCurrent: boolean;
  weekKey: string;
}) {
  return (
    <div className="ds-bands">
      <Band label="Status">
        <Stat label="Clients" value={s.total} sub="active" />
        <Stat label="At Risk" value={s.risk} sub="behind 28-day pace" tone="red" />
        <Stat label="On Track" value={s.ok} sub="on pace for 28-day target" tone="amber" />
        <Stat label="Done" value={s.done} sub="28-day target met" tone="green" />
        <Stat label="Paused" value={s.clientPaused} sub="clients on hold" />
        <Stat label="By Plan" value={`${s.plans.minimum} · ${s.plans.production} · ${s.plans.partner}`} sub="min · prod · partner" />
      </Band>

      <Band label={isCurrent ? "Performance" : `Performance — week of ${weekLabel(weekKey)}`}>
        <Stat
          label="Due This Week"
          value={s.dueThisWeek}
          sub={`${s.billingThisWeek} client${s.billingThisWeek === 1 ? "" : "s"} billing this week`}
          tone="brand"
        />
        <Stat label="Delivered" value={s.deliveredThisWeek} sub="toward this week's due" tone="brand" />
        <Stat
          label="Due Completion"
          value={s.dueCompletionPct === null ? <None /> : `${s.dueCompletionPct}%`}
          sub="delivered vs due this week"
          tone={s.dueCompletionPct === null ? undefined : "green"}
        />
        <Stat label="Monthly Intros Sent" value={s.monthlyIntros} sub="this 28-day period" tone="brand" />
        <Stat
          label="Monthly Target"
          value={s.monthlyTarget}
          sub={s.monthlyTarget > 0 ? "intros / 28 days" : "no client has one set"}
        />
        <Stat
          label="Monthly Completion"
          value={s.monthlyTarget > 0 ? `${s.monthlyCompletionPct}%` : <None />}
          sub="intros vs 28-day target"
          tone={s.monthlyTarget > 0 ? "green" : undefined}
        />
      </Band>

      <FunnelBand label="Funnel — Lifetime" totals={s.lifetime} rates={lifetime} emailsSub="all campaigns" />
      <FunnelBand
        label={isCurrent ? "Funnel — This Week" : `Funnel — Week of ${weekLabel(weekKey)}`}
        totals={s.week}
        rates={week}
        emailsSub="this week"
      />
    </div>
  );
}

const n = (v: number) => v.toLocaleString("en-US");
const ratio = (a: number, b: number) => `${n(a)} / ${n(b)}`;

/** A missing figure. Never a zero — "0%" is a claim, "—" is the absence of one. */
function None() {
  return <span style={{ color: "var(--ds-faint)" }}>—</span>;
}
const pct = (v: number | null, digits = 1) => (v === null ? <None /> : `${v.toFixed(digits)}%`);

function Band({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="ds-band" aria-label={label}>
      <div className="ds-band-l">{label}</div>
      <Stats min={150}>{children}</Stats>
    </section>
  );
}

/**
 * One funnel band. Both funnels have identical shape, so they are one
 * component. Each rate carries its numerator and denominator as its subtitle,
 * because a percentage without them cannot be checked.
 */
function FunnelBand({
  label, totals, rates, emailsSub,
}: {
  label: string;
  totals: FunnelTotals;
  rates: ReturnType<typeof funnelRates>;
  emailsSub: string;
}) {
  const funnel = totals.converted + totals.interested;
  return (
    <Band label={label}>
      <Stat label="Emails Sent" value={totals.emails} sub={emailsSub} />
      <Stat label="Reply Rate" value={pct(rates.replyRate)} sub={ratio(totals.replies, totals.emails)} />
      <Stat label="Positive Reply" value={pct(rates.positiveReply)} sub={ratio(totals.interested, totals.replies)} />
      <Stat label="Avg Conv." value={pct(rates.convPer1k)} sub={`${ratio(totals.converted, totals.emails)} · per 1k`} />
      <Stat label="Converted" value={totals.converted} sub="interested → intro" tone="green" />
      <Stat label="Int → Intro" value={pct(rates.intToIntro)} sub={ratio(totals.converted, funnel)} tone="brand" />
    </Band>
  );
}
