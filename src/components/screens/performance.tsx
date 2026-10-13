"use client";

import { useMemo, useState } from "react";

import { Drawer, PageHeader, SearchInput, Segmented } from "@/components/ds";
import type { Performance, SubscriptionListRow } from "@/lib/workspace/performance";
import {
  DEFAULT_PRESET,
  RANGE_PRESETS,
  compareRange,
  isDay,
  rangeDays,
  rangeLabel,
  rangeTiles,
  resolveRange,
  revenuePerAccount,
  type CompareMode,
  type RangePreset,
} from "@/lib/workspace/performance-range";

import { Lazy, PlaceholderScreen } from "./lazy";

/*
 * Performance — clients and revenue (Overview), and the next 30 days of Stripe
 * charges (Billing Calendar, its own sub-page since 9 Oct).
 *
 * REBUILT TO THE CLIENT'S WIREFRAME (11 Oct; built 13 Oct). What changed:
 *
 *   · a DATE FILTER — This month, Last 30 days, Last 90 days, YTD (default),
 *     All time, Custom — and a COMPARE choice (previous period / same period
 *     last year). Every tile says, top right, which of three things it is:
 *       RANGE     follows the date filter
 *       TODAY     live as of now
 *       ALL TIME  ignores the filter
 *   · Total Clients became SIGNED / ACTIVE: who signed in the range, and how
 *     many of those same clients are active today.
 *   · LTV, Avg revenue per account and Customer lifespan are new; Growth moved
 *     beside them and now compares the range with the compare period.
 *   · Active subs and Paused subs open the list of those subscriptions.
 *   · The Production / Minimum / Partner row is gone.
 *
 * Also from the 13 Oct notes: each month in Client movement opens to show WHO
 * was added, paused or churned, and "not tied to a client" opens the list of
 * Stripe customers that money came from.
 *
 * The RANGE tiles are computed here, in the browser, from one payload of
 * facts (performance-range.ts) — changing the range asks the server nothing.
 *
 * Where a number is unavailable the tile says WHY. "—" alone invites someone
 * to assume the value is zero.
 */

const MISSING = "#B9C0CB";

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const usd2 = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const PLAN_LABEL: Record<string, string> = { production: "Production", minimum: "Minimum", partner: "Partner" };
const dayLabel = (d: string | null) =>
  d ? new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—";
const listed = (names: string[]) => (names.length ? names.join(", ") : "none");

type Scope = "RANGE" | "TODAY" | "ALL TIME";
type PanelState = { kind: "subscriptions"; tab: "active" | "paused" } | { kind: "unattributed" } | null;

