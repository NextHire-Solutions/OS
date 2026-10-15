"use client";

/*
 * Pipeline — the redesign's board and list, on the client's real pipeline.
 * Filters, views and panels work; everything that would change the pipeline
 * is drawn disabled (see src/app/crm-preview/page.tsx).
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { PipelineEntry } from "@/lib/tools/master-inbox/portals/stages-shared";
import {
  TIME_RANGES,
  abbrevUsd,
  groupByMonth,
  initials,
  pipelineView,
  salesVolumeOf,
  shortDate,
  sourceLabel,
  stageKeyOf,
  type PreviewStage,
  type TimeRange,
} from "@/lib/crm-preview/model";

import { Icon } from "./icons";
import { k, READ_ONLY } from "./k";
import { AgentPanel, ConversationPanel, NotesPanel, StageCell, TagChip } from "./panels";

type Open = { kind: "agent" | "conversation" | "notes"; entry: PipelineEntry } | null;

const CARDS_PER_COLUMN = 40;
const ROWS_PER_MONTH = 10;

export function PipelineScreen({ entries, stages, token, now }: { entries: PipelineEntry[]; stages: PreviewStage[]; token: string; now: Date }) {
  const [mode, setMode] = useState<"board" | "list">("board");
  const [range, setRange] = useState<TimeRange>("all");
  const [search, setSearch] = useState("");
  const [chip, setChip] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const menuRef = useRef<HTMLSpanElement>(null);

  const byKey = useMemo(() => new Map(stages.map((s) => [s.key, s])), [stages]);
  const view = useMemo(() => pipelineView(entries, stages, { range, search, chip, now }), [entries, stages, range, search, chip, now]);
  const groups = useMemo(() => groupByMonth(view.shown), [view.shown]);
  const rangeLabel = TIME_RANGES.find((r) => r.id === range)?.label ?? "All time";
  const forward = stages.filter((s) => s.role === "stage");
  const tags = stages.filter((s) => s.role === "tag");

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [menuOpen]);

  const stageOf = (e: PipelineEntry) => byKey.get(stageKeyOf(e))!;
  const toggleChip = (key: string) => setChip((c) => (c === key ? null : key));
  const openAgent = (entry: PipelineEntry) => setOpen({ kind: "agent", entry });

  return (
    <>
      <header className={k("top")}>
        <div className={k("ttl")}>
          <h1>Pipeline</h1>
          <span className={k("hsub")}>Every agent who replied interested, from first reply to&nbsp;hire.</span>
        </div>
        <div className={k("hr")} />
      </header>

      <div className={k("content")}>
        <div className={k("card ms")} aria-disabled="true" title={READ_ONLY}>
          <span className={k("mi")}><Icon name="stages" size={16} /></span>
          <span>
            <b>Manage stages</b>
            <span className={k("t")}>Rename, reorder, and show or hide your pipeline stages. Applies to everyone viewing this portal.</span>
          </span>
          <span className={k("cv")}><Icon name="chevDown" size={15} /></span>
        </div>

        {entries.length === 0 ? (
          <div className={k("es")}>
            <section className={k("card ec")}>
              <span className={k("ei")}><Icon name="pipeline" size={22} /></span>
              <h2>No agents in your pipeline yet</h2>
              <p>When an agent replies interested to your outreach, they show up here. You can also add one&nbsp;yourself.</p>
              <div className={k("ea")}>
                <button type="button" className={k("btn pri dim")} disabled title={READ_ONLY}><Icon name="plus" size={15} />Add agent</button>
                <button type="button" className={k("btn")} disabled title={READ_ONLY}><Icon name="upload" size={15} />Upload CSV</button>
              </div>
            </section>
          </div>
        ) : (
          <>
            <div className={k("tbar")}>
              <label className={k("srch")}>
                <Icon name="search" size={15} />
                <input id="crx-pipeline-search" type="text" placeholder="Search agents..." aria-label="Search agents" value={search} onChange={(e) => setSearch(e.target.value)} />
              </label>
              <span className={k("ddw")} ref={menuRef}>
                <button type="button" className={k("btn")} aria-haspopup="menu" aria-expanded={menuOpen} aria-label={`Time range: ${rangeLabel}`} onClick={() => setMenuOpen((o) => !o)}>
                  <Icon name="calendar" size={15} />
                  {rangeLabel} <Icon name="chevDown" size={12} />
                </button>
                {menuOpen ? (
                  <div className={k("menu")} role="menu">
                    {TIME_RANGES.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={r.id === range}
                        className={r.id === range ? k("hv") : undefined}
                        onClick={() => { setRange(r.id); setMenuOpen(false); }}
                      >
                        {r.label}
                        {r.id === range ? <span style={{ marginLeft: "auto", display: "inline-flex" }}><Icon name="check" size={14} /></span> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </span>
              <span className={k("vlab")} style={{ marginLeft: "auto" }}>View as:</span>
              <div className={k("seg")} role="group" aria-label="View as">
                <button type="button" className={mode === "board" ? k("on") : undefined} aria-pressed={mode === "board"} onClick={() => setMode("board")}><Icon name="board" size={14} />Board</button>
                <button type="button" className={mode === "list" ? k("on") : undefined} aria-pressed={mode === "list"} onClick={() => setMode("list")}><Icon name="list" size={15} />List</button>
              </div>
              <button type="button" className={k("btn")} disabled title={READ_ONLY}><Icon name="upload" size={15} />Upload CSV</button>
              <button type="button" className={k("btn pri dim")} disabled title={READ_ONLY}><Icon name="plus" size={15} />Add agent</button>
            </div>

            <div className={k("chips")} aria-label="Stages">
              {forward.map((s) => (
                <button key={s.key} type="button" className={`${k("chip")}${chip === s.key ? " cpv-on" : ""}`} aria-pressed={chip === s.key} onClick={() => toggleChip(s.key)}>
                  {s.label} <b>{view.counts.get(s.key) ?? 0}</b>
                </button>
              ))}
              {tags.length > 0 ? (
                <>
                  <span className={k("chsep")} />
                  <span className={k("chl")}>Tags</span>
                  {tags.map((s) => (
                    <button key={s.key} type="button" className={`${k("chip stc")}${chip === s.key ? " cpv-on" : ""}`} aria-pressed={chip === s.key} onClick={() => toggleChip(s.key)}>
                      <span className={k("tg")} style={{ background: "transparent", padding: 0, height: "auto", fontSize: 12 }}><i style={{ background: s.dot }} />{s.label}</span>{" "}
                      <b>{view.counts.get(s.key) ?? 0}</b>
                    </button>
                  ))}
                </>
              ) : null}
            </div>

            <div className={k("card bulk")}>
              <span className={k("l")}>Bulk actions: off in this preview</span>
              <button type="button" className={k("btn sm dis")} disabled>Move to... <Icon name="chevDown" size={12} /></button>
              <button type="button" className={k("btn sm dis")} disabled>Add tag... <Icon name="chevDown" size={12} /></button>
              <button type="button" className={k("btn sm dis")} disabled>Assign to... <Icon name="chevDown" size={12} /></button>
              <button type="button" className={k("btn sm dis")} disabled><Icon name="copy" size={14} />Copy names</button>
              <button type="button" className={k("btn sm dis")} disabled><Icon name="copy" size={14} />Copy emails</button>
              <button type="button" className={k("btn sm dis")} disabled><Icon name="download" size={14} />Export CSV</button>
              <button type="button" className={k("btn sm dis")} disabled><Icon name="trash" size={14} />Delete</button>
            </div>

            <div className={k("sumr")}>
              <span><b>{view.shown.length.toLocaleString("en-US")}</b> agents</span>
              <span className={k("sd")} />
              <span><b>{abbrevUsd(view.totalVolume)}</b> total sales volume</span>
              <span className={k("sd")} />
              <span>{rangeLabel}</span>
            </div>

            {mode === "board" ? (
              <div className={k("board")}>
                {view.columns.map((c) => {
                  const showAll = expanded[`col:${c.stage.key}`];
                  const cards = showAll ? c.entries : c.entries.slice(0, CARDS_PER_COLUMN);
                  return (
                    <section key={c.stage.key} className={k("col")} aria-label={c.stage.label}>
                      <div className={k("colh")}>
                        <span className={k("dot")} style={{ background: c.stage.dot }} />
                        {c.stage.label}
                        {c.volume > 0 ? <span className={k("amt")}>{abbrevUsd(c.volume)}</span> : null}
                        <span className={k("n")}>{c.entries.length}</span>
                      </div>
                      {cards.map((e) => {
                        const sv = salesVolumeOf(e);
                        const stage = stageOf(e);
                        const src = sourceLabel(e);
                        return (
                          <button key={e.id} type="button" className={k("kc")} onClick={() => openAgent(e)}>
                            <span className={k("t1")}>{e.lead_name || "Unnamed agent"}{sv ? <span>{abbrevUsd(sv)}</span> : null}</span>
                            <span className={k("co")}>{e.current_brokerage || "—"}</span>
                            <span className={k("t3")}>
                              <span><Icon name="calendar" size={12} />{shortDate(e.introduced_at, now)}</span>
                              <span className={k(src === "Client" ? "src cl" : "src")}>{src}</span>
                            </span>
                            {stage.role === "tag" ? <span className="cpv-cardtag"><TagChip stage={stage} /></span> : null}
                          </button>
                        );
                      })}
                      {c.entries.length > cards.length ? (
                        <div className="cpv-more">
                          <button type="button" className={k("btn sm")} onClick={() => setExpanded((x) => ({ ...x, [`col:${c.stage.key}`]: true }))}>
                            Show {c.entries.length - cards.length} more
                          </button>
                        </div>
                      ) : null}
                    </section>
                  );
                })}
              </div>
            ) : (
              <div className={k("card")}>
                <table className={k("tb lt")}>
                  <thead>
                    <tr>
                      <th scope="col" style={{ width: 20 }}><input type="checkbox" aria-label="Select all on this page" disabled /></th>
                      <th scope="col">Name</th>
                      <th scope="col">Phone</th>
                      <th scope="col">Office</th>
                      <th scope="col">Stage</th>
                      <th scope="col">Owner</th>
                      <th scope="col">Date</th>
                      <th scope="col" className={k("r")}><span className={k("sr")}>Actions</span></th>
                    </tr>
                  </thead>
                  {groups.length === 0 ? (
                    <tbody>
                      <tr><td /><td colSpan={7} className="cpv-muted" style={{ padding: "18px 0" }}>No agents match.</td></tr>
                    </tbody>
                  ) : null}
                  {groups.map((g) => {
                    const showAll = expanded[`month:${g.key}`];
                    const rows = showAll ? g.entries : g.entries.slice(0, ROWS_PER_MONTH);
                    const month = g.label.split(" ")[0];
                    return (
                      <tbody key={g.key}>
                        <tr className={k("grp")}>
                          <td><input type="checkbox" aria-label={`Select all in ${g.label}`} disabled /></td>
                          <th scope="rowgroup" colSpan={7}>
                            <span className={k("gm")}>{g.label}</span>
                            <span className={k("gs")}>{g.entries.length} {g.entries.length === 1 ? "agent" : "agents"}</span>
                          </th>
                        </tr>
                        {rows.map((e) => (
                          <ListRow
                            key={e.id}
                            entry={e}
                            stage={stageOf(e)}
                            now={now}
                            onAgent={() => openAgent(e)}
                            onConversation={() => setOpen({ kind: "conversation", entry: e })}
                            onNotes={() => setOpen({ kind: "notes", entry: e })}
                          />
                        ))}
                        {g.entries.length > rows.length ? (
                          <tr className={k("morer")}>
                            <td />
                            <td colSpan={7}>
                              <a href="#" onClick={(ev) => { ev.preventDefault(); setExpanded((x) => ({ ...x, [`month:${g.key}`]: true })); }}>
                                Show {g.entries.length - rows.length} more from {month}
                              </a>
                            </td>
                          </tr>
                        ) : null}
                      </tbody>
                    );
                  })}
                </table>
                <div className={k("tf")}>
                  <span><b style={{ color: "#1f2124", fontWeight: 600 }}>{view.shown.length.toLocaleString("en-US")}</b> agents</span>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {open?.kind === "agent" ? (
        <AgentPanel
          entry={open.entry}
          stage={stageOf(open.entry)}
          onClose={() => setOpen(null)}
          onConversation={() => setOpen({ kind: "conversation", entry: open.entry })}
          onNotes={() => setOpen({ kind: "notes", entry: open.entry })}
        />
      ) : null}
      {open?.kind === "conversation" ? (
        <ConversationPanel entry={open.entry} stage={stageOf(open.entry)} token={token} now={now} onClose={() => setOpen(null)} />
      ) : null}
      {open?.kind === "notes" ? <NotesPanel entry={open.entry} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

function ListRow({
  entry: e,
  stage,
  now,
  onAgent,
  onConversation,
  onNotes,
}: {
  entry: PipelineEntry;
  stage: PreviewStage;
  now: Date;
  onAgent: () => void;
  onConversation: () => void;
  onNotes: () => void;
}) {
  const name = e.lead_name || "Unnamed agent";
  const src = sourceLabel(e);
  const owner = e.assigned_team_member?.name ?? null;
  const notes = e.notes_log.length;
  return (
    <tr>
      <td className={k("vt")}><input type="checkbox" aria-label={`Select ${name}`} disabled /></td>
      <td className={k("vt")}>
        <div className={k("nmc")}>
          <a href="#" onClick={(ev) => { ev.preventDefault(); onAgent(); }}>{name}</a>
          {e.lead_email ? <span className={k("em")}>{e.lead_email}</span> : null}
          <div className={k("nx")}>
            {e.thread_id ? (
              <a className={k("cvb")} href="#" onClick={(ev) => { ev.preventDefault(); onConversation(); }}>
                <Icon name="chat" size={13} />Conversation
              </a>
            ) : null}
            <span className={k(src === "Client" ? "src cl" : "src")}>{src}</span>
            {stage.role === "tag" ? <TagChip stage={stage} /> : null}
          </div>
        </div>
      </td>
      <td className={k("vt")}>
        {e.lead_phone ? (
          <span className={k("ph")}>
            {e.lead_phone}
            <button className={k("mini")} type="button" aria-label="Copy phone number" title="Copy phone number" onClick={() => void navigator.clipboard?.writeText(e.lead_phone ?? "")}>
              <Icon name="copy" size={12} />
            </button>
          </span>
        ) : (
          <span className={k("dash")}>&ndash;</span>
        )}
      </td>
      <td className={k("vt")}><div className={k("coc")}>{e.current_brokerage || <span className={k("dash")}>&ndash;</span>}</div></td>
      <td className={k("vt")}><StageCell stage={stage} /></td>
      <td className={k("vt")}>
        {owner ? (
          <span className={k("own")}><span className={k("av")}>{initials(owner)}</span>{owner}</span>
        ) : (
          <span className={k("own none")}>Unassigned</span>
        )}
      </td>
      <td className={k("vt")}>{shortDate(e.introduced_at, now)}</td>
      <td className={k("vt r")}>
        <div className={k("acts")}>
          <button type="button" className={k("ib")} aria-label={`Edit ${name}`} title={READ_ONLY} disabled><Icon name="pencil" size={15} /></button>
          <button type="button" className={k("btn sm")} style={{ marginLeft: 4 }} onClick={onNotes}>
            <Icon name="note" size={14} />Notes{notes ? ` (${notes})` : ""}
          </button>
        </div>
      </td>
    </tr>
  );
}
