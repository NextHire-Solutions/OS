"use client";

import { useMemo, useState } from "react";

import { Badge, Panel, StatusPill, isLifecycleStatus, type LifecycleStatus } from "@/components/ds";
import {
  activeCampaigns, campaignProgress, campaignsLabel, clientFunnel,
} from "@/lib/tools/client-health/campaigns";
import {
  blankForm, formForClient, todayLocalISO, type ClientFormState,
} from "@/lib/tools/client-health/clientForm";
import { daysUntil, todayInET } from "@/lib/tools/client-health/derive";
import { applyFilters, visibleTotal } from "@/lib/tools/client-health/filters";
import {
  asOfForWeek, deriveRows, funnelRates, summarize, type WeeklyRow,
} from "@/lib/tools/client-health/summarize";
import { sortWeekly, type Sort, type SortCol } from "@/lib/tools/client-health/sorting";
import {
  TZ_SHORT_BY_VALUE, type ClientMarket, type DashboardClient,
} from "@/lib/tools/client-health/types";
import type { ClientHealthWeeklyData } from "@/lib/tools/client-health/weekly";

import { IntrosBillingCell, MonthlyCell, asDate, fmtMDY, isBehind } from "./billing-cells";
import { CampaignToggleDialog } from "./campaign-toggle-dialog";
import { CampaignsPopup } from "./campaigns-popup";
import { ClientModal } from "./client-modal";
import { FilterBar } from "./filter-bar";
import { ClientHealthFrame } from "./frame";
import { patchClient, refreshClientHealth } from "./load";
import { ToastHost } from "./toast";
import { ClientHealthToolbar, useSelectedWeek, weekLabel } from "./toolbar";
import { SummaryCards } from "./summary-cards";
import { setFilters, useClientHealthView } from "./view-state";

/*
 * Client Health — Weekly.
 *
 * The numbers come from the tool's own derive(), summarize(), billing engine
 * and campaign helpers, so this screen and the live app cannot disagree. Every
 * control does what the live tool's does — the filters, the columns, the
 * campaigns popup, the client modal, Play/Pause.
 *
 * BILLING CYCLES (port document §6). There is no weekly target any more. Each
 * row carries one billing snapshot (`row.snap`, billing.ts) taken as of NOW
 * for the current week and as of Sunday 12:00 UTC for a past one; the Monthly,
 * Intros / Billing, Last / Next Billing, Days Until and Status cells, the
 * cards, the filters and the sorts all read that one snapshot.
 *
 * Changing week is a re-derive in the browser, not a round trip: each client
 * already carries `metricsByWeek`. The first render uses the server's own rows
 * and clock (`data.now`), so the client's first render is identical and
 * hydration never mismatches.
 *
 * The selected week and the filters live in view-state.ts, shared with the
 * Bi-Weekly and Client Success screens.
 *
 * A cell with no data shows an em dash. Never a zero — on a health dashboard
 * "0 emails sent" is a claim, and a different one from "we have no figure".
 */

const STATUS = {
  risk: { label: "At Risk", tone: "red" },
  ok: { label: "On Track", tone: "amber" },
  done: { label: "Done", tone: "green" },
  pending: { label: "Pending", tone: "muted" },
} as const;

const PLAN_TONE = { minimum: "outline", production: "brand", partner: "violet" } as const;

const n = (v: number) => v.toLocaleString("en-US");

/** A percentage, or an em dash when its denominator was zero. */
const pct = (v: number | null, digits = 1) => (v === null ? "—" : `${v.toFixed(digits)}%`);

const describeMarket = (m: ClientMarket) => [m.market, m.mls, m.area].filter(Boolean).join(" · ");

type ToggleTarget = { id: string; name: string; action: "pause" | "resume" };

