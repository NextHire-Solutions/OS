"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { StatusDot } from "@/components/ds";
import { Cell, avatarStyle, initials, textOf } from "@/components/clients/cells";
import { ToolGlyph } from "@/components/shell/tool-glyph";
import {
  CATEGORIES, CATEGORY_LABEL, FIELDS, FIELD_BY_KEY, TOOL_VIEWS,
  type FieldCategory, type ToolViewId,
} from "@/lib/clients/field-registry";
import type { MasterClient, MasterClientList } from "@/lib/clients/master-list";
import { CLIENT_STATUSES, STATUS_MEANING, statusLabel, type ClientStatus } from "@/lib/clients/client-status";

import { ClientRecord } from "./client-record";
import { OnboardClient } from "./clients-onboard";
import { invalidate, loadOnce, PlaceholderScreen } from "./lazy";

/*
 * CLIENTS — THE MASTER CLIENT LIST.
 *
 * The client's document, §23: "We should be able to open one system and know
 * exactly who our clients are, their current status, their plan, their
 * lifecycle dates, their billing information, their assigned team, their
 * agents, their account manager, their campaigns, their relevant operational
 * information." This is that system.
 *
 *   Master record   every §6 field, in the document's four categories and its
 *                   own words, plus the §12 lifecycle dates.
 *   Tool views      §8, one per tool — the SAME record showing only the part
 *                   that tool needs (§5, §20), each field in the tool's own
 *                   list order.
 *   Data dictionary §15 — every field's definition, source of truth, who can
 *                   edit it, which tools use it, whether it syncs — and how
 *                   many clients have it filled in.
 *
 * Every column comes from field-registry.ts; every value from cells.tsx. A row
 * opens the client's record, where each field is edited in place.
 */

const DATA_URL = "/api/workspace/clients/master";

type Lens = "master" | ToolViewId | "dictionary";

const CAT_TONE: Record<FieldCategory, string> = {
  client: "cat-client", billing: "cat-billing", campaign: "cat-campaign", performance: "cat-performance", lifecycle: "cat-lifecycle",
};

const LENS_GLYPH: Record<string, string> = {
  master: "roster", health: "clients", database: "search", portal: "inbox", onboarding: "onboarding", analytics: "analytics", dictionary: "consistency",
};

/* The master record's columns: every registry field except the name, which is the pinned first column. */
const MASTER_COLUMNS = FIELDS.filter((f) => f.key !== "name");

function sortValue(k: string, c: MasterClient): string | number {
  const v = (c as unknown as Record<string, unknown>)[k];
  if (typeof v === "number") return v;
  if (k === "status") return CLIENT_STATUSES.indexOf(c.status);
  if (k === "performance" || k === "health") return c.health.period ? c.health.period.delivered / Math.max(1, c.health.period.target) : -1;
  if (k === "campaigns") return c.campaigns?.length ?? -1;
  if (k === "portal") return c.portal.count;
  if (k === "campaignMetrics") return c.analytics.sent ?? -1;
  if (k === "onboardingProgress" || k === "onboardingStatus") return c.onboarding.progress?.pct ?? -1;
  return textOf(k, c).toLowerCase() || "￿";
}

