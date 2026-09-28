"use client";

import { useMemo, useState } from "react";

import { Badge, Panel, Stat, Stats } from "@/components/ds";
import {
  blankForm, formForClient, todayLocalISO, type ClientFormState,
} from "@/lib/tools/client-health/clientForm";
import { applyFilters, visibleTotal } from "@/lib/tools/client-health/filters";
import { asOfForWeek, deriveRows, funnelRates, summarize } from "@/lib/tools/client-health/summarize";
import type { DashboardClient } from "@/lib/tools/client-health/types";
import {
  biweeklyRows, sortBiWeekly,
  type BwSortCol, type BiWeeklyRow,
} from "@/lib/tools/client-health/views";
import type { ClientHealthWeeklyData } from "@/lib/tools/client-health/weekly";

import { CarryBadge, fmtMDY, isBehind } from "./billing-cells";
import { ClientModal } from "./client-modal";
import { FilterBar } from "./filter-bar";
import { ClientHealthFrame } from "./frame";
import { ToastHost } from "./toast";
import { ClientHealthToolbar, useSelectedWeek, weekLabel } from "./toolbar";
import { SummaryCards } from "./summary-cards";
import { setFilters, useClientHealthView } from "./view-state";

/*
 * Client Health — Bi-Weekly.
 *
 * Answers one question: who bills next, and are they owed introductions when
 * they do. That is why the default sort is soonest-billing-first and why the
 * "Left This Cycle" column is loud — a client billing in two days who is four
 * introductions short is the whole point of the screen.
 *
 * Every figure is the billing snapshot at NOW (views.ts biweeklyRows, from
 * billing.ts): Introductions = delivered / required this cycle, carry
 * included; Left This Cycle = what is still owed ("Done" at 0); "—" when the
 * client has no target or no schedule. Port document §6.8.
 *
 * `now` is the SERVER's clock, sent with the data — never read during render.
 *
 * The week and the filters are shared with Weekly (view-state.ts): stepping
 * back a week narrows the "At Risk" / "Done" subset here exactly as it does
 * there — the billing arithmetic itself is always measured from today.
 */

const PLAN_TONE = { minimum: "outline", production: "brand", partner: "violet" } as const;

const COLUMNS: { col: BwSortCol; label: string; title: string }[] = [
  { col: "name", label: "Client", title: "Sort by client name" },
  { col: "tz", label: "Time Zone", title: "Sort by time zone" },
  { col: "billing", label: "Billing Date", title: "Sort by next billing date" },
  { col: "days", label: "Days Until Billing", title: "Sort by days until billing" },
  { col: "intros", label: "Introductions", title: "Delivered this billing cycle vs required, carry included" },
  { col: "leftCycle", label: "Left This Cycle", title: "Introductions still owed this billing cycle" },
];

