"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import { AnchoredPanel } from "@/components/ui/anchored-panel";

import {
  COLUMNS,
  COLUMN_GROUPS,
  COLUMN_PREFS_KEY,
  COLUMN_PREFS_VERSION,
  DEFAULT_VISIBLE,
  type CampaignRow,
} from "@/lib/tools/analytics/columns.ts";
import { DASH, compactNumber, duration, fullNumber, percent } from "@/lib/tools/analytics/format.ts";
import {
  bounceRate,
  humanRate,
  leadToEmail,
  positiveRate,
  replyRate,
} from "@/lib/tools/analytics/metrics.ts";
import { DEFAULT_SERIES, type SeriesKey } from "@/lib/tools/analytics/series.ts";
import type { SubView } from "@/lib/tools/analytics/query-params.ts";
import { STAGE_ORDER, TERMINAL_TYPES, outcomeLabel } from "@/lib/tools/analytics/outcomes.ts";
import { fullStamp } from "@/lib/workspace/dates";
import {
  CAMPAIGN_ROWS_URL,
  CLIENT_ROWS_URL,
  KPIS_URL,
  REPLIES_URL,
  REPLY_ROWS_URL,
  TIMESERIES_URL,
  logOutcome,
  unlogOutcome,
  useAnalyticsData,
} from "./actions";
import { SeriesChart, SeriesChips, type Series } from "./chart";
import { AnalyticsFilters, FilterBar, todayInET, useAnalyticsFilters } from "./filters";
import { KpiBand, type KpiResponse } from "./kpi-band";
import { SERIES_COLOR } from "./palette";
import {
  AnalyticsTabs,
  Bar,
  Box,
  Check,
  ColumnPicker,
  EmptyRow,
  LoadError,
  Pager,
  Search,
  Seg,
  SortHeader,
  sortRows,
  useColumnPrefs,
  useDebounced,
  useSort,
} from "./shared";
import { Btn, ConfirmButton, Toast, useToast } from "./toast";

/*
 * Campaign Analytics — the Campaign screen.
 *
 * The tool's `/analytics/campaign`, which is a KPI band over a segmented
 * control with four sub-views (Charts, Clients, Campaigns, Replies) — the
 * tool's own `SUB_VIEWS`. Volume was folded in here as a fifth sub-view while
 * the workspace had no destination for it; it is its own screen now
 * (`volume.tsx`, the tool's `/analytics/volume`), so this matches the tool.
 *
 * Every number here is the tool's own: the routes under /api/tools/analytics
 * are its route handlers, calling its RPCs, against its database.
 */

const SUB_VIEWS: Array<{ value: SubView; label: string }> = [
  { value: "charts", label: "Charts" },
  { value: "clients", label: "Clients" },
  { value: "campaigns", label: "Campaigns" },
  { value: "replies", label: "Replies" },
];

export function AnalyticsCampaignScreen() {
  /*
   * `today` is resolved ONCE per mount and handed down, never read from the
   * clock during a render. The tool resolves it in its server layout for the
   * same reason: if the client resolved "30d" against the browser's timezone
   * and the API resolved it against the team's, the band and the chart would
   * silently cover different windows.
   */
  const [today] = useState(todayInET);
  return (
    <AnalyticsFilters today={today}>
      <CampaignBody />
    </AnalyticsFilters>
  );
}

function CampaignBody() {
  const { filters, toQueryString } = useAnalyticsFilters();
  const qs = toQueryString();
  const [view, setView] = useState<SubView>("charts");

  const kpis = useAnalyticsData<KpiResponse>(KPIS_URL(qs));

  return (
    <div className="an-screen">
      <AnalyticsTabs active="campaign" />
      <FilterBar tab="campaign" showReplyFacets={view === "replies"} />

      {kpis.error ? (
        <div className="anno" style={{ marginBottom: 0 }}>
          <b>The KPI band could not be loaded.</b> {kpis.error}
        </div>
      ) : (
        <KpiBand data={kpis.data} loading={kpis.loading} />
      )}

      <Seg
        label="Sub-view"
        full
        value={view}
        options={SUB_VIEWS}
        onChange={setView}
      />

      {/*
        `an-flush` lifts `.wrap`'s 1500px cap for this container only.

        The KPI band and the sub-view tab strip above render outside any wrap,
        so they run the full width of the stage. The sub-views did not: on a
        2289px screen the band measured 1943px and the table under it 1448px,
        centred — the panel looked inset by 248px a side for no reason a reader
        could see. Both carry the same 26px gutter, so removing the cap lines
        them up exactly rather than approximately.
      */}
      <div className="wrap an-flush" style={{ paddingTop: 20 }}>
        {view === "charts" ? <ChartsView qs={qs} compare={filters.compare} /> : null}
        {view === "clients" ? <ClientsView qs={qs} /> : null}
        {view === "campaigns" ? <CampaignsView qs={qs} /> : null}
        {view === "replies" ? <RepliesView qs={qs} /> : null}
      </div>
    </div>
  );
}

