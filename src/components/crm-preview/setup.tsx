"use client";

/*
 * The redesign's Setup wizard (Setup-1-Team … Setup-6-Done, and the -Empty
 * variants), on the client's real lists: their team, My Agents, DNC List,
 * market and prospects. The design draws it full-page, without the sidebar.
 * Moving between steps works; anything that would add, remove or save is
 * inert (k.ts RO). The design shows each step's "-Empty" variant when its
 * list is empty; so does the preview.
 *
 * On the Demo Portal (22 Oct) the wizard's own lists save, as the pages do
 * (demo-save.ts): the team (add, edit, remove, the switch), My Agents and DNC
 * (add by hand, Import CSV, remove). Ticking agents from the market is shown
 * on the page only and never saved — those are real agents (the Demo's sample
 * market), and a DNC address would also stop the reply agent answering that
 * person for every client (the user, 22 Oct: "Show only, don't save").
 * "Who we email" (prospects) and "Your offer" stay as drawn.
 *
 * The two market steps (My Agents, Who we email) filter with Market's own
 * filter bar (market.tsx MarketFilters, 28 Oct) — the same panels, the same
 * query, so a count here is the count on Market.
 *
 * Names here are the setup family's (scripts/crm-preview-css.mjs): .sbulk
 * .sacts .snx .ssec.
 */

import { useEffect, useMemo, useState } from "react";

import type { TeamMember } from "@/lib/tools/master-inbox/portals/stages-shared";
import type { AgentEntry, DncEntry } from "@/lib/tools/master-inbox/portals/portal-data";
import { abbrevUsd, formatPhone, initials, SETUP_OFFERS, type PortalOffer } from "@/lib/crm-preview/model";
import { maxPage, SETUP_PAGE_SIZE } from "@/lib/crm-preview/market-model";

import { csvRowToAgent, csvRowToDnc } from "@/lib/tools/master-inbox/portals/csv";

import { Icon } from "./icons";
import { k, off, RO, withIds } from "./k";
import { anyPicks, Chip, MarketFilters, NO_PICKS, pickParams, type Picks, type Row } from "./market";
import { DncAddDialog, ImportDialog, TeamAddForm } from "./dialogs";
import { importCsv, useDemo } from "./demo-save";
import { firstName } from "@/lib/crm-preview/signed-in";
import logo from "./brokerstaffer-logo.png";

const STEPS = ["Welcome and your team", "My Agents", "DNC List", "Who we email", "Your offer"] as const;
const PER = SETUP_PAGE_SIZE;

