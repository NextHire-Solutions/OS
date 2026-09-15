"use client";

import { useMemo, useState } from "react";

import { DASH, fullNumber, percent, ratio } from "@/lib/tools/analytics/format.ts";
import {
  RESOLUTION_LABELS,
  STAGE_ORDER,
  TERMINAL_TYPES,
  outcomeLabel,
} from "@/lib/tools/analytics/outcomes.ts";
import { dateStamp, fullStamp } from "@/lib/workspace/dates";
import {
  ATTRIBUTION_EVENTS_URL,
  ATTRIBUTION_URL,
  describeSync,
  runSync,
  useAnalyticsData,
} from "./actions";
import { AnalyticsFilters, FilterBar, todayInET, useAnalyticsFilters } from "./filters";
import { PLATFORM_COLOR, SERIES_COLOR } from "./palette";
import {
  AnalyticsTabs,
  Bar,
  Box,
  EmptyRow,
  LoadError,
  Pager,
  Search,
  SortHeader,
  sortRows,
  useDebounced,
  useSort,
} from "./shared";
import { Btn, Toast, useToast } from "./toast";

/*
 * Campaign Analytics — Attribution.
 *
 * The tool's `/analytics/attribution`: what the sending actually produced, and
 * how much of it can be proved. Everything here rests on one rule from the
 * tool's CLAUDE.md, and it is worth restating because it is the whole point of
 * the screen:
 *
 *   An outcome is only credited to a campaign the feed can PROVE is ours. The
 *   outcomes feed's campaign_id holds an EmailBison integer, an Instantly uuid,
 *   or nothing; only `emailbison` may reach `resolved_campaign_id`. Resolving
 *   an Instantly row by email SUCCEEDS — the same people are in both systems —
 *   and credits one of our campaigns with another platform's result. That is
 *   the one failure this tab exists to prevent, and it fails upward: EmailBison
 *   looks better, so nobody checks.
 *
 * Which is why the coverage strip is first, and why "Another platform" is a
 * first-class bucket rather than something quietly dropped.
 */

interface Measure { key: string; label: string; count: number; emailsPer: number | null }
interface Stage { type: string; events: number; people: number }
interface TypeTotal { type: string; events: number; people: number; attributed: number; unattributed: number }
interface Coverage {
  total: number;
  attributed: number;
  otherPlatform: number;
  unattributed: number;
  pending: number;
  byMethod: Record<string, number>;
  byPlatform: Record<string, number>;
}
interface CampaignRow {
  campaignId: number;
  name: string | null;
  client: string | null;
  sent: number;
  outcomes: number;
  people: number;
  byType: Record<string, number>;
}
interface TimelineWeek { week: string; counts: Record<string, number>; total: number }
interface Summary {
  emailsSent: number;
  timeline: TimelineWeek[];
  measures: Measure[];
  funnel: Stage[];
  totals: TypeTotal[];
  coverage: Coverage | null;
  campaigns: CampaignRow[];
  platforms?: string[];
}

interface EventRow {
  id: string;
  email: string | null;
  type: string;
  occurredAt: string;
  platform: string;
  sourceRef: string | null;
  resolution: string;
  campaignId: number | null;
  campaign: string | null;
  client: string | null;
}

const PAGE_SIZE = 50;

const STAGE_COLOR: Record<string, string> = {
  introduction: "#2a78d6",
  phone_screen_scheduled: "#4a3aa7",
  phone_screen: "#5B3FD4",
  interview_scheduled: "#eb6834",
  interview: "#B45309",
  hired: "#008300",
};

export function AnalyticsAttributionScreen() {
  const [today] = useState(todayInET);
  return (
    <AnalyticsFilters today={today}>
      <AttributionBody />
    </AnalyticsFilters>
  );
}

