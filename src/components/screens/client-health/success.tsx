"use client";

import { useMemo, useState } from "react";

import {
  applyFilters, visibleTotal, FILTER_TABS,
  type Filter, type Sort as WeeklySort,
} from "@/lib/tools/client-health/filters";
import { deriveRows } from "@/lib/tools/client-health/summarize";
import {
  successRows, sortSuccess, scoreTone, humanizeAgo, fmtDateShort,
  type CsSortCol, type SuccessRow,
} from "@/lib/tools/client-health/views";
import type { ClientHealthWeeklyData } from "@/lib/tools/client-health/weekly";
import { ClientHealthFrame } from "./frame";
import { SyncButton } from "./sync-button";

/*
 * Client Health — Client Success.
 *
 * The relationship lens, independent of the throughput ones. Weekly asks "did
 * they get their introductions"; this asks "is the account healthy" — is the
 * portal being worked, are introductions going stale, is anyone being hired.
 *
 * Two things are deliberate and both come from the tool:
 *
 *   a client too new to score shows "—", never 0.0. A zero would read as
 *   "scored badly" when the truth is "not enough weeks yet", and that
 *   distinction is the difference between a call and no call.
 *
 *   Stagnant Intros is introductions never touched since they arrived. It is
 *   the column most likely to prompt action, so a non-zero value is coloured
 *   and a zero is left quiet.
 */

const PLAN_CLASS: Record<string, string> = {
  minimum: "plan-min",
  production: "plan-prod",
  partner: "plan-partner",
};

const COLUMNS: { col: CsSortCol; label: string; title: string; num?: boolean }[] = [
  { col: "name", label: "Client", title: "Sort by client name" },
  { col: "plan", label: "Plan", title: "Sort by plan" },
  { col: "score", label: "Score", title: "Eight-week delivery score, 0–10", num: true },
  { col: "tz", label: "Time Zone", title: "Sort by time zone" },
  { col: "launch", label: "Launch Date", title: "Sort by launch date" },
  { col: "portal", label: "Portal Updated", title: "Last lead activity in the client portal" },
  { col: "stage", label: "Stagnant Intros", title: "Introductions never touched since they arrived", num: true },
  { col: "hired", label: "Hired", title: "Total hires recorded", num: true },
  { col: "lastHire", label: "Last Hire", title: "Most recent hire" },
  { col: "dnc", label: "DNC", title: "Do-not-contact count", num: true },
  { col: "agents", label: "Agents", title: "Agents in the client portal", num: true },
];

const SCORE_COLOR = { good: "var(--green)", mid: "var(--yellow)", low: "var(--red)" } as const;

