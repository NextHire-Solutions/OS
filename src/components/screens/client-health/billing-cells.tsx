"use client";

import { useState } from "react";
import { createPortal } from "react-dom";

import type { BillingSnapshot, CycleState } from "@/lib/tools/client-health/billing";
import type { PerLead } from "@/lib/tools/client-health/per-lead";

/*
 * The billing-cycle cells, shared by Weekly and Bi-Weekly so the two cannot
 * disagree. PORTED from the tool's app/Dashboard.tsx (1590588): CarryBadge,
 * IntrosBillingCell and the Monthly cell — same numbers, same thresholds, same
 * words; restyled on the design system.
 *
 * A snapshot that crossed the server → client boundary may carry its dates as
 * strings, so every date here goes through `asDate`.
 */

export const asDate = (d: Date | string): Date => (d instanceof Date ? d : new Date(d));

/** 09/29/2026, read in UTC — the billing engine's dates are UTC midnights. */
export const fmtMDY = (d: Date | string) => {
  const x = asDate(d);
  return `${String(x.getUTCMonth() + 1).padStart(2, "0")}/${String(x.getUTCDate()).padStart(2, "0")}/${x.getUTCFullYear()}`;
};

/** The day before `d`: a per-lead period or window ends the day before its exclusive end (per-lead.ts). */
const dayBefore = (d: Date | string) => new Date(asDate(d).getTime() - 86_400_000);

/** Why a per-lead client's numbers are missing, for a title: they couldn't be counted, never "0". */
export const notCounted = (p: PerLead) => `Its leads couldn't be counted, so this isn't shown: ${p.error ?? "unknown reason"}`;

/** True when intros carried from an earlier cycle are still outstanding — the red row edge. */
export const isBehind = (snap: BillingSnapshot | null) =>
  !!snap && snap.cycle.carryIn > 0 && snap.cycle.remaining > 0;

/**
 * "+N carried" — shown only when intros carried over from a previous cycle.
 * Hover or focus opens the four numbers, so nobody works out "4 + 2 − 2" by hand.
 *
 * The popover is position: fixed, placed from the badge's own rectangle: the
 * table scrolls inside an overflow container that would clip an absolutely
 * positioned one at its edges. And it is PORTALLED to <body>: the workspace's
 * screen container carries a transform, which makes `fixed` relative to that
 * container instead of the viewport — measured 29 Sep, the popover for a row
 * near the bottom opened 4,000px above the screen. Same reason as dialog.tsx.
 */
export function CarryBadge({ cycle }: { cycle: CycleState }) {
  // Below the badge, or — near the bottom of the screen — above it, anchored by
  // its BOTTOM edge so the popover's own height never matters.
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number } | null>(null);
  if (cycle.carryIn <= 0) return null;
  const outstanding = cycle.remaining > 0;
  const open = (e: React.SyntheticEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const width = 240;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - width / 2), window.innerWidth - width - 8);
    const below = r.bottom + 8;
    setPos(below + 170 > window.innerHeight ? { bottom: window.innerHeight - r.top + 8, left } : { top: below, left });
  };
  return (
    <span
      className={`ds-carry${outstanding ? "" : " cleared"}`}
      tabIndex={0}
      onMouseEnter={open}
      onFocus={open}
      onMouseLeave={() => setPos(null)}
      onBlur={() => setPos(null)}
      aria-label={`${cycle.carryIn} intros carried forward. Cycle target ${cycle.target}, delivered ${cycle.delivered}, total required ${cycle.required}.`}
    >
      +{cycle.carryIn} carried
      {pos ? createPortal(
        <span className={`ds-carry-pop${outstanding ? "" : " cleared"}`} role="tooltip" style={pos}>
          <span className="t">{outstanding ? "Behind — intros carried forward" : "Carried intros cleared"}</span>
          <span className="r"><span>Current cycle target</span><b>{cycle.target}</b></span>
          <span className="r"><span>Delivered</span><b>{cycle.delivered}</b></span>
          <span className="r over"><span>Overdue / carry-forward</span><b>+{cycle.carryIn}</b></span>
          <span className="r total"><span>Total intros now required</span><b>{cycle.required}</b></span>
        </span>,
        document.body,
      ) : null}
    </span>
  );
}

