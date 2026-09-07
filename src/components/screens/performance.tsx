import type { Performance } from "@/lib/workspace/performance";

/*
 * Performance — client base, plans and movement.
 *
 * Follows the design's markup, including its decision to grey out clients
 * churned and monthly revenue. That decision turned out to be exactly right:
 * churn is stored as a boolean with no date, and plans carry no price, so
 * neither figure exists anywhere in the stack.
 *
 * Where a number is unavailable the cell says WHY. "—" alone invites someone
 * to assume the value is zero; "needs status history" tells them what would
 * have to change, which is the difference between a gap and a to-do.
 */

const MISSING = "#B9C0CB";

export function PerformanceScreen({ performance }: { performance: Performance }) {
  const { totals, plans, months, unavailable } = performance;

  if (unavailable) {
    return (
      <>
        <div className="hero">
          <h1>Performance</h1>
          <p>Client base, plans and movement</p>
        </div>
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
      <div className="hero">
        <h1>Performance</h1>
        <p>Client base, plans and movement · last 90 days</p>
      </div>

      <div className="wrap">
        <div className="cards" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
          <Card label="Total clients" value={totals.clients} sub={`${totals.active} active · ${totals.paused} paused`} />
          <Card
            label="Clients added"
            value={totals.addedLast90}
            tone="n-green"
            prefix="+"
            sub="last 90 days"
          />
          {/*
           * Churned is known as a COUNT but not as a rate over time, because
           * `hidden` carries no date. Showing the count beside "needs status
           * history" is the honest middle: we know 7 have left, not when.
           */}
          <Card
            label="Clients churned"
            value={totals.churned}
            sub="all time · needs status history for a rate"
          />
          <Card label="Monthly revenue" value={null} sub="needs plan pricing" />
        </div>

        <div className="cards" style={{ gridTemplateColumns: `repeat(${Math.max(1, plans.length)}, 1fr)` }}>
          {plans.map((plan) => (
            <Card
              key={plan.plan}
              label={plan.label}
              value={plan.count}
              sub={plan.weeklyTarget !== null ? `${plan.weeklyTarget} intros / week` : "mixed weekly targets"}
            />
          ))}
        </div>

        <div className="tbl-wrap">
          <div className="tbl-head">
            <div>
              <div className="tbl-title">Client movement</div>
              <div className="tbl-sub">
                When each client was onboarded
                {totals.undated > 0
                  ? ` · ${totals.undated} client${totals.undated === 1 ? "" : "s"} have no start date and are not counted below`
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
                  <th>Net</th>
                  <th>Onboarded to date</th>
                  <th>Revenue</th>
                </tr>
              </thead>
              <tbody>
                {months.map((row) => (
                  <tr key={row.month}>
                    <td>{row.label}</td>
                    <td className="tnum n-green">+{row.added}</td>
                    <td className="mut">—</td>
                    <td className="mut">—</td>
                    <td className="tnum">{row.onboardedToDate}</td>
                    <td className="mut">—</td>
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
          <b>Churned</b> and <b>Net</b> are blank because Client Health records churn as a
          flag with no date — the total is known, the month is not. A status-history table
          would fill both columns. <b>Revenue</b> needs a price on each plan.{" "}
          <b>Onboarded to date</b> is a running total of onboardings and never subtracts
          churn, so it is not the client count at that moment.
        </p>
      </div>
    </>
  );
}

function Card({
  label,
  value,
  sub,
  tone,
  prefix = "",
}: {
  label: string;
  value: number | null;
  sub: string;
  tone?: string;
  prefix?: string;
}) {
  const missing = value === null;
  return (
    <div className="card">
      <div className="card-l">{label}</div>
      <div
        className={`card-n tnum${tone && !missing ? ` ${tone}` : ""}`}
        style={missing ? { color: MISSING } : undefined}
      >
        {missing ? "—" : `${prefix}${value.toLocaleString("en-US")}`}
      </div>
      <div className="card-s" style={missing ? { color: MISSING } : undefined}>
        {sub}
      </div>
    </div>
  );
}
