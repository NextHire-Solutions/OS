"use client";

import { useMemo, useState } from "react";

import {
  activeCampaigns, campaignProgress, campaignsLabel, clientFunnel,
} from "@/lib/tools/client-health/campaigns";
import {
  blankForm, formForClient, todayLocalISO, type ClientFormState,
} from "@/lib/tools/client-health/clientForm";
import {
  addDays, daysUntil, formatWeek, getMondayOf,
  lastBillingDate, nextBillingDate, todayInET, weekKey,
} from "@/lib/tools/client-health/derive";
import { applyFilters, visibleTotal } from "@/lib/tools/client-health/filters";
import {
  deriveRows, funnelRates, summarize,
  type FunnelTotals, type WeeklyRow,
} from "@/lib/tools/client-health/summarize";
import { sortWeekly, type Sort, type SortCol } from "@/lib/tools/client-health/sorting";
import { TZ_SHORT_BY_VALUE, type DashboardClient } from "@/lib/tools/client-health/types";
import { fmtDateUTC } from "@/lib/tools/client-health/views";
import type { ClientHealthWeeklyData } from "@/lib/tools/client-health/weekly";

import { CampaignsPopup } from "./campaigns-popup";
import { ClientModal } from "./client-modal";
import { EMPTY_FILTERS, FilterBar, type FilterBarState } from "./filter-bar";
import { ClientHealthFrame } from "./frame";
import { removeClient, setHidden, setPaused } from "./mutations";
import { SyncButton } from "./sync-button";
import { ToastHost } from "./toast";

/*
 * Client Health — Weekly.
 *
 * The design file's markup: its cards, its table, its class names. The numbers
 * come from the tool's own derive(), summarize() and campaign helpers, so this
 * screen and the live app cannot disagree.
 *
 * Every control does what the live tool's does — the filters, the nineteen
 * columns, the campaigns popup, the client modal, the row actions. A pill
 * labelled "At Risk" that selects a slightly different set than the tool's is
 * worse than no pill at all, because the reader would trust it.
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

const n = (v: number) => v.toLocaleString("en-US");

/** A percentage, or an em dash when its denominator was zero. */
const pct = (v: number | null, digits = 1) => (v === null ? "—" : `${v.toFixed(digits)}%`);

/** "1,204 / 96,331" — the numerator and denominator behind a rate. */
const ratio = (a: number, b: number) => `${n(a)} / ${n(b)}`;