/**
 * "+N ahead" — intros delivered beyond what this billing cycle requires
 * (its target plus anything carried in). The client's ask, 30 Sep: over-
 * delivery pays a shortfall down but banks no credit, so the team needs to
 * SEE when a client is already ahead and ease off. Display only — it does
 * not change what the next cycle requires.
 */
export function AheadBadge({ cycle }: { cycle: CycleState }) {
  const ahead = cycle.delivered - cycle.required;
  if (cycle.target <= 0 || ahead <= 0) return null;
  return (
    <span
      className="ds-ahead"
      title={`${ahead} more intro${ahead === 1 ? "" : "s"} than this cycle requires (${cycle.delivered} delivered, ${cycle.required} required). Extra intros do not carry into the next cycle.`}
      aria-label={`${ahead} intros ahead of this cycle's requirement`}
    >
      +{ahead} ahead
    </span>
  );
}

/** Green when met, amber from half, red below — the tool's bw-done / bw-mid / bw-short. */
function cycleTone(cy: CycleState): "green" | "amber" | "red" {
  if (cy.remaining === 0) return "green";
  if (cy.carryIn > 0) return "red";
  return cy.delivered >= Math.ceil(cy.required / 2) ? "amber" : "red";
}

/** "2 / 6 due" — delivered since the last billing date vs required by the next. */
export function IntrosBillingCell({ snap, onSetBilling, perLead }: { snap: BillingSnapshot | null; onSetBilling: () => void; perLead?: PerLead | null }) {
  /*
   * Billed per lead (per-lead.ts): the leads of this billing period, which are what it is charged next. No lead is
   * due in a period, so there is no "due" and nothing carried. Its schedule is the Billing tab's.
   */
  if (perLead) {
    if (!snap) return <span className="ds-none" title={notCounted(perLead)}>—</span>;
    const cy = snap.cycle;
    return (
      <span className="ds-ib" data-per-lead="">
        <b className="num" title={`${cy.delivered} lead${cy.delivered === 1 ? "" : "s"} in this billing period, ${fmtMDY(cy.start)} – ${fmtMDY(dayBefore(cy.end))}, charged from ${fmtMDY(cy.end)}`}>
          {cy.delivered}
        </b>
        <span className="ds-ib-due">{cy.delivered === 1 ? "lead" : "leads"}</span>
      </span>
    );
  }
  if (!snap) {
    return <button type="button" className="ds-link" onClick={onSetBilling}>Set billing date</button>;
  }
  const cy = snap.cycle;
  if (cy.target <= 0) return <span className="ds-none" title="No monthly target set">—</span>;
  return (
    <span className="ds-ib">
      <b className={`tone-${cycleTone(cy)}`} title={`${cy.delivered} delivered since last billing · ${cy.required} due by next billing`}>
        {cy.delivered} / {cy.required}
      </b>
      <span className="ds-ib-due">due</span>
      <CarryBadge cycle={cy} />
      <AheadBadge cycle={cy} />
    </span>
  );
}

/**
 * Monthly — intros in the current 28-day period (both billing cycles) vs the
 * monthly target, e.g. 6/8. Resets only when the full 28 days end. Colour
 * follows the status: green done, amber on pace, red behind.
 */
export function MonthlyCell({ snap, perLead }: { snap: BillingSnapshot | null; perLead?: PerLead | null }) {
  const period = snap?.period ?? null;
  if (perLead && !snap) return <span className="ds-none" title={notCounted(perLead)}>—</span>;
  if (perLead && period && period.target <= 0) return <span className="ds-none" title="No lead cap: set its Monthly target, or a spend limit on its Billing tab">—</span>;
  if (!snap || !period || period.target <= 0) return <span className="ds-none">—</span>;
  const tone = snap.status === "done" ? "green" : snap.status === "ok" ? "amber" : "red";
  return (
    <span className="ds-ib">
      <b
        className={`tone-${tone}`}
        title={perLead
          ? `Leads ${fmtMDY(period.start)} – ${fmtMDY(dayBefore(period.end))} against the lead cap of ${period.target} · day ${period.elapsedDays} of ${period.totalDays} · ${period.expected} expected by now`
          : `28-day period ${fmtMDY(period.start)} → ${fmtMDY(period.end)} · day ${period.elapsedDays} of ${period.totalDays} · ${period.expected} expected by now`}
      >
        {period.delivered}/{period.target}
      </b>
      <CarryBadge cycle={snap.cycle} />
    </span>
  );
}
