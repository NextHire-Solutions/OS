"use client";

/*
 * Pipeline — the redesign's board and list, on the client's real pipeline.
 * Filters, views and panels work; everything that would change the pipeline
 * is drawn disabled (see src/app/crm-preview/page.tsx) — except on the Demo
 * Portal, where moving, tagging, assigning, adding, editing, notes and
 * deleting save (demo-save.ts), and Upload CSV imports and Manage stages
 * save (22 Oct).
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import { DEFAULT_STAGE_LABELS, type PipelineEntry, type PipelineStage, type TeamMember } from "@/lib/tools/master-inbox/portals/stages-shared";
import {
  ALWAYS_SHOWN,
  CUSTOM_TAG_PREFIX,
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
  type ManagedStage,
  type Placement,
  panelFields,
  type PreviewStage,
  type TimeRange,
} from "@/lib/crm-preview/model";
import { csvRowToPipeline } from "@/lib/tools/master-inbox/portals/csv";
import { PHONE_KEYS, pickFirstString } from "@/components/master-inbox/portals-ui/custom-field-helpers";
import { GLOBAL_CUSTOM_STAGE_KEYS, STAGE_COLOR_PALETTE } from "@/lib/tools/master-inbox/portals/stage-config";

import { Icon } from "./icons";
import { k, RO, withIds } from "./k";
import { EditLeadDialog, PipelineAddDialog, PipelineUploadDialog, ymd } from "./dialogs";
import { AgentPanel, ChooseMenu, ConversationPanel, NotesPanel, ReplacementMark, StageCell, TagChip } from "./panels";
import { importCsv, isCanonicalStage, lock, moveTo, saveCsv, useDemo, type DemoAction } from "./demo-save";
import { useBoardDrag } from "./board-drag";
import { useColumnDrag } from "./column-drag";

type Open = { kind: "agent" | "conversation" | "notes" | "edit"; entry: PipelineEntry } | { kind: "add" | "upload" } | null;


export function PipelineScreen({ entries, stages, allStages, furthest, team, clientId, fubConnected = false, now }: { entries: PipelineEntry[]; stages: PreviewStage[]; allStages?: ManagedStage[]; furthest: Record<string, string>; team: TeamMember[]; fubConnected?: boolean; clientId: string; now: Date }) {
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
  // Saves where this viewer may change the portal (demo-save.ts `live`: the Demo, a client's own, staff on any open one).
  const demo = useDemo();
  const { live, save } = demo;
  const bulkRef = useRef<HTMLDivElement>(null);

  /*
   * A card dropped in another column (Demo Portal, 23 Oct) shows there at once;
   * the page's reload after the save replaces this guess with the real row, and
   * a failed save puts the card back.
   */
  const [pending, setPending] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => setPending(new Map()), [entries]);
  const shownEntries = useMemo(
    () => (pending.size
      ? entries.map((e) => {
          const to = pending.get(e.id);
          return !to ? e : isCanonicalStage(to) ? { ...e, stage: to as PipelineEntry["stage"], custom_stage_key: null } : { ...e, custom_stage_key: to };
        })
      : entries),
    [entries, pending],
  );
  const board = useBoardDrag(live && mode === "board", (id, to) => {
    setPending((m) => new Map(m).set(id, to));
    void save(moveTo([id], to)).then((ok) => {
      if (!ok) setPending((m) => new Map([...m].filter(([k]) => k !== id)));
    });
  });

  const view = useMemo(() => pipelineView(shownEntries, stages, { range, search, chip, now }, furthest), [shownEntries, stages, range, search, chip, now, furthest]);
  /*
   * The board's columns can be dragged into a new order (Demo Portal, 27 Oct;
   * column-drag.tsx) — when every stage is on the board, not one picked out.
   * The new order saves as Manage stages saves it: the moved stages first,
   * then every other stage and tag (hidden ones too) as they were.
   */
  const columnKeys = useMemo(() => stages.filter((s) => s.role === "stage").map((s) => s.key), [stages]);
  const canReorder = live && !!allStages && mode === "board" && view.columns.length === columnKeys.length;
  const cols = useColumnDrag(canReorder, columnKeys, (order) => {
    if (!allStages) return;
    const byKey = new Map(allStages.map((s) => [s.key, s]));
    const moved = order.map((key) => byKey.get(key)).filter((s): s is ManagedStage => !!s);
    const rest = allStages.filter((s) => !order.includes(s.key));
    void save({ type: "stages.save", stages: payload([...moved, ...rest]) }).then((ok) => { if (!ok) cols.revert(); });
  });
  const boardColumns = canReorder
    ? cols.order.map((key) => view.columns.find((c) => c.stage.key === key)).filter((c): c is (typeof view.columns)[number] => !!c)
    : view.columns;
  const [listPageNo, setListPageNo] = useState(1);
  const page = useMemo(() => listPage(view.shown, listPageNo), [view.shown, listPageNo]);
  // A new filter starts the list again at its first page.
  useEffect(() => setListPageNo(1), [range, search, chip]);
  const pageIds = useMemo(() => page.groups.flatMap((g) => g.rows.map((x) => x.id)), [page]);
  const pageAllPicked = pageIds.length > 0 && pageIds.every((id) => picked.has(id));
  // Only ticked rows still on screen count (a filter can hide one).
  const pickedShown = useMemo(() => view.shown.filter((x) => picked.has(x.id)), [view.shown, picked]);
  /*
   * The current portal's bulk Copy and Export (28 Oct): its toasts, and its export's columns — Name, Email, Phone,
   * Company, Agent profile, Location, Stage (the agent's pipeline stage by this portal's name for it, so the file
   * imports back), Assigned, Introduced, then each custom field the agents have.
   */
  const copy = (what: string, values: Array<string | null | undefined>) => {
    const list = values.map((v) => (v ?? "").trim()).filter(Boolean);
    if (!list.length) return demo.say("Nothing to copy", true);
    navigator.clipboard?.writeText(list.join("\n")).then(() => demo.say(list.length === 1 ? `Copied: ${list[0]}` : `Copied ${list.length.toLocaleString("en-US")} ${what}`), () => demo.say("Could not access clipboard", true));
  };
  // A phone as the current portal copies it: the entry's own, else the campaign's (its PHONE_KEYS).
  const phoneOf = (x: PipelineEntry) => x.lead_phone || pickFirstString((x.lead_detail as { custom_fields?: Record<string, unknown> } | null)?.custom_fields ?? {}, PHONE_KEYS);
  const stageName = (s: PipelineStage) => stages.find((x) => x.key === s)?.label ?? allStages?.find((x) => x.key === s)?.label ?? DEFAULT_STAGE_LABELS[s] ?? s;
  const exportPicked = () => {
    const extra = new Map<string, string>();
    // Headed as the current portal heads them: the first letter capitalised ("Buy-side", "Sales volume").
    for (const x of pickedShown) for (const f of panelFields(x)) if (!extra.has(f.label.toLowerCase())) extra.set(f.label.toLowerCase(), f.label.charAt(0).toUpperCase() + f.label.slice(1));
    const fieldsOf = (x: PipelineEntry) => new Map(panelFields(x).map((f) => [f.label.toLowerCase(), f.value]));
    saveCsv(
      `pipeline-${ymd(now)}.csv`,
      ["Name", "Email", "Phone", "Company", "Agent profile", "Location", "Stage", "Assigned", "Introduced", ...extra.values()],
      pickedShown.map((x) => {
        const own = fieldsOf(x);
        return [x.lead_name, x.lead_email, x.lead_phone, x.current_brokerage, x.agent_profile_url, x.lead_location, stageName(x.stage), x.assigned_team_member?.name, (x.introduced_at ?? "").slice(0, 10), ...[...extra.keys()].map((key) => own.get(key))];
      }),
    );
  };
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
  /*
   * The Edit form on the Demo Portal (23 Oct): the agent's fields, then any
   * custom field changed, cleared or added, then the tag — each its own save.
   */
  const saveEdit = async (e: PipelineEntry, v: Record<string, string>) => {
    // The date and the replacement mark only when changed (the current portal re-sends both, rewriting the time of day).
    const day = e.introduced_at ? ymd(new Date(e.introduced_at)) : "";
    const replacing = v.replacement === "true";
    if (!(await save({
      type: "entry.edit", id: e.id, lead_name: v.name, lead_email: v.email, lead_phone: v.phone, current_brokerage: v.company, agent_profile_url: v.profile,
      introduced_at: v.introduced && v.introduced !== day ? v.introduced : undefined,
      needs_replacement: replacing !== e.needs_replacement ? replacing : undefined,
    }))) return false;
    const before = new Map(panelFields(e).filter((f) => f.key).map((f) => [f.key as string, f.value]));
    // As the current portal: a field the client added themselves comes off when emptied; one from the campaign is blanked.
    const own = new Set(e.manual_custom_field_keys ?? []);
    const fields: Record<string, string | null> = {};
    for (const [name, value] of Object.entries(v)) {
      if (name.startsWith("cf:") && before.get(name.slice(3)) !== value) fields[name.slice(3)] = value || (own.has(name.slice(3)) ? null : "");
      if (name.startsWith("nf:name:") && value) fields[value] = v[`nf:value:${name.slice(8)}`] || null;
    }
    if (Object.keys(fields).length && !(await save({ type: "entry.fields", id: e.id, fields }))) return false;
    const place = placeOf(e);
    const tagNow = place.tag?.key ?? "";
    if ((v.tag ?? "") !== tagNow) {
      // "No tag": one of the portal's own tags just comes off (the agent keeps its stage — 28 Oct audit); a pipeline
      // tag (Nurture, Not a Fit, No Response) IS a stage, so the agent goes to the stage the board shows it at, which
      // the option names.
      const untag: DemoAction = tagNow && !isCanonicalStage(tagNow) ? { type: "entry.customStage", ids: [e.id], key: null } : moveTo([e.id], place.stage.key);
      if (!(await save(v.tag ? moveTo([e.id], v.tag) : untag))) return false;
    }
    return true;
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
        {entries.length ? <ManageStages stages={stages} all={live ? allStages : undefined} counts={placeCounts(view.placement)} /> : null}

        {entries.length === 0 ? (
          <div className={k("es")}>
            <section className={k("card ec")}>
              <span className={k("ei")}><Icon name="pipeline" size={22} /></span>
              <h2>No agents in your pipeline yet</h2>
              <p>When an agent replies interested to your outreach, they show up here. You can also add one&nbsp;yourself.</p>
              <div className={k("ea")}>
                <button type="button" className={k("btn pri")} {...lock(live)} onClick={live ? () => setOpen({ kind: "add" }) : undefined}><Icon name="plus" size={15} />Add agent</button>
                <button type="button" className={k("btn")} {...lock(live)} onClick={live ? () => setOpen({ kind: "upload" }) : undefined}><Icon name="upload" size={15} />Upload CSV</button>
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
                <button type="button" className={k("btn sm dis")} disabled><Icon name="copy" size={14} />Copy phones</button>
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
                  <button type="button" className={k("btn sm")} {...lock(live)} onClick={live ? () => copy("names", pickedShown.map((x) => x.lead_name || x.lead_email)) : undefined}><Icon name="copy" size={14} />Copy names</button>
                  <button type="button" className={k("btn sm")} {...lock(live)} onClick={live ? () => copy("emails", pickedShown.map((x) => x.lead_email)) : undefined}><Icon name="copy" size={14} />Copy emails</button>
                  <button type="button" className={k("btn sm")} {...lock(live)} onClick={live ? () => copy("phone numbers", pickedShown.map(phoneOf)) : undefined}><Icon name="copy" size={14} />Copy phones</button>
                  <button type="button" className={k("btn sm")} {...lock(live)} onClick={live ? exportPicked : undefined}><Icon name="download" size={14} />Export CSV</button>
                  <button
                    type="button"
                    className={k("btn sm del")}
                    {...lock(live)}
                    onClick={live ? () => { if (window.confirm(`Delete ${pickedIds.length} ${pickedIds.length === 1 ? "agent" : "agents"} from your pipeline?`)) void bulk({ type: "entry.delete", ids: pickedIds }); } : undefined}
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
              <div className={k("board")} data-board="">
                {/* Every card, as the design's board (no client has more than a few hundred); each column scrolls. */}
                {boardColumns.map((c) => {
                  const target = board.drag && board.drag.over === c.stage.key && board.drag.from !== c.stage.key;
                  const held = cols.held === c.stage.key;
                  return (
                    <section key={c.stage.key} className={k("col")} aria-label={c.stage.label} data-col={c.stage.key}
                      style={target ? { boxShadow: "0 0 0 2px #3e6bd1 inset", background: "#eef3fd" } : held ? { boxShadow: "0 0 0 2px #3e6bd1 inset, 0 10px 24px rgba(30, 41, 59, .12)", background: "#f7f9fe" } : undefined}>
                      <div className={k("colh")} {...(canReorder ? cols.headProps(c.stage.key) : {})}
                        style={canReorder ? { cursor: held ? "grabbing" : "grab" } : undefined}
                        title={canReorder ? "Drag to reorder stages" : undefined}>
                        {canReorder ? (
                          <button type="button" className="cpv-grip" data-grip="" aria-label={`Move ${c.stage.label} — left or right arrow`}
                            title="Drag to reorder stages, or use the left and right arrow keys" onKeyDown={cols.gripKeys(c.stage.key)}>
                            <Icon name="grip" size={14} />
                          </button>
                        ) : null}
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
                          <button
                            key={e.id}
                            type="button"
                            className={k("kc")}
                            {...board.cardProps(e.id, e.lead_name || "Unnamed agent", c.stage.key)}
                            style={board.drag?.id === e.id ? { opacity: 0.4 } : live ? { cursor: "grab" } : undefined}
                            title={live ? "Drag to another column to move — or click to open" : undefined}
                            onClick={() => { if (!board.wasDrag()) openAgent(e); }}
                          >
                            <span className={k("t1")}>{e.lead_name || "Unnamed agent"}{sv ? <span>{abbrevUsd(sv)}</span> : null}</span>
                            <span className={k("co")}>{e.current_brokerage || "—"}</span>
                            <span className={k("t3")}>
                              <span><Icon name="calendar" size={13} />{shortDate(e.introduced_at, now)}</span>
                              <span className={k(src === "Client" ? "src cl" : "src")}>{src}</span>
                            </span>
                            {place.tag || e.needs_replacement || e.stage === "no_show" ? <span className="cpv-cardtag">{place.tag ? <TagChip stage={place.tag} /> : null}<ReplacementMark entry={e} /></span> : null}
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
          onPush={live && !demo.demo && fubConnected ? () => save({ type: "entry.push", id: open.entry.id }) : undefined}
          onClose={() => setOpen(null)}
          onEdit={() => setOpen({ kind: "edit", entry: fresh(open.entry) })}
        />
      ) : null}
      {open?.kind === "edit" ? (
        <EditLeadDialog
          entry={open.entry}
          placement={placeOf(fresh(open.entry))}
          tags={tags}
          onClose={() => setOpen(null)}
          onSave={live ? (v) => saveEdit(fresh(open.entry), v) : undefined}
        />
      ) : null}
      {open?.kind === "add" ? (
        <PipelineAddDialog
          now={now}
          onClose={() => setOpen(null)}
          onSave={live ? (v) => save({ type: "entry.add", lead_name: v.name, lead_email: v.email, lead_phone: v.phone, current_brokerage: v.company, agent_profile_url: v.profile, introduced_at: v.introduced || undefined, needs_replacement: v.replacement === "true" }) : undefined}
        />
      ) : null}
      {board.drag ? <div className="cpv-drag-ghost" style={{ left: board.drag.x + 14, top: board.drag.y + 10 }} aria-hidden="true">{board.drag.name}</div> : null}
      {open?.kind === "upload" ? <PipelineUploadDialog onClose={() => setOpen(null)} onFile={live ? (f) => importCsv(f, csvRowToPipeline, "entry.import", demo) : undefined} /> : null}
      {open?.kind === "conversation" ? (
        <ConversationPanel entry={open.entry} placement={placeOf(open.entry)} clientId={clientId} now={now} onClose={() => setOpen(null)} />
      ) : null}
      {open?.kind === "notes" ? <NotesPanel entry={fresh(open.entry)} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

/** How many agents carry each tag — all of them, whatever the filters. */
/* Agents at each stage or tag, by key (a tagged agent counts at its tag). */
function placeCounts(placement: Map<string, Placement>): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of placement.values()) {
    const key = p.tag ? p.tag.key : p.stage.key;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

const NAME_INPUT = { flex: 1, border: 0, outline: 0, background: "transparent", fontSize: 13, color: "#1f2124", fontWeight: 500 } as const;
const ALWAYS = new Set<string>(ALWAYS_SHOWN);
const agentsText = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "agent" : "agents"}`;

/*
 * Manage stages, as the design draws it open (its Stages screen): the client's
 * stages and tags with their own names and colours. For every client but the
 * Demo Portal, renaming, reordering, hiding, adding and saving are drawn
 * disabled; opening and closing it works. On the Demo Portal (`all`, 22 Oct)
 * they work and save (lib/crm-preview/demo.ts saveStages).
 */
function ManageStages({ stages, all, counts }: { stages: PreviewStage[]; all?: ManagedStage[]; counts: Map<string, number> }) {
  const [open, setOpen] = useState(false);
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
  return (
    <section className={k("card")}>
      <button type="button" className={k("ms msx")} aria-expanded onClick={() => setOpen(false)} aria-label="Collapse manage stages">{head}</button>
      {all ? <StagesEditor all={all} counts={counts} /> : <StagesDrawn stages={stages} counts={counts} />}
    </section>
  );
}

/* Every client but the Demo Portal: the panel as the design draws it, inert. */
function StagesDrawn({ stages, counts }: { stages: PreviewStage[]; counts: Map<string, number> }) {
  const forward = stages.filter((s) => s.role === "stage");
  const tags = stages.filter((s) => s.role === "tag");
  const row = (s: PreviewStage, end: React.ReactNode) => (
    <div key={s.key} className={k("stg")}>
      <button type="button" className={k("ib")} aria-label={`Reorder ${s.label}`} {...RO} style={{ cursor: "grab" }}><Icon name="reorder" size={16} /></button>
      <span className={k("dot")} style={{ background: s.dot }} />
      <input value={s.label} aria-label={`Rename ${s.label}`} style={NAME_INPUT} readOnly {...RO} />
      {end}
    </div>
  );
  return (
    <div className={k("stl")}>
      {forward.map((s) => row(s, (
        ALWAYS.has(s.key) ? (
          <button type="button" className={k("ib")} disabled aria-label={`${s.label} is always shown`} title="Always shown" style={{ color: "#c2c7d0", cursor: "default" }}>
            <Icon name="eyeOutline" size={16} />
          </button>
        ) : (
          <button type="button" className={k("ib")} aria-label={`Hide ${s.label}`} {...RO}>
            <Icon name="eyeOutline" size={16} />
          </button>
        )
      )))}
      <button type="button" className={k("addb")} {...RO}><Icon name="plus" size={14} />Add stage</button>
      <div className={k("svr")}>
        <span>Custom stages are for your team&apos;s workflow. They don&apos;t change your&nbsp;reporting.</span>
        <button type="button" className={k("btn pri")} {...RO}>Save changes</button>
      </div>
      {tags.length ? (
        <>
          <TagsHead />
          {tags.map((t) => row(t, (
            <>
              <span style={{ fontSize: 12, color: "#6b7280", marginRight: 4 }}>{agentsText(counts.get(t.key) ?? 0)}</span>
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
  );
}

function TagsHead() {
  return (
    <div style={{ padding: "18px 0 4px", borderTop: "1px solid #ebedf0", marginTop: 10 }}>
      <div style={{ fontWeight: 600 }}>Tags</div>
      <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>Tag an agent without moving them through your pipeline. Stages only move&nbsp;forward.</div>
    </div>
  );
}

type Part = "stages" | "tags";
type Draft = ManagedStage & { fresh?: boolean };
type Sections = Record<Part, Draft[]>;
const sections = (all: ManagedStage[]): Sections => ({ stages: all.filter((s) => s.role === "stage"), tags: all.filter((s) => s.role === "tag") });
/* What a save sends — the live route's row shape. */
const payload = (list: Draft[]) => list.map((s) => ({ key: s.key, label: s.label.trim(), color: s.color, kind: s.kind, canonical_stage: s.canonical, hidden: s.hidden }));
const same = (a: Draft[], b: Draft[]) => JSON.stringify(payload(a)) === JSON.stringify(payload(b));
const builtInTag = (s: Draft) => s.kind === "canonical" || (GLOBAL_CUSTOM_STAGE_KEYS as readonly string[]).includes(s.key);

/* A new custom stage's key, as the live portal makes them ("custom_apw2pau5"); a tag's starts "custom_tag_". */
function newKey(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return prefix + [...bytes].map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
}

/*
 * The Demo Portal's working panel. Each section saves on its own (the design
 * has a Save changes for stages and one for tags): its edits, with the other
 * section as last saved. Names, order and show/hide are kept as typed until
 * saved; a new stage or tag can be dropped before it is saved. Built-in tags
 * (the pipeline's own, and the two no-show tags every portal has) can be
 * renamed, not deleted; Introduction and Hired are always shown.
 */
function StagesEditor({ all, counts }: { all: ManagedStage[]; counts: Map<string, number> }) {
  const { save } = useDemo();
  const sig = JSON.stringify(all);
  const [base, setBase] = useState<Sections>(() => sections(all));
  const [draft, setDraft] = useState<Sections>(() => sections(all));
  const baseRef = useRef(base);
  // After a save the page reloads its stages: take them as saved (a section just saved now matches them), keeping edits not yet saved in the other section.
  useEffect(() => {
    const next = sections(JSON.parse(sig) as ManagedStage[]);
    // Read before it is replaced below: the draft is compared with the stages as they were (22 Oct audit — not left to when React runs the update).
    const prev = baseRef.current;
    const take = (d: Draft[], part: Part) => (same(d, prev[part]) || same(d, next[part]) ? next[part] : d);
    setDraft((d) => ({ stages: take(d.stages, "stages"), tags: take(d.tags, "tags") }));
    baseRef.current = next;
    setBase(next);
  }, [sig]);
  const [busy, setBusy] = useState<Part | null>(null);
  const [drag, setDrag] = useState<{ part: Part; key: string } | null>(null);
  /* The press on a handle, and the latest draft for the pointer handlers (they run between renders). */
  const pressRef = useRef<{ part: Part; key: string; y: number; moved: boolean } | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const focus = useRef<{ key: string; what: "name" | "handle" } | null>(null);
  useEffect(() => {
    if (!focus.current) return;
    const { key, what } = focus.current;
    focus.current = null;
    document.querySelector<HTMLElement>(`[data-stage="${CSS.escape(key)}"] ${what === "name" ? "input" : "[data-handle]"}`)?.focus();
  });

  const setPart = (part: Part, list: Draft[]) => setDraft((d) => ({ ...d, [part]: list }));
  const edit = (part: Part, key: string, patch: Partial<Draft>) => setPart(part, draft[part].map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const move = (part: Part, from: number, to: number) => {
    const list = [...draftRef.current[part]];
    const [it] = list.splice(from, 1);
    list.splice(to, 0, it);
    draftRef.current = { ...draftRef.current, [part]: list };
    setPart(part, list);
  };
  const add = (part: Part) => {
    const color = STAGE_COLOR_PALETTE[(draft.stages.length + draft.tags.length) % STAGE_COLOR_PALETTE.length];
    const s: Draft = { key: newKey(part === "tags" ? CUSTOM_TAG_PREFIX : "custom_"), label: "", color, dot: color, kind: "custom", canonical: null, hidden: false, role: part === "tags" ? "tag" : "stage", fresh: true };
    focus.current = { key: s.key, what: "name" };
    setPart(part, [...draft[part], s]);
  };
  const ready = (part: Part) => !busy && !same(draft[part], base[part]) && draft[part].every((s) => s.label.trim().length > 0);
  const commit = async (part: Part) => {
    if (!ready(part)) return;
    setBusy(part);
    const trimmed = draft[part].map((s) => ({ ...s, label: s.label.trim() }));
    setPart(part, trimmed);
    const saved = await save({ type: "stages.save", stages: payload(part === "stages" ? [...trimmed, ...baseRef.current.tags] : [...baseRef.current.stages, ...trimmed]) });
    if (saved) {
      /*
       * Taken as saved at once (22 Oct audit): the page's reload lands a moment
       * later, and a Save of the other section in between sent this section as
       * it was BEFORE — undoing the save just made.
       */
      const done = trimmed.map(({ fresh: _fresh, ...rest }) => rest);
      const next = { ...baseRef.current, [part]: done };
      baseRef.current = next;
      setBase(next);
      setPart(part, done);
    }
    setBusy(null);
  };

  const row = (part: Part, s: Draft, i: number, end: React.ReactNode) => {
    const name = s.label.trim() || (part === "tags" ? "new tag" : "new stage");
    const list = draft[part];
    return (
      <div
        key={s.key}
        data-stage={s.key}
        data-part={part}
        className={k("stg")}
        style={{ ...(s.hidden ? { opacity: 0.55 } : {}), ...(drag?.key === s.key ? { background: "#eef3fd", boxShadow: "0 0 0 1px #c7d5f3 inset" } : {}) }}
      >
        <button
          type="button"
          className={k("ib")}
          data-handle=""
          aria-label={`Reorder ${name}`}
          title="Drag to reorder, or use the arrow keys"
          style={{ cursor: drag?.key === s.key ? "grabbing" : "grab", touchAction: "none" }}
          /*
           * Pointer events, not the browser's drag and drop (23 Oct): a real
           * mouse drag on this handle never started one in Chrome, and Safari
           * and Firefox are worse with draggable buttons. Pressing and moving
           * reorders the row live under the pointer — mouse, pen or finger.
           */
          onPointerDown={(e) => {
            if (e.button !== 0 || !e.isPrimary) return;
            e.preventDefault();
            const p = { part, key: s.key, y: e.clientY, moved: false };
            pressRef.current = p;
            /*
             * Followed on the window, not by pointer capture: the row moves in
             * the page as it is dragged, and moving the handle's element
             * releases a capture — the drag stopped after one row (23 Oct test).
             */
            const follow = (ev: PointerEvent) => {
              if (pressRef.current !== p || ev.pointerId !== e.pointerId) return;
              if (!p.moved) {
                if (Math.abs(ev.clientY - p.y) < 4) return;
                p.moved = true;
                setDrag({ part: p.part, key: p.key });
              }
              ev.preventDefault();
              // The row under the pointer, in the same section: the dragged one takes its place.
              const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-stage]");
              if (!over || over.dataset.part !== p.part || over.dataset.stage === p.key) return;
              const cur = draftRef.current[p.part];
              const from = cur.findIndex((x) => x.key === p.key);
              const to = cur.findIndex((x) => x.key === over.dataset.stage);
              if (from >= 0 && to >= 0 && from !== to) move(p.part, from, to);
            };
            const end = (ev: PointerEvent) => {
              if (ev.pointerId !== e.pointerId) return;
              window.removeEventListener("pointermove", follow);
              window.removeEventListener("pointerup", end);
              window.removeEventListener("pointercancel", end);
              if (pressRef.current === p) pressRef.current = null;
              setDrag(null);
            };
            window.addEventListener("pointermove", follow);
            window.addEventListener("pointerup", end);
            window.addEventListener("pointercancel", end);
          }}
          onKeyDown={(e) => {
            const to = e.key === "ArrowUp" ? i - 1 : e.key === "ArrowDown" ? i + 1 : -1;
            if (to < 0 || to >= list.length) return;
            e.preventDefault();
            focus.current = { key: s.key, what: "handle" };
            move(part, i, to);
          }}
        >
          <Icon name="reorder" size={16} />
        </button>
        <span className={k("dot")} style={{ background: s.dot }} />
        <input
          value={s.label}
          maxLength={40}
          placeholder={part === "tags" ? "Tag name" : "Stage name"}
          aria-label={`Rename ${name}`}
          style={NAME_INPUT}
          onChange={(e) => edit(part, s.key, { label: e.target.value })}
          onKeyDown={(e) => { if (e.key === "Enter") void commit(part); }}
        />
        {end}
      </div>
    );
  };
  const drop = (part: Part, s: Draft) => (
    <button type="button" className={k("ib")} aria-label={`Remove ${s.label.trim() || (part === "tags" ? "new tag" : "new stage")}`} title="Not saved yet — remove it" onClick={() => setPart(part, draft[part].filter((x) => x.key !== s.key))}>
      <Icon name="x" size={15} />
    </button>
  );
  const showHide = (part: Part, s: Draft) => (
    <button
      type="button"
      className={k("ib")}
      aria-label={`${s.hidden ? "Show" : "Hide"} ${s.label}`}
      aria-pressed={s.hidden}
      title={s.hidden ? "Hidden — click to show" : "Shown — click to hide"}
      onClick={() => {
        const n = counts.get(s.key) ?? 0;
        if (!s.hidden && n > 0 && !window.confirm(`${agentsText(n)} ${n === 1 ? "is" : "are"} at ${s.label}. While it is hidden, they don't show on the board. Hide it?`)) return;
        edit(part, s.key, { hidden: !s.hidden });
      }}
    >
      <Icon name={s.hidden ? "eyeOff" : "eyeOutline"} size={16} />
    </button>
  );
  const saveRow = (part: Part, text: React.ReactNode) => {
    const named = draft[part].every((s) => s.label.trim().length > 0);
    return (
      <div className={k("svr")}>
        <span>{named ? text : <>Give every {part === "tags" ? "tag" : "stage"} a name to&nbsp;save.</>}</span>
        <button type="button" className={k(ready(part) ? "btn pri" : "btn pri dim")} disabled={!ready(part)} onClick={() => void commit(part)}>
          {busy === part ? "Saving…" : "Save changes"}
        </button>
      </div>
    );
  };

  return (
    <div className={k("stl")}>
      {draft.stages.map((s, i) => row("stages", s, i, (
        ALWAYS.has(s.key) ? (
          <button type="button" className={k("ib")} disabled aria-label={`${s.label} is always shown`} title="Always shown" style={{ color: "#c2c7d0", cursor: "default" }}>
            <Icon name="eyeOutline" size={16} />
          </button>
        ) : s.fresh ? drop("stages", s) : showHide("stages", s)
      )))}
      <button type="button" className={k("addb")} onClick={() => add("stages")}><Icon name="plus" size={14} />Add stage</button>
      {saveRow("stages", <>Custom stages are for your team&apos;s workflow. They don&apos;t change your&nbsp;reporting.</>)}
      <TagsHead />
      {draft.tags.map((t, i) => row("tags", t, i, (
        <>
          <span style={{ fontSize: 12, color: "#6b7280", marginRight: 4 }}>{agentsText(counts.get(t.key) ?? 0)}</span>
          {t.hidden ? showHide("tags", t) : null}
          {t.fresh ? drop("tags", t) : builtInTag(t) ? (
            <button type="button" className={k("ib")} disabled aria-label={`${t.label} is a built-in tag`} title="A built-in tag — rename it; it can't be deleted" style={{ color: "#c2c7d0", cursor: "default" }}>
              <Icon name="x" size={15} />
            </button>
          ) : (
            <button
              type="button"
              className={k("ib")}
              aria-label={`Delete tag ${t.label}`}
              onClick={() => {
                const n = counts.get(t.key) ?? 0;
                if (n > 0 && !window.confirm(`${agentsText(n)} ${n === 1 ? "has" : "have"} the tag ${t.label}. Deleting it takes the tag off them when you save; they stay at their stage. Delete it?`)) return;
                setPart("tags", draft.tags.filter((x) => x.key !== t.key));
              }}
            >
              <Icon name="x" size={15} />
            </button>
          )}
        </>
      )))}
      <button type="button" className={k("addb")} onClick={() => add("tags")}><Icon name="plus" size={14} />Add tag</button>
      {saveRow("tags", <>Tags are shared with everyone on your&nbsp;team.</>)}
    </div>
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
            <ReplacementMark entry={e} />
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