function AttributionBody() {
  const { toQueryString } = useAnalyticsFilters();
  const qs = toQueryString();
  const { data, error, loading, reload } = useAnalyticsData<Summary>(ATTRIBUTION_URL(qs));
  const { toast, show } = useToast();
  const [busy, setBusy] = useState(false);

  const sync = async (job: string, what: string) => {
    setBusy(true);
    try {
      const result = await runSync(job);
      await reload();
      // The per-job counts, not just "finished" — see describeSync.
      show(describeSync(what, result));
    } catch (e) {
      show({ text: e instanceof Error ? e.message : "Sync failed", bad: true });
    } finally {
      setBusy(false);
    }
  };

  if (error) return <LoadError what="Attribution" error={error} />;

  const c = data?.coverage;

  return (
    <div className="an-screen">
      <AnalyticsTabs active="attribution" />
      <FilterBar tab="attribution" />
      <div className="wrap" style={{ opacity: loading && !data ? 0.6 : 1, transition: "opacity .14s" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="tbl-title" style={{ fontSize: 19 }}>Attribution</div>
            <div className="tbl-sub">What the sending produced, and how much of it can be proved.</div>
          </div>
          <Btn disabled={busy} onClick={() => void sync("sync-outcomes", "Outcomes sync")}>
            Sync outcomes
          </Btn>
          <Btn disabled={busy} onClick={() => void sync("sync-outcome-attribution", "Campaign resolution")}>
            Resolve campaigns
          </Btn>
        </div>

        {data && !c?.total ? (
          <div className="anno">
            <b>No outcomes in this range.</b> Widen the date range, or check that the outcomes sync
            has run.
          </div>
        ) : null}

        {c ? (
          <Box
            title="Where the outcomes come from"
            note={`${fullNumber(c.total)} outcomes in range`}
          >
            <div style={{ padding: 22 }}>
              <div className="stack" style={{ height: 16, marginBottom: 14 }}>
                {(["emailbison", "instantly", "direct"] as const).map((p) => {
                  const n = c.byPlatform[p] ?? 0;
                  if (!n) return null;
                  return (
                    <i
                      key={p}
                      title={`${p}: ${n}`}
                      style={{ display: "block", width: `${(n / c.total) * 100}%`, background: PLATFORM_COLOR[p], height: "100%" }}
                    />
                  );
                })}
              </div>
              <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 20 }}>
                {(["emailbison", "instantly", "direct"] as const).map((p) => (
                  <span key={p} style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5 }}>
                    <i style={{ width: 9, height: 9, borderRadius: 3, background: PLATFORM_COLOR[p], display: "block" }} />
                    <span style={{ textTransform: "capitalize" }}>{p}</span>
                    <b className="tnum">{fullNumber(c.byPlatform[p] ?? 0)}</b>
                    <span className="mut">{percent(c.total ? (c.byPlatform[p] ?? 0) / c.total : null, 0)}</span>
                  </span>
                ))}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
                {[
                  ["Credited to a campaign", c.attributed, "provable — it counts in the campaign table below"],
                  ["Another platform", c.otherPlatform, "an Instantly result; crediting it here would flatter us"],
                  ["No campaign found", c.unattributed, "client known, campaign not provable"],
                  ["Not yet resolved", c.pending, "the resolver has not reached these"],
                ].map(([label, n, why]) => (
                  <div key={label as string}>
                    <div className="card-l">{label}</div>
                    <div className="card-n tnum" style={{ fontSize: 24 }}>{fullNumber(n as number)}</div>
                    <div className="card-s">{why}</div>
                  </div>
                ))}
              </div>
              {Object.keys(c.byMethod ?? {}).length ? (
                <div style={{ marginTop: 18, fontSize: 12, color: "var(--muted)", lineHeight: 1.6 }}>
                  {/*
                    The tool computes byMethod in SQL, ships it, and renders it
                    nowhere. It is the answer to "how was this decided", which is
                    the question the strip above raises — so it is shown.
                  */}
                  How each was decided:{" "}
                  {Object.entries(c.byMethod)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, n]) => `${RESOLUTION_LABELS[k] ?? k} ${n.toLocaleString("en-US")}`)
                    .join(" · ")}
                </div>
              ) : null}
            </div>
          </Box>
        ) : null}

        {data?.measures?.length ? (
          <Box
            title="What it costs to earn one"
            note={`over ${fullNumber(data.emailsSent)} emails sent`}
          >
            <div style={{ padding: 22, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 18 }}>
              {data.measures.map((m) => (
                <div key={m.key}>
                  <div className="card-l">{m.label}</div>
                  <div className="card-n tnum" style={{ fontSize: 26 }}>{ratio(m.emailsPer)}</div>
                  <div className="card-s">{fullNumber(m.count)} in range</div>
                </div>
              ))}
            </div>
            {data.platforms && data.platforms.length === 1 && data.platforms[0] === "instantly" ? (
              <div className="anno" style={{ margin: "0 22px 20px" }}>
                <b>These ratios mix two populations.</b> Emails sent is EmailBison&rsquo;s figure —
                the RPC behind it has no platform parameter — while the outcome counts beside it are
                filtered to Instantly. Read the counts, not the ratios, in this mode.
              </div>
            ) : null}
          </Box>
        ) : null}

        {data?.timeline && data.timeline.length >= 2 ? <Timeline weeks={data.timeline} /> : null}

        {data?.funnel?.length ? <Funnel funnel={data.funnel} totals={data.totals ?? []} /> : null}

        {data?.campaigns?.length ? <Campaigns rows={data.campaigns} /> : null}

        <Events qs={qs} />
      </div>
      <Toast toast={toast} />
    </div>
  );
}

