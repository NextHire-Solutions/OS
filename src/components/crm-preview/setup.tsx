"use client";

/*
 * The redesign's Setup wizard (Setup-1-Team … Setup-6-Done, and the -Empty
 * variants), on the client's real lists: their team, My Agents, DNC List,
 * market and prospects. The design draws it full-page, without the sidebar.
 * Moving between steps works; anything that would add, remove or save is
 * inert (k.ts RO). The design shows each step's "-Empty" variant when its
 * list is empty; so does the preview.
 *
 * Names here are the setup family's (scripts/crm-preview-css.mjs): .sbulk
 * .sacts .snx .ssec.
 */

import { useEffect, useMemo, useState } from "react";

import type { TeamMember } from "@/lib/tools/master-inbox/portals/stages-shared";
import type { AgentEntry, DncEntry } from "@/lib/tools/master-inbox/portals/portal-data";
import { abbrevUsd, formatPhone, initials } from "@/lib/crm-preview/model";
import { SETUP_PAGE_SIZE, UNIT_PRESETS, VOLUME_PRESETS, YEAR_PRESETS } from "@/lib/crm-preview/market-model";

import { Icon } from "./icons";
import { k, RO, withIds } from "./k";
import { Chip, NO_FILTERS, type Filters, type Row } from "./market";
import logo from "./brokerstaffer-logo.png";

const STEPS = ["Welcome and your team", "My Agents", "DNC List", "Who we email", "Your offer"] as const;
const PER = SETUP_PAGE_SIZE;

export interface SetupClient {
  id: string;
  name: string;
  contactName: string | null;
  /** What the client's record says it covers (areas, else MLS), for the welcome line. */
  coverage: string | null;
}

const fmt = (n: number) => n.toLocaleString("en-US");
const has = (q: string, ...vals: Array<string | null | undefined>) => {
  const s = q.trim().toLowerCase();
  return !s || vals.some((v) => (v ?? "").toLowerCase().includes(s));
};

/* The List column's tags (Setup-2/3/4): My agent, DNC List, Prospects; anything else as plain grey text. */
function ListTag({ list }: { list: string }) {
  if (list === "My Agents") return <span className={k("tag ok")}>My agent</span>;
  if (list === "DNC List") return <span className={k("tag no")}>DNC List</span>;
  if (list === "Prospects") return <span className={k("tag ltg")}>Prospects</span>;
  return <span className={k("sub")}>{list}</span>;
}