function WeeklyView({ data }: { data: ClientHealthWeeklyData }) {
  const [offset, setOffset] = useState(0);
  const [filters, setFilters] = useState<FilterBarState>(EMPTY_FILTERS);
  const [sort, setSort] = useState<Sort | null>(null);
  /** Which campaign each row's dropdown is showing. Absent means the roll-up. */
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [modal, setModal] = useState<ClientFormState | null>(null);
  const [popup, setPopup] = useState<string | null>(null);

  // The week being shown, measured from the server's own answer so offset 0
  // reproduces the server render exactly.
  const key = offset === 0 ? data.weekKey : weekKey(addDays(`${data.weekKey}T00:00:00`, offset * 7));
  const isCurrent = offset === 0;

  /*
   * The server's rows win on the first render, because `derive()` reads the
   * local clock — deriving again here would compute "2d ago" against the
   * server's "3d ago" and break hydration. Once the reader changes week there
   * is no server render to match, so deriving is safe.
   *
   * `data.rows` is also dropped the moment anything is edited (see load.ts),
   * which is what keeps the headline numbers honest after a pause.
   */
  const rows = useMemo(
    () => (offset === 0 && data.rows ? data.rows : deriveRows(data.clients, key)),
    [data.rows, data.clients, key, offset],
  );
  const summary = useMemo(
    () => (offset === 0 && data.summary ? data.summary : summarize(rows, key)),
    [data.summary, rows, key, offset],
  );

  /*
   * The SERVER's clock — not the week's Monday, and not the browser's.
   *
   * "Daily Emails Sent" only counts when the stored date is today, the billing
   * sort needs the next date from now, and the billing-window filter needs
   * both. Passing the Monday made every daily figure compare as zero, so that
   * column quietly did not sort at all.
   */
  const now = useMemo(() => new Date(data.now), [data.now]);
  const todayET = useMemo(() => todayInET(now), [now]);

  /*
   * Filter first, then sort. The tool's own order, and the cheaper one — the
   * sort only ever runs over what survived the filter.
   */
  const visible = useMemo(
    () => sortWeekly(applyFilters(rows, { ...filters, sort: null }, now), sort, now),
    [rows, filters, sort, now],
  );

  const s = summary;
  const lifetime = funnelRates(s.lifetime);
  const week = funnelRates(s.week);

  const toggleSort = (col: SortCol) =>
    setSort((cur) =>
      cur?.col !== col ? { col, dir: "desc" } : cur.dir === "desc" ? { col, dir: "asc" } : null,
    );

  const openAdd = () => setModal(blankForm(todayLocalISO()));
  const openEdit = (c: DashboardClient) => setModal(formForClient(c));

  const popupClient = popup ? data.clients.find((c) => c.id === popup) ?? null : null;

  return (
    <div className="wrap">
      {data.source === "seed" ? (
        <div className="anno">
          <b>Showing sample data.</b> Client Health&rsquo;s database is not reachable
          {data.error ? ` — ${data.error}` : ""}.
        </div>
      ) : null}

      {/* A past week is a record, not a dashboard. Said plainly, because the
          rest of the screen looks exactly the same and the numbers do not. */}
      {!isCurrent ? (
        <div className="anno">
          <b>Viewing a past week.</b> These figures are a record of that week — the row
          actions and the sync still act on today.
        </div>
      ) : null}

      <div
        style={{
          display: "flex", alignItems: "center", justifyContent: "flex-end",
          gap: 10, marginBottom: 18, flexWrap: "wrap",
        }}
      >
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

        {!isCurrent ? (
          <button className="btn" onClick={() => setOffset(0)} title="Back to the current week">
            Today
          </button>
        ) : null}

        <button className="btn" onClick={openAdd}>+ Add Client</button>
        <SyncButton />
      </div>

      <CardGroup label="Status">
        <Card label="Clients" value={s.total} sub="active" />
        <Card label="At Risk" value={s.risk} sub="below half target" tone="n-risk" />
        <Card label="On Track" value={s.ok} sub="meeting target this week" tone="n-ok" />
        <Card label="Done" value={s.done} sub="met weekly target" tone="n-done" />
        <Card label="Client Paused" value={s.clientPaused} sub="manually paused" />
        <Card
          label="By Plan"
          value={`${s.plans.minimum} · ${s.plans.production} · ${s.plans.partner}`}
          sub="min · prod · partner"
          size={26}
        />
      </CardGroup>

      <CardGroup label="Performance">
        <Card label="Weekly Intros Sent" value={s.intros} sub="across all clients" tone="n-intros" />
        <Card label="Weekly Target" value={s.target} sub="intros / week" />
        <Card label="Weekly Completion" value={`${s.completionPct}%`} sub="intros vs weekly target" tone="n-green" />
        <Card label="Monthly Intros Sent" value={s.monthlyIntros} sub="this monthly cycle" tone="n-intros" />
        <Card
          label="Monthly Target"
          value={s.monthlyTarget}
          sub={s.monthlyTarget > 0 ? "intros / month" : "no client has one set"}
        />
        <Card
          label="Monthly Completion"
          value={s.monthlyTarget > 0 ? `${s.monthlyCompletionPct}%` : null}
          sub="intros vs monthly target"
          tone="n-green"
        />
      </CardGroup>

      {/*
        Two funnels, deliberately side by side.
        Lifetime answers "does this motion work"; This Week answers "is it
        working now". One without the other is how a quarter of decline hides
        behind a good all-time average.
      */}
      <FunnelGroup
        label="Funnel — Lifetime"
        totals={s.lifetime}
        rates={lifetime}
        emailsSub="all campaigns"
      />
      <FunnelGroup
        label={isCurrent ? "Funnel — This Week" : `Funnel — Week of ${formatWeek(getMondayOf(`${key}T00:00:00`))}`}
        totals={s.week}
        rates={week}
        emailsSub="this week"
      />

      <div className="tbl-wrap">
        <div className="tbl-head">
          <div>
            <div className="tbl-title">Client Health</div>
            <div className="tbl-sub">
              {isCurrent
                ? "Live data from Instantly · Bison · MasterInbox"
                : `Week of ${formatWeek(getMondayOf(`${key}T00:00:00`))}`}
              {visible.length !== visibleTotal(rows) ? ` · showing ${visible.length}` : ""}
            </div>
          </div>
          <FilterBar value={filters} onChange={setFilters} now={now} />
        </div>

        <div className="tbl-scroll">
          <table style={{ minWidth: 2180 }}>
            <thead>
              <tr>
                <SortableTh col="campaigns" sort={sort} onClick={toggleSort} title="Sort by number of active campaigns">Client</SortableTh>
                <SortableTh col="tz" sort={sort} onClick={toggleSort}>Time Zone</SortableTh>
                <SortableTh col="monthly" sort={sort} onClick={toggleSort} title="Intros this monthly cycle, which starts on the billing anchor day">Monthly</SortableTh>
                <SortableTh col="lastIntro" sort={sort} onClick={toggleSort}>Last Intro</SortableTh>
                <SortableTh col="lastBilling" sort={sort} onClick={toggleSort} title="Sort by the most recent billing date">Last Billing</SortableTh>
                <SortableTh col="billing" sort={sort} onClick={toggleSort}>Next Billing</SortableTh>
                <SortableTh col="billingDays" sort={sort} onClick={toggleSort}>Days Until Billing</SortableTh>
                <SortableTh col="today" sort={sort} onClick={toggleSort} title="Emails sent today, Eastern">Daily Emails Sent</SortableTh>
                <SortableTh col="intros" sort={sort} onClick={toggleSort}>Intros This Week</SortableTh>
                <SortableTh col="conv" sort={sort} onClick={toggleSort} title="Introductions per 1,000 emails">Conv. Rate</SortableTh>
                <SortableTh col="leftWeek" sort={sort} onClick={toggleSort}>Left This Week</SortableTh>
                <SortableTh col="progress" sort={sort} onClick={toggleSort}>Campaign Progress</SortableTh>
                <th>Status</th>
                <SortableTh col="interested" sort={sort} onClick={toggleSort} title="All-time Interested count">Interested</SortableTh>
                <SortableTh col="converted" sort={sort} onClick={toggleSort} title="All-time Interested → Introduction count">Converted</SortableTh>
                <SortableTh col="convRate" sort={sort} onClick={toggleSort} title="Interested → Introduction conversion rate">Int → Intro</SortableTh>
                <th>Plan</th>
                <th>Portal</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={19} style={{ padding: "34px 16px", textAlign: "center", color: "var(--muted)" }}>
                    {rows.length === 0 ? (
                      <>
                        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--ink)", marginBottom: 6 }}>
                          No clients yet
                        </div>
                        <div style={{ marginBottom: 14 }}>Add your first client to start tracking.</div>
                        <button className="btn btn-pri" onClick={openAdd}>+ Add Client</button>
                      </>
                    ) : (
                      <>No clients match {filters.search.trim() ? `“${filters.search.trim()}”` : "this filter"}.</>
                    )}
                  </td>
                </tr>
              ) : (
                visible.map((row) => (
                  <Row
                    key={row.client.id}
                    row={row}
                    now={now}
                    todayET={todayET}
                    convAvg={s.avgConv ?? 0}
                    picked={picked[row.client.id]}
                    onPick={(id) => setPicked((p) => ({ ...p, [row.client.id]: id }))}
                    onEdit={() => openEdit(row.client)}
                    onCampaigns={() => setPopup(row.client.id)}
                  />
                ))
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

      {popupClient ? <CampaignsPopup client={popupClient} onClose={() => setPopup(null)} /> : null}

      <ToastHost />
    </div>
  );
}

