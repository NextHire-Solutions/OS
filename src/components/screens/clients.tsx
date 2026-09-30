"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Cell, avatarStyle, initials, introMissing, textOf } from "@/components/clients/cells";
import {
  CATEGORIES, CATEGORY_LABEL, FIELDS, FIELD_BY_KEY, TOOL_VIEWS, shown,
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
 *                   that tool needs (§5, §20). Opening a client from a tool
 *                   view opens that tool's part of the record, nothing else.
 *   Data dictionary §15 — every field's definition, source of truth, who can
 *                   edit it, which tools use it, whether it syncs.
 *
 * Design (30 Sep, second pass): one metrics strip that is also the status
 * filter, quiet text tabs, one toolbar, hairlines instead of shadows.
 * Keyboard: "/" searches, ↑ ↓ move through clients in the record, Esc closes.
 */

const DATA_URL = "/api/workspace/clients/master";

type Lens = "master" | ToolViewId | "dictionary";

/* The master record's columns: every registry field except the name, which is the pinned first column. */
const MASTER_COLUMNS = FIELDS.filter((f) => f.key !== "name" && !f.hidden);

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
  const [colsOpen, setColsOpen] = useState(false);
  const [sort, setSort] = useState<{ k: string; dir: 1 | -1 }>({ k: "name", dir: 1 });
  const [openId, setOpenId] = useState<string | null>(null);
  const search = useRef<HTMLInputElement | null>(null);

  // Deep links: ?view=database opens a tool's view, ?client=<id> opens a record.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const v = p.get("view");
    if (!only && v && (v === "master" || v === "dictionary" || TOOL_VIEWS.some((t) => t.id === v))) setLens(v as Lens);
    const id = p.get("client");
    if (id && data.clients.some((c) => c.id === id)) setOpenId(id);
  }, [only, data.clients]);

  // "/" jumps to search, as in every good list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || openId) return;
      const t = e.target as HTMLElement;
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
      e.preventDefault();
      search.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openId]);

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
      : view ? view.columns.filter((c) => c.key !== "name" && shown(c.key)) : [];
  const firstLabel = view?.columns.find((c) => c.key === "name")?.label ?? "Client";
  const groups = lens === "master"
    ? CATEGORIES.filter((cat) => !hidden.has(cat)).map((cat) => ({ cat, span: columns.filter((c) => c.category === cat).length }))
    : [];

  const toggleSort = (k: string) => setSort((s) => ({ k, dir: s.k === k ? (s.dir === 1 ? -1 : 1) : 1 }));

  const openIdx = openId ? rows.findIndex((c) => c.id === openId) : -1;
  const open = openId ? data.clients.find((c) => c.id === openId) ?? null : null;
  const close = useCallback(() => {
    setOpenId(null);
    const u = new URL(window.location.href);
    if (u.searchParams.has("client")) { u.searchParams.delete("client"); window.history.replaceState(null, "", u); }
  }, []);

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
          <span className="cx-kicker">{view && only ? `${view.label} · client view` : "Master client list"}</span>
          <h1>{view && only ? view.label : "Clients"}</h1>
          <p>
            {view && only
              ? <>The part of the client record this tool uses — {view.columns.map((c) => c.label).join(" · ")}.</>
              : "One record per client. Every tool reads from it — change a field once, and it changes everywhere."}
          </p>
        </div>
        <div className="cx-head-a">
          <button type="button" className="cx-btn" onClick={exportCsv}>Export</button>
          {/* §2/§13: ONE place creates a client — the Clients page — never a tool view. */}
          {only ? <a className="cx-btn" href={`/roster?view=${only}`}>All fields →</a> : <span className="cx-primary"><OnboardClient /></span>}
        </div>
      </header>

      {/* ------------------------------------------------ status = filter */}
      <section className="cx-metrics" aria-label="Clients by status — click to filter">
        <button type="button" className="cx-metric" aria-pressed={status === "all"} onClick={() => setStatus("all")}>
          <span className="k">All clients</span>
          <span className="v">{total}</span>
          <span className="cx-dist" aria-hidden="true">
            {CLIENT_STATUSES.map((s) => counts[s] ? <i key={s} className={`st-${s}`} style={{ flex: counts[s] }} /> : null)}
          </span>
        </button>
        {CLIENT_STATUSES.map((s) => (
          <button key={s} type="button" className={`cx-metric st-${s}`} aria-pressed={status === s} title={STATUS_MEANING[s]}
            onClick={() => setStatus(status === s ? "all" : s)}>
            <span className="k"><i className="d" aria-hidden="true" />{statusLabel(s)}</span>
            <span className="v">{counts[s]}</span>
            <span className="p">{total ? Math.round((counts[s] / total) * 100) : 0}%</span>
          </button>
        ))}
        <a className="cx-metric cx-sync" href="/consistency" title="Where the tools disagree about clients (§16)">
          <span className="k"><i className={`live${data.unavailable.length ? " warn" : ""}`} aria-hidden="true" />Sync</span>
          <span className="v sm">{data.unavailable.length ? `${data.unavailable.length} unread` : "All tools"}</span>
          <span className="p">{data.unavailable.length ? data.unavailable.join(", ") : "Consistency →"}</span>
        </a>
      </section>

      {/* ------------------------------------------------------------ views */}
      {only ? null : (
        <nav className="cx-tabs" aria-label="Views of the client record">
          <Tab id="master" label="Master record" n={FIELDS.filter((f) => !f.hidden).length} on={lens === "master"} onClick={pickLens} />
          <span className="cx-tabs-l">Tool views</span>
          {TOOL_VIEWS.map((t) => (
            <Tab key={t.id} id={t.id} label={t.label.replace(" Dashboard", "")} n={t.columns.filter((c) => shown(c.key)).length} on={lens === t.id} onClick={pickLens} />
          ))}
          <span className="cx-tab disabled" title="Commission Tracker — coming soon. It will read this same record (§8).">Commission Tracker <em>soon</em></span>
          <span className="cx-tabs-sp" />
          <Tab id="dictionary" label="Data dictionary" on={lens === "dictionary"} onClick={pickLens} />
        </nav>
      )}

      {lens === "dictionary" ? (
        <Dictionary clients={data.clients} />
      ) : (
        <section className="cx-panel">
          {/* ------------------------------------------------------ toolbar */}
          <div className="cx-toolbar">
            <label className="cx-search">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
              <input ref={search} type="search" value={q} onChange={(e) => setQ(e.target.value)}
                placeholder="Search clients, aliases, people" aria-label="Search clients" />
              <kbd>/</kbd>
            </label>
            <span className="cx-note">
              {view ? <>{view.label} — the §8 fields, read from the master record</> : <>Every §6 field and the §12 dates, in the document&rsquo;s words</>}
            </span>
            <span className="cx-toolbar-r">
              <span className="cx-count">{rows.length === total ? total : `${rows.length}/${total}`} <em>clients</em></span>
              {lens === "master" ? (
                <span className="cx-cols-menu">
                  <button type="button" className="cx-btn sm" aria-expanded={colsOpen} onClick={() => setColsOpen((o) => !o)}>
                    Columns <em>{columns.length}</em>
                  </button>
                  {colsOpen ? (
                    <>
                      <span className="cx-menu-scrim" onClick={() => setColsOpen(false)} />
                      <span className="cx-menu" role="group" aria-label="Show categories">
                        {CATEGORIES.map((cat) => (
                          <label key={cat} className={`cx-menu-i cat-${cat}`}>
                            <input type="checkbox" checked={!hidden.has(cat)}
                              onChange={() => setHidden((h) => { const n = new Set(h); if (n.has(cat)) n.delete(cat); else n.add(cat); return n; })} />
                            <i aria-hidden="true" />{CATEGORY_LABEL[cat]}
                            <em>{FIELDS.filter((f) => f.category === cat && !f.hidden).length}</em>
                          </label>
                        ))}
                      </span>
                    </>
                  ) : null}
                </span>
              ) : view ? <a className="cx-btn sm" href={view.openIn.href}>{view.openIn.label} →</a> : null}
            </span>
          </div>

          {/* -------------------------------------------------------- table */}
          <div className="cx-scroll">
            <table className="cx-table">
              <thead>
                {groups.length ? (
                  <tr className="cx-bands">
                    <th className="cx-pin" />
                    {groups.map((g) => g.span ? (
                      <th key={g.cat} colSpan={g.span} className={`cat-${g.cat} cx-gstart`}><span>{CATEGORY_LABEL[g.cat]}</span></th>
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
                  <tr><td colSpan={columns.length + 1} className="cx-empty">No client matches “{q}”.</td></tr>
                ) : rows.map((c) => (
                  <tr key={c.id} onClick={() => setOpenId(c.id)} tabIndex={0} className={c.id === openId ? "on" : undefined}
                    onKeyDown={(e) => { if (e.key === "Enter") setOpenId(c.id); }} aria-label={`Open ${c.name}`}>
                    <td className="cx-pin">
                      <span className="cx-client">
                        <span className={`cx-sdot st-${c.status}`} title={statusLabel(c.status)} aria-hidden="true" />
                        <span className="cx-av" style={avatarStyle(c.name)} aria-hidden="true">{initials(c.name)}</span>
                        <span className="cx-client-t">
                          <b>{c.name}{introMissing(c).length ? (
                            <span className="cx-chip t-orange" style={{ marginLeft: 8, height: 18, fontSize: 10.5, verticalAlign: 1 }}
                              title={`The Introduce button cannot be used for ${c.name}: add the ${introMissing(c).join(" and ")} under Introduce to.`}>
                              No intro template
                            </span>
                          ) : null}</b>
                          {c.aliases.length ? <small>{c.aliases.slice(0, 2).join(" · ")}{c.aliases.length > 2 ? " …" : ""}</small> : null}
                        </span>
                        <span className="cx-open" aria-hidden="true">Open</span>
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
            <p className="cx-foot">Not read this time: {data.unavailable.join(", ")} — their columns show “—”.</p>
          ) : null}
        </section>
      )}

      {open ? (
        <ClientRecord
          client={open}
          view={only ?? (view ? view.id : undefined)}
          onClose={close}
          onChanged={onChanged}
          onDeleted={() => { close(); onChanged(); }}
          onPrev={openIdx > 0 ? () => setOpenId(rows[openIdx - 1].id) : undefined}
          onNext={openIdx >= 0 && openIdx < rows.length - 1 ? () => setOpenId(rows[openIdx + 1].id) : undefined}
          position={openIdx >= 0 ? `${openIdx + 1} / ${rows.length}` : undefined}
        />
      ) : null}
    </div>
  );
}

function Tab({ id, label, n, on, onClick }: { id: Lens; label: string; n?: number; on: boolean; onClick: (l: Lens) => void }) {
  return (
    <button type="button" className={`cx-tab${on ? " on" : ""}`} aria-pressed={on} onClick={() => onClick(id)}>
      {label}{n !== undefined ? <em>{n}</em> : null}
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
        <span className="cx-note" style={{ marginLeft: 0 }}>
          <b>Master Client Data Dictionary (§15)</b> — what each field means, its one source of truth, who can edit it, which tools use
          it, whether it syncs, and how many of the {clients.length} clients have it today.
        </span>
      </div>
      <div className="cx-scroll">
        <table className="cx-table cx-dict">
          <thead>
            <tr className="cx-cols">
              {["Field", "Definition", "Source of Truth", "Who Can Edit", "Tools That Use It", "Sync Required?", "Filled"].map((h, i) => (
                <th key={h} className={i === 0 ? "cx-pin" : undefined}><span className="cx-thl">{h}</span></th>
              ))}
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
      <tr className={`cx-dict-cat cat-${cat}`}><td colSpan={7}><i aria-hidden="true" />{CATEGORY_LABEL[cat]}</td></tr>
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
 * list in place, and the record stays open on the same client.
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
