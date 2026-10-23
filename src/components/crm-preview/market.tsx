"use client";

/*
 * The redesign's Market and Prospects (one table, two lists) and Reports, on
 * the client's real market — read from the agent database through the
 * preview's own GET routes (src/app/api/crm-preview). Moving agents between
 * lists, importing and exporting are drawn as designed and inert; ticking rows
 * and a row's list menu open as the design draws them. Filtering, sorting and
 * selecting work the Database app's way (21 Oct, Eddy's feedback).
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { PipelineEntry } from "@/lib/tools/master-inbox/portals/stages-shared";
import { abbrevUsd, initials } from "@/lib/crm-preview/model";
import { FIRST_DIR, interestedReport, LIST_PILL, MAX_PICKS, maxPage, PAGE_SIZE, TITLES, UNIT_PRESETS, VOLUME_PRESETS, YEAR_PRESETS, type GroupRow, type ListName, type Range, type ReportGroup, type SortKey } from "@/lib/crm-preview/market-model";

import { Icon } from "./icons";
import { k, off, withIds } from "./k";
import { lock, useDemo } from "./demo-save";

const HIDDEN = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" } as const;

type Mls = { matched: Array<{ code: string; name: string }>; unmatched: string[] };

/*
 * What the page counts, for the preview's bar (never inside the design): the
 * design does not say where a client's market comes from (market-model.ts).
 */
function definition(list: "market" | "prospects", client: string | null, mls: Mls | null): string | null {
  if (!client) return null;
  if (list === "prospects") return `Prospects here = the agents in ${client}'s lists in the agent database (its campaign leads).`;
  if (!mls) return null;
  const codes = mls.matched.map((m) => m.code).join(", ");
  const missing = mls.unmatched.length ? ` Not in the agent database, so not counted: ${mls.unmatched.join(", ")}.` : "";
  return `Market here = every agent in the MLS on ${client}'s record${codes ? ` (${codes})` : ""}.${missing}`;
}

// ---------------------------------------------------------------- Market ---

export type Row = {
  id: string; name: string; title: string | null; brokerage: string | null; officeCity: string | null;
  mostTransactedCity: string | null; salesVolume: number | null; units: number | null; list: string; pill: string;
  office?: string | null; years?: number | null; email?: string | null;
};
export type Filters = { minVolume: number | null; minUnits: number | null; minYears: number | null; brokerage: string | null; county: string | null; title: string | null; office: string | null; city: string | null };
export const NO_FILTERS: Filters = { minVolume: null, minUnits: null, minYears: null, brokerage: null, county: null, title: null, office: null, city: null };

type Loaded = { total: number; salesVolume: number; page: number; rows: Row[]; client: string | null; mls: Mls | null };

/*
 * A filter chip and its menu. The menu's items carry the design's leading tick
 * (as its other menus do). `bold`: the Setup wizard writes a set chip as
 * "Location: <b>11 counties</b>"; Market as "Location: Cobb, Fulton".
 */
export function Chip<T extends string | number>({
  id, label, value, show, choices, open, onOpen, onPick, hint, bold = false,
}: {
  id: string; label: string; value: T | null; show: (v: T) => string; choices: readonly T[];
  open: boolean; onOpen: (id: string | null) => void; onPick: (v: T | null) => void; hint?: string; bold?: boolean;
}) {
  const tick = (on: boolean) => <span style={{ width: 14, display: "inline-flex", color: "#3e6bd1" }}>{on ? <Icon name="check" size={14} /> : null}</span>;
  return (
    <span style={{ position: "relative", display: "inline-flex" }} data-chip={id}>
      <button type="button" className={k(value !== null ? "dd set" : "dd")} aria-haspopup="menu" aria-expanded={open} onClick={() => onOpen(open ? null : id)}>
        {value === null ? label : bold ? <>{label}:{" "}<b>{show(value)}</b></> : `${label}: ${show(value)}`}
        <Icon name="chevDown" size={14} />
      </button>
      {open ? (
        <div className={k("mmenu")} role="menu" style={{ top: "calc(100% + 4px)", left: 0, maxHeight: 320, overflowY: "auto" }}>
          {hint ? <div style={{ padding: "6px 10px 8px", fontSize: 12, color: "#6b7280", lineHeight: 1.45 }}>{hint}</div> : null}
          <button type="button" role="menuitemradio" aria-checked={value === null} className={value === null ? k("hv") : undefined} onClick={() => onPick(null)}>
            {tick(value === null)}Any
          </button>
          {choices.map((c) => (
            <button key={String(c)} type="button" role="menuitemradio" aria-checked={value === c} className={value === c ? k("hv") : undefined} onClick={() => onPick(c)}>
              {tick(value === c)}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{show(c)}</span>
            </button>
          ))}
          {choices.length === 0 ? <div style={{ padding: "6px 10px", fontSize: 12, color: "#6b7280" }}>Loading…</div> : null}
        </div>
      ) : null}
    </span>
  );
}

/* The lists a row can be moved to, in the design's order (Market-Row). */
const MOVE_LISTS: readonly ListName[] = ["Not on a list", "Prospects", "My Agents", "DNC List"];

/* ---------------------------------------------------------------------------
 * The filters, the Database app's way (21 Oct, Eddy: "Could we provide the
 * same UX on filtering as the DB? … range filters for sales volume and number
 * of units … alphabetical sorting for names and brokerages … searching
 * multiple cities and brokerages at once"; Prospects: bulk selection, sorting).
 * A button per filter, blue with a count when set; its panel keeps a draft —
 * Apply or a click outside keeps it, Escape drops it, Clear empties it.
 * ------------------------------------------------------------------------- */

