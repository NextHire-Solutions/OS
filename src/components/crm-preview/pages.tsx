"use client";

/*
 * The redesign's other pages on the client's real lists — My Agents, DNC List,
 * Team, Integrations — and a placeholder for the pages this preview does not
 * draw yet. Adding, importing, editing and deleting are drawn as designed and
 * inert (k.ts RO); the bulk bar is disabled, as the design shows it untouched.
 * On the Demo Portal (21 Oct) adding, editing, deleting, exporting and Team's
 * Active switch save (demo-save.ts), and Import CSV imports (22 Oct);
 * Integrations stay drawn.
 */

import { useMemo, useState } from "react";

import type { TeamMember } from "@/lib/tools/master-inbox/portals/stages-shared";
import type { AgentEntry, DncEntry } from "@/lib/tools/master-inbox/portals/portal-data";
import { formatPhone, initials, LIST_PAGE_SIZE } from "@/lib/crm-preview/model";

import { DncAddDialog, ImportDialog, MyAgentAddDialog, TeamAddForm } from "./dialogs";
import { Icon, type IconName } from "./icons";
import { k, RO, withIds } from "./k";
import { csvRowToAgent, csvRowToDnc, csvRowToTeam } from "@/lib/tools/master-inbox/portals/csv";

import { importCsv, lock, saveCsv, useDemo } from "./demo-save";
import fubLogo from "./follow-up-boss.png";

const AV = { width: 30, height: 30, fontSize: 11, background: "#eef2fa", color: "#2f55a8" } as const;
const HIDDEN = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" } as const;

/* `add` names the page's primary action; without it (an empty page, Integrations) the header is the title alone, as designed. Export is inert; Import and Add open their pop-ups. */
function Header({ title, add, onAdd, onImport, onExport }: { title: string; add?: string; onAdd?: () => void; onImport?: () => void; onExport?: () => void }) {
  return (
    <header className={k("top")}>
      <div className={k("ttl")}><h1>{title}</h1></div>
      <div className={k("hr")}>
        {add ? (
          <>
            <button type="button" className={k("btn")} {...(onExport ? { onClick: onExport } : RO)}><Icon name="download" size={15} />Export CSV</button>
            <button type="button" className={k("btn")} onClick={onImport}><Icon name="upload" size={15} />Import CSV</button>
            <button type="button" className={k("btn pri")} onClick={onAdd}><Icon name="plus" size={15} />{add}</button>
          </>
        ) : null}
      </div>
    </header>
  );
}

function Search({ id, label, value, onChange, count }: { id: string; label: string; value: string; onChange: (v: string) => void; count?: string }) {
  return (
    <div className={k("tbar")}>
      <label className={k("srch")} style={{ width: 256 }}>
        <Icon name="search" size={15} />
        <span style={HIDDEN}>{label}</span>
        <input id={id} type="search" placeholder={label} value={value} onChange={(e) => onChange(e.target.value)} />
      </label>
      {count ? <span className={k("cnt")} style={{ marginLeft: "auto" }}>{count}</span> : null}
    </div>
  );
}

