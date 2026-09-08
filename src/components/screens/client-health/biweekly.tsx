"use client";

import { useMemo, useState } from "react";

import { applyFilters, visibleTotal, type Filter, type Sort as WeeklySort } from "@/lib/tools/client-health/filters";
import {
  biweeklyRows, sortBiWeekly, fmtDateUTC,
  type BwSortCol, type BiWeeklyRow,
} from "@/lib/tools/client-health/views";
import type { ClientHealthWeeklyData } from "@/lib/tools/client-health/weekly";
import { ClientHealthFrame } from "./frame";

/*
 * Client Health — Bi-Weekly.
 *
 * Answers one question: who bills next, and are they owed introductions when
 * they do. That is why the default sort is soonest-billing-first and why the
 * "Left This Cycle" column is loud — a client billing in two days who is four
 * introductions short is the whole point of the screen.
 *
 * All arithmetic comes from the tool's own BiWeeklyTable via views.ts, so this
 * screen and the live app cannot disagree.
 *
 * `now` is fixed at mount rather than read during render: every value here
 * depends on today's date, and a date that moved between the server render and
 * hydration would produce a mismatch for no benefit.
 */

const PLAN_CLASS: Record<string, string> = {
  minimum: "plan-min",
  production: "plan-prod",
  partner: "plan-partner",
};

const FILTERS: { id: Filter; label: string; cls?: string }[] = [
  { id: "all", label: "All" },
  { id: "risk", label: "At Risk", cls: "f-risk" },
  { id: "ok", label: "On Track", cls: "f-ok" },
  { id: "done", label: "Done", cls: "f-ok" },
  { id: "paused", label: "Paused" },
];

const COLUMNS: { col: BwSortCol; label: string; title: string }[] = [
  { col: "name", label: "Client", title: "Sort by client name" },
  { col: "tz", label: "Time Zone", title: "Sort by time zone" },
  { col: "billing", label: "Billing Date", title: "Sort by next billing date" },
  { col: "days", label: "Days Until Billing", title: "Sort by days until billing" },
  { col: "intros", label: "Introductions", title: "Introductions since the client's last billing day" },
  { col: "leftCycle", label: "Left This Cycle", title: "Introductions left in the current billing cycle" },
];

function BiWeeklyView({ data }: { data: ClientHealthWeeklyData }) {
  const [now] = useState(() => new Date(`${data.weekKey}T00:00:00Z`));
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<{ col: BwSortCol; dir: "desc" | "asc" } | null>(null);

  // Filtered with the Weekly view's own predicates, so "At Risk" means the
  // same thing on both screens.
  const filtered = useMemo(
    () => applyFilters(data.rows, { search, filter, plan: "all", sort: null as WeeklySort | null }),
    [data.rows, search, filter],
  );

  const rows = useMemo(
    () => sortBiWeekly(biweeklyRows(filtered.map((r) => r.client), now), sort),
    [filtered, now, sort],
  );

  // 1st click → desc, 2nd → asc, 3rd → back to the default order.
  const cycleSort = (col: BwSortCol) =>
    setSort((cur) => (cur?.col !== col ? { col, dir: "desc" } : cur.dir === "desc" ? { col, dir: "asc" } : null));

  const dueSoon = rows.filter((r) => r.days !== null && r.days <= 3).length;
  const short = rows.filter((r) => r.leftCycle > 0).length;
  const unset = rows.filter((r) => r.billing === null).length;

  return (
    <div className="wrap">
      {data.source === "seed" ? (
        <div className="anno">
          <b>Showing sample data.</b> Client Health&rsquo;s database is not reachable
          {data.error ? ` — ${data.error}` : ""}.
        </div>
      ) : null}

      <div className="cards" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
        <Card label="Clients" value={rows.length} sub="in this cycle view" />
        <Card label="Billing in ≤3 days" value={dueSoon} sub="invoice imminent" tone={dueSoon > 0 ? "n-risk" : undefined} />
        <Card label="Short of Cycle Target" value={short} sub="introductions still owed" tone={short > 0 ? "n-risk" : "n-green"} />
        <Card label="No Billing Date" value={unset} sub="anchor not set" tone={unset > 0 ? "n-risk" : undefined} />
      </div>

      <div className="tbl-wrap">
        <div className="tbl-head">
          <div>
            <div className="tbl-title">Billing Cycles</div>
            <div className="tbl-sub">
              Introductions since each client&rsquo;s last billing day, against a target scaled to their interval
              {rows.length !== visibleTotal(data.rows) ? ` · showing ${rows.length}` : ""}
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
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  className={`fp${f.cls ? ` ${f.cls}` : ""}${filter === f.id ? " on" : ""}`}
                  onClick={() => setFilter(f.id)}
                  aria-pressed={filter === f.id}
                >
                  {f.label}
                </button>
              ))}
            </span>
          </div>
        </div>

        <div className="tbl-scroll">
          <table style={{ minWidth: 900 }}>
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
                rows.map((r) => <Row key={r.client.id} row={r} />)
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Row({ row }: { row: BiWeeklyRow }) {
  const { client: c, billing, days, intros, target, leftCycle, tzShort } = row;

  // Matches the tool's three-way colouring: met, at least half, below half.
  const introTone =
    intros >= target ? "var(--green)"
    : intros >= Math.ceil(target / 2) ? "var(--yellow)"
    : "var(--red)";

  return (
    <tr>
      <td>
        <div className="cname">{c.name}</div>
        <span className="plan-inline">
          <span className={`plan ${PLAN_CLASS[c.plan] ?? "plan-min"}`}>
            {c.plan.charAt(0).toUpperCase() + c.plan.slice(1)}
          </span>
        </span>
      </td>

      <td>{tzShort ? <span className="tg">{tzShort}</span> : <span className="api-none">—</span>}</td>

      <td className="tnum">
        {billing ? fmtDateUTC(billing) : <span className="api-none" title="No billing anchor set for this client">not set</span>}
      </td>

      <td>
        {days === null ? (
          <span className="api-none">—</span>
        ) : days <= 3 ? (
          <span className="tg" style={{ background: "var(--red-bg)", borderColor: "transparent", color: "var(--red)" }}>
            {days} day{days === 1 ? "" : "s"}
          </span>
        ) : (
          <span className="tnum mut">{days} days</span>
        )}
      </td>

      <td>
        <span className="tnum" style={{ fontWeight: 700, color: introTone }}>
          {intros}/{target}
        </span>
      </td>

      <td>
        {leftCycle === 0 ? (
          <span className="badge s-done"><span className="dot" />Done</span>
        ) : (
          <span className="tg" style={{ background: "var(--red-bg)", borderColor: "transparent", color: "var(--red)" }}>
            {leftCycle} left
          </span>
        )}
      </td>
    </tr>
  );
}

function Card({ label, value, sub, tone }: { label: string; value: number; sub: string; tone?: string }) {
  return (
    <div className="card">
      <div className="card-l">{label}</div>
      <div className={`card-n tnum${tone ? ` ${tone}` : ""}`}>{value.toLocaleString("en-US")}</div>
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
export function ClientHealthBiWeekly({ initial }: { initial: ClientHealthWeeklyData | null }) {
  return <ClientHealthFrame initial={initial}>{(data) => <BiWeeklyView data={data} />}</ClientHealthFrame>;
}
