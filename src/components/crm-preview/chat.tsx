"use client";

/*
 * The design's support chat (Chat), opened from the button at the bottom
 * right — now a working assistant (19 Oct). It answers from ONE client's
 * portal: the server loads that portal's data and nothing else
 * (lib/crm-preview/chat-tools.ts), and it reads only — it changes nothing.
 *
 * Drawn exactly as the design draws it: the greeting, the four suggestions,
 * the bubbles, the typing dots, the input. The conversation stays while the
 * window is closed and reopened, for this page's life.
 *
 * "Ask for a person" (4 Nov; lib/portal-chat): our team hears on Slack, opens
 * this same window on that portal, and replies here. From then on the client's
 * messages go to our team, not the assistant, and survive a reload; they're back
 * with the assistant when it's resolved, or when they choose to be. The server
 * says who this is (person-chat), so the window shows a client their own
 * conversation and our team every open one on the portal.
 */

import { Fragment, useEffect, useReducer, useRef, useState } from "react";

import { PERSON_ASK, PERSON_FAILED } from "@/lib/crm-preview/ask-person";
import type { ChatMessageView, ChatThreadView } from "@/lib/portal-chat/threads";
import { firstName } from "@/lib/crm-preview/signed-in";

import { Icon } from "./icons";


/** sig: the server's signature on an assistant answer, sent back with it when they ask for a person. */
interface Turn { role: "user" | "assistant"; text: string; at: number; local?: boolean; failed?: boolean; sig?: string }

const SUGGESTIONS = ["Block a sister office", "Add a teammate", "Change my emails", "Billing question"];

/*
 * The conversation per client, for the page's life — outside the window, so
 * an answer that arrives after the window was closed lands in the reopened
 * one (21 Oct review: it used to be dropped, and the next send overwrote it).
 */
interface ChatState { turns: Turn[]; busy: boolean }
const store = new Map<string, ChatState>();
let listeners: Array<() => void> = [];
const read = (id: string): ChatState => store.get(id) ?? { turns: [], busy: false };
const write = (id: string, patch: Partial<ChatState>) => {
  store.set(id, { ...read(id), ...patch });
  for (const l of listeners) l();
};

/*
 * The conversation with our team, as the server last said it. A client: `mine`. Our team: `threads`, and `open` is the
 * one on screen. Null role: not heard yet (or before migration 0047): the window is the assistant, as ever.
 */
interface PersonState { role: "client" | "staff" | null; mine: ChatThreadView | null; threads: ChatThreadView[]; emailOn: boolean; open: string | null; note: string | null }
const persons = new Map<string, PersonState>();
const readPerson = (id: string): PersonState => persons.get(id) ?? { role: null, mine: null, threads: [], emailOn: false, open: null, note: null };
const writePerson = (id: string, patch: Partial<PersonState>) => {
  persons.set(id, { ...readPerson(id), ...patch });
  for (const l of listeners) l();
};

/* Counts what this window has just changed: an answer to a question asked before that is out of date, and is dropped. */
const changes = new Map<string, number>();
const changed = (id: string) => changes.set(id, (changes.get(id) ?? 0) + 1);

/** True when it's been heard (a failure is simply asked again at the next look). */
async function refreshPerson(id: string, named: string | null): Promise<boolean> {
  try {
    // The one on screen is always asked for by name: once closed it would otherwise stop coming back, and go stale.
    const name = named ?? readPerson(id).open;
    const q = new URLSearchParams({ client: id, ...(name ? { thread: name } : {}) }).toString();
    const asked = changes.get(id) ?? 0;
    const res = await fetch(`/api/crm-preview/person-chat?${q}`, { cache: "no-store" });
    if (!res.ok) return false;
    const body = (await res.json()) as { role?: string; thread?: ChatThreadView | null; threads?: ChatThreadView[]; emailOn?: boolean };
    if ((changes.get(id) ?? 0) !== asked) return true;
    const cur = readPerson(id);
    if (body.role === "client") {
      // Gone from what's to show (resolved, and they've read it) while it's on screen: it stays, as closed.
      writePerson(id, { role: "client", mine: body.thread ?? (cur.mine ? { ...cur.mine, status: "closed" } : null) });
    } else if (body.role === "staff") {
      const fresh = body.threads ?? [];
      // The one on screen stays, closed or not, until our team goes back from it.
      const kept = cur.threads.filter((t) => t.id === cur.open && !fresh.some((f) => f.id === t.id));
      writePerson(id, { role: "staff", threads: [...fresh, ...kept], emailOn: !!body.emailOn, open: cur.open ?? (named && fresh.some((t) => t.id === named) ? named : null) });
    }
    return true;
  } catch {
    return false;
  }
}

