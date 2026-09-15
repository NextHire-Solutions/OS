"use client";

import { useMemo, useState } from "react";

import { DASH, fullNumber, percent } from "@/lib/tools/analytics/format.ts";
import { dateStamp } from "@/lib/workspace/dates";
import { INFRASTRUCTURE_URL, useAnalyticsData } from "./actions";
import {
  BAND_COLOR,
  BAND_INK,
  BAND_LABEL,
  BAND_ORDER,
  BAND_RANGE,
  BOUNCE_HIGH,
  BOUNCE_METER_CEILING,
  bounceTone,
} from "./palette";
import {
  AnalyticsTabs,
  Bar,
  Box,
  EmptyRow,
  LoadError,
  Pager,
  Search,
  Seg,
  SortHeader,
  useDebounced,
  useSort,
} from "./shared";

/*
 * Campaign Analytics — Infrastructure.
 *
 * The tool's `/analytics/infrastructure`: the sending estate, lifetime. It is
 * the one analytics screen with no filter bar at all — every figure here is a
 * lifetime inbox total and would not respond to a date range, so showing one
 * would be a control that does nothing.
 *
 * Two things the tool gets wrong are fixed here rather than reproduced, and
 * both are noted in ANALYTICS-PARITY.md:
 *
 *   · the inbox table renders 100 rows under a header saying "1,796 inboxes",
 *     with no pager anywhere — the route supports limit/offset and the view
 *     never sends them. This pages properly.
 *   · sorting and four of the five filters are inert on the Instantly estate
 *     (`analytics_instantly_account_rows` takes no sort and no bands), while
 *     the controls stay interactive and show sorted state. Here they are hidden
 *     on that estate instead, because a control that does nothing is worse than
 *     an absent one.
 */

type View = "domain" | "provider" | "vendor" | "inbox";

interface Totals {
  inboxes: number;
  sending: number;
  domains: number;
  providers: number;
  sent: number;
  bounced: number;
  replied: number;
  bounce_rate: number | null;
  reply_rate: number | null;
  disconnected: number;
}

interface InboxRow {
  id: number;
  email: string;
  name: string | null;
  domain: string | null;
  provider: string | null;
  status: string | null;
  vendor: string | null;
  daily_limit: number | null;
  sent: number;
  bounced: number;
  replied: number;
  bounce_rate: number | null;
  reply_rate: number | null;
}

interface GroupRow {
  label: string;
  inboxes: number;
  sent: number;
  bounced: number;
  replied: number;
  bounce_rate: number | null;
  reply_rate: number | null;
  disconnected: number;
}

interface DeadRow {
  id: number;
  email: string;
  domain: string | null;
  vendor: string | null;
  provider: string | null;
  status: string | null;
  sent: number;
  bounced: number;
  daily_limit: number | null;
  last_sent_at: string | null;
}

interface Band {
  band: string;
  domains: number;
  inboxes: number;
  sent: number;
  bounced: number;
}

interface Recipient {
  label: string;
  leads: number;
  bounced: number;
  events: number;
  rate: number | null;
  domains: number;
}

interface InfraResponse {
  estate: "emailbison" | "instantly";
  view: View;
  totals: Totals;
  rows: Array<InboxRow | GroupRow>;
  total: number;
  problems: InboxRow[];
  bands: Band[];
  providers: GroupRow[];
  disconnected: DeadRow[];
  vendors: Array<{ vendor: string; inboxes: number }>;
  recipients: Recipient[];
  rcptGroup: "esp" | "domain";
  rcptMinLeads: number;
  minSent: number;
  degraded?: string[];
}

const PROVIDER_LABEL: Record<string, string> = {
  google_workspace_oauth: "Google Workspace",
  microsoft_oauth: "Microsoft 365",
  custom: "Custom SMTP",
  smtp: "SMTP",
  unknown: "Unknown",
};

const providerLabel = (p: string | null) => (p ? PROVIDER_LABEL[p] ?? p : "Unknown");

const PAGE_SIZE = 100;

