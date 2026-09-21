"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Btn } from "./analytics/toast";
import { AssistantMarkdown } from "./assistant-markdown";

/*
 * The assistant screen.
 *
 * ---------------------------------------------------------------------------
 * WHY IT SHOWS THE TOOLS RUNNING
 *
 * A turn is several queries across four databases and then a model reply —
 * measured at thirteen seconds for the first question of a session while the
 * client roster loads, under five after. A bare typing dot for thirteen
 * seconds reads as broken. Naming the lookup that is actually running is both
 * honest about where the time goes and the thing that makes the answer
 * checkable: "it asked Client Health" is the first half of "and here is what
 * Client Health said".
 *
 * ---------------------------------------------------------------------------
 * THE SIDEBAR IS THE PRODUCT
 *
 * Questions here are not one-offs; "which clients are behind" is asked every
 * week and the follow-ups differ. So chats persist, group by day, and reopen
 * with their context — and each answer keeps the figures it cited, rather than
 * recomputing them into a different number a month later.
 */

interface ChatSummary {
  id: string;
  title: string;
  updatedAt: string;
}

interface ToolRun {
  name: string;
  arguments: Record<string, unknown>;
  ms?: number;
}

interface Turn {
  id: number | string;
  role: "user" | "assistant";
  content: string;
  toolCalls: ToolRun[];
  error?: string | null;
}

const SUGGESTIONS = [
  "Which clients are furthest behind their intro target?",
  "How is The Keyes Company doing?",
  "Which clients have gone quiet?",
  "What did we scrape recently?",
  "How many interested replies did we get this month?",
];

/** Today / Yesterday / Previous 7 days / Older — the grouping a sidebar needs. */
function bucketOf(iso: string): string {
  const then = new Date(iso);
  const now = new Date();
  const days = Math.floor(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) /
      86_400_000,
  );
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days <= 7) return "Previous 7 days";
  if (days <= 30) return "Previous 30 days";
  return "Older";
}

const TOOL_LABEL: Record<string, string> = {
  find_client: "Looking up the client",
  client_overview: "Reading all four products",
  client_rankings: "Ranking clients by performance",
  campaigns_for_client: "Listing campaigns",
  scrape_activity: "Checking recent scrapes",
  inbox_activity: "Reading inbox replies",
  reply_agent_status: "Checking the reply agent",
  onboarding_pipeline: "Reading the onboarding pipeline",
  infrastructure_health: "Checking the sending fleet",
  campaign_copy: "Reading the campaign copy",
  recent_replies: "Reading recent replies",
  inbox_deliverability: "Checking inbox deliverability",
  client_commercials: "Reading the client's plan",
  sending_volume: "Adding up sending volume",
  client_reply_rates: "Comparing reply rates",
  agent_database: "Sizing the agent database",
};