function PerformanceView({ performance }: { performance: Performance }) {
  const { totals, months, unavailable, facts } = performance;
  const [preset, setPreset] = useState<RangePreset>(DEFAULT_PRESET);
  const [custom, setCustom] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const [mode, setMode] = useState<CompareMode>("previous");
  const [panel, setPanel] = useState<PanelState>(null);
  const [openMonths, setOpenMonths] = useState<Set<string>>(new Set());

  const range = useMemo(() => resolveRange(preset, facts.today, facts.earliest, custom), [preset, custom, facts.today, facts.earliest]);
  const compare = useMemo(() => compareRange(range, mode), [range, mode]);
  const t = performance.billing?.totals ?? null;
  const arpa = revenuePerAccount(t ? t.mrr : null, totals.active ?? 0);
  const tiles = useMemo(
    () => rangeTiles(facts.clients, facts.revenueByDay, range, compare, arpa),
    [facts.clients, facts.revenueByDay, range, compare, arpa],
  );

  if (unavailable) {
    return (
      <>
        <div className="hero"><PageHeader icon="performance" title="Performance" description="Clients and revenue" /></div>
        <div className="wrap">
          <div className="card">
            <div className="card-l">Unavailable</div>
            <p style={{ fontSize: 14, color: "var(--muted)" }}>{unavailable}</p>
          </div>
        </div>
      </>
    );
  }

  const noStripe = performance.billingError ? `Stripe could not be read (${performance.billingError})` : "Stripe could not be read";
  const subs = facts.subscriptions ?? [];
  const customReady = preset !== "custom" || (isDay(custom.from) && isDay(custom.to));
  const where = rangeLabel(range, facts.today);
  const against = rangeLabel(compare, facts.today);
  const toggleMonth = (m: string) =>
    setOpenMonths((cur) => {
      const next = new Set(cur);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });

  return (
    <>
      <div className="hero"><PageHeader icon="performance" title="Performance" description="Clients and revenue" /></div>

      <div className="wrap" data-performance>
        {/* ---- Date filter ---- */}
        <div className="pf-filter" data-pf-filter>
          <span className="pf-filter-l">Date</span>
          <div className="pf-pills" role="group" aria-label="Date range">
            {RANGE_PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                className={`pf-pill${preset === p.value ? " on" : ""}`}
                aria-pressed={preset === p.value}
                data-pf-preset={p.value}
                onClick={() => setPreset(p.value)}
              >
                {p.label}
              </button>
            ))}
            <button
              type="button"
              className={`pf-pill pf-pill-custom${preset === "custom" ? " on" : ""}`}
              aria-pressed={preset === "custom"}
              data-pf-preset="custom"
              onClick={() => {
                // Start from what is on screen, so "Custom" never begins empty.
                if (!isDay(custom.from) || !isDay(custom.to)) setCustom({ from: range.from, to: range.to });
                setPreset("custom");
              }}
            >
              Custom{preset === "custom" && customReady ? `: ${where}` : ""}
            </button>
            {preset === "custom" ? (
              <span className="pf-custom">
                <input
                  id="pf-from" type="date" className="inp" aria-label="From" value={custom.from} max={facts.today}
                  onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
                />
                <span className="mut">to</span>
                <input
                  id="pf-to" type="date" className="inp" aria-label="To" value={custom.to} max={facts.today}
                  onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
                />
              </span>
            ) : null}
          </div>
          <label className="pf-compare">
            <span>Compare</span>
            <select id="pf-compare" className="inp" value={mode} onChange={(e) => setMode(e.target.value as CompareMode)}>
              <option value="previous">Previous period</option>
              <option value="year">Same period last year</option>
            </select>
          </label>
        </div>
        <p className="pf-range" data-pf-range>
          <b>{where}</b> · {rangeDays(range)} day{rangeDays(range) === 1 ? "" : "s"} · compared with {against}
        </p>

        {/* ---- Row 1: the range ---- */}
        <div className="cards pf-row" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
          <Tile
            id="signed" scope="RANGE" label="Signed / Active"
            value={<>{tiles.signed} <span className="pf-slash">/</span> {tiles.signedActive}</>}
            sub={`signed in range · of those, still active (${tiles.signedPaused} paused, ${tiles.signedChurned} churned${tiles.signedOther ? `, ${tiles.signedOther} onboarding` : ""})`}
            title={`Signed in range: ${listed(tiles.signedNames)}`}
          />
          <Tile
            id="added" scope="RANGE" label="Clients added" tone="n-green"
            value={`+${tiles.added}`} sub="in selected range" title={`Added: ${listed(tiles.addedNames)}`}
          />
          <Tile
            id="churned" scope="RANGE" label="Clients churned"
            value={tiles.churned} sub={`in selected range · ${totals.churned ?? 0} churned in all`} title={`Churned: ${listed(tiles.churnedNames)}`}
          />
          <Tile
            id="revenue" scope="RANGE" label="Revenue"
            value={tiles.revenue === null ? null : usd(tiles.revenue)}
            sub={tiles.revenue === null ? noStripe : `collected in range · ${totals.stripeLinked} clients on Stripe`}
          />
        </div>

        {/* ---- Row 2: all time and today ---- */}
        <div className="cards pf-row" style={{ gridTemplateColumns: "repeat(5, minmax(0, 1fr))" }}>
          <Tile
            id="total-billed" scope="ALL TIME" label="Total billed"
            value={t ? usd(t.totalBilled) : null}
            sub={
              !t ? noStripe : t.unattributed > 0 ? (
                <>
                  less refunds ·{" "}
                  <button type="button" className="pf-link" data-pf-unattributed onClick={() => setPanel({ kind: "unattributed" })}>
                    {usd(t.unattributed)} not tied to a client →
                  </button>
                </>
              ) : "less refunds"
            }
          />
          <Tile
            id="mrr" scope="TODAY" label="MRR" tone="n-blue"
            value={t ? usd(t.mrr) : null}
            sub={t ? `+${usd(t.newMrr30)} new · −${usd(t.lostMrr30)} lost, 30 days` : noStripe}
          />
          <Tile id="arr" scope="TODAY" label="ARR" value={t ? usd(t.arr) : null} sub={t ? "MRR × 12" : noStripe} />
          <Tile
            id="active-subs" scope="TODAY" label="Active subs" tone="n-green"
            value={t ? t.activeSubscriptions : null}
            sub={t ? <span className="pf-link">collecting now · View list →</span> : noStripe}
            onClick={t ? () => setPanel({ kind: "subscriptions", tab: "active" }) : undefined}
          />
          <Tile
            id="paused-subs" scope="TODAY" label="Paused subs"
            value={t ? t.pausedSubscriptions : null}
            sub={t ? <span className="pf-link">not cancelled · View list →</span> : noStripe}
            onClick={t ? () => setPanel({ kind: "subscriptions", tab: "paused" }) : undefined}
          />
        </div>

        {/* ---- Row 3: value of a client ---- */}
        <div className="cards pf-row" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
          <Tile
            id="ltv" scope="RANGE" label="LTV"
            value={tiles.ltv === null ? null : usd(tiles.ltv)}
            sub={tiles.ltv === null ? (t ? "no client signed in range has paid through Stripe yet" : noStripe) : "avg revenue per account × customer lifespan"}
          />
          <Tile
            id="arpa" scope="TODAY" label="Avg revenue per account"
            value={arpa === null ? null : <>{usd(arpa)} <span className="pf-unit">/ mo</span></>}
            sub={arpa === null ? (t ? "no active clients" : noStripe) : `MRR ÷ ${totals.active} active clients`}
          />
          <Tile
            id="lifespan" scope="RANGE" label="Customer lifespan"
            value={tiles.lifespanMonths === null ? null : <>{tiles.lifespanMonths.toFixed(1)} <span className="pf-unit">months</span></>}
            sub={
              tiles.lifespanMonths === null
                ? (t ? "no client signed in range has paid through Stripe yet" : noStripe)
                : `avg months paid · ${tiles.lifespanClients} of ${tiles.signed} signed in range`
            }
          />
          <Tile
            id="growth" scope="RANGE" label="Growth"
            tone={tiles.growthPct === null ? undefined : tiles.growthPct >= 0 ? "n-green" : "n-red"}
            value={tiles.growthPct === null ? null : `${tiles.growthPct > 0 ? "+" : tiles.growthPct < 0 ? "−" : ""}${Math.abs(tiles.growthPct).toFixed(1)}%`}
            sub={
              tiles.revenue === null || tiles.revenueCompare === null
                ? noStripe
                : tiles.growthPct === null
                  ? `collected: ${usd(tiles.revenue)} in range · nothing collected in ${against}`
                  : `collected: ${usd(tiles.revenue)} in range vs ${usd(tiles.revenueCompare)} compare period`
            }
          />
        </div>
        <p className="pf-legend">
          <b>RANGE</b> follows the date filter · <b>TODAY</b> is live as of now · <b>ALL TIME</b> ignores the filter.
        </p>

        {/* ---- Client movement, month by month ---- */}
        <div className="tbl-wrap">
          <div className="tbl-head">
            <div>
              <div className="tbl-title">Client movement</div>
              <div className="tbl-sub">
                By onboarding, churn and pause dates · open a month to see who
                {totals.undated > 0
                  ? ` · ${totals.undated} client${totals.undated === 1 ? " has" : "s have"} no onboarding or start date`
                  : ""}
                {totals.churnUndated > 0
                  ? ` · ${totals.churnUndated} churned client${totals.churnUndated === 1 ? " has" : "s have"} no churn date`
                  : ""}
                {totals.pauseUndated > 0
                  ? ` · ${totals.pauseUndated} paused client${totals.pauseUndated === 1 ? " has" : "s have"} no pause date`
                  : ""}
              </div>
            </div>
          </div>
          <div className="tbl-scroll">
            <table>
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Added</th>
                  <th>Churned</th>
                  <th>Paused</th>
                  <th>Net</th>
                  <th>Active at month end</th>
                  <th>Revenue</th>
                </tr>
              </thead>
              <tbody>
                {months.flatMap((row) => {
                  const open = openMonths.has(row.month);
                  const any = row.added > 0 || row.churned > 0 || (row.paused ?? 0) > 0;
                  const main = (
                    <tr key={row.month} data-pf-month={row.month}>
                      <td>
                        {/* The whole label is the control, with the arrow beside it (13 Oct). */}
                        <button
                          type="button"
                          className="pf-month"
                          aria-expanded={open}
                          aria-controls={`pf-month-${row.month}`}
                          disabled={!any}
                          title={any ? "See which clients were added, paused or churned" : "No client was added, paused or churned this month"}
                          onClick={() => toggleMonth(row.month)}
                        >
                          <span>{row.label}</span>
                          <svg viewBox="0 0 24 24" aria-hidden="true" className={open ? "open" : ""}><path d="m6 9 6 6 6-6" /></svg>
                        </button>
                      </td>
                      <td className={`tnum${row.added ? " n-green" : " mut"}`}>{row.added ? `+${row.added}` : "0"}</td>
                      <td className={`tnum${row.churned ? " n-red" : " mut"}`}>{row.churned ? `−${row.churned}` : "0"}</td>
                      <td className={`tnum${row.paused ? "" : " mut"}`} title={row.paused === null ? "The status history could not be read" : undefined}>
                        {row.paused === null ? "—" : row.paused}
                      </td>
                      <td className="tnum">{row.net > 0 ? `+${row.net}` : row.net < 0 ? `−${-row.net}` : "0"}</td>
                      <td className="tnum">{row.activeAtEnd}</td>
                      <td className={`tnum${row.revenue === null ? " mut" : ""}`}>
                        {row.revenue === null ? "—" : row.revenue.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}
                      </td>
                    </tr>
                  );
                  if (!open) return [main];
                  return [
                    main,
                    <tr key={`${row.month}-who`} className="pf-who" id={`pf-month-${row.month}`} data-pf-month-detail={row.month}>
                      <td colSpan={7}>
                        <div className="pf-who-grid">
                          <WhoList tone="n-green" label="Added" names={row.addedNames} count={row.added} />
                          <WhoList label="Paused" names={row.pausedNames} count={row.paused} />
                          <WhoList tone="n-red" label="Churned" names={row.churnedNames} count={row.churned} />
                        </div>
                      </td>
                    </tr>,
                  ];
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/*
         * Says plainly what each figure is. Without this the page reads as a
         * set of numbers to be trusted rather than ones that can be checked.
         */}
        <p style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 14, lineHeight: 1.7, maxWidth: "84ch" }}>
          <b>Signed</b> is each client&rsquo;s sign-up date: the first $1 charge in Stripe ({facts.signedBy.stripe} clients), else the
          sign-up date on the record ({facts.signedBy.entered}), else the onboarding date ({facts.signedBy.onboarding})
          {facts.signedBy.none > 0 ? ` — ${facts.signedBy.none} have none of the three and are in no range` : ""}.{" "}
          <b>Added</b> is the onboarding date
          {totals.bySignupDate > 0 ? ` (${totals.bySignupDate} use their sign-up date because no onboarding date is recorded)` : ""};{" "}
          <b>Churned</b> is each churned client&rsquo;s churn date. All are on the client&rsquo;s record in <a href="/roster">Clients</a>.{" "}
          <b>Revenue</b> and <b>Growth</b> are everything Stripe collected, less refunds — every subscription and card.{" "}
          <b>Customer lifespan</b> is the months of service a client has paid for (a 14-day invoice counts as 0.46 of a month),
          averaged over the clients signed in the range that have paid through Stripe; <b>LTV</b> multiplies it by the average
          revenue per account. <b>Paused</b> in the table counts each client paused that month, once. The next 30 days of charges
          are on <a href="/performance/billing">Billing Calendar</a>.
        </p>
      </div>

      <SubscriptionsPanel
        open={panel?.kind === "subscriptions"}
        tab={panel?.kind === "subscriptions" ? panel.tab : "active"}
        onTab={(tab) => setPanel({ kind: "subscriptions", tab })}
        onClose={() => setPanel(null)}
        rows={subs}
      />
      <UnattributedPanel
        open={panel?.kind === "unattributed"}
        onClose={() => setPanel(null)}
        customers={facts.unattributed ?? []}
        total={t?.unattributed ?? 0}
      />
    </>
  );
}

