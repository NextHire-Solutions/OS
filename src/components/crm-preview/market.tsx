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
import { FIRST_DIR, interestedReport, LIST_PILL, MAX_PICKS, MAX_PLACES, maxPage, PAGE_SIZE, PLACE_KINDS, UNIT_PRESETS, VOLUME_PRESETS, YEAR_PRESETS, type GroupRow, type ListName, type PlaceKind, type Range, type ReportGroup, type SortKey } from "@/lib/crm-preview/market-model";

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
  return `Market here = every salesperson in the MLS on ${client}'s record${codes ? ` (${codes})` : ""}.${missing}`;
}

// ---------------------------------------------------------------- Market ---

export type Row = {
  id: string; name: string; title: string | null; brokerage: string | null; officeCity: string | null;
  mostTransactedCity: string | null; salesVolume: number | null; units: number | null; list: string; pill: string;
  office?: string | null; years?: number | null; email?: string | null;
};
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

/*
 * Include and exclude (23 Oct — the client likes the Database app's): a pick
 * is shown (ex false) or left out (ex true). The panel's Include / Exclude
 * switch only steers NEW picks; a pick keeps its side until it is removed or
 * ticked on the other side (the Database app's rule — flipping the switch
 * never silently turns a filter around).
 */
type Facet = "brand" | "office" | "city" | "county" | "state";
type Pick = { f: Facet; v: string; ex: boolean };
/*
 * No Title filter: the market is salespeople, set on the server (market-model.ts marketScope — 24 Oct, the user).
 * kinds: which of an agent's places Location looks at — the office, where it sold most: Market's Office city and Most transacted city columns (24 Oct).
 */
export type Picks = { volume: Range; units: Range; years: Range; brokerages: Pick[]; places: Pick[]; kinds: PlaceKind[] };
const NO_RANGE: Range = { min: null, max: null };
export const NO_PICKS: Picks = { volume: NO_RANGE, units: NO_RANGE, years: NO_RANGE, brokerages: [], places: [], kinds: [...PLACE_KINDS] };
const isSet = (r: Range) => r.min !== null || r.max !== null;
/** Is any filter set? */
export const anyPicks = (f: Picks) => isSet(f.volume) || isSet(f.units) || isSet(f.years) || f.brokerages.length > 0 || f.places.length > 0;
const PARAM: Record<Facet, string> = { brand: "brokerage", office: "office", city: "city", county: "county", state: "state" };
const PLURAL: Record<Facet, string> = { brand: "brokerages", office: "offices", city: "cities", county: "counties", state: "states" };
const KIND_LABEL: Record<PlaceKind, string> = { office: "Office location", transacted: "Most transacted location" };

/** The picks as the route's query string (several of a kind repeat their key; a left-out one is x-prefixed). */
export function pickParams(sp: URLSearchParams, p: Picks, skip?: "brokerage" | "place") {
  const range = (name: string, r: Range) => {
    if (r.min !== null) sp.set(`min${name}`, String(r.min));
    if (r.max !== null) sp.set(`max${name}`, String(r.max));
  };
  range("Volume", p.volume);
  range("Units", p.units);
  range("Years", p.years);
  if (skip !== "brokerage") for (const x of p.brokerages) sp.append(`${x.ex ? "x" : ""}${PARAM[x.f]}`, x.v);
  if (skip !== "place") {
    for (const x of p.places) sp.append(`${x.ex ? "x" : ""}${PARAM[x.f]}`, x.v);
    // Both is the default; one only matters with a place picked.
    if (p.places.length && p.kinds.length < PLACE_KINDS.length) for (const kd of p.kinds) sp.append("kind", kd);
  }
}

/** What a set filter's button says: one pick by name ("not Atlanta" when left out); several, a count. */
const pickText = (xs: readonly Pick[]) => (xs.length === 1 ? `${xs[0].ex ? "not " : ""}${xs[0].v}` : null);

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
type Options = { loading: boolean; options: Option[]; error: string | null; total?: number; agents?: number };

/*
 * A filter's choices from the agent database: the market's (or the client's prospects') places or brokerages, searched by name, with
 * counts — kept on the server, so they come back quickly (market.ts marketFacet). Places are counted at the chosen locations. While a
 * search is on its way, the choices already here that match it are shown.
 */