/* ========================================================================== */
/*                                  CHARTS                                    */
/* ========================================================================== */

function ChartsView({ qs, compare }: { qs: string; compare: boolean }) {
  const { filters, setFilters } = useAnalyticsFilters();
  const [mode, setMode] = useState<"volume" | "rates">("volume");
  const [series, setSeries] = useState<SeriesKey[]>(DEFAULT_SERIES);
  const [normalize, setNormalize] = useState(false);

  const { data, error, loading } = useAnalyticsData<Series>(TIMESERIES_URL(qs));

  if (error) return <LoadError what="The chart" error={error} />;

  /*
   * The design draws this as `.lc-card` — its own card shape, with `.lc-head`
   * carrying a real title and a subtitle, not the generic `.abox` head every
   * other card uses. Two reasons it matters rather than being decoration:
   *
   *   · `.abox` is `overflow:hidden`; `.lc-card` is `overflow:visible`. The
   *     drag-to-read bubble is absolutely positioned and WAS being clipped by
   *     the card at the edges of the range.
   *   · the subtitle is the only place the drag interaction is announced. It
   *     was undiscoverable before — there is no cursor affordance on an SVG.
   *
   * The mockup puts a "Last 30 Days" dropdown in the `.lc-range` slot. Here the
   * range is already owned by the filter bar above, so that slot carries the
   * two controls that ARE this chart's own — Volume/Rates and Normalize —
   * rather than a second, duplicate range picker that would have to either
   * fight the filter bar or do nothing.
   */
  return (
    <section className="abox lc-card" style={{ marginBottom: 20 }}>
      <div className="lc-head">
        <div style={{ minWidth: 0 }}>
          <h2 className="lc-title">{chartTitle(series, mode)}</h2>
          <p className="lc-sub">
            Drag across the chart to read any day
            {compare
              ? " · the dashed line is the previous period, aligned day for day from the most recent end"
              : ""}
          </p>
        </div>
        <div className="an-lc-tools">
          <Seg
            label="Chart mode"
            value={mode}
            options={[
              { value: "volume", label: "Volume" },
              { value: "rates", label: "Rates" },
            ]}
            onChange={(m) => {
              setMode(m);
              // Sent and Prospects have no rate. Leaving them selected would
              // show two lines that vanish, which reads as a broken chart.
              if (m === "rates") {
                const kept = series.filter((k) => k !== "sent" && k !== "prospects");
                setSeries(kept.length ? kept : ["replies"]);
              }
            }}
          />
          <Check
            checked={normalize}
            onChange={setNormalize}
            label="Normalize"
            hint="each line to its own scale"
          />
          {/*
            A FILTER, not chart state: it goes into the query string as
            `exclude_weekends=1`, which the timeseries route and
            `resolveFilters` already honour — the control was the only thing
            missing. Kept in the filter context so it survives a sub-view
            change and lands in a pasted link, as it does in the tool.
          */}
          <Check
            checked={filters.excludeWeekends}
            onChange={(v) => setFilters({ excludeWeekends: v })}
            label="Exclude weekends"
          />
        </div>
      </div>
      <div style={{ padding: "10px 24px 0" }}>
        <SeriesChips selected={series} mode={mode} onChange={setSeries} />
      </div>
      <div style={{ opacity: loading ? 0.55 : 1, transition: "opacity .14s" }}>
        {data ? (
          <SeriesChart data={{ ...data, mode }} series={series} mode={mode} normalize={normalize} />
        ) : (
          <div style={{ height: 340 }} aria-busy="true" />
        )}
      </div>
    </section>
  );
}