function WeeklyView({ data }: { data: ClientHealthWeeklyData }) {
  const { filters } = useClientHealthView();
  const selected = useSelectedWeek(data);
  const { key, isCurrent, offset } = selected;
  const [sort, setSort] = useState<Sort | null>(null);
  /** Which campaign each row's dropdown is showing. Absent means the roll-up. */
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [modal, setModal] = useState<ClientFormState | null>(null);
  const [popup, setPopup] = useState<string | null>(null);
  const [toggle, setToggle] = useState<ToggleTarget | null>(null);

  /*
   * The SERVER's clock — not the browser's. Daily Emails only counts when the
   * stored date is today, the billing snapshot is taken as of it, and the
   * billing sort and window filter need it. One clock for the whole screen.
   */
  const now = useMemo(() => new Date(data.now), [data.now]);
  const todayET = useMemo(() => todayInET(now), [now]);

  /*
   * The server's rows win on the first render. `data.rows` is dropped the
   * moment anything is edited (see load.ts); after that, and on any other
   * week, the rows are derived here against the same clock.
   */
  const rows = useMemo(() => {
    if (offset === 0 && data.rows) return data.rows;
    const monday = new Date(`${key}T00:00:00Z`);
    return deriveRows(data.clients, key, asOfForWeek(monday, isCurrent, now), monday);
  }, [data.rows, data.clients, key, offset, isCurrent, now]);
  const summary = useMemo(
    () => (offset === 0 && data.summary ? data.summary : summarize(rows, key)),
    [data.summary, rows, key, offset],
  );

  /* Filter first, then sort — the tool's own order. */
  const visible = useMemo(
    () => sortWeekly(applyFilters(rows, filters, now), sort, now),
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
  const shown = visible.length !== visibleTotal(rows) ? `Showing ${visible.length} of ${visibleTotal(rows)}` : `${visible.length} clients`;

  return (
    <div className="ds-page">
      {data.source === "seed" ? (
        <p className="ds-note">
          <b>Showing sample data.</b> Client Health&rsquo;s database is not reachable
          {data.error ? ` — ${data.error}` : ""}.
        </p>
      ) : null}

      <ClientHealthToolbar title="Weekly" description="intros, billing cycles and campaigns for every client" week={selected} onAdd={openAdd} sync={data.sync} now={now} />

      <SummaryCards s={s} lifetime={lifetime} week={week} isCurrent={isCurrent} weekKey={key} />

      <Panel
        title="Client Health"
        description={`${isCurrent ? "Live data from Instantly · Bison · MasterInbox" : `Week of ${weekLabel(key)}`} · ${shown}`}
        actions={<FilterBar value={filters} onChange={setFilters} now={now} />}
        flush
      >
        <div className="ds-table-scroll">
          <table className="ds-table" style={{ minWidth: 2300 }}>
            <thead>
              <tr>
                <SortableTh col="campaigns" sort={sort} onClick={toggleSort} title="Sort by number of active campaigns">Client</SortableTh>
                <SortableTh col="tz" sort={sort} onClick={toggleSort}>Time Zone</SortableTh>
                <SortableTh col="monthly" sort={sort} onClick={toggleSort} title="Intros in the current 28-day period vs the monthly target">Monthly</SortableTh>
                <SortableTh col="lastIntro" sort={sort} onClick={toggleSort}>Last Intro</SortableTh>
                <SortableTh col="lastBilling" sort={sort} onClick={toggleSort} title="Sort by the most recent billing date">Last Billing</SortableTh>
                <SortableTh col="billing" sort={sort} onClick={toggleSort}>Next Billing</SortableTh>
                <SortableTh col="billingDays" sort={sort} onClick={toggleSort}>Days Until Billing</SortableTh>
                <SortableTh col="introsBilling" sort={sort} onClick={toggleSort} title="Delivered since the last billing date vs due by the next, carry included">Intros / Billing</SortableTh>
                <SortableTh col="today" sort={sort} onClick={toggleSort} title="Emails sent today, Eastern">Daily Emails Sent</SortableTh>
                <SortableTh col="emails" sort={sort} onClick={toggleSort} title="Emails sent in the selected week, Monday to Sunday">Weekly Emails Sent</SortableTh>
                <SortableTh col="intros" sort={sort} onClick={toggleSort}>Intros This Week</SortableTh>
                <SortableTh col="conv" sort={sort} onClick={toggleSort} title="Introductions per 1,000 emails">Conv. Rate</SortableTh>
                <SortableTh col="progress" sort={sort} onClick={toggleSort}>Campaign Progress</SortableTh>
                <th>Status</th>
                <SortableTh col="interested" sort={sort} onClick={toggleSort} title="All-time Interested count">Interested</SortableTh>
                <SortableTh col="converted" sort={sort} onClick={toggleSort} title="All-time Interested → Introduction count">Converted</SortableTh>
                <SortableTh col="convRate" sort={sort} onClick={toggleSort} title="Interested → Introduction conversion rate">Int → Intro</SortableTh>
                <th>Plan</th>
                {/* §8 Client Health fields that were held but never shown. */}
                <th>Billing</th>
                <th title="Other names this client's campaigns go by">Aliases</th>
                <th>Portal</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={22} style={{ padding: "34px 16px", textAlign: "center" }} className="ds-none">
                    {rows.length === 0 ? (
                      <>
                        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--ds-ink)", marginBottom: 6 }}>No clients yet</div>
                        <div style={{ marginBottom: 14 }}>Add your first client to start tracking.</div>
                        <a className="ds-btn primary" href="/roster">Add a client on the Clients page</a>
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
                    onToggle={(action) => setToggle({ id: row.client.id, name: row.client.name, action })}
                  />
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

      {popupClient ? <CampaignsPopup client={popupClient} onClose={() => setPopup(null)} /> : null}

      {toggle ? (
        <CampaignToggleDialog
          clientId={toggle.id}
          clientName={toggle.name}
          action={toggle.action}
          onClose={() => setToggle(null)}
          onApplied={(held) => {
            patchClient(toggle.id, { toggle_paused_campaigns: held });
            void refreshClientHealth().catch(() => undefined);
          }}
        />
      ) : null}

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
  row, now, todayET, convAvg, picked, onPick, onEdit, onCampaigns, onToggle,
}: {
  row: WeeklyRow;
  now: Date;
  todayET: string;
  convAvg: number;
  picked: string | undefined;
  onPick: (id: string) => void;
  onEdit: () => void;
  onCampaigns: () => void;
  onToggle: (action: "pause" | "resume") => void;
}) {
  const { client: c, derived: d, snap } = row;

  /*
   * Billing dates from the snapshot: the cycle runs from the last billing date
   * to the next. A billing date closes the cycle billed that day, so on a
   * billing day Next Billing is today. `now` is the server's clock, never
   * `new Date()` here — that is the hydration bug this workspace has shipped
   * three times.
   */
  const lastBilling = snap ? asDate(snap.cycle.start) : null;
  const billing = snap ? asDate(snap.cycle.end) : null;
  const billingDays = billing ? daysUntil(billing, now) : null;

  const status = STATUS[snap?.status ?? "pending"];
  const active = activeCampaigns(c);
  const progress = campaignProgress(active, picked);
  const funnel = clientFunnel(c);
  const label = campaignsLabel(c);

  /* Today's emails only count when the stored date IS today, in Eastern. */
  const todayEmails = c.emails_today_date === todayET ? c.emails_today : 0;

  /*
   * Play/Pause for every campaign of this client. ▶ when this toggle is
   * holding campaigns paused (it resumes exactly those); ⏸ when something is
   * running; ⏸ disabled when nothing is. Distinct from the client's status,
   * which is the lifecycle on the Clients page.
   */
  const held = c.toggle_paused_campaigns?.length ?? 0;
  const campToggle = held > 0 ? (
    <button
      type="button"
      className="ds-camp-toggle is-paused"
      title={`Campaigns paused from here (${held}). Click to resume them.`}
      aria-label={`Resume ${held} campaign${held === 1 ? "" : "s"} for ${c.name}`}
      onClick={(e) => { e.stopPropagation(); onToggle("resume"); }}
    >▶</button>
  ) : (
    <button
      type="button"
      className="ds-camp-toggle"
      disabled={active.length === 0}
      title={active.length ? `Pause all ${active.length} running campaign${active.length === 1 ? "" : "s"}` : "No running campaigns to pause"}
      aria-label={active.length ? `Pause ${active.length} running campaigns for ${c.name}` : `No running campaigns to pause for ${c.name}`}
      onClick={(e) => { e.stopPropagation(); onToggle("pause"); }}
    >⏸</button>
  );

  /* Markets covered, from the OS's own client record. null = could not be read. */
  const markets = c.markets;
  const lifecycle: LifecycleStatus = isLifecycleStatus(c.status) ? c.status
    : c.hidden ? "churned" : c.client_paused ? "paused" : "active";

  return (
    <tr className={isBehind(snap) ? "has-carry" : undefined} style={c.hidden || c.client_paused ? { opacity: 0.62 } : undefined}>
      <td style={{ minWidth: 220 }}>
        <div className="ds-client-name">
          <span>{c.name}</span>
          {/* ↗ and Play/Pause in one nowrap group, so they never split on a long name. */}
          <span className="ds-client-icons">
            {c.portal_url ? (
              <a
                className="ds-portal-link"
                href={c.portal_url}
                target="_blank"
                rel="noopener noreferrer"
                title="Open this client’s portal in Corofy"
                aria-label={`Open ${c.name}’s portal in Corofy`}
              >↗</a>
            ) : null}
            {campToggle}
          </span>
          {/* §11: the lifecycle status in the one pill every tool uses — shown
              when it is not Active, so a row only speaks up when it differs. */}
          {lifecycle !== "active" ? <StatusPill status={lifecycle} size="sm" /> : null}
        </div>

        {/* Since … · N markets — one line. Markets are the OS's own record; null = could not be read. */}
        {c.start_date || markets !== null ? (
          <span className="ds-sub">
            {c.start_date ? `Since ${formatDate(c.start_date)}` : null}
            {c.start_date && markets !== null ? " · " : null}
            {markets === null ? null : (
              <span
                className={`ds-markets${markets.length === 0 ? " empty" : ""}`}
                title={markets.length ? markets.map(describeMarket).join("\n") : "No markets added yet — add them on the client’s record"}
              >
                {markets.length === 0 ? "No markets" : `${markets.length} market${markets.length === 1 ? "" : "s"}`}
              </span>
            )}
          </span>
        ) : null}

        {/* The campaign line. Clickable only when there is something to open. */}
        {active.length > 0 ? (
          <button type="button" className="ds-camps" onClick={onCampaigns} aria-label={`View ${label} for ${c.name}`}>
            <span className="dot" />{label} ›
          </button>
        ) : (
          <span
            className="ds-camps idle"
            title={label === "Campaign Paused" ? "Every linked campaign is paused or finished" : "No campaign has ever launched for this client"}
          >
            {label}
          </span>
        )}
      </td>

      <td>
        {c.time_zone ? (
          <Badge tone="outline" title={c.time_zone}>{TZ_SHORT_BY_VALUE[c.time_zone] ?? c.time_zone}</Badge>
        ) : (
          <button type="button" className="ds-link" onClick={onEdit}>Set</button>
        )}
      </td>

      <td><MonthlyCell snap={snap} /></td>

      <td>
        {d.daysSince === null ? (
          <span className="ds-none">No data</span>
        ) : d.daysSince <= 5 ? (
          <span className="tone-green" style={{ fontWeight: 650 }}>
            {d.daysSince === 0 ? "Today" : d.daysSince === 1 ? "Yesterday" : `${d.daysSince}d ago`}
          </span>
        ) : (
          <Badge tone="amber">{d.daysSince}d ago</Badge>
        )}
      </td>

      <td className="num">{lastBilling ? fmtMDY(lastBilling) : <span className="ds-none">—</span>}</td>

      <td className="num">
        {billing ? fmtMDY(billing) : <button type="button" className="ds-link" onClick={onEdit}>Set billing date</button>}
      </td>

      {/* Three days or fewer is the number somebody acts on, so only it is coloured. */}
      <td>
        {billingDays === null ? (
          <span className="ds-none">—</span>
        ) : billingDays <= 3 ? (
          <Badge tone="red">{billingDays} day{billingDays === 1 ? "" : "s"}</Badge>
        ) : (
          <span className="num">{billingDays} days</span>
        )}
      </td>

      <td><IntrosBillingCell snap={snap} onSetBilling={onEdit} /></td>

      <td className="num">{todayEmails > 0 ? n(todayEmails) : <span className="ds-none">—</span>}</td>

      <td className="num">{d.emails > 0 ? n(d.emails) : <span className="ds-none">—</span>}</td>

      {/* A plain count: there is no weekly target to colour it against. */}
      <td className="num">{n(d.intros)}</td>

      <td className="num">
        {d.convPct === null ? (
          <span className="ds-none">—</span>
        ) : (
          <b
            // The tool's rule: above 3 is good; 1–3 only if it also beats the
            // dashboard average; everything else is not.
            className={d.convPct > 3 ? "tone-green" : d.convPct >= 1 && d.convPct >= convAvg ? "tone-amber" : "tone-red"}
          >
            {d.convPct.toFixed(1)}%
          </b>
        )}
      </td>

      {/*
        Campaign progress across the RUNNING campaigns only, with a picker when
        there is more than one. The roll-up is weighted — sum of completed over
        sum of leads — so a 40-lead campaign at 100% cannot flatter a
        4,000-lead one at 10%.
      */}
      <td style={{ minWidth: 200 }}>
        {active.length === 0 ? (
          <span className="ds-none">—</span>
        ) : (
          <>
            {active.length > 1 ? (
              <select
                className="ds-input"
                value={picked ?? "__avg__"}
                onChange={(e) => onPick(e.target.value)}
                aria-label={`Campaign shown for ${c.name}`}
                style={{ width: "100%", height: 28, marginBottom: 6, fontSize: 12 }}
              >
                <option value="__avg__">All active (avg)</option>
                {active.map((camp) => (
                  <option key={camp.id} value={camp.id}>{camp.name}</option>
                ))}
              </select>
            ) : null}
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5 }}>
              <span className="num ds-none" style={{ color: "var(--ds-muted)" }}>{n(progress.completedLeads)} / {n(progress.totalLeads)}</span>
              <b className="num">{Math.round(progress.pct)}%</b>
            </div>
            <div className="track"><i style={{ width: `${Math.min(100, progress.pct)}%` }} /></div>
            <span className="ds-sub">{n(progress.sent)} sent · Running</span>
          </>
        )}
      </td>

      <td><Badge tone={status.tone} dot>{status.label}</Badge></td>

      <td className="num">{n(funnel.interested)}</td>
      <td className="num">{n(funnel.converted)}</td>
      <td className="num">
        {funnel.ratePct === null
          ? <span className="ds-none" title="Nobody has entered the funnel yet">—</span>
          : pct(funnel.ratePct)}
      </td>

      <td>
        <Badge tone={PLAN_TONE[c.plan as keyof typeof PLAN_TONE] ?? "outline"}>
          {c.plan.charAt(0).toUpperCase() + c.plan.slice(1)}
        </Badge>
      </td>

      {/* §8: billing interval + anchor, and aliases — held on every row, shown nowhere before. */}
      <td>
        {c.billing_interval === "custom" && c.billing_interval_days
          ? `every ${c.billing_interval_days}d`
          : (c.billing_interval ?? "—")}
        <span className="ds-sub">{c.billing_anchor_date ? `anchor ${formatDate(c.billing_anchor_date)}` : "no anchor set"}</span>
      </td>
      <td className="wrap" style={{ maxWidth: 220, minWidth: 120 }}>
        {(c.campaign_aliases ?? []).length
          ? <span title={(c.campaign_aliases ?? []).join(", ")}>{(c.campaign_aliases ?? []).join(", ")}</span>
          : <span className="ds-none">—</span>}
      </td>

      <td title={c.portal_active ? "Portal active in Corofy" : "Not in Corofy portals, or the portal is disabled"}>
        {c.portal_active ? <b className="tone-green">✓</b> : <span className="ds-none">—</span>}
      </td>

      <td>
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          <button type="button" className="ds-btn sm" onClick={onEdit} aria-label={`Edit ${c.name}`}>Edit</button>
          {/*
            §10 — status is changed once and reaches every tool: pause, churn,
            reactivate and delete live on the Clients page, which updates the
            portal, campaigns and billing together.
          */}
          <a
            className="ds-btn sm"
            href="/roster"
            aria-label={`Change ${c.name}'s status on the Clients page`}
            title="Pause, churn, reactivate or delete on the Clients page — it updates every tool, the portal, campaigns and billing together"
          >
            Status…
          </a>
        </div>
      </td>
    </tr>
  );
}

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
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