type Place = { f: "city" | "county"; v: string };
type Picks = { volume: Range; units: Range; years: Range; brokerages: string[]; places: Place[]; title: string | null };
const NO_RANGE: Range = { min: null, max: null };
const NO_PICKS: Picks = { volume: NO_RANGE, units: NO_RANGE, years: NO_RANGE, brokerages: [], places: [], title: null };
const isSet = (r: Range) => r.min !== null || r.max !== null;

/** The picks as the route's query string (several brokerages and places repeat their key). */
function pickParams(sp: URLSearchParams, p: Picks, skip?: "brokerage" | "place") {
  const range = (name: string, r: Range) => {
    if (r.min !== null) sp.set(`min${name}`, String(r.min));
    if (r.max !== null) sp.set(`max${name}`, String(r.max));
  };
  range("Volume", p.volume);
  range("Units", p.units);
  range("Years", p.years);
  if (skip !== "brokerage") for (const b of p.brokerages) sp.append("brokerage", b);
  if (skip !== "place") for (const x of p.places) sp.append(x.f, x.v);
  if (p.title) sp.set("title", p.title);
}

type Unit = "usd" | "count" | "years";
const fmt = (u: Unit, n: number) => (u === "usd" ? abbrevUsd(n) : u === "years" ? `${n} yrs` : n.toLocaleString("en-US"));
function rangeText(u: Unit, r: Range): string {
  if (r.min !== null && r.max !== null) return `${fmt(u, r.min)}–${fmt(u, r.max)}`;
  if (r.min !== null) return `${fmt(u, r.min)}+`;
  if (r.max !== null) return `up to ${fmt(u, r.max)}`;
  return "";
}

/* A filter's button and its panel. */
function FilterButton({ id, label, value, count, open, onOpen, children }: { id: string; label: string; value: string | null; count?: number; open: boolean; onOpen: (id: string | null) => void; children: React.ReactNode }) {
  return (
    <span style={{ position: "relative", display: "inline-flex" }} data-chip={id}>
      <button type="button" className={`${k("dd")} cpv-fbtn${value || (count ?? 0) > 1 ? " cpv-on" : ""}`} aria-haspopup="dialog" aria-expanded={open} aria-label={count && count > 1 ? `${label}: ${count} selected` : undefined} onClick={() => onOpen(open ? null : id)}>
        {value ? `${label}: ${value}` : label}
        {count && count > 1 ? <span className="cpv-badge">{count}</span> : null}
        <Icon name="chevDown" size={14} />
      </button>
      {open ? <div className="cpv-pop" role="dialog" aria-label={label}>{children}</div> : null}
    </span>
  );
}

function PopFoot({ onClear, onApply }: { onClear: () => void; onApply: () => void }) {
  return (
    <div className="cpv-pop-foot">
      <button type="button" className={k("btn sm")} onClick={onClear}>Clear</button>
      <button type="button" className={k("btn sm pri")} onClick={onApply}>Apply</button>
    </div>
  );
}

/* Digits only, as the Database app keeps them; a thousands separator only for show. */
const toNum = (s: string): number | null => {
  const d = s.replace(/[^\d.]/g, "");
  if (!d) return null;
  const n = Number(d);
  return Number.isFinite(n) ? n : null;
};
const show = (n: number | null, u: Unit) => (n === null ? "" : u === "usd" ? n.toLocaleString("en-US") : String(n));

/** A range: quick picks, or a Min – Max of your own. */
function RangePanel({ unit, presets, value, onApply, register }: { unit: Unit; presets: readonly number[]; value: Range; onApply: (r: Range) => void; register: (commit: () => void) => void }) {
  const [min, setMin] = useState(show(value.min, unit));
  const [max, setMax] = useState(show(value.max, unit));
  const draft = (): Range => ({ min: toNum(min), max: toNum(max) });
  register(() => onApply(draft()));
  const prefix = unit === "usd" ? "$" : unit === "count" ? "#" : "";
  return (
    <>
      <div className="cpv-pop-body">
        <div className="cpv-pills">
          {presets.map((n) => {
            const on = toNum(min) === n && !max;
            return (
              <button key={n} type="button" className="cpv-pill" aria-pressed={on} onClick={() => { setMin(show(n, unit)); setMax(""); }}>
                {fmt(unit, n)}+
              </button>
            );
          })}
        </div>
        <div className="cpv-mm">
          <input aria-label="Minimum" inputMode="numeric" placeholder={`${prefix}Min`} value={min} onChange={(e) => setMin(unit === "usd" ? show(toNum(e.target.value), unit) : e.target.value.replace(/[^\d]/g, ""))} />
          <span style={{ color: "#6b7280" }}>–</span>
          <input aria-label="Maximum" inputMode="numeric" placeholder={`${prefix}Max`} value={max} onChange={(e) => setMax(unit === "usd" ? show(toNum(e.target.value), unit) : e.target.value.replace(/[^\d]/g, ""))} />
        </div>
        {unit === "years" ? null : <span style={{ fontSize: 12, color: "#6b7280" }}>The last 12 months.</span>}
      </div>
      <PopFoot onClear={() => onApply(NO_RANGE)} onApply={() => onApply(draft())} />
    </>
  );
}

type Option = { v: string; n: number };