/**
 * What the chart is currently showing, as a title.
 *
 * One series gets named — "Reply Volume", the design's own wording — because
 * that is the state the screen opens in and a card with a real name is worth
 * more than a card called "Over time". More than one and there is no honest
 * single name, so it falls back.
 */
const CHART_NOUN: Record<SeriesKey, string> = {
  sent: "Send",
  prospects: "Prospect",
  replies: "Reply",
  human: "Human Reply",
  positive: "Positive Reply",
  bounces: "Bounce",
};

function chartTitle(series: SeriesKey[], mode: "volume" | "rates") {
  if (series.length !== 1) return mode === "rates" ? "Rates over time" : "Volume over time";
  return `${CHART_NOUN[series[0]]} ${mode === "rates" ? "Rate" : "Volume"}`;
}

/* ========================================================================== */
/*                                  CLIENTS                                   */
/* ========================================================================== */

interface ClientRow {
  clientId: string | null;
  name: string;
  campaignCount: number;
  ambiguousCount: number;
  sent: number;
  prospects: number;
  replies: number;
  positive: number | null;
  bounces: number | null;
  replyRate: number | null;
  positiveRate: number | null;
  leadToEmail: number | null;
  bounceRate: number | null;
  medianReplySeconds: number | null;
}

function ClientsView({ qs }: { qs: string }) {
  const { data, error, loading } = useAnalyticsData<{ rows: ClientRow[] }>(CLIENT_ROWS_URL(qs));
  const [q, setQ] = useState("");
  const { sort, toggle } = useSort();

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? (data?.rows ?? []).filter((r) => r.name.toLowerCase().includes(needle))
      : (data?.rows ?? []);
    return sortRows(filtered, sort, (r, key) => (r as unknown as Record<string, number | string | null>)[key]);
  }, [data, q, sort]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (t, r) => ({
          sent: t.sent + r.sent,
          prospects: t.prospects + r.prospects,
          replies: t.replies + r.replies,
          positive: t.positive + (r.positive ?? 0),
          bounces: t.bounces + (r.bounces ?? 0),
        }),
        { sent: 0, prospects: 0, replies: 0, positive: 0, bounces: 0 },
      ),
    [rows],
  );

  if (error) return <LoadError what="The client table" error={error} />;

  return (
    <Box
      title="By client"
      note={`${rows.length} client${rows.length === 1 ? "" : "s"} in this window`}
      right={<Search value={q} onChange={setQ} placeholder="Search clients…" />}
      style={{ opacity: loading ? 0.6 : 1, transition: "opacity .14s" }}
    >
      {/*
        The totals band sums THE ROWS ON SCREEN, not the window — so it agrees
        with what you are looking at once a search narrows it. The KPI band
        above is the window's own total, and the two are allowed to differ.
      */}
      <div className="kpi" style={{ margin: "16px 22px", gridTemplateColumns: "repeat(5, 1fr)" }}>
        {[
          ["Sent", compactNumber(totals.sent)],
          ["Prospects", compactNumber(totals.prospects)],
          ["Replies", compactNumber(totals.replies)],
          ["Positive", compactNumber(totals.positive)],
          ["Reply rate", percent(replyRate(totals.replies, totals.sent), 2)],
        ].map(([k, v]) => (
          <div key={k}>
            <div className="k">{k}</div>
            <div className="v tnum">{v}</div>
          </div>
        ))}
      </div>

      <div className="tbl-scroll">
        <table className="atbl" style={{ minWidth: 1180 }}>
          <thead>
            <tr>
              <SortHeader label="Client" sortKey="name" sort={sort} onToggle={toggle} width={250} />
              <SortHeader label="Sent" sortKey="sent" sort={sort} onToggle={toggle} align="right" />
              <SortHeader label="Prospects" sortKey="prospects" sort={sort} onToggle={toggle} align="right" />
              <SortHeader label="Replies" sortKey="replies" sort={sort} onToggle={toggle} align="right" />
              <SortHeader label="Positive" sortKey="positive" sort={sort} onToggle={toggle} align="right" />
              <SortHeader label="Reply %" sortKey="replyRate" sort={sort} onToggle={toggle} align="right" />
              <SortHeader label="Positive %" sortKey="positiveRate" sort={sort} onToggle={toggle} align="right" />
              <SortHeader label="Lead:Email" sortKey="leadToEmail" sort={sort} onToggle={toggle} align="right" />
              <SortHeader label="Bounces" sortKey="bounces" sort={sort} onToggle={toggle} align="right" />
              {/* The tool's ninth column: how long a client's prospects take
                  to answer, as `duration` renders it — `4.7m`, `12.3h`, `2.0d`. */}
              <SortHeader label="Median Reply" sortKey="medianReplySeconds" sort={sort} onToggle={toggle} align="right" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <EmptyRow colSpan={10}>
                {data ? "No client sent anything in this window." : "Loading…"}
              </EmptyRow>
            ) : (
              rows.map((r) => (
                <tr
                  key={r.clientId ?? "unassigned"}
                  /*
                   * Unassigned is highlighted and NEVER hidden. If unmatched
                   * campaigns dropped out, the client totals would quietly stop
                   * summing to the KPI band and nobody would know why.
                   */
                  style={r.clientId ? undefined : { background: "var(--amber-pale)" }}
                >
                  <td>
                    <div className="cname">{r.name}</div>
                    <div className="csince">
                      {r.campaignCount} campaign{r.campaignCount === 1 ? "" : "s"}
                      {r.ambiguousCount > 0 ? (
                        <span
                          className="badge s-ok"
                          style={{ marginLeft: 8 }}
                          title={`${r.ambiguousCount} campaign${r.ambiguousCount === 1 ? "" : "s"} matched more than one client and were left unassigned rather than guessed`}
                        >
                          {r.ambiguousCount} ambiguous
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(r.sent)}</td>
                  <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(r.prospects)}</td>
                  <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(r.replies)}</td>
                  <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(r.positive)}</td>
                  <td className="tnum" style={{ textAlign: "right" }}>{percent(r.replyRate, 2)}</td>
                  <td className="tnum" style={{ textAlign: "right" }}>{percent(r.positiveRate, 2)}</td>
                  <td className="tnum" style={{ textAlign: "right" }}>
                    {r.leadToEmail == null ? DASH : `1 : ${Math.round(r.leadToEmail).toLocaleString("en-US")}`}
                  </td>
                  <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(r.bounces)}</td>
                  <td className="tnum" style={{ textAlign: "right" }}>{duration(r.medianReplySeconds)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Box>
  );
}

