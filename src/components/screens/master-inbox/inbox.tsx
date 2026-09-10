"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  InboxData, ThreadRow, ThreadDetail, ThreadResult,
} from "@/lib/tools/master-inbox/inbox-view";
import { Lazy } from "../lazy";
import { Composer } from "./composer";
import { InboxRow, RailCard } from "./row";
import { SelectionBar } from "./selection-bar";
import {
  applyLabel, loadLabels, setSeen, setStatus,
  type Label, type ThreadStatus,
} from "./actions";
import { fullStamp, shortStamp } from "@/lib/workspace/dates";

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

  const [selected, setSelected] = useState<string[]>([]);
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

  // The server's clock, not the browser's — see shortDate below.
  const now = new Date(data.now ?? first.now).getTime();

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
    <>
      {failed ? (
        <div className="anno" style={{ margin: "0 16px 12px" }}>
          <b>The inbox could not be read.</b> {failed}
        </div>
      ) : null}

      {/* The design's tab strip. Counts are UNSEEN — the tool's "N new" pill. */}
      <div className="mi-tabs">
        {VIEWS.map((v) => {
          const unseen = counts[v.slug]?.unseen ?? 0;
          return (
            <button
              key={v.slug}
              className={`mi-tab${view === v.slug ? " on" : ""}`}
              onClick={() => change(() => setView(v.slug))}
              aria-pressed={view === v.slug}
            >
              {v.label}
              {unseen > 0 ? <span className="cpill">{unseen} new</span> : null}
            </button>
          );
        })}
      </div>

      <div className="mi-filter">
        <input
          className="inp"
          placeholder="Search conversations…"
          value={q}
          onChange={(e) => change(() => setQ(e.target.value))}
          aria-label="Search conversations"
          style={{ flex: 1, maxWidth: 420 }}
        />
      </div>

      <SelectionBar
        selected={selected}
        total={data.total}
        page={data.page}
        lastPage={lastPage}
        pageSize={data.pageSize}
        onClear={() => setSelected([])}
        onSelectAll={() => setSelected(data.threads.map((t) => t.id))}
        onDone={() => { setSelected([]); load({ view, q, page }); }}
        onPage={(d) => setPage((n) => Math.min(Math.max(1, n + d), lastPage))}
      />

      {/*
        Two modes, as the design has them.

        With nothing open the list is full width, so a row can carry sender,
        chips, subject and preview on one line. Opening a conversation narrows
        the list to a rail of compact cards — the same rows squeezed into 320px
        would be unreadable, which is why the design draws them differently
        rather than just shrinking them.
      */}
      <div
        style={
          openId
            ? { display: "grid", gridTemplateColumns: "320px 1fr", minHeight: 0, flex: 1 }
            : undefined
        }
      >
        <div style={openId ? { overflow: "auto", borderRight: "1px solid var(--line-soft)" } : undefined}>
          <div style={{ opacity: busy ? 0.55 : 1, transition: "opacity .12s" }} aria-busy={busy} role="list">
            {data.threads.length === 0 ? (
              <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--muted)" }}>
                {q.trim() ? `Nothing matches \u201c${q.trim()}\u201d.` : "No conversations in this view."}
              </div>
            ) : openId ? (
              data.threads.map((t) => (
                <RailCard
                  key={t.id}
                  t={t}
                  now={now}
                  open={openId === t.id}
                  onOpen={() => setOpenId(t.id)}
                />
              ))
            ) : (
              data.threads.map((t) => (
                <InboxRow
                  key={t.id}
                  t={t}
                  now={now}
                  open={false}
                  selected={selected.includes(t.id)}
                  onOpen={() => setOpenId(t.id)}
                  onToggle={() =>
                    setSelected((cur) =>
                      cur.includes(t.id) ? cur.filter((x) => x !== t.id) : [...cur, t.id],
                    )
                  }
                />
              ))
            )}
          </div>
        </div>

        {openId ? (
          <ThreadPane
            detail={thread}
            busy={threadBusy}
            error={threadError}
            onClose={() => setOpenId(null)}
            onDone={() => { setOpenId(null); load({ view, q, page }); }}
          />
        ) : null}
      </div>
    </>
  );
}