function BiWeeklyView({ data }: { data: ClientHealthWeeklyData }) {
  const now = useMemo(() => new Date(data.now), [data.now]);
  const { filters } = useClientHealthView();
  const week = useSelectedWeek(data);
  const { key, isCurrent } = week;
  const [sort, setSort] = useState<{ col: BwSortCol; dir: "desc" | "asc" } | null>(null);
  const [modal, setModal] = useState<ClientFormState | null>(null);

  const openAdd = () => setModal(blankForm(todayLocalISO()));
  const openEdit = (c: DashboardClient) => setModal(formForClient(c));

  /*
   * The Weekly rows for the selected week — they drive the filters and the 24
   * cards, so "At Risk" means the same thing on both screens and for the same
   * week. The server's rows on the current week, derived here otherwise.
   */
  const rowsAll = useMemo(() => {
    if (isCurrent && data.rows) return data.rows;
    const monday = new Date(`${key}T00:00:00Z`);
    return deriveRows(data.clients, key, asOfForWeek(monday, isCurrent, now), monday);
  }, [data.rows, data.clients, key, isCurrent, now]);

  const filtered = useMemo(() => applyFilters(rowsAll, filters, now), [rowsAll, filters, now]);

  const rows = useMemo(
    () => sortBiWeekly(biweeklyRows(filtered.map((r) => r.client), now), sort),
    [filtered, now, sort],
  );
  const summary = useMemo(
    () => (isCurrent && data.summary ? data.summary : summarize(rowsAll, key)),
    [isCurrent, data.summary, rowsAll, key],
  );
  const lifetimeRates = funnelRates(summary.lifetime);
  const weekRates = funnelRates(summary.week);

  // 1st click → desc, 2nd → asc, 3rd → back to the default order.
  const cycleSort = (col: BwSortCol) =>
    setSort((cur) => (cur?.col !== col ? { col, dir: "desc" } : cur.dir === "desc" ? { col, dir: "asc" } : null));

  const dueSoon = rows.filter((r) => r.days !== null && r.days <= 3).length;
  const short = rows.filter((r) => (r.leftCycle ?? 0) > 0).length;
  const unset = rows.filter((r) => r.billing === null).length;

  return (
    <div className="ds-page">
      {data.source === "seed" ? (
        <p className="ds-note">
          <b>Showing sample data.</b> Client Health&rsquo;s database is not reachable
          {data.error ? ` — ${data.error}` : ""}.
        </p>
      ) : null}

      <ClientHealthToolbar title="Bi-Weekly" description="who bills next, and what they are still owed" week={week} onAdd={openAdd} sync={data.sync} now={now} />
      <SummaryCards s={summary} lifetime={lifetimeRates} week={weekRates} isCurrent={isCurrent} weekKey={key} />

      <Stats>
        <Stat label="Clients" value={rows.length} sub="in this cycle view" />
        <Stat label="Billing in ≤3 days" value={dueSoon} sub="invoice imminent" tone={dueSoon > 0 ? "red" : undefined} />
        <Stat label="Short of Cycle Target" value={short} sub="introductions still owed" tone={short > 0 ? "red" : "green"} />
        <Stat label="No Billing Date" value={unset} sub="anchor not set" tone={unset > 0 ? "red" : undefined} />
      </Stats>

      <Panel
        title="Billing Cycles"
        description={
          <>
            Introductions this billing cycle against what is due, carry included
            {isCurrent ? "" : ` · status filters as of week of ${weekLabel(key)}`}
            {rows.length !== visibleTotal(rowsAll) ? ` · showing ${rows.length}` : ""}
          </>
        }
        actions={<FilterBar value={filters} onChange={setFilters} now={now} />}
        flush
      >
        <div className="ds-table-scroll">
          <table className="ds-table" style={{ minWidth: 900 }}>
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
                  <td colSpan={COLUMNS.length} className="ds-none" style={{ padding: "34px 16px", textAlign: "center" }}>
                    No clients match {filters.search.trim() ? `“${filters.search.trim()}”` : "this filter"}.
                  </td>
                </tr>
              ) : (
                rows.map((r) => <Row key={r.client.id} row={r} onEdit={() => openEdit(r.client)} />)
              )}
            </tbody>
          </table>
        </div>
      </Panel>

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
  const { client: c, billing, days, intros, required, leftCycle, snap, tzShort } = row;

  // The tool's three-way colouring: met, at least half, below half.
  const tone =
    required === null ? undefined
    : leftCycle === 0 ? "tone-green"
    : (snap?.cycle.carryIn ?? 0) > 0 ? "tone-red"
    : intros >= Math.ceil(required / 2) ? "tone-amber"
    : "tone-red";

  return (
    <tr className={isBehind(snap) ? "has-carry" : undefined}>
      <td>
        <span className="ds-primary">{c.name}</span>
        <span className="ds-sub">
          <Badge tone={PLAN_TONE[c.plan as keyof typeof PLAN_TONE] ?? "outline"}>
            {c.plan.charAt(0).toUpperCase() + c.plan.slice(1)}
          </Badge>
        </span>
      </td>

      <td>{tzShort ? <Badge tone="outline">{tzShort}</Badge> : <button type="button" className="ds-link" onClick={onEdit}>Set</button>}</td>

      <td className="num">
        {billing ? fmtMDY(billing) : <button type="button" className="ds-link" onClick={onEdit}>Set billing date</button>}
      </td>

      <td>
        {days === null ? (
          <span className="ds-none">—</span>
        ) : days <= 3 ? (
          <Badge tone="red">{days} day{days === 1 ? "" : "s"}</Badge>
        ) : (
          <span className="num">{days} days</span>
        )}
      </td>

      <td>
        {required === null ? (
          <span className="ds-none" title={billing ? "No monthly target set" : "No billing schedule"}>—</span>
        ) : (
          <span className="ds-ib">
            <b className={tone}>{intros} / {required}</b>
            {snap ? <CarryBadge cycle={snap.cycle} /> : null}
          </span>
        )}
      </td>

      <td>
        {leftCycle === null ? (
          <span className="ds-none">—</span>
        ) : leftCycle === 0 ? (
          <Badge tone="green" dot>Done</Badge>
        ) : (
          <Badge tone="red">{leftCycle} left</Badge>
        )}
      </td>
    </tr>
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