/** One tile: what it is, which scope it follows, the figure, and what the figure means. */
function Tile({
  id, scope, label, value, sub, tone, title, onClick,
}: {
  id: string;
  scope: Scope;
  label: string;
  /** null = unknown: a dash, and `sub` says why. */
  value: React.ReactNode | null;
  sub: React.ReactNode;
  tone?: string;
  title?: string;
  onClick?: () => void;
}) {
  const missing = value === null;
  const body = (
    <>
      <div className="pf-tile-top">
        <span className="card-l">{label}</span>
        <span className="pf-tag" data-scope={scope}>{scope}</span>
      </div>
      <div className={`card-n tnum${tone && !missing ? ` ${tone}` : ""}`} style={missing ? { color: MISSING } : undefined}>
        {missing ? "—" : value}
      </div>
      <div className="card-s" style={missing ? { color: MISSING } : undefined}>{sub}</div>
    </>
  );
  return onClick ? (
    <button type="button" className="card pf-tile pf-tile-btn" data-pf-tile={id} title={title} onClick={onClick}>{body}</button>
  ) : (
    <div className="card pf-tile" data-pf-tile={id} title={title}>{body}</div>
  );
}

function WhoList({ label, names, count, tone }: { label: string; names: string[]; count: number | null; tone?: string }) {
  return (
    <div data-pf-who={label.toLowerCase()}>
      <div className={`pf-who-h${tone ? ` ${tone}` : ""}`}>{label}{count === null ? "" : ` · ${count}`}</div>
      {count === null ? (
        <div className="mut">The status history could not be read.</div>
      ) : names.length === 0 ? (
        <div className="mut">{count > 0 ? "Names unavailable." : "Nobody"}</div>
      ) : (
        <ul>{names.map((n) => <li key={n}>{n}</li>)}</ul>
      )}
    </div>
  );
}

