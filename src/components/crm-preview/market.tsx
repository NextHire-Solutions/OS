"use client";

/*
 * The redesign's Market and Prospects (one table, two lists) and Reports, on
 * the client's real market — read from the agent database through the
 * preview's own GET routes (src/app/api/crm-preview). Moving agents between
 * lists, importing and exporting are drawn disabled.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { PipelineEntry } from "@/lib/tools/master-inbox/portals/stages-shared";
import { abbrevUsd, initials } from "@/lib/crm-preview/model";
import { interestedReport, TITLES, UNIT_PRESETS, VOLUME_PRESETS, YEAR_PRESETS, type GroupRow, type ReportGroup } from "@/lib/crm-preview/market-model";

import { Icon } from "./icons";
import { k, RO } from "./k";

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

type Row = {
  id: string; name: string; title: string | null; brokerage: string | null; officeCity: string | null;
  mostTransactedCity: string | null; salesVolume: number | null; units: number | null; list: string; pill: string;
};
type Filters = { minVolume: number | null; minUnits: number | null; minYears: number | null; brokerage: string | null; county: string | null; title: string | null };
const NO_FILTERS: Filters = { minVolume: null, minUnits: null, minYears: null, brokerage: null, county: null, title: null };

type Loaded = { total: number; page: number; rows: Row[]; client: string | null; mls: Mls | null };

function Chip<T extends string | number>({
  id, label, value, show, choices, open, onOpen, onPick, hint,
}: {
  id: string; label: string; value: T | null; show: (v: T) => string; choices: readonly T[];
  open: boolean; onOpen: (id: string | null) => void; onPick: (v: T | null) => void; hint?: string;
}) {
  return (
    <span style={{ position: "relative", display: "inline-flex" }} data-chip={id}>
      <button type="button" className={k(value !== null ? "dd set" : "dd")} aria-haspopup="menu" aria-expanded={open} onClick={() => onOpen(open ? null : id)}>
        {value !== null ? `${label}: ${show(value)}` : label}
        <Icon name="chevDown" size={14} />
      </button>
      {open ? (
        <div className={k("mmenu")} role="menu" style={{ top: "calc(100% + 4px)", left: 0, maxHeight: 320, overflowY: "auto" }}>
          {hint ? <div style={{ padding: "6px 10px 8px", fontSize: 12, color: "#6b7280", lineHeight: 1.45 }}>{hint}</div> : null}
          <button type="button" role="menuitemradio" aria-checked={value === null} className={value === null ? k("hv") : undefined} onClick={() => onPick(null)}>
            Any{value === null ? <span style={{ marginLeft: "auto", display: "inline-flex" }}><Icon name="check" size={14} /></span> : null}
          </button>
          {choices.map((c) => (
            <button key={String(c)} type="button" role="menuitemradio" aria-checked={value === c} className={value === c ? k("hv") : undefined} onClick={() => onPick(c)}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{show(c)}</span>
              {value === c ? <span style={{ marginLeft: "auto", display: "inline-flex" }}><Icon name="check" size={14} /></span> : null}
            </button>
          ))}
          {choices.length === 0 ? <div style={{ padding: "6px 10px", fontSize: 12, color: "#6b7280" }}>Loading…</div> : null}
        </div>
      ) : null}
    </span>
  );
}

export function MarketScreen({ clientId, list, onContext }: { clientId: string; list: "market" | "prospects"; onContext?: (text: string | null) => void }) {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [page, setPage] = useState(1);
  const [menu, setMenu] = useState<string | null>(null);
  const [state, setState] = useState<{ loading: boolean; error: string | null; unavailable: string | null; data: Loaded | null }>({ loading: true, error: null, unavailable: null, data: null });
  const [options, setOptions] = useState<{ brokerages: string[]; counties: string[] } | null>(null);
  const bar = useRef<HTMLDivElement>(null);

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
                    hint="Recorded for few agents in the database (about 1 in 80), so this keeps only agents with a recorded figure."
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
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderTop: "1px solid #ebedf0", fontSize: 12, color: "#555a64" }}>
              <Icon name="info" size={14} />
              {q
                ? "Agents matching your search are listed first; the count is the whole list, as in the Database app."
                : <>Tick agents to move them to your prospects, My Agents or DNC List. To move one agent, click its list in the List&nbsp;column.</>}
            </div>
            <div style={{ overflow: "visible", borderTop: "1px solid #ebedf0", opacity: state.loading && data ? 0.55 : 1 }}>
              <table className={k("tb mkt")}>
                <thead>
                  <tr>
                    <th scope="col" style={{ width: 16 }}><input type="checkbox" className={k("ck")} aria-label="Select all" {...RO} /></th>
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
                      <tr key={r.id}>
                        <td style={{ width: 16 }}><input type="checkbox" className={k("ck")} aria-label={`Select ${r.name}`} {...RO} /></td>
                        <td><div style={{ display: "flex", alignItems: "center", gap: 10 }}><span className={k("av")}>{initials(r.name)}</span><span className={k("nm")}>{r.name}</span></div></td>
                        <td>{r.title ?? <span className={k("dash")}>&ndash;</span>}</td>
                        <td>{r.brokerage ?? <span className={k("dash")}>&ndash;</span>}</td>
                        <td>{r.officeCity ?? <span className={k("dash")}>&ndash;</span>}</td>
                        <td>{r.mostTransactedCity ?? <span className={k("dash")}>&ndash;</span>}</td>
                        <td className={k("r")}><span className={k("num")} style={{ fontWeight: 500 }}>{r.salesVolume !== null ? abbrevUsd(r.salesVolume) : "–"}</span></td>
                        <td className={k("r")}>{r.units ?? "–"}</td>
                        <td style={{ position: "relative" }}>
                          <button type="button" className={k("lsel")} aria-label={`Change list for ${r.name}`} aria-haspopup="menu" {...RO}>
                            <span className={k(`pill ${r.pill}`)}>{r.list}</span>
                            <Icon name="chevDown" size={12} />
                          </button>
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
                <button type="button" className={k("btn sm")} disabled={to >= total || shownPage >= 200 || state.loading} onClick={() => setPage((p) => p + 1)}>Next</button>
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

function ReportCard({ group, interested, all }: { group: ReportGroup; interested: boolean; all?: GroupRow[] }) {
  const [open, setOpen] = useState(false);
  const known = group.rows.filter((r) => r.label !== "Unknown");
  const unknown = group.rows.find((r) => r.label === "Unknown");
  const full = open && all ? all : known;
  const isList = Boolean(NOUN[group.title]);
  const rows = [...(isList && !open ? full.slice(0, 8) : full), ...(unknown ? [unknown] : [])];
  const max = Math.max(1, ...rows.map((r) => r.n));
  const more = isList && ((all && all.length > 8) || known.length > 8);
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
          <span>
            {open ? `All ${full.length}` : `Top ${Math.min(8, known.length)}`}
            {group.of && !open ? ` of ${group.of.total.toLocaleString("en-US")}` : ""} {NOUN[group.title]}
            {!group.of && !open && all && all.length >= 50 ? " (the largest 50 are listed)" : ""}
          </span>
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
