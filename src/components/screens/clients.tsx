import type { ClientsOverview, ClientRow } from "@/lib/clients/overview";

/*
 * Clients — one row per client, and what each tool knows about them.
 *
 * The roster is the spine. Every row is a client the business has; the columns
 * show what each tool holds for it. A blank cell is a gap in that tool, not a
 * disagreement about who the clients are — which is the entire reason for
 * having a canonical list.
 *
 * The page is deliberately quiet. A client present everywhere draws no
 * attention at all; only genuine gaps are marked, because a screen that
 * highlights everything gets read once.
 */

const PLAN_CLASS: Record<string, string> = {
  minimum: "plan-min",
  production: "plan-prod",
  partner: "plan-partner",
};

export function ClientsScreen({ data }: { data: ClientsOverview }) {
  const present = (fn: (r: ClientRow) => boolean) => data.rows.filter(fn).length;

  return (
    <>
      <div className="hero">
        <h1>Clients</h1>
        <p>{data.rows.length} clients · what each tool knows about them</p>
      </div>

      <div className="wrap">
        <div className="cards" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
          <Card label="Clients" value={data.rows.length} sub="on the roster" />
          <Card
            label="In Client Health"
            value={present((r) => r.health.present)}
            sub="the billed roster"
            tone={present((r) => r.health.present) === data.rows.length ? "n-green" : undefined}
          />
          <Card
            label="In Master Inbox"
            value={present((r) => r.inbox.present)}
            sub="replies attributed"
            tone={present((r) => r.inbox.present) === data.rows.length ? "n-green" : undefined}
          />
          <Card
            label="In Analytics"
            value={present((r) => r.analytics.present)}
            sub="campaign attribution"
            tone={present((r) => r.analytics.present) === data.rows.length ? "n-green" : "n-risk"}
          />
        </div>

        <div className="tbl-wrap">
          <div className="tbl-head">
            <div>
              <div className="tbl-title">Client roster</div>
              <div className="tbl-sub">
                The names the business uses. Each tool&rsquo;s own spelling is matched to these.
              </div>
            </div>
          </div>

          <div className="tbl-scroll">
            <table style={{ minWidth: 1080 }}>
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Plan</th>
                  <th>Status</th>
                  <th>Weekly target</th>
                  <th>Introductions</th>
                  <th>Last intro</th>
                  <th>Campaigns</th>
                  <th>Sent</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <Row key={row.client.name} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Rows a tool holds that are not on the roster. Reported, because one
            is either a client nobody mentioned or a spelling needing an alias —
            and silently dropping either is how a live client disappears. */}
        {(["health", "inbox", "analytics"] as const).map((k) => {
          const tool = data.tools[k];
          if (tool.unavailable) {
            return (
              <p key={k} style={note}>
                <b>{tool.label}</b> could not be read — {tool.unavailable}
              </p>
            );
          }
          if (tool.unknown.length === 0) return null;
          return (
            <p key={k} style={note}>
              <b>{tool.label}</b> holds {tool.unknown.length} entr
              {tool.unknown.length === 1 ? "y" : "ies"} not on the roster:{" "}
              {tool.unknown.join(", ")}. Either a client to add here, or a spelling to
              record as an alias.
            </p>
          );
        })}

        {/* Deliberate non-clients, so nobody mistakes them for clutter. */}
        {Object.values(data.tools).some((t) => t.exempt.length > 0) ? (
          <p style={note}>
            <b>Kept on purpose:</b>{" "}
            {[...new Map(
              Object.values(data.tools).flatMap((t) => t.exempt.map((e) => [e.name, e] as const)),
            ).values()]
              .map((e) => `${e.name} (${e.reason})`)
              .join(", ")}
            .
          </p>
        ) : null}
      </div>
    </>
  );
}

const note: React.CSSProperties = {
  fontSize: 12.5,
  color: "var(--muted)",
  marginTop: 12,
  lineHeight: 1.7,
  maxWidth: "90ch",
};

function Row({ row }: { row: ClientRow }) {
  const { client, health, inbox, analytics } = row;
  return (
    <tr>
      <td><div className="cname">{client.name}</div></td>

      <td>
        {health.plan ? (
          <span className={`plan ${PLAN_CLASS[health.plan] ?? "plan-min"}`}>
            {health.plan.charAt(0).toUpperCase() + health.plan.slice(1)}
          </span>
        ) : (
          <Gap tool="Client Health" />
        )}
      </td>

      <td>
        {health.status ? (
          <span className={`badge ${health.status === "active" ? "s-done" : "s-pending"}`}>
            <span className="dot" />
            {health.status.charAt(0).toUpperCase() + health.status.slice(1)}
          </span>
        ) : (
          <span className="api-none">—</span>
        )}
      </td>

      <td>{health.weeklyTarget === null ? <span className="api-none">—</span> : <span className="tnum">{health.weeklyTarget}</span>}</td>

      <td>
        {inbox.present ? (
          <span className="api-num tnum">{(inbox.intros ?? 0).toLocaleString("en-US")}</span>
        ) : (
          <Gap tool="Master Inbox" />
        )}
      </td>

      <td className="mut">{inbox.lastIntro ? formatDate(inbox.lastIntro) : "—"}</td>

      <td>
        {analytics.present ? (
          <span className="tnum">{analytics.campaigns ?? 0}</span>
        ) : (
          <Gap tool="Analytics" />
        )}
      </td>

      <td>{analytics.sent === null ? <span className="api-none">—</span> : <span className="tnum">{analytics.sent.toLocaleString("en-US")}</span>}</td>
    </tr>
  );
}

/** A client a tool does not have. Named, so the reader knows what to fix. */
function Gap({ tool }: { tool: string }) {
  return (
    <span
      className="tg"
      style={{ background: "var(--red-bg)", borderColor: "transparent", color: "var(--red)" }}
      title={`Not set up in ${tool}`}
    >
      missing
    </span>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function Card({
  label, value, sub, tone,
}: { label: string; value: number; sub: string; tone?: string }) {
  return (
    <div className="card">
      <div className="card-l">{label}</div>
      <div className={`card-n tnum${tone ? ` ${tone}` : ""}`}>{value}</div>
      <div className="card-s">{sub}</div>
    </div>
  );
}
