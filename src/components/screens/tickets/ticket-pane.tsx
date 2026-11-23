"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { ModalDialog } from "@/components/ui/modal-dialog";
import type { TicketStatus } from "@/lib/tools/tickets/ticket-rules";
import type { ReplyContextView } from "@/lib/tools/tickets/reply-service";
import type { Person, TicketDetail, TicketEventView, TicketMessageView } from "@/lib/tools/tickets/types";
import { snoozePresets } from "@/lib/tools/tickets/views";

import { EmailFrame } from "./email-frame";
import { ago, api, Avatar, dayTime, fileSize, firstName, fullTime, Icon, inGSequence, Picker, typingOrDialog, useDismiss, usePeople, type PickOption } from "./ui";

/*
 * TICKETS — one conversation: the client's emails (each sandboxed, outside images held back), the team's replies
 * (a reply written in Gmail is a one-line marker, its text never stored; a reply sent from Tickets shows its text and
 * who sent it), notes and every change, in time order; the ticket's status, owner and snooze above; the reply box and
 * the note box below. Shortcuts: E done · Q mine · A assign · S snooze · N note · R reply · I not a ticket · O Gmail.
 */

type Item =
  | { kind: "mail"; at: string; m: TicketMessageView }
  | { kind: "reply"; at: string; m: TicketMessageView }
  | { kind: "event"; at: string; e: TicketEventView };

const STATUS_LABEL: Record<TicketStatus, string> = { open: "Open", waiting: "Waiting", done: "Done", ignored: "Not a ticket" };