/*
 * The subscriptions behind the Active / Paused tiles (wireframe page 2).
 *
 * Exactly the subscriptions each tile counts — the list and the number come
 * from the same filter (billing-model.ts subscriptionRows) — with the client
 * each belongs to. A row opens that client's record; a subscription no client
 * is tied to says whose card it is and links only to Stripe.
 */
function SubscriptionsPanel({
  open, tab, onTab, onClose, rows,
}: {
  open: boolean;
  tab: "active" | "paused";
  onTab: (tab: "active" | "paused") => void;
  onClose: () => void;
  rows: SubscriptionListRow[];
}) {
  const [q, setQ] = useState("");
  const active = rows.filter((r) => r.state === "active");
  const paused = rows.filter((r) => r.state === "paused");
  const needle = q.trim().toLowerCase();
  const shown = (tab === "active" ? active : paused).filter((r) => !needle || r.client.toLowerCase().includes(needle));
  return (
    <Drawer open={open} onClose={onClose} label="Subscriptions" title="Subscriptions" subtitle="From Stripe, as of now">
      <div className="pf-panel-tools" data-pf-subs>
        <Segmented
          label="Which subscriptions"
          value={tab}
          onChange={onTab}
          options={[
            { value: "active", label: `Active ${active.length}` },
            { value: "paused", label: `Paused ${paused.length}` },
          ]}
        />
        <SearchInput value={q} onChange={setQ} placeholder="Search client…" label="Search client" />
      </div>
      <div className="tbl-scroll">
        <table className="pf-subs">
          <thead>
            <tr>
              <th>Client</th>
              <th>Plan</th>
              <th style={{ textAlign: "right" }}>MRR</th>
              <th>{tab === "active" ? "Next charge" : "Resumes"}</th>
              <th aria-label="Stripe" />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr><td colSpan={5} className="mut" style={{ textAlign: "center", padding: 28 }}>{needle ? `No ${tab} subscription matches “${q.trim()}”.` : `No ${tab} subscriptions.`}</td></tr>
            ) : (
              shown.map((r) => {
                const href = r.clientId ? `/roster?client=${r.clientId}` : null;
                return (
                  <tr
                    key={r.id}
                    data-pf-sub={r.state}
                    className={href ? "pf-clickable" : undefined}
                    tabIndex={href ? 0 : undefined}
                    onClick={href ? () => window.location.assign(href) : undefined}
                    onKeyDown={href ? (e) => { if (e.key === "Enter") window.location.assign(href); } : undefined}
                    title={href ? `Open ${r.client} in Clients` : "No client is tied to this subscription"}
                  >
                    <td>
                      <div className="cname">{r.client}</div>
                      <div className="csince">{r.clientId ? (r.market ?? "No area on the record") : "Not tied to a client"}</div>
                    </td>
                    <td>{r.plan ? (PLAN_LABEL[r.plan] ?? r.plan) : <span className="mut">—</span>}</td>
                    <td className="tnum" style={{ textAlign: "right" }} title={`${usd2(r.amount)} ${r.every}`}>{usd(r.mrr)}</td>
                    <td className="tnum">
                      {tab === "active" ? dayLabel(r.nextCharge) : r.resumes ? dayLabel(r.resumes) : <span className="mut">No date set</span>}
                    </td>
                    <td>
                      <a
                        className="pf-stripe" href={`https://dashboard.stripe.com/subscriptions/${r.id}`} target="_blank" rel="noopener"
                        title="Open this subscription in Stripe" aria-label={`Open ${r.client}'s subscription in Stripe`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        Stripe ↗
                      </a>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <p className="pf-panel-note">A row opens the client in Clients. MRR is Stripe&rsquo;s monthly figure for the subscription (hover for the amount charged each cycle).</p>
    </Drawer>
  );
}

/* "$6,624 not tied to a client — what are these?" (13 Oct): the Stripe customers that money came from. */
function UnattributedPanel({
  open, onClose, customers, total,
}: {
  open: boolean;
  onClose: () => void;
  customers: NonNullable<Performance["facts"]["unattributed"]>;
  total: number;
}) {
  return (
    <Drawer
      open={open} onClose={onClose} label="Money not tied to a client"
      title={`${usd(total)} not tied to a client`}
      subtitle="Money Stripe collected from customers that no client record is linked to"
    >
      <div className="tbl-scroll" data-pf-unattributed-list>
        <table className="pf-subs">
          <thead>
            <tr><th>Stripe customer</th><th style={{ textAlign: "right" }}>Collected</th><th style={{ textAlign: "right" }}>Charges</th><th>First – last</th><th aria-label="Stripe" /></tr>
          </thead>
          <tbody>
            {customers.length === 0 ? (
              <tr><td colSpan={5} className="mut" style={{ textAlign: "center", padding: 28 }}>Every charge is tied to a client.</td></tr>
            ) : (
              customers.map((c) => (
                <tr key={c.customerId ?? "none"}>
                  <td>
                    <div className="cname">{c.name ?? (c.customerId ? "Unnamed customer" : "No customer on the charge")}</div>
                    <div className="csince">{c.email ?? "no email"}</div>
                  </td>
                  <td className="tnum" style={{ textAlign: "right" }}>{usd2(c.amount)}</td>
                  <td className="tnum" style={{ textAlign: "right" }}>{c.charges}</td>
                  <td className="tnum">{c.first === c.last ? dayLabel(c.first) : `${dayLabel(c.first)} – ${dayLabel(c.last)}`}</td>
                  <td>
                    {c.customerId ? (
                      <a className="pf-stripe" href={`https://dashboard.stripe.com/customers/${c.customerId}`} target="_blank" rel="noopener" title="Open this customer in Stripe">Stripe ↗</a>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="pf-panel-note">
        A customer is tied to a client by the Stripe ids on the client&rsquo;s record, by a subscription it owns, or by its name matching
        the client&rsquo;s. To tie one of these to a client, open the client in Clients → Billing and link the Stripe customer.
      </p>
    </Drawer>
  );
}

/** The billing calendar: who is charged what, day by day, for the next 30 days. */
function BillingCalendar({ performance }: { performance: Performance }) {
  const b = performance.billing;
  if (!b) {
    return (
      <p className="ds-note">
        The billing calendar is unavailable — Stripe could not be read{performance.billingError ? ` (${performance.billingError})` : ""}.
      </p>
    );
  }
  const days = new Map<string, typeof b.upcoming>();
  for (const u of b.upcoming) days.set(u.date, [...(days.get(u.date) ?? []), u]);
  const total = b.upcoming.reduce((t, u) => t + u.amount, 0);
  const fmt = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <div className="tbl-wrap">
      <div className="tbl-head">
        <div>
          <div className="tbl-title">Upcoming billing</div>
          <div className="tbl-sub">Next 30 days · {b.upcoming.length} charges · ${Math.round(total).toLocaleString("en-US")} expected, from each live subscription&rsquo;s next charge date in Stripe</div>
        </div>
      </div>
      <div className="tbl-scroll">
        <table>
          <thead><tr><th>Date</th><th>Client</th><th>Amount</th><th>Cycle</th></tr></thead>
          <tbody>
            {[...days.entries()].map(([date, list]) => list.map((u, i) => (
              <tr key={`${date}-${i}`}>
                <td className="tnum">{i === 0 ? <b>{fmt(date)}</b> : null}</td>
                <td>{u.client ?? <span className="mut">Not tied to a client</span>}</td>
                <td className="tnum">${u.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}</td>
                <td className="mut">{u.every}</td>
              </tr>
            )))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/*
 * The public screen. `initial` is set only when the page was opened here —
 * then it server-renders with no loading state and no second round trip.
 * Otherwise it fetches on first visit and stays mounted, so returning to it is
 * instant. See `Lazy` for why every route no longer pays for this data.
 */
export function PerformanceScreen({ initial }: { initial: Performance | null }) {
  return (
    <Lazy<Performance>
      initial={initial}
      url="/api/workspace/performance"
      label="Performance"
      skeleton={<PlaceholderScreen cards={4} />}
    >
      {(d) => <PerformanceView performance={d} />}
    </Lazy>
  );
}

/*
 * Performance › Billing Calendar (9 Oct, OS feedback): the calendar that sat
 * at the foot of Overview, on its own page. Same data and the same request as
 * Overview — `Lazy` shares one fetch per URL — so moving between the two
 * costs nothing.
 */
export function BillingCalendarScreen({ initial }: { initial: Performance | null }) {
  return (
    <Lazy<Performance>
      initial={initial}
      url="/api/workspace/performance"
      label="Billing Calendar"
      skeleton={<PlaceholderScreen cards={0} />}
    >
      {(d) => (
        <>
          <div className="hero"><PageHeader icon="performance" title="Billing Calendar" description="Every live subscription's charges in the next 30 days, from Stripe" /></div>
          <div className="wrap">
            <BillingCalendar performance={d} />
            <p style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 14, lineHeight: 1.7, maxWidth: "80ch" }}>
              Each charge is a live subscription&rsquo;s next charge date in Stripe, and the ones after it on the same
              cycle. Paused subscriptions are left out. MRR, ARR and growth are on <a href="/performance">Overview</a>.
            </p>
          </div>
        </>
      )}
    </Lazy>
  );
}