/* "1-8 of 41,870 matching agents" · Previous · Next, as the design writes it. */
function Pager({ page, total, onPage }: { page: number; total: number; onPage: (p: number) => void }) {
  if (total === 0) return null;
  const from = (page - 1) * PER + 1;
  const to = Math.min(total, page * PER);
  return (
    <div className={k("tf")}>
      <span>{fmt(from)}-{fmt(to)} of {fmt(total)} matching agents</span>
      <div className={k("pg")}>
        <button className={k("btn sm")} type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
        <button className={k("btn sm")} type="button" disabled={to >= total} onClick={() => onPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}

function Head({ step, title, text, actions }: { step: number; title: string; text: string; actions?: React.ReactNode }) {
  return (
    <div className={k("hd")}>
      <div>
        <span className={k("ey")}>Step {step} of 5 · {STEPS[step - 1]}</span>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
      {actions ? <div className={k("sacts")}>{actions}</div> : null}
    </div>
  );
}

function Tabs<T extends string>({ tabs, on, onTab }: { tabs: Array<{ id: T; label: string; count: number | null }>; on: T; onTab: (id: T) => void }) {
  return (
    <div className={k("ctabs")} role="tablist" aria-label="List">
      {tabs.map((t) => (
        <button key={t.id} className={k(t.id === on ? "ctab on" : "ctab")} type="button" role="tab" aria-selected={t.id === on} onClick={() => onTab(t.id)}>
          {t.label}<span>{t.count === null ? "…" : fmt(t.count)}</span>
        </button>
      ))}
    </div>
  );
}

const Divider = () => <span style={{ width: 1, height: 20, background: "#ebedf0", margin: "0 4px" }} />;

/* A table with nobody in it says why (a client with no MLS on record has no market). */
function NoRows({ cols, why }: { cols: number; why: string }) {
  return <tr><td /><td colSpan={cols - 1} className="cpv-muted" style={{ padding: "18px 0" }}>{why}</td></tr>;
}

/* The design's search box is 280px for "Search all 41,870 agents in your market"; a longer count widens it rather than cutting the word off. */
const searchWidth = (placeholder: string) => Math.max(280, 280 + (placeholder.length - 39) * 7);

/** A page of the client's market or prospects, eight at a time, from the preview's market route. */
function useMarket(clientId: string, list: "market" | "prospects", page: number, q: string, f: Filters, enabled = true) {
  const [state, setState] = useState<{ total: number | null; rows: Row[]; loading: boolean; unavailable: string | null }>({ total: null, rows: [], loading: true, unavailable: null });
  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    const sp = new URLSearchParams({ client: clientId, list, page: String(page), per: String(PER) });
    if (q) sp.set("q", q);
    if (f.minVolume) sp.set("minVolume", String(f.minVolume));
    if (f.minUnits) sp.set("minUnits", String(f.minUnits));
    if (f.minYears) sp.set("minYears", String(f.minYears));
    if (f.brokerage) sp.set("brokerage", f.brokerage);
    if (f.county) sp.set("county", f.county);
    setState((s) => ({ ...s, loading: true }));
    fetch(`/api/crm-preview/market?${sp.toString()}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((j) => setState({ total: j.unavailable ? 0 : j.total ?? 0, rows: j.rows ?? [], loading: false, unavailable: j.unavailable ?? null }))
      .catch((err) => { if (err?.name !== "AbortError") setState((s) => ({ ...s, loading: false })); });
    return () => ctrl.abort();
  }, [clientId, list, page, q, f, enabled]);
  return state;
}

/* The market's filter choices (Location, Brokerage) — the same lists as Market's chips. */
function useOptions(clientId: string) {
  const [options, setOptions] = useState<{ brokerages: string[]; counties: string[] } | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    const sp = new URLSearchParams({ client: clientId, list: "market", page: "1", per: String(PER), options: "1" });
    fetch(`/api/crm-preview/market?${sp.toString()}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((j) => { if (j.options) setOptions(j.options); })
      .catch(() => {});
    return () => ctrl.abort();
  }, [clientId]);
  return options;
}

function useDebounced(value: string) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value.trim()), 400);
    return () => clearTimeout(t);
  }, [value]);
  return v;
}

// ------------------------------------------------------------- the steps ---

