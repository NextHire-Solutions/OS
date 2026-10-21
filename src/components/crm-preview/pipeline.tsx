"use client";

/*
 * Pipeline — the redesign's board and list, on the client's real pipeline.
 * Filters, views and panels work; everything that would change the pipeline
 * is drawn disabled (see src/app/crm-preview/page.tsx) — except on the Demo
 * Portal, where moving, tagging, assigning, adding, editing, notes and
 * deleting save (demo-save.ts). Upload CSV and Manage stages are drawn only.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import type { PipelineEntry, TeamMember } from "@/lib/tools/master-inbox/portals/stages-shared";
import {
  TIME_RANGES,
  abbrevUsd,
  formatPhone,
  listPage,
  ROWS_PER_MONTH,
  initials,
  pipelineView,
  salesVolumeOf,
  shortDate,
  sourceLabel,
  type Placement,
  type PreviewStage,
  type TimeRange,
} from "@/lib/crm-preview/model";

import { Icon } from "./icons";
import { k, RO, withIds } from "./k";
import { EditLeadDialog, PipelineAddDialog, PipelineUploadDialog } from "./dialogs";
import { AgentPanel, ChooseMenu, ConversationPanel, NotesPanel, StageCell, TagChip } from "./panels";
import { lock, moveTo, saveCsv, useDemo, type DemoAction } from "./demo-save";

type Open = { kind: "agent" | "conversation" | "notes" | "edit"; entry: PipelineEntry } | { kind: "add" | "upload" } | null;


export function PipelineScreen({ entries, stages, furthest, team, clientId, now }: { entries: PipelineEntry[]; stages: PreviewStage[]; furthest: Record<string, string>; team: TeamMember[]; clientId: string; now: Date }) {
  const [mode, setMode] = useState<"board" | "list">("board");
  const [range, setRange] = useState<TimeRange>("all");
  const [search, setSearch] = useState("");
  const [chip, setChip] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const menuRef = useRef<HTMLSpanElement>(null);
  // Ticked rows (the list's checkboxes): the bulk bar switches on as the design's Pipeline-Selected; its actions are inert.
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [bulkMenu, setBulkMenu] = useState<"move" | "tag" | "assign" | null>(null);
  // The Demo Portal saves (demo-save.ts); every other client stays read-only.
  const { live, save } = useDemo();
  const bulkRef = useRef<HTMLDivElement>(null);

  const view = useMemo(() => pipelineView(entries, stages, { range, search, chip, now }, furthest), [entries, stages, range, search, chip, now, furthest]);
  const [listPageNo, setListPageNo] = useState(1);
  const page = useMemo(() => listPage(view.shown, listPageNo), [view.shown, listPageNo]);
  // A new filter starts the list again at its first page.
  useEffect(() => setListPageNo(1), [range, search, chip]);
  const pageIds = useMemo(() => page.groups.flatMap((g) => g.rows.map((x) => x.id)), [page]);
  const pageAllPicked = pageIds.length > 0 && pageIds.every((id) => picked.has(id));
  // Only ticked rows still on screen count (a filter can hide one).
  const pickedShown = useMemo(() => view.shown.filter((x) => picked.has(x.id)), [view.shown, picked]);
  const pick = (ids: readonly string[], on: boolean) => setPicked((cur) => withIds(cur, ids, on));
  useEffect(() => {
    if (!bulkMenu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !bulkRef.current?.contains(e.target as Node)) setBulkMenu(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [bulkMenu]);
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

  const placeOf = (e: PipelineEntry) => view.placement.get(e.id)!;
  // An open panel shows the agent as the page last loaded them — after a save, the fresh row.
  const fresh = (e: PipelineEntry) => entries.find((x) => x.id === e.id) ?? e;
  const pickedIds = pickedShown.map((x) => x.id);
  const bulk = async (a: DemoAction) => {
    if (await save(a)) {
      setPicked(new Set());
      setBulkMenu(null);
    }
  };
  const toggleChip = (key: string) => setChip((c) => (c === key ? null : key));
  const openAgent = (entry: PipelineEntry) => setOpen({ kind: "agent", entry });

  return (
    <>
      <header className={k("top")}>
        <div className={k("ttl")}>
          <h1>Pipeline</h1>
          {entries.length ? <span className={k("hsub")}>Every agent who replied interested, from first reply to&nbsp;hire.</span> : null}
        </div>
        <div className={k("hr")} />
      </header>

      <div className={k("content")}>
        {entries.length ? <ManageStages stages={stages} tagCounts={tagCounts(view.placement)} /> : null}

        {entries.length === 0 ? (
          <div className={k("es")}>
            <section className={k("card ec")}>
              <span className={k("ei")}><Icon name="pipeline" size={22} /></span>
              <h2>No agents in your pipeline yet</h2>
              <p>When an agent replies interested to your outreach, they show up here. You can also add one&nbsp;yourself.</p>
              <div className={k("ea")}>
                <button type="button" className={k("btn pri")} {...lock(live)} onClick={live ? () => setOpen({ kind: "add" }) : undefined}><Icon name="plus" size={15} />Add agent</button>
                <button type="button" className={k("btn")} {...RO}><Icon name="upload" size={15} />Upload CSV</button>
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
                  <div className={k("menu")} role="menu" style={{ minWidth: 170 }}>
                    {TIME_RANGES.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={r.id === range}
                        className={r.id === range ? k("hv") : undefined}
                        onClick={() => { setRange(r.id); setMenuOpen(false); }}
                      >
                        <span style={{ width: 14, display: "inline-flex", color: "#3e6bd1" }}>{r.id === range ? <Icon name="check" size={14} /> : null}</span>
                        {r.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </span>
              <span className={k("vlab")} style={{ marginLeft: "auto" }}>View as:</span>
              <div className={k("seg")} role="group" aria-label="View as">
                <button type="button" className={mode === "board" ? k("on") : undefined} aria-pressed={mode === "board"} onClick={() => setMode("board")}><Icon name="board" size={14} />Board</button>
                <button type="button" className={mode === "list" ? k("on") : undefined} aria-pressed={mode === "list"} onClick={() => setMode("list")}><Icon name="list" size={14} />List</button>
              </div>
              <button type="button" className={k("btn")} onClick={() => setOpen({ kind: "upload" })}><Icon name="upload" size={15} />Upload CSV</button>
              <button type="button" className={k("btn pri")} onClick={() => setOpen({ kind: "add" })}><Icon name="plus" size={15} />Add agent</button>
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

            {pickedShown.length === 0 ? (
              <div className={k("card bulk")}>
                <span className={k("l")}>Bulk actions: tick rows below to enable</span>
                <button type="button" className={k("btn sm dis")} disabled>Move to... <Icon name="chevDown" size={12} /></button>
                <button type="button" className={k("btn sm dis")} disabled>Add tag... <Icon name="chevDown" size={12} /></button>
                <button type="button" className={k("btn sm dis")} disabled>Assign to... <Icon name="chevDown" size={12} /></button>
                <button type="button" className={k("btn sm dis")} disabled><Icon name="copy" size={14} />Copy names</button>
                <button type="button" className={k("btn sm dis")} disabled><Icon name="copy" size={14} />Copy emails</button>
                <button type="button" className={k("btn sm dis")} disabled><Icon name="download" size={14} />Export CSV</button>
                <button type="button" className={k("btn sm dis")} disabled><Icon name="trash" size={14} />Delete</button>
              </div>
            ) : (
              <>
                <div className={k("card bulk on")} ref={bulkRef}>
                  <span className={k("l")}>{pickedShown.length.toLocaleString("en-US")} selected</span>
                  <span className={k("ddw")}>
                    <button type="button" className={k("btn sm")} aria-haspopup="menu" aria-expanded={bulkMenu === "move"} onClick={() => setBulkMenu((m) => (m === "move" ? null : "move"))}>Move to...{" "}<Icon name="chevDown" size={12} /></button>
                    {bulkMenu === "move" ? (
                      <div className={k("menu")} role="menu">
                        {forward.map((st, i) => (
                          <button key={st.key} type="button" role="menuitem" className={i === 0 ? k("hv") : undefined} {...lock(live)} onClick={live ? () => void bulk(moveTo(pickedIds, st.key)) : undefined}>
                            <span className={k("dot")} style={{ background: st.dot }} />{st.label}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </span>
                  {live ? (
                    <span className={k("ddw")}>
                      <button type="button" className={k("btn sm")} aria-haspopup="menu" aria-expanded={bulkMenu === "tag"} onClick={() => setBulkMenu((m) => (m === "tag" ? null : "tag"))}>Add tag...{" "}<Icon name="chevDown" size={12} /></button>
                      {bulkMenu === "tag" ? (
                        <div className={k("menu")} role="menu">
                          {tags.map((t) => (
                            <button key={t.key} type="button" role="menuitem" onClick={() => void bulk(moveTo(pickedIds, t.key))}>
                              <span className={k("dot")} style={{ background: t.dot }} />{t.label}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </span>
                  ) : (
                    <button type="button" className={k("btn sm")} {...RO}>Add tag...{" "}<Icon name="chevDown" size={12} /></button>
                  )}
                  <span className={k("ddw")}>
                    <button type="button" className={k("btn sm")} aria-haspopup="menu" aria-expanded={bulkMenu === "assign"} onClick={() => setBulkMenu((m) => (m === "assign" ? null : "assign"))}>Assign to...{" "}<Icon name="chevDown" size={12} /></button>
                    {bulkMenu === "assign" ? (
                      <div className={k("menu")} role="menu">
                        <button type="button" role="menuitem" className={k("mut")} {...lock(live)} onClick={live ? () => void bulk({ type: "entry.assign", ids: pickedIds, member: null }) : undefined}>Unassigned</button>
                        {team.map((m, i) => <button key={m.id} type="button" role="menuitem" className={i === 0 ? k("hv") : undefined} {...lock(live)} onClick={live ? () => void bulk({ type: "entry.assign", ids: pickedIds, member: m.id }) : undefined}>{m.name}</button>)}
                      </div>
                    ) : null}
                  </span>
                  <button type="button" className={k("btn sm")} {...lock(live)} onClick={live ? () => void navigator.clipboard?.writeText(pickedShown.map((x) => x.lead_name ?? "").filter(Boolean).join("\n")) : undefined}><Icon name="copy" size={14} />Copy names</button>
                  <button type="button" className={k("btn sm")} {...lock(live)} onClick={live ? () => void navigator.clipboard?.writeText(pickedShown.map((x) => x.lead_email ?? "").filter(Boolean).join("\n")) : undefined}><Icon name="copy" size={14} />Copy emails</button>
                  <button type="button" className={k("btn sm")} {...lock(live)} onClick={live ? () => saveCsv("pipeline.csv", ["Name", "Email", "Phone", "Company", "Stage", "Introduced"], pickedShown.map((x) => [x.lead_name, x.lead_email, x.lead_phone, x.current_brokerage, placeOf(x).stage.label, (x.introduced_at ?? "").slice(0, 10)])) : undefined}><Icon name="download" size={14} />Export CSV</button>
                  <button
                    type="button"
                    className={k("btn sm del")}
                    {...lock(live)}
                    onClick={live ? () => { if (window.confirm(`Delete ${pickedIds.length} ${pickedIds.length === 1 ? "agent" : "agents"} from the Demo Portal's pipeline?`)) void bulk({ type: "entry.delete", ids: pickedIds }); } : undefined}
                  >
                    <Icon name="trash" size={14} />Delete
                  </button>
                  <button type="button" className={k("btn sm ghost")} onClick={() => { setPicked(new Set()); setBulkMenu(null); }}>Clear</button>
                </div>
                {pageAllPicked && view.shown.length > pageIds.length ? (
                  <div className={k("selall")}>
                    <span>All{" "}<b>{pageIds.length}</b>{" "}leads on this page are selected.</span>
                    <a href="#" onClick={(ev) => { ev.preventDefault(); setPicked(new Set(view.shown.map((x) => x.id))); }}>Select all {view.shown.length.toLocaleString("en-US")} leads</a>
                  </div>
                ) : null}
              </>
            )}

            <div className={k("sumr")}>
              <span><b>{view.shown.length.toLocaleString("en-US")}</b> agents</span>
              <span className={k("sd")} />
              <span><b>{abbrevUsd(view.totalVolume)}</b> total sales volume</span>
              <span className={k("sd")} />
              <span>{rangeLabel}</span>
            </div>

            {mode === "board" ? (
              <div className={k("board")}>
                {/* Every card, as the design's board (no client has more than a few hundred); each column scrolls. */}
                {view.columns.map((c) => {
                  return (
                    <section key={c.stage.key} className={k("col")} aria-label={c.stage.label}>
                      <div className={k("colh")}>
                        <span className={k("dot")} style={{ background: c.stage.dot }} />
                        {c.stage.label}
                        {c.volume > 0 ? <span className={k("amt")}>{abbrevUsd(c.volume)}</span> : null}
                        <span className={k("n")}>{c.entries.length}</span>
                      </div>
                      {c.entries.map((e) => {
                        const sv = salesVolumeOf(e);
                        const place = placeOf(e);
                        const src = sourceLabel(e);
                        return (
                          <button key={e.id} type="button" className={k("kc")} onClick={() => openAgent(e)}>
                            <span className={k("t1")}>{e.lead_name || "Unnamed agent"}{sv ? <span>{abbrevUsd(sv)}</span> : null}</span>
                            <span className={k("co")}>{e.current_brokerage || "—"}</span>
                            <span className={k("t3")}>
                              <span><Icon name="calendar" size={13} />{shortDate(e.introduced_at, now)}</span>
                              <span className={k(src === "Client" ? "src cl" : "src")}>{src}</span>
                            </span>
                            {place.tag ? <span className="cpv-cardtag"><TagChip stage={place.tag} /></span> : null}
                          </button>
                        );
                      })}
                    </section>
                  );
                })}
              </div>
            ) : (
              <div className={k("card")}>
                <table className={k("tb lt")}>
                  <thead>
                    <tr>
                      <th scope="col" style={{ width: 20 }}><input type="checkbox" aria-label="Select all on this page" checked={pageAllPicked} onChange={() => pick(pageIds, !pageAllPicked)} /></th>
                      <th scope="col">Name</th>
                      <th scope="col">Phone</th>
                      <th scope="col">Office</th>
                      <th scope="col">Stage</th>
                      <th scope="col">Owner</th>
                      <th scope="col">Date</th>
                      <th scope="col" className={k("r")}><span className={k("sr")}>Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                  {page.groups.length === 0 ? (
                    <tr><td /><td colSpan={7} className="cpv-muted" style={{ padding: "18px 0" }}>No agents match.</td></tr>
                  ) : null}
                  {page.groups.map((g) => {
                    const openKey = `month:${page.page}:${g.key}`;
                    const rows = expanded[openKey] ? g.rows : g.rows.slice(0, ROWS_PER_MONTH);
                    const month = g.label.split(" ")[0];
                    return (
                      <Fragment key={g.key}>
                        <tr className={k("grp")}>
                          <td><input type="checkbox" aria-label={`Select all in ${g.label}`} checked={g.rows.every((x) => picked.has(x.id))} onChange={() => pick(g.rows.map((x) => x.id), !g.rows.every((x) => picked.has(x.id)))} /></td>
                          <th scope="rowgroup" colSpan={7}>
                            <span className={k("gm")}>{g.label}</span>
                            <span className={k("gs")}>{g.monthTotal} {g.monthTotal === 1 ? "agent" : "agents"}</span>
                          </th>
                        </tr>
                        {rows.map((e) => (
                          <ListRow
                            key={e.id}
                            entry={e}
                            placement={placeOf(e)}
                            now={now}
                            picked={picked.has(e.id)}
                            onPick={() => pick([e.id], !picked.has(e.id))}
                            onEdit={() => setOpen({ kind: "edit", entry: e })}
                            onConversation={() => setOpen({ kind: "conversation", entry: e })}
                            onNotes={() => setOpen({ kind: "notes", entry: e })}
                            stages={forward}
                            onMove={live ? (key) => void save(moveTo([e.id], key)) : undefined}
                          />
                        ))}
                        {g.rows.length > rows.length ? (
                          <tr className={k("morer")}>
                            <td />
                            <td colSpan={7}>
                              <a href="#" onClick={(ev) => { ev.preventDefault(); setExpanded((x) => ({ ...x, [openKey]: true })); }}>
                                Show {g.rows.length - rows.length} more from {month}
                              </a>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                  </tbody>
                </table>
                <div className={k("tf")}>
                  <span>
                    <b style={{ color: "#1f2124", fontWeight: 600 }}>{page.from.toLocaleString("en-US")}&ndash;{page.to.toLocaleString("en-US")}</b> of {page.total.toLocaleString("en-US")} agents
                  </span>
                  <div className={k("pg")} style={{ alignItems: "center" }}>
                    <button type="button" className={k(page.page <= 1 ? "btn sm dis" : "btn sm")} disabled={page.page <= 1} onClick={() => setListPageNo(page.page - 1)}>Previous</button>
                    <span>Page {page.page} / {page.pages}</span>
                    <button type="button" className={k(page.page >= page.pages ? "btn sm dis" : "btn sm")} disabled={page.page >= page.pages} onClick={() => setListPageNo(page.page + 1)}>
                      Next <Icon name="chevRight" size={12} />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {open?.kind === "agent" ? (
        <AgentPanel
          entry={fresh(open.entry)}
          placement={placeOf(fresh(open.entry))}
          tags={tags}
          onTag={live ? (key) => void save(moveTo([open.entry.id], key)) : undefined}
          onClose={() => setOpen(null)}
          onEdit={() => setOpen({ kind: "edit", entry: fresh(open.entry) })}
        />
      ) : null}
      {open?.kind === "edit" ? (
        <EditLeadDialog
          entry={open.entry}
          placement={placeOf(fresh(open.entry))}
          onClose={() => setOpen(null)}
          onSave={live ? (v) => save({ type: "entry.edit", id: open.entry.id, lead_name: v.name, lead_email: v.email, lead_phone: v.phone, current_brokerage: v.company, agent_profile_url: v.profile }) : undefined}
        />
      ) : null}
      {open?.kind === "add" ? (
        <PipelineAddDialog
          now={now}
          onClose={() => setOpen(null)}
          onSave={live ? (v) => save({ type: "entry.add", lead_name: v.name, lead_email: v.email, lead_phone: v.phone, current_brokerage: v.company, agent_profile_url: v.profile }) : undefined}
        />
      ) : null}
      {open?.kind === "upload" ? <PipelineUploadDialog onClose={() => setOpen(null)} /> : null}
      {open?.kind === "conversation" ? (
        <ConversationPanel entry={open.entry} placement={placeOf(open.entry)} clientId={clientId} now={now} onClose={() => setOpen(null)} />
      ) : null}
      {open?.kind === "notes" ? <NotesPanel entry={fresh(open.entry)} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

/** How many agents carry each tag — all of them, whatever the filters. */
function tagCounts(placement: Map<string, Placement>): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of placement.values()) if (p.tag) out.set(p.tag.key, (out.get(p.tag.key) ?? 0) + 1);
  return out;
}

const NAME_INPUT = { flex: 1, border: 0, outline: 0, background: "transparent", fontSize: 13, color: "#1f2124", fontWeight: 500 } as const;

/*
 * Manage stages, as the design draws it open (its Stages screen): the client's
 * stages and tags with their own names and colours. Renaming, reordering,
 * hiding, adding and saving are drawn disabled; opening and closing it works.
 */
function ManageStages({ stages, tagCounts: counts }: { stages: PreviewStage[]; tagCounts: Map<string, number> }) {
  const [open, setOpen] = useState(false);
  const forward = stages.filter((s) => s.role === "stage");
  const tags = stages.filter((s) => s.role === "tag");
  const head = (
    <>
      <span className={k("mi")}><Icon name="stages" size={17} /></span>
      <span>
        <b>Manage stages</b>
        <span className={k("t")}>Rename, reorder, and show or hide your pipeline stages. Applies to everyone viewing this portal.</span>
      </span>
      <span className={k("cv")}><Icon name={open ? "chevUp" : "chevDown"} size={16} /></span>
    </>
  );
  if (!open) {
    return <button type="button" className={k("card ms")} aria-expanded={false} onClick={() => setOpen(true)}>{head}</button>;
  }
  const row = (s: PreviewStage, end: React.ReactNode) => (
    <div key={s.key} className={k("stg")}>
      <button type="button" className={k("ib")} aria-label={`Reorder ${s.label}`} {...RO} style={{ cursor: "grab" }}><Icon name="reorder" size={16} /></button>
      <span className={k("dot")} style={{ background: s.dot }} />
      <input value={s.label} aria-label={`Rename ${s.label}`} style={NAME_INPUT} readOnly {...RO} />
      {end}
    </div>
  );
  return (
    <section className={k("card")}>
      <button type="button" className={k("ms msx")} aria-expanded onClick={() => setOpen(false)} aria-label="Collapse manage stages">{head}</button>
      <div className={k("stl")}>
        {forward.map((s, i) => {
          // The design keeps the first and the last (Hired) always shown.
          const always = i === 0 || s.key === "hired";
          return row(s, (
            always ? (
              <button type="button" className={k("ib")} disabled aria-label={`${s.label} is always shown`} title="Always shown" style={{ color: "#c2c7d0", cursor: "default" }}>
                <Icon name="eyeOutline" size={16} />
              </button>
            ) : (
              <button type="button" className={k("ib")} aria-label={`Hide ${s.label}`} {...RO}>
                <Icon name="eyeOutline" size={16} />
              </button>
            )
          ));
        })}
        <button type="button" className={k("addb")} {...RO}><Icon name="plus" size={14} />Add stage</button>
        <div className={k("svr")}>
          <span>Custom stages are for your team&apos;s workflow. They don&apos;t change your&nbsp;reporting.</span>
          <button type="button" className={k("btn pri")} {...RO}>Save changes</button>
        </div>
        {tags.length ? (
          <>
            <div style={{ padding: "18px 0 4px", borderTop: "1px solid #ebedf0", marginTop: 10 }}>
              <div style={{ fontWeight: 600 }}>Tags</div>
              <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>Tag an agent without moving them through your pipeline. Stages only move&nbsp;forward.</div>
            </div>
            {tags.map((t) => row(t, (
              <>
                <span style={{ fontSize: 12, color: "#6b7280", marginRight: 4 }}>{(counts.get(t.key) ?? 0).toLocaleString("en-US")} agents</span>
                <button type="button" className={k("ib")} aria-label={`Delete tag ${t.label}`} {...RO}><Icon name="x" size={15} /></button>
              </>
            )))}
            <button type="button" className={k("addb")} {...RO}><Icon name="plus" size={14} />Add tag</button>
            <div className={k("svr")}>
              <span>Tags are shared with everyone on your&nbsp;team.</span>
              <button type="button" className={k("btn pri")} {...RO}>Save changes</button>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}

function ListRow({
  entry: e,
  placement,
  now,
  picked,
  onPick,
  onEdit,
  onConversation,
  onNotes,
  stages,
  onMove,
}: {
  entry: PipelineEntry;
  placement: Placement;
  now: Date;
  picked: boolean;
  onPick: () => void;
  onEdit: () => void;
  onConversation: () => void;
  onNotes: () => void;
  /** The forward stages, and what choosing one does — only on the Demo Portal. */
  stages: PreviewStage[];
  onMove?: (key: string) => void;
}) {
  const name = e.lead_name || "Unnamed agent";
  const src = sourceLabel(e);
  const owner = e.assigned_team_member?.name ?? null;
  const notes = e.notes_log.length;
  return (
    <tr className={picked ? k("sel") : undefined}>
      <td className={k("vt")}><input type="checkbox" aria-label={`Select ${name}`} checked={picked} onChange={onPick} /></td>
      <td className={k("vt")}>
        <div className={k("nmc")}>
          {/* The design's list opens Edit lead from the name, as from the pencil. */}
          <a href="#" onClick={(ev) => { ev.preventDefault(); onEdit(); }}>{name}</a>
          {e.lead_email ? <span className={k("em")}>{e.lead_email}</span> : null}
          <div className={k("nx")}>
            {e.thread_id ? (
              <a className={k("cvb")} href="#" onClick={(ev) => { ev.preventDefault(); onConversation(); }}>
                <Icon name="chat" size={13} />Conversation
              </a>
            ) : null}
            <span className={k(src === "Client" ? "src cl" : "src")}>{src}</span>
            {placement.tag ? <TagChip stage={placement.tag} /> : null}
          </div>
        </div>
      </td>
      <td className={k("vt")}>
        {e.lead_phone ? (
          <span className={k("ph")}>
            {formatPhone(e.lead_phone)}
            <button className={k("mini")} type="button" aria-label="Copy phone number" title="Copy phone number" onClick={() => void navigator.clipboard?.writeText(e.lead_phone ?? "")}>
              <Icon name="copy" size={13} />
            </button>
          </span>
        ) : (
          <span className={k("dash")}>&ndash;</span>
        )}
      </td>
      <td className={k("vt")}><div className={k("coc")}>{e.current_brokerage || <span className={k("dash")}>&ndash;</span>}</div></td>
      <td className={k("vt")}>
        {/* The design's stage picker: a pill that opens the stages — it moves the agent on the Demo Portal, and is drawn only elsewhere. */}
        {onMove ? (
          <ChooseMenu className={k(`pill p-${placement.stage.pill}`)} label={<>{placement.stage.label} <Icon name="chevDown" size={11} /></>} options={stages} onChoose={onMove} />
        ) : (
          <button type="button" className={k(`pill p-${placement.stage.pill}`)} {...RO}>
            {placement.stage.label} <Icon name="chevDown" size={11} />
          </button>
        )}
      </td>
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
          <button type="button" className={k("ib")} aria-label={`Edit ${name}`} title="Edit" onClick={onEdit}><Icon name="pencil" size={15} /></button>
          <button type="button" className={k("btn sm")} style={{ marginLeft: 4 }} onClick={onNotes}>
            <Icon name="note" size={13} />Add note
          </button>
        </div>
      </td>
    </tr>
  );
}