export interface SetupClient {
  id: string;
  name: string;
  contactName: string | null;
  /** The signed-in person's address: their team row is "You" (and can't be removed). */
  youEmail?: string | null;
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
        <button className={k("btn sm")} type="button" disabled={to >= total || page >= maxPage(PER)} title={page >= maxPage(PER) && to < total ? "A search shows its first 1,000 agents — narrow the filters to see others" : undefined} onClick={() => onPage(page + 1)}>Next</button>
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

/** A page of the client's market or prospects, eight at a time, from the preview's market route — filtered as Market filters (pickParams). */
function useMarket(clientId: string, list: "market" | "prospects", page: number, q: string, f: Picks, enabled = true, version = 0) {
  const [state, setState] = useState<{ total: number | null; rows: Row[]; loading: boolean; unavailable: string | null }>({ total: null, rows: [], loading: true, unavailable: null });
  const fKey = JSON.stringify(f);
  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    const sp = new URLSearchParams({ client: clientId, list, page: String(page), per: String(PER) });
    if (q) sp.set("q", q);
    pickParams(sp, f);
    setState((s) => ({ ...s, loading: true }));
    fetch(`/api/crm-preview/market?${sp.toString()}`, { signal: ctrl.signal })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        // A refusal or a server error is said, never shown as "no agents" with a count of 0 (22 Oct audit) — the total stays unknown.
        if (!r.ok) return setState({ total: null, rows: [], loading: false, unavailable: j.error ?? "The agent database could not be read just now. Please try again." });
        setState({ total: j.unavailable ? 0 : j.total ?? 0, rows: j.rows ?? [], loading: false, unavailable: j.unavailable ?? null });
      })
      .catch((err) => { if (err?.name !== "AbortError") setState({ total: null, rows: [], loading: false, unavailable: "Couldn't reach the server. Please try again." }); });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fKey stands for f
  }, [clientId, list, page, q, fKey, enabled, version]);
  return state;
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
  const first = firstName(client.contactName ?? client.name);
  const you = (client.contactName ?? "").trim().toLowerCase();
  const { live, save } = useDemo();
  const [form, setForm] = useState<"add" | TeamMember | null>(null);
  const addMember = live ? { onClick: () => setForm("add") } : RO;
  const remove = async (m: TeamMember) => { if (window.confirm(`Remove ${m.name} from the team?`)) await save({ type: "team.delete", ids: [m.id] }); };
  return (
    <>
      <Head step={1} title={first ? `Welcome to BrokerStaffer, ${first}.` : "Welcome to BrokerStaffer."} text={client.coverage ?? client.name} />
      <div className={k("card")}>
        <div className={k("ssec")}>
          <div>
            <h2>Your team</h2>
            <p>When an agent replies interested, we forward the email thread to everyone with &quot;Gets interested agents&quot;&nbsp;on.</p>
          </div>
          <button className={k("btn")} type="button" {...addMember}><Icon name="plus" size={15} />Add member</button>
        </div>
        {form ? (
          <div style={{ padding: "0 20px 16px" }}>
            <TeamAddForm
              key={form === "add" ? "add" : form.id}
              initial={form === "add" ? undefined : { name: form.name, email: form.email, title: form.title, phone: form.phone }}
              onClose={() => setForm(null)}
              onSave={(v) => (form === "add" ? save({ type: "team.add", name: v.name, email: v.email, title: v.title, phone: v.phone }) : save({ type: "team.edit", id: form.id, name: v.name, email: v.email, title: v.title, phone: v.phone }))}
            />
          </div>
        ) : null}
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
              const isYou = client.youEmail ? (m.email ?? "").trim().toLowerCase() === client.youEmail : !!you && m.name.trim().toLowerCase() === you;
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
                  <td>
                    <span
                      className={k(m.active ? "sw" : "sw off")}
                      role="switch"
                      aria-checked={m.active}
                      aria-label={`${m.name} gets interested agents`}
                      {...(live ? { tabIndex: 0, style: { cursor: "pointer" }, onClick: () => void save({ type: "team.active", id: m.id, active: !m.active }), onKeyDown: (e: React.KeyboardEvent) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); void save({ type: "team.active", id: m.id, active: !m.active }); } } } : RO)}
                    />
                  </td>
                  <td className={k("r")}>
                    <button className={k("ib")} type="button" aria-label={`Edit ${m.name}`} {...(live ? { onClick: () => setForm(m) } : RO)}><Icon name="pencil" size={16} /></button>
                    {isYou ? null : <button className={k("ib")} type="button" aria-label={`Remove ${m.name}`} {...(live ? { onClick: () => void remove(m) } : RO)}><Icon name="trash" size={16} /></button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {team.length <= 1 ? (
          <div className={k("addrow")}>
            <span>Add the recruiters and managers who should get interested agents by&nbsp;email.</span>
            <button className={k("btn sm")} type="button" {...addMember}><Icon name="plus" size={14} />Add member</button>
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
  // Market's own filters (28 Oct, the user: "the same filters ui … that we in markets page"; one pick each of Office, Brokerage, City and Years before).
  const [f, setF] = useState<Picks>(NO_PICKS);
  const [version, setVersion] = useState(0);
  const market = useMarket(clientId, "market", tab === "market" ? page : 1, tab === "market" ? q : "", f, true, version);
  useEffect(() => setPage(1), [tab, q, f]);
  const mine = useMemo(() => agents.filter((a) => has(q, a.name, a.email, a.phone)), [agents, q]);
  // Agents just added show on My Agents at once; the market's reload (a few seconds) then confirms it.
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setAdded(new Set()), [market.rows]);
  const rows: Array<{ id: string; name: string; office: string | null; city: string | null; email: string | null; years: number | null; list: string }> =
    tab === "market"
      ? market.rows.map((r) => ({ id: r.id, name: r.name, office: r.office ?? r.brokerage, city: r.officeCity, email: r.email ?? null, years: r.years ?? null, list: added.has(r.id) ? "My Agents" : r.list }))
      : mine.slice((page - 1) * PER, page * PER).map((a) => ({ id: a.id, name: a.name, office: null, city: null, email: a.email, years: null, list: "My Agents" }));
  const total = tab === "market" ? market.total ?? 0 : mine.length;
  const n = agents.length;
  const demo = useDemo();
  const { live, save } = demo;
  const [importing, setImporting] = useState(false);
  // On the Demo: market ticks live on the page only (never saved — real agents); My Agents ticks pick rows to remove.
  const [marked, setMarked] = useState<ReadonlySet<string>>(new Set());
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setPicked(new Set()), [agents]);
  // As the design draws it: a row is ticked when the agent is on My Agents; ticking or unticking would change the list, so it is inert (except on the Demo, above).
  const onList = (r: { list: string }) => r.list === "My Agents";
  const isTicked = (r: { id: string; list: string }) => (live && tab === "mine" ? picked.has(r.id) : onList(r) || (live && marked.has(r.id)));
  const ticked = rows.filter(isTicked).length;
  const tick = (r: { id: string; list: string }) => {
    if (tab === "mine") setPicked((cur) => withIds(cur, [r.id], !cur.has(r.id)));
    else if (!onList(r)) setMarked((cur) => withIds(cur, [r.id], !cur.has(r.id)));
  };
  const tickAll = () => {
    const ids = rows.filter((r) => tab === "mine" || !onList(r)).map((r) => r.id);
    const on = !ids.every((id) => (tab === "mine" ? picked : marked).has(id));
    (tab === "mine" ? setPicked : setMarked)((cur) => withIds(cur, ids, on));
  };
  // Only ticked agents still in the list (search can hide a ticked one — 22 Oct audit: hidden ticks were deleted too).
  const pickedShown = mine.filter((a) => picked.has(a.id)).map((a) => a.id);
  const removePicked = async () => {
    const ids = pickedShown;
    if (ids.length && window.confirm(`Remove ${fmt(ids.length)} ${ids.length === 1 ? "agent" : "agents"} from My Agents?`)) await save({ type: "agent.delete", ids, bulk: true });
  };
  // Ticked market agents onto My Agents (23 Oct, demo-market.ts): by name, brokerage and phone — never the agent database's email.
  const [adding, setAdding] = useState(false);
  const addMarked = async () => {
    // Every agent ticked, on any page or search (only agents not on My Agents can be ticked).
    const ids = [...marked];
    if (!ids.length) { demo.say("Tick the agents on your team first."); return; }
    // At most 500 at once on a client's own portal, as Market (portal-save.ts PORTAL_MAX_MOVE).
    if (!demo.demo && ids.length > 500) { demo.say(`That's ${fmt(ids.length)} agents — add 500 or fewer at once.`, true); return; }
    // Asked first on a client's own portal, as Market asks (28 Oct audit): My Agents are never emailed, by any campaign, for good.
    if (!demo.demo && !window.confirm(`Add ${ids.length === 1 ? "this agent" : `${fmt(ids.length)} agents`} to My Agents? We'll never email them in any campaign. This can't be undone.`)) return;
    setAdding(true);
    const ok = await save({ type: "market.move", ids, to: "My Agents" });
    setAdding(false);
    if (ok) { setAdded(new Set(ids)); setMarked(new Set()); setVersion((v) => v + 1); }
  };
  const placeholder = `Search all ${fmt(market.total ?? 0)} agents in your market`;
  return (
    <>
      <Head
        step={2}
        title="Find your agents"
        text={"Everyone already on your team. Search your market by your office, tick your agents and add them. We never email anyone on this\u00a0list."}
        actions={<button className={k("btn")} type="button" {...(live ? { onClick: () => setImporting(true) } : RO)}><Icon name="upload" size={15} />Import CSV</button>}
      />
      {importing ? <ImportDialog kind="agents" onClose={() => setImporting(false)} onFile={(f) => importCsv(f, csvRowToAgent, "agent.import", demo)} /> : null}
      <div className={k("card")}>
        <Tabs tabs={[{ id: "market", label: "All agents in your market", count: market.total }, { id: "mine", label: "My Agents", count: n }]} on={tab} onTab={setTab} />
        <div className={k("tbar")} style={{ flexWrap: "wrap" }}>
          <label className={k("srch")} style={{ width: searchWidth(placeholder) }}>
            <Icon name="search" size={15} />
            <input id="crx-setup-agents-search" type="search" placeholder={placeholder} aria-label="Search agents in your market" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          {/* The filters are the market's; My Agents is their own short list, searched only. */}
          {tab === "market" ? (
            <>
              <Divider />
              <MarketFilters clientId={clientId} list="market" value={f} onChange={setF} />
            </>
          ) : null}
          <button className={k("clr")} type="button" onClick={() => { setSearch(""); setF(NO_PICKS); }}>Clear all</button>
        </div>
        {n === 0 ? (
          <div className={k("sbulk idle")}>
            <span className={k("bt")}>No agents added yet. Filter by your office to find them, or import a&nbsp;CSV.</span>
            {live && tab === "market" ? (
              <button className={k("btn sm")} type="button" disabled={adding || marked.size === 0} onClick={() => void addMarked()}>{adding ? "Adding…" : marked.size ? `Add ${fmt(marked.size)} to My Agents` : "Add to My Agents"}</button>
            ) : (
              <button className={k("btn sm")} type="button" disabled>Add to My Agents</button>
            )}
          </div>
        ) : tab === "mine" ? (
          <div className={k("sbulk")}>
            <span className={k("bt")}><b className={k("num")}>{fmt(n)}</b>{" "}agents match ·{" "}<span className={k("sub")}>{live && pickedShown.length ? `${fmt(pickedShown.length)} selected` : `all ${fmt(n)} added to My Agents`}</span></span>
            <button className={k("btn sm")} type="button" {...(live ? { onClick: () => void removePicked(), disabled: pickedShown.length === 0 } : RO)}>Remove selected</button>
          </div>
        ) : (
          <div className={k("sbulk idle")}>
            <span className={k("bt")}><b className={k("num")}>{fmt(total)}</b>{" "}agents match ·{" "}<span className={k("sub")}>{fmt(n)} added to My Agents</span></span>
            {live ? (
              <button className={k("btn sm")} type="button" disabled={adding} onClick={() => void addMarked()}>{adding ? "Adding…" : marked.size ? `Add ${fmt(marked.size)} to My Agents` : "Add to My Agents"}</button>
            ) : (
              <button className={k("btn sm")} type="button" {...RO}>{ticked ? "Remove selected" : "Add to My Agents"}</button>
            )}
          </div>
        )}
        <table className={k("tb")}>
          <thead>
            <tr>
              <th style={{ width: 20 }}><input type="checkbox" aria-label="Select all" checked={rows.length > 0 && ticked === rows.length} {...(live ? { onChange: tickAll } : { readOnly: true, ...RO })} /></th>
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
              <tr key={r.id} className={isTicked(r) ? k("sel") : undefined}>
                <td><input type="checkbox" aria-label={`Select ${r.name}`} checked={isTicked(r)} {...(live && !(tab === "market" && onList(r)) ? { onChange: () => tick(r) } : live ? { readOnly: true, ...off(`${r.name} is on My Agents already — remove them on the My Agents tab.`) } : { readOnly: true, ...RO })} /></td>
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
  // The Brokerage filter: the brokerages on the list itself.
  const [brk, setBrk] = useState<string | null>(null);
  const [dncMenu, setDncMenu] = useState<string | null>(null);
  const brokerages = useMemo(() => [...new Set(dnc.map((d) => d.brokerage).filter((b): b is string => !!b && !!b.trim()))].sort((x, y) => x.localeCompare(y)), [dnc]);
  useEffect(() => {
    if (!dncMenu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as Element)?.closest?.("[data-chip]")) setDncMenu(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [dncMenu]);
  useEffect(() => setPage(1), [tab, q, brk]);
  const demo = useDemo();
  const { live, save } = demo;
  const [dialog, setDialog] = useState<"agent" | "company" | "import" | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setPicked(new Set()), [dnc]);
  const opens = (d: "agent" | "company" | "import") => (live ? { onClick: () => setDialog(d) } : RO);
  const dialogs = dialog === "import" ? (
    <ImportDialog kind="dnc" onClose={() => setDialog(null)} onFile={(f) => importCsv(f, csvRowToDnc, "dnc.import", demo)} />
  ) : dialog ? (
    <DncAddDialog
      initial={dialog}
      onClose={() => setDialog(null)}
      onSave={(v) => save({ type: "dnc.add", kind: v.kind === "company" ? "company" : "agent", name: v.name, email: v.email, phone: v.phone, brokerage: v.brokerage, domain: v.domain, notes: v.notes })}
    />
  ) : null;
  // Only ticked entries on the tab and search shown (22 Oct audit: ticks on the other tab were deleted too).
  const pickedIn = (rows: DncEntry[]) => rows.filter((d) => picked.has(d.id)).map((d) => d.id);
  const removePicked = async (ids: string[]) => {
    if (ids.length && window.confirm(`Remove ${fmt(ids.length)} ${ids.length === 1 ? "entry" : "entries"} from the DNC List?`)) await save({ type: "dnc.delete", ids, bulk: true });
  };
  if (dnc.length === 0) {
    return (
      <>
        <Head step={3} title="Your DNC List" text={"Sister offices, referral partners, former agents. We never email anyone on this list. Adding a company blocks every agent at its email\u00a0domain."} />
        <div className={k("card emp")}>
          <span className={k("ei")}><Icon name="ban" size={22} /></span>
          <h2>Your DNC List is empty</h2>
          <p>Add the agents and companies we should never email. Search your market, block a whole company by its email domain, or import a&nbsp;CSV.</p>
          <div className={k("ea")}>
            <button className={k("btn")} type="button" {...opens("agent")}><Icon name="plus" size={15} />Add agent</button>
            <button className={k("btn")} type="button" {...opens("company")}><Icon name="ban" size={15} />Add company</button>
            <button className={k("btn")} type="button" {...opens("import")}><Icon name="upload" size={15} />Import CSV</button>
          </div>
        </div>
        {dialogs}
      </>
    );
  }
  const list = (tab === "agents" ? people : companies).filter((d) => has(q, d.name, d.email, d.brokerage, d.domain) && (!brk || d.brokerage === brk));
  const names = companies.map((c) => c.name);
  const blocked = names.length === 0 ? "" : names.length === 1 ? ` (${names[0]})` : names.length === 2 ? ` (${names[0]} and ${names[1]})` : ` (${names[0]}, ${names[1]} and ${fmt(names.length - 2)} more)`;
  return (
    <>
      <Head
        step={3}
        title="Your DNC List"
        text={"Sister offices, referral partners, former agents. We never email anyone on this list. Adding a company blocks every agent at its email\u00a0domain."}
        actions={<>
          <button className={k("btn")} type="button" {...opens("agent")}><Icon name="plus" size={15} />Add agent</button>
          <button className={k("btn")} type="button" {...opens("company")}><Icon name="ban" size={15} />Add company</button>
          <button className={k("btn")} type="button" {...opens("import")}><Icon name="upload" size={15} />Import CSV</button>
        </>}
      />
      {dialogs}
      <div className={k("card")}>
        <Tabs tabs={[{ id: "agents", label: "Agents", count: people.length }, { id: "companies", label: "Companies", count: companies.length }]} on={tab} onTab={setTab} />
        <div className={k("tbar")}>
          <label className={k("srch")} style={{ width: 280 }}>
            <Icon name="search" size={15} />
            <input id="crx-setup-dnc-search" type="search" placeholder="Search your DNC List" aria-label="Search your DNC List" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <Divider />
          {/* Brokerage filters the list itself (23 Oct); a DNC entry records no office or city, so those two say so. */}
          <Chip id="dnc-brokerage" label="Brokerage" value={brk} show={(v) => v} choices={brokerages} open={dncMenu === "dnc-brokerage"} onOpen={setDncMenu} onPick={(v) => { setBrk(v); setDncMenu(null); }} />
          <button className={k("dd")} type="button" {...off("A DNC entry doesn't record an office, so there is nothing to filter by.")}>Office<Icon name="chevDown" size={14} /></button>
          <button className={k("dd")} type="button" {...off("A DNC entry doesn't record a city, so there is nothing to filter by.")}>City<Icon name="chevDown" size={14} /></button>
          <button className={k("clr")} type="button" onClick={() => { setQ(""); setBrk(null); }}>Clear all</button>
        </div>
        <div className={k("sbulk idle")}>
          <span className={k("bt")}><b className={k("num")}>{fmt(people.length)}</b>{" "}agents ·{" "}<b className={k("num")}>{fmt(companies.length)}</b>{" "}companies blocked{blocked}{live && pickedIn(list).length ? <> · <span className={k("sub")}>{fmt(pickedIn(list).length)} selected</span></> : null}</span>
          <button className={k("btn sm")} type="button" {...(live ? { onClick: () => void removePicked(pickedIn(list)), disabled: pickedIn(list).length === 0 } : RO)}>Remove selected</button>
        </div>
        <table className={k("tb")}>
          <thead>
            <tr>
              <th style={{ width: 20 }}>{(() => {
                const ids = list.slice((page - 1) * PER, page * PER).map((d) => d.id);
                const all = ids.length > 0 && ids.every((id) => picked.has(id));
                return <input type="checkbox" aria-label="Select all" {...(live ? { checked: all, onChange: () => setPicked((cur) => withIds(cur, ids, !all)) } : RO)} />;
              })()}</th>
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
              <tr key={d.id} className={live && picked.has(d.id) ? k("sel") : undefined}>
                <td><input type="checkbox" aria-label={`Select ${d.name}`} {...(live ? { checked: picked.has(d.id), onChange: () => setPicked((cur) => withIds(cur, [d.id], !cur.has(d.id))) } : RO)} /></td>
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

/*
 * Who we email (28 Oct, the user): the client's market to look through with Market's filters, and their prospects —
 * the agents in their campaigns, shown and never chosen here ("we will not add prospect leads to campaigns. we just
 * need to show the prospects data to client"). A new client has no campaign yet: the step says so and they carry on.
 * Nothing here saves, the Demo Portal included, so a demo shows what a client gets.
 */
function TargetStep({ clientId }: { clientId: string }) {
  const [tab, setTab] = useState<"market" | "prospects">("market");
  const [search, setSearch] = useState("");
  const q = useDebounced(search);
  // Market's own filters (28 Oct), on whichever tab is open.
  const [f, setF] = useState<Picks>(NO_PICKS);
  const [page, setPage] = useState(1);
  const all = useMarket(clientId, "market", 1, "", NO_PICKS);
  // Every prospect, for the tab's count — a search or filter never empties it.
  const prospectsAll = useMarket(clientId, "prospects", 1, "", NO_PICKS);
  const prospects = useMarket(clientId, "prospects", page, q, f, tab === "prospects");
  const filtered = useMarket(clientId, "market", page, q, f, tab === "market");
  useEffect(() => setPage(1), [tab, q, f]);
  const any = anyPicks(f) || !!q;
  const shown = tab === "market" ? filtered : prospects;
  const marketTotal = all.total ?? 0;
  // The filtered count is in, for these filters (not the last ones).
  const counted = !filtered.loading && filtered.total !== null;
  // No campaign yet (or none we can read): nothing to list, and nothing for the client to do about it.
  const noProspects = !prospectsAll.loading && (prospectsAll.total ?? 0) === 0;
  return (
    <>
      <Head step={4} title="Who we email" text={"Every active agent in your market — filter to look through it. Your prospects are the agents in your campaigns. My Agents and your DNC List are always left out."} />
      <div className={k("card")}>
        <Tabs tabs={[{ id: "market", label: "All agents in your market", count: all.total }, { id: "prospects", label: "Prospects", count: prospectsAll.total }]} on={tab} onTab={setTab} />
        {tab === "prospects" && noProspects ? (
          <div className={k("emp")} style={{ borderTop: "1px solid #ebedf0" }}>
            <span className={k("ei")}><Icon name="target" size={22} /></span>
            <h2>No prospects yet</h2>
            <p>We&apos;re building your first campaign. The agents we email will show here once it&apos;s&nbsp;ready.</p>
          </div>
        ) : (
          <>
            <div className={k("tbar")} style={{ flexWrap: "wrap" }}>
              <label className={k("srch")} style={{ width: 280 }}>
                <Icon name="search" size={15} />
                <input id="crx-setup-target-search" type="search" placeholder={tab === "market" ? "Search agents in your market" : "Search your prospects"} aria-label={tab === "market" ? "Search agents in your market" : "Search your prospects"} value={search} onChange={(e) => setSearch(e.target.value)} />
              </label>
              <Divider />
              <MarketFilters clientId={clientId} list={tab} value={f} onChange={setF} />
              <button className={k("clr")} type="button" onClick={() => { setF(NO_PICKS); setSearch(""); }}>Clear all</button>
            </div>
            <div className={k("sbulk idle")}>
              {tab === "prospects" ? (
                <span className={k("bt")}><b className={k("num")}>{fmt(prospectsAll.total ?? 0)}</b>{" "}prospects — the agents we email{any && prospects.total !== null && !prospects.loading ? <> ·{" "}<span className={k("sub")}>{fmt(prospects.total)} match</span></> : null}</span>
              ) : !any ? (
                <span className={k("bt")}><b className={k("num")}>{all.total === null ? "…" : fmt(marketTotal)}</b>{" "}active agents in your market ·{" "}<span className={k("sub")}>filter to look through it</span></span>
              ) : counted ? (
                <span className={k("bt")}><b className={k("num")}>{fmt(filtered.total ?? 0)}</b>{" "}agents match these filters ·{" "}<span className={k("sub")}>of {all.total === null ? "…" : fmt(marketTotal)} active in your market</span></span>
              ) : (
                // Never "0 agents match" while the count is on its way (28 Oct: a slow first answer showed 0).
                <span className={k("bt")} role="status">{filtered.unavailable ?? "Counting the agents that match…"}</span>
              )}
            </div>
            <table className={k("tb")}>
              <thead>
                <tr>
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
                {shown.rows.length === 0 && !shown.loading ? <tr><td colSpan={7} className="cpv-muted" style={{ padding: "18px 20px" }}>{shown.unavailable ?? "No agents match."}</td></tr> : null}
                {shown.rows.map((r) => (
                  <tr key={r.id}>
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
          </>
        )}
      </div>
    </>
  );
}

const OFFERS = SETUP_OFFERS;

/* The client's offer is not on record anywhere yet, so the step opens empty (Setup-5-Offer-Empty); ticking and typing work, nothing is kept. */
type OfferDraft = { offers: string[]; whyJoin: string; neverSay: string };

/* Controlled by the wizard, so "Finish setup" can save it (the Demo Portal, 22 Oct); opens with what was saved, else empty (Setup-5-Offer-Empty). */
function OfferStep({ value, onChange }: { value: OfferDraft; onChange: (v: OfferDraft) => void }) {
  const on = new Set(value.offers);
  return (
    <>
      <Head step={5} title="Tell us your offer" text={"We write your emails from this. You'll see them and approve them before anything goes\u00a0out."} />
      <div className={k("card cpad")} style={{ display: "flex", flexDirection: "column", gap: 22 }}>
        <fieldset>
          <legend>What do you give agents who join?{" "}<small>Pick everything that applies.</small></legend>
          <div className={k("ckg")}>
            {OFFERS.map((o) => (
              <label key={o} className={k(on.has(o) ? "ckl on" : "ckl")}>
                <input type="checkbox" checked={on.has(o)} onChange={() => onChange({ ...value, offers: on.has(o) ? value.offers.filter((x) => x !== o) : OFFERS.filter((x) => x === o || on.has(x)) })} />
                {o}
              </label>
            ))}
          </div>
        </fieldset>
        <label className={k("slb")}>
          In a sentence or two, why do agents join you?
          <textarea className={k("ta")} rows={3} maxLength={1000} placeholder="e.g. Steady leads from day one and a TC who handles every file" value={value.whyJoin} onChange={(e) => onChange({ ...value, whyJoin: e.target.value })} />
        </label>
        <label className={k("slb")}>
          <span>Anything we should never say?{" "}<small>Optional. Competitors you don&apos;t want named, claims to avoid.</small></span>
          <textarea className={k("ta")} rows={2} maxLength={1000} placeholder="e.g. Don't mention splits in the first email" value={value.neverSay} onChange={(e) => onChange({ ...value, neverSay: e.target.value })} />
        </label>
      </div>
    </>
  );
}

function DoneStep({ client, onExit }: { client: SetupClient; onExit: () => void }) {
  const first = firstName(client.contactName ?? client.name);
  return (
    <div className={k("card")} style={{ padding: "36px 40px", maxWidth: 560, display: "flex", flexDirection: "column", gap: 20 }}>
      <span style={{ width: 44, height: 44, borderRadius: 99, background: "#e9f6ee", color: "#1a7f38", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Icon name="check" size={22} stroke={2.4} />
      </span>
      <h1 style={{ margin: "0", fontSize: 22, fontWeight: 600, letterSpacing: "-0.01em" }}>You&apos;re all set{first ? `, ${first}` : ""}.</h1>
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
  offer,
  step,
  onStep,
  onExit,
}: {
  client: SetupClient;
  team: TeamMember[];
  agents: AgentEntry[];
  dnc: DncEntry[];
  /** The saved offer (the Demo Portal; null — not filled in yet). */
  offer: PortalOffer | null;
  step: number;
  onStep: (n: number) => void;
  onExit: () => void;
}) {
  const [offerDraft, setOfferDraft] = useState<OfferDraft>({ offers: offer?.offers ?? [], whyJoin: offer?.whyJoin ?? "", neverSay: offer?.neverSay ?? "" });
  const offerReady = offerDraft.offers.length > 0 && !!offerDraft.whyJoin.trim();
  const { live, demo, staff, save } = useDemo();
  const [finishing, setFinishing] = useState(false);
  /*
   * "Finish setup" on the Demo Portal saves the offer first (the user, 22 Oct:
   * "yes please save the data"); it moves on only once saved. Everywhere else
   * it moves on, as drawn.
   */
  const finish = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (!live) return onStep(6);
    if (finishing) return;
    // Staff on a real portal (29 Oct audit): this saves the CLIENT's offer, and with it their own first-sign-in wizard is done.
    if (staff && !demo && !window.confirm(`Save this as ${client.name}'s offer? It's saved as if they gave it — and they won't be shown the Setup wizard when they first sign in.`)) return;
    setFinishing(true);
    const ok = await save({ type: "offer.save", offers: offerDraft.offers, why_join: offerDraft.whyJoin.trim(), never_say: offerDraft.neverSay.trim() });
    setFinishing(false);
    if (ok) onStep(6);
  };
  const link = (n: number) => (e: React.MouseEvent) => { e.preventDefault(); onStep(n); };
  // The design's -Empty variants: a step with nothing on its list offers "Skip for now", and can't be saved.
  // Who we email (step 4) never holds anyone back: a new client has no prospects until their first campaign (28 Oct).
  const empty = step === 2 ? agents.length === 0 : step === 3 ? dnc.length === 0 : step === 5 ? !offerReady : false;
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
              : step === 4 ? <TargetStep clientId={client.id} />
              : step === 5 ? <OfferStep value={offerDraft} onChange={setOfferDraft} />
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
                  <a className={k("btn pri")} href="#" onClick={step === 5 ? (e) => void finish(e) : link(step + 1)} aria-busy={finishing}>{step === 5 && finishing ? "Saving…" : next}</a>
                )}
              </div>
            </footer>
          ) : null}
        </main>
      </div>
    </div>
  );
}