export function TicketPane({ number, team, clients, me, onChanged, onBack, onRemoved }: {
  number: number;
  team: Person[];
  clients: Array<{ id: string; name: string; status: string | null }>;
  me: string;
  onChanged: () => void;
  onBack: () => void;
  onRemoved: () => void;
}) {
  const [d, setD] = useState<TicketDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<null | "assign" | "snooze" | "more" | "client">(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Replying from Tickets (24 Nov): who it can go from, to whom; null until read.
  const [rc, setRc] = useState<ReplyContextView | null>(null);
  const [replyOpen, setReplyOpen] = useState(false);
  const people = usePeople(team);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const lastActivity = useRef<string | null>(null);
  const closePop = useCallback(() => setOpen(null), []);
  const assignRef = useRef<HTMLDivElement | null>(null);
  const snoozeRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLDivElement | null>(null);
  useDismiss(open === "assign", closePop, assignRef);
  useDismiss(open === "snooze", closePop, snoozeRef);
  useDismiss(open === "more" || open === "client", closePop, moreRef);

  const changedRef = useRef(onChanged);
  useEffect(() => { changedRef.current = onChanged; }, [onChanged]);
  const load = useCallback(async (quiet = false) => {
    try {
      const data = await api<TicketDetail>(`/api/tools/tickets/${number}`);
      setD(data);
      setErr(null);
      setNow(Date.now());
      if (data.ticket.lastActivityAt !== lastActivity.current) {
        lastActivity.current = data.ticket.lastActivityAt;
        void api(`/api/tools/tickets/${data.ticket.id}/ping`, { method: "POST", json: { seen: true, viewing: true } }).then(() => quiet || changedRef.current(), () => {});
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't load this ticket");
    }
  }, [number]);

  useEffect(() => { setD(null); setErr(null); lastActivity.current = null; void load(); }, [number, load]);

  const loadReply = useCallback(async () => {
    try { setRc(await api<ReplyContextView>(`/api/tools/tickets/${number}/reply`)); } catch { setRc(null); }
  }, [number]);
  useEffect(() => { setRc(null); setReplyOpen(hasDraft(number)); void loadReply(); }, [number, loadReply]);

  // Every 15 seconds while open: "I'm looking at this", and pick up anything new.
  const id = d?.ticket.id;
  useEffect(() => {
    if (!id) return;
    const beat = () => {
      if (document.visibilityState !== "visible") return;
      void api<{ viewers: string[] }>(`/api/tools/tickets/${id}/ping`, { method: "POST", json: { viewing: true } })
        .then((r) => setD((cur) => (cur && cur.ticket.id === id ? { ...cur, viewers: r.viewers } : cur)), () => {});
      void load(true);
    };
    const t = setInterval(beat, 15_000);
    // Back from Gmail (Reply in Gmail opens a tab): refresh at once rather than at the next beat.
    const onVisible = () => { if (document.visibilityState === "visible") beat(); };
    document.addEventListener("visibilitychange", onVisible);
    const leave = () => navigator.sendBeacon?.(`/api/tools/tickets/${id}/ping`, new Blob([JSON.stringify({ viewing: false })], { type: "application/json" }));
    window.addEventListener("pagehide", leave);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("pagehide", leave); leave(); };
  }, [id, load]);

  const change = useCallback(async (body: Record<string, unknown>, okMsg?: string) => {
    if (!d) return;
    setBusy(true);
    try {
      await api(`/api/tools/tickets/${d.ticket.id}`, { method: "PATCH", json: body });
      await load(true);
      changedRef.current();
      if (okMsg) toast.success(okMsg);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't save");
    } finally {
      setBusy(false);
    }
  }, [d, load]);

  const t = d?.ticket;
  const lastClientMail = useMemo(() => [...(d?.messages ?? [])].reverse().find((m) => m.direction === "in") ?? null, [d]);
  const myCopy = useMemo(() => [...(d?.messages ?? [])].reverse().find((m) => m.myGmailId) ?? null, [d]);

  const openGmail = useCallback(() => {
    if (!d || !myCopy) return;
    const url = `https://mail.google.com/mail/?authuser=${encodeURIComponent(me)}#search/${encodeURIComponent(`rfc822msgid:${myCopy.rfcId}`)}`;
    window.open(url, "_blank", "noopener,noreferrer");
    void api(`/api/tools/tickets/${d.ticket.id}/ping`, { method: "POST", json: { gmail: true } }).then(() => load(true), () => {});
  }, [d, myCopy, me, load]);

  const setStatus = useCallback((s: TicketStatus) => {
    if (!t) return;
    void change({ status: s }, s === "done" ? `#${t.number} marked done` : s === "ignored" ? `#${t.number} marked Not a ticket` : undefined);
  }, [t, change]);

  // Shortcuts that act on the open ticket.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!t || e.metaKey || e.ctrlKey || e.altKey || typingOrDialog(e) || inGSequence()) return;
      const k = e.key.toLowerCase();
      if (k === "e") { e.preventDefault(); setStatus(t.status === "done" ? "open" : "done"); }
      else if (k === "q") { e.preventDefault(); if (t.assignee !== me) void change({ assignee: me }, `#${t.number} is yours`); }
      else if (k === "a") { e.preventDefault(); setOpen("assign"); }
      else if (k === "s") { e.preventDefault(); setOpen("snooze"); }
      // N: a note instead of the reply (the reply's draft is kept for later).
      else if (k === "n") { e.preventDefault(); setReplyOpen(false); requestAnimationFrame(() => noteRef.current?.focus()); }
      else if (k === "i") { e.preventDefault(); setStatus(t.status === "ignored" ? "open" : "ignored"); }
      else if (k === "o") { e.preventDefault(); openGmail(); }
      else if (k === "r" && rc && !rc.blocked && rc.senders.length) { e.preventDefault(); setReplyOpen(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [t, me, change, setStatus, openGmail, rc]);

  if (err && !d) {
    return (
      <div className="tk-read">
        <div className="tk-empty">
          <div className="tk-empty-art"><Icon name="ban" /></div>
          <h3>This ticket can&apos;t be shown</h3>
          <p>{err}</p>
          <button type="button" className="tk-btn" onClick={onBack}>Back to the list</button>
        </div>
      </div>
    );
  }
  if (!d || !t) {
    return (
      <div className="tk-read" aria-busy="true">
        <div className="tk-rhead"><div className="tk-skel" style={{ border: 0, padding: 0 }}><i style={{ width: "30%" }} /><i style={{ width: "70%", height: 16 }} /><i style={{ width: "45%" }} /></div></div>
        <div className="tk-timeline"><div className="tk-mail" style={{ height: 180 }} /></div>
      </div>
    );
  }

  const snoozed = t.snoozedUntil && Date.parse(t.snoozedUntil) > now;
  const statusValue: TicketStatus = t.status;
  const assigneeOptions: PickOption[] = [
    ...(t.assignee !== me ? [{ id: me, label: "Assign to me", hint: "Q", icon: <Avatar email={me} name={people.name(me)} /> }] : []),
    ...team.filter((p) => p.email !== me).map((p) => ({ id: p.email, label: p.name, hint: p.email, icon: <Avatar email={p.email} name={p.name} />, selected: p.email === t.assignee })),
    ...(t.assignee === me ? [{ id: me, label: `${people.name(me)} (you)`, icon: <Avatar email={me} name={people.name(me)} />, selected: true }] : []),
    ...(t.assignee ? [{ id: "__none", label: "Unassign", icon: <Icon name="userx" /> }] : []),
  ];
  const presets = snoozePresets(now);
  const replyBy = myCopy ? [] : (lastClientMail?.receivedBy ?? []).map((e) => people.first(e) || e);
  const firstAt = d.messages.reduce((min, m) => (m.sentAt && m.sentAt < min ? m.sentAt : min), t.createdAt);

  return (
    <div className="tk-read">
      <header className="tk-rhead">
        <div className="tk-crumbs">
          <button type="button" className="tk-btn ghost icon tk-back" onClick={onBack} aria-label="Back to the list"><Icon name="back" /></button>
          <span className="tk-num">#{t.number}</span>
          {t.client ? (
            <a className="tk-client big" href={`/roster?client=${encodeURIComponent(t.client.id)}`} title={`Open ${t.client.name}'s record`}>
              <i className={t.client.status === "churned" ? "churned" : t.client.status === "paused" ? "paused" : ""} /><span className="tk-client-n">{t.client.name}</span>
            </a>
          ) : <span className="tk-client big">No client</span>}
          <span className="tk-crumb" title={t.contact.email ?? undefined}>{t.contact.name ?? t.contact.email}</span>
          {/* When the client first wrote, not when Tickets first saw it (an inbox connected later imports older mail). */}
          <span className="tk-crumb tk-crumb-dot" title={fullTime(firstAt)}>Started {fullTime(firstAt)}</span>
        </div>
        <h2 className="tk-title">{t.subject}</h2>
        <div className="tk-actions">
          <div className="tk-seg" role="group" aria-label="Status">
            {(["open", "waiting", "done"] as const).map((s) => (
              <button key={s} type="button" className={`s-${s}`} aria-pressed={statusValue === s && !(s === "waiting" && snoozed)} disabled={busy} onClick={() => setStatus(s)} title={s === "done" ? "Done (E)" : undefined}>
                <i />{STATUS_LABEL[s]}
              </button>
            ))}
          </div>
          {snoozed ? <span className="tk-pill snoozed"><Icon name="moon" />Snoozed until {fullTime(t.snoozedUntil!)}</span> : null}
          {t.status === "ignored" ? <span className="tk-pill ignored">Not a ticket</span> : null}

          <div className="tk-popwrap" ref={assignRef}>
            <button type="button" className="tk-btn" onClick={() => setOpen(open === "assign" ? null : "assign")} aria-haspopup="dialog" aria-expanded={open === "assign"} title="Assign (A)">
              {t.assignee ? <><Avatar email={t.assignee} name={people.name(t.assignee)} />{t.assignee === me ? "You" : people.first(t.assignee)}</> : <><Icon name="user" />Assign</>}
            </button>
            <Picker open={open === "assign"} onClose={() => setOpen(null)} placeholder="Assign to…" options={assigneeOptions}
              onPick={(pick) => void change({ assignee: pick === "__none" ? null : pick }, pick === "__none" ? "Unassigned" : pick === me ? `#${t.number} is yours` : `Assigned to ${people.first(pick)}`)} />
          </div>

          <div className="tk-popwrap" ref={snoozeRef}>
            <button type="button" className="tk-btn" onClick={() => setOpen(open === "snooze" ? null : "snooze")} aria-haspopup="dialog" aria-expanded={open === "snooze"} title="Snooze (S)">
              <Icon name="moon" /><span className="tk-hide-sm">Snooze</span>
            </button>
            <Picker open={open === "snooze"} onClose={() => setOpen(null)} search={false}
              options={[...presets.map((p) => ({ id: p.until, label: p.label, hint: dayTime(p.until, now) })), ...(snoozed ? [{ id: "__cancel", label: "Cancel the snooze", icon: <Icon name="x" /> }] : [])]}
              onPick={(until) => void change({ snooze: until === "__cancel" ? null : until }, until === "__cancel" ? "Snooze cancelled" : `Snoozed until ${fullTime(until)}`)}
              footer={<SnoozeCustom onPick={(until) => { setOpen(null); void change({ snooze: until }, `Snoozed until ${fullTime(until)}`); }} />} />
          </div>

          <span className="tk-sp" />
          {rc && !rc.blocked && rc.senders.length ? (
            <>
              <button type="button" className="tk-btn pri" data-reply-open onClick={() => setReplyOpen(true)} title={`Reply to ${rc.to?.name ?? rc.to?.email ?? "the client"} from Tickets (R)`}>
                <Icon name="reply" />Reply<kbd>R</kbd>
              </button>
              {myCopy ? <button type="button" className="tk-btn icon" onClick={openGmail} title="Open in your Gmail (O)" aria-label="Open in your Gmail"><Icon name="ext" /></button> : null}
            </>
          ) : myCopy ? (
            <button type="button" className="tk-btn pri" onClick={openGmail} title="Opens this email in your Gmail to reply (O)">
              <Icon name="reply" />Reply in Gmail<kbd>O</kbd>
            </button>
          ) : replyBy.length ? (
            // Not a greyed-out button: a plain line saying who answers this one, and where.
            <span className="tk-replyby" data-reply-by title={`Not in your inbox. Received by ${replyBy.join(", ")}`}>
              <Icon name="reply" />{replyBy.length === 1 ? `${replyBy[0]} replies in Gmail` : `${listNames(replyBy, "or")} replies in Gmail`}
            </span>
          ) : null}

          <div className="tk-popwrap" ref={moreRef}>
            <button type="button" className="tk-btn icon" onClick={() => setOpen(open === "more" ? null : "more")} aria-label="More actions" aria-haspopup="menu" aria-expanded={open === "more"}>
              <Icon name="more" />
            </button>
            <Picker open={open === "more"} onClose={() => setOpen(null)} search={false} align="right"
              options={[
                t.status === "ignored" ? { id: "reopen", label: "Reopen", icon: <Icon name="refresh" /> } : { id: "ignore", label: "Not a ticket", hint: "I", icon: <Icon name="ban" /> },
                { id: "client", label: "Change client", icon: <Icon name="building" /> },
                { id: "copy", label: "Copy link", icon: <Icon name="link" /> },
                ...(d.canRemove ? [{ id: "remove", label: "Remove from Tickets…", icon: <Icon name="trash" /> }] : []),
              ]}
              onPick={(a) => {
                if (a === "ignore") setStatus("ignored");
                else if (a === "reopen") setStatus("open");
                else if (a === "client") setTimeout(() => setOpen("client"), 0);
                else if (a === "copy") void navigator.clipboard?.writeText(`${window.location.origin}/tickets?t=${t.number}`).then(() => toast.success("Link copied"));
                else if (a === "remove") setConfirmRemove(true);
              }} />
            <Picker open={open === "client"} onClose={() => setOpen(null)} align="right" placeholder="Which client?"
              options={clients.map((c) => ({ id: c.id, label: c.name, hint: c.status ?? undefined, selected: c.id === t.client?.id }))}
              onPick={(cid) => void change({ client: cid }, "Client changed")} />
          </div>
        </div>
        {d.viewers.length ? (
          <div className="tk-banner presence" role="status"><Icon name="eye" />{listNames(d.viewers.map((v) => people.first(v)))} {d.viewers.length === 1 ? "is" : "are"} looking at this ticket too</div>
        ) : null}
      </header>

      <Timeline d={d} now={now} people={people} />

      {replyOpen && rc && !rc.blocked && rc.senders.length ? (
        <ReplyBox key={t.id} ticketNumber={t.number} ctx={rc} me={me} people={people}
          onClose={() => setReplyOpen(false)}
          onStale={() => { void load(true); void loadReply(); }}
          onSent={() => { setReplyOpen(false); void load(true); void loadReply(); changedRef.current(); }} />
      ) : null}

      {/* One box at a time: while replying, the note box steps aside so the conversation keeps its room. */}
      {replyOpen && rc && !rc.blocked && rc.senders.length ? null : <NoteBox ticketId={t.id} team={team} me={me} textareaRef={noteRef} onSaved={() => { void load(true); changedRef.current(); }} />}

      <ModalDialog open={confirmRemove} onClose={() => setConfirmRemove(false)} width={460} label="Remove from Tickets">
        <div className="tk-dialog">
          <h3>Remove #{t.number} from Tickets?</h3>
          <p>The emails stored for this conversation are deleted from the OS and it won&apos;t be imported again, even when the client replies. Nothing changes in anyone&apos;s Gmail. Use this for a conversation that isn&apos;t business, not to finish a ticket (that&apos;s Done).</p>
          <div className="tk-dialog-f">
            <button type="button" className="tk-btn" onClick={() => setConfirmRemove(false)}>Keep it</button>
            <button type="button" className="tk-btn danger solid" disabled={busy} onClick={async () => {
              setBusy(true);
              try {
                await api(`/api/tools/tickets/${t.id}`, { method: "DELETE" });
                setConfirmRemove(false);
                toast.success(`#${t.number} removed from Tickets`);
                onRemoved();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Couldn't remove it");
              } finally {
                setBusy(false);
              }
            }}>Remove</button>
          </div>
        </div>
      </ModalDialog>
    </div>
  );
}

function SnoozeCustom({ onPick }: { onPick: (iso: string) => void }) {
  const [v, setV] = useState("");
  return (
    <>
      <label htmlFor="tk-snooze-at">Pick a time (your clock)</label>
      <div style={{ display: "flex", gap: 6 }}>
        <input id="tk-snooze-at" type="datetime-local" value={v} onChange={(e) => setV(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
        <button type="button" className="tk-btn" disabled={!v || !(Date.parse(v) > Date.now())} onClick={() => onPick(new Date(v).toISOString())}>Snooze</button>
      </div>
    </>
  );
}

/** Fetched first: a file Gmail can't give right now shows a message, rather than replacing the OS with an error page. */
async function download(url: string, filename: string) {
  const id = toast.loading(`Getting ${filename}…`);
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(j.error ?? "Couldn't get that file. Open it in Gmail.", { id });
      return;
    }
    const href = URL.createObjectURL(await res.blob());
    const link = document.createElement("a");
    link.href = href;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 30_000);
    toast.dismiss(id);
  } catch {
    toast.error("Couldn't get that file. Open it in Gmail.", { id });
  }
}

function listNames(names: string[], joiner: "and" | "or" = "and"): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} ${joiner} ${names[names.length - 1]}`;
}

/* ------------------------------------------------------------------ timeline --- */

function Timeline({ d, now, people }: { d: TicketDetail; now: number; people: ReturnType<typeof usePeople> }) {
  /*
   * The conversation and nothing else (21 Nov, the user: "cannot even read emails properly ... very confusing ... I
   * need a very simple to understand ui"): the client's emails, our replies as one quiet line each, and the team's
   * notes. Status changes, assigning, snoozing and the like are the ticket's activity, listed under it on request.
   */
  const conversation = useMemo<Item[]>(() => {
    const out: Item[] = [
      ...d.messages.map((m) => (m.direction === "in" ? { kind: "mail" as const, at: m.sentAt, m } : { kind: "reply" as const, at: m.sentAt, m })),
      ...d.events.filter((e) => e.kind === "note").map((e) => ({ kind: "event" as const, at: e.at, e })),
    ];
    return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }, [d]);
  const activity = useMemo(() => d.events.filter((e) => e.kind !== "note").sort((a, b) => Date.parse(b.at) - Date.parse(a.at)), [d]);
  const mails = conversation.filter((i) => i.kind === "mail");
  const lastMailId = mails.length ? (mails[mails.length - 1] as Extract<Item, { kind: "mail" }>).m.id : null;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(lastMailId ? [lastMailId] : []));
  const [showAll, setShowAll] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { setExpanded(new Set(lastMailId ? [lastMailId] : [])); setShowAll(false); setShowActivity(false); }, [d.ticket.id, lastMailId]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [d.ticket.id]);

  // A long conversation: its first message and the latest five, the middle behind one button (as Gmail does).
  const hiddenCount = !showAll && conversation.length > 8 ? conversation.length - 6 : 0;
  const visible = hiddenCount ? [conversation[0], ...conversation.slice(conversation.length - 5)] : conversation;

  return (
    <div className="tk-timeline" aria-label="Conversation">
      {visible.map((it, i) => (
        <TimelineItemWrap key={it.kind === "event" ? it.e.id : it.m.id}>
          {i === 1 && hiddenCount ? (
            <button type="button" className="tk-earlier" onClick={() => setShowAll(true)}>
              Show {hiddenCount} earlier {hiddenCount === 1 ? "message" : "messages"}
            </button>
          ) : null}
          {it.kind === "mail" ? (
            <MailCard m={it.m} open={expanded.has(it.m.id)} onToggle={() => setExpanded((s) => { const n = new Set(s); if (n.has(it.m.id)) n.delete(it.m.id); else n.add(it.m.id); return n; })} people={people} />
          ) : it.kind === "reply" && it.m.sentBy ? (
            <SentReply m={it.m} people={people} />
          ) : it.kind === "reply" ? (
            <div className="tk-reply" title="Replies are sent and kept in Gmail. Tickets only notes that one was sent.">
              <Icon name="reply" />
              {/* The first message from our side started the conversation: it "wrote", it didn't reply. */}
              <span><b>{firstName(it.m.from.name, it.m.from.email)}</b> {conversation[0] === it ? "wrote" : "replied"} from Gmail</span>
              <time dateTime={it.m.sentAt} title={fullTime(it.m.sentAt)}>{fullTime(it.m.sentAt)}</time>
            </div>
          ) : (
            <EventLine e={it.e} now={now} people={people} />
          )}
        </TimelineItemWrap>
      ))}
      {activity.length ? (
        <div className="tk-activity">
          <button type="button" className="tk-activity-t" aria-expanded={showActivity} onClick={() => setShowActivity((v) => !v)}>
            {showActivity ? "Hide activity" : "Show activity"} <span>{activity.length}</span>
          </button>
          {showActivity ? <div className="tk-activity-list">{activity.map((e) => <EventLine key={e.id} e={e} now={now} people={people} />)}</div> : null}
        </div>
      ) : null}
      <div ref={endRef} />
    </div>
  );
}

function TimelineItemWrap({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function MailCard({ m, open, onToggle, people }: { m: TicketMessageView; open: boolean; onToggle: () => void; people: ReturnType<typeof usePeople> }) {
  const [showImages, setShowImages] = useState(false);
  const [blocked, setBlocked] = useState(0);
  const onBlocked = useCallback((n: number) => setBlocked(n), []);
  const toLine = [...m.to, ...m.cc].map((a) => (people.has(a.email) ? people.first(a.email) : a.name ?? a.email));
  const snippet = (m.text ?? "").replace(/\s+/g, " ").slice(0, 160);
  return (
    <article className="tk-mail" data-open={open}>
      {open ? (
        <div className="tk-mail-h">
          <Avatar client name={m.from.name} email={m.from.email} size="lg" />
          <div className="tk-mail-who">
            <b>{m.from.name ?? m.from.email}{m.from.name ? <span>{m.from.email}</span> : null}</b>
            <span className="tk-mail-to" title={[...m.to, ...m.cc].map((a) => a.email).join(", ")}>to {toLine.slice(0, 4).join(", ")}{toLine.length > 4 ? ` +${toLine.length - 4}` : ""}</span>
          </div>
          <div className="tk-mail-when">
            <time dateTime={m.sentAt} title={fullTime(m.sentAt)}>{fullTime(m.sentAt)}</time>
            <button type="button" className="tk-mail-close" onClick={onToggle} aria-label="Close this email">Close</button>
          </div>
        </div>
      ) : (
        // Closed: one row that reads at a glance (who, the first words, when) and opens with a click.
        <button type="button" className="tk-mail-row" onClick={onToggle} aria-label={`Open the email from ${m.from.name ?? m.from.email}, ${fullTime(m.sentAt)}`}>
          <Avatar client name={m.from.name} email={m.from.email} />
          <b>{m.from.name ?? m.from.email}</b>
          <span className="tk-mail-snip">{snippet || "(no text)"}</span>
          <time dateTime={m.sentAt} title={fullTime(m.sentAt)}>{fullTime(m.sentAt)}</time>
        </button>
      )}
      {open ? (
        <>
          <div className="tk-mail-b">
            <EmailFrame html={m.html} text={m.text} messageId={m.id} attachments={m.attachments} showImages={showImages} onBlocked={onBlocked} />
          </div>
          {m.trimmed ? (
            <div className="tk-trimmed">Earlier messages quoted in this email aren&apos;t kept in Tickets, only the client&apos;s own words.{m.myGmailId ? " The full email is in your Gmail." : ""}</div>
          ) : null}
          {blocked > 0 && !showImages ? (
            <div className="tk-imgbar">
              <Icon name="shield" />
              <span>Pictures from outside this email are hidden, so the sender can&apos;t tell it was opened.</span>
              <button type="button" onClick={() => setShowImages(true)}>Show pictures</button>
            </div>
          ) : null}
          {m.attachments.filter((a) => !a.inline).length ? (
            <div className="tk-files" style={{ paddingTop: 10 }}>
              {m.attachments.filter((a) => !a.inline).map((a) => (
                <a key={a.partId} className="tk-file" href={`/api/tools/tickets/attachment?m=${encodeURIComponent(m.id)}&p=${encodeURIComponent(a.partId)}`} title={`Download ${a.filename}`}
                  onClick={(e) => { e.preventDefault(); void download(e.currentTarget.href, a.filename); }}>
                  <i>{(a.filename.split(".").pop() ?? "file").slice(0, 4)}</i>
                  <span>{a.filename}</span>
                  <small>{fileSize(a.size)}</small>
                </a>
              ))}
            </div>
          ) : <div style={{ height: 6 }} />}
        </>
      ) : null}
    </article>
  );
}

const EVENT_ICON: Record<TicketEventView["kind"], string> = {
  note: "note", status: "checkc", assign: "user", snooze: "moon", created: "mail", reopened: "refresh", client: "building", gmail: "ext",
};

function EventLine({ e, now, people }: { e: TicketEventView; now: number; people: ReturnType<typeof usePeople> }) {
  const who = e.actor ? <b>{people.first(e.actor)}</b> : null;
  if (e.kind === "note") {
    return (
      <div className="tk-note">
        <div className="tk-note-h">
          <Avatar email={e.actor} name={people.name(e.actor)} />
          <b>{people.name(e.actor)}</b><span>added a note</span>
          <time dateTime={e.at} title={fullTime(e.at)}>{ago(e.at, now)}</time>
        </div>
        <div className="tk-note-b">{highlightMentions(e.body ?? "", e.mentions.map((m) => people.name(m)))}</div>
      </div>
    );
  }
  let text: React.ReactNode;
  switch (e.kind) {
    case "created": text = <>{e.body ?? "Ticket opened"}</>; break;
    case "status": text = e.actor ? <>{who} marked it <b>{label(e.to)}</b></> : <><b>{label(e.to)}</b>{e.body ? ` · ${e.body}` : ""}</>; break;
    case "reopened": text = <><b>Reopened</b>{e.body ? ` · ${e.body}` : ""}</>; break;
    case "assign": text = e.to ? (e.to === e.actor ? <>{who} took it</> : <>{who ?? "Someone"} assigned it to <b>{people.first(e.to)}</b></>) : <>{who} unassigned it</>; break;
    case "snooze": text = e.to ? <>{who} snoozed it until <b>{fullTime(e.to)}</b></> : <>{e.body ?? "Snooze ended"}{who ? <> by {who}</> : null}</>; break;
    case "client": text = <>{who} changed the client{e.from ? <> from <b>{e.from}</b></> : null} to <b>{e.to ?? "none"}</b></>; break;
    case "gmail": text = <>{who} opened it in Gmail to reply</>; break;
    default: text = e.body;
  }
  return (
    <div className="tk-ev">
      <Icon name={EVENT_ICON[e.kind]} />
      <span>{text}</span>
      <time dateTime={e.at} title={fullTime(e.at)}>{ago(e.at, now)}</time>
    </div>
  );
}

function label(s: string | null): string {
  return s === "done" ? "Done" : s === "waiting" ? "Waiting" : s === "ignored" ? "Not a ticket" : s === "open" ? "Open" : s ?? "";
}

function highlightMentions(body: string, names: string[]): React.ReactNode {
  const tokens = names.filter(Boolean).map((n) => `@${n}`).sort((a, b) => b.length - a.length);
  if (!tokens.length) return body;
  const re = new RegExp(`(${tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
  return body.split(re).map((part, i) => (tokens.includes(part) ? <mark key={i}>{part}</mark> : part));
}

/* ----------------------------------------------------------------- note box --- */

function NoteBox({ ticketId, team, me, textareaRef, onSaved }: { ticketId: string; team: Person[]; me: string; textareaRef: React.RefObject<HTMLTextAreaElement | null>; onSaved: () => void }) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [mention, setMention] = useState<{ q: string; start: number } | null>(null);
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<Person[]>([]);
  useEffect(() => { setText(""); setPicked([]); setMention(null); }, [ticketId]);
  const choices = useMemo(() => (mention ? team.filter((p) => p.email !== me && `${p.name} ${p.email}`.toLowerCase().includes(mention.q.toLowerCase())).slice(0, 6) : []), [mention, team, me]);

  const grow = (el: HTMLTextAreaElement) => { el.style.height = "auto"; el.style.height = `${Math.min(220, el.scrollHeight)}px`; };
  const onInput = (el: HTMLTextAreaElement) => {
    setText(el.value);
    grow(el);
    const upto = el.value.slice(0, el.selectionStart);
    const m = /(^|\s)@([\w.-]{0,30})$/.exec(upto);
    setMention(m ? { q: m[2], start: upto.length - m[2].length - 1 } : null);
    setActive(0);
  };
  const insert = (p: Person) => {
    const el = textareaRef.current;
    if (!el || !mention) return;
    const before = text.slice(0, mention.start);
    const after = text.slice(el.selectionStart);
    const next = `${before}@${p.name} ${after}`;
    setText(next);
    setPicked((xs) => (xs.some((x) => x.email === p.email) ? xs : [...xs, p]));
    setMention(null);
    requestAnimationFrame(() => { el.focus(); const pos = before.length + p.name.length + 2; el.setSelectionRange(pos, pos); grow(el); });
  };
  const save = async () => {
    const body = text.trim();
    if (!body || saving) return;
    setSaving(true);
    try {
      const mentions = picked.filter((p) => body.includes(`@${p.name}`)).map((p) => p.email);
      await api(`/api/tools/tickets/${ticketId}/notes`, { method: "POST", json: { body, mentions } });
      setText("");
      setPicked([]);
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      onSaved();
      if (mentions.length) toast.success(`Note saved · ${mentions.length === 1 ? "1 person" : `${mentions.length} people`} mentioned`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The note didn't save");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="tk-compose">
      {mention && choices.length ? (
        <div className="tk-pop up" style={{ left: 22, width: 280 }} role="listbox" aria-label="Mention a teammate">
          <div className="tk-opts">
            {choices.map((p, i) => (
              <button key={p.email} type="button" className="tk-opt" data-active={i === active} onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); insert(p); }}>
                <Avatar email={p.email} name={p.name} /><span>{p.name}</span><small>{p.email}</small>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="tk-compose-box">
        <textarea ref={textareaRef} id="tk-note" rows={1} value={text} placeholder="Add an internal note… type @ to mention a teammate" aria-label="Internal note"
          onChange={(e) => onInput(e.target)}
          onKeyDown={(e) => {
            if (mention && choices.length) {
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, choices.length - 1)); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); return; }
              if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); insert(choices[active]); return; }
              if (e.key === "Escape") { e.preventDefault(); setMention(null); return; }
            }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
            if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
          }} />
        <div className="tk-compose-f">
          <span>Only the team sees notes. The client never does.</span>
          <span className="tk-sp" />
          <button type="button" className="tk-btn" style={{ height: 28, background: "#fff" }} disabled={!text.trim() || saving} onClick={() => void save()}>
            {saving ? "Saving…" : <>Save note <kbd>⌘↵</kbd></>}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- replies (24 Nov) --- */