/* A filter's choices from the agent database: searched by name, with counts, under the other filters. */
function useOptions(clientId: string, list: "market" | "prospects", facet: "brand" | "city" | "county", text: string, picks: Picks, skip: "brokerage" | "place") {
  const [state, setState] = useState<{ loading: boolean; options: Option[]; error: string | null }>({ loading: true, options: [], error: null });
  const key = JSON.stringify(picks);
  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      const sp = new URLSearchParams({ client: clientId, list, facet });
      if (text.trim()) sp.set("fq", text.trim());
      pickParams(sp, picks, skip);
      setState((s) => ({ ...s, loading: true, error: null }));
      fetch(`/api/crm-preview/market?${sp.toString()}`, { signal: ctrl.signal })
        .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
        .then(({ ok, j }) => setState(ok ? { loading: false, options: Array.isArray(j.options) ? j.options : [], error: j.unavailable ?? null } : { loading: false, options: [], error: j?.error ?? "Couldn't load the choices." }))
        .catch((err) => { if (err?.name !== "AbortError") setState({ loading: false, options: [], error: "Couldn't reach the server." }); });
    }, 250);
    return () => { clearTimeout(t); ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, list, facet, text, key]);
  return state;
}

/** Several of a kind at once (brokerages; places with their level): a search, a list with counts, the picks as chips. */
function ManyPanel<T>({
  clientId, list, picks, levels, initial, keyOf, labelOf, make, facetOf, skip, onApply, register, noun,
}: {
  clientId: string; list: "market" | "prospects"; picks: Picks;
  levels: ReadonlyArray<{ id: "brand" | "city" | "county"; label: string }>;
  initial: T[]; keyOf: (x: T) => string; labelOf: (x: T) => string; make: (o: Option, level: "brand" | "city" | "county") => T; facetOf: (x: T) => string;
  skip: "brokerage" | "place"; onApply: (xs: T[]) => void; register: (commit: () => void) => void; noun: string;
}) {
  const [level, setLevel] = useState(levels[0].id);
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<T[]>(initial);
  register(() => onApply(draft));
  const opts = useOptions(clientId, list, level, text, picks, skip);
  const chosen = new Set(draft.map(keyOf));
  const keyFor = (o: Option) => keyOf(make(o, level));
  const toggle = (o: Option) => setDraft((d) => (chosen.has(keyFor(o)) ? d.filter((x) => keyOf(x) !== keyFor(o)) : d.length >= MAX_PICKS ? d : [...d, make(o, level)]));
  return (
    <>
      <div className="cpv-pop-body">
        {levels.length > 1 ? (
          <div className="cpv-seg2" role="group" aria-label="Level">
            {levels.map((l) => <button key={l.id} type="button" aria-pressed={level === l.id} onClick={() => setLevel(l.id)}>{l.label}</button>)}
          </div>
        ) : null}
        <input className="cpv-find" type="search" aria-label={`Search ${noun}`} placeholder={`Search ${levels.length > 1 ? levels.find((l) => l.id === level)?.label.toLowerCase() + "s" : noun}`} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        <div className="cpv-status">
          <span>{opts.loading ? "Searching…" : opts.error ? opts.error : `${opts.options.length} shown · ${draft.length} selected`}</span>
          <span style={{ display: "flex", gap: 10 }}>
            <button type="button" className="cpv-link" onClick={() => setDraft((d) => [...d, ...opts.options.filter((o) => !chosen.has(keyFor(o))).map((o) => make(o, level))].slice(0, MAX_PICKS))}>Select all</button>
            <button type="button" className="cpv-link" onClick={() => setDraft([])}>Clear</button>
          </span>
        </div>
        <div className="cpv-opts" role="listbox" aria-multiselectable="true" aria-label={noun}>
          {opts.options.map((o) => (
            <label key={o.v} className="cpv-opt">
              <input type="checkbox" className={k("ck")} checked={chosen.has(keyFor(o))} onChange={() => toggle(o)} />
              <span>{o.v}</span>
              <small>{o.n.toLocaleString("en-US")} agents</small>
            </label>
          ))}
          {!opts.loading && !opts.error && opts.options.length === 0 ? <span style={{ padding: "6px 4px", color: "#6b7280", fontSize: 12 }}>Nothing matches “{text}”.</span> : null}
        </div>
        {draft.length ? (
          <div className="cpv-chips">
            {draft.map((x) => (
              <span key={keyOf(x)} className="cpv-chipx">
                {labelOf(x)}
                {levels.length > 1 ? <small style={{ opacity: 0.7 }}>{facetOf(x)}</small> : null}
                <button type="button" aria-label={`Remove ${labelOf(x)}`} onClick={() => setDraft((d) => d.filter((y) => keyOf(y) !== keyOf(x)))}><Icon name="x" size={12} /></button>
              </span>
            ))}
          </div>
        ) : null}
        {draft.length >= MAX_PICKS ? <span style={{ fontSize: 12, color: "#6b7280" }}>Up to {MAX_PICKS} at once.</span> : null}
      </div>
      <PopFoot onClear={() => onApply([])} onApply={() => onApply(draft)} />
    </>
  );
}

