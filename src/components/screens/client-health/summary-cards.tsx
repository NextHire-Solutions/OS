"use client";

import type { ReactNode } from "react";

import type { FunnelTotals, WeeklySummary } from "@/lib/tools/client-health/summarize";
import { funnelRates } from "@/lib/tools/client-health/summarize";
import { weekLabel } from "./toolbar";


/*
 * The 24 summary cards — Status, Performance, Funnel Lifetime, Funnel Week.
 *
 * In the tool (app/Dashboard.tsx 876–929) these sit above the table on EVERY
 * view; the view switch is below them. The workspace drew them on Weekly only,
 * so on Bi-Weekly you could not see "At Risk" or either funnel without going
 * back. Lifted out of weekly.tsx so all three screens render the same block
 * from the same numbers.
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
    <>
      <CardGroup label="Status">
        <Card label="Clients" value={s.total} sub="active" />
        <Card label="At Risk" value={s.risk} sub="below half target" tone="n-risk" />
        <Card label="On Track" value={s.ok} sub="meeting target this week" tone="n-ok" />
        <Card label="Done" value={s.done} sub="met weekly target" tone="n-done" />
        <Card label="Client Paused" value={s.clientPaused} sub="manually paused" />
        <Card
          label="By Plan"
          value={`${s.plans.minimum} · ${s.plans.production} · ${s.plans.partner}`}
          sub="min · prod · partner"
          size={26}
        />
      </CardGroup>

      <CardGroup label="Performance">
        <Card label="Weekly Intros Sent" value={s.intros} sub="across all clients" tone="n-intros" />
        <Card label="Weekly Target" value={s.target} sub="intros / week" />
        <Card label="Weekly Completion" value={`${s.completionPct}%`} sub="intros vs weekly target" tone="n-green" />
        <Card label="Monthly Intros Sent" value={s.monthlyIntros} sub="this monthly cycle" tone="n-intros" />
        <Card
          label="Monthly Target"
          value={s.monthlyTarget}
          sub={s.monthlyTarget > 0 ? "intros / month" : "no client has one set"}
        />
        <Card
          label="Monthly Completion"
          value={s.monthlyTarget > 0 ? `${s.monthlyCompletionPct}%` : null}
          sub="intros vs monthly target"
          tone="n-green"
        />
      </CardGroup>

      <FunnelGroup label="Funnel — Lifetime" totals={s.lifetime} rates={lifetime} emailsSub="all campaigns" />
      <FunnelGroup
        label={isCurrent ? "Funnel — This Week" : `Funnel — Week of ${weekLabel(weekKey)}`}
        totals={s.week}
        rates={week}
        emailsSub="this week"
      />
    </>
  );
}

/* ---- the same formatting helpers weekly.tsx uses for its table ---- */
const n = (v: number) => v.toLocaleString("en-US");
const pct = (v: number | null, digits = 1) => (v === null ? "—" : `${v.toFixed(digits)}%`);
const ratio = (a: number, b: number) => `${n(a)} / ${n(b)}`;

/** One labelled band of six cards — the tool's own grouping. */
export function CardGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 20 }}>
      <div className="grp-h" style={{ marginBottom: 10 }}>{label}</div>
      <div className="cards" style={{ gridTemplateColumns: "repeat(6, 1fr)", marginBottom: 0 }}>
        {children}
      </div>
    </section>
  );
}

/**
 * One funnel band.
 *
 * Both funnels have identical shape, so they are one component — which is also
 * what guarantees the two read the same way. Each rate card carries its own
 * numerator and denominator as its subtitle, because a percentage without them
 * cannot be checked and a wrong one looks exactly like a right one.
 */
function FunnelGroup({
  label, totals, rates, emailsSub,
}: {
  label: string;
  totals: FunnelTotals;
  rates: ReturnType<typeof funnelRates>;
  emailsSub: string;
}) {
  const funnel = totals.converted + totals.interested;
  return (
    <CardGroup label={label}>
      <Card label="Emails Sent" value={totals.emails} sub={emailsSub} tone="n-emails" />
      <Card label="Reply Rate" value={pct(rates.replyRate)} sub={ratio(totals.replies, totals.emails)} tone="n-ok" />
      <Card label="Positive Reply" value={pct(rates.positiveReply)} sub={ratio(totals.interested, totals.replies)} tone="n-ok" />
      <Card label="Avg Conv." value={pct(rates.convPer1k)} sub={`${ratio(totals.converted, totals.emails)} · per 1k`} tone="n-ok" />
      <Card label="Converted" value={totals.converted} sub="interested → intro" tone="n-green" />
      <Card label="Int → Intro" value={pct(rates.intToIntro)} sub={ratio(totals.converted, funnel)} tone="n-blue" />
    </CardGroup>
  );
}

export function Card({
  label, value, sub, tone, size,
}: {
  label: string;
  value: number | string | null;
  sub: string;
  tone?: string;
  size?: number;
}) {
  // An em dash string counts as missing too — that is how the rate helpers
  // say "no denominator", and it should look the same as a null.
  const missing = value === null || value === "—";
  return (
    <div className="card">
      <div className="card-l">{label}</div>
      <div
        className={`card-n tnum${tone && !missing ? ` ${tone}` : ""}`}
        style={{ ...(size ? { fontSize: size } : {}), ...(missing ? { color: "#B9C0CB" } : {}) }}
      >
        {missing ? "—" : typeof value === "number" ? n(value) : value}
      </div>
      <div className="card-s">{sub}</div>
    </div>
  );
}