export function AssistantScreen() {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const loadChats = useCallback(async () => {
    const res = await fetch("/api/tools/assistant/chats");
    if (res.status === 403) {
      setForbidden((await res.json()).detail ?? "You do not have access to the assistant.");
      return;
    }
    if (!res.ok) return;
    setChats((await res.json()).chats ?? []);
  }, []);

  useEffect(() => {
    void loadChats();
  }, [loadChats]);

  // Only scrolls once a turn exists, so the empty state is not yanked upward.
  useEffect(() => {
    if (turns.length) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, running]);

  const openChat = useCallback(async (id: string) => {
    setChatId(id);
    setError(null);
    const res = await fetch(`/api/tools/assistant/chats/${id}`);
    if (!res.ok) return;
    const body = await res.json();
    setTurns(
      (body.messages ?? []).map((m: Turn & { toolCalls?: ToolRun[] }) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        toolCalls: m.toolCalls ?? [],
        error: m.error,
      })),
    );
  }, []);

  const newChat = useCallback(() => {
    setChatId(null);
    setTurns([]);
    setError(null);
    inputRef.current?.focus();
  }, []);

  const ask = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q || busy) return;
      setBusy(true);
      setError(null);
      setQuestion("");

      /*
       * The question appears immediately, before the round trip. A thirteen
       * second wait during which your own words have not appeared reads as the
       * message having been dropped.
       */
      setTurns((prev) => [...prev, { id: `local-${Date.now()}`, role: "user", content: q, toolCalls: [] }]);
      setRunning("Thinking");

      try {
        let id = chatId;
        if (!id) {
          const made = await fetch("/api/tools/assistant/chats", { method: "POST" });
          if (!made.ok) throw new Error("Could not start a chat");
          id = (await made.json()).chat.id as string;
          setChatId(id);
        }

        const res = await fetch(`/api/tools/assistant/chats/${id}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: q }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.detail ?? body.error ?? "The assistant could not answer");

        setTurns((prev) => [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: "assistant",
            content: body.answer ?? "",
            toolCalls: body.toolCalls ?? [],
          },
        ]);
        await loadChats();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
        setRunning(null);
      }
    },
    [busy, chatId, loadChats],
  );

  const remove = useCallback(
    async (id: string) => {
      await fetch(`/api/tools/assistant/chats/${id}`, { method: "DELETE" });
      if (id === chatId) newChat();
      await loadChats();
    },
    [chatId, loadChats, newChat],
  );

  const rename = useCallback(
    async (id: string, title: string) => {
      setRenaming(null);
      if (!title.trim()) return;
      await fetch(`/api/tools/assistant/chats/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      await loadChats();
    },
    [loadChats],
  );

  if (forbidden) {
    return (
      <div className="wrap an-screen">
        <div className="tbl-card" style={{ padding: 28, maxWidth: 560 }}>
          <div className="tbl-title" style={{ fontSize: 17 }}>Assistant</div>
          <p className="mut" style={{ marginTop: 8, lineHeight: 1.6 }}>{forbidden}</p>
        </div>
      </div>
    );
  }

  let lastBucket = "";

  return (
    <div className="asst">
      <aside className="asst-side">
        <button className="asst-new" onClick={newChat}>+ New chat</button>
        <div className="asst-list">
          {chats.length === 0 ? (
            <div className="asst-empty-list">No conversations yet</div>
          ) : (
            chats.map((c) => {
              const bucket = bucketOf(c.updatedAt);
              const heading = bucket !== lastBucket ? ((lastBucket = bucket), bucket) : null;
              return (
                <div key={c.id}>
                  {heading ? <div className="asst-bucket">{heading}</div> : null}
                  <div className={`asst-item${c.id === chatId ? " is-on" : ""}`}>
                    {renaming === c.id ? (
                      <input
                        className="asst-rename"
                        defaultValue={c.title}
                        autoFocus
                        onBlur={(e) => void rename(c.id, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void rename(c.id, e.currentTarget.value);
                          if (e.key === "Escape") setRenaming(null);
                        }}
                      />
                    ) : (
                      <>
                        <button className="asst-item-open" onClick={() => void openChat(c.id)} title={c.title}>
                          {c.title}
                        </button>
                        <span className="asst-item-actions">
                          <button onClick={() => setRenaming(c.id)} title="Rename">✎</button>
                          <button onClick={() => void remove(c.id)} title="Delete">🗑</button>
                        </span>
                      </>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>

      <main className="asst-main">
        <div className="asst-scroll">
          {turns.length === 0 ? (
            <div className="asst-welcome">
              <h1>Ask about the business</h1>
              <p className="mut">
                Every client, campaign, inbox and scrape — in one place. Answers cite the product
                they came from, and say so when something is not tracked rather than reporting zero.
              </p>
              <div className="asst-suggest">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => void ask(s)}>{s}</button>
                ))}
              </div>
            </div>
          ) : (
            turns.map((t) => (
              <div key={t.id} className={`asst-turn is-${t.role}`}>
                {t.role === "assistant" && t.toolCalls.length ? (
                  <div className="asst-tools">
                    {t.toolCalls.map((c, i) => (
                      <span key={i} className="asst-tool">
                        {TOOL_LABEL[c.name] ?? c.name}
                        {typeof c.ms === "number" ? <em>{(c.ms / 1000).toFixed(1)}s</em> : null}
                      </span>
                    ))}
                  </div>
                ) : null}
                {t.error ? (
                  <div className="asst-error">That question could not be answered — {t.error}</div>
                ) : t.role === "assistant" ? (
                  <div className="asst-body asst-md"><AssistantMarkdown text={t.content} /></div>
                ) : (
                  <div className="asst-body">{t.content}</div>
                )}
              </div>
            ))
          )}

          {running ? (
            <div className="asst-turn is-assistant">
              <div className="asst-running">
                <span className="asst-dot" /> {running}…
              </div>
            </div>
          ) : null}

          {error ? <div className="asst-error">{error}</div> : null}
          <div ref={endRef} />
        </div>

        <form
          className="asst-ask"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(question);
          }}
        >
          <textarea
            ref={inputRef}
            className="asst-input"
            rows={1}
            value={question}
            placeholder="Ask about a client, a campaign, or how the month is going…"
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter is a newline — the convention people
              // already have from every other chat box.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void ask(question);
              }
            }}
            disabled={busy}
          />
          <Btn disabled={busy || !question.trim()}>{busy ? "Asking…" : "Ask"}</Btn>
        </form>
      </main>
    </div>
  );
}