function Timeline({ weeks }: { weeks: TimelineWeek[] }) {
  const max = Math.max(1, ...weeks.map((w) => w.total));
  return (
    <Box title="Outcomes over time" note="One bar a week, stacked by stage.">
      <div style={{ padding: "22px 22px 8px", display: "flex", gap: 4, alignItems: "flex-end", height: 180, overflowX: "auto" }}>
        {weeks.map((w, i) => (
          <div
            key={w.week}
            title={`${dateStamp(w.week)} · ${w.total} outcome${w.total === 1 ? "" : "s"}`}
            style={{
              flex: "1 0 18px", minWidth: 18, height: `${(w.total / max) * 100}%`,
              display: "flex", flexDirection: "column-reverse",
              // The last bar is a part-week and is dimmed and captioned, so a
              // dip at the right edge is not read as a collapse.
              opacity: i === weeks.length - 1 ? 0.5 : 1,
              borderRadius: 4, overflow: "hidden", background: "var(--inset-2)",
            }}
          >
            {STAGE_ORDER.map((type) =>
              w.counts[type] ? (
                <i
                  key={type}
                  style={{
                    display: "block",
                    height: `${(w.counts[type] / w.total) * 100}%`,
                    background: STAGE_COLOR[type] ?? "var(--muted)",
                  }}
                />
              ) : null,
            )}
          </div>
        ))}
      </div>
      <div style={{ padding: "6px 22px 18px", display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12, color: "var(--muted)" }}>
        {STAGE_ORDER.map((type) => (
          <span key={type} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <i style={{ width: 9, height: 9, borderRadius: 3, background: STAGE_COLOR[type], display: "block" }} />
            {outcomeLabel(type)}
          </span>
        ))}
        <span style={{ marginLeft: "auto" }}>the last bar is this week, still filling</span>
      </div>
    </Box>
  );
}