function SortableTh({
  col, sort, onClick, title, children,
}: {
  col: SortCol;
  sort: Sort | null;
  onClick: (col: SortCol) => void;
  title?: string;
  children: React.ReactNode;
}) {
  const active = sort?.col === col;
  return (
    <th
      onClick={() => onClick(col)}
      style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
      title={`${title ?? "Sort"} — click to cycle descending, ascending, then reset`}
      aria-sort={active ? (sort.dir === "desc" ? "descending" : "ascending") : "none"}
    >
      {children}
      <span style={{ opacity: active ? 1 : 0.28, marginLeft: 5 }}>
        {!active ? "↕" : sort.dir === "desc" ? "↓" : "↑"}
      </span>
    </th>
  );
}

function Row({
  row, now, todayET, convAvg, picked, onPick, onEdit, onCampaigns,
}: {
  row: WeeklyRow;
  now: Date;
  todayET: string;
  convAvg: number;
  picked: string | undefined;
  onPick: (id: string) => void;
  onEdit: () => void;
  onCampaigns: () => void;
}) {
  const { client: c, derived: d } = row;

  /*
   * The billing dates.
   *
   * `now` comes from the parent, seeded from the server — NOT from
   * `new Date()`. Reading the clock here would be the same hydration bug that
   * has already shipped three times in this workspace.
   */
  const anchor = c.billing_anchor_date ?? c.start_date;
  const lastBilling = lastBillingDate(anchor, c.billing_interval, now, c.billing_interval_days);
  const billing = nextBillingDate(anchor, c.billing_interval, now, c.billing_interval_days);
  const billingDays = billing ? daysUntil(billing, now) : null;

  const status = STATUS[d.status];
  const active = activeCampaigns(c);
  const progress = campaignProgress(active, picked);
  const funnel = clientFunnel(c);
  const label = campaignsLabel(c);

  /*
   * Today's emails only count when the stored date IS today, in Eastern.
   *
   * Without the check the row shows yesterday's number between midnight and
   * the next sync tick — a figure that is not wrong so much as answering a
   * different question than the column asks.
   */
  const todayEmails = c.emails_today_date === todayET ? c.emails_today : 0;

  return (
    <tr style={c.hidden || c.client_paused ? { opacity: 0.62 } : undefined}>
      <td>
        <div className="cname" style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
          {c.name}
          {/* The deep link into Corofy's portal for this client. Present only
              when the sync has seen a portal — a link to nothing is worse
              than no link. */}
          {c.portal_url ? (
            <a
              href={c.portal_url}
              target="_blank"
              rel="noopener noreferrer"
              title="Open this client’s portal in Corofy"
              aria-label={`Open ${c.name}’s portal in Corofy`}
              style={{ color: "var(--blue)", textDecoration: "none", fontSize: 12, fontWeight: 700 }}
            >
              ↗
            </a>
          ) : null}
          {c.hidden ? <Tag text="Churned" tone="red" /> : null}
          {!c.hidden && c.client_paused ? <Tag text="Client Paused" tone="amber" /> : null}
        </div>

        {c.start_date ? <div className="csince">Since {formatDate(c.start_date)}</div> : null}

        {/* The campaign line. Clickable only when there is something to open —
            a button that opens an empty dialog is a broken button. */}
        {active.length > 0 ? (
          <button
            className="cmeta"
            onClick={onCampaigns}
            title="View this client’s campaigns"
            aria-label={`View ${label} for ${c.name}`}
            style={{ cursor: "pointer", font: "inherit" }}
          >
            {label} ›
          </button>
        ) : (
          <span
            className="cmeta"
            style={{ borderStyle: "dashed", opacity: 0.8 }}
            title={
              label === "Campaign Paused"
                ? "Every linked campaign is paused or finished"
                : "No campaign has ever launched for this client"
            }
          >
            {label}
          </span>
        )}
      </td>

      <td>
        {c.time_zone ? (
          <span className="tg" title={c.time_zone}>
            {TZ_SHORT_BY_VALUE[c.time_zone] ?? c.time_zone}
          </span>
        ) : (
          <SetLink onClick={onEdit}>Set</SetLink>
        )}
      </td>

      {/*
        Monthly progress against the client's own monthly target. An em dash
        rather than "0/0" when no target is set: 0/0 reads as complete.
        Thresholds are the tool's — met, at least half, below half.
      */}
      <td>
        {c.monthly_target === 0 ? (
          <span className="api-none" title="No monthly target set for this client">—</span>
        ) : (
          <span
            className="tnum"
            style={{
              fontWeight: 700,
              color:
                c.intros_this_month >= c.monthly_target ? "var(--green)"
                : c.intros_this_month >= Math.ceil(c.monthly_target / 2) ? "var(--yellow)"
                : "var(--red)",
            }}
          >
            {c.intros_this_month}/{c.monthly_target}
          </span>
        )}
      </td>

      <td>
        {d.daysSince === null ? (
          <span style={{ fontSize: 13, color: "var(--muted)" }}>No data</span>
        ) : d.daysSince <= 1 ? (
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--green)" }}>
            {d.daysSince === 0 ? "Today" : "Yesterday"}
          </span>
        ) : d.daysSince <= 5 ? (
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--green)" }}>{d.daysSince}d ago</span>
        ) : (
          <span
            className="tg"
            style={{ background: "var(--yellow-bg)", borderColor: "transparent", color: "var(--yellow)" }}
          >
            {d.daysSince}d ago
          </span>
        )}
      </td>

      {/* The last billing day. Null until a client has billed once — a new
          client has not "billed longest ago", it has not billed at all. */}
      <td className="tnum mut">
        {lastBilling ? fmtDateUTC(lastBilling) : <span className="api-none">—</span>}
      </td>

      {/* The next billing date, using the tool's own nextBillingDate. An anchor
          is the FIRST billing day, not the next one, so it rolls forward a
          whole cycle — reading it as the next date would show a date in the
          past for every long-standing client. */}
      <td className="tnum mut">
        {billing ? fmtDateUTC(billing) : <SetLink onClick={onEdit}>Set billing date</SetLink>}
      </td>

      {/* Days until billing. Three days or fewer is the number somebody acts
          on, so it is the only one coloured. */}
      <td>
        {billingDays === null ? (
          <span className="api-none">—</span>
        ) : billingDays <= 3 ? (
          <span className="tg" style={{ background: "var(--red-bg)", borderColor: "transparent", color: "var(--red)" }}>
            {billingDays} day{billingDays === 1 ? "" : "s"}
          </span>
        ) : (
          <span className="tnum mut">{billingDays} days</span>
        )}
      </td>

      <td>
        {todayEmails > 0
          ? <span className="api-num tnum">{n(todayEmails)}</span>
          : <span className="api-none">—</span>}
      </td>

      <td>
        <input
          className={`mi tnum${d.status === "risk" ? " risk" : d.metTarget ? " ok" : ""}`}
          value={d.intros}
          readOnly
          aria-label={`Introductions this week for ${c.name}`}
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
              // The tool's own rule: above 3 is good; 1–3 is acceptable only
              // if it also beats the dashboard average; everything else is not.
              color:
                d.convPct > 3 ? "var(--green)"
                : d.convPct >= 1 && d.convPct >= convAvg ? "var(--yellow)"
                : "var(--red)",
            }}
          >
            {d.convPct.toFixed(1)}%
          </span>
        )}
      </td>

      {/* A client with no weekly target has nothing left to do this week —
          which is not the same as having finished. */}
      <td>
        {c.weekly_target === 0 ? (
          <span className="api-none" title="No weekly target set for this client">—</span>
        ) : d.metTarget ? (
          <span className="tnum" style={{ color: "var(--muted)" }}>0</span>
        ) : (
          <span className="tg" style={{ background: "var(--red-bg)", borderColor: "transparent", color: "var(--red)" }}>
            {d.leftThisWeek} left
          </span>
        )}
      </td>

      {/*
        Campaign progress across the RUNNING campaigns only, with a picker when
        there is more than one. The roll-up is weighted — sum of completed over
        sum of leads — so a 40-lead campaign at 100% cannot flatter a
        4,000-lead one at 10%.
      */}
      <td style={{ minWidth: 190 }}>
        {active.length === 0 ? (
          <span className="api-none">—</span>
        ) : (
          <>
            {active.length > 1 ? (
              <select
                className="inp"
                value={picked ?? "__avg__"}
                onChange={(e) => onPick(e.target.value)}
                aria-label={`Campaign shown for ${c.name}`}
                style={{ width: "100%", marginBottom: 6, padding: "5px 8px", fontSize: 12, cursor: "pointer" }}
              >
                <option value="__avg__">All active (avg)</option>
                {active.map((camp) => (
                  <option key={camp.id} value={camp.id}>{camp.name}</option>
                ))}
              </select>
            ) : null}
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5 }}>
              <span className="tnum mut">{n(progress.completedLeads)} / {n(progress.totalLeads)}</span>
              <span className="tnum" style={{ fontWeight: 700 }}>{Math.round(progress.pct)}%</span>
            </div>
            <div className="track"><i style={{ width: `${Math.min(100, progress.pct)}%` }} /></div>
            <div style={{ marginTop: 5, fontSize: 12, color: "var(--muted)" }}>
              <span className="tnum">{n(progress.sent)}</span> sent · Running
            </div>
          </>
        )}
      </td>

      <td>
        <span className={`badge ${status.cls}`}>
          <span className="dot" />
          {status.label}
        </span>
      </td>

      <td><input className="mi tnum" value={funnel.interested} readOnly aria-label={`Interested, all time, for ${c.name}`} /></td>
      <td><input className="mi tnum" value={funnel.converted} readOnly aria-label={`Converted, all time, for ${c.name}`} /></td>

      <td>
        {funnel.ratePct === null ? (
          <span className="api-none" title="Nobody has entered the funnel yet">—</span>
        ) : (
          <span className="api-num tnum">{pct(funnel.ratePct)}</span>
        )}
      </td>

      <td>
        <span className={`plan ${PLAN_CLASS[c.plan] ?? "plan-min"}`}>
          {c.plan.charAt(0).toUpperCase() + c.plan.slice(1)}
        </span>
      </td>

      <td
        className={c.portal_active ? "" : "mut"}
        style={c.portal_active ? { color: "var(--green)", fontWeight: 700 } : undefined}
        title={c.portal_active ? "Portal active in Corofy" : "Not in Corofy portals, or the portal is disabled"}
      >
        {c.portal_active ? "✓" : "—"}
      </td>

      <td>
        <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
          <IconButton label={`Edit ${c.name}`} onClick={onEdit}>Edit</IconButton>
          <IconButton
            label={c.client_paused ? `Resume ${c.name}` : `Pause ${c.name}`}
            onClick={() => void setPaused(c, !c.client_paused)}
          >
            {c.client_paused ? "Resume" : "Pause"}
          </IconButton>
          <IconButton
            label={c.hidden ? `Restore ${c.name}` : `Mark ${c.name} churned`}
            onClick={() => void setHidden(c, !c.hidden)}
          >
            {c.hidden ? "Restore" : "Churn"}
          </IconButton>
          <IconButton label={`Delete ${c.name}`} danger onClick={() => void removeClient(c)}>
            Delete
          </IconButton>
        </div>
      </td>
    </tr>
  );
}

