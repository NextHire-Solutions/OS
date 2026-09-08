import type { ClientHealthWeeklyData, WeeklyRow } from "@/lib/tools/client-health/weekly";

/*
 * Client Health — Weekly.
 *
 * The design file's markup: thirteen cards in the order it lists them, the
 * table it specifies, its class names. The numbers come from the tool's own
 * derive(), so this screen and the live app cannot disagree.
 *
 * A cell with no data shows an em dash. Never a zero — on a health dashboard
 * "0 emails sent" is a claim, and a different one from "we have no figure".
 */

const STATUS = {
  risk: { label: "At Risk", cls: "s-risk" },
  ok: { label: "On Track", cls: "s-ok" },
  done: { label: "Done", cls: "s-done" },
  pending: { label: "Pending", cls: "s-pending" },
} as const;

const PLAN_CLASS: Record<string, string> = {
  minimum: "plan-min",
  production: "plan-prod",
  partner: "plan-partner",
};

export function ClientHealthWeekly({ data }: { data: ClientHealthWeeklyData }) {
  const s = data.summary;

  // Hidden clients are off-roster in the tool and are not listed here either.
  const visible = data.rows.filter((r) => !r.client.hidden);

  return (
    <div className="wrap">
      {data.source === "seed" ? (
        <div className="anno">
          <b>Showing sample data.</b> Client Health&rsquo;s database is not reachable
          {data.error ? ` — ${data.error}` : ""}.
        </div>
      ) : null}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, marginBottom: 18 }}>
        <span className="pills" style={{ padding: 0 }}>
          <button className="fp">←</button>
          <button className="fp on" style={{ minWidth: 150 }}>This Week</button>
          <button className="fp">→</button>
        </span>
        <button className="btn btn-pri">+ Add Client</button>
      </div>

      <div className="cards" style={{ gridTemplateColumns: "repeat(6, 1fr)" }}>
        <Card label="Clients" value={s.total} sub="active" />
        <Card label="At Risk" value={s.risk} sub="below half target" tone="n-risk" />
        <Card label="On Track" value={s.ok} sub="meeting target this week" tone="n-ok" />
        <Card label="Done" value={s.done} sub="met weekly target" tone="n-done" />
        <Card label="Intros Sent" value={s.intros} sub="across all clients" tone="n-intros" />
        <Card label="Intros Target" value={s.target} sub="weekly across all clients" />
        <Card label="Completion" value={`${s.completionPct}%`} sub="intros vs weekly target" tone="n-green" />
        <Card label="Client Paused" value={s.clientPaused} sub="manually paused" />
        <Card
          label="By Plan"
          value={`${s.plans.minimum} · ${s.plans.production} · ${s.plans.partner}`}
          sub="min · prod · partner"
          size={26}
        />
        <Card label="Emails Sent" value={s.emails} sub="across all clients" tone="n-emails" />
        <Card
          label="Avg Conv."
          value={s.avgConv === null ? null : `${s.avgConv.toFixed(1)}`}
          sub="1k email → intro"
          tone="n-ok"
        />
        <Card label="Converted" value={s.convertedTotal} sub="interested → intro leads" tone="n-green" />
        <Card
          label="Int → Intro"
          value={s.intToIntroPct === null ? null : `${s.intToIntroPct.toFixed(1)}%`}
          sub="of total funnel"
          tone="n-blue"
        />
      </div>

      <div className="tbl-wrap">
        <div className="tbl-head">
          <div>
            <div className="tbl-title">Client Health</div>
            <div className="tbl-sub">Live data from Instantly · Bison · MasterInbox</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <input className="inp" placeholder="Search clients…" />
            <span className="pills">
              <button className="fp on">All</button>
              <button className="fp f-risk">At Risk</button>
              <button className="fp f-ok">On Track</button>
              <button className="fp f-ok">Done</button>
              <button className="fp">Paused</button>
            </span>
          </div>
        </div>

        <div className="tbl-scroll">
          <table style={{ minWidth: 1520 }}>
            <thead>
              <tr>
                <th>Client</th>
                <th>Daily Emails Sent</th>
                <th>Emails Sent</th>
                <th>Intros This Week</th>
                <th>Conv. Rate</th>
                <th>Left This Week</th>
                <th>Campaign Progress</th>
                <th>Last Intro</th>
                <th>Status</th>
                <th>Interested</th>
                <th>Converted</th>
                <th>Plan</th>
                <th>Portal</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <Row key={row.client.id} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Row({ row }: { row: WeeklyRow }) {
  const { client: c, derived: d } = row;
  const status = c.client_paused ? STATUS.pending : STATUS[d.status];

  return (
    <tr>
      <td>
        <div className="cname">{c.name}</div>
        {c.start_date ? <div className="csince">Since {formatDate(c.start_date)}</div> : null}
        {c.client_paused ? (
          <span className="cmeta" style={{ borderStyle: "dashed", opacity: 0.75 }}>Client Paused</span>
        ) : null}
      </td>

      <td>{c.emails_today ? <span className="api-num tnum">{c.emails_today.toLocaleString("en-US")}</span> : <span className="api-none">—</span>}</td>
      <td>{d.hasEmails ? <span className="api-num tnum">{d.emails.toLocaleString("en-US")}</span> : <span className="api-none">—</span>}</td>

      <td>
        <input
          className={`mi tnum${d.status === "risk" ? " risk" : d.metTarget ? " ok" : ""}`}
          value={d.intros}
          readOnly
        />
      </td>

      <td>
        {d.convPct === null ? (
          <span className="api-none">—</span>
        ) : (
          <span
            className="tnum"
            style={{
              fontWeight: 700,
              color:
                d.convClass === "good" ? "var(--green)"
                : d.convClass === "mid" ? "var(--yellow)"
                : "var(--red)",
            }}
          >
            {d.convPct.toFixed(1)}%
          </span>
        )}
      </td>

      <td>
        {d.leftThisWeek === 0 ? (
          <span className="tnum" style={{ color: "var(--muted)" }}>0</span>
        ) : (
          <span className="tg" style={{ background: "var(--red-bg)", borderColor: "transparent", color: "var(--red)" }}>
            {d.leftThisWeek} left
          </span>
        )}
      </td>

      <td>
        {d.campaignsAvgPct > 0 ? (
          <>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{Math.round(d.campaignsAvgPct)}%</div>
            <div className="track"><i style={{ width: `${Math.min(100, d.campaignsAvgPct)}%` }} /></div>
          </>
        ) : (
          <span className="api-none">—</span>
        )}
      </td>

      <td>
        {d.daysSince === null ? (
          <span style={{ fontSize: 13, color: "var(--muted)" }}>No data</span>
        ) : d.daysSince <= 1 ? (
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--green)" }}>
            {d.daysSince === 0 ? "Today" : "Yesterday"}
          </span>
        ) : (
          <span
            className="tg"
            style={{ background: "var(--yellow-bg)", borderColor: "transparent", color: "var(--yellow)" }}
          >
            {d.daysSince}d ago
          </span>
        )}
      </td>

      <td>
        <span className={`badge ${status.cls}`}>
          <span className="dot" />
          {c.client_paused ? "Paused" : status.label}
        </span>
      </td>

      <td><input className="mi tnum" value={d.interested} readOnly /></td>
      <td><input className="mi tnum" value={d.intros} readOnly /></td>

      <td>
        <span className={`plan ${PLAN_CLASS[c.plan] ?? "plan-min"}`}>
          {c.plan.charAt(0).toUpperCase() + c.plan.slice(1)}
        </span>
      </td>

      <td className={c.portal_active ? "" : "mut"} style={c.portal_active ? { color: "var(--green)", fontWeight: 700 } : undefined}>
        {c.portal_active ? "✓" : "—"}
      </td>
    </tr>
  );
}

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

function Card({
  label, value, sub, tone, size,
}: {
  label: string;
  value: number | string | null;
  sub: string;
  tone?: string;
  size?: number;
}) {
  const missing = value === null;
  return (
    <div className="card">
      <div className="card-l">{label}</div>
      <div
        className={`card-n tnum${tone && !missing ? ` ${tone}` : ""}`}
        style={{ ...(size ? { fontSize: size } : {}), ...(missing ? { color: "#B9C0CB" } : {}) }}
      >
        {missing ? "—" : typeof value === "number" ? value.toLocaleString("en-US") : value}
      </div>
      <div className="card-s">{sub}</div>
    </div>
  );
}