function TeamStep({ client, team }: { client: SetupClient; team: TeamMember[] }) {
  const first = (client.contactName ?? client.name).split(/\s+/)[0];
  const you = (client.contactName ?? "").trim().toLowerCase();
  return (
    <>
      <Head step={1} title={`Welcome to BrokerStaffer, ${first}.`} text={client.coverage ?? client.name} />
      <div className={k("card")}>
        <div className={k("ssec")}>
          <div>
            <h2>Your team</h2>
            <p>When an agent replies interested, we forward the email thread to everyone with &quot;Gets interested agents&quot;&nbsp;on.</p>
          </div>
          <button className={k("btn")} type="button" {...RO}><Icon name="plus" size={15} />Add member</button>
        </div>
        <table className={k("tb")} style={{ borderTop: "1px solid #ebedf0" }}>
          <thead>
            <tr>
              <th>Member</th>
              <th>Title</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Gets interested agents</th>
              <th className={k("r")}><span style={{ position: "absolute", left: -9999 }}>Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {team.map((m) => {
              const isYou = !!you && m.name.trim().toLowerCase() === you;
              return (
                <tr key={m.id}>
                  <td>
                    <span className={k("nmw")}>
                      <span className={k("av")}>{initials(m.name)}</span>
                      <span className={k("nm")}>{m.name}</span>
                      {isYou ? <span className={k("tag")}>You</span> : null}
                    </span>
                  </td>
                  <td>{m.title || "–"}</td>
                  <td>{m.email}</td>
                  <td className={k("sub")}>{formatPhone(m.phone) ?? "–"}</td>
                  <td><span className={k(m.active ? "sw" : "sw off")} role="switch" aria-checked={m.active} aria-label={`${m.name} gets interested agents`} {...RO} /></td>
                  <td className={k("r")}>
                    <button className={k("ib")} type="button" aria-label={`Edit ${m.name}`} {...RO}><Icon name="pencil" size={16} /></button>
                    {isYou ? null : <button className={k("ib")} type="button" aria-label={`Remove ${m.name}`} {...RO}><Icon name="trash" size={16} /></button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {team.length <= 1 ? (
          <div className={k("addrow")}>
            <span>Add the recruiters and managers who should get interested agents by&nbsp;email.</span>
            <button className={k("btn sm")} type="button" {...RO}><Icon name="plus" size={14} />Add member</button>
          </div>
        ) : null}
      </div>
    </>
  );
}

function AgentsStep({ clientId, agents }: { clientId: string; agents: AgentEntry[] }) {
  const [tab, setTab] = useState<"market" | "mine">("market");
  const [search, setSearch] = useState("");
  const q = useDebounced(search);
  const [page, setPage] = useState(1);
  const market = useMarket(clientId, "market", tab === "market" ? page : 1, tab === "market" ? q : "", NO_FILTERS);
  useEffect(() => setPage(1), [tab, q]);
  const mine = useMemo(() => agents.filter((a) => has(q, a.name, a.email, a.phone)), [agents, q]);
  const rows: Array<{ id: string; name: string; office: string | null; city: string | null; email: string | null; years: number | null; list: string }> =
    tab === "market"
      ? market.rows.map((r) => ({ id: r.id, name: r.name, office: r.office ?? r.brokerage, city: r.officeCity, email: r.email ?? null, years: r.years ?? null, list: r.list }))
      : mine.slice((page - 1) * PER, page * PER).map((a) => ({ id: a.id, name: a.name, office: null, city: null, email: a.email, years: null, list: "My Agents" }));
  const total = tab === "market" ? market.total ?? 0 : mine.length;
  const n = agents.length;
  // As the design draws it: a row is ticked when the agent is on My Agents; ticking or unticking would change the list, so it is inert.
  const onList = (r: { list: string }) => r.list === "My Agents";
  const ticked = rows.filter(onList).length;
  const placeholder = `Search all ${fmt(market.total ?? 0)} agents in your market`;
  return (
    <>
      <Head
        step={2}
        title="Find your agents"
        text={"Everyone already on your team. Search your market by your office, tick your agents and add them. We never email anyone on this\u00a0list."}
        actions={<button className={k("btn")} type="button" {...RO}><Icon name="upload" size={15} />Import CSV</button>}
      />
      <div className={k("card")}>
        <Tabs tabs={[{ id: "market", label: "All agents in your market", count: market.total }, { id: "mine", label: "My Agents", count: n }]} on={tab} onTab={setTab} />
        <div className={k("tbar")}>
          <label className={k("srch")} style={{ width: searchWidth(placeholder) }}>
            <Icon name="search" size={15} />
            <input id="crx-setup-agents-search" type="search" placeholder={placeholder} aria-label="Search agents in your market" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <Divider />
          <button className={k("dd")} type="button" {...RO}>Office<Icon name="chevDown" size={14} /></button>
          <button className={k("dd")} type="button" {...RO}>Brokerage<Icon name="chevDown" size={14} /></button>
          <button className={k("dd")} type="button" {...RO}>City<Icon name="chevDown" size={14} /></button>
          <button className={k("dd")} type="button" {...RO}>Years licensed<Icon name="chevDown" size={14} /></button>
          <button className={k("clr")} type="button" onClick={() => setSearch("")}>Clear all</button>
        </div>
        {n === 0 ? (
          <div className={k("sbulk idle")}>
            <span className={k("bt")}>No agents added yet. Filter by your office to find them, or import a&nbsp;CSV.</span>
            <button className={k("btn sm")} type="button" disabled>Add to My Agents</button>
          </div>
        ) : tab === "mine" ? (
          <div className={k("sbulk")}>
            <span className={k("bt")}><b className={k("num")}>{fmt(n)}</b>{" "}agents match ·{" "}<span className={k("sub")}>all {fmt(n)} added to My Agents</span></span>
            <button className={k("btn sm")} type="button" {...RO}>Remove selected</button>
          </div>
        ) : (
          <div className={k("sbulk idle")}>
            <span className={k("bt")}><b className={k("num")}>{fmt(total)}</b>{" "}agents match ·{" "}<span className={k("sub")}>{fmt(n)} added to My Agents</span></span>
            <button className={k("btn sm")} type="button" {...RO}>{ticked ? "Remove selected" : "Add to My Agents"}</button>
          </div>
        )}
        <table className={k("tb")}>
          <thead>
            <tr>
              <th style={{ width: 20 }}><input type="checkbox" aria-label="Select all" checked={rows.length > 0 && ticked === rows.length} readOnly {...RO} /></th>
              <th>Agent</th>
              <th>Office</th>
              <th>City</th>
              <th>Email</th>
              <th className={k("r")}>Licensed</th>
              <th>List</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !(tab === "market" && market.loading) ? <NoRows cols={7} why={tab === "market" ? market.unavailable ?? "No agents match." : "No agents on My Agents yet."} /> : null}
            {rows.map((r) => (
              <tr key={r.id} className={onList(r) ? k("sel") : undefined}>
                <td><input type="checkbox" aria-label={`Select ${r.name}`} checked={onList(r)} readOnly {...RO} /></td>
                <td className={k("nm")}>{r.name}</td>
                <td>{r.office ?? "–"}</td>
                <td>{r.city ?? "–"}</td>
                <td>{r.email ?? "–"}</td>
                <td className={k("r")}>{r.years !== null ? `${r.years} yrs` : "–"}</td>
                <td><ListTag list={r.list} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager page={page} total={total} onPage={setPage} />
      </div>
    </>
  );
}

function DncStep({ dnc }: { dnc: DncEntry[] }) {
  const [tab, setTab] = useState<"agents" | "companies">("agents");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const people = useMemo(() => dnc.filter((d) => d.kind === "agent"), [dnc]);
  const companies = useMemo(() => dnc.filter((d) => d.kind === "company"), [dnc]);
  useEffect(() => setPage(1), [tab, q]);
  if (dnc.length === 0) {
    return (
      <>
        <Head step={3} title="Your DNC List" text={"Sister offices, referral partners, former agents. We never email anyone on this list. Adding a company blocks every agent at its email\u00a0domain."} />
        <div className={k("card emp")}>
          <span className={k("ei")}><Icon name="ban" size={22} /></span>
          <h2>Your DNC List is empty</h2>
          <p>Add the agents and companies we should never email. Search your market, block a whole company by its email domain, or import a&nbsp;CSV.</p>
          <div className={k("ea")}>
            <button className={k("btn")} type="button" {...RO}><Icon name="plus" size={15} />Add agent</button>
            <button className={k("btn")} type="button" {...RO}><Icon name="ban" size={15} />Add company</button>
            <button className={k("btn")} type="button" {...RO}><Icon name="upload" size={15} />Import CSV</button>
          </div>
        </div>
      </>
    );
  }
  const list = (tab === "agents" ? people : companies).filter((d) => has(q, d.name, d.email, d.brokerage, d.domain));
  const names = companies.map((c) => c.name);
  const blocked = names.length === 0 ? "" : names.length === 1 ? ` (${names[0]})` : names.length === 2 ? ` (${names[0]} and ${names[1]})` : ` (${names[0]}, ${names[1]} and ${fmt(names.length - 2)} more)`;
  return (
    <>
      <Head
        step={3}
        title="Your DNC List"
        text={"Sister offices, referral partners, former agents. We never email anyone on this list. Adding a company blocks every agent at its email\u00a0domain."}
        actions={<>
          <button className={k("btn")} type="button" {...RO}><Icon name="plus" size={15} />Add agent</button>
          <button className={k("btn")} type="button" {...RO}><Icon name="ban" size={15} />Add company</button>
          <button className={k("btn")} type="button" {...RO}><Icon name="upload" size={15} />Import CSV</button>
        </>}
      />
      <div className={k("card")}>
        <Tabs tabs={[{ id: "agents", label: "Agents", count: people.length }, { id: "companies", label: "Companies", count: companies.length }]} on={tab} onTab={setTab} />
        <div className={k("tbar")}>
          <label className={k("srch")} style={{ width: 280 }}>
            <Icon name="search" size={15} />
            <input id="crx-setup-dnc-search" type="search" placeholder="Search your DNC List" aria-label="Search your DNC List" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <Divider />
          <button className={k("dd")} type="button" {...RO}>Brokerage<Icon name="chevDown" size={14} /></button>
          <button className={k("dd")} type="button" {...RO}>Office<Icon name="chevDown" size={14} /></button>
          <button className={k("dd")} type="button" {...RO}>City<Icon name="chevDown" size={14} /></button>
          <button className={k("clr")} type="button" onClick={() => setQ("")}>Clear all</button>
        </div>
        <div className={k("sbulk idle")}>
          <span className={k("bt")}><b className={k("num")}>{fmt(people.length)}</b>{" "}agents ·{" "}<b className={k("num")}>{fmt(companies.length)}</b>{" "}companies blocked{blocked}</span>
          <button className={k("btn sm")} type="button" {...RO}>Remove selected</button>
        </div>
        <table className={k("tb")}>
          <thead>
            <tr>
              <th style={{ width: 20 }}><input type="checkbox" aria-label="Select all" {...RO} /></th>
              <th>Agent</th>
              <th>Office</th>
              <th>City</th>
              <th>Email</th>
              <th className={k("r")}>Licensed</th>
              <th>List</th>
            </tr>
          </thead>
          <tbody>
            {list.slice((page - 1) * PER, page * PER).map((d) => (
              <tr key={d.id}>
                <td><input type="checkbox" aria-label={`Select ${d.name}`} {...RO} /></td>
                <td className={k("nm")}>{d.name}</td>
                <td>{(d.kind === "agent" ? d.brokerage : null) ?? "–"}</td>
                <td>–</td>
                <td>{d.kind === "company" ? (d.domain ? `@${d.domain}` : "–") : d.email ?? "–"}</td>
                <td className={k("r")}>–</td>
                <td><span className={k("tag no")}>DNC List</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager page={page} total={list.length} onPage={setPage} />
      </div>
    </>
  );
}

function TargetStep({ clientId, onProspects }: { clientId: string; onProspects: (n: number) => void }) {
  const [tab, setTab] = useState<"market" | "prospects">("market");
  const [search, setSearch] = useState("");
  const q = useDebounced(search);
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [page, setPage] = useState(1);
  const [menu, setMenu] = useState<string | null>(null);
  const options = useOptions(clientId);
  const all = useMarket(clientId, "market", 1, "", NO_FILTERS);
  const prospects = useMarket(clientId, "prospects", tab === "prospects" ? page : 1, tab === "prospects" ? q : "", NO_FILTERS);
  const filtered = useMarket(clientId, "market", page, q, f, tab === "market");
  useEffect(() => setPage(1), [tab, q, f]);
  useEffect(() => { if (prospects.total !== null) onProspects(prospects.total); }, [prospects.total, onProspects]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as Element)?.closest?.("[data-chip]")) setMenu(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [menu]);
  const set = <K extends keyof Filters>(key: K, v: Filters[K]) => { setF((x) => ({ ...x, [key]: v })); setMenu(null); };
  const any = Object.values(f).some((v) => v !== null) || !!q;
  const shown = tab === "market" ? filtered : prospects;
  const marketTotal = all.total ?? 0;
  // As the design draws it: a row is ticked when the agent is in the client's prospects; changing that is inert.
  const inProspects = (r: Row) => tab === "prospects" || r.list === "Prospects";
  return (
    <>
      <Head step={4} title="Choose who we email" text={"Every active agent in your market. Filter them, then add the ones you want to your prospects. My Agents and your DNC List are always left\u00a0out."} />
      <div className={k("card")}>
        <Tabs tabs={[{ id: "market", label: "All agents in your market", count: all.total }, { id: "prospects", label: "Prospects", count: prospects.total }]} on={tab} onTab={setTab} />
        <div className={k("tbar")}>
          <label className={k("srch")} style={{ width: 280 }}>
            <Icon name="search" size={15} />
            <input id="crx-setup-target-search" type="search" placeholder="Search agents in your market" aria-label="Search agents in your market" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <Divider />
          <Chip bold id="county" label="Location" value={f.county} show={(v) => v} choices={options?.counties ?? []} open={menu === "county"} onOpen={setMenu} onPick={(v) => set("county", v)} />
          <Chip bold id="volume" label="Sales volume" value={f.minVolume} show={(v) => `${abbrevUsd(v)}+`} choices={VOLUME_PRESETS} open={menu === "volume"} onOpen={setMenu} onPick={(v) => set("minVolume", v)} />
          <Chip bold id="units" label="Units" value={f.minUnits} show={(v) => `${v}+`} choices={UNIT_PRESETS} open={menu === "units"} onOpen={setMenu} onPick={(v) => set("minUnits", v)} />
          <Chip bold id="years" label="Years licensed" value={f.minYears} show={(v) => `${v}+`} choices={YEAR_PRESETS} open={menu === "years"} onOpen={setMenu} onPick={(v) => set("minYears", v)} />
          <Chip bold id="brokerage" label="Brokerage" value={f.brokerage} show={(v) => v} choices={options?.brokerages ?? []} open={menu === "brokerage"} onOpen={setMenu} onPick={(v) => set("brokerage", v)} />
          <button className={k("clr")} type="button" onClick={() => { setF(NO_FILTERS); setSearch(""); }}>Clear all</button>
        </div>
        {tab === "market" && any ? (
          <div className={k("sbulk")}>
            <span className={k("bt")}><b className={k("num")}>{fmt(filtered.total ?? 0)}</b>{" "}agents match these filters ·{" "}<span className={k("sub")}>of {fmt(marketTotal)} active in your market</span></span>
            <button className={k("btn sm")} type="button" {...RO}>Add {fmt(filtered.total ?? 0)} to prospects</button>
          </div>
        ) : (
          <div className={k("sbulk idle")}>
            <span className={k("bt")}><b className={k("num")}>{fmt(marketTotal)}</b>{" "}active agents in your market ·{" "}<span className={k("sub")}>add filters to build your prospects</span></span>
            <button className={k("btn sm")} type="button" disabled>Add to Prospects</button>
          </div>
        )}
        <table className={k("tb")}>
          <thead>
            <tr>
              <th style={{ width: 20 }}><input type="checkbox" aria-label="Select all" checked={shown.rows.length > 0 && shown.rows.every(inProspects)} readOnly {...RO} /></th>
              <th>Agent</th>
              <th>Brokerage</th>
              <th>City</th>
              <th className={k("r")}>Sales volume</th>
              <th className={k("r")}>Units</th>
              <th className={k("r")}>Licensed</th>
              <th>List</th>
            </tr>
          </thead>
          <tbody>
            {shown.rows.length === 0 && !shown.loading ? <NoRows cols={8} why={shown.unavailable ?? "No agents match."} /> : null}
            {shown.rows.map((r) => (
              <tr key={r.id} className={inProspects(r) ? k("sel") : undefined}>
                <td><input type="checkbox" aria-label={`Select ${r.name}`} checked={inProspects(r)} readOnly {...RO} /></td>
                <td className={k("nm")}>{r.name}</td>
                <td>{r.brokerage ?? "–"}</td>
                <td>{r.officeCity ?? "–"}</td>
                <td className={k("r")}>{r.salesVolume !== null ? abbrevUsd(r.salesVolume) : "–"}</td>
                <td className={k("r")}>{r.units ?? "–"}</td>
                <td className={k("r")}>{r.years !== null && r.years !== undefined ? `${r.years} yrs` : "–"}</td>
                <td><ListTag list={r.list} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager page={page} total={shown.total ?? 0} onPage={setPage} />
      </div>
    </>
  );
}

const OFFERS = [
  "Leads, including Zillow Preferred",
  "Transaction coordinator",
  "Coaching and training",
  "Competitive commission split",
  "Marketing done for them",
  "Tech and CRM included",
  "Team culture and events",
  "Path to leadership",
] as const;

/* The client's offer is not on record anywhere yet, so the step opens empty (Setup-5-Offer-Empty); ticking and typing work, nothing is kept. */
function OfferStep({ onReady }: { onReady: (ready: boolean) => void }) {
  const [on, setOn] = useState<ReadonlySet<string>>(new Set());
  const [why, setWhy] = useState("");
  useEffect(() => onReady(on.size > 0 && !!why.trim()), [on, why, onReady]);
  return (
    <>
      <Head step={5} title="Tell us your offer" text={"We write your emails from this. You'll see them and approve them before anything goes\u00a0out."} />
      <div className={k("card cpad")} style={{ display: "flex", flexDirection: "column", gap: 22 }}>
        <fieldset>
          <legend>What do you give agents who join?{" "}<small>Pick everything that applies.</small></legend>
          <div className={k("ckg")}>
            {OFFERS.map((o) => (
              <label key={o} className={k(on.has(o) ? "ckl on" : "ckl")}>
                <input type="checkbox" checked={on.has(o)} onChange={() => setOn((cur) => withIds(cur, [o], !cur.has(o)))} />
                {o}
              </label>
            ))}
          </div>
        </fieldset>
        <label className={k("slb")}>
          In a sentence or two, why do agents join you?
          <textarea className={k("ta")} rows={3} placeholder="e.g. Steady leads from day one and a TC who handles every file" value={why} onChange={(e) => setWhy(e.target.value)} />
        </label>
        <label className={k("slb")}>
          <span>Anything we should never say?{" "}<small>Optional. Competitors you don&apos;t want named, claims to avoid.</small></span>
          <textarea className={k("ta")} rows={2} placeholder="e.g. Don't mention splits in the first email" />
        </label>
      </div>
    </>
  );
}

function DoneStep({ client, onExit }: { client: SetupClient; onExit: () => void }) {
  const first = (client.contactName ?? client.name).split(/\s+/)[0];
  return (
    <div className={k("card")} style={{ padding: "36px 40px", maxWidth: 560, display: "flex", flexDirection: "column", gap: 20 }}>
      <span style={{ width: 44, height: 44, borderRadius: 99, background: "#e9f6ee", color: "#1a7f38", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Icon name="check" size={22} stroke={2.4} />
      </span>
      <h1 style={{ margin: "0", fontSize: 22, fontWeight: 600, letterSpacing: "-0.01em" }}>You&apos;re all set, {first}.</h1>
      <div style={{ borderTop: "1px solid #f1f2f4", paddingTop: 16 }}>
        <p className={k("cttl")} style={{ marginBottom: 12 }}>What happens next</p>
        <ol className={k("snx")}>
          <li><span className={k("n")}>1</span><span>We write your emails and send them to you for&nbsp;approval.</span></li>
          <li><span className={k("n")}>2</span><span>Once you approve, your campaign goes&nbsp;live.</span></li>
          <li><span className={k("n")}>3</span><span>Agents who reply interested land in your&nbsp;pipeline.</span></li>
        </ol>
      </div>
      <div>
        <a className={k("btn pri")} href="#" onClick={(e) => { e.preventDefault(); onExit(); }}>Go to your pipeline</a>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ the frame ---

export function SetupWizard({
  client,
  team,
  agents,
  dnc,
  step,
  onStep,
  onExit,
}: {
  client: SetupClient;
  team: TeamMember[];
  agents: AgentEntry[];
  dnc: DncEntry[];
  step: number;
  onStep: (n: number) => void;
  onExit: () => void;
}) {
  const [prospects, setProspects] = useState<number | null>(null);
  const [offerReady, setOfferReady] = useState(false);
  const link = (n: number) => (e: React.MouseEvent) => { e.preventDefault(); onStep(n); };
  // The design's -Empty variants: a step with nothing on its list offers "Skip for now", and can't be saved.
  const empty = step === 2 ? agents.length === 0 : step === 3 ? dnc.length === 0 : step === 4 ? prospects === 0 : step === 5 ? !offerReady : false;
  const next = step === 5 ? "Finish setup" : "Save and continue";
  return (
    <div className={k("ob")}>
      <header className={k("top")}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a fixed-size logo, as the design draws it */}
        <img src={logo.src} alt="BrokerStaffer" style={{ width: 104, height: 32, objectFit: "contain", objectPosition: "left" }} />
        <span className={k("vr")} />
        <span className={k("lbl")}>Account setup</span>
        <div className={k("hr")} style={{ padding: "0", gap: 10 }}>
          <a className={k("btn")} href="#" onClick={(e) => { e.preventDefault(); onExit(); }}>Save and exit</a>
        </div>
      </header>
      <div className={k("obb")}>
        <nav className={k("steps")} aria-label="Setup steps">
          <span className={k("sh")}>{step >= 6 ? "Setup · all done" : `Setup · ${step - 1} of 5 done`}</span>
          {STEPS.map((label, i) => {
            const n = i + 1;
            return (
              <a key={label} className={k(n < step ? "st done" : n === step ? "st on" : "st")} href="#" aria-current={n === step ? "step" : undefined} onClick={link(n)}>
                <span className={k("n")}>{n < step ? <Icon name="check" size={13} stroke={2.4} /> : n}</span>
                {label}
              </a>
            );
          })}
        </nav>
        <main className={k("obm")}>
          <div className={k("obc")}>
            {step === 1 ? <TeamStep client={client} team={team} />
              : step === 2 ? <AgentsStep clientId={client.id} agents={agents} />
              : step === 3 ? <DncStep dnc={dnc} />
              : step === 4 ? <TargetStep clientId={client.id} onProspects={setProspects} />
              : step === 5 ? <OfferStep onReady={setOfferReady} />
              : <DoneStep client={client} onExit={onExit} />}
          </div>
          {step === 1 ? (
            <footer className={k("obf")}>
              <div className={k("rt")}><a className={k("btn pri")} href="#" onClick={link(2)}>Save and continue</a></div>
            </footer>
          ) : step <= 5 ? (
            <footer className={k("obf")}>
              <a className={k("btn")} href="#" onClick={link(step - 1)}><Icon name="arrowLeft" size={15} />Back</a>
              <div className={k("rt")}>
                {empty && (step === 2 || step === 3) ? <a className={k("btn")} href="#" style={{ borderColor: "transparent", color: "#555a64" }} onClick={link(step + 1)}>Skip for now</a> : null}
                {empty ? (
                  <button className={k("btn pri")} type="button" disabled style={{ opacity: 0.5, cursor: "default", color: "#fff", borderColor: "#3e6bd1" }}>{next}</button>
                ) : (
                  <a className={k("btn pri")} href="#" onClick={link(step + 1)}>{next}</a>
                )}
              </div>
            </footer>
          ) : null}
        </main>
      </div>
    </div>
  );
}
