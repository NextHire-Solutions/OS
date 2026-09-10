"use client";

import { useMemo, useState } from "react";

import {
  blankForm, formForClient, todayLocalISO, type ClientFormState,
} from "@/lib/tools/client-health/clientForm";
import { applyFilters, visibleTotal } from "@/lib/tools/client-health/filters";
import { deriveRows } from "@/lib/tools/client-health/summarize";
import type { DashboardClient } from "@/lib/tools/client-health/types";
import {
  biweeklyRows, sortBiWeekly, fmtDateUTC,
  type BwSortCol, type BiWeeklyRow,
} from "@/lib/tools/client-health/views";
import type { ClientHealthWeeklyData } from "@/lib/tools/client-health/weekly";
import { ClientModal } from "./client-modal";
import { EMPTY_FILTERS, FilterBar, type FilterBarState } from "./filter-bar";
import { ClientHealthFrame } from "./frame";
import { SyncButton } from "./sync-button";
import { ToastHost } from "./toast";

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
 * `now` is the SERVER's clock, sent with the data — not read during render and
 * not the week's Monday. Every value on this screen is a number of days until
 * a date, so measuring them from Monday would overstate every one of them by
 * however far into the week you happen to be reading.
 */

const PLAN_CLASS: Record<string, string> = {
  minimum: "plan-min",
  production: "plan-prod",
  partner: "plan-partner",
};

const COLUMNS: { col: BwSortCol; label: string; title: string }[] = [
  { col: "name", label: "Client", title: "Sort by client name" },
  { col: "tz", label: "Time Zone", title: "Sort by time zone" },
  { col: "billing", label: "Billing Date", title: "Sort by next billing date" },
  { col: "days", label: "Days Until Billing", title: "Sort by days until billing" },
  { col: "intros", label: "Introductions", title: "Introductions since the client's last billing day" },
  { col: "leftCycle", label: "Left This Cycle", title: "Introductions left in the current billing cycle" },
];

function BiWeeklyView({ data }: { data: ClientHealthWeeklyData }) {
  const now = useMemo(() => new Date(data.now), [data.now]);
  const [filters, setFilters] = useState<FilterBarState>(EMPTY_FILTERS);
  const [sort, setSort] = useState<{ col: BwSortCol; dir: "desc" | "asc" } | null>(null);
  const [modal, setModal] = useState<ClientFormState | null>(null);

  const openEdit = (c: DashboardClient) => setModal(formForClient(c));

  // Filtered with the Weekly view's own predicates, so "At Risk" means the
  // same thing on both screens.
  // The current week's rows, derived rather than sent — see weekly.ts.
  // The server's rows when it rendered this screen — `derive()` reads the
  // local clock, so deriving again would break hydration. See weekly.ts.
  const rowsAll = useMemo(
    () => data.rows ?? deriveRows(data.clients, data.weekKey),
    [data.rows, data.clients, data.weekKey],
  );

  const filtered = useMemo(
    () => applyFilters(rowsAll, { ...filters, sort: null }, now),
    [rowsAll, filters, now],
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

      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 18 }}>
        <SyncButton />
      </div>

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
              {rows.length !== visibleTotal(rowsAll) ? ` · showing ${rows.length}` : ""}
            </div>
          </div>
          <FilterBar value={filters} onChange={setFilters} now={now} />
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
                    No clients match {filters.search.trim() ? `“${filters.search.trim()}”` : "this filter"}.
                  </td>
                </tr>
              ) : (
                rows.map((r) => <Row key={r.client.id} row={r} onEdit={() => openEdit(r.client)} />)
              )}
            </tbody>
          </table>
        </div>
      </div>

      {modal ? (
        <ClientModal
          form={modal}
          instantly={data.instantlyCampaigns ?? []}
          bison={data.bisonCampaigns ?? []}
          onClose={() => setModal(null)}
        />
      ) : null}

      <ToastHost />
    </div>
  );
}

function Row({ row, onEdit }: { row: BiWeeklyRow; onEdit: () => void }) {
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

      <td>{tzShort ? <span className="tg">{tzShort}</span> : <SetLink onClick={onEdit}>Set</SetLink>}</td>

      <td className="tnum">
        {billing ? fmtDateUTC(billing) : <SetLink onClick={onEdit}>Set billing date</SetLink>}
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

/*
 * The "Set" affordance on an empty cell.
 *
 * A date this screen cannot derive is not a gap to report — it is a gap to
 * fill, and the person reading the row is the person who can fill it. So the
 * cell offers the edit modal rather than an em dash.
 */
function SetLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        border: 0, background: "none", padding: 0, font: "inherit", fontSize: 12.5,
        color: "var(--blue)", cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2,
      }}
    >
      {children}
    </button>
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