/** Our team's copy or the client's, with what the server just said. */
function mergeThread(id: string, thread: ChatThreadView) {
  const cur = readPerson(id);
  if (cur.role === "staff") writePerson(id, { threads: cur.threads.some((t) => t.id === thread.id) ? cur.threads.map((t) => (t.id === thread.id ? thread : t)) : [...cur.threads, thread] });
  else writePerson(id, { mine: thread });
}

async function personPost(id: string, body: Record<string, unknown>): Promise<{ ok: boolean; role?: string; reply?: string; error?: string; thread?: ChatThreadView | null }> {
  changed(id);
  try {
    const res = await fetch(`/api/crm-preview/ask-person`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: id, ...body }),
      signal: AbortSignal.timeout(30_000),
    });
    const out = (await res.json().catch(() => null)) as { role?: string; reply?: string; error?: string; thread?: ChatThreadView | null } | null;
    changed(id);
    return { ok: res.ok, ...out };
  } catch {
    return { ok: false, error: PERSON_FAILED };
  }
}

/** Reads the conversation for the portal's page, and keeps it fresh while it matters. The count on the chat button. */
export function usePersonChat(id: string, windowOpen: boolean, named: string | null): number {
  // Only what the page shows: the conversation's own changes redraw the window, not the whole portal behind it.
  const look = () => {
    const p = readPerson(id);
    // Not heard yet (the first look failed): asked again until it is.
    return { count: p.role === "staff" ? p.threads.filter((t) => t.status === "open").length : p.mine?.unread ? 1 : 0, waiting: p.role !== "client" || p.mine?.status === "open" };
  };
  const [{ count, waiting }, setSeen] = useState(look);
  useEffect(() => {
    const listen = () => setSeen((was) => { const now = look(); return was.count === now.count && was.waiting === now.waiting ? was : now; });
    listeners = [...listeners, listen];
    return () => { listeners = listeners.filter((l) => l !== listen); };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps -- `look` reads only `id`
  // A Slack link's conversation is asked for by name until it's been heard: after that the window keeps it, while it's open.
  const first = useRef(named);
  useEffect(() => {
    void refreshPerson(id, first.current).then((heard) => { if (heard) first.current = null; });
  }, [id, windowOpen]);
  useEffect(() => {
    if (!waiting) return;
    const every = setInterval(() => { if (!document.hidden) void refreshPerson(id, first.current).then((heard) => { if (heard) first.current = null; }); }, windowOpen ? 10_000 : 60_000);
    return () => clearInterval(every);
  }, [id, windowOpen, waiting]);
  return count;
}

/** A key for one typed message (crypto.randomUUID is missing before Safari 15.4). */
const newKey = () => (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`);

const stamp = (at: string) => { const t = Date.parse(at); return Number.isFinite(t) ? t : Date.now(); };
// A kept conversation can be days old: the time alone would read as today.
const time = (at: number) => new Intl.DateTimeFormat("en-US", new Date(at).toDateString() === new Date().toDateString() ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(at));
const BOT = (
  <span style={{ width: 28, height: 28, borderRadius: 99, background: "#eef2fa", color: "#3e6bd1", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
    <Icon name="bot" size={16} />
  </span>
);
const CHIP = { height: 30, padding: "0 12px", border: "1px solid #c9d6f2", borderRadius: 99, background: "#fff", fontSize: 12, fontWeight: 500, color: "#2f55a8", cursor: "pointer", whiteSpace: "nowrap" } as const;

/** The assistant's words as text: lines kept, **bold** shown bold, "- " as a bullet. Never HTML. */
function Words({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  return (
    <>
      {lines.map((line, i) => {
        const l = line.replace(/^\s*[-*]\s+/, "• ").replace(/^#{1,6}\s+/, "");
        const parts = l.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
        return (
          <Fragment key={i}>
            {i ? <br /> : null}
            {parts.map((p, j) => (/^\*\*[^*]+\*\*$/.test(p) ? <b key={j}>{p.slice(2, -2)}</b> : <Fragment key={j}>{p}</Fragment>))}
          </Fragment>
        );
      })}
    </>
  );
}

function Mine({ text, at, under }: { text: string; at: number; under?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignSelf: "flex-end", maxWidth: "80%" }}>
      <div style={{ background: "#3e6bd1", color: "#fff", padding: "9px 12px", borderRadius: "14px 14px 4px 14px", lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {text}
      </div>
      <span style={{ fontSize: 11, color: "#6b7280", alignSelf: "flex-end" }}>
        {under ? `${under} · ` : ""}{time(at)}
      </span>
    </div>
  );
}

/** Someone's initial, where the assistant has its icon. */
const FACE = (name: string | null) => (
  <span style={{ width: 28, height: 28, borderRadius: 99, background: "#3e6bd1", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 12, fontWeight: 600 }}>
    {(name ?? "").trim().charAt(0).toUpperCase() || "B"}
  </span>
);

function Theirs({ text, at, failed, face, who }: { text: string; at: number; failed?: boolean; face?: React.ReactNode; who?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignSelf: "flex-start", maxWidth: "86%" }} data-chat-reply={failed ? "failed" : "ok"}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
        {face ?? BOT}
        <div style={{ background: "#ffffff", border: `1px solid ${failed ? "#f3c4c0" : "#ebedf0"}`, color: failed ? "#b42318" : "#1f2124", padding: "10px 12px", borderRadius: "14px 14px 14px 4px", lineHeight: 1.55, overflowWrap: "anywhere" }}>
          <Words text={text} />
        </div>
      </div>
      <span style={{ fontSize: 11, color: "#6b7280", marginLeft: 36 }}>
        {who ? `${who} · ` : ""}{time(at)}
      </span>
    </div>
  );
}

/** A conversation as the client sees it. */
function ClientMessage({ m }: { m: ChatMessageView }) {
  if (m.role === "client") return <Mine text={m.text} at={stamp(m.at)} />;
  if (m.role === "team") return <Theirs text={m.text} at={stamp(m.at)} face={FACE(m.sender)} who={m.sender ? `${m.sender}, BrokerStaffer` : "BrokerStaffer"} />;
  return <Theirs text={m.text} at={stamp(m.at)} />;
}

/** The same conversation as our team sees it: their side on the right, and whether each reply reached the email. */
function TeamMessage({ m, person }: { m: ChatMessageView; person: string | null }) {
  if (m.role === "team") return <Mine text={m.text} at={stamp(m.at)} under={`${m.sender ?? "BrokerStaffer"} · ${m.emailed ? "Emailed" : "Not emailed"}`} />;
  if (m.role === "client") return <Theirs text={m.text} at={stamp(m.at)} face={FACE(person)} who={person ?? "Client"} />;
  return <Theirs text={m.text} at={stamp(m.at)} who="Assistant" />;
}

const NOTICE = { alignSelf: "center", textAlign: "center", fontSize: 11, color: "#6b7280", padding: "4px 10px", borderRadius: 10, background: "#eef0f3" } as const;
const LINK = { border: 0, background: "none", padding: 0, font: "inherit", color: "#3e6bd1", cursor: "pointer" } as const;

export function ChatWindow({ client, onClose }: { client: { id: string; contactName: string | null }; onClose: () => void }) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const { turns, busy } = read(client.id);
  const person = readPerson(client.id);
  const mine = person.role === "client" ? person.mine : null;
  const withTeam = mine?.status === "open";
  // Our team, on one conversation (else the assistant, with the open ones listed above it).
  const onThread = person.role === "staff" ? person.threads.find((t) => t.id === person.open) ?? null : null;
  const waiting = person.role === "staff" ? person.threads.filter((t) => t.status === "open") : [];
  const [draft, setDraft] = useState("");
  const box = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // What was typed and its key, until it's gone: sent again (after a timeout), the server saves and emails it once.
  const unsent = useRef<{ text: string; key: string } | null>(null);

  useEffect(() => {
    listeners = [...listeners, rerender];
    return () => { listeners = listeners.filter((l) => l !== rerender); };
  }, []);
  useEffect(() => {
    // Escape closes the chat only from inside it — not a panel or dialog the person is closing behind it.
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && box.current?.contains(document.activeElement)) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    input.current?.focus();
    // Closing hands focus back to the chat button.
    return () => { document.querySelector<HTMLElement>(".crx-aiask")?.focus(); };
  }, []);
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [turns, busy, mine?.messages.length, onThread?.id, onThread?.messages.length]);
  // Open on a reply they hadn't seen: they've seen it now, and the button's mark goes.
  useEffect(() => {
    if (!mine?.unread) return;
    writePerson(client.id, { mine: { ...mine, unread: false } });
    void personPost(client.id, { action: "read", thread: mine.id });
  }, [client.id, mine]);

  const first = firstName(client.contactName);

  /** One message in the conversation with our team, either way. What they typed comes back if it didn't go. */
  async function sayToPerson(action: "say" | "reply", thread: string, text: string) {
    const id = client.id;
    const key = unsent.current?.text === text ? unsent.current.key : newKey();
    unsent.current = { text, key };
    write(id, { busy: true });
    writePerson(id, { note: null });
    setDraft("");
    const r = await personPost(id, { action, thread, text, key });
    write(id, { busy: false });
    if (r.thread) mergeThread(id, r.thread);
    if (r.ok) unsent.current = null;
    if (!r.ok) {
      writePerson(id, { note: r.error ?? PERSON_FAILED });
      setDraft(text);
    }
    input.current?.focus();
  }

  async function send(text: string) {
    const id = client.id;
    const clean = text.trim();
    if (!clean || read(id).busy) return;
    if (onThread) return sayToPerson("reply", onThread.id, clean);
    if (withTeam && mine) return sayToPerson("say", mine.id, clean);
    if (person.note) writePerson(id, { note: null });
    const typed: Turn = { role: "user", text: clean.slice(0, 2000), at: Date.now() };
    write(id, { turns: [...read(id).turns, typed], busy: true });
    setDraft("");
    // Each answer is added to the conversation as it is THEN — never to a copy taken before the wait.
    const answerWith = (t: Turn) => write(id, { turns: [...read(id).turns, t], busy: false });
    try {
      // Only real answers go back as context — not this window's own notes or failures; long ones clipped.
      const messages = read(id).turns.filter((t) => !t.local && !t.failed).slice(-12)
        .map((t) => ({ role: t.role, text: t.role === "assistant" ? t.text.slice(0, 4000) : t.text }));
      const res = await fetch(`/api/crm-preview/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client: id, messages }),
        signal: AbortSignal.timeout(90_000),
      });
      const body = (await res.json().catch(() => null)) as { reply?: string; sig?: string | null; error?: string } | null;
      answerWith(res.ok && body?.reply
        ? { role: "assistant", text: body.reply, at: Date.now(), ...(body.sig ? { sig: body.sig } : {}) }
        : { role: "assistant", text: body?.error ?? "The assistant couldn't answer just now. Please try again.", at: Date.now(), failed: true });
    } catch {
      answerWith({ role: "assistant", text: "The assistant couldn't be reached. Check your connection and try again.", at: Date.now(), failed: true });
    } finally {
      input.current?.focus();
    }
  }

  async function askForPerson() {
    const id = client.id;
    if (read(id).busy) return;
    const said = read(id).turns.filter((t) => !t.local && !t.failed);
    // What they last typed themselves, so our team knows what it's about; and what came before, to read in the chat.
    const question = [...said].reverse().find((t) => t.role === "user")?.text ?? null;
    write(id, { turns: [...read(id).turns, { role: "user", text: PERSON_ASK, at: Date.now(), local: true }], busy: true });
    // This window's own notes (local): never sent back to the assistant as if they were answers.
    const answerWith = (t: Turn) => write(id, { turns: [...read(id).turns, t], busy: false });
    const r = await personPost(id, { action: "ask", question, turns: said.slice(-12).map((t) => ({ role: t.role === "user" ? "client" : "assistant", text: t.text, ...(t.sig ? { sig: t.sig } : {}) })) });
    if (r.ok && r.role === "client" && r.thread) {
      // It's all in the conversation now, kept: this page's copy would only say it twice.
      write(id, { turns: [], busy: false });
      writePerson(id, { role: "client", mine: r.thread, note: null });
    } else if (r.ok && r.reply) {
      answerWith({ role: "assistant", text: r.reply, at: Date.now(), local: true });
      void refreshPerson(id, null);
    } else {
      answerWith({ role: "assistant", text: r.error ?? PERSON_FAILED, at: Date.now(), local: true, failed: true });
    }
    input.current?.focus();
  }

  async function backToAssistant() {
    if (!mine) return;
    const r = await personPost(client.id, { action: "leave", thread: mine.id });
    if (r.ok) writePerson(client.id, { mine: null, note: null });
    else writePerson(client.id, { note: r.error ?? PERSON_FAILED });
  }

  async function resolve() {
    if (!onThread) return;
    const r = await personPost(client.id, { action: "resolve", thread: onThread.id });
    if (r.thread) mergeThread(client.id, r.thread);
    if (!r.ok) writePerson(client.id, { note: r.error ?? PERSON_FAILED });
  }

  return (
      <section ref={box} role="dialog" aria-label="Support chat" style={{ position: "fixed", right: 24, bottom: 92, zIndex: 12, width: 380, height: 600, maxHeight: "calc(100vh - 116px)", boxSizing: "border-box", background: "#f7f8fa", borderRadius: 18, boxShadow: "0 24px 60px rgba(31,33,36,0.22)", display: "flex", flexDirection: "column", fontFamily: "var(--crx-font), 'Inter Tight', system-ui, sans-serif", fontSize: 13, color: "#1f2124", overflow: "hidden" }}>
        <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 16px 18px", background: "#3e6bd1", color: "#fff" }}>
          <span style={{ position: "relative", width: 38, height: 38, borderRadius: 99, background: "#fff", color: "#3e6bd1", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="bot" size={20} />
            <span style={{ position: "absolute", bottom: "0", right: "0", width: 10, height: 10, borderRadius: 99, background: "#22c55e", border: "2px solid #3e6bd1" }} />
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              BrokerStaffer Assistant
            </div>
            <div style={{ fontSize: 12, opacity: 0.85 }}>
              Online · Our team can join anytime
            </div>
          </div>
          <button type="button" aria-label="Minimize chat" onClick={onClose} style={{ border: 0, background: "transparent", padding: 0, cursor: "pointer", width: 30, height: 30, borderRadius: 8, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="chevDown" size={18} />
          </button>
        </header>
        <div ref={scroller} aria-live="polite" style={{ flex: 1, overflow: "auto", padding: "16px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
          {onThread ? null : (
            <>
          {mine ? null : (
          <div style={{ alignSelf: "center", fontSize: 11, color: "#6b7280", padding: "2px 10px", borderRadius: 99, background: "#eef0f3" }}>
            Today
          </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 4, alignSelf: "flex-start", maxWidth: "86%" }}>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
              {BOT}
              <div style={{ background: "#ffffff", border: "1px solid #ebedf0", color: "#1f2124", padding: "10px 12px", borderRadius: "14px 14px 14px 4px", lineHeight: 1.55 }}>
                Hi{first ? ` ${first}` : " there"}! I am the BrokerStaffer assistant. What can I help you with?
              </div>
            </div>
          </div>
            </>
          )}
          {!turns.length && !mine && !onThread ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginLeft: 36 }}>
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" disabled={busy} onClick={() => void send(s)} style={CHIP}>{s}</button>
              ))}
            </div>
          ) : null}
          {waiting.length && !onThread ? (
            <div data-chat-waiting style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {waiting.map((t) => (
                <button key={t.id} type="button" onClick={() => { setDraft(""); writePerson(client.id, { open: t.id, note: null }); }} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "9px 12px", border: "1px solid #c9d6f2", borderRadius: 12, background: "#fff", font: "inherit", color: "#1f2124", textAlign: "left", cursor: "pointer" }}>
                  {FACE(t.person)}
                  <span style={{ flex: 1, overflowWrap: "anywhere" }}><b style={{ fontWeight: 600 }}>{t.person ?? "Someone"}</b> asked for a person{t.test ? " (test)" : ""}</span>
                  <Icon name="chevRight" size={15} />
                </button>
              ))}
            </div>
          ) : null}
          {onThread ? (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <button type="button" onClick={() => { setDraft(""); writePerson(client.id, { open: null, note: null }); }} style={{ ...LINK, display: "inline-flex", alignItems: "center", gap: 4 }}><Icon name="arrowLeft" size={14} />Back</button>
                <b style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{onThread.person ?? "Client"}{onThread.test ? " (test)" : ""}</b>
                {onThread.status === "open" ? <button type="button" onClick={() => void resolve()} style={LINK}>Mark resolved</button> : <span />}
              </div>
              {onThread.messages.map((m) => <TeamMessage key={m.id} m={m} person={onThread.person} />)}
              {onThread.status === "closed" ? <div style={NOTICE}>This conversation is closed.</div> : null}
            </>
          ) : null}
          {mine ? mine.messages.map((m) => <ClientMessage key={m.id} m={m} />) : null}
          {mine?.status === "closed" ? <div style={NOTICE}>This conversation is closed. You&apos;re back with the assistant.</div> : null}
          {!onThread ? turns.map((t, i) => t.role === "user" ? <Mine key={i} text={t.text} at={t.at} /> : <Theirs key={i} text={t.text} at={t.at} failed={t.failed} />) : null}
          {busy ? (
            <div role="status" aria-label={onThread || withTeam ? "Sending" : "The assistant is typing"} style={{ display: "flex", alignItems: "flex-end", gap: 8, alignSelf: "flex-start" }}>
              {BOT}
              <div style={{ background: "#fff", border: "1px solid #ebedf0", padding: "12px 14px", borderRadius: "14px 14px 14px 4px", display: "flex", gap: 4 }}>
                <span style={{ width: 6, height: 6, borderRadius: 99, background: "#a0a7b4", opacity: 1 }} />
                <span style={{ width: 6, height: 6, borderRadius: 99, background: "#a0a7b4", opacity: 0.7 }} />
                <span style={{ width: 6, height: 6, borderRadius: 99, background: "#a0a7b4", opacity: 0.4 }} />
              </div>
            </div>
          ) : null}
        </div>
        {person.note ? <div role="alert" style={{ padding: "8px 14px", background: "#fdf1f0", color: "#b42318", fontSize: 12 }}>{person.note}</div> : null}
        {onThread?.status === "closed" ? null : (
        <form
          onSubmit={(e) => { e.preventDefault(); void send(draft); }}
          style={{ padding: "10px 12px 12px", background: "#fff", borderTop: "1px solid #ebedf0", margin: 0 }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 4px 4px 14px", border: "1px solid #e3e6eb", borderRadius: 99 }}>
            <input ref={input} type="text" placeholder={onThread ? `Reply to ${firstName(onThread.person) || "them"}...` : withTeam ? "Message our team..." : "Type a message..."} aria-label="Message" value={draft} maxLength={2000}
              onChange={(e) => setDraft(e.target.value)}
              style={{ flex: 1, border: "0", outline: "0", fontSize: 13, fontFamily: "inherit", background: "transparent" }} />
            <button type="submit" aria-label="Send" disabled={busy || !draft.trim()} style={{ width: 34, height: 34, border: "0", borderRadius: 99, background: "#3e6bd1", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: busy || !draft.trim() ? "default" : "pointer", opacity: busy || !draft.trim() ? 0.6 : 1 }}>
              <Icon name="campaigns" size={15} />
            </button>
          </div>
          <div style={{ fontSize: 11, color: "#6b7280", textAlign: "center", marginTop: 8 }}>
            {onThread ? (
              person.emailOn ? "Your reply shows in their chat and goes to their email." : "Your reply shows in their chat. Emailing clients is switched off."
            ) : withTeam ? (
              <>You&apos;re chatting with our team ·{" "}<button type="button" onClick={() => void backToAssistant()} style={LINK}>Ask the assistant instead</button></>
            ) : (
              <>Automated assistant ·{" "}<button type="button" onClick={() => void askForPerson()} style={LINK}>Ask for a person</button>{" "}anytime</>
            )}
          </div>
        </form>
        )}
      </section>
  );
}