/* A sortable column heading: ↕ when another column sorts, ↑ / ↓ when this one does. */
function SortHead({ label, by, sort, onSort, right }: { label: string; by: SortKey; sort: { key: SortKey; dir: "asc" | "desc" }; onSort: (by: SortKey) => void; right?: boolean }) {
  const on = sort.key === by;
  return (
    <th scope="col" className={right ? k("r") : undefined} aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className="cpv-sort" data-on={on ? "" : undefined} onClick={() => onSort(by)} title={on ? (sort.dir === "asc" ? "Sorted A→Z / smallest first — click to reverse" : "Sorted Z→A / largest first — click to reverse") : `Sort by ${label.toLowerCase()}`}>
        {label}<i aria-hidden="true">{on ? (sort.dir === "asc" ? "↑" : "↓") : "↕"}</i>
      </button>
    </th>
  );
}

export function MarketScreen({ clientId, list, onContext, onOpenMarket }: { clientId: string; list: "market" | "prospects"; onContext?: (text: string | null) => void; onOpenMarket?: () => void }) {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  // Market starts on salespeople (23 Oct, the user: "only Salesperson pre selected as we do not have team lead and managing broker"); Clear all shows everyone.
  const [f, setF] = useState<Picks>(list === "market" ? { ...NO_PICKS, title: "Salesperson" } : NO_PICKS);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "volume", dir: "desc" });
  const [page, setPage] = useState(1);
  const [menu, setMenu] = useState<string | null>(null);
  const [state, setState] = useState<{ loading: boolean; error: string | null; unavailable: string | null; data: Loaded | null }>({ loading: true, error: null, unavailable: null, data: null });
  const bar = useRef<HTMLDivElement>(null);
  // Ticked rows, or every agent that matches (Prospects: "bulk selection"); moving anyone is inert. An open row menu (Market-Row).
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [allPicked, setAllPicked] = useState(false);
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  // The Demo Portal moves agents between its lists (23 Oct, demo-market.ts); every other client is read-only.
  const { live, save, say } = useDemo();
  const [moving, setMoving] = useState(false);
  const [reload, setReload] = useState(0);
  // The open panel's "keep what I set" — run on a click outside it (Escape drops it).
  const commit = useRef<(() => void) | null>(null);
  const register = (fn: () => void) => { commit.current = fn; };

  // Search waits for a pause in typing.
  useEffect(() => {
    const t = setTimeout(() => { setQ(search.trim()); setPage(1); }, 400);
    return () => clearTimeout(t);
  }, [search]);

  const fKey = JSON.stringify(f);
  useEffect(() => {
    const ctrl = new AbortController();
    const sp = new URLSearchParams({ client: clientId, list, page: String(page), sort: sort.key, dir: sort.dir });
    if (q) sp.set("q", q);
    pickParams(sp, f);
    setState((s) => ({ ...s, loading: true, error: null }));
    fetch(`/api/crm-preview/market?${sp.toString()}`, { signal: ctrl.signal })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!ok) return setState((s) => ({ ...s, loading: false, error: j?.error ?? "The agent database could not be read." }));
        if (j.unavailable) return setState({ loading: false, error: null, unavailable: j.unavailable, data: null });
        setState({ loading: false, error: null, unavailable: null, data: { total: j.total ?? 0, salesVolume: j.salesVolume ?? 0, page: j.page ?? 1, rows: j.rows ?? [], client: j.client ?? null, mls: j.mls ?? null } });
        onContext?.(definition(list, j.client ?? null, j.mls ?? null));
      })
      .catch((err) => { if (err?.name !== "AbortError") setState((s) => ({ ...s, loading: false, error: "Couldn't reach the server." })); });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, list, page, q, fKey, sort.key, sort.dir, reload]);

  /* Ticked agents, every agent that matches, or one row's agent, to a list (Demo Portal). */
  const moveAgents = async (to: "Prospects" | "My Agents" | "DNC List" | "Not on a list", one?: string) => {
    if (!live || moving) return;
    if (!one && !allPicked && picked.size > 1000) { say("Move at most 1,000 agents at once — tick fewer, or narrow the filters.", true); return; }
    const sp = new URLSearchParams({ sort: sort.key, dir: sort.dir });
    if (q) sp.set("q", q);
    pickParams(sp, f);
    setMoving(true);
    const ok = await save(one ? { type: "market.move", ids: [one], to } : allPicked ? { type: "market.moveAll", list, query: sp.toString(), to } : { type: "market.move", ids: [...picked], to });
    setMoving(false);
    if (ok) {
      // Shown at once; the reload (from the agent database, a few seconds) then confirms it.
      const moved = one ? [one] : allPicked ? null : [...picked];
      if (moved) setState((st) => (st.data ? { ...st, data: { ...st.data, rows: st.data.rows.map((r) => (moved.includes(String(r.id)) ? { ...r, list: to, pill: LIST_PILL[to] } : r)) } } : st));
      setPicked(new Set());
      setAllPicked(false);
      setRowMenu(null);
      setReload((n) => n + 1);
    }
  };

  useEffect(() => {
    if (!rowMenu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as Element)?.closest?.("[data-rowmenu]")) setRowMenu(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [rowMenu]);
  // A new list, search or filter starts with nothing ticked.
  useEffect(() => { setPicked(new Set()); setAllPicked(false); }, [list, q, fKey]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== "Escape") return;
        commit.current = null;
        setMenu(null);
        return;
      }
      if ((e.target as Element)?.closest?.("[data-chip]")) return;
      const keep = commit.current;
      commit.current = null;
      setMenu(null);
      keep?.();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [menu]);
  const openMenu = (id: string | null) => { commit.current = null; setMenu(id); };

  const apply = <K extends keyof Picks>(key: K, v: Picks[K]) => { commit.current = null; setF((x) => ({ ...x, [key]: v })); setPage(1); setMenu(null); };
  const onSort = (by: SortKey) => { setSort((cur) => (cur.key === by ? { key: by, dir: cur.dir === "asc" ? "desc" : "asc" } : { key: by, dir: FIRST_DIR[by] })); setPage(1); };
  const any = isSet(f.volume) || isSet(f.units) || isSet(f.years) || f.brokerages.length > 0 || f.places.length > 0 || f.title !== null;
  const data = state.data;
  const total = data?.total ?? 0;
  // From the rows on screen, not the page asked for: while the next page loads, the footer still describes these.
  const shownPage = data?.page ?? 1;
  const from = total === 0 ? 0 : (shownPage - 1) * 50 + 1;
  const to = Math.min(shownPage * 50, total);
  const title = list === "market" ? "Market" : "Prospects";
  const rowIds = (data?.rows ?? []).map((r) => String(r.id));
  const isPicked = (id: string) => allPicked || picked.has(id);
  const pageAll = rowIds.length > 0 && rowIds.every(isPicked);
  const pickRows = (ids: string[], on: boolean) => {
    // Unticking one of "all that match" leaves the rest of this page ticked.
    if (allPicked) { setAllPicked(false); setPicked(new Set(on ? rowIds : rowIds.filter((x) => !ids.includes(x)))); return; }
    setPicked((cur) => withIds(cur, ids, on));
  };
  const selected = allPicked ? total : picked.size;
  const clearAll = () => { setSearch(""); setQ(""); setF(NO_PICKS); setPage(1); };

  // What each filter shows when set.
  // One pick reads by name; several, as the Database app shows them, by the filter's name and a count.
  const placeText = f.places.length === 1 ? f.places[0].v : null;
  const brokerText = f.brokerages.length === 1 ? f.brokerages[0] : null;
  const filters = (
    <>
      <FilterButton id="place" label="Location" value={placeText} count={f.places.length} open={menu === "place"} onOpen={openMenu}>
        <ManyPanel<Place>
          clientId={clientId} list={list} picks={f} skip="place" noun="places"
          levels={[{ id: "city", label: "City" }, { id: "county", label: "County" }]}
          initial={f.places} keyOf={(x) => `${x.f}:${x.v}`} labelOf={(x) => x.v} facetOf={(x) => x.f}
          make={(o, level) => ({ f: level === "county" ? "county" : "city", v: o.v })}
          onApply={(xs) => apply("places", xs)} register={register}
        />
      </FilterButton>
      <FilterButton id="volume" label="Sales volume" value={isSet(f.volume) ? rangeText("usd", f.volume) : null} open={menu === "volume"} onOpen={openMenu}>
        <RangePanel unit="usd" presets={VOLUME_PRESETS} value={f.volume} onApply={(r) => apply("volume", r)} register={register} />
      </FilterButton>
      <FilterButton id="units" label="Units" value={isSet(f.units) ? rangeText("count", f.units) : null} open={menu === "units"} onOpen={openMenu}>
        <RangePanel unit="count" presets={UNIT_PRESETS} value={f.units} onApply={(r) => apply("units", r)} register={register} />
      </FilterButton>
      <FilterButton id="years" label="Years licensed" value={isSet(f.years) ? rangeText("years", f.years) : null} open={menu === "years"} onOpen={openMenu}>
        <RangePanel unit="years" presets={YEAR_PRESETS} value={f.years} onApply={(r) => apply("years", r)} register={register} />
      </FilterButton>
      <FilterButton id="brokerage" label="Brokerage" value={brokerText} count={f.brokerages.length} open={menu === "brokerage"} onOpen={openMenu}>
        <ManyPanel<string>
          clientId={clientId} list={list} picks={f} skip="brokerage" noun="brokerages"
          levels={[{ id: "brand", label: "Brokerage" }]}
          initial={f.brokerages} keyOf={(x) => x} labelOf={(x) => x} facetOf={() => "brand"} make={(o) => o.v}
          onApply={(xs) => apply("brokerages", xs)} register={register}
        />
      </FilterButton>
      <Chip id="title" label="Title" value={f.title} show={(v) => v} choices={TITLES} open={menu === "title"} onOpen={openMenu} onPick={(v) => apply("title", v)} />
    </>
  );

  // Nothing matches a search or filter (Market-NoResults); or the client has no prospects yet (Prospects-Empty).
  if (data && !state.loading && total === 0 && (q || any)) {
    return (
      <>
        <header className={k("top")}><div className={k("ttl")}><h1>{title}</h1></div><div className={k("hr")} /></header>
        <div className={k("content")}>
          <div className={k("es")}>
            <div className={k("tbar")} style={{ marginBottom: 14, flexWrap: "wrap" }}>
              <label className={k("srch")} style={{ width: 260 }}>
                <Icon name="search" size={15} />
                <input id={`crx-${list}-search`} type="search" aria-label="Search agents" value={search} onChange={(e) => setSearch(e.target.value)} />
              </label>
              {filters}
            </div>
            <section className={k("card ec")}>
              <span className={k("ei")}><Icon name="search" size={22} /></span>
              <h2>No agents match</h2>
              <p>Nothing matches your search and filters. Try a different name or remove a&nbsp;filter.</p>
              <div className={k("ea")}>
                <button type="button" className={k("btn pri")} onClick={clearAll}><Icon name="x" size={15} />Clear filters</button>
              </div>
            </section>
          </div>
        </div>
      </>
    );
  }
  if (data && !state.loading && total === 0 && list === "prospects") {
    return (
      <>
        <header className={k("top")}><div className={k("ttl")}><h1>{title}</h1></div><div className={k("hr")} /></header>
        <div className={k("content")}>
          <div className={k("es")}>
            <section className={k("card ec")}>
              <span className={k("ei")}><Icon name="target" size={22} /></span>
              <h2>No prospects yet</h2>
              <p>Prospects are the agents we reach out to. Open Market, filter agents and add the ones you want to&nbsp;Prospects.</p>
              <div className={k("ea")}>
                <button type="button" className={k("btn pri")} onClick={onOpenMarket}><Icon name="search" size={15} />Open Market</button>
              </div>
            </section>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <header className={k("top")}>
        <div className={k("ttl")}><h1>{title}</h1></div>
        <div className={k("hr")}>
          <button type="button" className={k("btn")} {...off(`Importing a list into ${title} isn't set up yet.`)}><Icon name="upload" size={15} />Import CSV</button>
          <button type="button" className={k("btn")} {...off("Export is off on purpose: agent details from the agent database can't be downloaded from the portal.")}><Icon name="download" size={15} />Export</button>
        </div>
      </header>
      <div className={k("content")}>
        {state.unavailable ? (
          <div className={k("es")}>
            <section className={k("card ec")}>
              <span className={k("ei")}><Icon name={list === "market" ? "search" : "target"} size={22} /></span>
              <h2>No {title.toLowerCase()} to show for this client</h2>
              <p>{state.unavailable}</p>
            </section>
          </div>
        ) : (
          <div className={k("card")}>
            <div className={k("tbar")} style={{ padding: "12px 14px", flexWrap: "wrap" }} ref={bar}>
              <label className={k("srch")} style={{ width: 220 }}>
                <Icon name="search" size={15} />
                <span style={HIDDEN}>Search agents</span>
                <input id={`crx-${list}-search`} type="search" placeholder="Search agents" value={search} onChange={(e) => setSearch(e.target.value)} />
              </label>
              {filters}
              {any ? <button type="button" className={k("dd")} style={{ color: "#3e6bd1" }} onClick={() => { setF(NO_PICKS); setPage(1); }}><Icon name="x" size={13} />Clear all</button> : null}
              <span style={{ flexGrow: 1 }} />
              <span className={k("cnt")} role="status">
                {data ? (
                  <>
                    <span className={k("num")}>{total.toLocaleString("en-US")}</span> agents · <span className={k("num")}>{abbrevUsd(data.salesVolume)}</span> sales volume ·{" "}
                    <button type="button" className="cpv-link" onClick={() => setAllPicked(true)} disabled={total === 0}>
                      Select all {total.toLocaleString("en-US")}
                    </button>
                  </>
                ) : state.loading ? "Counting…" : null}
              </span>
            </div>
            {selected > 0 ? (
              <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, padding: "8px 14px", background: "#f5f7fc", borderTop: "1px solid #e4e9f5", borderBottom: "1px solid #e4e9f5" }}>
                <span style={{ fontWeight: 600 }}>{allPicked ? `All ${selected.toLocaleString("en-US")} selected` : `${selected.toLocaleString("en-US")} selected`}</span>
                {!allPicked && pageAll && total > rowIds.length ? <button type="button" className="cpv-link" onClick={() => setAllPicked(true)}>Select all {total.toLocaleString("en-US")} that match</button> : null}
                <span style={{ width: 1, height: 18, background: "#d9e1f2", margin: "0 4px" }} />
                <span style={{ fontSize: 12, color: "#555a64" }}>Move to</span>
                <button className={k("btn sm pri")} type="button" disabled={moving} {...lock(live)} onClick={live ? () => void moveAgents("Prospects") : undefined}><Icon name="plus" size={13} />Prospects</button>
                <button className={k("btn sm")} type="button" disabled={moving} {...lock(live)} onClick={live ? () => void moveAgents("My Agents") : undefined}><Icon name="users" size={13} />My Agents</button>
                <button className={k("btn sm")} type="button" style={{ color: "#b42318" }} disabled={moving} {...lock(live)} onClick={live ? () => void moveAgents("DNC List") : undefined}><Icon name="ban" size={13} />DNC List</button>
                <button className={k("btn sm")} type="button" disabled={moving} {...lock(live)} onClick={live ? () => void moveAgents("Not on a list") : undefined}><Icon name="x" size={13} />Remove from all lists</button>
                {moving ? <span style={{ fontSize: 12, color: "#555a64" }} role="status">Moving…</span> : null}
                <span style={{ flexGrow: 1 }} />
                <button type="button" className={k("dd")} style={{ height: 30, fontSize: 12, color: "#555a64" }} onClick={() => { setPicked(new Set()); setAllPicked(false); }}><Icon name="x" size={13} />Clear selection</button>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderTop: "1px solid #ebedf0", fontSize: 12, color: "#555a64" }}>
                <Icon name="info" size={14} />
                {q
                  ? "Agents matching your search are listed first; the count is the whole list, as in the Database app."
                  : <>Tick agents to move them to your prospects, My Agents or DNC List. To move one agent, click its list in the List&nbsp;column.</>}
              </div>
            )}
            <div style={{ overflow: "visible", ...(selected > 0 ? {} : { borderTop: "1px solid #ebedf0" }), opacity: state.loading && data ? 0.55 : 1 }}>
              <table className={k("tb mkt")}>
                <thead>
                  <tr>
                    <th scope="col" style={{ width: 16 }}><input type="checkbox" className={k("ck")} aria-label="Select all on this page" checked={pageAll} onChange={() => pickRows(rowIds, !pageAll)} /></th>
                    <SortHead label="Name" by="name" sort={sort} onSort={onSort} />
                    <SortHead label="Title" by="title" sort={sort} onSort={onSort} />
                    <SortHead label="Brokerage" by="brokerage" sort={sort} onSort={onSort} />
                    <SortHead label="Office city" by="officeCity" sort={sort} onSort={onSort} />
                    <SortHead label="Most transacted city" by="transactedCity" sort={sort} onSort={onSort} />
                    <SortHead label="Sales volume" by="volume" sort={sort} onSort={onSort} right />
                    <SortHead label="Units" by="units" sort={sort} onSort={onSort} right />
                    <th scope="col">List</th>
                  </tr>
                </thead>
                <tbody>
                  {state.error ? (
                    <tr><td /><td colSpan={8} role="alert" style={{ padding: "18px 0" }}>{state.error}</td></tr>
                  ) : !data ? (
                    <tr><td /><td colSpan={8} className="cpv-muted" style={{ padding: "18px 0" }}>Loading the {title.toLowerCase()}…</td></tr>
                  ) : data.rows.length === 0 ? (
                    <tr><td /><td colSpan={8} className="cpv-muted" style={{ padding: "18px 0" }}>No agents match.</td></tr>
                  ) : (
                    data.rows.map((r) => (
                      <tr key={r.id} className={isPicked(String(r.id)) || rowMenu === String(r.id) ? k("sel") : undefined}>
                        <td style={{ width: 16 }}><input type="checkbox" className={k("ck")} aria-label={`Select ${r.name}`} checked={isPicked(String(r.id))} onChange={() => pickRows([String(r.id)], !isPicked(String(r.id)))} /></td>
                        <td><div style={{ display: "flex", alignItems: "center", gap: 10 }}><span className={k("av")}>{initials(r.name)}</span><span className={k("nm")}>{r.name}</span></div></td>
                        <td>{r.title ?? <span className={k("dash")}>&ndash;</span>}</td>
                        <td>{r.brokerage ?? <span className={k("dash")}>&ndash;</span>}</td>
                        <td>{r.officeCity ?? <span className={k("dash")}>&ndash;</span>}</td>
                        <td>{r.mostTransactedCity ?? <span className={k("dash")}>&ndash;</span>}</td>
                        <td className={k("r")}><span className={k("num")} style={{ fontWeight: 500 }}>{r.salesVolume !== null ? abbrevUsd(r.salesVolume) : "–"}</span></td>
                        <td className={k("r")}>{r.units ?? "–"}</td>
                        <td style={{ position: "relative" }} data-rowmenu="">
                          <button type="button" className={k("lsel")} aria-label={`Change list for ${r.name}`} aria-haspopup="menu" aria-expanded={rowMenu === String(r.id)} onClick={() => setRowMenu((m) => (m === String(r.id) ? null : String(r.id)))}>
                            <span className={k(`pill ${r.pill}`)}>{r.list}</span>
                            <Icon name="chevDown" size={12} />
                          </button>
                          {rowMenu === String(r.id) ? (
                            <div className={k("mmenu")} role="menu" style={{ top: 36, right: "0", width: 200 }}>
                              <div style={{ padding: "6px 10px 4px", fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em" }}>Move to list</div>
                              {MOVE_LISTS.map((l) => (
                                <button
                                  key={l}
                                  type="button"
                                  role="menuitemradio"
                                  aria-checked={r.list === l}
                                  className={r.list === l ? k("hv") : undefined}
                                  disabled={moving}
                                  {...lock(live)}
                                  onClick={live ? () => { if (r.list !== l) void moveAgents(l as "Prospects" | "My Agents" | "DNC List" | "Not on a list", String(r.id)); else setRowMenu(null); } : undefined}
                                >
                                  <span style={{ width: 14, display: "inline-flex", color: "#3e6bd1" }}>{r.list === l ? <Icon name="check" size={14} /> : null}</span>
                                  <span className={k(`pill ${LIST_PILL[l]}`)}>{l}</span>
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className={k("tf")}>
              <span>{data ? `${from.toLocaleString("en-US")}–${to.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} · ` : ""}Sales volume and units are the last 12&nbsp;months</span>
              <div className={k("pg")}>
                <button type="button" className={k("btn sm")} disabled={page <= 1 || state.loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</button>
                <button type="button" className={k("btn sm")} disabled={to >= total || shownPage >= maxPage(PAGE_SIZE) || state.loading} title={shownPage >= maxPage(PAGE_SIZE) && to < total ? "A search shows its first 1,000 agents — narrow the filters or change the sort to see others" : undefined} onClick={() => setPage((p) => p + 1)}>Next</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// --------------------------------------------------------------- Reports ---

const NOUN: Record<string, string> = { "Current brokerage": "brokerages", "Office city": "cities" };

/*
 * A list card shows the design's eight rows — "Unknown" the last of them when
 * some agents have none ("Top 8 of 64 cities": seven cities and Unknown) — and
 * "See all" opens the rest. The brokerage list is the Database app's largest
 * 50, so how many there are in all is "50+".
 */
function ReportCard({ group, interested, all }: { group: ReportGroup; interested: boolean; all?: GroupRow[] }) {
  const [open, setOpen] = useState(false);
  const noun = NOUN[group.title];
  const isList = Boolean(noun);
  const unknown = group.rows.find((r) => r.label === "Unknown");
  const known = (all ?? group.rows).filter((r) => r.label !== "Unknown");
  const top = unknown ? 7 : 8;
  const rows = isList ? [...(open ? known : known.slice(0, top)), ...(unknown ? [unknown] : [])] : group.rows;
  const max = Math.max(1, ...rows.map((r) => r.n));
  const more = isList && known.length > top;
  const capped = !group.of && known.length >= 50;
  const total = group.of?.total ?? known.length;
  const foot = open
    ? `${capped || total > known.length ? "Largest" : "All"} ${known.length.toLocaleString("en-US")} ${noun}`
    : more
      ? `Top ${rows.length} of ${capped ? "50+" : total.toLocaleString("en-US")} ${noun}`
      : `All ${total.toLocaleString("en-US")} ${noun}`;
  return (
    <section className={k("card")} style={{ display: "flex", flexDirection: "column" }}>
      <div className={k("ch")} style={{ padding: "16px 18px 6px", alignItems: "center" }}><h2>{group.title}</h2></div>
      <table className={k("bk")}>
        <colgroup><col style={{ width: "40%" }} /><col /><col style={{ width: 90 }} /></colgroup>
        <thead>
          <tr><th scope="col">Group</th><th scope="col"><span style={HIDDEN}>Share</span></th><th scope="col" className={k("r")}>{interested ? "Interested" : "Agents"}</th></tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={3} className="cpv-muted" style={{ padding: "14px 18px" }}>Nothing recorded.</td></tr>
          ) : rows.map((r) => (
            <tr key={r.label}>
              <th scope="row" className={k("bl")} title={r.label}>{r.label}</th>
              <td className={k("bt")}><span className={k("bar")}><span style={{ width: `${((r.n / max) * 100).toFixed(1)}%`, ...(interested ? { background: "#1a9a47" } : {}) }} /></span></td>
              <td className={k(interested ? "r bi" : "r br")}>{r.n.toLocaleString("en-US")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <span style={{ flexGrow: 1 }} />
      {isList && rows.length > 0 ? (
        <div className={k("tf")} style={{ padding: "10px 18px" }}>
          <span>{foot}</span>
          {more ? (
            <a href="#" style={{ color: "#3e6bd1", fontWeight: 500 }} onClick={(e) => { e.preventDefault(); setOpen((o) => !o); }}>{open ? "Show fewer" : "See all"}</a>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function ReportsScreen({ clientId, entries, onContext }: { clientId: string; entries: PipelineEntry[]; onContext?: (text: string | null) => void }) {
  const [mode, setMode] = useState<"all" | "interested">("all");
  const [rep, setRep] = useState<{ loading: boolean; error: string | null; unavailable: string | null; data: { total: number; groups: ReportGroup[]; allBrokerages: GroupRow[]; client: string | null; mls: Mls } | null }>({ loading: true, error: null, unavailable: null, data: null });
  const interested = useMemo(() => interestedReport(entries), [entries]);

  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams({ client: clientId }).toString();
    fetch(`/api/crm-preview/report?${qs}`)
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (cancelled) return;
        if (!ok) return setRep({ loading: false, error: j?.error ?? "The agent database could not be read.", unavailable: null, data: null });
        if (j.unavailable) return setRep({ loading: false, error: null, unavailable: j.unavailable, data: null });
        setRep({ loading: false, error: null, unavailable: null, data: { total: j.total, groups: j.groups ?? [], allBrokerages: j.allBrokerages ?? [], client: j.client ?? null, mls: j.mls } });
        onContext?.(definition("market", j.client ?? null, j.mls ?? null));
      })
      .catch(() => { if (!cancelled) setRep({ loading: false, error: "Couldn't reach the server.", unavailable: null, data: null }); });
    return () => { cancelled = true; };
  }, [clientId]);

  return (
    <>
      <header className={k("top")}><div className={k("ttl")}><h1>Reports</h1></div><div className={k("hr")} /></header>
      <div className={k("content")}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Market</h2>
          <div className={k("seg")} role="group" aria-label="Show">
            <button type="button" className={mode === "all" ? k("on") : undefined} aria-pressed={mode === "all"} onClick={() => setMode("all")}>All market</button>
            <button type="button" className={mode === "interested" ? k("on") : undefined} aria-pressed={mode === "interested"} onClick={() => setMode("interested")}>Interested only</button>
          </div>
          <span className={k("cnt")}>
            {mode === "all"
              ? <>Every agent in your market, by group.</>
              : <>Agents interested in talking, by&nbsp;group.</>}
          </span>
        </div>
        {mode === "all" ? (
          rep.unavailable ? (
            <div className={k("es")}><section className={k("card ec")}><span className={k("ei")}><Icon name="reports" size={22} /></span><h2>No market to report on</h2><p>{rep.unavailable}</p></section></div>
          ) : rep.error ? (
            <p role="alert">{rep.error}</p>
          ) : !rep.data ? (
            <p className="cpv-muted" role="status">Counting the market… a large market takes about 20 seconds the first time.</p>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 14, alignItems: "stretch" }}>
              {rep.data.groups.map((g) => <ReportCard key={g.title} group={g} interested={false} all={g.title === "Current brokerage" ? rep.data!.allBrokerages : undefined} />)}
            </div>
          )
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 14, alignItems: "stretch" }}>
            {interested.groups.map((g) => <ReportCard key={g.title} group={g} interested />)}
          </div>
        )}
      </div>
    </>
  );
}
