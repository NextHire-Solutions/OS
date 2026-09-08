import type { ClientHealthWeekly, ClientStatus, WeeklyClient } from "@/lib/tools/client-health";

/*
 * Client Health — Weekly.
 *
 * Built natively in the workspace: the live tool is untouched, and this reads
 * its API and draws the design's own markup. Card order, column order, class
 * names and copy follow the design file exactly, so its stylesheet drives this
 * with no translation layer.
 *
 * Where a number cannot be sourced the cell shows an em dash, never a zero.
 * On a health dashboard a fabricated 0 reads as "nothing happened", which is a
 * confident claim and a different one from "we could not measure".
 */

const STATUS_LABEL: Record<ClientStatus, string> = {
  "at-risk": "At Risk",
  "on-track": "On Track",
  done: "Done",
  paused: "Paused",
  churned: "Hidden",
  pending: "Pending",
};

const STATUS_CLASS: Record<ClientStatus, string> = {
  "at-risk": "s-risk",
  "on-track": "s-ok",
  done: "s-done",
  paused: "s-pending",
  churned: "s-pending",
  pending: "s-pending",
};

const PLAN_CLASS: Record<string, string> = {
  minimum: "plan-min",
  production: "plan-prod",
  partner: "plan-partner",
};

export function ClientHealthWeeklyScreen({ data }: { data: ClientHealthWeekly }) {
  if (data.unavailable) {
    return (
      <div className="wrap">
        <div className="card">
          <div className="card-l">Client Health</div>
          <p style={{ fontSize: 14, color: "var(--muted)" }}>{data.unavailable}</p>
        </div>
      </div>
    );
  }

  const s = data.summary;

  return (
    <div className="wrap">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, marginBottom: 18 }}>
        <span className="pills" style={{ padding: 0 }}>
          <button className="fp">←</button>
          <button className="fp on" style={{ minWidth: 150 }}>This Week</button>
          <button className="fp">→</button>
        </span>
      </div>

      <div className="cards" style={{ gridTemplateColumns: "repeat(6, 1fr)" }}>
        <Card label="Clients" value={s.clients} sub="active" />
        <Card label="At Risk" value={s.atRisk} sub="below half target" tone="n-risk" />
        <Card label="On Track" value={s.onTrack} sub="meeting target this week" tone="n-ok" />
        <Card label="Done" value={s.done} sub="met weekly target" tone="n-done" />
        <Card label="Intros Sent" value={s.introsSent} sub="across all clients" tone="n-intros" />
        <Card label="Intros Target" value={s.introsTarget} sub="weekly across all clients" />
        <Card
          label="Completion"
          value={s.completion === null ? null : `${Math.round(s.completion * 100)}%`}
          sub="intros vs weekly target"
          tone="n-green"
        />
        <Card label="Client Paused" value={s.paused} sub="manually paused" />
        <Card
          label="By Plan"
          value={`${s.byPlan.minimum} · ${s.byPlan.production} · ${s.byPlan.partner}`}
          sub="min · prod · partner"
          size={26}
        />
        <Card label="Emails Sent" value={s.emailsSent} sub="across all clients" tone="n-emails" />
        <Card
          label="Avg Conv."
          value={s.conversion === null ? null : `${s.conversion.toFixed(1)}`}
          sub="intros per 1k emails"
          tone="n-ok"
        />
        <Card label="Interested" value={s.interested} sub="interested replies" tone="n-green" />
      </div>

      <div className="tbl-wrap">
        <div className="tbl-head">
          <div>
            <div className="tbl-title">Client Health</div>
            <div className="tbl-sub">
              Live data from Instantly · Bison · MasterInbox
              {data.weekKey ? ` · week of ${data.weekKey}` : ""}
            </div>
          </div>
        </div>

        <div className="tbl-scroll">
          <table style={{ minWidth: 1180 }}>
            <thead>
              <tr>
                <th>Client</th>
                <th>Daily Emails Sent</th>
                <th>Emails Sent</th>
                <th>Intros This Week</th>
                <th>Conv. Rate</th>
                <th>Left This Week</th>
                <th>Last Intro</th>
                <th>Status</th>
                <th>Interested</th>
                <th>Plan</th>
                <th>Portal</th>
              </tr>
            </thead>
            <tbody>
              {data.clients.map((c) => (
                <Row key={c.id} c={c} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Row({ c }: { c: WeeklyClient }) {
  return (
    <tr>
      <td>
        <div className="cname">{c.name}</div>
        {c.startDate ? <div className="csince">Since {formatDate(c.startDate)}</div> : null}
      </td>
      <td><Num value={c.emailsToday} /></td>
      <td><Num value={c.emailsSent} /></td>
      <td>
        <input
          className={`mi tnum${c.status === "at-risk" ? " risk" : c.status === "done" ? " ok" : ""}`}
          value={c.intros}
          readOnly
        />
      </td>
      <td>
        {c.conversion === null ? (
          <span className="api-none">—</span>
        ) : (
          <span className="tnum" style={{ fontWeight: 700, color: c.conversion >= 1 ? "var(--green)" : "var(--yellow)" }}>
            {c.conversion.toFixed(1)}
          </span>
        )}
      </td>
      <td>
        {c.remaining === 0 ? (
          <span className="tnum" style={{ color: "var(--muted)" }}>0</span>
        ) : (
          <span className="tg" style={{ background: "var(--red-bg)", borderColor: "transparent", color: "var(--red)" }}>
            {c.remaining} left
          </span>
        )}
      </td>
      <td>{c.lastIntroAt ? <Relative iso={c.lastIntroAt} /> : <span className="api-none">—</span>}</td>
      <td>
        <span className={`badge ${STATUS_CLASS[c.status]}`}>
          <span className="dot" />
          {STATUS_LABEL[c.status]}
        </span>
      </td>
      <td><Num value={c.interested} /></td>
      <td>
        {c.plan ? (
          <span className={`plan ${PLAN_CLASS[c.plan] ?? "plan-min"}`}>
            {c.plan.charAt(0).toUpperCase() + c.plan.slice(1)}
          </span>
        ) : (
          <span className="api-none">—</span>
        )}
      </td>
      <td style={c.portalActive ? { color: "var(--green)", fontWeight: 700 } : undefined} className={c.portalActive ? "" : "mut"}>
        {c.portalActive ? "✓" : "—"}
      </td>
    </tr>
  );
}

/** A missing number is a dash. Never a zero — see the note at the top. */
function Num({ value }: { value: number | null }) {
  return value === null ? (
    <span className="api-none">—</span>
  ) : (
    <span className="api-num tnum">{value.toLocaleString("en-US")}</span>
  );
}

function Relative({ iso }: { iso: string }) {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  const label = days <= 0 ? "Today" : days === 1 ? "Yesterday" : `${days}d ago`;
  const stale = days > 7;
  return (
    <span
      className={stale ? "tg" : ""}
      style={
        stale
          ? { background: "var(--yellow-bg)", borderColor: "transparent", color: "var(--yellow)" }
          : { fontSize: 13, fontWeight: 700, color: "var(--green)" }
      }
    >
      {label}
    </span>
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
