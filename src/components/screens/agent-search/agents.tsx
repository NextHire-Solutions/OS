"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  Agent, AgentPage, AgentSearchOverview, AgentSort,
} from "@/lib/tools/agent-search/agents";
import { Lazy, PlaceholderScreen } from "../lazy";
import { dateStamp } from "@/lib/workspace/dates";

/*
 * Agent Search — the agent database.
 *
 * 1.17 million agents, so this screen is server-paged and cannot be otherwise:
 * every other table in the workspace filters and sorts in the browser because
 * it holds forty rows, and doing that here would mean downloading a million.
 *
 * Consequences that shape the whole component:
 *
 *   searching is a round trip, so it is debounced. Firing a query per keystroke
 *   would put twelve requests in flight for "compass" and paint whichever
 *   returned last, which is not necessarily the one that was typed.
 *
 *   responses are matched to the request that asked for them. Without that, a
 *   slow early query landing after a fast later one silently shows results for
 *   a term the reader has already replaced.
 *
 *   the previous page stays on screen while the next loads, dimmed. Blanking
 *   the table on every keystroke makes a fast search feel broken.
 */

const SORTS: { id: AgentSort; label: string }[] = [
  { id: "volume", label: "Sales volume" },
  { id: "transactions", label: "Transactions" },
  { id: "recent", label: "Recently updated" },
  { id: "name", label: "Name" },
];

export function AgentSearchScreen({ initial }: { initial: AgentSearchOverview | null }) {
  return (
    <Lazy<AgentSearchOverview>
      initial={initial}
      url="/api/tools/agent-search"
      label="Agent Search"
      skeleton={<PlaceholderScreen cards={4} />}
    >
      {(overview) => <AgentsView overview={overview} />}
    </Lazy>
  );
}