/* ========================================================================== */
/*                                 CAMPAIGNS                                  */
/* ========================================================================== */

interface StepRow {
  stepId: number;
  order: number;
  subject: string | null;
  body: string | null;
  sent: number;
  replies: number;
  interested: number;
  bounced: number;
  isVariant?: boolean;
  variants?: StepRow[];
}

function CampaignsView({ qs }: { qs: string }) {
  const { data, error, loading } = useAnalyticsData<{ rows: CampaignRow[] }>(CAMPAIGN_ROWS_URL(qs));
  const [q, setQ] = useState("");
  const { sort, toggle } = useSort();
  const [visible, setVisible] = useColumnPrefs(
    COLUMN_PREFS_KEY,
    COLUMN_PREFS_VERSION,
    DEFAULT_VISIBLE,
  );
  const [open, setOpen] = useState<number | string | null>(null);

  const cols = useMemo(() => COLUMNS.filter((c) => visible.includes(c.key)), [visible]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? (data?.rows ?? []).filter(
          (r) =>
            r.campaignName.toLowerCase().includes(needle) ||
            (r.clientName ?? "").toLowerCase().includes(needle),
        )
      : (data?.rows ?? []);
    return sortRows(filtered, sort, (r, key) => {
      const col = COLUMNS.find((c) => c.key === key);
      if (col?.sortValue) return col.sortValue(r);
      if (key === "campaignName") return r.campaignName;
      return null;
    });
  }, [data, q, sort]);

  if (error) return <LoadError what="The campaign table" error={error} />;

  return (
    <Box
      title="By campaign"
      note={`${rows.length} campaign${rows.length === 1 ? "" : "s"} · open a row for its sequence steps`}
      right={
        <>
          <Search value={q} onChange={setQ} placeholder="Search campaigns…" />
          <ColumnPicker
            groups={COLUMN_GROUPS}
            columns={COLUMNS}
            visible={visible}
            onChange={setVisible}
          />
        </>
      }
      style={{ opacity: loading ? 0.6 : 1, transition: "opacity .14s" }}
    >
      <div className="tbl-scroll">
        <table className="atbl" style={{ minWidth: 460 + cols.length * 116 }}>
          <thead>
            <tr>
              <th style={{ width: 34 }} aria-label="Expand" />
              <SortHeader label="Campaign" sortKey="campaignName" sort={sort} onToggle={toggle} width={330} />
              {cols.map((c) =>
                c.sortValue ? (
                  <SortHeader key={c.key} label={c.label} sortKey={c.key} sort={sort} onToggle={toggle} align="right" />
                ) : (
                  <th key={c.key} style={{ textAlign: "right" }}>{c.label}</th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <EmptyRow colSpan={cols.length + 2}>
                {data ? "No campaign sent anything in this window." : "Loading…"}
              </EmptyRow>
            ) : (
              rows.map((r) => (
                <CampaignRowView
                  key={`${r.platform ?? "eb"}-${r.campaignId}`}
                  row={r}
                  cols={cols}
                  qs={qs}
                  open={open === r.campaignId}
                  onToggle={() => setOpen(open === r.campaignId ? null : r.campaignId)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </Box>
  );
}

function CampaignRowView({
  row,
  cols,
  qs,
  open,
  onToggle,
}: {
  row: CampaignRow;
  cols: typeof COLUMNS;
  qs: string;
  open: boolean;
  onToggle: () => void;
}) {
  /*
   * Instantly rows do not expand. `analytics_campaign_steps` keys on an
   * EmailBison bigint, and Instantly's sequence lives in a different table with
   * no per-step send counts — a chevron that opened an empty panel would be
   * worse than no chevron.
   */
  const expandable = typeof row.campaignId === "number";
  const steps = useAnalyticsData<{ steps: StepRow[] }>(
    `/api/tools/analytics/campaign-rows/${row.campaignId}/steps?${qs}`,
    { skip: !open || !expandable },
  );

  return (
    <>
      {/*
        The whole row opens it, not just the caret.
        The panel's own note says "open a row for its sequence steps", and only
        a 13px ▸ responded — so the instruction was wrong about its own table
        and the steps looked missing entirely unless you found the glyph. The
        caret stays as the visible affordance and keeps `aria-expanded`; this
        makes the row agree with what the note promises.

        `closest('a,button,input,select')` so a control inside the row still
        does its own job instead of toggling the row underneath it.
      */}
      <tr
        onClick={expandable ? (e) => {
          if ((e.target as HTMLElement).closest("a,button,input,select")) return;
          onToggle();
        } : undefined}
        style={expandable ? { cursor: "pointer" } : undefined}
      >
        <td style={{ paddingRight: 0 }}>
          {expandable ? (
            <button
              type="button"
              aria-expanded={open}
              aria-label={open ? "Hide steps" : "Show steps"}
              onClick={onToggle}
              style={{
                border: 0, background: "none", cursor: "pointer", color: "var(--muted)",
                fontSize: 13, padding: 2,
              }}
            >
              {open ? "▾" : "▸"}
            </button>
          ) : null}
        </td>
        <td>
          <div className="cname" style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {row.campaignName}
          </div>
          <div className="csince">
            {row.clientName ?? "Unassigned"}
            {row.platform === "instantly" ? <span className="c c-inst" style={{ marginLeft: 7 }}>Instantly</span> : null}
          </div>
        </td>
        {cols.map((c) => (
          <td key={c.key} className="tnum" style={{ textAlign: "right" }}>
            {c.render(row)}
          </td>
        ))}
      </tr>
      {open ? (
        <tr>
          <td colSpan={cols.length + 2} style={{ background: "var(--inset)", padding: "14px 18px" }}>
            {steps.error ? (
              <span style={{ color: "var(--red)" }}>{steps.error}</span>
            ) : !steps.data ? (
              <span className="mut">Loading steps…</span>
            ) : steps.data.steps.length === 0 ? (
              <span className="mut">This campaign has no sequence steps in the cache.</span>
            ) : (
              <table className="atbl" style={{ background: "var(--surface)", borderRadius: 10, overflow: "hidden" }}>
                <thead>
                  <tr>
                    <th style={{ width: 46 }}>Step</th>
                    <th>Subject</th>
                    <th style={{ textAlign: "right" }}>Sent</th>
                    <th style={{ textAlign: "right" }}>Replies</th>
                    <th style={{ textAlign: "right" }}>Reply %</th>
                    <th style={{ textAlign: "right" }}>Positive</th>
                    <th style={{ textAlign: "right" }}>Bounced</th>
                  </tr>
                </thead>
                <tbody>
                  {steps.data.steps.map((s) => (
                    <tr key={s.stepId}>
                      <td className="tnum">{s.order}</td>
                      <td style={{ maxWidth: 460, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {s.subject || <span className="mut">(no subject)</span>}
                      </td>
                      <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(s.sent)}</td>
                      <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(s.replies)}</td>
                      <td className="tnum" style={{ textAlign: "right" }}>{percent(replyRate(s.replies, s.sent), 2)}</td>
                      <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(s.interested)}</td>
                      <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(s.bounced)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}

/* ========================================================================== */
/*                                  REPLIES                                   */
/* ========================================================================== */

interface Breakdown {
  key: string;
  label: string;
  bucket: string | null;
  rows: Array<{ value: string; replies: number; positive: number | null }>;
  total?: number;
  groupCount?: number;
  unknown?: number;
  shown?: number;
  unavailable?: string;
}

interface ReplyRow {
  id: number;
  receivedAt: string;
  fromName: string | null;
  fromEmail: string | null;
  subject: string | null;
  preview: string | null;
  interested: boolean | null;
  automated: boolean;
  campaign: string | null;
  client: string | null;
  company: string | null;
  officeCity: string | null;
  salesVolume: string | null;
  logged: string[];
}

const PAGE_SIZE = 50;

function RepliesView({ qs }: { qs: string }) {
  const [positiveOnly, setPositiveOnly] = useState(false);
  const [drill, setDrill] = useState<{ dimension: string; value: string } | null>(null);
  const [page, setPage] = useState(1);
  const [rawQ, setRawQ] = useState("");
  const q = useDebounced(rawQ);
  const { toast, show } = useToast();

  const scope = `${qs}${positiveOnly ? "&positive=1" : ""}`;
  const cards = useAnalyticsData<{ breakdowns: Breakdown[]; platform?: string; positiveAvailable?: boolean }>(
    REPLIES_URL(scope),
  );

  const listQs = useMemo(() => {
    const p = new URLSearchParams(scope);
    p.set("page", String(page));
    if (q.trim()) p.set("q", q.trim());
    if (drill) { p.set("dimension", drill.dimension); p.set("value", drill.value); }
    return p.toString();
  }, [scope, page, q, drill]);

  const list = useAnalyticsData<{
    total: number;
    rows: ReplyRow[];
    platform?: string;
    unavailable?: string;
  }>(REPLY_ROWS_URL(listQs));

  if (cards.error) return <LoadError what="The reply breakdowns" error={cards.error} />;

  return (
    <>
      <Box
        title="Who replied"
        note={
          drill
            ? `Filtered to ${drill.value}. Click the bar again to clear.`
            : "Each card groups this window's replies by one attribute of the person who sent them."
        }
        right={
          <Seg
            label="Reply scope"
            value={positiveOnly ? "positive" : "all"}
            options={[
              { value: "all", label: "All replies" },
              { value: "positive", label: "Positive only" },
            ]}
            onChange={(v) => {
              setPositiveOnly(v === "positive");
              // Switching scope clears the drill-down: a value that existed in
              // "all" may have no positive replies at all, and the list would
              // read as empty rather than as filtered.
              setDrill(null);
              setPage(1);
            }}
          />
        }
      >
        <div
          className="grid2"
          style={{
            padding: 22,
            gridTemplateColumns: "repeat(auto-fill, minmax(330px, 1fr))",
            opacity: cards.loading ? 0.6 : 1,
            transition: "opacity .14s",
          }}
        >
          {(cards.data?.breakdowns ?? []).map((b) => (
            <BreakdownCard
              key={b.key}
              breakdown={b}
              positiveOnly={positiveOnly}
              active={drill?.dimension === b.key ? drill.value : null}
              onPick={(value) => {
                setDrill((d) =>
                  d && d.dimension === b.key && d.value === value ? null : { dimension: b.key, value },
                );
                setPage(1);
              }}
            />
          ))}
          {cards.data && cards.data.breakdowns.length === 0 ? (
            <div className="mut">No replies in this window.</div>
          ) : null}
        </div>
      </Box>

      <Box
        title="Every reply"
        note={
          list.data?.unavailable ??
          `${(list.data?.total ?? 0).toLocaleString("en-US")} matching`
        }
        right={<Search value={rawQ} onChange={(v) => { setRawQ(v); setPage(1); }} placeholder="Search replies…" width={280} />}
        style={{ opacity: list.loading ? 0.6 : 1, transition: "opacity .14s" }}
      >
        {list.data?.unavailable ? (
          <div className="anno" style={{ margin: 22 }}>
            <b>Reply detail covers one platform at a time.</b> {list.data.unavailable}
          </div>
        ) : null}
        <div className="tbl-scroll">
          <table className="atbl" style={{ minWidth: 1000 }}>
            <thead>
              <tr>
                <th style={{ width: 168 }}>When</th>
                <th style={{ width: 230 }}>Who</th>
                <th>Reply</th>
                <th style={{ width: 190 }}>Campaign</th>
                <th style={{ width: 220 }}>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {(list.data?.rows ?? []).length === 0 ? (
                <EmptyRow colSpan={5}>{list.data ? "No replies match." : "Loading…"}</EmptyRow>
              ) : (
                (list.data?.rows ?? []).map((r) => (
                  <tr key={r.id}>
                    <td className="mut" style={{ fontSize: 12.5 }}>{fullStamp(r.receivedAt)}</td>
                    <td>
                      <div style={{ fontWeight: 600, color: "var(--ink)" }}>{r.fromName || r.fromEmail}</div>
                      <div className="csince">{r.company ?? r.officeCity ?? r.fromEmail}</div>
                    </td>
                    <td style={{ maxWidth: 420 }}>
                      <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.subject}
                      </div>
                      <div className="csince" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.preview}
                      </div>
                    </td>
                    <td>
                      <div style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 }}>
                        {r.campaign ?? DASH}
                      </div>
                      <div className="csince">{r.client ?? "Unassigned"}</div>
                    </td>
                    <td>
                      <LogOutcome reply={r} show={show} onChanged={() => void list.reload()} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {list.data && !list.data.unavailable ? (
          <Pager page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />
        ) : null}
      </Box>
      <Toast toast={toast} />
    </>
  );
}

function BreakdownCard({
  breakdown,
  positiveOnly,
  active,
  onPick,
}: {
  breakdown: Breakdown;
  positiveOnly: boolean;
  active: string | null;
  onPick: (value: string) => void;
}) {
  const max = Math.max(1, ...breakdown.rows.map((r) => r.replies));
  const unknownShare =
    breakdown.total && breakdown.unknown ? breakdown.unknown / breakdown.total : 0;

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: "var(--r-md)", overflow: "hidden" }}>
      <div style={{ padding: "13px 15px", borderBottom: "1px solid var(--line-soft)", fontWeight: 600, color: "var(--ink)", fontSize: 14 }}>
        {breakdown.label}
      </div>
      <div style={{ padding: "10px 15px 6px" }}>
        {breakdown.unavailable ? (
          <div className="mut" style={{ fontSize: 12.5, padding: "10px 0" }}>{breakdown.unavailable}</div>
        ) : (
          breakdown.rows.map((r) => {
            /*
             * Unknown and Unassigned are grey. They are real rows — dropping
             * them would stop the bars summing to the reply count and the card
             * would quietly lie about its own coverage — but they are not a
             * finding, and colouring them like one invites a conclusion.
             */
            const muted = r.value === "Unknown" || r.value === "Unassigned";
            const on = active === r.value;
            return (
              <button
                key={r.value}
                type="button"
                onClick={() => onPick(r.value)}
                aria-pressed={on}
                title={`${r.replies} repl${r.replies === 1 ? "y" : "ies"} · click to filter the list below`}
                style={{
                  display: "block", width: "100%", textAlign: "left", border: 0,
                  background: on ? "var(--inset)" : "none", cursor: "pointer",
                  padding: "5px 6px", borderRadius: 8, marginBottom: 2,
                }}
              >
                <div style={{ display: "flex", gap: 10, fontSize: 12.5, marginBottom: 3 }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: muted ? "var(--muted)" : "var(--ink-2)" }}>
                    {r.value}
                  </span>
                  <span className="tnum mut">{r.replies.toLocaleString("en-US")}</span>
                </div>
                <Bar
                  fraction={r.replies / max}
                  color={muted ? "#cbd5e1" : positiveOnly ? SERIES_COLOR.positive : SERIES_COLOR.replies}
                />
              </button>
            );
          })
        )}
      </div>
      {unknownShare >= 0.2 || (breakdown.groupCount && breakdown.shown && breakdown.groupCount > breakdown.shown) ? (
        <div style={{ padding: "8px 15px 12px", fontSize: 11.5, color: "var(--muted)", lineHeight: 1.5 }}>
          {unknownShare >= 0.2
            ? `${percent(unknownShare, 0)} of these replies have no value for this attribute. `
            : ""}
          {breakdown.groupCount && breakdown.shown && breakdown.groupCount > breakdown.shown
            ? `Top ${breakdown.shown} of ${breakdown.groupCount.toLocaleString("en-US")}.`
            : ""}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Log an outcome against one reply, and take it back.
 *
 * The id the server builds is `manual:<replyId>:<type>`, so pressing the same
 * button twice is a no-op rather than a duplicate, and the `manual:` prefix is
 * what stops the delete from reaching a row the outcomes feed owns — one the
 * next sync would silently restore, making the delete look intermittent.
 */
function LogOutcome({
  reply,
  show,
  onChanged,
}: {
  reply: ReplyRow;
  show: (t: { text: string; bad?: boolean }) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const outcomeWrap = useRef<HTMLSpanElement | null>(null);
  const closeOutcome = useCallback(() => setOpen(false), []);
  const logged = reply.logged ?? [];

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
      show({ text: what });
    } catch (e) {
      show({ text: e instanceof Error ? e.message : "Something went wrong", bad: true });
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      {logged.map((type) => (
        <ConfirmButton
          key={type}
          label={outcomeLabel(type)}
          armedLabel="Remove?"
          title={`Remove the hand-logged “${outcomeLabel(type)}” from this reply. The outcomes feed's own rows are never touched.`}
          disabled={busy}
          onConfirm={() =>
            void run(`Removed ${outcomeLabel(type)}`, () => unlogOutcome(`manual:${reply.id}:${type}`))
          }
        />
      ))}
      <span ref={outcomeWrap} style={{ position: "relative" }}>
        <Btn disabled={busy} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {logged.length ? "+" : "Log outcome"}
        </Btn>
        {/*
          Portalled: this menu opens from inside a scrolling replies table,
          which clips it. See ui/anchored-panel.tsx.
        */}
        <AnchoredPanel
          anchorRef={outcomeWrap} open={open} onClose={closeOutcome}
          width={210} align="end" label="Log outcome"
        >
          <div style={{ padding: 6, overflowY: "auto", flex: 1, minHeight: 0 }}>
            {/* The stages, then where a person stopped — No-show, Rejected,
                Keep Warm — the same list the tool's select offers. */}
            {[...STAGE_ORDER, ...TERMINAL_TYPES].map((type) => (
              <button
                key={type}
                type="button"
                disabled={busy || logged.includes(type)}
                onClick={() => void run(`Logged ${outcomeLabel(type)}`, () => logOutcome(reply.id, type))}
                style={{
                  display: "block", width: "100%", textAlign: "left", border: 0,
                  background: "none", padding: "7px 10px", borderRadius: 8,
                  font: "inherit", fontSize: 13, cursor: logged.includes(type) ? "not-allowed" : "pointer",
                  color: logged.includes(type) ? "var(--muted)" : "var(--ink-2)",
                }}
              >
                {outcomeLabel(type)}
              </button>
            ))}
          </div>
        </AnchoredPanel>
      </span>
    </div>
  );
}