function SuccessView({ data }: { data: ClientHealthWeeklyData }) {
  const [now] = useState(() => new Date(`${data.weekKey}T00:00:00Z`));
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<{ col: CsSortCol; dir: "desc" | "asc" } | null>(null);

  // The current week's rows, derived rather than sent — see weekly.ts.
  const rowsAll = useMemo(() => deriveRows(data.clients, data.weekKey), [data.clients, data.weekKey]);

  const filtered = useMemo(
    () => applyFilters(rowsAll, { search, filter, plan: "all", sort: null as WeeklySort | null }),
    [rowsAll, search, filter],
  );

  const rows = useMemo(
    () => sortSuccess(successRows(filtered.map((r) => r.client), now), sort),
    [filtered, now, sort],
  );

  const cycleSort = (col: CsSortCol) =>
    setSort((cur) => (cur?.col !== col ? { col, dir: "desc" } : cur.dir === "desc" ? { col, dir: "asc" } : null));

  const scored = rows.filter((r) => r.score !== null);
  const avgScore = scored.length
    ? scored.reduce((a, r) => a + (r.score ?? 0), 0) / scored.length
    : null;
  const stagnant = rows.reduce((a, r) => a + r.client.stagnant_intros_count, 0);
  const hires = rows.reduce((a, r) => a + r.hiredTotal, 0);
  const lowScoring = scored.filter((r) => (r.score ?? 0) < 5).length;

  // A portal untouched for a fortnight is the signal a CSM would want.
  const stale = rows.filter((r) => {
    if (!r.client.last_lead_activity_at) return true;
    const t = new Date(r.client.last_lead_activity_at).getTime();
    return Number.isFinite(t) && now.getTime() - t > 14 * 86_400_000;
  }).length;

  return (
    <div className="wrap">
      {data.source === "seed" ? (
        <div className="anno">
          <b>Showing sample data.</b> Client Health&rsquo;s database is not reachable
          {data.error ? ` — ${data.error}` : ""}.
        </div>
      ) : null}

      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 18 }}>
        <SyncButton />
      </div>

      <div className="cards" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
        <Card label="Clients" value={rows.length} sub="in this view" />
        <Card
          label="Avg Score"
          value={avgScore === null ? null : avgScore.toFixed(1)}
          sub={scored.length === rows.length ? "eight-week delivery" : `across ${scored.length} scored`}
          tone={avgScore === null ? undefined : avgScore >= 8 ? "n-green" : avgScore >= 5 ? "n-ok" : "n-risk"}
        />
        <Card label="Scoring Below 5" value={lowScoring} sub="need attention" tone={lowScoring > 0 ? "n-risk" : "n-green"} />
        <Card label="Stagnant Intros" value={stagnant} sub="never touched since arriving" tone={stagnant > 0 ? "n-risk" : "n-green"} />
        <Card label="Portals Quiet 14d+" value={stale} sub="no lead activity" tone={stale > 0 ? "n-risk" : "n-green"} />
        <Card label="Hired" value={hires} sub="all time, across clients" tone="n-green" />
      </div>

      <div className="tbl-wrap">
        <div className="tbl-head">
          <div>
            <div className="tbl-title">Client Success</div>
            <div className="tbl-sub">
              Account health — portal activity, stagnant introductions, hires
              {rows.length !== visibleTotal(rowsAll) ? ` · showing ${rows.length}` : ""}
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
          <table style={{ minWidth: 1420 }}>
            <thead>
              <tr>
                {COLUMNS.map((c) => {
                  const active = sort?.col === c.col;
                  return (
                    <th
                      key={c.col}
                      onClick={() => cycleSort(c.col)}
                      title={`${c.title} — click to cycle descending, ascending, then reset`}
                      style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
                      aria-sort={active ? (sort.dir === "desc" ? "descending" : "ascending") : "none"}
                    >
                      {c.label}
                      <span style={{ opacity: active ? 1 : 0.28, marginLeft: 5 }}>
                        {!active ? "↕" : sort.dir === "desc" ? "↓" : "↑"}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={COLUMNS.length} style={{ padding: "34px 16px", textAlign: "center", color: "var(--muted)" }}>
                    No clients match {search.trim() ? `“${search.trim()}”` : "this filter"}.
                  </td>
                </tr>
              ) : (
                rows.map((r) => <Row key={r.client.id} row={r} now={now.getTime()} />)
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Row({ row, now }: { row: SuccessRow; now: number }) {
  const { client: c, hiredTotal, lastHireAt, score, tzShort } = row;

  return (
    <tr>
      <td><div className="cname">{c.name}</div></td>

      <td>
        <span className={`plan ${PLAN_CLASS[c.plan] ?? "plan-min"}`}>
          {c.plan.charAt(0).toUpperCase() + c.plan.slice(1)}
        </span>
      </td>

      <td>
        {score === null ? (
          <span className="api-none" title="Too few weeks of history to score yet">—</span>
        ) : (
          <span className="tnum" style={{ fontWeight: 700, color: SCORE_COLOR[scoreTone(score)] }}>
            {score.toFixed(1)}
          </span>
        )}
      </td>

      <td>{tzShort ? <span className="tg">{tzShort}</span> : <span className="api-none">—</span>}</td>

      <td className="tnum mut">{c.start_date ? fmtDateShort(c.start_date) : <span className="api-none">—</span>}</td>

      <td className="mut">
        {c.last_lead_activity_at ? humanizeAgo(c.last_lead_activity_at, now) : <span className="api-none">—</span>}
      </td>

      <td>
        {c.stagnant_intros_count > 0 ? (
          <span className="tg" style={{ background: "var(--red-bg)", borderColor: "transparent", color: "var(--red)" }}>
            {c.stagnant_intros_count}
          </span>
        ) : (
          <span className="tnum" style={{ color: "var(--muted)" }}>0</span>
        )}
      </td>

      <td>{hiredTotal > 0 ? <span className="api-num tnum">{hiredTotal}</span> : <span className="api-none">—</span>}</td>

      <td className="mut">{lastHireAt ? humanizeAgo(lastHireAt, now) : <span className="api-none">—</span>}</td>

      <td>{c.dnc_count > 0 ? <span className="tnum">{c.dnc_count.toLocaleString("en-US")}</span> : <span className="api-none">—</span>}</td>

      <td>{c.agents_count > 0 ? <span className="tnum">{c.agents_count.toLocaleString("en-US")}</span> : <span className="api-none">—</span>}</td>
    </tr>
  );
}

function Card({
  label, value, sub, tone,
}: { label: string; value: number | string | null; sub: string; tone?: string }) {
  const missing = value === null;
  return (
    <div className="card">
      <div className="card-l">{label}</div>
      <div
        className={`card-n tnum${tone && !missing ? ` ${tone}` : ""}`}
        style={missing ? { color: "#B9C0CB" } : undefined}
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
export function ClientHealthSuccess({ initial }: { initial: ClientHealthWeeklyData | null }) {
  return <ClientHealthFrame initial={initial}>{(data) => <SuccessView data={data} />}</ClientHealthFrame>;
}
