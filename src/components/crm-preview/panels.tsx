"use client";

/*
 * The redesign's side panels: an agent's details, their email conversation
 * (read-only in the design too) and their notes. They slide in over a dimmed
 * page and close on the scrim, the close button or Escape.
 */

import { useEffect, useRef, useState } from "react";

import type { PipelineEntry } from "@/lib/tools/master-inbox/portals/stages-shared";
import { formatPhone, initials, longDate, messageText, panelFields, shortDate, sourceLabel, stamp, type Placement, type PreviewStage } from "@/lib/crm-preview/model";

import { Icon } from "./icons";
import { k, RO } from "./k";
import { useDemo } from "./demo-save";

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
}

/* Focus moves into the panel itself (not onto its close button, which would draw a ring the design does not have). */
function usePanelFocus() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return ref;
}

/* A message or note as the design sets it: one <p> per paragraph; a line break inside one is kept. */
function Paragraphs({ text }: { text: string }) {
  const parts = text.split(/\n[ \t]*\n+/).map((t) => t.trim()).filter(Boolean);
  return <>{parts.map((t, i) => <p key={i} className="cpv-para">{t}</p>)}</>;
}

/*
 * A button that opens a short menu of stages or tags (the design's stage
 * picker and Add tag) — only where a choice can be saved: the Demo Portal.
 */
