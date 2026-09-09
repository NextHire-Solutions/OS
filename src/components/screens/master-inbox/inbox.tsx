"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  InboxData, ThreadRow, ThreadDetail, ThreadResult,
} from "@/lib/tools/master-inbox/inbox-view";
import { Lazy } from "../lazy";

/*
 * Master Inbox — the staff inbox.
 *
 * Two panes: the thread list on the left, the conversation on the right. Both
 * are server-paged, because the workspace holds 9,862 open threads and a
 * thread carries every message body.
 *
 * Read-only in this phase, deliberately and visibly. The audit found that
 * labelling a thread fires a database trigger which creates a pipeline row in
 * that client's LIVE portal — so the actions are not stubbed out with buttons
 * that do nothing. They are absent, and the screen says why.
 *
 * The same round-trip discipline as Agent Search applies: searching is
 * debounced, responses are matched to the request that asked for them, and the
 * previous page stays on screen while the next loads.
 */

export function MasterInboxScreen({ initial }: { initial: InboxData | null }) {
  return (
    <Lazy<InboxData>
      initial={initial}
      url="/api/tools/master-inbox"
      label="Master Inbox"
      skeleton={<InboxSkeleton />}
    >
      {(data) => <InboxView first={data} />}
    </Lazy>
  );
}