/* The bulk bar: off until rows are ticked, then the design's "N selected" (its actions inert; Cancel clears). */
function Bulk({ count, onCancel, onExport, onDelete }: { count: number; onCancel: () => void; onExport?: () => void; onDelete?: () => void }) {
  if (count === 0) {
    return (
      <div className={k("abulk")}>
        <span>Bulk actions: tick rows below to enable</span>
        <div className={k("acts")}>
          <button type="button" className={k("btn sm")} disabled><Icon name="download" size={14} />Export selected</button>
          <button type="button" className={k("btn sm")} disabled><Icon name="trash" size={14} />Delete selected</button>
        </div>
      </div>
    );
  }
  return (
    <div className={k("abulk on")}>
      <span>{count.toLocaleString("en-US")} selected</span>
      <div className={k("acts")}>
        <button type="button" className={k("btn sm")} {...(onExport ? { onClick: onExport } : RO)}><Icon name="download" size={14} />Export selected</button>
        <button type="button" className={k("btn sm dout")} {...(onDelete ? { onClick: onDelete } : RO)}><Icon name="trash" size={14} />Delete selected</button>
        <button type="button" className={k("btn sm")} style={{ borderColor: "transparent" }} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/* "All 50 agents on this page are selected. Select all 398 agents" — when a whole page of a longer list is ticked. */
function SelAll({ onPage, total, onAll }: { onPage: number; total: number; onAll: () => void }) {
  return (
    <div className={k("aselall")}>
      All{" "}<b>{onPage.toLocaleString("en-US")}</b>{" "}agents on this page are selected.
      <button type="button" onClick={onAll}>Select all {total.toLocaleString("en-US")} agents</button>
    </div>
  );
}

/* Ticked rows of one list. */
function usePicked() {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const pick = (ids: readonly string[], on: boolean) => setPicked((cur) => withIds(cur, ids, on));
  return { picked, pick, clear: () => setPicked(new Set()) };
}

function RowActions({ name, onEdit, onDelete }: { name: string; onEdit?: () => void; onDelete?: () => void }) {
  return (
    <td className={k("acts")}>
      <button type="button" className={k("ib")} aria-label={`Edit ${name}`} {...(onEdit ? { onClick: onEdit } : RO)}><Icon name="pencil" size={15} /></button>
      <button type="button" className={k("ib")} aria-label={`Delete ${name}`} {...(onDelete ? { onClick: onDelete } : RO)}><Icon name="trash" size={15} /></button>
    </td>
  );
}

/* "Delete …?" before a Demo Portal delete. */
const sure = (what: string) => window.confirm(`Delete ${what} from the Demo Portal?`);

function Dash() {
  return <span className={k("dash")}>&ndash;</span>;
}

/* A long list pages 50 at a time with the design's own footer (its Pipeline list); one page needs none, as the design's tables. */
function pageOf<T>(rows: readonly T[], page: number) {
  const pages = Math.max(1, Math.ceil(rows.length / LIST_PAGE_SIZE));
  const p = Math.min(Math.max(1, page), pages);
  return { page: p, pages, rows: rows.slice((p - 1) * LIST_PAGE_SIZE, p * LIST_PAGE_SIZE) };
}

function Pager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  const from = (page - 1) * LIST_PAGE_SIZE + 1;
  const to = Math.min(total, page * LIST_PAGE_SIZE);
  return (
    <div className={k("tf")}>
      <span>
        <b style={{ color: "#1f2124", fontWeight: 600 }}>{from.toLocaleString("en-US")}&ndash;{to.toLocaleString("en-US")}</b> of {total.toLocaleString("en-US")} agents
      </span>
      <div className={k("pg")} style={{ alignItems: "center" }}>
        <button type="button" className={k(page <= 1 ? "btn sm dis" : "btn sm")} disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
        <span>Page {page} / {pages}</span>
        <button type="button" className={k(page >= pages ? "btn sm dis" : "btn sm")} disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next <Icon name="chevRight" size={12} />
        </button>
      </div>
    </div>
  );
}

function Empty({ icon, title, text, red = false, actions, onActions }: { icon: IconName; title: string; text: string; red?: boolean; actions?: string[]; onActions?: Array<() => void> }) {
  return (
    <div className={k("es")}>
      <section className={k("card ec")}>
        <span className={k(red ? "ei r" : "ei")}><Icon name={icon} size={22} /></span>
        <h2>{title}</h2>
        <p>{text}</p>
        {actions?.length ? (
          <div className={k("ea")}>
            {actions.map((a, i) => (
              <button key={a} type="button" className={k(i === 0 ? "btn pri" : "btn")} {...(onActions?.[i] ? { onClick: onActions[i] } : RO)}>
                <Icon name={i === 0 ? "plus" : "upload"} size={15} />{a}
              </button>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}

const has = (q: string, ...vals: Array<string | null | undefined>) => {
  const s = q.trim().toLowerCase();
  return !s || vals.some((v) => (v ?? "").toLowerCase().includes(s));
};

// ------------------------------------------------------------- My Agents ---

export function MyAgentsScreen({ agents }: { agents: AgentEntry[] }) {
  const [q, setQ] = useState("");
  const [pageNo, setPageNo] = useState(1);
  const [dialog, setDialog] = useState<"add" | "import" | { edit: AgentEntry } | null>(null);
  const { picked, pick, clear } = usePicked();
  const demo = useDemo();
  const { live, save } = demo;
  const csv = (rows: AgentEntry[]) => saveCsv("my-agents.csv", ["Name", "Email", "Phone"], rows.map((a) => [a.name, a.email, a.phone]));
  const remove = async (ids: string[], what: string) => { if (sure(what) && (await save({ type: "agent.delete", ids }))) clear(); };
  const found = useMemo(() => agents.filter((a) => has(q, a.name, a.email, a.phone)), [agents, q]);
  const shown = pageOf(found, pageNo);
  const pageIds = shown.rows.map((a) => a.id);
  const pageAll = pageIds.length > 0 && pageIds.every((id) => picked.has(id));
  const count = found.filter((a) => picked.has(a.id)).length;
  const close = () => setDialog(null);
  return (
    <>
      <Header title="My Agents" add={agents.length ? "Add agent" : undefined} onAdd={() => setDialog("add")} onImport={() => setDialog("import")} onExport={live ? () => csv(agents) : undefined} />
      <div className={k("content")}>
        {agents.length === 0 ? (
          <Empty icon="users" title="No agents added yet" text={"Add the agents already on your team so we never reach out to\u00a0them."} actions={["Add agents", "Import CSV"]} onActions={[() => setDialog("add"), () => setDialog("import")]} />
        ) : (
          <>
            <p className={k("lede")}>Your brokerage&apos;s own agents. We never reach out to anyone on this&nbsp;list.</p>
            <div className={k("kpis")}>
              <div className={k("card kpi")}>
                <div className={k("k")}><span className={k("lb")}>My Agents</span><span className={k("ki")}><Icon name="shield" size={16} /></span></div>
                <span className={k("v")} style={{ color: "#3e6bd1" }}>{agents.length.toLocaleString("en-US")}</span>
                <span className={k("s")}>We never reach out to these agents.</span>
              </div>
            </div>
            <Search id="crx-agents-search" label="Search agents..." value={q} onChange={(v) => { setQ(v); setPageNo(1); }} count={`${found.length.toLocaleString("en-US")} of ${agents.length.toLocaleString("en-US")}`} />
            <Bulk
              count={count}
              onCancel={clear}
              onExport={live ? () => csv(found.filter((a) => picked.has(a.id))) : undefined}
              onDelete={live ? () => void remove(found.filter((a) => picked.has(a.id)).map((a) => a.id), `${count} ${count === 1 ? "agent" : "agents"}`) : undefined}
            />
            {pageAll && found.length > pageIds.length ? <SelAll onPage={pageIds.length} total={found.length} onAll={() => pick(found.map((a) => a.id), true)} /> : null}
            <div className={k("card")} style={{ overflow: "hidden" }}>
              <table className={k("tb")}>
                <thead>
                  <tr>
                    <th scope="col" style={{ width: 20 }}><input type="checkbox" className={k("ck")} aria-label="Select all agents" checked={pageAll} onChange={() => pick(pageIds, !pageAll)} /></th>
                    <th scope="col" style={{ width: "36%" }}>Agent</th>
                    <th scope="col" style={{ width: "28%" }}>Email</th>
                    <th scope="col">Phone</th>
                    <th scope="col"><span style={HIDDEN}>Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {shown.rows.map((a) => (
                    <tr key={a.id} className={picked.has(a.id) ? k("sel") : undefined}>
                      <td><input type="checkbox" className={k("ck")} aria-label={`Select ${a.name}`} checked={picked.has(a.id)} onChange={() => pick([a.id], !picked.has(a.id))} /></td>
                      <td><div style={{ display: "flex", alignItems: "center", gap: 10 }}><span className={k("av")} style={AV}>{initials(a.name)}</span><span className={k("nm")}>{a.name}</span></div></td>
                      <td>{a.email || <Dash />}</td>
                      <td>{formatPhone(a.phone) ?? <Dash />}</td>
                      <RowActions name={a.name} onEdit={live ? () => setDialog({ edit: a }) : undefined} onDelete={live ? () => void remove([a.id], a.name) : undefined} />
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pager page={shown.page} pages={shown.pages} total={found.length} onPage={setPageNo} />
            </div>
          </>
        )}
      </div>
      {dialog === "add" ? <MyAgentAddDialog onClose={close} onSave={live ? (v) => save({ type: "agent.add", name: v.name, email: v.email, phone: v.phone }) : undefined} /> : null}
      {dialog && typeof dialog === "object" ? (
        <MyAgentAddDialog
          initial={dialog.edit}
          onClose={close}
          onSave={(v) => save({ type: "agent.edit", id: dialog.edit.id, name: v.name, email: v.email, phone: v.phone, license: dialog.edit.license })}
        />
      ) : null}
      {dialog === "import" ? <ImportDialog kind="agents" onClose={close} onFile={live ? (f) => importCsv(f, csvRowToAgent, "agent.import", demo) : undefined} /> : null}
    </>
  );
}

// --------------------------------------------------------------- DNC List ---

export function DncScreen({ dnc }: { dnc: DncEntry[] }) {
  const [q, setQ] = useState("");
  const [pageNo, setPageNo] = useState(1);
  const [dialog, setDialog] = useState<"add" | "import" | { edit: DncEntry } | null>(null);
  const { picked, pick, clear } = usePicked();
  const demo = useDemo();
  const { live, save } = demo;
  const csv = (rows: DncEntry[]) => saveCsv("dnc-list.csv", ["Kind", "Name", "Email", "Phone", "Brokerage", "Domain", "Notes"], rows.map((d) => [d.kind, d.name, d.email, d.phone, d.brokerage, d.domain, d.notes]));
  const remove = async (ids: string[], what: string) => { if (sure(what) && (await save({ type: "dnc.delete", ids }))) clear(); };
  const close = () => setDialog(null);
  const people = useMemo(() => dnc.filter((d) => d.kind === "agent"), [dnc]);
  const companies = useMemo(() => dnc.filter((d) => d.kind === "company"), [dnc]);
  const foundPeople = useMemo(() => people.filter((d) => has(q, d.name, d.email, d.phone, d.brokerage)), [people, q]);
  const foundCompanies = useMemo(() => companies.filter((d) => has(q, d.name, d.domain, d.notes)), [companies, q]);
  const shown = pageOf(foundPeople, pageNo);
  const pageIds = shown.rows.map((d) => d.id);
  const pageAll = pageIds.length > 0 && pageIds.every((id) => picked.has(id));
  const count = foundPeople.filter((d) => picked.has(d.id)).length;
  return (
    <>
      <Header title="DNC List" add={dnc.length ? "Add to DNC" : undefined} onAdd={() => setDialog("add")} onImport={() => setDialog("import")} onExport={live ? () => csv(dnc) : undefined} />
      <div className={k("content")}>
        {dnc.length === 0 ? (
          <Empty icon="ban" red title="Your DNC List is empty" text={"Add agents or whole companies you never want contacted. They are excluded from all\u00a0outreach."} actions={["Add to DNC", "Import CSV"]} onActions={[() => setDialog("add"), () => setDialog("import")]} />
        ) : (
          <>
            <p className={k("lede")}>Agents and companies we should never reach out&nbsp;to.</p>
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", border: "1px solid #f6d5d2", borderRadius: 10, background: "#fef6f5", color: "#7a271a" }}>
              <span style={{ width: 30, height: 30, borderRadius: 99, background: "#fdeeed", color: "#b42318", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Icon name="ban" size={16} /></span>
              <span><b style={{ color: "#b42318" }}>Do not contact.</b> Everyone on this list, and every agent at these companies, is excluded from all&nbsp;outreach.</span>
            </div>
            <div className={k("kpis")}>
              <div className={k("card kpi")}>
                <div className={k("k")}><span className={k("lb")}>DNC agents</span><span className={k("ki")}><Icon name="users" size={16} /></span></div>
                <span className={k("v")} style={{ color: "#3e6bd1" }}>{people.length.toLocaleString("en-US")}</span>
                <span className={k("s")}>never contacted in any outreach</span>
              </div>
              <div className={k("card kpi")}>
                <div className={k("k")}><span className={k("lb")}>DNC companies</span><span className={k("ki g")}><Icon name="building" size={16} /></span></div>
                <span className={k("v")} style={{ color: "#1f2124" }}>{companies.length.toLocaleString("en-US")}</span>
                <span className={k("s")}>entire firms excluded from outreach</span>
              </div>
            </div>
            <Search id="crx-dnc-search" label="Search agents or companies..." value={q} onChange={(v) => { setQ(v); setPageNo(1); }} />
            <Bulk
              count={count}
              onCancel={clear}
              onExport={live ? () => csv(foundPeople.filter((d) => picked.has(d.id))) : undefined}
              onDelete={live ? () => void remove(foundPeople.filter((d) => picked.has(d.id)).map((d) => d.id), `${count} ${count === 1 ? "entry" : "entries"}`) : undefined}
            />
            <div className={k("sec")}>Agents<span>{foundPeople.length.toLocaleString("en-US")}</span></div>
            {pageAll && foundPeople.length > pageIds.length ? <SelAll onPage={pageIds.length} total={foundPeople.length} onAll={() => pick(foundPeople.map((d) => d.id), true)} /> : null}
            <div className={k("card")} style={{ overflow: "hidden" }}>
              <table className={k("tb")}>
                <thead>
                  <tr>
                    <th scope="col" style={{ width: 20 }}><input type="checkbox" className={k("ck")} aria-label="Select all DNC agents" checked={pageAll} onChange={() => pick(pageIds, !pageAll)} /></th>
                    <th scope="col" style={{ width: "30%" }}>Agent</th>
                    <th scope="col" style={{ width: "26%" }}>Brokerage</th>
                    <th scope="col">Email / Phone</th>
                    <th scope="col"><span style={HIDDEN}>Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {shown.rows.map((d) => (
                    <tr key={d.id} className={picked.has(d.id) ? k("sel") : undefined}>
                      <td><input type="checkbox" className={k("ck")} aria-label={`Select ${d.name}`} checked={picked.has(d.id)} onChange={() => pick([d.id], !picked.has(d.id))} /></td>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <span className={k("av")} style={AV}>{initials(d.name)}</span>
                          <span className={k("nm")}>{d.name}</span>
                          <span title="Do not contact" aria-label="Do not contact" style={{ color: "#d92d20", display: "inline-flex" }}><Icon name="ban" size={13} /></span>
                        </div>
                      </td>
                      <td>{d.brokerage || <Dash />}</td>
                      <td>
                        {d.email || d.phone ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                            {d.email ? <span>{d.email}</span> : null}
                            {d.phone ? <span className={k("sub")} style={{ fontSize: 12 }}>{formatPhone(d.phone)}</span> : null}
                          </div>
                        ) : <Dash />}
                      </td>
                      <RowActions name={d.name} onEdit={live ? () => setDialog({ edit: d }) : undefined} onDelete={live ? () => void remove([d.id], d.name) : undefined} />
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pager page={shown.page} pages={shown.pages} total={foundPeople.length} onPage={setPageNo} />
            </div>

            {companies.length > 0 ? (
              <>
                <div className={k("sec")}>Companies<span>{foundCompanies.length.toLocaleString("en-US")}</span></div>
                <div className={k("card")} style={{ overflow: "hidden" }}>
                  <table className={k("tb")}>
                    <thead>
                      <tr>
                        <th scope="col" style={{ width: 20 }}><input type="checkbox" className={k("ck")} aria-label="Select all DNC companies" {...RO} /></th>
                        <th scope="col" style={{ width: "30%" }}>Company</th>
                        <th scope="col" style={{ width: "26%" }}>Email domain</th>
                        <th scope="col">Notes</th>
                        <th scope="col"><span style={HIDDEN}>Actions</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {foundCompanies.map((d) => (
                        <tr key={d.id}>
                          <td><input type="checkbox" className={k("ck")} aria-label={`Select ${d.name}`} {...RO} /></td>
                          <td>
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              <span className={k("av")} style={{ ...AV, background: "#f1f3f6", color: "#555a64" }}><Icon name="building" size={14} /></span>
                              <span className={k("nm")}>{d.name}</span>
                            </div>
                          </td>
                          <td>{d.domain ? `@${d.domain}` : <Dash />}</td>
                          {/* The design's cells don't wrap; a company's note can be a paragraph (Maltos: two sentences), so this one does. */}
                          <td style={{ whiteSpace: "normal", overflowWrap: "anywhere", minWidth: 220 }}>{d.notes || <Dash />}</td>
                          <RowActions name={d.name} onEdit={live ? () => setDialog({ edit: d }) : undefined} onDelete={live ? () => void remove([d.id], d.name) : undefined} />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : null}
          </>
        )}
      </div>
      {dialog === "add" ? (
        <DncAddDialog
          onClose={close}
          onSave={live ? (v) => save({ type: "dnc.add", kind: v.kind, name: v.name, email: v.email, phone: v.phone, brokerage: v.brokerage, domain: v.domain, notes: v.notes }) : undefined}
        />
      ) : null}
      {dialog && typeof dialog === "object" ? (
        <DncAddDialog
          initial={dialog.edit.kind === "company" ? "company" : "agent"}
          entry={dialog.edit}
          onClose={close}
          onSave={(v) => save({ type: "dnc.edit", id: dialog.edit.id, name: v.name, email: v.email, phone: v.phone, brokerage: v.brokerage, domain: v.domain, notes: v.notes })}
        />
      ) : null}
      {dialog === "import" ? <ImportDialog kind="dnc" onClose={close} onFile={live ? (f) => importCsv(f, csvRowToDnc, "dnc.import", demo) : undefined} /> : null}
    </>
  );
}

// ------------------------------------------------------------------- Team ---

export function TeamScreen({ team }: { team: TeamMember[] }) {
  const [q, setQ] = useState("");
  const [dialog, setDialog] = useState<"add" | "import" | { edit: TeamMember } | null>(null);
  const { picked, pick, clear } = usePicked();
  const demo = useDemo();
  const { live, save } = demo;
  const csv = (rows: TeamMember[]) => saveCsv("team.csv", ["Name", "Title", "Email", "Phone", "Active"], rows.map((m) => [m.name, m.title, m.email, m.phone, m.active ? "yes" : "no"]));
  const remove = async (ids: string[], what: string) => { if (sure(what) && (await save({ type: "team.delete", ids }))) clear(); };
  const found = useMemo(() => team.filter((m) => has(q, m.name, m.email, m.title, m.phone)), [team, q]);
  const ids = found.map((m) => m.id);
  const all = ids.length > 0 && ids.every((id) => picked.has(id));
  const count = found.filter((m) => picked.has(m.id)).length;
  const close = () => setDialog(null);
  return (
    <>
      <Header title="Team" add="Add member" onAdd={() => setDialog("add")} onImport={() => setDialog("import")} onExport={live ? () => csv(team) : undefined} />
      <div className={k("content")}>
        <p className={k("lede")}>Who receives intro notifications and&nbsp;how.</p>
        {dialog === "add" ? <TeamAddForm onClose={close} onSave={live ? (v) => save({ type: "team.add", name: v.name, title: v.title, email: v.email, phone: v.phone }) : undefined} /> : null}
        {dialog && typeof dialog === "object" ? (
          <TeamAddForm
            key={dialog.edit.id}
            initial={dialog.edit}
            onClose={close}
            onSave={(v) => save({ type: "team.edit", id: dialog.edit.id, name: v.name, title: v.title, email: v.email, phone: v.phone })}
          />
        ) : null}
        {team.length === 0 ? (
          <Empty icon="user" title="No team members yet" text="Add the people who should receive interested agents by email." />
        ) : (
          <>
            <Search id="crx-team-search" label="Search team..." value={q} onChange={setQ} count={`${found.length} of ${team.length}`} />
            <Bulk
              count={count}
              onCancel={clear}
              onExport={live ? () => csv(found.filter((m) => picked.has(m.id))) : undefined}
              onDelete={live ? () => void remove(found.filter((m) => picked.has(m.id)).map((m) => m.id), `${count} team ${count === 1 ? "member" : "members"}`) : undefined}
            />
            <div className={k("card")} style={{ overflow: "hidden" }}>
              <table className={k("tb")}>
                <thead>
                  <tr>
                    <th scope="col" style={{ width: 20 }}><input type="checkbox" className={k("ck")} aria-label="Select all team members" checked={all} onChange={() => pick(ids, !all)} /></th>
                    <th scope="col" style={{ width: "24%" }}>Member</th>
                    <th scope="col" style={{ width: "22%" }}>Title</th>
                    <th scope="col">Email / Phone</th>
                    <th scope="col" style={{ width: 90 }}>Active</th>
                    <th scope="col"><span style={HIDDEN}>Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {found.map((m) => (
                    <tr key={m.id} style={{ height: 60 }} className={picked.has(m.id) ? k("sel") : undefined}>
                      <td><input type="checkbox" className={k("ck")} aria-label={`Select ${m.name}`} checked={picked.has(m.id)} onChange={() => pick([m.id], !picked.has(m.id))} /></td>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <span className={k("avw")}>
                            <span className={k("av")} style={AV}>{initials(m.name)}</span>
                            {m.active ? <span className={k("on")} aria-label="Active" /> : null}
                          </span>
                          <span className={k("nm")}>{m.name}</span>
                        </div>
                      </td>
                      <td>{m.title || <Dash />}</td>
                      <td>
                        <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "8px 0" }}>
                          <span style={{ color: "#1f2124" }}>{m.email}</span>
                          {m.phone ? <span className={k("sub")} style={{ fontSize: 12 }}>{formatPhone(m.phone)}</span> : null}
                        </div>
                      </td>
                      <td>
                        <span
                          className={k(m.active ? "sw" : "sw off")}
                          role="switch"
                          aria-checked={m.active}
                          aria-label={`${m.name} receives intro emails`}
                          {...lock(live)}
                          {...(live ? { tabIndex: 0, style: { cursor: "pointer" }, onClick: () => void save({ type: "team.active", id: m.id, active: !m.active }), onKeyDown: (e: React.KeyboardEvent) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); void save({ type: "team.active", id: m.id, active: !m.active }); } } } : {})}
                        />
                      </td>
                      <RowActions name={m.name} onEdit={live ? () => setDialog({ edit: m }) : undefined} onDelete={live ? () => void remove([m.id], m.name) : undefined} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      {dialog === "import" ? <ImportDialog kind="team" onClose={close} onFile={live ? (f) => importCsv(f, csvRowToTeam, "team.import", demo) : undefined} /> : null}
    </>
  );
}

// ----------------------------------------------------------- Integrations ---

export function IntegrationsScreen({ fubConnected }: { fubConnected: boolean }) {
  return (
    <>
      <Header title="Integrations" />
      <div className={k("content")}>
        <div className={k("int")}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className={k("lbu")} style={{ color: "#3e6bd1" }}>Integrations</span>
            <h2>Connect your tools</h2>
            <p className={k("lede")} style={{ lineHeight: 1.55 }}>Wire BrokerStaffer into the CRM your team already uses, so every agent who replies interested lands in the right place&nbsp;automatically.</p>
          </div>
          <section className={k("card")} aria-label="Follow Up Boss">
            <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                {/* eslint-disable-next-line @next/next/no-img-element -- a fixed-height partner logo, as the design draws it */}
                <img src={fubLogo.src} alt="Follow Up Boss" style={{ height: 26, width: "auto" }} />
              </div>
              <p className={k("sub")} style={{ margin: 0, fontSize: 13 }}>Send every agent marked as Interested straight to your Follow Up Boss&nbsp;CRM.</p>
              <span className={k(fubConnected ? "pill p-live" : "pill p-nu")} style={{ alignSelf: "flex-start" }}>{fubConnected ? "Connected" : "Not connected"}</span>
            </div>
            <div style={{ padding: "18px 20px 20px", borderTop: "1px solid #ebedf0", display: "flex", flexDirection: "column", gap: 8 }}>
              <label className={k("fl")} htmlFor="crx-fubkey">API key</label>
              <div className={k("inw")}>
                <input id="crx-fubkey" className={k("in")} type="password" placeholder={fubConnected ? "A key is saved for this client" : "Paste your Follow Up Boss API key"} style={{ height: 38, paddingRight: 40 }} readOnly {...RO} />
                <button type="button" className={k("ib")} aria-label="Show API key" {...RO}><Icon name="eye" size={16} /></button>
              </div>
              <p className={k("hint")}>
                Find it in Follow Up Boss under <b style={{ color: "#1f2124", fontWeight: 500 }}>My Settings &rarr; API</b>.{" "}
                <a href="https://help.followupboss.com/hc/en-us/articles/360014289393-API-Key" target="_blank" rel="noopener noreferrer" style={{ color: "#3e6bd1", display: "inline-flex", alignItems: "center", gap: 3 }}>
                  View instructions<Icon name="externalSmall" size={12} />
                </a>
              </p>
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
                <button type="button" className={k("btn pri dim")} {...RO}>{fubConnected ? "Update key" : "Connect"}</button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
