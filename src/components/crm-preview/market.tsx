"use client";

/*
 * The redesign's Market and Prospects (one table, two lists) and Reports, on
 * the client's real market — read from the agent database through the
 * preview's own GET routes (src/app/api/crm-preview). Moving agents between
 * lists, importing and exporting are drawn as designed and inert; ticking rows
 * and a row's list menu open as the design draws them.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { PipelineEntry } from "@/lib/tools/master-inbox/portals/stages-shared";
import { abbrevUsd, initials } from "@/lib/crm-preview/model";
import { interestedReport, LIST_PILL, maxPage, PAGE_SIZE, TITLES, UNIT_PRESETS, VOLUME_PRESETS, YEAR_PRESETS, type GroupRow, type ListName, type ReportGroup } from "@/lib/crm-preview/market-model";

import { Icon } from "./icons";
import { k, RO, withIds } from "./k";

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
export type Filters = { minVolume: number | null; minUnits: number | null; minYears: number | null; brokerage: string | null; county: string | null; title: string | null };
export const NO_FILTERS: Filters = { minVolume: null, minUnits: null, minYears: null, brokerage: null, county: null, title: null };

type Loaded = { total: number; page: number; rows: Row[]; client: string | null; mls: Mls | null };

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

export function MarketScreen({ clientId, list, onContext, onOpenMarket }: { clientId: string; list: "market" | "prospects"; onContext?: (text: string | null) => void; onOpenMarket?: () => void }) {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [page, setPage] = useState(1);
  const [menu, setMenu] = useState<string | null>(null);
  const [state, setState] = useState<{ loading: boolean; error: string | null; unavailable: string | null; data: Loaded | null }>({ loading: true, error: null, unavailable: null, data: null });
  const [options, setOptions] = useState<{ brokerages: string[]; counties: string[] } | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  // Ticked rows and an open row menu (the design's Market-Selected and Market-Row); moving anyone is inert.
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [rowMenu, setRowMenu] = useState<string | null>(null);

  // Search waits for a pause in typing.
  useEffect(() => {
    const t = setTimeout(() => { setQ(search.trim()); setPage(1); }, 400);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    const ctrl = new AbortController();
    const sp = new URLSearchParams({ client: clientId, list, page: String(page) });
    if (q) sp.set("q", q);
    if (f.minVolume) sp.set("minVolume", String(f.minVolume));
    if (f.minUnits) sp.set("minUnits", String(f.minUnits));
    if (f.minYears) sp.set("minYears", String(f.minYears));
    if (f.brokerage) sp.set("brokerage", f.brokerage);
    if (f.county) sp.set("county", f.county);
    if (f.title) sp.set("title", f.title);
    if (!options) sp.set("options", "1");
    setState((s) => ({ ...s, loading: true, error: null }));
    fetch(`/api/crm-preview/market?${sp.toString()}`, { signal: ctrl.signal })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!ok) return setState((s) => ({ ...s, loading: false, error: j?.error ?? "The agent database could not be read." }));
        if (j.options) setOptions(j.options);
        if (j.unavailable) return setState({ loading: false, error: null, unavailable: j.unavailable, data: null });
        setState({ loading: false, error: null, unavailable: null, data: { total: j.total ?? 0, page: j.page ?? 1, rows: j.rows ?? [], client: j.client ?? null, mls: j.mls ?? null } });
        onContext?.(definition(list, j.client ?? null, j.mls ?? null));
      })
      .catch((err) => { if (err?.name !== "AbortError") setState((s) => ({ ...s, loading: false, error: "Couldn't reach the server." })); });
    return () => ctrl.abort();
    // `options` is read once and is not a reason to load again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, list, page, q, f]);

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
  useEffect(() => setPicked(new Set()), [list, q, f]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as Element)?.closest?.("[data-chip]")) setMenu(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [menu]);

  const set = <K extends keyof Filters>(key: K, v: Filters[K]) => { setF((x) => ({ ...x, [key]: v })); setPage(1); setMenu(null); };
  const any = Object.values(f).some((v) => v !== null);
  const data = state.data;
  const total = data?.total ?? 0;
  // From the rows on screen, not the page asked for: while the next page loads, the footer still describes these.
  const shownPage = data?.page ?? 1;
  const from = total === 0 ? 0 : (shownPage - 1) * 50 + 1;
  const to = Math.min(shownPage * 50, total);
  const title = list === "market" ? "Market" : "Prospects";
  const rowIds = (data?.rows ?? []).map((r) => String(r.id));
  const pageAll = rowIds.length > 0 && rowIds.every((id) => picked.has(id));
  const pickRows = (ids: string[], on: boolean) => setPicked((cur) => withIds(cur, ids, on));
  const clearAll = () => { setSearch(""); setQ(""); setF(NO_FILTERS); setPage(1); };

  // Nothing matches a search or filter (Market-NoResults); or the client has no prospects yet (Prospects-Empty).
  if (data && !state.loading && total === 0 && (q || any)) {
    return (
      <>
        <header className={k("top")}><div className={k("ttl")}><h1>{title}</h1></div><div className={k("hr")} /></header>
        <div className={k("content")}>
          <div className={k("es")}>
            <div className={k("tbar")} style={{ marginBottom: 14 }}>
              <label className={k("srch")} style={{ width: 260 }}>
                <Icon name="search" size={15} />
                <input id={`crx-${list}-search`} type="search" aria-label="Search agents" value={search} onChange={(e) => setSearch(e.target.value)} />
              </label>
              {f.county ? <button type="button" className={k("dd set")} onClick={() => set("county", null)}>Location: {f.county}{" "}<Icon name="chevDown" size={14} /></button> : null}
              {f.minVolume ? <button type="button" className={k("dd set")} onClick={() => set("minVolume", null)}>Sales volume: {abbrevUsd(f.minVolume)}+{" "}<Icon name="chevDown" size={14} /></button> : null}
              {f.minUnits ? <button type="button" className={k("dd set")} onClick={() => set("minUnits", null)}>Units: {f.minUnits}+{" "}<Icon name="chevDown" size={14} /></button> : null}
              {f.minYears ? <button type="button" className={k("dd set")} onClick={() => set("minYears", null)}>Years licensed: {f.minYears}+{" "}<Icon name="chevDown" size={14} /></button> : null}
              {f.brokerage ? <button type="button" className={k("dd set")} onClick={() => set("brokerage", null)}>Brokerage: {f.brokerage}{" "}<Icon name="chevDown" size={14} /></button> : null}
              {f.title ? <button type="button" className={k("dd set")} onClick={() => set("title", null)}>Title: {f.title}{" "}<Icon name="chevDown" size={14} /></button> : null}
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
          <button type="button" className={k("btn")} {...RO}><Icon name="upload" size={15} />Import CSV</button>
          <button type="button" className={k("btn")} {...RO}><Icon name="download" size={15} />Export</button>
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
            <div className={k("tbar")} style={{ padding: "12px 14px" }} ref={bar}>
              <label className={k("srch")} style={{ width: 220 }}>
                <Icon name="search" size={15} />
                <span style={HIDDEN}>Search agents</span>
                <input id={`crx-${list}-search`} type="search" placeholder="Search agents" value={search} onChange={(e) => setSearch(e.target.value)} />
              </label>
              {(
                <>
                  <Chip id="county" label="Location" value={f.county} show={(v) => v} choices={options?.counties ?? []} open={menu === "county"} onOpen={setMenu} onPick={(v) => set("county", v)} />
                  <Chip id="volume" label="Sales volume" value={f.minVolume} show={(v) => `${abbrevUsd(v)}+`} choices={VOLUME_PRESETS} open={menu === "volume"} onOpen={setMenu} onPick={(v) => set("minVolume", v)} />
                  <Chip id="units" label="Units" value={f.minUnits} show={(v) => `${v}+`} choices={UNIT_PRESETS} open={menu === "units"} onOpen={setMenu} onPick={(v) => set("minUnits", v)} />
                  <Chip
                    id="years" label="Years licensed" value={f.minYears} show={(v) => `${v}+`} choices={YEAR_PRESETS} open={menu === "years"} onOpen={setMenu} onPick={(v) => set("minYears", v)}
                  />
                  <Chip id="brokerage" label="Brokerage" value={f.brokerage} show={(v) => v} choices={options?.brokerages ?? []} open={menu === "brokerage"} onOpen={setMenu} onPick={(v) => set("brokerage", v)} />
                  <Chip id="title" label="Title" value={f.title} show={(v) => v} choices={TITLES} open={menu === "title"} onOpen={setMenu} onPick={(v) => set("title", v)} />
                  <button type="button" className={k("dd")} style={{ color: "#3e6bd1" }} onClick={() => { if (any) { setF(NO_FILTERS); setPage(1); } }}>Clear</button>
                </>
              )}
              <span style={{ flexGrow: 1 }} />
              <span className={k("cnt")} role="status">
                {data ? (
                  <>
                    <span className={k("num")}>{total.toLocaleString("en-US")}</span> match ·{" "}
                    <button type="button" className={k("mlnk")} {...RO} style={{ border: 0, background: "transparent", padding: 0, color: "#3e6bd1", fontWeight: 500, cursor: "pointer", fontSize: 12 }}>
                      Select all {total.toLocaleString("en-US")}
                    </button>
                  </>
                ) : state.loading ? "Counting…" : null}
              </span>
            </div>
            {picked.size > 0 ? (
              <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, padding: "8px 14px", background: "#f5f7fc", borderTop: "1px solid #e4e9f5", borderBottom: "1px solid #e4e9f5" }}>
                <span style={{ fontWeight: 600 }}>{picked.size.toLocaleString("en-US")} selected</span>
                <span style={{ width: 1, height: 18, background: "#d9e1f2", margin: "0 4px" }} />
                <span style={{ fontSize: 12, color: "#555a64" }}>Move to</span>
                <button className={k("btn sm pri")} type="button" {...RO}><Icon name="plus" size={13} />Prospects</button>
                <button className={k("btn sm")} type="button" {...RO}><Icon name="users" size={13} />My Agents</button>
                <button className={k("btn sm")} type="button" style={{ color: "#b42318" }} {...RO}><Icon name="ban" size={13} />DNC List</button>
                <button className={k("btn sm")} type="button" {...RO}><Icon name="x" size={13} />Remove from all lists</button>
                <span style={{ flexGrow: 1 }} />
                <button type="button" className={k("dd")} style={{ height: 30, fontSize: 12, color: "#555a64" }} onClick={() => setPicked(new Set())}><Icon name="x" size={13} />Clear selection</button>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderTop: "1px solid #ebedf0", fontSize: 12, color: "#555a64" }}>
                <Icon name="info" size={14} />
                {q
                  ? "Agents matching your search are listed first; the count is the whole list, as in the Database app."
                  : <>Tick agents to move them to your prospects, My Agents or DNC List. To move one agent, click its list in the List&nbsp;column.</>}
              </div>
            )}
            <div style={{ overflow: "visible", ...(picked.size > 0 ? {} : { borderTop: "1px solid #ebedf0" }), opacity: state.loading && data ? 0.55 : 1 }}>
              <table className={k("tb mkt")}>
                <thead>
                  <tr>
                    <th scope="col" style={{ width: 16 }}><input type="checkbox" className={k("ck")} aria-label="Select all" checked={pageAll} onChange={() => pickRows(rowIds, !pageAll)} /></th>
                    <th scope="col">Name</th>
                    <th scope="col">Title</th>
                    <th scope="col">Brokerage</th>
                    <th scope="col">Office city</th>
                    <th scope="col">Most transacted city</th>
                    <th scope="col" className={k("r")}>Sales volume</th>
                    <th scope="col" className={k("r")}>Units</th>
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
                      <tr key={r.id} className={picked.has(String(r.id)) || rowMenu === String(r.id) ? k("sel") : undefined}>
                        <td style={{ width: 16 }}><input type="checkbox" className={k("ck")} aria-label={`Select ${r.name}`} checked={picked.has(String(r.id))} onChange={() => pickRows([String(r.id)], !picked.has(String(r.id)))} /></td>
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
                                <button key={l} type="button" role="menuitemradio" aria-checked={r.list === l} className={r.list === l ? k("hv") : undefined} {...RO}>
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
                <button type="button" className={k("btn sm")} disabled={to >= total || shownPage >= maxPage(PAGE_SIZE) || state.loading} title={shownPage >= maxPage(PAGE_SIZE) && to < total ? "A search shows its first 1,000 agents — narrow the filters to see others" : undefined} onClick={() => setPage((p) => p + 1)}>Next</button>
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
