"use client";

/*
 * The redesign's other pages on the client's real lists — My Agents, DNC List,
 * Team, Integrations — and a placeholder for the pages this preview does not
 * draw yet. Adding, importing, editing and deleting are shown disabled.
 */

import { useMemo, useState } from "react";

import type { TeamMember } from "@/lib/tools/master-inbox/portals/stages-shared";
import type { AgentEntry, DncEntry } from "@/lib/tools/master-inbox/portals/portal-data";
import { initials } from "@/lib/crm-preview/model";

import { Icon, type IconName } from "./icons";
import { k, READ_ONLY } from "./k";
import fubLogo from "./follow-up-boss.png";

const PAGE = 100;
const AV = { width: 30, height: 30, fontSize: 11, background: "#eef2fa", color: "#2f55a8" } as const;
const HIDDEN = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" } as const;

function Header({ title, add }: { title: string; add?: string }) {
  return (
    <header className={k("top")}>
      <div className={k("ttl")}><h1>{title}</h1></div>
      <div className={k("hr")}>
        {add ? (
          <>
            <button type="button" className={k("btn")} disabled title={READ_ONLY}><Icon name="download" size={15} />Export CSV</button>
            <button type="button" className={k("btn")} disabled title={READ_ONLY}><Icon name="upload" size={15} />Import CSV</button>
            <button type="button" className={k("btn pri dim")} disabled title={READ_ONLY}><Icon name="plus" size={15} />{add}</button>
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

function BulkOff() {
  return (
    <div className={k("abulk")}>
      <span>Bulk actions: off in this preview</span>
      <div className={k("acts")}>
        <button type="button" className={k("btn sm")} disabled><Icon name="download" size={14} />Export selected</button>
        <button type="button" className={k("btn sm")} disabled><Icon name="trash" size={14} />Delete selected</button>
      </div>
    </div>
  );
}

function RowActions({ name }: { name: string }) {
  return (
    <td className={k("acts")}>
      <button type="button" className={k("ib")} aria-label={`Edit ${name}`} title={READ_ONLY} disabled><Icon name="pencil" size={15} /></button>
      <button type="button" className={k("ib")} aria-label={`Delete ${name}`} title={READ_ONLY} disabled><Icon name="trash" size={15} /></button>
    </td>
  );
}

function Dash() {
  return <span className={k("dash")}>&ndash;</span>;
}

function ShowMore({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  if (shown >= total) return null;
  return (
    <div className="cpv-more">
      <button type="button" className={k("btn sm")} onClick={onMore}>Show {Math.min(PAGE, total - shown)} more of {(total - shown).toLocaleString("en-US")}</button>
    </div>
  );
}

function Empty({ icon, title, text, red = false }: { icon: IconName; title: string; text: string; red?: boolean }) {
  return (
    <div className={k("es")}>
      <section className={k("card ec")}>
        <span className={k(red ? "ei r" : "ei")}><Icon name={icon} size={22} /></span>
        <h2>{title}</h2>
        <p>{text}</p>
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
  const [limit, setLimit] = useState(PAGE);
  const found = useMemo(() => agents.filter((a) => has(q, a.name, a.email, a.phone)), [agents, q]);
  return (
    <>
      <Header title="My Agents" add="Add agent" />
      <div className={k("content")}>
        <p className={k("lede")}>Your brokerage&apos;s own agents. We never reach out to anyone on this&nbsp;list.</p>
        {agents.length === 0 ? (
          <Empty icon="users" title="No agents on your list yet" text="Add your brokerage's agents so we never reach out to them." />
        ) : (
          <>
            <div className={k("kpis")}>
              <div className={k("card kpi")}>
                <div className={k("k")}><span className={k("lb")}>My Agents</span><span className={k("ki")}><Icon name="shield" size={16} /></span></div>
                <span className={k("v")} style={{ color: "#3e6bd1" }}>{agents.length.toLocaleString("en-US")}</span>
                <span className={k("s")}>We never reach out to these agents.</span>
              </div>
            </div>
            <Search id="crx-agents-search" label="Search agents..." value={q} onChange={(v) => { setQ(v); setLimit(PAGE); }} count={`${found.length.toLocaleString("en-US")} of ${agents.length.toLocaleString("en-US")}`} />
            <BulkOff />
            <div className={k("card")} style={{ overflow: "hidden" }}>
              <table className={k("tb")}>
                <thead>
                  <tr>
                    <th scope="col" style={{ width: 20 }}><input type="checkbox" className={k("ck")} aria-label="Select all agents" disabled /></th>
                    <th scope="col" style={{ width: "36%" }}>Agent</th>
                    <th scope="col" style={{ width: "28%" }}>Email</th>
                    <th scope="col">Phone</th>
                    <th scope="col"><span style={HIDDEN}>Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {found.slice(0, limit).map((a) => (
                    <tr key={a.id}>
                      <td><input type="checkbox" className={k("ck")} aria-label={`Select ${a.name}`} disabled /></td>
                      <td><div style={{ display: "flex", alignItems: "center", gap: 10 }}><span className={k("av")} style={AV}>{initials(a.name)}</span><span className={k("nm")}>{a.name}</span></div></td>
                      <td>{a.email || <Dash />}</td>
                      <td>{a.phone || <Dash />}</td>
                      <RowActions name={a.name} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ShowMore shown={Math.min(limit, found.length)} total={found.length} onMore={() => setLimit((l) => l + PAGE)} />
          </>
        )}
      </div>
    </>
  );
}

// --------------------------------------------------------------- DNC List ---

export function DncScreen({ dnc }: { dnc: DncEntry[] }) {
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const people = useMemo(() => dnc.filter((d) => d.kind === "agent"), [dnc]);
  const companies = useMemo(() => dnc.filter((d) => d.kind === "company"), [dnc]);
  const foundPeople = useMemo(() => people.filter((d) => has(q, d.name, d.email, d.phone, d.brokerage)), [people, q]);
  const foundCompanies = useMemo(() => companies.filter((d) => has(q, d.name, d.domain, d.notes)), [companies, q]);
  return (
    <>
      <Header title="DNC List" add="Add to DNC" />
      <div className={k("content")}>
        <p className={k("lede")}>Agents and companies we should never reach out&nbsp;to.</p>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", border: "1px solid #f6d5d2", borderRadius: 10, background: "#fef6f5", color: "#7a271a" }}>
          <span style={{ width: 30, height: 30, borderRadius: 99, background: "#fdeeed", color: "#b42318", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Icon name="ban" size={16} /></span>
          <span><b style={{ color: "#b42318" }}>Do not contact.</b> Everyone on this list, and every agent at these companies, is excluded from all&nbsp;outreach.</span>
        </div>
        {dnc.length === 0 ? (
          <Empty icon="ban" red title="Nobody on your DNC list" text="Add agents or whole companies we should never reach out to." />
        ) : (
          <>
            <div className={k("kpis")}>
              <div className={k("card kpi")}>
                <div className={k("k")}><span className={k("lb")}>DNC agents</span><span className={k("ki")}><Icon name="ban" size={16} /></span></div>
                <span className={k("v")} style={{ color: "#3e6bd1" }}>{people.length.toLocaleString("en-US")}</span>
                <span className={k("s")}>never contacted in any outreach</span>
              </div>
              <div className={k("card kpi")}>
                <div className={k("k")}><span className={k("lb")}>DNC companies</span><span className={k("ki g")}><Icon name="building" size={16} /></span></div>
                <span className={k("v")} style={{ color: "#1f2124" }}>{companies.length.toLocaleString("en-US")}</span>
                <span className={k("s")}>entire firms excluded from outreach</span>
              </div>
            </div>
            <Search id="crx-dnc-search" label="Search agents or companies..." value={q} onChange={(v) => { setQ(v); setLimit(PAGE); }} />
            <BulkOff />
            <div className={k("sec")}>Agents<span>{foundPeople.length.toLocaleString("en-US")}</span></div>
            <div className={k("card")} style={{ overflow: "hidden" }}>
              <table className={k("tb")}>
                <thead>
                  <tr>
                    <th scope="col" style={{ width: 20 }}><input type="checkbox" className={k("ck")} aria-label="Select all DNC agents" disabled /></th>
                    <th scope="col" style={{ width: "30%" }}>Agent</th>
                    <th scope="col" style={{ width: "26%" }}>Brokerage</th>
                    <th scope="col">Email / Phone</th>
                    <th scope="col"><span style={HIDDEN}>Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {foundPeople.slice(0, limit).map((d) => (
                    <tr key={d.id}>
                      <td><input type="checkbox" className={k("ck")} aria-label={`Select ${d.name}`} disabled /></td>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <span className={k("av")} style={AV}>{initials(d.name)}</span>
                          <span className={k("nm")}>{d.name}</span>
                          <span title="Do not contact" aria-label="Do not contact" style={{ color: "#d92d20", display: "inline-flex" }}><Icon name="ban" size={14} /></span>
                        </div>
                      </td>
                      <td>{d.brokerage || <Dash />}</td>
                      <td>
                        {d.email || d.phone ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                            {d.email ? <span>{d.email}</span> : null}
                            {d.phone ? <span className={k("sub")} style={{ fontSize: 12 }}>{d.phone}</span> : null}
                          </div>
                        ) : <Dash />}
                      </td>
                      <RowActions name={d.name} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ShowMore shown={Math.min(limit, foundPeople.length)} total={foundPeople.length} onMore={() => setLimit((l) => l + PAGE)} />

            {companies.length > 0 ? (
              <>
                <div className={k("sec")}>Companies<span>{foundCompanies.length.toLocaleString("en-US")}</span></div>
                <div className={k("card")} style={{ overflow: "hidden" }}>
                  <table className={k("tb")}>
                    <thead>
                      <tr>
                        <th scope="col" style={{ width: 20 }}><input type="checkbox" className={k("ck")} aria-label="Select all DNC companies" disabled /></th>
                        <th scope="col" style={{ width: "30%" }}>Company</th>
                        <th scope="col" style={{ width: "26%" }}>Email domain</th>
                        <th scope="col">Notes</th>
                        <th scope="col"><span style={HIDDEN}>Actions</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {foundCompanies.map((d) => (
                        <tr key={d.id}>
                          <td><input type="checkbox" className={k("ck")} aria-label={`Select ${d.name}`} disabled /></td>
                          <td>
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              <span className={k("av")} style={{ ...AV, background: "#f1f3f6", color: "#555a64" }}><Icon name="building" size={14} /></span>
                              <span className={k("nm")}>{d.name}</span>
                            </div>
                          </td>
                          <td>{d.domain ? `@${d.domain}` : <Dash />}</td>
                          <td>{d.notes || <Dash />}</td>
                          <RowActions name={d.name} />
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
    </>
  );
}

// ------------------------------------------------------------------- Team ---

export function TeamScreen({ team }: { team: TeamMember[] }) {
  const [q, setQ] = useState("");
  const found = useMemo(() => team.filter((m) => has(q, m.name, m.email, m.title, m.phone)), [team, q]);
  return (
    <>
      <Header title="Team" add="Add member" />
      <div className={k("content")}>
        <p className={k("lede")}>Who receives intro notifications and&nbsp;how.</p>
        {team.length === 0 ? (
          <Empty icon="user" title="No team members yet" text="Add the people who should receive interested agents by email." />
        ) : (
          <>
            <Search id="crx-team-search" label="Search team..." value={q} onChange={setQ} count={`${found.length} of ${team.length}`} />
            <BulkOff />
            <div className={k("card")} style={{ overflow: "hidden" }}>
              <table className={k("tb")}>
                <thead>
                  <tr>
                    <th scope="col" style={{ width: 20 }}><input type="checkbox" className={k("ck")} aria-label="Select all team members" disabled /></th>
                    <th scope="col" style={{ width: "24%" }}>Member</th>
                    <th scope="col" style={{ width: "22%" }}>Title</th>
                    <th scope="col">Email / Phone</th>
                    <th scope="col" style={{ width: 90 }}>Active</th>
                    <th scope="col"><span style={HIDDEN}>Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {found.map((m) => (
                    <tr key={m.id} style={{ height: 60 }}>
                      <td><input type="checkbox" className={k("ck")} aria-label={`Select ${m.name}`} disabled /></td>
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
                          {m.phone ? <span className={k("sub")} style={{ fontSize: 12 }}>{m.phone}</span> : null}
                        </div>
                      </td>
                      <td>
                        <span className={k(m.active ? "sw" : "sw off")} role="switch" aria-checked={m.active} aria-disabled="true" aria-label={`${m.name} receives intro emails`} title={READ_ONLY} />
                      </td>
                      <RowActions name={m.name} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
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
                <input id="crx-fubkey" className={k("in")} type="password" placeholder={fubConnected ? "A key is saved for this client" : "Paste your Follow Up Boss API key"} style={{ height: 38, paddingRight: 40 }} disabled />
                <button type="button" className={k("ib")} aria-label="Show API key" disabled><Icon name="eye" size={15} /></button>
              </div>
              <p className={k("hint")}>
                Find it in Follow Up Boss under <b style={{ color: "#1f2124", fontWeight: 500 }}>My Settings &rarr; API</b>.{" "}
                <a href="https://help.followupboss.com/hc/en-us/articles/360014289393-API-Key" target="_blank" rel="noopener noreferrer" style={{ color: "#3e6bd1", display: "inline-flex", alignItems: "center", gap: 3 }}>
                  View instructions<Icon name="externalSmall" size={12} />
                </a>
              </p>
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
                <button type="button" className={k("btn pri dim")} disabled title={READ_ONLY}>{fubConnected ? "Update key" : "Connect"}</button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