/** A reply sent from Tickets: what was written, from which inbox, and who pressed Send. */
function SentReply({ m, people }: { m: TicketMessageView; people: ReturnType<typeof usePeople> }) {
  const [more, setMore] = useState(false);
  const text = m.text ?? "";
  const long = text.split("\n").length > 6 || text.length > 600;
  const as = firstName(m.from.name, m.from.email);
  const by = m.sentBy && m.sentBy !== m.from.email ? people.first(m.sentBy) || m.sentBy : null;
  const to = [...m.to, ...m.cc].map((a) => (people.has(a.email) ? people.first(a.email) : a.name ?? a.email));
  return (
    <article className="tk-sent" data-sent-reply={m.id}>
      <div className="tk-sent-h">
        <Icon name="reply" />
        <b>{m.from.name ?? m.from.email}</b>
        <span>to {to.slice(0, 3).join(", ")}{to.length > 3 ? ` +${to.length - 3}` : ""}</span>
        <span className="tk-sent-by" title="Sent from Tickets">{by ? `Sent as ${as} by ${by}` : "Sent from Tickets"}</span>
        <time dateTime={m.sentAt} title={fullTime(m.sentAt)}>{fullTime(m.sentAt)}</time>
      </div>
      <div className={`tk-sent-b${long && !more ? " clamp" : ""}`}>{text}</div>
      {long ? <button type="button" className="tk-sent-more" onClick={() => setMore((v) => !v)}>{more ? "Show less" : "Show the whole reply"}</button> : null}
    </article>
  );
}