/** A small text button in a row — the tool's emoji icons, said in words. */
function IconButton({
  label, danger, onClick, children,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      style={{
        border: "1px solid var(--line)",
        background: "var(--surface)",
        borderRadius: 8,
        padding: "4px 8px",
        font: "inherit",
        fontSize: 11.5,
        fontWeight: 600,
        cursor: "pointer",
        whiteSpace: "nowrap",
        color: danger ? "var(--red)" : "var(--muted)",
      }}
    >
      {children}
    </button>
  );
}

/** The "Set" affordance on an empty cell — opens the edit modal. */
function SetLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        border: 0,
        background: "none",
        padding: 0,
        font: "inherit",
        fontSize: 12.5,
        color: "var(--blue)",
        cursor: "pointer",
        textDecoration: "underline",
        textUnderlineOffset: 2,
      }}
    >
      {children}
    </button>
  );
}

function Tag({ text, tone }: { text: string; tone: "red" | "amber" }) {
  return (
    <span
      style={{
        padding: "2px 7px",
        borderRadius: 7,
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: ".02em",
        color: tone === "red" ? "var(--red)" : "var(--yellow)",
        background: tone === "red" ? "var(--red-bg)" : "var(--yellow-bg)",
      }}
    >
      {text}
    </span>
  );
}

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