function useOptions(clientId: string, list: "market" | "prospects", facet: Facet, text: string, kinds?: readonly PlaceKind[]) {
  const [state, setState] = useState<Options>({ loading: true, options: [], error: null });
  const seen = useRef<Option[]>([]);
  const kindKey = (kinds ?? []).join(",");
  useEffect(() => { seen.current = []; }, [clientId, list, facet, kindKey]);
  useEffect(() => {
    const ctrl = new AbortController();
    const needle = text.trim().toLowerCase();
    setState((s) => ({ ...s, loading: true, error: null, options: needle ? seen.current.filter((o) => o.v.toLowerCase().includes(needle)) : seen.current.length ? seen.current : s.options }));
    const t = setTimeout(() => {
      const sp = new URLSearchParams({ client: clientId, list, facet });
      if (text.trim()) sp.set("fq", text.trim());
      if (kinds && kinds.length < PLACE_KINDS.length) for (const kd of kinds) sp.append("kind", kd);
      fetch(`/api/crm-preview/market?${sp.toString()}`, { signal: ctrl.signal })
        .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
        .then(({ ok, j }) => {
          const options: Option[] = ok && Array.isArray(j.options) ? j.options : [];
          if (ok && !text.trim()) seen.current = options;
          setState(ok ? { loading: false, options, error: j.unavailable ?? null, total: typeof j.total === "number" ? j.total : undefined, agents: typeof j.agents === "number" ? j.agents : undefined } : { loading: false, options: [], error: j?.error ?? "Couldn't load the choices." });
        })
        .catch((err) => { if (err?.name !== "AbortError") setState({ loading: false, options: [], error: "Couldn't reach the server." }); });
    }, 200);
    return () => { clearTimeout(t); ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, list, facet, text, kindKey]);
  return state;
}

/** Include / Exclude, as the Database app's panels have it: which side a new pick lands on. */
function ModeSwitch({ out, onChange }: { out: boolean; onChange: (out: boolean) => void }) {
  return (
    <span className="cpv-mode" role="radiogroup" aria-label="Include or exclude">
      <button type="button" role="radio" aria-checked={!out} onClick={() => onChange(false)}>Include</button>
      <button type="button" role="radio" aria-checked={out} data-x="" onClick={() => onChange(true)}>Exclude</button>
    </span>
  );
}

/**
 * Several of a kind at once (brokerages and offices; cities, counties and states), included or excluded:
 * a search, a list with counts, the picks as chips. With `kinds`, the Database app's Location panel: which
 * of an agent's places it looks at, up to MAX_PLACES picks, and how many places match with the agents they cover.
 */
function ManyPanel({
  clientId, list, levels, initial, kinds, onApply, register, noun,
}: {
  clientId: string; list: "market" | "prospects";
  levels: ReadonlyArray<{ id: Facet; label: string }>;
  initial: Pick[]; kinds?: PlaceKind[]; onApply: (xs: Pick[], kinds?: PlaceKind[]) => void; register: (commit: () => void) => void; noun: string;
}) {
  const [level, setLevel] = useState(levels[0].id);
  const [out, setOut] = useState(false);
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<Pick[]>(initial);
  const [where, setWhere] = useState<PlaceKind[] | undefined>(kinds);
  const cap = kinds ? MAX_PLACES : MAX_PICKS;
  register(() => onApply(draft, where));
  const opts = useOptions(clientId, list, level, text, where);
  const same = (x: Pick, v: string) => x.f === level && x.v === v;
  const sideOf = (v: string) => draft.find((x) => same(x, v))?.ex;
  // Ticking: off this side if it is on it, over from the other side if it is there, else added.
  const toggle = (v: string) => setDraft((d) => {
    const at = d.find((x) => same(x, v));
    if (at) return at.ex === out ? d.filter((x) => x !== at) : d.map((x) => (x === at ? { ...x, ex: out } : x));
    return d.length >= cap ? d : [...d, { f: level, v, ex: out }];
  });
  // Select all only adds the ones on neither side — it never moves a pick across.
  const addShown = () => setDraft((d) => [...d, ...opts.options.filter((o) => sideOf(o.v) === undefined).map((o): Pick => ({ f: level, v: o.v, ex: out }))].slice(0, cap));
  // At least one of the three: a Location that looked at none of an agent's places would match no one.
  const flip = (kd: PlaceKind) => setWhere((w) => (!w ? w : w.includes(kd) ? (w.length > 1 ? w.filter((x) => x !== kd) : w) : PLACE_KINDS.filter((x) => x === kd || w.includes(x))));
  const status = opts.loading ? "Searching…" : opts.error ? opts.error
    : kinds && opts.total !== undefined ? `${opts.total.toLocaleString("en-US")} ${opts.total === 1 ? "match" : "matches"}${opts.agents !== undefined ? ` · ≈${opts.agents.toLocaleString("en-US")} agents` : ""} · ${draft.length} selected`
    : `${opts.options.length} shown · ${draft.length} selected`;
  const levelName = (f: Facet) => levels.find((l) => l.id === f)?.label.toLowerCase() ?? f;
  const chips = (ex: boolean) => {
    const xs = draft.filter((x) => x.ex === ex);
    return xs.length ? (
      <div className="cpv-chips" aria-label={ex ? "Excluded" : "Included"}>
        {xs.map((x) => (
          <span key={`${x.f}:${x.v}`} className={ex ? "cpv-chipx cpv-x" : "cpv-chipx"}>
            {ex ? <s aria-hidden="true">not</s> : null}
            {x.v}
            {levels.length > 1 ? <small style={{ opacity: 0.7 }}>{levelName(x.f)}</small> : null}
            <button type="button" aria-label={`Remove ${ex ? "excluded " : ""}${x.v}`} onClick={() => setDraft((d) => d.filter((y) => y !== x))}><Icon name="x" size={12} /></button>
          </span>
        ))}
      </div>
    ) : null;
  };
  return (
    <>
      <div className="cpv-pop-body">
        <div className="cpv-pop-row">
          {levels.length > 1 ? (
            <div className="cpv-seg2" role="group" aria-label="Level">
              {levels.map((l) => <button key={l.id} type="button" aria-pressed={level === l.id} onClick={() => setLevel(l.id)}>{l.label}</button>)}
            </div>
          ) : null}
          <ModeSwitch out={out} onChange={setOut} />
        </div>
        <input className="cpv-find" type="search" aria-label={`Search ${noun}`} placeholder={`Search ${PLURAL[level]}`} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        <div className="cpv-status">
          <span>{status}</span>
          <span style={{ display: "flex", gap: 10 }}>
            <button type="button" className="cpv-link" onClick={addShown}>Select all</button>
            <button type="button" className="cpv-link" onClick={() => setDraft([])}>Clear</button>
          </span>
        </div>
        <div className="cpv-opts" role="listbox" aria-multiselectable="true" aria-label={noun}>
          {opts.options.map((o) => {
            const side = sideOf(o.v);
            return (
              <label key={o.v} className="cpv-opt">
                <input type="checkbox" className={k("ck")} data-x={out ? "" : undefined} checked={side === out} onChange={() => toggle(o.v)} />
                <span>{o.v}</span>
                {side !== undefined && side !== out ? <em className={side ? "cpv-tag cpv-x" : "cpv-tag"}>{side ? "Excluded" : "Included"}</em> : null}
                <small>{o.n.toLocaleString("en-US")} agents</small>
              </label>
            );
          })}
          {!opts.loading && !opts.error && opts.options.length === 0 ? <span style={{ padding: "6px 4px", color: "#6b7280", fontSize: 12 }}>Nothing matches “{text}”.</span> : null}
        </div>
        {chips(false)}
        {chips(true)}
        {draft.length >= cap ? <span style={{ fontSize: 12, color: "#6b7280" }}>{kinds ? `${cap} places max — remove some to add more.` : `Up to ${cap} at once.`}</span> : null}
        {where ? (
          <div className="cpv-kinds" role="group" aria-label="Look at the agent's">
            {PLACE_KINDS.map((kd) => (
              <label key={kd} className="cpv-kind">
                <input type="checkbox" className={k("ck")} checked={where.includes(kd)} disabled={where.length === 1 && where.includes(kd)} onChange={() => flip(kd)} />
                {KIND_LABEL[kd]}
              </label>
            ))}
          </div>
        ) : null}
      </div>
      <PopFoot onClear={() => onApply([], kinds ? [...PLACE_KINDS] : undefined)} onApply={() => onApply(draft, where)} />
    </>
  );
}

/**
 * The filter bar — Location, Sales volume, Units, Years licensed, Brokerage — as Market draws it. The Setup wizard's
 * market steps use this same bar (28 Oct, the user: "we need the same filters ui here in this setup wizard market ui
 * that we in markets page"). It keeps which panel is open; the picks are the caller's (`onChange` takes an update).
 */
export function MarketFilters({ clientId, list, value: f, onChange }: { clientId: string; list: "market" | "prospects"; value: Picks; onChange: (update: (p: Picks) => Picks) => void }) {
  const [menu, setMenu] = useState<string | null>(null);
  // The open panel's "keep what I set" — run on a click outside it (Escape drops it).
  const commit = useRef<(() => void) | null>(null);
  const register = (fn: () => void) => { commit.current = fn; };

  // The Location and Brokerage choices, asked for as the bar appears so they are ready when a panel is (the server keeps them 30 minutes).
  useEffect(() => {
    const ctrl = new AbortController();
    for (const facet of ["city", "county", "state", "brand"]) {
      const sp = new URLSearchParams({ client: clientId, list, facet });
      void fetch(`/api/crm-preview/market?${sp.toString()}`, { signal: ctrl.signal }).catch(() => {});
    }
    return () => ctrl.abort();
  }, [clientId, list]);

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
  const apply = <K extends keyof Picks>(key: K, v: Picks[K]) => { commit.current = null; onChange((x) => ({ ...x, [key]: v })); setMenu(null); };
  const applyPlaces = (places: Pick[], kinds: PlaceKind[]) => { commit.current = null; onChange((x) => ({ ...x, places, kinds })); setMenu(null); };

  // What each filter shows when set: one pick by name, several by the filter's name and a count (the Database app's way).
  return (
    <>
      <FilterButton id="place" label="Location" value={pickText(f.places)} count={f.places.length} open={menu === "place"} onOpen={openMenu}>
        <ManyPanel
          clientId={clientId} list={list} noun="places"
          levels={[{ id: "city", label: "City" }, { id: "county", label: "County" }, { id: "state", label: "State" }]}
          initial={f.places} kinds={f.kinds} onApply={(xs, kinds) => applyPlaces(xs, kinds ?? [...PLACE_KINDS])} register={register}
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
      <FilterButton id="brokerage" label="Brokerage" value={pickText(f.brokerages)} count={f.brokerages.length} open={menu === "brokerage"} onOpen={openMenu}>
        <ManyPanel
          clientId={clientId} list={list} noun="brokerages"
          levels={[{ id: "brand", label: "Brokerage" }, { id: "office", label: "Office" }]}
          initial={f.brokerages} onApply={(xs) => apply("brokerages", xs)} register={register}
        />
      </FilterButton>
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
  const [f, setF] = useState<Picks>(NO_PICKS);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "volume", dir: "desc" });
  const [page, setPage] = useState(1);
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

  const onSort = (by: SortKey) => { setSort((cur) => (cur.key === by ? { key: by, dir: cur.dir === "asc" ? "desc" : "asc" } : { key: by, dir: FIRST_DIR[by] })); setPage(1); };
  const any = anyPicks(f);
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

  const filters = <MarketFilters clientId={clientId} list={list} value={f} onChange={(update) => { setF(update); setPage(1); }} />;

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
          {/* No Import CSV here (26 Oct, the user: "you can remove this") — the design drew one; it never had a job. My Agents and the DNC List import. */}
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
                {/* Not on Prospects itself: they are there already (24 Oct, the user). */}
                {list === "market" ? <button className={k("btn sm pri")} type="button" disabled={moving} {...lock(live)} onClick={live ? () => void moveAgents("Prospects") : undefined}><Icon name="plus" size={13} />Prospects</button> : null}
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
                  ? <>Only agents whose name contains &ldquo;{q}&rdquo;. Clear the search to see everyone.</>
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