function InboxView({ first }: { first: InboxData }) {
  const [data, setData] = useState<InboxData>(first);
  const [view, setView] = useState(first.query.view);
  const [q, setQ] = useState(first.query.q);
  const [page, setPage] = useState(first.page);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(first.error);

  const [openId, setOpenId] = useState<string | null>(null);
  const [thread, setThread] = useState<ThreadDetail | null>(null);
  const [threadBusy, setThreadBusy] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);

  // Only the newest request may paint. Searches race: "opp" can outlive
  // "opportunity" on a slow link, and without this the list settles on results
  // for a term nobody is looking at.
  const latest = useRef(0);
  const latestThread = useRef(0);

  const load = useCallback(async (next: { view: string; q: string; page: number }) => {
    const ticket = ++latest.current;
    setBusy(true);
    try {
      const params = new URLSearchParams({ view: next.view, q: next.q, page: String(next.page) });
      const res = await fetch(`/api/tools/master-inbox?${params}`, { credentials: "same-origin" });
      const body = (await res.json()) as InboxData & { error?: string };
      if (ticket !== latest.current) return;
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
      setData(body);
      setFailed(body.error ?? null);
    } catch (error) {
      if (ticket !== latest.current) return;
      setFailed(error instanceof Error ? error.message : "Could not load the inbox");
    } finally {
      if (ticket === latest.current) setBusy(false);
    }
  }, []);

  // Skipped on the very first render: the server already provided that page.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    const t = setTimeout(() => load({ view, q, page }), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [view, q, page, load]);

  // Opening a thread fetches it; the list stays put behind it.
  useEffect(() => {
    if (!openId) { setThread(null); setThreadError(null); return; }
    const ticket = ++latestThread.current;
    setThreadBusy(true);
    setThreadError(null);
    fetch(`/api/tools/master-inbox/thread?id=${encodeURIComponent(openId)}`, {
      credentials: "same-origin",
    })
      .then((r) => r.json() as Promise<ThreadResult>)
      .then((body) => {
        if (ticket !== latestThread.current) return;
        setThread(body.detail);
        setThreadError(body.error ?? (body.detail ? null : "That conversation no longer exists"));
      })
      .catch((e: unknown) => {
        if (ticket !== latestThread.current) return;
        setThreadError(e instanceof Error ? e.message : "Could not open that conversation");
      })
      .finally(() => { if (ticket === latestThread.current) setThreadBusy(false); });
  }, [openId]);

  const change = (fn: () => void) => { fn(); setPage(1); setOpenId(null); };

  const lastPage = Math.max(1, Math.ceil(data.total / (data.pageSize || 50)));
  const counts = data.counts ?? {};

  const VIEWS = [
    { slug: "all-email", label: "All Email" },
    { slug: "archive", label: "Archive" },
    { slug: "spam", label: "Spam" },
    { slug: "trash", label: "Trash" },
    ...data.views.map((v) => ({ slug: v.slug, label: v.name })),
  ];

  return (
    <div className="wrap">
      <div className="anno" style={{ marginBottom: 16 }}>
        <b>Reading only, for now.</b> Replying, labelling and archiving still happen in
        Master Inbox itself. Labelling a thread creates a row in that
        client&rsquo;s live portal, so those actions are being added deliberately rather
        than quickly.
      </div>

      {failed ? (
        <div className="anno" style={{ borderColor: "var(--red)", marginBottom: 16 }}>
          <b>The inbox could not be read.</b> {failed}
        </div>
      ) : null}

      {/* Views. Counts come from the tool's own loadViewCounts. */}
      <div className="pills" style={{ marginBottom: 16, flexWrap: "wrap" }}>
        {VIEWS.map((v) => {
          // The tool's count is UNSEEN, not a total — it is the "N new" pill.
          // Showing it as a total would misreport every view.
          const unseen = counts[v.slug]?.unseen ?? 0;
          return (
            <button
              key={v.slug}
              className={`fp${view === v.slug ? " on" : ""}`}
              onClick={() => change(() => setView(v.slug))}
              aria-pressed={view === v.slug}
              title={unseen > 0 ? `${unseen.toLocaleString("en-US")} unread` : v.label}
            >
              {v.label}
              {unseen > 0 ? (
                <span
                  className="tnum"
                  style={{
                    marginLeft: 7,
                    background: "var(--red-bg)",
                    color: "var(--red)",
                    borderRadius: 7,
                    padding: "1px 6px",
                    fontWeight: 700,
                  }}
                >
                  {unseen.toLocaleString("en-US")}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: openId ? "minmax(340px, 420px) 1fr" : "1fr", gap: 18, alignItems: "start" }}>
        <div className="tbl-wrap">
          <div className="tbl-head">
            <div>
              <div className="tbl-title">Conversations</div>
              <div className="tbl-sub">
                {data.total.toLocaleString("en-US")} in {view.replace(/-/g, " ")}
                {lastPage > 1 ? ` · page ${data.page} of ${lastPage.toLocaleString("en-US")}` : ""}
              </div>
            </div>
            <input
              className="inp"
              placeholder="Search conversations…"
              value={q}
              onChange={(e) => change(() => setQ(e.target.value))}
              aria-label="Search conversations"
              style={{ minWidth: 210 }}
            />
          </div>

          {/* Dimmed rather than blanked while loading — an inbox that empties
              on every keystroke reads as "you have no mail". */}
          <div style={{ opacity: busy ? 0.55 : 1, transition: "opacity .12s" }} aria-busy={busy}>
            {data.threads.length === 0 ? (
              <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--muted)" }}>
                {q.trim() ? `Nothing matches “${q.trim()}”.` : "No conversations in this view."}
              </div>
            ) : (
              <div role="list">
                {data.threads.map((t) => (
                  <ThreadItem
                    key={t.id}
                    t={t}
                    open={openId === t.id}
                    onOpen={() => setOpenId(openId === t.id ? null : t.id)}
                  />
                ))}
              </div>
            )}
          </div>

          {lastPage > 1 ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 18px" }}>
              <span style={{ fontSize: 12.5, color: "var(--muted)" }}>
                {((data.page - 1) * data.pageSize + 1).toLocaleString("en-US")}–
                {Math.min(data.page * data.pageSize, data.total).toLocaleString("en-US")} of{" "}
                {data.total.toLocaleString("en-US")}
              </span>
              <span className="pills" style={{ padding: 0 }}>
                <button className="fp" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={data.page <= 1}
                  style={data.page <= 1 ? { opacity: 0.4, cursor: "not-allowed" } : undefined} aria-label="Previous page">←</button>
                <button className="fp on" style={{ minWidth: 84 }} disabled>
                  {data.page} / {lastPage.toLocaleString("en-US")}
                </button>
                <button className="fp" onClick={() => setPage((p) => Math.min(lastPage, p + 1))} disabled={data.page >= lastPage}
                  style={data.page >= lastPage ? { opacity: 0.4, cursor: "not-allowed" } : undefined} aria-label="Next page">→</button>
              </span>
            </div>
          ) : null}
        </div>

        {openId ? (
          <ThreadPane
            detail={thread}
            busy={threadBusy}
            error={threadError}
            onClose={() => setOpenId(null)}
          />
        ) : null}
      </div>
    </div>
  );
}

function ThreadItem({ t, open, onOpen }: { t: ThreadRow; open: boolean; onOpen: () => void }) {
  return (
    <button
      role="listitem"
      onClick={onOpen}
      aria-expanded={open}
      className="mi-row"
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "13px 18px",
        borderTop: "1px solid var(--line-soft)",
        background: open ? "var(--inset)" : "transparent",
        cursor: "pointer",
        // An unseen thread is the reason somebody opened this screen.
        fontWeight: t.seen ? 400 : 600,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {t.lead_full_name ?? t.lead_email ?? "Unknown sender"}
        </span>
        {t.needs_reply ? (
          <span className="tg" style={{ background: "var(--red-bg)", borderColor: "transparent", color: "var(--red)" }}>
            needs reply
          </span>
        ) : null}
        <span style={{ fontSize: 11.5, color: "var(--muted)", whiteSpace: "nowrap" }}>
          {t.last_message_at ? shortDate(t.last_message_at) : ""}
        </span>
      </div>

      <div style={{ fontSize: 13, color: "var(--ink)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {t.subject ?? "(no subject)"}
      </div>

      {t.last_message_preview ? (
        <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 400 }}>
          {t.last_message_preview}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 6, marginTop: 7, flexWrap: "wrap", alignItems: "center" }}>
        {t.client_name ? <span className="tg">{t.client_name}</span> : null}
        {t.labels?.slice(0, 3).map((l) => (
          <span key={l.name} className="tg" style={{ background: l.color || "var(--inset-2)", borderColor: "transparent" }}>
            {l.name}
          </span>
        ))}
      </div>
    </button>
  );
}

function ThreadPane({
  detail, busy, error, onClose,
}: { detail: ThreadDetail | null; busy: boolean; error: string | null; onClose: () => void }) {
  return (
    <div className="tbl-wrap" style={{ position: "sticky", top: 12 }}>
      <div className="tbl-head">
        <div style={{ minWidth: 0 }}>
          <div className="tbl-title" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {detail?.subject ?? (busy ? "Opening…" : "Conversation")}
          </div>
          <div className="tbl-sub">
            {detail
              ? [detail.lead.full_name ?? detail.lead.email, detail.client_name, detail.campaign_name]
                  .filter(Boolean)
                  .join(" · ")
              : ""}
          </div>
        </div>
        <button className="fp" onClick={onClose} aria-label="Close conversation" title="Close">✕</button>
      </div>

      <div style={{ padding: "6px 20px 20px", maxHeight: "72vh", overflowY: "auto" }}>
        {error ? (
          <div className="anno" style={{ borderColor: "var(--red)" }}>{error}</div>
        ) : busy && !detail ? (
          <div style={{ padding: 24, color: "var(--muted)", fontSize: 13 }}>Opening…</div>
        ) : detail ? (
          <>
            {detail.labels.length > 0 ? (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "10px 0 4px" }}>
                {detail.labels.map((l) => (
                  <span key={l.id} className="tg" style={{ background: l.color || "var(--inset-2)", borderColor: "transparent" }}>
                    {l.name}
                  </span>
                ))}
              </div>
            ) : null}
            {detail.messages.map((m) => <Message key={m.id} m={m} />)}
            {detail.messages.length === 0 ? (
              <div style={{ padding: 24, color: "var(--muted)", fontSize: 13 }}>
                This conversation has no messages.
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function Message({ m }: { m: ThreadDetail["messages"][number] }) {
  const outbound = m.direction === "outbound";
  return (
    <div
      style={{
        borderTop: "1px solid var(--line-soft)",
        padding: "14px 0",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: outbound ? "var(--green)" : "var(--ink)" }}>
          {m.sender_name ?? m.sender ?? (outbound ? "Us" : "Them")}
        </span>
        <span className="tg" style={{ fontSize: 10.5 }}>{outbound ? "sent" : "received"}</span>
        <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--muted)" }}>
          {m.sent_at ? longDate(m.sent_at) : ""}
        </span>
      </div>
      {/*
        Rendered as TEXT, never as HTML. These bodies are written by people
        outside the business, so injecting body_html into the workspace would
        be handing them script execution inside a signed-in session.
      */}
      <div style={{ fontSize: 13.2, lineHeight: 1.65, color: "var(--ink-2)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {m.body_text?.trim() || stripHtml(m.body_html) || "(no content)"}
      </div>
    </div>
  );
}

/** Plain text from an HTML body — the workspace never renders sender HTML. */
function stripHtml(html: string | null): string {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const days = (Date.now() - d.getTime()) / 86_400_000;
  return days < 1
    ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function longDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function InboxSkeleton() {
  return (
    <div className="wrap" aria-busy="true">
      <div className="tbl-wrap">
        <div className="tbl-head">
          <div>
            <div className="tbl-title"><Bar w={140} h={16} /></div>
            <div className="tbl-sub" style={{ marginTop: 6 }}><Bar w={200} /></div>
          </div>
        </div>
        <div style={{ padding: "6px 18px 20px" }}>
          {Array.from({ length: 9 }, (_, i) => (
            <div key={i} style={{ padding: "14px 0", borderTop: i ? "1px solid var(--line-soft)" : undefined }}>
              <Bar w={`${34 + ((i * 11) % 22)}%`} h={12} />
              <div style={{ height: 7 }} />
              <Bar w={`${58 + ((i * 7) % 26)}%`} h={11} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Bar({ w, h = 11 }: { w: number | string; h?: number }) {
  return <span style={{ display: "block", width: w, height: h, borderRadius: 5, background: "var(--inset-2)" }} />;
}