function Funnel({ funnel, totals }: { funnel: Stage[]; totals: TypeTotal[] }) {
  const first = funnel[0]?.events ?? 0;
  const terminal = totals.filter((t) => (TERMINAL_TYPES as readonly string[]).includes(t.type));

  return (
    <Box
      title="The funnel"
      note="Each bar is a share of the FIRST stage, not the one above it — these events are logged independently, and step-through rates rendered Interview at 288%."
    >
      <div style={{ padding: "20px 22px 8px", display: "flex", flexDirection: "column", gap: 13 }}>
        {funnel.map((s) => (
          <div key={s.type}>
            <div style={{ display: "flex", gap: 10, fontSize: 13, marginBottom: 4 }}>
              <span style={{ flex: 1 }}>{outcomeLabel(s.type)}</span>
              <span className="tnum">{fullNumber(s.events)}</span>
              <span className="tnum mut" style={{ width: 88, textAlign: "right" }}>
                {fullNumber(s.people)} people
              </span>
              <span className="tnum mut" style={{ width: 52, textAlign: "right" }}>
                {percent(first > 0 ? s.events / first : null, 0)}
              </span>
            </div>
            <Bar fraction={first > 0 ? s.events / first : 0} color={STAGE_COLOR[s.type] ?? SERIES_COLOR.sent} />
          </div>
        ))}
      </div>
      {terminal.length ? (
        <div style={{ padding: "14px 22px 20px", borderTop: "1px solid var(--line-soft)", marginTop: 12 }}>
          <div className="card-l">Where people stopped</div>
          <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
            {terminal.map((t) => (
              <div key={t.type}>
                <div className="tnum" style={{ fontSize: 18, fontWeight: 600, color: "var(--ink)" }}>
                  {fullNumber(t.events)}
                </div>
                <div className="csince">{outcomeLabel(t.type)}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </Box>
  );
}

function Campaigns({ rows }: { rows: CampaignRow[] }) {
  const { sort, toggle } = useSort();
  const [limit, setLimit] = useState(12);

  const sorted = useMemo(
    () =>
      sortRows(rows, sort, (r, key) => {
        if (key === "perOutcome") return r.outcomes > 0 ? r.sent / r.outcomes : null;
        return (r as unknown as Record<string, number | string | null>)[key];
      }),
    [rows, sort],
  );

  return (
    <Box
      title="Which campaigns produce results"
      note="Only campaigns the feed could prove. Sorted by outcomes until you pick a column."
    >
      <div className="tbl-scroll">
        <table className="atbl" style={{ minWidth: 860 }}>
          <thead>
            <tr>
              <SortHeader label="Campaign" sortKey="name" sort={sort} onToggle={toggle} width={340} />
              <SortHeader label="Sent" sortKey="sent" sort={sort} onToggle={toggle} align="right" />
              <SortHeader label="Outcomes" sortKey="outcomes" sort={sort} onToggle={toggle} align="right" />
              <SortHeader label="People" sortKey="people" sort={sort} onToggle={toggle} align="right" />
              <SortHeader label="Per outcome" sortKey="perOutcome" sort={sort} onToggle={toggle} align="right" />
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, limit).map((r) => (
              <tr key={r.campaignId}>
                <td>
                  <div className="cname" style={{ maxWidth: 330, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.name ?? `#${r.campaignId}`}
                  </div>
                  <div className="csince">
                    {r.client ?? "Unassigned"}
                    {" · "}
                    {Object.entries(r.byType)
                      .sort((a, b) => b[1] - a[1])
                      .slice(0, 3)
                      .map(([t, n]) => `${outcomeLabel(t)} ${n}`)
                      .join(" · ")}
                  </div>
                </td>
                <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(r.sent)}</td>
                <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(r.outcomes)}</td>
                <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(r.people)}</td>
                <td className="tnum" style={{ textAlign: "right" }}>
                  {r.outcomes > 0 ? ratio(r.sent / r.outcomes) : DASH}
                </td>
              </tr>
            ))}
            {sorted.length === 0 ? <EmptyRow colSpan={5}>No campaign produced a provable outcome.</EmptyRow> : null}
          </tbody>
        </table>
      </div>
      {sorted.length > limit ? (
        <div style={{ padding: "13px 18px", borderTop: "1px solid var(--line-soft)" }}>
          <Btn onClick={() => setLimit((l) => l + 25)}>
            Show {Math.min(25, sorted.length - limit)} more of {sorted.length}
          </Btn>
        </div>
      ) : null}
    </Box>
  );
}

function Events({ qs }: { qs: string }) {
  const [page, setPage] = useState(1);
  const [rawQ, setRawQ] = useState("");
  const q = useDebounced(rawQ);
  const [type, setType] = useState("");
  const [platform, setPlatform] = useState("");
  const { sort, toggle } = useSort();

  const url = useMemo(() => {
    const p = new URLSearchParams(qs);
    p.set("page", String(page));
    if (q.trim()) p.set("q", q.trim());
    if (type) p.set("types", type);
    if (platform) p.set("platforms", platform);
    if (sort) { p.set("sort", sort.key); p.set("dir", sort.dir); }
    return p.toString();
  }, [qs, page, q, type, platform, sort]);

  const { data, error, loading } = useAnalyticsData<{
    page: number;
    pageSize: number;
    total: number;
    rows: EventRow[];
    facets: Array<{ kind: string; value: string; n: number }>;
  }>(ATTRIBUTION_EVENTS_URL(url));

  if (error) return <LoadError what="The outcome list" error={error} />;

  const facets = data?.facets ?? [];
  const typeFacets = facets.filter((f) => f.kind === "type");
  const platformFacets = facets.filter((f) => f.kind === "platform");

  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  return (
    <Box
      title="Every outcome"
      note={`${fullNumber(data?.total ?? 0)} matching`}
      right={
        <>
          <Search value={rawQ} onChange={reset(setRawQ)} placeholder="Search by email…" />
          <select className="sel" aria-label="Outcome type" value={type} onChange={(e) => reset(setType)(e.target.value)}>
            <option value="">Any outcome</option>
            {typeFacets.map((f) => (
              <option key={f.value} value={f.value}>{outcomeLabel(f.value)} ({f.n})</option>
            ))}
          </select>
          <select className="sel" aria-label="Source platform" value={platform} onChange={(e) => reset(setPlatform)(e.target.value)}>
            <option value="">Any source</option>
            {platformFacets.map((f) => (
              <option key={f.value} value={f.value}>{f.value} ({f.n})</option>
            ))}
          </select>
        </>
      }
      style={{ opacity: loading ? 0.6 : 1, transition: "opacity .14s" }}
    >
      <div className="tbl-scroll">
        <table className="atbl" style={{ minWidth: 940 }}>
          <thead>
            <tr>
              <SortHeader label="Date" sortKey="occurred_at" sort={sort} onToggle={toggle} width={170} />
              <SortHeader label="Person" sortKey="email" sort={sort} onToggle={toggle} width={250} />
              <SortHeader label="Outcome" sortKey="event_type" sort={sort} onToggle={toggle} width={170} />
              <SortHeader label="Source" sortKey="source_platform" sort={sort} onToggle={toggle} width={120} />
              <SortHeader label="Credited to" sortKey="client_name" sort={sort} onToggle={toggle} />
            </tr>
          </thead>
          <tbody>
            {(data?.rows ?? []).length === 0 ? (
              <EmptyRow colSpan={5}>{data ? "Nothing matches." : "Loading…"}</EmptyRow>
            ) : (
              (data?.rows ?? []).map((r) => (
                <tr key={r.id}>
                  <td className="mut" style={{ fontSize: 12.5 }}>{fullStamp(r.occurredAt)}</td>
                  <td>{r.email ?? <span className="mut">no email on the feed row</span>}</td>
                  <td><span className="badge s-done">{outcomeLabel(r.type)}</span></td>
                  <td>
                    <span className={`c ${r.platform === "instantly" ? "c-bison" : r.platform === "emailbison" ? "c-inst" : "c-camp"}`}>
                      {r.platform}
                    </span>
                  </td>
                  <td>
                    {/*
                      * The truncation lives on whatever holds the text, not on
                      * the box around it. `text-overflow: ellipsis` styles an
                      * element's OWN text — a child <span> is not covered by it,
                      * so the resolution label ("Belongs to this client, but no
                      * campaign we can prove") ran 56px past this 280px cell and
                      * was hard-cut with no ellipsis to admit it. `r.campaign`
                      * is a bare string and truncated correctly; only the
                      * fallback span did not, which is why it looked fine on
                      * most rows.
                      */}
                    <div style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.campaign ?? (
                        <span
                          className="mut"
                          style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                          title={RESOLUTION_LABELS[r.resolution] ?? r.resolution}
                        >
                          {RESOLUTION_LABELS[r.resolution] ?? r.resolution}
                        </span>
                      )}
                    </div>
                    <div className="csince">{r.client ?? DASH}</div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {data ? <Pager page={page} pageSize={PAGE_SIZE} total={data.total} onPage={setPage} /> : null}
    </Box>
  );
}
