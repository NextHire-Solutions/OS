"use client";

import { PageHeader } from "@/components/ds";
import type { Performance } from "@/lib/workspace/performance";

import { Lazy, PlaceholderScreen } from "./lazy";

/*
 * Performance — client base, plans and movement (Overview), and the next 30
 * days of Stripe charges (Billing Calendar, its own sub-page since 9 Oct).
 *
 * Built from the master client record (30 Sep): onboarding and churn dates
 * are stored and editable on each client, and revenue is what Stripe actually
 * collected. A client missing a date is counted as undated, never guessed.
 *
 * Where a number is unavailable the cell says WHY. "—" alone invites someone
 * to assume the value is zero; "needs status history" tells them what would
 * have to change, which is the difference between a gap and a to-do.
 */

const MISSING = "#B9C0CB";

function PerformanceView({ performance }: { performance: Performance }) {
  const { totals, plans, months, unavailable } = performance;

  if (unavailable) {
    return (
      <>
        <div className="hero"><PageHeader icon="performance" title="Performance" description="Client base, plans and movement" /></div>
        <div className="wrap">
          <div className="card">
            <div className="card-l">Unavailable</div>
            <p style={{ fontSize: 14, color: "var(--muted)" }}>{unavailable}</p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="hero"><PageHeader icon="performance" title="Performance" description="Client base, plans and movement · last 90 days" /></div>

      <div className="wrap">
        <div className="cards" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
          <Card label="Total clients" value={totals.clients}
            sub={`${totals.active} active · ${totals.paused} paused · ${totals.churned} churned${totals.onboarding ? ` · ${totals.onboarding} onboarding` : ""}`} />
          <Card
            label="Clients added"
            value={totals.addedLast90}
            tone="n-green"
            prefix="+"
            sub="last 90 days"
          />
          <Card
            label="Clients churned"
            value={totals.churnedLast90}
            sub={`last 90 days · ${totals.churned} churned in all`}
          />
          <Card
            label="Revenue this month"
            value={totals.revenueThisMonth === null ? null : Math.round(totals.revenueThisMonth)}
            prefix="$"
            sub={totals.revenueThisMonth === null ? "Stripe could not be read" : `collected so far · ${totals.stripeLinked} clients on Stripe`}
          />
        </div>

        <BillingCards performance={performance} />
        <div className="cards" style={{ gridTemplateColumns: `repeat(${Math.max(1, plans.length)}, 1fr)` }}>
          {plans.map((plan) => (
            <Card
              key={plan.plan}
              label={plan.label}
              value={plan.count}
              /*
               * The plan's own colour — blue for Production, purple for Partner,
               * plain for Minimum. The workspace already colours these pills on
               * the Clients roster, and the design colours these very numbers;
               * printing all three in black here made the plan mix unreadable at
               * a glance and disagreed with our own other screen.
               */
              tone={PLAN_TONE[plan.plan]}
              sub={weeklyTargetLabel(plan)}
            />
          ))}
        </div>

        <div className="tbl-wrap">
          <div className="tbl-head">
            <div>
              <div className="tbl-title">Client movement</div>
              <div className="tbl-sub">
                By onboarding, churn and pause dates
                {totals.undated > 0
                  ? ` · ${totals.undated} client${totals.undated === 1 ? " has" : "s have"} no onboarding or start date`
                  : ""}
                {totals.churnUndated > 0
                  ? ` · ${totals.churnUndated} churned client${totals.churnUndated === 1 ? " has" : "s have"} no churn date`
                  : ""}
                {totals.pauseUndated > 0
                  ? ` · ${totals.pauseUndated} paused client${totals.pauseUndated === 1 ? " has" : "s have"} no pause date`
                  : ""}
              </div>
            </div>
          </div>
          <div className="tbl-scroll">
            <table>
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Added</th>
                  <th>Churned</th>
                  <th>Paused</th>
                  <th>Net</th>
                  <th>Active at month end</th>
                  <th>Revenue</th>
                </tr>
              </thead>
              <tbody>
                {months.map((row) => (
                  <tr key={row.month}>
                    <td>{row.label}</td>
                    <td className={`tnum${row.added ? " n-green" : " mut"}`}>{row.added ? `+${row.added}` : "0"}</td>
                    <td className={`tnum${row.churned ? " n-red" : " mut"}`}>{row.churned ? `−${row.churned}` : "0"}</td>
                    <td className={`tnum${row.paused ? "" : " mut"}`} title={row.paused === null ? "The status history could not be read" : undefined}>
                      {row.paused === null ? "—" : row.paused}
                    </td>
                    <td className="tnum">{row.net > 0 ? `+${row.net}` : row.net < 0 ? `−${-row.net}` : "0"}</td>
                    <td className="tnum">{row.activeAtEnd}</td>
                    <td className={`tnum${row.revenue === null ? " mut" : ""}`}>
                      {row.revenue === null ? "—" : row.revenue.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/*
         * Says plainly what each blank column needs. Without this the table
         * reads as broken rather than as honest about a gap in the data.
         */}
        <p style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 14, lineHeight: 1.7, maxWidth: "80ch" }}>
          <b>Added</b> is each client&rsquo;s onboarding date
          {totals.bySignupDate > 0 ? ` (${totals.bySignupDate} use their sign-up date because no onboarding date is recorded)` : ""};{" "}
          <b>Churned</b> is each churned client&rsquo;s churn date. Both are on the client&rsquo;s record in{" "}
          <a href="/roster">Clients</a> — the churn date is set automatically when a client is marked Churned.{" "}
          <b>Paused</b> counts each client paused that month, once — from the status history, which records every
          status change since 13 Sep 2026, and from the <b>pause date</b> on the client&rsquo;s record, entered for a
          pause before then. A paused client still counts in Net and Active at month end.{" "}
          <b>Active at month end</b> counts clients onboarded by then and not yet churned.{" "}
          <b>Revenue</b> is everything Stripe collected that month, less refunds — every subscription and card, not just the one on each record.
          The next 30 days of charges are on <a href="/performance/billing">Billing Calendar</a>.
        </p>
      </div>
    </>
  );
}

/*
 * Billing across every subscription (client feedback, 6 Oct): total billed,
 * MRR, ARR, live and paused subscriptions, and growth. Growth compares this
 * month so far with the SAME days of last month, so a week-old month is not
 * set against a whole one.
 */
function BillingCards({ performance }: { performance: Performance }) {
  const b = performance.billing;
  if (!b) {
    return performance.billingError ? <p className="ds-note">Billing figures are unavailable — Stripe could not be read ({performance.billingError}).</p> : null;
  }
  const t = b.totals;
  const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
  return (
    <div className="cards" style={{ gridTemplateColumns: "repeat(6, 1fr)" }}>
      <Card label="Total billed" value={Math.round(t.totalBilled)} prefix="$"
        sub={t.unattributed > 0 ? `all time, less refunds · ${usd(t.unattributed)} not tied to a client` : "all time, less refunds"} />
      <Card label="MRR" value={Math.round(t.mrr)} prefix="$" tone="n-blue"
        sub={`+${usd(t.newMrr30)} new · −${usd(t.lostMrr30)} lost, 30 days`} />
      <Card label="ARR" value={Math.round(t.arr)} prefix="$" sub="MRR × 12" />
      <Card label="Active subscriptions" value={t.activeSubscriptions} tone="n-green" sub="collecting now" />
      <Card label="Paused subscriptions" value={t.pausedSubscriptions} sub="collection paused, not cancelled" />
      <Card label="Growth" value={t.growthPct === null ? null : Math.round(t.growthPct * 10) / 10}
        prefix={t.growthPct !== null && t.growthPct > 0 ? "+" : ""} suffix="%"
        tone={t.growthPct === null ? undefined : t.growthPct >= 0 ? "n-green" : "n-red"}
        sub={`collected: ${usd(t.collectedThisMonth)} this month vs ${usd(t.collectedLastMonthToDate)} same days last month`} />
    </div>
  );
}

/** The billing calendar: who is charged what, day by day, for the next 30 days. */
function BillingCalendar({ performance }: { performance: Performance }) {
  const b = performance.billing;
  if (!b) {
    return (
      <p className="ds-note">
        The billing calendar is unavailable — Stripe could not be read{performance.billingError ? ` (${performance.billingError})` : ""}.
      </p>
    );
  }
  const days = new Map<string, typeof b.upcoming>();
  for (const u of b.upcoming) days.set(u.date, [...(days.get(u.date) ?? []), u]);
  const total = b.upcoming.reduce((t, u) => t + u.amount, 0);
  const fmt = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <div className="tbl-wrap">
      <div className="tbl-head">
        <div>
          <div className="tbl-title">Upcoming billing</div>
          <div className="tbl-sub">Next 30 days · {b.upcoming.length} charges · ${Math.round(total).toLocaleString("en-US")} expected, from each live subscription&rsquo;s next charge date in Stripe</div>
        </div>
      </div>
      <div className="tbl-scroll">
        <table>
          <thead><tr><th>Date</th><th>Client</th><th>Amount</th><th>Cycle</th></tr></thead>
          <tbody>
            {[...days.entries()].map(([date, list]) => list.map((u, i) => (
              <tr key={`${date}-${i}`}>
                <td className="tnum">{i === 0 ? <b>{fmt(date)}</b> : null}</td>
                <td>{u.client ?? <span className="mut">Not tied to a client</span>}</td>
                <td className="tnum">${u.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}</td>
                <td className="mut">{u.every}</td>
              </tr>
            )))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/*
 * Plan colours, matching `.plan-prod` / `.plan-partner` / `.plan-min` on the
 * Clients roster so one plan does not read as two different things on two
 * screens.
 */
const PLAN_TONE: Record<string, string | undefined> = {
  production: "n-blue",
  partner: "n-purple",
  minimum: undefined,
};

/*
 * What the plan promises per week.
 *
 * Every client on a plan agreeing is the easy case. When they disagree the old
 * copy read "mixed weekly targets" — printed identically under all three cards,
 * which says nothing the reader cannot already see. The spread says the same
 * thing with the numbers in it, and "2–4 intros / week" is actionable where
 * "mixed" is not.
 */
function weeklyTargetLabel(plan: {
  weeklyTarget: number | null;
  targetMin: number | null;
  targetMax: number | null;
}): string {
  if (plan.weeklyTarget !== null) {
    return `${plan.weeklyTarget} intro${plan.weeklyTarget === 1 ? "" : "s"} / week`;
  }
  const { targetMin: lo, targetMax: hi } = plan;
  if (lo === null || hi === null) return "no weekly target set";
  if (lo === hi) return `${lo} intro${lo === 1 ? "" : "s"} / week`;
  return `${lo}–${hi} intros / week`;
}

function Card({
  label,
  value,
  sub,
  tone,
  prefix = "",
  suffix = "",
}: {
  label: string;
  value: number | null;
  sub: string;
  tone?: string;
  prefix?: string;
  suffix?: string;
}) {
  const missing = value === null;
  return (
    <div className="card">
      <div className="card-l">{label}</div>
      <div
        className={`card-n tnum${tone && !missing ? ` ${tone}` : ""}`}
        style={missing ? { color: MISSING } : undefined}
      >
        {missing ? "—" : `${prefix}${value.toLocaleString("en-US")}${suffix}`}
      </div>
      <div className="card-s" style={missing ? { color: MISSING } : undefined}>
        {sub}
      </div>
    </div>
  );
}

/*
 * The public screen. `initial` is set only when the page was opened here —
 * then it server-renders with no loading state and no second round trip.
 * Otherwise it fetches on first visit and stays mounted, so returning to it is
 * instant. See `Lazy` for why every route no longer pays for this data.
 */
export function PerformanceScreen({ initial }: { initial: Performance | null }) {
  return (
    <Lazy<Performance>
      initial={initial}
      url="/api/workspace/performance"
      label="Performance"
      skeleton={<PlaceholderScreen cards={4} />}
    >
      {(d) => <PerformanceView performance={d} />}
    </Lazy>
  );
}

/*
 * Performance › Billing Calendar (9 Oct, OS feedback): the calendar that sat
 * at the foot of Overview, on its own page. Same data and the same request as
 * Overview — `Lazy` shares one fetch per URL — so moving between the two
 * costs nothing.
 */
export function BillingCalendarScreen({ initial }: { initial: Performance | null }) {
  return (
    <Lazy<Performance>
      initial={initial}
      url="/api/workspace/performance"
      label="Billing Calendar"
      skeleton={<PlaceholderScreen cards={0} />}
    >
      {(d) => (
        <>
          <div className="hero"><PageHeader icon="performance" title="Billing Calendar" description="Every live subscription's charges in the next 30 days, from Stripe" /></div>
          <div className="wrap">
            <BillingCalendar performance={d} />
            <p style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 14, lineHeight: 1.7, maxWidth: "80ch" }}>
              Each charge is a live subscription&rsquo;s next charge date in Stripe, and the ones after it on the same
              cycle. Paused subscriptions are left out. MRR, ARR and growth are on <a href="/performance">Overview</a>.
            </p>
          </div>
        </>
      )}
    </Lazy>
  );
}