const DRAFT_KEY = (n: number) => `os.tickets.reply.${n}`;
interface Draft { text: string; from: string | null; ccOff: string[]; nonce: string; /** "It may have gone" from the last try: shown again after a reload. */ unsure?: string | null }
function readDraft(n: number): Draft | null {
  try { const v = window.localStorage.getItem(DRAFT_KEY(n)); return v ? (JSON.parse(v) as Draft) : null; } catch { return null; }
}
function writeDraft(n: number, d: Draft | null) {
  try { if (d && d.text.trim()) window.localStorage.setItem(DRAFT_KEY(n), JSON.stringify(d)); else window.localStorage.removeItem(DRAFT_KEY(n)); } catch { /* private window */ }
}
function hasDraft(n: number): boolean {
  return typeof window !== "undefined" && !!readDraft(n)?.text.trim();
}
const newNonce = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);

/**
 * The reply box: From (the inbox the client wrote to; the other one when both got it), To (the client), Cc (people on
 * their email, untick to leave out), the reply, the inbox's Gmail signature, Send. The draft is kept in this browser
 * until it is sent or discarded, so switching tickets loses nothing.
 */
function ReplyBox({ ticketNumber, ctx, me, people, onClose, onSent, onStale }: {
  ticketNumber: number;
  ctx: ReplyContextView;
  me: string;
  people: ReturnType<typeof usePeople>;
  onClose: () => void;
  onSent: () => void;
  /** A newer client email came in: read the ticket again (the draft stays). */
  onStale: () => void;
}) {
  const saved = useMemo(() => readDraft(ticketNumber), [ticketNumber]);
  const [text, setText] = useState(saved?.text ?? "");
  const [from, setFrom] = useState<string>(() => (saved?.from && ctx.senders.some((s) => s.email === saved.from) ? saved.from : ctx.defaultSender ?? ctx.senders[0]?.email ?? ""));
  const [ccOff, setCcOff] = useState<string[]>(saved?.ccOff ?? []);
  const [nonce, setNonce] = useState(saved?.nonce ?? newNonce);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<{ text: string; unsure?: boolean } | null>(saved?.unsure ? { text: saved.unsure, unsure: true } : null);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const sender = ctx.senders.find((s) => s.email === from) ?? ctx.senders[0];
  const asName = firstName(sender?.name ?? null, sender?.email ?? "");
  const cc = ctx.cc.filter((a) => a.email !== from);
  useEffect(() => { writeDraft(ticketNumber, { text, from, ccOff, nonce, unsure: problem?.unsure ? problem.text : null }); }, [ticketNumber, text, from, ccOff, nonce, problem]);
  useEffect(() => { const el = ref.current; if (el) { el.focus(); el.style.height = "auto"; el.style.height = `${Math.min(320, el.scrollHeight)}px`; } }, []);

  const send = async () => {
    if (!sender?.ready || !text.trim() || sending) return;
    setSending(true);
    setProblem(null);
    try {
      const res = await fetch(`/api/tools/tickets/${ticketNumber}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ from, text, cc: cc.filter((a) => !ccOff.includes(a.email)).map((a) => a.email), nonce, replyTo: ctx.replyTo }),
        cache: "no-store",
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; code?: string; note?: string; to?: string; sent?: boolean | "unknown" };
      if (res.ok && j.ok) {
        writeDraft(ticketNumber, null);
        toast.success(j.note ?? `Sent as ${asName} to ${ctx.to?.name ?? ctx.to?.email ?? "the client"}`);
        onSent();
        return;
      }
      if (j.sent === false) {
        // The server is sure nothing went: say why; the draft can be fixed and sent.
        setProblem({ text: j.error ?? "The reply couldn't be sent. Nothing was sent." });
        if (j.code === "stale") onStale();
        return;
      }
      // Anything else (Gmail didn't confirm, an error page while the OS restarts…) may have gone: never invite a resend.
      setProblem({ text: j.error ?? `It isn't known whether the reply went (${res.status}). Look in ${asName}'s Sent folder before sending it again.`, unsure: true });
    } catch {
      // The request may or may not have reached the OS: never invite a second send without a look first.
      setProblem({ text: `The connection dropped, so it isn't known whether the reply went. Look in ${asName}'s Sent folder before sending it again.`, unsure: true });
    } finally {
      setSending(false);
    }
  };
  const discard = () => { writeDraft(ticketNumber, null); onClose(); };

  return (
    <div className="tk-rbox" data-reply-box>
      <div className="tk-rbox-card">
        <div className="tk-rbox-rows">
          <div className="tk-rbox-row">
            <span className="k">From</span>
            {ctx.senders.length > 1 ? (
              <select id="tk-reply-from" aria-label="Send from" value={from} onChange={(e) => setFrom(e.target.value)} disabled={sending}>
                {ctx.senders.map((s) => <option key={s.email} value={s.email}>{s.name} &lt;{s.email}&gt;{s.ready ? "" : " · can't send yet"}</option>)}
              </select>
            ) : <span className="tk-rbox-addr" data-reply-from>{sender?.name}<small>{sender?.email}</small></span>}
            {sender && sender.email !== me ? <span className="tk-muted">· the client sees it from {asName}</span> : null}
          </div>
          <div className="tk-rbox-row">
            <span className="k">To</span>
            <span className="tk-rbox-addr" data-reply-to>{ctx.to?.name ?? ctx.to?.email}{ctx.to?.name ? <small>{ctx.to.email}</small> : null}</span>
          </div>
          {cc.length ? (
            <div className="tk-rbox-row">
              <span className="k">Cc</span>
              {cc.map((a) => {
                const off = ccOff.includes(a.email);
                const label = people.has(a.email) ? people.name(a.email) : a.name ?? a.email;
                return (
                  <label key={a.email} className="tk-rbox-cc" data-off={off} title={a.email}>
                    <input type="checkbox" checked={!off} disabled={sending} onChange={() => setCcOff((xs) => (off ? xs.filter((x) => x !== a.email) : [...xs, a.email]))} />
                    {label}
                  </label>
                );
              })}
            </div>
          ) : null}
        </div>
        {sender && !sender.ready ? <div className="tk-rbox-warn" role="status">{sender.why}</div> : null}
        {problem ? (
          <div className={`tk-rbox-warn${problem.unsure ? "" : " bad"}`} role="alert">
            {problem.text}
            {problem.unsure ? (
              <div>
                <button type="button" className="tk-btn" onClick={() => { writeDraft(ticketNumber, null); setProblem(null); onSent(); }}>It was sent: clear the draft</button>
                <button type="button" className="tk-btn" onClick={() => { setNonce(newNonce()); setProblem(null); }}>It wasn&apos;t sent: let me send again</button>
              </div>
            ) : null}
          </div>
        ) : null}
        <textarea ref={ref} id="tk-reply-text" value={text} rows={4} aria-label={`Reply to ${ctx.to?.name ?? ctx.to?.email ?? "the client"}`}
          placeholder={`Write your reply to ${ctx.to?.name?.split(/\s+/)[0] ?? "the client"}…`} disabled={sending || !!problem?.unsure}
          onChange={(e) => { setText(e.target.value); const el = e.target; el.style.height = "auto"; el.style.height = `${Math.min(320, el.scrollHeight)}px`; }}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
        {sender?.signature ? <div className="tk-rbox-sig" title={`${asName}'s Gmail signature, added when it's sent`}>{sender.signature}</div> : null}
        <div className="tk-rbox-f">
          <span>Goes to the client from {asName}&apos;s Gmail, in the same conversation{sender?.signature ? ", with the signature above" : ""}. Their email is quoted underneath.</span>
          <span className="tk-sp" />
          <button type="button" className="tk-btn ghost" onClick={discard} disabled={sending}>{text.trim() ? "Discard" : "Close"}</button>
          <button type="button" className="tk-btn pri" data-reply-send disabled={!sender?.ready || !text.trim() || sending || !!problem?.unsure} onClick={() => void send()}>
            {sending ? "Sending…" : <>Send as {asName} <kbd>⌘↵</kbd></>}
          </button>
        </div>
      </div>
    </div>
  );
}