export function AnalyticsInfrastructureScreen() {
  const [estate, setEstate] = useState<"emailbison" | "instantly">("emailbison");
  const [view, setView] = useState<View>("domain");
  const [rawQ, setRawQ] = useState("");
  const q = useDebounced(rawQ);
  const [bands, setBands] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [provider, setProvider] = useState("");
  const [vendor, setVendor] = useState("");
  const [minTotal, setMinTotal] = useState(0);
  const [rcpt, setRcpt] = useState<"esp" | "domain">("esp");
  const [page, setPage] = useState(1);
  const { sort, toggle } = useSort();

  const isInstantly = estate === "instantly";

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    p.set("estate", estate);
    p.set("view", view);
    if (q.trim()) p.set("q", q.trim());
    if (sort) { p.set("sort", sort.key); p.set("dir", sort.dir); }
    for (const b of bands) p.append("band", b);
    if (status) p.append("status", status);
    if (provider) p.append("provider", provider);
    if (vendor) p.append("vendor", vendor);
    if (minTotal > 0) p.set("min_total", String(minTotal));
    p.set("rcpt", rcpt);
    if (view === "inbox") {
      p.set("limit", String(PAGE_SIZE));
      p.set("offset", String((page - 1) * PAGE_SIZE));
    }
    return p.toString();
  }, [estate, view, q, sort, bands, status, provider, vendor, minTotal, rcpt, page]);

  const { data, error, loading } = useAnalyticsData<InfraResponse>(INFRASTRUCTURE_URL(qs));

  if (error) return <LoadError what="Infrastructure" error={error} />;

  const t = data?.totals;
  const bandTotal = (data?.bands ?? []).reduce((s, b) => s + b.domains, 0);
  const bandSent = (data?.bands ?? []).reduce((s, b) => s + b.sent, 0);
  const orderedBands = [...(data?.bands ?? [])].sort(
    (a, b) => (BAND_ORDER[a.band] ?? 9) - (BAND_ORDER[b.band] ?? 9),
  );
  /*
   * The "Needs attention" meter is scaled to the WORST rate in the list, not
   * to a fixed 5% ceiling.
   *
   * This list is by definition the worst inboxes in the estate, so every entry
   * cleared the fixed ceiling and every bar rendered at exactly 100%. Eight
   * identical full-width bars beside rates running 13.8% down to 9.1% — a
   * meter that could not discriminate in the one place it was used. Scaled to
   * the list, the worst is full and the rest are honestly shorter.
   */
  const worstBounce = (data?.problems ?? []).reduce(
    (m, p) => Math.max(m, p.bounce_rate ?? 0),
    0,
  );
  const hasFilters = Boolean(bands.length || status || provider || vendor || minTotal);

  return (
    <div className="an-screen">
      <AnalyticsTabs active="infrastructure" />
      <div className="wrap" style={{ opacity: loading && !data ? 0.6 : 1, transition: "opacity .14s" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="tbl-title" style={{ fontSize: 19 }}>Infrastructure</div>
          <div className="tbl-sub">
            {t ? `${fullNumber(t.sending)} of ${fullNumber(t.inboxes)} inboxes sending` : "Loading…"}
          </div>
        </div>
        <Seg
          label="Estate"
          value={estate}
          options={[
            { value: "emailbison", label: "EmailBison" },
            { value: "instantly", label: "Instantly" },
          ]}
          onChange={(e) => {
            setEstate(e);
            // Instantly has no provider or vendor grouping. Staying on one
            // would show an empty table under a heading that promises rows.
            if (e === "instantly" && (view === "provider" || view === "vendor")) setView("domain");
            setPage(1);
          }}
        />
      </div>

      {data?.degraded?.length ? (
        <div className="anno" style={{ margin: "0 0 18px" }}>
          <b>Some cards could not be loaded ({data.degraded.join(", ")}).</b> Everything else on this
          page is current — those sections are blank because their query failed, not because the
          data is empty.
        </div>
      ) : null}

      <div className="grid2" style={{ gridTemplateColumns: "1.35fr 1fr", marginBottom: 20 }}>
        <div className="abox">
          <div className="abox-h"><h2>Health</h2><span className="note">lifetime</span></div>
          <div style={{ padding: 22 }}>
            <div style={{ display: "flex", gap: 30, flexWrap: "wrap", marginBottom: 20 }}>
              <div>
                <div className="card-l">Bounce rate</div>
                <div
                  className="card-n tnum"
                  style={{ fontSize: 40, color: bounceTone(t?.bounce_rate ?? null) }}
                >
                  {percent(t?.bounce_rate ?? null, 2)}
                </div>
                <div className="card-s">
                  {fullNumber(t?.bounced ?? null)} bounced of {fullNumber(t?.sent ?? null)} sent ·
                  {" "}{percent(BOUNCE_HIGH, 0)} is the danger line
                </div>
              </div>
              <div>
                <div className="card-l">Reply rate</div>
                <div className="card-n tnum" style={{ fontSize: 28 }}>{percent(t?.reply_rate ?? null, 2)}</div>
                <div className="card-s">{fullNumber(t?.replied ?? null)} replies</div>
              </div>
            </div>

            {bandTotal > 0 ? (
              <>
                <div className="card-l">Sending domains by bounce band</div>
                {/*
                 * The bar is a share of VOLUME, which is what every label under
                 * it says. It used to be sized by domain COUNT while the labels
                 * read "% of volume" — so 249 critical domains carrying 3% of
                 * the sending drew a bar half the width of the card, and the
                 * honest reading of that picture was "half our volume is
                 * critical". The number under each band is still the domain
                 * count; the bar and the caption now measure the same thing.
                 *
                 * Ordered healthy → watch → critical → never sent, not by
                 * whatever order the query returned (which was alphabetical, so
                 * Critical came first and the severity ramp ran backwards).
                 */}
                <div className="stack" style={{ marginBottom: 12 }}>
                  {orderedBands.map((b) => (
                    <i
                      key={b.band}
                      title={`${BAND_LABEL[b.band] ?? b.band}: ${fullNumber(b.domains)} domains, ${percent(bandSent > 0 ? b.sent / bandSent : null, 1)} of volume`}
                      style={{
                        display: "block",
                        width: `${bandSent > 0 ? (b.sent / bandSent) * 100 : 0}%`,
                        background: BAND_COLOR[b.band] ?? "var(--muted)",
                        height: "100%",
                      }}
                    />
                  ))}
                </div>
                <div className="an-bands">
                  {orderedBands.map((b) => (
                    <div key={b.band}>
                      <div style={{ fontSize: 12, color: BAND_INK[b.band] ?? "var(--muted)", fontWeight: 600 }}>
                        {BAND_LABEL[b.band] ?? b.band}{" "}
                        <span className="mut" style={{ fontWeight: 500 }}>{BAND_RANGE[b.band]}</span>
                      </div>
                      <div className="tnum" style={{ fontSize: 17, fontWeight: 600, color: "var(--ink)" }}>
                        {fullNumber(b.domains)}
                      </div>
                      <div className="csince">
                        {b.domains === 1 ? "domain" : "domains"} ·{" "}
                        {percent(bandSent > 0 ? b.sent / bandSent : null, 0)} of volume
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            {(data?.providers ?? []).length ? (
              <div style={{ marginTop: 22 }}>
                <div className="card-l">By provider</div>
                <table className="atbl">
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th style={{ textAlign: "right" }}>Inboxes</th>
                      <th style={{ textAlign: "right" }}>Sent</th>
                      <th style={{ textAlign: "right" }}>Bounce %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.providers ?? []).map((p) => (
                      <tr key={p.label}>
                        <td>{providerLabel(p.label)}</td>
                        <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(p.inboxes)}</td>
                        <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(p.sent)}</td>
                        <td className="tnum" style={{ textAlign: "right", color: bounceTone(p.bounce_rate) }}>
                          {percent(p.bounce_rate, 2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        </div>

        <div className="abox">
          <div className="abox-h">
            <h2>Needs attention</h2>
            <span className="note">worst bounce, {data?.minSent ?? 50}+ sends</span>
          </div>
          <div style={{ padding: "8px 22px 20px" }}>
            {(data?.problems ?? []).length === 0 ? (
              <div className="mut" style={{ padding: "24px 0" }}>
                {data ? "No inbox is above the threshold." : "Loading…"}
              </div>
            ) : (
              (data?.problems ?? []).slice(0, 8).map((p) => (
                <div key={p.id} style={{ padding: "9px 0", borderTop: "1px solid var(--line-soft)" }}>
                  <div style={{ display: "flex", gap: 10, fontSize: 12.5, marginBottom: 5 }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.email}
                    </span>
                    <span className="tnum" style={{ color: bounceTone(p.bounce_rate), fontWeight: 600 }}>
                      {percent(p.bounce_rate, 1)}
                    </span>
                  </div>
                  <Bar
                    fraction={worstBounce > 0 ? (p.bounce_rate ?? 0) / worstBounce : 0}
                    color={bounceTone(p.bounce_rate)}
                  />
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {!isInstantly && (data?.recipients ?? []).length ? (
        <Box
          title="Where bounces land"
          note={`Lifetime. Counted as people, not messages — ${data?.rcptMinLeads ?? 50}+ contacted.`}
          right={
            <Seg
              label="Group recipients by"
              value={rcpt}
              options={[
                { value: "esp", label: "Provider" },
                { value: "domain", label: "Domain" },
              ]}
              onChange={setRcpt}
            />
          }
        >
          <div className="tbl-scroll">
            <table className="atbl" style={{ minWidth: 640 }}>
              <thead>
                <tr>
                  <th>Recipient</th>
                  <th style={{ textAlign: "right" }}>Contacted</th>
                  <th style={{ textAlign: "right" }}>Bounced</th>
                  <th style={{ width: 190 }}>Share rejected</th>
                </tr>
              </thead>
              <tbody>
                {(data?.recipients ?? []).map((r) => (
                  <tr key={r.label}>
                    <td>
                      {r.label}
                      {rcpt === "esp" && r.domains > 1 ? (
                        <span className="c c-camp" style={{ marginLeft: 8 }}>{r.domains} domains</span>
                      ) : null}
                    </td>
                    <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(r.leads)}</td>
                    <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(r.bounced)}</td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                        <span className="tnum" style={{ width: 48, fontSize: 12.5 }}>{percent(r.rate, 0)}</span>
                        <span style={{ flex: 1 }}>
                          <Bar
                            fraction={r.rate ?? 0}
                            color={(r.rate ?? 0) >= 0.5 ? "var(--red)" : (r.rate ?? 0) >= 0.15 ? "var(--yellow)" : "var(--muted)"}
                          />
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Box>
      ) : null}

      {!isInstantly && (data?.disconnected ?? []).length ? (
        <Box
          title="Disconnected inboxes"
          note={`${(data?.disconnected ?? []).filter((d) => d.sent > 0).length} were sending · ${
            (data?.disconnected ?? []).filter((d) => d.sent === 0).length
          } never did`}
          right={<span className="badge s-risk">{(data?.disconnected ?? []).length}</span>}
        >
          <div className="tbl-scroll" style={{ maxHeight: 352, overflowY: "auto" }}>
            <table className="atbl" style={{ minWidth: 780 }}>
              <thead>
                <tr>
                  <th>Mailbox</th>
                  <th>Vendor</th>
                  <th>Status</th>
                  <th style={{ textAlign: "right" }}>Sent</th>
                  <th style={{ textAlign: "right" }}>Bounced</th>
                  <th>Last send</th>
                </tr>
              </thead>
              <tbody>
                {(data?.disconnected ?? []).map((d) => (
                  <tr key={d.id}>
                    <td>
                      <span style={{ color: "var(--ink)", fontWeight: 500 }}>{d.email.split("@")[0]}</span>
                      <span className="mut">@{d.domain}</span>
                    </td>
                    <td>{d.vendor ?? <span className="mut">Untagged</span>}</td>
                    <td>
                      <span className={`badge ${d.status === "Failed" ? "s-risk" : "s-ok"}`}>
                        {d.status ?? "Unknown"}
                      </span>
                    </td>
                    <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(d.sent)}</td>
                    <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(d.bounced)}</td>
                    <td className="mut">{d.last_sent_at ? dateStamp(d.last_sent_at) : DASH}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Box>
      ) : null}

      <Box
        title="The estate"
        note={
          data
            ? view === "inbox"
              ? `${fullNumber(data.total)} inboxes`
              : `${data.rows.length} ${view === "domain" ? "domains" : view === "vendor" ? "vendors" : "providers"}`
            : undefined
        }
        right={
          <>
            <Seg
              label="Group by"
              value={view}
              options={
                isInstantly
                  ? [
                      { value: "domain" as View, label: "Domain" },
                      { value: "inbox" as View, label: "Inbox" },
                    ]
                  : [
                      { value: "domain" as View, label: "Domain" },
                      { value: "provider" as View, label: "Provider" },
                      { value: "vendor" as View, label: "Vendor" },
                      { value: "inbox" as View, label: "Inbox" },
                    ]
              }
              onChange={(v) => { setView(v); setPage(1); }}
            />
            <Search
              value={rawQ}
              onChange={(v) => { setRawQ(v); setPage(1); }}
              placeholder={view === "inbox" ? "Search mailboxes…" : "Search…"}
            />
          </>
        }
      >
        {/*
          Every filter below is honoured only on the EmailBison estate — the
          Instantly RPC takes none of them. The tool leaves the controls up and
          silently ignores the clicks; here they are simply absent, so nothing
          on screen claims to be doing something it is not.
        */}
        {!isInstantly ? (
          <div className="an-filter" style={{ borderTop: "1px solid var(--line-soft)" }}>
            <div className="qr" role="group" aria-label="Bounce band">
              {(["high", "watch", "ok", "unsent"] as const).map((b) => (
                <button
                  key={b}
                  type="button"
                  className={bands.includes(b) ? "on" : ""}
                  aria-pressed={bands.includes(b)}
                  onClick={() => {
                    setBands((cur) => (cur.includes(b) ? cur.filter((x) => x !== b) : [...cur, b]));
                    setPage(1);
                  }}
                >
                  {BAND_LABEL[b]}
                </button>
              ))}
            </div>
            <select
              className="sel"
              aria-label="Minimum volume"
              value={minTotal}
              onChange={(e) => { setMinTotal(Number(e.target.value)); setPage(1); }}
            >
              <option value={0}>Any volume</option>
              <option value={50}>50+ sent</option>
              <option value={500}>500+ sent</option>
              <option value={1000}>1,000+ sent</option>
            </select>
            <select
              className="sel"
              aria-label="Connection status"
              value={status}
              onChange={(e) => { setStatus(e.target.value); setPage(1); }}
            >
              <option value="">Any status</option>
              <option value="Connected">Connected</option>
              <option value="Not connected">Not connected</option>
              <option value="Failed">Failed</option>
            </select>
            {/*
              The two providers the estate actually has — the tool's own fixed
              pair, not read from the data, because `provider` is an enum of
              EmailBison's connection types rather than a tag anyone can add.
              The route reads it as `provider`, repeated.
            */}
            <select
              className="sel"
              aria-label="Provider"
              value={provider}
              onChange={(e) => { setProvider(e.target.value); setPage(1); }}
            >
              <option value="">All providers</option>
              <option value="google_workspace_oauth">Google Workspace</option>
              <option value="custom">Custom SMTP</option>
            </select>
            <select
              className="sel"
              aria-label="Vendor"
              value={vendor}
              onChange={(e) => { setVendor(e.target.value); setPage(1); }}
            >
              <option value="">Any vendor</option>
              {(data?.vendors ?? []).map((v) => (
                <option key={v.vendor} value={v.vendor}>
                  {v.vendor === "untagged" ? "Untagged" : v.vendor} ({v.inboxes})
                </option>
              ))}
            </select>
            {hasFilters ? (
              <button
                type="button"
                className="gh"
                onClick={() => { setBands([]); setStatus(""); setProvider(""); setVendor(""); setMinTotal(0); setPage(1); }}
              >
                Clear
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="tbl-scroll">
          <table className="atbl" style={{ minWidth: view === "inbox" ? 1020 : 760 }}>
            <thead>
              {view === "inbox" ? (
                <tr>
                  <SortHeader label="Domain" sortKey="domain" sort={sort} onToggle={toggle} width={210} />
                  <SortHeader label="Mailbox" sortKey="email" sort={sort} onToggle={toggle} width={260} />
                  {!isInstantly ? (
                    <SortHeader label="Provider" sortKey="provider" sort={sort} onToggle={toggle} />
                  ) : null}
                  {!isInstantly ? (
                    <SortHeader label="Vendor" sortKey="vendor" sort={sort} onToggle={toggle} />
                  ) : null}
                  <SortHeader label="Sent" sortKey="sent" sort={sort} onToggle={toggle} align="right" />
                  <SortHeader label="Bounced" sortKey="bounced" sort={sort} onToggle={toggle} align="right" />
                  <SortHeader label="Reply %" sortKey="reply_rate" sort={sort} onToggle={toggle} align="right" />
                  <SortHeader label="Bounce rate" sortKey="bounce_rate" sort={sort} onToggle={toggle} width={180} />
                </tr>
              ) : (
                <tr>
                  <SortHeader label="Label" sortKey="label" sort={sort} onToggle={toggle} width={280} />
                  <SortHeader label="Inboxes" sortKey="inboxes" sort={sort} onToggle={toggle} align="right" />
                  {view === "vendor" ? (
                    <SortHeader label="Dead" sortKey="disconnected" sort={sort} onToggle={toggle} align="right" />
                  ) : null}
                  <SortHeader label="Sent" sortKey="sent" sort={sort} onToggle={toggle} align="right" />
                  <SortHeader label="Bounced" sortKey="bounced" sort={sort} onToggle={toggle} align="right" />
                  <SortHeader label="Reply %" sortKey="reply_rate" sort={sort} onToggle={toggle} align="right" />
                  <SortHeader label="Bounce rate" sortKey="bounce_rate" sort={sort} onToggle={toggle} width={180} />
                </tr>
              )}
            </thead>
            <tbody>
              {(data?.rows ?? []).length === 0 ? (
                <EmptyRow colSpan={8}>
                  {!data
                    ? "Loading…"
                    : hasFilters || q
                      ? "No inboxes match these filters."
                      : "Nothing to show. Run sync-senders if this is unexpected."}
                </EmptyRow>
              ) : view === "inbox" ? (
                (data!.rows as InboxRow[]).map((r) => (
                  <tr key={r.id}>
                    <td className="mut">{r.domain}</td>
                    <td style={{ color: "var(--ink)" }}>{r.email}</td>
                    {!isInstantly ? <td>{providerLabel(r.provider)}</td> : null}
                    {!isInstantly ? <td>{r.vendor ?? <span className="mut">Untagged</span>}</td> : null}
                    <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(r.sent)}</td>
                    <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(r.bounced)}</td>
                    <td className="tnum" style={{ textAlign: "right" }}>{percent(r.reply_rate, 2)}</td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                        <span className="tnum" style={{ width: 52, fontSize: 12.5, color: bounceTone(r.bounce_rate) }}>
                          {percent(r.bounce_rate, 2)}
                        </span>
                        <span style={{ flex: 1 }}>
                          <Bar fraction={(r.bounce_rate ?? 0) / BOUNCE_METER_CEILING} color={bounceTone(r.bounce_rate)} />
                        </span>
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                (data!.rows as GroupRow[]).map((r) => (
                  <tr key={r.label}>
                    <td style={{ color: "var(--ink)" }}>
                      {view === "provider" ? providerLabel(r.label) : r.label === "untagged" ? "Untagged" : r.label}
                    </td>
                    <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(r.inboxes)}</td>
                    {view === "vendor" ? (
                      <td className="tnum" style={{ textAlign: "right", color: r.disconnected ? "var(--red)" : undefined }}>
                        {fullNumber(r.disconnected)}
                      </td>
                    ) : null}
                    <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(r.sent)}</td>
                    <td className="tnum" style={{ textAlign: "right" }}>{fullNumber(r.bounced)}</td>
                    <td className="tnum" style={{ textAlign: "right" }}>{percent(r.reply_rate, 2)}</td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                        <span className="tnum" style={{ width: 52, fontSize: 12.5, color: bounceTone(r.bounce_rate) }}>
                          {percent(r.bounce_rate, 2)}
                        </span>
                        <span style={{ flex: 1 }}>
                          <Bar fraction={(r.bounce_rate ?? 0) / BOUNCE_METER_CEILING} color={bounceTone(r.bounce_rate)} />
                        </span>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {/*
          The tool has no pager here at all: it renders the route's default 100
          rows beneath a header stating the true total of 1,796. That is the
          "looks complete at exactly the point it stopped being complete"
          failure this repo keeps re-learning.
        */}
        {view === "inbox" && data ? (
          <Pager page={page} pageSize={PAGE_SIZE} total={data.total} onPage={setPage} />
        ) : null}
      </Box>

      <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.55 }}>
        Lifetime figures. These do not respond to a date range, which is why this screen has no
        filter bar — an inbox&rsquo;s health is the whole of its history, not a window of it.
      </div>
      </div>
    </div>
  );
}