function ThreadPane({
  detail, busy, error, onClose, onDone,
}: {
  detail: ThreadDetail | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
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
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {detail ? <ThreadActions detail={detail} onDone={onDone} /> : null}
          <button className="fp" onClick={onClose} aria-label="Close conversation" title="Close">✕</button>
        </div>
      </div>

      <div style={{ padding: "6px 20px 20px", maxHeight: "72vh", overflowY: "auto" }}>
        {error ? (
          <div className="anno" style={{ borderColor: "var(--red)" }}>{error}</div>
        ) : busy && !detail ? (
          <div style={{ padding: 24, color: "var(--muted)", fontSize: 13 }}>Opening…</div>
        ) : detail ? (
          <>
            <LabelPicker detail={detail} onDone={onDone} />
            {detail.messages.map((m) => <Message key={m.id} m={m} />)}
            {detail.messages.length === 0 ? (
              <div style={{ padding: 24, color: "var(--muted)", fontSize: 13 }}>
                This conversation has no messages.
              </div>
            ) : null}

            <Composer detail={detail} onSent={onDone} />
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
          {fullStamp(m.sent_at)}
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

/*
 * Archive, spam, trash, restore, and read state.
 *
 * Placed on the open conversation rather than as row hovers: these move a
 * thread out of the view you are looking at, and doing that from a list is how
 * you archive the wrong one.
 *
 * Every button disables while its write is in flight. Without that, an
 * impatient second click sends a second write, and for "trash" that means
 * moving a thread you have already moved.
 */
function ThreadActions({ detail, onDone }: { detail: ThreadDetail; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setFailed(null);
    try {
      await fn();
      onDone();
    } catch (error) {
      setFailed(error instanceof Error ? error.message : "That did not work");
    } finally {
      setBusy(null);
    }
  };

  const move = (status: ThreadStatus, label: string) =>
    run(label, () => setStatus([detail.id], status));

  // Restore is the only sensible action on something already filed away.
  const filed = detail.status !== "open";

  return (
    <>
      {filed ? (
        <button className="fp" disabled={busy !== null} onClick={() => move("open", "restore")}
          title="Move back to the inbox">
          {busy === "restore" ? "…" : "Restore"}
        </button>
      ) : (
        <>
          <button className="fp" disabled={busy !== null} onClick={() => move("archived", "archive")}
            title="Archive this conversation">
            {busy === "archive" ? "…" : "Archive"}
          </button>
          <button className="fp" disabled={busy !== null} onClick={() => move("spam", "spam")}
            title="Mark as spam">
            {busy === "spam" ? "…" : "Spam"}
          </button>
          <button className="fp" disabled={busy !== null} onClick={() => move("trash", "trash")}
            title="Move to trash — recoverable from the Trash view">
            {busy === "trash" ? "…" : "Trash"}
          </button>
        </>
      )}

      <button
        className="fp"
        disabled={busy !== null}
        onClick={() => run("seen", () => setSeen([detail.id], false))}
        title="Mark unread and return to the list"
      >
        {busy === "seen" ? "…" : "Unread"}
      </button>

      {failed ? (
        <span className="tg" style={{ background: "var(--red-bg)", borderColor: "transparent", color: "var(--red)" }}>
          {failed}
        </span>
      ) : null}
    </>
  );
}

/*
 * The thread's label, and the picker that changes it.
 *
 * Single-label-per-thread, as the tool decided in May 2026 — choosing one
 * replaces whatever was there, so the picker is a list of alternatives rather
 * than a set of checkboxes.
 *
 * The consequences are written next to the buttons rather than in a commit
 * message, because "Introduction" is not a filing decision: it puts a row in
 * front of the client and tells three other systems. Somebody should know that
 * before they click, not after.
 */
function LabelPicker({ detail, onDone }: { detail: ThreadDetail; onDone: () => void }) {
  const [labels, setLabels] = useState<Label[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const current = detail.labels[0] ?? null;

  useEffect(() => {
    if (!open || labels) return;
    loadLabels().then(setLabels, (e: unknown) =>
      setFailed(e instanceof Error ? e.message : "Labels could not be loaded"),
    );
  }, [open, labels]);

  const choose = async (label: Label) => {
    setBusy(label.id);
    setFailed(null);
    try {
      await applyLabel(detail.id, label.id);
      setOpen(false);
      onDone();
    } catch (error) {
      setFailed(error instanceof Error ? error.message : "That label could not be applied");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ padding: "10px 0 4px" }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {detail.labels.map((l) => (
          <span key={l.id} className="tg" style={{ background: l.color || "var(--inset-2)", borderColor: "transparent" }}>
            {l.name}
          </span>
        ))}
        <button
          className="fp"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={current ? `Replace the “${current.name}” label` : "Apply a label"}
        >
          {current ? "Change label" : "Add label"}
        </button>
      </div>

      {open ? (
        <div
          style={{
            marginTop: 10,
            padding: 12,
            border: "1px solid var(--line-soft)",
            borderRadius: 11,
            background: "var(--surface)",
          }}
        >
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 9, lineHeight: 1.6 }}>
            One label per conversation — this replaces{" "}
            {current ? <b>{current.name}</b> : "nothing yet"}.{" "}
            <b>Introduction</b> adds the lead to that client&rsquo;s portal and notifies
            n8n, Slack and Follow Up Boss. <b>Hostile</b> blacklists them on the sending
            platform.
          </div>

          {!labels && !failed ? (
            <div style={{ fontSize: 13, color: "var(--muted)" }}>Loading labels…</div>
          ) : (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {(labels ?? []).map((l) => (
                <button
                  key={l.id}
                  className={`fp${current?.id === l.id ? " on" : ""}`}
                  disabled={busy !== null || current?.id === l.id}
                  onClick={() => choose(l)}
                  title={current?.id === l.id ? "Already applied" : `Apply “${l.name}”`}
                >
                  {busy === l.id ? "…" : l.name}
                </button>
              ))}
            </div>
          )}

          {failed ? (
            <div className="tg" style={{ marginTop: 9, background: "var(--red-bg)", borderColor: "transparent", color: "var(--red)" }}>
              {failed}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