/** One labelled band of six cards — the tool's own grouping. */
function CardGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 20 }}>
      <div className="grp-h" style={{ marginBottom: 10 }}>{label}</div>
      <div className="cards" style={{ gridTemplateColumns: "repeat(6, 1fr)", marginBottom: 0 }}>
        {children}
      </div>
    </section>
  );
}

/**
 * One funnel band.
 *
 * Both funnels have identical shape, so they are one component — which is also
 * what guarantees the two read the same way. Each rate card carries its own
 * numerator and denominator as its subtitle, because a percentage without them
 * cannot be checked and a wrong one looks exactly like a right one.
 */
function FunnelGroup({
  label, totals, rates, emailsSub,
}: {
  label: string;
  totals: FunnelTotals;
  rates: ReturnType<typeof funnelRates>;
  emailsSub: string;
}) {
  const funnel = totals.converted + totals.interested;
  return (
    <CardGroup label={label}>
      <Card label="Emails Sent" value={totals.emails} sub={emailsSub} tone="n-emails" />
      <Card
        label="Reply Rate"
        value={pct(rates.replyRate)}
        sub={ratio(totals.replies, totals.emails)}
        tone="n-ok"
      />
      <Card
        label="Positive Reply"
        value={pct(rates.positiveReply)}
        sub={ratio(totals.interested, totals.replies)}
        tone="n-ok"
      />
      <Card
        label="Avg Conv."
        value={pct(rates.convPer1k)}
        sub={`${ratio(totals.converted, totals.emails)} · per 1k`}
        tone="n-ok"
      />
      <Card label="Converted" value={totals.converted} sub="interested → intro" tone="n-green" />
      <Card
        label="Int → Intro"
        value={pct(rates.intToIntro)}
        sub={ratio(totals.converted, funnel)}
        tone="n-blue"
      />
    </CardGroup>
  );
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
  // An em dash string counts as missing too — that is how the rate helpers
  // say "no denominator", and it should look the same as a null.
  const missing = value === null || value === "—";
  return (
    <div className="card">
      <div className="card-l">{label}</div>
      <div
        className={`card-n tnum${tone && !missing ? ` ${tone}` : ""}`}
        style={{ ...(size ? { fontSize: size } : {}), ...(missing ? { color: "#B9C0CB" } : {}) }}
      >
        {missing ? "—" : typeof value === "number" ? n(value) : value}
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
