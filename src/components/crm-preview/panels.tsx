"use client";

/*
 * The redesign's side panels: an agent's details, their email conversation
 * (read-only in the design too) and their notes. They slide in over a dimmed
 * page and close on the scrim, the close button or Escape.
 */

import { useEffect, useState } from "react";

import type { PipelineEntry } from "@/lib/tools/master-inbox/portals/stages-shared";
import { initials, longDate, messageText, panelFields, shortDate, sourceLabel, stamp, type PreviewStage } from "@/lib/crm-preview/model";

import { Icon } from "./icons";
import { k, READ_ONLY } from "./k";

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
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

export function AgentPanel({
  entry: e,
  stage,
  onClose,
  onConversation,
  onNotes,
}: {
  entry: PipelineEntry;
  stage: PreviewStage;
  onClose: () => void;
  onConversation: () => void;
  onNotes: () => void;
}) {
  useEscape(onClose);
  const name = e.lead_name || "Unnamed agent";
  const fields = panelFields(e);
  const profile = e.agent_profile_url && /^https?:\/\//i.test(e.agent_profile_url) && !fields.some((f) => f.href === e.agent_profile_url) ? e.agent_profile_url : null;
  const row = (dt: string, dd: React.ReactNode) => (
    <div key={dt}>
      <dt>{dt}</dt>
      <dd>{dd}</dd>
    </div>
  );
  return (
    <div className={k("pnl-ov")}>
      <button type="button" className={k("dimx")} aria-label="Close panel" onClick={onClose} />
      <aside className={k("panel")} role="dialog" aria-modal="true" aria-label={name}>
        <div className={k("pnh")}>
          <span className={k("av big")}>{initials(name)}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 600 }}>{name}</div>
            <span style={{ display: "inline-flex", marginTop: 6 }}><Source entry={e} /></span>
          </div>
          <button type="button" className={k("btn sm")} disabled title={READ_ONLY}><Icon name="pencil" size={14} />Edit</button>
          <button type="button" className={k("ib")} aria-label="Close" style={{ marginLeft: 2 }} onClick={onClose} autoFocus><Icon name="x" size={16} /></button>
        </div>
        <dl className={k("pf")}>
          {row("Stage", <StageCell stage={stage} />)}
          {row("Tags", stage.role === "tag" ? <TagChip stage={stage} /> : (
            <button type="button" className={k("btn sm")} style={{ height: 24 }} disabled title={READ_ONLY}>Add tag <Icon name="chevDown" size={12} /></button>
          ))}
          {row("Email", e.lead_email || "–")}
          {row("Phone", e.lead_phone || "–")}
          {row("Company", e.current_brokerage || "–")}
          {row("Source", sourceLabel(e))}
          {row("Owner", e.assigned_team_member?.name ?? "Unassigned")}
          {e.lead_location ? row("Location", e.lead_location) : null}
          {e.campaign_name ? row("Campaign", e.campaign_name) : null}
          {profile ? row("Profile", <a href={profile} target="_blank" rel="noopener noreferrer" style={{ color: "#3e6bd1", overflowWrap: "anywhere" }}>{profile}</a>) : null}
          {fields.map((f) => row(f.label, f.href ? <a href={f.href} target="_blank" rel="noopener noreferrer" style={{ color: "#3e6bd1", overflowWrap: "anywhere" }}>{f.value}</a> : f.value))}
        </dl>
        <div style={{ margin: "0 20px", paddingTop: 18, borderTop: "1px solid #ebedf0" }}>
          <div style={LABEL}>Introduced</div>
          {longDate(e.introduced_at)}
        </div>
        <div style={{ display: "flex", gap: 8, margin: "18px 20px 22px" }}>
          {e.thread_id ? <button type="button" className={k("btn sm")} onClick={onConversation}><Icon name="chat" size={14} />Conversation</button> : null}
          <button type="button" className={k("btn sm")} onClick={onNotes}><Icon name="note" size={14} />Notes{e.notes_log.length ? ` (${e.notes_log.length})` : ""}</button>
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
  stage,
  token,
  now,
  onClose,
}: {
  entry: PipelineEntry;
  stage: PreviewStage;
  token: string;
  now: Date;
  onClose: () => void;
}) {
  useEscape(onClose);
  const name = e.lead_name || "Unnamed agent";
  const [state, setState] = useState<{ loading: boolean; error: string | null; messages: Message[]; noThread: boolean }>({ loading: true, error: null, messages: [], noThread: false });

  useEffect(() => {
    let cancelled = false;
    // The live portal's own read-only feed (a GET; it changes nothing).
    fetch(`/api/tools/master-inbox/portal/${encodeURIComponent(token)}/conversation/${encodeURIComponent(e.id)}`)
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (cancelled) return;
        if (!ok) return setState({ loading: false, error: j?.error ?? "Couldn't load the conversation", messages: [], noThread: false });
        setState({ loading: false, error: null, messages: Array.isArray(j.messages) ? j.messages : [], noThread: j.reason === "no_thread" });
      })
      .catch(() => { if (!cancelled) setState({ loading: false, error: "Couldn't reach the server", messages: [], noThread: false }); });
    return () => { cancelled = true; };
  }, [token, e.id]);

  return (
    <>
      <button type="button" className={k("ov")} style={{ zIndex: 10 }} aria-label="Close conversation" onClick={onClose} />
      <aside className={k("pnl")} role="dialog" aria-modal="true" aria-label={`Conversation with ${name}`}>
        <div className={k("ph1")}>
          <span className={k("av")}>{initials(name)}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>{name}</h2>
            <div className={k("meta")}>{[e.lead_email, e.current_brokerage].filter(Boolean).join(" · ")}</div>
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              {stage.role === "stage" ? <StageCell stage={stage} /> : <TagChip stage={stage} />}
              <Source entry={e} />
            </div>
          </div>
          <button type="button" className={k("ib")} aria-label="Close" onClick={onClose} autoFocus><Icon name="x" size={16} /></button>
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
                  <p className="cpv-body">{messageText(m.body_text, m.body_html)}</p>
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
  const name = e.lead_name || "Unnamed agent";
  return (
    <>
      <button type="button" className={k("ov")} style={{ zIndex: 10 }} aria-label="Close notes" onClick={onClose} />
      <aside className={k("pnl")} role="dialog" aria-modal="true" aria-label={`Notes for ${name}`}>
        <div className={k("ph1")}>
          <span className={k("av")}>{initials(name)}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>{name}</h2>
            <div className={k("meta")}>Notes{e.current_brokerage ? ` · ${e.current_brokerage}` : ""}</div>
          </div>
          <button type="button" className={k("ib")} aria-label="Close" onClick={onClose} autoFocus><Icon name="x" size={16} /></button>
        </div>
        <div className={k("thr")}>
          {e.notes_log.length === 0 ? (
            <p className="cpv-muted">No notes on this agent yet.</p>
          ) : (
            e.notes_log.map((n) => (
              <div key={n.id} className={k("msg")}>
                <div className={k("mh")}><span><b>Note</b></span><span>{stamp(n.created_at)}</span></div>
                <p className="cpv-body">{n.body}</p>
              </div>
            ))
          )}
        </div>
        <div className={k("pf")} style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          <label className={k("fl")} htmlFor="crx-note">
            Add a note
            <textarea id="crx-note" className={k("ta")} rows={4} placeholder="Notes can't be added in this preview." disabled />
          </label>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className={k("btn")} onClick={onClose}>Close</button>
            <button type="button" className={k("btn pri dim")} disabled title={READ_ONLY}>Save note</button>
          </div>
        </div>
      </aside>
    </>
  );
}
