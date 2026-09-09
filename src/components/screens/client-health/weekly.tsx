"use client";

import { useMemo, useState } from "react";

import { addDays, formatWeek, getMondayOf, weekKey } from "@/lib/tools/client-health/derive";
import { deriveRows, summarize, type WeeklyRow } from "@/lib/tools/client-health/summarize";
import {
  applyFilters, visibleTotal, FILTER_TABS,
  type Filter, type Sort, type SortCol,
} from "@/lib/tools/client-health/filters";
import type { ClientHealthWeeklyData } from "@/lib/tools/client-health/weekly";
import { ClientHealthFrame } from "./frame";
import { SyncButton } from "./sync-button";

/*
 * Client Health — Weekly.
 *
 * The design file's markup: thirteen cards in the order it lists them, the
 * table it specifies, its class names. The numbers come from the tool's own
 * derive(), so this screen and the live app cannot disagree.
 *
 * Every control here does the same thing the live tool's does — the filter
 * predicates below are a direct port of its switch statement, because a pill
 * labelled "At Risk" that selects a slightly different set than the tool's is
 * worse than no pill at all.
 *
 * Changing week is a re-derive in the browser, not a round trip: each client
 * already carries `metricsByWeek` for every week it has. The base week comes
 * from the server's own answer rather than a fresh `new Date()`, so the first
 * client render is identical to the server's and hydration never mismatches
 * across a Monday boundary.
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

const PLANS: { id: string; label: string }[] = [
  { id: "all", label: "All plans" },
  { id: "minimum", label: "Minimum" },
  { id: "production", label: "Production" },
  { id: "partner", label: "Partner" },
];

function WeeklyView({ data }: { data: ClientHealthWeeklyData }) {
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [plan, setPlan] = useState("all");
  const [sort, setSort] = useState<Sort | null>(null);

  // The week being shown, measured from the server's own answer so offset 0
  // reproduces the server render exactly.
  const key = offset === 0 ? data.weekKey : weekKey(addDays(`${data.weekKey}T00:00:00`, offset * 7));
  const isCurrent = offset === 0;

  /*
   * Derived here rather than sent from the server. Both are a pure function of
   * the clients and the week, so shipping them would be shipping the same data
   * twice — 650 KB of it. The server would compute exactly this.
   */
  /*
   * The server's rows win on the first render, because `derive()` reads the
   * local clock — deriving again here would compute "2d ago" against the
   * server's "3d ago" and break hydration. Once the reader changes week there
   * is no server render to match, so deriving is safe.
   */
  const rows = useMemo(
    () => (offset === 0 && data.rows ? data.rows : deriveRows(data.clients, key)),
    [data.rows, data.clients, key, offset],
  );
  const summary = useMemo(
    () => (offset === 0 && data.summary ? data.summary : summarize(rows)),
    [data.summary, rows, offset],
  );

  const visible = useMemo(() => applyFilters(rows, { search, filter, plan, sort }), [rows, search, filter, plan, sort]);

  const s = summary;

  const toggleSort = (col: SortCol) =>
    setSort((cur) =>
      cur?.col !== col ? { col, dir: "desc" } : cur.dir === "desc" ? { col, dir: "asc" } : null,
    );

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
          <button className="fp" onClick={() => setOffset((o) => o - 1)} aria-label="Previous week" title="Previous week">←</button>
          <button
            className={`fp${isCurrent ? " on" : ""}`}
            style={{ minWidth: 150 }}
            onClick={() => setOffset(0)}
            // Highlighted only on the current week, so the rail reads as "you
            // are looking at something else" the moment you step back.
            aria-label="Selected week"
            title={isCurrent ? "Showing this week" : "Back to this week"}
          >
            {isCurrent ? "This Week" : formatWeek(getMondayOf(`${key}T00:00:00`))}
          </button>
          <button
            className="fp"
            onClick={() => setOffset((o) => Math.min(0, o + 1))}
            disabled={isCurrent}
            aria-label="Next week"
            title={isCurrent ? "This is the current week" : "Next week"}
            style={isCurrent ? { opacity: 0.4, cursor: "not-allowed" } : undefined}
          >
            →
          </button>
        </span>
        <SyncButton />
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
            <div className="tbl-sub">
              Live data from Instantly · Bison · MasterInbox
              {visible.length !== visibleTotal(rows) ? ` · showing ${visible.length}` : ""}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <input
              className="inp"
              placeholder="Search clients…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search clients"
            />
            <select
              className="inp"
              value={plan}
              onChange={(e) => setPlan(e.target.value)}
              aria-label="Filter by plan"
              style={{ cursor: "pointer" }}
            >
              {PLANS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
            <span className="pills">
              {FILTER_TABS.map((f) => (
                <button
                  key={f.id}
                  className={`fp${f.cls ? ` ${f.cls}` : ""}${filter === f.id ? " on" : ""}`}
                  onClick={() => setFilter(f.id)}
                  aria-pressed={filter === f.id}
                  title={f.title}
                >
                  {f.label}
                </button>
              ))}
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
                <SortableTh col="leftWeek" sort={sort} onClick={toggleSort}>Left This Week</SortableTh>
                <SortableTh col="campaigns" sort={sort} onClick={toggleSort}>Campaign Progress</SortableTh>
                <th>Last Intro</th>
                <th>Status</th>
                <th>Interested</th>
                <th>Converted</th>
                <th>Plan</th>
                <th>Portal</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={13} style={{ padding: "34px 16px", textAlign: "center", color: "var(--muted)" }}>
                    No clients match {search.trim() ? `“${search.trim()}”` : "this filter"}.
                  </td>
                </tr>
              ) : (
                visible.map((row) => <Row key={row.client.id} row={row} />)
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SortableTh({
  col, sort, onClick, children,
}: {
  col: SortCol;
  sort: Sort | null;
  onClick: (col: SortCol) => void;
  children: React.ReactNode;
}) {
  const active = sort?.col === col;
  return (
    <th
      onClick={() => onClick(col)}
      style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
      title="Sort"
      aria-sort={active ? (sort.dir === "desc" ? "descending" : "ascending") : "none"}
    >
      {children}
      <span style={{ opacity: active ? 1 : 0.28, marginLeft: 5 }}>
        {active && sort.dir === "asc" ? "↑" : "↓"}
      </span>
    </th>
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

/*
 * The public screen. `initial` is present only when the page was opened on
 * this view — then it server-renders with no loading state and no second round
 * trip. Otherwise the frame fetches, sharing one request across all three
 * views, and the screen stays mounted afterwards so returning is instant.
 */
export function ClientHealthWeekly({ initial }: { initial: ClientHealthWeeklyData | null }) {
  return <ClientHealthFrame initial={initial}>{(data) => <WeeklyView data={data} />}</ClientHealthFrame>;
}
