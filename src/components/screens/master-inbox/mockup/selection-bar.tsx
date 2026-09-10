"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/*
 * The design's `.mi-selbar` — paging, and what to do with a selection.
 *
 * One bar with two jobs, because that is how the design draws it: with nothing
 * ticked it shows where you are in the list; with rows ticked it becomes the
 * bulk toolbar. Two stacked bars would push the first row of mail further down
 * for no gain.
 *
 * ---------------------------------------------------------------------------
 * THE CHROME IS THE DESIGN'S; THE ACTIONS ARE THE TOOL'S
 *
 * Every button posts to `/api/tools/master-inbox/threads/bulk` — the Master
 * Inbox's own route, copied verbatim. Its contract is snake_case and
 * action-tagged:
 *
 *     { action: "seen",   thread_ids: [...], seen: boolean }
 *     { action: "status", thread_ids: [...], status: "archived" | "trash" | … }
 *
 * Worth writing down because guessing it (`threadIds`, `action: "unread"`)
 * returns 400 and looks like a broken route.
 *
 * Nothing here re-implements what an action means. Archiving from this bar and
 * archiving from the tool run the same code, fire the same triggers and reach
 * the same client portals.
 */

const API = "/api/tools/master-inbox/threads/bulk";

export function MockupSelectionBar({
  selected, total, page, lastPage, pageSize, onClear, onSelectAll, onDone, onPage,
}: {
  selected: string[];
  total: number;
  page: number;
  lastPage: number;
  pageSize: number;
  onClear: () => void;
  onSelectAll: () => void;
  onDone: () => void;
  onPage: (delta: number) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const n = selected.length;
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  async function run(label: string, body: Record<string, unknown>) {
    if (busy) return;
    setBusy(label);
    setFailed(null);
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, thread_ids: selected }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error ?? `That did not work (${res.status})`);
      }
      onDone();
      // The list is server-rendered, so the moved threads only disappear once
      // the server re-renders. Without this the rows sit there looking untouched.
      router.refresh();
    } catch (error) {
      setFailed(error instanceof Error ? error.message : "That did not work");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mi-selbar">
      <span
        className="cbx"
        role="checkbox"
        aria-checked={n > 0}
        aria-label={n > 0 ? "Clear selection" : "Select every conversation on this page"}
        onClick={n > 0 ? onClear : onSelectAll}
        style={{ cursor: "pointer", ...(n > 0 ? { background: "var(--blue)", borderColor: "var(--blue)" } : {}) }}
      />

      {n === 0 ? (
        <span className="tnum">
          {from.toLocaleString("en-US")}–{to.toLocaleString("en-US")} of {total.toLocaleString("en-US")}
        </span>
      ) : (
        <>
          <span className="tnum">{n} selected</span>
          {/* Each says what it will do to how many — a bulk action reading just
              "Archive" gives no sense of scale before it is pressed. */}
          <button className="fp" disabled={busy !== null}
            title={`Archive ${n} conversation${n === 1 ? "" : "s"}`}
            onClick={() => run("archive", { action: "status", status: "archived" })}>
            {busy === "archive" ? "…" : "Archive"}
          </button>
          <button className="fp" disabled={busy !== null}
            title={`Mark ${n} as spam`}
            onClick={() => run("spam", { action: "status", status: "spam" })}>
            {busy === "spam" ? "…" : "Spam"}
          </button>
          <button className="fp" disabled={busy !== null}
            title={`Move ${n} to trash — recoverable from the Trash view`}
            onClick={() => run("trash", { action: "status", status: "trash" })}>
            {busy === "trash" ? "…" : "Trash"}
          </button>
          <button className="fp" disabled={busy !== null}
            title={`Mark ${n} as read`}
            onClick={() => run("read", { action: "seen", seen: true })}>
            {busy === "read" ? "…" : "Read"}
          </button>
          <button className="fp" disabled={busy !== null}
            title={`Mark ${n} as unread`}
            onClick={() => run("unread", { action: "seen", seen: false })}>
            {busy === "unread" ? "…" : "Unread"}
          </button>
          {failed ? <span className="lc lc-red" title={failed}>{failed.slice(0, 40)}</span> : null}
        </>
      )}

      <span style={{ flex: 1 }} />

      {lastPage > 1 ? (
        <>
          <span className="tnum">Page {page} / {lastPage.toLocaleString("en-US")}</span>
          <button className="ib" onClick={() => onPage(-1)} disabled={page <= 1} aria-label="Previous page">
            <svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></svg>
          </button>
          <button className="ib" onClick={() => onPage(1)} disabled={page >= lastPage} aria-label="Next page">
            <svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6" /></svg>
          </button>
        </>
      ) : null}
    </div>
  );
}