function ClientsView({ data, onChanged, only }: { data: MasterClientList; onChanged: () => void; only?: ToolViewId }) {
  const [lens, setLens] = useState<Lens>(only ?? "master");
  const [status, setStatus] = useState<ClientStatus | "all">("all");
  const [q, setQ] = useState("");
  const [hidden, setHidden] = useState<Set<FieldCategory>>(new Set());
  const [sort, setSort] = useState<{ k: string; dir: 1 | -1 }>({ k: "name", dir: 1 });
  const [openId, setOpenId] = useState<string | null>(null);

  // Deep link: /roster?view=database opens straight onto a tool's view.
  useEffect(() => {
    if (only) return;
    const v = new URLSearchParams(window.location.search).get("view");
    if (v && (v === "master" || v === "dictionary" || TOOL_VIEWS.some((t) => t.id === v))) setLens(v as Lens);
  }, [only]);
  const pickLens = (l: Lens) => {
    setLens(l);
    const u = new URL(window.location.href);
    if (l === "master") u.searchParams.delete("view"); else u.searchParams.set("view", l);
    window.history.replaceState(null, "", u);
  };

  const counts = useMemo(() => {
    const out: Record<ClientStatus, number> = { onboarding: 0, active: 0, paused: 0, churned: 0 };
    for (const c of data.clients) out[c.status] += 1;
    return out;
  }, [data.clients]);
  const total = data.clients.length;

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = data.clients.filter((c) =>
      (status === "all" || c.status === status) &&
      (!needle || [c.name, ...c.aliases, c.accountManager ?? "", c.salesperson ?? ""].some((s) => s.toLowerCase().includes(needle))),
    );
    return [...list].sort((a, b) => {
      const x = sortValue(sort.k, a), y = sortValue(sort.k, b);
      const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return cmp * sort.dir || a.name.localeCompare(b.name);
    });
  }, [data.clients, status, q, sort]);

  const view = TOOL_VIEWS.find((t) => t.id === lens) ?? null;
  const columns: { key: string; label: string; category?: FieldCategory }[] =
    lens === "master"
      ? MASTER_COLUMNS.filter((f) => !hidden.has(f.category)).map((f) => ({ key: f.key, label: f.label, category: f.category }))
      : view ? view.columns.filter((c) => c.key !== "name") : [];
  const firstLabel = view?.columns.find((c) => c.key === "name")?.label ?? "Client";

  const groups = lens === "master"
    ? CATEGORIES.filter((cat) => !hidden.has(cat)).map((cat) => ({ cat, span: columns.filter((c) => c.category === cat).length }))
    : [];

  const toggleSort = (k: string) => setSort((s) => ({ k, dir: s.k === k ? (s.dir === 1 ? -1 : 1) : 1 }));
  const open = openId ? data.clients.find((c) => c.id === openId) ?? null : null;

  function exportCsv() {
    const cols = [{ key: "name", label: firstLabel }, ...columns];
    const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = [cols.map((c) => esc(c.label)).join(","), ...rows.map((r) => cols.map((c) => esc(textOf(c.key, r))).join(","))];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = window.URL.createObjectURL(blob);
    a.download = `clients-${lens}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    window.URL.revokeObjectURL(a.href);
  }

  return (
    <div className="cx-page">
      {/* ---------------------------------------------------------- header */}
      <header className="cx-head">
        <div className="cx-head-t">
          <span className="cx-head-ico" aria-hidden="true"><ToolGlyph id={only ? LENS_GLYPH[only] : "roster"} /></span>
          <div>
            <h1>{view && only ? `${view.label} — Client view` : "Clients"}</h1>
            <p>
              {view && only
                ? <>The part of the master client record this tool uses (§8): {view.columns.map((c) => c.label).join(" · ")}. Every value is read from the master record — edit it once, on the client.</>
                : "The master client list — one record per client. Every tool reads from it: change a field once and it changes everywhere."}
            </p>
          </div>
        </div>
        <div className="cx-head-a">
          <button type="button" className="ds-btn" onClick={exportCsv} title="Download this view as a spreadsheet">Export CSV</button>
          {/* §2/§13: ONE place creates a client — the Clients page — never a tool view. */}
          {only ? <a className="ds-btn" href={`/roster?view=${only}`}>All fields on Clients →</a> : <OnboardClient />}
        </div>
      </header>

      {/* ------------------------------------------------ status overview */}
      <section className="cx-overview" aria-label="Clients by status">
        <div className="cx-total">
          <span className="cx-total-n">{total}</span>
          <span className="cx-total-l">clients</span>
        </div>
        <div className="cx-dist">
          <div className="cx-bar" role="img" aria-label={CLIENT_STATUSES.map((s) => `${counts[s]} ${s}`).join(", ")}>
            {CLIENT_STATUSES.map((s) => counts[s] ? (
              <span key={s} className={`st-${s}`} style={{ flex: counts[s] }} title={`${statusLabel(s)}: ${counts[s]}`} />
            ) : null)}
          </div>
          <div className="cx-statuses">
            <button type="button" className="cx-st" aria-pressed={status === "all"} onClick={() => setStatus("all")}>
              <span className="cx-st-l">All</span><span className="cx-st-n">{total}</span>
            </button>
            {CLIENT_STATUSES.map((s) => (
              <button key={s} type="button" className="cx-st" aria-pressed={status === s} title={STATUS_MEANING[s]}
                onClick={() => setStatus(status === s ? "all" : s)}>
                <StatusDot status={s} />
                <span className="cx-st-l">{statusLabel(s)}</span>
                <span className="cx-st-n">{counts[s]}</span>
                <span className="cx-st-p">{total ? Math.round((counts[s] / total) * 100) : 0}%</span>
              </button>
            ))}
          </div>
        </div>
        <a className="cx-sync" href="/consistency" title="Where the tools disagree about clients (§16)">
          <span className={`cx-sync-dot${data.unavailable.length ? " warn" : ""}`} aria-hidden="true" />
          <span>
            <b>{data.unavailable.length ? `${data.unavailable.length} source${data.unavailable.length === 1 ? "" : "s"} unreachable` : "Every tool read"}</b>
            <small>{data.unavailable.length ? data.unavailable.join(", ") : "Sync status on Consistency →"}</small>
          </span>
        </a>
      </section>

      {/* ------------------------------------------------------------ lenses */}
      {only ? null : <nav className="cx-lenses" aria-label="Views of the client record">
        <LensTab id="master" label="Master record" sub={`${FIELDS.length} fields`} on={lens === "master"} onClick={pickLens} />
        <span className="cx-lens-sep" aria-hidden="true" />
        {TOOL_VIEWS.map((t) => (
          <LensTab key={t.id} id={t.id} label={t.label} sub={`${t.columns.length} fields`} on={lens === t.id} onClick={pickLens} />
        ))}
        <span className="cx-lens-tab disabled" title="Commission Tracker — coming soon. It will read this same record rather than keep its own (§8).">
          <span className="cx-lens-ico" aria-hidden="true"><ToolGlyph id="performance" /></span>
          <span><b>Commission Tracker</b><small>Coming soon</small></span>
        </span>
        <span className="cx-lens-sep" aria-hidden="true" />
        <LensTab id="dictionary" label="Data dictionary" sub="Who owns each field" on={lens === "dictionary"} onClick={pickLens} />
      </nav>}

      {lens === "dictionary" ? (
        <Dictionary clients={data.clients} />
      ) : (
        <section className="cx-panel">
          {/* ------------------------------------------------------ toolbar */}
          <div className="cx-toolbar">
            <div className="cx-toolbar-l">
              <label className="cx-search">
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
                <input type="search" value={q} onChange={(e) => setQ(e.target.value)}
                  placeholder="Search name, alias, account manager…" aria-label="Search clients" />
              </label>
              {view ? (
                <p className="cx-lens-note">
                  <b>{view.label}</b> view — the §8 fields for this tool, from the same master record.
                </p>
              ) : (
                <p className="cx-lens-note">
                  <b>Master Client Record</b> — every field of §6 and the §12 lifecycle dates, in the document&rsquo;s words.
                </p>
              )}
            </div>
            <div className="cx-toolbar-r">
              <span className="cx-count">{rows.length === total ? `${total} clients` : `${rows.length} of ${total} clients`}</span>
              {view ? <a className="ds-btn sm" href={view.openIn.href}>{view.openIn.label} →</a> : null}
            </div>
          </div>
          {lens === "master" ? (
            <div className="cx-subbar">
              <span className="cx-subbar-l">Categories</span>
              <div className="cx-groups" role="group" aria-label="Show categories">
                {CATEGORIES.map((cat) => (
                  <button key={cat} type="button" className={`cx-group ${CAT_TONE[cat]}`} aria-pressed={!hidden.has(cat)}
                    onClick={() => setHidden((h) => { const n = new Set(h); if (n.has(cat)) n.delete(cat); else n.add(cat); return n; })}>
                    <i aria-hidden="true" />{CATEGORY_LABEL[cat]}
                    <span className="cx-group-n">{FIELDS.filter((f) => f.category === cat).length}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/* -------------------------------------------------------- table */}
          <div className="cx-scroll">
            <table className="cx-table">
              <thead>
                {groups.length ? (
                  <tr className="cx-bands">
                    <th className="cx-pin" />
                    {groups.map((g) => g.span ? (
                      <th key={g.cat} colSpan={g.span} className={`${CAT_TONE[g.cat]} cx-gstart`}><span>{CATEGORY_LABEL[g.cat]}</span></th>
                    ) : null)}
                  </tr>
                ) : null}
                <tr className="cx-cols">
                  <SortTh k="name" sort={sort} onSort={toggleSort} className="cx-pin">{firstLabel}</SortTh>
                  {columns.map((col, i) => (
                    <SortTh key={col.key} k={col.key} sort={sort} onSort={toggleSort}
                      className={col.category && columns[i - 1]?.category !== col.category ? "cx-gstart" : undefined}
                      title={FIELD_BY_KEY[col.key]?.definition}>
                      {col.label}
                    </SortTh>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr><td colSpan={columns.length + 1} className="cx-empty">No client matches.</td></tr>
                ) : rows.map((c) => (
                  <tr key={c.id} onClick={() => setOpenId(c.id)} tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter") setOpenId(c.id); }} aria-label={`Open ${c.name}`}>
                    <td className="cx-pin">
                      <span className="cx-client">
                        <span className="cx-av" style={avatarStyle(c.name)} aria-hidden="true">{initials(c.name)}</span>
                        <span className="cx-client-t">
                          <b>{c.name}</b>
                          {c.aliases.length ? <small>aka {c.aliases.slice(0, 2).join(", ")}{c.aliases.length > 2 ? "…" : ""}</small> : null}
                        </span>
                        <StatusDot status={c.status} />
                      </span>
                    </td>
                    {columns.map((col, i) => (
                      <td key={col.key} className={col.category && columns[i - 1]?.category !== col.category ? "cx-gstart" : undefined}>
                        <Cell k={col.key} c={c} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.unavailable.length ? (
            <p className="cx-foot">Could not be read this time: {data.unavailable.join(", ")} — their columns show “—”.</p>
          ) : null}
        </section>
      )}

      {open ? (
        <ClientRecord client={open} onClose={() => setOpenId(null)} onChanged={onChanged}
          onDeleted={() => { setOpenId(null); onChanged(); }} />
      ) : null}
    </div>
  );
}

function LensTab({ id, label, sub, on, onClick }: { id: Lens; label: string; sub: string; on: boolean; onClick: (l: Lens) => void }) {
  return (
    <button type="button" className={`cx-lens-tab${on ? " on" : ""}`} aria-pressed={on} onClick={() => onClick(id)}>
      <span className="cx-lens-ico" aria-hidden="true"><ToolGlyph id={LENS_GLYPH[id] ?? "roster"} /></span>
      <span><b>{label}</b><small>{sub}</small></span>
    </button>
  );
}

function SortTh({ k, sort, onSort, className, title, children }: {
  k: string; sort: { k: string; dir: 1 | -1 }; onSort: (k: string) => void; className?: string; title?: string; children: React.ReactNode;
}) {
  const on = sort.k === k;
  return (
    <th className={className} title={title} aria-sort={on ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button type="button" onClick={() => onSort(k)}>
        {children}<span className={`cx-arrow${on ? " on" : ""}`} aria-hidden="true">{on ? (sort.dir === 1 ? "↑" : "↓") : "↕"}</span>
      </button>
    </th>
  );
}

/* ------------------------------------------------------ §15 data dictionary --- */

function filled(k: string, c: MasterClient): boolean {
  const t = textOf(k, c);
  return t !== "" && t !== "No";
}

function Dictionary({ clients }: { clients: MasterClient[] }) {
  return (
    <section className="cx-panel">
      <div className="cx-toolbar">
        <p className="cx-lens-note" style={{ margin: 0 }}>
          <b>Master Client Data Dictionary (§15)</b> — for every field: what it means, its one source of truth, who can edit it,
          which tools use it, and whether it syncs. <b>Filled</b> is how many of the {clients.length} clients have a value today.
        </p>
      </div>
      <div className="cx-scroll">
        <table className="cx-table cx-dict">
          <thead>
            <tr className="cx-cols">
              <th className="cx-pin"><span className="cx-thl">Field</span></th>
              <th><span className="cx-thl">Definition</span></th>
              <th><span className="cx-thl">Source of Truth</span></th>
              <th><span className="cx-thl">Who Can Edit</span></th>
              <th><span className="cx-thl">Tools That Use It</span></th>
              <th><span className="cx-thl">Sync Required?</span></th>
              <th><span className="cx-thl">Filled</span></th>
            </tr>
          </thead>
          <tbody>
            {CATEGORIES.map((cat) => <DictGroup key={cat} cat={cat} clients={clients} />)}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DictGroup({ cat, clients }: { cat: FieldCategory; clients: MasterClient[] }) {
  const fields = FIELDS.filter((f) => f.category === cat);
  return (
    <>
      <tr className={`cx-dict-cat ${CAT_TONE[cat]}`}><td colSpan={7}><i aria-hidden="true" />{CATEGORY_LABEL[cat]}</td></tr>
      {fields.map((f) => {
        const n = clients.filter((c) => filled(f.key, c)).length;
        const pct = clients.length ? n / clients.length : 0;
        return (
          <tr key={f.key} className="cx-static">
            <td className="cx-pin"><b className="cx-strong">{f.label}</b></td>
            <td className="wrap"><span className="cx-wt">{f.definition}</span></td>
            <td className="wrap">
              <span className="cx-src">{f.sourceOfTruth}</span>
              {f.source !== "Master record" && f.source !== "Derived" ? <small className="cx-sub-block">held in {f.source}</small> : null}
              {f.source === "Derived" ? <small className="cx-sub-block">worked out, not stored</small> : null}
            </td>
            <td className="wrap"><span className="cx-wt">{f.editIn}</span></td>
            <td className="wrap"><span className="cx-wt">{f.tools.join(", ")}</span></td>
            <td className="wrap"><span className="cx-wt">{f.sync}</span></td>
            <td>
              <span className="cx-perf">
                <span className="cx-num">{n}/{clients.length}</span>
                <span className={`cx-meter t-${pct >= 0.9 ? "green" : pct >= 0.4 ? "amber" : "red"}`}><i style={{ width: `${pct * 100}%` }} /></span>
              </span>
            </td>
          </tr>
        );
      })}
    </>
  );
}

/*
 * The screen. `initial` is set only when the page was opened here — it then
 * server-renders from the warm cache with no loading state. Saves refresh the
 * list in place, and the record panel stays open on the same client.
 */
export function ClientsScreen({ initial, only }: { initial: MasterClientList | null; only?: ToolViewId }) {
  const [data, setData] = useState<MasterClientList | null>(initial);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (fresh: boolean) => {
    const url = fresh ? `${DATA_URL}?fresh=1` : DATA_URL;
    invalidate(url);
    try {
      setData(await loadOnce<MasterClientList>(url));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the client list");
    }
  }, []);

  useEffect(() => { if (!initial) void refresh(false); }, [initial, refresh]);

  if (!data) {
    return error ? (
      <div className="cx-page"><p className="ds-note"><b>The client list could not be loaded.</b> {error}</p></div>
    ) : <PlaceholderScreen cards={5} />;
  }
  return <ClientsView data={data} only={only} onChanged={() => void refresh(true)} />;
}

/** A tool's own §8 view of the client record, mounted inside that tool. */
export function ToolClientView({ view }: { view: ToolViewId }) {
  return <ClientsScreen initial={null} only={view} />;
}