function AgentsView({ overview }: { overview: AgentSearchOverview }) {
  const [q, setQ] = useState("");
  const [state, setState] = useState("");
  const [sort, setSort] = useState<AgentSort>("volume");
  const [page, setPage] = useState(1);

  const [result, setResult] = useState<AgentPage | null>(null);
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);

  /*
   * Only the newest request may paint.
   *
   * Searches race: "com" can outlive "compass" on a slow link, and without
   * this the table would settle on results for a term nobody is looking at.
   */
  const latest = useRef(0);

  const load = useCallback(async (query: { q: string; state: string; sort: AgentSort; page: number }) => {
    const ticket = ++latest.current;
    setBusy(true);
    try {
      const params = new URLSearchParams({
        q: query.q, state: query.state, sort: query.sort, page: String(query.page),
      });
      const res = await fetch(`/api/tools/agent-search/agents?${params}`, {
        credentials: "same-origin",
      });
      const body = (await res.json()) as AgentPage & { error?: string };
      if (ticket !== latest.current) return;
      if (!res.ok) throw new Error(body?.error ?? `Search failed (${res.status})`);
      setResult(body);
      setFailed(body.error ?? null);
    } catch (error) {
      if (ticket !== latest.current) return;
      setFailed(error instanceof Error ? error.message : "Search failed");
    } finally {
      if (ticket === latest.current) setBusy(false);
    }
  }, []);

  // Debounced: a query per keystroke would be twelve round trips for "compass".
  useEffect(() => {
    const t = setTimeout(() => load({ q, state, sort, page }), q || state ? 300 : 0);
    return () => clearTimeout(t);
  }, [q, state, sort, page, load]);

  // Any change to the query resets to the first page — page 7 of the old
  // results has nothing to do with the new ones.
  const change = (fn: () => void) => { fn(); setPage(1); };

  const total = result?.total ?? null;
  const pageSize = result?.pageSize ?? 25;
  const lastPage = total !== null ? Math.max(1, Math.ceil(total / pageSize)) : null;

  if (overview.error) {
    return (
      <div className="wrap">
        <div className="anno">
          <b>Agent Search could not be read.</b> {overview.error}. The scrapers themselves
          are unaffected — this is the workspace&rsquo;s connection to their database.
        </div>
      </div>
    );
  }

  return (
    <div className="wrap">
      <div className="cards" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
        <Card label="Agents" value={overview.agents} sub="in the database" tone="n-blue" />
        <Card label="Offices" value={overview.offices} sub="brokerages" />
        <Card label="MLS Boards" value={overview.mlsBoards} sub="covered" />
        <Card label="Saved Lists" value={overview.savedLists.length} sub="built by the team" />
      </div>

      <div className="tbl-wrap">
        <div className="tbl-head">
          <div>
            <div className="tbl-title">Agents</div>
            <div className="tbl-sub">
              {failed ? (
                <span style={{ color: "var(--red)" }}>{failed}</span>
              ) : total !== null ? (
                <>
                  {total.toLocaleString("en-US")} matching
                  {lastPage && lastPage > 1
                    ? ` · page ${result?.page ?? 1} of ${lastPage.toLocaleString("en-US")}`
                    : ""}
                </>
              ) : (
                "Searching…"
              )}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <input
              className="inp"
              placeholder="Search name or brokerage…"
              value={q}
              onChange={(e) => change(() => setQ(e.target.value))}
              aria-label="Search agents"
              style={{ minWidth: 230 }}
            />
            <input
              className="inp"
              placeholder="State"
              value={state}
              onChange={(e) => change(() => setState(e.target.value.toUpperCase().slice(0, 2)))}
              aria-label="Filter by state"
              maxLength={2}
              style={{ width: 78, textTransform: "uppercase" }}
            />
            <select
              className="inp"
              value={sort}
              onChange={(e) => change(() => setSort(e.target.value as AgentSort))}
              aria-label="Sort by"
              style={{ cursor: "pointer" }}
            >
              {SORTS.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Dimmed rather than blanked while loading: a table that empties on
            every keystroke reads as broken even when it is fast. */}
        <div
          className="tbl-scroll"
          style={{ opacity: busy && result ? 0.55 : 1, transition: "opacity .12s" }}
          aria-busy={busy}
        >
          <table style={{ minWidth: 1180 }}>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Brokerage</th>
                <th>Location</th>
                <th>Sales Volume</th>
                <th>Transactions</th>
                <th>Avg Sale</th>
                <th>Active</th>
                <th>MLS</th>
                <th>Contact</th>
              </tr>
            </thead>
            <tbody>
              {result && result.agents.length === 0 && !busy ? (
                <tr>
                  <td colSpan={9} style={{ padding: "34px 16px", textAlign: "center", color: "var(--muted)" }}>
                    No agents match {q.trim() ? `“${q.trim()}”` : "this filter"}
                    {state ? ` in ${state}` : ""}.
                  </td>
                </tr>
              ) : !result ? (
                Array.from({ length: 8 }, (_, i) => (
                  <tr key={i}>
                    <td colSpan={9} style={{ padding: "16px 0" }}>
                      <span style={{ display: "block", width: `${52 + ((i * 9) % 30)}%`, height: 13, borderRadius: 5, background: "var(--inset-2)" }} />
                    </td>
                  </tr>
                ))
              ) : (
                result.agents.map((a) => <Row key={a.id} a={a} />)
              )}
            </tbody>
          </table>
        </div>

        {lastPage && lastPage > 1 ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 22px" }}>
            <span style={{ fontSize: 12.5, color: "var(--muted)" }}>
              Showing {((result!.page - 1) * pageSize + 1).toLocaleString("en-US")}–
              {Math.min(result!.page * pageSize, total ?? 0).toLocaleString("en-US")} of{" "}
              {(total ?? 0).toLocaleString("en-US")}
            </span>
            <span className="pills" style={{ padding: 0 }}>
              <button className="fp" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}
                style={page <= 1 ? { opacity: 0.4, cursor: "not-allowed" } : undefined} aria-label="Previous page">
                ←
              </button>
              <button className="fp on" style={{ minWidth: 96 }} disabled>
                {result!.page.toLocaleString("en-US")} / {lastPage.toLocaleString("en-US")}
              </button>
              <button className="fp" onClick={() => setPage((p) => Math.min(lastPage, p + 1))} disabled={page >= lastPage}
                style={page >= lastPage ? { opacity: 0.4, cursor: "not-allowed" } : undefined} aria-label="Next page">
                →
              </button>
            </span>
          </div>
        ) : null}
      </div>

      {overview.savedLists.length > 0 ? (
        <div className="tbl-wrap" style={{ marginTop: 18 }}>
          <div className="tbl-head">
            <div>
              <div className="tbl-title">Saved Lists</div>
              <div className="tbl-sub">
                Built in Agent Search. Counts are the tool&rsquo;s own cached totals.
              </div>
            </div>
          </div>
          <div className="tbl-scroll">
            <table style={{ minWidth: 720 }}>
              <thead>
                <tr>
                  <th>List</th>
                  <th>Source</th>
                  <th>Agents</th>
                  <th>Shared</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {overview.savedLists.map((l) => (
                  <tr key={l.id}>
                    <td><div className="cname">{l.name}</div></td>
                    <td>{l.sourceMode ? <span className="tg">{l.sourceMode}</span> : <span className="api-none">—</span>}</td>
                    <td>{l.count !== null ? <span className="api-num tnum">{l.count.toLocaleString("en-US")}</span> : <span className="api-none">—</span>}</td>
                    <td className="mut">{l.shared ? "✓" : "—"}</td>
                    <td className="mut">{l.updatedAt ? dateStamp(l.updatedAt) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Row({ a }: { a: Agent }) {
  return (
    <tr>
      <td>
        <div className="cname">{a.name}</div>
        {a.title ? <div className="csince">{a.title}</div> : null}
      </td>
      <td>{a.officeName ? <span className="mut">{a.officeName}</span> : <span className="api-none">—</span>}</td>
      <td className="mut">
        {a.officeCity ? `${a.officeCity}${a.officeState ? `, ${a.officeState}` : ""}` : <span className="api-none">—</span>}
      </td>
      <td>{a.salesVolume !== null ? <span className="api-num tnum">{money(a.salesVolume)}</span> : <span className="api-none">—</span>}</td>
      <td>{a.closedTransactions !== null ? <span className="tnum">{a.closedTransactions.toLocaleString("en-US")}</span> : <span className="api-none">—</span>}</td>
      <td>{a.avgSalePrice !== null ? <span className="tnum mut">{money(a.avgSalePrice)}</span> : <span className="api-none">—</span>}</td>
      <td>{a.activeListings ? <span className="tnum">{a.activeListings}</span> : <span className="tnum" style={{ color: "var(--muted)" }}>0</span>}</td>
      <td>
        {a.primaryMls ? (
          <span className="tg" title={a.mlsCount && a.mlsCount > 1 ? `On ${a.mlsCount} boards` : undefined}>
            {a.primaryMls}{a.mlsCount && a.mlsCount > 1 ? ` +${a.mlsCount - 1}` : ""}
          </span>
        ) : (
          <span className="api-none">—</span>
        )}
      </td>
      <td>
        {a.email ? (
          <span
            className="mut"
            title={a.enrichedStatus ? `Enrichment: ${a.enrichedStatus}` : undefined}
            style={{ fontSize: 12.5 }}
          >
            {a.email}
          </span>
        ) : a.phone ? (
          <span className="mut" style={{ fontSize: 12.5 }}>{a.phone}</span>
        ) : (
          <span className="api-none">—</span>
        )}
      </td>
    </tr>
  );
}

/** Compact currency — a sales volume column of full figures is unreadable. */
function money(v: number): string {
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}K`;
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

function Card({
  label, value, sub, tone,
}: { label: string; value: number | null; sub: string; tone?: string }) {
  return (
    <div className="card">
      <div className="card-l">{label}</div>
      <div
        className={`card-n tnum${tone && value !== null ? ` ${tone}` : ""}`}
        style={value === null ? { color: "#B9C0CB" } : undefined}
      >
        {value === null ? "—" : value.toLocaleString("en-US")}
      </div>
      <div className="card-s">{sub}</div>
    </div>
  );
}
