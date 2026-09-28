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
  successRows, sortSuccess, scoreTone, humanizeAgo, fmtDateShort,
  type CsSortCol, type SuccessRow,
} from "@/lib/tools/client-health/views";
import type { ClientHealthWeeklyData } from "@/lib/tools/client-health/weekly";
import { ClientModal } from "./client-modal";
import { FilterBar } from "./filter-bar";
import { ClientHealthFrame } from "./frame";
import { ToastHost } from "./toast";
import { ClientHealthToolbar, useSelectedWeek, weekLabel } from "./toolbar";
import { SummaryCards } from "./summary-cards";
import { setFilters, useClientHealthView } from "./view-state";

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

const PLAN_TONE = { minimum: "outline", production: "brand", partner: "violet" } as const;

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

const SCORE_TONE = { good: "green", mid: "amber", low: "red" } as const;

function SuccessView({ data }: { data: ClientHealthWeeklyData }) {
  /*
   * The SERVER's clock, sent with the data.
   *
   * Every "how long ago" on this screen is measured from it. The week's Monday
   * would be up to six days stale, which on a column called "Portal Updated"
   * is the difference between a portal worked yesterday and one nobody has
   * touched in a week.
   */
  const now = useMemo(() => new Date(data.now), [data.now]);
  // Shared with Weekly and Bi-Weekly — the tool has one header and one
  // filtered list for all three views. See view-state.ts.
  const { filters } = useClientHealthView();
  const week = useSelectedWeek(data);
  const { key, isCurrent } = week;
  const [sort, setSort] = useState<{ col: CsSortCol; dir: "desc" | "asc" } | null>(null);
  const [modal, setModal] = useState<ClientFormState | null>(null);

  const openAdd = () => setModal(blankForm(todayLocalISO()));
  const openEdit = (c: DashboardClient) => setModal(formForClient(c));

  /*
   * The selected week's Weekly rows — they drive the filters and the 24 cards,
   * so "At Risk" means the same on every tab. The server's rows on the current
   * week; otherwise derived here with the billing snapshot as of that week.
   */
  const rowsAll = useMemo(() => {
    if (isCurrent && data.rows) return data.rows;
    const monday = new Date(`${key}T00:00:00Z`);
    return deriveRows(data.clients, key, asOfForWeek(monday, isCurrent, now), monday);
  }, [data.rows, data.clients, key, isCurrent, now]);

  const filtered = useMemo(
    () => applyFilters(rowsAll, filters, now),
    [rowsAll, filters, now],
  );

  const rows = useMemo(
    () => sortSuccess(successRows(filtered.map((r) => r.client), now), sort),
    [filtered, now, sort],
  );
  const summary = useMemo(
    () => (isCurrent && data.summary ? data.summary : summarize(rowsAll, key)),
    [isCurrent, data.summary, rowsAll, key],
  );
  const lifetimeRates = funnelRates(summary.lifetime);
  const weekRates = funnelRates(summary.week);

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
    <div className="ds-page">
      {data.source === "seed" ? (
        <p className="ds-note">
          <b>Showing sample data.</b> Client Health&rsquo;s database is not reachable
          {data.error ? ` — ${data.error}` : ""}.
        </p>
      ) : null}

      <ClientHealthToolbar title="Client Success" description="score, stagnant intros and portal activity" week={week} onAdd={openAdd} sync={data.sync} now={now} />

      <SummaryCards s={summary} lifetime={lifetimeRates} week={weekRates} isCurrent={isCurrent} weekKey={key} />

      <section className="ds-band" aria-label="Client Success">
        <div className="ds-band-l">Client Success</div>
        <Stats min={150}>
          <Stat label="Clients" value={rows.length} sub="in this view" />
          <Stat
            label="Avg Score"
            value={avgScore === null ? <span style={{ color: "var(--ds-faint)" }}>—</span> : avgScore.toFixed(1)}
            sub={scored.length === rows.length ? "eight-week delivery" : `across ${scored.length} scored`}
            tone={avgScore === null ? undefined : avgScore >= 8 ? "green" : avgScore >= 5 ? "amber" : "red"}
          />
          <Stat label="Scoring Below 5" value={lowScoring} sub="need attention" tone={lowScoring > 0 ? "red" : "green"} />
          <Stat label="Stagnant Intros" value={stagnant} sub="never touched since arriving" tone={stagnant > 0 ? "red" : "green"} />
          <Stat label="Portals Quiet 14d+" value={stale} sub="no lead activity" tone={stale > 0 ? "red" : "green"} />
          <Stat label="Hired" value={hires} sub="all time, across clients" tone="green" />
        </Stats>
      </section>

      <Panel
        title="Client Success"
        description={
          <>
            Account health — portal activity, stagnant introductions, hires
            {isCurrent ? "" : ` · status filters as of week of ${weekLabel(key)}`}
            {rows.length !== visibleTotal(rowsAll) ? ` · showing ${rows.length}` : ""}
          </>
        }
        actions={<FilterBar value={filters} onChange={setFilters} now={now} />}
        flush
      >
        <div className="ds-table-scroll">
          <table className="ds-table" style={{ minWidth: 1180 }}>
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
                rows.map((r) => (
                  <Row key={r.client.id} row={r} now={now.getTime()} onEdit={() => openEdit(r.client)} />
                ))
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

function Row({ row, now, onEdit }: { row: SuccessRow; now: number; onEdit: () => void }) {
  const { client: c, hiredTotal, lastHireAt, score, tzShort } = row;
  const none = <span className="ds-none">—</span>;

  return (
    <tr>
      <td><span className="ds-primary">{c.name}</span></td>

      <td>
        <Badge tone={PLAN_TONE[c.plan as keyof typeof PLAN_TONE] ?? "outline"}>
          {c.plan.charAt(0).toUpperCase() + c.plan.slice(1)}
        </Badge>
      </td>

      <td className="num">
        {score === null ? (
          <span className="ds-none" title="Too few weeks of history to score yet">—</span>
        ) : (
          <b className={`tone-${SCORE_TONE[scoreTone(score)]}`}>{score.toFixed(1)}</b>
        )}
      </td>

      <td>{tzShort ? <Badge tone="outline">{tzShort}</Badge> : <button type="button" className="ds-link" onClick={onEdit}>Set</button>}</td>

      <td className="num">{c.start_date ? fmtDateShort(c.start_date) : <button type="button" className="ds-link" onClick={onEdit}>Set date</button>}</td>

      <td>{c.last_lead_activity_at ? humanizeAgo(c.last_lead_activity_at, now) : none}</td>

      <td>
        {c.stagnant_intros_count > 0
          ? <Badge tone="red">{c.stagnant_intros_count}</Badge>
          : <span className="num ds-none">0</span>}
      </td>

      <td className="num">{hiredTotal > 0 ? hiredTotal : none}</td>

      <td>{lastHireAt ? humanizeAgo(lastHireAt, now) : none}</td>

      <td className="num">{c.dnc_count > 0 ? c.dnc_count.toLocaleString("en-US") : none}</td>

      <td className="num">{c.agents_count > 0 ? c.agents_count.toLocaleString("en-US") : none}</td>
    </tr>
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