export function ChooseMenu({
  className,
  label,
  options,
  onChoose,
  style,
}: {
  className: string;
  label: React.ReactNode;
  options: PreviewStage[];
  onChoose: (key: string) => void;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <span className={k("ddw")} ref={ref}>
      <button type="button" className={className} style={style} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{label}</button>
      {open ? (
        <div className={k("menu")} role="menu" style={{ minWidth: 190, zIndex: 30 }}>
          {options.map((o) => (
            <button key={o.key} type="button" role="menuitem" onClick={() => { setOpen(false); onChoose(o.key); }}>
              <span className={k("dot")} style={{ background: o.dot }} />{o.label}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}

export function TagChip({ stage }: { stage: PreviewStage }) {
  return <span className={k("tg")}><i style={{ background: stage.dot }} />{stage.label}</span>;
}

/** A forward stage as the design's pill; an agent who is only tagged has none. */
export function StageCell({ stage }: { stage: PreviewStage }) {
  return stage.role === "stage" ? <span className={k(`pill p-${stage.pill}`)}>{stage.label}</span> : <span className={k("dash")}>&ndash;</span>;
}

function Source({ entry }: { entry: PipelineEntry }) {
  const src = sourceLabel(entry);
  return <span className={k(src === "Client" ? "src cl" : "src")}>{src}</span>;
}

const LABEL = { fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: "#6b7280", marginBottom: 4 } as const;

/*
 * The agent's details exactly as the design lists them: stage, tags, email,
 * phone, company, source, then the lead's own fields, then the date
 * introduced. (A tagged agent's stage is the furthest one reached before the
 * tag — Eddy, 16 Oct.) Conversation and notes open from the list, as in the
 * design.
 */
export function AgentPanel({
  entry: e,
  placement,
  tags,
  onTag,
  onClose,
  onEdit,
}: {
  entry: PipelineEntry;
  placement: Placement;
  /** The portal's tags, and what choosing one does — only on the Demo Portal. */
  tags: PreviewStage[];
  onTag?: (key: string) => void;
  onClose: () => void;
  onEdit: () => void;
}) {
  useEscape(onClose);
  const focus = usePanelFocus();
  const name = e.lead_name || "Unnamed agent";
  const fields = panelFields(e);
  const row = (dt: string, dd: React.ReactNode) => (
    <div key={dt}>
      <dt>{dt}</dt>
      <dd>{dd}</dd>
    </div>
  );
  return (
    <div className={k("pnl-ov")}>
      <button type="button" className={k("dimx")} aria-label="Close panel" onClick={onClose} />
      <aside ref={focus} tabIndex={-1} className={k("panel")} role="dialog" aria-modal="true" aria-label={name}>
        <div className={k("pnh")}>
          <span className={k("av big")}>{initials(name)}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 600 }}>{name}</div>
            <span style={{ display: "inline-flex", marginTop: 6 }}><Source entry={e} /></span>
          </div>
          <button type="button" className={k("btn sm")} onClick={onEdit}><Icon name="pencil" size={14} />Edit</button>
          <button type="button" className={k("ib")} aria-label="Close" style={{ marginLeft: 2 }} onClick={onClose}><Icon name="x" size={16} /></button>
        </div>
        <dl className={k("pf")}>
          {row("Stage", <StageCell stage={placement.stage} />)}
          {row("Tags", placement.tag ? <TagChip stage={placement.tag} /> : onTag ? (
            <ChooseMenu className={k("btn sm")} style={{ height: 24 }} label={<>Add tag <Icon name="chevDown" size={12} /></>} options={tags} onChoose={onTag} />
          ) : (
            <button type="button" className={k("btn sm")} style={{ height: 24 }} {...RO}>Add tag <Icon name="chevDown" size={12} /></button>
          ))}
          {row("Email", e.lead_email || "–")}
          {row("Phone", formatPhone(e.lead_phone) ?? "–")}
          {row("Company", e.current_brokerage || "–")}
          {row("Source", sourceLabel(e))}
          {fields.map((f) => row(f.label, f.href ? <a href={f.href} target="_blank" rel="noopener noreferrer" style={{ color: "#3e6bd1", overflowWrap: "anywhere" }}>{f.value}</a> : f.value))}
        </dl>
        <div style={{ margin: "0 20px", paddingTop: 18, borderTop: "1px solid #ebedf0" }}>
          <div style={LABEL}>Introduced</div>
          {longDate(e.introduced_at)}
        </div>
      </aside>
    </div>
  );
}

type Message = {
  id: string;
  direction: "inbound" | "outbound";
  sender: string | null;
  sender_name: string | null;
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
  sent_at: string | null;
};

const bare = (s: string | null) => (s ?? "").replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, "").trim().toLowerCase();

export function ConversationPanel({
  entry: e,
  placement,
  clientId,
  now,
  onClose,
}: {
  entry: PipelineEntry;
  placement: Placement;
  clientId: string;
  now: Date;
  onClose: () => void;
}) {
  useEscape(onClose);
  const focus = usePanelFocus();
  const name = e.lead_name || "Unnamed agent";
  const [state, setState] = useState<{ loading: boolean; error: string | null; messages: Message[]; noThread: boolean }>({ loading: true, error: null, messages: [], noThread: false });

  useEffect(() => {
    let cancelled = false;
    // The preview's own read-only feed, by client and entry — the portal's secret link never reaches the browser (21 Oct).
    const q = new URLSearchParams({ client: clientId, entry: e.id });
    fetch(`/api/crm-preview/conversation?${q}`)
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (cancelled) return;
        if (!ok) return setState({ loading: false, error: j?.error ?? "Couldn't load the conversation", messages: [], noThread: false });
        setState({ loading: false, error: null, messages: Array.isArray(j.messages) ? j.messages : [], noThread: j.reason === "no_thread" });
      })
      .catch(() => { if (!cancelled) setState({ loading: false, error: "Couldn't reach the server", messages: [], noThread: false }); });
    return () => { cancelled = true; };
  }, [clientId, e.id]);

  return (
    <>
      <button type="button" className={k("ov")} style={{ zIndex: 10 }} aria-label="Close conversation" onClick={onClose} />
      <aside ref={focus} tabIndex={-1} className={k("pnl")} role="dialog" aria-modal="true" aria-label={`Conversation with ${name}`}>
        <div className={k("ph1")}>
          <span className={k("av")}>{initials(name)}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>{name}</h2>
            <div className={k("meta")}>{[e.lead_email, e.current_brokerage].filter(Boolean).join(" · ")}</div>
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <StageCell stage={placement.stage} />
              {placement.tag ? <TagChip stage={placement.tag} /> : null}
              <Source entry={e} />
            </div>
          </div>
          <button type="button" className={k("ib")} aria-label="Close" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>
        <div className={k("thr")}>
          {state.loading ? (
            <p className="cpv-muted" role="status">Loading the conversation…</p>
          ) : state.error ? (
            <p role="alert">{state.error}</p>
          ) : state.messages.length === 0 ? (
            <p className="cpv-muted">{state.noThread ? "This agent was added without an email conversation." : "No messages on this conversation yet."}</p>
          ) : (
            state.messages.map((m, i) => {
              const inbound = m.direction === "inbound";
              const who = inbound ? m.sender_name || name : m.sender_name || (m.sender ?? "").split("@")[0] || "Your team";
              const showSubject = !!m.subject && (i === 0 || bare(m.subject) !== bare(state.messages[i - 1].subject));
              return (
                <div key={m.id} className={k(inbound ? "msg rp" : "msg")}>
                  <div className={k("mh")}>
                    <span>{inbound ? <><b>{who}</b> replied</> : <><b>{who}</b> to {name}</>}</span>
                    <span>{stamp(m.sent_at)}</span>
                  </div>
                  {showSubject ? <div className={k("sj")}>{m.subject}</div> : null}
                  <Paragraphs text={messageText(m.body_text, m.body_html)} />
                </div>
              );
            })
          )}
          {e.introduced_at && !state.loading ? (
            <div className={k("fwd")}><Icon name="check" size={14} />Introduced to your team on {shortDate(e.introduced_at, now)}</div>
          ) : null}
        </div>
        <div className={k("pf")}>
          <span style={{ fontSize: 12, color: "#6b7280" }}>Agents reply to your team by email. This is a read-only copy of the&nbsp;thread.</span>
        </div>
      </aside>
    </>
  );
}

export function NotesPanel({ entry: e, onClose }: { entry: PipelineEntry; onClose: () => void }) {
  useEscape(onClose);
  const focus = usePanelFocus();
  const name = e.lead_name || "Unnamed agent";
  // On the Demo Portal a note is saved (and the panel shows it once the page has reloaded).
  const { live, save } = useDemo();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const saveNote = async () => {
    if (!note.trim() || busy) return;
    setBusy(true);
    if (await save({ type: "note.add", entry: e.id, body: note.trim() })) setNote("");
    setBusy(false);
  };
  return (
    <>
      <button type="button" className={k("ov")} style={{ zIndex: 10 }} aria-label="Close notes" onClick={onClose} />
      <aside ref={focus} tabIndex={-1} className={k("pnl")} role="dialog" aria-modal="true" aria-label={`Notes for ${name}`}>
        <div className={k("ph1")}>
          <span className={k("av")}>{initials(name)}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>{name}</h2>
            <div className={k("meta")}>Notes{e.current_brokerage ? ` · ${e.current_brokerage}` : ""}</div>
          </div>
          <button type="button" className={k("ib")} aria-label="Close" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>
        <div className={k("thr")}>
          {e.notes_log.length === 0 ? (
            <p className="cpv-muted">No notes on this agent yet.</p>
          ) : (
            e.notes_log.map((n) => (
              <div key={n.id} className={k("msg")}>
                <div className={k("mh")}><span><b>Note</b></span><span>{stamp(n.created_at)}</span></div>
                <Paragraphs text={n.body} />
              </div>
            ))
          )}
        </div>
        <div className={k("pf")} style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          <label className={k("fl")} htmlFor="crx-note">
            Add a note
            {live ? (
              <textarea id="crx-note" className={k("ta")} rows={4} placeholder={`Write a note about ${(e.lead_name || "this agent").split(" ")[0]}...`} value={note} onChange={(ev) => setNote(ev.target.value)} />
            ) : (
              <textarea id="crx-note" className={k("ta")} rows={4} placeholder={`Write a note about ${(e.lead_name || "this agent").split(" ")[0]}...`} readOnly {...RO} />
            )}
          </label>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className={k("btn")} onClick={onClose}>Cancel</button>
            {live ? (
              <button type="button" className={k(note.trim() && !busy ? "btn pri" : "btn pri dim")} disabled={!note.trim() || busy} onClick={() => void saveNote()}>{busy ? "Saving…" : "Save note"}</button>
            ) : (
              <button type="button" className={k("btn pri")} {...RO}>Save note</button>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
