"use client";

/*
 * The design's support chat (Chat), opened from the button at the bottom
 * right — now a working assistant (19 Oct). It answers from ONE client's
 * portal: the server loads that portal's data and nothing else
 * (lib/crm-preview/chat-tools.ts), and it reads only — it changes nothing.
 *
 * Drawn exactly as the design draws it: the greeting, the four suggestions,
 * the bubbles, the typing dots, the input. "Ask for a person" answers with
 * the support address (user, 19 Oct: no live handoff yet). The conversation
 * stays while the window is closed and reopened, for this page's life.
 */

import { Fragment, useEffect, useReducer, useRef, useState } from "react";

import { SUPPORT_EMAIL } from "@/lib/crm-preview/chat-tools";
import { firstName } from "@/lib/crm-preview/signed-in";

import { Icon } from "./icons";


interface Turn { role: "user" | "assistant"; text: string; at: number; local?: boolean; failed?: boolean }

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

const time = (at: number) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(at));
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

export function ChatWindow({ client, onClose }: { client: { id: string; contactName: string | null }; onClose: () => void }) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const { turns, busy } = read(client.id);
  const [draft, setDraft] = useState("");
  const box = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

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
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [turns, busy]);

  const first = firstName(client.contactName);

  async function send(text: string) {
    const id = client.id;
    const clean = text.trim();
    if (!clean || read(id).busy) return;
    const mine: Turn = { role: "user", text: clean.slice(0, 2000), at: Date.now() };
    write(id, { turns: [...read(id).turns, mine], busy: true });
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
      const body = (await res.json().catch(() => null)) as { reply?: string; error?: string } | null;
      answerWith(res.ok && body?.reply
        ? { role: "assistant", text: body.reply, at: Date.now() }
        : { role: "assistant", text: body?.error ?? "The assistant couldn't answer just now. Please try again.", at: Date.now(), failed: true });
    } catch {
      answerWith({ role: "assistant", text: "The assistant couldn't be reached. Check your connection and try again.", at: Date.now(), failed: true });
    } finally {
      input.current?.focus();
    }
  }

  function askForPerson() {
    if (busy) return;
    write(client.id, { turns: [
      ...read(client.id).turns,
      { role: "user", text: "I'd like to talk to a person.", at: Date.now(), local: true },
      { role: "assistant", text: `Of course. Email ${SUPPORT_EMAIL} and our team will pick it up.`, at: Date.now(), local: true },
    ] });
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
          <div style={{ alignSelf: "center", fontSize: 11, color: "#6b7280", padding: "2px 10px", borderRadius: 99, background: "#eef0f3" }}>
            Today
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, alignSelf: "flex-start", maxWidth: "86%" }}>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
              {BOT}
              <div style={{ background: "#ffffff", border: "1px solid #ebedf0", color: "#1f2124", padding: "10px 12px", borderRadius: "14px 14px 14px 4px", lineHeight: 1.55 }}>
                Hi{first ? ` ${first}` : " there"}! I am the BrokerStaffer assistant. What can I help you with?
              </div>
            </div>
          </div>
          {!turns.length ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginLeft: 36 }}>
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" disabled={busy} onClick={() => void send(s)} style={CHIP}>{s}</button>
              ))}
            </div>
          ) : null}
          {turns.map((t, i) => t.role === "user" ? (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4, alignSelf: "flex-end", maxWidth: "80%" }}>
              <div style={{ background: "#3e6bd1", color: "#fff", padding: "9px 12px", borderRadius: "14px 14px 4px 14px", lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {t.text}
              </div>
              <span style={{ fontSize: 11, color: "#6b7280", alignSelf: "flex-end" }}>
                {time(t.at)}
              </span>
            </div>
          ) : (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4, alignSelf: "flex-start", maxWidth: "86%" }} data-chat-reply={t.failed ? "failed" : "ok"}>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
                {BOT}
                <div style={{ background: "#ffffff", border: `1px solid ${t.failed ? "#f3c4c0" : "#ebedf0"}`, color: t.failed ? "#b42318" : "#1f2124", padding: "10px 12px", borderRadius: "14px 14px 14px 4px", lineHeight: 1.55, overflowWrap: "anywhere" }}>
                  <Words text={t.text} />
                </div>
              </div>
              <span style={{ fontSize: 11, color: "#6b7280", marginLeft: 36 }}>
                {time(t.at)}
              </span>
            </div>
          ))}
          {busy ? (
            <div role="status" aria-label="The assistant is typing" style={{ display: "flex", alignItems: "flex-end", gap: 8, alignSelf: "flex-start" }}>
              {BOT}
              <div style={{ background: "#fff", border: "1px solid #ebedf0", padding: "12px 14px", borderRadius: "14px 14px 14px 4px", display: "flex", gap: 4 }}>
                <span style={{ width: 6, height: 6, borderRadius: 99, background: "#a0a7b4", opacity: 1 }} />
                <span style={{ width: 6, height: 6, borderRadius: 99, background: "#a0a7b4", opacity: 0.7 }} />
                <span style={{ width: 6, height: 6, borderRadius: 99, background: "#a0a7b4", opacity: 0.4 }} />
              </div>
            </div>
          ) : null}
        </div>
        <form
          onSubmit={(e) => { e.preventDefault(); void send(draft); }}
          style={{ padding: "10px 12px 12px", background: "#fff", borderTop: "1px solid #ebedf0", margin: 0 }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 4px 4px 14px", border: "1px solid #e3e6eb", borderRadius: 99 }}>
            <input ref={input} type="text" placeholder="Type a message..." aria-label="Message" value={draft} maxLength={2000}
              onChange={(e) => setDraft(e.target.value)}
              style={{ flex: 1, border: "0", outline: "0", fontSize: 13, fontFamily: "inherit", background: "transparent" }} />
            <button type="submit" aria-label="Send" disabled={busy || !draft.trim()} style={{ width: 34, height: 34, border: "0", borderRadius: 99, background: "#3e6bd1", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: busy || !draft.trim() ? "default" : "pointer", opacity: busy || !draft.trim() ? 0.6 : 1 }}>
              <Icon name="campaigns" size={15} />
            </button>
          </div>
          <div style={{ fontSize: 11, color: "#6b7280", textAlign: "center", marginTop: 8 }}>
            Automated assistant ·{" "}
            <button type="button" onClick={askForPerson} style={{ border: 0, background: "none", padding: 0, font: "inherit", color: "#3e6bd1", cursor: "pointer" }}>
              Ask for a person
            </button>{" "}anytime
          </div>
        </form>
      </section>
  );
}
